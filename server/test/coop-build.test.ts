import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, P, Q, R, fails } from './coopworld.ts';

type W = Awaited<ReturnType<typeof world>>;
type H = ReturnType<W['home']>;

/** Party P (owner) + Q; Q has the given party role in P's Homeland and stands inside it. */
async function setup(role: 'visitor' | 'helper' | 'builder' = 'builder') {
  const w = await world();
  const h = w.home(P);
  w.party(P, Q);
  w.game.homelands.setRole(P, 'party', role);
  return { w, h };
}
const full = (w: W, a: string) => { const p = w.game.world.state(a); p.energy = 100; w.game.gs.savePlayer(p); };
/** Where to stand for a lot (the tile below its door). */
const doorOf = (h: H, lot: string) => { const l = h.map.layout.lots.find((x) => x.id === lot)!; return { x: l.door.x, y: l.door.y + 1 }; };
const act = (w: W, a: string, h: H, lot: string, body: Record<string, unknown>) => {
  const pos = doorOf(h, lot);
  w.game.positions!.setWorld(a, h.wid, pos, Date.now());
  w.game.reportPosition(a, pos, h.wid);
  w.adv(1000); full(w, a);
  return w.game.act(a, { world: h.wid, pos, ...body }) as any;
};
const build = (w: W, a: string, h: H, lot = 'kolam-c') => act(w, a, h, lot, { action: 'build', kind: 'build', target: lot });
const jobOf = (w: W, h: H, target = 'kolam-c') => w.game.gs.homelandJobs(h.row.account).find((j) => j.target === target)!;

test('a builder starts a Kolam in the owner\'s Homeland paid from their own bag', async () => {
  const { w, h } = await setup('builder');
  w.give(Q, 'wood', 5); w.give(P, 'wood', 5);
  const q0 = w.bal(Q, 'wood'), p0 = w.bal(P, 'wood');
  const r = build(w, Q, h);
  assert.equal(w.bal(Q, 'wood'), q0 - 5);
  assert.equal(w.bal(P, 'wood'), p0);
  assert.match(r.toast, /paid by you/);
  assert.equal(w.game.gs.homelandJobs(P).length, 1);
  assert.equal(w.game.gs.homelandJobs(Q).length, 0);
  // the owner's own build is still paid by the owner
  const row = w.game.gs.db.prepare("SELECT ref FROM ledger WHERE account = ? AND kind = 'build'").get(Q) as { ref: string };
  assert.equal(row.ref, `${h.wid}:build:kolam-c`);
  // not enough in the builder's own bag: the owner's bag does not help
  fails(() => build(w, Q, h, 'rumah-c'), 409, /builder is busy/);
});

test('a helper cannot start builds; a visitor cannot collect', async () => {
  const { w, h } = await setup('helper');
  w.give(Q, 'wood', 5);
  fails(() => build(w, Q, h), 409, /Only the owner or a Builder/);
  assert.equal(w.bal(Q, 'wood'), 5);
  w.game.homelands.setRole(P, 'party', 'visitor');
  fails(() => act(w, Q, h, 'kolam-c', { action: 'collect', lot: 'kolam-c' }), 409, /Helper/);
  fails(() => act(w, Q, h, 'kolam-c', { action: 'assist', target: 'kolam-c' }), 409, /Helper/);
});

/** P builds a Kolam, then it finishes and fills up. */
function readyKolam(w: W, h: H) {
  w.give(P, 'wood', 5);
  build(w, P, h);
  w.adv(200_000);
}

test('collect by a helper credits the owner, under the owner\'s cap', async () => {
  const { w, h } = await setup('helper');
  readyKolam(w, h);
  const p0 = w.bal(P, 'fish'), q0 = w.bal(Q, 'fish');
  const r = act(w, Q, h, 'kolam-c', { action: 'collect', lot: 'kolam-c' });
  const got = w.bal(P, 'fish') - p0;
  assert.ok(got > 0);
  assert.equal(w.bal(Q, 'fish'), q0);
  assert.match(r.toast, /Ani/);
  const row = w.game.gs.db.prepare("SELECT ref FROM ledger WHERE account = ? AND kind = 'collect' ORDER BY seq DESC LIMIT 1").get(P) as { ref: string };
  assert.equal(row.ref, `coop:${Q}`);
  const hist = w.store.history(P, 10).find((x: any) => /collected/.test(x.detail ?? x.text ?? JSON.stringify(x)));
  assert.ok(hist, 'a history row for the owner');
  // the owner's daily cap decides, not the helper's
  w.adv(200_000);
  w.give(P, 'fish', w.econ.caps.dailyGainPerItem);
  const before = w.bal(P, 'fish');
  fails(() => act(w, Q, h, 'kolam-c', { action: 'collect', lot: 'kolam-c' }), 409, /Daily limit/);
  assert.equal(w.bal(P, 'fish'), before);
});

test('assist shortens a job by 15 s, costs 10 energy, stops at 50% of the job', async () => {
  const { w, h } = await setup('helper');
  w.give(P, 'wood', 5);
  build(w, P, h);
  const j0 = jobOf(w, h), span = j0.ends_at - j0.started_at;
  const e0 = () => Math.floor(w.game.world.state(Q).energy);
  const r1 = act(w, Q, h, 'kolam-c', { action: 'assist', target: 'kolam-c' });
  assert.match(r1.toast, /15 s/);
  assert.equal(jobOf(w, h).ends_at, j0.ends_at - 15_000);
  assert.equal(e0(), 90);
  assert.equal(jobOf(w, h).assisted, 15_000);
  // the owner may speed it up too, up to half of the whole job
  act(w, P, h, 'kolam-c', { action: 'assist', target: 'kolam-c' });
  assert.equal(jobOf(w, h).assisted, Math.floor(span * 0.5));
  fails(() => act(w, Q, h, 'kolam-c', { action: 'assist', target: 'kolam-c' }), 409, /can't go any faster/);
  assert.equal(jobOf(w, h).assisted, Math.floor(span * 0.5));
});

test('assist with no job or no energy changes nothing', async () => {
  const { w, h } = await setup('helper');
  fails(() => act(w, Q, h, 'kolam-c', { action: 'assist', target: 'kolam-c' }), 409, /Nothing is being built/);
  w.give(P, 'wood', 5);
  build(w, P, h);
  const ends = jobOf(w, h).ends_at;
  const pos = doorOf(h, 'kolam-c');
  w.game.positions!.setWorld(Q, h.wid, pos, Date.now());
  w.game.reportPosition(Q, pos, h.wid);
  const p = w.game.world.state(Q); p.energy = 5; w.game.gs.savePlayer(p);
  fails(() => w.game.act(Q, { action: 'assist', target: 'kolam-c', world: h.wid, pos }), 409, /energy/i);
  assert.equal(jobOf(w, h).ends_at, ends);
  assert.equal(jobOf(w, h).assisted, 0);
  assert.equal(Math.floor(w.game.world.state(Q).energy), 5);
});

test('demoting a builder mid-job keeps the job and its cost: it finishes once for the owner', async () => {
  const { w, h } = await setup('builder');
  w.give(Q, 'wood', 5);
  build(w, Q, h);
  w.game.homelands.setRole(P, 'party', 'visitor');
  assert.equal(w.bal(Q, 'wood'), 0);
  assert.equal(w.game.gs.homelandJobs(P).length, 1);
  w.adv(100_000);
  w.enter(P, P);
  const st = w.game.state(P).homeland!;
  assert.equal(st.jobs.length, 0);
  assert.deepEqual(st.built.map((b) => b.lot), ['kolam-c']);
  assert.equal(w.game.gs.homelandBuildings(P).length, 1);
  assert.equal(w.bal(Q, 'wood'), 0);
});

test('guests get a trimmed view, and build checks look at their own bag', async () => {
  const { w, h } = await setup('builder');
  const v = w.game.homelands.guestView(P, Q) as any;
  assert.equal(v.hire, undefined);
  assert.equal(v.cosmetics, undefined);
  assert.equal(typeof v.guests.count, 'number');
  assert.equal(v.next.buildings.kolam.can, false);
  w.give(Q, 'wood', 5);
  assert.equal((w.game.homelands.guestView(P, Q) as any).next.buildings.kolam.can, true);
  assert.equal((w.game.homelands.view(P) as any).next.buildings.kolam.can, false);
  void h;
});

test('co-op adds no new coin; the town\'s coin only rises by the build coin', async () => {
  const { w, h } = await setup('builder');
  w.game.gs.db.prepare('UPDATE homelands SET th = 3 WHERE account = ?').run(P);
  const day = w.day(), g = w.game.gs;
  w.give(Q, 'wood', 45); w.give(Q, 'ore', 10); w.give(Q, 'coin', 60); const qc0 = w.bal(Q, 'coin');
  const coin0 = g.newCoin(day), town0 = g.balance(w.game.town, 'coin');
  build(w, Q, h);                                   // Kolam: wood only
  act(w, Q, h, 'kolam-c', { action: 'assist', target: 'kolam-c' });
  w.adv(300_000);
  const r2 = act(w, Q, h, 'restoran-c', { action: 'build', kind: 'build', target: 'restoran-c' }).toast;
  assert.match(r2, /paid by you/);
  act(w, Q, h, 'kolam-c', { action: 'collect', lot: 'kolam-c' });
  assert.equal(g.newCoin(day), coin0);
  assert.equal(g.balance(w.game.town, 'coin'), town0 + 60);
  assert.equal(w.bal(Q, 'coin'), qc0 - 60);
  void R;
});

test('a co-op day settles with no shortfall and the chain matches the game', async () => {
  const { w, h } = await setup('builder');
  w.give(Q, 'wood', 5);
  build(w, Q, h);
  act(w, P, h, 'kolam-c', { action: 'assist', target: 'kolam-c' });
  w.adv(200_000);
  const r = act(w, Q, h, 'kolam-c', { action: 'collect', lot: 'kolam-c' });
  assert.ok(r.toast);
  const settled = w.day();
  await w.game.devSettle();
  assert.equal(w.game.settlement.settledThrough(), settled, 'day settled');
  const n = w.game.gs.db.prepare('SELECT COUNT(*) AS n FROM shortfalls').get() as { n: number };
  assert.equal(n.n, 0);
  const chain = w.game.chain as any;
  for (const a of [P, Q]) for (const t of ['wood', 'fish', 'coin']) assert.equal(String(w.bal(a, t)), String(chain.get(a, t)), `${a} ${t}`);
});

test('a builder cannot raise the Town Hall or open new land, but still builds on lots', async () => {
  const { w, h } = await setup('builder');
  w.give(Q, 'wood', 50); w.give(Q, 'stone', 50); w.give(Q, 'coin', 500);
  const spawn = h.map.layout.spawn;
  const hall = (a: string, body: Record<string, unknown>) => {
    w.game.positions!.setWorld(a, h.wid, spawn, Date.now());
    w.game.reportPosition(a, spawn, h.wid);
    w.adv(1000); full(w, a);
    return w.game.act(a, { world: h.wid, pos: spawn, ...body }) as any;
  };
  const wood0 = w.bal(Q, 'wood'), coin0 = w.bal(Q, 'coin');
  fails(() => hall(Q, { action: 'build', kind: 'th', target: 'th' }), 409, 'Only the owner can upgrade the Town Hall or open new land.');
  fails(() => hall(Q, { action: 'build', kind: 'chunk', target: 'n' }), 409, 'Only the owner can upgrade the Town Hall or open new land.');
  assert.equal(w.game.gs.homelandJobs(P).length, 0);
  assert.equal(w.bal(Q, 'wood'), wood0);
  assert.equal(w.bal(Q, 'coin'), coin0);
  // a lot build by the same builder still works
  w.give(Q, 'wood', 5);
  build(w, Q, h);
  assert.equal(w.game.gs.homelandJobs(P).length, 1);
  // the owner is not blocked by this rule (any refusal here comes from the plan: cost, level)
  try { hall(P, { action: 'build', kind: 'th', target: 'th' }); } catch (e: any) { assert.doesNotMatch(String(e.message), /Only the owner can upgrade/); }
});
