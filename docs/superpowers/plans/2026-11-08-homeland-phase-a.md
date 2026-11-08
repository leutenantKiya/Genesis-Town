# Homeland Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new player presses Start, falls into their own Homeland (Town Hall + one plot), chops wood, builds a Kolam Ikan, collects fish, walks through the portal and sells the fish to a merchant in the public area.

**Architecture:** A shared seeded generator (`client/js/world/homeland.js`, browser + server, like `village.js`) builds each player's 3x3-chunk world from a seed and the player's progress. A server module (`server/src/game/homeland.ts`) owns Homeland rows, builder jobs with `ends_at` timers and lazy production; it replaces the broker-island module (`islands.ts`) inside `Game`, reusing `worldFor`, positions and per-world presence. Costs and gains are ordinary ledger rows, settled daily as today.

**Tech Stack:** Node >= 24 running `.ts` directly (erasable TS only), `node:sqlite`, `node --test`; plain browser JS mods on `window.GT`; no contract change.

**Spec:** `docs/superpowers/specs/2026-11-08-homeland-design.md`

## Global Constraints

- In-game text is Indonesian. Code, comments and docs are English.
- Numbers go in `economy/config.json` -> `homeland`, never in code.
- World ids: `public` and `HL-<n>` (n = positive integer counter). `IS-*` disappears everywhere.
- No contract change, no new npm dependency.
- Off-chain only for Homeland, builders, timers; costs/gains are ledger rows (`GameStore.add`). Item costs are burned (`delta -n`, kind `build`); coin costs move to the town treasury (`-n` player, `+n` town, kind `build`).
- Gains from collecting go through `World.checkGain` (daily caps).
- Timers are server-authoritative: `ends_at` (ms, `Date`-style from `Game.now`). Clients only display them.
- Demo path timing: first Kolam Ikan built in <= 60 s, first fish collectable within 60 s after that.
- `npm test` (economy + server + tsc) must pass at the end of every task.
- Commit messages: one plain English sentence of what the player gets, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. In parallel phases workers do NOT commit; the orchestrator commits.

## Review Focus

1. Page reload while in the public area or in a Homeland: the player must land on their own Homeland spawn without a 409 "position jumped" (Task 3 test `reload lands at own spawn`).
2. Two builds started at once with one builder: the second gets 409 "Builder sedang bekerja" (Task 2 test).
3. A job whose `ends_at` passed while the server was down completes on the next read, exactly once (Task 2 test `finishes once after restart`).
4. Collect with a full daily cap: the cap error comes back and the stored amount stays stored (Task 2 test).
5. Gather/farm/engage in the public world answers 409 "Area publik hanya untuk berdagang." (Task 3 test).

---

### Task 1: Homeland generator (shared browser + server)

**Files:**
- Create: `client/js/world/homeland.js`
- Test: `server/test/homeland-gen.test.ts`

**Interfaces:**
- Produces `globalThis.GTHomeland` / `window.GTHomeland`:
  - `generate(seed: number, prog: { open: string[]; th: number; built: Array<{ kind: string; lot: string }> }): HomelandLayout`
  - `chunkOf(L, x, y): Chunk`
  - `VERSION: 1`, `CHUNKS: string[]` (= `['nw','n','ne','w','c','e','sw','s','se']`)
- `HomelandLayout` has the same shape as `GTVillage.generate` output so the engine can draw it: `{ version, seed, w: 48, h: 48, chunk: 16, tiles: string[], unlocked: string[] (= prog.open plus 'c'), chunks: Chunk[9] ({id, name, cx, cy, biome, open, project: null}), buildings: [...], market: { stalls: [] }, farm: { plots, gate }, spawn, portal: {x,y}, lots: Array<{ id: string; kind: 'kolam'|'tambang'|'restoran'; chunk: string; x; y; w; h; door: {x,y} }> }`.
- Buildings array contains the Town Hall `{ kind: 'townhall', name: 'Balai Kota', own: true, x, y, w: 4, h: 4, dx, dy, open: true }` centred in chunk `c`, plus one entry per `prog.built` item (`kind` = the lot kind, placed on its lot). Unbuilt lots are plain grass (walkable) and listed only in `lots`.
- Chunk names: `c` "Pusat Desa"; outer chunks named by biome: forest "Hutan", rock "Bukit Batu", pond "Kolam", sea "Pantai", meadow "Padang".

- [ ] **Step 1: Write the failing test** `server/test/homeland-gen.test.ts` (import `'../../client/js/world/homeland.js'` for its side effect, read `globalThis.GTHomeland`):
  - `same seed and progress give identical tiles` (deepEqual of two `generate(42, {open:[], th:1, built:[]})`).
  - `nine chunks, only the centre open at start`: `chunks.length === 9`, open ids `['c']`.
  - `centre has a town hall, one farm plot, >= 4 trees, >= 2 rocks, a portal, a kolam and a restoran lot`: `farm.plots.length === 1` at `th:1`; `lots.some(l => l.kind==='kolam' && l.chunk==='c')`.
  - `every seed 1..50 has a forest and a water (pond or sea) chunk orthogonally next to the centre, and a rock chunk somewhere with a tambang lot`.
  - `spawn is walkable and the portal, every lot door and the farm plot are reachable from it` (BFS over non-solid tiles inside open chunks only, for `open:[]`).
  - `farm plots grow with town hall level`: `th:2` -> 2 plots, `th:3` -> 3, cap 6 (`min(th, 6)`; config can change later but the generator takes `th` only).
  - `opening a chunk never moves anything already in the centre` (tiles of chunk `c` equal for `open:[]` and `open:['n']`).
  - `built buildings appear on their lot`: `generate(42,{open:[],th:1,built:[{kind:'kolam',lot:<kolam lot id>}]}).buildings` contains a `kolam` at the lot's x/y.
- [ ] **Step 2: Run** `node --test server/test/homeland-gen.test.ts` -> FAIL (module missing).
- [ ] **Step 3: Implement** `client/js/world/homeland.js` as an IIFE like `island.js` (copy its `mulberry32`/`noise`/BFS helpers). Outer biomes from the seed; then force one orthogonal neighbour of `c` to forest and another to pond or sea, and one chunk to rock, if missing (deterministic swap). Lots: `kolam` and `restoran` in `c`, `tambang` in the first rock chunk (row-major order). Locked chunks are still fully generated (drawn under fog by the engine). Retry with `seed+attempt` until reachability holds, as `village.js` does.
- [ ] **Step 4: Run** the test -> PASS; run `npm test` -> PASS.
- [ ] **Step 5:** (orchestrator commits) "Every player's Homeland is generated from a seed: Town Hall in the middle, eight chunks of forest, rock, pond or shore around it".

### Task 2: Homeland server module and config

**Files:**
- Modify: `economy/config.json` (add `homeland`, remove `islands`), `server/src/game/econ.ts` (types), `server/src/game/gamestore.ts` (tables + methods; drop island tables/methods)
- Create: `server/src/game/homeland.ts`
- Modify: `server/src/game/worldmap.ts` (add `HomelandMap`, remove `IslandMap`; `GameMap.dock()` renamed `portal()`)
- Test: `server/test/homeland.test.ts`

**Interfaces:**
- Consumes Task 1 `GTHomeland.generate`.
- Config `homeland` (exact demo values; later tuning allowed):
```json
"homeland": {
  "builders": 1,
  "publicTradeOnly": true,
  "townhall": [
    { "level": 2, "cost": { "wood": 30, "ore": 5, "coin": 50 }, "secs": 120 },
    { "level": 3, "cost": { "wood": 60, "ore": 20, "coin": 150 }, "secs": 300 },
    { "level": 4, "cost": { "wood": 120, "ore": 50, "coin": 400 }, "secs": 900 },
    { "level": 5, "cost": { "wood": 200, "ore": 100, "coin": 900 }, "secs": 1800 }
  ],
  "chunks": [
    { "n": 1, "th": 1, "cost": { "wood": 10 }, "secs": 30 },
    { "n": 2, "th": 2, "cost": { "wood": 25, "coin": 20 }, "secs": 90 },
    { "n": 3, "th": 2, "cost": { "wood": 40, "ore": 10, "coin": 40 }, "secs": 180 },
    { "n": 4, "th": 3, "cost": { "wood": 60, "ore": 20, "coin": 80 }, "secs": 300 },
    { "n": 5, "th": 3, "cost": { "wood": 80, "ore": 30, "coin": 120 }, "secs": 450 },
    { "n": 6, "th": 4, "cost": { "wood": 110, "ore": 45, "coin": 200 }, "secs": 600 },
    { "n": 7, "th": 4, "cost": { "wood": 150, "ore": 60, "coin": 300 }, "secs": 900 },
    { "n": 8, "th": 5, "cost": { "wood": 200, "ore": 80, "coin": 450 }, "secs": 1200 }
  ],
  "buildings": {
    "kolam":    { "name": "Kolam Ikan", "th": 1, "cost": { "wood": 5 },  "secs": 45,  "produces": "fish", "perGameHour": 2, "capacity": 6 },
    "tambang":  { "name": "Tambang",    "th": 2, "cost": { "wood": 20, "coin": 30 }, "secs": 120, "produces": "ore", "perGameHour": 2, "capacity": 8, "needsChunk": true },
    "restoran": { "name": "Restoran",   "th": 3, "cost": { "wood": 40, "ore": 10, "coin": 60 }, "secs": 240, "produces": "meal", "perGameHour": 1, "capacity": 4 }
  }
}
```
  (`realMsPerGameHour` is 60 000, so Kolam Ikan makes 1 fish per 30 s.)
- Tables (in `GameStore` constructor): `homelands (account TEXT PRIMARY KEY, id INTEGER UNIQUE NOT NULL, seed INTEGER NOT NULL, gen INTEGER NOT NULL, th INTEGER NOT NULL, open TEXT NOT NULL, created_at INTEGER NOT NULL)`; `homeland_buildings (account TEXT, lot TEXT, kind TEXT, last_collect INTEGER NOT NULL, PRIMARY KEY(account, lot))`; `homeland_jobs (account TEXT, target TEXT, kind TEXT, ends_at INTEGER NOT NULL, PRIMARY KEY(account, target))` (`kind` = `th`|`chunk`|`build`; `target` = `th`, chunk id, or lot id); `homeland_invites (id INTEGER, account TEXT, PRIMARY KEY(id, account))`.
- `server/src/game/homeland.ts` exports:
  - `homeWorld(id: number): string` -> `HL-<id>`; `parseHome(w: string): number | null`
  - `class Homelands` with `constructor(d: { econ: Econ; gs: GameStore; worldSeed: number; now: () => number; players?: PlayerDir; town: string })` (`PlayerDir` moves here from `islands.ts`):
    - `ensure(account: string): HomelandRow` - creates on first call: id = max+1, seed = 32-bit FNV-1a of `` `${worldSeed}:${account}` ``, gen = `GTHomeland.VERSION`, th = 1, open = `[]`.
    - `byId(id: number): HomelandRow | undefined`
    - `settle(account: string): void` - applies every job with `ends_at <= now` exactly once (th -> th+1; chunk -> push id to open; build -> insert building row with `last_collect = ends_at`), deletes the job.
    - `view(account: string): HomelandView` = `{ id, world, seed, gen, th, open: string[], built: Array<{ lot, kind, stored: number, capacity: number }>, jobs: Array<{ target, kind, ends_at }>, builders: { total, busy }, next: { th: TownhallStep | null, chunk: ChunkStep | null, buildings: Record<string, BuildingDef & { lot: string | null; can: boolean; why: string | null }> }, guests: string[] }`; calls `settle` first.
    - `start(account: string, kind: 'th'|'chunk'|'build', target: string, day: number): { toast: string; tags: string[]; ends_at: number }` - 409 messages (Indonesian): `Builder sedang bekerja.` (busy >= total), `Balai Kota perlu level N.`, `<Item> kurang (punya a, perlu b).`, `Chunk itu tidak bersebelahan dengan wilayahmu.`, `Sudah dibangun.`; charges costs as ledger rows (Global Constraints) with `ref` = `` `${world}:${kind}:${target}` ``.
    - `collect(account: string, lot: string, day: number, checkGain: (a: string, t: string, n: number) => void): { toast: string; tags: string[]; gained: Record<string, number> }` - `stored = min(capacity, floor(perGameHour * (now - last_collect) / realMsPerGameHour))`; 409 `Belum ada hasil.` when 0; on success `gs.add(day, account, produces, +stored, 'collect', ref)` and `last_collect` advances by exactly `stored / perGameHour` game hours (remainder kept), or to `now` when it was full.
    - `access(account: string, id: number): { row: HomelandRow; owner: boolean }` (404 unknown, 409 `Kamu tidak diundang ke dunia ini.`), `map(row): HomelandMap` (cached per `id:th:open:built` key), `setInvites(account, accounts: string[]): string[]` (max 20, names or account ids, as `Islands.setInvites` did), `invitedTo(account): Array<{ id: number; world: string; owner_name: string }>`.
  - `HomelandMap implements GameMap`: `walkable` (like `WorldMap`: solid tiles, closed chunks, buildings), `nearStall() -> false`, `nearPlot`, `atOwnHouse(p)` = within 1 of the Town Hall door, `checkGather` (tile kind + open chunk), `portal(): Pos`, `nearLot(p, lot): boolean` (dist to lot door <= 1).
- [ ] **Step 1: Write failing tests** `server/test/homeland.test.ts` (in-memory `Store`, fake `now`): `ensure is idempotent and ids count up`; `kolam build: 5 wood leaves, job ends after 45 s, building exists after`; `one builder: a second start answers 409 Builder sedang bekerja`; `finishes once after restart` (new `Homelands` on the same db, `view` twice, one building row); `chunk n=1 needs 10 wood and an adjacent chunk`; `th upgrade needs coin, coin goes to the town`; `collect: 60 s gives 2 fish, capacity 6 caps 10 min`; `collect over the daily cap: 409 and stored unchanged`; `guest access: invited 200, stranger 409`.
- [ ] **Step 2: Run** `node --test server/test/homeland.test.ts` -> FAIL.
- [ ] **Step 3: Implement** the config, econ types, store tables/methods, `homeland.ts`, `HomelandMap`.
- [ ] **Step 4: Run** the tests -> PASS.
- [ ] **Step 5:** Do not commit yet (Task 3 finishes the server wiring; `npm test` passes only after Task 3 removes `islands.ts` users).

### Task 3: Wire Homelands into the game and API; public area trades only

**Files:**
- Modify: `server/src/game/game.ts`, `server/src/app.ts`, `server/src/main.ts`, `server/src/social.ts` (`worldIdOk` accepts `^(public|HL-[1-9]\d{0,9})$`), `server/src/config.ts` (drop voucher/settler settings only if unused elsewhere)
- Delete: `server/src/game/islands.ts`, `server/test/islands.test.ts` and any island-only tests; remove island references from other tests
- Test: `server/test/homeland-game.test.ts`

**Interfaces:**
- `Game.homelands: Homelands`; `Game.worldFor(account, wid, ownerOnly): { map: GameMap | null; row: HomelandRow | null }`.
- `ACTIONS` = `['gather','craft','eat','farm','ship','sell','buy','fight','flee','engage','travel','build','collect']`. `/api/act` bodies: `{action:'build', kind:'th'|'chunk'|'build', target}`, `{action:'collect', lot}`, `{action:'travel', to:'public'|'HL-<n>'}` (must stand within 2 tiles of the current world's portal).
- With `econ.homeland.publicTradeOnly`: in `public`, `gather`, `farm`, `engage` answer 409 `Area publik hanya untuk berdagang.`; monsters are not created for public. In a Homeland, `sell`/`buy` are impossible (no stalls), `ship` 409 `Kotak Kirim hanya ada di area publik.`; `craft`/`ship` "at own house" means the Town Hall door.
- `build`/`collect` require the owner and standing near: `build kind:'build'|'collect'` within 1 of the lot door; `th` and `chunk` within 1 of the Town Hall door.
- `Positions.report`: a report exactly on the player's own Homeland spawn is always accepted and moves them into that world (page reload / Start lands at home). Remove the island "spawn or dock" special case.
- `Game.onNewPlayer` also calls `homelands.ensure`. `Game.state(account)` adds `homeland: HomelandView | null` (own view always, since the HUD needs builder status) and `worldId`; drops `island`.
- HTTP: `GET /api/homeland` -> `{ ...view(acct), invited: invitedTo(acct) }`; `GET /api/homeland/layout?world=HL-<n>` -> `{ world, seed, gen, th, open, built: [{lot, kind}] }` for the owner or a guest (generator inputs); `POST /api/homeland/invite {accounts: string[]}` -> `{ invite }`. Remove `/api/islands*` and the `buy_island`/`save_island` relay hook.
- [ ] **Step 1: Write failing tests** `server/test/homeland-game.test.ts` (Game with `worldSeed` on MockChain, as existing game tests do): `reload lands at own spawn`; `gather in public answers 409 Area publik hanya untuk berdagang`; `demo path: gather wood at home x5, build kolam, advance 45 s, collect after 30 s gives fish, travel to public, sell fish at a stall gives coin`; `travel needs the portal`; `stranger cannot enter HL-<other>`.
- [ ] **Step 2: Run** -> FAIL.
- [ ] **Step 3: Implement** the wiring; delete islands code and fix every test that referenced it.
- [ ] **Step 4: Run** `npm test` -> all PASS, tsc clean.
- [ ] **Step 5:** (orchestrator commits Tasks 2+3) "Players own a Homeland with a Town Hall, a builder and a Kolam Ikan, and travel by portal to a public area that is only for trading".

### Task 4: Client Homeland (draw, interact, portal)

**Files:**
- Create: `client/js/mods/homeland.js`
- Modify: `client/js/engine.js` (world switching for `HL-*`), `client/js/buildings.js` (art: Town Hall, Kolam Ikan, Tambang, Restoran, portal, builder NPC with hammer), `client/index.html` (load `world/homeland.js` and `mods/homeland.js`; drop `world/island.js`, `mods/islands.js`), `client/sw.js` (cache version +1), `client/js/mods/chain.js` (any `IS-`/island reference -> `HL-`)
- Delete: `client/js/world/island.js`, `client/js/mods/islands.js`

**Interfaces:**
- Consumes Task 3 HTTP API and act bodies exactly as listed there; Task 1 `GTHomeland.generate` and `chunkOf`.
- `GT.switchWorld(id, layout)` accepts `id` matching `/^HL-\d+$/` with a `GTHomeland` layout; `layoutChunk` uses `GTHomeland.chunkOf` for Homeland layouts; locked chunks draw under fog (same as village closed chunks). `GT.world.portal` replaces `GT.world.dock`; the public village's portal is drawn at `GTVillage.dockOf(L)`.
- `client/js/mods/homeland.js` registers `{ id: 'homeland', init, onInteract, onFrame, onDraw, onWorld }`:
  - Loads `GET /api/homeland` after login and every state refresh while in a Homeland; rebuilds the layout when `th`, `open` or `built` changes (calls `GT.switchWorld` with the new layout, keeping the player position).
  - Town Hall door -> `GT.modal` "Balai Kota" with: level, builder status (countdown from `ends_at`), "Naikkan ke level N" with costs, "Buka wilayah" listing adjacent locked chunks with costs, `Undang teman` (invite list).
  - Empty lot door -> build menu for that lot kind (cost, time, can/why). Built lot -> `Ambil hasil (n)` -> `collect`. A floating `+n` icon over a building when `stored > 0`.
  - Portal -> `GT.menu` "Portal": `Area Publik`, `Rumahku`, each invited world `Dunia <owner_name>`. Sends `travel`, then switches world (layout from `/api/homeland/layout` for `HL-*`).
  - Builder NPC drawn next to the job target with a hammer animation while a job runs, idle by the Town Hall otherwise.
- [ ] **Step 1:** Implement; keep every call through `window.GT`.
- [ ] **Step 2: Verify** in the browser (`npm run dev:mock` equivalent, see README for Windows): after dev login and Start, the Homeland renders with fog on 8 chunks, Town Hall menu opens, chop a tree, build Kolam Ikan, countdown shows, collect fish, portal to public, sell fish to Sari. Browser console has no errors.
- [ ] **Step 3:** (orchestrator commits) "The Homeland is drawn and playable: Town Hall menu, building lots, builder at work, collect, and a portal to the public area".

### Task 5: Character screen, `name#tag`, look, fall animation

**Files:**
- Modify: `server/src/db.ts` (`names` gets `tag TEXT` and `look INTEGER NOT NULL DEFAULT 0`; unique index on `(lower(name), tag)` instead of name; `tagOf(account)` assigns a random free 5-digit tag `10000-99999` on first call; `setName(account, name)`, `setLook(account, look)`, `lookOf(account)`), `server/src/social.ts` (nick = name; presence rows add `tag` and `look`; `/msg name#tag` and `/msg name` both resolve, plain name only when unique), `server/src/app.ts` (`POST /api/name {name?, look?}` -> `{ name, tag, look }`; presence response adds `tag`, `look` for `me`), `client/js/mods/players.js` (other players drawn with their `look` palette; name tag shows `name#tag` in player cards, `name` above heads; remove first-login `promptName` in favour of the character screen)
- Create: `client/js/mods/charscreen.js` (registered mod), CSS in `client/css/` file used by the HUD
- Test: `server/test/names-tag.test.ts`

**Interfaces:**
- Look = palette index 0-7 of `sprites.js` character palettes (8 is police, not offered).
- Character screen (full-screen overlay, Indonesian): left a large canvas preview drawn with `GT`'s character drawing (expose `GT.drawCharacter(ctx, x, y, look, dir, step)` from the engine if not exposed); above it the name in an input + fixed `#12345` tag; right a 4x2 grid of look swatches and a big `Mulai` button. Shown after every login and on page load when logged in (CoC-style), before the world is controllable. Saving: `POST /api/name`.
- `Mulai`: plays ~1.6 s animation - the character is thrown up from the bottom of the screen, spins, falls onto the Homeland spawn with a dust puff - then hands control to the player in their Homeland (the client reports position at the Homeland spawn; Task 3 accepts it). Respect `prefers-reduced-motion` with a fade.
- [ ] **Step 1: Write failing test** `server/test/names-tag.test.ts`: `tag is 5 digits and stable`; `two accounts may share a name with different tags`; `same name+tag cannot be taken`; `look outside 0-7 answers 400`.
- [ ] **Step 2: Run** -> FAIL. **Step 3: Implement.** **Step 4: Run** `npm test` -> PASS.
- [ ] **Step 5: Verify** in the browser: after dev login the character screen shows, renaming and look change persist after reload, another browser tab sees the new look.
- [ ] **Step 6:** (orchestrator commits) "After login players see their character with name#tag, pick a look, and press Mulai to be thrown into their Homeland".

### Task 6: Docs, status and full verification

**Files:** `README.md` (status block), `CLAUDE.md` (layout table + core rules: Homeland replaces islands), `docs/world.md` (Islands section -> Homeland section), `docs/onchain-offchain.md`, `docs/threat-model.md` (vouchers removed; builder timers; public trade-only), `docs/superpowers/specs/2026-11-06-islands-design.md` (one line at top: superseded by the Homeland design).

- [ ] **Step 1:** Update the docs; phase B/C items marked *(planned)*.
- [ ] **Step 2:** `npm test` -> PASS; `node scripts/check-secrets.mjs` -> clean.
- [ ] **Step 3:** Full demo path in the browser on a fresh mock DB, timed: Start -> first coin from fish in <= 3 minutes.
- [ ] **Step 4:** (orchestrator commits) "Docs describe the Homeland and the trading-only public area".
