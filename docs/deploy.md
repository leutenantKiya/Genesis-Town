# Deploying Genesis Town (testnet)

The public game still runs on NEAR testnet. One Node 24 process serves the client (plain static files), the API and
the game loop; SQLite holds the off-chain day on a persistent disk. There is no framework build: the only build step
bundles the NEAR browser libraries into `client/vendor/near.js`, and the `Dockerfile` does it.

## What the host must offer

- Node 24 or Docker (the repo's `Dockerfile` pins `node:24.22.1-bookworm-slim`).
- **A persistent disk** mounted at `/data`. Without it every restart loses today's off-chain progress and the history.
- **A process that stays on** (no sleeping when idle). The game clock ticks every 2 seconds and settles on chain every
  24 real minutes.
- **One instance only.** SQLite and the game loop are single-process; never scale to two replicas.
- HTTPS and environment variables / secrets (every common host has both).

Examples that fit: Railway, Render (with a disk), Fly.io (with a volume), or any small VPS with Docker.
Vercel does not fit (no long-running process, no persistent disk).

## Only one server per contract

The hosted server and the one on your machine would both settle the same days with the same settler key, each from
its own database. **Stop the local testnet server before the hosted one starts**, and keep it stopped. A local server
in mock mode (`npm run dev:mock`) is fine: it never touches testnet.

## Environment variables

Set these in the host's environment / secrets settings. The values are the same as in your local `.env`; the
private keys are typed by you into the host, never committed and never put in a file in the repo.

| Name | Value on the host |
| --- | --- |
| `NEAR_NETWORK` | `testnet` |
| `NEAR_RPC_URL` | empty (uses `https://test.rpc.fastnear.com`) |
| `GAME_CONTRACT_ID` | as in `.env` |
| `RELAYER_ACCOUNT_ID`, `RELAYER_PRIVATE_KEYS` | as in `.env` (**secret**) |
| `SETTLER_ACCOUNT_ID`, `SETTLER_PRIVATE_KEY` | as in `.env` (**secret**) |
| `TOWN_ACCOUNT_ID`, `TOWN_PRIVATE_KEY` | as in `.env` (**secret**) |
| `PLAYERS_PARENT_ACCOUNT_ID`, `PLAYERS_PARENT_PRIVATE_KEY` | as in `.env` (**secret**) |
| `MERCHANT_PARENT_ACCOUNT_ID` | as in `.env` |
| `WORLD_SEED` | empty (keeps the current village) |
| `FASTAUTH_CLIENT_ID`, `FASTAUTH_DOMAIN` | empty, or the client id and Auth0 domain NEAR Auth gives for the public domain (see Login below) |
| `ANTHROPIC_API_KEY` | optional (**secret**); Claude writes merchant replies; without any AI key merchants answer with local lines |
| `DIALOGUE_PROVIDER` | empty (`anthropic` if the Anthropic key is set, else `nearai` if its key is set, else `local`), or `anthropic` / `nearai` / `local` |
| `DIALOGUE_MODEL` | empty (default `claude-sonnet-5-5`, low effort) |
| `NEARAI_API_KEY` | optional (**secret**); NEAR AI Cloud as the alternative provider |
| `DEV_TOOLS` | **empty** |
| `TRUST_PROXY` | `1` when the host puts a proxy in front (Railway, Render, Fly, nginx); **empty** when the container is reached directly (`docker run -p` on a VPS), or a client could fake `X-Forwarded-For` and dodge the per-address limits |
| `PORT` | usually set by the host; the Dockerfile defaults to 3000 |
| `DB_PATH` | `/data/genesis-town.db` (the Dockerfile sets it) |

Dev tools stay closed on a host even if `DEV_TOOLS=1` is left on: they only answer direct requests from the same
machine with no proxy headers.

## Steps

1. Create a service from the GitHub repo using the `Dockerfile`, one instance, with a persistent volume at `/data`.
2. Set the environment variables above. Set the health check path to `/api/health`.
3. Carry the current game over: stop the local testnet server (Ctrl+C, so SQLite checkpoints its WAL), then copy
   `data/genesis-town.db` to `/data/genesis-town.db` on the volume (the host's volume upload, `scp` on a VPS, or a
   one-off shell). Without this step the hosted game starts with a fresh off-chain database: on-chain balances are
   still read from the contract, but today's off-chain progress, plots and history are not.
4. Deploy, then check:
   - `GET /api/health` returns `{"ok":true,"chain":"testnet",...}` and `settledThrough` catches up within minutes;
   - `GET /api/config` shows `"devTools":false`;
   - the page loads, and Masuk opens NEAR Auth (see Login below).

## Login on the public domain

The shared NEAR Auth testnet client accepted only `http://localhost:3000` as a callback when probed on 2026-10-31
(docs/sources.md). The NEAR Auth docs document no testnet allow-list or request process; the only documented
request process is the mainnet application form (https://docs.auth.near.org/home/apply.md), which issues a
dedicated domain, client id and signing audience. So test Masuk on the public URL right after the first deploy; if
NEAR Auth refuses the domain, ask the NEAR Auth team (or the hackathon organisers) to allow it for testnet, and set
`FASTAUTH_CLIENT_ID` / `FASTAUTH_DOMAIN` if they issue new credentials.

## Updating

Push to the branch the host deploys from; the service rebuilds and restarts. A restart is safe at any time: missed
days are settled on start, and the service worker fetches the new client code on the next load.
