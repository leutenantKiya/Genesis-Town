// The land's work buildings, after Kingshot's resource buildings: the Penggergajian (sawmill) makes wood, the Kincir
// Angin (windmill) makes wheat, and the Gudang (storehouse) raises how much every producing building holds, in three
// levels. Each is unlocked by a Town Hall level and stands in an outer chunk that must be open first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { MockChain } from '../src/chain.ts';
import { Game } from '../src/game/game.ts';
import { loadEcon } from '../src/game/econ.ts';

const TOWN = 'town.gt.test', P = 'p1.players.test';

async function setup() {
  const econ = loadEcon();
  const chain = new MockChain();
  chain.accounts.add(TOWN); chain.add(TOWN, 'coin', 5000n);
  for (const [id, d] of Object.entries(econ.merchants)) chain.addMerchant(`${id}.gt.test`, d.shop, { coin: d.restore.coin, ...d.restore.items }, { coin: d.startCash, ...d.startStock }, {});
  const store = new Store(':memory:');
  let now = 1_800_000_000_000;
  const game = new Game(store, chain, { merchantParent: 'gt.test', town: TOWN, econ, worldSeed: 42, now: () => now, rng: () => 0.99 });
  await game.init();
  store.addPlayer(P, 'sub-' + P, 'ed25519:o'); await chain.registerPlayer(P); game.onNewPlayer(P);
  const gs = game.gs, H = game.homelands, ms = econ.time.realMsPerGameHour;
  for (const t of ['coin', 'fish', 'wood', 'wheat', 'ore']) gs.add(1, P, t, -gs.balance(P, t), 'test');
  gs.add(1, P, 'wood', 1000, 'test'); gs.add(1, P, 'ore', 500, 'test'); gs.add(1, P, 'coin', 3000, 'test');
  const lotOf = (kind: string) => H.view(P).next.buildings[kind].lot!;
  const chunkOf = (lot: string) => lot.slice(lot.lastIndexOf('-') + 1);
  const noCap = () => {};
  /** Runs the clock to the end of the running job, so production starts from that instant. */
  const finish = () => { const j = H.view(P).jobs[0]; now = j.ends_at; H.view(P); };
  return { econ, gs, H, ms, adv: (n: number) => { now += n; }, finish, lotOf, chunkOf, noCap };
}

const fails = (fn: () => unknown, status: number, msg: RegExp | string) =>
  assert.throws(fn, (e: any) => e.status === status && (typeof msg === 'string' ? e.message === msg : msg.test(e.message)));
const built = (H: any, lot: string) => H.view(P).built.find((b: any) => b.lot === lot);

test('the sawmill needs Town Hall 2 and its open forest, then makes 2 wood a game hour up to 8', async () => {
  const w = await setup();
  const { H, gs } = w, lot = w.lotOf('penggergajian');
  assert.match(lot, /^penggergajian-(n|w|e|s|nw|ne|sw|se)$/);
  fails(() => H.start(P, 'build', lot, 1), 409, 'Town Hall needs level 2.');
  gs.setHomelandTh(P, 2);
  fails(() => H.start(P, 'build', lot, 1), 409, "That region isn't open yet.");
  gs.setHomelandOpen(P, [w.chunkOf(lot)]);
  H.start(P, 'build', lot, 1);
  assert.deepEqual([gs.balance(P, 'wood'), gs.balance(P, 'ore'), gs.balance(P, 'coin')], [980, 495, 2960]);
  w.finish();
  assert.equal(built(H, lot).stored, 0);
  w.adv(w.ms);
  assert.equal(built(H, lot).stored, 2);
  w.adv(w.ms * 10);
  assert.deepEqual([built(H, lot).stored, built(H, lot).capacity], [8, 8]);
  const r = H.collect(P, lot, 1, w.noCap);
  assert.deepEqual(r.gained, { wood: 8 });
  assert.equal(gs.balance(P, 'wood'), 988);
});

test('the windmill needs Town Hall 3 and makes 3 wheat a game hour up to 12', async () => {
  const w = await setup();
  const { H, gs } = w, lot = w.lotOf('kincir');
  gs.setHomelandTh(P, 2); gs.setHomelandOpen(P, [w.chunkOf(lot)]);
  fails(() => H.start(P, 'build', lot, 1), 409, 'Town Hall needs level 3.');
  gs.setHomelandTh(P, 3);
  H.start(P, 'build', lot, 1);
  w.finish(); w.adv(w.ms * 2);
  assert.equal(built(H, lot).stored, 6);
  w.adv(w.ms * 10);
  assert.deepEqual([built(H, lot).stored, built(H, lot).capacity], [12, 12]);
  assert.deepEqual(H.collect(P, lot, 1, w.noCap).gained, { wheat: 12 });
});

test('the storehouse raises every producing building\'s capacity by 50%, 100% and 150% over three levels', async () => {
  const w = await setup();
  const { H, gs } = w, store = w.lotOf('gudang');
  gs.setHomelandTh(P, 3); gs.setHomelandOpen(P, [w.chunkOf(store)]);
  H.start(P, 'build', 'kolam-c', 1); w.adv(45_000 * 3);
  assert.equal(built(H, 'kolam-c').capacity, 6);
  assert.equal(H.view(P).storehouse, null);
  fails(() => H.start(P, 'upgrade', store, 1), 409, 'Build the Storehouse first.');
  H.start(P, 'build', store, 1); w.adv(300_000 * 3);
  const sh = () => H.view(P).storehouse!;
  assert.deepEqual([sh().lot, sh().level, sh().maxLevel, sh().bonus, sh().nextBonus], [store, 1, 3, 0.5, 1]);
  assert.equal(built(H, 'kolam-c').capacity, 9);
  for (const [lvl, cap] of [[2, 12], [3, 15]]) {
    H.start(P, 'upgrade', store, 1);
    assert.equal(H.view(P).jobs[0].target, `${store}:up`);
    w.adv(1200_000 * 3);
    assert.deepEqual([sh().level, built(H, 'kolam-c').capacity], [lvl, cap]);
  }
  assert.equal(sh().next, null);
  fails(() => H.start(P, 'upgrade', store, 1), 409, 'The Storehouse is already at the highest level.');
  // a full pond now holds 15 fish and gives them all at once
  w.adv(w.ms * 20);
  assert.equal(built(H, 'kolam-c').stored, 15);
  assert.deepEqual(H.collect(P, 'kolam-c', 1, w.noCap).gained, { fish: 15 });
  assert.equal(gs.homelandBuildings(P).length, 2); // upgrades are not new buildings
});

test('a building that has no levels cannot be upgraded, and the hospital keeps its own wording', async () => {
  const w = await setup();
  const { H, gs } = w;
  gs.setHomelandTh(P, 3);
  H.start(P, 'build', 'kolam-c', 1); w.adv(45_000 * 3);
  fails(() => H.start(P, 'upgrade', 'kolam-c', 1), 409, 'That building does not level up.');
  fails(() => H.start(P, 'upgrade', 'rumahsakit-c', 1), 409, 'Build the Hospital first.');
});
