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
import { WorldMap, Positions, HomelandMap, Village, type GameMap, type Pos } from './worldmap.ts';
import { Homelands, homeWorld, parseHome } from './homeland.ts';
import type { HomelandRow } from './gamestore.ts';
import { MockChain } from '../chain.ts';
import { Monsters } from './monsters.ts';
import { worldIdOk } from '../social.ts';
import { Trade } from './trade.ts';
import { Parties } from './party.ts';
import { leaderboard } from './leaderboard.ts';
import { Extras } from './extras.ts';
import { Chips } from './chips.ts';
import { NpcMarket } from './npc.ts';
import { returnConsignedGoods } from './consign-return.ts';

export interface GameOptions { merchantParent: string; town: string; chunkSize?: number; now?: () => number; rng?: Rng; econ?: Econ; worldSeed?: number }

const ACTIONS = ['gather', 'craft', 'eat', 'farm', 'ship', 'sell', 'buy', 'fight', 'flee', 'engage', 'travel', 'build', 'collect', 'hire', 'forage', 'cook', 'stock', 'dress', 'assist', 'boat', 'hoe', 'gamble', 'mall', 'repair', 'maketool', 'ride', 'casino', 'mission', 'grass', 'chips', 'toolshop', 'sleep'] as const;

/** The least Homeland role an action needs: guests (invited or the owner's party) may walk, travel, eat and handle a monster fight; the rest is owner-only until later co-op steps. */
export type Need = 'visit' | 'help' | 'build' | 'owner';
const NEED: Record<(typeof ACTIONS)[number], Need> = {
  gather: 'help', grass: 'help', boat: 'visit', sleep: 'visit', hoe: 'help', gamble: 'visit', mall: 'visit', repair: 'visit', maketool: 'visit', toolshop: 'visit', ride: 'visit', casino: 'visit', chips: 'visit', mission: 'visit', craft: 'help', eat: 'visit', farm: 'help', ship: 'owner', sell: 'visit', buy: 'visit', fight: 'visit', flee: 'visit', engage: 'help',
  travel: 'visit', build: 'build', collect: 'help', assist: 'help', hire: 'owner', forage: 'owner', cook: 'owner', stock: 'owner', dress: 'owner',
};

export class Game {
  econ: Econ;
  gs: GameStore;
  clock: Clock;
  world: World;
  rng: () => number;
  chips: Chips;
  market: Market;
  /** Merchants buying cheap Player Market listings and following their price trend (npc.ts). */
  npc: NpcMarket;
  settlement: Settlement;
  /** Set by the app (social.deal): a merchant trade happened, for the goods-flying animation. `a` got `aGot` from `b`. */
  onDeal?: (kind: 'shop', world: string, a: string, b: string, aGot: Record<string, number>, bGot: Record<string, number>) => void;
  /** The shared village map; absent in unit tests and the simulator, which use abstract tile coordinates. */
  map: WorldMap | null = null;
  positions: Positions | null = null;
  monsters: Monsters | null = null;
  homelands: Homelands;
  trade: Trade;
  party: Parties;
  /** Tools with durability, paid entertainment, Mall cosmetics, missions and news (extras.ts). */
  extras: Extras;
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
    this.rng = o.rng ?? Math.random;
    this.market = new Market(this.econ, this.gs, this.clock, o.merchantParent, o.town);
    this.settlement = new Settlement({ econ: this.econ, gs: this.gs, store, chain, clock: this.clock, market: this.market, town: o.town, chunkSize: o.chunkSize ?? 25 });
    this.now = o.now ?? Date.now;
    this.npc = new NpcMarket({
      econ: this.econ, gs: this.gs, clock: this.clock, market: this.market, settlement: this.settlement, chain, now: this.now, log: (l) => console.warn(l),
      history: (a, summary, tx, tokens) => { store.addHistory(a, 'trade', summary, chain.mode === 'mock' ? 'mock' : 'ok', tx, null, tokens.filter((t) => t in this.econ.items)); },
    });
    this.homelands = new Homelands({ econ: this.econ, gs: this.gs, worldSeed: o.worldSeed ?? 0, now: this.now, town: o.town, clock: this.clock, built: (a, k, t) => this.extras?.logBuilt(a, k, t), party: { same: (a, b) => this.party.same(a, b), mates: (a) => this.party.mates(a) }, players: { nameOf: (a) => store.nameOf(a), tagOf: (a) => store.tagOf(a), accountByNameTag: (n, t) => store.accountByNameTag(n, t), isPlayer: (a) => store.isPlayer(a) } });
    const hist = (a: string, summary: string, tokens: string[], ref: string | null = null) => { store.addHistory(a, 'trade', summary, 'offchain', null, ref, tokens.filter((t) => t in this.econ.items)); };
    this.trade = new Trade({
      econ: this.econ, gs: this.gs, clock: this.clock, world: this.world, now: this.now, history: hist, assertActive: (a) => this.assertActive(a), party: { same: (a, b) => this.party.same(a, b) },
      names: { nameOf: (a) => store.nameOf(a), tagOf: (a) => store.tagOf(a), accountByNameTag: (n, t) => store.accountByNameTag(n, t), isPlayer: (a) => store.isPlayer(a) },
      where: (a) => (this.positions ? { world: this.positions.worldOf(a), pos: this.positions.last.get(a) ?? null } : null),
    });
    this.extras = new Extras({
      econ: this.econ, gs: this.gs, clock: this.clock, world: this.world, town: o.town, now: this.now, map: () => this.map,
      nameOf: (a) => store.nameOf(a), board: (p) => this.leaderboard(p, null), merchantName: (acct) => this.econ.merchants[acct.split('.')[0]]?.name ?? acct.split('.')[0],
      stall: () => { const id = this.econ.toolShop.merchant; return { account: this.market.account(id), name: this.market.def(id).name, open: this.market.isOpen(id) }; },
    });
    this.world.tools = this.extras;
    this.chips = new Chips({
      cfg: () => this.econ.chips, db: this.gs.db, town: o.town, rng: () => this.rng(), day: () => this.clock.time().settleDay,
      coinOf: (a) => this.gs.balance(a, 'coin'),
      addCoin: (a, delta, kind, ref) => this.gs.add(this.clock.time().settleDay, a, 'coin', delta, kind, ref),
      payTown: (a, coin, kind, ref) => this.extras.payTown(a, coin, kind, ref),
      checkGain: (a, coin) => this.world.checkGain(a, 'coin', coin),
      passUntil: (a) => this.extras.passUntil(a),
      atLuckTable: (a) => { if (!this.map || !this.positions) return true; const p = this.positions.lastOf(a); return !!p && this.positions.worldOf(a) === 'public' && this.map.nearLandmark(p, 'gamble', 3); },
    });
    this.party = new Parties({
      econ: this.econ, gs: this.gs, now: this.now, assertActive: (a) => this.assertActive(a),
      names: { nameOf: (a) => store.nameOf(a), tagOf: (a) => store.tagOf(a), accountByNameTag: (n, t) => store.accountByNameTag(n, t), isPlayer: (a) => store.isPlayer(a) },
    });
    returnConsignedGoods(this.gs, this.clock, o.town, (t) => this.econ.items[t]?.name ?? t, hist); // the consignment stall is gone: goods left in it go back to their owners
    if (o.worldSeed != null) {
      this.map = new WorldMap(o.worldSeed, JSON.parse(this.gs.meta('world.unlocked') ?? '[]'));
      // every village area open from the start (owner's choice, 2026-11-12); town projects still run on chain
      if (this.econ.homeland.publicOpenAll) for (const c of this.map.layout.chunks) this.unlockChunk(c.id);
      this.positions = new Positions(this.map);
      // night monsters live in Homelands (and in the village forest only when the public area is not trade-only)
      if (this.econ.monsters) this.monsters = new Monsters(this.econ, this.gs, this.clock, this.world, this.map, o.rng ?? Math.random);
    }
  }

  /** Today's weather on the shared map (the same for every player). */
  weather() { if (!this.map) return null; const t = this.clock.time(); return this.map.weather(t.day, t.season); }

  private need<T>(x: T | null): T { if (!x) throw new HttpError(400, 'unknown action'); return x; }

  /** A state poll from the player's client, with where they stand (ignored without the shared map). */
  reportPosition(account: string, pos: Pos | null, world = 'public') {
    if (!this.positions || !pos) return;
    this.fixWorld(account);
    try { this.positions.report(account, pos, this.now(), world, this.worldFor(account, world, 'visit').map ?? undefined, this.homeFor(account, world)); } catch { /* a bad poll is not an action; the next action is checked */ }
  }

  /** The player's own Homeland as a place to land (page reload, Start): only when `world` is that Homeland and the server has them elsewhere. */
  private homeFor(account: string, world: string): { world: string; spawn: Pos } | undefined {
    if (!this.positions || world === 'public' || this.positions.worldOf(account) === world) return undefined;
    const id = parseHome(world);
    const row = id === null ? undefined : this.homelands.byId(id);
    if (!row || row.account !== account) return undefined;
    return { world, spawn: this.homelands.map(row).layout.spawn };
  }

  /** The map a request is about. `need` is the least role the request needs in a Homeland: 'visit' (any guest: invited or the owner's party),
   *  'help' (Helper or better), 'build' (Builder or better) or 'owner'. Anyone who may not be there at all gets 409. */
  worldFor(account: string, wid: string, need: Need): { map: GameMap | null; row: HomelandRow | null } {
    if (wid === 'public') return { map: this.map, row: null };
    const id = parseHome(wid);
    if (id === null || !worldIdOk(wid) || wid !== homeWorld(id)) throw new HttpError(400, 'Unknown world.');
    if (!this.map) throw new HttpError(409, 'The Homeland world isn\'t active yet.');
    const { row, role } = this.homelands.access(account, id);
    const have = { visitor: 0, helper: 1, builder: 2, owner: 3 }[role], want = { visit: 0, help: 1, build: 2, owner: 3 }[need];
    if (have < want) throw new HttpError(409, need === 'help' ? 'Ask the owner to make you a Helper.' : need === 'build' ? 'Only the owner or a Builder can build here.' : 'This isn\'t your Homeland. Guests can only look around.');
    return { map: this.homelands.map(row), row };
  }

  /** Kept for the HTTP layer: Homelands need no chain reads, so there is nothing to prepare. */
  async prepare(_account: string, _body: { world?: unknown }) { /* nothing to load */ }

  /** A player who may no longer be in the world the server has them in (guest uninvited) goes back to public. */
  fixWorld(account: string) {
    const w = this.positions?.worldOf(account);
    if (!this.positions || !w || w === 'public') return;
    try { this.worldFor(account, w, 'visit'); } catch { this.positions.reset(account); this.monsters?.pending.delete(account); }
  }

  /** Portal trip: from within 2 tiles of this world's portal to the public area (arrive at its portal) or a Homeland you own or are invited to (arrive at its spawn). */
  private travel(account: string, from: string, fromMap: GameMap | null, to: string, pos: Pos): { toast: string; world: string; arrive: Pos } {
    if (!this.map || !this.positions || !fromMap) throw new HttpError(409, 'Travel isn\'t active yet.');
    if (!to) throw new HttpError(400, 'Where to?');
    if (to === from) throw new HttpError(409, 'You\'re already there.');
    const d = fromMap.portal();
    if (Math.abs(pos.x - d.x) + Math.abs(pos.y - d.y) > 2) throw new HttpError(409, 'Go to the portal first.');
    const target = this.worldFor(account, to, 'visit');
    const arrive = target.row ? target.map!.layout.spawn : this.map.portal();
    this.positions.setWorld(account, to, arrive, this.now());
    return { toast: target.row ? (target.row.account === account ? 'Arrived at your Homeland.' : 'Arrived at your friend\'s Homeland.') : 'Arrived in the public area.', world: to, arrive };
  }

  /** The one public boat, shared by everybody: where it floats and who steers it (what presence tells every client). */
  boatView(viewer?: string): { x: number; y: number; by: string | null; name: string | null; mine: boolean } | null {
    const b = this.positions?.boatNow(this.now());
    if (!b) return null;
    return { x: b.x, y: b.y, by: b.by, name: b.by ? (this.store.nameOf(b.by) ?? b.by.split('.')[0]) : null, mine: !!b.by && b.by === viewer };
  }

  /** The ferry boat to the island in the village's bottom-right corner, steered by the player. There is ONE boat, wherever it was left. op 'board':
   *  from a land tile right next to the boat (and nobody else steering it), step in; while aboard the player's reports are water tiles the boat can
   *  reach (Positions) and the boat follows. op 'land' {x, y}: step off onto a walkable tile right next to the boat. Nothing else works aboard, and
   *  the boat moves at walking speed like anyone. An unused boat sails home to the mainland dock (Positions.boatNow). */
  private boat(account: string, wid: string, pos: Pos, op: string, to: Pos): { toast: string; world: string; arrive: Pos; aboard: boolean } {
    if (!this.map || !this.positions || wid !== 'public') throw new HttpError(409, 'The boat is in the public village.');
    const f = Village.ferryOf(this.map.layout);
    if (!f) throw new HttpError(409, 'There is no boat here.');
    // next to = one of the 8 tiles around (diagonals too, so a boat at an angle to the shore never strands anyone)
    const dist = (p: Pos, q: Pos) => Math.max(Math.abs(Math.round(p.x) - Math.round(q.x)), Math.abs(Math.round(p.y) - Math.round(q.y)));
    const boat = this.positions.boatNow(this.now())!;
    if (this.positions.aboard.has(account)) {
      if (op !== 'land') throw new HttpError(409, 'You are already in the boat.');
      if (!Number.isInteger(to.x) || !Number.isInteger(to.y)) throw new HttpError(400, 'Where to land?');
      if (dist(pos, to) !== 1 && dist(boat, to) !== 1) throw new HttpError(409, 'Steer the boat next to the shore first.');
      if (!this.map.walkable(to.x, to.y)) throw new HttpError(409, 'You cannot step off there.');
      this.positions.land(account, to, this.now());
      return { toast: 'You step ashore.', world: 'public', arrive: to, aboard: false };
    }
    if (op !== 'board') throw new HttpError(409, 'You are not in the boat.');
    if (boat.by) throw new HttpError(409, `The boat is in use by ${this.store.nameOf(boat.by) ?? boat.by.split('.')[0]}.`);
    if (dist(pos, boat) !== 1) throw new HttpError(409, 'Stand next to the boat.');
    const at = { x: boat.x, y: boat.y };
    this.positions.board(account, at, this.now());
    return { toast: 'You climb into the boat.', world: 'public', arrive: at, aboard: true };
  }

  /** Dev tool (mock chain only): moves coin that already exists from the town treasury to a player's settled balance. */
  async devGrant(account: string, coin: number) {
    if (!(this.chain instanceof MockChain)) throw new HttpError(403, 'only on the mock chain');
    if (!Number.isInteger(coin) || coin < 1 || coin > 100_000) throw new HttpError(400, 'coin 1-100000');
    const free = Math.min(this.gs.settledBalance(this.town, 'coin'), this.gs.balance(this.town, 'coin'));
    if (coin > free) throw new HttpError(409, `The village fund only has ${free} free coins.`);
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
      }
      this.gs.setMeta('clock.hour', String(now));
      await this.npc.run();
      await this.trade.finishDueChecked();
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

  onNewPlayer(account: string) { this.world.starter(account, this.town); this.extras.ensureTools(account); this.homelands.ensure(account); }

  /** Off-chain action from the player. Every one is logged in Riwayat as "waiting for settlement". */
  /** An account whose settlement debit the chain could not cover is frozen until the operator lifts it. */
  assertActive(account: string) {
    if (this.gs.isFrozen(account)) throw new HttpError(403, 'This account is frozen because the on-chain balance does not match the game. Contact the operators.');
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
      if (this.monsters.pending.has(account) && a !== 'fight' && a !== 'flee') throw new HttpError(409, `${this.monsters.pending.get(account)!.name} blocks your way! Fight or run first.`);
    }
    // With the shared map, every action says where the player stands, and the action must happen there.
    // Every action says which world it is in (default: the public area). Homelands: only the owner acts; guests just walk.
    const wid = s('world') || 'public';
    const w = this.worldFor(account, wid, NEED[a as (typeof ACTIONS)[number]]);
    const home = this.econ.homeland;
    if (a === 'build' && w.row && w.row.account !== account && (s('kind') === 'th' || s('kind') === 'chunk')) throw new HttpError(409, 'Only the owner can upgrade the Town Hall or open new land.');
    if (a === 'build' && w.row && w.row.account !== account && s('kind') === 'light') throw new HttpError(409, 'Only the owner can put up street lights.');
    if (this.map && wid === 'public' && home.publicTradeOnly && ((a === 'gather' && !home.publicGather) || (a === 'grass' && !home.publicGather) || a === 'farm' || a === 'engage')) throw new HttpError(409, 'The public area is for trading only.');
    if (w.row && a === 'ship') throw new HttpError(409, 'The Shipping Box is only in the public area.');
    if ((a === 'build' || a === 'collect' || a === 'assist' || a === 'hire' || a === 'forage' || a === 'cook' || a === 'stock' || a === 'dress') && !w.row) throw new HttpError(409, 'Build and harvest in your own Homeland.');
    let pos: Pos | null = null;
    if (this.map && this.positions && w.map) {
      // no `home` here: an action never changes worlds (only `travel` and the presence poll of a reload do)
      pos = this.positions.report(account, body.pos, this.now(), wid, w.map);
      const far = (msg: string) => { throw new HttpError(409, msg); };
      if (a !== 'boat' && wid === 'public' && this.positions.aboard.has(account)) far('Step off the boat first.');
      if ((a === 'gather' || a === 'grass') && Math.abs(pos.x - n('x', -1)) + Math.abs(pos.y - n('y', -1)) !== 1) far('Too far. Stand right next to it.');
      if ((a === 'sell' || a === 'buy' || a === 'toolshop') && !w.map.nearStall(pos)) far('Buying and selling happens at the merchants\' stalls in the market.');
      if (a === 'farm' && !w.map.nearPlot(pos, n('plot', -1))) far('Stand next to your garden plot.');
      if (a === 'craft' && !w.map.atWorkbench(pos)) far(w.row ? 'The Workbench is in your Town Hall and in your house.' : 'The Workbench is in your house.');
      if (a === 'ship' && !w.map.atOwnHouse(pos)) far('The Shipping Box is at your house.');
      // the owner builds anywhere in their own Homeland (lots open by click); a guest builder still stands at the lot
      if ((a === 'assist' || (a === 'build' && w.row!.account !== account)) && w.map instanceof HomelandMap) {
        const kind = a === 'build' ? s('kind') : this.gs.homelandJobs(w.row!.account).find((j) => j.target === s('target'))?.kind ?? '';
        // a lot's own work happens at the lot; the Town Hall's (level, new island, street lights) from anywhere in your
        // Homeland, since the Upgrade button opens the Town Hall window wherever you stand
        if (kind === 'build' || kind === 'furniture' || kind === 'upgrade') { if (!w.map.nearLot(pos, s('target').split(':')[0])) far('Stand near that lot.'); }
      }
      if (a === 'cook' || a === 'stock') {
        const lot = this.homelands.restoranLot(account);
        if (!lot) far('Build the Restaurant first.');
        else if (!(w.map instanceof HomelandMap) || !w.map.nearLot(pos, lot)) far('Stand near the Restaurant door.');
      }
      if (a === 'collect' && w.map instanceof HomelandMap && !w.map.nearLot(pos, s('lot'))) far('Stand near the building.');
    }
    if (a !== 'sleep') this.world.asleep.delete(account); // any other action gets the player out of bed
    let res: { toast: string; tags?: string[]; world?: string; arrive?: Pos; aboard?: boolean; gained?: Record<string, number> };
    switch (a) {
      case 'gather': {
        w.map?.checkGather(s('tile'), n('x', -1), n('y', -1));
        // fishing only where the water ripples (the same spots the client draws, from the world's seed and the game time)
        if (s('tile') === 'water' && w.map && !w.map.fishSpot(n('x', -1), n('y', -1), this.clock.time().totalHours)) throw new HttpError(409, 'No fish here. Cast where the water ripples.');
        // a guest (helper or builder) in someone else's Homeland: a daily share per host and never a node's last charge
        const guest = !!w.row && w.row.account !== account;
        const minLeft = guest ? this.econ.coop.guestLeavesCharges : 0;
        if (guest) {
          const taken = this.gs.guestTaken(this.clock.time().settleDay, account, wid), cap = this.econ.coop.guestGatherPerHostDay;
          if (taken >= cap) throw new HttpError(409, `You helped a lot here today (${taken}). Come back tomorrow.`);
        }
        // a monster can block a gather in the wild part of a Homeland (or the village forest when it is not trade-only)
        const enc = w.row && w.map instanceof HomelandMap ? this.monsters?.maybeEncounter(account, s('tile'), n('x', -1), n('y', -1), w.map, true, { prefix: `${wid}:`, minLeft })
          : home.publicTradeOnly ? null : this.monsters?.maybeEncounter(account, s('tile'), n('x', -1), n('y', -1));
        if (enc) { res = { toast: `${enc.name} blocks your way! Fight or run.` }; break; }
        res = this.world.gather(account, s('tile'), n('x', -1), n('y', -1), w.row ? `${wid}:` : '', w.row && !guest && this.econ.gather.tiles[s('tile')] === 'wood' ? this.homelands.effects(account).woodBonus : 0, minLeft); // Homeland nodes are charged per Homeland
        break;
      }
      case 'grass': {
        // the tile must be grass on this world's map (the client's word is not enough) and in an open area
        const gx = n('x', -1), gy = n('y', -1), g = this.econ.grass;
        if (w.map) {
          const tt = w.map.tileAt(gx, gy);
          if (tt === null) throw new HttpError(400, 'bad tile');
          if (!g || !g.tiles.includes(tt)) throw new HttpError(409, 'Nothing to search here.');
          w.map.checkGather(tt, gx, gy);
        }
        res = this.world.grass(account, gx, gy);
        break;
      }
      case 'fight': res = this.need(this.monsters).fight(account); break;
      case 'engage': {
        const where = w.row && w.map instanceof HomelandMap ? w.map : this.map!;
        const enc = this.need(this.monsters).engage(account, s('monster'), (pos ?? body.pos ?? {}) as { x: number; y: number }, where, !!w.row, { prefix: w.row ? `${wid}:` : '' });
        res = { toast: `${enc.name} attacks! Fight or run.` };
        break;
      }
      case 'flee': res = this.need(this.monsters).flee(account); break;
      case 'craft': res = this.world.craft(account, s('recipe')); break;
      case 'eat': res = this.world.eat(account, s('token')); break;
      case 'sleep': res = this.world.sleep(account, s('op'), pos); break;
      case 'farm': {
        const own = w.row?.account ?? account; // a guest farms the owner's plots; the owner's Petani speeds the crops
        res = this.world.farm(account, s('op'), n('plot', -1), w.row ? { plotAccount: `${own}@${wid}`, count: this.farmCount(w.row), growSecs: this.farmSecs(own), yieldBonus: 0, owner: own, guest: own !== account } : undefined);
        const cr = (res as { credit?: { account: string; token: string; n: number } }).credit;
        if (cr) {
          const who = this.store.nameOf(account) ?? account.split('.')[0], at = this.store.nameOf(own) ?? own.split('.')[0];
          this.store.addHistory(cr.account, 'harvest', `${who} harvested ${cr.n} Wheat for you in ${at}'s Homeland.`, 'offchain', null, null, [cr.token]);
          res = { toast: `The wheat goes to ${this.store.nameOf(cr.account) ?? cr.account.split('.')[0]}, who planted it.` };
        }
        break;
      }
      case 'travel': res = this.travel(account, wid, w.map, s('to'), pos ?? { x: -9, y: -9 }); break;
      case 'boat': res = this.boat(account, wid, pos ?? { x: -9, y: -9 }, s('op') || 'board', { x: n('x', NaN), y: n('y', NaN) }); break;
      case 'mall': {
        // op 'wear' changes what you wear, anywhere; buying (op 'buy' {id}) and worker gear (bot + cosmetic) happen at the Mall in the market
        if (s('op') === 'wear') { res = this.extras.wearItem(account, body.slot, body.id ?? null); break; }
        if (!this.map || wid !== 'public' || !this.map.nearLandmark(pos ?? { x: -9, y: -9 }, 'mall', 2)) throw new HttpError(409, 'Come to the Mall at the market.');
        if (s('op') === 'buy') res = this.extras.buy(account, body.id);
        else if (s('op') === '') res = this.homelands.dress(account, body.bot, body.cosmetic, this.clock.time().settleDay);
        else throw new HttpError(400, 'Unknown Mall action.');
        break;
      }
      case 'repair': res = this.extras.repair(account, body.tool); break;
      case 'maketool': res = this.extras.make(account, body.tool); break;
      case 'toolshop': res = this.extras.toolStall(account, body.op, body.tool); break;
      case 'ride': res = this.extras.ride(account, wid, pos); break;
      case 'casino': res = this.extras.casino(account, s('op') || 'enter', wid, pos); break;
      case 'mission': {
        if (s('op') !== 'claim') throw new HttpError(400, 'Unknown mission action.');
        res = this.extras.claimMission(account, body.id);
        break;
      }
      case 'chips': {
        if (wid !== 'public') throw new HttpError(409, 'Chips are played in the public village.');
        const op = s('op');
        if (op === 'buy') res = this.chips.buy(account, body.n);
        else if (op === 'sell') res = this.chips.sell(account, body.n);
        else if (op === 'play') res = this.chips.play(account, body.game, body);
        else throw new HttpError(400, 'Unknown chips action.');
        break;
      }
      case 'gamble': throw new HttpError(409, 'The Luck Table now plays for chips only.'); // goods and coin can no longer be staked; chips are bought and played through the `chips` act
      case 'hoe': {
        if (!w.row) throw new HttpError(409, 'Use the hoe in a Homeland farm.');
        const hx = n('x', -1), hy = n('y', -1);
        if (!pos || Math.abs(pos.x - hx) + Math.abs(pos.y - hy) > 1) throw new HttpError(409, 'Stand next to that ground.');
        this.extras.need(account, 'hoe');
        res = this.homelands.hoe(w.row.account, hx, hy);
        res.toast += this.extras.wear(account, 'hoe');
        this.extras.bump(account, 'farm:till');
        break;
      }
      case 'build': res = this.homelands.start(w.row!.account, s('kind') as 'th' | 'chunk' | 'light' | 'build' | 'furniture' | 'upgrade', s('target'), this.clock.time().settleDay, account); break;
      case 'assist': res = this.homelands.assist(w.row!.account, s('target'), (cost) => this.world.useEnergy(account, cost)); break;
      case 'dress': res = this.homelands.dress(account, body.bot, body.cosmetic, this.clock.time().settleDay); break;
      case 'hire': res = this.homelands.hire(account, s('job'), this.clock.time().settleDay); break;
      case 'forage': res = this.homelands.forage(account, this.clock.time().settleDay, (acc, t, q) => this.world.checkGain(acc, t, q)); break;
      case 'cook': res = this.homelands.cook(account, body.qty, this.clock.time().settleDay); break;
      case 'stock': res = this.homelands.stock(account, s('token'), body.qty, this.clock.time().settleDay); break;
      case 'collect': {
        const owner = w.row!.account;
        res = this.homelands.collect(owner, s('lot'), this.clock.time().settleDay, (acc, t, q) => this.world.checkGain(acc, t, q), account);
        if (owner !== account) {
          const token = Object.keys(res.gained!)[0], n0 = res.gained![token], nm = this.econ.items[token]?.name ?? token, who = this.store.nameOf(account) ?? account.split('.')[0];
          this.store.addHistory(owner, 'collect', `${who} collected ${n0} ${nm} for you.`, 'offchain', null, null, [token]);
          res = { toast: `+${n0} ${nm} goes to ${this.store.nameOf(owner) ?? owner.split('.')[0]}.`, tags: [] };
        }
        break;
      }
      case 'ship': res = this.world.ship(account, s('token'), n('qty')); break;
      case 'sell': {
        // the coin earned counts toward the daily coin gain cap (same as the contract's settlement check)
        try { this.world.checkGain(account, 'coin', this.market.quote(s('merchant'), s('token'), 'sell', n('qty')).total); } catch (e) { if (e instanceof HttpError && e.status === 409) throw e; }
        const sold = this.market.sell(account, s('merchant'), s('token'), n('qty'));
        res = sold;
        this.onDeal?.('shop', wid, account, this.market.account(s('merchant')), { coin: sold.total }, { [s('token')]: n('qty') });
        break;
      }
      default: {
        if (Number.isInteger(n('qty')) && n('qty') > 0) this.world.checkGain(account, s('token'), n('qty'));
        const bought = this.market.buy(account, s('merchant'), s('token'), n('qty'));
        res = bought;
        this.onDeal?.('shop', wid, account, this.market.account(s('merchant')), { [s('token')]: n('qty') }, { coin: bought.total });
        break;
      }
    }
    this.countMissions(account, a, body, res);
    if (a !== 'farm' && !(a === 'grass' && !Object.keys(res.gained ?? {}).length)) { // an empty search is not worth a Riwayat line
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

  /** Mission counters (extras.ts): what the player just did, once it has succeeded. */
  private countMissions(account: string, a: string, body: Record<string, unknown>, res: { gained?: Record<string, number> }) {
    const x = this.extras;
    if (a === 'gather') for (const [t, q] of Object.entries(res.gained ?? {})) x.bump(account, `gather:${t}`, q);
    else if (a === 'craft') x.bump(account, `craft:${String(body.recipe ?? '')}`);
    else if (a === 'sell') x.bump(account, 'sell');
    else if (a === 'farm' && body.op === 'till') x.bump(account, 'farm:till');
  }

  /** Farm plots in a Homeland: one per Town Hall level, up to 6. */
  /** Seconds from planting to ripe in a Homeland: the owner's Petani workers divide it. */
  private farmSecs(owner: string) { return Math.max(1, this.econ.farm.growSecs / this.homelands.effects(owner).farmGrowFactor); }
  private farmCount(row: HomelandRow) { return Math.min(row.th, 6); }

  state(account: string) {
    this.fixWorld(account);
    const koUntil = this.monsters?.koUntil(account) ?? null; // first: waking up restores energy
    const t = this.clock.time();
    const weather = this.weather();
    const wid = this.positions?.worldOf(account) ?? 'public';
    const hid = wid === 'public' ? null : parseHome(wid);
    const hrow = hid ? this.homelands.byId(hid) : undefined;
    let fieldOwner: string | null = null; // whose plots this player sees: the Homeland owner's, for helpers and up
    if (hrow) { try { if (hrow.account === account || this.homelands.access(account, hrow.id).role !== 'visitor') fieldOwner = hrow.account; } catch { /* fixWorld will move them */ } }
    const field = hrow && fieldOwner ? this.farmCount(hrow) : null;
    const p = this.world.state(account);
    const bag: Record<string, { settled: number; today: number; name: string }> = {};
    for (const [token, def] of Object.entries(this.econ.items)) {
      bag[token] = { settled: this.gs.settledBalance(account, token), today: this.gs.pending(account, token), name: def.name };
    }
    let here: { world: string; owner_name: string; role: string } | null = null;
    if (hrow) {
      try { const a = this.homelands.access(account, hrow.id); here = { world: wid, owner_name: this.store.nameOf(hrow.account) ?? hrow.account.split('.')[0], role: a.role }; } catch { /* fixWorld will move them */ }
    }
    return {
      time: { ...t, fraction: this.clock.hourFraction(), msPerHour: this.econ.time.realMsPerGameHour, settledThrough: this.settlement.settledThrough() },
      energy: Math.floor(p.energy), energyMax: this.econ.gather.energyMax,
      tool: { uses: p.tool_uses, durability: this.econ.items.tool.durability ?? 20 },
      tools: this.extras.toolsView(account),
      cosmetics: this.extras.cosmeticsView(account),
      missions: this.extras.missionsView(account),
      casinoPass: this.extras.passUntil(account),
      chips: this.chips.view(account),
      fun: this.econ.fun,
      bag,
      worldId: hrow ? wid : 'public',
      here,
      homeland: this.homelands.view(account),
      plots: (field ? this.world.plots(`${fieldOwner}@${wid}`, field, this.farmSecs(fieldOwner!)) : hrow ? [] : this.world.plots(account)).map((x) => ({ idx: x.idx, state: x.state, growMs: Math.round((field ? this.farmSecs(fieldOwner!) : this.econ.farm.growSecs) * 1000), ...(x.state === 'planted' || x.state === 'ready' ? { ageMs: Math.max(0, this.clock.now() - x.planted_at) } : {}), mine: !x.planter || x.planter === account, ...(x.planter && x.planter !== account ? { planter_name: this.store.nameOf(x.planter) ?? x.planter.split('.')[0] } : {}) })),
      world: this.map ? { seed: this.map.seed, unlocked: this.map.unlocked } : null,
      encounter: this.monsters?.pending.get(account) ?? null,
      koUntil,
      night: this.monsters ? { now: this.monsters.isNight(), guarded: this.monsters.guarded(wid !== 'public') } : null,
      weather,
      stumps: this.stumps(hrow ? `${wid}:` : '', t.totalHours),
    };
  }

  /** Trees of this world felled to their last charge: drawn as stumps that grow back by stages (client/js/three/nature.js).
   *  msLeft counts down to the refill hour; msTotal is the whole regrowth. Same node keys as `gather` (world.ts). */
  stumps(prefix: string, nowHours: number) {
    const msHour = this.econ.time.realMsPerGameHour, msTotal = this.econ.gather.respawnGameHours * msHour;
    const into = this.clock.hourFraction() * msHour;
    return this.gs.emptyNodes(prefix, 'tree', nowHours).map((n) => ({ x: n.x, y: n.y, msTotal, msLeft: Math.max(0, Math.min(msTotal, (n.refill_hour - nowHours) * msHour - into)) }));
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
      out.push({ ...s, id, name: this.econ.merchants[id]?.shop ?? s.name, holding: account ? await this.chain.holding(s.account_id, account) : null });
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
