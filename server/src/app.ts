// HTTP routes (node:http, no framework). Also serves the static client.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { MARKET_FEE_BPS, type Config } from './config.ts';
import type { Chain } from './chain.ts';
import type { Store } from './db.ts';
import { register, HttpError, type TokenVerifier } from './auth.ts';
import { relay, RateLimiter } from './relayer.ts';
import { spendGuard } from './spend.ts';
import { Dialogue } from './dialogue.ts';
import { ReplayCache, verifyRequest } from './reqauth.ts';
import { addDeviceKey } from './newdevice.ts';
import { Presence, validName, worldIdOk } from './presence.ts';
import { Bazaar } from './game/bazaar.ts';
import type { Game } from './game/game.ts';
import { leafHash, merkleProof, merkleRoot } from './game/merkle.ts';
import { Worker } from 'node:worker_threads';
import type { SimResult } from './game/sim.ts';

// Fast-forward simulations (off-chain, mock chain, same game code): run in a worker, cached by parameters.
const simCache = new Map<string, Promise<SimResult>>();
function simulate(days: number, players: number, seed: number): Promise<SimResult> {
  const key = `${days}:${players}:${seed}`;
  let p = simCache.get(key);
  if (!p) {
    p = new Promise<SimResult>((resolve, reject) => {
      const w = new Worker(new URL('./game/sim-worker.ts', import.meta.url), { workerData: { days, players, seed } });
      w.once('message', (r: SimResult) => { resolve(r); void w.terminate(); });
      w.once('error', reject);
    });
    p.catch(() => simCache.delete(key));
    if (simCache.size > 20) simCache.delete(simCache.keys().next().value as string);
    simCache.set(key, p);
  }
  return p;
}

export interface AppDeps {
  cfg: Config;
  chain: Chain;
  store: Store;
  game: Game;
  verify: TokenVerifier;
  currentBlockHeight: () => Promise<bigint>;
  clientDir: string;
  dialogue?: Dialogue;
  presence?: Presence;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

async function readRaw(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 16_384) throw new HttpError(413, 'body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function parseJson(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw || '{}'); } catch { throw new HttpError(400, 'bad json'); }
}
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> { return parseJson(await readRaw(req)); }

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

export function createApp(deps: AppDeps) {
  const { game } = deps;
  const limiter = new RateLimiter(deps.cfg.relay.perMinute, deps.cfg.relay.perDay);
  const actLimiter = new RateLimiter(60, 5000); // off-chain actions per account
  const ipLimiter = new RateLimiter(10, 200); // account creation per IP
  const posLimiter = new RateLimiter(240, 100000);
  const talkLimiter = new RateLimiter(6, 150);
  const deviceLimiter = new RateLimiter(3, 20); // new-device key additions per IP (each costs the relayer a NEAR Auth sign call) // merchant questions per account (each may be one NEAR AI call)
  const dialogue = deps.dialogue ?? new Dialogue(deps.cfg.nearai);
  const clientRoot = resolve(deps.clientDir);
  const checkSpend = spendGuard(deps.chain, game);
  const bazaar = new Bazaar(deps.store.db);
  const afterRelay = async (sender: string, method: string, args: Record<string, unknown>, extra: string[], relayBody: Record<string, unknown> = {}) => {
    const accts = [sender, ...extra];
    if (method === 'send_item' && typeof args.receiver_id === 'string') accts.push(args.receiver_id);
    if (typeof args.merchant === 'string') accts.push(args.merchant);
    await game.settlement.refresh(accts);
    if (method.startsWith('restore')) await game.settlement.refreshShops();
    if (method === 'project_contribute') await game.syncProjects();
    // the player market's two sides: remember Lapak or Pasar Gelap for a new listing; a Lapak sale earns popularity
    if (method === 'list_item') bazaar.recordListing(await deps.chain.listListings(50), sender, args, relayBody.anonymous === true);
    if (method === 'buy_listing' && extra[0]) bazaar.recordSale(Number(args.listing_id), extra[0], Number(args.amount));
  };

  // Live presence and chat (src/presence.ts): in memory, per world.
  const presence = deps.presence ?? new Presence((a) => deps.store.nameOf(a));
  const chatIpLimiter = new RateLimiter(30, 2000);
  const streams = new Map<string, number>();
  const worldOf = (v: unknown) => (v == null || v === '' ? 'public' : worldIdOk(v) ? v : (() => { throw new HttpError(400, 'bad world'); })());
  /** Records where a player says they stand (position already validated by the caller or checked here). */
  function feedPresence(acct: string, world: string, pos: { x?: unknown; y?: unknown } | null | undefined, dir: unknown, scene: unknown) {
    const x = Number(pos?.x), y = Number(pos?.y);
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 255 || y > 255) return;
    if (world === 'public' && game.map && !game.map.walkable(x, y)) return;
    if (!presence.access(acct, world)) return;
    presence.update(acct, world, { x, y }, String(dir ?? ''), String(scene ?? 'out'));
  }

  // Off-chain play is signed with the player's session key (src/reqauth.ts); the account header alone proves nothing.
  const replay = new ReplayCache();
  function accountOf(req: IncomingMessage, url: URL, raw = ''): string {
    return verifyRequest({ sessionKeyOwner: (k) => deps.store.sessionKeyOwner(k), replay }, req.headers, req.method ?? 'GET', url.pathname + url.search, raw);
  }

  /** Dev tools (clock jump, forced settlement) only answer the owner's own machine: DEV_TOOLS=1 and a direct loopback
   *  request with no proxy header. On a public host they stay closed even if the flag is left on by mistake. */
  function devAllowed(req: IncomingMessage) {
    if (!deps.cfg.devTools) return false;
    if (req.headers['x-forwarded-for'] || req.headers['forwarded'] || req.headers['x-real-ip']) return false;
    const ip = req.socket.remoteAddress ?? '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
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
          devTools: devAllowed(req),
          dialogue: dialogue.enabled ? 'nearai' : 'local',
          world: game.map?.view() ?? null,
          econ: { items: game.econ.items, recipes: game.econ.recipes, gather: game.econ.gather, farm: game.econ.farm, time: game.econ.time },
          monsters: game.monsters ? { fightEnergy: game.econ.monsters.fightEnergy, fleeEnergy: game.econ.monsters.fleeEnergy, nightFrom: game.econ.monsters.nightFrom, nightTo: game.econ.monsters.nightTo, roaming: game.econ.monsters.roaming, reach: game.econ.monsters.reach } : null,
        });
      }
      if (req.method === 'POST' && p === '/api/auth/register') {
        const ip = req.socket.remoteAddress ?? '?';
        if (!ipLimiter.take(ip)) throw new HttpError(429, 'too many sign-ups from this address');
        return send(res, 200, await register({ ...deps, onNewPlayer: (a) => game.onNewPlayer(a) }, await readJson(req)));
      }
      if (req.method === 'POST' && p === '/api/auth/add-key') {
        const ip = req.socket.remoteAddress ?? '?';
        if (!deviceLimiter.take(ip)) throw new HttpError(429, 'too many new-device requests');
        return send(res, 200, await addDeviceKey(deps, await readJson(req)));
      }
      if (req.method === 'POST' && p === '/api/relay') {
        const body = await readJson(req);
        const after = (s: string, m: string, a: Record<string, unknown>, e: string[]) => afterRelay(s, m, a, e, body);
        return send(res, 200, await relay({ ...deps, limiter, checkSpend, afterRelay: after, itemName: (t) => game.econ.items[t]?.name ?? t }, body));
      }
      if (req.method === 'GET' && p === '/api/time') {
        return send(res, 200, { ...game.clock.time(), fraction: game.clock.hourFraction(), settledThrough: game.settlement.settledThrough(), world: game.map ? { seed: game.map.seed, unlocked: game.map.unlocked } : null, weather: game.weather() });
      }
      if (req.method === 'GET' && p === '/api/state') {
        const acct = accountOf(req, url);
        const qx = url.searchParams.get('x'), qy = url.searchParams.get('y');
        if (qx !== null && qy !== null) { game.reportPosition(acct, { x: Number(qx), y: Number(qy) }); feedPresence(acct, worldOf(url.searchParams.get('world')), { x: qx, y: qy }, url.searchParams.get('dir'), url.searchParams.get('scene')); }
        return send(res, 200, { ...game.state(acct), name: deps.store.nameOf(acct) });
      }
      if (req.method === 'POST' && p === '/api/act') {
        const raw = await readRaw(req);
        const acct = accountOf(req, url, raw);
        if (!actLimiter.take(acct)) throw new HttpError(429, 'Pelan-pelan… terlalu banyak aksi');
        const ab = parseJson(raw), out = game.act(acct, ab);
        feedPresence(acct, worldOf(ab.world), ab.pos as { x?: unknown; y?: unknown } | undefined, ab.dir, ab.scene);
        return send(res, 200, out);
      }
      if (req.method === 'POST' && p === '/api/pos') {
        // Light position report for presence only (no game action): { world, x, y, dir, scene }
        const raw = await readRaw(req);
        const acct = accountOf(req, url, raw);
        if (!posLimiter.take(acct)) throw new HttpError(429, 'terlalu sering');
        const b = parseJson(raw);
        feedPresence(acct, worldOf(b.world), b as { x?: unknown; y?: unknown }, b.dir, b.scene);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && p === '/api/stream') {
        // Server-Sent Events: `presence` {players} twice a second and `chat` {account,name,text,t}. Signed like /api/state
        // (headers; the client reads it with fetch, since EventSource cannot set headers).
        const acct = accountOf(req, url);
        const world = worldOf(url.searchParams.get('world'));
        if (!presence.access(acct, world)) throw new HttpError(409, 'Kamu tidak boleh ke sana.');
        if ((streams.get(acct) ?? 0) >= 4) throw new HttpError(429, 'terlalu banyak koneksi');
        streams.set(acct, (streams.get(acct) ?? 0) + 1);
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        const emit = (ev: string, data: unknown) => { res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); };
        res.write('retry: 2000\n\n');
        for (const m of presence.recent(world)) emit('chat', { ...m, backlog: true });
        const tick = () => emit('presence', { players: presence.others(world, acct) });
        tick();
        const timer = setInterval(tick, 500);
        const unsub = presence.subscribe(world, (m) => emit('chat', m));
        req.on('close', () => { clearInterval(timer); unsub(); streams.set(acct, Math.max(0, (streams.get(acct) ?? 1) - 1)); });
        return;
      }
      if (req.method === 'POST' && p === '/api/chat') {
        const raw = await readRaw(req);
        const acct = accountOf(req, url, raw);
        if (!chatIpLimiter.take(req.socket.remoteAddress ?? '?')) throw new HttpError(429, 'terlalu cepat');
        const b = parseJson(raw), world = worldOf(b.world);
        if (!deps.store.nameOf(acct)) throw new HttpError(409, 'Pilih nama dulu.');
        if (!presence.access(acct, world)) throw new HttpError(409, 'Kamu tidak ada di dunia itu.');
        return send(res, 200, { message: presence.chat(acct, world, b.text) });
      }
      if (req.method === 'POST' && p === '/api/name') {
        const raw = await readRaw(req);
        const acct = accountOf(req, url, raw);
        const name = validName(parseJson(raw).name);
        deps.store.setName(acct, name);
        return send(res, 200, { name });
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
      if (req.method === 'POST' && p === '/api/talk') {
        const raw = await readRaw(req);
        const acct = accountOf(req, url, raw);
        if (!talkLimiter.take(acct)) throw new HttpError(429, 'Pedagangnya sedang sibuk melayani. Coba sebentar lagi.');
        const b = parseJson(raw);
        const id = String(b.merchant ?? '');
        if (!game.econ.merchants[id]) throw new HttpError(404, 'no such merchant');
        const r = await dialogue.reply(game.market.view(id), game.econ.merchants[id].personality, String(b.text ?? ''));
        return send(res, 200, r);
      }
      if (req.method === 'GET' && p === '/api/projects') {
        // Town projects as the contract holds them (pledges, contributors, done), plus the map areas they open.
        return send(res, 200, { projects: await deps.chain.listProjects(), world: game.map?.view() ?? null });
      }
      if (req.method === 'GET' && p === '/api/listings') {
        // Player market: open listings read from the contract (escrowed there), newest first.
        const listings = bazaar.view(await deps.chain.listListings(50));
        return send(res, 200, { listings, feeBps: MARKET_FEE_BPS, contractId: deps.cfg.gameContractId, popular: bazaar.top(10) });
      }
      if (req.method === 'GET' && p === '/api/history') {
        const acct = accountOf(req, url);
        const token = url.searchParams.get('token') ?? undefined;
        if (token && !(token in game.econ.items)) throw new HttpError(400, 'unknown item');
        return send(res, 200, { history: deps.store.history(acct, 50, token), explorerTxUrl: deps.cfg.explorerTxUrl });
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
      if (req.method === 'POST' && p === '/api/sim') {
        const b = await readJson(req);
        const days = Math.max(1, Math.min(30, Math.floor(Number(b.days ?? 7))));
        const players = Math.max(1, Math.min(60, Math.floor(Number(b.players ?? 25))));
        const seed = Math.floor(Number(b.seed ?? 42)) >>> 0;
        const r = await simulate(days, players, seed);
        return send(res, 200, { ...r, label: 'Simulasi off-chain: rantai tiruan, kode harga dan aturan yang sama (economy/pricing.ts)' });
      }
      if (req.method === 'POST' && p === '/api/dev/night') {
        // Dev panel: jump the game clock to the next 20:00 (night monsters); crossing 06:00 settles as usual
        if (!devAllowed(req)) throw new HttpError(403, 'dev tools are off (or not from this machine)');
        const per = game.econ.time.hoursPerDay, h = game.clock.time().hour;
        game.clock.skipHours((20 - h + per) % per || per);
        await game.step();
        return send(res, 200, { time: game.clock.time() });
      }
      if (req.method === 'POST' && p === '/api/dev/settle') {
        if (!devAllowed(req)) throw new HttpError(403, 'dev tools are off (or not from this machine)');
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
