// Searching grass for a wheat seed (act `grass`): the server checks the tile is grass and the player stands next to it,
// takes a little energy, waits a cooldown between tries, stops at a daily cap, and the seed is the existing wheat token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, P, Q, fails } from './coopworld.ts';
import type { Pos } from '../src/game/worldmap.ts';

type W = Awaited<ReturnType<typeof world>>;
type M = { layout: { w: number; h: number; tiles: string[] }; walkable(x: number, y: number): boolean; chunkAt(x: number, y: number): { open: boolean } };
type Spot = { tile: Pos; stand: Pos };

/** A tile of `type` in an open area with a walkable neighbour to stand on. */
function tileOf(map: M, type: string): Spot {
  const L = map.layout;
  for (let y = 2; y < L.h - 2; y++) for (let x = 2; x < L.w - 2; x++) {
    if (L.tiles[y * L.w + x] !== type || !map.chunkAt(x, y).open) continue;
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) if (map.walkable(x + dx, y + dy)) return { tile: { x, y }, stand: { x: x + dx, y: y + dy } };
  }
  throw new Error('no ' + type);
}
const full = (w: W, a: string) => { const p = w.game.world.state(a); p.energy = 100; w.game.gs.savePlayer(p); };
const energy = (w: W, a: string) => Math.floor(w.game.world.state(a).energy);
const seeds = (w: W, a: string) => (w.game.gs.db.prepare("SELECT COALESCE(SUM(delta), 0) AS s FROM ledger WHERE account = ? AND token = 'wheat' AND kind = 'grass'").get(a) as { s: number }).s;
const hits = (w: W) => { w.game.world.rng = () => 0.01; };
const misses = (w: W) => { w.game.world.rng = () => 0.99; };
const search = (w: W, p: Spot, world = 'public', a = P) => w.game.act(a, { action: 'grass', x: p.tile.x, y: p.tile.y, world, pos: p.stand }) as any;
/** Puts a player on exactly this tile of the village (w.stand would stand one below a landmark). */
const at = (w: W, a: string, pos: Pos) => { w.game.positions!.reset(a); w.game.reportPosition(a, pos, 'public'); };
const village = (w: W) => w.game.map as unknown as M;

test('next to grass in the village: a find is 1 wheat (a normal ledger row), costs the configured energy', async () => {
  const w = await world();
  const g = tileOf(village(w), 'grass');
  at(w, P, g.stand); full(w, P); hits(w);
  const cfg = w.econ.grass!;
  assert.equal(cfg.token, 'wheat');
  const before = w.bal(P, 'wheat');
  const r = search(w, g);
  assert.deepEqual(r.gained, { wheat: 1 });
  assert.match(r.toast, /wheat seed/i);
  assert.equal(w.bal(P, 'wheat'), before + 1);
  assert.equal(seeds(w, P), 1);
  assert.equal(energy(w, P), 100 - cfg.energyCost);
  const row = w.game.gs.db.prepare("SELECT * FROM ledger WHERE account = ? AND kind = 'grass'").get(P) as any;
  assert.equal(row.token, 'wheat'); assert.equal(row.delta, 1);
});

test('a miss costs energy but gives nothing and leaves no Riwayat line; a find does', async () => {
  const w = await world();
  const g = tileOf(village(w), 'grass');
  at(w, P, g.stand); full(w, P); misses(w);
  const lines = () => (w.store.db.prepare("SELECT COUNT(*) AS n FROM history WHERE account_id = ? AND kind = 'grass'").get(P) as { n: number }).n;
  const bal = w.bal(P, 'wheat');
  const r = search(w, g);
  assert.deepEqual(r.gained, {});
  assert.equal(w.bal(P, 'wheat'), bal);
  assert.equal(seeds(w, P), 0);
  assert.equal(energy(w, P), 100 - w.econ.grass!.energyCost);
  assert.equal(lines(), 0);
  w.adv(w.econ.grass!.cooldownSecs * 1000 + 1); hits(w);
  search(w, g);
  assert.equal(lines(), 1);
});

test('the server checks the tile is grass and that the player stands right next to it', async () => {
  const w = await world();
  const m = village(w);
  const g = tileOf(m, 'grass');
  at(w, P, g.stand); full(w, P); hits(w);
  fails(() => w.game.act(P, { action: 'grass', x: g.tile.x + 5, y: g.tile.y, world: 'public', pos: g.stand }), 409, /Too far/);
  fails(() => w.game.act(P, { action: 'grass', x: g.stand.x, y: g.stand.y, world: 'public', pos: g.stand }), 409, /Too far/); // the own tile
  for (const type of ['water', 'tree', 'rock']) {
    let t: Spot;
    try { t = tileOf(m, type); } catch { continue; }
    at(w, P, t.stand);
    fails(() => search(w, t), 409, /Nothing to search/);
  }
  assert.equal(seeds(w, P), 0);
  at(w, P, g.stand);
  fails(() => w.game.act(P, { action: 'grass', x: -3, y: 5, world: 'public', pos: g.stand }), 409, /Too far|bad tile/);
});

test('a cooldown between tries, a daily cap on finds, and a new day starts again', async () => {
  const w = await world();
  const g = tileOf(village(w), 'grass');
  at(w, P, g.stand); full(w, P); hits(w);
  const cfg = w.econ.grass!;
  search(w, g);
  fails(() => search(w, g), 409, /Wait a moment/);
  for (let i = 1; i < cfg.dailyMax; i++) { w.adv(cfg.cooldownSecs * 1000 + 1); full(w, P); search(w, g); }
  assert.equal(seeds(w, P), cfg.dailyMax);
  w.adv(cfg.cooldownSecs * 1000 + 1); full(w, P);
  fails(() => search(w, g), 409, /Come back tomorrow/);
  assert.equal(seeds(w, P), cfg.dailyMax, 'nothing more today');
  w.adv(25 * 60 * 1000); // the next game day (24 real minutes)
  at(w, P, g.stand); full(w, P); search(w, g);
  assert.equal(seeds(w, P), cfg.dailyMax + 1);
});

test('no energy, no search; the daily gain cap is asked too and a refused search takes no energy', async () => {
  const w = await world();
  const g = tileOf(village(w), 'grass');
  at(w, P, g.stand); hits(w);
  const p = w.game.world.state(P); p.energy = 0; w.game.gs.savePlayer(p);
  fails(() => search(w, g), 409, /energy/i);
  assert.equal(seeds(w, P), 0);
  full(w, P);
  w.give(P, 'wheat', w.econ.caps.dailyGainPerItem); // today's net gain of wheat is at the cap
  fails(() => search(w, g), 409, /Daily limit/);
  assert.equal(seeds(w, P), 0);
  assert.equal(energy(w, P), 100);
});

test('the Homeland: its own grass counts, the owner and a helper may search, a visitor may not', async () => {
  const w = await world();
  const h = w.enter(P, P);
  const g = tileOf(h.map as unknown as M, 'grass');
  w.game.positions!.setWorld(P, h.wid, g.stand, Date.now()); w.adv(60_000);
  full(w, P); hits(w);
  assert.deepEqual(search(w, g, h.wid).gained, { wheat: 1 });
  w.party(P, Q); // a party mate stays a visitor until promoted
  w.enter(Q, P);
  w.game.positions!.setWorld(Q, h.wid, g.stand, Date.now()); w.adv(60_000);
  full(w, Q);
  fails(() => search(w, g, h.wid, Q), 409, /./);
  w.game.homelands.setRole(P, 'party', 'helper');
  assert.deepEqual(search(w, g, h.wid, Q).gained, { wheat: 1 });
});

test('the wheat seed is the existing token: the config names no new item', async () => {
  const w = await world();
  assert.ok(Object.hasOwn(w.econ.items, w.econ.grass!.token));
  assert.equal(w.econ.grass!.token, w.econ.farm.seed);
});

test('the grass texts have Indonesian translations', async () => {
  const { toId } = await import('../src/lang.ts');
  assert.equal(toId('You found a wheat seed! +1 Wheat'), 'Kamu menemukan benih gandum! +1 Gandum');
  assert.equal(toId('Nothing to search here.'), 'Tidak ada yang bisa dicari di sini.');
  assert.match(toId('You found all the seeds the grass has for today (6). Come back tomorrow.'), /Kembali lagi besok/);
});
