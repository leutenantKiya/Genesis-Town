//! Genesis Town game contract (NEAR testnet).
//!
//! One NEP-245 multi-token contract holds every item type and the in-game `coin`.
//! - `mt.rs`: NEP-245 core (transfers with the 1 yoctoNEAR rule, transfer_call + resolve, views, events)
//! - `storage.rs`: NEP-145 storage management (registration-only; players are registered by the game server)
//! - `game.rs`: game methods. `mint_gathered` (minter role, idempotent by `mint_id`, daily caps) and
//!   `send_item` (zero deposit so a player's function-call session key can call it through the relayer; capped)
//!
//! Design notes: docs/architecture.md and docs/threat-model.md at the repository root.
use near_sdk::json_types::U128;
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{AccountId, BorshStorageKey, PanicOnDefault, env, near, require};

mod events;
mod game;
mod mt;
mod storage;

pub use game::MintEntry;

pub type TokenId = String;

pub const COIN: &str = "coin";
const NANOS_PER_DAY: u64 = 86_400_000_000_000;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Balances,
    Supply,
    Registered,
    UsedMintIds,
    GatherCaps,
    SendCaps,
    StoragePaid,
}

/// What kind of token an id is. Only `Raw` items can be minted by gathering.
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
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Limits {
    /// Max units of one raw item an account may receive from gathering per day.
    pub daily_gather_cap: U128,
    /// Max `send_item` calls per account per day.
    pub daily_sends: u32,
    /// Max units per `send_item` call.
    pub max_send_amount: U128,
    /// Max entries in one `mint_gathered` batch.
    pub max_batch: u32,
    /// Max accounts the server may register (the contract pays their storage).
    pub max_players: u32,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    minter_id: AccountId,
    town_id: AccountId,
    paused: bool,
    tokens: Vec<TokenMeta>,
    limits: Limits,
    balances: LookupMap<(TokenId, AccountId), u128>,
    supply: LookupMap<TokenId, u128>,
    registered: LookupSet<AccountId>,
    registered_count: u32,
    used_mint_ids: LookupSet<String>,
    gather_caps: LookupMap<(AccountId, TokenId), (u64, u128)>,
    send_caps: LookupMap<AccountId, (u64, u32)>,
    storage_paid: LookupMap<AccountId, u128>,
}

impl Contract {
    fn token(&self, token_id: &str) -> Option<&TokenMeta> {
        self.tokens.iter().find(|t| t.token_id == token_id)
    }

    fn require_token(&self, token_id: &str) -> &TokenMeta {
        match self.token(token_id) {
            Some(t) => t,
            None => env::panic_str(&format!("unknown token {token_id}")),
        }
    }

    fn require_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "only the owner");
    }

    fn require_not_paused(&self) {
        require!(!self.paused, "contract is paused");
    }

    fn require_registered(&self, account_id: &AccountId) {
        require!(self.registered.contains(account_id), format!("{account_id} is not registered"));
    }

    fn today() -> u64 {
        env::block_timestamp() / NANOS_PER_DAY
    }

    pub(crate) fn balance(&self, token_id: &str, account_id: &AccountId) -> u128 {
        self.balances.get(&(token_id.to_string(), account_id.clone())).copied().unwrap_or(0)
    }

    pub(crate) fn credit(&mut self, token_id: &str, account_id: &AccountId, amount: u128) {
        let key = (token_id.to_string(), account_id.clone());
        let new = self.balances.get(&key).copied().unwrap_or(0).checked_add(amount).unwrap_or_else(|| env::panic_str("balance overflow"));
        self.balances.insert(key, new);
    }

    pub(crate) fn debit(&mut self, token_id: &str, account_id: &AccountId, amount: u128) {
        let key = (token_id.to_string(), account_id.clone());
        let have = self.balances.get(&key).copied().unwrap_or(0);
        require!(have >= amount, format!("not enough {token_id}: have {have}, need {amount}"));
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
    #[init]
    pub fn new(owner_id: AccountId, minter_id: AccountId, town_id: AccountId, tokens: Vec<TokenMeta>, limits: Limits) -> Self {
        require!(!tokens.is_empty(), "at least one token");
        for (i, t) in tokens.iter().enumerate() {
            require!(!t.token_id.is_empty() && t.token_id.len() <= 32, "token ids are 1-32 chars");
            require!(tokens[..i].iter().all(|o| o.token_id != t.token_id), "duplicate token id");
        }
        require!(tokens.iter().any(|t| t.token_id == COIN && t.kind == TokenKind::Currency), "a `coin` currency token is required");
        Self {
            owner_id,
            minter_id,
            town_id,
            paused: false,
            tokens,
            limits,
            balances: LookupMap::new(StorageKey::Balances),
            supply: LookupMap::new(StorageKey::Supply),
            registered: LookupSet::new(StorageKey::Registered),
            registered_count: 0,
            used_mint_ids: LookupSet::new(StorageKey::UsedMintIds),
            gather_caps: LookupMap::new(StorageKey::GatherCaps),
            send_caps: LookupMap::new(StorageKey::SendCaps),
            storage_paid: LookupMap::new(StorageKey::StoragePaid),
        }
    }

    /* ----------------------------------------------------------- owner */

    pub fn set_minter(&mut self, minter_id: AccountId) {
        self.require_owner();
        self.minter_id = minter_id;
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

    pub fn get_config(&self) -> serde_json_config::Config {
        serde_json_config::Config {
            owner_id: self.owner_id.clone(),
            minter_id: self.minter_id.clone(),
            town_id: self.town_id.clone(),
            paused: self.paused,
            tokens: self.tokens.clone(),
            limits: self.limits.clone(),
            registered_count: self.registered_count,
        }
    }

    pub fn is_registered(&self, account_id: AccountId) -> bool {
        self.registered.contains(&account_id)
    }

    pub fn is_mint_id_used(&self, mint_id: String) -> bool {
        self.used_mint_ids.contains(&mint_id)
    }

    /// How many more units of `token_id` this account may gather today.
    pub fn gather_allowance(&self, account_id: AccountId, token_id: TokenId) -> U128 {
        let cap = self.limits.daily_gather_cap.0;
        match self.gather_caps.get(&(account_id, token_id)) {
            Some((day, used)) if *day == Self::today() => U128(cap.saturating_sub(*used)),
            _ => U128(cap),
        }
    }
}

mod serde_json_config {
    use super::*;
    #[near(serializers = [json])]
    pub struct Config {
        pub owner_id: AccountId,
        pub minter_id: AccountId,
        pub town_id: AccountId,
        pub paused: bool,
        pub tokens: Vec<TokenMeta>,
        pub limits: Limits,
        pub registered_count: u32,
    }
}

#[cfg(test)]
mod tests;
