// Fishing only where the water ripples: the spots come from one shared generator (client/js/world/village.js fishSpot), the same in
// the village and in a Homeland, deterministic from the world seed and the game time; the server refuses any other water tile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Village, WorldMap, HomelandMap } from '../src/game/worldmap.ts';

test('ripple spots: deterministic, about one in six shore tiles, only on water next to land, and they move with the time bucket', () => {
  const a = new WorldMap(20261114), b = new WorldMap(20261114);
  const L = a.layout;
  let shore = 0, spots = 0, moved = 0;
  for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
    const s0 = a.fishSpot(x, y, 0), s1 = b.fishSpot(x, y, 0);
    assert.equal(s0, s1, 'same seed, same spots');
    if (s0) {
      spots++;
      assert.equal(L.tiles[y * L.w + x], 'water', 'a spot is water');
      assert.ok([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !['water', 'lily', 'tree', 'rock', 'void'].includes(L.tiles[(y + dy) * L.w + x + dx] ?? 'void')), 'next to land');
    }
    if (Village.fishSpot(L, x, y, 100) !== Village.fishSpot(L, x, y, 101)) moved++;
    if (L.tiles[y * L.w + x] === 'water') shore++;
  }
  assert.ok(spots >= 8 && spots < shore * 0.3, `a reasonable number of spots (${spots} of ${shore} water tiles)`);
  assert.ok(moved > 0, 'the fish move on in the next bucket');
  assert.equal(a.fishSpot(0, 0, 0), false, 'dry land is never a spot');
});

test('the previous bucket still counts, so a spot does not vanish mid-cast; a Homeland has its own spots', () => {
  const m = new WorldMap(7), L = m.layout;
  let found: { x: number; y: number } | null = null;
  for (let y = 0; y < L.h && !found; y++) for (let x = 0; x < L.w && !found; x++) if (Village.fishSpot(L, x, y, 5) && !Village.fishSpot(L, x, y, 6)) found = { x, y };
  assert.ok(found);
  assert.equal(m.fishSpot(found!.x, found!.y, 5 * 6 + 1), true);
  assert.equal(m.fishSpot(found!.x, found!.y, 6 * 6 + 1), true, 'one bucket later it still counts');
  assert.equal(m.fishSpot(found!.x, found!.y, 8 * 6 + 1), false, 'two buckets later it is gone');
  const h = new HomelandMap(7, { open: ['n', 'e', 's', 'w'], th: 3, built: [] }), HL = h.layout;
  let n = 0;
  for (let y = 0; y < HL.h; y++) for (let x = 0; x < HL.w; x++) if (h.fishSpot(x, y, 0)) { n++; assert.equal(HL.tiles[y * HL.w + x], 'water'); }
  assert.ok(n > 0, 'a Homeland with a pond has ripple spots');
});
