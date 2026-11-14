import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { MockChain } from '../src/chain.ts';
import { Game } from '../src/game/game.ts';
import { loadEcon } from '../src/game/econ.ts';

const TOWN = 'town.gt.test';
const P = 'p1.players.test';
const SARI = 'sari.gt.test';
const BUDI = 'budi.gt.test';

async function world() {
  const econ = loadEcon();
  econ.homeland.publicTradeOnly = false;
  // pinned numbers: the tests do not follow later tuning of economy/config.json
  Object.assign(econ.shops, { chargeRent: true, rentBase: 15, rentSalesPct: 12, rentRampAfterDays: 7, rentRampPerDay: 2, rentRampMax: 60, storageFeePerUnit: 0 });
  const chain = new MockChain();
  const base = Object.fromEntries(Object.entries(econ.items).map(([t, i]) => [t, i.base]));
  chain.accounts.add(TOWN);
  chain.add(TOWN, 'coin', 5000n);
  for (const [id, d] of Object.entries(econ.merchants)) chain.addMerchant(`${id}.gt.test`, d.shop, { coin: d.restore.coin, ...d.restore.items }, { coin: d.startCash, ...d.startStock }, base);
  const store = new Store(':memory:');
  const now = 1_800_000_000_000;
  const game = new Game(store, chain, { merchantParent: 'gt.test', town: TOWN, now: () => now, rng: () => 0.99, econ, chunkSize: 5 });
  await game.init();
  store.addPlayer(P, 'sub-' + P, 'ed25519:o');
  await chain.registerPlayer(P);
  game.onNewPlayer(P);
  return { econ, chain, game };
}

const prepare = (g: Game, day: number) => (g.settlement as unknown as { prepare(d: number): void }).prepare(day);
const rentRows = (g: Game, day: number) => g.gs.dayRows(day).filter((r) => r.kind === 'rent');
const drain = (g: Game, day: number, acct: string, leave: number) => g.gs.add(day, acct, 'coin', -(g.gs.balance(acct, 'coin') - leave), 'test');

test('sales are the coin a merchant received from selling, nothing else', async () => {
  const { game } = await world();
  const day = game.clock.time().settleDay;
  game.gs.add(day, SARI, 'coin', 100, 'trade', 'sari:bread:1@100'); // a player bought
  game.gs.add(day, SARI, 'coin', 40, 'town_buy', 'bread');
  game.gs.add(day, SARI, 'coin', 30, 'resident_sale', 'x:bread');
  game.gs.add(day, SARI, 'coin', 20, 'tool_shop', 'buy:axe');
  game.gs.add(day, SARI, 'coin', -500, 'trade', 'sari:fish:5@100'); // the merchant buying is not a sale
  game.gs.add(day, SARI, 'coin', 999, 'admin_grant', 'x');
  game.gs.add(day, SARI, 'coin', 999, 'restore', 'x');
  game.gs.add(day, SARI, 'coin', 999, 'dividend', 'x');
  game.gs.add(day + 1, SARI, 'coin', 999, 'trade', 'later day');
  assert.equal(game.market.salesOn(day, 'sari'), 190);
});

test("rent is base + a share of the day's sales, paid merchant -> town, netting to zero", async () => {
  const { game } = await world();
  const day = game.clock.time().settleDay;
  game.gs.add(day, SARI, 'coin', 1000, 'trade', 'sari:bread:10@100');
  const sariBefore = game.gs.balance(SARI, 'coin'), townBefore = game.gs.balance(TOWN, 'coin');
  prepare(game, day);
  const rows = rentRows(game, day);
  assert.equal(rows.reduce((s, r) => s + r.delta, 0), 0, 'rent moves coin, it does not burn or mint it');
  const mine = rows.find((r) => r.account === SARI)!;
  assert.equal(mine.delta, -(15 + 120));
  assert.equal(game.gs.balance(SARI, 'coin'), sariBefore - 135);
  assert.ok(game.gs.balance(TOWN, 'coin') >= townBefore + 135, 'the town treasury got it');
  assert.match(mine.ref ?? '', /base 15/);
});

test('storage is added to the rent', async () => {
  const { game } = await world();
  game.econ.shops.storageFeePerUnit = 0.5;
  const day = game.clock.time().settleDay;
  const o = game.market.rentDue(day, 'sari');
  game.gs.add(day, SARI, game.market.tokens(game.econ.merchants.sari)[0], 100, 'test');
  const o2 = game.market.rentDue(day, 'sari');
  assert.ok(o2.storage > o.storage);
  assert.equal(o2.due, o2.base + o2.ramp + o2.salesPart + o2.storage);
});

test('a merchant whose cash is below what it owes is put on the close list and closes', async () => {
  const { game } = await world();
  const day = game.clock.time().settleDay;
  drain(game, day, BUDI, 10);
  prepare(game, day);
  assert.deepEqual(JSON.parse(game.gs.meta(`settle.close.${day}`)!), [BUDI]);
  assert.equal(rentRows(game, day).find((r) => r.account === BUDI)!.delta, -10, 'pays what it has');
  assert.equal(game.gs.meta('shops.lastCloseDay'), String(day));
  // and the whole settlement closes it on chain
  const g2 = await world();
  const d2 = g2.game.clock.time().settleDay;
  drain(g2.game, d2, BUDI, 10);
  g2.game.gs.add(d2, BUDI, 'tool', -g2.game.gs.balance(BUDI, 'tool'), 'test');
  await g2.game.devSettle();
  assert.equal((await g2.chain.listShops()).find((s) => s.account_id === BUDI)!.open, false);
  assert.ok(g2.game.market.closed.has(BUDI));
});

test('the ramp grows after rentRampAfterDays without a closing, is capped, and resets after a closing', async () => {
  const { game } = await world();
  const day = game.clock.time().settleDay;
  for (const [streak, ramp] of [[0, 0], [7, 0], [8, 2], [10, 6], [36, 58], [37, 60], [500, 60]] as const) {
    game.gs.setMeta('shops.rentStreak', String(streak));
    assert.equal(game.market.rentRamp(), ramp, `streak ${streak}`);
  }
  game.gs.setMeta('shops.rentStreak', '10');
  assert.equal(game.market.rentDue(day, 'sari').due, 15 + 6);
  prepare(game, day); // nobody closes: one more day without a closing
  assert.equal(game.gs.meta('shops.rentStreak'), '11');
  assert.equal(rentRows(game, day).find((r) => r.account === SARI)!.delta, -(15 + 6));
  const d2 = day + 1;
  game.gs.add(d2, P, 'wood', 1, 'noop'); // a player is active that day
  drain(game, d2, BUDI, 1);
  prepare(game, d2);
  assert.equal(game.gs.meta('shops.rentStreak'), '0', 'a closing resets the ramp');
  assert.equal(game.market.rentRamp(), 0);
});

test('no rent on an idle day, and idle days do not count toward the ramp', async () => {
  const { game } = await world();
  await game.devSettle(); // the day with the starter kit: players were active
  const first = game.settlement.settledThrough();
  assert.ok(rentRows(game, first).length > 0);
  assert.equal(game.gs.meta('shops.rentStreak'), '1');
  const idleDay = first + 5;
  prepare(game, idleDay); // nobody played that day
  assert.equal(rentRows(game, idleDay).length, 0);
  assert.equal(game.gs.meta('shops.rentStreak'), '1');
});
