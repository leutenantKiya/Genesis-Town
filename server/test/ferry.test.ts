// The ferry to the island in the village's bottom-right corner: stand beside a boat, row to the other shore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, P, fails } from './coopworld.ts';
import { Village } from '../src/game/worldmap.ts';

test('the boat takes a player from the mainland to the island and back, only from beside a boat', async () => {
  const w = await world();
  const f = Village.ferryOf(w.game.map!.layout);
  assert.ok(f, 'the village has an island reached by boat');
  w.game.positions!.setWorld(P, 'public', f!.a, Date.now());
  w.adv(60_000);
  const r = w.game.act(P, { action: 'boat', world: 'public', pos: f!.a }) as any;
  assert.deepEqual(r.arrive, f!.b);
  w.adv(60_000);
  assert.deepEqual((w.game.act(P, { action: 'boat', world: 'public', pos: f!.b }) as any).arrive, f!.a);
  w.adv(60_000);
  fails(() => w.game.act(P, { action: 'boat', world: 'public', pos: w.game.map!.layout.spawn }), 409, /next to the boat|Too far|far/i);
});
