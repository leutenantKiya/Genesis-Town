// The shared village map on the server. The same generator file the browser runs (client/js/world/village.js) builds
// the map from the world seed, so the server knows which tile is water, rock or tree and which areas are open.
// Gathering is checked against it: the tile must really be that kind, inside an open area. (Checking the player's
// own position is planned for M4.)
import '../../../client/js/world/village.js';
import { HttpError } from '../auth.ts';

export interface Chunk { id: string; name: string; cx: number; cy: number; biome: string; open: boolean; project: string | null }
export interface Project { chunk: string; name: string; need: Record<string, number> }
export interface Layout {
  version: number; seed: number; w: number; h: number; chunk: number; tiles: string[]; unlocked: string[];
  chunks: Chunk[]; projects: Record<string, Project>;
  buildings: Array<{ kind: string; name: string | null; x: number; y: number; w: number; h: number; dx: number; dy: number; open: boolean; own?: boolean }>;
  market: { stalls: Array<{ x: number; y: number }> };
  farm: { plots: Array<{ x: number; y: number }>; gate: { x: number; y: number } };
  spawn: { x: number; y: number };
}
export interface Pos { x: number; y: number }

// Tiles nobody stands on (as in the generator; street lamps are added by the client and are not known here).
const SOLID = new Set(['tree', 'fence', 'sign', 'mailbox', 'rock', 'water', 'bush', 'barrel', 'crate', 'stall', 'lamp']);
// Walking speed: one tile per 0.15 s in the client (MOVE_T), so at most ~6.7 tiles per second.
const TILES_PER_SEC = 8, SLACK = 6;
const dist = (a: Pos, b: Pos) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
interface VillageApi { generate(seed: number, unlocked?: string[]): Layout; chunkOf(L: Layout, x: number, y: number): Chunk; PROJECTS: Record<string, Project> }
export const Village = (globalThis as unknown as { GTVillage: VillageApi }).GTVillage;

export class WorldMap {
  seed: number;
  layout: Layout;
  constructor(seed: number, unlocked: string[] = []) {
    this.seed = seed >>> 0;
    this.layout = Village.generate(this.seed, unlocked);
  }
  get unlocked() { return this.layout.unlocked; }
  tileAt(x: number, y: number): string | null {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= this.layout.w || y >= this.layout.h) return null;
    return this.layout.tiles[y * this.layout.w + x];
  }
  chunkAt(x: number, y: number): Chunk { return Village.chunkOf(this.layout, x, y); }
  /** Opens a chunk (a finished town project) and regenerates the map with it open. */
  unlock(chunkId: string) {
    if (this.layout.unlocked.includes(chunkId)) return false;
    this.layout = Village.generate(this.seed, [...this.layout.unlocked, chunkId]);
    return true;
  }
  walkable(x: number, y: number): boolean {
    const t = this.tileAt(x, y);
    if (t === null || SOLID.has(t) || !this.chunkAt(x, y).open) return false;
    return !this.layout.buildings.some((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h);
  }
  nearStall(p: Pos, d = 3) { return this.layout.market.stalls.some((s) => dist(p, { x: s.x, y: s.y + 1 }) <= d || dist(p, s) <= d); }
  nearPlot(p: Pos, idx: number) { const q = this.layout.farm.plots[idx]; return !!q && dist(p, q) <= 1; }
  atOwnHouse(p: Pos) { const h = this.layout.buildings.find((b) => b.own); return !!h && dist(p, { x: h.dx, y: h.dy + 1 }) <= 1; }
  checkGather(tile: string, x: number, y: number) {
    const t = this.tileAt(x, y);
    if (t === null) throw new HttpError(400, 'bad tile');
    if (t !== tile) throw new HttpError(409, 'Tidak ada yang bisa dikumpulkan di sini.');
    const c = this.chunkAt(x, y);
    if (!c.open) throw new HttpError(409, `${c.name} belum dibuka.`);
  }
  /** What the client needs to build the same map. */
  view() { return { seed: this.seed, unlocked: this.layout.unlocked, version: this.layout.version, chunks: this.layout.chunks, projects: this.layout.projects }; }
}

/**
 * Where each player stands, as reported by their own (signed) client: with every action and every state poll.
 * Indoors the client reports the tile in front of the building's door. A report must be a walkable tile in an open
 * area, and the move since the last report must fit the walking speed (the spawn is always allowed: that is where a
 * player appears after loading the page). This stops gathering, trading and farming from across the map; a modified
 * client can still walk anywhere a player could walk.
 */
export class Positions {
  last = new Map<string, Pos & { t: number }>();
  map: WorldMap;
  constructor(map: WorldMap) { this.map = map; }
  report(account: string, raw: unknown, now: number): Pos {
    const r = raw as { x?: unknown; y?: unknown } | null;
    const p = { x: Number(r?.x), y: Number(r?.y) };
    if (!r || !Number.isInteger(p.x) || !Number.isInteger(p.y)) throw new HttpError(400, 'posisi pemain tidak ada');
    if (!this.map.walkable(p.x, p.y)) throw new HttpError(409, 'Posisi tidak valid.');
    const prev = this.last.get(account);
    const sp = this.map.layout.spawn;
    if (prev && !(p.x === sp.x && p.y === sp.y)) {
      const allowed = ((now - prev.t) / 1000) * TILES_PER_SEC + SLACK;
      if (dist(prev, p) > allowed) throw new HttpError(409, 'Posisi melompat terlalu jauh. Muat ulang halaman.');
    }
    this.last.set(account, { ...p, t: now });
    return p;
  }
}
