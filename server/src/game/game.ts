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
import { WorldMap, Positions, type GameMap, type Pos } from './worldmap.ts';
import { Islands, parseWorld, worldId, type VoucherSigner } from './islands.ts';
import type { IslandRow } from './gamestore.ts';
import { MockChain } from '../chain.ts';
import { Monsters } from './monsters.ts';

export interface GameOptions { merchantParent: string; town: string; chunkSize?: number; now?: () => number; rng?: Rng; econ?: Econ; worldSeed?: number; contractId?: string; voucherSigner?: VoucherSigner }

const ACTIONS = ['gather', 'craft', 'eat', 'farm', 'ship', 'sell', 'buy', 'fight', 'flee', 'engage', 'travel', 'island_upgrade'] as const;

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
  islands: Islands;
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
    this.islands = new Islands({ econ: this.econ, gs: this.gs, chain, contractId: o.contractId ?? 'game.genesistown.testnet', signer: o.voucherSigner });
    if (o.worldSeed != null) {
      this.map = new WorldMap(o.worldSeed, JSON.parse(this.gs.meta('world.unlocked') ?? '[]'));
      this.positions = new Positions(this.map);
      if (this.econ.monsters) this.monsters = new Monsters(this.econ, this.gs, this.clock, this.world, this.map, o.rng ?? Math.random);
    }
  }

  /** Today's weather on the shared map (the same for every player). */
  weather() { if (!this.map) return null; const t = this.clock.time(); return this.map.weather(t.day, t.season); }

  private need<T>(x: T | null): T { if (!x) throw new HttpError(400, 'unknown action'); return x; }

  /** A state poll from the player's client, with where they stand (ignored without the shared map). */
  reportPosition(account: string, pos: Pos | null, world = 'public') {
    if (!this.positions || !pos) return;
    try { this.positions.report(account, pos, this.now(), world, this.worldFor(account, world, false).map ?? undefined); } catch { /* a bad poll is not an action; the next action is checked */ }
  }

  /** The map a request is about. Islands: the owner (or, for walking only, an invited guest) is let in; anyone else gets 409. */
  worldFor(account: string, wid: string, ownerOnly: boolean): { map: GameMap | null; row: IslandRow | null } {
    if (wid === 'public') return { map: this.map, row: null };
    const id = parseWorld(wid);
    if (id === null) throw new HttpError(400, 'Dunia tidak dikenal.');
    if (!this.map) throw new HttpError(409, 'Dunia pulau belum aktif.');
    const { row, owner } = this.islands.access(account, id);
    if (ownerOnly && !owner) throw new HttpError(409, 'Ini bukan pulaumu. Tamu hanya boleh jalan-jalan.');
    return { map: this.islands.map(row), row };
  }

  /** Boat trip from a dock: to the public island (arrive at its dock) or to an island you own or are invited to. */
  private travel(account: string, from: string, fromMap: GameMap | null, to: string, pos: Pos): { toast: string; world: string; arrive: Pos } {
    if (!this.map || !this.positions || !fromMap) throw new HttpError(409, 'Perjalanan antar pulau belum aktif.');
    if (!to) throw new HttpError(400, 'Mau ke mana?');
    if (to === from) throw new HttpError(409, 'Kamu sudah di sana.');
    const d = fromMap.dock();
    if (Math.abs(pos.x - d.x) + Math.abs(pos.y - d.y) > 2) throw new HttpError(409, 'Pergi ke dermaga dulu.');
    const target = this.worldFor(account, to, false);
    const arrive = target.row ? target.map!.layout.spawn : this.map.dock();
    this.positions.setWorld(account, to, arrive, this.now());
    return { toast: target.row ? `Tiba di ${this.islands.state(target.row).name}.` : 'Tiba di Pulau Publik.', world: to, arrive };
  }

  private upgradeIsland(account: string, id: number, attr: string, wid: string) {
    if (wid !== worldId(id)) throw new HttpError(409, 'Tingkatkan pulaumu dari papan di pulaumu sendiri.');
    return this.islands.upgrade(account, id, attr, this.clock.time().settleDay);
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
    await this.islands.syncAll(true); // island ownership comes from the chain, not from the last run's database
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

  onNewPlayer(account: string) { this.world.starter(account, this.town); }

  /** Off-chain action from the player. Every one is logged in Riwayat as "waiting for settlement". */
  act(account: string, body: Record<string, unknown>) {
    const a = String(body.action ?? '');
    if (!(ACTIONS as readonly string[]).includes(a)) throw new HttpError(400, 'unknown action');
    const s = (k: string) => String(body[k] ?? '');
    const n = (k: string, d = 1) => Number(body[k] ?? d);
    // Knocked out by a monster: nothing works until 06:00. A monster in the way: fight or flee first.
    if (this.monsters) {
      this.monsters.checkAwake(account);
      if (this.monsters.pending.has(account) && a !== 'fight' && a !== 'flee') throw new HttpError(409, `${this.monsters.pending.get(account)!.name} menghadang! Lawan atau lari dulu.`);
    }
    // With the shared map, every action says where the player stands, and the action must happen there.
    // Every action says which world it is in (default: the public island). Islands: only the owner acts; guests just walk.
    const wid = s('world') || 'public';
    const w = this.worldFor(account, wid, a !== 'travel');
    let pos: Pos | null = null;
    if (this.map && this.positions && w.map) {
      pos = this.positions.report(account, body.pos, this.now(), wid, w.map);
      const far = (msg: string) => { throw new HttpError(409, msg); };
      if (a === 'gather' && Math.abs(pos.x - n('x', -1)) + Math.abs(pos.y - n('y', -1)) !== 1) far('Terlalu jauh. Berdiri tepat di sebelahnya.');
      if ((a === 'sell' || a === 'buy') && !w.map.nearStall(pos)) far('Jual-beli dilakukan di lapak pedagang di pasar.');
      if (a === 'farm' && !w.map.nearPlot(pos, n('plot', -1))) far('Berdiri di sebelah petak kebunmu.');
      if ((a === 'craft' || a === 'ship') && !w.map.atOwnHouse(pos)) far(a === 'craft' ? 'Meja Kerja ada di rumahmu.' : 'Kotak Kirim ada di rumahmu.');
    }
    if (w.row && (a === 'ship' || a === 'engage')) throw new HttpError(409, a === 'ship' ? 'Kotak Kirim hanya ada di Pulau Publik.' : 'Tidak ada monster di pulau pribadi.');
    let res: { toast: string; tags?: string[]; world?: string; arrive?: Pos; gained?: Record<string, number> };
    switch (a) {
      case 'gather': {
        w.map?.checkGather(s('tile'), n('x', -1), n('y', -1));
        const enc = w.row ? null : this.monsters?.maybeEncounter(account, s('tile'), n('x', -1), n('y', -1));
        if (enc) { res = { toast: `${enc.name} menghadang! Lawan atau lari.` }; break; }
        res = this.world.gather(account, s('tile'), n('x', -1), n('y', -1), w.row ? `${wid}:` : ''); // island nodes are charged per island
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
      case 'farm': res = this.world.farm(account, s('op'), n('plot', -1), w.row ? { plotAccount: `${account}@${wid}`, ...this.islands.farmOf(w.row, this.econ.farm.growDays) } : undefined); break;
      case 'travel': res = this.travel(account, wid, w.map, s('to'), pos ?? { x: -9, y: -9 }); break;
      case 'island_upgrade': res = this.upgradeIsland(account, n('island_id', -1), s('attr'), wid); break;
      case 'ship': res = this.world.ship(account, s('token'), n('qty')); break;
      case 'sell': res = this.market.sell(account, s('merchant'), s('token'), n('qty')); break;
      default: res = this.market.buy(account, s('merchant'), s('token'), n('qty')); break;
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

  state(account: string) {
    const koUntil = this.monsters?.koUntil(account) ?? null; // first: waking up restores energy
    const t = this.clock.time();
    const weather = this.weather();
    if (weather && (this.positions?.worldOf(account) ?? 'public') === 'public') this.world.rainWater(account, weather.wet); // rain waters the farm by itself
    const wid = this.positions?.worldOf(account) ?? 'public';
    const islandId = wid === 'public' ? null : parseWorld(wid);
    const irow = islandId ? this.gs.island(islandId) : undefined;
    const onIsland = !!irow && irow.owner === account;
    const field = onIsland ? this.islands.farmOf(irow, this.econ.farm.growDays) : null;
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
      worldId: irow ? wid : 'public',
      island: irow ? { island_id: irow.island_id, owner: irow.owner, mine: onIsland, ...this.islands.live(irow), ...(field ?? {}) } : null,
      plots: (field ? this.world.plots(`${account}@${wid}`, field.count) : irow ? [] : this.world.plots(account)).map((x) => ({ idx: x.idx, state: x.state, grown: x.grown, wateredToday: x.watered_day === t.day })),
      world: this.map ? { seed: this.map.seed, unlocked: this.map.unlocked } : null,
      encounter: this.monsters?.pending.get(account) ?? null,
      koUntil,
      night: this.monsters ? { now: this.monsters.isNight(), guarded: this.monsters.guarded() } : null,
      weather,
    };
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
