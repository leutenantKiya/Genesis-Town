import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, P, fails } from './coopworld.ts';

type W = Awaited<ReturnType<typeof world>>;

// The client shows the Workbench in every building marked as yours: in a Homeland that is the Town Hall and Rumahmu.
// Crafting from either door works; anywhere else it is refused.
async function craftAt(w: W, door: { x: number; y: number }, wid: string) {
  w.game.positions!.setWorld(P, wid, door, Date.now());
  w.game.reportPosition(P, door, wid);
  w.adv(1000);
  const p = w.game.world.state(P); p.energy = 100; w.game.gs.savePlayer(p);
  return w.game.act(P, { world: wid, pos: door, action: 'craft', recipe: 'bread' }) as { ok?: boolean };
}

test('a Homeland owner crafts at the Workbench in the Town Hall and in Rumahmu', async () => {
  const w = await world();
  const h = w.home(P);
  const own = h.map.layout.buildings.filter((b) => b.own);
  assert.deepEqual(own.map((b) => b.kind).sort(), ['house', 'townhall']);
  w.give(P, 'wheat', 10);
  for (const b of own) {
    const before = w.bal(P, 'bread');
    await craftAt(w, { x: b.dx, y: b.dy + 1 }, h.wid);
    assert.equal(w.bal(P, 'bread'), before + 1, `crafted from the ${b.kind}`);
  }
  // a walkable tile a few steps from both doors
  const L = h.map.layout, far = (x: number, y: number) => own.every((b) => Math.abs(x - b.dx) + Math.abs(y - b.dy - 1) > 3);
  let sp: { x: number; y: number } | null = null;
  for (let y = 0; y < L.h && !sp; y++) for (let x = 0; x < L.w && !sp; x++) if (h.map.walkable(x, y) && far(x, y)) sp = { x, y };
  assert.ok(sp && !h.map.atWorkbench(sp));
  w.game.positions!.setWorld(P, h.wid, sp!, Date.now());
  w.adv(1000);
  fails(() => w.game.act(P, { world: h.wid, pos: sp, action: 'craft', recipe: 'bread' }), 409, /Workbench is in your Town Hall and in your house/);
  // raising the Town Hall still needs its own door, not the house's
  const house = own.find((b) => b.kind === 'house')!;
  assert.equal(h.map.atOwnHouse({ x: house.dx, y: house.dy + 1 }), false);
});
