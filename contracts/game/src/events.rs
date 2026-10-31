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

#[allow(dead_code)] // used from M2 (crafting burns inputs)
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
