// Players in a party can always walk back to the public area through a portal, from their own Homeland or a mate's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, standNear, P, Q } from './coopworld.ts';

const go = (w: Awaited<ReturnType<typeof world>>, a: string, from: string, fromMap: any, to: string) => {
  w.adv(60_000);
  return w.game.act(a, { action: 'travel', to, world: from, pos: standNear(fromMap, fromMap.portal(), 1) }) as any;
};

test('a party member goes from the public area to a mate\'s Homeland and back to the public area', async () => {
  const w = await world();
  const h = w.home(P);
  w.party(P, Q);
  assert.equal(go(w, Q, 'public', w.game.map!, h.wid).world, h.wid);
  assert.equal(go(w, Q, h.wid, h.map, 'public').world, 'public');
  assert.equal(w.game.state(Q).worldId, 'public');
});

test('the party leader goes from their own Homeland to the public area', async () => {
  const w = await world();
  const h = w.home(P);
  w.party(P, Q);
  assert.equal(go(w, P, 'public', w.game.map!, h.wid).world, h.wid);
  assert.equal(go(w, P, h.wid, h.map, 'public').world, 'public');
});
