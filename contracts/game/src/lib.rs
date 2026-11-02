//! Genesis Town game contract (NEAR testnet), v4.
//!
//! One NEP-245 multi-token contract holds every item type and the in-game `coin`.
//! - `mt.rs`: NEP-245 core (transfers with the 1 yoctoNEAR rule, transfer_call + resolve, views, events)
//! - `storage.rs`: NEP-145 storage management (registration only)
//! - `game.rs`: player registration and `send_item` (zero deposit, capped, callable by a session key)
//! - `settle.rs`: the daily settlement. Gathering, farming, crafting and merchant trades happen off-chain; once per
//!   game day the server's settler applies everyone's net changes here, and the contract enforces the economy's
//!   invariants (gain caps, the coin faucet and money cap, each chunk once) and stores the day's ledger root.
//! - `shops.rs`: merchant shops: bankruptcy, restoration boards (on-chain pledges), shares and dividends
//! - `market.rs`: the player market (escrowed listings, 5% fee burned)
//! - `projects.rs`: town projects that open new map areas (pledged goods are burned when built) and the v3 -> v4 `migrate`
//!
//! Design: docs/onchain-offchain.md, docs/economy.md, docs/threat-model.md.
use near_sdk::json_types::U128;
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{AccountId, BorshStorageKey, PanicOnDefault, env, near, require};

mod events;
mod game;
mod market;
mod mt;
mod projects;
mod settle;
mod shops;
mod storage;

pub use market::ListingView;
pub use projects::ProjectView;
pub use settle::Delta;
pub use shops::{RestoreLine, ShopView};

pub type TokenId = String;
pub const COIN: &str = "coin";

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Balances,
    Supply,
    Registered,
    Applied,
    Roots,
    GainCaps,
    SendCaps,
    StoragePaid,
    Shops,
    Shares,
    DayFaucet,
    Dividends,
    // added in v3 (player market); appended so existing prefixes stay the same
    Listings,
    OpenListings,
    // added in v4 (town projects)
    Projects,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TokenKind {
    Currency,
    Raw,
    Crafted,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct TokenMeta {
    pub token_id: TokenId,
    pub name: String,
    pub kind: TokenKind,
    /// Base value in coins; used to value restoration contributions and shop books.
    pub base: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Limits {
    /// Max net gain of one item per player account per game day (settlement).
    pub daily_gain_cap: U128,
    /// Max net coin gain per player account per game day (settlement).
    pub daily_coin_gain_cap: U128,
    pub daily_sends: u32,
    pub max_send_amount: U128,
    /// Max entries per settlement chunk.
    pub max_chunk: u32,
    pub max_players: u32,
    /// Coin faucet W0 and money cap Mcap0 (docs/economy.md section 3); scaled by k = min(max_k, 1 + active/divisor).
    pub faucet_w0: U128,
    pub money_cap0: U128,
    pub active_divisor: u32,
    pub max_k: u32,
    /// Shop rent per game day; a shop with less coin than this may be closed.
    pub rent: U128,
    pub initial_shares: U128,
    pub max_contributors: u32,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
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
    day_faucet: LookupMap<u64, (u128, u128)>, // day -> (coin supply at the day's first chunk, coin minted so far)
    send_caps: LookupMap<AccountId, (u64, u32)>,
    storage_paid: LookupMap<AccountId, u128>,
    merchants: Vec<AccountId>,
    shops: LookupMap<AccountId, shops::Shop>,
    shares: LookupMap<(AccountId, AccountId), shops::Holding>,
    dividends_paid: LookupSet<(AccountId, u64)>,
    // v3: player market (escrowed listings)
    listings: LookupMap<u64, market::Listing>,
    next_listing_id: u64,
    open_listings: LookupMap<AccountId, u32>,
    market_fee_bps: u16,
    // v4: town projects
    projects: LookupMap<String, projects::Project>,
    project_ids: Vec<String>,
}

impl Contract {
    pub(crate) fn token(&self, token_id: &str) -> Option<&TokenMeta> {
        self.tokens.iter().find(|t| t.token_id == token_id)
    }

    pub(crate) fn require_token(&self, token_id: &str) -> &TokenMeta {
        match self.token(token_id) {
            Some(t) => t,
            None => env::panic_str(&format!("unknown token {token_id}")),
        }
    }

    pub(crate) fn require_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "only the owner");
    }

    pub(crate) fn require_settler(&self) {
        require!(env::predecessor_account_id() == self.settler_id, "only the settler");
    }

    pub(crate) fn require_not_paused(&self) {
        require!(!self.paused, "contract is paused");
    }

    pub(crate) fn require_registered(&self, account_id: &AccountId) {
        require!(self.registered.contains(account_id), format!("{account_id} is not registered"));
    }

    pub(crate) fn is_merchant(&self, account_id: &AccountId) -> bool {
        self.shops.contains_key(account_id)
    }

    pub(crate) fn balance(&self, token_id: &str, account_id: &AccountId) -> u128 {
        self.balances.get(&(token_id.to_string(), account_id.clone())).copied().unwrap_or(0)
    }

    pub(crate) fn credit(&mut self, token_id: &str, account_id: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        let key = (token_id.to_string(), account_id.clone());
        let new = self.balances.get(&key).copied().unwrap_or(0).checked_add(amount).unwrap_or_else(|| env::panic_str("balance overflow"));
        self.balances.insert(key, new);
    }

    pub(crate) fn debit(&mut self, token_id: &str, account_id: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        let key = (token_id.to_string(), account_id.clone());
        let have = self.balances.get(&key).copied().unwrap_or(0);
        require!(have >= amount, format!("not enough {token_id} for {account_id}: have {have}, need {amount}"));
        if have == amount {
            self.balances.remove(&key);
        } else {
            self.balances.insert(key, have - amount);
        }
    }

    pub(crate) fn mint(&mut self, token_id: &str, account_id: &AccountId, amount: u128) {
        self.credit(token_id, account_id, amount);
        let s = self.supply.get(token_id).copied().unwrap_or(0).checked_add(amount).unwrap_or_else(|| env::panic_str("supply overflow"));
        self.supply.insert(token_id.to_string(), s);
    }

    pub(crate) fn burn(&mut self, token_id: &str, account_id: &AccountId, amount: u128) {
        self.debit(token_id, account_id, amount);
        let s = self.supply.get(token_id).copied().unwrap_or(0);
        self.supply.insert(token_id.to_string(), s.saturating_sub(amount));
    }

    pub(crate) fn supply_of(&self, token_id: &str) -> u128 {
        self.supply.get(token_id).copied().unwrap_or(0)
    }

    pub(crate) fn internal_transfer(&mut self, token_id: &str, from: &AccountId, to: &AccountId, amount: u128) {
        require!(amount > 0, "amount must be positive");
        require!(from != to, "sender and receiver must differ");
        self.require_token(token_id);
        self.require_registered(to);
        self.debit(token_id, from, amount);
        self.credit(token_id, to, amount);
    }
}

#[near]
impl Contract {
    /// `treasury_coin` is minted to the town account once (pays starter kits; counts toward the money supply).
    #[init]
    pub fn new(owner_id: AccountId, settler_id: AccountId, town_id: AccountId, tokens: Vec<TokenMeta>, limits: Limits, treasury_coin: U128) -> Self {
        require!(!tokens.is_empty(), "at least one token");
        for (i, t) in tokens.iter().enumerate() {
            require!(!t.token_id.is_empty() && t.token_id.len() <= 32, "token ids are 1-32 chars");
            require!(tokens[..i].iter().all(|o| o.token_id != t.token_id), "duplicate token id");
        }
        require!(tokens.iter().any(|t| t.token_id == COIN && t.kind == TokenKind::Currency), "a `coin` currency token is required");
        let mut c = Self {
            owner_id,
            settler_id,
            town_id: town_id.clone(),
            paused: false,
            tokens,
            limits,
            balances: LookupMap::new(StorageKey::Balances),
            supply: LookupMap::new(StorageKey::Supply),
            registered: LookupSet::new(StorageKey::Registered),
            registered_count: 0,
            applied: LookupSet::new(StorageKey::Applied),
            roots: LookupMap::new(StorageKey::Roots),
            last_settled_day: 0,
            gain_caps: LookupMap::new(StorageKey::GainCaps),
            day_faucet: LookupMap::new(StorageKey::DayFaucet),
            send_caps: LookupMap::new(StorageKey::SendCaps),
            storage_paid: LookupMap::new(StorageKey::StoragePaid),
            merchants: vec![],
            shops: LookupMap::new(StorageKey::Shops),
            shares: LookupMap::new(StorageKey::Shares),
            dividends_paid: LookupSet::new(StorageKey::Dividends),
            listings: LookupMap::new(StorageKey::Listings),
            next_listing_id: 0,
            open_listings: LookupMap::new(StorageKey::OpenListings),
            market_fee_bps: 500,
            projects: LookupMap::new(StorageKey::Projects),
            project_ids: vec![],
        };
        c.registered.insert(town_id.clone());
        if treasury_coin.0 > 0 {
            c.mint(COIN, &town_id, treasury_coin.0);
            events::mt_mint(town_id.as_str(), &[COIN.to_string()], &[treasury_coin], Some("treasury"));
        }
        c
    }

    /* ----------------------------------------------------------- owner */

    pub fn set_settler(&mut self, settler_id: AccountId) {
        self.require_owner();
        self.settler_id = settler_id;
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.require_owner();
        self.paused = paused;
    }

    pub fn set_limits(&mut self, limits: Limits) {
        self.require_owner();
        self.limits = limits;
    }

    /* ----------------------------------------------------------- views */

    pub fn get_config(&self) -> config_view::Config {
        config_view::Config {
            owner_id: self.owner_id.clone(),
            settler_id: self.settler_id.clone(),
            town_id: self.town_id.clone(),
            paused: self.paused,
            tokens: self.tokens.clone(),
            limits: self.limits.clone(),
            registered_count: self.registered_count,
            merchants: self.merchants.clone(),
            last_settled_day: self.last_settled_day,
        }
    }

    pub fn is_registered(&self, account_id: AccountId) -> bool {
        self.registered.contains(&account_id)
    }
}

mod config_view {
    use super::*;
    #[near(serializers = [json])]
    pub struct Config {
        pub owner_id: AccountId,
        pub settler_id: AccountId,
        pub town_id: AccountId,
        pub paused: bool,
        pub tokens: Vec<TokenMeta>,
        pub limits: Limits,
        pub registered_count: u32,
        pub merchants: Vec<AccountId>,
        pub last_settled_day: u64,
    }
}

#[cfg(test)]
mod tests;
