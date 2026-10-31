//! NEP-245 multi token core: https://github.com/near/NEPs/blob/master/neps/nep-0245.md
//! Approval Management is not implemented, so every `approval` argument must be null.
use crate::{Contract, ContractExt, TokenId, events};
use near_sdk::json_types::U128;
use near_sdk::{AccountId, Gas, PromiseOrValue, assert_one_yocto, env, ext_contract, near, require, serde_json};

const GAS_FOR_RESOLVE: Gas = Gas::from_tgas(20);
const GAS_RESERVED: Gas = Gas::from_tgas(10);
const MIN_GAS_FOR_CALL: Gas = Gas::from_tgas(60);

pub type Approval = (AccountId, u64);

#[near(serializers = [json])]
pub struct Token {
    pub token_id: TokenId,
    /// Fungible token types have no single owner.
    pub owner_id: Option<AccountId>,
}

#[allow(dead_code)] // the trait itself is only used through the generated `ext_mt_receiver`
#[ext_contract(ext_mt_receiver)]
pub trait MultiTokenReceiver {
    fn mt_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_ids: Vec<AccountId>,
        token_ids: Vec<TokenId>,
        amounts: Vec<U128>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>>;
}

impl Contract {
    fn batch_transfer(&mut self, sender: &AccountId, receiver_id: &AccountId, token_ids: &[TokenId], amounts: &[U128], approvals: Option<&Vec<Option<Approval>>>, memo: Option<&str>) {
        require!(!token_ids.is_empty(), "no tokens");
        require!(token_ids.len() == amounts.len(), "token_ids and amounts must have the same length");
        if let Some(a) = approvals {
            require!(a.len() == token_ids.len(), "approvals must match token_ids");
            require!(a.iter().all(Option::is_none), "approval management is not supported");
        }
        for (t, a) in token_ids.iter().zip(amounts) {
            self.internal_transfer(t, sender, receiver_id, a.0);
        }
        events::mt_transfer(sender.as_str(), receiver_id.as_str(), token_ids, amounts, memo);
    }

    fn transfer_and_call(&mut self, receiver_id: AccountId, token_ids: Vec<TokenId>, amounts: Vec<U128>, approvals: Option<Vec<Option<Approval>>>, memo: Option<String>, msg: String) -> PromiseOrValue<Vec<U128>> {
        assert_one_yocto();
        self.require_not_paused();
        require!(env::prepaid_gas() >= MIN_GAS_FOR_CALL, "attach at least 60 TGas");
        let sender = env::predecessor_account_id();
        self.batch_transfer(&sender, &receiver_id, &token_ids, &amounts, approvals.as_ref(), memo.as_deref());
        let receiver_gas = env::prepaid_gas()
            .saturating_sub(env::used_gas())
            .saturating_sub(GAS_FOR_RESOLVE)
            .saturating_sub(GAS_RESERVED);
        ext_mt_receiver::ext(receiver_id.clone())
            .with_static_gas(receiver_gas)
            .mt_on_transfer(sender.clone(), vec![sender.clone(); token_ids.len()], token_ids.clone(), amounts.clone(), msg)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_RESOLVE)
                    .mt_resolve_transfer(sender, receiver_id, token_ids, amounts, None),
            )
            .into()
    }
}

#[near]
impl Contract {
    #[payable]
    pub fn mt_transfer(&mut self, receiver_id: AccountId, token_id: TokenId, amount: U128, approval: Option<Approval>, memo: Option<String>) {
        assert_one_yocto();
        self.require_not_paused();
        let sender = env::predecessor_account_id();
        self.batch_transfer(&sender, &receiver_id, &[token_id], &[amount], Some(&vec![approval]), memo.as_deref());
    }

    #[payable]
    pub fn mt_batch_transfer(&mut self, receiver_id: AccountId, token_ids: Vec<TokenId>, amounts: Vec<U128>, approvals: Option<Vec<Option<Approval>>>, memo: Option<String>) {
        assert_one_yocto();
        self.require_not_paused();
        let sender = env::predecessor_account_id();
        self.batch_transfer(&sender, &receiver_id, &token_ids, &amounts, approvals.as_ref(), memo.as_deref());
    }

    #[payable]
    pub fn mt_transfer_call(&mut self, receiver_id: AccountId, token_id: TokenId, amount: U128, approval: Option<Approval>, memo: Option<String>, msg: String) -> PromiseOrValue<Vec<U128>> {
        self.transfer_and_call(receiver_id, vec![token_id], vec![amount], Some(vec![approval]), memo, msg)
    }

    #[payable]
    pub fn mt_batch_transfer_call(&mut self, receiver_id: AccountId, token_ids: Vec<TokenId>, amounts: Vec<U128>, approvals: Option<Vec<Option<Approval>>>, memo: Option<String>, msg: String) -> PromiseOrValue<Vec<U128>> {
        self.transfer_and_call(receiver_id, token_ids, amounts, approvals, memo, msg)
    }

    /// Callback after `mt_on_transfer`. Refunds unused amounts (all of them if the receiver failed or returned
    /// something unreadable), limited to what the receiver still holds. Returns the amounts actually used.
    #[private]
    pub fn mt_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, token_ids: Vec<TokenId>, amounts: Vec<U128>, approvals: Option<Vec<Option<Vec<(AccountId, u64, U128)>>>>) -> Vec<U128> {
        let _ = approvals; // approval management not supported; kept for the standard's signature
        let unused: Vec<u128> = match env::promise_result_checked(0, 1024) {
            Ok(bytes) => serde_json::from_slice::<Vec<U128>>(&bytes)
                .ok()
                .filter(|v| v.len() == amounts.len())
                .map(|v| v.iter().zip(&amounts).map(|(u, a)| u.0.min(a.0)).collect())
                .unwrap_or_else(|| amounts.iter().map(|a| a.0).collect()),
            Err(_) => amounts.iter().map(|a| a.0).collect(),
        };
        let mut refunded_ids = vec![];
        let mut refunded_amounts = vec![];
        let mut used = vec![];
        for ((t, a), u) in token_ids.iter().zip(&amounts).zip(unused) {
            let refund = u.min(self.balance(t, &receiver_id));
            if refund > 0 {
                self.debit(t, &receiver_id, refund);
                self.credit(t, &sender_id, refund);
                refunded_ids.push(t.clone());
                refunded_amounts.push(U128(refund));
            }
            used.push(U128(a.0 - refund));
        }
        if !refunded_ids.is_empty() {
            events::mt_transfer(receiver_id.as_str(), sender_id.as_str(), &refunded_ids, &refunded_amounts, Some("refund"));
        }
        used
    }

    /* ----------------------------------------------------------- views */

    pub fn mt_token(&self, token_ids: Vec<TokenId>) -> Vec<Option<Token>> {
        token_ids
            .into_iter()
            .map(|t| self.token(&t).map(|m| Token { token_id: m.token_id.clone(), owner_id: None }))
            .collect()
    }

    pub fn mt_balance_of(&self, account_id: AccountId, token_id: TokenId) -> U128 {
        U128(self.balance(&token_id, &account_id))
    }

    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<TokenId>) -> Vec<U128> {
        token_ids.iter().map(|t| U128(self.balance(t, &account_id))).collect()
    }

    pub fn mt_supply(&self, token_id: TokenId) -> Option<U128> {
        self.token(&token_id).map(|_| U128(self.supply.get(&token_id).copied().unwrap_or(0)))
    }

    pub fn mt_batch_supply(&self, token_ids: Vec<TokenId>) -> Vec<Option<U128>> {
        token_ids.into_iter().map(|t| self.mt_supply(t)).collect()
    }
}
