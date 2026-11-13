# Genesis Town

> **Status (2026-11-09): M3 done, M4 (hardening) in progress; Homeland phases A, B and C built and merged into `main`.** Done and tested:
> - **UI and navigation round** (2026-11-14): the Town Hall has 3 tabs (Town now also holds the guests, invites and roles; Build; Workers); holding **Tab** (or the phone's 👥 button) lists the players in your world with name#tag, a party marker and a 4-bar connection signal (good, fair, weak; from the age of their last presence report, ours from the measured round trip), and Tab no longer moves browser focus; a **Misi** button at the top right opens the missions and shows a "!" when a reward waits or the current mission is new; the shop-closed rescue card (market info such as "still short 6 Wheat") is gone; clicking the dark backdrop closes a window unless it is `sticky: true` (payments, trade, casino, admin, device approval, settings, name and typed confirmations); Esc and the x always close. Needs a browser check.
> - **Merchants and the Player Market, consignment removed** (2026-11-14): about every 30 s (`npcMarket.everySecs`) the
>   server reads the open Player Market listings. Each merchant buys a listing of a good it trades when the price is at or
>   below its fair price (its mid price from `economy/pricing.ts` times its cash factor), within a daily cap, never above 15%
>   of its cash per buy or 35% per day, through the settler's new contract call `merchant_buy_listing` (the merchant's own
>   coin on chain, the normal escrow, 5% burn and events; contract change in `contracts/game/src/market.rs`, no migration).
>   If the contract is not redeployed yet the feature stays off quietly (`server/src/game/npc.ts`). The median listing price
>   over at least 3 sellers (`server/src/game/trend.ts`) moves each good's merchant price level by at most 5% a game day
>   (0.7x to 1.5x) and, when it stays 2x above or 0.5x below normal, merchants stop offering that good until it recovers.
>   Ben's shop window now has a tool stall: new Pickaxe, Axe, Fishing Rod or Hoe, or a repair priced by the wear, for coin
>   (act `toolshop`, config `toolShop`). **Titip Jual / Mbok Darmi is gone** (route, stall, sign, config); goods still held
>   there are returned to their owners once at startup (ledger kind `consign_return`).
> - **Chips on the server** (2026-11-14): casino chips are bought with coin (`economy/config.json` `chips`: 10 chips per coin, daily limits) and kept per account as `bought` (can be exchanged back to coin at the same rate minus a 5% fee, coin from the town fund) and `won` (won at a table, never exchangeable, so gambling creates no coin); a stake spends bought chips first, every win is paid in won chips, and the Luck Table, slot, dice and cards are decided by the server (act `chips {op: buy|sell|play}`, `server/src/game/chips.ts`, `/api/state` `chips {bought, won, ...}`); buying chips is on the chain-check spend list. The window shows both kinds and the Buy / Exchange buttons (`client/js/mods/casino.js`). The act `gamble` stays closed.
> - **One Settings window** (2026-11-14): Atur / Pengaturan is now one panel like the character screen: your name (editable, with the fixed #tag) and a preview of you idling in your Mall outfit on the left; on the right Kustomisasi (wear or take off what you own, a button to the Genesis Mall if you own nothing; the body look is fixed after the character is made), Party (members, invite by name#tag, leave, kick; key G still opens it alone) beside Tampilan & suara (language, view, text size, layout, music, sound, keys), and a Simpan button that saves a changed name (a taken name is shown under the field) and closes; X or Esc closes too. Narrow screens stack the boxes (`client/js/mods/settings.js`, `charscreen.js` and `party.js` export the pieces). Needs a browser check.
> - **Admin window and /admin** (2026-11-14, replaces the player Top up): the page `/admin` is the game page and opens the Admin window for accounts in `ADMIN_ACCOUNTS` (others get "admins only"); "Lainnya > Admin" opens it too. Tab Kas kota: the town treasury (books and chain) and one flow to send coin to a player (search, confirmation card with name#tag and look, amount with the limits shown, note, Send, result inline; `POST /api/admin/grant`, ledger kind `admin_grant`, limits `adminGrant`) plus the recent sends read from the ledger; tab Keamanan: guests, bans, frozen accounts, settlement. The NEAR top-up (`/topup`, `/api/topup/*`, `TOPUP_ENABLED`) is removed; the contract keeps `buy_coin`, unused by the game.
> - **Social round** (2026-11-13): player names are unique ignoring case (a taken name is refused; older duplicates keep working and `/msg name` says to use `name#tag` when several share one), clicking a player or their name tag opens a card with their look, Town Hall level, online and party state and the buttons Pesan, Trade and Batal (`GET /api/player?name=`), a finished trade flies the goods across to the other player with a sparkle and a chime (the session answer carries the swapped lines), and facing grass and pressing the action key can find 1 wheat seed (`economy/config.json` `grass`: energy, cooldown, daily cap; the existing wheat token, no new one). Needs a browser check.
> - **Old NEAR Auth accounts retired, trades visible to all** (2026-11-14): login only works through our own NEAR Auth
>   (`FASTAUTH_*`, no fallback to the public one) or Google; an account whose owner key came from the public NEAR Auth is
>   answered with "make a new account". An admin removes them from the Admin window, tab Keamanan: Dry run lists them (name#tag,
>   last seen, books, Homeland), then Delete selected after typing the confirmation (`POST /api/admin/purge-legacy`,
>   `server/src/purge.ts`; ledger and on-chain tokens stay, refused while settlement runs). While two players have a live
>   trade window open everyone in the world sees "A ⇄ B" on their name tags and a badge between them, and a finished
>   trade writes a public line "A traded with B" (names only).
> - **Live trades and accepted offers check both sides against the chain** (2026-11-13) before the swap.
> - **Every spend also checks the testnet** (2026-11-13): before a sell, buy, craft, cook, build, hire, Mall, repair, tool, ride, casino, shipping, pantry stock, live trade offer the server reads the player's balance from the contract (cached 15 s) and refuses with a 409 when the chain holds less than the database's settled amount (`server/src/chaincheck.ts`; `CHAIN_CHECK` strict | lenient (default) | off, `CHAIN_CHECK_TTL_MS`). Settlement runs and relays in flight are skipped, a chain read that fails or takes over 1.5 s is allowed in lenient and refused in strict, and `/api/admin/status` lists the last 50 mismatches.
> - **Phones either way up** (2026-11-13): a phone held sideways no longer shows an empty frame with the old D-pad; it
>   gets its own layout: the game takes the whole height under a one-line status bar, Tas, Pasar, Peta, Chat and Menu
>   stand in a rail at the right edge, and the joystick and action button sit low in the corners beside the item bar
>   (`html.gt-land`, `css/phone.css`; `engine.js` fills the view edge to edge). Turning the phone (fullscreen too)
>   switches at once; a phone in fullscreen keeps its thumb controls. The 2.5D camera comes closer on a short screen,
>   windows open as a centred panel, the character screen fits sideways, tips over the item bar wrap instead of running
>   off the screen and say "ketuk" on a phone, the joystick steps aside while typing a chat line, the town map covers
>   the 2.5D buttons, the last tab reads "Menu", and the Tas no longer opens on an empty "hoe · 0" card.
> - **Other players walk in step** (2026-11-13): a friend in the public village or your Homeland used to show up about
>   a second late and in stop-and-go steps. Now each client reports about 4 times a second while someone is near (and at
>   once when it starts, stops or turns), sends where it is between tiles and how fast it walks, and the others draw it
>   pushed on by that speed for as long as the report is old, gliding instead of easing tile to tile. On a 240 ms round
>   trip the friend is about a third of a second behind instead of about a second (`client/js/mods/players.js`).
> - **Settlement guards** (2026-11-12): before sending a day, the server asks the contract which day it last closed; if
>   the chain is already further (an older database, or a second server on the same contract), settlement stops instead
>   of paying gas for transactions that must fail, and `/api/health` says so. The Neon copy stores how far it is settled,
>   and a database that is further behind can no longer overwrite it. `server/scripts/snapshot-move.ts` puts a local
>   database into the copy (`--dry-run` only reads).
> - **No doomed NEAR Auth popup** (2026-11-12): NEAR Auth's shared testnet login only returns to addresses it has
>   allowed, so the server lists them (`NEAR_AUTH_ORIGINS`, default `http://localhost:3000`) and the game offers NEAR
>   Auth only there. Elsewhere the Google button stays, and a device approval explains instead of opening a popup that
>   fails with "Callback URL mismatch".
> - **Street lights in Homelands** (2026-11-12): the Town Hall menu has a Street lights project (owner only, a builder
>   job; cost in `economy/config.json` `homeland.lighting`). Level 1 puts lamps along the centre island's paths, level 2
>   on every open island (outer islands along their grass cross). The shared generator places them, so server, owner and
>   guests see the same lamps, and they glow at night like the village's. Crafting also works at the Workbench in
>   Rumahmu now, not only in the Town Hall.
> - **Admin panel** (2026-11-12, step 4 of [docs/session-guest-plan.md](docs/session-guest-plan.md)): accounts listed in the `ADMIN_ACCOUNTS` env var get an "Admin" entry in Lainnya: guests online with their address, Kick, Ban IP, and a list of banned addresses with Unban (`/api/admin/*`), plus two operator tools for hosts where the dev tools are closed: frozen accounts (settlement shortfalls) with Unfreeze, and a read-only settlement status (day, settled-through, days in retry backoff, last rows). To become admin set `ADMIN_ACCOUNTS=p<id>.players.genesistown.testnet` (comma-separated) in `.env` and in Railway Variables, then restart. A banned address cannot be a guest, sign up or redeem a device code. Guests are now one per address (a second hello returns the same guest), last at most 30 minutes at a time, and other players see a guest only by a public handle, never its secret id.
> - **Online guests** (2026-11-12, step 3 of [docs/session-guest-plan.md](docs/session-guest-plan.md)): a visitor who has not signed in walks the public village as a guest ("Tamu") and sees the players there; players see the guest with a small dim "Tamu" tag, and a guest sees everyone's name tags small. Guests cannot chat, trade or act; at most 5 at once (`guest.max` in `economy/config.json`), the 6th gets "Desa sedang penuh tamu" and stays in the offline demo. `POST /api/guest/hello` and `/api/guest/presence`, in memory only, never in Homelands.
> - **New device signs in at once** (2026-11-12, step 1 of [docs/session-guest-plan.md](docs/session-guest-plan.md)): the same Google or NEAR Auth login on another browser goes straight into the game, with no code and no extra screen; NEAR Auth approval is asked only the first time that device uses the market, gifts, shares or town projects. The "I have a code" box and "Move to another device" are gone from the UI.
> - **Party** (2026-11-11, step 1 of [docs/coop-trade-plan.md](docs/coop-trade-plan.md)): up to 4 players form a party by `name#tag`, from a player's name card ("Ajak party") or `/party nama#tag`; the invited player accepts or declines, anyone can leave and the leader can remove members. Press **G** for the Party panel. It is stored on the server and survives a reload. Step 2: party mates have green name tags at any distance, green dots on the map (M), an edge arrow when off screen, and `/p text` is a party-only chat that reaches mates in any world. Step 3: the owner's party mates may enter their Homeland without an invite (as visitors: walk, chat, eat), the portal lists party worlds, **Ikut** in the party panel walks you to the portal and across to a mate's world, and leaving or being kicked sends a visitor back to the village. Step 4 (2026-11-12, **Co-op in the Homeland**): the owner sets each guest's role and the party's role in the Town Hall (Pengunjung / Pembantu / Tukang; party mates are visitors until the owner promotes them). Helpers chop, mine, fish and fight night monsters in the owner's Homeland; the take goes to the helper under their own daily cap, a guest never takes a node's last charge, and each guest may take 40 units per host per day. Step 5 (2026-11-12): helpers till, plant, water and harvest the owner's Homeland field; every crop belongs to whoever planted it (a guest may have 2 crops per host), so harvesting someone else's crop delivers it to the planter with a Riwayat line. Step 6 (2026-11-12): friends build together. A Tukang starts a building in the owner's Homeland and pays for it from their own bag (the building is the owner's), a Pembantu or the owner presses **Bantu tukang** to cut 15 s off a running job for 10 energy (never below half the job), and a Pembantu can collect a building's output, which goes to the owner under the owner's daily cap with a Riwayat line. Step 7 (2026-11-12, server only): live two-sided trades. A player opens a trade with another in the same world (village or a Homeland; strangers within 3 tiles, party mates at any distance), both put in up to 4 kinds of items or coin, any change clears both confirmations, and once both confirm a 3 s countdown runs and the goods swap in one transaction (`/api/trade/open|join|set|ready|close`, Riwayat filter `GET /api/history?kind=trade`). Step 8 (2026-11-12): the trade window. "Ajak dagang" on a player card, "Dagang" next to a party mate in the party panel (G) or `/dagang nama#tag` opens a two-column window in the village or a Homeland: add coin and up to 3 kinds of items, press **Siap**, any change clears both ticks, then a 3 s countdown swaps the goods; an invitation pops up for the other player. Riwayat has a "Dagang" filter. The old offer pop-ups are gone from the client. Steps 9 and 10 of the plan are skipped for now.
> - **English by default** (2026-11-11): all in-game text is English; Bahasa Indonesia is one click away in Settings (Language / Bahasa, it reloads the page) or with `?lang=id`. NPC names follow the language (villagers, the four merchants Sarah, Ben, Wendy and Jack / Sari, Budi, Wati and Joko, Mbok Darmi / Granny Daisy), and merchants answer in the player's language. How it works: `client/js/i18n.js` gives `$t('Indonesian source text', [vars])`, the English entries are in `client/js/lang/en.js`; the server speaks English and translates its answers to Indonesian when the client sends `X-GT-Lang: id` (`server/src/lang.ts`, table in `server/src/i18n-id.ts`). Item and merchant display names come from `economy/config.json` (English), token ids are unchanged. The prototype mods that are switched off by default (casino, combat, thief, police, curfew, gossip, social) are still Indonesian only.
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
>   the 3D kit (solid buildings and trees, sun and shadows, seasons, night glow, see-through walls). Default on every device
>   (2D stays one switch away in Settings), behind a pixel loading screen that follows the real load; without WebGL the 2D view draws. Camera and keys: **Q / E** turn the
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
>   both must be in the public area within 3 tiles; atomic accept, off-chain ledger rows settled daily). **Papan Juara** shows the top sellers of the day and of all time. Numbers: `economy/config.json` -> `homeland.bots`,
>   `trade`; plan: [phase B](docs/superpowers/plans/2026-11-09-homeland-phase-b.md).
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
> - **Playtest fixes** (2026-11-12, branch `perbaikan-feedback`): chat no longer leaves the character walking; dialogue sits
>   above the key hints; sign-in buttons line up with a loading ring; More is **Settings** (Sign Out inside, no player Soul);
>   in a Homeland an **Upgrade** button opens the Town Hall, the guest role list stays open, waterfalls pour down, and standing
>   in a portal takes you through after a dizzy wait; other players lag about 0.5 s; the public village is all open with
>   fishing, chopping and mining (`homeland.publicGather`, `publicOpenAll`) and a **boat** to its bottom-right island
>   (`GTVillage.ferryOf`, act `boat`); mining swings a **pickaxe**; the fishing rod has a spinning reel; a **hoe** (Cangkul) tills
>   grass inside a Homeland farm fence (act `hoe`, table `homeland_tilled`).
>   The mining token `tool` is now shown as the **Pickaxe** (Beliung) with a pickaxe icon; it is still needed to mine
>   and wears out after 20 uses (token id unchanged).
>   Also: icons on the top bar, phone tabs, menus (`GT.menu` option `icon`), hotbar actions and Town Hall costs (item
>   pixel icons); Homeland buildings with a stone base and flower boxes; a nine-step
>   **mission** chain; a **Luck Table** by the market (now chips only, see the first bullet); a **Mall** stand selling worker gear (new Work Gloves, Work Boots, Hard Hat; act `mall`);
>   riding the **carousel** with a cinematic camera, letterbox and colour grade (`mods/ride.js`); house furniture to use
>   (nap, tips, TV news, watering a plant until it blooms, your own chest opens your bag; an icon and verb float over the
>   piece you face, `mods/interior.js`). *(planned)*: the Upgrade button on phones.
> - **Playtest fixes, round 2** (2026-11-13): phones play full screen with no D-pad or A/E buttons: a joystick at the bottom left walks
>   (analog in 2.5D, four directions in 2D and indoors; tapping the map still works), and one
>   round action button (`#btnAct`, `GT_ACTBTN.add` for mod probes in `mods/settings.js`) appears with an icon and a verb
>   only when something in front of you can be used; F (or the action button) opens the portal at once, the dizzy wait
>   still works; the hoe's green squares show again in 2D and 2.5D (the client now reads the fence from
>   `GT.world.layout.farm`, like the server) and in 2.5D they sit on an unlit sheet (new mod hook `onDrawMarks`),
>   so sun shading, night and rain never dim them; merchant name tags sit right above their heads; island waterfalls pour far
>   below the island and fade, with a new streaked water texture; F (or the action button) gets you on the carousel
>   again (it read a `GT.world.fun` the engine never had; now `GT.world.layout.fun`). On phones the 2.5D view's buttons
>   are one slim icon column at the top right and the mission card and Homeland chip keep clear of them; the joystick
>   and action button sit inside the game picture, above the item bar; a guest no longer gets a "Sign in first" toast that
>   never goes away (the portal check ran every frame). A player's `#tag` now comes from their account name, so a restart that
>   came back from an older database copy gives them the same tag instead of a new random one.
> - **Town expansion** (2026-11-13): new public buildings: the **Genesis Mall** (28 player cosmetics in 7 slots, 20-400
>   coin, worn items seen by everyone in 2D and 2.5D; acts `mall buy|wear`, `mods/mall.js`), the **Genesis Casino** (a
>   15-coin pass for 30 min; inside the Luck Table and chip mini-games whose chips never become coin or goods,
>   prizes are titles), the **News Hall** (Papan Juara and town news, `GET /api/news`, `mods/board.js`) and the **Public
>   Mine** beside a public forest and rock field for new players; 8 more house styles (12 in all) and medieval touches;
>   almost every building has a room to walk into (`GT.enterRoom`, Homeland buildings via "Masuk"). Tools are equipment
>   with durability (Pickaxe 60, Axe 60, Fishing Rod 40, Hoe 80 uses; acts `repair`, `maketool`; `/api/state` `tools`);
>   new players start with 3 Wheat and the four tools. The carousel costs 10 coin (act `ride`) and its horses now face
>   the way they turn. 12 missions teach tools and basic items (act `mission claim`). The HUD shows the player's own
>   account balance as read-only "Savings" coin (1000 per NEAR, never spent). Prices stay in coin; no NEAR words in UI.
> - **Sound effects** (2026-11-13): every activity makes a short sound, all synthesized with WebAudio (no audio files,
>   `mods/sfx.js`, `GT_SFX.play(name, {vol, pitch, x, y})`): gathering, farming, crafting, cooking, eating, selling and
>   building (one table in chain.js `act`), fishing phases (also other players' fishing, quieter with distance), swings
>   and brawls, doors, furniture, the carousel, the ferry, chat, party and trade invites, the Luck Table, hotbar and
>   windows; Settings has 'Sound effects' on/off and a volume slider (localStorage `gt.sfx`, `gt.sfxVol`). Round 2: a
>   limiter makes them clearly loud at 100%, footsteps per tile (wood indoors), rain (muffled indoors) and snow wind from
>   `GT_CHAIN.weather()`; background music from the first tap (`mods/music.js`, `GT_MUSIC`: generative, brighter by day,
>   softer at night, ducks for the night concert) and a fairground waltz while riding the carousel (`GT_MUSIC.ride`);
>   Settings 'Background music' on/off and volume (`gt.music`, `gt.musicVol`).
> - **Playtest fixes, round 3** (2026-11-13, [plan](docs/superpowers/plans/2026-11-13-playtest-round-3.md)): new players
>   start with 5 Wheat, and the hotbar shows the Hoe, the Pickaxe and a Fishing Rod (a free tool like the Hoe) first;
>   clicking to walk no longer fights W A S D (mouse.js holds its own direction, `GT.walkDir`, and any player direction
>   cancels it, hook `onPlayerDir`); tilled soil uses the field's own soil art, an empty plot shows corner marks, the hoe
>   squares are lighter; the owner's Town Hall is in three tabs with icons (Town incl. guests, Build, Workers), Build shows a
>   dot when something can start, and two regions with the same name say their side; the mission card is an icon, a
>   few words and one hint, and moves under the floating top bar; a closed shop shows one row per missing good with a
>   progress bar; the carousel ride is a clean, brighter picture with a warm light on the rider (`GT.setCleanView`), and
>   getting off puts the player back on the ground; the fishing rod is a 3D model in the 2.5D view (`three/rod.js`),
>   and other players see you fish (presence `fish`: phase and float tile, checked on water); players inside the same
>   building in a world see each other there (presence `room`, `rx`, `ry`); a lost connection shows a badge and
>   reconnects by itself (chain.js `netDown`/`netUp`, `/api/health` every 3 s); arriving through a portal no longer
>   sends you straight back (the portal waits until you have stepped off it once).
>
> - **Work buildings** (2026-11-12, after Kingshot's resource buildings): every Homeland has a **Penggergajian** (sawmill,
>   wood) on a forest island, a **Kincir Angin** (windmill, wheat) with sails that turn in the 2.5D view, and a **Gudang**
>   (storehouse, 3 levels) that lets every producing building hold 50% to 150% more. The Town Hall window names what its
>   next level opens. Off-chain like the other buildings; details: [docs/world.md](docs/world.md).
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
| Settler (function-call key: `settle_day`, `register_player`, `close_shop`, `pay_dividend`, `merchant_buy_listing` only) | [`minter.genesistown.testnet`](https://testnet.nearblocks.io/address/minter.genesistown.testnet) | runs the daily settlement |
| Town treasury (starter kits, initial shop shares) | [`town.genesistown.testnet`](https://testnet.nearblocks.io/address/town.genesistown.testnet) | |
| Merchants Sari, Budi, Wati, Joko | [`sari`](https://testnet.nearblocks.io/address/sari.genesistown.testnet) · [`budi`](https://testnet.nearblocks.io/address/budi.genesistown.testnet) · [`wati`](https://testnet.nearblocks.io/address/wati.genesistown.testnet) · [`joko`](https://testnet.nearblocks.io/address/joko.genesistown.testnet) `.genesistown.testnet` | real accounts holding their own coin and stock as NEP-245 balances. The merchants don't sign: the server holds no keys for them, and the settler applies their trades by the contract's settlement rules |
| Player accounts | `p<hash>.players.genesistown.testnet` | full-access key = the player's NEAR Auth key; plus a game-only session key |

Contract methods: NEP-245 `mt_transfer`, `mt_batch_transfer`, `mt_transfer_call`, `mt_batch_transfer_call`,
`mt_token`, `mt_balance_of`, `mt_batch_balance_of`, `mt_supply`, `mt_batch_supply`; NEP-145 `storage_*`. Game methods:
`settle_day`, `register_player`, `register_merchant`, `close_shop`, `restore_contribute`, `restore_withdraw`,
`pay_dividend`, `claim_dividends`, `send_item`, `list_item`, `buy_listing`, `merchant_buy_listing` (settler, for a merchant), `cancel_listing`, `create_project`,
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
