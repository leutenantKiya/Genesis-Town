# Homeland Phase C Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The rare Hunter who forages through winter, a Chef who makes food better and a Restoran that cooks instead of printing meals, and coin-bought cosmetics that make a bot better at its job.

**Architecture:** Extends the phase B bot system in `server/src/game/homeland.ts` (`hire`, `effects`) and its client in `client/js/mods/homeland.js`. All off-chain, ledger rows, no new item tokens (the contract's token registry stays unchanged), no contract change.

**Tech Stack:** as phase B. **Spec:** `docs/superpowers/specs/2026-11-08-homeland-design.md` sections 4.3 and 5; phase B plan `docs/superpowers/plans/2026-11-09-homeland-phase-b.md`.

## Global Constraints

- Same as phase B (Indonesian UI text, numbers in `economy/config.json`, ledger rows, `checkGain` on every gain, coin spent goes to the town, own-property lookups only: `Object.hasOwn` for every config key coming from a request).
- No new item tokens: Hunter and Restoran produce existing items only (`fish`, `wood`, `meal`).
- **Decisions (orchestrator, owner did not choose):** Restoran no longer produces `meal` from nothing; it cooks `meal` from the `meal` recipe inputs (1 fish + 1 wood). Hunter forages existing items, doubled in winter.

## Review Focus

1. Restoran cook without enough fish/wood: 409, nothing consumed.
2. Hunter output while offline across a season change: computed per game hour with the season of that hour (or at worst the current season), never more than capacity.
3. Cosmetic bought for a bot id that is not the caller's: 403/409, no coin charged.
4. Chef bonus on `eat` applies only to the owner's own bread/meal eating and never pushes energy over `energyMax`.
5. A request job/cosmetic name like `constructor` or `__proto__`: 400, nothing charged.

---

### Task C1: Hunter, Chef, Restoran that cooks

**Files:** `economy/config.json` (`homeland.bots.hunter`, `homeland.bots.chef`, `homeland.buildings.restoran`), `server/src/game/econ.ts`, `server/src/game/homeland.ts`, `server/src/game/game.ts` (acts `cook`, `forage`), `server/src/game/world.ts` (`eat` bonus hook), `client/js/mods/homeland.js`; test `server/test/homeland-c.test.ts`.

**Interfaces:**
- Config additions:
```json
"hunter": { "name": "Pemburu", "rarity": "rare", "price": 400, "max": 1, "th": 3, "effect": { "forage": { "items": ["fish", "wood"], "perGameHour": 1, "capacity": 6, "winterFactor": 2 } } },
"chef":   { "name": "Koki",    "rarity": "rare", "price": 350, "max": 1, "th": 3, "effect": { "foodEnergy": 1.5, "cookBonus": 1 } }
```
  `restoran` building: remove `produces`/`perGameHour`/`capacity`; add `"cooks": "meal"` (recipe from `econ.recipes.meal`).
- Hunter: stored forage computed lazily like buildings (`last_forage` per account, new column or table); items alternate fish/wood by game hour index (deterministic); in the winter season (`econ.seasons` entry whose id is `dingin`, the same one `farm.noGrowthSeasons` uses) the hour counts `winterFactor` units. `POST /api/act {action:'forage'}` at the Town Hall collects (409 `Pemburu belum membawa apa-apa.`), through `checkGain` per item.
- Restoran: `POST /api/act {action:'cook', qty}` (1-10) standing near the built `restoran` lot door: consumes `qty` x recipe inputs, gives `qty` meal plus `cookBonus` extra meal per cook action when a Chef is hired (not per unit), `checkGain` on the meal. 409 `Bahan kurang (perlu n Ikan, n Kayu).`; 409 `Bangun Restoran dulu.`.
- Chef: `World.eat` multiplies the energy from bread/meal by `foodEnergy` when the eater owns a Chef (capped at `energyMax`).
- `view()` adds `forage: { stored: Record<item, number>, capacity } | null` and `cook: { recipe, can, why } | null`.
- Client: Balai Kota shows "Pemburu membawa: n Ikan, n Kayu" with an Ambil button; Restoran lot menu becomes "Masak" with a qty picker; hire list shows rare bots with a "Langka" badge.
- [ ] Tests (`homeland-c.test.ts`): `restoran cooks meal from fish and wood`; `restoran without ingredients answers 409 and consumes nothing`; `chef adds a bonus meal per cook and more energy when eating, capped`; `hunter forages fish and wood up to capacity`; `hunter doubles in winter`; `forage at the town hall only`; `rare bots max 1 and need town hall 3`.

### Task C2: Cosmetics that boost bots

**Files:** `economy/config.json` (`homeland.cosmetics`), `server/src/game/econ.ts`, `server/src/game/gamestore.ts` (column `cosmetic TEXT` on `homeland_bots`, added with a guarded `ALTER TABLE`), `server/src/game/homeland.ts`, `server/src/game/game.ts` (act `dress`), `client/js/mods/homeland.js` (shop in the Balai Kota "Pekerja" section, hats drawn on bots); test `server/test/homeland-cosmetics.test.ts`.

**Interfaces:**
- Config:
```json
"cosmetics": {
  "caping":  { "name": "Caping",       "price": 80,  "boost": 0.2,  "color": "#d8b060" },
  "syal":    { "name": "Syal Merah",   "price": 150, "boost": 0.35, "color": "#c83838" },
  "mahkota": { "name": "Mahkota Emas", "price": 300, "boost": 0.5,  "color": "#f0c838" }
}
```
- `POST /api/act {action:'dress', bot, cosmetic}` (owner, own Homeland, at the Town Hall): bot id must be the caller's; replaces any current cosmetic (no refund); coin to the town (kind `cosmetic`). 400 unknown cosmetic, 409 `Pekerja itu bukan milikmu.`, 409 coin short.
- Boost per bot (`b` = its cosmetic boost, 0 without): factor effects become `1 + (f - 1) * (1 + b)` (farmGrowFactor, fishRate, foodEnergy); `woodBonus` adds an extra wood with probability `b` per gather (use the World rng); Hunter `perGameHour * (1 + b)` (floor at collection, remainder kept as with buildings); Chef `cookBonus` +1 when `b >= 0.5`; a dressed Tukang makes jobs started while it is hired `secs * (1 - 0.5 * maxBuilderBoost)` (rounded up).
- `view().bots[]` gains `cosmetic: string | null`; `view()` adds `cosmetics: Record<id, { name, price, boost, color }>`.
- [ ] Tests: `dress charges coin to the town and sets the cosmetic`; `dressing another player's bot answers 409, no coin`; `unknown or prototype cosmetic names answer 400`; `boost raises nelayan fish rate`; `dressed tukang shortens job time`.

### Task C3: Docs, smoke, push (orchestrator + workers)

- [ ] README status (phase C built), `docs/world.md` (bots table + cosmetics + Restoran cooking), `docs/economy.md` (sinks: rare bots, cosmetics; Restoran no longer a source), `docs/threat-model.md` (cosmetic ownership check), plan checkboxes.
- [ ] Browser smoke: hire Pemburu and Koki at TH3 (dev grant), forage, cook, eat, dress a bot.
- [ ] Push `homeland` and fast-forward `main` when the owner says so.
