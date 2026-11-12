import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, standNear, P, Q, fails } from './coopworld.ts';

type W = Awaited<ReturnType<typeof world>>;

/** A party where Q is a helper in P's Homeland (Town Hall level 3 = three plots). Returns P's Homeland. */
async function setup(role: 'helper' | 'visitor' = 'helper') {
  const w = await world();
  w.home(P);
  w.game.gs.db.prepare('UPDATE homelands SET th = 3 WHERE account = ?').run(P);
  const h = w.home(P);
  w.party(P, Q);
  if (role === 'helper') w.game.homelands.setRole(P, 'party', 'helper');
  w.give(P, 'wheat', 10); w.give(Q, 'wheat', 10);
  return { w, h };
}
/** Puts `a` at plot `idx` of the Homeland (as the owner or as a guest) and runs one farm action. */
function farm(w: W, h: ReturnType<W['home']>, a: string, op: string, idx: number) {
  const plot = h.map.layout.farm.plots[idx];
  const stand = standNear(h.map, plot, 1);
  w.game.positions!.setWorld(a, h.wid, stand, Date.now());
  w.game.reportPosition(a, stand, h.wid);
  const p = w.game.world.state(a); p.energy = 100; w.game.gs.savePlayer(p);
  return w.game.act(a, { action: 'farm', op, plot: idx, world: h.wid, pos: stand }) as any;
}
const growUp = (w: W, h: ReturnType<W['home']>, a: string, idx: number) => {
  for (let d = 0; d < w.econ.farm.growDays; d++) {
    farm(w, h, a, 'water', idx);
    w.adv(w.econ.time.realMsPerGameHour * w.econ.time.hoursPerDay);
  }
};

test('a helper plants in the owner\'s field and gets the harvest even when the owner harvests it', async () => {
  const { w, h } = await setup();
  farm(w, h, Q, 'till', 0);
  const q0 = w.bal(Q, 'wheat');
  farm(w, h, Q, 'plant', 0);
  assert.equal(w.bal(Q, 'wheat'), q0 - 1);
  w.enter(P, P);
  const st = w.game.state(P);
  assert.equal(st.plots[0].mine, false);
  assert.equal(st.plots[0].planter_name, 'Budi');
  assert.equal(w.game.state(Q).plots[0].mine, true);
  growUp(w, h, Q, 0);
  const before = w.bal(Q, 'wheat'), pBefore = w.bal(P, 'wheat');
  const r = farm(w, h, P, 'harvest', 0);
  assert.equal(w.bal(P, 'wheat'), pBefore);
  assert.ok(w.bal(Q, 'wheat') > before);
  assert.match(r.toast, /Budi/);
  const row = w.game.gs.db.prepare("SELECT ref FROM ledger WHERE account = ? AND kind = 'harvest' ORDER BY seq DESC LIMIT 1").get(Q) as { ref: string };
  assert.equal(row.ref, `coop:${P}`);
  assert.equal(w.game.state(P).plots[0].state, 'tilled');
});

test('the owner\'s crop harvested by a helper goes to the owner, with a history row for the owner', async () => {
  const { w, h } = await setup();
  farm(w, h, P, 'till', 1);
  farm(w, h, P, 'plant', 1);
  growUp(w, h, P, 1);
  const before = w.bal(Q, 'wheat'), pBefore = w.bal(P, 'wheat');
  const r = farm(w, h, Q, 'harvest', 1);
  assert.equal(w.bal(Q, 'wheat'), before);
  assert.ok(w.bal(P, 'wheat') > pBefore);
  assert.match(r.toast, /Ani/);
  const hist = w.store.history(P, 50).find((x: any) => x.kind === 'harvest');
  assert.ok(hist, 'history row for the owner');
  assert.match(hist!.summary, /Budi harvested \d+ Wheat for you in Ani's Homeland/);
});

test('guest plot limit is 2', async () => {
  const { w, h } = await setup();
  for (const i of [0, 1]) { farm(w, h, Q, 'till', i); farm(w, h, Q, 'plant', i); }
  farm(w, h, Q, 'till', 2);
  fails(() => farm(w, h, Q, 'plant', 2), 409, 'You already have 2 crops growing here.');
  // the owner is not held by the guest limit
  farm(w, h, P, 'plant', 2);
});

test('a visitor cannot farm', async () => {
  const { w, h } = await setup('visitor');
  fails(() => farm(w, h, Q, 'till', 0), 409, /Helper/);
  assert.equal(w.game.state(Q).plots.length, 0);
});

test('harvest checks the receiver\'s daily cap, not the actor\'s', async () => {
  const { w, h } = await setup();
  farm(w, h, P, 'till', 0);
  farm(w, h, P, 'plant', 0);
  growUp(w, h, P, 0);
  w.give(P, 'wheat', w.econ.caps.dailyGainPerItem);
  fails(() => farm(w, h, Q, 'harvest', 0), 409, /./);
  assert.equal(w.game.state(P).plots[0].state, 'ready');
});

test('owner farming is unchanged', async () => {
  const { w, h } = await setup();
  farm(w, h, P, 'till', 0);
  const p0 = w.bal(P, 'wheat');
  farm(w, h, P, 'plant', 0);
  assert.equal(w.bal(P, 'wheat'), p0 - 1);
  assert.equal(w.game.state(P).plots[0].mine, true);
  growUp(w, h, P, 0);
  farm(w, h, P, 'harvest', 0);
  assert.equal(w.bal(P, 'wheat'), p0 - 1 + w.econ.farm.harvest + (w.econ.seasons[w.game.clock.time().season]?.harvestBonus ?? 0));
  const row = w.game.gs.db.prepare("SELECT ref FROM ledger WHERE account = ? AND kind = 'harvest' ORDER BY seq DESC LIMIT 1").get(P) as { ref: string | null };
  assert.equal(row.ref, null);
});
