# Genesis Town

> **Status (2026-11-01): milestone M1 done (Checkpoint 2).** The game contract is deployed on NEAR testnet, and the
> M1 loop has been checked on testnet in two ways:
> - **Scripted:** account creation, a batched gather mint, and a gas-free player transfer signed by a session key.
> - **By hand in the browser:** Google sign-in through NEAR Auth created a player account (NEAR Auth key as full
>   access, plus a game-only session key), and gathering 3 Ikan at the pond was minted in one batch transaction:
>   https://testnet.nearblocks.io/txns/CNhfxPAQCAzkW8XsDoSo1R7MSar8LsJyKc3PCj7sDyxt
>
> Anything marked *(planned)* does not exist yet.

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
- A merchant that can't pay its daily rent closes. Players invest coins to reopen it and receive shares that pay 40%
  of the shop's daily profit as dividends.

Design docs: [game loop](docs/game-loop.md) · [economy](docs/economy.md) · [architecture](docs/architecture.md) ·
[threat model](docs/threat-model.md) · [sources](docs/sources.md)

## What is on-chain (NEAR testnet)

| Thing | Account | Notes |
| --- | --- | --- |
| Game contract (NEP-245 items + `coin`, NEP-145 storage) | [`game.genesistown.testnet`](https://testnet.nearblocks.io/address/game.genesistown.testnet) | source: [contracts/game](contracts/game) |
| Relayer (pays players' gas, NEP-366) | [`relayer.genesistown.testnet`](https://testnet.nearblocks.io/address/relayer.genesistown.testnet) | |
| Gather minter (function-call key: `mint_gathered`, `register_player` only) | [`minter.genesistown.testnet`](https://testnet.nearblocks.io/address/minter.genesistown.testnet) | |
| Player accounts | `p<hash>.players.genesistown.testnet` | full-access key = the player's NEAR Auth key; plus a game-only session key |

Contract methods: NEP-245 `mt_transfer`, `mt_batch_transfer`, `mt_transfer_call`, `mt_batch_transfer_call`,
`mt_token`, `mt_balance_of`, `mt_batch_balance_of`, `mt_supply`, `mt_batch_supply`; NEP-145 `storage_*`. Game
methods so far: `register_player`, `mint_gathered`, `send_item`. Table: [contracts/game/README.md](contracts/game/README.md).

Example transactions from the M1 end-to-end run (`node server/scripts/e2e-testnet.ts`):
- batch mint of 3 Ikan: https://testnet.nearblocks.io/txns/9rQEcKUNzgQnVPsEx4FAKXv1X8FvLnGDqNNko58T47Tu
- player A sends 1 Ikan to B, signed with A's session key and relayed gas-free:
  https://testnet.nearblocks.io/txns/HbhpvdLJU9Yja5hsMKFYm9ZnPAPPGgSLfBXGvV9pRcuh

## Try it in 5 minutes *(planned, steps become real as milestones land)*

1. Open the demo URL *(TBD)* and press **Masuk**, signing in with email → see your house, 100 coins, an Alat and
   3 Roti. No wallet popup.
2. Walk to the pond and press A → see `+1 Ikan`, and a Riwayat (history) entry with a testnet explorer link.
3. Sell 10 Ikan to merchant Sari → see her fish price fall over the next game hours, with her reason in the tooltip.
4. Press **Simulate 1 week** → watch the price charts move; merchant Budi's smithy goes bankrupt during the week.
5. Invest 50 coins in Budi's shop → the shop reopens and your share appears in Profile.

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
- Testnet only. NEAR Intents has no testnet, so it is out of scope unless approved as a mainnet stretch.

## License

MIT, see [LICENSE](LICENSE).
