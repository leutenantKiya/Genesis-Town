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
>
>   A returning player on a new browser adds a game key signed with their own NEAR Auth login (new-device flow).
>
> Not done yet: the rest of M4 (removing the game account's full-access key before
> submission, a mobile pass) and M5 (demo video, submission). Anything marked *(planned)* does not exist yet.

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
   instantly. A hint at the bottom of the screen always shows which key does what for the tile you face. Open **Tas NEAR** (N) → it shows "+1 hari ini" (off-chain,
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
