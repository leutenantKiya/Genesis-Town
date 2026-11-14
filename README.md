# Genesis Town

> **Status (2026-11-15):** playable on NEAR testnet, settled on chain through game day 806 (one game day = 24 real
> minutes). Built for NEAR HACKATHON (Nov 1–14, 2026), track **Games With Real Economies**.
> Not done yet: removing the game contract account's full-access key, the demo video and the submission.
> Anything marked *(planned)* does not exist yet.

## What it is

Genesis Town is a pixel-art market-town life sim that runs in the browser. Players gather fish, ore, wood and wheat,
craft food and tools, and trade with four AI merchants (Sarah, Ben, Wendy and Jack; Sari, Budi, Wati and Joko in
Indonesian) who set their own prices from their stock, recent demand and cash. Items and coins are NEP-245 multi
tokens in one NEAR contract. Players sign in with Google or email and never see a seed phrase, wallet popup or gas
prompt while playing.

## The problem

Most "on-chain games" either put a token on top of a static game, or make players fight wallets and gas. This game
tries the opposite: the economy *is* the gameplay. Prices react to what players do; merchants can go broke and be
rescued by players who then own a share of the shop. The chain records ownership and enforces the money rules (caps,
burns, rent), so anyone can verify them, while staying invisible in the normal loop.

## How the economy works

- **Prices.** Each merchant's price for an item = base × stock factor × demand factor, moving at most ±10% per game
  hour and staying within 0.25–4 × base. Every move comes with a one-sentence reason shown to the player. Full rule:
  [docs/economy.md §4](docs/economy.md#4-pricing-rule-economypricingts); code: `economy/pricing.ts`, used by both live
  play and the simulator. Merchants also follow the median Player Market price (at most 5% a game day, 0.7–1.5 ×) and
  buy cheap player listings with their own coin (`server/src/game/trend.ts`, `npc.ts`).
- **New coin.** The only source of new coin is town demand: five townsfolk (Haruto, Yui, Sota, Hina, Ren) walked by the
  server buy goods from one shared keyless wallet, `warga.genesistown.testnet`, topped up from the town treasury above a
  reserve and only then from the faucet. The contract caps the faucet per day and throttles it as total supply nears a
  cap. The townsfolk also cook, gather, craft and eat by fixed rules in `economy/config.json`, which keeps prices from
  running away (`server/src/game/residents.ts`, [docs/economy.md §3a](docs/economy.md)).
- **Sinks.** Shop rent and storage fees (burned), a 5% Player Market fee (burned by the contract), crafting fees (to the
  town treasury, which funds the townsfolk), eaten food and tool wear.
- **Off-chain play, daily settlement.** Gathering, farming, crafting and merchant trades are instant, server-checked
  ledger rows. Once per game day (06:00) one settlement transaction writes everyone's net change on chain with the
  Merkle root of that day's ledger. Player Market listings, gifts, shop shares and town projects are on chain at once.
  See [docs/onchain-offchain.md](docs/onchain-offchain.md).
- **Caps.** Per account and day the contract allows at most 200 of each item and 5,000 coin of net gain (merchants and
  the town are exempt).
- **Bankruptcy.** A merchant that can't pay its daily rent closes. Players pledge coin and goods on its restoration
  board to reopen it and receive shares that pay 40% of the shop's daily profit as dividends. Rent is only due on days
  someone plays, and if every shop is closed the town treasury pledges the coin part.
- **Seasons** (7 game days each) change what the land yields and what the town buys.

Design docs: [game loop](docs/game-loop.md) · [economy](docs/economy.md) · [world](docs/world.md) ·
[architecture](docs/architecture.md) · [threat model](docs/threat-model.md) ·
[on-chain vs off-chain](docs/onchain-offchain.md) · [sources](docs/sources.md) ·
[Homeland spec](docs/superpowers/specs/2026-11-08-homeland-design.md) ·
[30-day simulation report](docs/sim-report-30d.md)

## What you can do

- **Your Homeland.** After sign-in a character screen sets your `name#tag` and look, and **Mulai** drops you into your
  own world: a 3 × 3 grid of floating islands with a Town Hall in the middle and your house beside it. Raise the Town
  Hall (levels 1–5), open islands (items, coin and a timer each), build a fish pond, mine, sawmill, windmill, storehouse,
  restaurant, workers' houses and a hospital, and hire worker bots (builder, farmer, fisher, woodcutter, rarer hunter and
  cook). Contractors tire and are fed from the restaurant's pantry; bots need beds. Timers and production are kept by
  the server. Homelands are off-chain, not NFTs, and cannot be sold. Details: [docs/world.md](docs/world.md).
- **Gather and farm.** Fish only where the water ripples (a timing mini-game), chop, mine, hoe, plant and water wheat,
  and search grass for seeds. Each needs the right tool in your hand; tools wear out and are repaired or bought at Ben's
  tool stall. Rain waters planted plots. With no wheat left the village gives 3 free seeds a day.
- **Craft and cook** at any table: bread, grilled fish and tools.
- **The public village** (through the portal): the square with the four merchants' stalls and players' stalls, the
  Player Market, the Mall (cosmetics), the casino (chips bought with coin; winnings are chips that never turn back into
  coin), the News Hall with the top-seller board, a public mine and forest, a boat you steer to the south-east island,
  a nightly concert on the stage and a carousel.
- **Trade with players** face to face: a live window with two grids of nine tiles, both sides confirm, a short
  countdown, then the goods swap in one step and fly across the screen (`/api/trade/*`, `client/js/mods/trade.js`).
  Every purchase, from a merchant or a player, plays the same animation for everyone nearby.
- **Play together.** Parties of up to 4 (G), party chat (`/p`), global chat (C) with `/msg`, player cards (click a
  player), and the players list (hold Tab). The Homeland owner gives guests a role: visitor, helper (gather, farm, fight,
  collect) or builder.
- **Night monsters** (19:00–06:00) roam the open forest and rock islands of your Homeland: fight (F) or run (Esc); the
  server decides every round. Losing all energy knocks you out until morning, with nothing lost.
- **Missions** teach the basics; finished ones show under Achievements in your profile.
- **Talk to merchants**: ask why a price moved and the merchant answers from its real stock and price reason.
- **The simulator** (Settings > Simulasi): a week of the real economy code played fast, with price charts, merchant
  cash and money supply.

Views and devices: a 2.5D view in three.js (default; Q / E turn, + / − zoom) and a 2D pixel view, both drawn from the
same engine and positions. Phones get their own layout (joystick, one action button, tab bar) that fills the visible
screen. English by default, Bahasa Indonesia in Settings or with `?lang=id`. Installable as a web app.

## What is on-chain (NEAR testnet)

| Thing | Account | Notes |
| --- | --- | --- |
| Game contract (NEP-245 items + `coin`, NEP-145 storage) | [`game.genesistown.testnet`](https://testnet.nearblocks.io/address/game.genesistown.testnet) | source: [contracts/game](contracts/game) |
| Relayer (pays players' gas, NEP-366) | [`relayer.genesistown.testnet`](https://testnet.nearblocks.io/address/relayer.genesistown.testnet) | |
| Settler (function-call key: `settle_day`, `register_player`, `close_shop`, `pay_dividend`, `merchant_buy_listing` only) | [`minter.genesistown.testnet`](https://testnet.nearblocks.io/address/minter.genesistown.testnet) | runs the daily settlement |
| Town treasury (starter kits, initial shop shares, handouts) | [`town.genesistown.testnet`](https://testnet.nearblocks.io/address/town.genesistown.testnet) | |
| Merchants | [`sari`](https://testnet.nearblocks.io/address/sari.genesistown.testnet) · [`budi`](https://testnet.nearblocks.io/address/budi.genesistown.testnet) · [`wati`](https://testnet.nearblocks.io/address/wati.genesistown.testnet) · [`joko`](https://testnet.nearblocks.io/address/joko.genesistown.testnet) `.genesistown.testnet` | real accounts holding their own coin and stock. The server holds no keys for them; the settler applies their trades by the contract's settlement rules |
| Townsfolk wallet | `warga.genesistown.testnet` | keyless: registered in the contract by the settler, not a NEAR account; every buy is booked under the resident who made it |
| Player accounts | `p<hash>.players.genesistown.testnet` | full-access key = the player's NEAR Auth key; plus a game-only session key |

Contract methods: NEP-245 `mt_transfer`, `mt_batch_transfer`, `mt_transfer_call`, `mt_batch_transfer_call`,
`mt_token`, `mt_balance_of`, `mt_batch_balance_of`, `mt_supply`, `mt_batch_supply`; NEP-145 `storage_*`. Game methods:
`settle_day`, `register_player`, `register_merchant`, `close_shop`, `restore_contribute`, `restore_withdraw`,
`pay_dividend`, `claim_dividends`, `send_item`, `list_item`, `buy_listing`, `merchant_buy_listing` (settler, for a
merchant), `cancel_listing`, `create_project`, `project_contribute`, `project_withdraw`, `migrate`. Views include
`get_config` (with `last_settled_day`), `get_day_root(day)`, `treasury_status` and `market_fee_bps`. Full table:
[contracts/game/README.md](contracts/game/README.md).

Example transactions from the end-to-end testnet runs:
- daily settlement of day 0 (45 ledger rows, root stored on chain):
  https://testnet.nearblocks.io/txns/GPBpcDqWgXxQdhkkNEFZJhaFAeFHwPPn2LKZHXJ9DDXq
- player A sends 1 fish to B, signed with A's session key and relayed gas-free:
  https://testnet.nearblocks.io/txns/HGh8cA8oYj7ACBSUPszmoXgPEdwARS4jtiuTgSRZ3bEn
- A pledges 200 coin, 10 ore and 5 wood to Budi's restoration board; the shop reopens and A gets shares:
  https://testnet.nearblocks.io/txns/DDVwUrvu9XB1AqWNLW2W5ynGLdUU92mL17pVbmvzfTQM
  (this run forced the bankruptcy with ledger rows labelled `scripted`; in normal play it comes from trading)
- the town treasury pledges to all four restoration boards when every shop is closed:
  https://testnet.nearblocks.io/txns/BrYLXT6iUNQQKhaaHyZAAwzuehrpFtDqrGPHVBX9eMBT
- a returning player's new device gets a game key, signed by their own NEAR Auth key and relayed gas-free:
  https://testnet.nearblocks.io/txns/EQCu9GX2mNWT8YCJVehadGUGjYa1iBa1nY6hmdVdeMr6

Contract upgrades were deployed in place with a `migrate` call, keeping every balance, shop, share and listing:
- v3 (Player Market) over v2: https://testnet.nearblocks.io/txns/JnFKDYgGjvZUwCjHJ4S9WsZaMQMb7YwQoxg2Mb1kqDN
- v4 (town projects) over v3: https://testnet.nearblocks.io/txns/Cgc2KLL5krV5YpUumUNVfwCWJL7KNKStBqJP1BwTiTGS

### Player Market

Press **Pasar** (K). A player lists up to 50 of an item at their own price; the items move into the contract's escrow
right away (`list_item`). Another player buys some or all (`buy_listing`, with a `max_price_each` guard); the contract
pays the seller and burns 5% of the price. The seller can take the rest back at any time (`cancel_listing`). All three
are signed with the player's session key and relayed gas-free. Before relaying, the server checks that the player isn't
spending items or coins that today's off-chain play already used. The seller picks a side: the **Lapak** shows their
name and earns popularity titles, the **Pasar Gelap** hides the name inside the game (the chain stays public, and the
game says so).

Testnet run of `node server/scripts/e2e-market.ts` (2026-11-02):
- A lists 3 wheat at 10 coin each (escrowed): https://testnet.nearblocks.io/txns/DkeDjhqdqTFRiqCyjvhcyeyPSsT841ur5Huu1D7SjsVP
- B buys 2 for 20 coin; 19 go to A, 1 is burned: https://testnet.nearblocks.io/txns/6qCrnA2NKRyDs28gb6B7qR1YYWRyXVNYwrLmP9n7zDzF
- A cancels the last one and gets it back: https://testnet.nearblocks.io/txns/86QeWJ4kKZkxg2QhEZGj37fxJGQSEGuVUsdTGst76vRx

### Town project: the bridge

In the Balai Desa the project board shows the **Bridge to Far Bank Hamlet**: 60 wood, 20 ore, 300 coin. Players pledge
what they can (`project_contribute`, gas-free) and can take it back until it is complete (`project_withdraw`). When
every line is met, the contract burns the pledges and the server opens the hamlet on the shared map for everyone. The
bridge is left unbuilt on testnet so players can build it.

### Sign-in and keys

- Login is our own NEAR Auth deployment (Google or email, MPC owner key; `FASTAUTH_*` in `.env.example`, see
  [docs/fastauth-fork-plan.md](docs/fastauth-fork-plan.md)), or a plain Sign in with Google (`GOOGLE_CLIENT_ID`) that
  opens the same account. The NEAR Auth key is the player's full-access key and is used only to log in.
- Gameplay is signed by a session key in the browser: a function-call key on the game contract only. The relayer pays
  the gas with NEP-366 meta-transactions. Off-chain requests to the server are signed with the same key.
- The same login on a new browser plays at once; NEAR Auth approval is asked only the first time that device uses
  something on chain (market, gifts, shares, town projects).

## Try it

Run locally (below), open http://localhost:3000.

1. Press **Masuk** and sign in → pick a name and look → **Mulai**. You start in your Homeland with 100 coins, some bread
   and wheat, and four tools. No wallet popup.
2. Hold the fishing rod (hotbar), face a ripple on the water and press **F**; wait for the "!", press, and hold to keep
   the fish in the green zone → `+1 Fish`. A panel beside your character lists what **F** can do at the spot.
3. Press **I** (or the Bag button; **E** too in the 2D view, where it does not turn the camera) for the bag. Craft at a
   table (2 wheat → bread, 5 energy).
4. Walk into your Homeland's portal to reach the public village. Face a merchant's stall on the square → **Buy** and
   **Sell** tabs with the price, the merchant's reason and the exact total.
5. Open the Dev panel → **Settle now** → **History** (H) → tick technical mode → "Settlement day N" with a testnet
   explorer link. With the box unticked (the default) the game hardly mentions the chain.
   The Dev panel only appears on the machine running the server (`DEV_TOOLS=1` and a direct local request).
6. Settings > **Simulasi** → 7 game days of the real economy code in about a minute.
7. When a shop shows CLOSED, talk to its merchant → restoration board → pledge (on chain) → the shop reopens and your
   shares appear in the shop window.
8. Press **Pasar** (K) → list an item for other players (on-chain escrow), or buy someone's listing.
9. In your Homeland, open a forest or rock island, then Dev panel → **Lompat ke malam** and walk up to a boar or bats.
10. Mock server only (`npm run dev:mock`): Dev panel → **Beri bahan (mock)**, then the project board → pledge everything
    under the bridge → the bridge appears and the hamlet opens for everyone.

## Run locally

Requires Node 24 or later.

```bash
npm run setup
```

Mock chain (no NEAR account needed; everything is labelled "mock", and its data resets on every start):

```bash
npm run dev:mock
```

Testnet: copy `.env.example` to `.env`, fill it in, then run:

```bash
npm run dev
```

The local server runs on port 3000. `npm run dev:split` runs the hosted split on one machine (mock API on :3100, static
client on :5173). `npm test` runs the economy tests, the server tests and the typecheck; the contract is tested with
`cd contracts/game && cargo test`.

Hosting: one long-running Node process serves the client and the API ([docs/deploy.md](docs/deploy.md), `Dockerfile`,
`railway.json`). The server keeps SQLite; with `DATABASE_URL` set, a gzipped copy is saved to Postgres every 5 minutes
when it changed, after each settlement and on shutdown, and restored on a host with no disk (`server/src/snapshot.ts`).
`GET /api/health` reports settlement, database and the NEAR left for gas on the server's accounts.

Offline: `?mode=offline` replaces the server with an in-browser mock (gathering only, with a permanent banner).

## Architecture

See [docs/architecture.md](docs/architecture.md) for the diagram. In short: a static browser game (`/client`, plain
JS, no build step for game code), a Node/TypeScript server (`/server`) that runs the game loop, merchants, townsfolk,
relayer, settlement and merchant dialogue, a Rust NEP-245 contract (`/contracts/game`), and shared economy code
(`/economy`). The village and Homeland maps come from one seeded generator that runs in both the browser and the
server, so the server checks every action against where the player stands.

## Baseline vs. hackathon work (Q-003)

- Baseline: tag `pre-hackathon`, the unchanged prototype in [`prototype/`](prototype/) (published build of
  2026-10-25, see [prototype/BASELINE.md](prototype/BASELINE.md)). It has no blockchain code.
- Hackathon work: everything after that tag. Diff:
  https://github.com/leutenantKiya/Genesis-Town/compare/pre-hackathon...main

## AI-generated code and libraries (Q-005)

- The prototype was mostly written with AI assistance (Claude, as a claude.ai artifact).
- Hackathon work is written with Claude Code, using the NEAR agent skills `near-ai-cloud`, `near-api-js`, `near-dapp`,
  `near-intents`, `near-kit` and `near-smart-contracts` (https://github.com/near/agent-skills).
- Libraries: near-sdk 5.29 (Rust contract), near-sandbox 0.3.12 and near-api 0.8 (contract integration test),
  near-api-js 7.4.0 (server and browser), `@fast-auth-near/browser-sdk` 1.4.2 and `@fast-auth-near/javascript-provider`
  1.4.1 (NEAR Auth login), jose 6.2.14 (Auth0 token checks), borsh 2.0.0, esbuild 0.28.2 (browser bundle), three.js
  0.187.0 (2.5D view).
- AI used in the product: **Claude** (Anthropic Messages API, model `claude-sonnet-5-5`, low effort) writes the
  merchants' replies, and NEAR AI Cloud is the alternative provider; both are called with `fetch`, no SDK. The model's
  text is display-only and never triggers a trade, price change or chain action. Prices, the townsfolk and the
  merchants' market buying follow fixed rules in code.

## Known limits

- Testnet only. NEAR Intents has no testnet, so it is out of scope.
- The server runs every off-chain action; the chain checks each day's net totals and Merkle root, not every step. A
  modified client can still walk anywhere a player could walk.
- Items gathered or traded off-chain today are owned on chain only after the 06:00 settlement.
- The Player Market fee is burned by the contract *(to the town treasury: planned, needs a contract upgrade)*.
- Merchant dialogue needs `ANTHROPIC_API_KEY` or `NEARAI_API_KEY`; without either the server uses local lines. NEAR AI
  chat signatures (TEE attestation) are not verified in the client.
- The baseline is the 2026-10-25 published build. Later prototype work (to 2026-10-31) was in a local folder that
  wasn't available when this repository was created.

## License

MIT, see [LICENSE](LICENSE).
