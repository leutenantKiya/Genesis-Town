// The luck table (Meja Untung) in the market: stake goods, win the same again or lose the stake; never coin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, P, fails } from './coopworld.ts';

test('a bet at the luck table wins or burns the stake, only goods, only by the table, within the daily limit', async () => {
  const w = await world();
  const g = w.game, lm = g.map!.landmarks().gamble, pos = { x: lm.x, y: lm.y + 1 };
  g.gs.add(1, P, 'fish', 50, 'test');
  g.positions!.setWorld(P, 'public', pos, Date.now());
  const bet = (qty: number, token = 'fish', at = pos) => { w.adv(2_000); return g.act(P, { action: 'gamble', token, qty, world: 'public', pos: at }) as any; };
  let rolls = [0.1, 0.9];
  g.rng = () => rolls.shift() ?? 0.9;
  const before = g.gs.balance(P, 'fish');
  assert.equal(bet(3).win, true);
  assert.equal(g.gs.balance(P, 'fish'), before + 3);
  assert.equal(bet(2).win, false);
  assert.equal(g.gs.balance(P, 'fish'), before + 1);
  fails(() => bet(1, 'coin'), 400, 'That cannot be staked.');
  fails(() => bet(6), 400, 'Stake 1 to 5.');
  fails(() => bet(1, 'fish', g.map!.layout.spawn), 409, 'Come to the luck table at the market.');
  for (let i = 2; i < 20; i++) bet(1);
  fails(() => bet(1), 409, 'No more bets today. Come back tomorrow.');
});
