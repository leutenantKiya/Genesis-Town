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
// Trading (trade(), hourly): the townsfolk also buy goods to sell again to a merchant at the admin's margin; the settings
// (wallet target, treasury reserve, trade) are config.json overlaid with meta `residents.settings`, the goods held and
// what they cost are in meta `residents.stock`: everything the admin sets lives in the database.
// Crafting (craft(), hourly): the townsfolk craft bread, meals and tools and stock the shelves of the merchants that sell
// them, which brings those prices down (settings `craft`).
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
interface Job { merchant: string; token: string; ask: number; to: Pos; sell?: boolean }
export interface ResidentControls { paused: boolean; allow: Record<string, string[]> }
export interface TradeSettings { enabled: boolean; marginPct: number; perHour: number; holdMax: number; minWallet: number }
export interface CraftSettings { enabled: boolean; marginPct: number; perHour: number; fillPct: number }
export interface ResidentSettings { target: number; treasuryReserve: number; trade: TradeSettings; craft: CraftSettings }
const CTL_KEY = 'residents.ctl', SETTINGS_KEY = 'residents.settings', STOCK_KEY = 'residents.stock';

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
    const set = this.settings(), need = set.target - gs.balance(this.wallet, 'coin');
    if (need <= 0) return 0;
    const free = Math.max(0, Math.min(gs.settledBalance(town, 'coin'), gs.balance(town, 'coin')) - set.treasuryReserve);
    const fromTown = Math.min(need, free);
    if (fromTown > 0) {
      gs.add(day, town, 'coin', -fromTown, 'handout', this.wallet);
      gs.add(day, this.wallet, 'coin', fromTown, 'handout', 'treasury');
    }
    const minted = Math.max(0, Math.min(need - fromTown, market.faucetLeft(day)));
    if (minted > 0) gs.add(day, this.wallet, 'coin', minted, 'handout_mint', 'faucet');
    return fromTown + minted;
  }

  /* ---------------------------------------------------------------- trading: buy to sell again at a margin */

  /** The townsfolk's settings: config.json `residents` (and `residents.trade`) overlaid with what the admin saved in
   *  meta `residents.settings` (adminbots.ts), so a restart or a deploy keeps them. */
  settings(): ResidentSettings {
    const c = this.cfg, t = c.trade ?? { enabled: false, marginPct: 5, perHour: 2, holdMax: 5, minWallet: 100 };
    const cc = c.craft ?? { enabled: false, marginPct: 0, perHour: 2, fillPct: 100 };
    let saved: Partial<ResidentSettings> & { trade?: Partial<TradeSettings>; craft?: Partial<CraftSettings> } = {};
    try { saved = JSON.parse(this.d.gs.meta(SETTINGS_KEY) ?? '{}'); } catch { /* bad row: the config's */ }
    const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    const st: Partial<TradeSettings> = saved.trade ?? {}, sc: Partial<CraftSettings> = saved.craft ?? {};
    return {
      target: num(saved.target, c.target), treasuryReserve: num(saved.treasuryReserve, c.treasuryReserve),
      trade: {
        enabled: typeof st.enabled === 'boolean' ? st.enabled : t.enabled, marginPct: num(st.marginPct, t.marginPct),
        perHour: num(st.perHour, t.perHour), holdMax: num(st.holdMax, t.holdMax), minWallet: num(st.minWallet, t.minWallet),
      },
      craft: {
        enabled: typeof sc.enabled === 'boolean' ? sc.enabled : cc.enabled, marginPct: num(sc.marginPct, cc.marginPct),
        perHour: num(sc.perHour, cc.perHour), fillPct: num(sc.fillPct, cc.fillPct),
      },
    };
  }
  setSettings(s: ResidentSettings) { this.d.gs.setMeta(SETTINGS_KEY, JSON.stringify(s)); }

  /** What the wallet holds to sell again, with what it paid (meta `residents.stock`: token -> { qty, cost }). */
  stock(): Record<string, { qty: number; cost: number }> {
    try { const s = JSON.parse(this.d.gs.meta(STOCK_KEY) ?? '{}'); return s && typeof s === 'object' ? s : {}; } catch { return {}; }
  }
  private setStock(s: Record<string, { qty: number; cost: number }>) { this.d.gs.setMeta(STOCK_KEY, JSON.stringify(s)); }

  /** The next resident (in turn) who may trade with this merchant, or null. */
  private pick(merchantId: string, c: ResidentControls): Walker | null {
    for (let k = 0; k < this.walkers.length; k++) {
      const w = this.walkers[(this.next + k) % this.walkers.length];
      if (this.allows(w, merchantId, c)) { this.next += k + 1; return w; }
    }
    return null;
  }
  private walkTo(merchantId: string, token: string, coin: number, sell: boolean) {
    const to = this.d.map ? this.stallFront(merchantId) : null;
    if (!to) return;
    this.queue.push({ merchant: this.d.market.account(merchantId), token, ask: coin, to, sell });
    if (this.queue.length > this.cfg.queueMax) this.queue.shift();
  }

  /** One hour of trading (game.step, after the town's shopping). Sells what the wallet holds when a merchant pays at
   *  least cost x (1 + marginPct / 100), and buys a good to sell again only when some merchant would pay that margin for
   *  it right now; marginPct may be negative (selling at a loss). At most `perHour` trades, never more than `holdMax` of a
   *  good held, never spending the wallet below `minWallet`. Merchants' own prices, stock, cash and daily caps apply
   *  (market.buy / market.sell, ledger kind `trade`, ref tagged `#<resident>`). Returns the trades made. */
  trade(): number {
    const s = this.settings().trade, c = this.controls();
    if (!this.ready || !s.enabled || c.paused || s.perHour < 1) return 0;
    const { market, gs, econ } = this.d, m = 1 + s.marginPct / 100, stock = this.stock();
    const ids = market.ids().filter((id) => market.isOpen(id) && this.walkers.some((w) => this.allows(w, id, c)));
    const bidOf = (token: string) => ids.filter((id) => market.def(id).buys.includes(token) && market.buyRoom(id, token) >= 1)
      .map((id) => ({ id, unit: market.quote(id, token, 'sell', 1).unit })).filter((o) => gs.balance(market.account(o.id), 'coin') >= o.unit)
      .sort((a, b) => b.unit - a.unit)[0] ?? null;
    let done = 0;
    const sell = (token: string): boolean => {
      const held = stock[token];
      if (!held || held.qty < 1 || gs.balance(this.wallet, token) < 1) return false;
      const bid = bidOf(token), avg = held.cost / held.qty;
      if (!bid || bid.unit < avg * m) return false;
      const w = this.pick(bid.id, c); if (!w) return false;
      try { market.sell(this.wallet, bid.id, token, 1, w.id); } catch { return false; }
      held.cost -= avg; held.qty -= 1; if (held.qty < 1) delete stock[token];
      this.walkTo(bid.id, token, bid.unit, true);
      done++;
      return true;
    };
    // 1. sell what is held
    for (const token of Object.keys(stock)) while (done < s.perHour && sell(token)) { /* one unit at a time */ }
    // 2. buy to sell again, when a merchant would pay the margin for it now
    for (const token of Object.keys(econ.items)) {
      if (token === 'coin') continue;
      while (done < s.perHour && (stock[token]?.qty ?? 0) < s.holdMax) {
        if (market.trend.withdrawn(token)) break;
        const ask = ids.filter((id) => market.def(id).sells.includes(token) && gs.balance(market.account(id), token) >= 1)
          .map((id) => ({ id, unit: market.quote(id, token, 'buy', 1).unit })).sort((a, b) => a.unit - b.unit)[0];
        const bid = bidOf(token);
        if (!ask || !bid || bid.unit < ask.unit * m || gs.balance(this.wallet, 'coin') - ask.unit < s.minWallet) break;
        const w = this.pick(ask.id, c); if (!w) break;
        try { market.buy(this.wallet, ask.id, token, 1, w.id); } catch { break; }
        const h = stock[token] ?? (stock[token] = { qty: 0, cost: 0 }); h.qty += 1; h.cost += ask.unit;
        this.walkTo(ask.id, token, ask.unit, false);
        done++;
        if (done < s.perHour) sell(token);
      }
    }
    this.setStock(stock);
    return done;
  }

  /** One hour of crafting (game.step, after trading): a resident buys a recipe's inputs from the cheapest merchant (or
   *  uses what the wallet holds beyond the trading stock), crafts it like a player (the recipe's fee to the treasury) and
   *  stocks the shelf of the merchant that sells the good, at that merchant's bid, while its stock is under `fillPct` % of
   *  its target. More stock lowers that merchant's ask, so crafting brings the price of bread, meals and tools down.
   *  Done only when the bid is at least the cost x (1 + marginPct / 100) (negative allowed), at most `perHour` crafts,
   *  never spending the wallet below the trading floor `minWallet`. Ledger: inputs kind `trade` (tag `<resident>-c`),
   *  the craft kind `resident_craft`, the sale kind `trade` (market.restock). Returns the crafts made. */
  craft(day: number): number {
    const set = this.settings(), s = set.craft, c = this.controls();
    if (!this.ready || !s.enabled || c.paused || s.perHour < 1) return 0;
    const { market, gs, econ, town } = this.d, m = 1 + s.marginPct / 100, held = this.stock();
    const ids = market.ids().filter((id) => market.isOpen(id) && this.walkers.some((w) => this.allows(w, id, c)));
    const spare = (tk: string) => Math.max(0, gs.balance(this.wallet, tk) - (held[tk]?.qty ?? 0));
    // the merchant that sells `out`, under its fill line, paying most for it now
    const shopFor = (out: string) => ids.filter((id) => market.def(id).sells.includes(out)).map((id) => {
      const d = market.def(id), acct = market.account(id), upTo = Math.floor(((d.target[out] ?? 10) * s.fillPct) / 100);
      return { id, upTo, room: upTo - gs.balance(acct, out), unit: market.quote(id, out, 'sell', 1).unit, cash: gs.balance(acct, 'coin') };
    }).filter((o) => o.room >= 1 && o.cash >= o.unit).sort((a, b) => b.unit - a.unit)[0] ?? null;
    type Recipe = (typeof econ.recipes)[string];
    // one unit of one recipe; false when it cannot (no shelf with room, no ingredients, margin not met, wallet floor)
    const one = (rid: string, r: Recipe): boolean => {
      const out = r.output, shop = shopFor(out);
      if (!shop) return false;
      const w = this.pick(shop.id, c); if (!w) return false;
      const tag = `${w.id}-c`;
      // a good crafted earlier that never reached a shelf goes first
      if (spare(out) >= 1) {
        try { market.restock(this.wallet, shop.id, out, 1, tag, shop.upTo); } catch { return false; }
        this.walkTo(shop.id, out, shop.unit, true);
        return true;
      }
      const plan: Array<{ tk: string; own: number; need: number; seller: { id: string; unit: number } | null }> = [];
      let cost = r.fee ?? 0, coin = r.fee ?? 0;
      for (const [tk, n] of Object.entries(r.inputs)) {
        const own = Math.min(n, spare(tk)), need = n - own;
        const seller = need < 1 ? null : ids.filter((id) => market.def(id).sells.includes(tk) && !market.trend.withdrawn(tk) && gs.balance(market.account(id), tk) >= need)
          .map((id) => ({ id, unit: market.quote(id, tk, 'buy', need).unit })).sort((a, b) => a.unit - b.unit)[0] ?? null;
        if (need >= 1 && !seller) return false;
        plan.push({ tk, own, need, seller });
        cost += own * econ.items[tk].base + (seller ? seller.unit * need : 0); // what the wallet already holds counts at its base value
        coin += seller ? seller.unit * need : 0;
      }
      if (shop.unit < cost * m || gs.balance(this.wallet, 'coin') - coin < set.trade.minWallet) return false;
      try { for (const p of plan) if (p.seller) market.buy(this.wallet, p.seller.id, p.tk, p.need, tag); } catch { return false; } // bought inputs stay as spare
      for (const p of plan) gs.add(day, this.wallet, p.tk, -(p.own + p.need), 'resident_craft', `${rid}#${w.id}`);
      gs.add(day, this.wallet, out, 1, 'resident_craft', `${rid}#${w.id}`);
      if (r.fee > 0) { gs.add(day, this.wallet, 'coin', -r.fee, 'fee', rid); gs.add(day, town, 'coin', r.fee, 'fee', `${rid}:${this.wallet}`); }
      for (const p of plan) if (p.seller) this.walkTo(p.seller.id, p.tk, p.seller.unit * p.need, false);
      try { market.restock(this.wallet, shop.id, out, 1, tag, shop.upTo); } catch { return true; } // kept as spare for next hour
      this.walkTo(shop.id, out, shop.unit, true);
      return true;
    };
    // the recipes take turns, one unit each per round, so bread does not use up the hour before meals get a go
    let done = 0, moved = true;
    const recipes = Object.entries(econ.recipes);
    while (done < s.perHour && moved) {
      moved = false;
      for (const [rid, r] of recipes) { if (done >= s.perHour) break; if (one(rid, r)) { done++; moved = true; } }
    }
    return done;
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
        if (j.sell) this.d.onDeal?.(this.account(w.id), j.merchant, { coin: j.ask }, { [j.token]: 1 });
        else this.d.onDeal?.(this.account(w.id), j.merchant, { [j.token]: 1 }, { coin: j.ask });
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
