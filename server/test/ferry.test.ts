// The ferry boat to the island in the village's bottom-right corner: board at a landing, steer over water, step off next to the boat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, P, fails } from './coopworld.ts';
import { Village } from '../src/game/worldmap.ts';

const boat = (w: Awaited<ReturnType<typeof world>>, pos: { x: number; y: number }, op: string, to?: { x: number; y: number }) =>
  w.game.act(P, { action: 'boat', world: 'public', pos, op, ...(to ?? {}) }) as any;

test('boarding works only beside a landing, and the boat starts on the water tile there', async () => {
  const w = await world();
  const f = Village.ferryOf(w.game.map!.layout)!;
  assert.ok(f, 'the village has an island reached by boat');
  w.game.positions!.setWorld(P, 'public', w.game.map!.layout.spawn, Date.now());
  w.adv(60_000);
  fails(() => boat(w, w.game.map!.layout.spawn, 'board'), 409, /next to the boat/i);
  w.game.positions!.setWorld(P, 'public', f.a, Date.now());
  w.adv(60_000);
  const r = boat(w, f.a, 'board');
  assert.deepEqual(r.arrive, f.wa);
  assert.equal(r.aboard, true);
  assert.ok(w.game.positions!.aboard.has(P));
  fails(() => boat(w, f.wa, 'board'), 409, /already/i);
});

test('while aboard, water moves are accepted at walking speed and land moves are not; other actions wait', async () => {
  const w = await world();
  const L = w.game.map!.layout, f = Village.ferryOf(L)!;
  w.game.positions!.setWorld(P, 'public', f.a, Date.now());
  w.adv(60_000);
  boat(w, f.a, 'board');
  // sail one water tile at a time from the mainland dock to the island's: the boat's water joins both
  const seen = new Set<string>(); const q = [{ ...f.wa }]; seen.add(`${f.wa.x},${f.wa.y}`);
  const prev = new Map<string, { x: number; y: number }>();
  let goal: { x: number; y: number } | null = null;
  while (q.length && !goal) {
    const c = q.shift()!;
    if (c.x === f.wb.x && c.y === f.wb.y) { goal = c; break; }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = { x: c.x + dx, y: c.y + dy }, k = `${n.x},${n.y}`;
      if (seen.has(k) || !Village.boatWater(L, n.x, n.y)) continue;
      seen.add(k); prev.set(k, c); q.push(n);
    }
  }
  assert.ok(goal, 'the two boat spots share one water');
  const path: Array<{ x: number; y: number }> = [];
  for (let c: { x: number; y: number } | undefined = goal; c; c = prev.get(`${c.x},${c.y}`)) path.unshift(c);
  assert.ok(path.length >= 3, 'a real trip across the water');
  for (const p of path.slice(1)) { w.adv(300); w.game.reportPosition(P, p, 'public'); assert.deepEqual(w.game.positions!.lastOf(P), p); }
  // a land tile (the shore itself) is not a boat tile
  const land = f.b;
  w.adv(300);
  w.game.reportPosition(P, land, 'public');
  assert.deepEqual(w.game.positions!.lastOf(P), f.wb, 'a land report while aboard is refused, the boat stays');
  // nothing but the boat works while aboard
  fails(() => w.game.act(P, { action: 'gather', world: 'public', pos: f.wb, tile: 'water', x: f.wb.x, y: f.wb.y + 1 }), 409, /Step off the boat/i);
});

test('the boat cannot jump over the water: a far move is refused', async () => {
  const w = await world();
  const L = w.game.map!.layout, f = Village.ferryOf(L)!;
  w.game.positions!.setWorld(P, 'public', f.a, Date.now());
  w.adv(60_000);
  boat(w, f.a, 'board');
  let far: { x: number; y: number } | null = null;
  for (let y = 0; y < L.h && !far; y++) for (let x = 0; x < L.w; x++) if (Village.boatWater(L, x, y) && Math.abs(x - f.wa.x) + Math.abs(y - f.wa.y) > 40) { far = { x, y }; break; }
  assert.ok(far, 'the lake is wide');
  w.adv(1000);
  w.game.reportPosition(P, far!, 'public');
  assert.deepEqual(w.game.positions!.lastOf(P), f.wa, 'the jump was not believed');
});

test('landing needs a walkable tile right next to the boat; stepping off far away is refused', async () => {
  const w = await world();
  const L = w.game.map!.layout, f = Village.ferryOf(L)!;
  w.game.positions!.setWorld(P, 'public', f.a, Date.now());
  w.adv(60_000);
  boat(w, f.a, 'board');
  fails(() => boat(w, f.wa, 'land', f.b), 409, /next to the shore|Steer/i); // the island landing is far from the first boat spot
  fails(() => boat(w, f.wa, 'land', { x: f.wa.x + 1, y: f.wa.y }), 409, /cannot step|Steer/i); // water or not walkable
  fails(() => boat(w, f.wa, 'board'), 409, /already/i);
  const r = boat(w, f.wa, 'land', f.a);
  assert.deepEqual(r.arrive, f.a);
  assert.equal(r.aboard, false);
  assert.ok(!w.game.positions!.aboard.has(P));
  assert.deepEqual(w.game.positions!.lastOf(P), f.a);
  fails(() => boat(w, f.a, 'land', f.a), 409, /not in the boat/i);
  // reaching the other shore: board again, sail next to the island landing, step off there
  w.adv(60_000);
  boat(w, f.a, 'board');
  w.game.positions!.last.set(P, { ...f.wb, t: Date.now() }); // (as if sailed there; the speed rule is tested above)
  const r2 = boat(w, f.wb, 'land', f.b);
  assert.deepEqual(r2.arrive, f.b);
});

test('on the production seed the island is isolated: the docks are five or more tiles apart and nothing built moved into the water', () => {
  const open = Village.CHUNKS.map((c) => c.id);
  const L = Village.generate(20261114, open), f = Village.ferryOf(L)!;
  assert.ok(f);
  assert.ok(Math.abs(f.a.x - f.b.x) + Math.abs(f.a.y - f.b.y) >= 5);
  assert.ok(L.buildings.every((b) => b.y + b.h <= 64 || b.x + b.w <= 61 || b.y >= 68), 'no building stands in the new water band');
});
