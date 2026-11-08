import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { GameStore } from '../src/game/gamestore.ts';
import { loadEcon } from '../src/game/econ.ts';
import { Homelands, homeWorld, parseHome, type PlayerDir } from '../src/game/homeland.ts';
import { HttpError } from '../src/auth.ts';

const TOWN = 'town.gt.test';
const A = 'a.players.test';
const B = 'b.players.test';
const SEED = 20261114;
const DAY = 1;

function setup(opts: { store?: Store; start?: number; players?: PlayerDir } = {}) {
  const econ = loadEcon();
  const store = opts.store ?? new Store(':memory:');
  const gs = new GameStore(store.db);
  const clock = { t: opts.start ?? 1_800_000_000_000 };
  const mk = () => new Homelands({ econ, gs, worldSeed: SEED, now: () => clock.t, town: TOWN, players: opts.players });
  return { econ, store, gs, clock, hl: mk(), mk, advance: (ms: number) => { clock.t += ms; } };
}
const give = (gs: GameStore, a: string, t: string, n: number) => gs.add(DAY, a, t, n, 'test');
const fails = (fn: () => unknown, status: number, msg: string | RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof HttpError && e.status === status && (typeof msg === 'string' ? e.message === msg : msg.test(e.message)));

test('world ids round trip', () => {
  assert.equal(homeWorld(7), 'HL-7');
  assert.equal(parseHome('HL-7'), 7);
  assert.equal(parseHome('public'), null);
  assert.equal(parseHome('HL-0'), null);
  assert.equal(parseHome('IS-3'), null);
});

test('ensure is idempotent and ids count up', () => {
  const { hl } = setup();
  const a = hl.ensure(A), b = hl.ensure(B);
  assert.equal(a.id, 1);
  assert.equal(b.id, 2);
  assert.deepEqual(hl.ensure(A), a);
  assert.equal(a.th, 1);
  assert.deepEqual(a.open, []);
  assert.equal(a.gen, 1);
  assert.notEqual(a.seed, b.seed);
  assert.equal(hl.byId(2)!.account, B);
  assert.equal(hl.byId(99), undefined);
});

test('kolam build: 5 wood leaves, job ends after 45 s, building exists after', () => {
  const { hl, gs, advance } = setup();
  hl.ensure(A);
  give(gs, A, 'wood', 8);
  const lot = hl.view(A).next.buildings.kolam.lot!;
  assert.equal(lot, 'kolam-c');
  const r = hl.start(A, 'build', lot, DAY);
  assert.equal(gs.balance(A, 'wood'), 3);
  assert.equal(r.ends_at, 1_800_000_000_000 + 45_000);
  assert.deepEqual(r.tags, ['wood']);
  let v = hl.view(A);
  assert.equal(v.built.length, 0);
  assert.equal(v.jobs.length, 1);
  assert.deepEqual(v.builders, { total: 1, busy: 1 });
  advance(44_000);
  assert.equal(hl.view(A).built.length, 0);
  advance(1_000);
  v = hl.view(A);
  assert.equal(v.built.length, 1);
  assert.equal(v.built[0].lot, 'kolam-c');
  assert.equal(v.built[0].kind, 'kolam');
  assert.equal(v.jobs.length, 0);
  assert.deepEqual(v.builders, { total: 1, busy: 0 });
  // the map now has the building on the lot
  const m = hl.map(hl.ensure(A));
  assert.ok(m.layout.buildings.some((b) => b.kind === 'kolam'));
});

test('one builder: a second start answers 409 Builder sedang bekerja', () => {
  const { hl, gs } = setup();
  hl.ensure(A);
  give(gs, A, 'wood', 30);
  hl.start(A, 'build', 'kolam-c', DAY);
  fails(() => hl.start(A, 'chunk', 'n', DAY), 409, 'Builder sedang bekerja.');
  assert.equal(gs.balance(A, 'wood'), 25); // nothing charged for the refused start
});

test('finishes once after restart', () => {
  const s = setup();
  s.hl.ensure(A);
  give(s.gs, A, 'wood', 5);
  s.hl.start(A, 'build', 'kolam-c', DAY);
  s.advance(10 * 60_000); // "server down" for 10 minutes
  const hl2 = s.mk();
  assert.equal(hl2.view(A).built.length, 1);
  assert.equal(hl2.view(A).built.length, 1);
  hl2.settle(A);
  s.mk().settle(A);
  assert.equal(s.gs.homelandBuildings(A).length, 1);
  // production counts from the moment the building was done, not from the restart
  assert.equal(s.gs.homelandBuildings(A)[0].last_collect, 1_800_000_000_000 + 45_000);
  assert.equal(hl2.view(A).built[0].stored, 6);
});

test('chunk n=1 needs 10 wood and an adjacent chunk', () => {
  const { hl, gs, advance } = setup();
  hl.ensure(A);
  give(gs, A, 'wood', 9);
  fails(() => hl.start(A, 'chunk', 'n', DAY), 409, 'Kayu kurang (punya 9, perlu 10).');
  give(gs, A, 'wood', 1);
  fails(() => hl.start(A, 'chunk', 'nw', DAY), 409, 'Chunk itu tidak bersebelahan dengan wilayahmu.');
  fails(() => hl.start(A, 'chunk', 'c', DAY), 409, 'Sudah dibangun.');
  hl.start(A, 'chunk', 'n', DAY);
  assert.equal(gs.balance(A, 'wood'), 0);
  advance(30_000);
  assert.deepEqual(hl.view(A).open, ['n']);
  // n is open now, so nw and ne touch it; step 2 needs Town Hall 2
  give(gs, A, 'wood', 100); give(gs, A, 'coin', 100);
  fails(() => hl.start(A, 'chunk', 'nw', DAY), 409, 'Balai Kota perlu level 2.');
});

test('th upgrade needs coin, coin goes to the town', () => {
  const { hl, gs, advance } = setup();
  hl.ensure(A);
  give(gs, A, 'wood', 30); give(gs, A, 'ore', 5); give(gs, A, 'coin', 49);
  fails(() => hl.start(A, 'th', 'th', DAY), 409, 'Koin kurang (punya 49, perlu 50).');
  give(gs, A, 'coin', 1);
  const town0 = gs.balance(TOWN, 'coin');
  hl.start(A, 'th', 'th', DAY);
  assert.equal(gs.balance(A, 'coin'), 0);
  assert.equal(gs.balance(A, 'wood'), 0);
  assert.equal(gs.balance(A, 'ore'), 0);
  assert.equal(gs.balance(TOWN, 'coin'), town0 + 50);
  advance(120_000);
  const v = hl.view(A);
  assert.equal(v.th, 2);
  assert.equal(v.next.th!.level, 3);
});

test('collect: 60 s gives 2 fish, capacity 6 caps 10 min', () => {
  const { hl, gs, advance } = setup();
  hl.ensure(A);
  give(gs, A, 'wood', 5);
  hl.start(A, 'build', 'kolam-c', DAY);
  advance(45_000);
  fails(() => hl.collect(A, 'kolam-c', DAY, () => {}), 409, 'Belum ada hasil.');
  advance(60_000);
  assert.equal(hl.view(A).built[0].stored, 2);
  const r = hl.collect(A, 'kolam-c', DAY, () => {});
  assert.deepEqual(r.gained, { fish: 2 });
  assert.equal(gs.balance(A, 'fish'), 2);
  assert.equal(hl.view(A).built[0].stored, 0);
  advance(15_000); // half a fish: the remainder is kept
  assert.equal(hl.view(A).built[0].stored, 0);
  advance(15_000);
  assert.equal(hl.view(A).built[0].stored, 1);
  advance(10 * 60_000);
  assert.equal(hl.view(A).built[0].stored, 6);
  hl.collect(A, 'kolam-c', DAY, () => {});
  assert.equal(gs.balance(A, 'fish'), 8);
  assert.equal(hl.view(A).built[0].stored, 0); // a full building restarts from now
  fails(() => hl.collect(A, 'restoran-c', DAY, () => {}), 409, 'Belum ada bangunan di sini.');
});

test('collect over the daily cap: 409 and stored unchanged', () => {
  const { hl, gs, advance } = setup();
  hl.ensure(A);
  give(gs, A, 'wood', 5);
  hl.start(A, 'build', 'kolam-c', DAY);
  advance(45_000 + 60_000);
  const cap = () => { throw new HttpError(409, 'Batas harian Ikan tercapai (200 per hari). Lanjut besok.'); };
  fails(() => hl.collect(A, 'kolam-c', DAY, cap), 409, /Batas harian/);
  assert.equal(gs.balance(A, 'fish'), 0);
  assert.equal(hl.view(A).built[0].stored, 2);
  hl.collect(A, 'kolam-c', DAY, () => {});
  assert.equal(gs.balance(A, 'fish'), 2);
});

test('guest access: invited 200, stranger 409', () => {
  const dir: PlayerDir = {
    nameOf: (a) => (a === A ? 'Andi' : a === B ? 'Budi' : null),
    accountByName: (n) => (n === 'Budi' ? B : n === 'Andi' ? A : null),
    isPlayer: (a) => a === A || a === B,
  };
  const { hl } = setup({ players: dir });
  const row = hl.ensure(A);
  hl.ensure(B);
  assert.equal(hl.access(A, row.id).owner, true);
  fails(() => hl.access(B, row.id), 409, 'Kamu tidak diundang ke dunia ini.');
  fails(() => hl.access(B, 99), 404, /./);
  assert.deepEqual(hl.setInvites(A, ['Budi', A, 'Budi']), [B]);
  const g = hl.access(B, row.id);
  assert.equal(g.owner, false);
  assert.deepEqual(hl.view(A).guests, ['Budi']);
  assert.deepEqual(hl.invitedTo(B), [{ id: row.id, world: 'HL-1', owner_name: 'Andi' }]);
  fails(() => hl.setInvites(A, ['Nobody']), 400, /Pemain tidak ditemukan/);
});
