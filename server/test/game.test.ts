import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { MockChain } from '../src/chain.ts';
import { Game } from '../src/game/game.ts';
import { loadEcon } from '../src/game/econ.ts';
import { leafHash, merkleRoot, merkleProof, verifyProof } from '../src/game/merkle.ts';

const TOWN = 'town.gt.test';
const P = 'p1.players.test';
const Q = 'p2.players.test';

async function world(opts: { rng?: () => number } = {}) {
  const econ = loadEcon();
  const chain = new MockChain();
  const base = Object.fromEntries(Object.entries(econ.items).map(([t, i]) => [t, i.base]));
  chain.accounts.add(TOWN);
  chain.add(TOWN, 'coin', 5000n);
  for (const [id, d] of Object.entries(econ.merchants)) {
    chain.addMerchant(`${id}.gt.test`, d.shop, { coin: d.restore.coin, ...d.restore.items }, { coin: d.startCash, ...d.startStock }, base);
  }
  const store = new Store(':memory:');
  let now = 1_800_000_000_000;
  const clock = { now: () => now, advanceHours: (h: number) => { now += h * econ.time.realMsPerGameHour; } };
  const game = new Game(store, chain, { merchantParent: 'gt.test', town: TOWN, now: clock.now, rng: opts.rng ?? (() => 0.99), econ, chunkSize: 5 });
  await game.init();
  for (const a of [P, Q]) {
    store.addPlayer(a, 'sub-' + a, 'ed25519:o');
    await chain.registerPlayer(a);
    game.onNewPlayer(a);
  }
  return { econ, chain, store, game, clock };
}

const bal = (g: Game, a: string, t: string) => g.gs.balance(a, t);

test('starter kit, gathering with energy, node charges and respawn', async () => {
  const { game, clock } = await world();
  assert.equal(bal(game, P, 'coin'), 100);
  assert.equal(bal(game, P, 'tool'), 1);
  for (let i = 0; i < 4; i++) game.act(P, { action: 'gather', tile: 'water', x: 5, y: 5 });
  assert.equal(bal(game, P, 'fish'), 4);
  assert.equal(game.state(P).energy, 100 - 4 * 4);
  assert.throws(() => game.act(P, { action: 'gather', tile: 'water', x: 5, y: 5 }), /Sudah habis/);
  clock.advanceHours(2);
  game.act(P, { action: 'gather', tile: 'water', x: 5, y: 5 });
  assert.equal(bal(game, P, 'fish'), 5);
  assert.equal(game.state(P).energy, 100 - 16 + 4 - 4, 'energy regenerated 2/hour');
});

test('ore and wood need a tool, and the tool breaks after 20 uses', async () => {
  const { game, clock } = await world();
  game.gs.add(0, Q, 'tool', -1, 'test');
  assert.throws(() => game.act(Q, { action: 'gather', tile: 'rock', x: 1, y: 1 }), /Bijih|Alat/);
  let broke = '';
  for (let i = 0; i < 20; i++) {
    const r = game.act(P, { action: 'gather', tile: 'rock', x: i, y: 0 });
    if (/patah/.test(r.toast)) broke = r.toast;
    if (game.state(P).energy < 10) { game.act(P, { action: 'eat', token: 'bread' }); clock.advanceHours(0); }
  }
  assert.ok(broke, 'tool broke on the 20th use');
  assert.equal(bal(game, P, 'tool'), 0);
});

test('crafting consumes inputs and burns the fee; eating restores energy', async () => {
  const { game } = await world();
  game.gs.add(0, P, 'wheat', 1, 'test'); // 3 + 1 = 4 wheat
  game.act(P, { action: 'craft', recipe: 'bread' });
  assert.equal(bal(game, P, 'wheat'), 2);
  assert.equal(bal(game, P, 'bread'), 4);
  assert.equal(bal(game, P, 'coin'), 98);
  assert.throws(() => game.act(P, { action: 'craft', recipe: 'tool' }), /kurang/);
  assert.throws(() => game.act(P, { action: 'eat', token: 'bread' }), /penuh/);
  game.act(P, { action: 'gather', tile: 'water', x: 1, y: 1 });
  game.act(P, { action: 'eat', token: 'bread' });
  assert.equal(game.state(P).energy, 100);
});

test('farm: till, plant, water once a day, harvest after 3 watered days', async () => {
  const { game, clock } = await world();
  game.act(P, { action: 'farm', op: 'till', plot: 0 });
  game.act(P, { action: 'farm', op: 'plant', plot: 0 });
  assert.equal(bal(game, P, 'wheat'), 2);
  for (let d = 0; d < 3; d++) {
    game.act(P, { action: 'farm', op: 'water', plot: 0 });
    if (d === 0) assert.throws(() => game.act(P, { action: 'farm', op: 'water', plot: 0 }), /Sudah disiram/);
    clock.advanceHours(24);
  }
  assert.equal(game.state(P).plots[0].state, 'ready');
  game.act(P, { action: 'farm', op: 'harvest', plot: 0 });
  assert.equal(bal(game, P, 'wheat'), 5);
});

test('selling to a merchant moves items and coin, prices react with a reason, daily cap holds', async () => {
  const { game, clock } = await world();
  for (let i = 0; i < 3; i++) for (let k = 0; k < 4; k++) game.act(P, { action: 'gather', tile: 'water', x: i, y: 9 });
  const before = game.merchants().find((m) => m.id === 'sari')!.items.find((i) => i.token === 'fish')!;
  const r = game.act(P, { action: 'sell', merchant: 'sari', token: 'fish', qty: 10 }) as { toast: string };
  assert.match(r.toast, /Terjual 10 Ikan ke Sari/);
  assert.equal(bal(game, P, 'fish'), 2);
  assert.equal(bal(game, 'sari.gt.test', 'fish'), 30);
  assert.ok(bal(game, P, 'coin') > 100);
  clock.advanceHours(1);
  await game.step();
  const after = game.merchants().find((m) => m.id === 'sari')!.items.find((i) => i.token === 'fish')!;
  assert.ok(after.mid < before.mid, `${after.mid} < ${before.mid}`);
  assert.match(after.reason, /Harga turun/);
  // Sari buys at most 2 x target (40) fish a day.
  game.gs.add(game.clock.time().settleDay, P, 'fish', 40, 'test');
  for (let i = 0; i < 3; i++) game.act(P, { action: 'sell', merchant: 'sari', token: 'fish', qty: 10 });
  assert.throws(() => game.act(P, { action: 'sell', merchant: 'sari', token: 'fish', qty: 1 }), /sudah cukup membeli/);
  assert.throws(() => game.act(P, { action: 'sell', merchant: 'wati', token: 'fish', qty: 1 }), /tidak membeli/);
});

test('town demand creates new coin only within the faucet', async () => {
  const { game, clock } = await world();
  for (let h = 0; h < 24; h++) { clock.advanceHours(1); await game.step(); }
  const day = game.clock.time().settleDay;
  const made = game.gs.newCoin(day) + game.gs.newCoin(day - 1);
  assert.ok(made > 0, 'the town bought something');
  assert.ok(game.market.faucetLeft(day) >= 0);
  game.gs.setMeta('coin.supply', '1000000'); // above the money cap
  assert.equal(game.market.faucetLeft(day), 0);
});

test('settlement writes net deltas on chain in chunks, matches off-chain balances, and is retry-safe', async () => {
  const { game, chain, store } = await world();
  for (let k = 0; k < 4; k++) game.act(P, { action: 'gather', tile: 'water', x: 3, y: 3 });
  game.act(P, { action: 'sell', merchant: 'sari', token: 'fish', qty: 2 });
  game.act(Q, { action: 'ship', token: 'bread', qty: 2 });
  const day = game.clock.time().settleDay;
  const offP = { coin: bal(game, P, 'coin'), fish: bal(game, P, 'fish') };
  chain.failNext = true; // first chunk hits a network error
  await game.devSettle();
  assert.equal(game.settlement.settledThrough(), day - 1, 'day not settled after the error');
  await game.step(); // retry
  assert.equal(game.settlement.settledThrough(), day);
  assert.deepEqual(await chain.balances(P, ['coin', 'fish']), [String(offP.coin), String(offP.fish)]);
  assert.equal(game.gs.settledBalance(P, 'fish'), offP.fish);
  assert.equal(game.gs.pending(P, 'fish'), 0);
  assert.ok(bal(game, Q, 'coin') > 100, 'shipping box paid at settlement');
  const rows = game.gs.dayRows(day);
  assert.equal(chain.roots.get(day), merkleRoot(rows.map(leafHash)), 'on-chain root matches the published ledger');
  const leaves = rows.map(leafHash);
  assert.ok(verifyProof(leaves[1], 1, merkleProof(leaves, 1), merkleRoot(leaves)));
  const h = store.history(P);
  assert.ok(h.some((x) => x.kind === 'settle' && x.status === 'mock'));
  assert.ok(h.every((x) => x.status !== 'offchain'), 'off-chain rows now point at the settlement');
});

test('a merchant that cannot pay rent closes; a restoration board reopens it and issues shares', async () => {
  const { game, chain } = await world();
  // Drain Budi: players sell him lots of ore (he is cash-blind, "generous").
  const day = game.clock.time().settleDay;
  game.gs.add(day, P, 'ore', 150, 'test');
  game.gs.add(day, P, 'wood', 10, 'test');
  let sold = 0;
  for (let i = 0; i < 3; i++) { try { game.act(P, { action: 'sell', merchant: 'budi', token: 'ore', qty: 10 }); sold++; } catch { break; } }
  // Leave Budi 10 coin (< rent) and no tools, so the town cannot buy from him during the skipped hours.
  game.gs.add(day, 'budi.gt.test', 'coin', -(bal(game, 'budi.gt.test', 'coin') - 10), 'test');
  game.gs.add(day, 'budi.gt.test', 'tool', -bal(game, 'budi.gt.test', 'tool'), 'test');
  await game.devSettle();
  const budi = (await chain.listShops()).find((s) => s.account_id === 'budi.gt.test')!;
  assert.equal(budi.open, false, 'closed after failing rent');
  assert.ok(game.market.closed.has('budi.gt.test'));
  assert.throws(() => game.act(P, { action: 'sell', merchant: 'budi', token: 'ore', qty: 1 }), /TUTUP/);
  // Restore through the (mock) chain as the relayer would.
  const call = (m: string, a: object) => chain.relay({ delegateAction: { actions: [{ functionCall: { methodName: m, args: Buffer.from(JSON.stringify(a)) } }] } }, P);
  const res = await call('restore_contribute', { merchant: 'budi.gt.test', contribution: [{ token_id: 'coin', amount: '200' }, { token_id: 'ore', amount: '10' }, { token_id: 'wood', amount: '5' }] });
  assert.ok(res.ok, res.error);
  await game.settlement.refreshShops();
  assert.equal(game.market.closed.has('budi.gt.test'), false, 'reopened');
  assert.ok(Number((await chain.holding('budi.gt.test', P)).shares) > 0);
  assert.ok(sold > 0);
});

test('profitable shops pay dividends to shareholders', async () => {
  const { game, chain } = await world();
  const day = game.clock.time().settleDay;
  game.gs.add(day, 'wati.gt.test', 'coin', 500, 'trade'); // a good day for Wati
  game.gs.add(day, P, 'coin', -50, 'test');
  game.gs.add(day, TOWN, 'coin', -450, 'test');
  await game.devSettle();
  const h = await chain.holding('wati.gt.test', 'town');
  assert.ok(Number(h.claimable) > 0, 'town treasury holds the initial shares and earns dividends');
});

test('spend guard: on-chain debits only use items that are on chain and not spent today', async () => {
  const { spendGuard } = await import('../src/spend.ts');
  const { game, chain } = await world();
  const guard = spendGuard(chain, game);
  // Starter kit is off-chain until the first settlement.
  await assert.rejects(guard(P, 'list_item', { token_id: 'bread', amount: '1', price_each: '5' }), /di rantai baru 0/);
  await game.devSettle();
  assert.equal(game.gs.settledBalance(P, 'bread'), 3);
  await guard(P, 'list_item', { token_id: 'bread', amount: '3', price_each: '5' });
  game.act(P, { action: 'ship', token: 'bread', qty: 1 }); // spends one off-chain today
  await assert.rejects(guard(P, 'list_item', { token_id: 'bread', amount: '3', price_each: '5' }), /tidak cukup: perlu 3, punya 2/);
  await guard(P, 'send_item', { receiver_id: Q, token_id: 'bread', amount: '2' });
});

test('player market on the mock chain: list escrows, buy burns 5%, cancel returns, seller refreshed', async () => {
  const { spendGuard } = await import('../src/spend.ts');
  const { game, chain } = await world();
  await game.devSettle();
  const call = (who: string, method: string, args: Record<string, unknown>) =>
    chain.relay({ delegateAction: { actions: [{ functionCall: { methodName: method, args: Buffer.from(JSON.stringify(args)) } }] } }, who);
  assert.ok((await call(P, 'list_item', { token_id: 'wheat', amount: '3', price_each: '10' })).ok);
  assert.equal(chain.get(P, 'wheat'), 0n);
  assert.equal(chain.get(chain.contractId, 'wheat'), 3n);
  const [l] = await chain.listListings();
  assert.equal(l.seller, P);
  const supply0 = BigInt(await chain.coinSupply());
  const extra = await spendGuard(chain, game)(Q, 'buy_listing', { listing_id: l.id, amount: '2', max_price_each: '10' });
  assert.deepEqual(extra, [P]);
  assert.equal((await call(Q, 'buy_listing', { listing_id: l.id, amount: '2', max_price_each: '9' })).ok, false, 'price above limit');
  assert.equal((await call(P, 'buy_listing', { listing_id: l.id, amount: '1', max_price_each: '10' })).ok, false, 'own listing');
  assert.ok((await call(Q, 'buy_listing', { listing_id: l.id, amount: '2', max_price_each: '10' })).ok);
  assert.equal(chain.get(Q, 'wheat'), 5n);
  assert.equal(BigInt(await chain.coinSupply()), supply0 - 1n, '5% of 20 burned');
  assert.equal((await chain.getListing(l.id))?.amount, '1');
  assert.equal((await call(Q, 'cancel_listing', { listing_id: l.id })).ok, false, 'only the seller cancels');
  assert.ok((await call(P, 'cancel_listing', { listing_id: l.id })).ok);
  assert.equal(chain.get(P, 'wheat'), 1n);
  assert.equal(await chain.getListing(l.id), null);
});

test('settlement updates cached balances from what it wrote, even when a read right after is stale', async () => {
  const { game, chain } = await world();
  await game.devSettle();
  assert.equal(game.gs.settledBalance(P, 'bread'), 3);
  // A lagging RPC node would return the pre-settlement state; settlement must not depend on it.
  chain.balances = async (_a: string, tokens: string[]) => tokens.map(() => '3');
  game.act(P, { action: 'ship', token: 'bread', qty: 3 });
  await game.devSettle();
  assert.equal(chain.get(P, 'bread'), 0n);
  assert.equal(game.gs.settledBalance(P, 'bread'), 0, 'cache follows the written deltas, not the stale read');
  assert.equal(game.gs.balance(P, 'bread'), 0);
  assert.throws(() => game.act(P, { action: 'eat', token: 'bread' }));
});

test('shared map: gathering must match the map, inside open areas; a finished project opens its area', async () => {
  const { WorldMap } = await import('../src/game/worldmap.ts');
  const econ = (await import('../src/game/econ.ts')).loadEcon();
  const chain = new MockChain();
  chain.accounts.add(TOWN);
  chain.add(TOWN, 'coin', 5000n);
  for (const p of econ.projects) chain.addProject(p.id, p.name, p.chunk, p.need);
  const store = new Store(':memory:');
  const game = new Game(store, chain, { merchantParent: 'gt.test', town: TOWN, econ, worldSeed: 42, chunkSize: 5 });
  for (const [id, d] of Object.entries(econ.merchants)) chain.addMerchant(`${id}.gt.test`, d.shop, { coin: d.restore.coin, ...d.restore.items }, { coin: d.startCash, ...d.startStock }, {});
  await game.init();
  store.addPlayer(P, 'sub-' + P, 'ed25519:o'); await chain.registerPlayer(P); game.onNewPlayer(P);
  const map = game.map!;
  assert.equal(new WorldMap(42).layout.tiles.join(), map.layout.tiles.join(), 'same seed, same map');
  const L = map.layout;
  const find = (pred: (x: number, y: number, t: string) => boolean) => { for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) if (pred(x, y, L.tiles[y * L.w + x])) return { x, y }; throw new Error('none'); };
  const openWater = find((x, y, t) => t === 'water' && map.chunkAt(x, y).open);
  const lockedTree = find((x, y, t) => t === 'tree' && map.chunkAt(x, y).id === 'seberang');
  const grass = find((x, y, t) => t === 'grass' && map.chunkAt(x, y).open);
  assert.match(game.act(P, { action: 'gather', tile: 'water', x: openWater.x, y: openWater.y }).toast, /Ikan/);
  assert.throws(() => game.act(P, { action: 'gather', tile: 'water', x: grass.x, y: grass.y }), /Tidak ada/);
  assert.throws(() => game.act(P, { action: 'gather', tile: 'tree', x: lockedTree.x, y: lockedTree.y }), /Dusun Seberang belum dibuka/);
  // the town builds the bridge (on chain), and the server opens Dusun Seberang
  await game.devSettle();
  chain.add(P, 'wood', 60n); chain.add(P, 'ore', 20n); chain.add(P, 'coin', 300n);
  const call = (method: string, args: Record<string, unknown>) => chain.relay({ delegateAction: { actions: [{ functionCall: { methodName: method, args: Buffer.from(JSON.stringify(args)) } }] } }, P);
  assert.ok((await call('project_contribute', { id: 'jembatan-timur', contribution: [{ token_id: 'wood', amount: '60' }, { token_id: 'ore', amount: '20' }, { token_id: 'coin', amount: '300' }] })).ok);
  assert.equal((await chain.getProject('jembatan-timur'))?.done, true);
  assert.deepEqual(await game.syncProjects(), ['seberang']);
  assert.ok(map.chunkAt(lockedTree.x, lockedTree.y).open);
  assert.ok(map.layout.tiles.includes('bridge'), 'the bridge is on the map now');
  assert.match(game.act(P, { action: 'gather', tile: 'tree', x: lockedTree.x, y: lockedTree.y }).toast, /Kayu/);
  assert.deepEqual(JSON.parse(game.gs.meta('world.unlocked')!), ['seberang'], 'persisted');
});
