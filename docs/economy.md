# Economy design

Status: design (M0), updated 2026-11-01: seasons, the farm plot, shop restoration bundles and the shipping box are
added, and gathering, crafting and merchant trades are now off-chain until one daily on-chain settlement
([onchain-offchain.md](onchain-offchain.md)). These are starting values. The M3 simulation (30 game days, 50 simulated players) tunes them, and
its report will be committed next to this file. Code that will implement each part:

| Part | Where it will live | Runs in |
| --- | --- | --- |
| Constants (items, recipes, fees, caps) | `economy/config.json` | server, simulator, and the contract's `init` arguments |
| Pricing rule | `economy/pricing.ts` (the only pricing code) | server (live quotes) and `economy/sim.ts` (fast-forward) |
| Invariants: settlement caps, fees, burns, rent, shares, faucet throttle | `contracts/game` (Rust), checked at each daily settlement and on every player-to-player action | NEAR testnet |
| Day-to-day state: gathering, farming, crafting, merchant trades, energy | server ledger (SQLite), published per day with a Merkle root | off-chain until 06:00 |

Prices are decided off-chain by `pricing.ts`, because they are a judgement call that should be readable and easy to
tune. Every rule that protects the money supply (caps, burns, fees, rent, the faucet throttle) is enforced by the
contract, so anyone can verify it on chain.

## 1. Items

One NEP-245 contract holds every token. Token ids are short ASCII strings.

| Token id | UI name | Kind | Source | Base value (coins) | Used for |
| --- | --- | --- | --- | --- | --- |
| `coin` | Koin | currency (fungible) | town demand (§3), the only coin source | 1 | everything |
| `fish` | Ikan | raw | pond nodes | 8 | Ikan Bakar, sell |
| `ore` | Bijih | raw | rock nodes (needs Alat) | 12 | Alat |
| `wood` | Kayu | raw | tree nodes (by hand) | 6 | Ikan Bakar, Alat, town firewood |
| `wheat` | Gandum | raw | farm plot: plant 1, harvest 3 after 1 real minute (cannot be planted in Dingin) | 5 | Roti, seed |
| `bread` | Roti | food | craft: 2 `wheat` | 16 | eat (+25 energy), town demand |
| `meal` | Ikan Bakar | food | craft: 1 `fish` + 1 `wood` | 20 | eat (+45 energy), town demand |
| `tool` | Alat | tool | craft: 2 `ore` + 1 `wood` | 45 | needed to mine ore. 20 uses, then it breaks (burned) |

Seven items plus `coin`, within the 6–10 limit. Wood is gathered by hand: in an early simulation, wood needing a tool
and tools needing wood deadlocked the economy once wood ran out (docs/sim-report-30d.md). Tool durability is tracked per stack in game state and only the
break (burn of 1 `tool`) goes on chain.

## 1b. Seasons

One season is 7 game days: Semi → Panas → Gugur → Dingin. That is one fast-forward week. Multipliers apply to node
yield (chance of +1 extra per gather) and to how many units the town buys per day:

| Season | Node yield | Town demand |
| --- | --- | --- |
| Semi | wheat grows, fish ×1.0, wood ×1.2 | bread ×1.2 |
| Panas | fish ×1.5, ore ×1.0 | meal ×1.2, firewood ×0.6 |
| Gugur | wood ×1.3, wheat harvest +1 | bread ×1.0, tool ×1.5 (repairs before winter) |
| Dingin | no wheat growth, fish ×0.6 | meal ×1.4, firewood ×1.8 |

Seasons move supply and demand in a predictable way, so prices drift across a week with no dev patch, and players
can plan. They are config values in `economy/config.json`, used by both live play and the simulator.

## 2. Actors

- **Players.** Each has their own NEAR testnet account and balances in the game contract.
- **Merchants (4).** Each has its own testnet account, balances in the game contract, a cash balance (`coin`),
  a share ledger, and a personality.

  | Merchant | Shop | Buys | Sells | Personality |
  | --- | --- | --- | --- | --- |
  | Sari | fish stall | fish, wood | fish, meal | fair: spread 20%, watches cash |
  | Budi | smithy | ore, wood | tool | fair: spread 20%, watches cash |
  | Wati | bakery | wheat | bread, wheat | greedy: spread 30%, slow to raise bids |
  | Joko | general store | wood, wheat, fish | wood, bread | generous: spread 12%, never bids under 90% of base, buys up to 3× target a day, ignores his cash; starts with 350 coin |

  Merchants also craft: Wati bakes bread from wheat she holds, Sari cooks meals, and Budi forges tools. Each merchant
  has a daily crafting capacity (default 10 crafts per day), and crafting uses the same recipes as players. Merchants pay a 2-coin fee per craft
  (`craft.merchantFee`); players pay energy for food (Roti 5, Ikan Bakar 8) and coin for tools (Alat 3).
- **Town (townsfolk).** These are not individual accounts. The `town` account buys finished goods from open merchants
  every game hour, which is the demand side of the economy (§3).
- **Town treasury.** The `town` account also holds a fixed pre-minted coin stock. It pays starter kits and starts out
  owning each merchant's initial shares.

## 3. Sources and sinks

### Sources (things enter the game)

| Source | What | Bound |
| --- | --- | --- |
| Gathering | raw items, minted by the server's `minter` key | node charges (4 per node, 2-hour respawn), per-account rate limit on the server, per-account and per-item daily mint cap in the contract |
| Crafting | output item, minted by the contract itself when inputs are burned | inputs are burned first, so crafting never creates value from nothing |
| **Town demand** | **new `coin` paid to a merchant when the town buys a finished good** | **the only coin faucet. Daily cap in the contract, throttled by the total coin supply (see below)** |
| Starter kit | 100 coins + 1 Alat + 3 Roti + 3 Gandum (seed) per new player | comes from the treasury's existing coins (a transfer, not a mint). When the treasury runs low, new players get items only |

### Sinks (things leave the game)

| Sink | What is burned | Amount |
| --- | --- | --- |
| Shop rent | merchant `coin` | R = 40 per merchant per game day, while the shop is open |
| Storage (gudang) fee | merchant `coin` | 0.5 per unit held above target stock per day, paid with the rent |
| Crafting cost | simple recipes (bread, meal) cost the player energy (5 / 8); complex ones (tool) cost 3 `coin`; merchants pay a flat 2 `coin` per craft | see `recipes` and `craft` in config |
| Player-market fee | seller `coin` | 5% of each player-market sale |
| Shipping box | items sold to the town at 70% of base price | counted inside the town faucet `W_day` (it is town demand, at a worse price) |
| Food | `bread`, `meal` | eaten by players, and bought (then burned) by the town |
| Firewood | `wood` | bought (then burned) by the town |
| Tool wear | `tool` | 1 tool burned every 20 uses |
| Crafting inputs | raw items | burned on every craft |
| Worker bots | player `coin` | 120-150 coin per hire, paid to the town treasury (a transfer to the town, not a burn) |
| Rare bots, furniture, hospital, cosmetics | player `coin` and raw items | Pemburu 400 and Koki 350 coin; Kasur, Hiburan, Rumah Pekerja, Rumah Sakit, Penggergajian, Kincir Angin and Gudang builds and upgrades cost wood, ore and coin; cosmetics 80-300 coin. Coin goes to the town treasury, items are burned |
| Restoran | `fish`, `wood` (cook), `bread`, `meal` (stock) | the pantry consumes them to feed contractors; no new item tokens, the Restoran makes no meals by itself |

### The faucet throttle (why money supply stays bounded)

Town demand per game day at base prices is about 1,035 coins: 30 Roti, 15 Ikan Bakar, 3 Alat and 20 Kayu. The town
only buys when a merchant's ask is at most 1.5 × base. The coin it pays is newly minted, but the contract limits it:

```
W_day      = W0 · k · (1 − M / Mcap)           # max new coins the town may pay today
k          = min(6, 1 + A / 10)                # A = accounts active today (counted on chain)
Mcap       = Mcap0 · k
W0 = 1,200 coins/day      Mcap0 = 25,000 coins
M  = total coin supply (the contract's own supply counter for `coin`)
```

Every other coin movement is either a transfer or a burn, so `M` can never exceed `max(M_start, Mcap)`. The fixed
sinks pull the actual level below the cap.

**Expected equilibrium.** Money stops growing when faucet = sinks. That is when W0·k·(1 − M/Mcap) = S, so
**M\* = Mcap · (1 − S / (W0·k))**.

Worked example with 10 active players: k = 2, so the faucet ceiling is 2,400 coins/day and Mcap = 50,000. The daily
sinks add up to about S = 370 coins: rent 4 × 40 = 160, crafting fees about 160 (10 players × 8 crafts × 2), and
market fees about 50. That gives M\* ≈ 50,000 × (1 − 370/2,400) ≈ **42,300 coins**, about 4,200 per active player.
With fewer players, k and Mcap shrink with them.

Prices cannot run to 0 or infinity either: every price stays between 0.25 × base and 4 × base (§4).

## 4. Pricing rule (`economy/pricing.ts`)

Evaluated for each (merchant, item) once per game hour (one tick), and again for every quote.

Inputs:
- `base`: the item's base value.
- `s`: the merchant's stock, and `T`: its target stock.
- `B` and `S`: units the merchant bought and sold recently, as exponentially decayed counts with a 24-tick half-life.
- `C`: the merchant's cash, and `R`: rent.
- Personality: `spread`, elasticity `e`, cash sensitivity `c`.

```
stockFactor  fs = clamp((T / max(s, 1)) ^ e,              0.5, 2.5)     e = 0.5 (generous 0.3)
demandFactor fd = clamp(1 + 0.4 · (S − B) / (S + B + 5),   0.7, 1.4)
target       mid* = base · fs · fd
bounded      mid  = clamp(mid*, 0.9 · mid_prev, 1.1 · mid_prev)          # at most ±10% per tick
absolute     mid  = clamp(mid, 0.25 · base, 4 · base)
cashFactor   fc = clamp((C / (10 · R)) ^ (0.5 · c), 0.3, 1)               # a merchant short on cash bids less
ask = ceil(mid · (1 + spread/2))        bid = max(1, floor(mid · (1 − spread/2) · fc))
```

A quote for `q` units evaluates `fs` at `s ± q/2`, so a big lot gets a worse average price on that trade only. One
quote covers at most 10 units. Each merchant also has a daily buy cap per item of 2 × T.

**Reason text.** Every tick records which factor moved the price most, and turns it into one short sentence for the
tooltip. For example:
- `fs` dominant, falling: *"Stok ikan saya 50, targetnya 20. Harga turun 10%."*
- `fd` dominant, rising: *"Banyak yang beli roti hari ini. Harga naik 7%."*
- the tick clamp was hit: *"…(dibatasi 10% per jam)."*
- `fc` < 1: *"Kas saya tipis, jadi saya hanya bisa menawar rendah."*

### Worked example: a player floods Sari with fish

Sari's fish: base 8, target 20, price 8, cash 600 (so fc = 1). A player sells her 30 fish. Her stock goes 20 → 50,
recent buys B ≈ 30, recent sales S ≈ 4.

- fs = √(20/50) = 0.63, fd = 1 + 0.4 · (4 − 30)/39 = 0.73, so the target price = 8 × 0.63 × 0.73 = **3.71**.
- The ±10% clamp spreads the fall over game hours: 8.00 → 7.20 → 6.48 → 5.83 → 5.25 → 4.72 → 4.25 → 3.83 → 3.71.
- With a 20% spread, Sari's ask/bid go from 9/7 to 8/6 after one tick and 8/5 after two.
- Tooltip: *"Stok ikan saya 50 (target 20) dan banyak yang jual ke saya. Harga turun 10% (dibatasi 10% per jam)."*
- As she sells meals to the town and the buy volume decays, fs and fd rise and the price recovers. Nobody had to
  patch anything.

## 5. Bankruptcy and investment

**Daily settlement** runs at 06:00 game time. It is one contract call per game day by the server; it is idempotent
and keyed by day number.
1. Each open merchant pays rent R = 40, which is burned. A merchant with cash `C < R` cannot pay and **closes**: no
   quotes, the town skips it, and rent is no longer charged. The shop door shows TUTUP.
2. Each merchant's profit for the day is computed in the contract from its own coin flows:
   `P = sales income − purchase spend − rent − crafting fees`. If P > 0, 40% of P is paid out as dividends to
   shareholders, pro rata. Payouts accrue to each shareholder's claimable balance, which they collect with
   `claim_dividends`. The rest stays in the merchant's cash.

**Shares.** Each merchant starts with 1,000 shares owned by the town treasury. When a player invests `x` coins:

```
book        = C + Σ (stock_i · bid_i)              # cash plus inventory at its own bids
sharePrice  = max(0.05, book / totalShares)
newShares   = x / sharePrice
```

The coins go into the merchant's cash. A closed shop has a low book value, so rescuing it is cheap and buys a large
stake. That makes rescue rational, not charity.

**Restoration board (reopening).** A closed shop posts a board listing the coins and goods it needs:

| Shop | Coins | Goods |
| --- | --- | --- |
| Sari (fish) | 200 | 6 Ikan, 4 Kayu |
| Budi (smithy) | 200 | 10 Bijih, 5 Kayu |
| Wati (bakery) | 200 | 12 Gandum |
| Joko (general) | 200 | 6 Kayu, 6 Gandum |

Contributions are on-chain pledges held in the contract. Item contributions are valued at base price for shares.
When every line is met, the pledges turn into shares at the share price fixed when the shop closed, the goods join
the shop's stock, and the shop reopens. A pledge withdrawn before completion is returned.

**Shop health in the UI.** Shown on the notice board, the shop dialog and Profile: cash, days of rent covered (C / R),
7-day profit, status, and your share percentage.

**Expected first bankruptcy (confirmed by the simulator).** Joko is generous: he never bids under 90% of base value,
buys up to 3× his target stock a day, and ignores his own cash. His general store buys fish, wood and wheat but resells
only wood and bread, so stock piles up and the storage fees eat his cash. In the 7-day, 25-player simulation he closes
on day 4 and players restore him on day 6; see [sim-report-30d.md](sim-report-30d.md) for the 30-day run. Fair and
greedy merchants lower their bids when cash is short, so they protect themselves.

## 6. Player market

Built in M3: contract v3 (`contracts/game/src/market.rs`), on chain right away and relayed gas-free.

- **List.** Escrow 1–50 units of one item (not coin) at your chosen price (1–100,000 coin each). Max 5 open listings
  per account. Only items already on chain and not spent by today's off-chain play can be listed (server spend guard).
- **Buy.** Coins go to the seller minus the 5% fee (burned, lowering coin supply). Items go to the buyer. The buyer
  names a `max_price_each`, so a listing can't be repriced under them. Buyer and seller must differ.
- **Cancel.** Returns the escrowed items.

Player-market trades do **not** feed merchant demand counts (B, S), so wash trading between your own accounts cannot
move merchant prices, and every wash trade burns 5%.

## 6b. Direct trade and merchants on the Player Market

- **Direct trade.** Two players swap items and `coin` face to face in the public area. It is a transfer only: nothing is
  minted or burned, no merchant counter (B, S) moves, and each receiver's gain counts against `caps.dailyGainPerItem`.
  Rows are off-chain and settle daily like merchant trades.
- **Merchants on the Player Market.** About every 30 s the server reads the open listings (`npcMarket` in
  `economy/config.json`). A merchant buys a listing of a good it trades when the price is at or below
  `floor(mid * maxPayMidMult * cashFactor)` (the mid price and cash factor of section 4), never more than 15% of its cash
  per buy or 35% per day, never past the daily buy cap it shares with player sales, a stock of 1.5 x target, 30 units a day
  or a reserve of 3 days' rent. The buy is the settler's `merchant_buy_listing`: the merchant's own coin moves to the
  seller (5% burned, as for any buyer), so no coin is created. The median listing price (median over sellers of each
  seller's median, at least 3 sellers, last 6 readings) moves each good's base value by at most 5% per game day within
  0.7x to 1.5x; when it stays at 2x or above or 0.5x or below the normal value, merchants stop offering that good until
  it recovers. One seller or a few listings by one account cannot move it.
- **Tool stall.** Ben's shop sells a new Pickaxe, Axe, Fishing Rod or Hoe and repairs worn ones for coin (`toolShop`);
  a repair costs by the wear, the coin goes to Ben like any sale to a merchant.

## 7. How the economy changes without a dev patch

- Prices come only from state: stock, recent flows and cash. When players change what they gather, prices change.
- Merchants close and reopen on their own, and the shareholders who saved them earn on their recovery, which in turn
  changes who has coins to spend.
- Town demand scales with how many players are active (k). The money cap scales with it, so a busier town has a
  bigger economy and an empty town shrinks back without anyone resetting it.
- All tuning constants live in `economy/config.json`, and the contract's copy is set at `init`. Changing them is a
  config change with an on-chain record, not a code patch. It is not needed for the economy to move.

## 8. Acceptance checks for M3 (from the brief)

The simulation must run 30 game days with 50 simulated players and show:
- the money supply stays bounded (below Mcap);
- no item price hits 0 or infinity (prices stay inside [0.25, 4] × base);
- at least one merchant goes bankrupt and then recovers through investment.

The report is committed to `docs/sim-report-30d.md`.
