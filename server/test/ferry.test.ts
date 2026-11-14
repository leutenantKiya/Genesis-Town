// The ONE public boat to the island in the village's bottom-right corner: board next to it, steer over water, step off next to it.
// Everybody shares it: it stays where it was left, only one player steers, and an unused boat sails home to the mainland dock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, P, Q, fails } from './coopworld.ts';
import { Village, WorldMap, Positions } from '../src/game/worldmap.ts';

type W = Awaited<ReturnType<typeof world>>;
type XY = { x: number; y: number };
const boat = (w: W, who: string, pos: XY, op: string, to?: XY) =>
  w.game.act(who, { action: 'boat', world: 'public', pos, op, ...(to ?? {}) }) as any;

/** A shortest water route from one boat tile to another (4-connected, the tiles the boat may enter). */
function route(L: any, from: XY, to: XY): XY[] {
  const key = (p: XY) => `${p.x},${p.y}`, seen = new Set([key(from)]), prev = new Map<string, XY>(), q = [from];
  let goal: XY | null = null;
  while (q.length && !goal) {
    const c = q.shift()!;
    if (c.x === to.x && c.y === to.y) { goal = c; break; }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = { x: c.x + dx, y: c.y + dy };
      if (seen.has(key(n)) || !Village.boatWater(L, n.x, n.y)) continue;
      seen.add(key(n)); prev.set(key(n), c); q.push(n);
    }
  }
  assert.ok(goal, 'the water joins the two boat spots');
  const path: XY[] = [];
  for (let c: XY | undefined = goal!; c; c = prev.get(key(c))) path.unshift(c);
  return path;
}
/** The steerer sails along the route, one tile per 300 ms report. */
function sail(w: W, who: string, path: XY[]) {
  for (const p of path.slice(1)) { w.adv(300); w.game.reportPosition(who, p, 'public'); assert.deepEqual(w.game.positions!.lastOf(who), p); }
}
const at = (w: W, who: string, p: XY) => { w.game.positions!.setWorld(who, 'public', p, (w.game as any).now()); w.adv(60_000); };
const boatAt = (w: W) => { const b = w.game.positions!.boatNow((w.game as any).now())!; return { x: b.x, y: b.y }; };

test('there is one boat: it starts on the water tile by the mainland dock and boarding needs a land tile next to it', async () => {
  const w = await world();
  const f = Village.ferryOf(w.game.map!.layout)!;
  assert.ok(f, 'the village has an island reached by boat');
  assert.deepEqual(boatAt(w), f.wa);
  assert.deepEqual(w.game.boatView(P), { x: f.wa.x, y: f.wa.y, by: null, name: null, mine: false });
  at(w, P, w.game.map!.layout.spawn);
  fails(() => boat(w, P, w.game.map!.layout.spawn, 'board'), 409, /next to the boat/i);
  // the island dock has no boat: it is at the mainland dock
  at(w, P, f.b);
  fails(() => boat(w, P, f.b, 'board'), 409, /next to the boat/i);
  at(w, P, f.a);
  const r = boat(w, P, f.a, 'board');
  assert.deepEqual(r.arrive, f.wa);
  assert.equal(r.aboard, true);
  assert.ok(w.game.positions!.aboard.has(P));
  assert.deepEqual(w.game.boatView(P), { x: f.wa.x, y: f.wa.y, by: P, name: 'Ani', mine: true });
  assert.equal(w.game.boatView(Q)!.mine, false);
  fails(() => boat(w, P, f.wa, 'board'), 409, /already/i);
});

test('while aboard, water moves are accepted at walking speed and the boat follows; land moves are not; other actions wait', async () => {
  const w = await world();
  const L = w.game.map!.layout, f = Village.ferryOf(L)!;
  at(w, P, f.a);
  boat(w, P, f.a, 'board');
  const path = route(L, f.wa, f.wb);
  assert.ok(path.length >= 3, 'a real trip across the water');
  sail(w, P, path.slice(0, 3));
  assert.deepEqual(boatAt(w), path[2], 'the boat is where its steerer is');
  sail(w, P, path.slice(2));
  assert.deepEqual(boatAt(w), f.wb);
  // a land tile (the shore itself) is not a boat tile
  w.adv(300);
  w.game.reportPosition(P, f.b, 'public');
  assert.deepEqual(w.game.positions!.lastOf(P), f.wb, 'a land report while aboard is refused, the boat stays');
  assert.deepEqual(boatAt(w), f.wb);
  fails(() => w.game.act(P, { action: 'gather', world: 'public', pos: f.wb, tile: 'water', x: f.wb.x, y: f.wb.y + 1 }), 409, /Step off the boat/i);
});

test('the boat cannot jump over the water: a far move is refused', async () => {
  const w = await world();
  const L = w.game.map!.layout, f = Village.ferryOf(L)!;
  at(w, P, f.a);
  boat(w, P, f.a, 'board');
  let far: XY | null = null;
  for (let y = 0; y < L.h && !far; y++) for (let x = 0; x < L.w; x++) if (Village.boatWater(L, x, y) && Math.abs(x - f.wa.x) + Math.abs(y - f.wa.y) > 40) { far = { x, y }; break; }
  assert.ok(far, 'the lake is wide');
  w.adv(1000);
  w.game.reportPosition(P, far!, 'public');
  assert.deepEqual(w.game.positions!.lastOf(P), f.wa, 'the jump was not believed');
  assert.deepEqual(boatAt(w), f.wa);
});

test('landing needs a walkable tile right next to the boat; the boat stays where it was left and the next player boards it there', async () => {
  const w = await world();
  const L = w.game.map!.layout, f = Village.ferryOf(L)!;
  at(w, P, f.a);
  boat(w, P, f.a, 'board');
  fails(() => boat(w, P, f.wa, 'land', f.b), 409, /next to the shore|Steer/i); // the island landing is far from the first boat spot
  fails(() => boat(w, P, f.wa, 'land', { x: f.wa.x + 1, y: f.wa.y }), 409, /cannot step|Steer/i); // water or not walkable
  const r = boat(w, P, f.wa, 'land', f.a);
  assert.deepEqual(r.arrive, f.a);
  assert.equal(r.aboard, false);
  assert.ok(!w.game.positions!.aboard.has(P));
  assert.deepEqual(w.game.positions!.lastOf(P), f.a);
  assert.deepEqual(boatAt(w), f.wa);
  assert.equal(w.game.boatView(P)!.by, null);
  fails(() => boat(w, P, f.a, 'land', f.a), 409, /not in the boat/i);
  // sail across, step off on the island: the boat stays at the island
  w.adv(60_000);
  boat(w, P, f.a, 'board');
  sail(w, P, route(L, f.wa, f.wb));
  const r2 = boat(w, P, f.wb, 'land', f.b);
  assert.deepEqual(r2.arrive, f.b);
  assert.deepEqual(boatAt(w), f.wb);
  // the boat is no longer at the mainland dock; Q waiting there cannot board it, Q on the island can
  at(w, Q, f.a);
  fails(() => boat(w, Q, f.a, 'board'), 409, /next to the boat/i);
  at(w, Q, f.b);
  const r3 = boat(w, Q, f.b, 'board');
  assert.deepEqual(r3.arrive, f.wb);
});

test('a boat somebody steers is busy: others are refused by name, and may board once it is free', async () => {
  const w = await world();
  const f = Village.ferryOf(w.game.map!.layout)!;
  at(w, P, f.a); at(w, Q, f.a);
  boat(w, P, f.a, 'board');
  fails(() => boat(w, Q, f.a, 'board'), 409, 'The boat is in use by Ani.');
  assert.ok(!w.game.positions!.aboard.has(Q));
  assert.equal(w.game.boatView(Q)!.name, 'Ani');
  boat(w, P, f.wa, 'land', f.a);
  const r = boat(w, Q, f.a, 'board');
  assert.equal(r.aboard, true);
  assert.deepEqual(w.game.positions!.aboard.size, 1);
});

test('a steerer who goes silent lets go; the unused boat returns to the mainland dock, but not while somebody stands by it', async () => {
  const w = await world();
  const L = w.game.map!.layout, f = Village.ferryOf(L)!;
  // 1) P sails to the island and closes the page: after two minutes the boat is free and back at the dock
  at(w, P, f.a);
  boat(w, P, f.a, 'board');
  sail(w, P, route(L, f.wa, f.wb));
  assert.deepEqual(boatAt(w), f.wb);
  w.adv(Positions.STALE_MS + 1000);
  assert.deepEqual(boatAt(w), f.wa, 'the abandoned boat sailed home');
  assert.ok(!w.game.positions!.aboard.has(P));
  assert.equal(w.game.boatView(Q)!.by, null);
  // 2) a boat left at the island stays while the player who left it is still around (reporting), and goes home once nobody is there
  at(w, P, f.a);
  boat(w, P, f.a, 'board');
  sail(w, P, route(L, f.wa, f.wb));
  boat(w, P, f.wb, 'land', f.b);
  for (let i = 0; i < 4; i++) { w.adv(60_000); w.game.reportPosition(P, f.b, 'public'); assert.deepEqual(boatAt(w), f.wb, 'the player on the island can still sail back'); }
  w.adv(Positions.RETURN_MS + 1000);
  assert.deepEqual(boatAt(w), f.wa, 'nobody near for two minutes: it went home');
  // 3) a boat adrift away from every shore goes straight back to the dock
  const pos = w.game.positions!;
  let mid: XY | null = null;
  for (let y = 0; y < L.h && !mid; y++) for (let x = 0; x < L.w; x++) {
    if (Village.boatWater(L, x, y) && ![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => w.game.map!.walkable(x + dx, y + dy))) { mid = { x, y }; break; }
  }
  assert.ok(mid, 'the lake has tiles with no shore beside them');
  pos.boat = { x: mid!.x, y: mid!.y, by: null, since: (w.game as any).now() };
  assert.deepEqual(boatAt(w), f.wa, 'a boat nobody can reach from land is returned at once');
  // the sailing player's own reload (back on the spawn) lets go of the boat where it floats
  at(w, Q, f.a);
  boat(w, Q, f.a, 'board');
  sail(w, Q, route(L, f.wa, f.wb).slice(0, 4));
  const here = boatAt(w);
  w.game.reportPosition(Q, L.spawn, 'public');
  assert.ok(!pos.aboard.has(Q));
  assert.equal(w.game.boatView(P)!.by, null);
  assert.deepEqual(boatAt(w), here);
});

test('on the production seed the island is isolated: no walk from the spawn, a 3+ tile water band all round, the boat still sails', () => {
  const open = Village.CHUNKS.map((c) => c.id);
  const map = new WorldMap(20261114, open), L: any = map.layout, f = Village.ferryOf(L)!;
  assert.ok(f);
  assert.ok(Math.abs(f.a.x - f.b.x) + Math.abs(f.a.y - f.b.y) >= 5);
  assert.ok(L.buildings.every((b: any) => b.y + b.h <= 64 || b.x + b.w <= 61 || b.y >= 68), 'no building stands in the water band');
  const flood = (s: XY, ok: (x: number, y: number) => boolean, eight = false) => {
    const seen = new Set<number>([s.y * L.w + s.x]), q = [s];
    while (q.length) {
      const c = q.shift()!;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if ((!dx && !dy) || (!eight && dx && dy)) continue;
        const x = c.x + dx, y = c.y + dy;
        if (x < 0 || y < 0 || x >= L.w || y >= L.h || seen.has(y * L.w + x) || !ok(x, y)) continue;
        seen.add(y * L.w + x); q.push({ x, y });
      }
    }
    return seen;
  };
  // nobody walks there: the flood from the spawn over every walkable tile (all chunks open) never reaches the island
  const reach = flood(L.spawn, (x, y) => map.walkable(x, y));
  const isle = flood(f.b, (x, y) => map.walkable(x, y));
  assert.ok(isle.size >= 100, 'the island is a real place');
  for (const i of isle) assert.ok(!reach.has(i), `the island tile ${i % L.w},${(i / L.w) | 0} cannot be walked to`);
  assert.ok(!reach.has(f.b.y * L.w + f.b.x));
  // a water band of 3+ tiles between the island's land and any other land (the map's border ring and the island's own tiles excepted)
  const land = (x: number, y: number) => L.tiles[y * L.w + x] !== 'water';
  const ring = (x: number, y: number) => x === 0 || y === 0 || x === L.w - 1 || y === L.h - 1;
  const mine = flood(f.b, (x, y) => land(x, y) && !ring(x, y), true);
  for (const i of mine) for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    const x = (i % L.w) + dx, y = ((i / L.w) | 0) + dy;
    if (x < 0 || y < 0 || x >= L.w || y >= L.h || ring(x, y) || !land(x, y)) continue;
    assert.ok(mine.has(y * L.w + x), `other land ${x},${y} is within 3 tiles of the island at ${i % L.w},${(i / L.w) | 0}`);
  }
  // no line of ring trees joins the island's corner to the mainland along the east edge
  for (let y = 64; y < 68; y++) assert.equal(L.tiles[y * L.w + L.w - 1], 'water');
  // the boat's water still joins the two docks
  assert.ok(Village.boatWater(L, f.wa.x, f.wa.y) && Village.boatWater(L, f.wb.x, f.wb.y));
  assert.ok(route(L, f.wa, f.wb).length >= 3);
});
