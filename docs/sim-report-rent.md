# Simulator report: dynamic shop rent (2026-11-15)

Runs of `runSim` (`server/src/game/sim.ts`, real game code on a mock chain) for 30 game days with the live config,
rent on. Seeds 1, 7, 42; 10 and 25 players. Rent owed per shop per day = `rentBase` + ramp + `rentSalesPct`% of the
day's sales + storage (0.5 per unit over target); paid to the town treasury; a shop that cannot pay closes.

## What the simulator does and does not exercise

- Closing: yes, real settlement closes shops when cash < due.
- Reopening: yes. After each settlement the bots pledge coin and goods to the restore board (`restore_contribute`),
  half of them each time, so `reopened` events are real chain restores. With 10 players the bots usually cannot fund a
  restore (Joko stayed closed 14-21 days in most runs); with 25 they reopen a shop in 1-2 days. Real players are not
  bots, so this is a rough guide only.
- The townsfolk and their meals are the real `Residents` code (ledger rows `resident_eat`, `resident_burn`).

## Table (30 game days; days closed counted at noon, per shop)

| Rent config | Seed, players | Closings | Reopenings | Days closed (budi / joko) | All four closed | Residents (eat / burn rows) | Money max / cap | Prices in [0.25, 4] x base |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A: base 15, 8% (final) | 1, 10 | 3 | 2 | 3 / 12 | never | 185 / 90 | 24.6k / 50k | yes |
| A | 42, 10 | 2 | 1 | 0 / 14 | never | 234 / 95 | 33.8k / 50k | yes |
| A | 7, 10 | 1 | 0 | 0 / 20 | never | 209 / 113 | 45.3k / 50k | yes |
| A | 1, 25 | 12 | 10 | 5 / 5 | never | 269 / 71 | 45.4k / 75k | yes |
| A | 42, 25 | 10 | 8 | 4 / 7 | never | 293 / 88 | 46.7k / 75k | yes |
| A | 7, 25 | 9 | 8 | 6 / 6 | never | 283 / 97 | 47.0k / 75k | yes |
| first config: base 15, 12% | 1, 10 | 3 | 2 | 1 / 17 | never | 155 / 55 | 24.4k / 50k | yes |
| first config | 42, 10 | 1 | 0 | 0 / 21 | never | 161 / 97 | 35.5k / 50k | yes |
| first config | 7, 10 | 1 | 0 | 0 / 20 | never | 225 / 108 | 43.0k / 50k | yes |
| first config | 1, 25 | 12 | 11 | 9 / 7 | never | 277 / 67 | 44.8k / 75k | yes |
| first config | 42, 25 | 11 | 9 | 10 / 10 | never | 276 / 59 | 45.2k / 75k | yes |
| first config | 7, 25 | 12 | 11 | 5 / 8 | never | 273 / 58 | 45.0k / 75k | yes |
| B: base 10, 6% | 1, 10 | 1 | 0 | 0 / 21 | never | 100 / 63 | 25.5k / 50k | yes |
| B | 42, 10 | 2 | 1 | 2 / 9 | never | 246 / 132 | 33.2k / 50k | yes |
| B | 7, 10 | 1 | 1 | 0 / 1 | never | 110 / 57 | 25.1k / 50k | yes |
| B | 1, 25 | 6 | 4 | 10 / 12 | never | 274 / 62 | 48.3k / 75k | yes |
| B | 42, 25 | 12 | 11 | 6 / 5 | never | 285 / 83 | 46.0k / 75k | yes |
| B | 7, 25 | 6 | 5 | 13 / 3 | never | 290 / 119 | 53.1k / 75k | yes |

Sari and Wati never closed in any run. Rent paid per shop per day (min / median / max, config A, 25 players, seed 1):
Budi 60 / 158 / 360, Joko 4 / 150 / 256, Sari 75 / 264 / 419, Wati 62 / 183 / 233. The storage fee is most of the rent,
so the tunable base and sales share move little; 12% to 8% cut the time Budi and Joko spent closed (about 16 to 10
shop-days per run at 25 players) without removing the closings. Only Joko and Budi ever close (their cash stays near 0
to 350); Sari and Wati end the month with 5k to 18k coin, so the ramp (max 60) would never close them. The ramp is
rarely above 0 at 25 players because a closing every few days resets it.

## Conclusions

- Target met at 25 players: every run closes and reopens shops (8 to 10 reopenings), a closing lasts about a day on
  average, no shop stays closed, never all four at once, the townsfolk keep eating (270+ meals in 30 days) and burning
  wood, money stays under the cap, prices stay in bounds.
- At 10 players Joko closes around day 9-10 and the bots rarely fund the restore, so he stays closed to the end. That
  is the bots' limit (they pledge little), not the rent: with rent off Joko's cash also drains to near 0 there. The
  rent settings were not tuned against this.
- Churn is high at 25 players (about one closing per 3 days across the town). If that feels like too many closed
  shops, lower `rentSalesPct` further; for more closings, raise `rentBase`.

## Two findings outside the rent numbers

- Bug fixed: rent was `min(due, cash through the settled day)`, but trades of the next day were already in the ledger,
  so a poor shop could end below zero on the ledger (Joko -17) and settlement stalled for ever ("owes 17 coin but holds
  0 on chain"). The rent is now also capped by the shop's current balance (`settlement.ts` `prepare`).
- Not fixed: several runs stall in settlement with "coin faucet exceeded: 162 > 153 allowed today" (the townsfolk's
  `handout_mint` is sized by `faucetLeft`, which counts k from the ledger's active players, while the chain's allowance
  uses the settled day's `active` count and the live supply). It also happens with rent off, so it is not caused by rent.
