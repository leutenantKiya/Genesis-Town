// HTTP routes (node:http, no framework). Also serves the static client.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { MARKET_FEE_BPS, type Config } from './config.ts';
import { MockChain, type Chain } from './chain.ts';
import type { Store } from './db.ts';
import { register, HttpError, type TokenVerifier } from './auth.ts';
import { relay, RateLimiter } from './relayer.ts';
import { spendGuard } from './spend.ts';
import { Dialogue } from './dialogue.ts';
import { langOf, localizeJson, LangMemory, type Lang } from './lang.ts';
import { TransferStore } from './transfer.ts';
import { ReplayCache, verifyRequest } from './reqauth.ts';
import { addDeviceKey } from './newdevice.ts';
import { Bazaar, titleFor } from './game/bazaar.ts';
import { Social, worldIdOk } from './social.ts';
import type { Game } from './game/game.ts';
import { homeWorld, parseHome } from './game/homeland.ts';
import { leafHash, merkleProof, merkleRoot } from './game/merkle.ts';
import { TtlCache, BoundedCache } from './ttlcache.ts';
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
  verifyGoogle?: TokenVerifier; // "Masuk dengan Google"; absent when GOOGLE_CLIENT_ID is not set
  currentBlockHeight: () => Promise<bigint>;
  clientDir: string;
  dialogue?: Dialogue;
  transfers?: TransferStore;
  /** The Neon copy of the database, when DATABASE_URL is set (snapshot.ts): its state shows in /api/health. */
  snapshot?: { status(): { lastSavedAt: number | null; lastSize: number | null; lastError: string | null; saves: number } };
  /** NEAR left for gas on the server's own accounts (funds.ts): shown in /api/health. */
  funds?: { status(): { checkedAt: number | null; near: Record<string, string>; low: string[]; lowBelow: string } };
}

/** What /api/health reports as wrong: settlement more than a day behind the last day that could be closed, a server
 *  account low on NEAR for gas, or the last database copy failing. Each line is short, for a person reading the JSON. */
export function healthProblems(h: { settleDay: number; settledThrough: number; fundsLow?: string[]; snapshotError?: string | null }): string[] {
  const out: string[] = [];
  const behind = (h.settleDay - 1) - h.settledThrough;
  if (behind > 1) out.push(`settlement is ${behind} days behind (settled through day ${h.settledThrough})`);
  for (const a of h.fundsLow ?? []) out.push(`${a} is low on NEAR for gas`);
  if (h.snapshotError) out.push(`database copy failing: ${h.snapshotError}`);
  return out;
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

/** The language each response is for (X-GT-Lang of its request). English is the server's own text; 'id' is translated on the way out (lang.ts). */
const resLang = new WeakMap<ServerResponse, Lang>();
function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  if (resLang.get(res) === 'id') body = localizeJson(body);
  res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

export function createApp(deps: AppDeps) {
  const { game } = deps;
  const limiter = new RateLimiter(deps.cfg.relay.perMinute, deps.cfg.relay.perDay);
  const actLimiter = new RateLimiter(60, 5000); // off-chain actions per account
  const ipLimiter = new RateLimiter(10, 200); // account creation per IP
  const simLimiter = new RateLimiter(6, 300); // simulations per IP (each new parameter set starts a worker thread)
  const talkLimiter = new RateLimiter(6, 150);
  const transfers = deps.transfers ?? new TransferStore(); // one-time codes for moving to another device (transfer.ts)
  const transferSweep = setInterval(() => transfers.sweep(), 60_000); transferSweep.unref();
  const redeemLimiter = new RateLimiter(10, 100); // code redemptions per address (the id is random, this only stops guessing)
  const deviceLimiter = new RateLimiter(3, 20); // new-device key additions per IP (each costs the relayer a NEAR Auth sign call) // merchant questions per account (each may be one NEAR AI call)
  const dialogue = deps.dialogue ?? new Dialogue({ ...deps.cfg.nearai, ...deps.cfg.dialogue });
  const clientRoot = resolve(deps.clientDir);
  const checkSpend = spendGuard(deps.chain, game);
  const bazaar = new Bazaar(deps.store.db);
  const social = new Social(deps.store);
  social.guestCfg = { max: game.econ.guest.max, idleSecs: game.econ.guest.idleSecs, perIp: game.econ.guest.perIp, maxMinutes: game.econ.guest.maxMinutes };
  const guestHelloLimiter = new RateLimiter(game.econ.guest.helloPerMinute, 200); // new guests per IP
  const guestPresenceLimiter = new RateLimiter(240, 100_000); // guest position reports per IP
  // Merchants walk the public area as players tagged NPC: behind their stall (as the client draws them); "/msg Sari ..." asks them through the dialogue provider.
  const MERCHANT_LOOK: Record<string, number> = { sari: 3, budi: 2, wati: 5, joko: 4 };
  const stalls = game.map?.layout.market.stalls ?? [];
  social.setNpcs(game.market.ids().flatMap((id, k) => stalls[k] ? [{ id, account: game.market.account(id), name: game.econ.merchants[id].name, look: MERCHANT_LOOK[id] ?? k % 8, x: stalls[k].x, y: stalls[k].y - 1, title: game.econ.merchants[id].shop }] : []));
  social.onNpcMsg = (npc, from, text) => {
    if (!talkLimiter.take(from)) throw new HttpError(429, 'The merchant is busy serving customers. Try again in a moment.');
    void dialogue.reply(game.market.view(npc.id), game.econ.merchants[npc.id].personality, text, acctLang.get(from))
      .then((r) => { social.npcSay(npc, from, r.line); }, () => { /* the player simply gets no answer */ });
  };
  const acctLang = new LangMemory(); // last language each account played in (merchant chat replies follow it)
  const presenceLimiter = new RateLimiter(240, 100_000); // about 2 reports a second per account
  // Public read routes shared by every caller, held briefly. Anything the server itself changes clears them at once.
  const READ_CACHE_MS = 4000;
  const readCache = new TtlCache<unknown>(READ_CACHE_MS);
  const ledgerCache = new BoundedCache<unknown>(60); // settled days only, keyed by day
  const afterRelay = async (sender: string, method: string, args: Record<string, unknown>, extra: string[], relayBody: Record<string, unknown> = {}) => {
    try { await afterRelayWork(sender, method, args, extra, relayBody); } finally { readCache.clear(); }
  };
  const afterRelayWork = async (sender: string, method: string, args: Record<string, unknown>, extra: string[], relayBody: Record<string, unknown> = {}) => {
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
  social.partyOf = (a) => game.party.idOf(a);
  social.mates = (a) => game.party.mates(a);
  social.partyJoinedAt = (a) => game.party.joinedAt(a);
  social.access = (a, w) => {
    if (w === 'public') return true;
    try { game.worldFor(a, w, 'visit'); return true; } catch { return false; }
  };
  /** The party view plus where each member is: `world` and `online` from presence (last 15 s); `x`, `y` only for a mate outdoors in `w`. */
  function partyWithPlaces(acct: string, w: string) {
    const v = game.party.view(acct), now = social.now();
    if (!v.party) return v;
    const members = v.party.members.map((m) => {
      const s = social.seen.get(m.account), fresh = !!s && now - s.t <= 15_000;
      return { ...m, online: fresh, world: fresh ? s!.world : null, ...(fresh && s!.world === w && s!.scene === 'out' && m.account !== acct ? { x: s!.x, y: s!.y } : {}) };
    });
    return { ...v, party: { ...v.party, members } };
  }
  const chatIpLimiter = new RateLimiter(30, 2000);
  const worldOf = (v: unknown) => (v == null || v === '' ? 'public' : worldIdOk(v) ? v : (() => { throw new HttpError(400, 'bad world'); })());
  /** The world a presence or chat request is about: it must be one the player may be in AND the one the server has them in. */
  async function checkedWorld(acct: string, v: unknown, at?: { x: number; y: number }) {
    const w = worldOf(v);
    await game.prepare(acct, { world: w });
    if (!social.access(acct, w)) throw new HttpError(409, 'You can\'t go there.');
    if (at) game.reportPosition(acct, at, w); // a reload on the own Homeland spawn moves the player there first
    if (game.positions && game.positions.worldOf(acct) !== w) throw new HttpError(409, 'You are not in that world.');
    return w;
  }

  // Off-chain play is signed with the player's session key (src/reqauth.ts); the account header alone proves nothing.
  const replay = new ReplayCache();
  function accountOf(req: IncomingMessage, url: URL, raw = ''): string {
    return verifyRequest({ sessionKeyOwner: (k) => deps.store.sessionKeyOwner(k), isSuperseded: (k, a) => deps.store.isSuperseded(k, a), replay }, req.headers, req.method ?? 'GET', url.pathname + url.search, raw);
  }
  /** Like accountOf, for anything that moves items or coin to another player (live trade, old offers, device-transfer
   *  codes): a key that is not yet on the NEAR account (signed in on a new device, not approved with NEAR Auth) is refused. */
  function accountOfApproved(req: IncomingMessage, url: URL, raw = ''): string {
    const acct = accountOf(req, url, raw);
    if (!deps.store.sessionKeyOnchain(String(req.headers['x-gt-key']))) throw new HttpError(409, 'This device must be approved with NEAR Auth first.', 'approve_device');
    return acct;
  }

  function isAdmin(acct: string) { return deps.cfg.adminAccounts.includes(acct); }
  function assertNotBanned(ip: string) { if (deps.store.isBanned(ip)) throw new HttpError(403, 'This address is banned.'); }
  /** Admin routes: signed like any player request, then the account must be in ADMIN_ACCOUNTS (403 otherwise). */
  function adminOf(req: IncomingMessage, url: URL, raw = ''): string {
    const acct = accountOf(req, url, raw);
    if (!isAdmin(acct)) throw new HttpError(403, 'Admins only.');
    return acct;
  }

  /** Dev tools (clock jump, forced settlement) only answer the owner's own machine: DEV_TOOLS=1 and a direct loopback
   *  request with no proxy header. On a public host they stay closed even if the flag is left on by mistake. */
  function devAllowed(req: IncomingMessage) {
    if (!deps.cfg.devTools) return false;
    if (req.headers['x-forwarded-for'] || req.headers['forwarded'] || req.headers['x-real-ip']) return false;
    const ip = req.socket.remoteAddress ?? '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  }

  /** A client hosted elsewhere (CORS_ORIGINS, e.g. the Vercel page) calls the API straight from the browser, so the
   *  hosting proxy still appends the player's own address. Returns true when it answered a preflight. */
  function cors(req: IncomingMessage, res: ServerResponse) {
    const origin = req.headers.origin;
    if (!origin || !deps.cfg.corsOrigins.includes(origin)) return false;
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
    if (req.method !== 'OPTIONS') return false;
    res.writeHead(204, {
      'access-control-allow-methods': 'GET, POST',
      'access-control-allow-headers': 'content-type, x-account-id, x-gt-key, x-gt-ts, x-gt-sig, x-gt-lang',
      'access-control-max-age': '86400',
    });
    res.end();
    return true;
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
      const acct = accountOf(req, url), w = url.searchParams.get('world');
      const id = w ? parseHome(w) : null;
      if (w && id === null) throw new HttpError(400, 'Unknown world.');
      const acc = id === null ? null : game.homelands.access(acct, id);
      if (acc && !acc.owner) send(res, 200, { ...game.homelands.guestView(acc.row.account, acct), role: acc.role });
      else send(res, 200, { ...game.homelands.view(acct), invited: game.homelands.invitedTo(acct), role: 'owner' });
    } else if (req.method === 'GET' && p === '/api/homeland/layout') {
      const acct = accountOf(req, url), w = url.searchParams.get('world') ?? '';
      const id = parseHome(w);
      if (id === null) throw new HttpError(400, 'Unknown world.');
      const { row } = game.homelands.access(acct, id);
      game.homelands.settle(row.account);
      const built = game.gs.homelandBuildings(row.account).map((b) => ({ lot: b.lot, kind: b.kind }));
      send(res, 200, { world: homeWorld(row.id), seed: row.seed, gen: row.gen, th: row.th, open: row.open, light: game.homelands.lightLevel(row.account), built });
    } else if (req.method === 'POST' && p === '/api/homeland/invite') {
      const raw = await readRaw(req);
      const acct = accountOf(req, url, raw);
      if (!actLimiter.take(acct)) throw new HttpError(429, 'Slow down… too many actions');
      game.assertActive(acct);
      const b = parseJson(raw);
      if (!Array.isArray(b.accounts)) throw new HttpError(400, 'accounts must be a list');
      game.homelands.setInvites(acct, (b.accounts as unknown[]).map(String));
      send(res, 200, { invite: game.homelands.view(acct).guests });
    } else if (req.method === 'POST' && p === '/api/homeland/role') {
      const raw = await readRaw(req);
      const acct = accountOf(req, url, raw);
      if (!actLimiter.take(acct)) throw new HttpError(429, 'Slow down… too many actions');
      game.assertActive(acct);
      const b = parseJson(raw);
      game.homelands.setRole(acct, String(b.who ?? ''), String(b.role ?? ''));
      send(res, 200, { homeland: game.homelands.view(acct) });
    } else throw new HttpError(404, 'no such route');
    return true;
  }

  /** Party: GET /api/party, POST /api/party/{invite,accept,decline,leave,kick}. Every answer is the caller's party view. */
  async function partyApi(req: IncomingMessage, res: ServerResponse, url: URL, p: string): Promise<boolean> {
    if (p !== '/api/party' && !p.startsWith('/api/party/')) return false;
    if (req.method === 'GET' && p === '/api/party') return send(res, 200, game.party.view(accountOf(req, url))), true;
    if (req.method !== 'POST') throw new HttpError(404, 'no such route');
    const raw = await readRaw(req);
    const acct = accountOf(req, url, raw);
    if (!actLimiter.take(acct)) throw new HttpError(429, 'Slow down… too many actions');
    const b = parseJson(raw);
    if (p === '/api/party/invite') send(res, 200, game.party.invite(acct, b.to));
    else if (p === '/api/party/accept') send(res, 200, game.party.accept(acct, b.from));
    else if (p === '/api/party/decline') send(res, 200, game.party.decline(acct, b.from));
    else if (p === '/api/party/leave') send(res, 200, game.party.leave(acct));
    else if (p === '/api/party/kick') send(res, 200, game.party.kick(acct, b.account));
    else throw new HttpError(404, 'no such route');
    return true;
  }

  const boardCache = new Map<string, { at: number; body: unknown }>(); // Papan Juara: one heavy query per period and caller per 30 s
  /** Public-area economy: POST /api/trade/{offer,accept,cancel}, GET /api/trade, GET|POST /api/consign, POST /api/consign/withdraw, GET /api/leaderboard. */
  async function tradeApi(req: IncomingMessage, res: ServerResponse, url: URL, p: string): Promise<boolean> {
    const isTrade = p === '/api/trade' || p.startsWith('/api/trade/'), isConsign = p === '/api/consign' || p === '/api/consign/withdraw';
    if (!isTrade && !isConsign && p !== '/api/leaderboard') return false;
    if (req.method === 'GET') {
      const acct = p === '/api/leaderboard' ? (() => { try { return accountOf(req, url); } catch { return null; } })() : accountOf(req, url);
      if (p === '/api/trade') { game.trade.finishDue(); return send(res, 200, { ...game.trade.list(acct!), session: game.trade.session(acct!), invites: game.trade.invites(acct!) }), true; }
      if (p === '/api/consign') return send(res, 200, { lots: game.consign.lots(acct!), merchant: game.econ.consign.merchant, feeBps: game.econ.consign.feeBps, maxPerItem: game.econ.consign.maxPerItem }), true;
      if (p === '/api/leaderboard') {
        const period = url.searchParams.get('period') ?? 'day';
        if (period !== 'day' && period !== 'all') throw new HttpError(400, 'period must be day or all');
        const key = `${period}|${acct ?? ''}`, nowMs = Date.now(), hit = boardCache.get(key);
        if (hit && nowMs - hit.at < 30_000) return send(res, 200, hit.body), true;
        const body = game.leaderboard(period, acct);
        if (boardCache.size > 500) boardCache.clear();
        boardCache.set(key, { at: nowMs, body });
        return send(res, 200, body), true;
      }
      throw new HttpError(404, 'no such route');
    }
    if (req.method !== 'POST') throw new HttpError(404, 'no such route');
    const raw = await readRaw(req);
    const gated = /^\/api\/trade\/(open|join|set|ready|offer|accept)$/.test(p); // value moves to another player
    const acct = gated ? accountOfApproved(req, url, raw) : accountOf(req, url, raw);
    if (!actLimiter.take(acct)) throw new HttpError(429, 'Slow down… too many actions');
    game.assertActive(acct);
    const b = parseJson(raw);
    const isSession = /^\/api\/trade\/(open|join|set|ready|close)$/.test(p);
    const tw = isSession ? worldOf(b.world) : 'public'; // live sessions run in any world the player stands in; the old offers stay public
    if (b.pos !== undefined) game.reportPosition(acct, b.pos as { x: number; y: number }, tw); // the client's tile, checked like any report
    if (isSession) {
      game.trade.finishDue();
      const out = (session: unknown) => send(res, 200, { session, state: game.state(acct) });
      if (p === '/api/trade/open') out(game.trade.open(acct, b));
      else if (p === '/api/trade/join') out(game.trade.join(acct, b.id));
      else if (p === '/api/trade/set') out(game.trade.set(acct, b.id, b));
      else if (p === '/api/trade/ready') out(game.trade.ready(acct, b.id, b));
      else out(game.trade.close(acct, b.id));
      return true;
    }
    if (p === '/api/trade/offer') send(res, 200, game.trade.offer(acct, b));
    else if (p === '/api/trade/accept') send(res, 200, { ...game.trade.accept(acct, b.id), state: game.state(acct) });
    else if (p === '/api/trade/cancel') send(res, 200, game.trade.cancel(acct, b.id));
    else if (p === '/api/consign') send(res, 200, { ...game.consign.deposit(acct, b.token, b.qty, b.min_price), state: game.state(acct) });
    else if (p === '/api/consign/withdraw') send(res, 200, { ...game.consign.withdraw(acct, b.token), state: game.state(acct) });
    else throw new HttpError(404, 'no such route');
    return true;
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    if (p.startsWith('/api/')) {
      if (cors(req, res)) return;
      if (await homelandApi(req, res, url, p)) return;
      if (await partyApi(req, res, url, p)) return;
      if (await tradeApi(req, res, url, p)) return;
      if (req.method === 'GET' && p === '/api/config') {
        return send(res, 200, {
          chainMode: deps.chain.mode,
          gameContractId: deps.cfg.gameContractId,
          explorerTxUrl: deps.cfg.explorerTxUrl,
          rpcUrl: deps.cfg.rpcUrl,
          fastAuth: deps.cfg.fastAuth,
          google: deps.cfg.googleClientId && deps.verifyGoogle ? { clientId: deps.cfg.googleClientId } : null,
          devLogin: deps.cfg.devLogin,
          devTools: devAllowed(req),
          dialogue: dialogue.provider,
          world: game.map?.view() ?? null,
          econ: { items: game.econ.items, recipes: game.econ.recipes, gather: game.econ.gather, farm: game.econ.farm, time: game.econ.time, coop: game.econ.coop },
          monsters: game.monsters ? { fightEnergy: game.econ.monsters.fightEnergy, fleeEnergy: game.econ.monsters.fleeEnergy, nightFrom: game.econ.monsters.nightFrom, nightTo: game.econ.monsters.nightTo, roaming: game.econ.monsters.roaming, homelandRoaming: game.econ.monsters.homeland?.roaming ?? game.econ.monsters.roaming, reach: game.econ.monsters.reach, publicMonsters: !game.econ.homeland.publicTradeOnly } : null,
        });
      }
      if (req.method === 'GET' && p === '/api/health') {
        // The host's deploy check (railway.json) only needs the process up, so this stays 200 even when something is
        // wrong (a 503 would block the very deploy that fixes it); `ok` and `problems` say what. ?strict=1 answers 503
        // instead, for an outside uptime monitor.
        const t = game.clock.time(), settledThrough = game.settlement.settledThrough();
        const snapshot = deps.snapshot ? deps.snapshot.status() : null, funds = deps.funds ? deps.funds.status() : null;
        const problems = healthProblems({ settleDay: t.settleDay, settledThrough, fundsLow: funds?.low, snapshotError: snapshot?.lastError });
        const status = problems.length && url.searchParams.get('strict') === '1' ? 503 : 200;
        return send(res, status, { ok: problems.length === 0, problems, chain: deps.chain.mode, day: t.day, hour: t.hour, settledThrough, snapshot, funds });
      }
      if (req.method === 'POST' && p === '/api/auth/register') {
        const ip = clientIp(req);
        assertNotBanned(ip);
        if (!ipLimiter.take(ip)) throw new HttpError(429, 'too many sign-ups from this address');
        return send(res, 200, await register({ ...deps, onNewPlayer: (a) => game.onNewPlayer(a) }, await readJson(req)));
      }
      if (req.method === 'POST' && p === '/api/transfer') {
        // signed: only the account's own game key can open a code for it
        const raw = await readRaw(req);
        const acct = accountOfApproved(req, url, raw);
        const b = parseJson(raw);
        return send(res, 200, transfers.create(acct, b.ct, b.iv));
      }
      if (req.method === 'POST' && p === '/api/transfer/redeem') {
        assertNotBanned(clientIp(req));
        if (!redeemLimiter.take(clientIp(req))) throw new HttpError(429, 'too many new-device requests');
        return send(res, 200, transfers.redeem((await readJson(req)).id));
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
      if (p === '/api/admin/guests' || p === '/api/admin/bans' || p === '/api/admin/kick' || p === '/api/admin/ban' || p === '/api/admin/unban') {
        if (req.method === 'GET') {
          adminOf(req, url);
          if (p === '/api/admin/guests') return send(res, 200, { guests: social.guestList() });
          if (p === '/api/admin/bans') return send(res, 200, { bans: deps.store.listBans() });
        } else if (req.method === 'POST') {
          const raw = await readRaw(req);
          adminOf(req, url, raw);
          const b = parseJson(raw);
          if (p === '/api/admin/kick') return send(res, 200, { kicked: social.kickGuest(String(b.guest ?? '')), guests: social.guestList() });
          const ip = String(b.ip ?? '').trim().slice(0, 64);
          if (!ip) throw new HttpError(400, 'ip required');
          if (p === '/api/admin/ban') { deps.store.addBan(ip, String(b.note ?? '').slice(0, 200)); social.dropGuestsOf(ip); }
          else if (p === '/api/admin/unban') deps.store.removeBan(ip);
          else throw new HttpError(404, 'no such route');
          return send(res, 200, { bans: deps.store.listBans(), guests: social.guestList() });
        }
        throw new HttpError(404, 'no such route');
      }
      if (p === '/api/admin/frozen' || p === '/api/admin/status' || p === '/api/admin/unfreeze') {
        if (req.method === 'GET' && p !== '/api/admin/unfreeze') {
          adminOf(req, url);
          if (p === '/api/admin/frozen') {
            const by = new Map<string, { account: string; items: Array<{ token: string; day: number; wanted: number; applied: number }> }>();
            for (const f of game.gs.shortfalls()) {
              if (f.kind !== 'shortfall' || f.resolved) continue;
              const e = by.get(f.account) ?? { account: f.account, items: [] };
              e.items.push({ token: f.token, day: f.day, wanted: f.wanted, applied: f.applied });
              by.set(f.account, e);
            }
            return send(res, 200, { frozen: [...by.values()] });
          }
          const t = game.clock.time(), now = game.clock.now();
          return send(res, 200, {
            day: t.day, hour: t.hour, settleDay: t.settleDay, settledThrough: game.settlement.settledThrough(),
            retry: [...game.settlement.retry.entries()].map(([day, r]) => ({ day, inSeconds: Math.max(0, Math.round((r.until - now) / 1000)), delaySeconds: Math.round(r.delay / 1000) })),
            settlements: game.gs.settlements(8)
          });
        } else if (req.method === 'POST' && p === '/api/admin/unfreeze') {
          const raw = await readRaw(req);
          adminOf(req, url, raw);
          const account = String(parseJson(raw).account ?? '');
          if (!account) throw new HttpError(400, 'account required');
          return send(res, 200, { account, lifted: game.gs.unfreeze(account) });
        }
        throw new HttpError(404, 'no such route');
      }
      if (req.method === 'POST' && p === '/api/guest/hello') {
        assertNotBanned(clientIp(req));
        // a visitor who has not signed in: no keys, no account. Outside accountOf on purpose; limited per address, bound to it.
        if (!guestHelloLimiter.take(clientIp(req))) throw new HttpError(429, 'Too many requests, try again shortly.');
        return send(res, 200, social.guestHello(clientIp(req)));
      }
      if (req.method === 'POST' && p === '/api/guest/presence') {
        const ip = clientIp(req);
        assertNotBanned(ip);
        if (!guestPresenceLimiter.take(ip)) throw new HttpError(429, 'too many presence reports');
        const b = await readJson(req) as { guest?: unknown; x?: unknown; y?: unknown; dir?: unknown };
        const g = social.guestReport(b.guest, ip, b, game.map ? (x, y) => game.map!.walkable(x, y) : undefined);
        const players = social.nearby(g.id, 'public').map((s) => ({ nick: s.nick, tag: s.tag, look: s.look, account: s.account, x: s.x, y: s.y, dir: s.dir, ...(s.npc ? { npc: true, merchant: s.merchant, title: s.title } : s.guest ? { guest: true } : { title: titleFor(bazaar.points(s.account)) }) }));
        return send(res, 200, { me: g.nick, look: g.look, guest: true, online: social.online() + social.guests.size, world: 'public', players, chat: [], last: 0 });
      }
      if (req.method === 'POST' && p === '/api/presence') {
        // where I am now -> who else is in my world, and the chat lines since the last call
        const raw = await readRaw(req);
        const acct = accountOf(req, url, raw);
        if (!presenceLimiter.take(acct)) throw new HttpError(429, 'too many presence reports');
        const b = parseJson(raw) as { world?: unknown; x?: unknown; y?: unknown; dir?: unknown; scene?: unknown; since?: unknown };
        game.fixWorld(acct); // a guest uninvited while standing there: back to the public area first
        const w = await checkedWorld(acct, b.world, { x: Number(b.x), y: Number(b.y) });
        let onTile = true; // outdoors, only walkable tiles of that world's map are shown
        if (b.scene === 'out' && game.map) { try { const m = game.worldFor(acct, w, 'visit').map; onTile = !m || m.walkable(Number(b.x), Number(b.y)); } catch { onTile = false; } }
        if (onTile) social.report(acct, w, b);
        const players = social.nearby(acct, w).map((s) => ({ nick: s.nick, tag: s.tag, look: s.look, account: s.account, x: s.x, y: s.y, dir: s.dir, ...(s.npc ? { npc: true, merchant: s.merchant, title: s.title } : s.guest ? { guest: true } : { title: titleFor(bazaar.points(s.account)), ...(s.party ? { party: true } : {}) }) }));
        const chat = social.since(acct, w, Math.max(0, Math.floor(Number(b.since) || 0)));
        return send(res, 200, { me: social.nick(acct), tag: social.tag(acct), look: social.look(acct), named: !!deps.store.nameOf(acct), online: social.online(), world: w, players, chat, last: social.seq, party: partyWithPlaces(acct, w) });
      }
      if (req.method === 'POST' && p === '/api/chat') {
        const raw = await readRaw(req);
        const acct = accountOf(req, url, raw);
        if (!chatIpLimiter.take(clientIp(req))) throw new HttpError(429, 'too fast');
        game.assertActive(acct); // frozen accounts cannot speak
        const b = parseJson(raw) as { world?: unknown; text?: unknown };
        const text = typeof b.text === 'string' ? b.text : '';
        if (!deps.store.nameOf(acct)) throw new HttpError(409, 'Choose a name first.');
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
        return send(res, 200, { ...game.state(acct), name: deps.store.nameOf(acct), ...(isAdmin(acct) ? { admin: true } : {}) });
      }
      if (req.method === 'POST' && p === '/api/act') {
        const raw = await readRaw(req);
        const acct = accountOf(req, url, raw);
        if (!actLimiter.take(acct)) throw new HttpError(429, 'Slow down… too many actions');
        const ab = parseJson(raw);
        const w = worldOf(ab.world); // a bad world id must fail before the action changes any state
        // ids from the request must be the game's own (not '__proto__' & co) and quantities real integers
        if (ab.action === 'sell' || ab.action === 'buy' || ab.action === 'ship') intField(ab, 'qty');
        if (ab.merchant !== undefined && !has(game.econ.merchants, ab.merchant)) throw new HttpError(404, 'Unknown merchant.');
        if (ab.token !== undefined && ab.token !== '' && !has(game.econ.items, ab.token)) throw new HttpError(400, 'Unknown item.');
        if (ab.recipe !== undefined && !has(game.econ.recipes, ab.recipe)) throw new HttpError(400, 'Unknown recipe.');
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
        // The shop list is the same for everyone; only each caller's own `holding` differs, so only the list is cached.
        const a = req.headers['x-account-id'];
        const list = await readCache.get('shops', () => game.shops()) as Awaited<ReturnType<typeof game.shops>>;
        const shops = typeof a === 'string' && a ? await Promise.all(list.map(async (s) => ({ ...s, holding: await deps.chain.holding(s.account_id, a) }))) : list;
        return send(res, 200, { shops });
      }
      if (req.method === 'POST' && p === '/api/talk') {
        const raw = await readRaw(req);
        const acct = accountOf(req, url, raw);
        if (!talkLimiter.take(acct)) throw new HttpError(429, 'The merchant is busy serving customers. Try again in a moment.');
        const b = parseJson(raw);
        const id = String(b.merchant ?? '');
        if (!has(game.econ.merchants, id)) throw new HttpError(404, 'no such merchant');
        const r = await dialogue.reply(game.market.view(id), game.econ.merchants[id].personality, String(b.text ?? ''), resLang.get(res) ?? 'en');
        return send(res, 200, r);
      }
      if (req.method === 'GET' && p === '/api/projects') {
        // Town projects as the contract holds them (pledges, contributors, done), plus the map areas they open.
        const retired = Object.fromEntries(game.econ.projects.filter((p) => p.retired).map((p) => [p.id, p.retired]));
        return send(res, 200, await readCache.get('projects', async () => ({ projects: (await deps.chain.listProjects()).map((p) => { const own = game.econ.projects.find((q) => q.id === p.id); const named = own ? { ...p, name: own.name } : p; return retired[p.id] ? { ...named, retired: retired[p.id] } : named; }), world: game.map?.view() ?? null })));
      }
      if (req.method === 'GET' && p === '/api/listings') {
        // Player market: open listings read from the contract (escrowed there), newest first.
        return send(res, 200, await readCache.get('listings', async () => {
          const listings = bazaar.view(await deps.chain.listListings(50));
          return { listings, feeBps: MARKET_FEE_BPS, contractId: deps.cfg.gameContractId, popular: bazaar.top(10) };
        }));
      }
      if (req.method === 'GET' && p === '/api/history') {
        const acct = accountOf(req, url);
        const token = url.searchParams.get('token') ?? undefined;
        if (token && !has(game.econ.items, token)) throw new HttpError(400, 'unknown item');
        const kind = url.searchParams.get('kind') ?? undefined;
        if (kind && !/^[a-z_]{1,24}$/.test(kind)) throw new HttpError(400, 'bad kind');
        return send(res, 200, { history: deps.store.history(acct, 50, token, kind), explorerTxUrl: deps.cfg.explorerTxUrl });
      }
      const m = /^\/api\/ledger\/(\d+)$/.exec(p);
      if (req.method === 'GET' && m) {
        // The full off-chain ledger of a game day, with its Merkle root (stored on chain by settle_day).
        const day = Number(m[1]);
        // a settled day never changes: keep its rows, leaves and root (keyed by day only, so ?proof= values never add entries)
        const settled = day <= game.settlement.settledThrough();
        type DayLedger = { rows: { seq: number; day: number; account: string; token: string; delta: unknown; kind: string; ref: unknown }[]; leaves: ReturnType<typeof leafHash>[]; root: string; settlements: unknown[] };
        let d = settled ? ledgerCache.get(String(day)) as DayLedger | undefined : undefined;
        if (!d) {
          const rows = game.gs.dayRows(day).map(({ seq, day: dd, account, token, delta, kind, ref }) => ({ seq, day: dd, account, token, delta, kind, ref }));
          const leaves = rows.map(leafHash);
          d = { rows, leaves, root: merkleRoot(leaves), settlements: game.gs.settlements(50).filter((s) => (s as { day: number }).day === day) } as DayLedger;
          if (settled) ledgerCache.set(String(day), d);
        }
        const proofFor = url.searchParams.get('proof');
        const proofs = proofFor ? d.rows.map((r, i) => (r.account === proofFor ? { seq: r.seq, index: i, proof: merkleProof(d.leaves, i) } : null)).filter(Boolean) : undefined;
        const body = { day, root: d.root, rows: d.rows, proofs, settlements: d.settlements };
        return send(res, 200, body);
      }
      if (req.method === 'POST' && p === '/api/sim') {
        // open to everyone (the public simulator page), so: one limiter per address and clamped inputs
        if (!simLimiter.take(clientIp(req))) throw new HttpError(429, 'too many simulations, try again shortly');
        const b = await readJson(req);
        const num = (v: unknown, d: number) => { const n = Math.floor(Number(v ?? d)); return Number.isFinite(n) ? n : d; };
        const days = Math.max(1, Math.min(30, num(b.days, 7)));
        const players = Math.max(1, Math.min(60, num(b.players, 25)));
        const seed = num(b.seed, 42) >>> 0;
        const r = await simulate(days, players, seed);
        return send(res, 200, { ...r, label: 'Off-chain simulation: mock chain, same price code and rules (economy/pricing.ts)' });
      }
      if (req.method === 'POST' && p === '/api/dev/night') {
        // Dev panel: jump the game clock to the next 20:00 (night monsters); crossing 06:00 settles as usual
        if (!devAllowed(req)) throw new HttpError(403, 'dev tools are off (or not from this machine)');
        const per = game.econ.time.hoursPerDay, h = game.clock.time().hour;
        game.clock.skipHours((20 - h + per) % per || per);
        await game.step(); readCache.clear();
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
        await game.settlement.refresh([acct]); readCache.clear();
        return send(res, 200, { ok: true, state: game.state(acct) });
      }
      if (req.method === 'POST' && p === '/api/dev/settle') {
        if (!devAllowed(req)) throw new HttpError(403, 'dev tools are off (or not from this machine)');
        const r = await game.devSettle(); readCache.clear();
        return send(res, 200, r);
      }
      throw new HttpError(404, 'no such route');
    }
    // Static client.
    const rel = p === '/' ? '/index.html' : p;
    let decoded: string;
    try { decoded = decodeURIComponent(rel); } catch { throw new HttpError(400, 'bad path'); }
    const file = normalize(join(clientRoot, decoded));
    // the trailing separator matters: a bare prefix check would let /../client-secret/ through next to client/
    if (file !== clientRoot && !file.startsWith(clientRoot + sep)) throw new HttpError(403, 'forbidden');
    try {
      if (!(await stat(file)).isFile()) throw new Error();
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      return res.end(await readFile(file));
    } catch {
      throw new HttpError(404, 'not found');
    }
  }

  const server = createServer((req, res) => {
    const lang = langOf(req.headers['x-gt-lang']);
    resLang.set(res, lang);
    acctLang.note(req.headers['x-account-id'], lang);
    handle(req, res).catch((e) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      send(res, status, { error: e instanceof HttpError ? e.message : 'internal error', ...(e instanceof HttpError && e.code ? { code: e.code } : {}) });
    });
  });
  return { server };
}
