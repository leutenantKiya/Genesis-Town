// HTTP routes (node:http, no framework). Also serves the static client.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import type { Config } from './config.ts';
import type { Chain } from './chain.ts';
import type { Store } from './db.ts';
import { register, HttpError, type TokenVerifier } from './auth.ts';
import { relay, RateLimiter } from './relayer.ts';
import { Minter, GATHERABLE } from './minter.ts';

export interface AppDeps {
  cfg: Config;
  chain: Chain;
  store: Store;
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
  const limiter = new RateLimiter(deps.cfg.relay.perMinute, deps.cfg.relay.perDay);
  const minter = new Minter(deps);
  const ipLimiter = new RateLimiter(10, 200); // account creation per IP
  const clientRoot = resolve(deps.clientDir);

  // Session check for gather/history: the browser proves it holds a registered session key's account id.
  // M1 trusts the account id header for read-only history and rate-limited gathering; signed requests come in M2.
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
          items: GATHERABLE,
          devLogin: deps.cfg.devLogin,
        });
      }
      if (req.method === 'POST' && p === '/api/auth/register') {
        const ip = req.socket.remoteAddress ?? '?';
        if (!ipLimiter.take(ip)) throw new HttpError(429, 'too many sign-ups from this address');
        return send(res, 200, await register(deps, await readJson(req)));
      }
      if (req.method === 'POST' && p === '/api/relay') {
        return send(res, 200, await relay({ ...deps, limiter }, await readJson(req)));
      }
      if (req.method === 'POST' && p === '/api/gather') {
        const acct = accountOf(req);
        const body = await readJson(req);
        return send(res, 200, minter.gather(acct, String(body.item ?? '')));
      }
      if (req.method === 'GET' && p === '/api/history') {
        const acct = accountOf(req);
        return send(res, 200, { history: deps.store.history(acct), explorerTxUrl: deps.cfg.explorerTxUrl });
      }
      if (req.method === 'GET' && p === '/api/balances') {
        const acct = accountOf(req);
        const ids = Object.keys(GATHERABLE);
        const bal = await deps.chain.balances(acct, ids);
        return send(res, 200, { accountId: acct, balances: Object.fromEntries(ids.map((t, i) => [t, bal[i]])) });
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
  return { server, minter };
}
