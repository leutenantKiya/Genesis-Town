# Game loop

Genesis Town is a market-town life sim. The player gathers raw goods, crafts some of them, and sells to merchants whose
prices move with their stock and recent demand. The player's decisions are *what to gather, where to sell, when to
craft, and which failing shop to rescue*. Everything else in the town exists to make those decisions interesting.

Status: design (M0). Numbers below are starting values; the 30-day simulation in M3 tunes them. Exact economy rules
are in [economy.md](economy.md).

## Time

| Unit | Live play | Fast-forward (judge button) |
| --- | --- | --- |
| 1 game hour (= 1 pricing tick) | 60 real seconds | ~0.36 real seconds |
| 1 game day (24 ticks, settles rent and dividends at 06:00) | 24 real minutes | ~8.5 real seconds |
| 1 game week | 2.8 real hours | ~60 real seconds |

The prototype's clock and Dev panel time controls stay; they drive both modes.

## Every 30 seconds: gather, glance, decide

1. Walk to a gathering node (pond, ore rock, tree, or a wheat plot on your own land). Nodes show how many charges are
   left (4 per node, respawn after 2 game hours).
2. Press A. A 2-second action plays, then a toast: `+1 Ikan`. Ore and wood use 1 durability of your Alat (tool).
   Each gather costs 4 energy.
3. The bag counter updates at once. The item appears as "pending" (a small dot) until the server's next mint batch
   lands on chain (at most 30 s or 10 items later), then the dot disappears and a Riwayat entry gets its explorer link.
4. Hover or long-press any item in the bag: it shows the best current bid in town and which merchant pays it. This is
   the moment-to-moment decision: keep gathering this, or switch to what is scarce.

## Every 5 minutes: sell, craft, eat

1. **Sell.** Walk into a merchant's shop and talk to the keeper. The shop menu shows the merchant's bid and ask for
   each item, a ▲/▼ arrow for the last price move, and a tooltip with the merchant's reason, for example
   *"Stok ikan saya 50, targetnya 20, dan banyak yang jual ke saya. Harga turun 10%."* Selling is one tap; the coin
   balance updates when the trade confirms (~1–2 s on testnet). No wallet popup, no gas prompt.
2. **Craft.** At the workbench in your house: 2 Gandum → Roti, 1 Ikan + 1 Kayu → Ikan Bakar, 2 Bijih + 1 Kayu → Alat.
   Each craft costs a 2-coin fee (burned). Crafted goods sell for more than their inputs when the town is hungry,
   and for less when a merchant is overstocked.
3. **Eat.** Energy regenerates slowly (+2 per game hour, max 100). Roti restores 25, Ikan Bakar 45. A busy player eats
   one or two meals per game day, buying from a merchant or eating what they crafted.
4. **Check the board.** The town notice board (and the Profile screen) shows each shop's health: cash, days of rent
   covered, 7-day profit, and OPEN or TUTUP (closed).

## Every session (20–40 minutes, about 1–2 game days)

1. **Read the market.** Prices drift because of everyone's actions: other players, the merchants' own crafting, and
   the townsfolk who buy food, tools and firewood every day. A glut in one item pushes players toward another.
2. **Rescue or ignore a failing shop.** A merchant whose cash cannot cover the day's rent closes its shop: the door
   gets a TUTUP sign and the keeper explains why. Any player can invest coins. When pledges reach the reopen amount the
   shop reopens, and investors hold shares that pay a cut of the shop's future daily profit.
3. **Use the player market.** List goods for other players at your own price (escrowed in the contract), or buy
   listings cheaper than the merchants' asks.
4. **Collect.** Claim dividends from shops you hold shares in. Riwayat lists every on-chain action with explorer links.

## First-session walkthrough (what a judge sees)

1. Open the game and press **Masuk** (sign in). One Auth0 window: Google or email. This is the only popup in the game.
2. You spawn at your house with 100 coins, 1 Alat (durability 20), 3 Roti and full energy. A sign by the door gives
   the goal: *"Kumpulkan, jual, dan jaga pasar kota tetap hidup."* ("Gather, sell, and keep the town market alive.")
   Riwayat already shows the starter kit grant with an explorer link.
3. Walk to the pond (the minimap marks it) and press A four times: `+1 Ikan` ×4, the node empties and starts its
   respawn timer.
4. Walk to Sari's fish stall. Her bid for Ikan is shown with a tooltip. Sell 4 Ikan: coins go up, Sari's stock goes up,
   and next game hour her price ticks down a little, with the reason in the tooltip.
5. Chop wood (uses the Alat), cook Ikan Bakar at your workbench, and sell it to Sari for more than the raw fish.
6. The notice board shows Budi's smithy at 2 days of rent left and falling, because nobody needs tools this week.
   Next morning it reads TUTUP.
7. Talk to Budi. Invest 50 coins. Once total pledges reach the reopen amount (or straight away in the judge scenario,
   where the shortfall is small), the shop reopens and your shares appear in Profile.
8. Press **Simulate 1 week** (visible button, also in the Dev panel). Watch price charts per item, cash charts per
   merchant, and the town money supply move for 7 game days in about a minute. This runs off-chain, is labelled as a
   simulation, and uses the same pricing file as live play.

## What is deliberately not in the loop

Casino, combat, theft, police, curfew and gossip are switched off by default (code kept behind feature flags). They
pull attention away from the economy, and theft or gambling must never touch on-chain assets.
