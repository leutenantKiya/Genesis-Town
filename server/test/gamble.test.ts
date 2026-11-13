// The Luck Table (Meja Untung) in the market now plays for chips only, in the browser. The server act `gamble` is closed:
// goods and coin can no longer be staked, nothing is taken and nothing is paid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, P, fails } from './coopworld.ts';

test('the luck table act refuses every stake: no goods, no coin, nothing moves', async () => {
  const w = await world();
  const g = w.game, lm = g.map!.landmarks().gamble, pos = { x: lm.x, y: lm.y + 1 };
  g.gs.add(1, P, 'fish', 50, 'test');
  g.gs.add(1, P, 'coin', 50, 'test');
  g.positions!.setWorld(P, 'public', pos, Date.now());
  const fish = g.gs.balance(P, 'fish'), coin = g.gs.balance(P, 'coin');
  const bet = (body: Record<string, unknown>) => { w.adv(2_000); return g.act(P, { action: 'gamble', world: 'public', pos, ...body }) as any; };
  fails(() => bet({ token: 'fish', qty: 1 }), 409, 'The Luck Table now plays for chips only.');
  fails(() => bet({ token: 'coin', qty: 1 }), 409, 'The Luck Table now plays for chips only.');
  fails(() => bet({ token: 'fish', qty: 3, at: 'casino' }), 409, 'The Luck Table now plays for chips only.');
  assert.equal(g.gs.balance(P, 'fish'), fish);
  assert.equal(g.gs.balance(P, 'coin'), coin);
  assert.equal((g.econ as any).gamble, undefined, 'no gamble config is left to stake from');
});
