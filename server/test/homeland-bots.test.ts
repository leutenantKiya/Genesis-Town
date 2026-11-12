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
  return { game, econ, adv, hl, hall, hire, give, wid, gs: game.gs };
}

const fails = (fn: () => unknown, status: number, msg: RegExp | string) =>
  assert.throws(fn, (e: any) => e.status === status && (typeof msg === 'string' ? e.message === msg : msg.test(e.message)));

function treeSpot(m: any): { tree: Pos; stand: Pos } {
  const L = m.layout;
  for (let y = 1; y < L.h - 1; y++) for (let x = 1; x < L.w - 1; x++) {
    if (L.tiles[y * L.w + x] !== 'tree' || !m.chunkAt(x, y).open) continue;
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) if (m.walkable(x + dx, y + dy)) return { tree: { x, y }, stand: { x: x + dx, y: y + dy } };
  }
  throw new Error('no tree');
}

test('hire charges coin to the town', async () => {
  const w = await world();
  w.gs.add(1, P, 'coin', -w.gs.balance(P, 'coin'), 'test'); // starter coin out of the way
  w.give(P, 'coin', 200);
  const town0 = w.gs.balance(TOWN, 'coin');
  const r = w.hire(P, 'builder');
  assert.equal(w.gs.balance(P, 'coin'), 50);
  assert.equal(w.gs.balance(TOWN, 'coin'), town0 + 150);
  assert.match(r.toast, /Builder/);
  assert.deepEqual(r.state.homeland.bots.map((b: any) => b.job), ['builder']);
  assert.equal(r.state.homeland.hire.builder.have, 1);
  assert.equal(r.state.homeland.hire.builder.max, 3);
  assert.equal(r.state.homeland.builders.total, 2);
  fails(() => w.hire(P, 'builder'), 409, /Not enough coins \(have 50, need 150\)/);
  fails(() => w.hire(P, 'petani'), 409, 'Town Hall needs level 2.');
  fails(() => w.hire(P, 'nope'), 400, /./);
  // inherited object keys are not jobs: no NaN coin rows
  for (const job of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) fails(() => w.hire(P, job), 400, /Unknown worker/);
  assert.equal(w.gs.balance(P, 'coin'), 50);
});

test('second builder runs two jobs at once', async () => {
  const w = await world();
  const H = w.game.homelands;
  w.give(P, 'wood', 100);
  w.give(P, 'coin', 500);
  H.ensure(P);
  w.gs.setHomelandTh(P, 2);
  w.gs.setHomelandTh(Q, 2); w.give(Q, 'wood', 100); w.give(Q, 'coin', 500);
  H.start(Q, 'chunk', 'n', 1);
  fails(() => H.start(Q, 'chunk', 'e', 1), 409, 'The builder is busy.'); // one default builder
  w.hire(P, 'builder');
  H.start(P, 'chunk', 'n', 1);
  H.start(P, 'chunk', 'e', 1);
  assert.equal(H.view(P).jobs.length, 2);
  assert.deepEqual(H.view(P).builders, { total: 2, busy: 2 });
  fails(() => H.start(P, 'chunk', 's', 1), 409, 'The builder is busy.');
});

test('max per job answers 409', async () => {
  const w = await world();
  w.gs.add(1, P, 'coin', -w.gs.balance(P, 'coin'), 'test');
  w.give(P, 'coin', 1000);
  for (let i = 0; i < 3; i++) w.hire(P, 'builder');
  assert.equal(w.game.homelands.bots(P).length, 3);
  fails(() => w.hire(P, 'builder'), 409, 'Builder workers are full (max 3).');
  assert.equal(w.gs.balance(P, 'coin'), 1000 - 450); // the refused hire cost nothing
  assert.equal(w.game.homelands.view(P).hire.builder.can, false);
});

test('hire outside own homeland answers 409', async () => {
  const w = await world();
  w.gs.add(1, P, 'coin', -w.gs.balance(P, 'coin'), 'test');
  w.give(P, 'coin', 500);
  fails(() => w.hire(P, 'builder', w.game.map!.layout.spawn, 'public'), 409, /Homeland/);
  const L = w.hl(P).layout, far = [...Array(L.h * L.w).keys()].map((i) => ({ x: i % L.w, y: Math.floor(i / L.w) })).find((p) => w.hl(P).walkable(p.x, p.y) && Math.abs(p.x - L.spawn.x) + Math.abs(p.y - L.spawn.y) === 3)!;
  fails(() => w.hire(P, 'builder', far), 409, /Town Hall/); // not at the Town Hall
  fails(() => w.hire(P, 'builder', w.hall(Q), w.wid(Q)), 409, /not invited/); // somebody else's Homeland
  w.game.homelands.setInvites(Q, [P]);
  fails(() => w.hire(P, 'builder', w.hall(Q), w.wid(Q)), 409, /isn't your Homeland/); // a guest cannot hire either
  assert.equal(w.gs.balance(P, 'coin'), 500);
  assert.equal(w.game.homelands.bots(P).length, 0);
});

test('petani makes homeland crops grow faster', async () => {
  const w = await world();
  const { game, gs } = w, wid = w.wid(P);
  const standBy = (idx: number): Pos => { const M = w.hl(P); const q = M.layout.farm.plots[idx]; for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) if (M.walkable(q.x + dx, q.y + dy)) return { x: q.x + dx, y: q.y + dy }; throw new Error('no spot'); };
  const DAY = 24 * 60_000;
  const farm = (op: string, idx: number) => { w.adv(60_000); return game.act(P, { action: 'farm', op, plot: idx, world: wid, pos: standBy(idx) }) as any; };
  const grow = (idx: number) => {
    farm('till', idx); farm('plant', idx); farm('water', idx);
    w.adv(DAY);
    return farm('water', idx).state.plots.find((x: any) => x.idx === idx).state;
  };
  assert.equal(grow(0), 'planted'); // without a Petani two waterings of three are not enough
  gs.setHomelandTh(P, 2);
  w.give(P, 'coin', 200);
  w.hire(P, 'petani');
  assert.equal(game.homelands.effects(P).farmGrowFactor, 1.525); // 1 + 0.5 x 1.05 (motivation 60: a house with a radio)
  assert.equal(grow(1), 'ready'); // ceil(3 / 1.5) = 2 days
});

test('nelayan raises kolam output', async () => {
  const w = await world();
  const t0 = 1_800_000_000_000, H = w.game.homelands;
  H.ensure(P); H.ensure(Q);
  w.gs.setHomelandTh(P, 2);
  w.give(P, 'coin', 300);
  w.hire(P, 'nelayan');
  w.hire(P, 'nelayan');
  const built = t0 + 120_000; // two hires moved the test clock by 2 minutes
  w.gs.addHomelandBuilding(P, 'kolam-c', 'kolam', built);
  w.gs.addHomelandBuilding(Q, 'kolam-c', 'kolam', built);
  assert.equal(H.effects(P).fishRate, 1.525 * 1.525);
  w.adv(1 * w.econ.time.realMsPerGameHour);
  const stored = (a: string) => H.view(a).built.find((b) => b.kind === 'kolam')!.stored;
  assert.equal(stored(Q), 2); // 2 fish per game hour
  assert.equal(stored(P), 4); // 2 x 1.5 x 1.5 = 4.5 per hour, rounded down
  const r = H.collect(P, 'kolam-c', 1, () => {});
  assert.deepEqual(r.gained, { fish: 4 });
});

test('penebang adds wood per tree at home only', async () => {
  const w = await world();
  const { game, gs } = w;
  const doGather = (a: string) => {
    const wd = w.wid(a), s = treeSpot(w.hl(a)); w.adv(60_000);
    const before = gs.balance(a, 'wood');
    game.act(a, { action: 'gather', tile: 'tree', x: s.tree.x, y: s.tree.y, world: wd, pos: s.stand });
    return gs.balance(a, 'wood') - before;
  };
  assert.equal(doGather(P), 1);
  gs.setHomelandTh(P, 2);
  w.give(P, 'coin', 300);
  w.hire(P, 'penebang');
  assert.equal(game.homelands.effects(P).woodBonus, 1);
  assert.equal(doGather(P), 2);
  // bots belong to their owner: Q still gets 1 (the woodcutter's bonus is never added in the public area: woodBonus is Homeland-only in game.ts)
  assert.equal(doGather(Q), 1);
});
