import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, fails, P, TOWN } from './tradeworld.ts';

/** Best merchant bid for a token, as the consignment tick sees it. */
const bid = (w: Awaited<ReturnType<typeof world>>, token: string) =>
  Math.max(...w.game.market.ids().filter((id) => w.econ.merchants[id].buys.includes(token)).map((id) => w.game.market.row(id, token).bid));

test('consign sells only at or above min price, fee to town', async () => {
  const w = await world();
  w.give(P, 'fish', 10);
  w.stand(P, 'consign');
  const b = bid(w, 'fish');
  assert.ok(b >= 1);
  w.game.consign.deposit(P, 'fish', 5, b + 1);
  assert.equal(w.bal(P, 'fish'), 5);
  w.game.consign.tick();
  assert.equal(w.game.consign.lots(P)[0].sold, 0); // price too low
  w.game.consign.deposit(P, 'fish', 1, b); // lower the minimum: now it sells
  const coin0 = w.bal(P, 'coin'), town0 = w.bal(TOWN, 'coin');
  w.game.consign.tick();
  const lot = w.game.consign.lots(P)[0];
  assert.equal(lot.sold, 3); // sellPerGameHour
  const gross = 3 * b, fee = Math.floor((gross * 500) / 10000);
  assert.equal(w.bal(P, 'coin') - coin0, gross - fee);
  assert.equal(w.bal(TOWN, 'coin') - town0, fee);
  assert.equal(lot.earned, gross - fee);
  assert.ok(w.game.gs.dayRows(w.day()).some((r) => r.kind === 'consign_sale' && r.account === P));
});

test('consign never sells more than deposited, withdraw returns the rest', async () => {
  const w = await world();
  w.give(P, 'fish', 10);
  w.stand(P, 'consign');
  const f0 = w.bal(P, 'fish');
  w.game.consign.deposit(P, 'fish', 4, 1);
  for (let i = 0; i < 5; i++) w.game.consign.tick();
  let lot = w.game.consign.lots(P)[0];
  assert.equal(lot.sold, 4);
  assert.equal(lot.qty, 0);
  w.game.consign.deposit(P, 'fish', 2, 100000);
  w.game.consign.tick();
  assert.equal(w.game.consign.lots(P)[0].sold, 4);
  w.game.consign.withdraw(P, 'fish');
  lot = w.game.consign.lots(P)[0];
  assert.equal(lot.qty, 0);
  assert.equal(w.bal(P, 'fish'), f0 - 4); // 4 sold, the 2 deposited later came back
  fails(() => w.game.consign.withdraw(P, 'fish'), 409, /./);
});

test('consign needs the stall, the items and respects the per-item cap', async () => {
  const w = await world();
  w.give(P, 'fish', 100);
  w.stand(P, 'board', 9);
  fails(() => w.game.consign.deposit(P, 'fish', 1, 1), 409, /Titip Jual/);
  w.stand(P, 'consign');
  fails(() => w.game.consign.deposit(P, 'fish', 51, 1), 409, /maks/i);
  fails(() => w.game.consign.deposit(P, 'coin', 1, 1), 400, /./);
  fails(() => w.game.consign.deposit(P, 'fish', 1, 0), 400, /./);
  fails(() => w.game.consign.deposit(P, 'fish', 500, 1), 409, /./);
  w.game.consign.deposit(P, 'fish', 50, 1);
  fails(() => w.game.consign.deposit(P, 'fish', 1, 1), 409, /maks/i);
});

test('consign sales use up the merchants daily buy cap and stop at it', async () => {
  const w = await world();
  w.give(P, 'fish', 50);
  w.stand(P, 'consign');
  const buyers = w.game.market.ids().filter((id) => w.econ.merchants[id].buys.includes('fish'));
  const day = w.day();
  for (const id of buyers) { // leave room for exactly one unit per merchant
    const room = w.game.market.buyRoom(id, 'fish');
    w.game.gs.setMeta(`consign.bought.${day}.${w.game.market.account(id)}.fish`, String(room - 1));
  }
  w.game.consign.deposit(P, 'fish', 50, 1);
  for (let i = 0; i < 20; i++) w.game.consign.tick();
  assert.equal(w.game.consign.lots(P)[0].sold, buyers.length);
  for (const id of buyers) {
    assert.equal(w.game.market.buyRoom(id, 'fish'), 0);
    assert.throws(() => w.game.market.sell(P, id, 'fish', 1), (e: any) => e.status === 409 && /sudah cukup membeli/.test(e.message));
  }
});

test('withdraw answers 409 when returning the items would pass the daily gain cap', async () => {
  const w = await world();
  w.give(P, 'fish', 50);
  w.stand(P, 'consign');
  w.game.consign.deposit(P, 'fish', 50, 100000);
  w.adv(25 * 60 * 1000); // next game day: the deposit no longer offsets today's gains
  w.give(P, 'fish', 180);
  fails(() => w.game.consign.withdraw(P, 'fish'), 409, /Batas harian Ikan tercapai\. Ambil sisanya besok\./);
  assert.equal(w.game.consign.lots(P)[0].qty, 50);
});
