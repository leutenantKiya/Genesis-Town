//! NEP-145 storage management, registration-only: a fixed deposit covers an account's records.
//! Players created by the game server are registered with `register_player` (the contract pays);
//! anyone else (e.g. a regular wallet) can register by paying `storage_balance_bounds().min`.
use crate::{Contract, ContractExt};
use near_sdk::json_types::U128;
use near_sdk::{AccountId, NearToken, Promise, assert_one_yocto, env, near, require};

/// Covers the registration record plus balance records for the item types (~1,250 bytes at 1e19 yocto/byte).
pub const STORAGE_DEPOSIT: u128 = 12_500_000_000_000_000_000_000; // 0.0125 NEAR

#[near(serializers = [json])]
pub struct StorageBalance {
    pub total: U128,
    pub available: U128,
}

#[near(serializers = [json])]
pub struct StorageBalanceBounds {
    pub min: U128,
    pub max: Option<U128>,
}

#[near]
impl Contract {
    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        let _ = registration_only; // always registration-only
        let account_id = account_id.unwrap_or_else(env::predecessor_account_id);
        let deposit = env::attached_deposit().as_yoctonear();
        if self.registered.contains(&account_id) {
            if deposit > 0 {
                Promise::new(env::predecessor_account_id()).transfer(NearToken::from_yoctonear(deposit)).detach();
            }
        } else {
            require!(deposit >= STORAGE_DEPOSIT, "attach at least the minimum storage deposit");
            require!(self.registered_count < self.limits.max_players, "player limit reached");
            self.registered.insert(account_id.clone());
            self.registered_count += 1;
            self.storage_paid.insert(account_id.clone(), STORAGE_DEPOSIT);
            if deposit > STORAGE_DEPOSIT {
                Promise::new(env::predecessor_account_id()).transfer(NearToken::from_yoctonear(deposit - STORAGE_DEPOSIT)).detach();
            }
        }
        self.storage_balance_of(account_id).unwrap()
    }

    /// Nothing is ever withdrawable while registered (fixed-size registration). Returns the current balance.
    #[payable]
    pub fn storage_withdraw(&mut self, amount: Option<U128>) -> StorageBalance {
        assert_one_yocto();
        let account_id = env::predecessor_account_id();
        require!(self.registered.contains(&account_id), "not registered");
        require!(amount.map_or(true, |a| a.0 == 0), "no available storage balance to withdraw");
        self.storage_balance_of(account_id).unwrap()
    }

    /// Unregisters when every balance is zero (`force` is not supported). Refunds the deposit if the account paid one.
    #[payable]
    pub fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        assert_one_yocto();
        require!(!force.unwrap_or(false), "force unregister is not supported");
        let account_id = env::predecessor_account_id();
        if !self.registered.contains(&account_id) {
            return false;
        }
        let ids: Vec<String> = self.tokens.iter().map(|t| t.token_id.clone()).collect();
        require!(ids.iter().all(|t| self.balance(t, &account_id) == 0), "balances must be zero");
        self.registered.remove(&account_id);
        self.registered_count -= 1;
        if let Some(paid) = self.storage_paid.remove(&account_id) {
            Promise::new(account_id).transfer(NearToken::from_yoctonear(paid)).detach();
        }
        true
    }

    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        StorageBalanceBounds { min: U128(STORAGE_DEPOSIT), max: Some(U128(STORAGE_DEPOSIT)) }
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.registered.contains(&account_id).then(|| StorageBalance { total: U128(STORAGE_DEPOSIT), available: U128(0) })
    }
}
