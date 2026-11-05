import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as near from 'near-api-js';
import { Store } from '../src/db.ts';
import { MockChain } from '../src/chain.ts';
import { Game } from '../src/game/game.ts';
import { loadEcon } from '../src/game/econ.ts';
import { IslandMap, Village, type GameMap } from '../src/game/worldmap.ts';
import { createApp } from '../src/app.ts';
import { requestMessage } from '../src/reqauth.ts';
import { loadConfig } from '../src/config.ts';
import { signedDelegateB64 } from './helpers.ts';

const TOWN = 'town.gt.test';
const P = 'p1.players.test';
const Q = 'p2.players.test';
const SEED = 20261114;

async function harness(opts: { game?: boolean; chain?: MockChain; store?: Store } = {}) {
  const econ = loadEcon();
  const cfg = loadConfig({ CHAIN_MODE: 'mock', GAME_CONTRACT_ID: 'game.test', PLAYERS_PARENT_ACCOUNT_ID: 'players.test', TOWN_ACCOUNT_ID: TOWN, MERCHANT_PARENT_ACCOUNT_ID: 'gt.test' } as NodeJS.ProcessEnv);
  const voucher = near.KeyPair.fromRandom('ed25519');
  const chain = opts.chain ?? new MockChain();
  chain.contractId = cfg.gameContractId;
  chain.brokerId = cfg.brokerAccountId;
  chain.voucherKey = voucher.getPublicKey();
  if (!opts.chain) {
    const base = Object.fromEntries(Object.entries(econ.items).map(([t, i]) => [t, i.base]));
    chain.accounts.add(TOWN);
    chain.add(TOWN, 'coin', 5000n);
    for (const [id, d] of Object.entries(econ.merchants)) chain.addMerchant(`${id}.gt.test`, d.shop, { coin: d.restore.coin, ...d.restore.items }, { coin: d.startCash, ...d.startStock }, base);
  }
  const store = opts.store ?? new Store(':memory:');
  let now = 1_800_000_000_000;
  const clock = { now: () => now, advanceHours: (h: number) => { now += h * econ.time.realMsPerGameHour; } };
  const game = new Game(store, chain, { merchantParent: 'gt.test', town: TOWN, now: clock.now, rng: () => 0.99, econ, chunkSize: 5, worldSeed: SEED, contractId: cfg.gameContractId, voucherSigner: voucher });
  await game.init();
  for (const a of [P, Q]) {
    if (!store.sessionKeyOwner('x') && !store.db.prepare('SELECT 1 FROM players WHERE account_id = ?').get(a)) {
      store.addPlayer(a, 'sub-' + a, 'ed25519:o');
      await chain.registerPlayer(a);
      game.onNewPlayer(a);
    }
  }
  return { econ, cfg, chain, store, game, clock, voucher };
}
type H = Awaited<ReturnType<typeof harness>>;

/** Gives an account coin and goods that already exist on chain (so a settlement can spend them). */
async function fund(h: H, a: string, items: Record<string, number>) {
  for (const [t, n] of Object.entries(items)) h.chain.add(a, t, BigInt(n));
  await h.game.settlement.refresh([a]);
}

/** Runs a contract call the way the relayer would: through the mock chain, then the same sync the app does. */
async function relayCall(h: H, sender: string, method: string, args: Record<string, unknown>) {
  const r = await h.chain.relay({ delegateAction: { actions: [{ functionCall: { methodName: method, args: Buffer.from(JSON.stringify(args)) } }] } }, sender);
  await h.game.islands.syncOne(Number(args.island_id));
  await h.game.settlement.refresh([sender]);
  return r;
}
const voucherFor = (h: H, a: string, kind: string, id: number) => h.game.islands.voucher(a, kind, id);
async function buy(h: H, a: string, id: number) {
  const v = await voucherFor(h, a, 'buy', id);
  const r = await relayCall(h, a, v.method, v.args);
  assert.ok(r.ok, r.error);
}
/** Standing still `ms` later, so position jumps are never the reason a test fails. */
function step(h: H) { h.clock.advanceHours(0.1); }

function reach(map: GameMap & { layout: { w: number; h: number; spawn: { x: number; y: number } } }) {
  const { w, h, spawn } = map.layout;
  const seen = new Set<number>([spawn.y * w + spawn.x]);
  const q = [[spawn.x, spawn.y]];
  while (q.length) {
    const [x, y] = q.pop()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || seen.has(ny * w + nx) || !map.walkable(nx, ny)) continue;
      seen.add(ny * w + nx); q.push([nx, ny]);
    }
  }
  return (x: number, y: number) => seen.has(y * w + x);
}

test('generator_is_deterministic_and_reachable', () => {
  for (const seed of [7101, 7102, 7103, 7104, 7105, 7106, 7107, 7108, 1, 99999]) {
    for (const size of [1, 2, 3]) {
      const a = new IslandMap(seed, { size_level: size, fertility_level: 1 }).layout;
      const b = new IslandMap(seed, { size_level: size, fertility_level: 1 }).layout;
      assert.deepEqual(a.tiles, b.tiles, 'same seed, same island');
      assert.equal(a.w, 32); assert.equal(a.h, 32);
      assert.equal(a.farm.plots.length, [0, 6, 9, 12][size]);
      assert.equal(a.chunks.length, 1); assert.equal(a.chunks[0].id, 'island'); assert.equal(a.chunks[0].name, 'Pulau Pribadi');
      assert.deepEqual(a.market.stalls, []);
      const house = a.buildings.filter((x) => x.own);
      assert.equal(house.length, 1);
      const map = new IslandMap(seed, { size_level: size, fertility_level: 1 });
      const ok = reach(map);
      assert.ok(ok(a.spawn.x, a.spawn.y), 'spawn');
      assert.ok(ok(a.dock.x, a.dock.y), 'spawn reaches the dock');
      assert.ok(ok(house[0].dx, house[0].dy + 1), 'house door');
      for (const p of a.farm.plots) assert.ok(ok(p.x, p.y), 'plot ' + p.x + ',' + p.y);
      assert.ok(a.tiles.filter((t) => t === 'tree').length >= 8 && a.tiles.includes('rock') && a.tiles.includes('water'));
      // fertility only adds walkable decoration: the same attempt, the same blocking tiles
      const f3 = new IslandMap(seed, { size_level: size, fertility_level: 3 });
      assert.deepEqual(a.tiles.map((t) => ['tree', 'rock', 'water', 'fence'].includes(t)), f3.layout.tiles.map((t) => ['tree', 'rock', 'water', 'fence'].includes(t)));
    }
  }
});

const tileHash = (L: { tiles: string[]; buildings: unknown[] }) => createHash('sha256').update(L.tiles.join() + JSON.stringify(L.buildings)).digest('hex');
test('village_layout_unchanged_by_dock', () => {
  // hashes taken from the generator before dockOf existed
  const before: Record<number, string> = { 20261114: '373841a13b9b427ceacd981075f479ab2f8d30d3777f35544f7f955d4f6ee426', 123: '30ae752a9cc6423d353191f0c7b870332196461a89a388867f469c42cc54d50b' };
  for (const [seed, hash] of Object.entries(before)) {
    const L = Village.generate(Number(seed));
    const dock = Village.dockOf(L);
    assert.equal(tileHash(L), hash, 'tiles and buildings are what they were');
    assert.deepEqual(Village.dockOf(L), dock, 'deterministic');
    assert.equal(tileHash(Village.generate(Number(seed))), hash, 'a fresh generate is unaffected too');
    // walkable shore next to water, reachable, in an open area
    const near = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => L.tiles[(dock.y + dy) * L.w + dock.x + dx] === 'water');
    assert.ok(near, 'dock touches water');
    assert.ok(!['water', 'tree', 'rock', 'fence', 'stall', 'lamp'].includes(L.tiles[dock.y * L.w + dock.x]));
    assert.ok(Village.chunkOf(L, dock.x, dock.y).open);
  }
});

test('buy_voucher_requires_settled_coin', async () => {
  const h = await harness();
  await assert.rejects(voucherFor(h, P, 'buy', 1), /Koin kurang/);
  await fund(h, P, { coin: 499 });
  await assert.rejects(voucherFor(h, P, 'buy', 1), /Koin kurang/, '499 < price 500');
  // coin that exists only off-chain today (not settled) does not count
  h.game.gs.add(0, P, 'coin', 1000, 'test');
  await assert.rejects(voucherFor(h, P, 'buy', 1), /Koin kurang/);
  await fund(h, P, { coin: 1 });
  const v = await voucherFor(h, P, 'buy', 1);
  assert.equal(v.method, 'buy_island');
  assert.deepEqual(v.args.spec, { seed: 7101, size_level: 1, fertility_level: 1 });
  assert.equal(v.args.price, '500');
  assert.match(String(v.args.expires_ns), /^\d+$/);
  await assert.rejects(voucherFor(h, P, 'buy', 99), /tidak dijual/);
});

test('voucher_is_bound_to_buyer_island_and_price_and_works_once', async () => {
  const h = await harness();
  await fund(h, P, { coin: 5000 }); await fund(h, Q, { coin: 5000 });
  const v = await voucherFor(h, P, 'buy', 2);
  assert.equal((await relayCall(h, Q, 'buy_island', v.args)).ok, false, "another buyer cannot use P's voucher");
  assert.equal((await relayCall(h, P, 'buy_island', { ...v.args, island_id: 3 })).ok, false, 'other island');
  assert.equal((await relayCall(h, P, 'buy_island', { ...v.args, price: '1' })).ok, false, 'other price');
  assert.equal((await relayCall(h, P, 'buy_island', { ...v.args, spec: { seed: 7102, size_level: 3, fertility_level: 5 } })).ok, false, 'other spec');
  const ok = await relayCall(h, P, 'buy_island', v.args);
  assert.ok(ok.ok, ok.error);
  assert.equal((await relayCall(h, P, 'buy_island', v.args)).ok, false, 'reused after a successful buy');
  h.chain.nowNs = () => 9_999_999_999_999_999_999_999n;
  assert.equal((await relayCall(h, Q, 'buy_island', (await voucherFor(h, Q, 'buy', 3)).args)).ok, false, 'expired');
});

test('buy_flow_creates_island_state', async () => {
  const h = await harness();
  const kp = near.KeyPair.fromRandom('ed25519');
  h.store.addSessionKey(kp.getPublicKey().toString(), P);
  const { server } = createApp({ cfg: h.cfg, chain: h.chain, store: h.store, game: h.game, verify: async () => ({ sub: 'x' }), currentBlockHeight: async () => 0n, clientDir: '.' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const raw = body === undefined ? '' : JSON.stringify(body), ts = String(Date.now());
    const sig = kp.sign(new TextEncoder().encode(requestMessage(method, path, ts, raw))).signature;
    const res = await fetch(base + path, { method, body: raw || undefined, headers: { 'x-account-id': P, 'x-gt-key': kp.getPublicKey().toString(), 'x-gt-ts': ts, 'x-gt-sig': Buffer.from(sig).toString('base64') } });
    return { status: res.status, json: (await res.json()) as any };
  };
  try {
    let r = await call('GET', '/api/islands');
    assert.equal(r.status, 200);
    assert.equal(r.json.offers.length, 8); assert.deepEqual(r.json.mine, []);
    assert.deepEqual(Object.keys(r.json.offers[0]).sort(), ['island_id', 'name', 'price', 'spec']);
    assert.equal((await call('POST', '/api/islands/voucher', { kind: 'buy', island_id: 1 })).status, 409, 'no settled coin yet');
    await fund(h, P, { coin: 900 });
    r = await call('POST', '/api/islands/voucher', { kind: 'buy', island_id: 1 });
    assert.equal(r.status, 200);
    assert.equal(r.json.method, 'buy_island');
    // the client passes method + args to its signed relay call
    const { b64 } = signedDelegateB64({ sender: P, method: r.json.method, args: r.json.args, key: kp });
    const relayed = await fetch(base + '/api/relay', { method: 'POST', body: JSON.stringify({ signedDelegate: b64 }) });
    const out = (await relayed.json()) as any;
    assert.equal(relayed.status, 200, JSON.stringify(out));
    assert.equal(out.status, 'mock', JSON.stringify(out));
    r = await call('GET', '/api/islands');
    assert.equal(r.json.offers.length, 7, 'bought island is no longer offered');
    assert.equal(r.json.mine.length, 1);
    const m = r.json.mine[0];
    assert.equal(m.token_id, 'IS-1-1'); assert.equal(m.version, 1);
    assert.deepEqual(m.saved, { seed: 7101, size_level: 1, fertility_level: 1 });
    assert.deepEqual(m.live, m.saved); assert.deepEqual(m.savable, m.saved);
    assert.deepEqual(m.pending, []); assert.deepEqual(m.invite, []);
    assert.equal(h.chain.get(P, 'coin'), 400n, 'price left the player and was burned (broker holds none)');
    assert.equal(h.chain.get(h.cfg.brokerAccountId, 'coin'), 0n);
    assert.equal(h.chain.get(P, 'IS-1-1'), 1n);
    assert.equal(h.game.gs.settledBalance(P, 'coin'), 400, 'cached balance follows the chain');
    // layout for the client
    r = await call('GET', '/api/islands/layout?island_id=1');
    assert.deepEqual(r.json, { seed: 7101, spec: { seed: 7101, size_level: 1, fertility_level: 1 } });
    // buying with a stale hope: the history row says what happened
    assert.ok(h.store.history(P).some((x) => /Pulau Pribadi #1/.test(x.summary)));
  } finally {
    server.close();
  }
});

test('buy_voucher_refused_for_owned_island', async () => {
  const h = await harness();
  await fund(h, P, { coin: 2000 }); await fund(h, Q, { coin: 2000 });
  await buy(h, P, 1);
  await assert.rejects(voucherFor(h, Q, 'buy', 1), /sudah ada pemiliknya/);
  await assert.rejects(voucherFor(h, P, 'buy', 1), /sudah ada pemiliknya/);
  // even when our database forgot (a fresh one), the chain still says it is owned
  const again = await harness({ chain: h.chain });
  await assert.rejects(voucherFor(again, Q, 'buy', 1), /sudah ada pemiliknya/);
});

/** Puts a player on their island at its spawn (what `travel` does, minus walking to the dock). */
function onIsland(h: H, a: string, id: number) {
  const row = h.game.gs.island(id)!;
  const map = h.game.islands.map(row);
  h.game.positions!.setWorld(a, `IS-${id}`, map.layout.spawn, h.game.now());
  return map;
}

test('upgrade_is_immediate_but_not_savable_until_settled', async () => {
  const h = await harness();
  await fund(h, P, { coin: 900, wood: 100 });
  await buy(h, P, 1);
  const map = onIsland(h, P, 1);
  const up = () => h.game.act(P, { action: 'island_upgrade', island_id: 1, attr: 'fertility', world: 'IS-1', pos: map.layout.spawn });
  const woodBefore = h.game.gs.balance(P, 'wood'), coinBefore = h.game.gs.balance(P, 'coin');
  const r = up();
  assert.match(r.toast, /Kesuburan/);
  assert.equal(h.game.gs.balance(P, 'wood'), woodBefore - 30);
  assert.equal(h.game.gs.balance(P, 'coin'), coinBefore - 60);
  let st = h.game.islands.state(h.game.gs.island(1)!);
  assert.equal(st.live.fertility_level, 2, 'live at once');
  assert.equal(st.savable.fertility_level, 1, 'not final yet');
  assert.deepEqual(st.pending, [{ attr: 'fertility', level: 2, waitingSettlement: true }]);
  await assert.rejects(voucherFor(h, P, 'save', 1), /settlement 06:00/);
  const live = (await h.game.state(P)).island;
  assert.equal(live!.fertility_level, 2);
  await h.game.devSettle();
  st = h.game.islands.state(h.game.gs.island(1)!);
  assert.equal(st.savable.fertility_level, 2, 'savable after the settlement');
  assert.deepEqual(st.pending, [{ attr: 'fertility', level: 2, waitingSettlement: false }]);
  // level 3 needs ore the player does not have: refused, nothing spent
  assert.equal(st.next!.level, 3);
  assert.throws(up, /Bijih kurang/);
  assert.equal(st.next!.locked, false);
});

test('locked_levels_need_items_that_do_not_exist_yet', async () => {
  const h = await harness();
  await fund(h, P, { coin: 900, wood: 400, ore: 100 });
  await buy(h, P, 1);
  const map = onIsland(h, P, 1);
  const up = () => h.game.act(P, { action: 'island_upgrade', island_id: 1, attr: 'fertility', world: 'IS-1', pos: map.layout.spawn });
  up(); up(); // levels 2 and 3
  const st = h.game.islands.state(h.game.gs.island(1)!);
  assert.equal(st.live.fertility_level, 3);
  assert.deepEqual(st.next, { attr: 'fertility', level: 4, cost: { wood: 80, ore: 20, coin: 300, permata: 5 }, locked: true });
  assert.throws(up, /permata/);
  // and the world must be the island itself
  assert.throws(() => h.game.act(P, { action: 'island_upgrade', island_id: 2, attr: 'fertility', world: 'IS-1', pos: map.layout.spawn }), /pulaumu sendiri/);
  assert.throws(() => h.game.act(Q, { action: 'island_upgrade', island_id: 1, attr: 'fertility', world: 'IS-1', pos: map.layout.spawn }), /pulau/i);
});

test('save_flow_bumps_version', async () => {
  const h = await harness();
  await fund(h, P, { coin: 900, wood: 100 });
  await buy(h, P, 1);
  const map = onIsland(h, P, 1);
  h.game.act(P, { action: 'island_upgrade', island_id: 1, attr: 'fertility', world: 'IS-1', pos: map.layout.spawn });
  await assert.rejects(voucherFor(h, P, 'save', 1), /settlement 06:00/);
  await assert.rejects(voucherFor(h, Q, 'save', 1), /bukan pulaumu/);
  await h.game.devSettle();
  const v = await voucherFor(h, P, 'save', 1);
  assert.equal(v.method, 'save_island');
  assert.equal(v.args.from_version, 1);
  assert.deepEqual(v.args.spec, { seed: 7101, size_level: 1, fertility_level: 2 });
  assert.equal((await relayCall(h, Q, 'save_island', v.args)).ok, false, 'only the owner');
  const r = await relayCall(h, P, 'save_island', v.args);
  assert.ok(r.ok, r.error);
  assert.equal(h.chain.get(P, 'IS-1-1'), 0n);
  assert.equal(h.chain.get(P, 'IS-1-2'), 1n);
  assert.equal((await relayCall(h, P, 'save_island', v.args)).ok, false, 'voucher for version 1 is stale now');
  const st = h.game.islands.state(h.game.gs.island(1)!);
  assert.equal(st.token_id, 'IS-1-2'); assert.equal(st.version, 2);
  assert.equal(st.saved.fertility_level, 2); assert.deepEqual(st.pending, []);
  assert.equal(st.next!.level, 3);
  await assert.rejects(voucherFor(h, P, 'save', 1), /Tidak ada peningkatan/);
});

test('travel_requires_dock_and_ownership', async () => {
  const h = await harness();
  await fund(h, P, { coin: 900 }); await fund(h, Q, { coin: 900 });
  await buy(h, P, 1);
  const dock = h.game.map!.dock();
  const spawn = h.game.map!.layout.spawn;
  // not at the dock
  assert.throws(() => h.game.act(P, { action: 'travel', to: 'IS-1', pos: spawn }), /dermaga/);
  // at the dock, but not the owner (and not invited)
  assert.throws(() => h.game.act(Q, { action: 'travel', to: 'IS-1', pos: dock }), /pribadi/);
  assert.throws(() => h.game.act(Q, { action: 'travel', to: 'IS-2', pos: dock }), /belum dibeli/);
  h.clock.advanceHours(0.5);
  // the owner at the dock
  const r = h.game.act(P, { action: 'travel', to: 'IS-1', pos: dock });
  const isl = h.game.islands.map(h.game.gs.island(1)!);
  assert.equal(r.world, 'IS-1'); assert.deepEqual(r.arrive, isl.layout.spawn);
  assert.equal(r.state.worldId, 'IS-1');
  assert.equal(r.state.plots.length, 6);
  // on the island, public coordinates mean nothing
  assert.throws(() => h.game.act(P, { action: 'gather', tile: 'water', x: 1, y: 1, pos: dock }), /dermaga/i, 'public world claimed while on the island');
  // leaving needs the island's dock
  step(h);
  assert.throws(() => h.game.act(P, { action: 'travel', to: 'public', world: 'IS-1', pos: isl.layout.spawn }), /dermaga/);
  const idock = isl.layout.dock;
  h.clock.advanceHours(0.5);
  const back = h.game.act(P, { action: 'travel', to: 'public', world: 'IS-1', pos: idock });
  assert.equal(back.world, 'public'); assert.deepEqual(back.arrive, dock);
  assert.equal(back.state.worldId, 'public');
  // an invited guest may visit but not work there
  assert.throws(() => h.game.islands.setInvites(Q, 1, [Q]), /bukan pulaumu/);
  assert.deepEqual(h.game.islands.setInvites(P, 1, [Q, Q, P]), [Q]);
  const g = h.game.act(Q, { action: 'travel', to: 'IS-1', pos: dock });
  assert.equal(g.world, 'IS-1');
  assert.throws(() => h.game.act(Q, { action: 'eat', token: 'bread', world: 'IS-1', pos: isl.layout.spawn }), /bukan pulaumu/);
  assert.equal(h.game.islands.layout(Q, 1).seed, 7101);
});

test('act_on_foreign_island_refused', async () => {
  const h = await harness();
  await fund(h, P, { coin: 900 }); await fund(h, Q, { coin: 900 });
  await buy(h, P, 1);
  const map = h.game.islands.map(h.game.gs.island(1)!);
  const spawn = map.layout.spawn;
  const before = h.game.gs.balance(Q, 'wood');
  // Q claims to be on P's island: 409, nothing happens
  for (const body of [
    { action: 'gather', tile: 'tree', x: 1, y: 1 },
    { action: 'farm', op: 'till', plot: 0 },
    { action: 'craft', recipe: 'bread' },
    { action: 'island_upgrade', island_id: 1, attr: 'fertility' },
  ]) {
    assert.throws(() => h.game.act(Q, { ...body, world: 'IS-1', pos: spawn }), (e: { status?: number }) => e.status === 409, JSON.stringify(body));
  }
  assert.equal(h.game.gs.balance(Q, 'wood'), before);
  // the owner is not on the island according to the server either: claiming it without a boat is refused
  h.game.reportPosition(P, h.game.map!.layout.spawn); // the server knows P walks on the public island
  assert.throws(() => h.game.act(P, { action: 'craft', recipe: 'bread', world: 'IS-1', pos: spawn }), /dermaga/);
  assert.throws(() => h.game.act(P, { action: 'craft', recipe: 'bread', world: 'IS-7', pos: spawn }), /belum dibeli/);
  assert.throws(() => h.game.act(P, { action: 'craft', recipe: 'bread', world: 'nowhere', pos: spawn }), /Dunia/);
  // a state poll with a bad world does not move anyone
  h.game.reportPosition(Q, spawn, 'IS-1');
  assert.equal(h.game.positions!.worldOf(Q), 'public');
});

test('island_work_stays_on_the_island', async () => {
  const h = await harness();
  await fund(h, P, { coin: 900 });
  await buy(h, P, 1);
  const map = onIsland(h, P, 1);
  const L = map.layout;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const tree = L.tiles.findIndex((t, i) => t === 'tree' && dirs.some(([dx, dy]) => map.walkable((i % 32) + dx, ((i / 32) | 0) + dy)));
  const tx = tree % 32, ty = (tree / 32) | 0;
  const stand = dirs.map(([dx, dy]) => ({ x: tx + dx, y: ty + dy })).find((p) => map.walkable(p.x, p.y))!;
  h.clock.advanceHours(0.5);
  h.game.act(P, { action: 'gather', tile: 'tree', x: tx, y: ty, world: 'IS-1', pos: stand });
  assert.ok(h.game.gs.node(`IS-1:tree:${tx},${ty}`), 'island nodes are charged per island');
  assert.equal(h.game.gs.node(`tree:${tx},${ty}`), undefined);
  // no merchants, no shipping box on a Private Island
  assert.throws(() => h.game.act(P, { action: 'sell', merchant: 'sari', token: 'wood', qty: 1, world: 'IS-1', pos: L.spawn }), /lapak/);
  assert.throws(() => h.game.act(P, { action: 'ship', token: 'wood', qty: 1, world: 'IS-1', pos: L.spawn }), /Pulau Publik/);
});

test('ownership_reloaded_from_chain_on_restart', async () => {
  const h = await harness();
  await fund(h, P, { coin: 900 });
  await buy(h, P, 1);
  assert.equal(h.game.gs.island(1)!.owner, P);
  // 1. a brand new database after a restart learns the owner from the chain
  const fresh = await harness({ chain: h.chain });
  assert.equal(fresh.game.gs.island(1)?.owner, P);
  assert.equal((await fresh.game.islands.view(P)).mine.length, 1);
  assert.equal((await fresh.game.islands.view(Q)).offers.length, 7);
  // 2. the same database, but the island changed hands on chain while the server was down
  h.chain.islands.get(1)!.owner_id = Q;
  const again = await harness({ chain: h.chain, store: h.store });
  assert.equal(h.store.db.prepare('SELECT owner FROM islands WHERE island_id = 1').get()!.owner, Q, 'SQLite follows the chain');
  assert.equal((await again.game.islands.view(P)).mine.length, 0);
  assert.equal((await again.game.islands.view(Q)).mine.length, 1);
});

test('fertility_speeds_growth_on_island_plots', async () => {
  const h = await harness();
  await fund(h, P, { coin: 900, wood: 100 });
  await buy(h, P, 1);
  const map = onIsland(h, P, 1);
  const L = map.layout;
  const farm = (op: string, plot = 0) => h.game.act(P, { action: 'farm', op, plot, world: 'IS-1', pos: { x: L.farm.plots[plot].x, y: L.farm.plots[plot].y } });
  const row1 = h.game.gs.island(1)!;
  assert.equal(h.game.islands.farmOf(row1, 3).growDays, 3, 'level 1 grows like the village farm');
  h.game.act(P, { action: 'island_upgrade', island_id: 1, attr: 'fertility', world: 'IS-1', pos: L.spawn });
  assert.equal(h.game.islands.farmOf(row1, 3).growDays, 2, 'level 2 is a day faster');
  h.clock.advanceHours(0.5);
  farm('till'); farm('plant');
  assert.equal(farm('water').state.plots[0].state, 'planted');
  h.clock.advanceHours(24);
  const s = farm('water').state;
  assert.equal(s.plots[0].state, 'ready', 'ready after two waterings');
  assert.equal(s.plots.length, 6);
  assert.equal(s.island!.growDays, 2);
  const before = h.game.gs.balance(P, 'wheat');
  farm('harvest');
  assert.equal(h.game.gs.balance(P, 'wheat') - before, 3 + (h.game.state(P).time.season === 'gugur' ? 1 : 0));
  // island plots are separate rows from the village farm
  assert.equal(h.game.gs.plots(P).length, 0);
  assert.equal(h.game.gs.plots(`${P}@IS-1`).length, 1);
});

test('dev_grant_moves_existing_coin_from_the_town_only_on_mock', async () => {
  const h = await harness();
  const supply = BigInt(await h.chain.coinSupply());
  const out = await h.game.devGrant(P, 800);
  assert.equal(out.granted, 800);
  assert.equal(h.game.gs.settledBalance(P, 'coin'), 800);
  assert.equal(BigInt(await h.chain.coinSupply()), supply, 'nothing was minted');
  assert.equal(h.chain.get(TOWN, 'coin'), 5000n - 800n);
  await assert.rejects(h.game.devGrant(P, 99999), /Kas desa/);
});

/** Signed HTTP client against a real createApp, for the world-id validation tests. */
async function httpFor(h: H, account: string) {
  const kp = near.KeyPair.fromRandom('ed25519');
  h.store.addSessionKey(kp.getPublicKey().toString(), account);
  const { server } = createApp({ cfg: h.cfg, chain: h.chain, store: h.store, game: h.game, verify: async () => ({ sub: 'x' }), currentBlockHeight: async () => 0n, clientDir: '.' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const raw = body === undefined ? '' : JSON.stringify(body), ts = String(Date.now());
    const sig = kp.sign(new TextEncoder().encode(requestMessage(method, path, ts, raw))).signature;
    const res = await fetch(base + path, { method, body: raw || undefined, headers: { 'x-account-id': account, 'x-gt-key': kp.getPublicKey().toString(), 'x-gt-ts': ts, 'x-gt-sig': Buffer.from(sig).toString('base64') } });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { call, close: () => server.close() };
}
const ledgerRows = (h: H) => (h.store.db.prepare('SELECT COUNT(*) AS c FROM ledger').get() as { c: number }).c;

test('act_with_bad_world_changes_nothing', async () => {
  const h = await harness();
  const http = await httpFor(h, P);
  try {
    const rows = ledgerRows(h), wood = h.game.gs.balance(P, 'wood'), where = h.game.positions!.worldOf(P);
    const spawn = h.game.map!.layout.spawn;
    for (const world of ['bogus', 'IS-', 'IS-abc', '../public']) {
      const r = await http.call('POST', '/api/act', { action: 'gather', tile: 'tree', x: spawn.x, y: spawn.y, world, pos: spawn });
      assert.equal(r.status, 400, `world ${world}`);
    }
    assert.equal(ledgerRows(h), rows, 'no ledger row');
    assert.equal(h.game.gs.balance(P, 'wood'), wood, 'no item gained');
    assert.equal(h.game.positions!.worldOf(P), where, 'still in the same world');
  } finally { http.close(); }
});

test('state_with_bad_world_records_nothing', async () => {
  const h = await harness();
  const http = await httpFor(h, P);
  try {
    const where = h.game.positions!.worldOf(P), rows = ledgerRows(h);
    const r = await http.call('GET', '/api/state?x=5&y=5&world=bogus');
    assert.equal(r.status, 400);
    assert.equal(h.game.positions!.worldOf(P), where);
    assert.equal(ledgerRows(h), rows);
  } finally { http.close(); }
});

/* ------------------------------------------------------------ review fixes */

test('sync_all_survives_one_failing_island', async () => {
  const h = await harness();
  await fund(h, P, { coin: 900 });
  await buy(h, P, 1);
  const real = h.chain.getIsland.bind(h.chain);
  h.chain.getIsland = async (id: number) => { if (id === 2) throw new Error('rpc down'); return real(id); };
  h.game.islands.lastSync = 0;
  const v = await h.game.islands.view(P); // must not reject
  assert.equal(v.mine.length, 1, 'cached row kept');
  assert.equal(h.game.islands.lastSync, 0, 'a partial sync does not count as done');
  await h.game.init(); // a failing chain must not stop startup
});

test('old_owner_loses_access_after_chain_transfer', async () => {
  const h = await harness();
  await fund(h, P, { coin: 900, wood: 100 });
  await buy(h, P, 1);
  const map = onIsland(h, P, 1);
  h.chain.transferIsland(1, Q);
  const body = { action: 'island_upgrade', island_id: 1, attr: 'fertility', world: 'IS-1', pos: map.layout.spawn };
  await h.game.prepare(P, body); // within the TTL: still the cached owner
  assert.equal(h.game.gs.island(1)!.owner, P);
  h.clock.advanceHours(0.5); // 30 s
  await h.game.prepare(P, body);
  assert.equal(h.game.gs.island(1)!.owner, Q);
  assert.throws(() => h.game.act(P, body), (e: { status?: number }) => e.status === 409);
  assert.equal(h.game.positions!.worldOf(P), 'public', 'the old owner is moved back to the public island');
});

test('stream_ends_when_guest_is_uninvited', async () => {
  const h = await harness();
  await fund(h, P, { coin: 900 });
  await buy(h, P, 1);
  h.game.islands.setInvites(P, 1, [Q]);
  const kp = near.KeyPair.fromRandom('ed25519');
  h.store.addSessionKey(kp.getPublicKey().toString(), Q);
  const { server } = createApp({ cfg: h.cfg, chain: h.chain, store: h.store, game: h.game, verify: async () => ({ sub: 'x' }), currentBlockHeight: async () => 0n, clientDir: '.' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const path = '/api/stream?world=IS-1', ts = String(Date.now());
  const sig = kp.sign(new TextEncoder().encode(requestMessage('GET', path, ts, ''))).signature;
  const ac = new AbortController();
  try {
    const res = await fetch(base + path, { headers: { 'x-account-id': Q, 'x-gt-key': kp.getPublicKey().toString(), 'x-gt-ts': ts, 'x-gt-sig': Buffer.from(sig).toString('base64') }, signal: ac.signal });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    await reader.read();
    h.game.islands.setInvites(P, 1, []);
    const t0 = Date.now();
    let ended = false;
    while (Date.now() - t0 < 3000) {
      const r = await reader.read();
      if (r.done) { ended = true; break; }
    }
    assert.ok(ended, 'the stream is closed once the guest is not invited');
  } finally { ac.abort(); server.closeAllConnections(); server.close(); }
});

test('world_resets_or_recovers_when_server_memory_differs', async () => {
  const h = await harness();
  await fund(h, P, { coin: 900 });
  await buy(h, P, 1);
  h.game.islands.setInvites(P, 1, [Q]);
  const dock = h.game.map!.dock();
  const isl = h.game.islands.map(h.game.gs.island(1)!);
  // 1. a guest is uninvited while standing on the island: back to public at once
  h.game.act(Q, { action: 'travel', to: 'IS-1', pos: dock });
  assert.equal(h.game.positions!.worldOf(Q), 'IS-1');
  h.game.islands.setInvites(P, 1, []);
  step(h);
  assert.equal(h.game.state(Q).worldId, 'public');
  assert.equal(h.game.positions!.worldOf(Q), 'public');
  // 2. server restart: no memory of P; the client says it is on its island at the spawn
  h.game.positions!.worlds.clear(); h.game.positions!.last.clear();
  const r = h.game.act(P, { action: 'craft', recipe: 'bread', world: 'IS-1', pos: isl.layout.spawn });
  assert.ok(r, 'accepted');
  assert.equal(h.game.positions!.worldOf(P), 'IS-1');
  // ... but not from the middle of nowhere, and not for a stranger
  h.game.positions!.worlds.clear(); h.game.positions!.last.clear();
  assert.throws(() => h.game.act(P, { action: 'craft', recipe: 'bread', world: 'IS-1', pos: { x: isl.layout.spawn.x + 3, y: isl.layout.spawn.y } }), /dermaga/);
  assert.throws(() => h.game.act(Q, { action: 'craft', recipe: 'bread', world: 'IS-1', pos: isl.layout.spawn }), (e: { status?: number }) => e.status === 409);
});

test('non_canonical_world_ids_are_refused', async () => {
  const h = await harness();
  await fund(h, P, { coin: 900 });
  await buy(h, P, 1);
  const dock = h.game.map!.dock();
  for (const to of ['IS-001', 'IS-01', 'IS-1 ', 'is-1']) {
    assert.throws(() => h.game.act(P, { action: 'travel', to, pos: dock }), /Dunia/, to);
    assert.equal(h.game.positions!.worldOf(P), 'public');
  }
});

test('invite_by_display_name', async () => {
  const h = await harness();
  await fund(h, P, { coin: 900 });
  await buy(h, P, 1);
  h.store.setName(Q, 'Budi');
  const http = await httpFor(h, P);
  try {
    let r = await http.call('POST', '/api/islands/invite', { island_id: 1, accounts: ['budi'] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.invite, [{ account: Q, name: 'Budi' }]);
    assert.deepEqual(h.game.gs.invites(1), [Q]);
    r = await http.call('POST', '/api/islands/invite', { island_id: 1, accounts: ['Budi', 'Siapa', 'Entah'] });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /Siapa/); assert.match(r.json.error, /Entah/);
    assert.deepEqual(h.game.gs.invites(1), [Q], 'unchanged after the refusal');
    r = await http.call('GET', '/api/islands');
    assert.deepEqual(r.json.mine[0].guests, [{ account: Q, name: 'Budi' }]);
  } finally { http.close(); }
});

test('invited_islands_listed_for_guest', async () => {
  const h = await harness();
  await fund(h, P, { coin: 900 });
  await buy(h, P, 1);
  h.store.setName(P, 'Ayu');
  h.game.islands.setInvites(P, 1, [Q]);
  const http = await httpFor(h, Q);
  try {
    const r = await http.call('GET', '/api/islands');
    assert.deepEqual(r.json.invited, [{ island_id: 1, name: h.game.islands.state(h.game.gs.island(1)!).name, owner_name: 'Ayu' }]);
    assert.deepEqual(r.json.mine, []);
  } finally { http.close(); }
});
