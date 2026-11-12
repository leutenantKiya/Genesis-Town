// The hoe (cangkul): grass inside a Homeland's farm fence becomes tilled ground, kept in the Homeland's state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, P, fails } from './coopworld.ts';

test('the hoe tills grass inside the farm fence only, once, and the view lists it', async () => {
  const w = await world();
  const h = w.enter(P, P), L = h.map.layout, f = L.farm as any;
  let spot: { x: number; y: number } | null = null;
  for (let y = f.y0 + 1; y < f.y1 && !spot; y++) for (let x = f.x0 + 1; x < f.x1 && !spot; x++) if (L.tiles[y * L.w + x] === 'grass') spot = { x, y };
  assert.ok(spot, 'there is grass inside the fence');
  const pos = { x: spot!.x, y: spot!.y + 1 };
  w.game.positions!.setWorld(P, h.wid, pos, Date.now()); w.adv(60_000);
  const r = w.game.act(P, { action: 'hoe', x: spot!.x, y: spot!.y, world: h.wid, pos }) as any;
  assert.deepEqual(r.tilled, [[spot!.x, spot!.y]]);
  assert.deepEqual(w.game.homelands.view(P).tilled, [[spot!.x, spot!.y]]);
  w.adv(5_000);
  fails(() => w.game.act(P, { action: 'hoe', x: spot!.x, y: spot!.y, world: h.wid, pos }), 409, 'Already hoed.');
  w.adv(5_000);
  fails(() => w.game.act(P, { action: 'hoe', x: f.x0, y: spot!.y, world: h.wid, pos: { x: f.x0 + 1, y: spot!.y } }), 409, 'Use the hoe inside the farm fence.');
  w.adv(5_000);
  fails(() => w.game.act(P, { action: 'hoe', x: spot!.x, y: spot!.y, world: 'public', pos: w.game.map!.layout.spawn }), 409, /Homeland farm|not in that world/);
});
