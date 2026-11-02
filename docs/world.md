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
4. **Your house and farm** in Ladang Barat near the main road (the farm is a fenced 3×2 plot, as before), then houses
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
