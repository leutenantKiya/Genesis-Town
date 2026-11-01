//! Merchant shops: bankruptcy, restoration boards, shares and dividends (docs/economy.md section 5).
//!
//! - A shop whose coin balance is below the daily rent can be closed by the settler. The contract checks the balance,
//!   so the rule is enforced on chain, not just claimed by the server.
//! - A closed shop shows a restoration board: a coin amount plus goods. Players pledge from their settled balances;
//!   pledges are held by the contract and can be withdrawn until the board is complete.
//! - When every line is met, the shop reopens: pledged goods and coin go to the merchant, and each contributor gets
//!   shares worth their contribution (valued at base prices) at the share price fixed when the shop closed.
//! - Dividends: the settler moves coin from a merchant's profit into the contract once per day; holders claim their
//!   part themselves (accumulator per share, so no loop over holders).
use crate::{COIN, Contract, ContractExt, events};
use near_sdk::json_types::U128;
use near_sdk::{AccountId, env, near, require};

const SCALE: u128 = 1_000_000_000_000; // fixed point for dividend-per-share

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct RestoreLine {
    pub token_id: String,
    pub amount: U128,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Contribution {
    pub account_id: AccountId,
    pub lines: Vec<(String, u128)>,
    pub value: u128,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Shop {
    pub name: String,
    pub open: bool,
    pub total_shares: u128,
    pub need: Vec<(String, u128)>,
    pub pledged: Vec<(String, u128)>,
    pub contributors: Vec<Contribution>,
    pub book_at_close: u128,
    pub shares_at_close: u128,
    pub acc_per_share: u128,
    pub times_closed: u32,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default)]
pub struct Holding {
    pub shares: u128,
    pub debt: u128,
}

#[near(serializers = [json])]
pub struct ShopView {
    pub account_id: AccountId,
    pub name: String,
    pub open: bool,
    pub coin: U128,
    pub rent: U128,
    pub total_shares: U128,
    pub need: Vec<RestoreLine>,
    pub pledged: Vec<RestoreLine>,
    pub contributors: u32,
    pub times_closed: u32,
}

#[near(serializers = [json])]
pub struct HoldingView {
    pub shares: U128,
    pub total_shares: U128,
    pub claimable: U128,
}

fn get_amount(v: &[(String, u128)], t: &str) -> u128 {
    v.iter().find(|(k, _)| k == t).map(|(_, a)| *a).unwrap_or(0)
}
fn add_amount(v: &mut Vec<(String, u128)>, t: &str, n: u128) {
    match v.iter_mut().find(|(k, _)| k == t) {
        Some((_, a)) => *a += n,
        None => v.push((t.to_string(), n)),
    }
}
fn sub_amount(v: &mut Vec<(String, u128)>, t: &str, n: u128) {
    if let Some((_, a)) = v.iter_mut().find(|(k, _)| k == t) {
        *a = a.saturating_sub(n);
    }
}
fn lines(v: &[(String, u128)]) -> Vec<RestoreLine> {
    v.iter().map(|(t, a)| RestoreLine { token_id: t.clone(), amount: U128(*a) }).collect()
}

impl Contract {
    fn shop(&self, merchant: &AccountId) -> Shop {
        self.shops.get(merchant).cloned().unwrap_or_else(|| env::panic_str(&format!("{merchant} is not a merchant")))
    }

    fn base_of(&self, token: &str) -> u128 {
        self.require_token(token).base.0
    }

    fn holding(&self, merchant: &AccountId, holder: &AccountId) -> Holding {
        self.shares.get(&(merchant.clone(), holder.clone())).cloned().unwrap_or_default()
    }

    /// Pays out pending dividends, then changes the share count.
    fn add_shares(&mut self, merchant: &AccountId, shop: &Shop, holder: &AccountId, add: u128) {
        let mut h = self.holding(merchant, holder);
        let pending = (h.shares * shop.acc_per_share / SCALE).saturating_sub(h.debt);
        if pending > 0 {
            self.debit(COIN, &env::current_account_id(), pending);
            self.credit(COIN, holder, pending);
        }
        h.shares += add;
        h.debt = h.shares * shop.acc_per_share / SCALE;
        self.shares.insert((merchant.clone(), holder.clone()), h);
    }

    fn book_value(&self, merchant: &AccountId) -> u128 {
        let mut book = self.balance(COIN, merchant);
        let tokens: Vec<(String, u128)> = self.tokens.iter().filter(|t| t.token_id != COIN).map(|t| (t.token_id.clone(), t.base.0)).collect();
        for (t, base) in tokens {
            book = book.saturating_add(self.balance(&t, merchant).saturating_mul(base));
        }
        book
    }

    fn reopen(&mut self, merchant: &AccountId, mut shop: Shop) {
        for (t, a) in shop.pledged.clone() {
            self.debit(&t, &env::current_account_id(), a);
            self.credit(&t, merchant, a);
        }
        // Share price fixed at close, never below the minimum (0.05 coin per share).
        let floor_book = shop.shares_at_close / 20;
        let book = shop.book_at_close.max(floor_book).max(1);
        let contributors = std::mem::take(&mut shop.contributors);
        for c in &contributors {
            let new_shares = c.value.saturating_mul(shop.shares_at_close) / book;
            self.add_shares(merchant, &shop, &c.account_id, new_shares);
            shop.total_shares += new_shares;
        }
        shop.open = true;
        shop.pledged.clear();
        events::gt_shop(merchant.as_str(), "reopened", contributors.len() as u32);
        self.shops.insert(merchant.clone(), shop);
    }
}

#[near]
impl Contract {
    /// Owner: registers a merchant shop, its restoration board, and its opening stock (minted; counts toward supply).
    /// The town treasury owns the initial shares.
    pub fn register_merchant(&mut self, account_id: AccountId, name: String, restore: Vec<RestoreLine>, start: Vec<RestoreLine>) {
        self.require_owner();
        require!(!self.is_merchant(&account_id), "already a merchant");
        require!(!restore.is_empty(), "restoration board needs at least one line");
        for l in restore.iter().chain(start.iter()) {
            self.require_token(&l.token_id);
        }
        self.registered.insert(account_id.clone());
        let shop = Shop {
            name,
            open: true,
            total_shares: self.limits.initial_shares.0,
            need: restore.iter().map(|l| (l.token_id.clone(), l.amount.0)).collect(),
            pledged: vec![],
            contributors: vec![],
            book_at_close: 0,
            shares_at_close: 0,
            acc_per_share: 0,
            times_closed: 0,
        };
        let town = self.town_id.clone();
        self.shares.insert((account_id.clone(), town), Holding { shares: self.limits.initial_shares.0, debt: 0 });
        self.shops.insert(account_id.clone(), shop);
        self.merchants.push(account_id.clone());
        for l in start {
            if l.amount.0 > 0 {
                self.mint(&l.token_id, &account_id, l.amount.0);
                events::mt_mint(account_id.as_str(), &[l.token_id], &[l.amount], Some("shop opening stock"));
            }
        }
    }

    /// Settler: closes a shop that cannot pay the daily rent. The contract checks the balance itself.
    pub fn close_shop(&mut self, merchant: AccountId) {
        self.require_settler();
        let mut shop = self.shop(&merchant);
        require!(shop.open, "shop is already closed");
        let coin = self.balance(COIN, &merchant);
        require!(coin < self.limits.rent.0, format!("shop can still pay rent ({coin} coin)"));
        shop.open = false;
        shop.book_at_close = self.book_value(&merchant);
        shop.shares_at_close = shop.total_shares;
        shop.times_closed += 1;
        shop.pledged.clear();
        shop.contributors.clear();
        self.shops.insert(merchant.clone(), shop);
        events::gt_shop(merchant.as_str(), "closed", 0);
    }

    /// Player: pledges coin and goods to a closed shop's restoration board, from the settled balance. Each line only
    /// accepts what is still missing. Completing the board reopens the shop and issues shares.
    pub fn restore_contribute(&mut self, merchant: AccountId, contribution: Vec<RestoreLine>) {
        self.require_not_paused();
        let player = env::predecessor_account_id();
        self.require_registered(&player);
        require!(player != merchant, "a merchant cannot restore itself");
        let mut shop = self.shop(&merchant);
        require!(!shop.open, "shop is open");
        let mut accepted: Vec<(String, u128)> = vec![];
        let mut value: u128 = 0;
        for l in &contribution {
            let missing = get_amount(&shop.need, &l.token_id).saturating_sub(get_amount(&shop.pledged, &l.token_id));
            let take = l.amount.0.min(missing);
            if take == 0 {
                continue;
            }
            self.debit(&l.token_id, &player, take);
            self.credit(&l.token_id, &env::current_account_id(), take);
            add_amount(&mut shop.pledged, &l.token_id, take);
            add_amount(&mut accepted, &l.token_id, take);
            value += take * self.base_of(&l.token_id);
        }
        require!(!accepted.is_empty(), "nothing on the board still needs that");
        match shop.contributors.iter_mut().find(|c| c.account_id == player) {
            Some(c) => {
                for (t, a) in &accepted {
                    add_amount(&mut c.lines, t, *a);
                }
                c.value += value;
            }
            None => {
                require!((shop.contributors.len() as u32) < self.limits.max_contributors, "too many contributors on this board");
                shop.contributors.push(Contribution { account_id: player.clone(), lines: accepted.clone(), value });
            }
        }
        events::gt_shop(merchant.as_str(), "pledge", shop.contributors.len() as u32);
        let complete = shop.need.iter().all(|(t, a)| get_amount(&shop.pledged, t) >= *a);
        if complete {
            self.reopen(&merchant, shop);
        } else {
            self.shops.insert(merchant, shop);
        }
    }

    /// Player: takes back their pledge while the board is not yet complete.
    pub fn restore_withdraw(&mut self, merchant: AccountId) {
        let player = env::predecessor_account_id();
        let mut shop = self.shop(&merchant);
        require!(!shop.open, "shop is open; pledges were converted to shares");
        let idx = shop.contributors.iter().position(|c| c.account_id == player).unwrap_or_else(|| env::panic_str("no pledge to withdraw"));
        let c = shop.contributors.remove(idx);
        for (t, a) in &c.lines {
            self.debit(t, &env::current_account_id(), *a);
            self.credit(t, &player, *a);
            sub_amount(&mut shop.pledged, t, *a);
        }
        self.shops.insert(merchant, shop);
    }

    /// Settler: pays `amount` coin of a merchant's profit as dividends, at most once per merchant and day.
    pub fn pay_dividend(&mut self, merchant: AccountId, day: u64, amount: U128) {
        self.require_settler();
        let mut shop = self.shop(&merchant);
        require!(shop.open, "closed shops pay no dividends");
        require!(self.dividends_paid.insert((merchant.clone(), day)), "dividend already paid for this day");
        if amount.0 == 0 {
            return;
        }
        self.debit(COIN, &merchant, amount.0);
        self.credit(COIN, &env::current_account_id(), amount.0);
        shop.acc_per_share += amount.0 * SCALE / shop.total_shares.max(1);
        self.shops.insert(merchant.clone(), shop);
        events::gt_shop(merchant.as_str(), "dividend", 0);
    }

    /// Holder: claims accumulated dividends from one shop. Returns the amount paid.
    pub fn claim_dividends(&mut self, merchant: AccountId) -> U128 {
        let holder = env::predecessor_account_id();
        let shop = self.shop(&merchant);
        let h = self.holding(&merchant, &holder);
        let pending = (h.shares * shop.acc_per_share / SCALE).saturating_sub(h.debt);
        if pending == 0 {
            return U128(0);
        }
        self.add_shares(&merchant, &shop, &holder, 0);
        U128(pending)
    }

    /* ----------------------------------------------------------- views */

    pub fn get_shop(&self, merchant: AccountId) -> ShopView {
        let s = self.shop(&merchant);
        ShopView {
            account_id: merchant.clone(),
            name: s.name.clone(),
            open: s.open,
            coin: U128(self.balance(COIN, &merchant)),
            rent: self.limits.rent,
            total_shares: U128(s.total_shares),
            need: lines(&s.need),
            pledged: lines(&s.pledged),
            contributors: s.contributors.len() as u32,
            times_closed: s.times_closed,
        }
    }

    pub fn list_shops(&self) -> Vec<ShopView> {
        self.merchants.iter().map(|m| self.get_shop(m.clone())).collect()
    }

    pub fn get_holding(&self, merchant: AccountId, holder: AccountId) -> HoldingView {
        let s = self.shop(&merchant);
        let h = self.holding(&merchant, &holder);
        HoldingView {
            shares: U128(h.shares),
            total_shares: U128(s.total_shares),
            claimable: U128((h.shares * s.acc_per_share / SCALE).saturating_sub(h.debt)),
        }
    }
}
