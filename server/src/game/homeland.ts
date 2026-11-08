// Homelands: every player owns one private world (a Town Hall in the middle of a 3 x 3 grid of chunks). This module holds
// what is not in the map generator: the player's progress (Town Hall level, opened chunks, buildings), the builder jobs
// that run on server timers (`ends_at`), lazy production of the buildings, and the guest list.
//
// Everything is off-chain. Costs and gains are ordinary ledger rows (GameStore.add) that settle with the day:
// item costs are burned (negative rows, kind 'build'), coin costs move to the town treasury, gains go through the
// daily caps the caller passes in (World.checkGain). Timers are absolute timestamps; a job that ended while nobody
// looked (or the server was down) is applied the next time the Homeland is read, exactly once.
import type { BuildingDef, ChunkStep, Cost, Econ, TownhallStep } from './econ.ts';
import type { GameStore, HomelandRow } from './gamestore.ts';
import { HttpError } from '../auth.ts';
import { Homeland, HomelandMap, type HomelandProgress } from './worldmap.ts';

export interface PlayerDir { nameOf(account: string): string | null; accountByName(name: string): string | null; isPlayer(account: string): boolean }
export interface HomelandDeps { econ: Econ; gs: GameStore; worldSeed: number; now: () => number; players?: PlayerDir; town: string }

export interface BuildingOption extends BuildingDef { lot: string | null; can: boolean; why: string | null }
export interface HomelandView {
  id: number; world: string; seed: number; gen: number; th: number; open: string[];
  built: Array<{ lot: string; kind: string; stored: number; capacity: number }>;
  jobs: Array<{ target: string; kind: string; ends_at: number }>;
  builders: { total: number; busy: number };
  next: { th: TownhallStep | null; chunk: ChunkStep | null; buildings: Record<string, BuildingOption> };
  guests: string[];
}
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

  /** Applies every job that ended: exactly once each (the delete decides who applies it). */
  settle(account: string): void {
    const gs = this.d.gs;
    const now = this.now();
    for (const j of gs.homelandJobs(account)) {
      if (j.ends_at > now) continue;
      if (!gs.deleteHomelandJob(account, j.target)) continue;
      const row = gs.homelandOf(account);
      if (!row) continue;
      if (j.kind === 'th') gs.setHomelandTh(account, row.th + 1);
      else if (j.kind === 'chunk') { if (!row.open.includes(j.target)) gs.setHomelandOpen(account, [...row.open, j.target]); }
      else gs.addHomelandBuilding(account, j.target, j.target.split('-')[0], j.ends_at);
    }
  }

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

  private storedOf(def: BuildingDef, lastCollect: number): number {
    const gh = Math.max(0, this.now() - lastCollect) / this.msPerHour();
    return Math.min(def.capacity, Math.floor(def.perGameHour * gh + 1e-9));
  }

  collect(account: string, lot: string, day: number, checkGain: (a: string, t: string, n: number) => void): { toast: string; tags: string[]; gained: Record<string, number> } {
    this.settle(account);
    const gs = this.d.gs;
    const b = gs.homelandBuildings(account).find((x) => x.lot === lot);
    const def = b && this.cfg.buildings[b.kind];
    if (!b || !def) throw new HttpError(409, 'Belum ada bangunan di sini.');
    const stored = this.storedOf(def, b.last_collect);
    if (stored <= 0) throw new HttpError(409, 'Belum ada hasil.');
    checkGain(account, def.produces, stored); // throws on a full daily cap; nothing has changed yet
    const world = homeWorld(gs.homelandOf(account)!.id);
    gs.add(day, account, def.produces, stored, 'collect', `${world}:${lot}`);
    const full = stored >= def.capacity;
    gs.setHomelandCollect(account, lot, full ? this.now() : Math.round(b.last_collect + (stored / def.perGameHour) * this.msPerHour()));
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
    if (jobs.length >= this.cfg.builders) throw new HttpError(409, 'Builder sedang bekerja.');
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
    const ends_at = this.now() + plan.secs * 1000;
    gs.addHomelandJob(account, String(target), kind, ends_at);
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
        return { lot: b.lot, kind: b.kind, stored: def ? this.storedOf(def, b.last_collect) : 0, capacity: def?.capacity ?? 0 };
      }),
      jobs: jobs.map((j) => ({ target: j.target, kind: j.kind, ends_at: j.ends_at })),
      builders: { total: this.cfg.builders, busy: jobs.length },
      next: { th: this.thStep(row), chunk: this.chunkStep(row), buildings },
      guests: gs.homelandInvites(row.id).map((a) => this.d.players?.nameOf(a) ?? a),
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
      const acct = this.d.players ? ((this.d.players.isPlayer(raw) ? raw : null) ?? this.d.players.accountByName(raw)) : raw;
      if (!acct) unknown.push(raw.slice(0, 30)); else if (acct !== account && !list.includes(acct)) list.push(acct);
    }
    if (unknown.length) throw new HttpError(400, `Pemain tidak ditemukan: ${unknown.join(', ')}. Tulis nama pemain persis seperti di permainan.`);
    list.splice(MAX_INVITES);
    this.d.gs.setHomelandInvites(row.id, list);
    return list;
  }

  invitedTo(account: string): Array<{ id: number; world: string; owner_name: string }> {
    return this.d.gs.homelandsInvitedTo(account).map((r) => ({ id: r.id, world: homeWorld(r.id), owner_name: this.d.players?.nameOf(r.account) ?? r.account }));
  }
}
