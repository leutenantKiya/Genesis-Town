# The world: one seeded village, shared by every player

Status: built 2026-11-02 (M3). Code: [`client/js/world/village.js`](../client/js/world/village.js) (the generator, run
by both the browser and the server), [`client/js/buildings.js`](../client/js/buildings.js) (public buildings and the
bridge, drawn in code), [`server/src/game/worldmap.ts`](../server/src/game/worldmap.ts) (the server's copy of the map),
[`contracts/game/src/projects.rs`](../contracts/game/src/projects.rs) (town projects on chain).

## One seed, one world

The server has one world seed (`WORLD_SEED`, default `20261114`) and sends it to every client in `/api/config`. The
generator is deterministic, so every player sees the same village, and the server knows what is on every tile.
A different seed gives a different village; a new seed means a new world (for example a fresh town per season).
Offline mode (`?mode=offline`) still makes a random local town.

## Layout: 3 × 3 chunks of 32 × 32 tiles

| | west | middle | east |
| --- | --- | --- | --- |
| north | Bukit Barat Laut (closed) | **Hutan Utara**: forest, the mine | Hutan Timur (closed) |
| middle | **Ladang Barat**: your house and farm, a pond | **Desa Genesis**: the village core | Dusun Seberang (closed, opened by the bridge project) |
| south | Rawa Selatan (closed) | Padang Selatan (closed) | Danau Tenggara (closed) |

A river runs north to south between the core and Dusun Seberang. It is the border: the water and its west bank belong
to the village, the east bank to the hamlet. Closed chunks are generated and drawn under fog, so players can see what
is there, but nobody can walk or gather in them.

## How a village is generated

1. **River**: a meandering band of water near the core's east edge.
2. **Roads**: Manhattan polylines between jittered waypoints: the main road along the plaza's south side (crossing the
   river where the bridge will be), a north road into the forest, a south road, a loop of lanes around the plaza, and
   short side lanes.
3. **Landmarks**, most important first, each on the best free lot whose door is at most 4 tiles above a road:
   Balai Desa (5×4), Gereja Desa (5×5), Kantor Makelar, Kantor Pos, Puskesmas, Warung Kopi (4×3 each). Lots are scored
   by distance to the plaza (the church prefers to stand a little north of it).
4. **Your house and farm** in Ladang Barat near the main road (the farm is a fenced field with 5×3 plots and a walking row), then houses
   in the core, the fields, the hamlet and a forest hut.
5. **Market**: the plaza with the four stalls (Sari, Budi, Wati, Joko).
6. **Nature** from value noise per chunk biome: forest, village trees and flowers, fields, meadows, a lake; the mine
   clearing with rocks at the end of the north road; a pond with a sandy shore; sandy fishing spots along the river.
7. **Validation**: from the spawn, every open door, every stall (both sides), the farm gate, and at least 12 water,
   8 rock and 30 tree gathering spots must be reachable. Otherwise the next attempt is tried (seeded, so still
   deterministic). Each layout takes about 20–60 ms.

The attempt is always chosen with every project area closed and reused when areas open, so opening an area only adds
the bridge and lifts the fog; nothing already built moves.

## What the server checks

`Game.act` with `gather` now requires that the tile at `(x, y)` really is that kind (water, rock or tree) and lies in
an open chunk, and the player must stand on a walkable tile right next to it. Every action carries the player's
position, and moves between reports must fit the walking speed (see the threat model).

## Town projects: growing the world

When a village needs more room, the town builds its way there. The first project is the bridge:

- **Jembatan ke Dusun Seberang**: 60 Kayu, 20 Bijih, 300 Koin (`economy/config.json` → `projects`; created on chain
  with `create_project`).
- Players pledge at the project board in the Balai Desa (`project_contribute`, signed with the session key and relayed
  gas-free). Pledges sit in the contract and can be withdrawn (`project_withdraw`) until the project is complete.
- When every line is met, the contract burns the pledged goods and coin (they were used to build it) and marks the
  project done; contributors stay on the project as its plaque.
- The server sees `done` (after the relay, and at startup), opens the chunk on its map (`world.unlocked`, persisted),
  and every client follows within one poll: the bridge appears, the fog lifts, and a toast says the area is open.

Why it fits the economy: growth costs real goods, which creates demand for wood and ore exactly when more players
arrive, and the burn is a sink for coin and goods. New areas spread new players over fresh gathering spots.

Later (not built): more projects for the other chunks, a rule that offers the next project when the open house lots
are mostly taken, and true chunk streaming for a world without fixed edges.

## Homeland

Status: phases A, B and C built and merged into `main` (A 2026-11-08, B and C 2026-11-09). Code:
[`client/js/world/homeland.js`](../client/js/world/homeland.js) (generator),
[`server/src/game/homeland.ts`](../server/src/game/homeland.ts) (state, timers, production),
[`client/js/mods/homeland.js`](../client/js/mods/homeland.js) (UI) and `client/js/mods/charscreen.js` (character screen).
Design: [the Homeland spec](superpowers/specs/2026-11-08-homeland-design.md). It replaces the broker-sold Private
Islands; Homelands are off-chain, not NFTs, and cannot be sold.

### Public area vs Homeland

| | Public area (the village above) | Homeland |
| --- | --- | --- |
| Purpose | trading only: merchants, the Pasar, other players | gathering, farming, building, producing |
| Gathering, farming, monsters | none | yes, in your own world (monsters: open forest and rock chunks at night, never the centre) |
| People | everyone, live | the owner and invited guests, live |
| World id | `public` | `HL-<n>` (one per player, a counter assigned at the first Homeland request) |

### Islands (generator 3, 2026-11-11)

Each chunk is a floating island. The eight outer chunks keep a two-tile ring of `void` (sky, solid for walking) with
rounded, ragged corners; the centre keeps its square but loses its free corners (never its trees, rocks, paths, fence,
lots or buildings). Where two orthogonal chunks meet, the gap is crossed on the cross path (local rows or columns 7 and
8) by `bridge` tiles, laid only when both chunks are open; the layout check counts every possible bridge as walkable, so
every lot is reachable once everything is open. The 3D view hangs a stepped block of earth and stone under every bit of
land (deepest furthest from an edge), pours water over edges as waterfalls and floats clouds below.

### Generator

`homeland.js` makes one 3 x 3 chunk map (16 x 16 tiles each, 48 x 48 in all) from the player's seed (stored with the
Homeland row, with a `gen` version so later generator changes do not move existing worlds). The Town Hall stands in the
middle chunk with a farm plot, a few trees and rocks, and the portal. Each of the eight outer chunks gets a biome
(forest, rock, pond or shore); every seed has a forest and water next to the centre. Building lots are fixed per chunk. Generator version 2 (`GTHomeland.VERSION`) adds one `rumah` lot in every chunk (including the centre) and a `rumahsakit` lot in the centre; existing rows keep working. Generator 3 (new Homelands from 2026-11-11, `prog.gen`) adds the player's own house (`kind: 'house', own: true`, 3 x 3) west of the Town Hall, where the centre `rumah` lot was; that lot moves four rows down, its door opening through a gap in the farm's top fence. Worlds made before (gen 2) were given the house as well (owner's choice, 2026-11-11); a built centre Rumah Pekerja moves with its lot.
Every world (any `gen`, 2026-11-12) also has the land's work buildings, after Kingshot's resource buildings: a `penggergajian` (sawmill) lot north-east of the cross in the first forest chunk, a `kincir` (windmill) lot north-east of the cross in the first meadow chunk (else the first pond, rock or other forest chunk, never the sea), and a `gudang` (storehouse) lot south-west of the cross in the first dry chunk next to the centre, with a path to the cross. Over 4000 seeds these lots change no layout attempt and no tile outside the lots, their one-tile margin and their paths, so nothing a player built moves.
The browser and the server run the same file, so the server checks positions and gather tiles (`HomelandMap` in
`worldmap.ts`). Locked chunks are drawn under fog.

### Town Hall, chunks and costs

All numbers are in `economy/config.json` -> `homeland`.
- Town Hall levels 1-5. Each upgrade costs wood, ore and coin and a timer (level 2: 30 wood, 5 ore, 50 coin, 120 s;
  level 5: 200 wood, 100 ore, 900 coin, 30 min). Each level raises how many chunks may be open and which buildings exist.
- Chunks open one at a time, each needing a minimum Town Hall level, items, coin and time, rising with each chunk (the
  first: Town Hall 1, 10 wood, 30 s). The player picks which adjacent locked chunk to open.

### Buildings and the builder

| Building | Town Hall | Produces |
| --- | --- | --- |
| Kolam Ikan | 1 | fish, 2 per game hour, stores 6 |
| Tambang | 2, on a rock chunk | ore, 2 per game hour, stores 8 |
| Restoran | 3 | nothing by itself: it keeps a pantry and feeds contractors (see below) |
| Rumah Pekerja | 1 | beds and entertainment for worker bots (see below) |
| Rumah Sakit | 2 | heals collapsed contractors (see below) |
| Penggergajian (Sawmill) | 2, on its forest chunk (open) | wood, 2 per game hour, stores 8 |
| Kincir Angin (Windmill) | 3, on its chunk (open) | wheat, 3 per game hour, stores 12 |
| Gudang (Storehouse) | 3, next to the centre (open) | nothing by itself: every producing building stores 50% / 100% / 150% more by level (see below) |

Buildings go on fixed lots. There is one default **Builder** (`builders: 1`, the Tukang who lives in the Town Hall); each hired Tukang adds one more. A contractor takes one job at a time (Town Hall, chunk, building, furniture or upgrade) and is shown at the construction with a hammer while busy. The server stores `ends_at` for the job and
finishes it when the clock passes it; the client only draws it. Production is lazy: when you collect, the server works
out what accrued since the last collection, capped by the building's capacity, writes ledger rows like a gather and
counts it against `caps.dailyGainPerItem`. What does not fit under the daily cap stays stored.

### Worker bots

Hired at the Town Hall (the `hire` action, owner, in their own Homeland). The coin price goes to the town treasury. Each
job has a maximum and a Town Hall level (`homeland.bots`):

| Bot | Price | Max | Town Hall | Effect per bot |
| --- | --- | --- | --- | --- |
| Tukang | 150 | 3 | 1 | one more builder: another job can run at the same time |
| Petani | 120 | 2 | 2 | Homeland crops grow 1.5x faster (`ceil(growDays / 1.5^n)`, minimum 1 day) |
| Nelayan | 120 | 2 | 2 | Kolam Ikan makes 1.5x more per game hour |
| Penebang | 120 | 2 | 2 | +1 wood for every tree gathered in the owner's Homeland |

Bots only exist in their owner's Homeland: they walk near their workplace with the job name overhead, never hold items or
coin, and no API lets them trade. Hiring past the maximum, below the Town Hall level, without the coin or outside your own
Homeland answers 409. Effects are applied by the server when it computes timers and gains, so they stay under
`caps.dailyGainPerItem`.

### Contractors and the Restoran

Contractors are the default Tukang (slot 0) and every hired Tukang. Each has **fatigue** 0-100 (`homeland.fatigue`):
- a job picks the free, healthy contractor with the lowest fatigue; its duration is `secs x (1 + slowdownAt100 x fatigue/100) / motivationFactor`
  (`slowdownAt100` 1.0, so a 100% tired contractor takes twice as long);
- when a job ends, fatigue grows by `perJobMinute` (10) per job minute, capped at 100; idle contractors recover
  `idleRecoverPerGameHour` (5) per game hour;
- at `collapseAt` (100) the contractor collapses: the job in progress finishes, then it is sick (no new jobs) until healed.

The **Restoran** (Town Hall 3; 40 wood, 10 ore, 60 coin, 240 s) holds a **pantry** of up to `pantryMax` 20 portions
(`homeland.restoran`). `cook` turns the `meal` recipe's inputs into pantry meals (not the Tas); `stock` moves bread or meal
from the Tas into the pantry; nothing is ever taken from the Tas except by those two acts. Every `serveEveryGameHours` (1) the
Restoran serves one portion to the most tired contractor at or above `serveMinFatigue` (20): pantry -1, fatigue -`serveRelief`
(30). An empty pantry serves nothing. The **Koki** (rare, 350 coin, max 1, Town Hall 3) divides the serving interval by
`chefServeFactor` (2). The **Pemburu** (rare, 400 coin, max 1, Town Hall 3) forages fish and wood alternately, 1 per game
hour, capacity 6, doubled in `dingin`; the `forage` act collects at the Balai Kota. All of this is computed lazily from
timestamps (replay of at most 72 game hours), so a server restart changes nothing.

### Bot houses and motivation

Every hired bot needs a free bed (the default Tukang does not). A **Rumah Pekerja** (Town Hall 1; 15 wood, 60 s) starts with
1 bed; **Kasur** has 4 levels (+1 bed each, so at most 5 bots per house): 10 wood / 30 s, then 20 wood + 20 coin, 30 wood +
40 coin, 40 wood + 80 coin. **Hiburan** has 3 levels, Radio, TV, Gamelan (10 wood + 30 coin; 20 wood, 10 ore, 80 coin; 30 wood,
20 ore, 150 coin). Furniture upgrades are ordinary builder jobs (`build` kind `furniture`, target `<lot>:kasur|hiburan`), so
they cost resources and tire the contractor. Hiring with no free bed answers 409 `Tidak ada kasur kosong` and charges nothing.
Each bot lives in the house with a free bed and the best entertainment. Motivation = `min(100, 40 + 20 x hiburanLevel)`
(default Tukang 60); `motivationFactor = 0.75 + 0.5 x motivation/100` speeds contractors and strengthens producer bots
(Nelayan, Petani, Pemburu).

### Rumah Sakit

Town Hall 2; 30 wood, 10 ore, 60 coin, 180 s; 3 levels (upgrades 30 wood, 15 ore, 100 coin, 240 s and 50 wood, 30 ore,
200 coin, 480 s). A collapsed contractor is healed after `healGameHours` 3 / 2 / 1 by level, or after
`sickGameHoursWithoutHospital` (24) without one; fatigue then resets to 0. Another free contractor can take jobs meanwhile.

### Gudang

Town Hall 3; 50 wood, 20 ore, 100 coin, 300 s; 3 levels (upgrades 80 wood, 40 ore, 200 coin, 600 s and 120 wood, 60 ore,
400 coin, 1200 s), the same `upgrade` job as the Rumah Sakit. Every producing building (Kolam Ikan, Tambang,
Penggergajian, Kincir Angin) holds `capacity x (1 + storeBonus)` before it stops: 1.5x, 2x, 2.5x. It raises what you can
leave uncollected, not the rate, and collecting still counts against `caps.dailyGainPerItem`. The Town Hall window says
what its next level opens, by name ("Level 3 unlocks: Restaurant, Windmill, Storehouse").

### Cosmetics

At the Balai Kota the `dress` act buys a cosmetic for a bot you own (the default Tukang too); the coin goes to the town and
the cosmetic is drawn on the bot. With boost `b`: a contractor's fatigue gain x `(1 - b)`; producer bots' effect and Pemburu rate x
`(1 + b)`; Koki serving speed x `(1 + b)`.

| Cosmetic | Price | Boost |
| --- | --- | --- |
| Caping | 80 | 0.2 |
| Syal | 150 | 0.35 |
| Mahkota | 300 | 0.5 |

### Portal and travel

Every Homeland has a portal to the public area, and the public area has one back to the player's own Homeland. The
`travel` action moves you; the server tracks which world each player is in and changes it only that way. A world you
may not enter answers 409.

### Guests

The owner keeps an invite list (up to 20 players), typed as `name#tag`; it is stored as account ids, off chain.
Guests find the Homeland under "invited" in the Homeland menu, can walk around and chat, and cannot gather, farm or
build.

### Seeing each other

Players in the same world see each other with `name#tag`, their look (skin, hair, shirt) and chat bubbles (key C,
80 characters). The server keeps positions and the last 50 chat lines per world in memory; names are 3-16 characters
plus a 5-digit tag, unique as `name#tag`. Nothing of this is stored on chain.

### Public area: NPC merchants and Papan Juara

- **Merchants as NPC players.** Sari, Budi, Wati and Joko appear in public presence with the tag `NPC`, a fixed look and a
  place in front of their stall. Their player card has "Lihat dagangan" (their shop) and "Tanya" (prefills `/msg`). A
  private message to a merchant is answered privately by the merchant's AI (Claude by default when `ANTHROPIC_API_KEY` is
  set, else NEAR AI Cloud, else a local line); from a Homeland the merchant is not there and the server answers 409.
  Same limits as `/api/talk` (6 questions a minute, 200 characters). Model text is display-only.
- **Direct trade.** From another player's card, "Ajak dagang" offers up to 4 token lines each way (`coin` allowed). The
  receiver gets a toast and accepts or declines within 120 s. Both players must be in `public` and within 3 tiles.
- **Papan Juara.** A board on the plaza ranks the top 10 sellers by items sold, for today or all time, and shows your own
  rank. Counted: sales to merchants and items given in a direct trade that paid you coin.

## The public square (village generator 2, 2026-11-11)

`village.js` VERSION 2 rebuilds the core around a 17 x 12 market square (`L.plaza`) with a 3 x 3 `fountain` in the
middle (`L.fun.fountain`). The merchants' stalls stand two by two along the north side (seats behind them), so the
gap between the pairs stays open and the Papan Juara board (`landmarks`) stands east of the last stall; four players' lapak
stalls (`L.market.lapak`, decor) line the south side. `bench` tiles (walkable: a character standing still on one sits)
ring the fountain; lamps mark the corners. The church and the Puskesmas are no longer placed. Near the square, on free
ground in the core, the fields or the forest: a 7 x 2 `stage` with a 7 x 4 audience area and benches (`L.fun.stage`), a
`carousel` on a 3 x 3 base (`L.fun.carousel`), a lily pond (`water`, `lily`, a `mud` bank, reeds; `L.fun.pond`) and two
terrace tables with benches in front of the warung (`L.fun.terrace`). `fountain`, `stage`, `carousel`, `table` and
`lily` are solid on the server and in the client. The concert (19:00 to 01:00) is client-only: `mods/concert.js` plays
the music, `three/fun.js` draws the band and the lights.
