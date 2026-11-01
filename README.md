# Genesis Town

> **Status (2026-11-01): milestone M2 done (Checkpoint 3).** The economy loop runs, and an end-to-end run on NEAR testnet
> passed:
> - off-chain play: gathering, energy, crafting, the farm plot, shipping, and trading with four merchants priced by
>   `economy/pricing.ts`;
> - one daily settlement written on chain, with the published ledger's Merkle root;
> - a merchant closed on chain after failing rent, and reopened through its restoration board, with shares issued.
>
> Also done: a full-window layout on desktop, browser fullscreen (F), and a settings menu (O) with rebindable keys.
> Not built yet: the fast-forward simulator and charts (M3), NEAR AI Cloud dialogue (M3), the player market (M3), and
> the warmer art pass. Anything marked *(planned)* does not exist yet.

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
  Full rule: [docs/economy.md §4](docs/economy.md#4-pricing-rule-economypricingts). Code: `economy/pricing.ts`
  *(planned)*, used by both live play and the fast-forward simulator.
- The only source of new coins is townsfolk buying finished goods. The contract caps it per day and throttles it as
  total coin supply approaches a cap, so the money supply is bounded. Sinks: shop rent, crafting fees, a 5%
  player-market fee, eaten food, tool wear.
- Gathering, farming, crafting and merchant trades are instant and off-chain. Once per game day (every 24 real
  minutes) one settlement transaction writes everyone's net change on chain, with a hash of the day's published ledger.
  Player-to-player trades and shop shares are on-chain immediately. See [docs/onchain-offchain.md](docs/onchain-offchain.md).
- Seasons (7 game days each) change what the land yields and what the town buys.
- A merchant that can't pay its daily rent closes. Players invest coins to reopen it and receive shares that pay 40%
  of the shop's daily profit as dividends.

Design docs: [game loop](docs/game-loop.md) · [economy](docs/economy.md) · [architecture](docs/architecture.md) ·
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
`pay_dividend`, `claim_dividends`, `send_item`. Full table: [contracts/game/README.md](contracts/game/README.md).

Example transactions from the M2 end-to-end run (`node server/scripts/e2e-testnet.ts`, server stopped):
- daily settlement of day 0 (45 ledger rows, root stored on chain):
  https://testnet.nearblocks.io/txns/GPBpcDqWgXxQdhkkNEFZJhaFAeFHwPPn2LKZHXJ9DDXq
- player A sends 1 Ikan to B, signed with A's session key and relayed gas-free:
  https://testnet.nearblocks.io/txns/HGh8cA8oYj7ACBSUPszmoXgPEdwARS4jtiuTgSRZ3bEn
- A pledges 200 coin, 10 Bijih and 5 Kayu to Budi's restoration board; the shop reopens and A gets shares:
  https://testnet.nearblocks.io/txns/DDVwUrvu9XB1AqWNLW2W5ynGLdUU92mL17pVbmvzfTQM

The run forced Budi's bankruptcy with ledger rows labelled `scripted` so the whole cycle fits in one run. In normal
play, bankruptcy comes from trading, which the M3 simulator will show.

## Try it in 5 minutes

Run locally (below), open http://localhost:3000.

1. Press **Masuk** and sign in with Google or email → you see your house, an energy bar, the season (Semi H1), and
   100 coins. No wallet popup.
2. Walk to the pond, face the water and press **Space** (the on-screen **A** button on touch screens) → `+1 Ikan`
   instantly. A hint at the bottom of the screen always shows which key does what for the tile you face. Open **Tas NEAR** (N) → it shows "+1 hari ini" (off-chain,
   today).
3. Walk to the market just south of your house and talk to **Sari** → prices with a reason under each item. Sell your
   fish.
4. Inside your house, press Space at the table to craft (2 Gandum → Roti), and at the chest to use the Kotak Kirim.
   Outside, press Space on the plot tiles next to your house to till, plant (press twice) and water wheat.
5. Open the Dev panel → **Settle sekarang** → Riwayat (H) shows "Settlement hari N" with a testnet explorer link,
   and everything from step 2 now points to it.
6. *(planned, M3)* Press **Simulate 1 week** → price and cash charts move; Budi goes bankrupt during the week.
7. When a shop shows TUTUP, talk to its merchant → restoration board → **Sumbang** (on-chain) → the shop reopens and
   your shares appear in the shop window.

## Run locally

Requires Node 24 or later.

```bash
npm run setup
```

Mock chain (no NEAR account needed; everything is labelled "mock"). Open http://localhost:3000 and press **Masuk**:

```bash
npm run dev:mock
```

Testnet *(planned, after the M1 deploy)*: copy `.env.example` to `.env`, fill it in, then run:

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
- Libraries will be listed here with versions as they are added. Planned: near-sdk (Rust), near-sandbox,
  near-api-js, NEAR Auth SDK (`@fast-auth-near/*`).

## Known limits

- Design stage: nothing on-chain exists yet.
- The baseline is the 2026-10-25 published build. Later prototype work (to 2026-10-31) was in a local folder that
  wasn't available when this repository was created.
- Items gathered or traded off-chain today are owned on chain only after the 06:00 settlement. "Simpan sekarang"
  (settle my bag early) is planned.
- The server trusts the account header for off-chain play (rate limited); session-key-signed requests come in M4.
- Gathering does not yet check the player's position against the map (M4).
- Pure offline mode (`?mode=offline`) supports gathering only. For the full game without testnet, run `npm run dev:mock`.
- The warmer art pass and fullscreen/keybind settings are designed but scheduled after the economy loop works.
- Testnet only. NEAR Intents has no testnet, so it is out of scope unless approved as a mainnet stretch.

## License

MIT, see [LICENSE](LICENSE).
