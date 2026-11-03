# Genesis Town

> **Status (2026-11-02): M3 done, M4 (hardening) in progress.** Done and tested:
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
> - **M4 so far**: off-chain requests signed with the session key; actions checked against where the player stands;
>   a secret scan of the whole git history (`node scripts/check-secrets.mjs`).
>   A returning player on a new browser adds a game key signed with their own NEAR Auth login (new-device flow,
>   run live on testnet 2026-11-03). Sign-out keeps each account's key in the browser.
> - **Phone layout** (portrait): the game view fills the screen between a one-line status bar and the thumb zone
>   (D-pad, A, E) with a bottom bar for Tas, Pasar, Peta, Riwayat and Lainnya; windows open as bottom sheets; buttons
>   are 40 px or more. The prototype's thief-role picker no longer appears when the thief feature is off.
>
> - **Controls like a crafting game**: **left-click or F** acts on the world (walk to a tile; chop, mine, fish,
>   talk, open a stall, go into a building); **right-click or R** uses the item in your hand (eat, plant Gandum).
>   The hotbar along the bottom shows every item; pick the one in your hand with a click, 1–7 or the mouse wheel;
>   right-click a slot to send or sell it. **E** opens the bag (**Tas**), **L** fullscreen, **T** a message to an NPC.
>   On phones: tap the world to act, tap a slot to hold it, tap it again to use it.
> - **Night monsters**: from 19:00 to 06:00, wild boars and mine bats roam Hutan Utara and attack when you walk
>   up to them; gathering there can also disturb one. Fight or flee; losing all energy knocks you out until 06:00, with nothing lost on or off chain. The
>   **Pos Ronda** town project (on chain) keeps the forest safe for everyone. **Weather** for everyone each day (rain,
>   snow, bright summer sun); rain waters the farm. Calmer HUD and a first-steps guide.
>
> Not done yet: the rest of M4 (removing the game account's full-access key before submission) and M5 (demo video, submission). Anything marked *(planned)* does not exist yet.

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
[threat model](docs/threat-model.md) · [on-chain vs off-chain](docs/onchain-offchain.md) · [sources](docs/sources.md)

## What is on-chain (NEAR testnet)

| Thing | Account | Notes |
| --- | --- | --- |
| Game contract (NEP-245 items + `coin`, NEP-145 storage) | [`game.genesistown.testnet`](https://testnet.nearblocks.io/address/game.genesistown.testnet) | source: [contracts/game](contracts/game) |
| Relayer (pays players' gas, NEP-366) | [`relayer.genesistown.testnet`](https://testnet.nearblocks.io/address/relayer.genesistown.testnet) | |
| Settler (function-call key: `settle_day`, `register_player`, `close_shop`, `pay_dividend` only) | [`minter.genesistown.testnet`](https://testnet.nearblocks.io/address/minter.genesistown.testnet) | runs the daily settlement |
| Town treasury (starter kits, initial shop shares) | [`town.genesistown.testnet`](https://testnet.nearblocks.io/address/town.genesistown.testnet) | |
| Merchants Sari, Budi, Wati, Joko | [`sari`](https://testnet.nearblocks.io/address/sari.genesistown.testnet) · [`budi`](https://testnet.nearblocks.io/address/budi.genesistown.testnet) · [`wati`](https://testnet.nearblocks.io/address/wati.genesistown.testnet) · [`joko`](https://testnet.nearblocks.io/address/joko.genesistown.testnet) `.genesistown.testnet` | real accounts; the server holds no keys for them, so their balances change only through settlement rules |
| Player accounts | `p<hash>.players.genesistown.testnet` | full-access key = the player's NEAR Auth key; plus a game-only session key |

Contract methods: NEP-245 `mt_transfer`, `mt_batch_transfer`, `mt_transfer_call`, `mt_batch_transfer_call`,
`mt_token`, `mt_balance_of`, `mt_batch_balance_of`, `mt_supply`, `mt_batch_supply`; NEP-145 `storage_*`. Game methods:
`settle_day`, `register_player`, `register_merchant`, `close_shop`, `restore_contribute`, `restore_withdraw`,
`pay_dividend`, `claim_dividends`, `send_item`, `list_item`, `buy_listing`, `cancel_listing`, `create_project`,
`project_contribute`, `project_withdraw`, `migrate`. Full table: [contracts/game/README.md](contracts/game/README.md).

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

### Night monsters and Pos Ronda

At night (19:00–06:00) the forest north of the village is dangerous. Five wild boars roam Hutan Utara and three bat
swarms hang around the mine; walking right up to one makes it attack (beaten, it drops 1 Kayu or 1 Bijih). A gather
can also disturb a hidden **Babi hutan** (trees) or **Kelelawar tambang** (rocks; more likely). Where the roaming
monsters stand each game hour comes from the shared village file, so the server checks every fight against it. A small window offers **Lawan**
(5 energy a round, 70% to hit; the monster hits back while it stands) or **Lari** (4 energy, no gather). Winning gives
the gather plus one bonus. Running out of energy knocks the player out until 06:00 and sends them home; nothing is
lost, on chain or off. The server decides every roll (`server/src/game/monsters.ts`, tuning in
`economy/config.json` → `monsters`), so the cost is real: forest wood and ore are riskier at night.
The town can end it together: **Pos Ronda di Hutan Utara** (40 Kayu, 10 Bijih, 150 Koin) is a second on-chain town
project on the Balai Desa board; once it is built, no monster appears (created on testnet:
https://testnet.nearblocks.io/txns/7WZ9hLavZsXKBwQmUHLGp6vcdqVeMRiQTozC54PqeGZU). Player-versus-player combat and theft
stay switched off: they would either mean nothing or take things from other players.

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

1. Press **Masuk** and sign in with Google or email → you see your house, an energy bar, the season (Semi H1), and
   100 coins. No wallet popup.
2. Walk to the pond, face the water and press **Space** (the on-screen **A** button on touch screens) → `+1 Ikan`
   instantly. A hint at the bottom of the screen always shows which key does what for the tile you face. The hotbar at the bottom shows every item with its count; press **E** (or the round E button on phones) to open the **Tas** → it shows "+1 hari ini" (off-chain,
   today).
3. Walk to the market plaza next to your house and face **Sari's** stall (or Budi, Wati, Joko) → prices with a reason under each item. Sell your
   fish.
4. Inside your house, press Space at the table to craft (2 Gandum → Roti), and at the chest to use the Kotak Kirim.
   Outside, in the fenced field next to your house, press Space on a plot to till, plant (press twice) and water wheat.
5. Open the Dev panel → **Settle sekarang** → Riwayat (H) shows "Settlement hari N" with a testnet explorer link,
   and everything from step 2 now points to it.
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
11. Dev panel → **Lompat ke malam**, then gather at a tree or rock in Hutan Utara (north of the village) until a
    wild boar or bats appear. Fight with **Lawan** or run with **Lari**.

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
callback.

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
- NEAR AI Cloud is called over its OpenAI-compatible HTTP API with `fetch`; no SDK.

## Known limits

- The baseline is the 2026-10-25 published build. Later prototype work (to 2026-10-31) was in a local folder that
  wasn't available when this repository was created.
- Items gathered or traded off-chain today are owned on chain only after the 06:00 settlement. "Simpan sekarang"
  (settle my bag early) is planned.
- Off-chain requests are signed with the player's session key, and actions are checked against where the player
  stands (M4). A modified client can still walk anywhere a player could walk.
- Pure offline mode (`?mode=offline`) supports gathering only. For the full game without testnet, run `npm run dev:mock`.
- Merchant dialogue needs `NEARAI_API_KEY` for NEAR AI Cloud; without it the server uses local lines. The model's
  text is display-only and can't trigger trades. Chat signatures (TEE attestation) are not verified in the client yet.
- Signing in as a second person in the same browser replaces the stored session key, so the first account can't be
  used from that browser again until the new-device flow (planned for M4).
- Testnet only. NEAR Intents has no testnet, so it is out of scope unless approved as a mainnet stretch.

## License

MIT, see [LICENSE](LICENSE).
