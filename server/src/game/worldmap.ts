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
  buildings: Array<{ kind: string; name: string | null; x: number; y: number; w: number; h: number; dx: number; dy: number; open: boolean }>;
}
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
