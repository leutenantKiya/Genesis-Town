// The Mall in the market sells worker gear (the Homeland cosmetics) from the public village.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, P, fails } from './coopworld.ts';

test('the Mall dresses your Town Hall builder from the market, only by the Mall', async () => {
  const w = await world();
  const g = w.game, lm = g.map!.landmarks().mall, pos = { x: lm.x, y: lm.y + 1 };
  g.homelands.ensure(P); g.gs.add(1, P, 'coin', 1000, 'test');
  g.positions!.setWorld(P, 'public', pos, Date.now()); w.adv(60_000);
  const coin = g.gs.balance(P, 'coin');
  g.act(P, { action: 'mall', bot: 0, cosmetic: 'helm', world: 'public', pos });
  assert.equal(g.gs.balance(P, 'coin'), coin - 400);
  assert.equal(g.gs.cosmeticsOf(P)[0], 'helm');
  w.adv(2_000);
  fails(() => g.act(P, { action: 'mall', bot: 0, cosmetic: 'syal', world: 'public', pos: g.map!.layout.spawn }), 409, 'Come to the Mall at the market.');
});
