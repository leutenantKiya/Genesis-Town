# Game loop

Genesis Town is a market-town life sim. The player gathers raw goods, crafts some of them, and sells to merchants whose
prices move with their stock and recent demand. The player's decisions are *what to gather, where to sell, when to
craft, and which failing shop to rescue*. Everything else in the town exists to make those decisions interesting.

Status: design (M0), updated 2026-11-01:
- Stardew-style seasons, energy days, an own farm plot and shop restoration bundles;
- a warmer art direction;
- fullscreen with a settings menu and rebindable keys;
- most actions are now **off-chain until a daily settlement** ([onchain-offchain.md](onchain-offchain.md)).

Numbers are starting values; the 30-day simulation in M3 tunes them. Economy rules: [economy.md](economy.md).
Everything is original: inspired by the genre, with no assets, names or maps taken from another game.

## Time

| Unit | Live play | Fast-forward (judge button) |
| --- | --- | --- |
| 1 game hour (= 1 pricing tick) | 60 real seconds | ~0.36 real seconds |
| 1 game day (24 ticks, settles rent and dividends at 06:00) | 24 real minutes | ~8.5 real seconds |
| 1 season (7 game days: Semi, Panas, Gugur, Dingin) | 2.8 real hours | ~60 real seconds |
| 1 game year (4 seasons, 28 days) | 11.2 real hours | ~4 real minutes |

The prototype's clock and Dev panel time controls stay; they drive both modes.

## Every 30 seconds: gather, glance, decide

1. Walk to a gathering node (pond, ore rock, tree, or a wheat plot on your own land). Nodes show how many charges are
   left (4 per node, respawn after 2 game hours).
2. Press Space (or the on-screen A button on touch screens). A 2-second action plays, then a toast: `+1 Ikan`. Ore uses 1 durability of your Alat (tool); wood is gathered by hand.
   Each gather costs 4 energy.
3. The bag counter updates at once. This is off-chain: the item shows a small clock icon ("today") until the 06:00
   daily settlement writes the day's net result on chain in one batch. See [onchain-offchain.md](onchain-offchain.md).
4. Hover or long-press any item in the bag: it shows the best current bid in town and which merchant pays it. This is
   the moment-to-moment decision: keep gathering this, or switch to what is scarce.

## Every 5 minutes: sell, craft, farm, eat

1. **Sell.** Walk into a merchant's shop and talk to the keeper. The shop menu shows the merchant's bid and ask for
   each item, a ▲/▼ arrow for the last price move, and a tooltip with the merchant's reason, for example
   *"Stok ikan saya 50, targetnya 20, dan banyak yang jual ke saya. Harga turun 10%."* Selling is one tap; the coin
   balance updates when the trade confirms (~1–2 s on testnet). No wallet popup, no gas prompt.
2. **Craft.** At the workbench in your house: 2 Gandum → Roti, 1 Ikan + 1 Kayu → Ikan Bakar, 2 Bijih + 1 Kayu → Alat.
   Each craft costs a 2-coin fee (burned). Crafted goods sell for more than their inputs when the town is hungry,
   and for less when a merchant is overstocked.
3. **Farm.** Your house has a small plot (6 tiles). Till a tile, plant 1 Gandum as seed, and water it once a game
   day. After 3 game days it can be harvested for 3 Gandum; a day without water adds a day. Wheat grows in Semi,
   Panas and Gugur, not in Dingin.
4. **Ship.** Anything put in the **Kotak Kirim** (shipping box) by your door is sold to the town at 06:00, at 70% of
   base price. It is convenient but pays less than walking to a merchant.
5. **Eat.** Energy regenerates slowly (+2 per game hour, max 100). Roti restores 25, Ikan Bakar 45. A busy player eats
   one or two meals per game day, buying from a merchant or eating what they crafted.
6. **Check the board.** The town notice board (and the Profile screen) shows each shop's health: cash, days of rent
   covered, 7-day profit, and OPEN or TUTUP (closed).

## Every session (20–40 minutes, about 1–2 game days)

0. **Plan around the season.** Each season changes what the land gives and what the town wants. Fish are plentiful
   in Panas, wheat stops growing in Dingin, and the town burns more firewood and eats more cooked meals in Dingin.
   Prices drift with the season, and the bulletin board says what's coming.

1. **Read the market.** Prices drift because of everyone's actions: other players, the merchants' own crafting, and
   the townsfolk who buy food, tools and firewood every day. A glut in one item pushes players toward another.
2. **Restore a failing shop.** A merchant whose cash cannot cover the day's rent closes its shop: the door gets a
   TUTUP sign and the keeper explains why. A **restoration board** inside lists what it needs to reopen: coins plus a
   small bundle of goods (for Budi's smithy: 200 coins, 10 Bijih, 5 Kayu). Any player can contribute coins or items.
   When the board is complete the shop reopens, and every contributor holds shares, valued at base price, that pay a
   cut of the shop's daily profit. Contributions and shares are on-chain right away.
3. **Use the player market.** List goods for other players at your own price (escrowed in the contract), or buy
   listings cheaper than the merchants' asks.
4. **Collect.** Claim dividends from shops you hold shares in. Riwayat lists every on-chain action with explorer links.

## First-session walkthrough (what a judge sees)

1. Open the game and press **Masuk** (sign in). One Auth0 window: Google or email. This is the only popup in the game.
2. You spawn at your house with 100 coins, 1 Alat (durability 20), 3 Roti and full energy. A sign by the door gives
   the goal: *"Kumpulkan, jual, dan jaga pasar kota tetap hidup."* ("Gather, sell, and keep the town market alive.")
   Riwayat already shows the account creation with an explorer link. The starter kit is settled on chain at the
   first 06:00 settlement.
3. Walk to the pond (the minimap marks it) and press A four times: `+1 Ikan` ×4, the node empties and starts its
   respawn timer. This is instant and off-chain.
4. Walk to Sari's fish stall. Her bid for Ikan is shown with a tooltip. Sell 4 Ikan: coins go up, Sari's stock goes up,
   and next game hour her price ticks down a little, with the reason in the tooltip.
5. Chop wood (uses the Alat), cook Ikan Bakar at your workbench, and sell it to Sari for more than the raw fish.
6. The notice board shows Joko's general store at 2 days of rent left and falling: he buys everything and pays storage
   on what he can't resell. Next morning his stall reads TUTUP.
7. Open Joko's restoration board and contribute 50 coins and the 6 Kayu you chopped. When the board is complete
   (in the judge scenario the remaining gap is small), the shop reopens and your shares appear in Profile. The
   contribution has its own explorer link right away.
8. Press **Settle sekarang** (Dev panel) to run the daily settlement now: Riwayat shows one on-chain settlement
   transaction for the day, with an explorer link.
9. Press **Simulate 1 week** (visible button, also in the Dev panel). Watch price charts per item, cash charts per
   merchant, and the town money supply move for 7 game days in about a minute. This runs off-chain, is labelled as a
   simulation, and uses the same pricing file as live play.

## Screen, controls and look

- **Full window by default on desktop.** The view fills the browser window (up to 40×24 tiles) at the largest
  whole-pixel scale; phones and small windows keep the boxed layout with the touch pad. Settings can force either.
- **Fullscreen.** A ⛶ button in the HUD (and the key F) switches to browser fullscreen. Esc leaves it.
- **Context hint.** When you face something usable, a line at the bottom says which key does what, e.g.
  "Spasi Mancing (−4 energi)" or "Spasi Tanam gandum (1 Gandum, tekan 2x)". Planting needs a second press.
- **Settings (Pengaturan)** is a gear button in the HUD, also on the Menu button on phones:
  - **Keybinds:** every action (move ×4, interact/A, bag/E, message to an NPC/T, map, Riwayat, fullscreen, settings)
    is listed with its key. Click an action, press a new key, and conflicts are flagged before saving. "Reset ke
    bawaan" (reset to defaults) restores the defaults. Stored in this browser (localStorage).
  - **Text speed** and **reduced motion**. Reduced motion follows the OS setting by default.
  - **Language** stays Indonesian; the README is in English.
- **Art direction.** We move from the GBC-style palette to a warmer, softer farm-sim look: richer greens and wood
  tones, more detail on crops, ponds and shopfronts, seasonal tile tints, and gentle day/night lighting. Everything
  stays procedural pixel art drawn in `sprites.js`, all original. This replaces the M0 brief's "keep the GBC look", at
  your request on 2026-11-01. Because it is a large job, it is scheduled after the economy loop works (see the
  milestone plan in the README).

## Night in the wild

From 19:00 to 06:00, the open forest and rock chunks of your Homeland have wild boars and mine bats (the centre around
the Town Hall is safe). Gathering there can meet one, and walking into a roaming one makes it attack. Fight (energy per
round) or flee; winning gives the gather plus one; running out of energy knocks you out until 06:00 with nothing lost.
It makes wild wood and ore riskier, and so worth more, at night; opening a wild chunk brings its resources and its
danger. The trade-only public area has none, and the old village guard project **Pos Ronda** is retired. Details:
README, "Night monsters in the Homeland".

## What is deliberately not in the loop

Casino, player-versus-player combat, theft, police, curfew and gossip are switched off by default (code kept behind
feature flags). They pull attention away from the economy, and theft or gambling must never touch on-chain assets.
The night monsters are the one conflict in the loop: player against the forest, never against another player.
