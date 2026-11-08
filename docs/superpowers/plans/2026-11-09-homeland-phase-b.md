# Homeland Phase B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Worker bots for the Homeland, merchants that act like players and talk through Claude, direct player-to-player trade, a consignment merchant and a top-seller leaderboard in the public area.

**Architecture:** Three vertical slices, each owning its server and client code, built in parallel git worktrees and merged by the orchestrator: B1 bots (Homeland), B2 merchants as AI players (dialogue + presence), B3 public-area economy (trade, consignment, leaderboard). All new state is off-chain SQLite plus ledger rows settled daily, like merchant trades.

**Tech Stack:** Node >= 24 `.ts` (erasable only), `node:sqlite`, `node --test`; plain browser JS mods on `window.GT`; `fetch` to the Anthropic Messages API (no SDK). No contract change.

**Spec:** `docs/superpowers/specs/2026-11-08-homeland-design.md` (sections 5, 6, 9); Phase A plan `docs/superpowers/plans/2026-11-08-homeland-phase-a.md` for the existing APIs.

## Global Constraints

- In-game text Indonesian; code/docs English. Numbers in `economy/config.json`, not code.
- Off-chain only; every coin/item movement is a `GameStore.add` ledger row (one sqlite transaction per user action). Gains go through `World.checkGain`.
- Coin spent on bots goes to the town treasury (`-n` player, `+n` town). Fees go to the town treasury.
- **Decision (orchestrator):** direct player-to-player trade is off-chain (ledger rows, kind `trade`), like merchant trades, settled daily. On-chain Pasar listings stay as they are.
- Bots never leave their owner's Homeland, never hold coin or items, never trade (no API lets them).
- Model text never triggers a trade, price change or chain action.
- AI provider is set only by the developer through env: `DIALOGUE_PROVIDER` = `anthropic` (default when `ANTHROPIC_API_KEY` is set) | `nearai` | `local`; `DIALOGUE_MODEL` default `claude-sonnet-5-5`; effort low. Without a key the local lines answer, as today.
- `npm test` green and `tsc` clean at the end of each task; `node scripts/check-secrets.mjs` before committing config changes.
- Workers do not commit to `homeland`; each works in its own worktree branch and commits there; the orchestrator merges.

## Review Focus

1. Two players accept the same trade at once or one side spends the items before accepting: the trade fails cleanly with 409, no negative balances (B3 test).
2. Consignment while the owner is offline sells only when the merchant's current buy price >= the owner's minimum, never beyond the deposited quantity (B3 test).
3. Hiring a second Builder lets two jobs run at once; hiring beyond the cap answers 409 (B1 test).
4. Anthropic API down, slow (> 8 s) or returning an error: the merchant answers with a local line, no 500 (B2 test with a fake fetch).
5. Chat `/msg Sari ...` to a merchant from the Homeland (not public) answers "Pedagang ada di area publik." (B2 test).

---

### Task B1: Worker bots in the Homeland

**Files:** `economy/config.json` (`homeland.bots`), `server/src/game/econ.ts`, `server/src/game/gamestore.ts` (table `homeland_bots (account TEXT, id INTEGER, job TEXT, hired_at INTEGER, PRIMARY KEY(account, id))`), `server/src/game/homeland.ts`, `server/src/game/game.ts` (act `hire`), `server/src/game/world.ts` (bonus hooks), `client/js/mods/homeland.js`, `client/js/buildings.js` or engine draw via `onDraw`; test `server/test/homeland-bots.test.ts`.

**Interfaces:**
- Config:
```json
"bots": {
  "builder":  { "name": "Tukang",   "rarity": "common", "price": 150, "max": 3, "effect": { "builders": 1 } },
  "petani":   { "name": "Petani",   "rarity": "common", "price": 120, "max": 2, "effect": { "farmGrowFactor": 1.5 } },
  "nelayan":  { "name": "Nelayan",  "rarity": "common", "price": 120, "max": 2, "effect": { "fishRate": 1.5 } },
  "penebang": { "name": "Penebang", "rarity": "common", "price": 120, "max": 2, "effect": { "woodBonus": 1 } }
}
```
  The default Builder (`homeland.builders: 1`) is not a hired bot; hired `builder` bots add to it. Effects stack per bot: `builders` adds slots; `farmGrowFactor` divides Homeland farm grow days (`ceil(growDays / factor^n)`, min 1); `fishRate` multiplies Kolam Ikan `perGameHour` (`x factor^n`); `woodBonus` adds +n wood per tree gathered in the owner's Homeland. Requires Town Hall level 2 for non-builder jobs (`th` field optional per bot, default 1 for builder, 2 for others).
- `Homelands.hire(account, job, day): { toast, tags }` (409 `Pekerja <name> sudah penuh (maks n).`, `Balai Kota perlu level N.`, `Koin kurang (punya a, perlu b).`); `Homelands.bots(account): Array<{ id, job, name }>`; `Homelands.effects(account): { builders: number; farmGrowFactor: number; fishRate: number; woodBonus: number }`.
- `view()` adds `bots: Array<{ id, job, name }>` and `hire: Record<job, { name, price, rarity, max, have, th, can, why }>`.
- `/api/act {action:'hire', job, world, pos}` - owner, in own Homeland, standing at the Town Hall (`atOwnHouse`).
- Client: Balai Kota modal gets a "Pekerja" section (hire buttons with price, have/max, why). Each bot walks/idles near its workplace (farm for Petani, Kolam Ikan for Nelayan, forest edge for Penebang, Town Hall for extra Tukang) with its job name above its head.
- [x] Tests (`homeland-bots.test.ts`): `hire charges coin to the town`; `second builder runs two jobs at once`; `max per job answers 409`; `petani makes homeland crops grow faster`; `nelayan raises kolam output`; `penebang adds wood per tree at home only`; `hire outside own homeland answers 409`.
- [x] Implement, `npm test` green, browser check: hire a Nelayan, see it standing at the Kolam, collect is faster.

### Task B2: Merchants act like players and talk through Claude

**Files:** `server/src/dialogue.ts` (Anthropic provider), `server/src/config.ts` + `.env.example` (`DIALOGUE_PROVIDER`, `ANTHROPIC_API_KEY`, `DIALOGUE_MODEL`), `server/src/main.ts`, `server/src/social.ts` (merchant presence + `/msg` to merchants), `client/js/mods/players.js` (draw merchants like players, open their shop on the player card), tests `server/test/dialogue-anthropic.test.ts`, `server/test/social.test.ts`.

**Interfaces:**
- Read the `claude-api` skill before writing the Anthropic call (exact request shape, how to set effort low for `claude-sonnet-5-5`, headers `x-api-key`, `anthropic-version`). Use `fetch` with `AbortSignal.timeout(8000)`; `max_tokens` small (about 200); system prompt = existing merchant persona + current prices (as `dialogue.ts` builds it for NEAR AI). `DialogueReply.source` becomes `'anthropic' | 'nearai' | 'local'`.
- Provider choice: `DIALOGUE_PROVIDER` explicit, else `anthropic` if `ANTHROPIC_API_KEY`, else `nearai` if `NEARAI_API_KEY`, else `local`. The client can never choose it.
- Merchants in presence: in world `public`, `players[]` includes one entry per merchant `{ account: <merchant account>, nick: <merchant name>, tag: 'NPC', look: <fixed per merchant>, x, y (in front of their stall), dir: 'down', npc: true, title: <role> }`. They show in the online list with an NPC badge.
- `/msg Sari <text>` (or `/msg Sari#NPC`) from public: the line appears as a private chat line to the player, and the merchant's AI answer comes back as a private line `from: Sari, fromTag: 'NPC'` (uses the existing `/api/talk` rate limit: 6 per minute per account). From a Homeland: 409 `Pedagang ada di area publik.`
- Player card of a merchant: "Lihat dagangan" opens that merchant's shop (existing chain.js shop modal), "Tanya" prefills `/msg <name> `.
- [x] Tests: `anthropic provider sends model claude-sonnet-5-5 and returns its text` (fake fetch); `anthropic error or timeout falls back to a local line`; `no key uses local`; `merchants appear in public presence with tag NPC`; `/msg to a merchant from a homeland answers 409`.
- [x] Implement, `npm test` green, browser check with no key: merchants visible with name tags, `/msg Sari harga ikan?` gets a local answer bubble.

### Task B3: Public-area economy: trade, consignment, leaderboard

**Files:** create `server/src/game/trade.ts`, `server/src/game/consign.ts`; modify `server/src/game/gamestore.ts` (tables), `economy/config.json` (`trade`, `consign`), `server/src/game/econ.ts`, `server/src/game/game.ts` (hourly consignment tick in `step()`), `server/src/app.ts` (routes); create `client/js/mods/trade.js` (+ script tag in `client/index.html`, cache bump in `client/sw.js`); public-area art for the consignment stall and the leaderboard board via the mod's `onDraw`; tests `server/test/trade.test.ts`, `server/test/consign.test.ts`, `server/test/leaderboard.test.ts`.

**Interfaces:**
- Config: `"trade": { "expireSecs": 120, "maxLines": 4 }`, `"consign": { "merchant": "Mbok Darmi", "feeBps": 500, "maxPerItem": 50, "sellPerGameHour": 3 }`.
- **Direct trade** (both players in `public`, within 3 tiles of each other):
  - `POST /api/trade/offer {to: 'name#tag'|account, give: {token: qty}, want: {token: qty}}` -> `{ id, expires_at }`; give/want up to `maxLines` tokens each, `coin` allowed; offerer must have `give` now (checked, not reserved).
  - `GET /api/trade` -> `{ incoming: [...], outgoing: [...] }` (`{id, from, from_tag, to, to_tag, give, want, expires_at}`).
  - `POST /api/trade/accept {id}` -> executes atomically (one transaction): re-checks both balances (409 `<Item> kurang.`), both positions (409 `Kalian harus berdekatan di area publik.`), not expired (409 `Tawaran kedaluwarsa.`); ledger rows kind `trade` both ways; `checkGain` for each receiver. `POST /api/trade/cancel {id}` (offerer or receiver).
- **Consignment** (stall "Titip Jual" in the public area at a fixed tile next to the market; `nearStall`-style proximity check, within 3 tiles):
  - `POST /api/consign {token, qty, min_price}` - moves items from the player into consignment (ledger `-qty` kind `consign_in`); `GET /api/consign` -> own lots `{token, qty, min_price, sold, earned}`; `POST /api/consign/withdraw {token}` returns unsold items (`+qty`, kind `consign_out`).
  - Hourly in `Game.step()`: for each lot, up to `sellPerGameHour` units sell to the town (like town demand) when the best merchant buy price for that token >= `min_price`; the player gets `price x n` minus `feeBps` (kind `consign_sale`, fee to the town), respecting `checkGain` (stop selling when capped). Items sold this way are burned from consignment (they left the player at deposit).
- **Leaderboard:** `GET /api/leaderboard?period=day|all` -> `{ period, rows: [{ rank, account, name, tag, sold_qty, coin }] }` top 10 by items sold (merchant `sell` + `consign_sale` + items given in `trade` for coin), from ledger rows. A board in the public area ("Papan Juara") opens it; current player's own rank shown even if not top 10.
- Client `trade.js`: player card gets "Ajak dagang" (offer modal: pick from your Tas, ask for items/coin); incoming offer toast + modal with Terima/Tolak; Titip Jual stall modal; Papan Juara modal.
- [x] Tests: `trade swaps items and coin atomically`; `accept fails when offerer spent the items`; `double accept: second answers 409`; `expired offer answers 409`; `trade only in public and near each other`; `consign sells only at or above min price, fee to town`; `consign never sells more than deposited, withdraw returns the rest`; `leaderboard counts sells and consign sales, ranks by quantity`.
- [x] Implement, `npm test` green, browser check: two dev logins in two tabs trade fish for coin; consign 5 fish; Papan Juara shows both.

### Task B4: Merge, docs, verification (orchestrator + one worker)

- [ ] Merge B1, B2, B3 into `homeland`, resolve conflicts (`config.json`, `gamestore.ts`, `game.ts`, `index.html`, `sw.js`), `npm test` green.
- [ ] Docs: README status (phase B built), CLAUDE.md (new modules/routes, provider env), `docs/world.md`, `docs/threat-model.md` (trade/consign/AI provider), `docs/onchain-offchain.md` (direct trade off-chain), `.env.example`.
- [ ] Browser smoke of all three slices together; push `homeland` and fast-forward `main` when the owner says so.
