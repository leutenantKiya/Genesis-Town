import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Village, WorldMap } from '../src/game/worldmap.ts';

test('every seed makes a valid village; the same seed always makes the same one', () => {
  const t0 = Date.now();
  for (let seed = 1; seed <= 40; seed++) {
    const L = Village.generate(seed * 7919);
    const kinds = L.buildings.map((b) => b.kind);
    for (const k of ['hall', 'post', 'broker', 'warung']) assert.ok(kinds.includes(k), `seed ${seed}: ${k}`);
    for (const k of ['church', 'clinic']) assert.ok(!kinds.includes(k), `seed ${seed}: no ${k} (version 2: the square is for trade and fun)`);
    const F = (L as any).fun;
    assert.ok(F && F.fountain && F.stage && F.carousel && F.pond && F.benches.length >= 6, `seed ${seed}: fountain, stage, carousel, pond, benches`);
    assert.equal(L.tiles[F.fountain.y * L.w + F.fountain.x], 'fountain');
    assert.equal(L.buildings.filter((b) => b.kind === 'house' && (b as { own?: boolean }).own).length, 1, 'one player house');
    assert.ok(L.chunks.find((c) => c.id === 'seberang' && !c.open), 'Dusun Seberang starts closed');
    assert.ok(!L.tiles.includes('bridge'), 'no bridge before the project');
  }
  assert.ok(Date.now() - t0 < 15_000, 'fast enough to run in the browser');
  assert.equal(new WorldMap(123).layout.tiles.join(), new WorldMap(123).layout.tiles.join());
  assert.notEqual(new WorldMap(123).layout.tiles.join(), new WorldMap(124).layout.tiles.join());
});

test('opening Dusun Seberang adds the bridge and keeps the rest of the village where it was', () => {
  const closed = Village.generate(20261114), open = Village.generate(20261114, ['seberang']);
  assert.ok(open.tiles.includes('bridge'));
  const where = (L: typeof closed) => L.buildings.filter((b) => b.name).map((b) => `${b.kind}@${b.x},${b.y}`).join();
  assert.equal(where(open), where(closed), 'public buildings do not move when an area opens');
});
