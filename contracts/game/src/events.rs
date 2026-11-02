//! NEP-245 events (standard "nep245", version "1.0.0"), logged as `EVENT_JSON:{...}` per NEP-297.
use near_sdk::env;
use near_sdk::json_types::U128;
use near_sdk::serde_json::{Value, json};

fn emit(event: &str, data: Value) {
    let ev = json!({ "standard": "nep245", "version": "1.0.0", "event": event, "data": data });
    env::log_str(&format!("EVENT_JSON:{ev}"));
}

pub fn mt_mint(owner_id: &str, token_ids: &[String], amounts: &[U128], memo: Option<&str>) {
    let mut d = json!({ "owner_id": owner_id, "token_ids": token_ids, "amounts": amounts });
    if let Some(m) = memo {
        d["memo"] = json!(m);
    }
    emit("mt_mint", json!([d]));
}

pub fn mt_burn(owner_id: &str, token_ids: &[String], amounts: &[U128], memo: Option<&str>) {
    let mut d = json!({ "owner_id": owner_id, "token_ids": token_ids, "amounts": amounts });
    if let Some(m) = memo {
        d["memo"] = json!(m);
    }
    emit("mt_burn", json!([d]));
}

pub fn mt_transfer(old_owner_id: &str, new_owner_id: &str, token_ids: &[String], amounts: &[U128], memo: Option<&str>) {
    let mut d = json!({ "old_owner_id": old_owner_id, "new_owner_id": new_owner_id, "token_ids": token_ids, "amounts": amounts });
    if let Some(m) = memo {
        d["memo"] = json!(m);
    }
    emit("mt_transfer", json!([d]));
}

/// Game events (NEP-297 format, standard "genesis-town"): settlement chunks and shop state changes.
fn emit_game(event: &str, data: Value) {
    let ev = json!({ "standard": "genesis-town", "version": "1.0.0", "event": event, "data": data });
    env::log_str(&format!("EVENT_JSON:{ev}"));
}

pub fn gt_settle(day: u64, chunk: u32, ledger_root: &str, entries: usize) {
    emit_game("settle", json!([{ "day": day, "chunk": chunk, "ledger_root": ledger_root, "entries": entries }]));
}

pub fn gt_shop(merchant: &str, what: &str, contributors: u32) {
    emit_game("shop", json!([{ "merchant": merchant, "what": what, "contributors": contributors }]));
}

pub fn gt_project(id: &str, what: &str, detail: &str, contributors: u32) {
    emit_game("project", json!([{ "project": id, "what": what, "detail": detail, "contributors": contributors }]));
}

pub fn gt_market(what: &str, id: u64, account: &str, token_id: &str, amount: u128, price_each: u128) {
    emit_game("market", json!([{ "what": what, "listing_id": id, "account": account, "token_id": token_id, "amount": amount.to_string(), "price_each": price_each.to_string() }]));
}
