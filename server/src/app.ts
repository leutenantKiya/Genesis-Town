// HTTP routes (node:http, no framework). Also serves the static client.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { MARKET_FEE_BPS, type Config } from './config.ts';
import { MockChain, type Chain } from './chain.ts';
import type { Store } from './db.ts';
import { register, HttpError, type TokenVerifier } from './auth.ts';
import { relay, RateLimiter } from './relayer.ts';
import { spendGuard } from './spend.ts';
import { Dialogue } from './dialogue.ts';
import { ReplayCache, verifyRequest } from './reqauth.ts';
import { addDeviceKey } from './newdevice.ts';
import { Bazaar, titleFor } from './game/bazaar.ts';
import { Social, worldIdOk } from './social.ts';
import type { Game } from './game/game.ts';
import { homeWorld, parseHome } from './game/homeland.ts';
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
  let v: unknown;
  try { v = JSON.parse(raw || '{}'); } catch { throw new HttpError(400, 'bad json'); }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'body must be a JSON object');
  return v as Record<string, unknown>;
}
const has = (o: object, k: unknown): boolean => typeof k === 'string' && Object.hasOwn(o, k);
/** Quantity field from a JSON body: absent means the default, anything but a positive JSON integer is a 400. */
function intField(b: Record<string, unknown>, k: string) {
  const v = b[k];
  if (k in b && !(typeof v === 'number' && Number.isInteger(v) && v >= 1)) throw new HttpError(400, `${k} must be a positive whole number`);
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
  const simLimiter = new RateLimiter(6, 300); // simulations per IP (each new parameter set starts a worker thread)
  const talkLimiter = new RateLimiter(6, 150);
  const deviceLimiter = new RateLimiter(3, 20); // new-device key additions per IP (each costs the relayer a NEAR Auth sign call) // merchant questions per account (each may be one NEAR AI call)
  const dialogue = deps.dialogue ?? new Dialogue(deps.cfg.nearai);
  const clientRoot = resolve(deps.clientDir);
  const checkSpend = spendGuard(deps.chain, game);
  const bazaar = new Bazaar(deps.store.db);
  const social = new Social(deps.store);
  const presenceLimiter = new RateLimiter(240, 100_000); // about 2 reports a second per account
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

  // Homelands: only the owner and invited guests may report, chat or show up there.
  social.access = (a, w) => {
    if (w === 'public') return true;
    try { game.worldFor(a, w, false); return true; } catch { return false; }
  };
  const chatIpLimiter = new RateLimiter(30, 2000);
  const worldOf = (v: unknown) => (v == null || v === '' ? 'public' : worldIdOk(v) ? v : (() => { throw new HttpError(400, 'bad world'); })());
  /** The world a presence or chat request is about: it must be one the player may be in AND the one the server has them in. */
  async function checkedWorld(acct: string, v: unknown) {
    const w = worldOf(v);
    await game.prepare(acct, { world: w });
    if (!social.access(acct, w)) throw new HttpError(409, 'Kamu tidak boleh ke sana.');
    if (game.positions && game.positions.worldOf(acct) !== w) throw new HttpError(409, 'Kamu tidak ada di dunia itu.');
    return w;
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

  /** The visitor's address for per-address limits. Behind a hosting proxy every request comes from the proxy, so with
   *  TRUST_PROXY=1 the address the proxy appended (the last X-Forwarded-For entry, which a client cannot forge) is used. */
  function clientIp(req: IncomingMessage) {
    const direct = req.socket.remoteAddress ?? '?';
    if (!deps.cfg.trustProxy) return direct;
    const xff = req.headers['x-forwarded-for'];
    const list = (Array.isArray(xff) ? xff.join(',') : xff ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return list[list.length - 1] ?? direct;
  }

  /** Homelands: GET /api/homeland, GET /api/homeland/layout?world=HL-<n>, POST /api/homeland/invite. Returns true when it answered. */
  async function homelandApi(req: IncomingMessage, res: ServerResponse, url: URL, p: string): Promise<boolean> {
    if (p !== '/api/homeland' && !p.startsWith('/api/homeland/')) return false;
    if (req.method === 'GET' && p === '/api/homeland') {
      const acct = accountOf(req, url);
      send(res, 200, { ...game.homelands.view(acct), invited: game.homelands.invitedTo(acct) });
    } else if (req.method === 'GET' && p === '/api/homeland/layout') {
      const acct = accountOf(req, url), w = url.searchParams.get('world') ?? '';
      const id = parseHome(w);
      if (id === null) throw new HttpError(400, 'Dunia tidak dikenal.');
      const { row } = game.homelands.access(acct, id);
      game.homelands.settle(row.account);
      const built = game.gs.homelandBuildings(row.account).map((b) => ({ lot: b.lot, kind: b.kind }));
      send(res, 200, { world: homeWorld(row.id), seed: row.seed, gen: row.gen, th: row.th, open: row.open, built });
    } else if (req.method === 'POST' && p === '/api/homeland/invite') {
      const raw = await readRaw(req);
      const acct = accountOf(req, url, raw);
      if (!actLimiter.take(acct)) throw new HttpError(429, 'Pelan-pelan… terlalu banyak aksi');
      game.assertActive(acct);
      const b = parseJson(raw);
      if (!Array.isArray(b.accounts)) throw new HttpError(400, 'accounts must be a list');
      game.homelands.setInvites(acct, (b.accounts as unknown[]).map(String));
      send(res, 200, { invite: game.homelands.view(acct).guests });
    } else throw new HttpError(404, 'no such route');
    return true;
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    if (p.startsWith('/api/')) {
      if (await homelandApi(req, res, url, p)) return;
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
      if (req.method === 'GET' && p === '/api/health') {
        // for the host's health check: the process is up and the game clock and settlement are where they should be
        const t = game.clock.time();
        return send(res, 200, { ok: true, chain: deps.chain.mode, day: t.day, hour: t.hour, settledThrough: game.settlement.settledThrough() });
      }
      if (req.method === 'POST' && p === '/api/auth/register') {
        const ip = clientIp(req);
        if (!ipLimiter.take(ip)) throw new HttpError(429, 'too many sign-ups from this address');
        return send(res, 200, await register({ ...deps, onNewPlayer: (a) => game.onNewPlayer(a) }, await readJson(req)));
      }
      if (req.method === 'POST' && p === '/api/auth/add-key') {
        const ip = clientIp(req);
        if (!deviceLimiter.take(ip)) throw new HttpError(429, 'too many new-device requests');
        return send(res, 200, await addDeviceKey(deps, await readJson(req)));
      }
      if (req.method === 'POST' && p === '/api/relay') {
        const body = await readJson(req);
        const after = (s: string, m: string, a: Record<string, unknown>, e: string[]) => afterRelay(s, m, a, e, body);
        return send(res, 200, await relay({ ...deps, limiter, checkSpend, releaseSpend: (a) => game.gs.release(a), assertActive: (a) => game.assertActive(a), afterRelay: after, itemName: (t) => (has(game.econ.items, t) ? game.econ.items[t].name : t) }, body));
      }
      if (req.method === 'GET' && p === '/api/time') {
        return send(res, 200, { ...game.clock.time(), fraction: game.clock.hourFraction(), settledThrough: game.settlement.settledThrough(), world: game.map ? { seed: game.map.seed, unlocked: game.map.unlocked } : null, weather: game.weather() });
      }
      if (req.method === 'POST' && p === '/api/presence') {
        // where I am now -> who else is in my world, and the chat lines since the last call
        const raw = await readRaw(req);
        const acct = accountOf(req, url, raw);
        if (!presenceLimiter.take(acct)) throw new HttpError(429, 'too many presence reports');
        const b = parseJson(raw) as { world?: unknown; x?: unknown; y?: unknown; dir?: unknown; scene?: unknown; since?: unknown };
        game.fixWorld(acct); // a guest uninvited while standing there: back to the public area first
        const w = await checkedWorld(acct, b.world);
        game.reportPosition(acct, { x: Number(b.x), y: Number(b.y) }, w);
        let onTile = true; // outdoors, only walkable tiles of that world's map are shown
        if (b.scene === 'out' && game.map) { try { const m = game.worldFor(acct, w, false).map; onTile = !m || m.walkable(Number(b.x), Number(b.y)); } catch { onTile = false; } }
        if (onTile) social.report(acct, w, b);
        const players = social.nearby(acct, w).map((s) => ({ nick: s.nick, tag: s.tag, look: s.look, account: s.account, x: s.x, y: s.y, dir: s.dir, title: titleFor(bazaar.points(s.account)) }));
        const chat = social.since(acct, w, Math.max(0, Math.floor(Number(b.since) || 0)));
        return send(res, 200, { me: social.nick(acct), tag: social.tag(acct), look: social.look(acct), named: !!deps.store.nameOf(acct), online: social.online(), world: w, players, chat, last: social.seq });
      }
      if (req.method === 'POST' && p === '/api/chat') {
        const raw = await readRaw(req);
        const acct = accountOf(req, url, raw);
        if (!chatIpLimiter.take(clientIp(req))) throw new HttpError(429, 'terlalu cepat');
        game.assertActive(acct); // frozen accounts cannot speak
        const b = parseJson(raw) as { world?: unknown; text?: unknown };
        const text = typeof b.text === 'string' ? b.text : '';
        if (!deps.store.nameOf(acct)) throw new HttpError(409, 'Pilih nama dulu.');
        const w = await checkedWorld(acct, b.world);
        return send(res, 200, { msg: social.say(acct, w, text) });
      }
      if (req.method === 'POST' && p === '/api/name') {
        const raw = await readRaw(req);
        const acct = accountOf(req, url, raw);
        game.assertActive(acct);
        const b = parseJson(raw) as { name?: unknown; look?: unknown };
        if (b.look !== undefined) social.setLook(acct, b.look); // validated first: a bad look changes nothing
        if (b.name !== undefined) social.setNick(acct, b.name);
        return send(res, 200, { name: social.nick(acct), tag: social.tag(acct), look: social.look(acct), named: !!deps.store.nameOf(acct) });
      }
      if (req.method === 'GET' && p === '/api/state') {
        const acct = accountOf(req, url);
        const qx = url.searchParams.get('x'), qy = url.searchParams.get('y');
        if (qx !== null && qy !== null) {
          const w = worldOf(url.searchParams.get('world')); // validate before anything is recorded
          await game.prepare(acct, { world: w });
          game.reportPosition(acct, { x: Number(qx), y: Number(qy) }, w);
        }
        return send(res, 200, { ...game.state(acct), name: deps.store.nameOf(acct) });
      }
      if (req.method === 'POST' && p === '/api/act') {
        const raw = await readRaw(req);
        const acct = accountOf(req, url, raw);
        if (!actLimiter.take(acct)) throw new HttpError(429, 'Pelan-pelan… terlalu banyak aksi');
        const ab = parseJson(raw);
        const w = worldOf(ab.world); // a bad world id must fail before the action changes any state
        // ids from the request must be the game's own (not '__proto__' & co) and quantities real integers
        if (ab.action === 'sell' || ab.action === 'buy' || ab.action === 'ship') intField(ab, 'qty');
        if (ab.merchant !== undefined && !has(game.econ.merchants, ab.merchant)) throw new HttpError(404, 'Pedagang tidak dikenal.');
        if (ab.token !== undefined && ab.token !== '' && !has(game.econ.items, ab.token)) throw new HttpError(400, 'Barang tidak dikenal.');
        if (ab.recipe !== undefined && !has(game.econ.recipes, ab.recipe)) throw new HttpError(400, 'Resep tidak dikenal.');
        await game.prepare(acct, ab); // owner changes on chain show up here, before the act checks who owns what
        const out = game.act(acct, ab) as { world?: string; arrive?: { x: number; y: number } } & Record<string, unknown>;
        return send(res, 200, out);
      }
      if (req.method === 'GET' && p === '/api/market') {
        return send(res, 200, { merchants: game.merchants() });
      }
      if (req.method === 'GET' && p === '/api/quote') {
        const q = url.searchParams;
        const side = q.get('side') === 'buy' ? 'buy' : 'sell';
        const qs = q.get('qty') ?? '1';
        if (!/^\d{1,6}$/.test(qs)) throw new HttpError(400, 'qty must be a whole number');
        return send(res, 200, game.market.quote(q.get('merchant') ?? '', q.get('token') ?? '', side, Number(qs)));
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
        if (!has(game.econ.merchants, id)) throw new HttpError(404, 'no such merchant');
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
        if (token && !has(game.econ.items, token)) throw new HttpError(400, 'unknown item');
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
        // open to everyone (the public simulator page), so: one limiter per address and clamped inputs
        if (!simLimiter.take(clientIp(req))) throw new HttpError(429, 'terlalu banyak simulasi, coba sebentar lagi');
        const b = await readJson(req);
        const num = (v: unknown, d: number) => { const n = Math.floor(Number(v ?? d)); return Number.isFinite(n) ? n : d; };
        const days = Math.max(1, Math.min(30, num(b.days, 7)));
        const players = Math.max(1, Math.min(60, num(b.players, 25)));
        const seed = num(b.seed, 42) >>> 0;
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
      if (req.method === 'POST' && p === '/api/dev/unfreeze') {
        if (!devAllowed(req)) throw new HttpError(403, 'dev tools are off (or not from this machine)');
        const account = String(parseJson(await readRaw(req)).account ?? '');
        return send(res, 200, { account, lifted: game.gs.unfreeze(account) });
      }
      if (req.method === 'POST' && p === '/api/dev/grant') {
        // Mock chain only, from this machine only: put settled goods in a player's bag to try out town projects,
        // shop rescues and the market without hours of gathering. Never available on testnet.
        if (!devAllowed(req) || !(deps.chain instanceof MockChain)) throw new HttpError(403, 'dev grant is mock-only');
        const raw = await readRaw(req);
        const acct = accountOf(req, url, raw);
        const body = parseJson(raw) as { items?: Record<string, unknown>; coin?: unknown };
        const items = body.items ?? {};
        // coin never appears from nowhere: it moves from the town treasury (existing coin), items are minted on the mock chain
        if (body.coin != null) await game.devGrant(acct, Math.floor(Number(body.coin)));
        for (const [t, n] of Object.entries(items)) {
          if (t === 'coin') { await game.devGrant(acct, n as number); continue; }
          if (!game.econ.items[t] || !Number.isInteger(n) || (n as number) < 1 || (n as number) > 1000) throw new HttpError(400, 'bad item or amount');
          deps.chain.add(acct, t, BigInt(n as number));
        }
        await game.settlement.refresh([acct]);
        return send(res, 200, { ok: true, state: game.state(acct) });
      }
      if (req.method === 'POST' && p === '/api/dev/settle') {
        if (!devAllowed(req)) throw new HttpError(403, 'dev tools are off (or not from this machine)');
        return send(res, 200, await game.devSettle());
      }
      throw new HttpError(404, 'no such route');
    }
    // Static client.
    const rel = p === '/' ? '/index.html' : p;
    let decoded: string;
    try { decoded = decodeURIComponent(rel); } catch { throw new HttpError(400, 'bad path'); }
    const file = normalize(join(clientRoot, decoded));
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
