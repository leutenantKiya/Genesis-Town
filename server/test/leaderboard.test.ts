import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, P, Q, R } from './tradeworld.ts';

test('leaderboard counts sells and consign sales, ranks by quantity', async () => {
  const w = await world();
  w.give(P, 'fish', 20); w.give(Q, 'fish', 20); w.give(R, 'fish', 20);
  const m = w.game.market.ids().find((id) => w.econ.merchants[id].buys.includes('fish'))!;
  w.game.market.sell(P, m, 'fish', 2);
  w.game.market.sell(Q, m, 'fish', 1);
  w.stand(Q, 'consign');
  w.game.consign.deposit(Q, 'fish', 4, 1);
  w.game.consign.tick(); // 3 sell
  assert.equal(w.game.consign.lots(Q)[0].sold, 3);
  // R sells 5 fish to P for coin
  w.stand(R, 'consign'); w.stand(P, 'consign', 1);
  w.give(P, 'coin', 10);
  const o = w.game.trade.offer(R, { to: P, give: { fish: 5 }, want: { coin: 10 } });
  w.game.trade.accept(P, o.id);
  const b = w.game.leaderboard('day', P);
  assert.equal(b.period, 'day');
  assert.deepEqual(b.rows.map((r) => [r.account, r.sold_qty]), [[R, 5], [Q, 4], [P, 2]]);
  assert.deepEqual(b.rows.map((r) => r.rank), [1, 2, 3]);
  assert.equal(b.rows[0].name, 'Citra');
  assert.equal(b.rows[0].coin, 10);
  assert.equal(b.me?.rank, 3);
  const all = w.game.leaderboard('all', null);
  assert.equal(all.rows.length, 3);
  assert.equal(all.me, null);
});

test('leaderboard shows own rank beyond top 10', async () => {
  const w = await world();
  const m = w.game.market.ids().find((id) => w.econ.merchants[id].buys.includes('fish'))!;
  w.give(P, 'fish', 1);
  w.game.market.sell(P, m, 'fish', 1);
  for (let i = 0; i < 11; i++) {
    const a = `x${i}.players.test`;
    w.game.gs.add(w.day(), a, 'fish', 5, 'test');
    w.game.gs.add(w.day(), a, 'fish', -3, 'trade', `${m}:fish:3@1`);
    w.game.gs.add(w.day(), a, 'coin', 3, 'trade', `${m}:fish:3@1`);
  }
  const b = w.game.leaderboard('day', P);
  assert.equal(b.rows.length, 10);
  assert.equal(b.me?.rank, 12);
  assert.equal(b.me?.sold_qty, 1);
});
