# Homeland: a Town Hall world for every player, a public market for everyone

Status: design, agreed with the owner 2026-11-08. Replaces the broker-sold Private Islands
(`2026-11-06-islands-design.md`) and refines the teammate's private-island-plus-hub model (`docs/island-design.md`).
Marks: **(owner)** = the owner said it; **(call)** = the designer's call, open to change.

## 1. Why

The hackathon demo (deadline 2026-11-14, track "Games With Real Economies") must let a judge feel one loop
**(owner)**: *build your first building, get your first resource from it, sell it at the public market*. The sale pays
`coin`, which reaches the player's NEAR account through the existing daily settlement, so the judge sees a game
action end in a real on-chain balance.

## 2. Goals, non-goals, anti-goals

Goals
- Every player has their own world (Homeland) with a Town Hall in the middle, grown Clash-of-Clans style: upgrade the
  Town Hall to unlock buildings and land **(owner)**.
- One public area for trading only: merchants and other players **(owner)**.
- Worker bots bought with coin, merchants that act like real players, AI dialogue **(owner)**.
- A login flow: character on the left, `name#12345` above it (renamable), customisation and Start on the right; Start
  plays a "thrown and falling into your world" animation **(owner)**.

Non-goals
- Homelands are **not NFTs and cannot be sold** **(owner)**. No broker, no Save World, no `IS-<id>-<version>` tokens.
- Bots and cosmetics are off-chain, bought with in-game coin, not tradable **(owner)**.
- No real-money payments **(owner)**.

Anti-goals (a failure even if it works)
- A wallet popup or gas prompt during play. Login stays NEAR Auth social login (Google/email) **(owner)**.
- A judge waiting minutes for a timer in the demo path: the first chunk and first building finish in about a minute
  **(call)**.
- Breaking the shared economy: one price system, one settlement, one coin supply.

## 3. Phases

Phase A (must ship before the deadline) **(owner chose "core first")**:
1. Login screen, `name#tag`, simple customisation, Start + fall animation.
2. Homeland: Town Hall, one farm plot, chunk unlocking with Town Hall level + items + time.
3. The default Builder bot and the first buildings with timers; buildings produce resources the player collects.
4. Portals between Homeland and the public area; selling to merchants there.

Phase B (if time allows): job bots, AI merchant dialogue on Claude, player-to-player trade, consignment merchant,
top-seller leaderboard.

Phase C (after): cosmetics, Hunter winter bonus, Chef food bonus.

## 4. Homeland

### 4.1 Map **(call, except where marked)**
- 3 x 3 chunks, max 9 **(owner: "max world size 9")**, each 16 x 16 tiles (48 x 48 when fully open). Town Hall in the
  middle chunk **(owner)**. Locked chunks are drawn under fog, like the village's closed chunks.
- Generated from a seed by a shared generator (`client/js/world/homeland.js`), run by browser and server like
  `village.js` / `island.js`. Seed = hash(`WORLD_SEED`, account id). The seed decides each outer chunk's biome
  (forest, rock/mineshaft ground, pond, sea shore, meadow) and so which resources that Homeland has **(owner: seed
  affects resources)**. Every seed must give at least one forest and one water chunk next to the centre (validated,
  retried like `village.js`).
- Start state **(owner)**: Town Hall level 1, one farm plot, nothing else built. The centre chunk also has a few trees
  and rocks to gather by hand, so a new player can earn the first wood **(call)**, plus the portal.
- World id: reuse the per-world machinery from branch `islands` (`Game.worldFor`, `GT.switchWorld`, per-world
  presence/chat). Each account gets one Homeland id at first login (`HL-<n>`) **(call)**.
- Invites from the islands branch stay (owner + up to 20 guests; guests walk and chat, cannot gather or build).

### 4.2 Town Hall
- Levels 1-5 **(call)**. Upgrading costs items + coin + time and occupies one builder. Each level unlocks buildings,
  raises the open-chunk limit and may unlock new bot slots. All numbers in `economy/config.json` -> `homeland`.
- Opening chunks **(owner)**: each next chunk needs a minimum Town Hall level, items, and time, rising with each chunk
  opened. Example from the owner: the first chunk needs Town Hall 1 and 10 wood. The player picks which adjacent
  locked chunk to open **(call)**.

### 4.3 Buildings **(owner names them, call for the details)**
| Building | Unlock | Gives |
| --- | --- | --- |
| Kebun (farm plot) | start; more plots per TH level | wheat (existing farm rules) |
| Kolam Ikan | TH 1, first building in the demo | fish over time |
| Tambang (mineshaft) | TH 2, on a rock chunk | ore over time |
| Restoran | TH 3 | crafts meal/bread with a bonus (Chef in phase C) |
| Laut, Hutan | open with the matching chunk biome | sea fishing / wood gathering spots |

- Placement: fixed lots per chunk chosen by the generator **(call)**, not free placement (no layout editor before the
  deadline).
- Production: a producer building stores goods up to a capacity at a rate per game hour; the player taps it to collect.
  Collecting writes the same off-chain ledger rows as gather and counts against `caps.dailyGainPerItem`.
- Timers are server-authoritative: the server stores `ends_at`; a building is done when `now >= ends_at`.

## 5. Bots (worker NPCs) **(owner, details call)**
- Off-chain, bought with coin (the coin goes to the town treasury, like other sinks), not tradable.
- Every player starts with one **Builder** **(owner)**. One builder works on one construction at a time; more builders
  can be bought.
- Jobs: Petani (faster farm growth, common), Builder (common), Nelayan (better fish chance, common), Penebang (more
  wood, common), Hunter (stronger in winter, rare), Chef (food stat bonus).
- Restrictions **(owner: "ada beberapa larangan")**, as the designer reads them: bots stay in their owner's Homeland,
  never enter the public area, never hold coin or items, never trade or sell.
- Cosmetics (phase C) are bought with coin and add a small stat boost to a bot.

## 6. Public area
- Today's village core becomes the public area. It is for trading only **(owner)**: no gathering, farming or monsters
  there **(call: hand gathering moves to Homelands)**.
- A portal in every Homeland leads to the public area; a portal there leads back to the player's own Homeland
  **(owner)**.
- Merchants (Sari, Budi, Wati, Joko) keep their own on-chain wallets and dynamic prices (stock, demand, cash, season:
  winter raises food prices) **(owner)**. In phase B they show up like players: name tags, presence, chat.
- Phase B: direct trade between players **(owner)**; a consignment merchant who sells a player's goods for a fee
  **(owner)**; a leaderboard board of top sellers **(owner)**.
- AI dialogue for public NPCs **(owner)**: default model Claude Sonnet 5.5 at low effort (`claude-sonnet-5-5`); only the
  developer can change it, through env (`DIALOGUE_PROVIDER`, `ANTHROPIC_API_KEY`, `DIALOGUE_MODEL`). NEAR AI Cloud and
  the local fallback lines stay as alternatives. As today, model text never triggers a trade, price or chain action.

## 7. Login flow
- NEAR Auth social login unchanged **(owner)**. After it, a character screen: preview left, name above with an
  editable name and a fixed `#12345` tag, customisation and Start right **(owner)**.
- Tag: 5 digits assigned once per account; names no longer need to be unique, `name#tag` is **(call)**.
- Customisation in phase A: a few palette choices for skin, hair, shirt drawn with the existing sprites **(call)**.
- Start: the character is thrown up and falls onto the Town Hall square of the player's Homeland **(owner)**.

## 8. On-chain vs off-chain
- Off-chain: Homeland state, buildings, timers, bots, cosmetics, collection (ledger rows, settled daily).
- On-chain (unchanged): items and coin (NEP-245), merchant trades settled daily, P2P market listings, projects.
- Contract: no change needed for phase A. The v5 island methods on branch `islands` are not deployed and are not
  needed. Player-to-player direct trade (phase B) may need an escrowed swap; to be decided in its plan.

## 9. Decisions after the builder check (all **(call)**)
1. **Public area today's features.** Gathering, farming, monsters/combat and the bridge project are turned off in the
   public world behind flags, not deleted (teammate's combat work can move to Homelands later, e.g. for the Hunter).
   Prototype mods stay as they are. The islands branch's broker, offers, vouchers and `island_upgrade` are removed
   from server and client; invites, `worldFor`, travel and per-world presence are reused. No data migration: mock DB
   is fresh each start, and testnet has no Homeland rows yet.
2. **Economy.** Existing per-account caps (`World.checkGain`: `caps.dailyGainPerItem`, `caps.dailyCoinGain`) apply to
   every gain, Homeland collection included. Merchants keep buying every item. Numbers are tuned so a new player can
   sell their first fish for visible coin within ~3 minutes of pressing Start.
3. **Production accrual.** Computed lazily: `stored = min(capacity, rate x game-hours since last collect)`, so it also
   accrues offline but never beyond capacity. The daily cap applies at collection; what does not fit stays stored.
4. **Names.** The `names` table gains a `tag` (5 digits, unique per account, assigned at first need). Existing names
   keep their text and get a tag; uniqueness moves to `name#tag`. The character screen replaces the first-login name
   prompt. Appearance (3 palette choices: skin, hair, shirt) is stored server-side and sent in presence so others see it.
5. **Builder in phase A.** Logic is a slot counter (`builders: 1`, busy until `ends_at`). Visually a Builder NPC stands
   at the construction with a hammer animation while busy, and idles by the Town Hall otherwise. Buying more builders
   is phase B.
6. **Worlds.** Keep the islands behaviour: one `public` world for all, one position per player in the world they are
   in, presence/chat per world, guests may use the portal to the public area. The owner can be away while guests visit.
7. **Ids and seeds.** `HL-<n>` is a counter assigned at first Homeland request. The seed is stored with the Homeland
   row along with a `gen` version, so future generator changes do not move existing worlds. No reroll.
8. **Cut order in phase A** if time runs out, last cut first: (1) Restoran, (2) Tambang, (3) customisation choices
   (keep default look), (4) the fall animation becomes a simple fade-in. Never cut: Town Hall, chunk opening, Kolam
   Ikan, Builder timer, portal, selling.

## 10. Left to the builder
- Exact cost/time/rate numbers (in `economy/config.json`, aimed at: first chunk and Kolam Ikan done in ~1 minute,
  Town Hall 2 in ~10 minutes of play).
- Storage tables, API shape (`/api/act` kinds such as `build`, `collect`, `open_chunk`, `th_upgrade`; `/api/homeland`
  state), how the islands branch's broker code is removed.
- Art for the Town Hall, buildings, portal and fall animation, drawn in code like `client/js/buildings.js`.
