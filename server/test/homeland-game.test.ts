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
  const hl = (a: string) => game.homelands.map(game.homelands.ensure(a));
  return { game, econ, adv, hl, store };
}

const fails = (fn: () => unknown, status: number, msg: RegExp | string) =>
  assert.throws(fn, (e: any) => e.status === status && (typeof msg === 'string' ? e.message === msg : msg.test(e.message)));

/** A walkable tile within `d` of `target` on a map. */
function standNear(m: { walkable(x: number, y: number): boolean }, target: Pos, d = 1): Pos {
  for (let dy = -d; dy <= d; dy++) for (let dx = -d; dx <= d; dx++) {
    if (Math.abs(dx) + Math.abs(dy) > d) continue;
    if (m.walkable(target.x + dx, target.y + dy)) return { x: target.x + dx, y: target.y + dy };
  }
  throw new Error('nowhere to stand');
}

test('reload lands at own spawn', async () => {
  const w = await world();
  const home = w.hl(P), id = w.game.homelands.ensure(P).id, wid = `HL-${id}`;
  const pub = w.game.map!.layout.spawn;
  w.game.reportPosition(P, pub, 'public');
  assert.equal(w.game.positions!.worldOf(P), 'public');
  // the page reloads straight into the Homeland: the client reports its own spawn
  w.game.reportPosition(P, home.layout.spawn, wid);
  assert.equal(w.game.positions!.worldOf(P), wid);
  assert.equal(w.game.state(P).worldId, wid);
  // an action never moves a player between worlds, even onto their own spawn (the server restarted and believes 'public')
  w.game.positions!.reset(P);
  fails(() => w.game.act(P, { action: 'eat', token: 'bread', world: wid, pos: home.layout.spawn }), 409, 'Change worlds through the portal.');
  assert.equal(w.game.positions!.worldOf(P), 'public');
  // only the presence poll lands the reload
  w.game.reportPosition(P, home.layout.spawn, wid);
  assert.equal(w.game.positions!.worldOf(P), wid);
  fails(() => w.game.act(P, { action: 'eat', token: 'bread', world: wid, pos: home.layout.spawn }), 409, /energy is already full/); // past the position check
  // someone else's spawn is not believed
  const other = w.hl(Q), oid = `HL-${w.game.homelands.ensure(Q).id}`;
  w.adv(1000);
  fails(() => w.game.act(P, { action: 'eat', token: 'bread', world: oid, pos: other.layout.spawn }), 409, /./);
});

test('the public area allows gathering (publicGather) but not farming or monster fights', async () => {
  const w = await world();
  const pos = w.game.map!.layout.spawn;
  for (const body of [{ action: 'farm', op: 'till', plot: 0 }, { action: 'engage', monster: 'x' }]) {
    fails(() => w.game.act(P, { ...body, pos }), 409, 'The public area is for trading only.');
  }
  // gathering gets past the trade-only rule (it then fails on the tile, not on the rule)
  assert.throws(() => w.game.act(P, { action: 'gather', tile: 'tree', x: pos.x + 1, y: pos.y, pos }), (e: any) => e.message !== 'The public area is for trading only.');
  // with publicGather off, the old rule holds
  w.game.econ.homeland.publicGather = false;
  fails(() => w.game.act(P, { action: 'gather', tile: 'tree', x: pos.x + 1, y: pos.y, pos }), 409, 'The public area is for trading only.');
});

test("ship in a Homeland is refused; building is the owner's from anywhere in their Homeland", async () => {
  const w = await world();
  const home = w.hl(P), wid = `HL-${w.game.homelands.ensure(P).id}`;
  const sp = home.layout.spawn;
  w.game.reportPosition(P, sp, wid);
  fails(() => w.game.act(P, { action: 'ship', token: 'bread', qty: 1, world: wid, pos: sp }), 409, 'The Shipping Box is only in the public area.');
  // the owner may start a lot from anywhere in their Homeland (it answers about cost, not about where they stand)
  assert.throws(() => w.game.act(P, { action: 'build', kind: 'build', target: 'kolam-c', world: wid, pos: sp }), (e: any) => !/near that lot/.test(String(e.message)));
  fails(() => w.game.act(P, { action: 'build', kind: 'th', target: 'th', world: 'public', pos: w.game.map!.layout.spawn }), 409, /Homeland/);
});

test('travel needs the portal', async () => {
  const w = await world();
  const home = w.hl(P), wid = `HL-${w.game.homelands.ensure(P).id}`;
  const sp = home.layout.spawn;
  w.game.reportPosition(P, sp, wid);
  fails(() => w.game.act(P, { action: 'travel', to: 'public', world: wid, pos: sp }), 409, 'Go to the portal first.');
  w.adv(60_000);
  const near = standNear(home, home.portal(), 2);
  const r = w.game.act(P, { action: 'travel', to: 'public', world: wid, pos: near }) as any;
  assert.equal(r.world, 'public');
  assert.deepEqual(r.arrive, w.game.map!.portal());
  assert.equal(r.state.worldId, 'public');
  // back: from the public portal to the Homeland spawn
  w.adv(60_000);
  const back = w.game.act(P, { action: 'travel', to: wid, world: 'public', pos: standNear(w.game.map!, w.game.map!.portal(), 2) }) as any;
  assert.deepEqual(back.arrive, sp);
  assert.equal(back.state.worldId, wid);
});

test('stranger cannot enter HL-<other>', async () => {
  const w = await world();
  const oid = `HL-${w.game.homelands.ensure(Q).id}`;
  w.hl(P);
  w.adv(60_000);
  const near = standNear(w.game.map!, w.game.map!.portal(), 2);
  fails(() => w.game.act(P, { action: 'travel', to: oid, world: 'public', pos: near }), 409, 'You are not invited to this world.');
  fails(() => w.game.act(P, { action: 'eat', token: 'bread', world: oid, pos: w.hl(Q).layout.spawn }), 409, /not invited/);
  // an invited guest may enter and eat, but not gather
  w.game.homelands.setInvites(Q, [P]);
  const r = w.game.act(P, { action: 'travel', to: oid, world: 'public', pos: near }) as any;
  assert.equal(r.world, oid);
  w.adv(1000);
  fails(() => w.game.act(P, { action: 'eat', token: 'bread', world: oid, pos: w.hl(Q).layout.spawn }), 409, /energy is already full/);
  fails(() => w.game.act(P, { action: 'gather', tile: 'tree', x: 1, y: 1, world: oid, pos: w.hl(Q).layout.spawn }), 409, /Helper/);
});

test('demo path: gather wood at home x5, build kolam, advance 45 s, collect after 30 s gives fish, travel to public, sell fish at a stall gives coin', async () => {
  const w = await world();
  const { game } = w;
  const row = game.homelands.ensure(P), wid = `HL-${row.id}`;
  const home = w.hl(P), L = home.layout;
  const spots: Array<{ tree: Pos; stand: Pos }> = [];
  for (let y = 1; y < L.h - 1; y++) for (let x = 1; x < L.w - 1; x++) {
    if (L.tiles[y * L.w + x] !== 'tree' || !home.chunkAt(x, y).open) continue;
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) if (home.walkable(x + dx, y + dy)) { spots.push({ tree: { x, y }, stand: { x: x + dx, y: y + dy } }); break; }
  }
  assert.ok(spots.length >= 2, 'the starting chunk has trees');
  game.reportPosition(P, L.spawn, wid); // Start: the client reports its own spawn first
  for (const s of spots) {
    for (let i = 0; i < 4 && game.gs.balance(P, 'wood') < 5; i++) {
      w.adv(60_000);
      game.act(P, { action: 'gather', tile: 'tree', x: s.tree.x, y: s.tree.y, world: wid, pos: s.stand });
    }
    if (game.gs.balance(P, 'wood') >= 5) break;
  }
  assert.ok(game.gs.balance(P, 'wood') >= 5, 'five wood');
  const lot = L.lots.find((l) => l.id === 'kolam-c')!;
  const door = { x: lot.door.x, y: lot.door.y + 1 }; // the door tile itself becomes part of the building
  w.adv(60_000);
  const b = game.act(P, { action: 'build', kind: 'build', target: 'kolam-c', world: wid, pos: door }) as any;
  assert.equal(b.state.homeland.jobs.length, 1);
  w.adv(45_000);
  assert.equal(game.state(P).homeland!.built.length, 1);
  w.adv(30_000);
  const fish0 = game.gs.balance(P, 'fish');
  const c = game.act(P, { action: 'collect', lot: 'kolam-c', world: wid, pos: door }) as any;
  assert.equal(c.gained.fish, 1);
  assert.equal(game.gs.balance(P, 'fish'), fish0 + 1);
  // portal to the public area, walk to a stall, sell
  w.adv(60_000);
  const t = game.act(P, { action: 'travel', to: 'public', world: wid, pos: standNear(home, home.portal(), 2) }) as any;
  assert.equal(t.state.worldId, 'public');
  const stall = game.map!.layout.market.stalls[0];
  const at = standNear(game.map!, { x: stall.x, y: stall.y + 1 }, 2);
  w.adv(60_000);
  const coin0 = game.gs.balance(P, 'coin');
  const sold = game.act(P, { action: 'sell', merchant: 'sari', token: 'fish', qty: 1, world: 'public', pos: at }) as any;
  assert.ok(sold.toast);
  assert.ok(game.gs.balance(P, 'coin') > coin0, 'the fish paid coin');
  assert.equal(game.gs.balance(P, 'fish'), fish0);
});
