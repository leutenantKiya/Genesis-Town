//! Private Islands (v5). An island is a NEP-245 token `IS-<id>-<version>` with supply 1 in this contract.
//! - `buy_island`: the server signs a voucher (ed25519, key in `voucher_pk`) naming the buyer, island, spec and price.
//!   The buyer submits it; coin goes buyer -> broker and is burned, `IS-<id>-1` is minted to the broker and moved to the
//!   buyer, all in one call. The island id can be bought once, so a voucher cannot be replayed.
//! - `save_island` ("Save World"): the owner swaps `IS-<id>-<v>` for `IS-<id>-<v+1>` carrying upgraded attributes
//!   (burn + mint in one call). Only the current version has a balance.
//!
//! Settlement keeps using `require_token` (the registry), so it can never mint or move island tokens.
//! This file also holds the v4 -> v5 `migrate`.
use crate::shops;
use crate::{COIN, Contract, ContractExt, Limits, StorageKey, TokenId, TokenMeta, events, market, projects};
use near_sdk::json_types::{Base64VecU8, U64, U128};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{AccountId, PublicKey, env, near, require};

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct IslandSpec {
    pub seed: u32,
    pub size_level: u8,
    pub fertility_level: u8,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Island {
    pub owner: AccountId,
    pub version: u32,
    pub spec: IslandSpec,
    pub created_ns: u64,
}

#[near(serializers = [json])]
pub struct IslandView {
    pub island_id: u32,
    pub token_id: String,
    pub owner_id: AccountId,
    pub version: u32,
    pub spec: IslandSpec,
}

pub fn island_token(id: u32, version: u32) -> String {
    format!("IS-{id}-{version}")
}

/// `IS-<id>-<v>` -> `(id, v)`; ids and versions are canonical decimals >= 1.
pub fn parse_island(token_id: &str) -> Option<(u32, u32)> {
    let rest = token_id.strip_prefix("IS-")?;
    let (a, b) = rest.split_once('-')?;
    let (id, v) = (a.parse::<u32>().ok()?, b.parse::<u32>().ok()?);
    if id == 0 || v == 0 || island_token(id, v) != token_id {
        return None;
    }
    Some((id, v))
}

/// v4 state layout (the previous `Contract`), read once by `migrate`.
#[near(serializers = [borsh])]
pub struct ContractV4 {
    pub(crate) owner_id: AccountId,
    pub(crate) settler_id: AccountId,
    pub(crate) town_id: AccountId,
    pub(crate) paused: bool,
    pub(crate) tokens: Vec<TokenMeta>,
    pub(crate) limits: Limits,
    pub(crate) balances: LookupMap<(TokenId, AccountId), u128>,
    pub(crate) supply: LookupMap<TokenId, u128>,
    pub(crate) registered: LookupSet<AccountId>,
    pub(crate) registered_count: u32,
    pub(crate) applied: LookupSet<(u64, u32)>,
    pub(crate) roots: LookupMap<u64, String>,
    pub(crate) last_settled_day: u64,
    pub(crate) gain_caps: LookupMap<(AccountId, TokenId), (u64, u128)>,
    pub(crate) day_faucet: LookupMap<u64, (u128, u128)>,
    pub(crate) send_caps: LookupMap<AccountId, (u64, u32)>,
    pub(crate) storage_paid: LookupMap<AccountId, u128>,
    pub(crate) merchants: Vec<AccountId>,
    pub(crate) shops: LookupMap<AccountId, shops::Shop>,
    pub(crate) shares: LookupMap<(AccountId, AccountId), shops::Holding>,
    pub(crate) dividends_paid: LookupSet<(AccountId, u64)>,
    pub(crate) listings: LookupMap<u64, market::Listing>,
    pub(crate) next_listing_id: u64,
    pub(crate) open_listings: LookupMap<AccountId, u32>,
    pub(crate) market_fee_bps: u16,
    pub(crate) projects: LookupMap<String, projects::Project>,
    pub(crate) project_ids: Vec<String>,
}

/// The 32 raw key bytes of an ed25519 `PublicKey` (its first byte is the curve type, 0 = ed25519).
fn raw_key(pk: &PublicKey) -> Vec<u8> {
    let b = pk.as_bytes();
    require!(b.len() == 33 && b[0] == 0, "voucher key must be an ed25519 key");
    b[1..].to_vec()
}

impl Contract {
    /// Registry tokens, or the current version of an island. Used by transfers (never by settlement).
    pub(crate) fn require_transferable(&self, token_id: &str) {
        if self.token(token_id).is_some() {
            return;
        }
        match parse_island(token_id) {
            Some((id, v)) if self.islands.get(&id).is_some_and(|i| i.version == v) => {}
            _ => env::panic_str(&format!("unknown token {token_id}")),
        }
    }

    /// Called by `credit`: whoever receives the current version of an island becomes its owner.
    pub(crate) fn island_owner_hook(&mut self, token_id: &str, account_id: &AccountId) {
        if let Some((id, v)) = parse_island(token_id)
            && let Some(i) = self.islands.get_mut(&id)
            && i.version == v
        {
            i.owner = account_id.clone();
        }
    }

    fn check_voucher(&self, message: &str, expires_ns: u64, signature: &[u8]) {
        require!(env::block_timestamp() <= expires_ns, "voucher expired");
        require!(self.voucher_pk.len() == 32, "voucher key not set");
        let sig: [u8; 64] = signature.try_into().unwrap_or_else(|_| env::panic_str("signature must be 64 bytes"));
        let pk: [u8; 32] = self.voucher_pk.as_slice().try_into().unwrap_or_else(|_| env::panic_str("bad voucher key"));
        require!(env::ed25519_verify(&sig, message.as_bytes(), &pk), "bad voucher signature");
    }

    fn view_island(&self, id: u32, i: &Island) -> IslandView {
        IslandView { island_id: id, token_id: island_token(id, i.version), owner_id: i.owner.clone(), version: i.version, spec: i.spec }
    }
}

#[near]
impl Contract {
    /// Upgrade from v4: keeps every v4 field, adds the island map, the broker and the voucher key, and appends tokens
    /// (e.g. Emas, Permata) that are not in the registry yet. Callable only by the contract account itself.
    #[private]
    #[init(ignore_state)]
    pub fn migrate(broker_id: AccountId, voucher_key: PublicKey, new_tokens: Vec<TokenMeta>) -> Self {
        let mut o: ContractV4 = env::state_read().unwrap_or_else(|| env::panic_str("no v4 state to migrate"));
        for t in new_tokens {
            require!(!t.token_id.is_empty() && t.token_id.len() <= 32 && !t.token_id.starts_with("IS-"), "bad token id");
            require!(o.tokens.iter().all(|x| x.token_id != t.token_id), "duplicate token id");
            o.tokens.push(t);
        }
        o.registered.insert(broker_id.clone());
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
            listings: o.listings,
            next_listing_id: o.next_listing_id,
            open_listings: o.open_listings,
            market_fee_bps: o.market_fee_bps,
            projects: o.projects,
            project_ids: o.project_ids,
            islands: LookupMap::new(StorageKey::Islands),
            broker_id,
            voucher_pk: raw_key(&voucher_key),
            island_ids: vec![],
        }
    }

    /// Owner: the ed25519 public key whose signatures authorise island vouchers.
    pub fn set_voucher_key(&mut self, public_key: PublicKey) {
        self.require_owner();
        self.voucher_pk = raw_key(&public_key);
    }

    /// Owner: the broker account that receives, burns and hands out island purchases. It gets registered.
    pub fn set_broker(&mut self, broker_id: AccountId) {
        self.require_owner();
        self.registered.insert(broker_id.clone());
        self.broker_id = broker_id;
    }

    /// Buyer: buys island `island_id` with a server voucher. No deposit (session key + relayer).
    pub fn buy_island(&mut self, island_id: u32, spec: IslandSpec, price: U128, expires_ns: U64, signature: Base64VecU8) {
        self.require_not_paused();
        let buyer = env::predecessor_account_id();
        self.require_registered(&buyer);
        require!(!self.is_merchant(&buyer) && buyer != self.broker_id, "merchants and the broker cannot buy islands");
        require!(island_id >= 1, "island ids start at 1");
        require!(self.islands.get(&island_id).is_none(), "island already sold");
        require!(price.0 > 0, "price must be positive");
        let msg = format!(
            "GT-ISLAND-BUY|{}|{}|{}|{}|{}|{}|{}|{}",
            env::current_account_id(), island_id, buyer, price.0, spec.seed, spec.size_level, spec.fertility_level, expires_ns.0
        );
        self.check_voucher(&msg, expires_ns.0, &signature.0);
        let broker = self.broker_id.clone();
        let token = island_token(island_id, 1);
        self.islands.insert(island_id, Island { owner: broker.clone(), version: 1, spec, created_ns: env::block_timestamp() });
        self.island_ids.push(island_id);
        // coin buyer -> broker, then burned
        self.internal_transfer(COIN, &buyer, &broker, price.0);
        events::mt_transfer(buyer.as_str(), broker.as_str(), &[COIN.to_string()], &[price], Some("island"));
        self.burn(COIN, &broker, price.0);
        events::mt_burn(broker.as_str(), &[COIN.to_string()], &[price], Some("island price"));
        // mint to the broker, then hand to the buyer
        self.mint(&token, &broker, 1);
        events::mt_mint(broker.as_str(), std::slice::from_ref(&token), &[U128(1)], Some("island"));
        self.internal_transfer(&token, &broker, &buyer, 1);
        events::mt_transfer(broker.as_str(), buyer.as_str(), &[token], &[U128(1)], Some("island"));
        events::gt_island("bought", island_id, 1, buyer.as_str());
    }

    /// Owner: Save World. Swaps `IS-<id>-<from_version>` for the next version carrying the upgraded `spec`.
    pub fn save_island(&mut self, island_id: u32, from_version: u32, spec: IslandSpec, expires_ns: U64, signature: Base64VecU8) {
        self.require_not_paused();
        let owner = env::predecessor_account_id();
        self.require_registered(&owner);
        let island = self.islands.get(&island_id).cloned().unwrap_or_else(|| env::panic_str("no such island"));
        require!(island.owner == owner, "only the island owner");
        require!(from_version == island.version, "stale island version");
        require!(spec.seed == island.spec.seed, "the seed cannot change");
        require!(
            spec.size_level >= island.spec.size_level && spec.fertility_level >= island.spec.fertility_level,
            "upgrades cannot be lowered"
        );
        let msg = format!(
            "GT-ISLAND-SAVE|{}|{}|{}|{}|{}|{}|{}|{}",
            env::current_account_id(), island_id, owner, from_version, spec.seed, spec.size_level, spec.fertility_level, expires_ns.0
        );
        self.check_voucher(&msg, expires_ns.0, &signature.0);
        let old = island_token(island_id, from_version);
        let new_version = from_version.checked_add(1).unwrap_or_else(|| env::panic_str("version overflow"));
        let new = island_token(island_id, new_version);
        self.burn(&old, &owner, 1);
        events::mt_burn(owner.as_str(), &[old], &[U128(1)], Some("island save"));
        if let Some(i) = self.islands.get_mut(&island_id) {
            i.version = new_version;
            i.spec = spec;
        }
        self.mint(&new, &owner, 1);
        events::mt_mint(owner.as_str(), &[new], &[U128(1)], Some("island save"));
        events::gt_island("saved", island_id, new_version, owner.as_str());
    }

    pub fn get_island(&self, island_id: u32) -> Option<IslandView> {
        self.islands.get(&island_id).map(|i| self.view_island(island_id, i))
    }
}
