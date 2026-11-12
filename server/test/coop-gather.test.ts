import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, P, Q, fails } from './coopworld.ts';
import type { Pos } from '../src/game/worldmap.ts';

type W = Awaited<ReturnType<typeof world>>;

/** Tree tiles of a Homeland with a walkable neighbour to stand on. */
function trees(h: ReturnType<W['home']>, n: number): Array<{ tree: Pos; stand: Pos }> {
  const L = h.map.layout, out: Array<{ tree: Pos; stand: Pos }> = [];
  for (let y = 1; y < L.h - 1 && out.length < n; y++) for (let x = 1; x < L.w - 1 && out.length < n; x++) {
    if (L.tiles[y * L.w + x] !== 'tree' || !h.map.chunkAt(x, y).open) continue;
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) if (h.map.walkable(x + dx, y + dy)) { out.push({ tree: { x, y }, stand: { x: x + dx, y: y + dy } }); break; }
  }
  assert.ok(out.length >= n, 'enough trees');
  return out;
}
const full = (w: W, a: string) => { const p = w.game.world.state(a); p.energy = 100; w.game.gs.savePlayer(p); };
const chop = (w: W, a: string, h: ReturnType<W['home']>, t: { tree: Pos; stand: Pos }, ms = 60_000) => {
  w.adv(ms); full(w, a);
  return w.game.act(a, { action: 'gather', tile: 'tree', x: t.tree.x, y: t.tree.y, world: h.wid, pos: t.stand }) as any;
};
const promote = (w: W) => w.game.homelands.setRole(P, 'party', 'helper');

test('party mates are visitors by default; the owner raises the party to helper and the wood is the helper\'s', async () => {
  const w = await world();
  const h = w.home(P), [t] = trees(h, 1);
  w.party(P, Q);
  w.enter(Q, P);
  assert.equal(w.game.homelands.access(Q, h.row.id).role, 'visitor');
  fails(() => chop(w, Q, h, t), 409, /Helper/);
  promote(w);
  assert.equal(w.game.homelands.access(Q, h.row.id).role, 'helper');
  const wood = w.bal(Q, 'wood'), pw = w.bal(P, 'wood');
  chop(w, Q, h, t);
  assert.equal(w.bal(Q, 'wood'), wood + 1);
  assert.equal(w.bal(P, 'wood'), pw);
  const row = w.game.gs.db.prepare("SELECT ref FROM ledger WHERE account = ? AND kind = 'gather' ORDER BY seq DESC LIMIT 1").get(Q) as { ref: string };
  assert.ok(row.ref.startsWith(`${h.wid}:`));
  assert.equal(w.game.state(Q).here?.role, 'helper');
});

test('the owner promotes an invited visitor to helper; only allowed roles are accepted, never owner', async () => {
  const w = await world();
  const h = w.home(P), [t] = trees(h, 1);
  w.game.homelands.setInvites(P, [Q]);
  w.enter(Q, P);
  fails(() => chop(w, Q, h, t), 409, /Helper/);
  w.game.homelands.setRole(P, Q, 'helper');
  chop(w, Q, h, t);
  assert.equal(w.game.homelands.view(P).guests[0].role, 'helper');
  fails(() => w.game.homelands.setRole(P, Q, 'owner'), 400, 'Unknown role.');
  fails(() => w.game.homelands.setRole(P, Q, 'none'), 400, 'Unknown role.');
  fails(() => w.game.homelands.setRole(P, 'party', 'owner'), 400, 'Unknown role.');
  fails(() => w.game.homelands.setRole(P, 'constructor', 'helper'), 404, /invite list/);
  w.game.homelands.setRole(P, 'party', 'none');
  assert.equal(w.game.homelands.view(P).party_role, 'none');
});

test('a stored owner role is only a visitor, and a non-owner can only edit their own Homeland', async () => {
  const w = await world();
  const h = w.home(P);
  w.home(Q);
  w.party(P, Q);
  w.game.gs.setHomelandPartyRole(P, 'owner');
  assert.equal(w.game.homelands.access(Q, h.row.id).role, 'visitor');
  w.game.gs.setHomelandPartyRole(P, null);
  w.game.homelands.setInvites(P, [Q]);
  w.game.gs.db.prepare("UPDATE homeland_invites SET role = 'owner' WHERE id = ?").run(h.row.id);
  assert.equal(w.game.homelands.access(Q, h.row.id).role, 'visitor');
  w.game.homelands.setRole(Q, 'party', 'builder'); // Q edits Q's own Homeland, never P's
  assert.equal(w.game.homelands.view(P).party_role, 'visitor');
  assert.equal(w.game.homelands.view(Q).party_role, 'builder');
});

test('guests never take a node\'s last charge; the owner can', async () => {
  const w = await world();
  const h = w.home(P), [t] = trees(h, 1);
  w.party(P, Q); promote(w);
  w.enter(Q, P);
  w.adv(60_000);
  chop(w, Q, h, t, 100); chop(w, Q, h, t, 100); chop(w, Q, h, t, 100);
  fails(() => chop(w, Q, h, t, 100), 409, 'Leave the last one for the owner.');
  assert.equal(w.game.gs.node(`${h.wid}:tree:${t.tree.x},${t.tree.y}`)!.charges, 1);
  w.game.positions!.setWorld(P, h.wid, t.stand, Date.now());
  chop(w, P, h, t, 100);
  assert.equal(w.game.gs.node(`${h.wid}:tree:${t.tree.x},${t.tree.y}`)!.charges, 0);
});

test('guest share caps at 40 units per host per day, and resets the next day', async () => {
  const w = await world();
  const h = w.home(P), [t, t2] = trees(h, 2);
  w.party(P, Q); promote(w);
  w.enter(Q, P);
  w.game.gs.add(w.day(), Q, 'wood', 40, 'gather', `${h.wid}:tree:99,99`);
  assert.equal(w.game.gs.guestTaken(w.day(), Q, h.wid), 40);
  fails(() => chop(w, Q, h, t), 409, /You helped a lot here today \(40\)/);
  w.enter(P, P);
  chop(w, P, h, t2); // the owner is not held by it
  w.adv(w.econ.time.realMsPerGameHour * w.econ.time.hoursPerDay);
  w.game.positions!.setWorld(Q, h.wid, h.map.layout.spawn, Date.now());
  chop(w, Q, h, t);
});

test('no Penebang bonus for guests', async () => {
  const w = await world();
  const h = w.home(P), [t, t2] = trees(h, 2);
  w.party(P, Q); promote(w);
  (w.game.homelands as any).effects = () => ({ woodBonus: 2, builders: 0, farmGrowFactor: 1, fishRate: 1, chef: false, chefBoost: 0, forage: null });
  w.enter(P, P);
  const p0 = w.bal(P, 'wood');
  chop(w, P, h, t2);
  assert.equal(w.bal(P, 'wood') - p0, 3);
  w.enter(Q, P);
  const q0 = w.bal(Q, 'wood');
  chop(w, Q, h, t);
  assert.equal(w.bal(Q, 'wood') - q0, 1);
});

test('winning a monster fight in a Homeland charges the Homeland node, not the village node', async () => {
  const w = await world();
  const h = w.home(P), [t] = trees(h, 1);
  w.party(P, Q); promote(w);
  w.enter(Q, P);
  full(w, Q); w.adv(60_000);
  const m = w.game.monsters!;
  m.rng = () => 0;
  m.pending.set(Q, { kind: 'boar', name: 'Boar', hp: 1, maxHp: 1, tile: 'tree', x: t.tree.x, y: t.tree.y, prefix: `${h.wid}:`, minLeft: 1 });
  const r = w.game.act(Q, { action: 'fight', world: h.wid, pos: t.stand }) as any;
  assert.ok(r.won);
  assert.ok(w.game.gs.node(`${h.wid}:tree:${t.tree.x},${t.tree.y}`), 'Homeland node charged');
  assert.equal(w.game.gs.node(`tree:${t.tree.x},${t.tree.y}`), undefined, 'village node untouched');
  const row = w.game.gs.db.prepare("SELECT ref FROM ledger WHERE account = ? AND kind = 'monster_bonus'").get(Q) as { ref: string } | undefined;
  assert.ok(!row || row.ref.startsWith(`${h.wid}:`));
});

test('the daily gain cap still applies per account to a helper', async () => {
  const w = await world();
  const h = w.home(P), [t] = trees(h, 1);
  w.party(P, Q); promote(w);
  w.enter(Q, P);
  w.give(Q, 'wood', 300);
  fails(() => chop(w, Q, h, t), 409, /Daily limit/);
});
