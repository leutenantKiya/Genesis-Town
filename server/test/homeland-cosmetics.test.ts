import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { MockChain } from '../src/chain.ts';
import { Game } from '../src/game/game.ts';
import { loadEcon } from '../src/game/econ.ts';
import type { Pos } from '../src/game/worldmap.ts';

const TOWN = 'town.gt.test', P = 'p1.players.test', Q = 'p2.players.test';

async function setup() {
  const econ = loadEcon();
  const chain = new MockChain();
  chain.accounts.add(TOWN); chain.add(TOWN, 'coin', 5000n);
  for (const [id, d] of Object.entries(econ.merchants)) chain.addMerchant(`${id}.gt.test`, d.shop, { coin: d.restore.coin, ...d.restore.items }, { coin: d.startCash, ...d.startStock }, {});
  const store = new Store(':memory:');
  let now = 1_800_000_000_000;
  const game = new Game(store, chain, { merchantParent: 'gt.test', town: TOWN, econ, worldSeed: 42, now: () => now, rng: () => 0.99 });
  await game.init();
  for (const a of [P, Q]) { store.addPlayer(a, 'sub-' + a, 'ed25519:o'); await chain.registerPlayer(a); game.onNewPlayer(a); }
  const gs = game.gs, H = game.homelands, ms = econ.time.realMsPerGameHour;
  const adv = (n: number) => { now += n; };
  const wid = (a: string) => `HL-${H.ensure(a).id}`;
  for (const a of [P, Q]) game.reportPosition(a, H.map(H.ensure(a)).layout.spawn, wid(a));
  for (const a of [P, Q]) for (const t of ['coin', 'fish', 'wood', 'meal', 'bread', 'ore']) gs.add(1, a, t, -gs.balance(a, t), 'test');
  const hall = (a: string): Pos => { const h = H.map(H.ensure(a)).layout.buildings.find((b) => b.kind === 'townhall')!; return { x: h.dx, y: h.dy + 1 }; };
  const give = (a: string, t: string, n: number) => gs.add(1, a, t, n, 'test');
  const act = (a: string, body: any, pos: Pos = hall(a)) => { adv(1000); return game.act(a, { ...body, world: wid(a), pos }) as any; };
  const dress = (a: string, bot: unknown, cosmetic: unknown) => act(a, { action: 'dress', bot, cosmetic });
  const house = (a: string) => { H.ensure(a); gs.addHomelandBuilding(a, 'rumah-c', 'rumah', 0); gs.setFurnitureLevel(a, 'rumah-c:kasur', 4); gs.setFurnitureLevel(a, 'rumah-c:hiburan', 1); };
  return { game, econ, gs, H, ms, adv, now: () => now, give, act, dress, house, hall };
}
const fails = (fn: () => unknown, status: number, msg: RegExp | string) =>
  assert.throws(fn, (e: any) => e.status === status && (typeof msg === 'string' ? e.message === msg : msg.test(e.message)));

test('dress charges coin to the town', async () => {
  const w = await setup();
  w.give(P, 'coin', 300);
  const town0 = w.gs.balance(TOWN, 'coin');
  const r = w.dress(P, 0, 'caping');
  assert.equal(w.gs.balance(P, 'coin'), 220);
  assert.equal(w.gs.balance(TOWN, 'coin'), town0 + 80);
  assert.equal(r.state.homeland.workers[0].cosmetic, 'caping');
  assert.equal(w.H.view(P).cosmetics.mahkota.price, 300);
  // a better hat replaces it; no refund
  w.dress(P, 0, 'syal');
  assert.equal(w.gs.balance(P, 'coin'), 70);
  assert.equal(w.H.view(P).workers[0].cosmetic, 'syal');
  fails(() => w.dress(P, 0, 'mahkota'), 409, /Not enough coins/);
  assert.equal(w.gs.balance(P, 'coin'), 70);
  // bots can be dressed too
  w.house(P); w.give(P, 'coin', 500); w.H.hire(P, 'builder', 1);
  const c0 = w.gs.balance(P, 'coin');
  w.dress(P, 1, 'caping');
  assert.equal(w.gs.balance(P, 'coin'), c0 - 80);
  assert.equal(w.H.view(P).bots[0].cosmetic, 'caping');
});

test('dressing another player\'s bot 409, no coin', async () => {
  const w = await setup();
  w.give(P, 'coin', 500); w.give(Q, 'coin', 500);
  w.house(Q); w.gs.setHomelandTh(Q, 1);
  w.H.hire(Q, 'builder', 1); // Q's bot id 1
  const before = w.gs.balance(P, 'coin');
  fails(() => w.dress(P, 1, 'caping'), 409, "That worker isn't yours.");
  fails(() => w.dress(P, 99, 'caping'), 409, "That worker isn't yours.");
  assert.equal(w.gs.balance(P, 'coin'), before);
  assert.equal(w.H.view(Q).bots[0].cosmetic, null);
});

test('unknown or prototype cosmetic 400', async () => {
  const w = await setup();
  w.give(P, 'coin', 500);
  for (const c of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'topi', '', undefined]) fails(() => w.dress(P, 0, c), 400, /Unknown gear/);
  for (const b of ['abc', -1, 1.5, null]) fails(() => w.dress(P, b, 'caping'), 400, /Unknown worker/);
  assert.equal(w.gs.balance(P, 'coin'), 500);
  // must stand at the Balai Kota
  fails(() => w.act(P, { action: 'dress', bot: 0, cosmetic: 'caping' }, w.game.map!.layout.spawn), 409, /./);
  assert.equal(w.gs.balance(P, 'coin'), 500);
});

test('dressed tukang tires slower', async () => {
  const w = await setup();
  w.give(P, 'wood', 100); w.give(P, 'coin', 300); w.give(Q, 'wood', 100);
  w.dress(P, 0, 'mahkota'); // boost 0.5
  for (const a of [P, Q]) { w.H.start(a, 'chunk', 'n', 1); }
  w.adv(31_000);
  const f = (a: string) => w.H.view(a).workers[0].fatigue;
  assert.ok(f(Q) > 0);
  assert.ok(Math.abs(f(P) - f(Q) * 0.5) < 0.3, `${f(P)} vs ${f(Q)}`);
});

test('dressed nelayan raises fish rate', async () => {
  const w = await setup();
  w.give(P, 'coin', 1000); w.give(Q, 'coin', 1000);
  for (const a of [P, Q]) { w.house(a); w.gs.setHomelandTh(a, 2); w.H.hire(a, 'nelayan', 1); }
  const base = w.H.effects(Q).fishRate;
  assert.equal(w.H.effects(P).fishRate, base);
  w.dress(P, 1, 'mahkota');
  const mf = 1.05; // motivation 60
  assert.ok(Math.abs(w.H.effects(P).fishRate - (1 + 0.5 * mf * 1.5)) < 1e-9);
  assert.equal(w.H.effects(Q).fishRate, base);
});

test('dressed pemburu and koki are faster', async () => {
  const w = await setup();
  w.give(P, 'coin', 2000); w.house(P); w.gs.setHomelandTh(P, 3);
  w.H.hire(P, 'hunter', 1); w.H.hire(P, 'chef', 1);
  const rate = () => w.H.effects(P).forage!.perGameHour;
  const r0 = rate();
  w.dress(P, 1, 'syal'); // 0.35
  assert.ok(Math.abs(rate() - r0 * 1.35) < 1e-9);
  assert.equal(w.H.effects(P).chefBoost, 0);
  w.dress(P, 2, 'caping');
  assert.ok(Math.abs(w.H.effects(P).chefBoost - 0.2) < 1e-9);
});
