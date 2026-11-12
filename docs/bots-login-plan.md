# Bot wallets, intent bots, NEAR login on the deployed domain: plan

> Written 2026-11-12 (deadline 2026-11-14T23:59Z) by the Opus orchestrator, from a Sonnet research pass that was audited
> against the code and testnet. Carried out ONE STEP AT A TIME by workers with no memory of earlier sessions. Same rules
> as `docs/coop-trade-plan.md` ("How to resume", "Conventions every step follows"): read CLAUDE.md, pull, do only the
> first unticked step whose "Needs" are met, `npm test` green, tick the row, commit with explicit paths, push. Only one
> server, on :3000; never kill a process you did not start, never use another port. Steps marked **OWNER** are done by
> the owner (they need their accounts or keys); a worker skips them and says so.
> Supersedes parts 4 and 5 of `docs/superpowers/plans/2026-11-11-guide-kabar-bots-multiplayer.md`.

## Ringkasan (Bahasa Indonesia)

- **Penyimpanan kontrak hampir penuh.** Kontrak game di testnet tinggal punya ~1,9 KB penyimpanan yang sudah dibayar.
  Pemain baru dan settlement bisa gagal sebelum fitur apa pun ditambah. Isi dulu dengan NEAR testnet (langkah 0).
- **Login NEAR di domain Railway** tidak bisa diperbaiki dari kode: callback Auth0 milik NEAR Auth hanya menerima alamat
  yang mereka daftarkan. Tenant Auth0 "genesis-town" milikmu tidak bisa dipakai untuk tanda tangan NEAR Auth. Yang kita
  perbaiki: game tidak lagi membuka popup yang pasti gagal, dan menjelaskan dengan jelas. Minta pendaftaran domain lewat
  form dan Telegram; demo hal on-chain dari localhost.
- **Dompet bot.** Setiap bot penghasil (Petani, Nelayan, Penebang, Pemburu) punya dompet: sebuah id di kontrak NEP-245
  seperti dompet pedagang, tanpa kunci privat. Hasil kerja bot masuk ke dompetnya dan terlihat di explorer setelah
  settlement; pemilik menarik hasil yang sudah settle.
- **Bot berbasis niat.** Pemain menulis niat + memilih pemicu tetap; AI menyusun program JSON sekali; server mengecek dan
  menjalankannya tiap jam game tanpa AI. Bot menjual hasil dompetnya ke pedagang dengan harga minimum ("intent-style").
  NEAR Intents asli hanya ada di mainnet, jadi tidak dibangun sebelum deadline.

## STATUS

- [ ] Step 0 (OWNER): top up `game.genesistown.testnet` storage; stop the second testnet server
- [ ] Step 1: NEAR Auth only where it works: `NEAR_AUTH_ORIGINS`, no doomed popup, clear message
- [ ] Step 2 (OWNER): ask NEAR Auth to allow the Railway origin; pin `NEARAI_MODEL`
- [ ] Step 3: Bot wallets on the server: id, registration, output into the wallet, caps against the owner
- [ ] Step 4: Bot wallet in the UI: balances, explorer link, "Ambil hasil" (settled only)
- [ ] Step 5: Bot program: schema, intent filter, validator (no AI yet), tests
- [ ] Step 6: Compile with NEAR AI (server, paid in coin) and bring-your-own-key (browser)
- [ ] Step 7: Runner in the hourly game step, action log with reasons, bot panel
- [ ] Step 8: Docs and rules wrap-up (CLAUDE.md rule change, threat model, README)

## Facts this plan rests on (audited 2026-11-12)

| Fact | Source |
| --- | --- |
| `settle_day` credits only `registered` ids, merchants and the town; others are skipped and logged | `contracts/game/src/settle.rs:74` |
| `register_player` (settler or owner) takes any valid id, checks `registered_count < max_players`, no account-exists check | `contracts/game/src/game.rs:10-21` |
| `register_merchant` adds to `registered` and `merchants` without counting toward `registered_count` | `contracts/game/src/shops.rs:153-183` |
| Per-account caps: `daily_gain_cap` (items), `daily_coin_gain_cap` (coin) for everyone but merchants and town | `settle.rs:104` |
| Faucet "active players" counts only ledger accounts `LIKE '%.players.%'` | `server/src/game/gamestore.ts:179-181` |
| Settlement preflight checks `isRegistered` per account per day | `server/src/game/settlement.ts:202` |
| Testnet `get_config`: `max_players` 150, `registered_count` 19 | RPC view, 2026-11-12 |
| `game.genesistown.testnet`: 457,246 bytes used, balance covers 459,166 bytes → **1,920 bytes spare** (1E19 yocto per byte) | RPC `view_account`, 2026-11-12; https://docs.near.org/protocol/storage/storage-staking |
| Bots today are modifiers only; hire is a one-time price to the town; Pemburu output goes to the owner | `homeland.ts:377-392, 418-420, 300` |
| The NEAR Auth popup sends `redirect_uri = window.location.origin` | `client/build/node_modules/@auth0/auth0-spa-js/dist/auth0-spa-js.development.js:10154,10180` |
| `approveDevice` treats NEAR Auth as usable whenever `fastAuth` config exists, so the deployed site opens a popup that fails | `client/js/mods/chain.js:259` |
| Own Auth0 tenants are not accepted by the shared guards (`add_guard`, `set_public_keys` owner-only; `aud` must be the guard) | docs.auth.near.org `contracts/jwt-guard-router.md`, `contracts/auth0-guard.md` |
| Testnet NEAR Auth has no documented allow-list process; the only contact is the form | `resources/testnet.md`, `home/apply.md` (https://form.typeform.com/to/VWHjf3HV) |
| NEAR AI Cloud: OpenAI-compatible at `https://cloud-api.near.ai/v1`; `GET /v1/models` lists `supported_features` and pricing; browser CORS allowed for the Railway origin | docs.near.ai `cloud/quickstart.md`, `cloud/guides/openai-compatibility.md`; live GET/OPTIONS |
| `dialogue.ts` uses the FIRST model from `/v1/models` when `NEARAI_MODEL` is unset (currently an expensive one) | `server/src/dialogue.ts:107-117` |
| NEAR Intents has no testnet | nearhackathon.com/HACKATHON.md Q-007 |

## Step 0 (OWNER): storage and one server

1. **Storage:** send testnet NEAR to `game.genesistown.testnet` (2 NEAR covers ~200 KB). Get it from a testnet faucet
   (HACKATHON.md Q-008). Check afterwards with `view_account`: `amount / 1e19 - storage_usage` should be far above 1,920.
   Without this, new players' registrations and settlement rows can fail with "not enough balance for state".
2. **One server per contract:** only Railway runs against `game.genesistown.testnet`. Local work uses `npm run
   dev:mock`. (See part 0 of the 2026-11-11 plan; Railway was 44 days behind on 2026-11-12.)

**Done when:** spare storage > 100 KB and `/api/health` on Railway reports `ok: true`.

## Step 1: NEAR Auth only where it works

- **Server:**
  - `NEAR_AUTH_ORIGINS` (comma list, default `http://localhost:3000`) in `config.ts`, sent as
    `fastAuth.origins` in `/api/config`.
  - `.env.example` documents it.
- **Client (`chain.js`):** NEAR Auth counts as usable only when `location.origin` is in that list. Elsewhere:
  - the "Masuk dengan NEAR Auth" button is not shown, and the Google button stays;
  - `approveDevice` shows the existing friendly text ("… perlu persetujuan NEAR Auth, yang belum aktif di alamat ini …")
    instead of opening a popup;
  - when there is no Google client either, the title card says login works on localhost only.
- **Tests:** `/api/config` carries the origins. The client logic is small; check by hand on :3000 with
  `NEAR_AUTH_ORIGINS` set and unset.

**Done when:** on a non-listed origin no Auth0 popup ever opens; on localhost:3000 nothing changes.

## Step 2 (OWNER): domain request, model pin

- **NEAR Auth request:** submit the form and ask in https://t.me/nearbuilderschat. Ask them to allow
  `https://genesistown.up.railway.app` as callback and web origin on the shared testnet client. The owner sends it;
  never post for them. When it is allowed, add the origin to `NEAR_AUTH_ORIGINS`.
- **The owner's Auth0 tenant "genesis-town"** cannot sign NEAR transactions. Optional use: a plain email login checked
  by the server, like `googleVerifier`. Not planned unless the owner asks.
- **Model pin:** set `NEARAI_MODEL` on Railway to a cheap model whose `supported_features` include `json_mode`, picked
  from `GET https://cloud-api.near.ai/v1/models` on the day. Do not hard-code an id from memory. Steps 6–7 use the same
  variable, or `NEARAI_BOT_MODEL` if a different one is wanted.

## Step 3: bot wallets on the server

**Design (fixed):**
- **Who gets one:** producing bots only: `petani`, `nelayan`, `penebang`, `pemburu` (at most 2+2+2+1 = 7 per player).
  Builders and the Koki stay modifiers. This keeps `max_players` slots (131 free) for players.
- **Id:** `b<16 hex of sha256("genesis-town:bot:" + owner + ":" + bot.id)>.<BOTS_PARENT>`, with
  `BOTS_PARENT` = `bots.<game parent>` in config (`bots.genesistown.testnet` on testnet). It is a keyless id like the
  merchants' wallets: no NEAR account, no private key anywhere.
- **Registration:** hiring writes the wallet id into `homeland_bots.wallet` (`ALTER TABLE` pattern in `db.ts`/
  `gamestore.ts`) and queues `chain.registerPlayer(wallet)` (settler, ~30 Tgas). Retry like `ensureRegistered`
  (`auth.ts`) until `isRegistered` is true. The wallet earns nothing until it is registered: until then output goes to
  the owner, as today.
- **Output:**
  - A registered bot's production lands in its wallet as ledger rows (`kind 'bot'`, ref `HL-<n>:bot:<id>`). For
    nelayan/penebang/petani: the share their effect adds; for pemburu: what forage stores. The building's base output
    still goes to the owner.
  - Caps are checked against the OWNER (`world.checkGain`), so bots cannot multiply the anti-farming cap.
- **Withdraw:**
  - `POST /api/act {action:'botcollect', bot}`, owner only, writes `bot → owner` rows.
  - Only the **settled** part can be withdrawn (the contract balance from the last settlement). Otherwise the day's net
    for the bot could be zero and nothing would ever show on chain.
- **Fire:** sweep the settled balance to the owner. The id stays registered (a slot is not given back).
- **Faucet:** no change needed. `activeAccounts` already ignores non-`.players.` ids. Add a test that pins this.

**Tests (`server/test/bot-wallet.test.ts`):**
- id is deterministic;
- output goes to the wallet only after registration;
- the owner's cap includes bot output;
- botcollect moves only the settled part;
- firing sweeps the balance;
- settlement includes the bot rows;
- `activeAccounts` excludes bots.

**Needs:** step 0 (storage) before it runs against testnet.

## Step 4: bot wallet in the UI

The Workers panel in `client/js/mods/homeland.js`, for each producing bot:
- wallet id, shortened, with a copy button and an explorer link (`explorerTxUrl` host +
  `/address/<id>`; check that nearblocks shows keyless ids, and if it does not, link the settlement tx instead);
- settled and pending balances;
- **Ambil hasil**.

All new text goes through `$t()` with English lines in `client/js/lang/en.js`. Bump `client/sw.js` CACHE.

## Step 5: the bot program (no AI yet)

`server/src/game/botprog.ts`:

- **Triggers** (fixed list): `pagi` (06:00), `siang` (12:00), `malam` (19:00), `musim` (season change),
  `harga_di_atas {item, merchant?, price}`, `harga_di_bawah {…}`, `stok_dompet_di_atas {item, n}`.
- **Steps** (whitelist, at most 8 per trigger, at most 3 triggers):
  - `sell {item, merchant?, qty|all, minPrice}`: from the bot's wallet to a merchant;
  - `buy {item, merchant?, qty, maxPrice}`: wallet coin only;
  - `send_owner {item|coin, qty|all}`;
  - `wait`.
  - Never: hire, dress, build, travel, fight, ship, trade, list, gift.
- **Bounds:**
  - `minPrice` at least 50% of the current quote;
  - daily coin spend no more than the wallet balance and `bots.dailySpendMax` (config);
  - one run per trigger per game hour.
- **Intent filter (before any AI):**
  - 280 characters max;
  - a list of refused aims: stealing, spamming, "send all coin to …", account names outside the owner;
  - common prompt-injection phrases ("ignore", "abaikan aturan", "system prompt").
  - Each refusal returns its reason.
- **Validator:** a strict schema check (unknown keys rejected); errors come back as a list of plain sentences.
- **Tests:** good programs pass; every bound and every banned step fails with its reason; the filter catches the
  listed phrases.

## Step 6: compile

- **Server path:** `POST /api/bot/compile {bot, intent, triggers}` (signed, owner only, rate-limited like `talk`).
  1. filter;
  2. one chat completion to NEAR AI with the action schema in the prompt, asking for JSON only (`response_format` is
     not documented, so do not rely on it);
  3. parse, then validate;
  4. charge `bots.compileCoin` (config) owner → town as ledger rows;
  5. store the program: intent, JSON, model id, sha256, created_at.
  - Without a NEAR AI key, a local keyword compiler (reuse the parsing in `client/js/mods/agent.js` `parseText`, ported
    to TS) handles the simple phrases, so the demo never depends on an outside service.
- **Bring your own key:** the browser calls `https://cloud-api.near.ai/v1/chat/completions` with the player's key, kept
  in memory only (pattern in `soul.js`), then sends `{program, model}` to `POST /api/bot/program`. The server runs the
  same validator and charges nothing. The key never reaches the server.
- **Tests:** compile with a stubbed provider: good JSON is stored, bad JSON is refused, the coin is charged once, and
  the BYOK route validates the same way.

## Step 7: runner and panel

- **Runner:** in `Game.step()`'s per-game-hour loop (`game.ts:190-197`), after `market.tickAll()`: for each bot with a
  program, check its triggers and run the steps.
  - Sells and buys go through `market.sell/buy` with the bot's wallet as the account. The ledger rows are written for the
    wallet and settled daily.
  - Each action is stored in `bot_actions(bot, at, trigger, step, result, reason)`, where the reason is the program line
    plus the merchant's quote.
- **Panel** (bot card in `homeland.js`): "Pasang jiwa" with the intent box and trigger picks, the approved program as
  readable lines, the model and hash, and the last 10 actions with reasons. A switch pauses the bot.
- **Deadline slice:** if time is short, ship triggers `pagi` and `harga_di_atas` and steps `sell` and `send_owner`
  only.
- **Tests:** a program runs at its hour, respects `minPrice`, stops at the spend cap, logs reasons, and the wallet
  balances add up after a settlement.

## Step 8: docs and rules

- **CLAUDE.md:** replace "Worker bots never hold items or coin and never trade" with "Producing bots have keyless wallets
  (`b…<BOTS_PARENT>`); they sell and buy only with merchants through their validated program, never P2P, Pasar or
  gifts".
- **Other docs:**
  - `docs/threat-model.md`: bot wallets, prompt injection, cap bypass;
  - `docs/economy.md`: bot wages and output;
  - README status block.
- **README for judges:** "NPCs with wallets" (merchants and bots, explorer links) and "intent-style bots" (NEAR Intents
  is mainnet-only, Q-007).

## Decisions for the owner

Settled 2026-11-12:
- **Wallet type:** keyless ids inside the game contract, like the merchants' wallets. No private key, no NEAR per bot.
- **What a bot does with its wallet:** holds its output, sells to merchants, buys from merchants (spend capped per
  day). No daily wage.
- **Merchant bots** (Sari, Budi, Wati, Joko) already have wallets and need no work here:
  - they are real NEAR accounts (`<id>.genesistown.testnet`) and registered merchants in the contract (`get_config`
    `merchants`);
  - their stock and cash move only through settlement;
  - they are exempt from the daily gain caps and do not use player slots.
  - Balances on 2026-11-12: Sari 16 fish, 2 meal; Budi 7 wood, 1 tool; Wati 4 bread; Joko 45 coin, 10 fish, 4 wood,
    15 wheat.
  - The README should link their explorer pages as the first "NPCs with wallets".

Still open:
1. Which worker bots get a wallet: producing bots only (recommended), every bot, or one wallet per Homeland?
2. Who tops up the contract storage, and from which faucet? This must happen before step 3 runs on testnet.
3. Use the "genesis-town" Auth0 tenant for an email login, or leave it?
