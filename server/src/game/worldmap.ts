// The shared village map on the server. The same generator file the browser runs (client/js/world/village.js) builds
// the map from the world seed, so the server knows which tile is water, rock or tree and which areas are open.
// Gathering is checked against it: the tile must really be that kind, inside an open area. (Checking the player's
// own position is planned for M4.)
import '../../../client/js/world/village.js';
import '../../../client/js/world/homeland.js';
import { HttpError } from '../auth.ts';

export interface Chunk { id: string; name: string; cx: number; cy: number; biome: string; open: boolean; project: string | null }
export interface Project { chunk: string; name: string; need: Record<string, number> }
export interface Layout {
  version: number; seed: number; w: number; h: number; chunk: number; tiles: string[]; unlocked: string[];
  chunks: Chunk[]; projects: Record<string, Project>;
  buildings: Array<{ kind: string; name: string | null; x: number; y: number; w: number; h: number; dx: number; dy: number; open: boolean; own?: boolean }>;
  market: { stalls: Array<{ x: number; y: number }> };
  farm: { plots: Array<{ x: number; y: number }>; gate: { x: number; y: number }; x0?: number; y0?: number; x1?: number; y1?: number };
  spawn: { x: number; y: number };
}
export interface Pos { x: number; y: number }

// Tiles nobody stands on (as in the generator; street lamps are added by the client and are not known here).
// void: the sky between Homeland islands; fountain, stage, carousel, table, lily: the public square's fun side (village v2)
const SOLID = new Set(['tree', 'fence', 'sign', 'mailbox', 'rock', 'water', 'bush', 'barrel', 'crate', 'stall', 'lamp', 'void', 'fountain', 'stage', 'carousel', 'table', 'lily']);
// Walking speed: one tile per 0.15 s in the client (MOVE_T), so at most ~6.7 tiles per second.
const TILES_PER_SEC = 8, SLACK = 6;
const dist = (a: Pos, b: Pos) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
export interface Weather { kind: string; label: string; wet: boolean }
export interface MonsterSpot { id: string; kind: string; x: number; y: number }
interface VillageApi {
  generate(seed: number, unlocked?: string[]): Layout; CHUNKS: Array<{ id: string }>; chunkOf(L: Layout, x: number, y: number): Chunk; PROJECTS: Record<string, Project>;
  landmarks(L: Layout): { board: Pos; gamble: Pos; mall: Pos };
  fishSpot(L: { w: number; h: number; seed: number; tiles: string[] }, x: number, y: number, bucket: number): boolean; fishBucket(totalHours: number): number;
  weather(seed: number, day: number, season: string): Weather; monstersAt(L: Layout, hour: number, counts?: Record<string, number>): MonsterSpot[];
}
export const Village = (globalThis as unknown as { GTVillage: VillageApi & { dockOf(L: Layout): Pos; ferryOf(L: Layout): { a: Pos; b: Pos; wa: Pos; wb: Pos } | null; boatWater(L: Layout, x: number, y: number): boolean } }).GTVillage;

/** A player's Homeland (client/js/world/homeland.js): the same generator the browser runs. */
export interface HomelandProgress { open: string[]; th: number; built: Array<{ kind: string; lot: string }>; gen?: number; light?: number }
export interface HomelandLot { id: string; kind: string; chunk: string; x: number; y: number; w: number; h: number; door: Pos }
export interface HomelandLayout extends Omit<Layout, 'projects'> { portal: Pos; lots: HomelandLot[] }
interface HomelandApi {
  VERSION: number; CHUNKS: string[];
  generate(seed: number, prog: HomelandProgress): HomelandLayout; chunkOf(L: HomelandLayout, x: number, y: number): Chunk;
  wild(L: HomelandLayout, x: number, y: number): string | null; monstersAt(L: HomelandLayout, hour: number, counts?: Record<string, number>): MonsterSpot[];
}
export const Homeland = (globalThis as unknown as { GTHomeland: HomelandApi }).GTHomeland;

/** What a world map offers to the game: the public village and Homelands answer the same questions. */
export interface GameMap {
  layout: { spawn: Pos };
  walkable(x: number, y: number): boolean;
  /** The tile type at x, y (water, grass, ...), null outside the map. */
  tileAt(x: number, y: number): string | null;
  nearStall(p: Pos, d?: number): boolean;
  nearPlot(p: Pos, idx: number): boolean;
  atOwnHouse(p: Pos): boolean;
  /** In front of a building with the player's Workbench: the house in the village; the Town Hall or Rumahmu in a Homeland. */
  atWorkbench(p: Pos): boolean;
  checkGather(tile: string, x: number, y: number): void;
  /** Is there a ripple (a fishing spot) on this water tile now? The previous time bucket counts too, so a spot does not vanish mid-cast. */
  fishSpot(x: number, y: number, totalHours: number): boolean;
  portal(): Pos;
}

/** The parts of a map the night monsters need: where they may appear, and where they roam each game hour. */
export interface MonsterMap {
  /** The monster kind living at (x, y) at night, or null where the ground is safe. */
  wild(x: number, y: number): string | null;
  monstersAt(hour: number, counts?: Record<string, number>): MonsterSpot[];
}

export class WorldMap implements GameMap, MonsterMap {
  seed: number;
  layout: Layout & { mine?: { x: number; y: number }; seed: number };
  constructor(seed: number, unlocked: string[] = []) {
    this.seed = seed >>> 0;
    this.layout = Village.generate(this.seed, unlocked);
  }
  get unlocked() { return this.layout.unlocked; }
  /** Where boats leave from: the shore tile next to the water closest to the plaza (a village.js helper). */
  portal(): Pos { return Village.dockOf(this.layout); }
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
  /** The Papan Juara board and the other fixed spots (village.js `landmarks`); true when `p` is within `d` tiles of one. */
  landmarks() { return Village.landmarks(this.layout); }
  nearLandmark(p: Pos, which: 'board' | 'gamble' | 'mall', d = 3) { const l = this.landmarks()[which]; return dist(p, l) <= d || dist(p, { x: l.x, y: l.y + 1 }) <= d; }
  nearPlot(p: Pos, idx: number) { const q = this.layout.farm.plots[idx]; return !!q && dist(p, q) <= 1; }
  atOwnHouse(p: Pos) { const h = this.layout.buildings.find((b) => b.own); return !!h && dist(p, { x: h.dx, y: h.dy + 1 }) <= 1; }
  atWorkbench(p: Pos) { return this.atOwnHouse(p); }
  checkGather(tile: string, x: number, y: number) {
    const t = this.tileAt(x, y);
    if (t === null) throw new HttpError(400, 'bad tile');
    if (t !== tile) throw new HttpError(409, 'Nothing to gather here.');
    const c = this.chunkAt(x, y);
    if (!c.open) throw new HttpError(409, `${c.name} isn't open yet.`);
  }
  fishSpot(x: number, y: number, totalHours: number) { const b = Village.fishBucket(totalHours); return Village.fishSpot(this.layout, x, y, b) || Village.fishSpot(this.layout, x, y, b - 1); }
  weather(day: number, season: string): Weather { return Village.weather(this.seed, day, season); }
  monstersAt(hour: number, counts?: Record<string, number>): MonsterSpot[] { return Village.monstersAt(this.layout, hour, counts); }
  /** The village forest (when the public area is not trade-only): boars at trees, bats at rocks, in one named chunk. */
  wildChunk = 'hutan';
  wild(x: number, y: number): string | null { return this.chunkAt(x, y).id === this.wildChunk ? 'any' : null; }
  /** What the client needs to build the same map. */
  view() { return { seed: this.seed, unlocked: this.layout.unlocked, version: this.layout.version, chunks: this.layout.chunks, projects: this.layout.projects }; }
}

export class HomelandMap implements GameMap, MonsterMap {
  seed: number;
  layout: HomelandLayout;
  constructor(seed: number, prog: HomelandProgress) {
    this.seed = seed >>> 0;
    this.layout = Homeland.generate(this.seed, prog);
  }
  tileAt(x: number, y: number): string | null {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= this.layout.w || y >= this.layout.h) return null;
    return this.layout.tiles[y * this.layout.w + x];
  }
  chunkAt(x: number, y: number): Chunk { return Homeland.chunkOf(this.layout, x, y); }
  walkable(x: number, y: number): boolean {
    const t = this.tileAt(x, y);
    if (t === null || SOLID.has(t) || !this.chunkAt(x, y).open) return false;
    return !this.layout.buildings.some((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h);
  }
  nearStall() { return false; } // no merchants in a Homeland
  nearPlot(p: Pos, idx: number) { const q = this.layout.farm.plots[idx]; return !!q && dist(p, q) <= 1; }
  atOwnHouse(p: Pos) { const h = this.layout.buildings.find((b) => b.kind === 'townhall'); return !!h && dist(p, { x: h.dx, y: h.dy + 1 }) <= 1; }
  // the client shows the Workbench in every building marked `own`: the Town Hall and, since homeland v3, Rumahmu
  atWorkbench(p: Pos) { return this.layout.buildings.some((b) => b.own && dist(p, { x: b.dx, y: b.dy + 1 }) <= 1); }
  checkGather(tile: string, x: number, y: number) {
    const t = this.tileAt(x, y);
    if (t === null) throw new HttpError(400, 'bad tile');
    if (t !== tile) throw new HttpError(409, 'Nothing to gather here.');
    const c = this.chunkAt(x, y);
    if (!c.open) throw new HttpError(409, `${c.name} isn't open yet.`);
  }
  fishSpot(x: number, y: number, totalHours: number) { const b = Village.fishBucket(totalHours); return Village.fishSpot(this.layout, x, y, b) || Village.fishSpot(this.layout, x, y, b - 1); }
  portal(): Pos { return this.layout.portal; }
  /** Night monsters: open forest chunks have boars, open rock chunks bats; the centre around the Town Hall is safe. */
  wild(x: number, y: number): string | null { return Homeland.wild(this.layout, x, y); }
  monstersAt(hour: number, counts?: Record<string, number>): MonsterSpot[] { return Homeland.monstersAt(this.layout, hour, counts); }
  /** Within one tile of the lot's door (the door tile itself or the way in below it). */
  nearLot(p: Pos, lot: string): boolean {
    const l = this.layout.lots.find((x) => x.id === lot);
    return !!l && dist(p, l.door) <= 1;
  }
}

/**
 * Where each player stands, as reported by their own (signed) client: with every action and every state poll.
 * Indoors the client reports the tile in front of the building's door. A report must be a walkable tile in an open
 * area, and the move since the last report must fit the walking speed (the spawn is always allowed: that is where a
 * player appears after loading the page). This stops gathering, trading and farming from across the map; a modified
 * client can still walk anywhere a player could walk.
 * Each player is in one world (the public area or a Homeland). Only `travel` changes it; the exception is a page reload or
 * Start: a report exactly on the player's own Homeland spawn moves them there.
 */
export class Positions {
  last = new Map<string, Pos & { t: number }>();
  /** Which world each player is in (absent = the public island). */
  worlds = new Map<string, string>();
  /** Players aboard the ferry boat (public village only): their reports must be water tiles the boat can sail on. At most one (the boat is one). */
  aboard = new Set<string>();
  /** The one public boat: where it floats, who steers it (`by`) and when it was last used. Starts at the mainland dock (see boatNow). */
  boat: { x: number; y: number; by: string | null; since: number } | null = null;
  /** A steerer silent this long (closed the page) lets go of the boat; an idle boat away from a dock sails home after RETURN_MS. */
  static STALE_MS = 120_000;
  static RETURN_MS = 120_000;
  map: WorldMap;
  constructor(map: WorldMap) { this.map = map; }
  worldOf(account: string): string { return this.worlds.get(account) ?? 'public'; }
  /** Leaves the boat where it floats (the player stepped off, left the world or went away). */
  private drop(account: string, now: number) {
    this.aboard.delete(account);
    if (this.boat && this.boat.by === account) { this.boat.by = null; this.boat.since = now; }
  }
  /** The boat now, with the rules applied lazily: a vanished steerer lets go; an idle boat with no shore next to it, or unused for a while with
   *  nobody standing by it, goes back to the mainland dock. null when the village has no boat. */
  boatNow(now: number): { x: number; y: number; by: string | null; since: number } | null {
    const f = Village.ferryOf(this.map.layout);
    if (!f) return null;
    if (!this.boat) this.boat = { x: f.wa.x, y: f.wa.y, by: null, since: now };
    const b = this.boat;
    if (b.by) {
      const lt = this.last.get(b.by)?.t ?? 0;
      if (now - lt > Positions.STALE_MS) { this.drop(b.by, lt || now); }
    }
    if (!b.by && !(b.x === f.wa.x && b.y === f.wa.y)) {
      const shore = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => this.map.walkable(b.x + dx, b.y + dy));
      let someone = false;
      for (const [a, l] of this.last) if (this.worldOf(a) === 'public' && now - l.t < Positions.STALE_MS && Math.abs(l.x - b.x) + Math.abs(l.y - b.y) <= 3) { someone = true; break; }
      if (!shore || (now - b.since > Positions.RETURN_MS && !someone)) { b.x = f.wa.x; b.y = f.wa.y; b.since = now; }
    }
    return b;
  }
  /** Moves a player to another world at a tile the server chose. */
  setWorld(account: string, world: string, at: Pos, now: number) {
    this.drop(account, now);
    if (world === 'public') this.worlds.delete(account); else this.worlds.set(account, world);
    this.last.set(account, { ...at, t: now });
  }
  /** Back to the public island with no remembered position (the next report starts fresh). */
  reset(account: string) { this.worlds.delete(account); this.last.delete(account); this.drop(account, Date.now()); }
  /** Steps onto the ferry boat (already at `at`, the water tile it floats on). */
  board(account: string, at: Pos, now: number) {
    this.aboard.add(account); this.last.set(account, { ...at, t: now });
    if (this.boat) { this.boat.by = account; this.boat.x = at.x; this.boat.y = at.y; this.boat.since = now; }
  }
  /** Steps off the boat onto the land tile `at`; the boat stays where it floats. */
  land(account: string, at: Pos, now: number) { this.drop(account, now); this.last.set(account, { ...at, t: now }); }
  /** `world` is the world the client says it is in, `map` that world's map (the caller already checked access to it). */
  /** The last position this check accepted for the player (what presence shows, never the raw report). */
  lastOf(account: string): Pos | null { const l = this.last.get(account); return l ? { x: l.x, y: l.y } : null; }
  report(account: string, raw: unknown, now: number, world = 'public', map: GameMap = this.map, home?: { world: string; spawn: Pos }): Pos {
    const r = raw as { x?: unknown; y?: unknown } | null;
    const p = { x: Number(r?.x), y: Number(r?.y) };
    if (!r || !Number.isInteger(p.x) || !Number.isInteger(p.y)) throw new HttpError(400, 'player position missing');
    if (world !== this.worldOf(account)) {
      const pub = this.map.layout.spawn;
      if (world === 'public' && p.x === pub.x && p.y === pub.y) { this.worlds.delete(account); this.last.delete(account); this.drop(account, now); }
      // a reload (or Start) puts the client on its own Homeland spawn: always believed, wherever the server had the player
      else if (home && world === home.world && p.x === home.spawn.x && p.y === home.spawn.y) { this.worlds.set(account, world); this.last.delete(account); }
      else throw new HttpError(409, 'Change worlds through the portal.');
    }
    const sp0 = map.layout.spawn;
    if (this.aboard.has(account) && p.x === sp0.x && p.y === sp0.y) this.drop(account, now); // a page reload puts the client back on the spawn
    if (this.aboard.has(account) ? !Village.boatWater(this.map.layout, p.x, p.y) : !map.walkable(p.x, p.y)) throw new HttpError(409, 'Invalid position.');
    const prev = this.last.get(account);
    const sp = map.layout.spawn;
    if (prev && !(p.x === sp.x && p.y === sp.y)) {
      const allowed = ((now - prev.t) / 1000) * TILES_PER_SEC + SLACK;
      if (dist(prev, p) > allowed) throw new HttpError(409, 'Position jumped too far. Reload the page.');
    }
    this.last.set(account, { ...p, t: now });
    if (this.aboard.has(account) && this.boat && this.boat.by === account) { this.boat.x = p.x; this.boat.y = p.y; this.boat.since = now; }
    return p;
  }
}
