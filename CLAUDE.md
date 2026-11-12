# Genesis Town: quick map for new sessions

Read this first; open other files only when a task needs them. Detailed design lives in `docs/`, status in the
top block of `README.md`.

## What it is

Browser pixel-art market-town life sim for NEAR HACKATHON (Nov 1–14, 2026), track "Games With Real Economies".
Players gather (fish, ore, wood, wheat), craft (bread, meal, tool), trade with 4 AI merchants (sari, budi, wati,
joko) whose prices react to stock/demand/cash. Items + `coin` are NEP-245 tokens in one NEAR contract. Login via
NEAR Auth (Google/email); no seed phrase, wallet popup or gas prompt during play. In-game text is English by default and Bahasa Indonesia is selectable (Settings > Language, `?lang=id`, saved in localStorage `gt.lang`). The code's source strings are the Indonesian originals and act as translation KEYS: `$t('Tas')` gives 'Bag' (`client/js/i18n.js`, English table `client/js/lang/en.js`, `{0}` placeholders). Server text is English; `X-GT-Lang: id` makes `server/src/lang.ts` translate responses (`server/src/i18n-id.ts`). Config display names are English in `economy/config.json`.

## Layout

| Path | What |
| --- | --- |
| `client/` | Plain JS, no build step for game code. `index.html` loads scripts in order: `pwa, flags, sprites, art, buildings, world/village, engine, mods/*` |
| `client/js/engine.js` | Engine + plugin API `window.GT`. Header comment documents the whole mod contract (`GT.register`, `GT.modal`, `GT.menu`, hooks `onFrame/onInteract/onKey/onDraw/onMinimap`) |
| `client/js/i18n.js`, `client/js/lang/en.js` | Language layer loaded first: `GT_LANG`, `$t(key, vars)`, `GT_I18N.dom()` for static HTML. New player-visible client text: wrap it in `$t('Indonesian text')` and add the English line to `lang/en.js` |
| `client/js/mods/chain.js` | Everything economy/chain on the client: login, session key, `/api/*` calls, Tas, shops, Pasar, Riwayat |
| `client/js/mods/*.js` | One feature each (the Dev panel, `?flags=`, `?musim=`, `?cuaca=` only work on localhost, `GT_DEV_HOST` in `flags.js`): `fishing`, `actfx` (axe swing), `hotbar`, `mouse`, `combat`, `curfew`, `settings`, `sim`, `concert` (night music by the square's stage), and prototype mods (`casino`, `thief`, `police`, `gossip`, `agent`, `soul`, `social`) |
| `client/js/world/village.js` | Seeded village generator, run by BOTH browser and server (same map for everyone, `WORLD_SEED`) |
| `client/vendor/near.js` | esbuild bundle of near-api-js + fast-auth (`client/build/`), gitignored, made by `npm run build:client` |
| `server/src/main.ts` | Entry: config → SQLite `Store` → `MockChain` or `TestnetChain` → `Game` loop → HTTP app |
| `server/src/app.ts` | Hand-written router (no framework): `/api/config, auth/register, auth/add-key, transfer` (POST, signed: encrypted game key for "Move to another device", `server/src/transfer.ts`), `transfer/redeem` (POST, public, single use), `relay, time, state, act, market, quote, shops, talk, projects, listings, history, sim, dev/*`; homeland: `party` (GET, POST invite|accept|decline|leave|kick), `homeland` (GET state), `homeland/layout` (GET), `homeland/invite` (POST, by name#tag); public-area economy: `trade` (GET, also carries the live `session` and `invites`), `trade/open|join|set|ready|close` (POST, live two-sided trade in any world, `world` in the body, party mates at any distance), `trade/offer|accept|cancel` (POST, deprecated one-shot offers, public area only), `consign` (GET/POST), `consign/withdraw`, `leaderboard` (GET `?period=day|all`); live: `presence` (POST, polled ~0.7 s: position in, same-world players and chat out), `chat`, `name` (name#tag and look); `health`; `dev/grant` (mock chain, local only: `items` and `coin`) |
| `server/src/game/game.ts` | Game loop (tick 2 s) + `/api/act` switch: `gather, fight, engage, flee, craft, eat, farm, travel, build, collect, ship, sell, cook, stock, forage, dress, ...` (`build` kinds: `build|furniture|upgrade|th|chunk`) |
| `server/src/game/` | `world.ts` (off-chain actions → ledger rows), `market.ts` (merchant trades), `bazaar.ts` (Lapak / Pasar Gelap side), `settlement.ts` + `merkle.ts`, `monsters.ts`, `clock.ts`, `worldmap.ts`, `gamestore.ts`, `sim.ts` |
| `server/src/game/trade.ts`, `consign.ts`, `leaderboard.ts` | Direct player-to-player trade (offers, atomic accept, `p2p:` ledger rows), the Titip Jual consignment stall (Mbok Darmi, hourly sales within the faucet, 5% fee), the Papan Juara top-seller board read from the ledger. UI: `client/js/mods/trade.js` |
| `server/src/game/homeland.ts` | Homelands: worker bots (hire Tukang, Petani, Nelayan, Penebang, rare Pemburu and Koki; coin goes to the town), contractor fatigue (lazy replay, max 72 game hours), Restoran pantry + serving, Rumah Pekerja houses (Kasur beds, Hiburan motivation), Rumah Sakit, cosmetics, Town Hall level, open chunks, builder jobs with `ends_at`, building production (lazy, capped), invites by name#tag, world ids `HL-<n>` |
| `server/src/game/party.ts` | Parties (max 4, SQLite: `parties`, `party_members`, `party_invites`; leader invites, invites expire in 120 s). Routes `GET /api/party`, `POST /api/party/invite|accept|decline|leave|kick`; the presence answer carries `party` (members with `world`, `online`, and `x,y` for mates in your world); mates are shown at any distance and `/p text` is party chat (`social.ts` `partyOf`/`mates`). UI: `client/js/mods/party.js` (key G, "Ajak party" on name cards, `/party nama#tag`). Plan for co-op and the trade window: `docs/coop-trade-plan.md` |
| `server/src/social.ts` | Display names (Store `names` table), presence and chat, per world (`public` or `HL-<n>`), in memory only; `client/js/mods/players.js` is its client (name tags, bubbles, chat box, `/msg /block /nama`, player cards, first-login name prompt) |
| `client/js/world/homeland.js` | Homeland generator (seed, 3 x 3 chunks), run by browser and server like `village.js`; also night monsters (`wild`, `monstersAt`: open forest/rock chunks, never the centre); `client/js/mods/homeland.js` is the UI (Town Hall menu, lots, builder, portal), `client/js/mods/charscreen.js` the post-login character screen (name#tag, look, Mulai) |
| `client/js/three/` | 3D world kit (window.GT3, three.js bundled to `client/vendor/three.js`): `kit` (textures, banded toon material, merge), `ground`, `building`, `nature`, `props`, `actor`, `sky`, `rig`, `seethrough`, `world`, `room` (a building's room as a cut-away dollhouse, from the engine's interior map), `fun` (fountain, stage with the night concert, carousel), `life` (butterflies, fireflies, frogs), `monsters` (boar, bat). Built from the 2D art and season ramps (`art.js` `S.PAL`). Used by the game's 2.5D view (the standalone test page `lab3d.html` lives on the `dev` branch) `client/js/mods/view3d.js` (lazy-loaded; engine seam `GT.setView3d`, `render3d` in `engine.js`: the engine owns positions, mods' 2D overlays draw on the transparent canvas above; indoors too: a door has no black fade in 2.5D (`doorTransition`), the room unfolds out of its building) |
| `server/src/` | `funds.ts` (watches the NEAR the settler, relayer and players' parent have left for gas; `/api/health` `funds`), `snapshot.ts` (with `DATABASE_URL`: a gzipped copy of the SQLite db in one Neon Postgres row, saved every 5 min when changed, after settlement and on SIGTERM; restored at start when the host has no db file), `chain.ts`, `relayer.ts` (NEP-366), `auth.ts` (Auth0 JWT; `googleVerifier` for "Masuk dengan Google" with `GOOGLE_CLIENT_ID`, same `google-oauth2|<sub>` id as NEAR Auth), `reqauth.ts` (session-key signed requests), `newdevice.ts`, `dialogue.ts` (Anthropic Claude or NEAR AI Cloud, local fallback; merchants chat as NPC players via `social.ts`), `db.ts` |
| `economy/` | `config.json` (items, recipes, merchants, seasons, fees, caps, projects, monsters) + `pricing.ts` + `time.ts`; shared by server and simulator |
| `contracts/game/src/` | Rust near-sdk 5: `mt.rs` (NEP-245), `storage.rs` (NEP-145), `settle.rs`, `market.rs` (escrow, 5% burn), `shops.rs` (bankruptcy/restore/shares/dividends), `projects.rs` (bridge, Pos Ronda), `islands.rs` (v5 island NFTs, unused by the game), `events.rs`. Method table in `contracts/game/README.md` |
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
- **Homeland**: every player has an off-chain world (`HL-<n>`), not an NFT and not sellable. Town Hall, chunk and building
  timers are server-authoritative (`ends_at`, one builder, one job at a time); buildings produce lazily, capped by
  capacity and `caps.dailyGainPerItem`. Contractors tire and the Restoran pantry feeds them; hired bots need a bed in a Rumah Pekerja; collapsed contractors go to the Rumah Sakit; cosmetics boost bots (all off-chain, no new tokens). The public area (`public`) is trade-only: merchants, Pasar, players. Guests (invited by `name#tag`, or the owner's party) walk and chat, and get a role for more. Homeland roles (party mates are visitors until the owner promotes them; unknown or 'owner' stored roles count as visitor): visitor (walk, chat, eat, trade), helper (gather, farm, fight, collect for the owner, assist builds), builder (also start builds paid from own bag; the building stays the owner's; `assist` costs only energy and `collect` pays the owner); owner-only: hire, dress, cook, stock, forage, invites, roles (`POST /api/homeland/role`). Guest gathering never takes a node's last charge and is capped per host per day (`coop`); see docs/coop-trade-plan.md.
  Settlement uses the token registry only.
- **Direct player trade** (`/api/trade/*`, public area, within 3 tiles) is off-chain ledger rows settled daily like merchant trades; Pasar listings and gifts stay on chain. Consignment sells inside the same coin faucet. Worker bots never hold items or coin and never trade.
- Coin is minted only by town demand, capped per day + money-supply throttle (`docs/economy.md`).

## Adding an off-chain action (typical path)

client mod → `POST /api/act {kind, ...}` (signed) → `game.ts` switch → `world.ts`/`market.ts` method → ledger row
via `gamestore.ts` → shows in Riwayat as "menunggu settlement" → `settlement.ts` at 06:00. Requests that happen inside a Homeland carry `world` (`public` or `HL-<n>`); positions and gather checks use that
world's map (`Game.worldFor(account, world, need)`, `need` = `visit`, `help`, `build` or `owner`: the least Homeland role the action needs, table `NEED` in `game.ts`). Add tests in
`server/test/`. Balance/tuning numbers go in `economy/config.json`, not code.

## Commands

- `npm run setup`: install server + client build deps, build `client/vendor/near.js`.
- `npm run dev:mock`: mock chain in memory, `DEV_LOGIN=1` (token `dev:<name>`), fresh DB each start. Port 3000.
- `npm run dev:split`: the Vercel/Railway split on one machine: mock API on :3100, static client on :5173 (cross-origin).
- `npm run dev`: real testnet, needs `.env`.
- `npm test`: economy tests + server tests (`node --test`) + `tsc` typecheck.
- Contract: `cd contracts/game && cargo test` (build with `cargo-near`).

## Conventions

- Node >= 24 runs `.ts` directly (type stripping): no build step for server; use erasable TS syntax only (no enums/namespaces).
- Storage is synchronous `node:sqlite`.
- Commit messages: one plain English sentence of what the player gets, no `feat:` prefixes.
- When a feature lands, update the status block at the top of `README.md` (and mark unbuilt things *(planned)*).
- Client mods talk to the engine only through `window.GT`.
