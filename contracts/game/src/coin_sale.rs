//! Buying game coin with NEAR (v5.1, no state migration).
//!
//! The sale settings live under their OWN storage key (`coin_sale`, borsh), not as a field of `Contract`, so the
//! borsh layout of the deployed contract state is unchanged and the new wasm can be deployed over the old state
//! without `migrate`. The key starts with `c` (0x63), so it cannot collide with the collection prefixes (single
//! bytes 0..17) nor with the `STATE` key.
//!
//! `buy_coin(receiver_id?)`: the payer attaches NEAR, the receiver (default the payer) gets `floor(deposit * coin_per_near / 1 NEAR)` coin moved out of the town
//! treasury (never minted, so the money supply and the faucet are untouched), the unused dust is refunded, and the
//! spent NEAR is split: `dev_bps / 10000` to the developer account, the rest to the town account.
use crate::{COIN, Contract, ContractExt, events};
use near_sdk::json_types::U128;
use near_sdk::{AccountId, NearToken, Promise, env, near, require};

pub const COIN_SALE_KEY: &[u8] = b"coin_sale";
const YOCTO_PER_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const BPS: u128 = 10_000;

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CoinSale {
    pub dev_id: AccountId,
    pub coin_per_near: u32,
    pub dev_bps: u16,
    pub max_coin_per_call: U128,
    pub enabled: bool,
}

pub(crate) fn read_sale() -> Option<CoinSale> {
    let bytes = env::storage_read(COIN_SALE_KEY)?;
    Some(near_sdk::borsh::from_slice(&bytes).unwrap_or_else(|_| env::panic_str("corrupt coin sale settings")))
}

fn write_sale(s: &CoinSale) {
    let bytes = near_sdk::borsh::to_vec(s).unwrap_or_else(|_| env::panic_str("cannot encode coin sale settings"));
    env::storage_write(COIN_SALE_KEY, &bytes);
}

/// Pure sale math: returns (coin, cost, dev_share, town_share) for a deposit; panics outside 1..=max coin.
pub(crate) fn quote(s: &CoinSale, deposit: u128) -> (u128, u128, u128, u128) {
    let rate = s.coin_per_near as u128;
    let coin = deposit.checked_mul(rate).unwrap_or_else(|| env::panic_str("deposit too large")) / YOCTO_PER_NEAR;
    require!(coin >= 1, format!("deposit too small: at least {} yoctoNEAR buys 1 coin", YOCTO_PER_NEAR / rate));
    require!(coin <= s.max_coin_per_call.0, format!("too much coin in one call: {coin} > {} allowed", s.max_coin_per_call.0));
    let cost = coin * YOCTO_PER_NEAR / rate; // exact: set_coin_sale requires coin_per_near to divide 10^24
    let dev = cost * s.dev_bps as u128 / BPS;
    (coin, cost, dev, cost - dev)
}

#[near]
impl Contract {
    /// Owner: configures the coin sale. `coin_per_near` must divide 10^24 (so the price of a coin is exact),
    /// `dev_bps` is the developer's cut in basis points (1000 = 10%).
    pub fn set_coin_sale(&mut self, dev_id: AccountId, coin_per_near: u32, dev_bps: u16, max_coin_per_call: U128, enabled: bool) {
        self.require_owner();
        require!(coin_per_near > 0 && YOCTO_PER_NEAR % coin_per_near as u128 == 0, "coin_per_near must be positive and divide 10^24");
        require!(dev_bps as u128 <= BPS, "dev_bps is at most 10000");
        require!(max_coin_per_call.0 > 0, "max_coin_per_call must be positive");
        write_sale(&CoinSale { dev_id, coin_per_near, dev_bps, max_coin_per_call, enabled });
    }

    pub fn coin_sale(&self) -> Option<CoinSale> {
        read_sale()
    }

    /// Buys coin with the attached NEAR for `receiver_id` (default: the caller). The caller pays and gets the dust
    /// refund; the receiver must be registered. Returns the coin bought.
    #[payable]
    pub fn buy_coin(&mut self, receiver_id: Option<AccountId>) -> U128 {
        self.require_not_paused();
        let payer = env::predecessor_account_id();
        let receiver = receiver_id.unwrap_or_else(|| payer.clone());
        self.require_registered(&receiver);
        let sale = read_sale().unwrap_or_else(|| env::panic_str("coin sale is not configured"));
        require!(sale.enabled, "coin sale is not enabled");
        let deposit = env::attached_deposit().as_yoctonear();
        let (coin, cost, dev, town_share) = quote(&sale, deposit);
        let town = self.town_id.clone();
        let have = self.balance(COIN, &town);
        require!(have >= coin, format!("the town treasury is short of coin: has {have}, needs {coin}"));

        self.internal_transfer(COIN, &town, &receiver, coin);
        let memo = if receiver == payer { "buy_coin".to_string() } else { format!("buy_coin by {payer}") };
        events::mt_transfer(town.as_str(), receiver.as_str(), &[COIN.to_string()], &[U128(coin)], Some(&memo));

        if dev > 0 {
            Promise::new(sale.dev_id.clone()).transfer(NearToken::from_yoctonear(dev)).detach();
        }
        if town_share > 0 {
            Promise::new(town).transfer(NearToken::from_yoctonear(town_share)).detach();
        }
        if deposit > cost {
            Promise::new(payer).transfer(NearToken::from_yoctonear(deposit - cost)).detach();
        }
        U128(coin)
    }
}
