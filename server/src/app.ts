// HTTP routes (node:http, no framework). Also serves the static client.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import type { Config } from './config.ts';
import type { Chain } from './chain.ts';
import type { Store } from './db.ts';
import { register, HttpError, type TokenVerifier } from './auth.ts';
import { relay, RateLimiter } from './relayer.ts';
import type { Game } from './game/game.ts';
import { leafHash, merkleProof, merkleRoot } from './game/merkle.ts';

export interface AppDeps {
  cfg: Config;
  chain: Chain;
  store: Store;
  game: Game;
  verify: TokenVerifier;
  currentBlockHeight: () => Promise<bigint>;
  clientDir: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 16_384) throw new HttpError(413, 'body too large');
    chunks.push(c as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new HttpError(400, 'bad json'); }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

export function createApp(deps: AppDeps) {
  const { game } = deps;
  const limiter = new RateLimiter(deps.cfg.relay.perMinute, deps.cfg.relay.perDay);
  const actLimiter = new RateLimiter(60, 5000); // off-chain actions per account
  const ipLimiter = new RateLimiter(10, 200); // account creation per IP
  const clientRoot = resolve(deps.clientDir);
  const afterRelay = async (sender: string, method: string, args: Record<string, unknown>) => {
    const accts = [sender];
    if (method === 'send_item' && typeof args.receiver_id === 'string') accts.push(args.receiver_id);
    if (typeof args.merchant === 'string') accts.push(args.merchant);
    await game.settlement.refresh(accts);
    if (method.startsWith('restore')) await game.settlement.refreshShops();
  };

  // M2 trusts the account id header for off-chain play by a registered player (rate limited). Signed requests with
  // the session key are planned for M4 hardening (docs/threat-model.md).
  function accountOf(req: IncomingMessage): string {
    const a = req.headers['x-account-id'];
    if (typeof a !== 'string' || !deps.store.db.prepare('SELECT 1 FROM players WHERE account_id = ?').get(a)) {
      throw new HttpError(401, 'not signed in');
    }
    return a;
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    if (p.startsWith('/api/')) {
      if (req.method === 'GET' && p === '/api/config') {
        return send(res, 200, {
          chainMode: deps.chain.mode,
          gameContractId: deps.cfg.gameContractId,
          explorerTxUrl: deps.cfg.explorerTxUrl,
          rpcUrl: deps.cfg.rpcUrl,
          fastAuth: deps.cfg.fastAuth,
          devLogin: deps.cfg.devLogin,
          devTools: deps.cfg.devTools,
          econ: { items: game.econ.items, recipes: game.econ.recipes, gather: game.econ.gather, farm: game.econ.farm, time: game.econ.time },
        });
      }
      if (req.method === 'POST' && p === '/api/auth/register') {
        const ip = req.socket.remoteAddress ?? '?';
        if (!ipLimiter.take(ip)) throw new HttpError(429, 'too many sign-ups from this address');
        return send(res, 200, await register({ ...deps, onNewPlayer: (a) => game.onNewPlayer(a) }, await readJson(req)));
      }
      if (req.method === 'POST' && p === '/api/relay') {
        return send(res, 200, await relay({ ...deps, limiter, afterRelay }, await readJson(req)));
      }
      if (req.method === 'GET' && p === '/api/time') {
        return send(res, 200, { ...game.clock.time(), fraction: game.clock.hourFraction(), settledThrough: game.settlement.settledThrough() });
      }
      if (req.method === 'GET' && p === '/api/state') {
        return send(res, 200, game.state(accountOf(req)));
      }
      if (req.method === 'POST' && p === '/api/act') {
        const acct = accountOf(req);
        if (!actLimiter.take(acct)) throw new HttpError(429, 'Pelan-pelan… terlalu banyak aksi');
        return send(res, 200, game.act(acct, await readJson(req)));
      }
      if (req.method === 'GET' && p === '/api/market') {
        return send(res, 200, { merchants: game.merchants() });
      }
      if (req.method === 'GET' && p === '/api/quote') {
        const q = url.searchParams;
        const side = q.get('side') === 'buy' ? 'buy' : 'sell';
        return send(res, 200, game.market.quote(q.get('merchant') ?? '', q.get('token') ?? '', side, Number(q.get('qty') ?? 1)));
      }
      if (req.method === 'GET' && p === '/api/shops') {
        const a = req.headers['x-account-id'];
        return send(res, 200, { shops: await game.shops(typeof a === 'string' ? a : undefined) });
      }
      if (req.method === 'GET' && p === '/api/history') {
        const acct = accountOf(req);
        return send(res, 200, { history: deps.store.history(acct), explorerTxUrl: deps.cfg.explorerTxUrl });
      }
      const m = /^\/api\/ledger\/(\d+)$/.exec(p);
      if (req.method === 'GET' && m) {
        // The full off-chain ledger of a game day, with its Merkle root (stored on chain by settle_day).
        const day = Number(m[1]);
        const rows = game.gs.dayRows(day).map(({ seq, day: d, account, token, delta, kind, ref }) => ({ seq, day: d, account, token, delta, kind, ref }));
        const leaves = rows.map(leafHash);
        const proofFor = url.searchParams.get('proof');
        const proofs = proofFor ? rows.map((r, i) => (r.account === proofFor ? { seq: r.seq, index: i, proof: merkleProof(leaves, i) } : null)).filter(Boolean) : undefined;
        return send(res, 200, { day, root: merkleRoot(leaves), rows, proofs, settlements: game.gs.settlements(50).filter((s) => (s as { day: number }).day === day) });
      }
      if (req.method === 'POST' && p === '/api/dev/settle') {
        if (!deps.cfg.devTools) throw new HttpError(403, 'dev tools are off');
        return send(res, 200, await game.devSettle());
      }
      throw new HttpError(404, 'no such route');
    }
    // Static client.
    const rel = p === '/' ? '/index.html' : p;
    const file = normalize(join(clientRoot, decodeURIComponent(rel)));
    if (!file.startsWith(clientRoot)) throw new HttpError(403, 'forbidden');
    try {
      if (!(await stat(file)).isFile()) throw new Error();
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      return res.end(await readFile(file));
    } catch {
      throw new HttpError(404, 'not found');
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      send(res, status, { error: e instanceof HttpError ? e.message : 'internal error' });
    });
  });
  return { server };
}
