# Genesis Town game contract

One NEP-245 multi-token contract for every item type and the in-game `coin`. Rust, near-sdk 5.x, built with
cargo-near.

| Method | Who | What |
| --- | --- | --- |
| `new(owner_id, minter_id, town_id, tokens, limits)` | deployer | init |
| `mt_transfer`, `mt_batch_transfer`, `mt_transfer_call`, `mt_batch_transfer_call` | token holder, 1 yoctoNEAR | NEP-245 core; approvals not supported |
| `mt_token`, `mt_balance_of`, `mt_batch_balance_of`, `mt_supply`, `mt_batch_supply` | view | NEP-245 views |
| `storage_deposit`, `storage_withdraw`, `storage_unregister`, `storage_balance_of`, `storage_balance_bounds` | anyone | NEP-145, registration only |
| `register_player(account_id)` | minter or owner | contract-paid registration, capped by `limits.max_players` |
| `mint_gathered(batch, mint_id)` | minter | mints raw items only; `mint_id` single-use; per-account per-item daily cap |
| `send_item(receiver_id, token_id, amount)` | registered player, **no deposit** | items only (never `coin`), capped amount per call and calls per day |
| `set_minter`, `set_paused`, `set_limits` | owner | admin |
| `get_config`, `is_registered`, `is_mint_id_used`, `gather_allowance` | view | |

Events follow NEP-245 / NEP-297 (`EVENT_JSON:` with `standard: "nep245"`, `version: "1.0.0"`).

```bash
cargo test
```

`cargo test` runs the unit tests and the sandbox integration test (`tests/test_game.rs`). The integration test builds
the wasm with cargo-near and starts a local near-sandbox.

```bash
cargo near build non-reproducible-wasm
```
