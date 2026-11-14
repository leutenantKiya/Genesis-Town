// The townsfolk (economy/config.json `residents`): five residents the server walks around the village, the same for
// every player. They share ONE keyless wallet, `<wallet>.<merchant parent>` (no NEAR account, no key; the settler
// registers it like a player), and that wallet does the town's shopping:
//  - every unit of town demand (market.ts townDemand) is paid from the wallet to the merchant and booked under the
//    resident who made it (ledger ref `<resident id>:<merchant>:<good>`); the good is eaten, as before;
//  - the wallet lives on handouts: when it cannot pay, it is topped up to `target` from the town treasury (only what the
//    treasury holds above `treasuryReserve`, so starter kits keep coming) and only then from the coin faucet (new coin,
//    inside the same daily cap the contract checks). The faucet part is the only new money in the town's shopping now.
// The money moves when the town buys (hourly, in the game step, so a restart catches up the same way). The walk is only
// shown: the buyer then walks to that stall and the goods fly when it arrives (social.ts deals, client mods/trade.js).
// Until the wallet is registered on chain the town buys as before (new coin straight to the merchant), so settlement
// never carries rows for an account the contract would skip.
// Admin controls (adminbots.ts, kept in the meta table so a restart keeps them): `paused` stops the town's shopping, and
// `allow[resident]` lists the merchants that resident may buy from (missing = all); market.townDemand only picks a
// merchant some resident may buy from, and pay() books the purchase under such a resident.
import type { Chain } from '../chain.ts';
import type { Econ } from './econ.ts';
import type { GameStore } from './gamestore.ts';
import type { Market } from './market.ts';
import type { Pos, WorldMap } from './worldmap.ts';

export interface ResidentsDeps {
  econ: Econ; gs: GameStore; market: Market; chain: Chain; map: WorldMap | null; parent: string; town: string;
  now: () => number;
  /** A finished walk to a stall: the goods fly (app.ts -> social.deal). */
  onDeal?: (resident: string, merchant: string, got: Record<string, number>, paid: Record<string, number>) => void;
  log?: (line: string) => void;
}
/** What players are sent (presence): a resident is drawn like a player and tagged NPC. */
export interface ResidentView {
  id: string; account: string; name: string; look: number; x: number; y: number; fx: number; fy: number; vx: number; vy: number; dir: string;
  /** The walk being followed: tiles from the current one on as a flat [x, y, x, y, ...], started at server time `t0`
   *  (ms) at `sp` tiles a second. Clients place the resident from it every frame (players.js), so everyone sees the same. */
  route: { pts: number[]; t0: number; sp: number };
}
/** A new walk starts this long after it is chosen, so every client has it before the resident sets off (presence polls
 *  every 0.22-0.9 s): nobody sees a resident jump ahead to catch up with a walk it learned late. */
const ROUTE_LEAD_MS = 1200;

interface Walker {
  id: string; name: string; look: number;
  /** The route being walked (tiles), started at `t0`; a single point while standing. */
  path: Pos[]; t0: number; dir: string;
  /** Standing until this time (ms). */
  until: number;
  /** The purchase this walk ends in. */
  job: Job | null;
}
interface Job { merchant: string; token: string; ask: number; to: Pos }
export interface ResidentControls { paused: boolean; allow: Record<string, string[]> }
const CTL_KEY = 'residents.ctl';

const DIRS: Array<[number, number, string]> = [[1, 0, 'right'], [-1, 0, 'left'], [0, 1, 'down'], [0, -1, 'up']];

export class Residents {
  d: ResidentsDeps;
  /** The shared wallet's account id. */
  wallet: string;
  /** True once the wallet is registered on chain: only then does it pay for the town's shopping. */
  ready = false;
  walkers: Walker[] = [];
  queue: Job[] = [];
  next = 0;
  private spots: Pos[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(d: ResidentsDeps) {
    this.d = d;
    this.wallet = `${d.econ.residents.wallet}.${d.parent}`;
    const cfg = d.econ.residents, L = d.map?.layout as (WorldMap['layout'] & { plaza?: { x0: number; y0: number; x1: number; y1: number } }) | undefined;
    if (!cfg.enabled) return;
    // where residents stroll: open tiles of the square, and the doorsteps of the village's buildings (no map: no walks)
    const map = d.map;
    if (map && L) {
      if (L.plaza) for (let y = L.plaza.y0; y <= L.plaza.y1; y += 2) for (let x = L.plaza.x0; x <= L.plaza.x1; x += 2) if (map.walkable(x, y)) this.spots.push({ x, y });
      for (const b of L.buildings) if (b.open && map.walkable(b.dx, b.dy + 1)) this.spots.push({ x: b.dx, y: b.dy + 1 });
      if (!this.spots.length) this.spots.push(L.spawn);
    } else this.spots.push({ x: 0, y: 0 });
    const now = d.now();
    cfg.names.forEach((name, i) => {
      const at = this.spots[(i * 7) % this.spots.length];
      this.walkers.push({ id: `r${i + 1}`, name, look: cfg.looks[i] ?? i, path: [at], t0: now, dir: 'down', until: now + 1500 * i, job: null });
    });
  }

  get cfg() { return this.d.econ.residents; }
  /** A resident's account as players see it: not a wallet, only a name on the map. */
  account(id: string) { return `${id}.residents`; }

  /** The admin's controls (adminbots.ts): stored in meta, read on every purchase. */
  controls(): ResidentControls {
    try {
      const c = JSON.parse(this.d.gs.meta(CTL_KEY) ?? '{}') as Partial<ResidentControls>;
      const allow: Record<string, string[]> = {};
      if (c.allow && typeof c.allow === 'object') for (const [k, v] of Object.entries(c.allow)) if (Array.isArray(v)) allow[k] = v.map(String);
      return { paused: c.paused === true, allow };
    } catch { return { paused: false, allow: {} }; }
  }
  setControls(c: ResidentControls) { this.d.gs.setMeta(CTL_KEY, JSON.stringify({ paused: !!c.paused, allow: c.allow })); }
  private allows(w: Walker, merchantId: string, c: ResidentControls) { const a = c.allow[w.id]; return !a || a.includes(merchantId); }
  /** Whether the town may buy from this merchant now: not paused, and some resident may buy there. */
  canBuyFrom(merchantId: string): boolean {
    const c = this.controls();
    return !c.paused && (!this.walkers.length || this.walkers.some((w) => this.allows(w, merchantId, c)));
  }

  /** Registers the wallet on chain once (settler). Until that works the town buys the old way. */
  async ensure(): Promise<boolean> {
    if (!this.cfg.enabled) return false;
    try {
      if (!(await this.d.chain.isRegistered(this.wallet))) {
        const r = await this.d.chain.registerPlayer(this.wallet);
        if (!r.ok) throw new Error('register_player failed');
      }
      this.ready = true;
    } catch (e) {
      this.d.log?.(`residents: the wallet ${this.wallet} is not registered yet (${(e as Error).message}); the town buys the old way`);
    }
    return this.ready;
  }

  /** The town buys one `token` from `merchantId` at `ask`: paid from the wallet (handout first if short), booked under
   *  the next resident. Returns the resident's id, or null when even a handout cannot cover it (the town stops for now). */
  pay(day: number, merchantId: string, token: string, ask: number): string | null {
    const { gs } = this.d, c = this.controls();
    if (c.paused) return null;
    // the next resident (in turn) who may buy from this merchant
    let w: Walker | null = null, k = 0;
    for (; k < this.walkers.length; k++) { const cand = this.walkers[(this.next + k) % this.walkers.length]; if (this.allows(cand, merchantId, c)) { w = cand; break; } }
    if (this.walkers.length && !w) return null;
    if (gs.balance(this.wallet, 'coin') < ask) this.handout(day);
    if (gs.balance(this.wallet, 'coin') < ask) return null;
    this.next += k + 1;
    const rid = w ? w.id : 'r0';
    gs.add(day, this.wallet, 'coin', -ask, 'resident_buy', `${rid}:${merchantId}:${token}`);
    if (w && this.d.map) {
      const to = this.stallFront(merchantId);
      if (to) { this.queue.push({ merchant: this.d.market.account(merchantId), token, ask, to }); if (this.queue.length > this.cfg.queueMax) this.queue.shift(); }
    }
    return rid;
  }

  /** Tops the wallet up to `target`: from the treasury above its reserve, then new coin within today's faucet. */
  handout(day: number): number {
    const { gs, town, market } = this.d;
    const need = this.cfg.target - gs.balance(this.wallet, 'coin');
    if (need <= 0) return 0;
    const free = Math.max(0, Math.min(gs.settledBalance(town, 'coin'), gs.balance(town, 'coin')) - this.cfg.treasuryReserve);
    const fromTown = Math.min(need, free);
    if (fromTown > 0) {
      gs.add(day, town, 'coin', -fromTown, 'handout', this.wallet);
      gs.add(day, this.wallet, 'coin', fromTown, 'handout', 'treasury');
    }
    const minted = Math.max(0, Math.min(need - fromTown, market.faucetLeft(day)));
    if (minted > 0) gs.add(day, this.wallet, 'coin', minted, 'handout_mint', 'faucet');
    return fromTown + minted;
  }

  /* ---------------------------------------------------------------- walking (shown only) */

  start(ms = 400) {
    if (this.timer || !this.walkers.length || !this.d.map) return;
    this.timer = setInterval(() => this.tick(this.d.now()), ms);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** Moves the walks on: a resident who reached a stall buys (the goods fly), then everyone strolls or fetches. */
  tick(now: number) {
    if (!this.d.map) return;
    for (const w of this.walkers) {
      if (now < this.arrival(w)) continue;
      const end = w.path[w.path.length - 1];
      if (w.path.length > 1) { w.path = [end]; w.t0 = now; }
      if (w.job) {
        const j = w.job; w.job = null;
        this.d.onDeal?.(this.account(w.id), j.merchant, { [j.token]: 1 }, { coin: j.ask });
        w.until = now + 1800; w.dir = 'up';
        continue;
      }
      if (now < w.until) continue;
      const job = this.queue.shift();
      const goal = job ? job.to : this.spots[Math.floor(Math.random() * this.spots.length)];
      const path = this.route(end, goal);
      if (!path) { w.until = now + 3000; continue; }
      w.path = path; w.t0 = now + ROUTE_LEAD_MS; w.job = job ?? null;
      w.until = now + (job ? 0 : 2000 + Math.random() * 5000);
    }
  }

  /** Where everyone is now, between path points (presence; drawn smooth by players.js). */
  view(now = this.d.now()): ResidentView[] {
    return this.walkers.map((w) => {
      const p = this.at(w, now), moving = now >= w.t0 && now < this.arrival(w);
      const seg = this.segment(w, now);
      const dir = moving && seg ? (seg.dx > 0 ? 'right' : seg.dx < 0 ? 'left' : seg.dy > 0 ? 'down' : 'up') : w.dir;
      if (moving) w.dir = dir;
      const v = moving && seg ? this.cfg.speed : 0;
      // the rest of the walk from the current tile on (the tiles already behind are not sent)
      const i = Math.max(0, Math.min(w.path.length - 1, Math.floor(((now - w.t0) / 1000) * this.cfg.speed)));
      const pts: number[] = [];
      for (let k = i; k < w.path.length; k++) pts.push(w.path[k].x, w.path[k].y);
      const route = { pts, t0: Math.round(w.t0 + (i / this.cfg.speed) * 1000), sp: this.cfg.speed };
      return { id: w.id, account: this.account(w.id), name: w.name, look: w.look, x: Math.round(p.x), y: Math.round(p.y), fx: Math.round(p.x * 1000) / 1000, fy: Math.round(p.y * 1000) / 1000, vx: seg ? seg.dx * v : 0, vy: seg ? seg.dy * v : 0, dir, route };
    });
  }

  private arrival(w: Walker) { return w.t0 + ((w.path.length - 1) / this.cfg.speed) * 1000; }
  private segment(w: Walker, now: number) {
    if (w.path.length < 2) return null;
    const i = Math.max(0, Math.min(w.path.length - 2, Math.floor(((now - w.t0) / 1000) * this.cfg.speed)));
    const a = w.path[i], b = w.path[i + 1];
    return { dx: b.x - a.x, dy: b.y - a.y };
  }
  private at(w: Walker, now: number): Pos {
    const done = Math.max(0, ((now - w.t0) / 1000) * this.cfg.speed), last = w.path.length - 1;
    if (done >= last) return w.path[last];
    const i = Math.floor(done), f = done - i, a = w.path[i], b = w.path[i + 1];
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
  }

  /** The walkable tile in front of a merchant's stall, where players stand to trade. */
  stallFront(merchantId: string): Pos | null {
    const map = this.d.map, k = this.d.market.ids().indexOf(merchantId), s = map?.layout.market.stalls[k];
    if (!map || !s) return null;
    for (let r = 1; r <= 3; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const x = s.x + dx, y = s.y + 1 + dy;
      if (map.walkable(x, y) && map.nearStall({ x, y }, 1)) return { x, y };
    }
    return null;
  }

  /** Shortest walk on the village map (breadth first; the map is 96 x 96 tiles). */
  route(from: Pos, to: Pos): Pos[] | null {
    const map = this.d.map!, W = map.layout.w, H = map.layout.h;
    const sx = Math.round(from.x), sy = Math.round(from.y);
    if (sx === to.x && sy === to.y) return [{ x: sx, y: sy }];
    const prev = new Int32Array(W * H).fill(-1), start = sy * W + sx, goal = to.y * W + to.x;
    const q = [start]; prev[start] = start;
    for (let h = 0; h < q.length; h++) {
      const c = q[h];
      if (c === goal) break;
      const cx = c % W, cy = (c - cx) / W;
      for (const [dx, dy] of DIRS) {
        const x = cx + dx, y = cy + dy, n = y * W + x;
        if (x < 0 || y < 0 || x >= W || y >= H || prev[n] !== -1 || !map.walkable(x, y)) continue;
        prev[n] = c; q.push(n);
      }
    }
    if (prev[goal] === -1) return null;
    const out: Pos[] = [];
    for (let c = goal; ; c = prev[c]) { out.push({ x: c % W, y: (c - (c % W)) / W }); if (c === start) break; }
    return out.reverse();
  }
}
