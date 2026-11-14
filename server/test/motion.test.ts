// Smooth movement for other clients (players.js draws a little in the past, like Minecraft's entity interpolation):
// the server keeps a short trail of each player's outdoor positions with its own clock and marks jumps, and a
// townsperson's walk is sent as a route that starts a little in the future, so every client has it before it begins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { MockChain } from '../src/chain.ts';
import { Game } from '../src/game/game.ts';
import { loadEcon } from '../src/game/econ.ts';
import { Social } from '../src/social.ts';

const A = 'pa.players.test';
function social() {
  const store = new Store(':memory:');
  let now = 1_800_000_000_000;
  return { s: new Social(store, () => now), tick: (ms: number) => { now += ms; }, now: () => now };
}
const out = (x: number, y: number, fx = x, fy = y) => ({ x, y, fx, fy, dir: 'right', scene: 'out' });

test('a walking player leaves a trail of timed positions; the first one and a jump are marked', () => {
  const { s, tick, now } = social();
  s.report(A, 'public', out(10, 10));
  const t0 = now();
  tick(220); s.report(A, 'public', out(10, 10, 10.5, 10));
  tick(220); s.report(A, 'public', out(11, 10, 11.1, 10));
  let tr = s.seen.get(A)!.trail!;
  assert.deepEqual(tr.map((q) => [q.t - t0, q.x, q.y, !!q.tp]), [[0, 10, 10, true], [220, 10.5, 10, false], [440, 11.1, 10, false]]);
  tick(220); s.report(A, 'public', out(30, 10)); // 19 tiles in 0.22 s: not a walk
  tr = s.seen.get(A)!.trail!;
  assert.equal(tr.at(-1)!.tp, true, 'drawn as a jump');
  for (let i = 0; i < 20; i++) { tick(220); s.report(A, 'public', out(30, 10)); }
  assert.ok(s.seen.get(A)!.trail!.length <= 8, 'the trail stays short');
});

test('a new world, going indoors or a long silence starts the trail over with a jump', () => {
  const { s, tick } = social();
  s.report(A, 'public', out(10, 10));
  tick(200); s.report(A, 'HL-2', out(11, 10));
  assert.deepEqual(s.seen.get(A)!.trail!.map((q) => !!q.tp), [true], 'another world');
  tick(200); s.report(A, 'HL-2', { x: 3, y: 3, dir: 'down', scene: 'in', room: 'b:1', rx: 3, ry: 3 });
  assert.equal(s.seen.get(A)!.trail, undefined, 'no trail indoors');
  tick(200); s.report(A, 'HL-2', out(11, 10));
  tick(5000); s.report(A, 'HL-2', out(11, 10));
  assert.deepEqual(s.seen.get(A)!.trail!.map((q) => !!q.tp), [true], 'a long silence: the old samples are gone and the new one is a jump');
});

test('a townsperson\'s walk is sent as a route that starts in the future, and the route matches where the server has it', async () => {
  const econ = loadEcon();
  const chain = new MockChain();
  const base = Object.fromEntries(Object.entries(econ.items).map(([t, i]) => [t, i.base]));
  chain.accounts.add('town.gt.test'); chain.add('town.gt.test', 'coin', 5000n);
  for (const [id, d] of Object.entries(econ.merchants)) chain.addMerchant(`${id}.gt.test`, d.shop, { coin: d.restore.coin, ...d.restore.items }, { coin: d.startCash, ...d.startStock }, base);
  let now = 1_800_000_000_000;
  const game = new Game(new Store(':memory:'), chain, { merchantParent: 'gt.test', town: 'town.gt.test', now: () => now, rng: () => 0.99, econ, worldSeed: 42 });
  await game.init();
  const r = game.residents;
  r.pay(game.clock.time().settleDay, 'sari', 'bread', 7); // r1 is sent to Sari's stall
  for (let i = 0; i < 10; i++) { now += 400; r.tick(now); }
  const w = r.walkers[0], v = r.view(now).find((x) => x.id === 'r1')!;
  assert.ok(w.t0 > now - 4000, 'a walk was chosen');
  // the route's first tile is where the resident is now (or just left), and replaying it gives the server's position
  const at = (t: number) => {
    const p = v.route.pts, n = p.length / 2, done = Math.max(0, ((t - v.route.t0) / 1000) * v.route.sp);
    if (n === 1 || done >= n - 1) return { x: p[2 * n - 2], y: p[2 * n - 1] };
    const i = Math.floor(done), f = done - i;
    return { x: p[2 * i] + (p[2 * i + 2] - p[2 * i]) * f, y: p[2 * i + 1] + (p[2 * i + 3] - p[2 * i + 1]) * f };
  };
  for (const dt of [0, 300, 1000, 2500]) {
    const s = r.view(now + dt).find((x) => x.id === 'r1')!, c = at(now + dt);
    assert.ok(Math.abs(s.fx - c.x) < 0.01 && Math.abs(s.fy - c.y) < 0.01, `same place at +${dt} ms`);
  }
  // a walk picked now begins later: every client hears of it before the resident sets off
  const idle = r.walkers.find((x) => !x.job && x.path.length === 1)!;
  idle.until = 0; r.queue.length = 0;
  r.tick(now);
  if (idle.path.length > 1) assert.ok(idle.t0 >= now + 1000, 'the new walk starts after a lead');
});
