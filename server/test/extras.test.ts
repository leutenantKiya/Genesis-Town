// Paid entertainment (carousel ride, casino pass), Mall cosmetics, missions and the town news.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, P, Q, fails, standNear } from './coopworld.ts';

async function setup() {
  const w = await world();
  const g = w.game;
  const l = g.map!.landmarks();
  const mall = { x: l.mall.x, y: l.mall.y + 1 };
  const car = (g.map!.layout as any).fun.carousel as { x0: number; y0: number; x1: number; y1: number };
  const carPos = standNear(g.map!, { x: car.x0, y: car.y1 + 1 }, 2);
  const at = (a: string, pos: { x: number; y: number }) => { g.positions!.setWorld(a, 'public', pos, Date.now()); w.adv(60_000); return pos; };
  const act = (a: string, body: Record<string, unknown>, pos?: { x: number; y: number }) => { w.adv(2_000); return g.act(a, { world: 'public', pos: pos ?? g.positions!.lastOf(a), ...body }) as any; };
  const coin = (a: string) => g.gs.balance(a, 'coin');
  return { ...w, g, mall, carPos, at, act, coin };
}
const TOWN = 'town.gt.test';

test('the carousel costs coin, short of coin it is refused, and it must be ridden in the square', async () => {
  const s = await setup();
  const price = s.econ.fun.ride;
  s.at(P, s.carPos);
  const before = s.coin(P), town = s.coin(TOWN);
  const r = s.act(P, { action: 'ride' }, s.carPos);
  assert.equal(s.coin(P), before - price);
  assert.equal(s.coin(TOWN), town + price, 'the fee goes to the town fund');
  assert.deepEqual(r.ride, { secs: s.econ.fun.rideSecs, price });
  s.g.gs.add(1, Q, 'coin', -s.coin(Q) + price - 1, 'test'); // one coin short
  s.at(Q, s.carPos);
  fails(() => s.act(Q, { action: 'ride' }, s.carPos), 409, /Not enough coins/);
  assert.equal(s.coin(Q), price - 1);
  const far = s.g.map!.layout.spawn;
  s.at(P, far);
  fails(() => s.act(P, { action: 'ride' }, far), 409, 'Come to the carousel in the square.');
});

test('the casino entry charges once for a timed pass; the luck table inside the casino needs the pass', async () => {
  const s = await setup();
  const f = s.econ.fun, cb = s.g.map!.layout.buildings.find((b) => b.kind === 'casino')!, pos = { x: cb.dx, y: cb.dy + 1 }; // the village has a Casino building: enter at its door
  s.at(P, pos);
  const before = s.coin(P);
  const r = s.act(P, { action: 'casino', op: 'enter' }, pos);
  assert.equal(s.coin(P), before - f.casino);
  const again = s.act(P, { action: 'casino', op: 'enter' }, pos);
  assert.equal(s.coin(P), before - f.casino, 'a running pass is not charged twice');
  assert.equal(again.casino.until, r.casino.until);
  assert.equal(s.g.state(P).casinoPass, r.casino.until);
  assert.ok(Math.abs(r.casino.until - s.g.now() - f.casinoPassMinutes * 60_000) < 5_000, 'the pass lasts the configured minutes');
  // after it expires, entering charges again
  s.adv(f.casinoPassMinutes * 60_000 + 1_000);
  assert.equal(s.g.state(P).casinoPass, 0);
  s.act(P, { action: 'casino', op: 'enter' }, pos);
  assert.equal(s.coin(P), before - 2 * f.casino);
  // short of coin: refused, nothing taken
  s.g.gs.add(1, Q, 'coin', -s.coin(Q) + f.casino - 1, 'test');
  s.at(Q, pos);
  fails(() => s.act(Q, { action: 'casino', op: 'enter' }, pos), 409, /Not enough coins/);
  assert.equal(s.g.state(Q).casinoPass, 0);
  // the luck table at the market needs no pass; played "in the casino" it needs a casino and a pass
  s.g.gs.add(1, Q, 'fish', 5, 'test');
  fails(() => s.act(Q, { action: 'gamble', token: 'fish', qty: 1, at: 'casino' }, pos), 409, /no casino here|casino pass/);
  // a running pass does not let you play the casino's table from across the village
  s.g.gs.add(1, P, 'fish', 5, 'test');
  s.at(P, s.mall);
  fails(() => s.act(P, { action: 'gamble', token: 'fish', qty: 1, at: 'casino' }, s.mall), 409, /casino door/);
  s.at(P, pos);
  const played = s.act(P, { action: 'gamble', token: 'fish', qty: 1, at: 'casino' }, pos);
  assert.equal(typeof played.win, 'boolean', 'at the casino with a pass the table plays');
  assert.throws(() => s.act(P, { action: 'casino', op: 'bet' }, pos), /Unknown casino action/);
});

test('Mall cosmetics: at least 24 items, bought once with coin at the Mall, worn only if owned, shown in state', async () => {
  const s = await setup();
  const items = s.econ.mall.items;
  assert.ok(items.length >= 24);
  assert.equal(new Set(items.map((i) => i.id)).size, items.length, 'unique ids');
  for (const i of items) { assert.ok(s.econ.mall.slots.includes(i.slot), i.id); assert.ok(i.price >= 20 && i.price <= 400, i.id); }
  for (const slot of s.econ.mall.slots) assert.ok(items.some((i) => i.slot === slot), `slot ${slot} has items`);
  s.g.gs.add(1, P, 'coin', 1000, 'test');
  s.at(P, s.mall);
  const hats = items.filter((i) => i.slot === 'hat'), hat = hats[0], hat2 = hats[1];
  const before = s.coin(P);
  const r = s.act(P, { action: 'mall', op: 'buy', id: hat.id }, s.mall);
  assert.equal(s.coin(P), before - hat.price);
  assert.deepEqual(r.state.cosmetics, { owned: [hat.id], worn: { hat: hat.id } }, 'the first item of a slot is put on');
  fails(() => s.act(P, { action: 'mall', op: 'buy', id: hat.id }, s.mall), 409, /already own/);
  fails(() => s.act(P, { action: 'mall', op: 'buy', id: 'nope' }, s.mall), 400, 'Unknown Mall item.');
  fails(() => s.act(P, { action: 'mall', op: 'wear', slot: 'hat', id: hat2.id }), 409, /own the/);
  const away = s.g.map!.layout.spawn;
  s.at(P, away);
  fails(() => s.act(P, { action: 'mall', op: 'buy', id: hat2.id }, away), 409, 'Come to the Mall at the market.');
  s.at(P, s.mall);
  s.act(P, { action: 'mall', op: 'buy', id: hat2.id }, s.mall);
  s.act(P, { action: 'mall', op: 'wear', slot: 'hat', id: hat2.id }); // wearing needs no trip to the Mall
  assert.equal(s.g.state(P).cosmetics.worn.hat, hat2.id);
  fails(() => s.act(P, { action: 'mall', op: 'wear', slot: 'cape', id: hat.id }), 400, /does not go in/);
  assert.equal(s.act(P, { action: 'mall', op: 'wear', slot: 'hat', id: null }).state.cosmetics.worn.hat, undefined, 'taken off');
  s.act(P, { action: 'mall', op: 'wear', slot: 'hat', id: hat.id });
  assert.deepEqual(s.g.extras.worn(P), { hat: hat.id }, 'presence and name answers use this');
  assert.deepEqual(s.g.state(Q).cosmetics, { owned: [], worn: {} });
  // too poor
  s.g.gs.add(1, Q, 'coin', -s.coin(Q), 'test');
  s.at(Q, s.mall);
  fails(() => s.act(Q, { action: 'mall', op: 'buy', id: hat.id }, s.mall), 409, /Not enough coins/);
  // worker gear keeps working through the same act
  s.g.homelands.ensure(P);
  s.act(P, { action: 'mall', bot: 0, cosmetic: 'helm' }, s.mall);
  assert.equal(s.g.gs.cosmeticsOf(P)[0], 'helm');
});

test('a mission pays its reward once, only when finished, and shows progress in the state', async () => {
  const s = await setup();
  const m = s.econ.missions.find((x) => x.id === 'ride')!;
  assert.ok(s.econ.missions.length >= 8);
  assert.equal(s.g.state(P).missions.list.find((x: any) => x.id === 'ride')!.have, 0);
  s.at(P, s.carPos);
  fails(() => s.act(P, { action: 'mission', op: 'claim', id: 'ride' }), 409, 'Not finished yet.');
  s.act(P, { action: 'ride' }, s.carPos);
  const ms = s.g.state(P).missions;
  assert.equal(ms.list.find((x: any) => x.id === 'ride')!.done, true);
  assert.ok(ms.claimable.includes('ride'));
  const before = s.coin(P);
  const r = s.act(P, { action: 'mission', op: 'claim', id: 'ride' });
  assert.equal(s.coin(P), before + (m!.reward.coin ?? 0));
  assert.equal(r.state.missions.list.find((x: any) => x.id === 'ride')!.claimed, true);
  fails(() => s.act(P, { action: 'mission', op: 'claim', id: 'ride' }), 409, /already claimed/);
  assert.equal(s.coin(P), before + (m!.reward.coin ?? 0), 'not paid twice');
  fails(() => s.act(P, { action: 'mission', op: 'claim', id: 'nope' }), 400, 'Unknown mission.');
});

test('news lists finished buildings, settled days and the top seller, newest first, at most 20', async () => {
  const s = await setup();
  const kind = Object.keys(s.econ.homeland.buildings)[0];
  s.g.extras.logBuilt(P, kind, Date.now() + 10_000);
  const news = s.g.extras.news();
  assert.ok(news.length >= 1 && news.length <= 20);
  assert.equal(news[0].kind, 'building');
  assert.match(news[0].text, /finished building/);
  for (let i = 1; i < news.length; i++) assert.ok(news[i - 1].t >= news[i].t, 'newest first');
});
