//! Player market (v3): players list items for coin; goods are escrowed by the contract until bought or cancelled.
//! On-chain immediately (player-to-player value), no deposit so a session key can call it through the relayer.
//! - list_item: items move from the seller's settled balance into escrow; at most 5 open listings per account
//! - buy_listing: the buyer pays price x amount in coin; 5% fee is burned (market_fee_bps), the rest goes to the seller;
//!   `max_price_each` protects the buyer against a price change between seeing and buying
//! - cancel_listing: the seller takes the escrow back
//! Wash trading: buyer and seller must differ, and every sale burns the fee. Merchant prices ignore this market.
//! `migrate` upgrades a v2 contract in place (adds the market fields, keeps all state).
use crate::{COIN, Contract, ContractExt, Limits, StorageKey, TokenId, TokenKind, TokenMeta, events, shops};
use near_sdk::json_types::U128;
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{AccountId, env, near, require};

pub const MAX_OPEN_LISTINGS: u32 = 5;
const MAX_LIST_AMOUNT: u128 = 50;
const MAX_PRICE_EACH: u128 = 100_000;

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Listing {
    pub seller: AccountId,
    pub token_id: TokenId,
    pub amount: u128,
    pub price_each: u128,
    pub created_ns: u64,
}

#[near(serializers = [json])]
pub struct ListingView {
    pub id: u64,
    pub seller: AccountId,
    pub token_id: TokenId,
    pub amount: U128,
    pub price_each: U128,
    pub created_ns: u64,
}

/// v2 state layout, read once by `migrate`.
#[near(serializers = [borsh])]
pub struct ContractV2 {
    owner_id: AccountId,
    settler_id: AccountId,
    town_id: AccountId,
    paused: bool,
    tokens: Vec<TokenMeta>,
    limits: Limits,
    balances: LookupMap<(TokenId, AccountId), u128>,
    supply: LookupMap<TokenId, u128>,
    registered: LookupSet<AccountId>,
    registered_count: u32,
    applied: LookupSet<(u64, u32)>,
    roots: LookupMap<u64, String>,
    last_settled_day: u64,
    gain_caps: LookupMap<(AccountId, TokenId), (u64, u128)>,
    day_faucet: LookupMap<u64, (u128, u128)>,
    send_caps: LookupMap<AccountId, (u64, u32)>,
    storage_paid: LookupMap<AccountId, u128>,
    merchants: Vec<AccountId>,
    shops: LookupMap<AccountId, shops::Shop>,
    shares: LookupMap<(AccountId, AccountId), shops::Holding>,
    dividends_paid: LookupSet<(AccountId, u64)>,
}

impl Contract {
    fn listing(&self, id: u64) -> Listing {
        self.listings.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such listing"))
    }
    fn view_listing(id: u64, l: &Listing) -> ListingView {
        ListingView { id, seller: l.seller.clone(), token_id: l.token_id.clone(), amount: U128(l.amount), price_each: U128(l.price_each), created_ns: l.created_ns }
    }
    fn close_listing(&mut self, id: u64, seller: &AccountId) {
        self.listings.remove(&id);
        let n = self.open_listings.get(seller).copied().unwrap_or(1);
        if n <= 1 { self.open_listings.remove(seller); } else { self.open_listings.insert(seller.clone(), n - 1); }
    }
}

#[near]
impl Contract {
    /// Upgrade from v2: keeps every v2 field and adds the empty market. Callable only by the contract account itself
    /// (as part of a deploy with an init call).
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let o: ContractV2 = env::state_read().unwrap_or_else(|| env::panic_str("no v2 state to migrate"));
        Self {
            owner_id: o.owner_id,
            settler_id: o.settler_id,
            town_id: o.town_id,
            paused: o.paused,
            tokens: o.tokens,
            limits: o.limits,
            balances: o.balances,
            supply: o.supply,
            registered: o.registered,
            registered_count: o.registered_count,
            applied: o.applied,
            roots: o.roots,
            last_settled_day: o.last_settled_day,
            gain_caps: o.gain_caps,
            day_faucet: o.day_faucet,
            send_caps: o.send_caps,
            storage_paid: o.storage_paid,
            merchants: o.merchants,
            shops: o.shops,
            shares: o.shares,
            dividends_paid: o.dividends_paid,
            listings: LookupMap::new(StorageKey::Listings),
            next_listing_id: 0,
            open_listings: LookupMap::new(StorageKey::OpenListings),
            market_fee_bps: 500,
        }
    }

    /// Seller: escrow `amount` of an item and offer it at `price_each` coin. Returns the listing id.
    pub fn list_item(&mut self, token_id: TokenId, amount: U128, price_each: U128) -> u64 {
        self.require_not_paused();
        let seller = env::predecessor_account_id();
        self.require_registered(&seller);
        require!(!self.is_merchant(&seller), "merchants trade through their shops");
        require!(self.require_token(&token_id).kind != TokenKind::Currency, "coin cannot be listed");
        require!(amount.0 >= 1 && amount.0 <= MAX_LIST_AMOUNT, "amount must be 1-50");
        require!(price_each.0 >= 1 && price_each.0 <= MAX_PRICE_EACH, "price out of range");
        let open = self.open_listings.get(&seller).copied().unwrap_or(0);
        require!(open < MAX_OPEN_LISTINGS, "at most 5 open listings");
        self.debit(&token_id, &seller, amount.0);
        self.credit(&token_id, &env::current_account_id(), amount.0);
        let id = self.next_listing_id;
        self.next_listing_id += 1;
        self.listings.insert(id, Listing { seller: seller.clone(), token_id: token_id.clone(), amount: amount.0, price_each: price_each.0, created_ns: env::block_timestamp() });
        self.open_listings.insert(seller.clone(), open + 1);
        events::gt_market("listed", id, seller.as_str(), &token_id, amount.0, price_each.0);
        id
    }

    /// Buyer: buy `amount` from a listing, paying at most `max_price_each` per unit. 5% of the price is burned.
    pub fn buy_listing(&mut self, listing_id: u64, amount: U128, max_price_each: U128) {
        self.require_not_paused();
        let buyer = env::predecessor_account_id();
        self.require_registered(&buyer);
        let mut l = self.listing(listing_id);
        require!(buyer != l.seller, "cannot buy your own listing");
        require!(l.price_each <= max_price_each.0, "price is above your limit");
        require!(amount.0 >= 1 && amount.0 <= l.amount, "amount not available");
        let total = l.price_each.checked_mul(amount.0).unwrap_or_else(|| env::panic_str("overflow"));
        let fee = total * self.market_fee_bps as u128 / 10_000;
        self.debit(COIN, &buyer, total);
        self.credit(COIN, &l.seller, total - fee);
        if fee > 0 {
            let s = self.supply_of(COIN);
            self.supply.insert(COIN.to_string(), s.saturating_sub(fee));
            events::mt_burn(buyer.as_str(), &[COIN.to_string()], &[U128(fee)], Some("market fee"));
        }
        self.debit(&l.token_id, &env::current_account_id(), amount.0);
        self.credit(&l.token_id, &buyer, amount.0);
        events::mt_transfer(l.seller.as_str(), buyer.as_str(), &[l.token_id.clone()], &[amount], Some("market"));
        l.amount -= amount.0;
        let seller = l.seller.clone();
        events::gt_market("bought", listing_id, buyer.as_str(), &l.token_id, amount.0, l.price_each);
        if l.amount == 0 { self.close_listing(listing_id, &seller); } else { self.listings.insert(listing_id, l); }
    }

    /// Seller: cancel a listing and take the escrowed goods back.
    pub fn cancel_listing(&mut self, listing_id: u64) {
        let l = self.listing(listing_id);
        require!(env::predecessor_account_id() == l.seller, "only the seller can cancel");
        self.debit(&l.token_id, &env::current_account_id(), l.amount);
        self.credit(&l.token_id, &l.seller, l.amount);
        events::gt_market("cancelled", listing_id, l.seller.as_str(), &l.token_id, l.amount, l.price_each);
        self.close_listing(listing_id, &l.seller);
    }

    pub fn get_listing(&self, listing_id: u64) -> Option<ListingView> {
        self.listings.get(&listing_id).map(|l| Self::view_listing(listing_id, l))
    }

    /// Open listings, newest first, scanning back from the latest id (bounded).
    pub fn list_listings(&self, limit: Option<u32>) -> Vec<ListingView> {
        let limit = limit.unwrap_or(50).min(100) as usize;
        let mut out = vec![];
        let mut id = self.next_listing_id;
        let mut scanned = 0;
        while id > 0 && out.len() < limit && scanned < 2000 {
            id -= 1;
            scanned += 1;
            if let Some(l) = self.listings.get(&id) { out.push(Self::view_listing(id, l)); }
        }
        out
    }

    pub fn market_fee_bps(&self) -> u16 { self.market_fee_bps }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Limits, TokenKind, TokenMeta};
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn acc(s: &str) -> AccountId { s.parse().unwrap() }

    #[test]
    fn migrate_keeps_v2_state_and_adds_an_empty_market() {
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc("game.testnet")).predecessor_account_id(acc("game.testnet"));
        testing_env!(b.build());
        let tokens = vec![TokenMeta { token_id: "coin".into(), name: "Koin".into(), kind: TokenKind::Currency, base: U128(1) }];
        let limits = Limits { daily_gain_cap: U128(1), daily_coin_gain_cap: U128(1), daily_sends: 1, max_send_amount: U128(1), max_chunk: 1, max_players: 7, faucet_w0: U128(1), money_cap0: U128(1), active_divisor: 1, max_k: 1, rent: U128(40), initial_shares: U128(1000), max_contributors: 1 };
        let mut balances = LookupMap::new(StorageKey::Balances);
        balances.insert(("coin".to_string(), acc("alice.testnet")), 123u128);
        balances.flush();
        let v2 = ContractV2 {
            owner_id: acc("owner.testnet"), settler_id: acc("settler.testnet"), town_id: acc("town.testnet"), paused: false,
            tokens, limits, balances, supply: LookupMap::new(StorageKey::Supply), registered: LookupSet::new(StorageKey::Registered),
            registered_count: 3, applied: LookupSet::new(StorageKey::Applied), roots: LookupMap::new(StorageKey::Roots), last_settled_day: 9,
            gain_caps: LookupMap::new(StorageKey::GainCaps), day_faucet: LookupMap::new(StorageKey::DayFaucet), send_caps: LookupMap::new(StorageKey::SendCaps),
            storage_paid: LookupMap::new(StorageKey::StoragePaid), merchants: vec![acc("joko.testnet")], shops: LookupMap::new(StorageKey::Shops),
            shares: LookupMap::new(StorageKey::Shares), dividends_paid: LookupSet::new(StorageKey::Dividends),
        };
        env::state_write(&v2);
        let c = Contract::migrate();
        assert_eq!(c.registered_count, 3);
        assert_eq!(c.last_settled_day, 9);
        assert_eq!(c.merchants, vec![acc("joko.testnet")]);
        assert_eq!(c.balance("coin", &acc("alice.testnet")), 123);
        assert_eq!(c.next_listing_id, 0);
        assert_eq!(c.market_fee_bps, 500);
        assert!(c.list_listings(None).is_empty());
    }
}
