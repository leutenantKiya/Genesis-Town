// Off-chain extras around the core loop, none of them tokens:
//  - Tools: Pickaxe, Axe, Fishing Rod and Hoe with durability (economy/config.json `tools`); repair and make-new acts.
//  - Fun: the carousel ride and the casino entry are paid in coin (spent the way the Mall spends: player -> town).
//  - Mall: a cosmetics catalogue (`mall.items`), owned and worn per account; presence carries what is worn.
//  - Missions: server-checked learning steps (`missions`) driven by counters, reward claimed once.
//  - News: the latest town news, generated from existing data plus a small log of finished buildings.
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from '../auth.ts';
import type { Cost, Econ, MallItem } from './econ.ts';
import type { GameStore } from './gamestore.ts';
import type { Clock } from './clock.ts';
import type { World } from './world.ts';
import type { WorldMap, Pos } from './worldmap.ts';
import type { Board } from './leaderboard.ts';

export class ExtrasStore {
  db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS tool_state (account TEXT NOT NULL, kind TEXT NOT NULL, left INTEGER NOT NULL, PRIMARY KEY (account, kind));
      CREATE TABLE IF NOT EXISTS counters (account TEXT NOT NULL, key TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account, key));
      CREATE TABLE IF NOT EXISTS passes (account TEXT NOT NULL, kind TEXT NOT NULL, until INTEGER NOT NULL, PRIMARY KEY (account, kind));
      CREATE TABLE IF NOT EXISTS cosmetics_owned (account TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (account, id));
      CREATE TABLE IF NOT EXISTS cosmetics_worn (account TEXT NOT NULL, slot TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (account, slot));
      CREATE TABLE IF NOT EXISTS missions_done (account TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (account, id));
      CREATE TABLE IF NOT EXISTS news_log (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL);
    `);
  }
  tools(account: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db.prepare('SELECT kind, left FROM tool_state WHERE account = ?').all(account) as unknown as Array<{ kind: string; left: number }>) out[r.kind] = r.left;
    return out;
  }
  setTool(account: string, kind: string, left: number) {
    this.db.prepare('INSERT INTO tool_state (account, kind, left) VALUES (?, ?, ?) ON CONFLICT(account, kind) DO UPDATE SET left = excluded.left').run(account, kind, left);
  }
  bump(account: string, key: string, n = 1) {
    if (n <= 0) return;
    this.db.prepare('INSERT INTO counters (account, key, n) VALUES (?, ?, ?) ON CONFLICT(account, key) DO UPDATE SET n = n + excluded.n').run(account, key, n);
  }
  counter(account: string, key: string): number {
    return (this.db.prepare('SELECT n FROM counters WHERE account = ? AND key = ?').get(account, key) as { n: number } | undefined)?.n ?? 0;
  }
  pass(account: string, kind: string): number {
    return (this.db.prepare('SELECT until FROM passes WHERE account = ? AND kind = ?').get(account, kind) as { until: number } | undefined)?.until ?? 0;
  }
  setPass(account: string, kind: string, until: number) {
    this.db.prepare('INSERT INTO passes (account, kind, until) VALUES (?, ?, ?) ON CONFLICT(account, kind) DO UPDATE SET until = excluded.until').run(account, kind, until);
  }
  owned(account: string): string[] {
    return (this.db.prepare('SELECT id FROM cosmetics_owned WHERE account = ? ORDER BY rowid').all(account) as unknown as Array<{ id: string }>).map((r) => r.id);
  }
  addOwned(account: string, id: string): boolean {
    return Number(this.db.prepare('INSERT OR IGNORE INTO cosmetics_owned (account, id) VALUES (?, ?)').run(account, id).changes) > 0;
  }
  worn(account: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of this.db.prepare('SELECT slot, id FROM cosmetics_worn WHERE account = ?').all(account) as unknown as Array<{ slot: string; id: string }>) out[r.slot] = r.id;
    return out;
  }
  setWorn(account: string, slot: string, id: string | null) {
    if (id === null) this.db.prepare('DELETE FROM cosmetics_worn WHERE account = ? AND slot = ?').run(account, slot);
    else this.db.prepare('INSERT INTO cosmetics_worn (account, slot, id) VALUES (?, ?, ?) ON CONFLICT(account, slot) DO UPDATE SET id = excluded.id').run(account, slot, id);
  }
  claimed(account: string): string[] {
    return (this.db.prepare('SELECT id FROM missions_done WHERE account = ?').all(account) as unknown as Array<{ id: string }>).map((r) => r.id);
  }
  /** True when this call recorded the claim (so exactly one caller pays the reward). */
  claim(account: string, id: string): boolean {
    return Number(this.db.prepare('INSERT OR IGNORE INTO missions_done (account, id) VALUES (?, ?)').run(account, id).changes) > 0;
  }
  log(t: number, kind: string, text: string) {
    this.db.prepare('INSERT INTO news_log (t, kind, text) VALUES (?, ?, ?)').run(t, kind, text);
    this.db.prepare('DELETE FROM news_log WHERE id <= (SELECT MAX(id) FROM news_log) - 200').run();
  }
  recentLog(limit: number): Array<{ id: number; t: number; kind: string; text: string }> {
    return this.db.prepare('SELECT id, t, kind, text FROM news_log ORDER BY id DESC LIMIT ?').all(limit) as never;
  }
}

export interface NewsItem { id: string; t: number; kind: 'settlement' | 'top_seller' | 'price' | 'building'; text: string }
export interface ToolView { uses: number; max: number; name: string; broken: boolean }
export interface ExtrasDeps {
  econ: Econ; gs: GameStore; clock: Clock; world: World; town: string; now: () => number;
  map: () => WorldMap | null;
  nameOf: (account: string) => string | null;
  board: (period: 'day' | 'all') => Board;
  merchantName: (account: string) => string;
}
type Res = { toast: string; tags: string[] };

const costText = (econ: Econ, c: Cost) => Object.entries(c).map(([t, n]) => `${n} ${t === 'coin' ? 'coins' : econ.items[t]?.name ?? t}`).join(', ');

export class Extras {
  d: ExtrasDeps;
  st: ExtrasStore;
  private wornCache = new Map<string, Record<string, string>>();

  constructor(d: ExtrasDeps) { this.d = d; this.st = new ExtrasStore(d.gs.db); }

  private day() { return this.d.clock.time().settleDay; }

  /** Takes coin from a player into the town fund (the same path as the Mall's worker gear). 409 when short. */
  payTown(account: string, coin: number, kind: string, ref: string) {
    const have = this.d.gs.balance(account, 'coin');
    if (have < coin) throw new HttpError(409, `Not enough coins (have ${have}, need ${coin}).`);
    this.d.gs.add(this.day(), account, 'coin', -coin, kind, ref);
    this.d.gs.add(this.day(), this.d.town, 'coin', coin, kind, ref);
  }

  /** Pays a cost of items and coin: items are used up, coin goes to the town. Checks everything first. */
  private payCost(account: string, cost: Cost, kind: string, ref: string) {
    const { gs, econ } = this.d;
    for (const [t, n] of Object.entries(cost)) {
      const have = gs.balance(account, t);
      if (have < n) throw new HttpError(409, t === 'coin' ? `Not enough coins (have ${have}, need ${n}).` : `Not enough ${econ.items[t]?.name ?? t} (have ${have}, need ${n}).`);
    }
    for (const [t, n] of Object.entries(cost)) {
      if (t === 'coin') this.payTown(account, n, kind, ref);
      else gs.add(this.day(), account, t, -n, kind, ref);
    }
  }

  /* ------------------------------------------------------------ tools */

  /** Gives a player the tools they miss, at full durability (new players, and existing players on their first state read). */
  ensureTools(account: string): Record<string, number> {
    const have = this.st.tools(account);
    for (const [kind, def] of Object.entries(this.d.econ.tools)) if (have[kind] === undefined) { have[kind] = def.durability; this.st.setTool(account, kind, def.durability); }
    return have;
  }
  /** The tool kind a tile type is worked with (rock: pickaxe, tree: axe, water: rod), or null. */
  toolFor(use: string): string | null {
    return Object.entries(this.d.econ.tools).find(([, t]) => t.use === use)?.[0] ?? null;
  }
  private def(kind: unknown) {
    if (typeof kind !== 'string' || !Object.hasOwn(this.d.econ.tools, kind)) throw new HttpError(400, 'Unknown tool.');
    return this.d.econ.tools[kind];
  }
  /** 409 when the tool is worn out. */
  need(account: string, kind: string | null) {
    if (!kind) return;
    const def = this.def(kind), left = this.ensureTools(account)[kind];
    if (left <= 0) throw new HttpError(409, `Your ${def.name} is broken. Repair it or make a new one.`);
  }
  /** One use: returns a message suffix when the tool wore out with this use. */
  wear(account: string, kind: string | null): string {
    if (!kind) return '';
    const def = this.def(kind), left = Math.max(0, this.ensureTools(account)[kind] - 1);
    this.st.setTool(account, kind, left);
    return left === 0 ? ` · Your ${def.name} wore out!` : '';
  }
  toolsView(account: string): Record<string, ToolView> {
    const have = this.ensureTools(account), out: Record<string, ToolView> = {};
    for (const [kind, def] of Object.entries(this.d.econ.tools)) out[kind] = { uses: Math.min(have[kind], def.durability), max: def.durability, name: def.name, broken: have[kind] <= 0 };
    return out;
  }
  repair(account: string, kind: unknown): Res {
    const def = this.def(kind), k = kind as string, left = this.ensureTools(account)[k];
    if (left >= def.durability) throw new HttpError(409, `Your ${def.name} is already like new.`);
    this.payCost(account, def.repair, 'tool_repair', k);
    this.st.setTool(account, k, def.durability);
    this.st.bump(account, 'repair'); this.st.bump(account, `repair:${k}`);
    return { toast: `${def.name} repaired (${costText(this.d.econ, def.repair)}).`, tags: Object.keys(def.repair) };
  }
  /** A brand-new tool from basic materials (or, for the Pickaxe, a Pickaxe bought from Ben): durability back to full. */
  make(account: string, kind: unknown): Res {
    const def = this.def(kind), k = kind as string;
    let cost = def.make;
    if (def.makeAlt && Object.entries(def.make).some(([t, n]) => this.d.gs.balance(account, t) < n) && Object.entries(def.makeAlt).every(([t, n]) => this.d.gs.balance(account, t) >= n)) cost = def.makeAlt;
    this.payCost(account, cost, 'tool_make', k);
    this.ensureTools(account);
    this.st.setTool(account, k, def.durability);
    this.st.bump(account, 'maketool'); this.st.bump(account, `maketool:${k}`);
    return { toast: `New ${def.name} made (${costText(this.d.econ, cost)}).`, tags: Object.keys(cost) };
  }

  /* ------------------------------------------------------------ counters (missions) */

  bump(account: string, key: string, n = 1) { this.st.bump(account, key, n); }

  /* ------------------------------------------------------------ paid entertainment */

  private rectDist(box: { x0: number; y0: number; x1: number; y1: number }, p: Pos) {
    return Math.max(box.x0 - p.x, 0, p.x - box.x1) + Math.max(box.y0 - p.y, 0, p.y - box.y1);
  }
  /** The carousel ride costs `fun.ride` coin. Where the village has a carousel, the player must be within 4 tiles of it. */
  ride(account: string, wid: string, pos: Pos | null): Res & { ride: { secs: number; price: number } } {
    const f = this.d.econ.fun;
    if (wid !== 'public') throw new HttpError(409, 'The carousel is in the public village.');
    const map = this.d.map();
    const box = (map?.layout as unknown as { fun?: { carousel?: { x0: number; y0: number; x1: number; y1: number } } } | undefined)?.fun?.carousel;
    if (map && box && pos && this.rectDist(box, pos) > 4) throw new HttpError(409, 'Come to the carousel in the square.');
    this.payTown(account, f.ride, 'fun', 'ride');
    this.st.bump(account, 'ride');
    return { toast: `Enjoy the ride! (−${f.ride} coins)`, tags: ['coin'], ride: { secs: f.rideSecs, price: f.ride } };
  }
  /** Casino entry: `fun.casino` coin buys a pass for `casinoPassMinutes` real minutes; a pass still running is not charged again. */
  casino(account: string, op: string, wid: string, pos: Pos | null): Res & { casino: { until: number } } {
    const f = this.d.econ.fun, now = this.d.now();
    if (op !== 'enter' && op !== 'status') throw new HttpError(400, 'Unknown casino action.');
    const have = this.st.pass(account, 'casino');
    if (op === 'status') return { toast: have > now ? 'Your casino pass is valid.' : 'You have no casino pass.', tags: [], casino: { until: have > now ? have : 0 } };
    if (wid !== 'public') throw new HttpError(409, 'The casino is in the public village.');
    this.nearCasino(wid, pos, 3);
    if (have > now) return { toast: `Your pass is still valid (${Math.ceil((have - now) / 60000)} min left).`, tags: [], casino: { until: have } };
    this.payTown(account, f.casino, 'fun', 'casino');
    const until = now + f.casinoPassMinutes * 60_000;
    this.st.setPass(account, 'casino', until);
    this.st.bump(account, 'casino');
    return { toast: `Welcome to the casino! Pass for ${f.casinoPassMinutes} minutes (−${f.casino} coins).`, tags: ['coin'], casino: { until } };
  }
  /** Where the village has a Casino building, the player must be within `d` tiles of its door (returns true when there is one). */
  nearCasino(wid: string, pos: Pos | null, d: number): boolean {
    const map = this.d.map();
    const c = map?.layout.buildings.find((b) => b.kind === 'casino');
    if (!map || !c || wid !== 'public') return !!c;
    // no position is a refusal, not a pass (indoors the client sends the door-front tile)
    if (!pos || Math.abs(pos.x - c.dx) + Math.abs(pos.y - c.dy) > d + 1) throw new HttpError(409, 'Come to the casino door first.');
    return true;
  }
  /** Whether the village has a Casino building. */
  hasCasino(): boolean { return !!this.d.map()?.layout.buildings.some((b) => b.kind === 'casino'); }
  passUntil(account: string): number { const u = this.st.pass(account, 'casino'); return u > this.d.now() ? u : 0; }

  /* ------------------------------------------------------------ mall cosmetics */

  private item(id: unknown): MallItem {
    const it = typeof id === 'string' ? this.d.econ.mall.items.find((x) => x.id === id) : undefined;
    if (!it) throw new HttpError(400, 'Unknown Mall item.');
    return it;
  }
  buy(account: string, id: unknown): Res {
    const it = this.item(id);
    if (this.st.owned(account).includes(it.id)) throw new HttpError(409, `You already own the ${it.name}.`);
    this.payTown(account, it.price, 'cosmetic', `mall:${it.id}`);
    this.st.addOwned(account, it.id);
    this.st.bump(account, 'mall:buy');
    let worn = '';
    if (!this.worn(account)[it.slot]) { this.setWorn(account, it.slot, it.id); worn = ' You put it on.'; }
    return { toast: `${it.name} bought (−${it.price} coins).${worn}`, tags: ['coin'] };
  }
  /** Wear an owned item in its slot; an empty id takes the slot's item off. */
  wearItem(account: string, slot: unknown, id: unknown): Res {
    if (typeof slot !== 'string' || !this.d.econ.mall.slots.includes(slot)) throw new HttpError(400, 'Unknown slot.');
    if (id === null || id === undefined || id === '') {
      this.setWorn(account, slot, null);
      return { toast: 'Taken off.', tags: [] };
    }
    const it = this.item(id);
    if (it.slot !== slot) throw new HttpError(400, `The ${it.name} does not go in the ${slot} slot.`);
    if (!this.st.owned(account).includes(it.id)) throw new HttpError(409, `You don't own the ${it.name} yet.`);
    this.setWorn(account, slot, it.id);
    this.st.bump(account, 'mall:wear');
    return { toast: `You wear the ${it.name}.`, tags: [] };
  }
  private setWorn(account: string, slot: string, id: string | null) {
    this.st.setWorn(account, slot, id);
    this.wornCache.delete(account);
  }
  /** What the account wears, slot -> item id (cached: presence asks for it several times a second). */
  worn(account: string): Record<string, string> {
    let w = this.wornCache.get(account);
    if (!w) {
      const cat = new Set(this.d.econ.mall.items.map((i) => i.id));
      w = Object.fromEntries(Object.entries(this.st.worn(account)).filter(([, id]) => cat.has(id)));
      if (this.wornCache.size > 5000) this.wornCache.clear();
      this.wornCache.set(account, w);
    }
    return w;
  }
  cosmeticsView(account: string) { return { owned: this.st.owned(account), worn: this.worn(account) }; }

  /* ------------------------------------------------------------ missions */

  missionsView(account: string) {
    const claimed = new Set(this.st.claimed(account));
    const list = this.d.econ.missions.map((m) => {
      const have = this.st.counter(account, m.counter);
      return { id: m.id, name: m.name, hint: m.hint, have: Math.min(have, m.need), need: m.need, done: have >= m.need, claimed: claimed.has(m.id), reward: m.reward };
    });
    return { list, current: list.find((m) => !m.claimed)?.id ?? null, claimable: list.filter((m) => m.done && !m.claimed).map((m) => m.id) };
  }
  /** Pays a finished mission's reward once: coin from the town fund (if it can pay), items minted at settlement, all inside the daily gain caps. */
  claimMission(account: string, id: unknown): Res {
    const m = typeof id === 'string' ? this.d.econ.missions.find((x) => x.id === id) : undefined;
    if (!m) throw new HttpError(400, 'Unknown mission.');
    if (this.st.claimed(account).includes(m.id)) throw new HttpError(409, 'You already claimed this reward.');
    if (this.st.counter(account, m.counter) < m.need) throw new HttpError(409, 'Not finished yet.');
    const { gs, world, town } = this.d, coin = m.reward.coin ?? 0;
    if (coin > 0 && gs.balance(town, 'coin') < coin) throw new HttpError(409, 'The village fund is short right now. Try again later.');
    for (const [t, n] of Object.entries(m.reward)) world.checkGain(account, t, n); // a full daily cap refuses before anything moves
    gs.tx(() => {
      if (!this.st.claim(account, m.id)) throw new HttpError(409, 'You already claimed this reward.');
      for (const [t, n] of Object.entries(m.reward)) {
        if (t === 'coin') gs.add(this.day(), town, 'coin', -n, 'mission', m.id);
        gs.add(this.day(), account, t, n, 'mission', m.id);
      }
    });
    return { toast: `Mission done: ${m.name}! Reward ${costText(this.d.econ, m.reward)}.`, tags: Object.keys(m.reward) };
  }

  /* ------------------------------------------------------------ news */

  logBuilt(account: string, kind: string, t: number) {
    const def = this.d.econ.homeland.buildings[kind];
    if (!def) return;
    this.st.log(t, 'building', `${this.d.nameOf(account) ?? account.split('.')[0]} finished building a ${def.name}.`);
  }
  /** The latest town news, newest first, at most 20: finished buildings, settled days, the day's top seller and big price moves. */
  news(): NewsItem[] {
    const { gs, econ, clock } = this.d, out: NewsItem[] = [], now = this.d.now();
    for (const r of this.st.recentLog(8)) out.push({ id: `building:${r.id}`, t: r.t, kind: 'building', text: r.text });
    const days = new Set<number>();
    for (const s of gs.settlements(12) as Array<{ day: number; created_at: number }>) {
      if (days.has(s.day)) continue;
      days.add(s.day);
      if (days.size > 4) break;
      const n = gs.activeAccounts(s.day);
      out.push({ id: `settlement:${s.day}`, t: s.created_at, kind: 'settlement', text: `Day ${s.day} is settled in the town ledger.${n > 0 ? ` ${n} player${n === 1 ? ' was' : 's were'} active.` : ''}` });
    }
    const today = clock.time().settleDay;
    for (const [day, period] of [[today, 'day'] as const]) {
      const top = this.d.board(period).rows[0];
      if (top) out.push({ id: `top:${day}`, t: now, kind: 'top_seller', text: `${top.name} is the top seller today with ${top.sold_qty} item${top.sold_qty === 1 ? '' : 's'} sold.` });
    }
    const moves = gs.markets().filter((m) => Math.abs(m.change_pct) >= 3 && m.token in econ.items).sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct)).slice(0, 4);
    for (const m of moves) out.push({ id: `price:${m.merchant}:${m.token}:${m.hour}`, t: now - 1, kind: 'price', text: `${this.d.merchantName(m.merchant)}: ${econ.items[m.token].name} price ${m.change_pct > 0 ? 'up' : 'down'} ${Math.abs(m.change_pct)}% (now ${m.ask || m.bid} coins).` });
    return out.sort((a, b) => b.t - a.t).slice(0, 20);
  }
}
