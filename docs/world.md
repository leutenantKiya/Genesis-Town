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

Status: phase A built on branch `homeland` (2026-11-08). Code:
[`client/js/world/homeland.js`](../client/js/world/homeland.js) (generator),
[`server/src/game/homeland.ts`](../server/src/game/homeland.ts) (state, timers, production),
[`client/js/mods/homeland.js`](../client/js/mods/homeland.js) (UI) and `client/js/mods/charscreen.js` (character screen).
Design: [the Homeland spec](superpowers/specs/2026-11-08-homeland-design.md). It replaces the broker-sold Private
Islands; Homelands are off-chain, not NFTs, and cannot be sold.

### Public area vs Homeland

| | Public area (the village above) | Homeland |
| --- | --- | --- |
| Purpose | trading only: merchants, the Pasar, other players | gathering, farming, building, producing |
| Gathering, farming, monsters | none | yes, in your own world |
| People | everyone, live | the owner and invited guests, live |
| World id | `public` | `HL-<n>` (one per player, a counter assigned at the first Homeland request) |

### Generator

`homeland.js` makes one 3 x 3 chunk map (16 x 16 tiles each, 48 x 48 in all) from the player's seed (stored with the
Homeland row, with a `gen` version so later generator changes do not move existing worlds). The Town Hall stands in the
middle chunk with a farm plot, a few trees and rocks, and the portal. Each of the eight outer chunks gets a biome
(forest, rock, pond or shore); every seed has a forest and water next to the centre. Building lots are fixed per chunk.
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
| Restoran | 3 | meal, 1 per game hour, stores 4 |

Buildings go on fixed lots. There is one **Builder** (`builders: 1`): it takes one job at a time (Town Hall, chunk or
building) and is shown at the construction with a hammer while busy. The server stores `ends_at` for the job and
finishes it when the clock passes it; the client only draws it. Production is lazy: when you collect, the server works
out what accrued since the last collection, capped by the building's capacity, writes ledger rows like a gather and
counts it against `caps.dailyGainPerItem`. What does not fit under the daily cap stays stored.

### Portal and travel

Every Homeland has a portal to the public area, and the public area has one back to the player's own Homeland. The
`travel` action moves you; the server tracks which world each player is in and changes it only that way. A world you
may not enter answers 409. Bots (Phase B) will stay in their Homeland.

### Guests

The owner keeps an invite list (up to 20 players), typed as `name#tag`; it is stored as account ids, off chain.
Guests find the Homeland under "invited" in the Homeland menu, can walk around and chat, and cannot gather, farm or
build.

### Seeing each other

Players in the same world see each other with `name#tag`, their look (skin, hair, shirt) and chat bubbles (key C,
80 characters). The server keeps positions and the last 50 chat lines per world in memory; names are 3-16 characters
plus a 5-digit tag, unique as `name#tag`. Nothing of this is stored on chain.
