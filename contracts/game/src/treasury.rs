//! Owner top-up of the town treasury (v5.2, no state migration).
//!
//! `mint_treasury` mints new `coin` straight into the town account (which `buy_coin` sells from), so the owner can
//! stock the treasury without moving coin around. The town balance may never exceed `TREASURY_MAX`.
//!
//! The coin faucet (settle.rs) shrinks as the coin supply M approaches the money cap, so a huge treasury mint must
//! not count as circulating money, or the daily faucet would drop to zero. The contract therefore remembers how much
//! coin it minted this way in a separate counter under its OWN storage key (`treasury_minted`, borsh `u128`), not as a
//! field of `Contract`, so the borsh layout of the deployed state is unchanged. The key starts with `t` (0x74), so it
//! cannot collide with the collection prefixes (single bytes 0..17) nor with the `STATE` key.
//!
//! `faucet_supply()` = total coin supply minus `min(treasury_minted, town balance)`: the part of the owner-minted
//! coin that still sits unspent in the treasury is ignored. Once the town hands coin out (buy_coin, starter kits)
//! beyond its original balance, that coin counts as circulating again, so the money cap still bites. The coin supply
//! counter itself (`mt_supply`) is always the true total.
use crate::{COIN, Contract, ContractExt, events};
use near_sdk::json_types::U128;
use near_sdk::{env, near, require};

pub const TREASURY_MAX: u128 = 1_000_000_000_000_000; // 10^15 coin
const MINTED_KEY: &[u8] = b"treasury_minted";
const MAX_MEMO: usize = 120;

#[near(serializers = [json])]
pub struct TreasuryStatus {
    /// Coin the town holds now.
    pub balance: U128,
    /// The most the town may hold (10^15).
    pub max: U128,
    /// How much more `mint_treasury` may add right now.
    pub room: U128,
}

fn read_minted() -> u128 {
    match env::storage_read(MINTED_KEY) {
        Some(b) => near_sdk::borsh::from_slice(&b).unwrap_or_else(|_| env::panic_str("corrupt treasury counter")),
        None => 0,
    }
}

fn write_minted(v: u128) {
    let bytes = near_sdk::borsh::to_vec(&v).unwrap_or_else(|_| env::panic_str("cannot encode treasury counter"));
    env::storage_write(MINTED_KEY, &bytes);
}

impl Contract {
    /// Coin supply as the faucet sees it: the total minus the owner-minted coin still unspent in the town treasury.
    pub(crate) fn faucet_supply(&self) -> u128 {
        let excluded = read_minted().min(self.balance(COIN, &self.town_id));
        self.supply_of(COIN).saturating_sub(excluded)
    }
}

#[near]
impl Contract {
    /// Owner: mints `amount` coin into the town treasury. The town balance after the mint must be <= 10^15.
    /// Emits `mt_mint` (memo `treasury`, plus `: <memo>` when given). Returns the new town balance.
    pub fn mint_treasury(&mut self, amount: U128, memo: Option<String>) -> U128 {
        self.require_owner();
        self.require_not_paused();
        require!(amount.0 > 0, "amount must be positive");
        let town = self.town_id.clone();
        let have = self.balance(COIN, &town);
        let room = TREASURY_MAX.saturating_sub(have);
        require!(
            have <= TREASURY_MAX && amount.0 <= room,
            format!("treasury balance would exceed the maximum of {TREASURY_MAX} coin: it holds {have}, room left {room}, asked {}", amount.0)
        );
        let note = match memo.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
            Some(m) => {
                require!(m.len() <= MAX_MEMO, "memo is at most 120 bytes");
                format!("treasury: {m}")
            }
            None => "treasury".to_string(),
        };
        self.mint(COIN, &town, amount.0);
        let minted = read_minted().checked_add(amount.0).unwrap_or_else(|| env::panic_str("treasury counter overflow"));
        write_minted(minted);
        events::mt_mint(town.as_str(), &[COIN.to_string()], &[amount], Some(&note));
        U128(have + amount.0)
    }

    pub fn treasury_status(&self) -> TreasuryStatus {
        let balance = self.balance(COIN, &self.town_id);
        TreasuryStatus { balance: U128(balance), max: U128(TREASURY_MAX), room: U128(TREASURY_MAX.saturating_sub(balance)) }
    }

    /// The coin supply the daily faucet counts: all coin minus the owner-minted coin still sitting in the treasury.
    /// The server's own faucet estimate reads this, so a treasury fill does not freeze town payouts.
    pub fn coin_faucet_supply(&self) -> U128 { U128(self.faucet_supply()) }
}
