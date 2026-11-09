import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { MockChain } from '../src/chain.ts';
import { Game } from '../src/game/game.ts';
import { loadEcon } from '../src/game/econ.ts';
import type { Pos } from '../src/game/worldmap.ts';

const TOWN = 'town.gt.test', P = 'p1.players.test', Q = 'p2.players.test';

async function world() {
  const econ = loadEcon();
  const chain = new MockChain();
  chain.accounts.add(TOWN); chain.add(TOWN, 'coin', 5000n);
  for (const [id, d] of Object.entries(econ.merchants)) chain.addMerchant(`${id}.gt.test`, d.shop, { coin: d.restore.coin, ...d.restore.items }, { coin: d.startCash, ...d.startStock }, {});
  const store = new Store(':memory:');
  let now = 1_800_000_000_000;
  const game = new Game(store, chain, { merchantParent: 'gt.test', town: TOWN, econ, worldSeed: 42, now: () => now, rng: () => 0.99 });
  await game.init();
  for (const a of [P, Q]) { store.addPlayer(a, 'sub-' + a, 'ed25519:o'); await chain.registerPlayer(a); game.onNewPlayer(a); }
  const adv = (ms: number) => { now += ms; };
  for (const a of [P, Q]) game.reportPosition(a, game.homelands.map(game.homelands.ensure(a)).layout.spawn, `HL-${game.homelands.ensure(a).id}`);
  const wid = (a: string) => `HL-${game.homelands.ensure(a).id}`;
  const hl = (a: string) => game.homelands.map(game.homelands.ensure(a));
  /** Standing at the Town Hall door of the owner's Homeland. */
  const hall = (a: string): Pos => { const h = hl(a).layout.buildings.find((b) => b.kind === 'townhall')!; return { x: h.dx, y: h.dy + 1 }; };
  /** C2: hiring needs a bed, so every test hirer lives in a house with five beds and a radio (motivation 60). */
  const ensureHouse = (a: string) => { game.homelands.ensure(a); if (!game.gs.homelandBuildings(a).some((b) => b.kind === 'rumah')) { game.gs.addHomelandBuilding(a, 'rumah-c', 'rumah', 0); game.gs.setFurnitureLevel(a, 'rumah-c:kasur', 4); game.gs.setFurnitureLevel(a, 'rumah-c:hiburan', 1); } };
  const hire = (a: string, job: string, pos: Pos = hall(a), world = wid(a)) => { ensureHouse(a); adv(60_000); return game.act(a, { action: 'hire', job, world, pos }) as any; };
  const give = (a: string, t: string, n: number) => game.gs.add(1, a, t, n, 'test');
  return { game, econ, now: () => now, adv, hl, hall, hire, give, wid, gs: game.gs };
}

const fails = (fn: () => unknown, status: number, msg: RegExp | string) =>
  assert.throws(fn, (e: any) => e.status === status && (typeof msg === 'string' ? e.message === msg : msg.test(e.message)));


import { Homelands } from '../src/game/homeland.ts';

async function setup() {
  const w = await world();
  const { gs, game } = w;
  const H = game.homelands, ms = w.econ.time.realMsPerGameHour;
  for (const a of [P, Q]) for (const t of ['coin', 'fish', 'wood', 'meal', 'bread', 'ore']) gs.add(1, a, t, -gs.balance(a, t), 'test');
  const doorOf = (a: string, lot: string): Pos => {
    const m = w.hl(a), d = m.layout.lots.find((l: any) => l.id === lot)!.door;
    for (const [dx, dy] of [[0, 0], [0, 1], [0, -1], [1, 0], [-1, 0]]) if (m.walkable(d.x + dx, d.y + dy)) return { x: d.x + dx, y: d.y + dy };
    throw new Error('no spot at the door');
  };
  const build = (a: string) => { H.ensure(a); gs.addHomelandBuilding(a, 'restoran-c', 'restoran', 0); };
  const act = (a: string, body: any, pos: Pos) => { w.adv(1000); return game.act(a, { ...body, world: w.wid(a), pos }) as any; };
  const cook = (a: string, qty: unknown, pos: Pos = doorOf(a, 'restoran-c')) => act(a, { action: 'cook', qty }, pos);
  const stock = (a: string, token: string, qty: unknown, pos: Pos = doorOf(a, 'restoran-c')) => act(a, { action: 'stock', token, qty }, pos);
  const forage = (a: string, pos: Pos = w.hall(a)) => act(a, { action: 'forage' }, pos);
  /** Sets contractor state and restarts the replay clock at this instant. */
  const prime = (a: string, o: { fatigue?: Record<number, number>; pantry?: number }) => {
    H.settle(a);
    for (const [slot, f] of Object.entries(o.fatigue ?? {})) gs.saveWorker({ account: a, slot: Number(slot), fatigue: f, updated_at: w.now(), sick_until: 0 });
    gs.savePantry(a, o.pantry ?? gs.pantryOf(a)?.pantry ?? 0, w.now());
  };
  const fat = (a: string, slot = 0) => H.view(a).workers.find((x) => x.slot === slot)!.fatigue;
  return { ...w, H, ms, doorOf, build, cook, stock, forage, act, prime, fat };
}

test('fresh tukang builds kolam in 45 s', async () => {
  const w = await setup();
  w.give(P, 'wood', 20);
  const t0 = w.now();
  const r = w.H.start(P, 'build', 'kolam-c', 1);
  assert.equal(r.ends_at - t0, 43_000); // 45 s base / 1.05 (default Tukang motivation 60), well inside the 60 s demo budget
  assert.deepEqual(w.H.view(P).workers.map((x) => [x.slot, x.fatigue, x.busy]), [[0, 0, true]]);
});

test('fatigue grows per job and slows the next job', async () => {
  const w = await setup();
  w.give(P, 'wood', 100);
  w.H.start(P, 'chunk', 'n', 1); // 30 s base
  w.adv(31_000);
  assert.equal(w.fat(P), 5); // 10 per job minute x 30 s
  const t0 = w.now();
  const r = w.H.start(P, 'build', 'kolam-c', 1);
  assert.equal(r.ends_at - t0, Math.ceil(45 * 1.05 / 1.05) * 1000); // 5% tired, motivation factor 1.05
  w.adv(49_000);
  assert.equal(w.H.view(P).built.length, 1);
  const f = w.fat(P);
  w.H.view(P); w.H.settle(P); // applied exactly once however often it is read
  assert.equal(w.fat(P), f);
  assert.ok(f > 5 && f <= 12.5, `fatigue ${f}`);
});

test('idle contractors recover over game hours', async () => {
  const w = await setup();
  w.H.ensure(P);
  w.prime(P, { fatigue: { 0: 50 } });
  w.adv(3 * w.ms);
  assert.equal(w.fat(P), 35);
  w.adv(100 * w.ms);
  assert.equal(w.fat(P), 0); // never below zero
});

test('restoran serves the most tired contractor from its pantry', async () => {
  const w = await setup();
  w.give(P, 'coin', 200); w.H.ensure(P);
  w.build(P);
  w.hire(P, 'builder');
  w.prime(P, { fatigue: { 0: 40, 1: 70 }, pantry: 3 });
  w.adv(w.ms);
  assert.equal(w.fat(P, 0), 35); // recovered 5
  assert.equal(w.fat(P, 1), 35); // 70 - 5 - 30 served
  assert.equal(w.H.view(P).restoran!.pantry, 2);
  assert.equal(w.H.view(P).restoran!.pantryMax, 20);
});

test('koki doubles serving speed', async () => {
  const w = await setup();
  w.give(P, 'coin', 500); w.H.ensure(P); w.H.ensure(Q);
  w.gs.setHomelandTh(P, 3); w.build(P); w.build(Q);
  w.hire(P, 'chef');
  w.prime(P, { fatigue: { 0: 90 }, pantry: 3 });
  w.prime(Q, { fatigue: { 0: 90 }, pantry: 3 });
  w.adv(w.ms);
  assert.equal(w.H.view(P).restoran!.pantry, 1); // two portions in one game hour
  assert.equal(w.H.view(Q).restoran!.pantry, 2);
  assert.equal(w.fat(P), 25);
  assert.equal(w.fat(Q), 55);
});

test('empty pantry serves nothing', async () => {
  const w = await setup();
  w.H.ensure(P); w.build(P); w.give(P, 'meal', 5);
  w.prime(P, { fatigue: { 0: 80 }, pantry: 0 });
  w.adv(3 * w.ms);
  assert.equal(w.fat(P), 65); // only idle recovery
  assert.equal(w.H.view(P).restoran!.pantry, 0);
  assert.equal(w.gs.balance(P, 'meal'), 5); // serving never touches the bag
});

test('cook fills the pantry not the bag, 409 without ingredients', async () => {
  const w = await setup();
  w.H.ensure(P);
  fails(() => w.cook(P, 1), 409, 'Bangun Restoran dulu.');
  w.build(P); w.give(P, 'fish', 5); w.give(P, 'wood', 5); w.give(P, 'bread', 2);
  const r = w.cook(P, 3);
  assert.equal(w.gs.balance(P, 'meal'), 0);
  assert.equal(w.gs.balance(P, 'fish'), 2);
  assert.equal(r.state.homeland.restoran.pantry, 3);
  assert.deepEqual(r.state.homeland.cook.recipe, { inputs: { fish: 1, wood: 1 }, output: 'meal' });
  fails(() => w.cook(P, 3), 409, 'Bahan kurang (perlu 3 Ikan, 3 Kayu).');
  assert.equal(w.gs.balance(P, 'fish'), 2);
  assert.equal(w.H.view(P).restoran!.pantry, 3);
  for (const q of [0, 11, 1.5, -1, 'x']) fails(() => w.cook(P, q), 400, /1 sampai 10/);
  fails(() => w.cook(P, 1, w.hall(P)), 409, 'Berdiri di dekat pintu Restoran.');
  fails(() => w.cook(Q, 1), 409, 'Bangun Restoran dulu.');
  // stock moves bread/meal from the bag
  w.stock(P, 'bread', 2);
  assert.equal(w.gs.balance(P, 'bread'), 0);
  assert.equal(w.H.view(P).restoran!.pantry, 5);
  fails(() => w.stock(P, 'bread', 1), 409, /kurang/);
  // only bread and meal, never inherited keys
  for (const t of ['constructor', '__proto__', 'fish', 'coin']) fails(() => w.stock(P, t, 1), 400, /roti/);
  // the pantry has a limit
  w.give(P, 'meal', 30);
  fails(() => w.stock(P, 'meal', 16), 409, /penuh/);
  assert.equal(w.gs.balance(P, 'meal'), 30);
  w.stock(P, 'meal', 15);
  assert.equal(w.H.view(P).restoran!.pantry, 20);
});

test('pemburu forages and doubles in winter', async () => {
  const w = await setup();
  const { gs, game, H, ms } = w, T = w.econ.time;
  const sum = (a: string) => Object.values(H.view(a).forage!.stored).reduce((x, y) => x + y, 0);
  gs.setHomelandTh(P, 3); w.give(P, 'coin', 400);
  fails(() => w.forage(P), 409, 'Kamu belum punya Pemburu.');
  w.hire(P, 'hunter');
  assert.deepEqual(H.view(P).forage, { stored: { fish: 0, wood: 0 }, capacity: 6 });
  fails(() => w.forage(P), 409, 'Pemburu belum membawa apa-apa.');
  w.adv(3 * ms);
  assert.deepEqual(H.view(P).forage!.stored, { fish: 2, wood: 1 });
  const r = w.forage(P);
  assert.deepEqual(r.gained, { fish: 2, wood: 1 });
  assert.equal(gs.balance(P, 'fish'), 2);
  w.build(P);
  fails(() => w.forage(P, w.doorOf(P, 'restoran-c')), 409, 'Berdiri di depan Balai Kota.');
  w.adv(100 * ms);
  assert.equal(sum(P), 6); // capacity
  assert.equal(H.view(Q).forage, null);
  // winter
  const winterStart = T.seasons.indexOf('dingin') * T.daysPerSeason * T.hoursPerDay, year = T.seasons.length * T.daysPerSeason * T.hoursPerDay;
  const toHour = (target: number) => { let d = target - game.clock.hours(); while (d < 0) d += year; game.clock.skipHours(d); };
  gs.setHomelandTh(Q, 3); w.give(Q, 'coin', 400);
  toHour(winterStart + 5);
  w.hire(Q, 'hunter');
  w.adv(2 * ms);
  assert.equal(sum(Q), 4); // 2 hours x winterFactor 2
  // across the season change: one autumn hour (x1) and one winter hour (x2)
  w.forage(P);
  toHour(winterStart - 1);
  gs.setForage(P, w.now(), 0);
  w.adv(2 * ms);
  toHour(winterStart);
  assert.equal(sum(P), 3);
  w.adv(100 * ms);
  assert.equal(sum(P), 6);
});

test('restart mid-job finishes once', async () => {
  const w = await setup();
  w.give(P, 'wood', 50); w.give(P, 'coin', 100); w.gs.setHomelandTh(P, 2);
  w.H.start(P, 'chunk', 'n', 1);
  w.adv(31_000);
  const H2 = new Homelands({ econ: w.econ, gs: w.gs, worldSeed: 42, now: w.now, town: TOWN, clock: w.game.clock });
  H2.settle(P); w.H.settle(P); H2.view(P);
  assert.deepEqual(w.H.view(P).open, ['n']);
  assert.equal(w.fat(P), 5);
  w.H.settle(P); H2.settle(P);
  assert.equal(w.fat(P), 5);
  // a job still running after a restart keeps its end time
  const r = w.H.start(P, 'chunk', 'e', 1);
  assert.equal(H2.view(P).jobs[0].ends_at, r.ends_at);
});

test('collapse: the job in progress finishes, then the contractor is sick and another takes jobs', async () => {
  const w = await setup();
  w.give(P, 'wood', 200); w.give(P, 'coin', 300);
  w.H.ensure(P); w.gs.setHomelandTh(P, 2);
  w.prime(P, { fatigue: { 0: 95 } });
  w.H.start(P, 'chunk', 'n', 1); // 30 s base x 1.95 = 59 s
  w.adv(30_000);
  assert.deepEqual(w.H.view(P).open, []); // still running
  w.adv(30_000);
  assert.deepEqual(w.H.view(P).open, ['n']); // the job finished
  const v = w.H.view(P).workers[0];
  assert.equal(v.fatigue, 100);
  assert.ok(v.sick_until > w.now());
  const wood = w.gs.balance(P, 'wood');
  fails(() => w.H.start(P, 'chunk', 'e', 1), 409, /sakit/);
  assert.equal(w.gs.balance(P, 'wood'), wood); // nothing charged by the refused start
  w.hire(P, 'builder');
  w.H.start(P, 'chunk', 'e', 1);
  assert.ok(w.gs.balance(P, 'wood') < wood);
  assert.equal(w.H.view(P).jobs.length, 1);
  w.adv(25 * w.ms);
  assert.equal(w.H.view(P).workers[0].sick_until, 0); // healed after 24 game hours, fatigue reset
  assert.equal(w.fat(P), 0);
});

test('request names like constructor and __proto__ are 400 and charge nothing', async () => {
  const w = await setup();
  w.give(P, 'coin', 100); w.build(P);
  for (const job of ['constructor', '__proto__', 'toString']) fails(() => w.hire(P, job), 400, /tidak dikenal/);
  for (const t of ['constructor', '__proto__']) fails(() => w.stock(P, t, 1), 400, /roti/);
  assert.equal(w.gs.balance(P, 'coin'), 100);
});
