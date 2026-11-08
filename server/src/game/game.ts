// Game orchestrator: wires the clock, world actions, markets and settlement, and runs the hourly/daily loop.
import type { Chain } from '../chain.ts';
import type { Store } from '../db.ts';
import { HttpError } from '../auth.ts';
import { loadEcon, type Econ } from './econ.ts';
import { GameStore } from './gamestore.ts';
import { Clock } from './clock.ts';
import { World, type Rng } from './world.ts';
import { Market } from './market.ts';
import { Settlement } from './settlement.ts';
import { WorldMap, Positions, HomelandMap, type GameMap, type Pos } from './worldmap.ts';
import { Homelands, homeWorld, parseHome } from './homeland.ts';
import type { HomelandRow } from './gamestore.ts';
import { MockChain } from '../chain.ts';
import { Monsters } from './monsters.ts';
import { worldIdOk } from '../social.ts';
import { Trade } from './trade.ts';
import { Consign } from './consign.ts';
import { leaderboard } from './leaderboard.ts';

export interface GameOptions { merchantParent: string; town: string; chunkSize?: number; now?: () => number; rng?: Rng; econ?: Econ; worldSeed?: number }

const ACTIONS = ['gather', 'craft', 'eat', 'farm', 'ship', 'sell', 'buy', 'fight', 'flee', 'engage', 'travel', 'build', 'collect', 'hire'] as const;

export class Game {
  econ: Econ;
  gs: GameStore;
  clock: Clock;
  world: World;
  market: Market;
  settlement: Settlement;
  /** The shared village map; absent in unit tests and the simulator, which use abstract tile coordinates. */
  map: WorldMap | null = null;
  positions: Positions | null = null;
  monsters: Monsters | null = null;
  homelands: Homelands;
  trade: Trade;
  consign: Consign;
  now: () => number;
  store: Store;
  chain: Chain;
  town: string;
  timer: NodeJS.Timeout | null = null;
  ticking = false;

  constructor(store: Store, chain: Chain, o: GameOptions) {
    this.econ = o.econ ?? loadEcon();
    this.store = store;
    this.chain = chain;
    this.town = o.town;
    this.gs = new GameStore(store.db);
    this.clock = new Clock(this.econ, this.gs, o.now);
    this.world = new World(this.econ, this.gs, this.clock, o.rng);
    this.market = new Market(this.econ, this.gs, this.clock, o.merchantParent, o.town);
    this.settlement = new Settlement({ econ: this.econ, gs: this.gs, store, chain, clock: this.clock, market: this.market, town: o.town, chunkSize: o.chunkSize ?? 25 });
    this.now = o.now ?? Date.now;
    this.homelands = new Homelands({ econ: this.econ, gs: this.gs, worldSeed: o.worldSeed ?? 0, now: this.now, town: o.town, players: { nameOf: (a) => store.nameOf(a), tagOf: (a) => store.tagOf(a), accountByNameTag: (n, t) => store.accountByNameTag(n, t), isPlayer: (a) => store.isPlayer(a) } });
    const hist = (a: string, summary: string, tokens: string[]) => { store.addHistory(a, 'trade', summary, 'offchain', null, null, tokens.filter((t) => t in this.econ.items)); };
    this.trade = new Trade({
      econ: this.econ, gs: this.gs, clock: this.clock, world: this.world, now: this.now, history: hist,
      names: { nameOf: (a) => store.nameOf(a), tagOf: (a) => store.tagOf(a), accountByNameTag: (n, t) => store.accountByNameTag(n, t), isPlayer: (a) => store.isPlayer(a) },
      where: (a) => (this.positions ? { world: this.positions.worldOf(a), pos: this.positions.last.get(a) ?? null } : null),
    });
    this.consign = new Consign({
      econ: this.econ, gs: this.gs, clock: this.clock, world: this.world, market: this.market, town: o.town, history: hist,
      atStall: (a) => {
        if (!this.map || !this.positions) return;
        const p = this.positions.worldOf(a) === 'public' ? this.positions.last.get(a) : undefined;
        if (!p || !this.map.nearLandmark(p, 'consign')) throw new HttpError(409, `Datang ke lapak Titip Jual (${this.econ.consign.merchant}) di pasar.`);
      },
    });
    if (o.worldSeed != null) {
      this.map = new WorldMap(o.worldSeed, JSON.parse(this.gs.meta('world.unlocked') ?? '[]'));
      this.positions = new Positions(this.map);
      if (this.econ.monsters && !this.econ.homeland.publicTradeOnly) this.monsters = new Monsters(this.econ, this.gs, this.clock, this.world, this.map, o.rng ?? Math.random);
    }
  }

  /** Today's weather on the shared map (the same for every player). */
  weather() { if (!this.map) return null; const t = this.clock.time(); return this.map.weather(t.day, t.season); }

  private need<T>(x: T | null): T { if (!x) throw new HttpError(400, 'unknown action'); return x; }

  /** A state poll from the player's client, with where they stand (ignored without the shared map). */
  reportPosition(account: string, pos: Pos | null, world = 'public') {
    if (!this.positions || !pos) return;
    this.fixWorld(account);
    try { this.positions.report(account, pos, this.now(), world, this.worldFor(account, world, false).map ?? undefined, this.homeFor(account, world)); } catch { /* a bad poll is not an action; the next action is checked */ }
  }

  /** The player's own Homeland as a place to land (page reload, Start): only when `world` is that Homeland and the server has them elsewhere. */
  private homeFor(account: string, world: string): { world: string; spawn: Pos } | undefined {
    if (!this.positions || world === 'public' || this.positions.worldOf(account) === world) return undefined;
    const id = parseHome(world);
    const row = id === null ? undefined : this.homelands.byId(id);
    if (!row || row.account !== account) return undefined;
    return { world, spawn: this.homelands.map(row).layout.spawn };
  }

  /** The map a request is about. Homelands: the owner (or, for walking and travel only, an invited guest) is let in; anyone else gets 409. */
  worldFor(account: string, wid: string, ownerOnly: boolean): { map: GameMap | null; row: HomelandRow | null } {
    if (wid === 'public') return { map: this.map, row: null };
    const id = parseHome(wid);
    if (id === null || !worldIdOk(wid) || wid !== homeWorld(id)) throw new HttpError(400, 'Dunia tidak dikenal.');
    if (!this.map) throw new HttpError(409, 'Dunia Homeland belum aktif.');
    const { row, owner } = this.homelands.access(account, id);
    if (ownerOnly && !owner) throw new HttpError(409, 'Ini bukan Homeland-mu. Tamu hanya boleh jalan-jalan.');
    return { map: this.homelands.map(row), row };
  }

  /** Kept for the HTTP layer: Homelands need no chain reads, so there is nothing to prepare. */
  async prepare(_account: string, _body: { world?: unknown }) { /* nothing to load */ }

  /** A player who may no longer be in the world the server has them in (guest uninvited) goes back to public. */
  fixWorld(account: string) {
    const w = this.positions?.worldOf(account);
    if (!this.positions || !w || w === 'public') return;
    try { this.worldFor(account, w, false); } catch { this.positions.reset(account); }
  }

  /** Portal trip: from within 2 tiles of this world's portal to the public area (arrive at its portal) or a Homeland you own or are invited to (arrive at its spawn). */
  private travel(account: string, from: string, fromMap: GameMap | null, to: string, pos: Pos): { toast: string; world: string; arrive: Pos } {
    if (!this.map || !this.positions || !fromMap) throw new HttpError(409, 'Perjalanan belum aktif.');
    if (!to) throw new HttpError(400, 'Mau ke mana?');
    if (to === from) throw new HttpError(409, 'Kamu sudah di sana.');
    const d = fromMap.portal();
    if (Math.abs(pos.x - d.x) + Math.abs(pos.y - d.y) > 2) throw new HttpError(409, 'Pergi ke portal dulu.');
    const target = this.worldFor(account, to, false);
    const arrive = target.row ? target.map!.layout.spawn : this.map.portal();
    this.positions.setWorld(account, to, arrive, this.now());
    return { toast: target.row ? (target.row.account === account ? 'Tiba di Homeland-mu.' : 'Tiba di Homeland temanmu.') : 'Tiba di area publik.', world: to, arrive };
  }

  /** Dev tool (mock chain only): moves coin that already exists from the town treasury to a player's settled balance. */
  async devGrant(account: string, coin: number) {
    if (!(this.chain instanceof MockChain)) throw new HttpError(403, 'only on the mock chain');
    if (!Number.isInteger(coin) || coin < 1 || coin > 100_000) throw new HttpError(400, 'coin 1-100000');
    const free = Math.min(this.gs.settledBalance(this.town, 'coin'), this.gs.balance(this.town, 'coin'));
    if (coin > free) throw new HttpError(409, `Kas desa hanya punya ${free} koin yang bebas.`);
    this.chain.add(this.town, 'coin', -BigInt(coin));
    this.chain.add(account, 'coin', BigInt(coin));
    await this.settlement.refresh([this.town, account]);
    return { granted: coin, coin: this.gs.balance(account, 'coin') };
  }

  /** Opens the map areas of town projects that are done on chain. Returns the chunks opened now. */
  async syncProjects(): Promise<string[]> {
    if (!this.map) return [];
    const opened: string[] = [];
    for (const p of await this.chain.listProjects()) if (p.done && this.unlockChunk(p.chunk)) opened.push(p.chunk);
    return opened;
  }

  /** Opens a chunk of the map for everyone (a finished town project). Persisted. */
  unlockChunk(chunkId: string) {
    if (!this.map || !this.map.unlock(chunkId)) return false;
    this.gs.setMeta('world.unlocked', JSON.stringify(this.map.unlocked));
    return true;
  }

  /** Loads on-chain state the off-chain game depends on: town treasury, merchant balances, shop status, supply. */
  async init() {
    await this.settlement.refresh([this.town, ...this.market.ids().map((id) => this.market.account(id))]);
    await this.settlement.refreshShops();
    await this.syncProjects();
    if (!this.gs.meta('clock.hour')) this.gs.setMeta('clock.hour', String(this.clock.hours()));
  }

  /** Runs missed game hours (prices, merchant crafting, town demand), then any due settlement. */
  async step() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const last = Number(this.gs.meta('clock.hour') ?? this.clock.hours());
      const now = this.clock.hours();
      // merchants only spend on crafting on days someone plays (a quiet town keeps its shops' cash)
      const busy = this.gs.activeAccounts(this.clock.time().settleDay) > 0;
      for (let h = Math.max(last + 1, now - 24); h <= now; h++) {
        this.market.tickAll();
        if (busy) this.market.merchantCraft();
        this.market.townDemand();
        this.consign.tick();
      }
      this.gs.setMeta('clock.hour', String(now));
      await this.settlement.settleDue();
    } finally {
      this.ticking = false;
    }
  }

  start(intervalMs = 2000) {
    this.timer = setInterval(() => { this.step().catch((e) => console.error('game step:', e)); }, intervalMs);
    this.timer.unref?.();
  }

  stop() { if (this.timer) clearInterval(this.timer); }

  onNewPlayer(account: string) { this.world.starter(account, this.town); this.homelands.ensure(account); }

  /** Off-chain action from the player. Every one is logged in Riwayat as "waiting for settlement". */
  /** An account whose settlement debit the chain could not cover is frozen until the operator lifts it. */
  assertActive(account: string) {
    if (this.gs.isFrozen(account)) throw new HttpError(403, 'Akun ini dibekukan karena saldo on-chain tidak cocok dengan permainan. Hubungi pengelola.');
  }

  act(account: string, body: Record<string, unknown>) {
    this.assertActive(account);
    const a = String(body.action ?? '');
    this.fixWorld(account);
    if (!(ACTIONS as readonly string[]).includes(a)) throw new HttpError(400, 'unknown action');
    const s = (k: string) => String(body[k] ?? '');
    const n = (k: string, d = 1) => Number(body[k] ?? d);
    // Knocked out by a monster: nothing works until 06:00. A monster in the way: fight or flee first.
    if (this.monsters) {
      this.monsters.checkAwake(account);
      if (this.monsters.pending.has(account) && a !== 'fight' && a !== 'flee') throw new HttpError(409, `${this.monsters.pending.get(account)!.name} menghadang! Lawan atau lari dulu.`);
    }
    // With the shared map, every action says where the player stands, and the action must happen there.
    // Every action says which world it is in (default: the public area). Homelands: only the owner acts; guests just walk.
    const wid = s('world') || 'public';
    const w = this.worldFor(account, wid, a !== 'travel');
    const home = this.econ.homeland;
    if (this.map && wid === 'public' && home.publicTradeOnly && (a === 'gather' || a === 'farm' || a === 'engage')) throw new HttpError(409, 'Area publik hanya untuk berdagang.');
    if (w.row && a === 'ship') throw new HttpError(409, 'Kotak Kirim hanya ada di area publik.');
    if (w.row && a === 'engage') throw new HttpError(409, 'Tidak ada monster di Homeland.');
    if ((a === 'build' || a === 'collect' || a === 'hire') && !w.row) throw new HttpError(409, 'Bangun dan panen di Homeland-mu sendiri.');
    let pos: Pos | null = null;
    if (this.map && this.positions && w.map) {
      pos = this.positions.report(account, body.pos, this.now(), wid, w.map, this.homeFor(account, wid));
      const far = (msg: string) => { throw new HttpError(409, msg); };
      if (a === 'gather' && Math.abs(pos.x - n('x', -1)) + Math.abs(pos.y - n('y', -1)) !== 1) far('Terlalu jauh. Berdiri tepat di sebelahnya.');
      if ((a === 'sell' || a === 'buy') && !w.map.nearStall(pos)) far('Jual-beli dilakukan di lapak pedagang di pasar.');
      if (a === 'farm' && !w.map.nearPlot(pos, n('plot', -1))) far('Berdiri di sebelah petak kebunmu.');
      if ((a === 'craft' || a === 'ship') && !w.map.atOwnHouse(pos)) far(a === 'craft' ? 'Meja Kerja ada di Balai Kota-mu.' : 'Kotak Kirim ada di rumahmu.');
      if (a === 'build' && w.map instanceof HomelandMap) {
        if (s('kind') === 'build') { if (!w.map.nearLot(pos, s('target'))) far('Berdiri di dekat lahan itu.'); }
        else if (!w.map.atOwnHouse(pos)) far('Berdiri di depan Balai Kota.');
      }
      if (a === 'hire' && !w.map.atOwnHouse(pos)) far('Berdiri di depan Balai Kota.');
      if (a === 'collect' && w.map instanceof HomelandMap && !w.map.nearLot(pos, s('lot'))) far('Berdiri di dekat bangunannya.');
    }
    let res: { toast: string; tags?: string[]; world?: string; arrive?: Pos; gained?: Record<string, number> };
    switch (a) {
      case 'gather': {
        w.map?.checkGather(s('tile'), n('x', -1), n('y', -1));
        const enc = w.row ? null : this.monsters?.maybeEncounter(account, s('tile'), n('x', -1), n('y', -1));
        if (enc) { res = { toast: `${enc.name} menghadang! Lawan atau lari.` }; break; }
        res = this.world.gather(account, s('tile'), n('x', -1), n('y', -1), w.row ? `${wid}:` : '', w.row && this.econ.gather.tiles[s('tile')] === 'wood' ? this.homelands.effects(account).woodBonus : 0); // Homeland nodes are charged per Homeland
        break;
      }
      case 'fight': res = this.need(this.monsters).fight(account); break;
      case 'engage': {
        const enc = this.need(this.monsters).engage(account, s('monster'), (body.pos ?? {}) as { x: number; y: number });
        res = { toast: `${enc.name} menyerang! Lawan atau lari.` };
        break;
      }
      case 'flee': res = this.need(this.monsters).flee(account); break;
      case 'craft': res = this.world.craft(account, s('recipe')); break;
      case 'eat': res = this.world.eat(account, s('token')); break;
      case 'farm': res = this.world.farm(account, s('op'), n('plot', -1), w.row ? { plotAccount: `${account}@${wid}`, count: this.farmCount(w.row), growDays: Math.max(1, Math.ceil(this.econ.farm.growDays / this.homelands.effects(account).farmGrowFactor - 1e-9)), yieldBonus: 0 } : undefined); break;
      case 'travel': res = this.travel(account, wid, w.map, s('to'), pos ?? { x: -9, y: -9 }); break;
      case 'build': res = this.homelands.start(account, s('kind') as 'th' | 'chunk' | 'build', s('target'), this.clock.time().settleDay); break;
      case 'hire': res = this.homelands.hire(account, s('job'), this.clock.time().settleDay); break;
      case 'collect': res = this.homelands.collect(account, s('lot'), this.clock.time().settleDay, (acc, t, q) => this.world.checkGain(acc, t, q)); break;
      case 'ship': res = this.world.ship(account, s('token'), n('qty')); break;
      case 'sell': {
        // the coin earned counts toward the daily coin gain cap (same as the contract's settlement check)
        try { this.world.checkGain(account, 'coin', this.market.quote(s('merchant'), s('token'), 'sell', n('qty')).total); } catch (e) { if (e instanceof HttpError && e.status === 409) throw e; }
        res = this.market.sell(account, s('merchant'), s('token'), n('qty'));
        break;
      }
      default: if (Number.isInteger(n('qty')) && n('qty') > 0) this.world.checkGain(account, s('token'), n('qty')); res = this.market.buy(account, s('merchant'), s('token'), n('qty')); break;
    }
    if (a !== 'farm') {
      const tags = new Set<string>(Object.keys((res as { gained?: Record<string, number> }).gained ?? {}));
      if (body.token) tags.add(String(body.token));
      if (a === 'craft') {
        const r = this.econ.recipes[s('recipe')];
        for (const t of Object.keys(r.inputs)) tags.add(t);
        tags.add(r.output);
        if (r.fee > 0) tags.add('coin');
      }
      if (a === 'gather' && this.econ.gather.tiles[s('tile')]) tags.add(this.econ.gather.tiles[s('tile')]);
      if (a === 'buy' || a === 'sell') tags.add('coin');
      for (const t of res.tags ?? []) tags.add(t);
      this.store.addHistory(account, a, res.toast, 'offchain', null, null, [...tags].filter((t) => t in this.econ.items));
    }
    return { ...res, state: this.state(account) };
  }

  /** Farm plots in a Homeland: one per Town Hall level, up to 6. */
  private farmCount(row: HomelandRow) { return Math.min(row.th, 6); }

  state(account: string) {
    this.fixWorld(account);
    const koUntil = this.monsters?.koUntil(account) ?? null; // first: waking up restores energy
    const t = this.clock.time();
    const weather = this.weather();
    if (weather && (this.positions?.worldOf(account) ?? 'public') === 'public') this.world.rainWater(account, weather.wet); // rain waters the farm by itself
    const wid = this.positions?.worldOf(account) ?? 'public';
    const hid = wid === 'public' ? null : parseHome(wid);
    const hrow = hid ? this.homelands.byId(hid) : undefined;
    const field = hrow && hrow.account === account ? this.farmCount(hrow) : null;
    const p = this.world.state(account);
    const bag: Record<string, { settled: number; today: number; name: string }> = {};
    for (const [token, def] of Object.entries(this.econ.items)) {
      bag[token] = { settled: this.gs.settledBalance(account, token), today: this.gs.pending(account, token), name: def.name };
    }
    return {
      time: { ...t, fraction: this.clock.hourFraction(), msPerHour: this.econ.time.realMsPerGameHour, settledThrough: this.settlement.settledThrough() },
      energy: Math.floor(p.energy), energyMax: this.econ.gather.energyMax,
      tool: { uses: p.tool_uses, durability: this.econ.items.tool.durability ?? 20 },
      bag,
      worldId: hrow ? wid : 'public',
      homeland: this.homelands.view(account),
      plots: (field ? this.world.plots(`${account}@${wid}`, field) : hrow ? [] : this.world.plots(account)).map((x) => ({ idx: x.idx, state: x.state, grown: x.grown, wateredToday: x.watered_day === t.day })),
      world: this.map ? { seed: this.map.seed, unlocked: this.map.unlocked } : null,
      encounter: this.monsters?.pending.get(account) ?? null,
      koUntil,
      night: this.monsters ? { now: this.monsters.isNight(), guarded: this.monsters.guarded() } : null,
      weather,
    };
  }

  /** Papan Juara. */
  leaderboard(period: 'day' | 'all', me: string | null) {
    const merchants = new Set(this.market.ids().map((id) => this.market.account(id)));
    return leaderboard(this.gs, period, this.clock.time().settleDay, me, (a) => a !== this.town && !merchants.has(a),
      (a) => ({ name: this.store.nameOf(a) ?? a.split('.')[0], tag: this.store.tagOf(a) }));
  }

  merchants() { return this.market.ids().map((id) => this.market.view(id)); }

  async shops(account?: string) {
    const shops = await this.settlement.refreshShops();
    const out = [];
    for (const s of shops) {
      const id = s.account_id.split('.')[0];
      out.push({ ...s, id, holding: account ? await this.chain.holding(s.account_id, account) : null });
    }
    return out;
  }

  /** Dev panel: jump to the next 06:00 and settle now. */
  async devSettle() {
    this.clock.skipToNextSettlement();
    await this.step();
    return { settledThrough: this.settlement.settledThrough(), settlements: this.gs.settlements(5) };
  }
}
