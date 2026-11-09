// Homelands: every player owns one private world (a Town Hall in the middle of a 3 x 3 grid of chunks). This module holds
// what is not in the map generator: the player's progress (Town Hall level, opened chunks, buildings), the builder jobs
// that run on server timers (`ends_at`), lazy production of the buildings, and the guest list.
//
// Everything is off-chain. Costs and gains are ordinary ledger rows (GameStore.add) that settle with the day:
// item costs are burned (negative rows, kind 'build'), coin costs move to the town treasury, gains go through the
// daily caps the caller passes in (World.checkGain). Timers are absolute timestamps; a job that ended while nobody
// looked (or the server was down) is applied the next time the Homeland is read, exactly once.
import type { BuildingDef, ChunkStep, Cost, Econ, ForageDef, TownhallStep } from './econ.ts';
import type { GameStore, HomelandRow, WorkerRow } from './gamestore.ts';
import { HttpError } from '../auth.ts';
import { gameTime } from '../../../economy/time.ts';
import type { Clock } from './clock.ts';
import { Homeland, HomelandMap, type HomelandProgress } from './worldmap.ts';

export interface PlayerDir { nameOf(account: string): string | null; tagOf(account: string): string; accountByNameTag(name: string, tag: string): string | null; isPlayer(account: string): boolean }
export interface HomelandDeps { econ: Econ; gs: GameStore; worldSeed: number; now: () => number; players?: PlayerDir; town: string; clock?: Clock }

export interface BuildingOption extends BuildingDef { lot: string | null; can: boolean; why: string | null }
export interface HomelandView {
  id: number; world: string; seed: number; gen: number; th: number; open: string[];
  built: Array<{ lot: string; kind: string; stored: number; capacity: number }>;
  jobs: Array<{ target: string; kind: string; ends_at: number }>;
  builders: { total: number; busy: number };
  next: { th: TownhallStep | null; chunk: ChunkStep | null; buildings: Record<string, BuildingOption> };
  guests: Array<{ account: string; name: string; tag: string }>;
  bots: Array<{ id: number; job: string; name: string }>;
  workers: Array<{ slot: number; name: string; fatigue: number; busy: boolean; sick_until: number }>;
  restoran: { pantry: number; pantryMax: number; nextServeAt: number } | null;
  forage: { stored: Record<string, number>; capacity: number } | null;
  cook: { recipe: { inputs: Record<string, number>; output: string }; can: boolean; why: string | null } | null;
  hire: Record<string, { name: string; price: number; rarity: string; max: number; have: number; th: number; can: boolean; why: string | null }>;
}
export interface BotEffects { builders: number; farmGrowFactor: number; fishRate: number; woodBonus: number; chef: boolean; forage: ForageDef | null }
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
    const chef = this.effects(account).chef;
    const interval = rc.serveEveryGameHours / (chef ? rc.chefServeFactor : 1); // game hours between servings
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
        else gs.addHomelandBuilding(account, j.target, j.target.split('-')[0], j.ends_at);
        const w = workers.get(j.worker);
        if (w) {
          w.fatigue = Math.min(100, w.fatigue + fc.perJobMinute * (j.base_secs / 60));
          if (w.fatigue >= fc.collapseAt && !w.sick_until) w.sick_until = j.ends_at + fc.sickGameHours * hourMs; // C2 shortens this with a hospital
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
  /** The motivation hook for C2 (beds and entertainment). */
  private motivationFactor(_account: string, _slot: number): number { return 1.0; }

  private progress(row: HomelandRow): HomelandProgress {
    return { open: row.open, th: row.th, built: this.d.gs.homelandBuildings(row.account).map((b) => ({ kind: b.kind, lot: b.lot })) };
  }

  /** The map as it is now (progress decides what is open and built; cached per progress key). */
  map(row: HomelandRow): HomelandMap {
    const prog = this.progress(row);
    const key = `${row.id}:${row.th}:${row.open.join(',')}:${prog.built.map((b) => b.lot).sort().join(',')}`;
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
    return Math.min(def.capacity ?? 0, Math.floor(this.rateOf(account, def) * gh + 1e-9));
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
    if (!f || !fs) throw new HttpError(409, 'Kamu belum punya Pemburu.');
    const got = Object.entries(fs.stored).filter(([, n]) => n > 0);
    if (!got.length) throw new HttpError(409, 'Pemburu belum membawa apa-apa.');
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
    return lack ? `Bahan kurang (perlu ${Object.entries(r.inputs).map(([t, n]) => `${n * qty} ${this.name(t)}`).join(', ')}).` : null;
  }

  private pantryOf(account: string): number { return this.d.gs.pantryOf(account)?.pantry ?? 0; }
  private qtyOf(qty: unknown, max: number): number {
    const q = Number(qty);
    if (!Number.isInteger(q) || q < 1 || q > max) throw new HttpError(400, `Jumlah harus 1 sampai ${max}.`);
    return q;
  }
  private pantrySpace(account: string, q: number) {
    const max = this.cfg.restoran.pantryMax, have = this.pantryOf(account);
    if (have + q > max) throw new HttpError(409, `Lemari makanan penuh (${have} dari ${max}).`);
  }
  private setPantry(account: string, n: number) { this.d.gs.savePantry(account, n, this.d.gs.pantryOf(account)?.tick_at ?? this.now()); }

  /** Cooks `qty` (1-10) of the Restoran's recipe from the bag into the Restoran's pantry (not the bag). */
  cook(account: string, qty: unknown, day: number): { toast: string; tags: string[] } {
    this.settle(account);
    const r = this.cookRecipe(account);
    if (!r) throw new HttpError(409, 'Bangun Restoran dulu.');
    const q = this.qtyOf(qty, 10);
    const why = this.cookWhy(account, r, q);
    if (why) throw new HttpError(409, why);
    this.pantrySpace(account, q);
    const gs = this.d.gs, world = homeWorld(this.ensure(account).id);
    for (const [t, n] of Object.entries(r.inputs)) gs.add(day, account, t, -n * q, 'cook', `${world}:cook`);
    this.setPantry(account, this.pantryOf(account) + q);
    return { toast: `${q} ${this.name(r.output)} masuk lemari Restoran (${this.pantryOf(account)} dari ${this.cfg.restoran.pantryMax}).`, tags: Object.keys(r.inputs) };
  }

  /** Moves bread or meal from the bag into the pantry. */
  stock(account: string, token: string, qty: unknown, day: number): { toast: string; tags: string[] } {
    this.settle(account);
    if (!this.restoranLot(account)) throw new HttpError(409, 'Bangun Restoran dulu.');
    if (!['bread', 'meal'].includes(token)) throw new HttpError(400, 'Hanya roti dan ikan bakar yang bisa ditaruh.');
    const q = this.qtyOf(qty, this.cfg.restoran.pantryMax);
    const have = this.d.gs.balance(account, token);
    if (have < q) throw new HttpError(409, `${this.name(token)} kurang (punya ${have}, perlu ${q}).`);
    this.pantrySpace(account, q);
    this.d.gs.add(day, account, token, -q, 'stock', `${homeWorld(this.ensure(account).id)}:pantry`);
    this.setPantry(account, this.pantryOf(account) + q);
    return { toast: `${q} ${this.name(token)} ditaruh di lemari Restoran.`, tags: [token] };
  }

  /* ------------------------------------------------------------ worker bots */

  /** A bot definition by job name: own config keys only (never 'constructor', '__proto__' and the like). */
  private botDef(job: string) {
    const all = this.cfg.bots ?? {};
    return Object.hasOwn(all, job) ? all[job] : undefined;
  }

  bots(account: string): Array<{ id: number; job: string; name: string }> {
    return this.d.gs.homelandBots(account).filter((b) => this.botDef(b.job)).map((b) => ({ id: b.id, job: b.job, name: this.botDef(b.job)!.name }));
  }

  /** What the owner's bots add up to. Factors multiply per bot, bonuses add. */
  effects(account: string): BotEffects {
    const e: BotEffects = { builders: 0, farmGrowFactor: 1, fishRate: 1, woodBonus: 0, chef: false, forage: null };
    for (const b of this.d.gs.homelandBots(account)) {
      const x = this.botDef(b.job)?.effect;
      if (!x) continue;
      e.builders += x.builders ?? 0;
      e.woodBonus += x.woodBonus ?? 0;
      if (x.farmGrowFactor) e.farmGrowFactor *= x.farmGrowFactor;
      if (x.fishRate) e.fishRate *= x.fishRate;
      if (x.chef) e.chef = true;
      if (x.forage) e.forage = x.forage;
    }
    return e;
  }
  private builderSlots(account: string) { return this.cfg.builders + this.effects(account).builders; }

  /** Why this job cannot be hired right now, or null. Pure. */
  private hireWhy(account: string, th: number, job: string): string | null {
    const def = this.botDef(job);
    if (!def) return 'Pekerja tidak dikenal.';
    const have = this.d.gs.homelandBots(account).filter((b) => b.job === job).length;
    if (have >= def.max) return `Pekerja ${def.name} sudah penuh (maks ${def.max}).`;
    const need = def.th ?? (job === 'builder' ? 1 : 2);
    if (th < need) return `Balai Kota perlu level ${need}.`;
    const coin = this.d.gs.balance(account, 'coin');
    if (coin < def.price) return `Koin kurang (punya ${coin}, perlu ${def.price}).`;
    return null;
  }

  hire(account: string, job: string, day: number): { toast: string; tags: string[] } {
    this.settle(account);
    const row = this.ensure(account);
    const def = this.botDef(String(job));
    if (!def) throw new HttpError(400, 'Pekerja tidak dikenal.');
    const why = this.hireWhy(account, row.th, job);
    if (why) throw new HttpError(409, why);
    const gs = this.d.gs;
    const ref = `${homeWorld(row.id)}:hire:${job}`;
    gs.add(day, account, 'coin', -def.price, 'hire', ref);
    gs.add(day, this.d.town, 'coin', def.price, 'hire', ref);
    gs.addHomelandBot(account, job, this.now());
    if (def.effect.forage) gs.setForage(account, this.now(), 0);
    return { toast: `${def.name} dipekerjakan (-${def.price} koin).`, tags: ['coin'] };
  }

  collect(account: string, lot: string, day: number, checkGain: (a: string, t: string, n: number) => void): { toast: string; tags: string[]; gained: Record<string, number> } {
    this.settle(account);
    const gs = this.d.gs;
    const b = gs.homelandBuildings(account).find((x) => x.lot === lot);
    const def = b && this.cfg.buildings[b.kind];
    if (!b || !def) throw new HttpError(409, 'Belum ada bangunan di sini.');
    if (!def.produces) throw new HttpError(409, `${def.name} tidak menghasilkan apa-apa sendiri.`);
    const stored = this.storedOf(account, def, b.last_collect);
    if (stored <= 0) throw new HttpError(409, 'Belum ada hasil.');
    checkGain(account, def.produces, stored); // throws on a full daily cap; nothing has changed yet
    const world = homeWorld(gs.homelandOf(account)!.id);
    gs.add(day, account, def.produces, stored, 'collect', `${world}:${lot}`);
    const full = stored >= (def.capacity ?? 0);
    gs.setHomelandCollect(account, lot, full ? this.now() : Math.round(b.last_collect + (stored / this.rateOf(account, def)) * this.msPerHour()));
    return { toast: `+${stored} ${this.name(def.produces)}`, tags: [def.produces], gained: { [def.produces]: stored } };
  }

  /* ------------------------------------------------------------ builder jobs */

  private chunkStep(row: HomelandRow): ChunkStep | null {
    return this.cfg.chunks.find((c) => c.n === row.open.length + 1) ?? null;
  }
  private thStep(row: HomelandRow): TownhallStep | null {
    return this.cfg.townhall.find((s) => s.level === row.th + 1) ?? null;
  }

  /** Checks a build request and returns what it costs; throws the 409 the player sees. Pure: charges nothing. */
  private plan(row: HomelandRow, kind: string, target: string): { cost: Cost; secs: number; label: string } {
    const gs = this.d.gs, account = row.account;
    const jobs = gs.homelandJobs(account);
    if (jobs.length >= this.builderSlots(account)) throw new HttpError(409, 'Builder sedang bekerja.');
    if (!this.pickWorker(account)) throw new HttpError(409, 'Semua tukang sedang sakit. Tunggu sampai sembuh.');
    let plan: { cost: Cost; secs: number; label: string };
    if (kind === 'th') {
      const step = this.thStep(row);
      if (!step) throw new HttpError(409, 'Balai Kota sudah level tertinggi.');
      plan = { cost: step.cost, secs: step.secs, label: `Balai Kota level ${step.level}` };
    } else if (kind === 'chunk') {
      const step = this.chunkStep(row);
      if (!(target in NEIGHBOURS)) throw new HttpError(409, 'Chunk itu tidak bersebelahan dengan wilayahmu.');
      if (target === 'c' || row.open.includes(target) || !step) throw new HttpError(409, 'Sudah dibangun.');
      const mine = new Set(['c', ...row.open]);
      if (!NEIGHBOURS[target].some((n) => mine.has(n))) throw new HttpError(409, 'Chunk itu tidak bersebelahan dengan wilayahmu.');
      if (row.th < step.th) throw new HttpError(409, `Balai Kota perlu level ${step.th}.`);
      plan = { cost: step.cost, secs: step.secs, label: 'Wilayah baru' };
    } else if (kind === 'build') {
      const lot = this.map(row).layout.lots.find((l) => l.id === target);
      const def = lot && this.cfg.buildings[lot.kind];
      if (!lot || !def) throw new HttpError(409, 'Lahan itu tidak ada.');
      if (gs.homelandBuildings(account).some((b) => b.lot === target)) throw new HttpError(409, 'Sudah dibangun.');
      if (row.th < def.th) throw new HttpError(409, `Balai Kota perlu level ${def.th}.`);
      if (def.needsChunk && !row.open.includes(lot.chunk) && lot.chunk !== 'c') throw new HttpError(409, 'Wilayah itu belum dibuka.');
      plan = { cost: def.cost, secs: def.secs, label: def.name };
    } else throw new HttpError(400, 'Jenis bangunan tidak dikenal.');
    for (const [t, n] of Object.entries(plan.cost)) {
      const have = gs.balance(account, t);
      if (have < n) throw new HttpError(409, `${this.name(t)} kurang (punya ${have}, perlu ${n}).`);
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

  start(account: string, kind: 'th' | 'chunk' | 'build', target: string, day: number): { toast: string; tags: string[]; ends_at: number } {
    this.settle(account);
    const row = this.ensure(account);
    const plan = this.plan(row, kind, String(target));
    const gs = this.d.gs;
    const ref = `${homeWorld(row.id)}:${kind}:${target}`;
    for (const [t, n] of Object.entries(plan.cost)) {
      gs.add(day, account, t, -n, 'build', ref);
      if (t === 'coin') gs.add(day, this.d.town, 'coin', n, 'build', ref);
    }
    const w = this.pickWorker(account)!;
    const secs = Math.ceil(plan.secs * (1 + this.cfg.fatigue.slowdownAt100 * w.fatigue / 100) / this.motivationFactor(account, w.slot) - 1e-9);
    const ends_at = this.now() + secs * 1000;
    gs.addHomelandJob(account, String(target), kind, ends_at, w.slot, plan.secs, this.now());
    return { toast: `${plan.label}: pembangun mulai bekerja.`, tags: Object.keys(plan.cost), ends_at };
  }

  /* ------------------------------------------------------------ view */

  view(account: string): HomelandView {
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
      if (!lot) why = 'Lahan tidak tersedia.';
      else { try { this.plan(row, 'build', lot); } catch (e) { why = (e as Error).message; } }
      buildings[kind] = { ...def, lot, can: why === null, why };
    }
    return {
      id: row.id, world: homeWorld(row.id), seed: row.seed, gen: row.gen, th: row.th, open: row.open,
      built: built.map((b) => {
        const def = this.cfg.buildings[b.kind];
        return { lot: b.lot, kind: b.kind, stored: def ? this.storedOf(account, def, b.last_collect) : 0, capacity: def?.capacity ?? 0 };
      }),
      jobs: jobs.map((j) => ({ target: j.target, kind: j.kind, ends_at: j.ends_at })),
      builders: { total: this.builderSlots(account), busy: jobs.length },
      next: { th: this.thStep(row), chunk: this.chunkStep(row), buildings },
      bots: this.bots(account),
      workers: this.contractorSlots(account).map((slot) => {
        const w = this.workerOf(account, slot), busy = jobs.some((j) => j.worker === slot);
        return { slot, name: slot === 0 ? 'Tukang Balai Kota' : `Tukang ${slot}`, fatigue: Math.round(w.fatigue * 10) / 10, busy, sick_until: w.sick_until };
      }),
      restoran: this.restoranLot(account) ? { pantry: this.pantryOf(account), pantryMax: this.cfg.restoran.pantryMax, nextServeAt: (gs.pantryOf(account)?.tick_at ?? this.now()) + Math.round(this.msPerHour() * Math.min(1, this.cfg.restoran.serveEveryGameHours / (this.effects(account).chef ? this.cfg.restoran.chefServeFactor : 1))) } : null,
      forage: (() => { const f = this.forageStored(account); return f ? { stored: f.stored, capacity: f.capacity } : null; })(),
      cook: (() => { const r = this.cookRecipe(account); if (!r) return null; const why = this.cookWhy(account, r, 1); return { recipe: r, can: why === null, why }; })(),
      hire: Object.fromEntries(Object.entries(this.cfg.bots ?? {}).map(([job, d]) => {
        const why = this.hireWhy(account, row.th, job);
        return [job, { name: d.name, price: d.price, rarity: d.rarity, max: d.max, have: gs.homelandBots(account).filter((b) => b.job === job).length, th: d.th ?? (job === 'builder' ? 1 : 2), can: why === null, why }];
      })),
      guests: gs.homelandInvites(row.id).map((a) => ({ account: a, name: this.d.players?.nameOf(a) ?? a, tag: this.d.players?.tagOf(a) ?? '' })),
    };
  }

  /* ------------------------------------------------------------ guests */

  access(account: string, id: number): { row: HomelandRow; owner: boolean } {
    const row = this.byId(id);
    if (!row) throw new HttpError(404, 'Dunia itu tidak ada.');
    const owner = row.account === account;
    if (!owner && !this.d.gs.homelandInvites(id).includes(account)) throw new HttpError(409, 'Kamu tidak diundang ke dunia ini.');
    return { row, owner };
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
        else throw new HttpError(400, 'Tulis nama#tag pemain (contoh: Budi#12345).');
      }
      if (!acct) unknown.push(raw.slice(0, 30)); else if (acct !== account && !list.includes(acct)) list.push(acct);
    }
    if (unknown.length) throw new HttpError(400, `Pemain tidak ditemukan: ${unknown.join(', ')}. Tulis nama pemain persis seperti di permainan.`);
    list.splice(MAX_INVITES);
    this.d.gs.setHomelandInvites(row.id, list);
    return list;
  }

  invitedTo(account: string): Array<{ id: number; world: string; owner_name: string; owner_tag: string }> {
    return this.d.gs.homelandsInvitedTo(account).map((r) => ({ id: r.id, world: homeWorld(r.id), owner_name: this.d.players?.nameOf(r.account) ?? r.account, owner_tag: this.d.players?.tagOf(r.account) ?? '' }));
  }
}
