//! Daily settlement. Off-chain play (gathering, farming, crafting, merchant trades, town purchases, rent) is recorded
//! in the server's day ledger; once per game day the settler submits each account's NET change per token here, in
//! chunks, together with the Merkle root of the published ledger (docs/onchain-offchain.md).
//!
//! The contract does not replay the ledger. It enforces the invariants on the net result:
//! - each (day, chunk) is applied once, and a day's ledger root never changes once stored;
//! - a player account's net gain per item and per day is capped (`daily_gain_cap`, `daily_coin_gain_cap`);
//! - new `coin` (a chunk's net positive coin) is limited by the faucet W_day = W0 * k * (1 - M / Mcap), M being the
//!   coin supply when the day's first chunk arrives, not counting owner-minted coin still unspent in the town
//!   treasury (`faucet_supply`, treasury.rs) (docs/economy.md section 3);
//! - negative deltas need the settled balance to cover them.
use crate::{COIN, Contract, ContractExt, events};
use near_sdk::json_types::U128;
use near_sdk::{AccountId, env, near, require};

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Delta {
    pub account_id: AccountId,
    pub token_id: String,
    /// Signed integer as a decimal string, e.g. "-3".
    pub delta: String,
}

#[near(serializers = [json])]
pub struct FaucetView {
    pub allowed_today: U128,
    pub minted_today: U128,
    pub coin_supply: U128,
}

impl Contract {
    fn k(&self, active_players: u32) -> u128 {
        let active = active_players.min(self.registered_count) as u128;
        (1 + active / self.limits.active_divisor.max(1) as u128).min(self.limits.max_k as u128)
    }

    /// W_day = W0 * k * (Mcap - M) / Mcap with Mcap = Mcap0 * k; zero once the supply reaches the cap.
    pub(crate) fn faucet_allowed(&self, supply_at_start: u128, active_players: u32) -> u128 {
        let k = self.k(active_players);
        let mcap = self.limits.money_cap0.0.saturating_mul(k);
        if mcap == 0 || supply_at_start >= mcap {
            return 0;
        }
        self.limits.faucet_w0.0.saturating_mul(k).saturating_mul(mcap - supply_at_start) / mcap
    }
}

fn parse_delta(s: &str) -> i128 {
    s.parse::<i128>().unwrap_or_else(|_| env::panic_str(&format!("bad delta {s}")))
}

#[near]
impl Contract {
    pub fn settle_day(&mut self, day: u64, chunk: u32, entries: Vec<Delta>, ledger_root: String, active_players: u32) {
        self.require_settler();
        self.require_not_paused();
        require!(ledger_root.len() == 64 && ledger_root.bytes().all(|b| b.is_ascii_hexdigit()), "ledger_root must be 64 hex chars");
        require!(entries.len() as u32 <= self.limits.max_chunk, "chunk too large");
        require!(day >= self.last_settled_day, "day already closed");
        require!(!self.applied.contains(&(day, chunk)), "chunk already applied");
        match self.roots.get(&day) {
            Some(r) => require!(*r == ledger_root, "ledger_root differs from the day's stored root"),
            None => {
                self.roots.insert(day, ledger_root.clone());
            }
        }

        // An account that unregistered while off-chain rows were pending is skipped (and logged), so one player
        // cannot freeze settlement for everyone. The town and merchants always count as known accounts.
        let mut parsed: Vec<(AccountId, String, i128)> = Vec::with_capacity(entries.len());
        for e in entries {
            self.require_token(&e.token_id);
            let delta = parse_delta(&e.delta);
            if self.registered.contains(&e.account_id) || self.is_merchant(&e.account_id) || e.account_id == self.town_id {
                parsed.push((e.account_id, e.token_id, delta));
            } else {
                events::gt_settle_skip(day, chunk, e.account_id.as_str(), &e.token_id, &e.delta);
            }
        }

        // Coin faucet: the day's running NET coin (all chunks, signed) is new money. A transfer split across chunks
        // (player +X in one, merchant -X in another) nets to zero. The server sends negative-net chunks first.
        let net_coin: i128 = parsed.iter().filter(|(_, t, _)| t == COIN).map(|(_, _, d)| *d).sum();
        let (start_supply, _) = self.day_faucet.get(&day).copied().unwrap_or((self.faucet_supply(), 0));
        let running = self.day_net.get(&day).copied().unwrap_or(0).saturating_add(net_coin);
        if net_coin > 0 {
            let allowed = self.faucet_allowed(start_supply, active_players);
            let minted = running.max(0) as u128;
            require!(minted <= allowed, format!("coin faucet exceeded: {minted} > {allowed} allowed today"));
        }
        self.day_net.insert(day, running);
        self.day_faucet.insert(day, (start_supply, running.max(0) as u128));

        // Debits first (they must be covered by settled balances), then credits.
        let memo = format!("settle:{day}:{chunk}");
        for (acct, token, d) in parsed.iter().filter(|(_, _, d)| *d < 0) {
            let amount = d.unsigned_abs();
            self.burn(token, acct, amount);
            events::mt_burn(acct.as_str(), &[token.clone()], &[U128(amount)], Some(&memo));
        }
        for (acct, token, d) in parsed.iter().filter(|(_, _, d)| *d > 0) {
            let amount = *d as u128;
            if !self.is_merchant(acct) && *acct != self.town_id {
                let cap = if token == COIN { self.limits.daily_coin_gain_cap.0 } else { self.limits.daily_gain_cap.0 };
                let key = (acct.clone(), token.clone());
                let used = match self.gain_caps.get(&key) {
                    Some((d0, u)) if *d0 == day => *u,
                    _ => 0,
                };
                let next = used.saturating_add(amount);
                require!(next <= cap, format!("daily gain cap reached for {acct} {token}"));
                self.gain_caps.insert(key, (day, next));
            }
            self.mint(token, acct, amount);
            events::mt_mint(acct.as_str(), &[token.clone()], &[U128(amount)], Some(&memo));
        }

        self.applied.insert((day, chunk));
        self.last_settled_day = day;
        events::gt_settle(day, chunk, &ledger_root, parsed.len());
    }

    pub fn get_day_root(&self, day: u64) -> Option<String> {
        self.roots.get(&day).cloned()
    }

    pub fn is_chunk_applied(&self, day: u64, chunk: u32) -> bool {
        self.applied.contains(&(day, chunk))
    }

    pub fn faucet_status(&self, day: u64, active_players: u32) -> FaucetView {
        let (start, minted) = self.day_faucet.get(&day).copied().unwrap_or((self.faucet_supply(), 0));
        FaucetView { allowed_today: U128(self.faucet_allowed(start, active_players)), minted_today: U128(minted), coin_supply: U128(self.supply_of(COIN)) }
    }
}
