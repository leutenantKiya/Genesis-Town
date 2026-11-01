//! Player registration and `send_item` (player to player, on-chain immediately).
use crate::{Contract, ContractExt, TokenId, TokenKind, events};
use near_sdk::json_types::U128;
use near_sdk::{AccountId, env, near, require};

#[near]
impl Contract {
    /// Registers a player account so it can hold tokens. The contract pays the storage. Settler or owner only;
    /// the server calls it once when it creates a player account. Returns false if already registered.
    pub fn register_player(&mut self, account_id: AccountId) -> bool {
        let caller = env::predecessor_account_id();
        require!(caller == self.settler_id || caller == self.owner_id, "only the settler or owner");
        self.require_not_paused();
        if self.registered.contains(&account_id) {
            return false;
        }
        require!(self.registered_count < self.limits.max_players, "player limit reached");
        self.registered.insert(account_id);
        self.registered_count += 1;
        true
    }

    /// Sends items to another registered player from the settled balance. No deposit (callable by a session key),
    /// so it is limited: items only (never `coin`), at most `max_send_amount` per call and `daily_sends` calls a day.
    pub fn send_item(&mut self, receiver_id: AccountId, token_id: TokenId, amount: U128) {
        self.require_not_paused();
        let sender = env::predecessor_account_id();
        self.require_registered(&sender);
        require!(!self.is_merchant(&receiver_id), "use the shop to trade with merchants");
        let kind = self.require_token(&token_id).kind;
        require!(kind != TokenKind::Currency, "coins cannot be sent with send_item");
        require!(amount.0 >= 1 && amount.0 <= self.limits.max_send_amount.0, "amount out of range");
        let today = env::block_timestamp() / 86_400_000_000_000;
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
