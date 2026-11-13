import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, fails, P, Q, R } from './tradeworld.ts';
import { MockChain, type ListingInfo } from '../src/chain.ts';
import { median, readListings } from '../src/game/trend.ts';
import { standNear } from './coopworld.ts';

type W = Awaited<ReturnType<typeof world>>;
const chainOf = (w: W) => w.game.chain as MockChain;
let nextId = 1;
/** An open listing on the mock chain (the goods are in escrow, like list_item). */
function list(w: W, seller: string, token: string, amount: number, price: number): ListingInfo {
  const c = chainOf(w), id = nextId++;
  const l = { id, seller, token_id: token, amount: String(amount), price_each: String(price), created_ns: 0 };
  c.listings.set(id, l);
  c.add(c.contractId, token, BigInt(amount));
  return l;
}
const DAY_MS = 24 * 60_000;

test('a merchant buys a cheap player listing with its own coin, through the settler call', async () => {
  const w = await world(), c = chainOf(w);
  const sari = w.game.market.account('sari'), cash0 = w.bal(sari, 'coin'), stock0 = w.bal(sari, 'fish');
  const l = list(w, P, 'fish', 4, 6); // fair price is the mid price (8)
  const sold: number[] = [];
  w.game.npc.onSale = (id, _s, units) => sold.push(id, units);
  const n = await w.game.npc.run();
  assert.equal(n, 4);
  assert.deepEqual(c.merchantBuys, [{ merchant: sari, listingId: l.id, amount: 4, maxPriceEach: 6 }]);
  assert.equal(w.bal(sari, 'coin'), cash0 - 24);
  assert.equal(w.bal(sari, 'fish'), stock0 + 4);
  assert.equal(BigInt(w.game.gs.settledBalance(P, 'coin')), c.get(P, 'coin'), 'the seller books follow the chain');
  assert.equal(c.get(P, 'coin'), 23n, '24 coins minus the 5% fee (1)');
  assert.equal(c.listings.size, 0, 'a sold-out listing closes');
  assert.equal(w.game.market.npcBoughtToday(sari, 'fish', w.day()), 4, 'counts against the merchant daily buy cap');
  assert.deepEqual(sold, [l.id, 4]);
  const hist = w.store.history(P, 20) as Array<{ summary: string }>;
  assert.ok(hist.some((h) => /Sarah bought 4 Fish from your Market listing/.test(h.summary)));
});

test('never above the fair price, never a merchant for a good it does not buy', async () => {
  const w = await world(), c = chainOf(w);
  list(w, P, 'fish', 3, 40);      // far above any merchant's mid
  list(w, Q, 'bread', 3, 1);      // nobody buys bread from players
  assert.equal(await w.game.npc.run(), 0);
  assert.equal(c.merchantBuys.length, 0);
  const sari = w.game.market.ids()[0];
  assert.ok(w.game.npc.fairBuy(sari, 'fish') <= Math.ceil(w.econ.items.fish.base * 1.5));
  assert.equal(w.game.npc.fairBuy(sari, 'bread'), 0);
});

test('limits: stock room, share of cash per buy, and a few buys per look', async () => {
  const w = await world(), c = chainOf(w);
  const sari = w.game.market.account('sari');
  list(w, P, 'fish', 50, 1);
  const n = await w.game.npc.run();
  // Sarah has 20 fish (target 20): room to 1.5 x target = 10 more
  assert.equal(n, 10);
  assert.equal(c.merchantBuys.length, 1);
  assert.equal(c.merchantBuys[0].amount, 10);
  assert.ok(w.bal(sari, 'fish') <= Math.floor(20 * w.econ.npcMarket.maxStockOverTarget));
  // cash: a merchant with little coin buys only up to its share of it
  const w2 = await world(), sari2 = w2.game.market.account('sari');
  w2.game.gs.add(w2.day(), sari2, 'coin', -450, 'test'); // 150 left, rent reserve is 3 x 40 = 120
  w2.game.gs.add(w2.day(), sari2, 'fish', -15, 'test');   // stock room is not the limit now
  list(w2, P, 'fish', 40, 3);
  await w2.game.npc.run();
  const spent = 150 - w2.bal(sari2, 'coin');
  assert.ok(spent <= 150 * w2.econ.npcMarket.maxCashPctPerBuy / 100, `spent ${spent} of 150`);
  assert.ok(w2.bal(sari2, 'coin') >= w2.econ.shops.rent * w2.econ.npcMarket.reserveRentDays - 1 || spent === 0);
  // at most maxBuysPerRun purchases in one look
  const w3 = await world();
  for (const [t, a] of [['fish', 1], ['wood', 1], ['ore', 1], ['wheat', 1], ['fish', 1]] as const) list(w3, [P, Q, R][a % 3 === 0 ? 0 : 1], t, 1, 1);
  const wn = await w3.game.npc.run();
  assert.ok(chainOf(w3).merchantBuys.length <= w3.econ.npcMarket.maxBuysPerRun);
  assert.ok(wn >= 1);
});

test('daily spending cap per merchant and daily buy cap are shared with player sales', async () => {
  const w = await world(), sari = w.game.market.account('sari');
  const room = w.game.market.buyRoom('sari', 'fish');
  list(w, P, 'fish', 10, 5);
  await w.game.npc.run();
  assert.equal(w.game.market.buyRoom('sari', 'fish'), room - 10);
  assert.ok(w.game.npc.spentToday(sari, w.day()) > 0);
});

test('rate limited by real time; asks again after a gap', async () => {
  const w = await world(), c = chainOf(w);
  list(w, P, 'fish', 1, 5);
  await w.game.npc.run();
  assert.equal(c.merchantBuys.length, 1);
  list(w, P, 'wood', 1, 1);
  assert.equal(await w.game.npc.run(), 0, 'too soon');
  w.adv(w.econ.npcMarket.everySecs * 1000 + 1);
  assert.ok((await w.game.npc.run()) >= 1);
});

test('contract without the method: stays off quietly, retries later', async () => {
  const w = await world(), c = chainOf(w);
  c.merchantBuyEnabled = false;
  const logs: string[] = [];
  w.game.npc.d.log = (l) => logs.push(l);
  list(w, P, 'fish', 2, 5);
  assert.equal(await w.game.npc.run(), 0);
  assert.equal(w.game.npc.missing, true);
  assert.equal(logs.length, 1);
  assert.equal(c.listings.size, 1);
  // nothing is asked while it is off, even after the rate limit gap
  let asked = 0; const orig = c.merchantBuyListing.bind(c);
  c.merchantBuyListing = async (...a: Parameters<typeof orig>) => { asked++; return orig(...a); };
  w.adv(60_000);
  await w.game.npc.run();
  assert.equal(asked, 0);
  // redeployed: after the wait the buying resumes
  c.merchantBuyEnabled = true;
  w.adv(w.econ.npcMarket.retryMissingMinutes * 60_000 + 1000);
  assert.ok((await w.game.npc.run()) >= 1);
  assert.equal(asked, 1);
});

test('feature flag off: no buying, trend still read', async () => {
  const w = await world();
  w.econ.npcMarket.buyEnabled = false;
  list(w, P, 'fish', 2, 5);
  assert.equal(await w.game.npc.run(), 0);
  assert.equal(chainOf(w).merchantBuys.length, 0);
  w.econ.npcMarket.buyEnabled = true;
});

test('no run while a settlement is busy', async () => {
  const w = await world();
  list(w, P, 'fish', 2, 5);
  w.game.settlement.busy = true;
  assert.equal(await w.game.npc.run(), 0);
  w.game.settlement.busy = false;
  assert.ok((await w.game.npc.run()) >= 1);
});

/* ------------------------------------------------------------ trend */

const L = (seller: string, token: string, price: number): ListingInfo => ({ id: 1, seller, token_id: token, amount: '5', price_each: String(price), created_ns: 0 });

test('trend reading: median over sellers, one seller counts once, needs enough sellers', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 10]), 2.5);
  const spam = [L('a', 'fish', 1), L('a', 'fish', 1), L('a', 'fish', 1), L('a', 'fish', 1), L('b', 'fish', 8), L('c', 'fish', 9)];
  assert.deepEqual(readListings(spam, 3), { fish: 8 }, 'a spammer with four cheap listings is one voice');
  assert.deepEqual(readListings([L('a', 'fish', 8), L('b', 'fish', 8)], 3), {}, 'two sellers are not a market');
  assert.deepEqual(readListings([L('a', 'fish', 8), L('b', 'fish', 99), L('c', 'fish', 8), L('d', 'fish', 9)], 3), { fish: 8.5 }, 'an outlier does not move the median');
});

function feed(w: W, token: string, price: number, times: number) {
  for (let i = 0; i < times; i++) w.game.market.trend.record(['s1', 's2', 's3'].map((s) => L(`${s}.players.test`, token, price)));
}

test('merchant prices follow the trend by at most the daily move, and settle back when listings vanish', async () => {
  const w = await world(), m = w.game.market, c = w.econ.npcMarket.trend;
  assert.equal(m.trend.mult('fish'), 1);
  feed(w, 'fish', 12, 4); // 1.5 x the base value of 8, same day
  const day1 = m.trend.mult('fish');
  assert.ok(day1 > 1 && day1 <= 1 + c.maxMovePctPerDay / 100 + 1e-9, `first day ${day1}`);
  feed(w, 'fish', 12, 2);
  assert.equal(m.trend.mult('fish'), day1, 'no second step on the same day');
  w.adv(DAY_MS); feed(w, 'fish', 12, 1);
  const day2 = m.trend.mult('fish');
  assert.ok(day2 > day1 && day2 - day1 <= c.maxMovePctPerDay / 100 + 1e-9);
  for (let i = 0; i < 40; i++) { w.adv(DAY_MS); feed(w, 'fish', 12, 1); }
  assert.ok(m.trend.mult('fish') <= c.multMax + 1e-9);
  assert.ok(m.trend.mult('fish') > 1.3, 'it gets there, slowly');
  // the pricing input really uses it
  const inp = m.inputs('sari', 'fish', m.row('sari', 'fish'));
  assert.equal(inp.base, w.econ.items.fish.base * m.trend.mult('fish'));
  // nobody lists any more: readings fade and the level drifts back
  const high = m.trend.mult('fish');
  for (let i = 0; i < 12; i++) { w.adv(DAY_MS); m.trend.record([]); }
  assert.ok(m.trend.mult('fish') < high);
});

test('manipulation: a single seller cannot move the trend', async () => {
  const w = await world(), m = w.game.market;
  for (let i = 0; i < 10; i++) { w.adv(DAY_MS); m.trend.record([L('x', 'wood', 300), L('x', 'wood', 300), L('x', 'wood', 300), L('x', 'wood', 300), L('x', 'wood', 300)]); }
  assert.equal(m.trend.mult('wood'), 1);
  assert.equal(m.trend.price('wood'), null);
  assert.equal(m.trend.withdrawn('wood'), false);
});

test('far from normal: merchants stop offering the good until the price comes back; buying from them says why', async () => {
  const w = await world(), m = w.game.market;
  w.give(P, 'coin', 500);
  w.stand(P, 'board');
  const pos = standNear(w.game.map!, w.game.map!.layout.market.stalls[0], 1);
  assert.equal(m.trend.withdrawn('fish'), false);
  feed(w, 'fish', 20, 5); // 2.5 x base 8 for most of the recent readings
  assert.equal(m.trend.withdrawn('fish'), true);
  const view = m.view('sari');
  assert.equal(view.items.find((i) => i.token === 'fish')!.ask, null, 'no sell offer shown');
  fails(() => m.buy(P, 'sari', 'fish', 1), 409, /isn't offering Fish right now/);
  assert.ok(pos);
  // buying other goods is not affected
  m.buy(P, 'sari', 'meal', 1);
  // and the price comes back
  feed(w, 'fish', 8, 6);
  assert.equal(m.trend.withdrawn('fish'), false);
  m.buy(P, 'sari', 'fish', 1);
  // a glut (far below normal) withdraws the offer too
  feed(w, 'wood', 2, 6);
  assert.equal(m.trend.withdrawn('wood'), true);
});

test('trend feature flag off: multiplier stays 1 and nothing is withdrawn', async () => {
  const w = await world();
  w.econ.npcMarket.trendEnabled = false;
  feed(w, 'fish', 40, 6);
  assert.equal(w.game.market.trend.mult('fish'), 1);
  assert.equal(w.game.market.trend.withdrawn('fish'), false);
  w.econ.npcMarket.trendEnabled = true;
});

/* ------------------------------------------------------------ tool stall */

test('tool stall: a new tool or a repair for coin, paid to Ben, priced by the wear', async () => {
  const w = await world(), ex = w.game.extras, ts = w.econ.toolShop, ben = w.game.market.account(ts.merchant);
  w.give(P, 'coin', 300);
  const full = w.econ.tools.axe.durability;
  fails(() => ex.toolStall(P, 'repair', 'axe'), 409, /already like new/);
  fails(() => ex.toolStall(P, 'buy', 'axe'), 409, /already like new/);
  ex.st.setTool(P, 'axe', 0);
  const cash0 = w.bal(ben, 'coin'), mine0 = w.bal(P, 'coin');
  ex.toolStall(P, 'repair', 'axe');
  assert.equal(ex.toolsView(P).axe.uses, full);
  assert.equal(w.bal(P, 'coin'), mine0 - ts.repair.axe, 'a broken tool costs the full repair price');
  assert.equal(w.bal(ben, 'coin'), cash0 + ts.repair.axe);
  ex.st.setTool(P, 'axe', Math.floor(full / 2));
  const m1 = w.bal(P, 'coin');
  ex.toolStall(P, 'repair', 'axe');
  const half = m1 - w.bal(P, 'coin');
  assert.ok(half >= 1 && half < ts.repair.axe, `half worn costs ${half}`);
  ex.st.setTool(P, 'pickaxe', 5);
  const m2 = w.bal(P, 'coin');
  ex.toolStall(P, 'buy', 'pickaxe');
  assert.equal(m2 - w.bal(P, 'coin'), ts.price.pickaxe);
  assert.equal(ex.toolsView(P).pickaxe.uses, w.econ.tools.pickaxe.durability);
  assert.ok(w.game.gs.dayRows(w.day()).some((r) => r.kind === 'tool_shop' && r.account === P));
  fails(() => ex.toolStall(P, 'sell', 'axe'), 400, /Unknown tool shop action/);
  fails(() => ex.toolStall(P, 'buy', 'laser'), 400, /Unknown tool/);
  ex.st.setTool(P, 'hoe', 1);
  w.game.gs.add(w.day(), P, 'coin', -w.bal(P, 'coin'), 'test');
  fails(() => ex.toolStall(P, 'buy', 'hoe'), 409, /Not enough coins/);
});

test('tool stall over the act: only at the merchant stalls, not while the shop is closed', async () => {
  const w = await world(), g = w.game;
  w.give(P, 'coin', 100);
  g.extras.st.setTool(P, 'rod', 1);
  const far = w.stand(P, 'board', 12);
  fails(() => g.act(P, { action: 'toolshop', op: 'repair', tool: 'rod', pos: far }), 409, /stalls in the market/);
  const pos = standNear(g.map!, g.map!.layout.market.stalls[1], 1);
  g.positions!.reset(P); g.reportPosition(P, pos, 'public');
  const r = g.act(P, { action: 'toolshop', op: 'repair', tool: 'rod', pos }) as { toast: string };
  assert.match(r.toast, /repaired by Ben/);
  g.extras.st.setTool(P, 'rod', 1);
  g.market.closed.add(g.market.account(w.econ.toolShop.merchant));
  fails(() => g.act(P, { action: 'toolshop', op: 'repair', tool: 'rod', pos }), 409, /CLOSED/);
});

/* ------------------------------------------------------------ the consignment stall is gone */

test('goods left in the old consignment stall go back to their owners once, with ledger rows', async () => {
  const w = await world(), gs = w.game.gs;
  const { returnConsignedGoods } = await import('../src/game/consign-return.ts');
  gs.db.exec('CREATE TABLE consign_lots (account TEXT NOT NULL, token TEXT NOT NULL, qty INTEGER NOT NULL, min_price INTEGER NOT NULL, sold INTEGER NOT NULL DEFAULT 0, earned INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account, token))');
  gs.add(w.day(), 'town.gt.test', 'fish', 7, 'consign_in', 'x');
  gs.db.prepare('INSERT INTO consign_lots (account, token, qty, min_price) VALUES (?, ?, ?, ?)').run(P, 'fish', 7, 5);
  gs.db.prepare('INSERT INTO consign_lots (account, token, qty, min_price) VALUES (?, ?, ?, ?)').run(Q, 'wood', 0, 5);
  const town0 = w.bal('town.gt.test', 'fish'), p0 = w.bal(P, 'fish');
  const said: string[] = [];
  const n = returnConsignedGoods(gs, w.game.clock, 'town.gt.test', (t) => t, (a, s) => said.push(`${a}:${s}`));
  assert.equal(n, 1);
  assert.equal(w.bal(P, 'fish'), p0 + 7);
  assert.equal(w.bal('town.gt.test', 'fish'), town0 - 7);
  assert.ok(gs.dayRows(w.day()).some((r) => r.kind === 'consign_return' && r.account === P && r.delta === 7));
  assert.equal(said.length, 1);
  assert.equal(returnConsignedGoods(gs, w.game.clock, 'town.gt.test', (t) => t, () => {}), 0, 'idempotent: the table is gone');
  assert.equal(w.bal(P, 'fish'), p0 + 7);
});
