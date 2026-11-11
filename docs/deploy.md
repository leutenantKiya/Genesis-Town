# Deploying Genesis Town (testnet)

The public game still runs on NEAR testnet. One Node 24 process serves the client (plain static files), the API and
the game loop; SQLite holds the off-chain day on a persistent disk. There is no framework build: the only build step
bundles the NEAR browser libraries into `client/vendor/near.js`, and the `Dockerfile` does it.

## What the host must offer

- Node 24 or Docker (the repo's `Dockerfile` pins `node:24.22.1-bookworm-slim`).
- **A persistent disk** mounted at `/data`, **or** a Neon Postgres database (`DATABASE_URL`, see "Database copy in
  Neon" below). With neither, every restart loses today's off-chain progress and the history.
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
| `GOOGLE_CLIENT_ID` | the Google OAuth client id for "Masuk dengan Google" (see Login below); empty hides the button |
| `ANTHROPIC_API_KEY` | optional (**secret**); Claude writes merchant replies; without any AI key merchants answer with local lines |
| `DIALOGUE_PROVIDER` | empty (`anthropic` if the Anthropic key is set, else `nearai` if its key is set, else `local`), or `anthropic` / `nearai` / `local` |
| `DIALOGUE_MODEL` | empty (default `claude-sonnet-5-5`, low effort) |
| `NEARAI_API_KEY` | optional (**secret**); NEAR AI Cloud as the alternative provider |
| `DEV_TOOLS` | **empty** |
| `TRUST_PROXY` | `1` (the Dockerfile sets it) |
| `PORT` | usually set by the host; the Dockerfile defaults to 3000 |
| `DB_PATH` | `/data/genesis-town.db` (the Dockerfile sets it) |
| `CORS_ORIGINS` | empty, or the client's origin when it is hosted apart (see the split setup below) |
| `DATABASE_URL` | optional (**secret**): Neon's **direct** connection string (host without `-pooler`), see below; `DATABASE_URL_UNPOOLED` wins when both are set (as `neon env pull` writes them) |
| `SNAPSHOT_MINUTES` | empty (5): how often the database copy is saved to Neon when something changed |
| `FUNDS_LOW_NEAR` | empty (0.25): warn when the settler, relayer or players' parent account has less NEAR than this left for gas |

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
   - `GET /api/health` returns `{"ok":true,"chain":"testnet",...}` and `settledThrough` catches up within minutes
     (days on which nothing happened close without a transaction, so even a long pause catches up in seconds);
     `funds` lists the NEAR left for gas on the settler, relayer and players' parent, and `funds.low` names any that
     needs topping up;
   - `GET /api/config` shows `"devTools":false`;
   - the page loads, and Masuk opens NEAR Auth (see Login below).

## Split setup: client on Vercel, server on Railway

The client is plain static files, so it can live on a CDN while the Node server (API, game loop, SQLite) stays on a
host with a persistent process. The browser calls the server **directly** (cross-origin), not through a Vercel
rewrite: behind a rewrite every request would reach the server from Vercel's address, and the per-address limits
(account creation, chat) would treat all players as one visitor.

**Server on Railway** (`railway.json` + `Dockerfile` in the repo):

1. New project, Deploy from GitHub repo; Railway reads `railway.json` (Dockerfile build, health check `/api/health`).
2. Add a Volume to the service, mount path `/data`. Set `RAILWAY_RUN_UID=0`: the image runs as user `node`, and
   Railway volumes are owned by root.
3. Set the environment variables from the table above, plus `CORS_ORIGINS=https://<your-app>.vercel.app` (add
   custom domains too, comma separated). Keep one replica, and pick the region closest to the players (Singapore).
4. Settings → Networking → Generate Domain. This URL is `GT_API_BASE` below.

**Client on Vercel** (`vercel.json` in the repo):

1. Import the same GitHub repo, root directory = repo root. `vercel.json` sets install, build and output (`client/`).
2. Environment variable `GT_API_BASE=https://<service>.up.railway.app` (no trailing slash), then deploy. The build
   writes it into `client/vendor/env.js`; changing it needs a redeploy.
3. Open the Vercel URL: the mode banner should say testnet (or mock), not offline. If it says offline, check the
   browser console for a CORS error and compare `CORS_ORIGINS` with the exact page origin.

To try the split on one machine first: `npm run dev:split` (mock server on :3100 with `CORS_ORIGINS`, the static
client on :5173 whose `vendor/env.js` points at it; `API_PORT` / `WEB_PORT` change the ports).

The landing page lives in its own repository and its own Vercel project (e.g. the bare domain); its play button links
to this client (e.g. a `play.` subdomain). Only the game client's origin goes in `CORS_ORIGINS` and in NEAR Auth's
callbacks: the landing page never calls the API. The server itself cannot run on Vercel: it keeps a game loop (every 2
s), settles on chain every 24 real minutes and holds presence in memory, while Vercel functions stop after each request.

The Railway URL still serves the whole game on its own, so it keeps working as a fallback. NEAR Auth must accept the
Vercel domain as a callback (next section).

## Database copy in Neon

The server works on SQLite either way. With `DATABASE_URL` set (testnet chain only; the mock chain starts fresh every
time and ignores it), `server/src/snapshot.ts` keeps a gzipped copy of the whole database in one Neon row (table
`gt_snapshot`, keyed by `GAME_CONTRACT_ID`):

- **at start**, if the host has no database file (no volume, or a fresh deploy), it loads the copy before the server
  opens the database; if Neon cannot be reached then, the server refuses to start rather than run on an empty day;
- **every `SNAPSHOT_MINUTES`** (5) when something changed, **right after each daily settlement**, and **when the
  host stops the process** (SIGTERM, as on every redeploy), it saves a new copy. The copy is made with node:sqlite's
  `backup()`, which does not block the game loop; a copy is about 100 KB after ten days of testnet play.
- At most `SNAPSHOT_MINUTES` of off-chain play can be lost if the process dies without warning. Items and coin settled
  on chain are never at risk.
- `GET /api/health` shows `snapshot`: when it last saved, the size and the last error.

Setting it up (driver: `pg`, as the Neon docs advise for a long-running Node server):

1. In Neon, create a project with **Postgres only** (no object storage, functions, AI gateway, realtime or auth),
   region **AWS Asia Pacific 1 (Singapore)**, the same region as the Railway service.
2. Connect → copy the connection string with **connection pooling off** (the host has no `-pooler`). You enter it
   yourself into Railway as `DATABASE_URL` (a secret); it never goes into the repo or a file.
3. First deploy only: to carry the current testnet game over, either upload `data/genesis-town.db` to the volume (step
   3 above) or start the server once on your machine with `DATABASE_URL` in `.env` (after stopping the local testnet
   server cleanly) so it saves the current database to Neon; then stop it before the hosted one starts.
4. With Neon, the Railway volume is optional; keeping it too makes a restart independent of Neon.

## Login on the public domain

The shared NEAR Auth testnet client accepted only `http://localhost:3000` as a callback when probed on 2026-10-31
(docs/sources.md). The NEAR Auth docs document no testnet allow-list or request process; the only documented
request process is the mainnet application form (https://docs.auth.near.org/home/apply.md), which issues a
dedicated domain, client id and signing audience. So test Masuk on the public URL right after the first deploy; if
NEAR Auth refuses the domain, ask the NEAR Auth team (or the hackathon organisers) to allow it for testnet, and set
`FASTAUTH_CLIENT_ID` / `FASTAUTH_DOMAIN` if they issue new credentials.

On 2026-11-11 the Railway domain got "Callback URL mismatch" from NEAR Auth, as expected. The NEAR Auth request form
is https://form.typeform.com/to/VWHjf3HV (the only contact the docs give). Meanwhile **Masuk dengan Google** works
there without NEAR:

1. https://console.developers.google.com/auth/clients → Create client → Application type **Web application**.
2. Authorized JavaScript origins: the game client's origin(s), scheme and host only (e.g.
   `https://genesistown.up.railway.app`), plus `http://localhost:3000` and `http://localhost` for local tests.
3. Fill in the Branding page (app name, support email). The default scopes (email, profile, openid) are enough.
4. Set `GOOGLE_CLIENT_ID` on the server. No client secret is used.

The server checks Google's ID token itself (`server/src/auth.ts` `googleVerifier`) and stores the player as
`google-oauth2|<Google sub>`, which is how NEAR Auth's tenant names the same Google user (seen in our own players
table). Check once before relying on it: on localhost sign in with one Google account through both buttons and
confirm both land on the same `p….players` account. A Google player on a second device needs the owner key (NEAR
Auth) to add a game key, so that step waits for NEAR Auth to accept the domain.

## Updating

Push to the branch the host deploys from; the service rebuilds and restarts. A restart is safe at any time: missed
days are settled on start, and the service worker fetches the new client code on the next load.
