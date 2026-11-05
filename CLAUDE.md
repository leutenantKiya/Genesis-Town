# Genesis Town: quick map for new sessions

Read this first; open other files only when a task needs them. Detailed design lives in `docs/`, status in the
top block of `README.md`.

## What it is

Browser pixel-art market-town life sim for NEAR HACKATHON (Nov 1–14, 2026), track "Games With Real Economies".
Players gather (fish, ore, wood, wheat), craft (bread, meal, tool), trade with 4 AI merchants (sari, budi, wati,
joko) whose prices react to stock/demand/cash. Items + `coin` are NEP-245 tokens in one NEAR contract. Login via
NEAR Auth (Google/email); no seed phrase, wallet popup or gas prompt during play. In-game UI text is Indonesian
(Tas = bag, Pasar = market, Riwayat = history, Balai Desa, Puskesmas, ...).

## Layout

| Path | What |
| --- | --- |
| `client/` | Plain JS, no build step for game code. `index.html` loads scripts in order: `pwa, flags, sprites, art, buildings, world/village, engine, mods/*` |
| `client/js/engine.js` | Engine + plugin API `window.GT`. Header comment documents the whole mod contract (`GT.register`, `GT.modal`, `GT.menu`, hooks `onFrame/onInteract/onKey/onDraw`) |
| `client/js/mods/chain.js` | Everything economy/chain on the client: login, session key, `/api/*` calls, Tas, shops, Pasar, Riwayat |
| `client/js/mods/*.js` | One feature each: `fishing`, `actfx` (axe swing), `hotbar`, `mouse`, `combat`, `curfew`, `settings`, `sim`, and prototype mods (`casino`, `thief`, `police`, `gossip`, `agent`, `soul`, `social`) |
| `client/js/world/village.js` | Seeded village generator, run by BOTH browser and server (same map for everyone, `WORLD_SEED`) |
| `client/vendor/near.js` | esbuild bundle of near-api-js + fast-auth (`client/build/`), gitignored, made by `npm run build:client` |
| `server/src/main.ts` | Entry: config → SQLite `Store` → `MockChain` or `TestnetChain` → `Game` loop → HTTP app |
| `server/src/app.ts` | Hand-written router (no framework): `/api/config, auth/register, auth/add-key, relay, time, state, act, market, quote, shops, talk, projects, listings, history, sim, dev/*` |
| `server/src/game/game.ts` | Game loop (tick 2 s) + `/api/act` switch: `gather, fight, engage, flee, craft, eat, farm, ship, sell, ...` |
| `server/src/game/` | `world.ts` (off-chain actions → ledger rows), `market.ts` (merchant trades), `bazaar.ts` (Lapak / Pasar Gelap side), `settlement.ts` + `merkle.ts`, `monsters.ts`, `clock.ts`, `worldmap.ts`, `gamestore.ts`, `sim.ts` |
| `server/src/` | `chain.ts`, `relayer.ts` (NEP-366), `auth.ts` (Auth0 JWT), `reqauth.ts` (session-key signed requests), `newdevice.ts`, `dialogue.ts` (NEAR AI Cloud + local fallback), `db.ts` |
| `economy/` | `config.json` (items, recipes, merchants, seasons, fees, caps, projects, monsters) + `pricing.ts` + `time.ts`; shared by server and simulator |
| `contracts/game/src/` | Rust near-sdk 5: `mt.rs` (NEP-245), `storage.rs` (NEP-145), `settle.rs`, `market.rs` (escrow, 5% burn), `shops.rs` (bankruptcy/restore/shares/dividends), `projects.rs` (bridge, Pos Ronda), `events.rs`. Method table in `contracts/game/README.md` |
| `docs/` | `architecture, economy, game-loop, onchain-offchain, world, threat-model, sources, sim-report-30d` |
| `prototype/` | Pre-hackathon single-file baseline. Reference only, never served, never edited |

## Core rules (don't break)

- **On-chain only when ownership changes in a way others should verify.** Gather/farm/craft/eat/merchant trades are
  off-chain, server-authoritative, written as ledger rows. One `settle_day` per game day (24 real min, 06:00) writes
  net deltas + the ledger Merkle root. P2P (market listings, gifts), shop shares, town projects are on-chain at once.
- **Keys**: NEAR Auth key = player's full-access key (login only, each signature is an Auth0 popup). Gameplay is
  signed by a browser session key = function-call key on the game contract; relayer pays gas. Function-call keys
  can't attach 1 yocto → gameplay uses game methods, not `mt_transfer`. Server holds no player or merchant keys.
- **Secrets only in env** (`.env`, see `.env.example`). Run `node scripts/check-secrets.mjs` before commits that touch config.
- Server validates actions against where the player stands (shared `village.js` map).
- Coin is minted only by town demand, capped per day + money-supply throttle (`docs/economy.md`).

## Adding an off-chain action (typical path)

client mod → `POST /api/act {kind, ...}` (signed) → `game.ts` switch → `world.ts`/`market.ts` method → ledger row
via `gamestore.ts` → shows in Riwayat as "menunggu settlement" → `settlement.ts` at 06:00. Add tests in
`server/test/`. Balance/tuning numbers go in `economy/config.json`, not code.

## Commands

- `npm run setup`: install server + client build deps, build `client/vendor/near.js`.
- `npm run dev:mock`: mock chain in memory, `DEV_LOGIN=1` (token `dev:<name>`), fresh DB each start. Port 3000.
- `npm run dev`: real testnet, needs `.env`.
- `npm test`: economy tests + server tests (`node --test`) + `tsc` typecheck.
- Contract: `cd contracts/game && cargo test` (build with `cargo-near`).

## Conventions

- Node >= 24 runs `.ts` directly (type stripping): no build step for server; use erasable TS syntax only (no enums/namespaces).
- Storage is synchronous `node:sqlite`.
- Commit messages: one plain English sentence of what the player gets, no `feat:` prefixes.
- When a feature lands, update the status block at the top of `README.md` (and mark unbuilt things *(planned)*).
- Client mods talk to the engine only through `window.GT`.
