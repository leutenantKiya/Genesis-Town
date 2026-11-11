import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../client/js/world/homeland.js';

const GH = (globalThis as any).GTHomeland;
const SOLID = new Set(['tree', 'fence', 'sign', 'mailbox', 'rock', 'water', 'bush', 'barrel', 'crate', 'stall', 'lamp']);
const base = { open: [] as string[], th: 1, built: [] as Array<{ kind: string; lot: string }> };

function reach(L: any, sx: number, sy: number) {
  const seen = new Set<number>(), q: number[][] = [[sx, sy]];
  const blocked = new Set<number>();
  for (const b of L.buildings) for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) blocked.add(y * L.w + x);
  seen.add(sy * L.w + sx);
  while (q.length) {
    const [x, y] = q.pop()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, k = ny * L.w + nx;
      if (nx < 0 || ny < 0 || nx >= L.w || ny >= L.h || seen.has(k) || blocked.has(k)) continue;
      if (SOLID.has(L.tiles[k]) || !GH.chunkOf(L, nx, ny).open) continue;
      seen.add(k); q.push([nx, ny]);
    }
  }
  return seen;
}

test('same seed and progress give identical tiles', () => {
  assert.deepEqual(GH.generate(42, base), GH.generate(42, base));
});

test('nine chunks, only the centre open at start', () => {
  const L = GH.generate(42, base);
  assert.equal(L.chunks.length, 9);
  assert.deepEqual(L.chunks.filter((c: any) => c.open).map((c: any) => c.id), ['c']);
  assert.deepEqual(L.unlocked, ['c']);
  assert.equal(L.w, 48);
  assert.equal(L.tiles.length, 48 * 48);
});

test('centre has a town hall, one farm plot, trees, rocks, a portal, a kolam and a restoran lot', () => {
  const L = GH.generate(42, base);
  const th = L.buildings.find((b: any) => b.kind === 'townhall');
  assert.ok(th && th.own && th.w === 4 && th.h === 4 && th.open);
  assert.equal(GH.chunkOf(L, th.x, th.y).id, 'c');
  assert.equal(L.farm.plots.length, 1);
  const centre = (t: string) => L.tiles.filter((k: string, i: number) => k === t && GH.chunkOf(L, i % L.w, Math.floor(i / L.w)).id === 'c').length;
  assert.ok(centre('tree') >= 4);
  assert.ok(centre('rock') >= 2);
  assert.ok(L.portal && L.portal.x >= 16 && L.portal.x < 32);
  assert.ok(L.lots.some((l: any) => l.kind === 'kolam' && l.chunk === 'c'));
  assert.ok(L.lots.some((l: any) => l.kind === 'restoran' && l.chunk === 'c'));
  assert.equal(L.lots.find((l: any) => l.kind === 'kolam').id, 'kolam-c');
});

test('every seed 1..50 has forest and water next to the centre, and a rock chunk with a tambang lot', () => {
  for (let s = 1; s <= 50; s++) {
    const L = GH.generate(s, base);
    const by = Object.fromEntries(L.chunks.map((c: any) => [c.id, c.biome]));
    const orth = ['n', 'w', 'e', 's'].map((id) => by[id]);
    assert.ok(orth.includes('forest'), `seed ${s} forest`);
    assert.ok(orth.some((b: string) => b === 'pond' || b === 'sea'), `seed ${s} water`);
    const t = L.lots.find((l: any) => l.kind === 'tambang');
    assert.ok(t && by[t.chunk] === 'rock', `seed ${s} tambang`);
  }
});

test('spawn is walkable and portal, lot doors and farm plot are reachable from it', () => {
  for (let s = 1; s <= 50; s++) {
    const L = GH.generate(s, base);
    assert.ok(!SOLID.has(L.tiles[L.spawn.y * L.w + L.spawn.x]));
    const r = reach(L, L.spawn.x, L.spawn.y);
    const has = (p: any) => r.has(p.y * L.w + p.x);
    assert.ok(r.has(L.spawn.y * L.w + L.spawn.x));
    assert.ok(has(L.portal), `seed ${s} portal`);
    for (const l of L.lots) if (l.chunk === 'c') assert.ok(has(l.door), `seed ${s} lot ${l.id}`);
    assert.ok(has(L.farm.plots[0]) && has(L.farm.gate), `seed ${s} farm`);
  }
});

test('farm plots grow with town hall level, capped at 6', () => {
  const n = (th: number) => GH.generate(42, { ...base, th }).farm.plots.length;
  assert.deepEqual([1, 2, 3, 4, 6, 9].map(n), [1, 2, 3, 4, 6, 6]);
});

test('opening a chunk never moves anything: it only lays the bridge across the gap', () => {
  const a = GH.generate(42, base), b = GH.generate(42, { ...base, open: ['n'] });
  const changed = a.tiles.map((t: string, i: number) => (t === b.tiles[i] ? null : t + '>' + b.tiles[i])).filter(Boolean);
  assert.ok(changed.length >= 4, 'a bridge appears');
  assert.ok(changed.every((c: string) => c === 'void>bridge'), 'only sky turns into bridge');
  assert.deepEqual(b.unlocked, ['c', 'n']);
  assert.equal(b.chunks.find((c: any) => c.id === 'n').open, true);
});

test('built buildings appear on their lot', () => {
  const lot = GH.generate(42, base).lots.find((l: any) => l.kind === 'kolam');
  const L = GH.generate(42, { open: [], th: 1, built: [{ kind: 'kolam', lot: lot.id }] });
  const b = L.buildings.find((x: any) => x.kind === 'kolam');
  assert.ok(b && b.x === lot.x && b.y === lot.y && b.dx === lot.door.x && b.dy === lot.door.y);
});

test('generator v2 and later have a rumah lot per chunk and a rumahsakit lot, all reachable', () => {
  const ids = ['nw', 'n', 'ne', 'w', 'c', 'e', 'sw', 's', 'se'];
  assert.equal(GH.VERSION, 3);
  for (let s = 1; s <= 30; s++) {
    const L0 = GH.generate(s, base);
    assert.deepEqual(ids.map((id) => `rumah-${id}`).filter((id) => !L0.lots.some((l: any) => l.id === id)), [], `seed ${s} rumah lots`);
    assert.ok(L0.lots.some((l: any) => l.id === 'rumahsakit-c' && l.kind === 'rumahsakit'));
    // every lot built and every chunk open: nothing may block the way to a door
    const L = GH.generate(s, { open: ids.filter((i) => i !== 'c'), th: 5, built: L0.lots.map((l: any) => ({ kind: l.kind, lot: l.id })) });
    const r = reach(L, L.spawn.x, L.spawn.y);
    for (const l of L0.lots) assert.ok(r.has((l.door.y + 1) * L.w + l.door.x), `seed ${s} lot ${l.id} reachable`);
    assert.deepEqual(L.lots, L0.lots); // lots never move with progress
  }
});

test('a new Homeland (generator 3) has the player\'s own house beside the Town Hall, reachable from the spawn', () => {
  for (const seed of [1, 42, 12345, 987654]) {
    const L = GH.generate(seed, { ...base, gen: 3 });
    const th = L.buildings.find((b: any) => b.kind === 'townhall'), house = L.buildings.find((b: any) => b.kind === 'house');
    assert.ok(house, 'the house is there from the start');
    assert.equal(house.own, true);
    assert.equal(house.w, 3); assert.equal(house.h, 3);
    assert.ok(house.x + house.w < th.x && th.x - (house.x + house.w) <= 3, 'west of the Town Hall, close by');
    assert.ok(reach(L, L.spawn.x, L.spawn.y).has((house.dy + 1) * L.w + house.dx), 'its door can be walked to from the spawn');
    const lot = L.lots.find((l: any) => l.id === 'rumah-c');
    assert.ok(reach(L, L.spawn.x, L.spawn.y).has((lot.door.y + 1) * L.w + lot.door.x), 'the centre Rumah Pekerja lot is still reachable');
  }
});

test('an older Homeland (generator 2) gets the house too, and its centre Rumah Pekerja lot moves beside it', () => {
  const L = GH.generate(42, { ...base, gen: 2 });
  assert.equal(L.buildings.filter((b: any) => b.kind === 'house' && b.own).length, 1);
  const lot = L.lots.find((l: any) => l.id === 'rumah-c');
  assert.equal(lot.y, 16 + 6);
});

test('Homelands are floating islands: sky between the chunks, bridges only where both sides are open', () => {
  const L0 = GH.generate(7, base), L1 = GH.generate(7, { ...base, open: ['n', 'e'] });
  const at = (L: any, x: number, y: number) => L.tiles[y * L.w + x];
  // the gap between the centre and the north island, on the cross path, and off it
  assert.equal(at(L0, 16 + 7, 15), 'void');
  assert.equal(at(L1, 16 + 7, 15), 'bridge');
  assert.equal(at(L1, 16 + 3, 14), 'void');
  // the north and east islands are not neighbours: no bridge from n to e, and none to a closed chunk
  assert.equal(at(L1, 32 + 7, 15), 'void');
  assert.ok(reach(L1, L1.spawn.x, L1.spawn.y).has(8 * L1.w + 16 + 8), 'the north island can be walked to');
  assert.ok(!reach(L0, L0.spawn.x, L0.spawn.y).has(8 * L0.w + 16 + 8), 'and not before it is open');
});
