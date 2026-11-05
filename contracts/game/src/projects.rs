//! Town projects (v4): the village pools goods and coin to build something that changes the map for everyone, such as
//! the bridge to Dusun Seberang. Works like a restoration board without a merchant:
//! - the owner creates a project with what it needs and the map area (chunk) it opens;
//! - players pledge from their settled balances (no deposit, so a session key can do it through the relayer); pledges
//!   are held by the contract and can be withdrawn until the project is complete;
//! - when every line is met the project is done: the pledged goods and coin are burned (used to build it), which is
//!   one of the economy's sinks, and contributors are kept on the project as its plaque.
//! The server watches `get_project` and opens the chunk on the shared map when `done` is true.
use crate::shops::{Contribution, RestoreLine, add_amount, get_amount, sub_amount};
use crate::{Contract, ContractExt, events};
use near_sdk::json_types::U128;
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
