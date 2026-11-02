//! Town projects (v4): the village pools goods and coin to build something that changes the map for everyone, such as
//! the bridge to Dusun Seberang. Works like a restoration board without a merchant:
//! - the owner creates a project with what it needs and the map area (chunk) it opens;
//! - players pledge from their settled balances (no deposit, so a session key can do it through the relayer); pledges
//!   are held by the contract and can be withdrawn until the project is complete;
//! - when every line is met the project is done: the pledged goods and coin are burned (used to build it), which is
//!   one of the economy's sinks, and contributors are kept on the project as its plaque.
//! The server watches `get_project` and opens the chunk on the shared map when `done` is true.
//! `migrate` upgrades a v3 contract (player market) in place, keeping all state.
use crate::shops::{Contribution, RestoreLine, add_amount, get_amount, sub_amount};
use crate::{Contract, ContractExt, Limits, StorageKey, TokenId, TokenMeta, events, market, shops};
use near_sdk::json_types::U128;
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{AccountId, env, near, require};

const MAX_PROJECTS: usize = 20;

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Project {
    pub name: String,
    pub chunk: String,
    pub need: Vec<(String, u128)>,
    pub pledged: Vec<(String, u128)>,
    pub contributors: Vec<Contribution>,
    pub done: bool,
    pub done_ns: u64,
}

#[near(serializers = [json])]
pub struct ProjectView {
    pub id: String,
    pub name: String,
    pub chunk: String,
    pub need: Vec<RestoreLine>,
    pub pledged: Vec<RestoreLine>,
    pub contributors: Vec<ContributorView>,
    pub done: bool,
    pub done_ns: u64,
}

#[near(serializers = [json])]
pub struct ContributorView {
    pub account_id: AccountId,
    pub lines: Vec<RestoreLine>,
}

fn lines(v: &[(String, u128)]) -> Vec<RestoreLine> {
    v.iter().map(|(t, a)| RestoreLine { token_id: t.clone(), amount: U128(*a) }).collect()
}

/// v3 state layout, read once by `migrate`.
#[near(serializers = [borsh])]
pub struct ContractV3 {
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
    listings: LookupMap<u64, market::Listing>,
    next_listing_id: u64,
    open_listings: LookupMap<AccountId, u32>,
    market_fee_bps: u16,
}

impl Contract {
    fn project(&self, id: &str) -> Project {
        self.projects.get(id).cloned().unwrap_or_else(|| env::panic_str("no such project"))
    }
    fn view_project(id: &str, p: &Project) -> ProjectView {
        ProjectView {
            id: id.to_string(),
            name: p.name.clone(),
            chunk: p.chunk.clone(),
            need: lines(&p.need),
            pledged: lines(&p.pledged),
            contributors: p.contributors.iter().map(|c| ContributorView { account_id: c.account_id.clone(), lines: lines(&c.lines) }).collect(),
            done: p.done,
            done_ns: p.done_ns,
        }
    }
}

#[near]
impl Contract {
    /// Upgrade from v3: keeps every v3 field and adds the empty project list. Callable only by the contract account
    /// itself (as part of a deploy with an init call).
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let o: ContractV3 = env::state_read().unwrap_or_else(|| env::panic_str("no v3 state to migrate"));
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
            projects: LookupMap::new(StorageKey::Projects),
            project_ids: vec![],
        }
    }

    /// Owner: a new town project that opens map area `chunk` when complete.
    pub fn create_project(&mut self, id: String, name: String, chunk: String, need: Vec<RestoreLine>) {
        self.require_owner();
        require!(!id.is_empty() && id.len() <= 32 && !name.is_empty() && name.len() <= 64 && chunk.len() <= 32, "bad id, name or chunk");
        require!(self.projects.get(&id).is_none(), "project exists");
        require!(self.project_ids.len() < MAX_PROJECTS, "too many projects");
        require!(!need.is_empty(), "a project needs something");
        let mut n: Vec<(String, u128)> = vec![];
        for l in &need {
            self.require_token(&l.token_id);
            require!(l.amount.0 > 0, "amounts must be positive");
            add_amount(&mut n, &l.token_id, l.amount.0);
        }
        self.projects.insert(id.clone(), Project { name, chunk, need: n, pledged: vec![], contributors: vec![], done: false, done_ns: 0 });
        self.project_ids.push(id.clone());
        events::gt_project(&id, "created", "", 0);
    }

    /// Player: pledges goods or coin to a project; only what the project still needs is taken.
    pub fn project_contribute(&mut self, id: String, contribution: Vec<RestoreLine>) {
        self.require_not_paused();
        let player = env::predecessor_account_id();
        self.require_registered(&player);
        require!(!self.is_merchant(&player), "merchants do not pledge to projects");
        let mut p = self.project(&id);
        require!(!p.done, "project is already done");
        let mut accepted: Vec<(String, u128)> = vec![];
        for l in &contribution {
            let take = l.amount.0.min(get_amount(&p.need, &l.token_id).saturating_sub(get_amount(&p.pledged, &l.token_id)));
            if take == 0 {
                continue;
            }
            self.debit(&l.token_id, &player, take);
            self.credit(&l.token_id, &env::current_account_id(), take);
            add_amount(&mut p.pledged, &l.token_id, take);
            add_amount(&mut accepted, &l.token_id, take);
        }
        require!(!accepted.is_empty(), "the project does not need that any more");
        match p.contributors.iter_mut().find(|c| c.account_id == player) {
            Some(c) => {
                for (t, a) in &accepted {
                    add_amount(&mut c.lines, t, *a);
                }
            }
            None => {
                require!((p.contributors.len() as u32) < self.limits.max_contributors, "too many contributors on this project");
                p.contributors.push(Contribution { account_id: player.clone(), lines: accepted, value: 0 });
            }
        }
        events::gt_project(&id, "pledge", player.as_str(), p.contributors.len() as u32);
        if p.need.iter().all(|(t, a)| get_amount(&p.pledged, t) >= *a) {
            // built: the pledged goods and coin are used up
            let here = env::current_account_id();
            let mut ids = vec![];
            let mut amounts = vec![];
            for (t, a) in &p.pledged {
                self.burn(t, &here, *a);
                ids.push(t.clone());
                amounts.push(U128(*a));
            }
            events::mt_burn(here.as_str(), &ids, &amounts, Some("town project"));
            p.done = true;
            p.done_ns = env::block_timestamp();
            events::gt_project(&id, "done", &p.chunk, p.contributors.len() as u32);
        }
        self.projects.insert(id, p);
    }

    /// Player: takes back their pledge while the project is not done.
    pub fn project_withdraw(&mut self, id: String) {
        let player = env::predecessor_account_id();
        let mut p = self.project(&id);
        require!(!p.done, "project is done; pledges were used");
        let idx = p.contributors.iter().position(|c| c.account_id == player).unwrap_or_else(|| env::panic_str("no pledge to withdraw"));
        let c = p.contributors.remove(idx);
        for (t, a) in &c.lines {
            self.debit(t, &env::current_account_id(), *a);
            self.credit(t, &player, *a);
            sub_amount(&mut p.pledged, t, *a);
        }
        events::gt_project(&id, "withdraw", player.as_str(), p.contributors.len() as u32);
        self.projects.insert(id, p);
    }

    pub fn get_project(&self, id: String) -> Option<ProjectView> {
        self.projects.get(&id).map(|p| Self::view_project(&id, p))
    }

    pub fn list_projects(&self) -> Vec<ProjectView> {
        self.project_ids.iter().filter_map(|id| self.projects.get(id).map(|p| Self::view_project(id, p))).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{TokenKind, TokenMeta};
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn acc(s: &str) -> AccountId { s.parse().unwrap() }

    #[test]
    fn migrate_keeps_v3_state_and_adds_projects() {
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc("game.testnet")).predecessor_account_id(acc("game.testnet"));
        testing_env!(b.build());
        let tokens = vec![TokenMeta { token_id: "coin".into(), name: "Koin".into(), kind: TokenKind::Currency, base: U128(1) }];
        let limits = Limits { daily_gain_cap: U128(1), daily_coin_gain_cap: U128(1), daily_sends: 1, max_send_amount: U128(1), max_chunk: 1, max_players: 7, faucet_w0: U128(1), money_cap0: U128(1), active_divisor: 1, max_k: 1, rent: U128(40), initial_shares: U128(1000), max_contributors: 1 };
        let mut balances = LookupMap::new(StorageKey::Balances);
        balances.insert(("coin".to_string(), acc("alice.testnet")), 77u128);
        balances.flush();
        let v3 = ContractV3 {
            owner_id: acc("owner.testnet"), settler_id: acc("settler.testnet"), town_id: acc("town.testnet"), paused: false,
            tokens, limits, balances, supply: LookupMap::new(StorageKey::Supply), registered: LookupSet::new(StorageKey::Registered),
            registered_count: 4, applied: LookupSet::new(StorageKey::Applied), roots: LookupMap::new(StorageKey::Roots), last_settled_day: 12,
            gain_caps: LookupMap::new(StorageKey::GainCaps), day_faucet: LookupMap::new(StorageKey::DayFaucet), send_caps: LookupMap::new(StorageKey::SendCaps),
            storage_paid: LookupMap::new(StorageKey::StoragePaid), merchants: vec![acc("joko.testnet")], shops: LookupMap::new(StorageKey::Shops),
            shares: LookupMap::new(StorageKey::Shares), dividends_paid: LookupSet::new(StorageKey::Dividends),
            listings: LookupMap::new(StorageKey::Listings), next_listing_id: 3, open_listings: LookupMap::new(StorageKey::OpenListings), market_fee_bps: 500,
        };
        env::state_write(&v3);
        let c = Contract::migrate();
        assert_eq!(c.registered_count, 4);
        assert_eq!(c.last_settled_day, 12);
        assert_eq!(c.next_listing_id, 3);
        assert_eq!(c.balance("coin", &acc("alice.testnet")), 77);
        assert!(c.list_projects().is_empty());
    }
}
