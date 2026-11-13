// Homelands: every player owns one private world (a Town Hall in the middle of a 3 x 3 grid of chunks). This module holds
// what is not in the map generator: the player's progress (Town Hall level, opened chunks, buildings), the builder jobs
// that run on server timers (`ends_at`), lazy production of the buildings, and the guest list.
//
// Everything is off-chain. Costs and gains are ordinary ledger rows (GameStore.add) that settle with the day:
// item costs are burned (negative rows, kind 'build'), coin costs move to the town treasury, gains go through the
// daily caps the caller passes in (World.checkGain). Timers are absolute timestamps; a job that ended while nobody
// looked (or the server was down) is applied the next time the Homeland is read, exactly once.
import type { BuildingDef, ChunkStep, Cost, Econ, ForageDef, LightStep, TownhallStep } from './econ.ts';

/** Job target and furniture-table key of the Town Hall's Lighting project. */
export const LIGHT_KEY = 'light';
import type { GameStore, HomelandRow, WorkerRow } from './gamestore.ts';
import { HttpError } from '../auth.ts';
import { gameTime } from '../../../economy/time.ts';
import type { Clock } from './clock.ts';
import { Homeland, HomelandMap, type HomelandProgress } from './worldmap.ts';

export interface PlayerDir { nameOf(account: string): string | null; tagOf(account: string): string; accountByNameTag(name: string, tag: string): string | null; isPlayer(account: string): boolean }
export interface HomelandDeps { econ: Econ; gs: GameStore; worldSeed: number; now: () => number; players?: PlayerDir; town: string; clock?: Clock; party?: { same(a: string, b: string): boolean; mates(a: string): string[] };
  /** A building finished (for the town news). */
  built?: (account: string, kind: string, t: number) => void }

/** Guest roles: visitor < helper < builder < owner. */
export type Role = 'visitor' | 'helper' | 'builder' | 'owner';
const RANK: Record<Role, number> = { visitor: 0, helper: 1, builder: 2, owner: 3 };
/** Stored invite and party roles only ever grant helper or builder; 'owner' and anything unknown count as visitor (owner comes from row.account alone). */
const roleOf = (r: unknown): Role => (r === 'helper' || r === 'builder' ? r : 'visitor');
const SETTABLE = ['visitor', 'helper', 'builder'];
/** Ground the hoe can turn: open grass inside the farm fence (the fixed plots are 'soil' and are tilled through the farm act). */
const HOEABLE = new Set(['grass', 'tallgrass', 'flower']);

export interface BuildingOption extends BuildingDef { lot: string | null; can: boolean; why: string | null }
export interface HomelandView {
  id: number; world: string; seed: number; gen: number; th: number; open: string[];
  built: Array<{ lot: string; kind: string; stored: number; capacity: number }>;
  jobs: Array<{ target: string; kind: string; ends_at: number }>;
  builders: { total: number; busy: number };
  light: number;
  next: { th: TownhallStep | null; chunk: ChunkStep | null; light: LightStep | null; buildings: Record<string, BuildingOption> };
  guests: Array<{ account: string; name: string; tag: string; role: Role }>;
  party_role: string;
  bots: Array<{ id: number; job: string; name: string; house: string | null; cosmetic: string | null }>;
  workers: Array<{ slot: number; name: string; fatigue: number; busy: boolean; sick_until: number; motivation: number; cosmetic: string | null }>;
  cosmetics: Record<string, { name: string; price: number; boost: number; color: string }>;
  houses: Array<{ lot: string; beds: number; used: number; kasur: number; kasurMax: number; hiburan: number; hiburanMax: number; hiburanName: string | null; motivation: number; nextKasur: { cost: Cost; secs: number } | null; nextHiburan: { cost: Cost; secs: number; name: string | null } | null }>;
  beds: { total: number; used: number };
  hospital: { lot: string; level: number; maxLevel: number; healGameHours: number; next: { cost: Cost; secs: number } | null } | null;
  storehouse: { lot: string; level: number; maxLevel: number; bonus: number; nextBonus: number | null; next: { cost: Cost; secs: number } | null } | null;
  restoran: { pantry: number; pantryMax: number; nextServeAt: number } | null;
  forage: { stored: Record<string, number>; capacity: number } | null;
  tilled: Array<[number, number]>;
  cook: { recipe: { inputs: Record<string, number>; output: string }; can: boolean; why: string | null } | null;
  hire: Record<string, { name: string; price: number; rarity: string; max: number; have: number; th: number; can: boolean; why: string | null }>;
}
export interface BotEffects { builders: number; farmGrowFactor: number; fishRate: number; woodBonus: number; chef: boolean; chefBoost: number; forage: ForageDef | null }
export type { HomelandRow };

export const homeWorld = (id: number): string => `HL-${id}`;
export function parseHome(w: string): number | null {
  const m = /^HL-([1-9]\d{0,9})$/.exec(String(w));
  return m ? Number(m[1]) : null;
}

/** 32-bit FNV-1a of the UTF-8 bytes. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(s, 'utf8')) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
const NEIGHBOURS: Record<string, string[]> = {
  nw: ['n', 'w'], n: ['nw', 'c', 'ne'], ne: ['n', 'e'],
  w: ['nw', 'c', 'sw'], c: ['n', 'w', 'e', 's'], e: ['ne', 'c', 'se'],
  sw: ['w', 's'], s: ['sw', 'c', 'se'], se: ['s', 'e'],
};
const MAX_INVITES = 20;

export class Homelands {
  d: HomelandDeps;
  maps = new Map<string, HomelandMap>();

  constructor(d: HomelandDeps) { this.d = d; }

  private get cfg() { return this.d.econ.homeland; }
  private now() { return this.d.now(); }
  private name(token: string) { return this.d.econ.items[token]?.name ?? token; }
  private msPerHour() { return this.d.econ.time.realMsPerGameHour; }

  /* ------------------------------------------------------------ rows */

  ensure(account: string): HomelandRow {
    const have = this.d.gs.homelandOf(account);
    if (have) return have;
    return this.d.gs.createHomeland(account, fnv1a(`${this.d.worldSeed}:${account}`), Homeland.VERSION, this.now());
  }
  byId(id: number): HomelandRow | undefined { return this.d.gs.homelandById(id); }

  /** Applies every job that ended (exactly once each: the delete decides who applies it), then replays contractor
   *  fatigue, recovery and the Restoran's serving from the last tick up to now (at most 72 game hours back). */
  settle(account: string): void {
    const gs = this.d.gs, fc = this.cfg.fatigue, rc = this.cfg.restoran;
    const now = this.now(), hourMs = this.msPerHour();
    if (!gs.homelandOf(account)) return;
    const interval = this.serveInterval(account); // game hours between servings
    const stepMs = Math.max(1, Math.round(hourMs * Math.min(1, interval)));
    let st = gs.pantryOf(account);
    if (!st) { gs.savePantry(account, 0, now); st = { pantry: 0, tick_at: now }; }
    let pantry = st.pantry, cursor = Math.max(st.tick_at, now - 72 * hourMs);
    const workers = new Map<number, WorkerRow>();
    for (const slot of this.contractorSlots(account)) workers.set(slot, this.workerOf(account, slot));
    const dirty = new Set<number>();
    const hasRestoran = this.restoranLot(account) !== null;
    const applyEnded = (upTo: number) => {
      for (const j of gs.homelandJobs(account)) {
        if (j.ends_at > upTo) continue;
        if (!gs.deleteHomelandJob(account, j.target)) continue;
        const row = gs.homelandOf(account);
        if (!row) continue;
        if (j.kind === 'th') gs.setHomelandTh(account, row.th + 1);
        else if (j.kind === 'chunk') { if (!row.open.includes(j.target)) gs.setHomelandOpen(account, [...row.open, j.target]); }
        else if (j.kind === 'light') gs.setFurnitureLevel(account, LIGHT_KEY, gs.furnitureLevel(account, LIGHT_KEY) + 1);
        else if (j.kind === 'furniture') gs.setFurnitureLevel(account, j.target, gs.furnitureLevel(account, j.target) + 1);
        else if (j.kind === 'upgrade') { const lot = j.target.split(':')[0]; gs.setFurnitureLevel(account, lot, Math.max(1, gs.furnitureLevel(account, lot)) + 1); }
        else { gs.addHomelandBuilding(account, j.target, j.target.split('-')[0], j.ends_at); this.d.built?.(account, j.target.split('-')[0], j.ends_at); }
        const w = workers.get(j.worker);
        if (w) {
          w.fatigue = Math.min(100, w.fatigue + fc.perJobMinute * (j.base_secs / 60) * (1 - this.boostOf(account, w.slot)));
          if (w.fatigue >= fc.collapseAt && !w.sick_until) w.sick_until = j.ends_at + this.sickHours(account) * hourMs;
          dirty.add(w.slot);
        }
      }
    };
    while (cursor + stepMs <= now) {
      cursor += stepMs;
      applyEnded(cursor);
      const busy = new Set(gs.homelandJobs(account).filter((j) => j.started_at <= cursor).map((j) => j.worker));
      for (const w of workers.values()) {
        if (w.sick_until && w.sick_until <= cursor) { w.sick_until = 0; w.fatigue = 0; dirty.add(w.slot); }
        else if (!w.sick_until && !busy.has(w.slot) && w.fatigue > 0) { w.fatigue = Math.max(0, w.fatigue - fc.idleRecoverPerGameHour * stepMs / hourMs); dirty.add(w.slot); }
      }
      if (pantry > 0 && hasRestoran) {
        const tired = [...workers.values()].filter((w) => !w.sick_until && w.fatigue >= rc.serveMinFatigue).sort((a, b) => b.fatigue - a.fatigue || a.slot - b.slot)[0];
        if (tired) { tired.fatigue = Math.max(0, tired.fatigue - rc.serveRelief); pantry--; dirty.add(tired.slot); }
      }
    }
    applyEnded(now);
    // a worker whose sickness ended inside the last, unfinished step is healed now, not one step later
    for (const w of workers.values()) if (w.sick_until && w.sick_until <= now) { w.sick_until = 0; w.fatigue = 0; dirty.add(w.slot); }
    for (const slot of dirty) { const w = workers.get(slot)!; w.updated_at = now; gs.saveWorker(w); }
    if (pantry !== st.pantry || cursor !== st.tick_at) gs.savePantry(account, pantry, cursor);
  }

  /** Slot 0 is the default Tukang in the Balai Kota; each hired builder bot is its own slot (its bot id). */
  private contractorSlots(account: string): number[] {
    return [0, ...this.d.gs.homelandBots(account).filter((b) => b.job === 'builder').map((b) => b.id)];
  }
  private workerOf(account: string, slot: number): WorkerRow {
    return this.d.gs.workerRows(account).find((w) => w.slot === slot) ?? { account, slot, fatigue: 0, updated_at: this.now(), sick_until: 0 };
  }
  /* ------------------------------------------------------------ cosmetics */

  private cosmeticDef(name: string | undefined) {
    const all = this.cfg.cosmetics ?? {};
    return name && Object.hasOwn(all, name) ? all[name] : undefined;
  }
  /** Boost of the cosmetic a slot (0 = the default Tukang) or bot id wears; 0 when bare. */
  private boostOf(account: string, slot: number): number { return this.cosmeticDef(this.d.gs.cosmeticsOf(account)[slot])?.boost ?? 0; }
  /** Game hours between Restoran servings: a Koki halves it, a dressed Koki a little more. */
  private serveInterval(account: string): number {
    const rc = this.cfg.restoran, e = this.effects(account);
    return rc.serveEveryGameHours / (e.chef ? rc.chefServeFactor * (1 + e.chefBoost) : 1);
  }

  /** Dresses the Tukang (bot 0) or one of the owner's bots; the coin goes to the town and a new hat replaces the old without refund. */
  dress(account: string, bot: unknown, cosmetic: unknown, day: number): { toast: string; tags: string[] } {
    this.settle(account);
    const def = typeof cosmetic === 'string' ? this.cosmeticDef(cosmetic) : undefined;
    if (!def) throw new HttpError(400, 'Unknown gear.');
    const id = Number(bot);
    if (bot === null || bot === '' || typeof bot === 'boolean' || !Number.isInteger(id) || id < 0) throw new HttpError(400, 'Unknown worker.');
    const gs = this.d.gs;
    if (id !== 0 && !gs.homelandBots(account).some((b) => b.id === id)) throw new HttpError(409, 'That worker isn\'t yours.');
    const coin = gs.balance(account, 'coin');
    if (coin < def.price) throw new HttpError(409, `Not enough coins (have ${coin}, need ${def.price}).`);
    const ref = `${homeWorld(this.ensure(account).id)}:dress:${id}`;
    gs.add(day, account, 'coin', -def.price, 'cosmetic', ref);
    gs.add(day, this.d.town, 'coin', def.price, 'cosmetic', ref);
    gs.setCosmetic(account, id, cosmetic as string);
    return { toast: `${def.name} installed (-${def.price} coins).`, tags: ['coin'] };
  }

  /* ------------------------------------------------------------ houses, motivation, hospital */

  /** Built houses (buildings whose config has furniture) with their lot ids, in lot order. */
  private houseLots(account: string): string[] {
    return this.d.gs.homelandBuildings(account).filter((b) => Object.hasOwn(this.cfg.buildings, b.kind) && this.cfg.buildings[b.kind].furniture).map((b) => b.lot);
  }
  private houseDef() { return Object.values(this.cfg.buildings).find((d) => d.furniture)!; }
  private furnLevel(account: string, lot: string, item: string) { return this.d.gs.furnitureLevel(account, `${lot}:${item}`); }
  private bedsOf(account: string, lot: string) { return 1 + this.furnLevel(account, lot, 'kasur'); }
  private bedInfo(account: string): { total: number; used: number } {
    let total = 0;
    for (const lot of this.houseLots(account)) total += this.bedsOf(account, lot);
    return { total, used: this.d.gs.homelandBots(account).length };
  }
  private houseMotivation(account: string, lot: string): number {
    const m = this.cfg.motivation;
    return lot ? Math.min(100, m.base + m.perHiburan * this.furnLevel(account, lot, 'hiburan')) : m.base;
  }
  /** Motivation of a contractor slot or bot id: the default Tukang (slot 0) is fixed, a bot takes its house's. */
  private motivationOf(account: string, slot: number): number {
    if (slot === 0) return this.cfg.motivation.tukang;
    const b = this.d.gs.homelandBots(account).find((x) => x.id === slot);
    return b ? this.houseMotivation(account, b.house) : this.cfg.motivation.base;
  }
  private factorOf(motivation: number) { return this.cfg.motivation.factorBase + this.cfg.motivation.factorSpan * motivation / 100; }
  private motivationFactor(account: string, slot: number): number { return this.factorOf(this.motivationOf(account, slot)); }
  /** The house a new bot moves into: a free bed, the best entertainment first. '' when none (legacy bots). */
  private pickHouse(account: string): string {
    const bots = this.d.gs.homelandBots(account);
    const free = this.houseLots(account).filter((lot) => this.bedsOf(account, lot) - bots.filter((b) => b.house === lot).length > 0);
    free.sort((a, b) => this.furnLevel(account, b, 'hiburan') - this.furnLevel(account, a, 'hiburan') || (a < b ? -1 : 1));
    return free[0] ?? '';
  }
  private hospital(account: string): { lot: string; level: number; def: BuildingDef } | null {
    const b = this.d.gs.homelandBuildings(account).find((x) => Object.hasOwn(this.cfg.buildings, x.kind) && this.cfg.buildings[x.kind].healGameHours);
    if (!b) return null;
    const def = this.cfg.buildings[b.kind];
    return { lot: b.lot, level: Math.min(def.maxLevel ?? 1, Math.max(1, this.d.gs.furnitureLevel(account, b.lot))), def };
  }
  /** A built building that levels up (the Hospital, the Storehouse): its lot, level 1..maxLevel and def. */
  private leveled(account: string, lot: string): { lot: string; level: number; def: BuildingDef } | null {
    const b = this.d.gs.homelandBuildings(account).find((x) => x.lot === lot);
    const def = b && Object.hasOwn(this.cfg.buildings, b.kind) ? this.cfg.buildings[b.kind] : undefined;
    if (!b || !def?.upgrade) return null;
    return { lot: b.lot, level: Math.min(def.maxLevel ?? 1, Math.max(1, this.d.gs.furnitureLevel(account, b.lot))), def };
  }
  /** The Storehouse (Gudang): every producing building holds this much more before it stops (0 without one). */
  private storehouse(account: string): { lot: string; level: number; def: BuildingDef } | null {
    const b = this.d.gs.homelandBuildings(account).find((x) => Object.hasOwn(this.cfg.buildings, x.kind) && this.cfg.buildings[x.kind].storeBonus);
    return b ? this.leveled(account, b.lot) : null;
  }
  private storeBonus(account: string): number {
    const s = this.storehouse(account);
    return s ? s.def.storeBonus![s.level - 1] ?? 0 : 0;
  }
  /** What a producing building holds before it stops: its capacity, raised by the Storehouse. */
  private capOf(account: string, def: BuildingDef): number {
    return Math.floor((def.capacity ?? 0) * (1 + this.storeBonus(account)) + 1e-9);
  }
  /** Game hours a collapsed contractor stays sick: the hospital level decides, no hospital is the long way. */
  private sickHours(account: string): number {
    const h = this.hospital(account);
    return h ? h.def.healGameHours![h.level - 1] : this.cfg.fatigue.sickGameHoursWithoutHospital;
  }

  private progress(row: HomelandRow): HomelandProgress {
    return { open: row.open, th: row.th, gen: row.gen, light: this.lightLevel(row.account), built: this.d.gs.homelandBuildings(row.account).map((b) => ({ kind: b.kind, lot: b.lot })) };
  }

  /** The map as it is now (progress decides what is open and built; cached per progress key). */
  map(row: HomelandRow): HomelandMap {
    const prog = this.progress(row);
    const key = `${row.id}:${row.th}:${row.open.join(',')}:${prog.built.map((b) => b.lot).sort().join(',')}:L${prog.light ?? 0}`;
    let m = this.maps.get(key);
    if (!m) {
      for (const k of this.maps.keys()) if (k.startsWith(`${row.id}:`)) this.maps.delete(k);
      m = new HomelandMap(row.seed, prog);
      this.maps.set(key, m);
    }
    return m;
  }

  /* ------------------------------------------------------------ production */

  /** Output per game hour: Nelayan bots speed up the fish ponds. */
  private rateOf(account: string, def: BuildingDef): number {
    return (def.perGameHour ?? 0) * (def.produces === 'fish' ? this.effects(account).fishRate : 1);
  }
  private storedOf(account: string, def: BuildingDef, lastCollect: number): number {
    if (!def.produces) return 0;
    const gh = Math.max(0, this.now() - lastCollect) / this.msPerHour();
    return Math.min(this.capOf(account, def), Math.floor(this.rateOf(account, def) * gh + 1e-9));
  }

  /* ------------------------------------------------------------ Pemburu (forage) */

  /** Game hour index now (the server clock; without one, derived from the wall clock). */
  private gameHourNow(): number { return this.d.clock ? this.d.clock.hours() : Math.floor(this.now() / this.msPerHour()); }
  private isWinter(season: string): boolean { return this.d.econ.farm.noGrowthSeasons.includes(season); }

  /** Units the Pemburu has brought so far (fractional): the carried remainder plus every hour since the last pick-up,
   *  each counted at the rate of the season of that game hour (winter hours count `winterFactor` units), newest hour first. */
  private forageTotal(account: string, f: ForageDef): number {
    const st = this.d.gs.forageOf(account);
    if (!st) return 0;
    let total = st.carry, left = Math.max(0, this.now() - st.last) / this.msPerHour();
    const H = this.gameHourNow();
    for (let i = 0; left > 1e-9 && Math.floor(total + 1e-9) < f.capacity && i < 100000; i++) {
      const span = Math.min(1, left);
      left -= span;
      const season = gameTime(Math.max(0, H - i), this.d.econ.time).season;
      total += span * f.perGameHour * (this.isWinter(season) ? f.winterFactor : 1);
    }
    return total;
  }
  private forageStored(account: string): { stored: Record<string, number>; capacity: number; total: number } | null {
    const f = this.effects(account).forage;
    if (!f) return null;
    const total = this.forageTotal(account, f);
    const n = Math.min(f.capacity, Math.floor(total + 1e-9));
    const stored: Record<string, number> = Object.fromEntries(f.items.map((t) => [t, 0]));
    for (let k = 0; k < n; k++) stored[f.items[k % f.items.length]]++;
    return { stored, capacity: f.capacity, total };
  }

  forage(account: string, day: number, checkGain: (a: string, t: string, n: number) => void): { toast: string; tags: string[]; gained: Record<string, number> } {
    this.settle(account);
    const gs = this.d.gs;
    const f = this.effects(account).forage, fs = this.forageStored(account);
    if (!f || !fs) throw new HttpError(409, 'You don\'t have a Hunter yet.');
    const got = Object.entries(fs.stored).filter(([, n]) => n > 0);
    if (!got.length) throw new HttpError(409, 'The Hunter isn\'t carrying anything.');
    for (const [t, n] of got) checkGain(account, t, n); // throws on a full daily cap; nothing has changed yet
    const world = homeWorld(this.ensure(account).id);
    for (const [t, n] of got) gs.add(day, account, t, n, 'forage', `${world}:forage`);
    const whole = Math.floor(fs.total + 1e-9);
    gs.setForage(account, this.now(), whole >= f.capacity ? 0 : fs.total - whole);
    return { toast: got.map(([t, n]) => `+${n} ${this.name(t)}`).join(', '), tags: got.map(([t]) => t), gained: Object.fromEntries(got) };
  }

  /* ------------------------------------------------------------ Restoran (cook) */

  /** The built Restoran lot, or null. */
  restoranLot(account: string): string | null {
    return this.d.gs.homelandBuildings(account).find((b) => this.cfg.buildings[b.kind]?.cooks)?.lot ?? null;
  }
  private cookRecipe(account: string): { inputs: Record<string, number>; output: string } | null {
    const b = this.d.gs.homelandBuildings(account).find((x) => this.cfg.buildings[x.kind]?.cooks);
    const id = b && this.cfg.buildings[b.kind].cooks;
    if (!id || !Object.hasOwn(this.d.econ.recipes, id)) return null;
    const r = this.d.econ.recipes[id];
    return { inputs: r.inputs, output: r.output };
  }
  private cookWhy(account: string, r: { inputs: Record<string, number> }, qty: number): string | null {
    const lack = Object.entries(r.inputs).some(([t, n]) => this.d.gs.balance(account, t) < n * qty);
    return lack ? `Not enough materials (need ${Object.entries(r.inputs).map(([t, n]) => `${n * qty} ${this.name(t)}`).join(', ')}).` : null;
  }

  private pantryOf(account: string): number { return this.d.gs.pantryOf(account)?.pantry ?? 0; }
  private qtyOf(qty: unknown, max: number): number {
    const q = Number(qty);
    if (!Number.isInteger(q) || q < 1 || q > max) throw new HttpError(400, `The amount must be 1 to ${max}.`);
    return q;
  }
  private pantrySpace(account: string, q: number) {
    const max = this.cfg.restoran.pantryMax, have = this.pantryOf(account);
    if (have + q > max) throw new HttpError(409, `The pantry is full (${have} of ${max}).`);
  }
  private setPantry(account: string, n: number) { this.d.gs.savePantry(account, n, this.d.gs.pantryOf(account)?.tick_at ?? this.now()); }

  /** Cooks `qty` (1-10) of the Restoran's recipe from the bag into the Restoran's pantry (not the bag). */
  cook(account: string, qty: unknown, day: number): { toast: string; tags: string[] } {
    this.settle(account);
    const r = this.cookRecipe(account);
    if (!r) throw new HttpError(409, 'Build the Restaurant first.');
    const q = this.qtyOf(qty, 10);
    const why = this.cookWhy(account, r, q);
    if (why) throw new HttpError(409, why);
    this.pantrySpace(account, q);
    const gs = this.d.gs, world = homeWorld(this.ensure(account).id);
    for (const [t, n] of Object.entries(r.inputs)) gs.add(day, account, t, -n * q, 'cook', `${world}:cook`);
    this.setPantry(account, this.pantryOf(account) + q);
    return { toast: `${q} ${this.name(r.output)} went into the Restaurant pantry (${this.pantryOf(account)} of ${this.cfg.restoran.pantryMax}).`, tags: Object.keys(r.inputs) };
  }

  /** Moves bread or meal from the bag into the pantry. */
  stock(account: string, token: string, qty: unknown, day: number): { toast: string; tags: string[] } {
    this.settle(account);
    if (!this.restoranLot(account)) throw new HttpError(409, 'Build the Restaurant first.');
    if (!['bread', 'meal'].includes(token)) throw new HttpError(400, 'Only bread and grilled fish can be stored.');
    const q = this.qtyOf(qty, this.cfg.restoran.pantryMax);
    const have = this.d.gs.balance(account, token);
    if (have < q) throw new HttpError(409, `Not enough ${this.name(token)} (have ${have}, need ${q}).`);
    this.pantrySpace(account, q);
    this.d.gs.add(day, account, token, -q, 'stock', `${homeWorld(this.ensure(account).id)}:pantry`);
    this.setPantry(account, this.pantryOf(account) + q);
    return { toast: `${q} ${this.name(token)} put into the Restaurant pantry.`, tags: [token] };
  }

  /* ------------------------------------------------------------ worker bots */

  /** A bot definition by job name: own config keys only (never 'constructor', '__proto__' and the like). */
  private botDef(job: string) {
    const all = this.cfg.bots ?? {};
    return Object.hasOwn(all, job) ? all[job] : undefined;
  }

  bots(account: string): Array<{ id: number; job: string; name: string; house: string | null; cosmetic: string | null }> {
    return this.d.gs.homelandBots(account).filter((b) => this.botDef(b.job)).map((b) => ({ id: b.id, job: b.job, name: this.botDef(b.job)!.name, house: b.house || null, cosmetic: this.d.gs.cosmeticsOf(account)[b.id] ?? null }));
  }

  /** What the owner's bots add up to. Factors multiply per bot, bonuses add. */
  effects(account: string): BotEffects {
    const e: BotEffects = { builders: 0, farmGrowFactor: 1, fishRate: 1, woodBonus: 0, chef: false, chefBoost: 0, forage: null };
    for (const b of this.d.gs.homelandBots(account)) {
      const x = this.botDef(b.job)?.effect;
      if (!x) continue;
      const cb = this.boostOf(account, b.id), mf = this.motivationFactor(account, b.id) * (1 + cb); // a hat adds to the excess like motivation does // motivated bots work harder, bored ones slower
      e.builders += x.builders ?? 0;
      e.woodBonus += x.woodBonus ?? 0;
      if (x.farmGrowFactor) e.farmGrowFactor *= 1 + (x.farmGrowFactor - 1) * mf;
      if (x.fishRate) e.fishRate *= 1 + (x.fishRate - 1) * mf;
      if (x.chef) { e.chef = true; e.chefBoost = cb; }
      if (x.forage) e.forage = { ...x.forage, perGameHour: x.forage.perGameHour * mf };
    }
    return e;
  }
  private builderSlots(account: string) { return this.cfg.builders + this.effects(account).builders; }

  /** Why this job cannot be hired right now, or null. Pure. */
  private hireWhy(account: string, th: number, job: string): string | null {
    const def = this.botDef(job);
    if (!def) return 'Unknown worker.';
    const have = this.d.gs.homelandBots(account).filter((b) => b.job === job).length;
    if (have >= def.max) return `${def.name} workers are full (max ${def.max}).`;
    const need = def.th ?? (job === 'builder' ? 1 : 2);
    if (th < need) return `Town Hall needs level ${need}.`;
    const beds = this.bedInfo(account);
    if (beds.used >= beds.total) return 'No empty bed. Build a Workers\' House or add beds.';
    const coin = this.d.gs.balance(account, 'coin');
    if (coin < def.price) return `Not enough coins (have ${coin}, need ${def.price}).`;
    return null;
  }

  hire(account: string, job: string, day: number): { toast: string; tags: string[] } {
    this.settle(account);
    const row = this.ensure(account);
    const def = this.botDef(String(job));
    if (!def) throw new HttpError(400, 'Unknown worker.');
    const why = this.hireWhy(account, row.th, job);
    if (why) throw new HttpError(409, why);
    const gs = this.d.gs;
    const ref = `${homeWorld(row.id)}:hire:${job}`;
    gs.add(day, account, 'coin', -def.price, 'hire', ref);
    gs.add(day, this.d.town, 'coin', def.price, 'hire', ref);
    gs.addHomelandBot(account, job, this.now(), this.pickHouse(account));
    if (def.effect.forage) gs.setForage(account, this.now(), 0);
    return { toast: `${def.name} hired (-${def.price} coins).`, tags: ['coin'] };
  }

  /** The hoe: turns one grass tile inside the farm fence into tilled ground (owner's world, kept for good). */
  hoe(owner: string, x: number, y: number): { toast: string; tags: string[]; tilled: Array<[number, number]> } {
    const row = this.ensure(owner), L = this.map(row).layout, f = L.farm;
    if (!Number.isInteger(x) || !Number.isInteger(y) || f.x0 == null || f.y0 == null || f.x1 == null || f.y1 == null) throw new HttpError(400, 'Bad tile.');
    if (x <= f.x0 || x >= f.x1 || y <= f.y0 || y >= f.y1) throw new HttpError(409, 'Use the hoe inside the farm fence.');
    const t = L.tiles[y * L.w + x];
    if (!HOEABLE.has(t)) throw new HttpError(409, 'This ground cannot be hoed.');
    if (!this.d.gs.addTilled(owner, x, y)) throw new HttpError(409, 'Already hoed.');
    return { toast: 'The ground is hoed.', tags: [], tilled: this.d.gs.tilledOf(owner) };
  }

  collect(account: string, lot: string, day: number, checkGain: (a: string, t: string, n: number) => void, actor = account): { toast: string; tags: string[]; gained: Record<string, number> } {
    this.settle(account);
    const gs = this.d.gs;
    const b = gs.homelandBuildings(account).find((x) => x.lot === lot);
    const def = b && this.cfg.buildings[b.kind];
    if (!b || !def) throw new HttpError(409, 'There\'s no building here yet.');
    if (!def.produces) throw new HttpError(409, `${def.name} doesn't produce anything by itself.`);
    const stored = this.storedOf(account, def, b.last_collect);
    if (stored <= 0) throw new HttpError(409, 'No output yet.');
    checkGain(account, def.produces, stored); // throws on a full daily cap; nothing has changed yet
    const world = homeWorld(gs.homelandOf(account)!.id);
    gs.add(day, account, def.produces, stored, 'collect', actor === account ? `${world}:${lot}` : `coop:${actor}`);
    const full = stored >= this.capOf(account, def);
    gs.setHomelandCollect(account, lot, full ? this.now() : Math.round(b.last_collect + (stored / this.rateOf(account, def)) * this.msPerHour()));
    return { toast: `+${stored} ${this.name(def.produces)}`, tags: [def.produces], gained: { [def.produces]: stored } };
  }

  /* ------------------------------------------------------------ builder jobs */

  private chunkStep(row: HomelandRow): ChunkStep | null {
    return this.cfg.chunks.find((c) => c.n === row.open.length + 1) ?? null;
  }
  /** The Lighting project's level (0 = no lamps), kept in the furniture table under its own key. */
  lightLevel(account: string): number { return this.d.gs.furnitureLevel(account, LIGHT_KEY); }
  private lightStep(row: HomelandRow): LightStep | null {
    const lvl = this.lightLevel(row.account);
    return (this.cfg.lighting ?? []).find((s) => s.level === lvl + 1) ?? null;
  }
  private thStep(row: HomelandRow): TownhallStep | null {
    return this.cfg.townhall.find((s) => s.level === row.th + 1) ?? null;
  }

  /** Checks a build request and returns what it costs; throws the 409 the player sees. Pure: charges nothing. */
  /** 'rumah-c:kasur' -> its parts; the item must be an own key of some furniture config (400 otherwise, 'constructor' included). */
  private furnParts(target: string): { lot: string; item: string } {
    const parts = String(target).split(':');
    const items = Object.values(this.cfg.buildings).flatMap((d) => Object.keys(d.furniture ?? {}));
    if (parts.length !== 2 || !items.includes(parts[1])) throw new HttpError(400, 'Unknown furniture.');
    return { lot: parts[0], item: parts[1] };
  }

  private plan(row: HomelandRow, kind: string, target: string, payer = row.account): { cost: Cost; secs: number; label: string; job: string } {
    const gs = this.d.gs, account = row.account;
    const furn = kind === 'furniture' ? this.furnParts(target) : null; // names are checked before anything else
    const jobs = gs.homelandJobs(account);
    if (jobs.length >= this.builderSlots(account)) throw new HttpError(409, 'The builder is busy.');
    if (!this.pickWorker(account)) throw new HttpError(409, 'All builders are sick. Wait until they recover.');
    let plan: { cost: Cost; secs: number; label: string; job: string };
    const same = (job: string) => { if (jobs.some((j) => j.target === job)) throw new HttpError(409, 'Already under construction.'); return job; };
    if (kind === 'th') {
      const step = this.thStep(row);
      if (!step) throw new HttpError(409, 'The Town Hall is already at the highest level.');
      plan = { cost: step.cost, secs: step.secs, label: `Town Hall level ${step.level}`, job: same(target) };
    } else if (kind === 'chunk') {
      const step = this.chunkStep(row);
      if (!(target in NEIGHBOURS)) throw new HttpError(409, 'That chunk is not next to your territory.');
      if (target === 'c' || row.open.includes(target) || !step) throw new HttpError(409, 'Already built.');
      const mine = new Set(['c', ...row.open]);
      if (!NEIGHBOURS[target].some((n) => mine.has(n))) throw new HttpError(409, 'That chunk is not next to your territory.');
      if (row.th < step.th) throw new HttpError(409, `Town Hall needs level ${step.th}.`);
      plan = { cost: step.cost, secs: step.secs, label: 'New region', job: same(target) };
    } else if (kind === 'light') {
      const step = this.lightStep(row);
      if (!step) throw new HttpError(409, 'The street lights are already at the highest level.');
      if (row.th < step.th) throw new HttpError(409, `Town Hall needs level ${step.th}.`);
      plan = { cost: step.cost, secs: step.secs, label: step.name, job: same(LIGHT_KEY) };
    } else if (kind === 'build') {
      const lot = this.map(row).layout.lots.find((l) => l.id === target);
      const def = lot && this.cfg.buildings[lot.kind];
      if (!lot || !def) throw new HttpError(409, 'That lot does not exist.');
      if (gs.homelandBuildings(account).some((b) => b.lot === target)) throw new HttpError(409, 'Already built.');
      if (row.th < def.th) throw new HttpError(409, `Town Hall needs level ${def.th}.`);
      if (def.needsChunk && !row.open.includes(lot.chunk) && lot.chunk !== 'c') throw new HttpError(409, 'That region isn\'t open yet.');
      plan = { cost: def.cost, secs: def.secs, label: def.name, job: same(target) };
    } else if (furn) {
      const b = gs.homelandBuildings(account).find((x) => x.lot === furn.lot);
      const hdef = b && Object.hasOwn(this.cfg.buildings, b.kind) ? this.cfg.buildings[b.kind] : undefined;
      if (!b || !hdef?.furniture) throw new HttpError(409, 'Build the Workers\' House first.');
      if (!Object.hasOwn(hdef.furniture, furn.item)) throw new HttpError(400, 'Unknown furniture.');
      const fd = hdef.furniture[furn.item], lvl = gs.furnitureLevel(account, target);
      if (lvl >= fd.max || !fd.levels[lvl]) throw new HttpError(409, `${fd.name} is already at the highest level.`);
      const label = fd.names ? fd.names[lvl] ?? fd.name : `${fd.name} ke-${lvl + 2}`;
      plan = { cost: fd.levels[lvl].cost, secs: fd.levels[lvl].secs, label, job: same(target) };
    } else if (kind === 'upgrade') {
      const lot = this.map(row).layout.lots.find((l) => l.id === String(target));
      const ldef = lot && Object.hasOwn(this.cfg.buildings, lot.kind) ? this.cfg.buildings[lot.kind] : undefined;
      if (!lot || !ldef?.upgrade) throw new HttpError(409, 'That building does not level up.');
      const h = this.leveled(account, lot.id);
      if (!h) throw new HttpError(409, `Build the ${ldef.name} first.`);
      const step = h.def.upgrade?.[h.level - 1];
      if (h.level >= (h.def.maxLevel ?? 1) || !step) throw new HttpError(409, `The ${h.def.name} is already at the highest level.`);
      plan = { cost: step.cost, secs: step.secs, label: `${h.def.name} level ${h.level + 1}`, job: same(`${h.lot}:up`) };
    } else throw new HttpError(400, 'Unknown building type.');
    for (const [t, n] of Object.entries(plan.cost)) {
      const have = gs.balance(payer, t);
      if (have < n) throw new HttpError(409, `Not enough ${this.name(t)} (have ${have}, need ${n}).`);
    }
    return plan;
  }

  /** The free, not-sick contractor with the lowest fatigue (null when none). */
  private pickWorker(account: string): WorkerRow | null {
    const busy = new Set(this.d.gs.homelandJobs(account).map((j) => j.worker));
    const free = this.contractorSlots(account).filter((s) => !busy.has(s)).map((s) => this.workerOf(account, s)).filter((w) => !w.sick_until);
    free.sort((a, b) => a.fatigue - b.fatigue || a.slot - b.slot);
    return free[0] ?? null;
  }

  start(account: string, kind: 'th' | 'chunk' | 'light' | 'build' | 'furniture' | 'upgrade', target: string, day: number, payer = account): { toast: string; tags: string[]; ends_at: number } {
    this.settle(account);
    const row = this.ensure(account);
    const plan = this.plan(row, kind, String(target), payer);
    const gs = this.d.gs;
    const ref = `${homeWorld(row.id)}:${kind}:${target}`;
    for (const [t, n] of Object.entries(plan.cost)) {
      gs.add(day, payer, t, -n, 'build', ref);
      if (t === 'coin') gs.add(day, this.d.town, 'coin', n, 'build', ref);
    }
    const w = this.pickWorker(account)!;
    const secs = Math.ceil(plan.secs * (1 + this.cfg.fatigue.slowdownAt100 * w.fatigue / 100) / this.motivationFactor(account, w.slot) - 1e-9);
    const ends_at = this.now() + secs * 1000;
    gs.addHomelandJob(account, plan.job, kind, ends_at, w.slot, plan.secs, this.now());
    return { toast: payer === account ? `${plan.label}: the builder starts working.` : `${plan.label}: the builder starts working (paid by you).`, tags: Object.keys(plan.cost), ends_at };
  }

  /** A helper's energy shortens a running job (never below half of it): no ledger rows, the cost is energy only. */
  assist(owner: string, target: string, spend: (cost: number) => void): { toast: string; tags: string[]; ends_at: number } {
    this.settle(owner);
    const gs = this.d.gs, co = this.d.econ.coop;
    const j = gs.homelandJobs(owner).find((x) => x.target === String(target));
    if (!j) throw new HttpError(409, 'Nothing is being built there.');
    const span = j.started_at ? j.ends_at - j.started_at + j.assisted : j.base_secs * 1000;
    const cut = Math.min(co.assistSecs * 1000, Math.floor(span * co.assistMaxShare) - j.assisted, j.ends_at - this.now());
    if (cut <= 0) throw new HttpError(409, 'This job can\'t go any faster.');
    spend(co.assistEnergy); // throws when short; nothing has changed yet
    gs.assistJob(owner, j.target, cut);
    return { toast: `You helped the builder (${Math.round(cut / 1000)} s faster).`, tags: [], ends_at: j.ends_at - cut };
  }

  /* ------------------------------------------------------------ view */

  private houseView(account: string, lot: string): HomelandView['houses'][number] {
    const fd = this.houseDef().furniture!, kasur = this.furnLevel(account, lot, 'kasur'), hib = this.furnLevel(account, lot, 'hiburan');
    return {
      lot, beds: 1 + kasur, used: this.d.gs.homelandBots(account).filter((b) => b.house === lot).length,
      kasur, kasurMax: fd.kasur.max, hiburan: hib, hiburanMax: fd.hiburan.max, hiburanName: hib > 0 ? fd.hiburan.names?.[hib - 1] ?? null : null,
      motivation: this.houseMotivation(account, lot),
      nextKasur: kasur < fd.kasur.max && fd.kasur.levels[kasur] ? fd.kasur.levels[kasur] : null,
      nextHiburan: hib < fd.hiburan.max && fd.hiburan.levels[hib] ? { ...fd.hiburan.levels[hib], name: fd.hiburan.names?.[hib] ?? null } : null,
    };
  }

  view(account: string, viewer = account): HomelandView {
    this.settle(account);
    const row = this.ensure(account);
    const gs = this.d.gs;
    const jobs = gs.homelandJobs(account);
    const built = gs.homelandBuildings(account);
    const m = this.map(row);
    const buildings: Record<string, BuildingOption> = {};
    for (const [kind, def] of Object.entries(this.cfg.buildings)) {
      const lot = m.layout.lots.find((l) => l.kind === kind)?.id ?? null;
      let why: string | null = null;
      if (!lot) why = 'Lot not available.';
      else { try { this.plan(row, 'build', lot, viewer); } catch (e) { why = (e as Error).message; } }
      buildings[kind] = { ...def, lot, can: why === null, why };
    }
    return {
      id: row.id, world: homeWorld(row.id), seed: row.seed, gen: row.gen, th: row.th, open: row.open,
      built: built.map((b) => {
        const def = this.cfg.buildings[b.kind];
        return { lot: b.lot, kind: b.kind, stored: def ? this.storedOf(account, def, b.last_collect) : 0, capacity: def?.produces ? this.capOf(account, def) : def?.capacity ?? 0 };
      }),
      jobs: jobs.map((j) => ({ target: j.target, kind: j.kind, ends_at: j.ends_at })),
      builders: { total: this.builderSlots(account), busy: jobs.length },
      light: this.lightLevel(account),
      next: { th: this.thStep(row), chunk: this.chunkStep(row), light: this.lightStep(row), buildings },
      bots: this.bots(account),
      workers: this.contractorSlots(account).map((slot) => {
        const w = this.workerOf(account, slot), busy = jobs.some((j) => j.worker === slot);
        return { slot, name: slot === 0 ? 'Town Hall Builder' : `Builder ${slot}`, fatigue: Math.round(w.fatigue * 10) / 10, busy, sick_until: w.sick_until, motivation: this.motivationOf(account, slot), cosmetic: this.d.gs.cosmeticsOf(account)[slot] ?? null };
      }),
      cosmetics: this.cfg.cosmetics ?? {},
      houses: this.houseLots(account).map((lot) => this.houseView(account, lot)),
      beds: this.bedInfo(account),
      storehouse: (() => {
        const h = this.storehouse(account); if (!h) return null;
        const st = h.def.upgrade?.[h.level - 1], up = h.level < (h.def.maxLevel ?? 1) && st;
        return { lot: h.lot, level: h.level, maxLevel: h.def.maxLevel ?? 1, bonus: h.def.storeBonus![h.level - 1] ?? 0, nextBonus: up ? h.def.storeBonus![h.level] ?? null : null, next: up ? { cost: st.cost, secs: st.secs } : null };
      })(),
      hospital: (() => { const h = this.hospital(account); if (!h) return null; const st = h.def.upgrade?.[h.level - 1]; return { lot: h.lot, level: h.level, maxLevel: h.def.maxLevel ?? 1, healGameHours: h.def.healGameHours![h.level - 1], next: h.level < (h.def.maxLevel ?? 1) && st ? { cost: st.cost, secs: st.secs } : null }; })(),
      restoran: this.restoranLot(account) ? { pantry: this.pantryOf(account), pantryMax: this.cfg.restoran.pantryMax, nextServeAt: (gs.pantryOf(account)?.tick_at ?? this.now()) + Math.round(this.msPerHour() * Math.min(1, this.serveInterval(account))) } : null,
      tilled: gs.tilledOf(account),
      forage: (() => { const f = this.forageStored(account); return f ? { stored: f.stored, capacity: f.capacity } : null; })(),
      cook: (() => { const r = this.cookRecipe(account); if (!r) return null; const why = this.cookWhy(account, r, 1); return { recipe: r, can: why === null, why }; })(),
      hire: Object.fromEntries(Object.entries(this.cfg.bots ?? {}).map(([job, d]) => {
        const why = this.hireWhy(account, row.th, job);
        return [job, { name: d.name, price: d.price, rarity: d.rarity, max: d.max, have: gs.homelandBots(account).filter((b) => b.job === job).length, th: d.th ?? (job === 'builder' ? 1 : 2), can: why === null, why }];
      })),
      guests: gs.homelandInviteRoles(row.id).map((g) => ({ account: g.account, name: this.d.players?.nameOf(g.account) ?? g.account, tag: this.d.players?.tagOf(g.account) ?? '', role: roleOf(g.role) })),
      party_role: row.party_role ?? this.d.econ.coop.partyRoleDefault,
    };
  }

  /** What a guest may see of someone's Homeland: no hire list, no cosmetics, guests as a count; build checks are against the viewer's own bag. */
  guestView(owner: string, viewer: string) {
    const { hire: _h, cosmetics: _c, guests, ...rest } = this.view(owner, viewer);
    return { ...rest, guests: { count: guests.length } };
  }

  /* ------------------------------------------------------------ guests */

  /** The role a non-owner gets in this Homeland, or null: the better of the invite role and the party role. */
  private guestRole(account: string, row: HomelandRow): { role: Role; via: 'invite' | 'party' } | null {
    let best: { role: Role; via: 'invite' | 'party' } | null = null;
    const inv = this.d.gs.homelandInviteRoles(row.id).find((r) => r.account === account);
    if (inv) best = { role: roleOf(inv.role), via: 'invite' };
    const pr = row.party_role ?? this.d.econ.coop.partyRoleDefault;
    if (pr !== 'none' && this.d.party?.same(account, row.account)) {
      const role = roleOf(pr);
      if (!best || RANK[role] > RANK[best.role]) best = { role, via: 'party' };
    }
    return best;
  }

  access(account: string, id: number): { row: HomelandRow; owner: boolean; role: Role } {
    const row = this.byId(id);
    if (!row) throw new HttpError(404, 'That world does not exist.');
    if (row.account === account) return { row, owner: true, role: 'owner' };
    const g = this.guestRole(account, row);
    if (!g) throw new HttpError(409, 'You are not invited to this world.');
    return { row, owner: false, role: g.role };
  }

  /** Only the owner edits the list; each entry is an account id of a registered player or a display name. */
  setInvites(account: string, accounts: string[]): string[] {
    const row = this.ensure(account);
    const list: string[] = [], unknown: string[] = [];
    for (const raw of accounts.map((a) => String(a).trim()).filter(Boolean)) {
      let acct: string | null = raw;
      if (this.d.players) {
        const m = /^(.+)#(\d{5})$/.exec(raw);
        if (m) acct = this.d.players.accountByNameTag(m[1].trim(), m[2]);
        else if (this.d.players.isPlayer(raw)) acct = raw;
        else throw new HttpError(400, 'Write the player\'s name#tag (example: Ann#12345).');
      }
      if (!acct) unknown.push(raw.slice(0, 30)); else if (acct !== account && !list.includes(acct)) list.push(acct);
    }
    if (unknown.length) throw new HttpError(400, `Player not found: ${unknown.join(', ')}. Write the player name exactly as in the game.`);
    list.splice(MAX_INVITES);
    this.d.gs.setHomelandInvites(row.id, list);
    return list;
  }

  /** Owner only: sets one invited guest's role (`who` = account or name#tag on the list) or the party's role (`who` = 'party', also 'none'). */
  setRole(account: string, who: string, role: string): string {
    const row = this.ensure(account);
    if (who === 'party') {
      if (role !== 'none' && !SETTABLE.includes(role)) throw new HttpError(400, 'Unknown role.');
      this.d.gs.setHomelandPartyRole(account, role);
      return role;
    }
    if (!SETTABLE.includes(role)) throw new HttpError(400, 'Unknown role.');
    let acct: string | null = who;
    const m = /^(.+)#(\d{5})$/.exec(who);
    if (m && this.d.players) acct = this.d.players.accountByNameTag(m[1].trim(), m[2]);
    if (!acct || !this.d.gs.homelandInviteRoles(row.id).some((g) => g.account === acct)) throw new HttpError(404, 'That player is not on your invite list.');
    this.d.gs.db.prepare('UPDATE homeland_invites SET role = ? WHERE id = ? AND account = ?').run(role, row.id, acct);
    return role;
  }

  /** Homelands this account may visit as a guest: on the owner's invite list, or the owner's party (unless the owner shut it out). */
  invitedTo(account: string): Array<{ id: number; world: string; owner_name: string; owner_tag: string; role: Role; via: 'invite' | 'party' }> {
    const rows = new Map<number, HomelandRow>();
    for (const r of this.d.gs.homelandsInvitedTo(account)) rows.set(r.id, r);
    for (const m of this.d.party?.mates(account) ?? []) { const r = this.d.gs.homelandOf(m); if (r) rows.set(r.id, r); }
    const out: Array<{ id: number; world: string; owner_name: string; owner_tag: string; role: Role; via: 'invite' | 'party' }> = [];
    for (const r of [...rows.values()].sort((a, b) => a.id - b.id)) {
      const g = this.guestRole(account, r);
      if (g) out.push({ id: r.id, world: homeWorld(r.id), owner_name: this.d.players?.nameOf(r.account) ?? r.account, owner_tag: this.d.players?.tagOf(r.account) ?? '', role: g.role, via: g.via });
    }
    return out;
  }
}
