# Homeland Phase C Implementation Plan (v2, owner design 2026-11-09)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything in the Homeland feeds one thing, building speed. Contractors get tired; the Restoran feeds them; bots live in houses whose furniture (beds, entertainment) sets how many bots fit and how motivated they are; a Rumah Sakit heals bots that collapse; cosmetics make bots better.

**Architecture:** Extends `server/src/game/homeland.ts` (builder jobs with `ends_at`, bots, lazy production), the generator `client/js/world/homeland.js` (new lots), and `client/js/mods/homeland.js`. Off-chain, ledger rows, existing item tokens only, no contract change. All state is computed lazily from timestamps (no tick job), replaying at most 72 game hours.

**Spec:** `docs/superpowers/specs/2026-11-08-homeland-design.md` sections 4-5, plus the owner's decisions below. Phase B plan for existing APIs.

## Owner decisions (2026-11-09)

- Contractors (Tukang) are paid once when hired; building and upgrades cost resources (coin, wood, ore, ...).
- Contractors have **fatigue**; tired contractors build slower. The **Restoran** serves food to contractors; faster serving = faster recovery = faster construction. The **Koki** makes serving faster.
- Bots need **houses**. A house is built on a lot; its **furniture** is upgraded: more **beds** = more bots per house (land efficiency), **entertainment** = more motivation for the bots living there.
- A **Rumah Sakit** treats bots.
- Orchestrator calls (owner agreed to the proposal): fatigue -> food, motivation -> entertainment, collapse at 100% fatigue -> hospital. Hunter forages fish/wood, doubled in winter (supplies the Restoran when farms stop). Cosmetics: on a contractor less fatigue, on other bots more output.

## Global Constraints

- Phase B constraints hold (Indonesian UI text, numbers in `economy/config.json` -> `homeland`, ledger rows, `checkGain` on gains, coin spent goes to the town, `Object.hasOwn` for any config key from a request).
- The demo path stays fast: a fresh player's default Tukang has 0 fatigue and the first Kolam Ikan still finishes in <= 60 s.
- The default Tukang lives in the Balai Kota (needs no bed, fixed motivation 60). Every hired bot needs a free bed.
- Generator change: bump `GTHomeland.VERSION` to 2; existing rows keep working (no live players yet; `gen` is informational).

## Review Focus

1. Server restart in the middle of a job / while a bot is sick: everything resumes from timestamps exactly once.
2. A contractor collapses mid-queue: the job in progress finishes, the contractor is then sick and gets no new job until healed; another free contractor can take jobs.
3. Hiring with no free bed: 409 `Tidak ada kasur kosong. Bangun Rumah Pekerja atau tambah kasur.`, no coin charged.
4. Restoran with an empty pantry serves nothing and never goes negative; serving takes meals from the Restoran stock only, never from the player's Tas.
5. Request names like `constructor` / `__proto__` for furniture, cosmetics, jobs: 400, nothing charged.

---

### Task C1: Contractor fatigue, Restoran pantry and serving, Koki, Pemburu

**Files:** `economy/config.json`, `server/src/game/econ.ts`, `server/src/game/gamestore.ts`, `server/src/game/homeland.ts`, `server/src/game/game.ts`, `server/src/game/world.ts` (only if needed), `client/js/mods/homeland.js`; tests `server/test/homeland-fatigue.test.ts`. (Uncommitted C1 v1 work in the tree — Restoran `cooks`, Pemburu forage, Koki config — may be reused; drop the Koki `foodEnergy` player-eating bonus.)

**Interfaces / numbers (config `homeland.fatigue`, `homeland.restoran`):**
```json
"fatigue": { "perJobMinute": 10, "idleRecoverPerGameHour": 5, "collapseAt": 100, "slowdownAt100": 1.0 },
"restoran": { "pantryMax": 20, "serveEveryGameHours": 1, "serveRelief": 30, "serveMinFatigue": 20, "chefServeFactor": 2 }
```
- Contractors = the default Tukang (slot 0) + hired `builder` bots. Each has `fatigue` 0-100 and `sick_until` (C2 uses it). Store in a table `homeland_workers (account, slot, fatigue REAL, updated_at INTEGER, sick_until INTEGER, PRIMARY KEY(account, slot))`.
- Job start picks the free, not-sick contractor with the lowest fatigue; duration = `ceil(secs x (1 + slowdownAt100 x fatigue/100) / motivationFactor)` (motivationFactor from C2; 1.0 until C2 lands). On job end: `fatigue += perJobMinute x secs/60` (cap 100). Idle contractors recover `idleRecoverPerGameHour` per game hour.
- Restoran pantry: `POST /api/act {action:'cook', qty}` at the Restoran door cooks `qty` meals from recipe `meal` inputs into the **pantry** (not the Tas), cap `pantryMax`; `POST /api/act {action:'stock', token:'bread'|'meal', qty}` moves food from the Tas into the pantry. Every `serveEveryGameHours` (divided by `chefServeFactor` with a Koki) the Restoran serves one portion to the most tired contractor with fatigue >= `serveMinFatigue`: pantry -1, fatigue -`serveRelief`. Lazy replay from the last update.
- Pemburu (rare, max 1, TH3, price 400): forages fish/wood alternately, `perGameHour` 1, capacity 6, x2 in season `dingin`; `POST /api/act {action:'forage'}` at the Balai Kota.
- Koki (rare, max 1, TH3, price 350): only the serving speed factor.
- `view()` adds `workers: [{slot, name, fatigue, busy, sick_until}]`, `restoran: { pantry, pantryMax, nextServeAt } | null`, `forage`.
- Client: Balai Kota shows each contractor with a fatigue bar; Restoran lot menu "Masak" (qty) and "Taruh makanan" (from Tas) and the pantry count; a tired contractor sprite slows its hammer; "Langka" badge on rare bots.
- [x] Tests: `fresh tukang builds kolam in 45 s`; `fatigue grows per job and slows the next job`; `idle contractors recover over game hours`; `restoran serves the most tired contractor from its pantry`; `koki doubles serving speed`; `empty pantry serves nothing`; `cook fills the pantry not the bag, 409 without ingredients`; `pemburu forages and doubles in winter`; `restart mid-job finishes once`.

### Task C2: Rumah Pekerja with furniture, motivation, Rumah Sakit

**Files:** `client/js/world/homeland.js` (lots: `rumah-<chunk>` one per chunk incl. `c`, and `rumahsakit-c`; keep validation; `VERSION` 2), `server/test/homeland-gen.test.ts`, `economy/config.json`, `server/src/game/econ.ts`, `server/src/game/gamestore.ts`, `server/src/game/homeland.ts`, `server/src/game/game.ts`, `client/js/mods/homeland.js`, `client/js/buildings.js` (house and hospital art); tests `server/test/homeland-housing.test.ts`.

**Interfaces / numbers:**
```json
"rumah": { "name": "Rumah Pekerja", "th": 1, "cost": { "wood": 15 }, "secs": 60,
  "furniture": {
    "kasur":   { "name": "Kasur",   "max": 4, "levels": [ { "cost": { "wood": 10 }, "secs": 30 }, { "cost": { "wood": 20, "coin": 20 }, "secs": 60 }, { "cost": { "wood": 30, "coin": 40 }, "secs": 90 }, { "cost": { "wood": 40, "coin": 80 }, "secs": 120 } ] },
    "hiburan": { "name": "Hiburan", "max": 3, "names": ["Radio", "TV", "Gamelan"], "levels": [ { "cost": { "wood": 10, "coin": 30 }, "secs": 60 }, { "cost": { "wood": 20, "ore": 10, "coin": 80 }, "secs": 120 }, { "cost": { "wood": 30, "ore": 20, "coin": 150 }, "secs": 240 } ] }
  } },
"rumahsakit": { "name": "Rumah Sakit", "th": 2, "cost": { "wood": 30, "ore": 10, "coin": 60 }, "secs": 180, "maxLevel": 3, "healGameHours": [3, 2, 1], "upgrade": [ { "cost": { "wood": 30, "ore": 15, "coin": 100 }, "secs": 240 }, { "cost": { "wood": 50, "ore": 30, "coin": 200 }, "secs": 480 } ] },
"sickGameHoursWithoutHospital": 24
```
- A built house starts with 1 bed (kasur level 0); each Kasur level adds 1 bed, so a house holds at most `1 + kasur.max` = 5 bots. Furniture upgrades are builder jobs (`build` act with `kind:'furniture'`, `target:'<lot>:kasur|hiburan'`), charged and timed like other builds (fatigue applies).
- Hiring needs a free bed (sum of beds over built houses minus hired bots); each hired bot is assigned to the house with a free bed and the best entertainment.
- Motivation of a bot = `min(100, 40 + 20 x hiburanLevel of its house)`; the default Tukang 60. `motivationFactor = 0.75 + 0.5 x motivation/100` multiplies contractor speed (C1 formula) and producer bots' effect strength (`fishRate`, `farmGrowFactor` excess, Pemburu rate).
- Collapse: a contractor reaching `collapseAt` fatigue becomes sick for `healGameHours[level-1]` with a built Rumah Sakit, else `sickGameHoursWithoutHospital`; on heal fatigue resets to 0. Sick contractors take no jobs.
- `view()` adds `houses: [{lot, beds, used, hiburan, hiburanName, motivation}]`, `beds: {total, used}`, `hospital: {level, healGameHours} | null`, `workers[].motivation`.
- Client: house lot menu (build house, Tambah Kasur, Hiburan level with names), bots shown at their house, sick contractors shown lying down with a red cross; hospital art; Balai Kota hire buttons disabled with the bed message when full.
- [x] Tests: `house gives one bed, kasur adds beds`; `hire without a free bed answers 409 and charges nothing`; `hiburan raises motivation and speeds builds`; `collapse makes a contractor sick, rumah sakit heals faster`; `sick contractor takes no job, another does`; `generator v2 has a rumah lot per chunk and a rumahsakit lot, all reachable` (in homeland-gen test).

### Task C3: Cosmetics

**Files:** `economy/config.json` (`homeland.cosmetics`: caping 80 coin boost 0.2, syal 150 boost 0.35, mahkota 300 boost 0.5, each with a `color`), `server/src/game/gamestore.ts` (bot column `cosmetic`, guarded `ALTER TABLE`), `homeland.ts`, `game.ts` (act `dress {bot, cosmetic}` at the Balai Kota; slot 0 Tukang can be dressed too), `client/js/mods/homeland.js` (shop in "Pekerja", hats drawn); tests `server/test/homeland-cosmetics.test.ts`.
- Effect with boost `b`: a contractor's fatigue gain x `(1 - b)`; producer bots' effect excess x `(1 + b)`; Pemburu rate x `(1 + b)`; Koki serve factor x `(1 + b)`.
- [ ] Tests: `dress charges coin to the town`; `dressing another player's bot 409, no coin`; `unknown or prototype cosmetic 400`; `dressed tukang tires slower`; `dressed nelayan raises fish rate`.

### Task C4: Docs, smoke, push

- [ ] README status, `docs/world.md` (contractors, fatigue, Restoran, houses, furniture, motivation, hospital, cosmetics), `docs/economy.md` (sinks), `docs/threat-model.md`, plan checkboxes.
- [ ] Browser smoke on a mock server with dev grants.
- [ ] Push `homeland` and fast-forward `main` when the owner says so.
