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
| `settle_day(day, chunk, entries, ledger_root, active_players)` | settler | applies the day's net changes (signed deltas); each chunk once; root fixed per day; player gain caps; coin faucet on the day's running net coin across chunks, with money cap; entries of unregistered accounts are skipped and logged as `settle_skip` |
| `register_merchant(account_id, name, restore, start)` | owner | shop + restoration board + opening stock; town owns initial shares |
| `close_shop(merchant)` | settler | only if the merchant's coin is below the daily rent (checked on chain) |
| `restore_contribute(merchant, contribution)`, `restore_withdraw(merchant)` | player, **no deposit** | pledge to / withdraw from a closed shop's board; completing it reopens the shop and issues shares |
| `pay_dividend(merchant, day, amount)` | settler | once per merchant and day; moves profit into the dividend pool |
| `claim_dividends(merchant)` | shareholder, **no deposit** | pulls accumulated dividends |
| `send_item(receiver_id, token_id, amount)` | player, **no deposit** | items only (never `coin`, never to a merchant), capped per call and per day |
| `list_item(token_id, amount, price_each)` | player, **no deposit** | player market: escrows 1–50 of an item (not `coin`) in the contract; max 5 open listings per account; returns the listing id |
| `buy_listing(listing_id, amount, max_price_each)` | player, **no deposit** | pays `price_each × amount` coin; 5% (`market_fee_bps`) is burned, the rest goes to the seller; buyer ≠ seller |
| `cancel_listing(listing_id)` | the seller | returns the escrowed items |
| `create_project(id, name, chunk, need)` | owner | a town project that opens map area `chunk` when complete (max 20) |
| `project_contribute(id, contribution)` | player, **no deposit** | pledges goods or coin; only what is still needed is taken; when every line is met the pledges are burned and the project is done |
| `project_withdraw(id)` | player | takes a pledge back while the project is not done |
| *The game no longer uses the island methods below (`buy_island`, `save_island`, `set_voucher_key`, `set_broker`, `migrate`): Homeland is off-chain. They stay in the source only.* | | |
| `buy_island(island_id, spec, price, expires_ns, signature)` | player, **no deposit** | buys a Private Island with a server voucher (ed25519 over `GT-ISLAND-BUY\|contract\|id\|buyer\|price\|seed\|size\|fertility\|expires_ns`, key from `set_voucher_key`). Coin buyer → broker, burned from the broker, `IS-<id>-1` minted to the broker and moved to the buyer, in one call. An island id can be bought once |
| `save_island(island_id, from_version, spec, expires_ns, signature)` | island owner, **no deposit** | Save World: burns `IS-<id>-<v>`, mints `IS-<id>-<v+1>` with the upgraded spec (same seed, levels never lower). Voucher message `GT-ISLAND-SAVE\|contract\|id\|owner\|from_version\|seed\|size\|fertility\|expires_ns` |
| `set_voucher_key(public_key)`, `set_broker(broker_id)` | owner | voucher signer (ed25519) and the broker account (gets registered) |
| `migrate(broker_id, voucher_key, new_tokens)` | the contract itself (deploy with init call) | v4 → v5 upgrade: keeps all state, adds islands, the broker, the voucher key and any new registry tokens (Emas, Permata). `scripts/make-init.mjs` writes `migrate-v5-testnet.json` with the arguments |
| `set_settler`, `set_paused`, `set_limits` | owner | admin |
| `get_config`, `is_registered`, `get_day_root`, `is_chunk_applied`, `faucet_status`, `get_shop`, `list_shops`, `get_holding`, `get_listing`, `list_listings(limit)`, `market_fee_bps`, `get_project`, `list_projects`, `get_island(island_id)` | view | |

Events follow NEP-245 / NEP-297 (`EVENT_JSON:` with `standard: "nep245"`, `version: "1.0.0"`). Settlement chunks and
shop changes, market actions, town projects and islands also emit `standard: "genesis-town"` events (`settle`, `shop`, `market`,
`project`, `island`). Market fees and finished projects emit `mt_burn`.

Upgrading a deployed v2 contract in place:

```bash
near contract deploy game.genesistown.testnet use-file target/near/game.wasm with-init-call migrate json-args-file migrate-v5-testnet.json prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-legacy-keychain send
```

```bash
cargo test
```

`cargo test` runs the unit tests and the sandbox integration test (`tests/test_game.rs`). The integration test builds
the wasm with cargo-near and starts a local near-sandbox.

```bash
cargo near build non-reproducible-wasm
```
