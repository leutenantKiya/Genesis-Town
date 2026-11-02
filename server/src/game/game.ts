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
import { WorldMap, Positions, type Pos } from './worldmap.ts';

export interface GameOptions { merchantParent: string; town: string; chunkSize?: number; now?: () => number; rng?: Rng; econ?: Econ; worldSeed?: number }

const ACTIONS = ['gather', 'craft', 'eat', 'farm', 'ship', 'sell', 'buy'] as const;

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
    if (o.worldSeed != null) {
      this.map = new WorldMap(o.worldSeed, JSON.parse(this.gs.meta('world.unlocked') ?? '[]'));
      this.positions = new Positions(this.map);
    }
  }

  /** A state poll from the player's client, with where they stand (ignored without the shared map). */
  reportPosition(account: string, pos: Pos | null) {
    if (!this.positions || !pos) return;
    try { this.positions.report(account, pos, this.now()); } catch { /* a bad poll is not an action; the next action is checked */ }
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
      for (let h = Math.max(last + 1, now - 24); h <= now; h++) {
        this.market.tickAll();
        this.market.merchantCraft();
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
    // With the shared map, every action says where the player stands, and the action must happen there.
    if (this.map && this.positions) {
      const pos = this.positions.report(account, body.pos, this.now());
      const far = (msg: string) => { throw new HttpError(409, msg); };
      if (a === 'gather' && Math.abs(pos.x - n('x', -1)) + Math.abs(pos.y - n('y', -1)) !== 1) far('Terlalu jauh. Berdiri tepat di sebelahnya.');
      if ((a === 'sell' || a === 'buy') && !this.map.nearStall(pos)) far('Jual-beli dilakukan di lapak pedagang di pasar.');
      if (a === 'farm' && !this.map.nearPlot(pos, n('plot', -1))) far('Berdiri di sebelah petak kebunmu.');
      if ((a === 'craft' || a === 'ship') && !this.map.atOwnHouse(pos)) far(a === 'craft' ? 'Meja Kerja ada di rumahmu.' : 'Kotak Kirim ada di rumahmu.');
    }
    let res: { toast: string };
    switch (a) {
      case 'gather':
        this.map?.checkGather(s('tile'), n('x', -1), n('y', -1));
        res = this.world.gather(account, s('tile'), n('x', -1), n('y', -1));
        break;
      case 'craft': res = this.world.craft(account, s('recipe')); break;
      case 'eat': res = this.world.eat(account, s('token')); break;
      case 'farm': res = this.world.farm(account, s('op'), n('plot', -1)); break;
      case 'ship': res = this.world.ship(account, s('token'), n('qty')); break;
      case 'sell': res = this.market.sell(account, s('merchant'), s('token'), n('qty')); break;
      default: res = this.market.buy(account, s('merchant'), s('token'), n('qty')); break;
    }
    if (a !== 'farm') this.store.addHistory(account, a, res.toast, 'offchain');
    return { ...res, state: this.state(account) };
  }

  state(account: string) {
    const t = this.clock.time();
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
      plots: this.world.plots(account).map((x) => ({ idx: x.idx, state: x.state, grown: x.grown, wateredToday: x.watered_day === t.day })),
      world: this.map ? { seed: this.map.seed, unlocked: this.map.unlocked } : null,
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
