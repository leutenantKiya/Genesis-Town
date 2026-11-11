# Merchant rename: sari, budi, wati, joko -> sarah, ben, wendy, jack

The game's default language is now English, and the four merchants follow it: **Sarah, Ben, Wendy, Jack** (Indonesian
display names Sari, Budi, Wati, Joko stay available through the language switch). On branch `merchant-rename` the
merchant **ids** change too: `economy/config.json`, the server, the client, tests, docs and the contract's
`merchants-testnet.json` now say `sarah`, `ben`, `wendy`, `jack`.

The merchants are real accounts on NEAR testnet with tokens in the game contract. **Do not merge this branch, and do
not deploy it, before the steps below are done**, or the running game loses its merchants: the server would look for
`sarah.genesistown.testnet` (not created, not registered) while the real stock sits in `sari.genesistown.testnet`.
`main` keeps the old ids and keeps working meanwhile.

## What a merchant is on chain

- an account `<id>.genesistown.testnet` (no key on the server; merchants never sign anything);
- a **registration** in the game contract: `register_merchant(account_id, name, restore, start)` (owner only) creates the
  shop (restoration board, shares: the town treasury holds the initial ones) and mints the opening stock `start`;
- token balances (`coin`, `fish`, ...) held by that account inside the contract;
- shareholders and a restoration board per shop (players who donated to a closed shop hold shares).

The contract has **no method to rename a merchant or to move a shop**. So the migration creates four new merchants and
moves the old merchants' balances to them. Nothing else on the contract changes (no redeploy, no `migrate`).

## What stays behind, on purpose

- the four old shops stay registered in the contract, with their **shares, dividends and history**. The server ignores
  shops whose id is not in `economy/config.json` (`Settlement.ourShops`), so they no longer show up or get closed or
  charged rent. Players keep their shares on chain, but the game UI will not offer to claim dividends from them. If
  that matters, claim before the migration (or accept it: the old shops are drained to zero and earn nothing);
- the **settled ledger rows** of the old merchants stay under the old accounts in the server's database. The daily
  Merkle roots on chain were computed over those rows; rewriting them would break verification of past days.

## Steps

All commands run from the repo root. `.env` is read by the scripts at run time and never printed.

1. **Stop the game server** (the user's `:3000` process and the Railway deploy), after the last settlement of the old
   build has finished (`/api/health`: `settledThrough` is yesterday's day). Back up the SQLite file
   (`cp data/genesis-town.db data/genesis-town.db.bak`; with `DATABASE_URL` the Neon copy is a second backup).
2. **Plan (read-only):** `node server/scripts/migrate-merchants.ts plan` lists, per old merchant, its token balances,
   whether the new account exists, and whether it is registered.
3. **Create the accounts and register the new merchants** (needs the **contract owner key**, `genesistown.testnet`, from
   your near-cli-rs keychain; the server never has it): `node server/scripts/migrate-merchants.ts commands` prints four
   `near account create-account ...` and four `near contract call-function ... register_merchant ...` commands. They
   register each merchant with **no opening stock** (`start: []`), so no new tokens are minted: the stock moves over in
   step 4. Run them yourself after reading them; check the syntax against `near account create-account --help`.
4. **Move the balances** (needs the **settler key**, the one already in `.env` as `SETTLER_PRIVATE_KEY`):
   `node server/scripts/migrate-merchants.ts move` (dry run), then `... move --execute`. It sends one `settle_day`
   call per merchant that debits the old account and credits the new one for every token. Both are merchants, so the
   daily gain cap does not apply, and the net coin change per call is zero, so the coin faucet is untouched. The calls
   reuse the last settled day and its stored root with chunk numbers from 9000 up, which the daily settlement never
   uses, so they cannot collide with a normal settlement.
5. **Update the server database** (file, server stopped): `node server/scripts/migrate-merchants.ts db` (dry run), then
   `... db --execute`. It renames the merchants in the tables that are only caches or still open: unsettled ledger rows,
   `settled` balances, `market` price rows, unresolved shortfalls. In one transaction; the dry run rolls back.
6. **Deploy and start the `merchant-rename` build** (`git checkout merchant-rename`, or merge it now), with the same
   `.env`. `MERCHANT_PARENT_ACCOUNT_ID` is unchanged. Check `/api/shops` and `/api/market`: four open shops named
   Sarah's Fish Stall, Ben's Workshop, Wendy's Bakery, Jack's General Store with their old balances.
7. Optional: `node server/scripts/reconcile.ts` (read-only without `--fix`) compares the server's cached balances with the
   chain for every account, which should now show the new merchants matching.

## Keys and accounts you must supply

| What | Where | Used for |
| --- | --- | --- |
| contract owner key for `genesistown.testnet` (near-cli-rs keychain) | your machine only | creating `sarah|ben|wendy|jack.genesistown.testnet` and `register_merchant` |
| about 4 NEAR of testnet funds on the owner account (1 NEAR per new account in the printed commands) | owner account | funding the new accounts |
| `SETTLER_ACCOUNT_ID` / `SETTLER_PRIVATE_KEY` and `GAME_CONTRACT_ID` | server `.env` | `move` (the same `settle_day` key the server already uses) |
| `NEAR_RPC_URL`, `MERCHANT_PARENT_ACCOUNT_ID`, `DB_PATH` | server `.env` | all script steps |

## Rolling back

Before step 4 nothing has changed for the running game: delete nothing, keep running `main`. After step 4, run the
`move` the other way (swap `OLD_TO_NEW` in the script) and restore the database backup. After step 5 without the
backup, the cache rows must be renamed back by hand.

## What was and was not converted

Converted: every id in code, config, tests, docs and the contract test sources (`contracts/game/src/tests.rs`,
`contracts/game/tests/test_game.rs`), `.env.example`, `merchants-testnet.json`. Display names are per language and are
**not** tied to the ids (English Sarah, Ben, Wendy, Jack; Indonesian Sari, Budi, Wati, Joko). Left alone: historical
text that reports past testnet runs (`docs/sim-report-30d.md`, design documents under `docs/superpowers/`, and the
transaction links in the README, which refer to the old accounts).
