# Genesis Town game contract

One NEP-245 multi-token contract for every item type and the in-game `coin`. Rust, near-sdk 5.x, built with
cargo-near.

| Method | Who | What |
| --- | --- | --- |
| `new(owner_id, settler_id, town_id, tokens, limits, treasury_coin)` | deployer | init; mints the town treasury once |
| `mt_transfer`, `mt_batch_transfer`, `mt_transfer_call`, `mt_batch_transfer_call` | token holder, 1 yoctoNEAR | NEP-245 core; approvals not supported |
| `mt_token`, `mt_balance_of`, `mt_batch_balance_of`, `mt_supply`, `mt_batch_supply` | view | NEP-245 views |
| `storage_deposit`, `storage_withdraw`, `storage_unregister`, `storage_balance_of`, `storage_balance_bounds` | anyone | NEP-145, registration only |
| `register_player(account_id)` | settler or owner | contract-paid registration, capped by `limits.max_players` |
| `settle_day(day, chunk, entries, ledger_root, active_players)` | settler | applies the day's net changes (signed deltas); each chunk once; root fixed per day; player gain caps; coin faucet with money cap |
| `register_merchant(account_id, name, restore, start)` | owner | shop + restoration board + opening stock; town owns initial shares |
| `close_shop(merchant)` | settler | only if the merchant's coin is below the daily rent (checked on chain) |
| `restore_contribute(merchant, contribution)`, `restore_withdraw(merchant)` | player, **no deposit** | pledge to / withdraw from a closed shop's board; completing it reopens the shop and issues shares |
| `pay_dividend(merchant, day, amount)` | settler | once per merchant and day; moves profit into the dividend pool |
| `claim_dividends(merchant)` | shareholder, **no deposit** | pulls accumulated dividends |
| `send_item(receiver_id, token_id, amount)` | player, **no deposit** | items only (never `coin`, never to a merchant), capped per call and per day |
| `list_item(token_id, amount, price_each)` | player, **no deposit** | player market: escrows 1–50 of an item (not `coin`) in the contract; max 5 open listings per account; returns the listing id |
| `buy_listing(listing_id, amount, max_price_each)` | player, **no deposit** | pays `price_each × amount` coin; 5% (`market_fee_bps`) is burned, the rest goes to the seller; buyer ≠ seller |
| `cancel_listing(listing_id)` | the seller | returns the escrowed items |
| `migrate()` | the contract itself (deploy with init call) | v2 → v3 upgrade: keeps all state, adds the empty market |
| `set_settler`, `set_paused`, `set_limits` | owner | admin |
| `get_config`, `is_registered`, `get_day_root`, `is_chunk_applied`, `faucet_status`, `get_shop`, `list_shops`, `get_holding`, `get_listing`, `list_listings(limit)`, `market_fee_bps` | view | |

Events follow NEP-245 / NEP-297 (`EVENT_JSON:` with `standard: "nep245"`, `version: "1.0.0"`). Settlement chunks and
shop changes and market actions also emit `standard: "genesis-town"` events (`settle`, `shop`, `market`). A market
fee burn emits `mt_burn`.

Upgrading a deployed v2 contract in place:

```bash
near contract deploy game.genesistown.testnet use-file target/near/game.wasm with-init-call migrate json-args '{}' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-legacy-keychain send
```

```bash
cargo test
```

`cargo test` runs the unit tests and the sandbox integration test (`tests/test_game.rs`). The integration test builds
the wasm with cargo-near and starts a local near-sandbox.

```bash
cargo near build non-reproducible-wasm
```
