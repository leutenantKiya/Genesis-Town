import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { MockChain } from '../src/chain.ts';
import { Game } from '../src/game/game.ts';
import { loadEcon } from '../src/game/econ.ts';
import { Homelands } from '../src/game/homeland.ts';
import type { Pos } from '../src/game/worldmap.ts';

const TOWN = 'town.gt.test', P = 'p1.players.test', Q = 'p2.players.test';
const NO_BED = 'Tidak ada kasur kosong. Bangun Rumah Pekerja atau tambah kasur.';

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
  const hl = (a: string) => H.map(H.ensure(a));
  const hall = (a: string): Pos => { const h = hl(a).layout.buildings.find((b) => b.kind === 'townhall')!; return { x: h.dx, y: h.dy + 1 }; };
  const doorOf = (a: string, lot: string): Pos => {
    const m = hl(a), d = m.layout.lots.find((l: any) => l.id === lot)!.door;
    for (const [dx, dy] of [[0, 0], [0, 1], [0, -1], [1, 0], [-1, 0]]) if (m.walkable(d.x + dx, d.y + dy)) return { x: d.x + dx, y: d.y + dy };
    throw new Error('no spot at the door');
  };
  const give = (a: string, t: string, n: number) => gs.add(1, a, t, n, 'test');
  const act = (a: string, body: any, pos: Pos) => { adv(1000); return game.act(a, { ...body, world: wid(a), pos }) as any; };
  const hire = (a: string, job: string) => act(a, { action: 'hire', job }, hall(a));
  /** A finished house on the lot, with the given furniture levels. */
  const house = (a: string, lot = 'rumah-c', kasur = 0, hiburan = 0) => {
    H.ensure(a); gs.addHomelandBuilding(a, lot, 'rumah', 0);
    gs.setFurnitureLevel(a, `${lot}:kasur`, kasur); gs.setFurnitureLevel(a, `${lot}:hiburan`, hiburan);
  };
  const view = (a: string) => H.view(a);
  /** Sets the Tukang's fatigue and restarts the replay clock at this instant. */
  const prime = (a: string, fatigue: Record<number, number>) => {
    H.settle(a);
    for (const [slot, f] of Object.entries(fatigue)) gs.saveWorker({ account: a, slot: Number(slot), fatigue: f, updated_at: now, sick_until: 0 });
  };
  return { game, econ, gs, H, ms, adv, now: () => now, wid, hl, hall, doorOf, give, act, hire, house, view, prime };
}

const fails = (fn: () => unknown, status: number, msg: RegExp | string) =>
  assert.throws(fn, (e: any) => e.status === status && (typeof msg === 'string' ? e.message === msg : msg.test(e.message)));

test('house gives one bed, kasur adds beds', async () => {
  const w = await setup();
  const { H, gs } = w;
  w.give(P, 'wood', 200); w.give(P, 'coin', 500);
  assert.deepEqual(w.view(P).beds, { total: 0, used: 0 });
  assert.deepEqual(w.view(P).houses, []);
  const r = w.act(P, { action: 'build', kind: 'build', target: 'rumah-c' }, w.doorOf(P, 'rumah-c'));
  assert.equal(gs.balance(P, 'wood'), 185);
  assert.equal(r.state.homeland.jobs.length, 1);
  w.adv(60_000);
  const v = w.view(P);
  assert.deepEqual(v.beds, { total: 1, used: 0 });
  assert.equal(v.houses.length, 1);
  const h = v.houses[0];
  assert.deepEqual([h.lot, h.beds, h.used, h.hiburan, h.hiburanName, h.motivation], ['rumah-c', 1, 0, 0, null, 40]);
  // each Kasur level adds a bed, up to 1 + 4; the price is the level's price
  for (let i = 1; i <= 4; i++) {
    w.act(P, { action: 'build', kind: 'furniture', target: 'rumah-c:kasur' }, w.doorOf(P, 'rumah-c'));
    assert.equal(w.view(P).jobs[0].target, 'rumah-c:kasur');
    w.adv(400_000);
    assert.equal(w.view(P).beds.total, 1 + i);
  }
  assert.equal(w.view(P).houses[0].nextKasur, null);
  const wood = gs.balance(P, 'wood'), coin = gs.balance(P, 'coin');
  assert.equal(wood, 200 - 15 - 10 - 20 - 30 - 40);
  assert.equal(coin, 500 - 20 - 40 - 80);
  fails(() => H.start(P, 'furniture', 'rumah-c:kasur', 1), 409, /sudah level tertinggi/);
  assert.equal(gs.balance(P, 'wood'), wood); assert.equal(gs.balance(P, 'coin'), coin);
  fails(() => H.start(P, 'build', 'rumah-zz', 1), 409, 'Lahan itu tidak ada.');
});

test('furniture jobs are timed with fatigue and need the player at the house', async () => {
  const w = await setup();
  const { H } = w;
  w.give(P, 'wood', 100); w.give(P, 'coin', 200);
  w.house(P);
  fails(() => w.act(P, { action: 'build', kind: 'furniture', target: 'rumah-c:kasur' }, w.hall(P)), 409, /dekat lahan/);
  assert.equal(w.gs.balance(P, 'wood'), 100);
  w.prime(P, { 0: 50 });
  const t0 = w.now();
  const r = H.start(P, 'furniture', 'rumah-c:kasur', 1); // 30 s x 1.5 / 1.05
  assert.equal(r.ends_at - t0, Math.ceil(30 * 1.5 / 1.05) * 1000);
  fails(() => H.start(P, 'furniture', 'rumah-c:kasur', 1), 409, 'Builder sedang bekerja.');
});

test('hire without a free bed answers 409 and charges nothing', async () => {
  const w = await setup();
  w.give(P, 'coin', 1000);
  fails(() => w.hire(P, 'builder'), 409, NO_BED);
  assert.equal(w.gs.balance(P, 'coin'), 1000);
  assert.equal(w.view(P).hire.builder.why, NO_BED);
  w.house(P); // one bed
  w.hire(P, 'builder');
  assert.deepEqual(w.view(P).beds, { total: 1, used: 1 });
  fails(() => w.hire(P, 'builder'), 409, NO_BED);
  assert.equal(w.gs.balance(P, 'coin'), 850); // only the first hire was paid
  w.gs.setFurnitureLevel(P, 'rumah-c:kasur', 1);
  w.hire(P, 'builder');
  assert.equal(w.gs.balance(P, 'coin'), 700);
});

test('bots move into the house with a free bed and the best entertainment', async () => {
  const w = await setup();
  w.give(P, 'coin', 1000);
  w.house(P, 'rumah-c', 0, 0);
  w.house(P, 'rumah-n', 0, 2);
  w.hire(P, 'builder'); w.hire(P, 'builder');
  const houses = Object.fromEntries(w.view(P).houses.map((h) => [h.lot, h]));
  assert.equal(houses['rumah-n'].used, 1);
  assert.equal(houses['rumah-c'].used, 1); // rumah-n has one bed, the next bot goes to the other house
  assert.deepEqual(w.view(P).bots.map((b) => b.house), ['rumah-n', 'rumah-c']);
  const m = Object.fromEntries(w.view(P).workers.map((x) => [x.slot, x.motivation]));
  assert.deepEqual(m, { 0: 60, 1: 80, 2: 40 });
});

test('hiburan raises motivation and speeds builds', async () => {
  const w = await setup();
  const { H, gs } = w;
  w.give(P, 'coin', 1000); w.give(P, 'wood', 200);
  gs.setHomelandTh(P, 2);
  w.house(P, 'rumah-c', 0, 3);
  assert.equal(w.view(P).houses[0].motivation, 100);
  assert.equal(w.view(P).houses[0].hiburanName, 'Gamelan');
  w.hire(P, 'builder');
  assert.equal(w.view(P).workers[1].motivation, 100);
  // the default Tukang (motivation 60, factor 1.05) takes the first job, the hired one (100, factor 1.25) the next
  const t0 = w.now();
  const j1 = H.start(P, 'chunk', 'n', 1);
  assert.equal(j1.ends_at - t0, Math.ceil(30 / 1.05) * 1000);
  const t1 = w.now();
  const j2 = H.start(P, 'build', 'kolam-c', 1);
  assert.equal(j2.ends_at - t1, Math.ceil(45 / 1.25) * 1000);
  // a bare house means motivation 40 and factor 0.95: slower than the default Tukang
  w.adv(100_000);
  gs.setFurnitureLevel(P, 'rumah-c:hiburan', 0);
  assert.equal(w.view(P).workers[1].motivation, 40);
  const t2 = w.now();
  gs.saveWorker({ account: P, slot: 0, fatigue: 100, updated_at: t2, sick_until: t2 + 1e12 }); // only the bot is free
  gs.saveWorker({ account: P, slot: 1, fatigue: 0, updated_at: t2, sick_until: 0 }); // and rested
  const j3 = H.start(P, 'chunk', 'e', 1);
  assert.equal(j3.ends_at - t2, Math.ceil(90 / 0.95) * 1000); // 90 s base
});

test('collapse makes a contractor sick, rumah sakit heals faster', async () => {
  const w = await setup();
  const { H, gs, ms } = w;
  w.give(P, 'wood', 1000); w.give(P, 'ore', 1000); w.give(P, 'coin', 5000);
  gs.setHomelandTh(P, 5);
  let step = 0;
  const targets = ['n', 'e', 'w', 's'];
  /** The Tukang starts a chunk job already exhausted: the job finishes, then it drops. Returns hours sick. */
  const collapse = () => {
    w.prime(P, { 0: 100 });
    const t0 = w.now();
    const r = H.start(P, 'chunk', targets[step++], 1);
    w.adv(r.ends_at - t0 + 1000);
    const wk = w.view(P).workers[0];
    assert.equal(wk.fatigue, 100);
    return (wk.sick_until - r.ends_at) / ms;
  };
  assert.equal(collapse(), 24); // no hospital
  w.adv(25 * ms);
  assert.equal(w.view(P).workers[0].sick_until, 0); // healed, fatigue reset
  assert.equal(w.view(P).workers[0].fatigue, 0);
  gs.addHomelandBuilding(P, 'rumahsakit-c', 'rumahsakit', 0);
  const wanted = [3, 2, 1];
  for (const lvl of [1, 2, 3]) {
    gs.setFurnitureLevel(P, 'rumahsakit-c', lvl);
    assert.equal(collapse(), wanted[lvl - 1], `hospital level ${lvl}`);
    w.adv(5 * ms);
    assert.equal(w.view(P).workers[0].sick_until, 0);
  }
});

test('a contractor is healed the moment the sickness ends, not a serving step later', async () => {
  const w = await setup();
  const { H, gs, ms } = w;
  w.give(P, 'wood', 100); w.give(P, 'coin', 100);
  gs.addHomelandBuilding(P, 'rumahsakit-c', 'rumahsakit', 0); gs.setFurnitureLevel(P, 'rumahsakit-c', 1);
  gs.setHomelandTh(P, 3);
  w.prime(P, { 0: 100 });
  const t0 = w.now();
  const r = H.start(P, 'chunk', 'n', 1);
  w.adv(r.ends_at - t0 + 1000);
  const sickUntil = w.view(P).workers[0].sick_until;
  assert.ok(sickUntil > 0);
  w.adv(sickUntil - w.now() + 1000); // 1 s past the end, well inside a game hour
  const wk = w.view(P).workers[0];
  assert.equal(wk.sick_until, 0);
  assert.equal(wk.fatigue, 0);
});

test('sick contractor takes no job, another does', async () => {
  const w = await setup();
  const { H, gs } = w;
  w.give(P, 'wood', 500); w.give(P, 'coin', 500);
  w.house(P, 'rumah-c', 1);
  w.hire(P, 'builder');
  const sick = (slot: number) => gs.saveWorker({ account: P, slot, fatigue: 100, updated_at: w.now(), sick_until: w.now() + 1e12 });
  sick(0);
  H.start(P, 'build', 'kolam-c', 1);
  assert.equal(gs.homelandJobs(P)[0].worker, 1); // the sick Tukang is skipped, the hired one builds
  assert.equal(w.view(P).workers.find((x) => x.slot === 0)!.busy, false);
  assert.equal(w.view(P).workers.find((x) => x.slot === 1)!.busy, true);
  sick(1);
  const wood = gs.balance(P, 'wood');
  fails(() => H.start(P, 'chunk', 'n', 1), 409, /sakit/);
  assert.equal(gs.balance(P, 'wood'), wood); // nothing charged
});

test('a restart in the middle of a job or a sickness resumes from the timestamps exactly once', async () => {
  const w = await setup();
  const { H, gs, ms } = w;
  w.give(P, 'wood', 50);
  w.prime(P, { 0: 100 });
  const t0 = w.now();
  const r = H.start(P, 'chunk', 'n', 1);
  w.adv(r.ends_at - t0 + 1000);
  const h2 = new Homelands(H.d); // the server restarted: a fresh object over the same rows
  const sick = h2.view(P).workers[0].sick_until;
  assert.equal(sick, r.ends_at + 24 * ms);
  assert.deepEqual(h2.view(P).open, ['n']);
  new Homelands(H.d).settle(P); h2.settle(P);
  assert.equal(h2.view(P).workers[0].sick_until, sick); // not extended by repeated reads
  w.adv(30 * ms);
  const h3 = new Homelands(H.d);
  assert.equal(h3.view(P).workers[0].sick_until, 0);
  assert.equal(h3.view(P).workers[0].fatigue, 0);
  assert.equal(new Homelands(H.d).view(P).workers[0].fatigue, 0);
  assert.equal(gs.homelandJobs(P).length, 0);
});

test('rumah sakit needs Balai Kota level 2 and upgrades to heal faster', async () => {
  const w = await setup();
  const { H, gs } = w;
  w.give(P, 'wood', 500); w.give(P, 'ore', 100); w.give(P, 'coin', 1000);
  assert.equal(w.view(P).hospital, null);
  fails(() => w.act(P, { action: 'build', kind: 'build', target: 'rumahsakit-c' }, w.doorOf(P, 'rumahsakit-c')), 409, 'Balai Kota perlu level 2.');
  gs.setHomelandTh(P, 2);
  fails(() => H.start(P, 'upgrade', 'rumahsakit-c', 1), 409, 'Bangun Rumah Sakit dulu.');
  w.act(P, { action: 'build', kind: 'build', target: 'rumahsakit-c' }, w.doorOf(P, 'rumahsakit-c'));
  assert.deepEqual([gs.balance(P, 'wood'), gs.balance(P, 'ore'), gs.balance(P, 'coin')], [470, 90, 940]);
  w.adv(180_000);
  const hos = () => w.view(P).hospital!;
  assert.deepEqual([hos().lot, hos().level, hos().maxLevel, hos().healGameHours], ['rumahsakit-c', 1, 3, 3]);
  assert.deepEqual(hos().next, { cost: { wood: 30, ore: 15, coin: 100 }, secs: 240 });
  for (const [lvl, hours] of [[2, 2], [3, 1]]) {
    w.act(P, { action: 'build', kind: 'upgrade', target: 'rumahsakit-c' }, w.doorOf(P, 'rumahsakit-c'));
    assert.equal(w.view(P).jobs[0].target, 'rumahsakit-c:up');
    w.adv(1_500_000);
    assert.deepEqual([hos().level, hos().healGameHours], [lvl, hours]);
  }
  assert.equal(hos().next, null);
  assert.deepEqual([gs.balance(P, 'wood'), gs.balance(P, 'ore'), gs.balance(P, 'coin')], [470 - 30 - 50, 90 - 15 - 30, 940 - 100 - 200]);
  fails(() => H.start(P, 'upgrade', 'rumahsakit-c', 1), 409, 'Rumah Sakit sudah level tertinggi.');
  assert.equal(gs.homelandBuildings(P).length, 1); // an upgrade is not a second building
});

test('request names like constructor and __proto__ are 400 for furniture and jobs and charge nothing', async () => {
  const w = await setup();
  const { H, gs } = w;
  w.give(P, 'wood', 100); w.give(P, 'coin', 500);
  w.house(P, 'rumah-c', 1);
  const before = () => [gs.balance(P, 'wood'), gs.balance(P, 'coin'), gs.homelandJobs(P).length].join();
  const b0 = before();
  for (const n of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'kasur:x', '']) {
    fails(() => H.start(P, 'furniture', `rumah-c:${n}`, 1), 400, /Perabot tidak dikenal/);
    fails(() => w.act(P, { action: 'build', kind: 'furniture', target: `rumah-c:${n}` }, w.doorOf(P, 'rumah-c')), 400, /Perabot tidak dikenal/);
  }
  for (const t of ['constructor', '__proto__', 'rumah-c', 'rumah-c:kasur:1']) fails(() => H.start(P, 'furniture', t, 1), 400, /Perabot tidak dikenal/);
  for (const k of ['constructor', '__proto__', 'toString']) fails(() => H.start(P, k as any, 'rumah-c', 1), 400, /Jenis bangunan tidak dikenal/);
  for (const j of ['constructor', '__proto__', 'toString']) fails(() => w.hire(P, j), 400, /Pekerja tidak dikenal/);
  assert.equal(before(), b0);
});
