# Genesis Town

> **Status (2026-11-09): M3 done, M4 (hardening) in progress; Homeland phases A, B and C built and merged into `main`.** Done and tested:
> - M2 (Checkpoint 3): off-chain play (gathering, energy, crafting, farm plot, shipping, trading with four merchants
>   priced by `economy/pricing.ts`), a daily settlement on NEAR testnet with the ledger's Merkle root, and shop
>   bankruptcy and restoration with shares, all in an end-to-end testnet run;
> - the fast-forward simulator (**Simulasi**) and a 30-day report ([docs/sim-report-30d.md](docs/sim-report-30d.md));
> - the **player market** (*Pasar Pemain*): contract v3 escrows listings on chain, burns a 5% fee on each sale, and was
>   upgraded in place on testnet with all state kept;
> - **merchant dialogue**: ask a merchant about prices; the answer comes from NEAR AI Cloud when the server has a key,
>   otherwise from a local line built from the same price facts;
> - **one shared, seeded village**: the same generator runs in the browser and on the server, so every player sees
>   the same map: a river, a market plaza, Balai Desa, a church, Puskesmas, Kantor Pos, Kantor Makelar, Warung Kopi,
>   forest and mine, fields, and fogged areas that open later ([docs/world.md](docs/world.md));
> - **town projects** (contract v4): players pool goods and coin on chain to build the bridge to Dusun Seberang; the
>   pledges are burned when it is built and the new area opens for everyone;
> - warmer art, a full-window layout, fullscreen (F) and a settings menu (O) with rebindable keys.
> - **2.5D view** (2026-11-10, Pengaturan > Tampilan): the village and Homelands in three.js with the HD-2D look of
>   the 3D kit (solid buildings and trees, sun and shadows, seasons, night glow, see-through walls). Default on a
>   computer, 2D on a phone; without WebGL the 2D view draws. Camera and keys: **Q / E** turn the
>   view by 45 degrees (the bag stays on I and the Tas button), **+ / -** zoom, and the arrows walk the way they point on
>   screen. Signs and name tags follow each head at any turn, drawn small so they do not cover the world.
>   The lab's controls are in the game too: its trays (top right) hold **Desa / Homeland** (walks to the portal, then
>   travels), zoom and turn; a **drag** on the world walks with the lab's ring, the **mouse wheel** over the world zooms
>   (over the hotbar it still picks the item), and the lab's key hint sits bottom left on wide screens. Season and hour
>   follow the server, so the lab's season buttons and hour slider are not in the game.
>   **Free walking** in the 2.5D view outdoors: no tile grid, diagonals with two keys or a drag, 5 tiles a second, sliding
>   along walls; walking up into a door still goes in. The server still gets the tile under the player's feet, so its
>   position and walking-speed checks are unchanged. Indoors and in the 2D view walking stays on the grid. Same rules and positions as 2D: the engine
>   still owns them (`client/js/mods/view3d.js`).
>   **Walking in without a cut** (2026-11-11): stepping through a door no longer fades to black. The building's roof and
>   walls fade, the room unfolds out of the door to its full size (rooms are bigger than their buildings), and the
>   village fades into mist around it; walking out plays it backwards (0.7 s, instant with Kurangi animasi). The room
>   is the 2D game's own room, drawn as a cut-away dollhouse lit by a warm lamp, its windows glowing at night
>   (`client/js/three/room.js`). Walking up into a door outdoors now always goes in (a step could skip the trigger).
> - **Floating-island Homelands** (2026-11-11): every area of a Homeland is its own island in the sky, with stepped
>   rock and earth hanging underneath, waterfalls where a pond or the sea reaches the edge, and clouds drifting below.
>   Opening an area lays a plank bridge across the gap (the bridge is part of the map, so the server checks it too).
> - **The public square** (village generator 2, 2026-11-11): the market is now a 17 x 12 square with a fountain in the
>   middle, the four merchants' stalls along the north side, players' lapak stalls along the south side, benches and
>   street lamps; the church and the Puskesmas are gone (Balai Desa, Kantor Makelar, Kantor Pos, the Warung and the
>   houses stay). **Sit** on any bench by walking onto it and standing still. Around the square: a **stage** with a
>   concert every night from 19:00 to 01:00 (a band, spotlights, and the town's own chiptune tune made in the browser,
>   louder the closer you stand; Pengaturan > Musik konser turns it off), a turning **carousel**, a **lily pond** with
>   frogs on its muddy bank, and a **terrace** with parasols in front of the warung. Fishing stays in the Homelands
>   (the public area is trade-only).
> - **Living world** (2.5D view): butterflies over the flowers by day, fireflies by the water at night, frogs that hop
>   on the mud and the lily pads; the night monsters (boars, bats) are 3D models that trot or flap and face you.
> - **Your own house** (2026-11-11): every new Homeland (generator 3) has the player's house west of the Town Hall,
>   built from the start, with its door on the path to the Town Hall; walk in to find Ibu at home. The centre's Rumah
>   Pekerja lot moved down beside it, its door opening onto the farm (older Homelands too; a built one moves with it).
>   **Felled trees** show as stumps: the last chop tips the top over and it fades, then the tree regrows as a sapling,
>   a young tree and a grown one over its 2 game hour cooldown (server `state.stumps`).
>   The village portal, where everyone on the server arrives, is drawn about twice the size of a Homeland's in both views
>   (look only: same tile, same walk map).
> - **M4 so far**: off-chain requests signed with the session key; actions checked against where the player stands;
>   a secret scan of the whole git history (`node scripts/check-secrets.mjs`).
>   A returning player on a new browser adds a game key signed with their own NEAR Auth login (new-device flow,
>   run live on testnet 2026-11-03). Sign-out keeps each account's key in the browser.
> - **Masuk dengan Google** (2026-11-11, with `GOOGLE_CLIENT_ID`): a plain Sign in with Google button next to NEAR
>   Auth, for domains NEAR Auth does not accept yet. The server checks Google's ID token (Google's certs, issuer,
>   audience, expiry) and files the player under `google-oauth2|<Google id>`, the id NEAR Auth gives the same Google
>   account, so both buttons open one NEAR account with the same MPC owner key; the server never holds a private key.
>   Limit until NEAR Auth accepts the domain: a Google player on a second device cannot add a game key there.
> - **Phone layout** (portrait): the game view fills the screen between a one-line status bar and the thumb zone
>   (D-pad, A, E, drawn as translucent glass with an opaque fallback) with a bottom bar for Tas, Pasar, Peta and
>   Lainnya; windows open as bottom sheets; buttons
>   are 40 px or more. The prototype's thief-role picker no longer appears when the thief feature is off.
>
> - **Controls like a crafting game**: **left-click or F** acts on the world (walk to a tile; chop, mine, fish,
>   talk, open a stall, go into a building); **right-click or R** uses the item in your hand (eat, plant Gandum).
>   The hotbar along the bottom shows every item; pick the one in your hand with a click, 1–7 or the mouse wheel;
>   right-click a slot to send or sell it. **E** opens the bag (**Tas**), **L** fullscreen (also in Pengaturan), **T** a message to an NPC.
>   On phones: tap the world to act, tap a slot to hold it, tap it again to use it.
> - **Players see each other**: everyone outdoors walks around the same village with their name and market title over
>   their head (your house stays private). Global chat (C, or the Chat tab on phones) with `/msg name text` for private
>   lines, `/block name`, `/nama NamaBaru` and `/help`; long lines are capped, rude words masked and sending is
>   rate-limited (80 characters, one line per 2 s). Players and chat are per world: in a Homeland you only meet the
>   owner and the guests there (`/msg` still reaches anyone). Your name is `name#tag` (3–16 characters plus a 5-digit tag, set on the
>   character screen after sign-in), and chat lines carry the tag. Presence and chat live in server memory and never touch the chain. Click another player for their card:
>   message them or open their stall in the market.
> - **Fights play out in the world**: a slim battle bar (Lawan / Lari, F / Esc) replaces the pop-up; each attack swings
>   the axe at the monster (sparks and a white flash on a hit, "Meleset!" on a miss, the damage rising over it), then the
>   monster lunges back with a red flash, the energy it cost and a small shake. The server still decides every round.
> - **A bigger farm**: the fenced field next to your house has 15 plots (5 × 3) instead of 6.
> - **Readable UI**: text is set in Pixelify Sans at 12–18px (the blocky Press Start 2P only for big titles), with a
>   text-size setting (Normal / Besar / Lebih besar); a title card tells first-time visitors what the game is, shows one
>   live line from the market and offers "Main sekarang"; portrait tablets get the full-screen phone layout.
> - **Chopping has a swing**: the axe slashes into the tree with a white trail, wood chips fly and leaves drift down.
> - **Fishing as a skill game**: ripples mark where fish gather (they move every two game hours; bites come faster
>   there). Cast, wait for the "!", press in time, then hold to keep the fish inside the green zone until the catch
>   bar fills. The screen is clean while fishing (only the reel bar and one button). The catch is the normal gather
>   action, so energy and node charges work as before; a fish that gets away costs nothing.
> - **Riwayat in plain words**: grouped by day, item icons, repeats folded ("+1 Ikan ×3"), friendly titles; each
>   on-chain row has "Detail ↗" to the block explorer for the full record.
> - **Crafting costs**: simple recipes cost energy (Roti 5, Ikan Bakar 8), complex ones cost coin (Alat 3 coin).
>   Merchants still pay their own 2-coin crafting fee.
> - **Riwayat per item**: in the Tas, each item's panel has a Riwayat button that lists only that item's history;
>   "Semua riwayat" (or H) shows everything. History rows are tagged with the items they touch.
> - **Installable (PWA)**: web app manifest, icons and a network-first service worker (never caches `/api/*`, so game
>   code is never stale online). On iPhone, fullscreen comes from "Tambah ke Layar Utama"; the settings say so.
> - **Winter is white**: in Dingin (and on snowy days) the ground, roads and plaza are snow-covered and grass and
>   flowers are frosted; the old hazy filter is gone, snowflakes still fall.
>- **Item windows like a farming or server-economy game**: every window shows items as icon cards (the same icons as
>   the hotbar). A shop shows what the merchant sells on top and your own items below with what they pay, greyed when
>   they don't buy it; click to trade 1, Shift-click for 5, right-click to sell up to 10, and the price reason shows
>   for the item you touched. The **Tas** is a grid with a detail panel (what an item is for, where to get it, which
>   merchant pays most, Makan / Pegang / Jual / Kirim). **Pasar** groups listings by item, cheapest first, next to the
>   merchants' prices, shows your listing slots (n/5), and warns when your price after the fee is below what a
>   merchant would pay.
> - **Night monsters, in your Homeland**: from 19:00 to 06:00, wild boars roam the open forest chunks and bat swarms
>   the open rock chunks of your Homeland (the centre around the Town Hall stays safe) and attack when you walk up to
>   them; gathering there can also disturb one. Fight or flee; losing all energy knocks you out until 06:00, with nothing
>   lost on or off chain. Opening a wild chunk brings its resources and its night danger. The trade-only public area has
>   none, so the **Pos Ronda** town project is retired (no new pledges; what was pledged can be withdrawn). **Weather** for everyone each day (rain,
>   snow, bright summer sun); rain waters the farm. Calmer HUD and a first-steps guide.
>
> - **Homeland, phase A** (replaces the broker-sold Private Islands, which are gone): after
>   login a character screen shows `name#12345` (rename it, pick skin, hair and shirt) and **Mulai** drops you into your
>   own world. Every player has a **Homeland**: a seeded 3 x 3 chunk map (48 x 48 tiles) with a Town Hall in the middle and
>   eight chunks of forest, rock, pond or shore under fog. You upgrade the Town Hall (levels 1-5), open chunks (items,
>   coin and a timer each), and build **Kolam Ikan**, **Tambang** and **Restoran** on fixed lots. The one **Builder** works
>   on one job at a time; timers are kept by the server. Buildings fill up over time and you tap to collect (same daily
>   gain cap as gathering). A **portal** leads to the **public area**: the old village, now for trading only (merchants,
>   Pasar, other players; no gathering, farming or monsters). Selling there pays `coin`, which settles on chain at 06:00
>   as before. Homelands are off-chain, not NFTs, and cannot be sold. The owner invites guests by `name#tag`; guests walk
>   and chat but cannot build. Numbers: `economy/config.json` -> `homeland`; design: [docs/world.md](docs/world.md) and
>   the [Homeland spec](docs/superpowers/specs/2026-11-08-homeland-design.md).
> - The contract still has the v5 island methods (`buy_island`, `save_island`); the game does not use them and v5 is not deployed to testnet.
>
> - **Homeland, phase B**: at the Town Hall you hire **worker bots** for coin (Tukang = a second builder,
>   Petani = faster crops, Nelayan = faster Kolam Ikan, Penebang = +1 wood per tree); bots stay in your Homeland, never hold
>   items or coin and never trade. In the public area the four **merchants walk around as NPC players** (name tag `NPC`) and
>   answer private messages (`/msg Sari harga ikan?`) through **Claude** (`claude-sonnet-5-5`, low effort), or NEAR AI Cloud,
>   or a local line when no key is set; the model's text is display-only. Players can **trade face to face** (items and coin,
>   both must be in the public area within 3 tiles; atomic accept, off-chain ledger rows settled daily). **Titip Jual**: leave
>   goods with Mbok Darmi and a minimum price; she sells a few units each game hour, even while you are offline, for a 5% fee.
>   **Papan Juara** shows the top sellers of the day and of all time. Numbers: `economy/config.json` -> `homeland.bots`,
>   `trade`, `consign`; plan: [phase B](docs/superpowers/plans/2026-11-09-homeland-phase-b.md).
>
> - **Homeland, phase C**: everything feeds building speed. **Contractors** (the default Tukang and hired
>   Tukang) get **tired** and build slower; the **Restoran** no longer makes meals on its own but keeps a **pantry** (cook meals
>   into it, or stock bread/meal from the Tas) and serves the most tired contractor, faster with a **Koki**. A **Pemburu**
>   forages fish and wood (double in winter). Hired bots need a bed: build a **Rumah Pekerja**, add **Kasur** (more bots per
>   house) and **Hiburan** (Radio, TV, Gamelan: more motivation, which speeds builders and boosts producer bots). A contractor
>   who hits 100% fatigue collapses and is healed by the **Rumah Sakit** (or slowly without one). **Cosmetics** (caping,
>   syal, mahkota) cut a contractor's fatigue and boost other bots. All off-chain, no new tokens; generator version 2 adds a
>   house lot per chunk and a hospital lot. Numbers: `economy/config.json` -> `homeland`; details: [docs/world.md](docs/world.md);
>   plan: [phase C](docs/superpowers/plans/2026-11-09-homeland-phase-c.md).
>
> - **The season is the look** ([DESIGN.md](DESIGN.md)): a dark HUD tray with a band in the season's colour, cream
>   paper windows with a thick ink outline and a header in the season's tone, one accent colour per season on the next
>   thing to do (blossom pink, sea teal, pumpkin, ice blue), and the world's grass, trees, water and light to match.
>   Every window, the hotbar, chat, toasts, name tags, bubbles and floating numbers read from the same tokens
>   (`client/css/theme.css`, `client/js/theme.js`). Glass stays only on the phone's D-pad, A/E and tab bar.
> - **3D world kit**: `client/js/three/` draws the village or a Homeland with three.js 0.187.0 in an HD-2D style: the
>   game's own pixel art on solid low-poly buildings, trees, rocks and props, characters as sprite cards facing the
>   camera, a sun that crosses the sky with shadows, glowing windows and lamps at night, the four seasons, and
>   buildings and tree crowns that fade when they hide the player. `npm run build:client` bundles three.js to
>   `client/vendor/three.js`. The standalone test page `lab3d.html` lives on the `dev` branch; on
>   `main` the Dev panel, `?flags=`, `?musim=` and `?cuaca=` work on localhost only.
> Not done yet: the rest of M4 (removing the game account's full-access key before submission), **M4.5 Online**
> and M5 (demo video, submission). Also *(planned)*: agent wallets. Anything marked *(planned)* does not exist yet.
>
> **M4.5 Online** *(planned, target 2026-11-07)*: a public HTTPS URL anyone can play on testnet.
> - Host: one long-running Node 24 process (the game loop ticks every 2 s, one game hour is one real minute,
>   settlement every 24 real minutes), serving the client and the API from the same origin. Provider to be chosen
>   by the owner; no paid service or personal account is added without their OK.
> - Database: keep SQLite on a persistent disk if the host has one; otherwise migrate to Postgres (the store is
>   synchronous `node:sqlite` today, about 60 statements in `db.ts`, `gamestore.ts` and `bazaar.ts`, so this means
>   making the store async). Copy the current testnet DB over so balances, shops and history carry on.
> - Secrets only as the host's environment variables; NEAR Auth login checked on the new origin (from its docs);
>   relayer balance and rate limits reviewed for public traffic.
> - Ready in the repo: `Dockerfile`, [docs/deploy.md](docs/deploy.md) (host requirements, env var names, DB move,
>   checks), `GET /api/health`, and `TRUST_PROXY=1` so per-address limits see each visitor behind the host's proxy.
>   Split setup also ready: client on Vercel (`vercel.json`, `GT_API_BASE`), server on Railway (`railway.json`,
>   volume at `/data`, `CORS_ORIGINS`), browser calls the server directly.
>   Settlement (2026-11-11): days on which nothing happened close without a transaction (a long pause catches up in
>   seconds instead of sending hundreds of empty days); `settle_day` attaches 100 Tgas, not 300 (it uses about 19 for a
>   full server chunk); the settler key's allowance is unlimited (still only the game contract's four settler methods);
>   `/api/health` shows the NEAR left for gas on the server's accounts and warns when one runs low.
>   Database: the server keeps SQLite; with `DATABASE_URL` set, a gzipped copy is kept in **Neon Postgres** (saved every
>   5 minutes when it changed, after each settlement and on shutdown; loaded back on a host with no disk), so Railway
>   needs no volume (`server/src/snapshot.ts`, docs/deploy.md).
>   Waiting on: NEAR Auth accepting the public domain (until then players use Masuk dengan Google there).

Built for NEAR HACKATHON (Nov 1–14, 2026). Track: **Games With Real Economies** (`games`). Possible secondary track:
Agent Economy (`agents`), decided at submission.

## What it is

Genesis Town is a pixel-art market-town life sim that runs in the browser. Players gather fish, ore, wood and wheat,
craft food and tools, and trade with four AI merchants who set their own prices from their stock, recent demand and
cash. Items and coins are NEP-245 multi tokens in one NEAR contract. Players sign in with Google or email and never
see a seed phrase, wallet popup or gas prompt while playing.

## The problem

Most "on-chain games" either put a token on top of a static game, or make players fight wallets and gas. This game
tries the opposite: the economy *is* the gameplay. Prices react to what players do; merchants can go broke and be
rescued by players who then own a share of the shop. The chain records ownership and enforces the money rules (caps,
burns, rent), so anyone can verify them, while staying invisible in the normal loop.

## How the economy works

- Each merchant's price for an item = base × stock factor × demand factor, moving at most ±10% per game hour and
  staying within 0.25–4 × base. Every move comes with a one-sentence reason shown in a tooltip.
  Full rule: [docs/economy.md §4](docs/economy.md#4-pricing-rule-economypricingts). Code: `economy/pricing.ts`,
  used by both live play and the fast-forward simulator.
- The only source of new coins is townsfolk buying finished goods. The contract caps it per day and throttles it as
  total coin supply approaches a cap, so the money supply is bounded. Sinks: shop rent, crafting fees, a 5%
  player-market fee, eaten food, tool wear.
- Gathering, farming, crafting and merchant trades are instant and off-chain. Once per game day (every 24 real
  minutes) one settlement transaction writes everyone's net change on chain, with a hash of the day's published ledger.
  Player-to-player trades and shop shares are on-chain immediately. See [docs/onchain-offchain.md](docs/onchain-offchain.md).
- Seasons (7 game days each) change what the land yields and what the town buys.
- A merchant that can't pay its daily rent closes. Players invest coins to reopen it and receive shares that pay 40%
  of the shop's daily profit as dividends.

Design docs: [game loop](docs/game-loop.md) · [economy](docs/economy.md) · [world](docs/world.md) · [architecture](docs/architecture.md) ·
[threat model](docs/threat-model.md) · [on-chain vs off-chain](docs/onchain-offchain.md) · [sources](docs/sources.md) ·
[Homeland spec](docs/superpowers/specs/2026-11-08-homeland-design.md) · [NPC souls and schematics](docs/island-design.md) *(planned)*

## What is on-chain (NEAR testnet)

| Thing | Account | Notes |
| --- | --- | --- |
| Game contract (NEP-245 items + `coin`, NEP-145 storage) | [`game.genesistown.testnet`](https://testnet.nearblocks.io/address/game.genesistown.testnet) | source: [contracts/game](contracts/game) |
| Relayer (pays players' gas, NEP-366) | [`relayer.genesistown.testnet`](https://testnet.nearblocks.io/address/relayer.genesistown.testnet) | |
| Settler (function-call key: `settle_day`, `register_player`, `close_shop`, `pay_dividend` only) | [`minter.genesistown.testnet`](https://testnet.nearblocks.io/address/minter.genesistown.testnet) | runs the daily settlement |
| Town treasury (starter kits, initial shop shares) | [`town.genesistown.testnet`](https://testnet.nearblocks.io/address/town.genesistown.testnet) | |
| Merchants Sari, Budi, Wati, Joko | [`sari`](https://testnet.nearblocks.io/address/sari.genesistown.testnet) · [`budi`](https://testnet.nearblocks.io/address/budi.genesistown.testnet) · [`wati`](https://testnet.nearblocks.io/address/wati.genesistown.testnet) · [`joko`](https://testnet.nearblocks.io/address/joko.genesistown.testnet) `.genesistown.testnet` | real accounts holding their own coin and stock as NEP-245 balances. The merchants don't sign: the server holds no keys for them, and the settler applies their trades by the contract's settlement rules |
| Player accounts | `p<hash>.players.genesistown.testnet` | full-access key = the player's NEAR Auth key; plus a game-only session key |

Contract methods: NEP-245 `mt_transfer`, `mt_batch_transfer`, `mt_transfer_call`, `mt_batch_transfer_call`,
`mt_token`, `mt_balance_of`, `mt_batch_balance_of`, `mt_supply`, `mt_batch_supply`; NEP-145 `storage_*`. Game methods:
`settle_day`, `register_player`, `register_merchant`, `close_shop`, `restore_contribute`, `restore_withdraw`,
`pay_dividend`, `claim_dividends`, `send_item`, `list_item`, `buy_listing`, `cancel_listing`, `create_project`,
`project_contribute`, `project_withdraw`, `migrate`; the v5 island methods (`buy_island`, `save_island`, `set_voucher_key`, `set_broker`,
`get_island`) exist but the game does not use them. Full table: [contracts/game/README.md](contracts/game/README.md).

Example transactions from the M2 end-to-end run (`node server/scripts/e2e-testnet.ts`, server stopped):
- daily settlement of day 0 (45 ledger rows, root stored on chain):
  https://testnet.nearblocks.io/txns/GPBpcDqWgXxQdhkkNEFZJhaFAeFHwPPn2LKZHXJ9DDXq
- player A sends 1 Ikan to B, signed with A's session key and relayed gas-free:
  https://testnet.nearblocks.io/txns/HGh8cA8oYj7ACBSUPszmoXgPEdwARS4jtiuTgSRZ3bEn
- A pledges 200 coin, 10 Bijih and 5 Kayu to Budi's restoration board; the shop reopens and A gets shares:
  https://testnet.nearblocks.io/txns/DDVwUrvu9XB1AqWNLW2W5ynGLdUU92mL17pVbmvzfTQM

The run forced Budi's bankruptcy with ledger rows labelled `scripted` so the whole cycle fits in one run. In normal
play, bankruptcy comes from trading, which the simulator shows (Joko, day 4).

Contract upgrades were deployed in place with a `migrate` init call, keeping every balance, shop, share and listing:
- v3 (player market) over v2: https://testnet.nearblocks.io/txns/JnFKDYgGjvZUwCjHJ4S9WsZaMQMb7YwQoxg2Mb1kqDN
- v4 (town projects) over v3: https://testnet.nearblocks.io/txns/Cgc2KLL5krV5YpUumUNVfwCWJL7KNKStBqJP1BwTiTGS
- the bridge project created by the owner: https://testnet.nearblocks.io/txns/5kkEN7uRopMhfJaB7xn1ZNPKVSg9qtmdunht3iDyXkym

### Player market (Pasar Pemain)

The market has two sides, and nobody needs a shop to use either. In the **Lapak** the seller's name shows, and every
unit sold earns them a popularity point (titles from Pedagang baru to Legenda Pasar, and a Populer ranking). In the
**Pasar Gelap** (black market) the seller is anonymous inside the game and earns no popularity; listings and sales stay
public on chain, and the game says so. The side is the seller's choice when listing; the server keeps it
(`server/src/game/bazaar.ts`), the contract is unchanged.

Press **Pasar** (K). A player lists up to 50 of an item at their own price; the items move into the contract's escrow
right away (`list_item`). Another player buys some or all (`buy_listing`, with a `max_price_each` guard); the contract
pays the seller and burns 5% of the price. The seller can take the rest back at any time (`cancel_listing`). All three
are signed with the player's session key and relayed gas-free. Before relaying, the server's *spend guard* checks
that the player isn't spending items or coins that today's off-chain play already used (otherwise the 06:00
settlement would hit a negative balance). Items gathered today can be listed after that day's settlement.

Testnet run of `node server/scripts/e2e-market.ts` (2026-11-02, MARKET E2E PASS):
- A lists 3 Gandum at 10 coin each (escrowed): https://testnet.nearblocks.io/txns/DkeDjhqdqTFRiqCyjvhcyeyPSsT841ur5Huu1D7SjsVP
- B buys 2 for 20 coin; 19 go to A, 1 is burned: https://testnet.nearblocks.io/txns/6qCrnA2NKRyDs28gb6B7qR1YYWRyXVNYwrLmP9n7zDzF
- A cancels the last one and gets it back: https://testnet.nearblocks.io/txns/86QeWJ4kKZkxg2QhEZGj37fxJGQSEGuVUsdTGst76vRx

### New device (adding a game key with NEAR Auth)

A returning player on a browser without their game key presses **Setujui di NEAR Auth** once. Their own NEAR Auth key
signs a delegate action that adds a new function-call key (game contract only, no NEAR transfers); the relayer has
it signed through `fast-auth.testnet` and pays the gas. Live run on 2026-11-03: the AddKey for a real Google login,
relayed gas-free: https://testnet.nearblocks.io/txns/EQCu9GX2mNWT8YCJVehadGUGjYa1iBa1nY6hmdVdeMr6. Afterwards the
account has exactly one full-access key (the NEAR Auth key the server stored at sign-up) and two game-only keys.

### Night monsters in the Homeland (and the retired Pos Ronda)

At night (19:00–06:00) the wild part of your Homeland is dangerous: the open **forest** chunks have wild boars and the
open **rock** chunks bat swarms (3 and 2 per Homeland); the centre around the Town Hall is always safe, and a new
Homeland, with only its centre open, has none. Opening a wild chunk brings its wood or ore and its night danger.
Walking right up to a roaming monster makes it attack (beaten, it drops 1 Kayu or 1 Bijih). A gather there can also
disturb a hidden **Babi hutan** (trees) or **Kelelawar tambang** (rocks; more likely). Where the roaming monsters stand
each game hour comes from the shared Homeland generator (`client/js/world/homeland.js` → `monstersAt`), so the server
checks every fight against it. The battle bar offers **Lawan** (F; 5 energy a round, 70% to hit; the monster hits back
while it stands) or **Lari** (Esc; 4 energy, no gather). Winning gives the gather plus one bonus. Running out of energy
knocks the player out until 06:00 and sends them to their spawn; nothing is lost, on chain or off. The server decides
every roll (`server/src/game/monsters.ts`, tuning in `economy/config.json` → `monsters`, Homeland counts in
`monsters.homeland`), so the cost is real: wild wood and ore are riskier at night.

The public area is trade-only, so it has no monsters. **Pos Ronda di Hutan Utara**, the on-chain town project that
used to guard the village forest (created on testnet:
https://testnet.nearblocks.io/txns/7WZ9hLavZsXKBwQmUHLGp6vcdqVeMRiQTozC54PqeGZU), is retired: the server refuses new
pledges (`economy/config.json` → `projects[].retired`) and the board shows a **Tarik sumbanganku** button so earlier
pledges can be taken back. Player-versus-player combat and theft stay switched off: they would either mean nothing or
take things from other players.

### When shops fail: quiet days and the village relief fund

A shop pays its 40-coin rent only on days when someone plays (no customers, no rent), and merchants only craft on
those days, so a quiet town keeps its shops. If every shop is closed anyway, nobody can sell for coin, so the town
treasury pledges the coin part of each restoration board on chain at the next settlement (the town gets shares like
any contributor); players still bring the goods. First run on testnet, 2026-11-03, all four boards:
https://testnet.nearblocks.io/txns/BrYLXT6iUNQQKhaaHyZAAwzuehrpFtDqrGPHVBX9eMBT (Joko) and three more in Riwayat.

### Weather

Every game day has one weather for every player, from the shared village file: showers in Semi, bright **Terik** sun
most of Panas (the scene is drawn more vivid), rain in Gugur, **Salju** (snow) through most of Dingin. Rain and snow
fall over the scene; the HUD shows the day's weather beside the season. **Rain waters every planted plot by itself**
(checked on the server), so a wet week saves energy on the farm. `?cuaca=hujan|salju|terik|berawan|cerah` previews a
look on your own screen only.

### Town projects (the bridge)

In the Balai Desa, the project board shows **Jembatan ke Dusun Seberang**: 60 Kayu, 20 Bijih, 300 Koin. Players
pledge what they can (`project_contribute`, gas-free through the relayer, checked by the spend guard) and can take it
back until the project is complete (`project_withdraw`). When every line is met, the contract burns the pledges and
marks the project done; the server opens Dusun Seberang on the shared map and every player sees the bridge appear.
The bridge is left unbuilt on testnet so players can build it.

Testnet run of `node server/scripts/e2e-project.ts` (2026-11-02, PROJECT E2E PASS):
- a new player pledges 40 coin: https://testnet.nearblocks.io/txns/3gEfJYc7DhoDrrYJndpUHBTgLkG2dGVtc2MakdR2GEHP
- and withdraws it: https://testnet.nearblocks.io/txns/3hg3qgZNewW9HNtFeoQpzLyxDBsqv9QEf85BWfkrzaUP

## Try it in 5 minutes

Run locally (below), open http://localhost:3000.

1. Press **Masuk** and sign in with Google or email → you see your house, an energy bar, the current season and day, and
   100 coins. No wallet popup.
2. Click the pond (or face the water and press **F**; the on-screen **A** button on touch screens), wait for the
   "!", press, and hold to keep the fish in the green zone → `+1 Ikan`. A hint at the bottom of the screen always shows which key does what for the tile you face. The hotbar at the bottom shows every item with its count; press **E** (or the round E button on phones) to open the **Tas** → it shows "+1 hari ini" (off-chain,
   today).
3. Walk to the market plaza next to your house and face **Sari's** stall (or Budi, Wati, Joko) → her goods on top, your items below with her price. Click
   your fish to sell one.
4. Inside your house, press F at the table to craft (2 Gandum → Roti, costs 5 energy), and at the chest to use the Kotak Kirim.
   Outside, in the fenced field next to your house, press F on a plot to till, plant (press twice) and water wheat
   (not in Dingin: wheat doesn't grow in winter). With no Gandum left, the village gives
   up to 3 free seeds a day (planted straight away), so farming never dead-ends when the bakery is closed.
5. Open the Dev panel → **Settle sekarang** → Riwayat (H, or Tas → Semua riwayat) → tick **Mode teknis** → "Settlement hari N"
   with a testnet explorer link, and everything from step 2 now points to it. With the box unticked (the default) the
   game hardly mentions the chain: no account banner, no "on-chain" labels and no explorer links; one line in
   Riwayat says the items are kept on NEAR testnet.
   The Dev panel only appears on the machine running the server (`DEV_TOOLS=1` and a direct local request).
6. Press **Simulasi** → 7 game days play in about 60 seconds: price charts per item, merchant cash, money supply.
   Joko goes bankrupt on day 4 and players restore him on day 6 (off-chain simulation of the same game code, labelled).
7. When a shop shows TUTUP, talk to its merchant → restoration board → **Sumbang** (on-chain) → the shop reopens and
   your shares appear in the shop window.
8. Press **Pasar** (K) → list an item for other players (on-chain escrow), or buy someone's listing.
   The same board is on the desk in the Kantor Makelar.
9. In any shop, press **Ngobrol dengan …** and ask "kenapa harga ikan turun?" → the merchant answers from its real
   stock and price reason.
10. Walk into the **Balai Desa** next to the plaza and face the shelf at the back → the project board. Pledge toward
    the bridge to Dusun Seberang (the fogged hamlet across the river). Press **Peta** (M) to see the whole village.
11. In your Homeland, open a forest or rock chunk at the Town Hall, then Dev panel → **Lompat ke malam** and gather at
    a tree or rock there until a wild boar or bats appear, or walk up to one roaming at night. Fight with **Lawan** (F)
    or run with **Lari** (Esc).
12. Finish a town project quickly (mock server only, `npm run dev:mock`): Dev panel → **Beri bahan (mock)**, then the
    project board → **Sumbang semua yang bisa** under the bridge → "Proyek desa selesai! Dusun Seberang sekarang
    terbuka", the bridge appears and the map opens the hamlet across the river for everyone.

## Run locally

Requires Node 24 or later.

```bash
npm run setup
```

Mock chain (no NEAR account needed; everything is labelled "mock", and its data resets on every start). Open
http://localhost:3000 and press **Masuk**:

```bash
npm run dev:mock
```

Testnet: copy `.env.example` to `.env`, fill it in, then run:

```bash
npm run dev
```

The local server must run on port 3000. The shared NEAR Auth testnet login only accepts `http://localhost:3000` as a
callback. With `GOOGLE_CLIENT_ID` set, a **Masuk dengan Google** button works on any origin listed in that Google
client (see `.env.example`).

## Demo / offline mode

Open the game with `?mode=offline`. All chain calls are replaced by an in-browser mock, shown by a permanent
"OFFLINE DEMO" banner. Use it if testnet or the server is unavailable.

## Architecture

See [docs/architecture.md](docs/architecture.md) for the diagram. In short: a static browser game (`/client`), a
Node/TypeScript server (`/server`) that runs the relayer, merchants, pricing ticks and NEAR AI Cloud calls, a Rust
NEP-245 contract (`/contracts`), and shared economy code (`/economy`).

## Baseline vs. hackathon work (Q-003)

- Baseline: tag `pre-hackathon`, the unchanged prototype in [`prototype/`](prototype/) (published build of
  2026-10-25, see [prototype/BASELINE.md](prototype/BASELINE.md)). It has no blockchain code.
- Hackathon work: everything after that tag. Diff:
  https://github.com/leutenantKiya/Genesis-Town/compare/pre-hackathon...main (the link works once the repository is
  pushed).

## AI-generated code and libraries (Q-005)

- The prototype was mostly written with AI assistance (Claude, as a claude.ai artifact).
- Hackathon work is being written with Claude Code, using the NEAR agent skills `near-ai-cloud`, `near-api-js`,
  `near-dapp`, `near-intents`, `near-kit` and `near-smart-contracts` (https://github.com/near/agent-skills).
- Libraries: near-sdk 5.29 (Rust contract), near-sandbox 0.3.12 and near-api 0.8 (contract integration test),
  near-api-js 7.4.0 (server and browser), `@fast-auth-near/browser-sdk` 1.4.2 and `@fast-auth-near/javascript-provider`
  1.4.1 (NEAR Auth login), jose 6.2.14 (Auth0 token checks), borsh 2.0.0, esbuild 0.28.2 (browser bundle).
- AI used in the product: **Claude** (Anthropic Messages API, model `claude-sonnet-5-5`, low effort) writes the merchants'
  replies to private messages, and NEAR AI Cloud is the alternative provider; both are called with `fetch` (OpenAI-compatible
  HTTP for NEAR AI), no SDK. The developer picks the provider with env vars; the model's text is display-only and never
  triggers a trade, price change or chain action.

## Known limits

- The baseline is the 2026-10-25 published build. Later prototype work (to 2026-10-31) was in a local folder that
  wasn't available when this repository was created.
- Items gathered or traded off-chain today are owned on chain only after the 06:00 settlement. "Simpan sekarang"
  (settle my bag early) is planned.
- Off-chain requests are signed with the player's session key, and actions are checked against where the player
  stands (M4). A modified client can still walk anywhere a player could walk.
- Pure offline mode (`?mode=offline`) supports gathering only. For the full game without testnet, run `npm run dev:mock`.
- Merchant dialogue needs `ANTHROPIC_API_KEY` (Claude) or `NEARAI_API_KEY` (NEAR AI Cloud); without either the server uses local lines. The model's
  text is display-only and can't trigger trades. Chat signatures (TEE attestation) are not verified in the client yet.
- Testnet only. NEAR Intents has no testnet, so it is out of scope unless approved as a mainnet stretch.

## License

MIT, see [LICENSE](LICENSE).
