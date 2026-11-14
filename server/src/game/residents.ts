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
// Nobody steers the townsfolk (2026-11-15): there is no admin setting any more, and what an admin saved earlier in the
// meta table (`residents.settings`, `residents.ctl`, `town.maxPriceMult`) is ignored. Their numbers come from
// economy/config.json and follow the market (auto()): at least `meals` (2) foods and `burnWood` (1) wood a day, one more
// when food or wood is cheap; the resale margin falls as the wallet fills. `tune` and `ctl` are in-memory overrides for
// tests and simulations only: no route sets them.
// Trading (trade(), hourly): the townsfolk also buy goods to sell again to a merchant at the admin's margin; the settings
// (wallet target, treasury reserve, trade) are config.json overlaid with meta `residents.settings`, the goods held and
// what they cost are in meta `residents.stock`: everything the admin sets lives in the database.
// Crafting (craft(), hourly): the townsfolk craft bread, meals and tools and stock the shelves of the merchants that sell
// them, which brings those prices down (settings `craft`).
// Gathering (gather() + stockShelves(), hourly): when a raw good is scarce or dear the townsfolk fish, chop, harvest or
// mine it, cook and craft with it first, and put the rest on the shelf of the merchant that sells it (settings `gather`).
// Meals (eat(), hourly): each resident eats `meals` foods (bread or grilled fish) a game day from the shared bag, buying
// the cheapest when the bag has none (settings `meals`, today's count in meta `residents.meals`).
// Firewood (burn(), hourly): each resident burns `burnWood` wood a game day in the evening, bought from a merchant every
// time (the bag's own wood only when nobody sells any), so wood has a buyer every day (meta `residents.burn`).
// Roles (config `roles`, one per name): the women ('cook') make the food (bread, grilled fish) and the men ('gather')
// fish, chop, mine and hoe, and make the tools. Every job is shown: the resident walks to the tree, rock, ripple, field or
// table and works there for a few seconds (presence `act`, and `fish` for the rod), so other players can watch.
import type { Chain } from '../chain.ts';
import type { Econ } from './econ.ts';
import type { GameStore } from './gamestore.ts';
import type { Market } from './market.ts';
import type { Pos, WorldMap } from './worldmap.ts';

export interface ResidentsDeps {
  econ: Econ; gs: GameStore; market: Market; chain: Chain; map: WorldMap | null; parent: string; town: string;
  now: () => number;
  /** Is (x, y) a fishing spot now (the ripples, game.ts fishSpotAt), and the catch there moves it (moveRipple). */
  fishSpot?: (x: number, y: number) => boolean;
  fished?: (x: number, y: number) => void;
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
  /** Work on the spot (chop, mine, hoe, cook, eat, burn) at tile x, y; a fishing resident sends `fish` like a player. */
  act?: { kind: string; x: number; y: number };
  fish?: { phase: 'cast' | 'wait' | 'bite' | 'reel'; x: number; y: number };
}
/** A new walk starts this long after it is chosen, so every client has it before the resident sets off (presence polls
 *  every 0.22-0.9 s): nobody sees a resident jump ahead to catch up with a walk it learned late. */
const ROUTE_LEAD_MS = 1200;

export type Role = 'cook' | 'gather';
interface Act { kind: string; x: number; y: number; ms: number }
interface Walker {
  id: string; name: string; look: number;
  /** cook: makes the food; gather: fishes, chops, mines, hoes and makes tools. */
  role: Role;
  /** The work being done on the spot, from `start` for `ms`. */
  act: (Act & { start: number }) | null;
  /** The route being walked (tiles), started at `t0`; a single point while standing. */
  path: Pos[]; t0: number; dir: string;
  /** Standing until this time (ms). */
  until: number;
  /** The purchase this walk ends in. */
  job: Job | null;
}
/** A walk: to a stall to buy or sell (merchant = its account), or (act) to a spot to work there. `who`: only that resident takes it. */
interface Job { merchant: string; token: string; ask: number; to: Pos; sell?: boolean; who?: string; act?: Act }
/** One step a resident is doing or will do (admin: the townsfolk's next steps). */
export interface Step { kind: string; merchant?: string; token?: string; coin?: number; until?: number }
export interface ResidentControls { paused: boolean; allow: Record<string, string[]> }
export interface TradeSettings { enabled: boolean; marginPct: number; perHour: number; holdMax: number; minWallet: number }
export interface CraftSettings { enabled: boolean; marginPct: number; perHour: number; fillPct: number }
export interface GatherSettings { enabled: boolean; goods: string[]; perHour: number; dailyMax: number; minPricePct: number; fillPct: number; keepMax: number }
export interface ResidentSettings { target: number; treasuryReserve: number; meals: number; burnWood: number; trade: TradeSettings; craft: CraftSettings; gather: GatherSettings }
const STOCK_KEY = 'residents.stock', MEALS_KEY = 'residents.meals', TOOLS_KEY = 'residents.tools', BURN_KEY = 'residents.burn';
/** How long each kind of work is shown on the spot (ms). */
const ACT_MS: Record<string, number> = { fish: 7000, chop: 5000, mine: 5000, hoe: 4500, cook: 5000, eat: 3000, burn: 4000 };
/** The work that gathers each raw good. */
const GATHER_ACT: Record<string, string> = { fish: 'fish', wood: 'chop', ore: 'mine', wheat: 'hoe' };
/** The raw good each tool's use gathers (economy/config.json `tools[*].use`). */
const USE_GOOD: Record<string, string> = { water: 'fish', tree: 'wood', rock: 'ore', farm: 'wheat' };

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
  /** The turn for trading and crafting, apart from the town's shopping turn (`next`). */
  nextJob = 0;
  private spots: Pos[] = [];
  /** Where each kind of work is done: the target tile and a walkable tile next to it (trees, rocks, shore water, fields, tables). */
  private nodes: Record<string, Array<{ x: number; y: number; stand: Pos }>> = { chop: [], mine: [], fish: [], hoe: [], cook: [] };
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
      // the work spots: each target with a walkable neighbour to stand on
      const T = (L as unknown as { tiles: string[] }).tiles, W = (L as unknown as { w: number }).w, H = (L as unknown as { h: number }).h;
      const V = (globalThis as unknown as { GTVillage?: { fishShore(L: unknown, x: number, y: number): boolean } }).GTVillage;
      const standBy = (x: number, y: number): Pos | null => { for (const [dx, dy] of DIRS) if (map.walkable(x + dx, y + dy)) return { x: x + dx, y: y + dy }; return null; };
      const plots = new Set(((L as unknown as { farm?: { plots: Pos[] } }).farm?.plots ?? []).map((q) => `${q.x},${q.y}`));
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const t = T[y * W + x];
        const kind = t === 'tree' ? 'chop' : t === 'rock' ? 'mine' : t === 'table' ? 'cook' : t === 'water' && V?.fishShore(L, x, y) ? 'fish' : plots.has(`${x},${y}`) ? 'hoe' : null;
        if (!kind) continue;
        const stand = kind === 'hoe' && map.walkable(x, y + 1) ? { x, y: y + 1 } : standBy(x, y);
        if (stand) this.nodes[kind].push({ x, y, stand });
      }
      if (!this.nodes.hoe.length) for (let y = 0; y < H; y += 3) for (let x = 0; x < W; x += 3) if (T[y * W + x] === 'grass' && map.walkable(x, y) && map.walkable(x, y + 1)) this.nodes.hoe.push({ x, y, stand: { x, y: y + 1 } });
    } else this.spots.push({ x: 0, y: 0 });
    const now = d.now();
    cfg.names.forEach((name, i) => {
      const at = this.spots[(i * 7) % this.spots.length];
      const role: Role = cfg.roles?.[i] === 'cook' ? 'cook' : 'gather';
      this.walkers.push({ id: `r${i + 1}`, name, look: cfg.looks[i] ?? i, role, act: null, path: [at], t0: now, dir: 'down', until: now + 1500 * i, job: null });
    });
  }

  get cfg() { return this.d.econ.residents; }
  /** A resident's account as players see it: not a wallet, only a name on the map. */
  account(id: string) { return `${id}.residents`; }

  /** Tests and simulations only (in memory, no route): pause the shopping or limit a resident to some merchants. */
  private ctl: ResidentControls = { paused: false, allow: {} };
  /** Tests and simulations only (in memory, no route): fixed settings instead of the ones that follow the market. */
  private tune: ResidentSettings | null = null;
  controls(): ResidentControls { return { paused: this.ctl.paused, allow: { ...this.ctl.allow } }; }
  setControls(c: ResidentControls) { this.ctl = { paused: !!c.paused, allow: { ...c.allow } }; }

  /** The numbers that follow the market, and what they were read from: the cheapest food and wood against their base
   *  value, and how full the wallet is against its target. */
  auto(): { meals: number; burnWood: number; marginPct: number; food: { token: string; ask: number; pct: number } | null; wood: { ask: number; pct: number } | null; walletFill: number; cheapPct: number } {
    const c = this.cfg, a = c.adaptive ?? { cheapPct: 80, mealsMax: c.meals ?? 2, burnMax: c.burnWood ?? 1, marginMin: c.trade?.marginPct ?? 5, marginMax: c.trade?.marginPct ?? 5 };
    const { econ, gs } = this.d, minMeals = c.meals ?? 2, minBurn = c.burnWood ?? 1;
    const pct = (tk: string) => { const o = this.cheapestAsk(tk); return o ? { ask: o.unit, pct: Math.round((o.unit / econ.items[tk].base) * 100) } : null; };
    const foods = Object.keys(econ.items).filter((t) => econ.items[t].energy).map((t) => ({ token: t, ...(pct(t) ?? { ask: 0, pct: Infinity }) })).filter((f) => Number.isFinite(f.pct)).sort((x, y) => x.pct - y.pct);
    const food = foods[0] ?? null, wood = econ.items.wood ? pct('wood') : null;
    const fill = c.target > 0 ? Math.max(0, Math.min(1, gs.balance(this.wallet, 'coin') / c.target)) : 1;
    return {
      meals: Math.max(minMeals, food && food.pct <= a.cheapPct ? a.mealsMax : minMeals),
      burnWood: Math.max(minBurn, wood && wood.pct <= a.cheapPct ? a.burnMax : minBurn),
      marginPct: Math.round((a.marginMax - (a.marginMax - a.marginMin) * fill) * 10) / 10,
      food, wood, walletFill: Math.round(fill * 100) / 100, cheapPct: a.cheapPct,
    };
  }
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

  /** Tops the wallet up to `target`: from the treasury above its reserve, then (unless `mint` is false) new coin within
   *  today's faucet. Trading and crafting ask with `mint` false: their losses never print coin. */
  handout(day: number, mint = true): number {
    const { gs, town, market } = this.d;
    const set = this.settings(), need = set.target - gs.balance(this.wallet, 'coin');
    if (need <= 0) return 0;
    const free = Math.max(0, Math.min(gs.settledBalance(town, 'coin'), gs.balance(town, 'coin')) - set.treasuryReserve);
    const fromTown = Math.min(need, free);
    if (fromTown > 0) {
      gs.add(day, town, 'coin', -fromTown, 'handout', this.wallet);
      gs.add(day, this.wallet, 'coin', fromTown, 'handout', 'treasury');
    }
    const minted = mint ? Math.max(0, Math.min(need - fromTown, market.faucetLeft(day))) : 0;
    if (minted > 0) gs.add(day, this.wallet, 'coin', minted, 'handout_mint', 'faucet');
    return fromTown + minted;
  }

  /* ---------------------------------------------------------------- trading: buy to sell again at a margin */

  /** The townsfolk's settings: config.json `residents`, with meals, firewood and the resale margin following the market
   *  (auto()). Nothing is read from the database. */
  settings(): ResidentSettings {
    if (this.tune) return this.tune;
    const au = this.auto();
    const c = this.cfg, t = c.trade ?? { enabled: false, marginPct: 5, perHour: 2, holdMax: 5, minWallet: 100 };
    const cc = c.craft ?? { enabled: false, marginPct: 0, perHour: 2, fillPct: 100 };
    const cg = c.gather ?? { enabled: false, goods: [], perHour: 2, dailyMax: 20, minPricePct: 100, fillPct: 100, keepMax: 10 };
    const saved: { target?: number; treasuryReserve?: number; meals?: number; burnWood?: number; trade?: Partial<TradeSettings>; craft?: Partial<CraftSettings>; gather?: Partial<GatherSettings> } = { meals: au.meals, burnWood: au.burnWood, trade: { marginPct: au.marginPct } };
    const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    const st: Partial<TradeSettings> = saved.trade ?? {}, sc: Partial<CraftSettings> = saved.craft ?? {}, sg: Partial<GatherSettings> = saved.gather ?? {};
    return {
      target: num(saved.target, c.target), treasuryReserve: num(saved.treasuryReserve, c.treasuryReserve), meals: num(saved.meals, c.meals ?? 2), burnWood: num(saved.burnWood, c.burnWood ?? 1),
      trade: {
        enabled: typeof st.enabled === 'boolean' ? st.enabled : t.enabled, marginPct: num(st.marginPct, t.marginPct),
        perHour: num(st.perHour, t.perHour), holdMax: num(st.holdMax, t.holdMax), minWallet: num(st.minWallet, t.minWallet),
      },
      craft: {
        enabled: typeof sc.enabled === 'boolean' ? sc.enabled : cc.enabled, marginPct: Math.max(0, num(sc.marginPct, cc.marginPct)), // never crafted at a loss
        perHour: num(sc.perHour, cc.perHour), fillPct: num(sc.fillPct, cc.fillPct),
      },
      gather: {
        enabled: typeof sg.enabled === 'boolean' ? sg.enabled : cg.enabled, goods: Array.isArray(sg.goods) ? sg.goods.map(String) : cg.goods.slice(),
        perHour: num(sg.perHour, cg.perHour), dailyMax: num(sg.dailyMax, cg.dailyMax), minPricePct: num(sg.minPricePct, cg.minPricePct),
        fillPct: num(sg.fillPct, cg.fillPct), keepMax: num(sg.keepMax, cg.keepMax),
      },
    };
  }
  /** Tests and simulations only: fix every setting (null: follow the market again). In memory; no route calls it. */
  setSettings(s: ResidentSettings | null) { this.tune = s; }

  /** What the wallet holds to sell again, with what it paid (meta `residents.stock`: token -> { qty, cost }). */
  stock(): Record<string, { qty: number; cost: number }> {
    try { const s = JSON.parse(this.d.gs.meta(STOCK_KEY) ?? '{}'); return s && typeof s === 'object' ? s : {}; } catch { return {}; }
  }
  private setStock(s: Record<string, { qty: number; cost: number }>) { this.d.gs.setMeta(STOCK_KEY, JSON.stringify(s)); }

  /** The next resident (in turn) who may trade with this merchant, or null. */
  private pick(merchantId: string, c: ResidentControls, role?: Role): Walker | null {
    for (let k = 0; k < this.walkers.length; k++) {
      const w = this.walkers[(this.nextJob + k) % this.walkers.length];
      if ((!role || w.role === role) && this.allows(w, merchantId, c)) { this.nextJob += k + 1; return w; }
    }
    return null;
  }
  /** Who makes `out`: the cooks make food (an item with energy), the gatherers the rest (tools). */
  roleFor(out: string): Role { return this.d.econ.items[out]?.energy ? 'cook' : 'gather'; }
  private push(j: Job) {
    this.queue.push(j);
    if (this.queue.length > this.cfg.queueMax) this.queue.shift();
  }
  private walkTo(merchantId: string, token: string, coin: number, sell: boolean, who?: string) {
    const to = this.d.map ? this.stallFront(merchantId) : null;
    if (!to) return;
    this.push({ merchant: this.d.market.account(merchantId), token, ask: coin, to, sell, who });
  }
  /** Queues `who` walking to a spot for `kind` of work (chop, mine, fish, hoe, cook; eat and burn at a strolling spot)
   *  near where the resident will be, and working there. Shown only: the goods were already booked. */
  private workAt(w: Walker, kind: string) {
    if (!this.d.map) return;
    const from = w.path[w.path.length - 1];
    let list = this.nodes[kind] ?? [];
    if (kind === 'fish' && this.d.fishSpot) { const rip = list.filter((n) => this.d.fishSpot!(n.x, n.y)); if (rip.length) list = rip; }
    let spot: { x: number; y: number; stand: Pos };
    if (list.length) {
      const near = list.map((n) => ({ n, d: Math.abs(n.stand.x - from.x) + Math.abs(n.stand.y - from.y) })).sort((a, b) => a.d - b.d).slice(0, 6);
      spot = near[Math.floor(Math.random() * near.length)].n;
    } else {
      const at = this.spots[Math.floor(Math.random() * this.spots.length)];
      spot = { x: at.x, y: at.y, stand: at };
    }
    this.push({ merchant: '', token: '', ask: 0, to: spot.stand, who: w.id, act: { kind, x: spot.x, y: spot.y, ms: ACT_MS[kind] ?? 4000 } });
  }

  /** One hour of trading (game.step, after the town's shopping). Sells what the wallet holds when a merchant pays at
   *  least cost x (1 + marginPct / 100), and buys a good to sell again only when some merchant would pay that margin for
   *  it right now; marginPct may be negative (selling at a loss). At most `perHour` trades, never more than `holdMax` of a
   *  good held, never spending the wallet below `minWallet`. Merchants' own prices, stock, cash and daily caps apply
   *  (market.buy / market.sell, ledger kind `trade`, ref tagged `#<resident>`). A wallet short of that floor asks for an
   *  allowance from the treasury (above its reserve, never new coin). Returns the trades made. */
  trade(day: number): number {
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
      this.walkTo(bid.id, token, bid.unit, true, w.id);
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
        if (!ask || !bid || bid.unit < ask.unit * m) break;
        if (gs.balance(this.wallet, 'coin') - ask.unit < s.minWallet) this.handout(day, false); // from the treasury only
        if (gs.balance(this.wallet, 'coin') - ask.unit < s.minWallet) break;
        const w = this.pick(ask.id, c); if (!w) break;
        try { market.buy(this.wallet, ask.id, token, 1, w.id); } catch { break; }
        const h = stock[token] ?? (stock[token] = { qty: 0, cost: 0 }); h.qty += 1; h.cost += ask.unit;
        this.walkTo(ask.id, token, ask.unit, false, w.id);
        done++;
        if (done < s.perHour) sell(token);
      }
    }
    this.setStock(stock);
    return done;
  }

  /** One hour of crafting (game.step, after trading): a resident buys a recipe's inputs from the cheapest merchant (or
   *  uses what the wallet holds beyond the trading stock), crafts it like a player (the recipe's fee to the treasury) and
   *  stocks the shelf of the merchant that sells the good dearest, while its stock is under `fillPct` % of its target.
   *  More stock lowers that merchant's ask, so crafting brings the price of bread, meals and tools down. The townsfolk's job
   *  is to keep prices fair: a good is crafted only when making it costs less than the merchant sells it for (cost x (1 +
   *  marginPct / 100) < its ask; never at a loss), and the merchant pays the cost of making it (below its own ask), at most
   *  `perHour` crafts,
   *  never spending the wallet below the trading floor `minWallet` (short: an allowance from the treasury, never new coin). Ledger: inputs kind `trade` (tag `<resident>-c`),
   *  the craft kind `resident_craft`, the sale kind `trade` (market.restock). Returns the crafts made. */
  craft(day: number): number {
    const set = this.settings(), s = set.craft, c = this.controls();
    if (!this.ready || !s.enabled || c.paused || s.perHour < 1) return 0;
    const { market, gs, econ, town } = this.d, m = 1 + s.marginPct / 100, held = this.stock();
    const ids = market.ids().filter((id) => market.isOpen(id) && this.walkers.some((w) => this.allows(w, id, c)));
    const spare = (tk: string) => Math.max(0, gs.balance(this.wallet, tk) - (held[tk]?.qty ?? 0));
    // the merchant that sells `out` dearest (its ask: what players pay), under its fill line
    const shopFor = (out: string) => ids.filter((id) => market.def(id).sells.includes(out)).map((id) => {
      const d = market.def(id), acct = market.account(id), upTo = Math.floor(((d.target[out] ?? 10) * s.fillPct) / 100);
      return { id, upTo, room: upTo - gs.balance(acct, out), ask: market.quote(id, out, 'buy', 1).unit, unit: market.quote(id, out, 'sell', 1).unit, cash: gs.balance(acct, 'coin') };
    }).filter((o) => o.room >= 1 && o.cash >= 1).sort((a, b) => b.ask - a.ask)[0] ?? null;
    type Recipe = (typeof econ.recipes)[string];
    // one unit of one recipe; false when it cannot (no shelf with room, no ingredients, margin not met, wallet floor)
    const one = (rid: string, r: Recipe): boolean => {
      const out = r.output, shop = shopFor(out);
      if (!shop) return false;
      const w = this.pick(shop.id, c, this.roleFor(out)); if (!w) return false; // the women cook, the men make tools
      const tag = `${w.id}-c`;
      // a good crafted earlier that never reached a shelf goes first
      if (spare(out) >= 1) {
        if (shop.cash < shop.unit) return false;
        try { market.restock(this.wallet, shop.id, out, 1, tag, shop.upTo); } catch { return false; }
        this.walkTo(shop.id, out, shop.unit, true, w.id);
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
      // making it must be cheaper than buying it from the merchant; then the merchant pays what it cost to make
      if (cost * m >= shop.ask) return false;
      const pay = Math.max(1, Math.min(shop.ask - 1, Math.ceil(cost)));
      if (shop.cash < pay) return false;
      if (gs.balance(this.wallet, 'coin') - coin < set.trade.minWallet) this.handout(day, false); // from the treasury only
      if (gs.balance(this.wallet, 'coin') - coin < set.trade.minWallet) return false;
      try { for (const p of plan) if (p.seller) market.buy(this.wallet, p.seller.id, p.tk, p.need, tag); } catch { return false; } // bought inputs stay as spare
      for (const p of plan) gs.add(day, this.wallet, p.tk, -(p.own + p.need), 'resident_craft', `${rid}#${w.id}`);
      gs.add(day, this.wallet, out, 1, 'resident_craft', `${rid}#${w.id}`);
      if (r.fee > 0) { gs.add(day, this.wallet, 'coin', -r.fee, 'fee', rid); gs.add(day, town, 'coin', r.fee, 'fee', `${rid}:${this.wallet}`); }
      for (const p of plan) if (p.seller) this.walkTo(p.seller.id, p.tk, p.seller.unit * p.need, false, w.id);
      this.workAt(w, 'cook'); // at a table: cooking, baking or making the tool
      try { market.restock(this.wallet, shop.id, out, 1, tag, shop.upTo, pay); } catch { return true; } // kept as spare for next hour
      this.walkTo(shop.id, out, pay, true, w.id);
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

/* ---------------------------------------------------------------- gathering: fishing, chopping, harvesting, mining */

  /** The cheapest a merchant sells `good` for now (in stock), or null when nobody has it: then it is scarce. */
  private cheapestAsk(good: string): { id: string; unit: number } | null {
    const { market, gs } = this.d;
    return market.ids().filter((id) => market.isOpen(id) && market.def(id).sells.includes(good) && !market.trend.withdrawn(good) && gs.balance(market.account(id), good) >= 1)
      .map((id) => ({ id, unit: market.quote(id, good, 'buy', 1).unit })).sort((a, b) => a.unit - b.unit)[0] ?? null;
  }
  /** The tool a raw good needs (rod, axe, pickaxe, hoe), or null. */
  toolFor(good: string): string | null {
    const tools = this.d.econ.tools ?? {};
    return Object.keys(tools).find((k) => USE_GOOD[tools[k].use] === good) ?? null;
  }
  /** Each resident's own tools and the uses left on them (meta `residents.tools`: resident -> tool -> uses). */
  tools(): Record<string, Record<string, number>> {
    try { const t = JSON.parse(this.d.gs.meta(TOOLS_KEY) ?? '{}'); return t && typeof t === 'object' ? t : {}; } catch { return {}; }
  }
  private setTools(t: Record<string, Record<string, number>>) { this.d.gs.setMeta(TOOLS_KEY, JSON.stringify(t)); }
  /** A resident buys a brand-new tool at Ben's tool stall (economy/config.json `toolShop`): a broken tool is replaced,
   *  never repaired. Paid from the bag (an allowance from the treasury when short, never new coin), the coin to the stall's
   *  merchant (kind `tool_shop`, ref `buy:<tool>#<resident>`). False when the stall is closed or the money is not there. */
  private buyTool(day: number, w: Walker, kind: string, tools: Record<string, Record<string, number>>): boolean {
    const { econ, market, gs } = this.d, ts = econ.toolShop, price = ts?.price?.[kind], def = econ.tools?.[kind];
    if (!ts || !def || !(price >= 1) || !market.ids().includes(ts.merchant) || !market.isOpen(ts.merchant)) return false;
    if (gs.balance(this.wallet, 'coin') < price) this.handout(day, false);
    if (gs.balance(this.wallet, 'coin') < price) return false;
    const ref = `buy:${kind}#${w.id}`, shop = market.account(ts.merchant);
    gs.add(day, this.wallet, 'coin', -price, 'tool_shop', ref);
    gs.add(day, shop, 'coin', price, 'tool_shop', ref);
    (tools[w.id] ??= {})[kind] = def.durability;
    this.walkTo(ts.merchant, 'tool', price, false, w.id);
    return true;
  }

  /** The residents who gather (the men): fish, chop, mine and hoe. */
  crew(): Walker[] { return this.walkers.filter((w) => w.role === 'gather'); }
  /** Units of `good` the townsfolk gathered on `day`. */
  gatheredOn(day: number, good: string): number { return this.d.gs.sumKind(day, this.wallet, good, 'resident_gather'); }

  /** One hour of gathering (game.step, before crafting): for each raw good the admin picked (fish, wood, wheat, ore) that
   *  is scarce or dear (no merchant has it, or the cheapest costs at least `minPricePct` % of its base value), the
   *  residents fish, chop, harvest or mine up to `perHour` units, at most `dailyMax` a game day, and never keep more than
   *  `keepMax` spare in the bag. Each unit wears one use of the gathering resident's own tool (rod, axe, pickaxe, hoe); a
   *  broken or missing tool is bought new at Ben's tool stall. The catch first feeds crafting and cooking (own goods count at their base value), the
   *  rest goes to the shelves (stockShelves). Ledger kind `resident_gather`, ref `<good>#<resident>`. */
  gather(day: number): number {
    const set = this.settings(), s = set.gather, c = this.controls(), crew = this.crew();
    if (!this.ready || !s.enabled || c.paused || s.perHour < 1 || !crew.length) return 0;
    const { gs, econ } = this.d, held = this.stock(), tools = this.tools();
    let done = 0;
    const worked = new Set<string>();
    for (const good of s.goods) {
      if (econ.items[good]?.kind !== 'raw') continue;
      const spare = gs.balance(this.wallet, good) - (held[good]?.qty ?? 0);
      const ask = this.cheapestAsk(good);
      if (ask && ask.unit < (econ.items[good].base * s.minPricePct) / 100) continue; // cheap enough: leave it to players
      const n = Math.min(s.perHour, s.dailyMax - this.gatheredOn(day, good), s.keepMax - spare), tool = this.toolFor(good);
      for (let i = 0; i < n; i++) {
        // the next resident whose own tool still has a use; when every one is worn out, the next resident buys a new one
        let w = crew[this.nextJob % crew.length];
        if (tool) {
          const ready = crew.map((_, k) => crew[(this.nextJob + k) % crew.length]).find((x) => (tools[x.id]?.[tool] ?? 0) >= 1);
          if (ready) w = ready;
          else if (!this.buyTool(day, w, tool, tools)) break; // a broken tool is replaced at Ben's, never repaired
          tools[w.id][tool] -= 1;
        }
        this.nextJob = crew.indexOf(w) + 1;
        gs.add(day, this.wallet, good, 1, 'resident_gather', `${good}#${w.id}`);
        if (!worked.has(`${good}:${w.id}`)) { worked.add(`${good}:${w.id}`); this.workAt(w, GATHER_ACT[good] ?? 'hoe'); } // shown once per good and resident an hour
        done++;
      }
    }
    this.setTools(tools);
    return done;
  }

  /** After crafting: what is left of the catch goes to the shelf of the merchant that sells it (its bid), while that
   *  shelf is under `fillPct` % of its target, which brings that price down. Tag `<resident>-g`. A good nobody sells
   *  (ore) stays in the bag for crafting. */
  stockShelves(day: number): number {
    const set = this.settings(), s = set.gather, c = this.controls();
    if (!this.ready || !s.enabled || c.paused || !this.walkers.length) return 0;
    const { market, gs, econ } = this.d, held = this.stock();
    let done = 0;
    for (const good of s.goods) {
      if (econ.items[good]?.kind !== 'raw') continue;
      while (done < s.perHour * 2 && gs.balance(this.wallet, good) - (held[good]?.qty ?? 0) >= 1) {
        const shop = market.ids().filter((id) => market.isOpen(id) && market.def(id).sells.includes(good)).map((id) => {
          const upTo = Math.floor(((market.def(id).target[good] ?? 10) * s.fillPct) / 100), acct = market.account(id);
          return { id, upTo, room: upTo - gs.balance(acct, good), unit: market.quote(id, good, 'sell', 1).unit, cash: gs.balance(acct, 'coin') };
        }).filter((o) => o.room >= 1 && o.cash >= o.unit).sort((a, b) => a.room - b.room || b.unit - a.unit)[0];
        if (!shop) break;
        const w = this.pick(shop.id, c); if (!w) break;
        try { market.restock(this.wallet, shop.id, good, 1, `${w.id}-g`, shop.upTo); } catch { break; }
        this.walkTo(shop.id, good, shop.unit, true);
        done++;
      }
    }
    return done;
  }

  /* ---------------------------------------------------------------- meals: every resident eats `meals` foods a game day */

  /** How many meals a resident should have had by this hour of the game day (the day runs from 06:00; the meals are spread
   *  evenly: with 2, at 12:00 and 24:00). */
  mealsDue(hour: number, meals = this.settings().meals): number {
    const since = (((hour - 6) % 24) + 24) % 24;
    let due = 0;
    for (let k = 0; k < meals; k++) if (since >= Math.round(((k + 0.5) * 24) / meals)) due++;
    return due;
  }
  /** Today's meals per resident (meta `residents.meals`, reset each game day). */
  meals(day: number): { day: number; ate: Record<string, number> } {
    try { const m = JSON.parse(this.d.gs.meta(MEALS_KEY) ?? '{}'); if (m && m.day === day && m.ate && typeof m.ate === 'object') return m; } catch { /* a new day */ }
    return { day, ate: {} };
  }

  /** Each hour (game.step): every resident who is behind on today's meals eats one food from the shared bag (the cheapest
   *  food it holds beyond the goods kept to sell again: bread or grilled fish, a crafted one too), else buys the cheapest
   *  food a merchant has (an allowance from the treasury when short, never new coin; tag `<resident>-e`). Ledger kind
   *  `resident_eat`, ref the resident. A resident with no food and no coin stays hungry until something turns up. */
  eat(day: number, hour: number): number {
    const set = this.settings();
    if (!this.ready || set.meals < 1 || !this.walkers.length) return 0;
    const { market, gs, econ } = this.d, held = this.stock(), due = this.mealsDue(hour, set.meals), log = this.meals(day);
    const foods = Object.keys(econ.items).filter((t) => econ.items[t].energy).sort((a, b) => econ.items[a].base - econ.items[b].base);
    const ids = market.ids().filter((id) => market.isOpen(id));
    let eaten = 0;
    for (const w of this.walkers) {
      while ((log.ate[w.id] ?? 0) < due) {
        let food = foods.find((t) => gs.balance(this.wallet, t) - (held[t]?.qty ?? 0) >= 1) ?? null;
        if (!food) {
          const offer = foods.flatMap((t) => ids.filter((id) => market.def(id).sells.includes(t) && !market.trend.withdrawn(t) && gs.balance(market.account(id), t) >= 1)
            .map((id) => ({ id, t, unit: market.quote(id, t, 'buy', 1).unit }))).sort((a, b) => a.unit - b.unit)[0];
          if (!offer) break;
          if (gs.balance(this.wallet, 'coin') < offer.unit) this.handout(day, false); // from the treasury only
          if (gs.balance(this.wallet, 'coin') < offer.unit) break;
          try { market.buy(this.wallet, offer.id, offer.t, 1, `${w.id}-e`); } catch { break; }
          this.walkTo(offer.id, offer.t, offer.unit, false, w.id);
          food = offer.t;
        }
        gs.add(day, this.wallet, food, -1, 'resident_eat', w.id);
        this.workAt(w, 'eat');
        log.ate[w.id] = (log.ate[w.id] ?? 0) + 1;
        eaten++;
      }
    }
    this.d.gs.setMeta(MEALS_KEY, JSON.stringify(log));
    return eaten;
  }

  /* ---------------------------------------------------------------- firewood: every resident burns `burnWood` wood a day */

  /** How many fires a resident should have lit by this hour: in the evening, from 18:00 (with 2, at 18:00 and 24:00). */
  burnDue(hour: number, n = this.settings().burnWood): number {
    const since = (((hour - 6) % 24) + 24) % 24;
    let due = 0;
    for (let k = 0; k < n; k++) if (since >= Math.round(12 + (k * 12) / n)) due++;
    return due;
  }
  /** Today's fires per resident (meta `residents.burn`, reset each game day); `cold`: fires missed for want of wood. */
  burns(day: number): { day: number; burnt: Record<string, number>; cold: Record<string, number> } {
    try { const m = JSON.parse(this.d.gs.meta(BURN_KEY) ?? '{}'); if (m && m.day === day && m.burnt && typeof m.burnt === 'object') return { day, burnt: m.burnt, cold: m.cold ?? {} }; } catch { /* a new day */ }
    return { day, burnt: {}, cold: {} };
  }
  /** Each hour (game.step, after meals): every resident who is behind on today's fires buys one wood from the merchant
   *  that sells it cheapest and burns it (an allowance from the treasury when short, never new coin; tag `<resident>-w`,
   *  ledger kind `resident_burn`). Bought every time, so wood sells every day; the bag's own wood is burnt only when no
   *  merchant has any or the wallet cannot pay. A resident with neither stays cold (counted in `cold`). Returns the fires lit. */
  burn(day: number, hour: number): number {
    const set = this.settings();
    if (!this.ready || set.burnWood < 1 || !this.walkers.length) return 0;
    const { market, gs } = this.d, held = this.stock(), due = this.burnDue(hour, set.burnWood), log = this.burns(day);
    let burnt = 0;
    for (const w of this.walkers) {
      while ((log.burnt[w.id] ?? 0) < due) {
        const offer = market.ids().filter((id) => market.isOpen(id) && market.def(id).sells.includes('wood') && !market.trend.withdrawn('wood') && gs.balance(market.account(id), 'wood') >= 1)
          .map((id) => ({ id, unit: market.quote(id, 'wood', 'buy', 1).unit })).sort((a, b) => a.unit - b.unit)[0];
        let bought = false;
        if (offer) {
          if (gs.balance(this.wallet, 'coin') < offer.unit) this.handout(day, false); // from the treasury only
          if (gs.balance(this.wallet, 'coin') >= offer.unit) {
            try { market.buy(this.wallet, offer.id, 'wood', 1, `${w.id}-w`); this.walkTo(offer.id, 'wood', offer.unit, false, w.id); bought = true; } catch { bought = false; }
          }
        }
        if (!bought && gs.balance(this.wallet, 'wood') - (held.wood?.qty ?? 0) < 1) { log.cold[w.id] = (log.cold[w.id] ?? 0) + 1; break; }
        gs.add(day, this.wallet, 'wood', -1, 'resident_burn', w.id);
        log.burnt[w.id] = (log.burnt[w.id] ?? 0) + 1;
        this.workAt(w, 'burn');
        burnt++;
      }
    }
    this.d.gs.setMeta(BURN_KEY, JSON.stringify(log));
    return burnt;
  }

  /* ---------------------------------------------------------------- what each resident does now and next (admin) */

  /** Each resident's step now and the walks queued for them, and the queued walks anyone may take. */
  plan(now = this.d.now()): { per: Record<string, { doing: Step; next: Step[] }>; open: Step[] } {
    const step = (j: Job): Step => j.act ? { kind: j.act.kind } : { kind: j.sell ? 'sell' : 'buy', merchant: j.merchant, token: j.token, coin: j.ask };
    const per: Record<string, { doing: Step; next: Step[] }> = {};
    for (const w of this.walkers) {
      let doing: Step;
      if (w.act && now < w.act.start + w.act.ms) doing = { kind: w.act.kind, until: w.act.start + w.act.ms };
      else if (w.job) doing = w.job.act ? { kind: `to_${w.job.act.kind}` } : { ...step(w.job), kind: `to_${step(w.job).kind}` };
      else if (now < this.arrival(w)) doing = { kind: 'stroll' };
      else doing = { kind: 'rest', until: w.until };
      per[w.id] = { doing, next: this.queue.filter((j) => j.who === w.id).map(step) };
    }
    return { per, open: this.queue.filter((j) => !j.who).map(step) };
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
      if (w.act && now >= w.act.start + w.act.ms) { // the work is done: a catch moves the ripples on
        if (w.act.kind === 'fish' && this.d.fishSpot?.(w.act.x, w.act.y)) this.d.fished?.(w.act.x, w.act.y);
        w.act = null;
      }
      if (now < this.arrival(w)) continue;
      const end = w.path[w.path.length - 1];
      if (w.path.length > 1) { w.path = [end]; w.t0 = now; }
      if (w.job) {
        const j = w.job; w.job = null;
        if (j.act) { // at the spot: work there, facing it
          const dx = j.act.x - end.x, dy = j.act.y - end.y;
          w.dir = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : dx < 0 ? 'left' : 'down') : dy > 0 ? 'down' : 'up';
          w.act = { ...j.act, start: now }; w.until = now + j.act.ms + 600;
          continue;
        }
        if (j.sell) this.d.onDeal?.(this.account(w.id), j.merchant, { coin: j.ask }, { [j.token]: 1 });
        else this.d.onDeal?.(this.account(w.id), j.merchant, { [j.token]: 1 }, { coin: j.ask });
        w.until = now + 1800; w.dir = 'up';
        continue;
      }
      if (now < w.until) continue;
      const qi = this.queue.findIndex((j) => !j.who || j.who === w.id); // a walk for this resident, or one anyone may take
      const job = qi >= 0 ? this.queue.splice(qi, 1)[0] : undefined;
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
      const a = w.act && now >= w.act.start && now < w.act.start + w.act.ms ? w.act : null, el = a ? now - a.start : 0;
      const work = a ? (a.kind === 'fish'
        ? { fish: { phase: (el < 800 ? 'cast' : el < a.ms - 2200 ? 'wait' : el < a.ms - 1400 ? 'bite' : 'reel') as 'cast' | 'wait' | 'bite' | 'reel', x: a.x, y: a.y } }
        : { act: { kind: a.kind, x: a.x, y: a.y } }) : {};
      return { id: w.id, account: this.account(w.id), name: w.name, look: w.look, x: Math.round(p.x), y: Math.round(p.y), fx: Math.round(p.x * 1000) / 1000, fy: Math.round(p.y * 1000) / 1000, vx: seg ? seg.dx * v : 0, vy: seg ? seg.dy * v : 0, dir, route, ...work };
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
