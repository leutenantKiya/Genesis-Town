import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, fails, P, Q, R } from './tradeworld.ts';

test('trade swaps items and coin atomically', async () => {
  const w = await world();
  w.give(P, 'fish', 5); w.give(Q, 'coin', 100);
  w.stand(P, 'consign'); w.stand(Q, 'consign', 1);
  const pc = w.bal(P, 'coin'), qc = w.bal(Q, 'coin'), pf = w.bal(P, 'fish'), qf = w.bal(Q, 'fish');
  const o = w.game.trade.offer(P, { to: 'Budi#' + w.store.tagOf(Q), give: { fish: 5 }, want: { coin: 40 } });
  assert.ok(o.id > 0 && o.expires_at > 0);
  const list = w.game.trade.list(Q);
  assert.equal(list.incoming.length, 1);
  assert.equal(list.incoming[0].from, 'Ani');
  assert.equal(w.game.trade.list(P).outgoing.length, 1);
  w.game.trade.accept(Q, o.id);
  assert.equal(w.bal(P, 'fish'), pf - 5);
  assert.equal(w.bal(Q, 'fish'), qf + 5);
  assert.equal(w.bal(P, 'coin'), pc + 40);
  assert.equal(w.bal(Q, 'coin'), qc - 40);
  assert.equal(w.game.gs.dayRows(w.day()).filter((r) => r.kind === 'trade').length, 4);
  assert.equal(w.game.trade.list(Q).incoming.length, 0);
});

test('accept fails when offerer spent the items', async () => {
  const w = await world();
  w.give(P, 'fish', 5); w.give(Q, 'coin', 100);
  w.stand(P, 'consign'); w.stand(Q, 'consign', 1);
  const o = w.game.trade.offer(P, { to: Q, give: { fish: 5 }, want: { coin: 40 } });
  w.game.gs.add(w.day(), P, 'fish', -(w.bal(P, 'fish') - 2), 'test'); // P spends down to 2
  const snap = () => [w.bal(P, 'fish'), w.bal(Q, 'coin'), w.bal(P, 'coin'), w.bal(Q, 'fish')];
  const before = snap();
  fails(() => w.game.trade.accept(Q, o.id), 409, /Ikan.* kurang\./);
  assert.deepEqual(snap(), before);
  // the receiver is short of coin
  w.give(P, 'fish', 10);
  const o2 = w.game.trade.offer(P, { to: Q, give: { fish: 1 }, want: { coin: 5000 } });
  fails(() => w.game.trade.accept(Q, o2.id), 409, /Koin kurang\./);
  assert.deepEqual(snap(), [before[0] + 10, before[1], before[2], before[3]]);
});

test('double accept: second answers 409', async () => {
  const w = await world();
  w.give(P, 'fish', 5);
  w.stand(P, 'consign'); w.stand(Q, 'consign', 1);
  const o = w.game.trade.offer(P, { to: Q, give: { fish: 5 }, want: {} });
  w.game.trade.accept(Q, o.id);
  fails(() => w.game.trade.accept(Q, o.id), 409, /sudah/);
  fails(() => w.game.trade.accept(R, o.id), 404, /./); // not the receiver
  assert.equal(w.game.gs.dayRows(w.day()).filter((r) => r.kind === 'trade' && r.token === 'fish' && r.account === Q).length, 1);
});

test('expired offer answers 409', async () => {
  const w = await world();
  w.give(P, 'fish', 5);
  w.stand(P, 'consign'); w.stand(Q, 'consign', 1);
  const o = w.game.trade.offer(P, { to: Q, give: { fish: 5 }, want: {} });
  w.adv(121_000);
  fails(() => w.game.trade.accept(Q, o.id), 409, 'Tawaran kedaluwarsa.');
  assert.equal(w.game.trade.list(Q).incoming.length, 0);
});

test('trade only in public and near each other', async () => {
  const w = await world();
  w.give(P, 'fish', 5);
  w.stand(P, 'consign'); w.stand(Q, 'consign', 8); // far apart
  fails(() => w.game.trade.offer(P, { to: Q, give: { fish: 1 }, want: {} }), 409, 'Kalian harus berdekatan di area publik.');
  w.stand(Q, 'consign', 1);
  const o = w.game.trade.offer(P, { to: Q, give: { fish: 1 }, want: {} });
  w.stand(Q, 'consign', 8);
  fails(() => w.game.trade.accept(Q, o.id), 409, 'Kalian harus berdekatan di area publik.');
  // in a Homeland
  const row = w.game.homelands.ensure(Q);
  w.game.positions!.setWorld(Q, `HL-${row.id}`, w.game.homelands.map(row).layout.spawn, Date.now());
  fails(() => w.game.trade.accept(Q, o.id), 409, 'Kalian harus berdekatan di area publik.');
  // validation
  fails(() => w.game.trade.offer(P, { to: P, give: { fish: 1 }, want: {} }), 400, /./);
  fails(() => w.game.trade.offer(P, { to: 'Nobody#12345', give: { fish: 1 }, want: {} }), 404, /./);
  fails(() => w.game.trade.offer(P, { to: Q, give: { nope: 1 }, want: {} }), 400, /./);
  fails(() => w.game.trade.offer(P, { to: Q, give: { fish: 0 }, want: {} }), 400, /./);
});

test('cancel by either side', async () => {
  const w = await world();
  w.give(P, 'fish', 5);
  w.stand(P, 'consign'); w.stand(Q, 'consign', 1);
  const o = w.game.trade.offer(P, { to: Q, give: { fish: 1 }, want: {} });
  fails(() => w.game.trade.cancel(R, o.id), 404, /./);
  w.game.trade.cancel(Q, o.id);
  fails(() => w.game.trade.accept(Q, o.id), 409, /sudah/);
});
