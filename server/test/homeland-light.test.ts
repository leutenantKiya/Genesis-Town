import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, P, Q, fails } from './coopworld.ts';
import { Homeland, HomelandMap } from '../src/game/worldmap.ts';

// The Town Hall's Lighting project: level 1 puts lamps along the centre island's paths, level 2 on every open island.
// The lamps come from the shared generator, so the server's walk map and every client agree on where they stand.

test('the generator puts lamps only when the project is built, never blocking a door, lot or the portal', () => {
  for (const seed of [7919, 15838, 23757, 31676, 39595]) {
    const none = Homeland.generate(seed, { open: [], th: 1, built: [] }) as unknown as { lamps: unknown[]; tiles: string[] };
    assert.equal(none.lamps.length, 0);
    assert.ok(!none.tiles.includes('lamp'));
    const one = Homeland.generate(seed, { open: ['n'], th: 1, built: [], light: 1 }) as unknown as { lamps: Array<{ x: number; y: number }>; tiles: string[]; w: number };
    assert.ok(one.lamps.length >= 3, `seed ${seed}: ${one.lamps.length} lamps`);
    for (const l of one.lamps) {
      assert.equal(one.tiles[l.y * one.w + l.x], 'lamp');
      assert.equal(Homeland.chunkOf(one as never, l.x, l.y).id, 'c', 'level 1 lights the centre only');
    }
    // the portal, the field gate and every building's and open lot's door are still reachable from the spawn
    const m = new HomelandMap(seed, { open: ['n'], th: 1, built: [], light: 1 }), L = m.layout;
    const seen = new Set<string>([`${L.spawn.x},${L.spawn.y}`]), q = [L.spawn];
    while (q.length) {
      const p = q.pop()!;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = `${p.x + dx},${p.y + dy}`;
        if (!seen.has(k) && m.walkable(p.x + dx, p.y + dy)) { seen.add(k); q.push({ x: p.x + dx, y: p.y + dy }); }
      }
    }
    const musts = [L.portal, L.farm.gate, ...L.buildings.map((b) => ({ x: b.dx, y: b.dy + 1 })), ...L.lots.filter((l) => l.chunk === 'c' || l.chunk === 'n').map((l) => ({ x: l.door.x, y: l.door.y + 1 }))];
    for (const p of musts) assert.ok(seen.has(`${p.x},${p.y}`), `seed ${seed}: ${p.x},${p.y} unreachable`);
    const two = Homeland.generate(seed, { open: ['n'], th: 2, built: [], light: 2 }) as unknown as { lamps: Array<{ x: number; y: number }> };
    assert.ok(two.lamps.some((l) => Homeland.chunkOf(two as never, l.x, l.y).id === 'n'), 'level 2 lights the open island too');
    // same progress, same lamps
    assert.deepEqual((Homeland.generate(seed, { open: ['n'], th: 1, built: [], light: 1 }) as unknown as { lamps: unknown }).lamps, one.lamps);
  }
});

test('the owner puts up street lights from the Town Hall; the lamps are solid on the server map', async () => {
  const w = await world();
  const h = w.home(P);
  const th = h.map.layout.buildings.find((b) => b.kind === 'townhall')!;
  const door = { x: th.dx, y: th.dy + 1 };
  const at = (a: string) => { w.game.positions!.setWorld(a, h.wid, door, Date.now()); w.game.reportPosition(a, door, h.wid); w.adv(1000); };
  w.give(P, 'wood', 30); w.give(P, 'ore', 10); w.give(P, 'coin', 100);
  const wood0 = w.bal(P, 'wood');
  at(P);
  w.game.act(P, { world: h.wid, pos: door, action: 'build', kind: 'light', target: 'light' });
  assert.equal(w.bal(P, 'wood'), wood0 - 8);
  // one job at a time, like every builder job
  fails(() => w.game.act(P, { world: h.wid, pos: door, action: 'build', kind: 'light', target: 'light' }), 409, /builder is busy|Already under construction/);
  w.adv(61_000);
  w.game.homelands.settle(P);
  assert.equal(w.game.homelands.lightLevel(P), 1);
  const m = w.game.homelands.map(w.game.homelands.ensure(P));
  const lamps = (m.layout as unknown as { lamps: Array<{ x: number; y: number }> }).lamps;
  assert.ok(lamps.length >= 3);
  for (const l of lamps) assert.equal(m.walkable(l.x, l.y), false);
  assert.equal(w.game.homelands.view(P, P).light, 1);
  // level 2 needs Town Hall level 2
  at(P);
  fails(() => w.game.act(P, { world: h.wid, pos: door, action: 'build', kind: 'light', target: 'light' }), 409, /Town Hall needs level 2/);
});

test('only the owner can put up street lights, even a party Builder cannot', async () => {
  const w = await world();
  const h = w.home(P);
  w.party(P, Q);
  w.game.homelands.setRole(P, 'party', 'builder');
  const th = h.map.layout.buildings.find((b) => b.kind === 'townhall')!;
  const door = { x: th.dx, y: th.dy + 1 };
  w.give(Q, 'wood', 30); w.give(Q, 'ore', 10); w.give(Q, 'coin', 100);
  w.game.positions!.setWorld(Q, h.wid, door, Date.now()); w.game.reportPosition(Q, door, h.wid); w.adv(1000);
  fails(() => w.game.act(Q, { world: h.wid, pos: door, action: 'build', kind: 'light', target: 'light' }), 409, /Only the owner can put up street lights/);
});
