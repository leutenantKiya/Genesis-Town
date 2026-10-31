//! Game methods. Gathering mints are server-authorised but bounded by the contract; `send_item` is the one
//! player method in M1 and takes no deposit so a function-call session key can call it via a NEP-366 relayer.
use crate::{Contract, ContractExt, TokenId, TokenKind, events};
use near_sdk::json_types::U128;
use near_sdk::{AccountId, env, near, require};

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct MintEntry {
    pub account_id: AccountId,
    pub token_id: TokenId,
    pub amount: U128,
}

#[near]
impl Contract {
    /// Registers a player account so it can hold tokens. The contract pays the storage. Minter or owner only;
    /// the server calls it once when it creates a player account. Returns false if already registered.
    pub fn register_player(&mut self, account_id: AccountId) -> bool {
        let caller = env::predecessor_account_id();
        require!(caller == self.minter_id || caller == self.owner_id, "only the minter or owner");
        self.require_not_paused();
        if self.registered.contains(&account_id) {
            return false;
        }
        require!(self.registered_count < self.limits.max_players, "player limit reached");
        self.registered.insert(account_id);
        self.registered_count += 1;
        true
    }

    /// Mints gathered raw items. Minter only. `mint_id` is single-use, so a retried batch never mints twice.
    /// Each account may receive at most `daily_gather_cap` of each raw item per day.
    pub fn mint_gathered(&mut self, batch: Vec<MintEntry>, mint_id: String) {
        require!(env::predecessor_account_id() == self.minter_id, "only the minter");
        self.require_not_paused();
        require!(!mint_id.is_empty() && mint_id.len() <= 64, "mint_id must be 1-64 chars");
        require!(!batch.is_empty() && batch.len() as u32 <= self.limits.max_batch, "batch size out of range");
        require!(self.used_mint_ids.insert(mint_id.clone()), "mint_id already used");
        let today = Self::today();
        let cap = self.limits.daily_gather_cap.0;
        for e in &batch {
            let meta = self.require_token(&e.token_id);
            require!(meta.kind == TokenKind::Raw, format!("{} cannot be gathered", e.token_id));
            require!(e.amount.0 > 0, "amount must be positive");
            self.require_registered(&e.account_id);
            let key = (e.account_id.clone(), e.token_id.clone());
            let used = match self.gather_caps.get(&key) {
                Some((day, used)) if *day == today => *used,
                _ => 0,
            };
            let next = used.saturating_add(e.amount.0);
            require!(next <= cap, format!("daily gather cap reached for {} {}", e.account_id, e.token_id));
            self.gather_caps.insert(key, (today, next));
            self.mint(&e.token_id, &e.account_id, e.amount.0);
            events::mt_mint(e.account_id.as_str(), &[e.token_id.clone()], &[e.amount], Some(&mint_id));
        }
    }

    /// Sends items to another registered player. No deposit (callable by the player's session key), so it is
    /// limited: items only (never `coin`), at most `max_send_amount` units per call and `daily_sends` calls a day.
    pub fn send_item(&mut self, receiver_id: AccountId, token_id: TokenId, amount: U128) {
        self.require_not_paused();
        let sender = env::predecessor_account_id();
        self.require_registered(&sender);
        let kind = self.require_token(&token_id).kind;
        require!(kind != TokenKind::Currency, "coins cannot be sent with send_item");
        require!(amount.0 >= 1 && amount.0 <= self.limits.max_send_amount.0, "amount out of range");
        let today = Self::today();
        let count = match self.send_caps.get(&sender) {
            Some((day, n)) if *day == today => *n,
            _ => 0,
        };
        require!(count < self.limits.daily_sends, "daily send limit reached");
        self.send_caps.insert(sender.clone(), (today, count + 1));
        self.internal_transfer(&token_id, &sender, &receiver_id, amount.0);
        events::mt_transfer(sender.as_str(), receiver_id.as_str(), &[token_id], &[amount], Some("send_item"));
    }
}
