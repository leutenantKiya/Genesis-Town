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
  econ.homeland.publicTradeOnly = false; // these tests are about village mechanics
  econ.starter = { ...econ.starter, wheat: 3 }; // the counts below were written for a 3-seed kit; the real kit is checked on its own
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
  assert.equal(bal(game, P, 'tool'), 0, 'tools are equipment now, not bag items');
  assert.deepEqual(Object.keys(game.state(P).tools).sort(), ['axe', 'hoe', 'pickaxe', 'rod']);
  for (let i = 0; i < 4; i++) game.act(P, { action: 'gather', tile: 'water', x: 5, y: 5 });
  assert.equal(bal(game, P, 'fish'), 4);
  assert.equal(game.state(P).energy, 100 - 4 * 4);
  assert.throws(() => game.act(P, { action: 'gather', tile: 'water', x: 5, y: 5 }), /Depleted/);
  clock.advanceHours(2);
  game.act(P, { action: 'gather', tile: 'water', x: 5, y: 5 });
  assert.equal(bal(game, P, 'fish'), 5);
  assert.equal(game.state(P).energy, 100 - 16 + 4 - 4, 'energy regenerated 2/hour');
});

test('a felled tree is a stump in the state until it grows back', async () => {
  const { game, clock, econ } = await world();
  for (let i = 0; i < 3; i++) game.act(P, { action: 'gather', tile: 'tree', x: 7, y: 3 });
  assert.deepEqual(game.state(P).stumps, [], 'still standing with charges left');
  game.act(P, { action: 'gather', tile: 'tree', x: 7, y: 3 });
  const total = econ.gather.respawnGameHours * econ.time.realMsPerGameHour;
  const [s] = game.state(Q).stumps; // every player in the world sees it
  assert.equal(s.x, 7); assert.equal(s.y, 3); assert.equal(s.msTotal, total);
  assert.ok(s.msLeft > 0 && s.msLeft <= total, `msLeft ${s.msLeft}`);
  clock.advanceHours(1);
  assert.ok(game.state(P).stumps[0].msLeft <= total / 2, 'grows back over time');
  clock.advanceHours(1);
  assert.deepEqual(game.state(P).stumps, [], 'grown back');
  assert.equal(game.state(P).stumps.length, 0);
});

test('tools wear one use per gather and refuse at 0 until repaired or made again', async () => {
  const { game, econ } = await world();
  const st = (a: string) => game.state(a).tools as Record<string, { uses: number; max: number; broken: boolean }>;
  assert.deepEqual(Object.values(st(P)).map((x) => x.max), [econ.tools.pickaxe.durability, econ.tools.axe.durability, econ.tools.rod.durability, econ.tools.hoe.durability]);
  game.act(P, { action: 'gather', tile: 'rock', x: 1, y: 1 });
  game.act(P, { action: 'gather', tile: 'tree', x: 2, y: 2 });
  game.act(P, { action: 'gather', tile: 'water', x: 3, y: 3 });
  game.act(P, { action: 'farm', op: 'till', plot: 0 });
  assert.equal(st(P).pickaxe.uses, econ.tools.pickaxe.durability - 1);
  assert.equal(st(P).axe.uses, econ.tools.axe.durability - 1);
  assert.equal(st(P).rod.uses, econ.tools.rod.durability - 1);
  assert.equal(st(P).hoe.uses, econ.tools.hoe.durability - 1);
  assert.equal(st(Q).pickaxe.uses, econ.tools.pickaxe.durability, 'wear is per account');
  // the last use wears the tool out; the next gather is refused with a clear message
  game.extras.st.setTool(P, 'pickaxe', 1);
  assert.match(game.act(P, { action: 'gather', tile: 'rock', x: 4, y: 4 }).toast, /Pickaxe wore out/);
  assert.equal(st(P).pickaxe.broken, true);
  const ore = bal(game, P, 'ore');
  assert.throws(() => game.act(P, { action: 'gather', tile: 'rock', x: 5, y: 5 }), (e: any) => e.status === 409 && /Pickaxe is broken/.test(e.message));
  assert.equal(bal(game, P, 'ore'), ore, 'the refused gather gave nothing');
  // repair: wood and coin from the config, back to full
  game.gs.add(0, P, 'wood', 5, 'test');
  const coin = bal(game, P, 'coin'), wood = bal(game, P, 'wood');
  game.act(P, { action: 'repair', tool: 'pickaxe' });
  assert.equal(st(P).pickaxe.uses, econ.tools.pickaxe.durability);
  assert.equal(bal(game, P, 'wood'), wood - econ.tools.pickaxe.repair.wood);
  assert.equal(bal(game, P, 'coin'), coin - econ.tools.pickaxe.repair.coin);
  assert.throws(() => game.act(P, { action: 'repair', tool: 'pickaxe' }), /already like new/);
  assert.throws(() => game.act(P, { action: 'repair', tool: 'spade' }), /Unknown tool/);
  // a new Axe from wood and ore, durability full again; short of materials it is refused
  game.extras.st.setTool(P, 'axe', 0);
  assert.throws(() => game.act(P, { action: 'gather', tile: 'tree', x: 6, y: 6 }), /Axe is broken/);
  game.gs.add(0, P, 'wood', 3, 'test'); game.gs.add(0, P, 'ore', 1, 'test');
  game.act(P, { action: 'maketool', tool: 'axe' });
  assert.equal(st(P).axe.uses, econ.tools.axe.durability);
  assert.throws(() => game.act(Q, { action: 'maketool', tool: 'axe' }), /Not enough/);
});

test('crafting: simple recipes cost energy, complex ones cost coin; eating restores energy', async () => {
  const { game } = await world();
  game.gs.add(0, P, 'wheat', 1, 'test'); // 3 + 1 = 4 wheat
  game.act(P, { action: 'craft', recipe: 'bread' });
  assert.equal(bal(game, P, 'wheat'), 2);
  assert.equal(bal(game, P, 'bread'), 4);
  assert.equal((game.state(P).missions.list as any[]).find((m) => m.id === 'bread').done, true, 'crafting bread counts for its mission');
  assert.equal(bal(game, P, 'coin'), 100);
  assert.equal(game.state(P).energy, 95);
  assert.throws(() => game.act(P, { action: 'craft', recipe: 'tool' }), /Not enough/);
  game.gs.add(0, P, 'ore', 2, 'test');
  game.gs.add(0, P, 'wood', 1, 'test');
  const tools = bal(game, P, 'tool');
  game.act(P, { action: 'craft', recipe: 'tool' });
  assert.equal(bal(game, P, 'coin'), 97);
  assert.equal(bal(game, P, 'tool'), tools + 1);
  // Too tired to craft bread.
  const p = game.world.state(P);
  p.energy = 4;
  game.gs.savePlayer(p);
  game.gs.add(0, P, 'wheat', 2, 'test');
  assert.throws(() => game.act(P, { action: 'craft', recipe: 'bread' }), /Not enough energy/);
  game.act(P, { action: 'eat', token: 'bread' });
  assert.equal(game.state(P).energy, 29);
});

test('farm: till, plant, water once a day, harvest after 3 watered days', async () => {
  const { game, clock } = await world();
  game.act(P, { action: 'farm', op: 'till', plot: 0 });
  game.act(P, { action: 'farm', op: 'plant', plot: 0 });
  assert.equal(bal(game, P, 'wheat'), 2);
  for (let d = 0; d < 3; d++) {
    game.act(P, { action: 'farm', op: 'water', plot: 0 });
    if (d === 0) assert.throws(() => game.act(P, { action: 'farm', op: 'water', plot: 0 }), /Already watered/);
    clock.advanceHours(24);
  }
  assert.equal(game.state(P).plots[0].state, 'ready');
  game.act(P, { action: 'farm', op: 'harvest', plot: 0 });
  assert.equal(bal(game, P, 'wheat'), 5);
});

test('farm: with no Gandum left the village gives a few seeds a day, so farming never dead-ends', async () => {
  const { game, econ, clock } = await world();
  econ.farm.villageSeedsPerDay = 2;
  const kit = bal(game, P, 'wheat'); // the starter kit's seeds (economy/config.json starter.wheat)
  for (let i = 0; i < kit + 3; i++) game.act(P, { action: 'farm', op: 'till', plot: i });
  for (let i = 0; i < kit; i++) game.act(P, { action: 'farm', op: 'plant', plot: i });
  assert.equal(bal(game, P, 'wheat'), 0);
  const r = game.act(P, { action: 'farm', op: 'plant', plot: kit }) as { toast: string };
  assert.match(r.toast, /village gives you 1 wheat seed/);
  game.act(P, { action: 'farm', op: 'plant', plot: kit + 1 });
  assert.equal(bal(game, P, 'wheat'), 0);
  assert.throws(() => game.act(P, { action: 'farm', op: 'plant', plot: kit + 2 }), /village seeds are used up/);
  clock.advanceHours(24);
  game.act(P, { action: 'farm', op: 'plant', plot: kit + 2 });
  assert.equal(game.state(P).plots[kit + 2].state, 'planted');
});

test('selling to a merchant moves items and coin, prices react with a reason, daily cap holds', async () => {
  const { game, clock } = await world();
  for (let i = 0; i < 3; i++) for (let k = 0; k < 4; k++) game.act(P, { action: 'gather', tile: 'water', x: i, y: 9 });
  const before = game.merchants().find((m) => m.id === 'sari')!.items.find((i) => i.token === 'fish')!;
  const r = game.act(P, { action: 'sell', merchant: 'sari', token: 'fish', qty: 10 }) as { toast: string };
  assert.match(r.toast, /Sold 10 Fish to Sarah/);
  assert.equal(bal(game, P, 'fish'), 2);
  assert.equal(bal(game, 'sari.gt.test', 'fish'), 30);
  assert.ok(bal(game, P, 'coin') > 100);
  clock.advanceHours(1);
  await game.step();
  const after = game.merchants().find((m) => m.id === 'sari')!.items.find((i) => i.token === 'fish')!;
  assert.ok(after.mid < before.mid, `${after.mid} < ${before.mid}`);
  assert.match(after.reason, /Price down/);
  // Sari buys at most 2 x target (40) fish a day.
  game.gs.add(game.clock.time().settleDay, P, 'fish', 40, 'test');
  for (let i = 0; i < 3; i++) game.act(P, { action: 'sell', merchant: 'sari', token: 'fish', qty: 10 });
  assert.throws(() => game.act(P, { action: 'sell', merchant: 'sari', token: 'fish', qty: 1 }), /has bought enough/);
  assert.throws(() => game.act(P, { action: 'sell', merchant: 'wati', token: 'fish', qty: 1 }), /doesn't buy/);
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
  const { game, chain, store, clock } = await world();
  for (let k = 0; k < 4; k++) game.act(P, { action: 'gather', tile: 'water', x: 3, y: 3 });
  game.act(P, { action: 'sell', merchant: 'sari', token: 'fish', qty: 2 });
  game.act(Q, { action: 'ship', token: 'bread', qty: 2 });
  const day = game.clock.time().settleDay;
  const offP = { coin: bal(game, P, 'coin'), fish: bal(game, P, 'fish') };
  chain.failNext = true; // first chunk hits a network error
  await game.devSettle();
  assert.equal(game.settlement.settledThrough(), day - 1, 'day not settled after the error');
  await game.step();
  assert.equal(game.settlement.settledThrough(), day - 1, 'backoff: no retry within 30 s');
  clock.advanceHours(1);
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
  assert.throws(() => game.act(P, { action: 'sell', merchant: 'budi', token: 'ore', qty: 1 }), /CLOSED/);
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
  await assert.rejects(guard(P, 'list_item', { token_id: 'bread', amount: '1', price_each: '5' }), /on the chain is only 0/);
  await game.devSettle();
  assert.equal(game.gs.settledBalance(P, 'bread'), 3);
  await guard(P, 'list_item', { token_id: 'bread', amount: '3', price_each: '5' });
  game.act(P, { action: 'ship', token: 'bread', qty: 1 }); // spends one off-chain today
  await assert.rejects(guard(P, 'list_item', { token_id: 'bread', amount: '3', price_each: '5' }), /Not enough .*: need 3, have 2/);
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
  econ.homeland.publicTradeOnly = false; // village mechanics
  econ.homeland.publicOpenAll = false; // this test is about areas that open with their town project
  const chain = new MockChain();
  chain.accounts.add(TOWN);
  chain.add(TOWN, 'coin', 5000n);
  for (const p of econ.projects) chain.addProject(p.id, p.name, p.chunk, p.need);
  const store = new Store(':memory:');
  let now = 1_800_000_000_000;
  const game = new Game(store, chain, { merchantParent: 'gt.test', town: TOWN, econ, worldSeed: 42, chunkSize: 5, now: () => now });
  for (const [id, d] of Object.entries(econ.merchants)) chain.addMerchant(`${id}.gt.test`, d.shop, { coin: d.restore.coin, ...d.restore.items }, { coin: d.startCash, ...d.startStock }, {});
  await game.init();
  store.addPlayer(P, 'sub-' + P, 'ed25519:o'); await chain.registerPlayer(P); game.onNewPlayer(P);
  const map = game.map!;
  assert.equal(new WorldMap(42).layout.tiles.join(), map.layout.tiles.join(), 'same seed, same map');
  const L = map.layout;
  const find = (pred: (x: number, y: number, t: string) => boolean) => { for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) if (pred(x, y, L.tiles[y * L.w + x])) return { x, y }; throw new Error('none'); };
  const FREE = new Set(['grass', 'path', 'sand', 'flower', 'tallgrass', 'plaza', 'bridge']);
  const inBuilding = (x: number, y: number) => L.buildings.some((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h);
  const freeNb = (x: number, y: number) => [[0, 1], [0, -1], [1, 0], [-1, 0]].some(([dx, dy]) => FREE.has(L.tiles[(y + dy) * L.w + x + dx]) && !inBuilding(x + dx, y + dy));
  const openWater = find((x, y, t) => t === 'water' && map.chunkAt(x, y).open && map.fishSpot(x, y, game.clock.time().totalHours + 60) && [[0, 1], [0, -1], [1, 0], [-1, 0]].some(([dx, dy]) => map.walkable(x + dx, y + dy)));
  const lockedTree = find((x, y, t) => t === 'tree' && map.chunkAt(x, y).id === 'seberang' && freeNb(x, y));
  const grass = find((x, y, t) => t === 'grass' && map.chunkAt(x, y).open);
  // stand on a walkable tile next to the target (an hour later, so walking there is plausible)
  const beside = (t: { x: number; y: number }) => {
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) if (map.walkable(t.x + dx, t.y + dy)) return { x: t.x + dx, y: t.y + dy };
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) if (FREE.has(L.tiles[(t.y + dy) * L.w + t.x + dx]) && !inBuilding(t.x + dx, t.y + dy)) return { x: t.x + dx, y: t.y + dy };
    return { x: t.x, y: t.y + 1 };
  };
  const gather = (tile: string, t: { x: number; y: number }) => { now += 3_600_000; return game.act(P, { action: 'gather', tile, x: t.x, y: t.y, pos: beside(t) }); };
  assert.match(gather('water', openWater).toast, /Fish/);
  const noRipple = find((x, y, t) => t === 'water' && map.chunkAt(x, y).open && !map.fishSpot(x, y, game.clock.time().totalHours + 120) && [[0, 1], [0, -1], [1, 0], [-1, 0]].some(([dx, dy]) => map.walkable(x + dx, y + dy)));
  assert.throws(() => gather('water', noRipple), /No fish here/); // fishing only where the water ripples
  assert.throws(() => gather('water', grass), /Nothing to gather/);
  assert.throws(() => gather('tree', lockedTree), /Invalid position|Far Bank Hamlet isn't open yet/);
  // the town builds the bridge (on chain), and the server opens Dusun Seberang
  await game.devSettle();
  chain.add(P, 'wood', 60n); chain.add(P, 'ore', 20n); chain.add(P, 'coin', 300n);
  const call = (method: string, args: Record<string, unknown>) => chain.relay({ delegateAction: { actions: [{ functionCall: { methodName: method, args: Buffer.from(JSON.stringify(args)) } }] } }, P);
  assert.ok((await call('project_contribute', { id: 'jembatan-timur', contribution: [{ token_id: 'wood', amount: '60' }, { token_id: 'ore', amount: '20' }, { token_id: 'coin', amount: '300' }] })).ok);
  assert.equal((await chain.getProject('jembatan-timur'))?.done, true);
  assert.deepEqual(await game.syncProjects(), ['seberang']);
  assert.ok(map.chunkAt(lockedTree.x, lockedTree.y).open);
  assert.ok(map.layout.tiles.includes('bridge'), 'the bridge is on the map now');
  assert.match(gather('tree', lockedTree).toast, /Wood/);
  assert.deepEqual(JSON.parse(game.gs.meta('world.unlocked')!), ['seberang'], 'persisted');
});

test('positions: actions happen where the player stands, and nobody jumps across the map', async () => {
  const econ = (await import('../src/game/econ.ts')).loadEcon();
  econ.homeland.publicTradeOnly = false; // village mechanics
  econ.homeland.publicOpenAll = false; // this test is about areas that open with their town project
  const chain = new MockChain();
  chain.accounts.add(TOWN);
  chain.add(TOWN, 'coin', 5000n);
  for (const [id, d] of Object.entries(econ.merchants)) chain.addMerchant(`${id}.gt.test`, d.shop, { coin: d.restore.coin, ...d.restore.items }, { coin: d.startCash, ...d.startStock }, {});
  const store = new Store(':memory:');
  let now = 1_800_000_000_000;
  const game = new Game(store, chain, { merchantParent: 'gt.test', town: TOWN, econ, worldSeed: 42, now: () => now });
  await game.init();
  store.addPlayer(P, 'sub-' + P, 'ed25519:o'); await chain.registerPlayer(P); game.onNewPlayer(P);
  const L = game.map!.layout;
  const stall = L.market.stalls[0], front = { x: stall.x, y: stall.y + 1 };
  const own = L.buildings.find((b) => b.own)!, door = { x: own.dx, y: own.dy + 1 };
  // no position, or a position inside a wall, is refused
  assert.throws(() => game.act(P, { action: 'eat', token: 'bread' }), /player position missing/);
  assert.throws(() => game.act(P, { action: 'eat', token: 'bread', pos: { x: own.x, y: own.y } }), /Invalid position/);
  // at home: craft is fine; selling from home is not
  now += 1000;
  game.act(P, { action: 'ship', token: 'bread', qty: 1, pos: door });
  assert.throws(() => game.act(P, { action: 'sell', merchant: 'wati', token: 'wheat', qty: 1, pos: door }), /merchants' stalls/);
  // jumping from the house to the market in one second is refused; walking there (a minute later) is fine
  now += 1000;
  assert.throws(() => game.act(P, { action: 'sell', merchant: 'wati', token: 'wheat', qty: 1, pos: front }), /jumped too far/);
  now += 60_000;
  game.act(P, { action: 'sell', merchant: 'wati', token: 'wheat', qty: 1, pos: front });
  // crafting needs the house, farming needs the plot
  now += 1000;
  assert.throws(() => game.act(P, { action: 'craft', recipe: 'bread', pos: front }), /Workbench/);
  assert.throws(() => game.act(P, { action: 'farm', op: 'till', plot: 0, pos: front }), /garden plot/);
  // the spawn is always allowed (where a player appears after loading the page)
  now += 1000;
  game.act(P, { action: 'ship', token: 'bread', qty: 1, pos: L.spawn });
});

test('a day with no players costs the shops no rent, and nobody closes', async () => {
  const { game, chain } = await world();
  await game.devSettle(); // the day with the starter kits (players were active): rent as usual
  assert.ok(game.gs.dayRows(game.settlement.settledThrough()).some((r) => r.kind === 'rent'));
  // drain every shop below rent; then a whole day passes with nobody playing
  const day = game.clock.time().settleDay;
  for (const id of Object.keys(game.econ.merchants)) { const a = `${id}.gt.test`; game.gs.add(day - 1, a, 'coin', 0, 'noop'); }
  await game.devSettle();
  assert.equal(game.gs.dayRows(game.settlement.settledThrough()).filter((r) => r.kind === 'rent').length, 0, 'no rent on an idle day');
  assert.ok((await chain.listShops()).every((s) => s.open), 'every shop still open');
});

test('when every shop is closed, the village relief fund pledges the coin part of each board', async () => {
  const { game, chain } = await world();
  chain.townAccount = TOWN;
  const day = game.clock.time().settleDay;
  // every merchant below rent, nothing to sell to the town
  for (const id of Object.keys(game.econ.merchants)) {
    const a = `${id}.gt.test`;
    game.gs.add(day, a, 'coin', -(bal(game, a, 'coin') - 5), 'test');
    for (const t of Object.keys(game.econ.items)) if (t !== 'coin' && bal(game, a, t) > 0) game.gs.add(day, a, t, -bal(game, a, t), 'test');
  }
  await game.devSettle();
  const shops = await chain.listShops();
  assert.ok(shops.every((s) => !s.open), 'all closed');
  for (const s of shops) {
    const need = Number(s.need.find((l) => l.token_id === 'coin')!.amount);
    const got = Number(s.pledged.find((l) => l.token_id === 'coin')?.amount ?? 0);
    assert.equal(got, need, `${s.name}: the town pledged the coin`);
  }
  assert.ok(JSON.parse(game.gs.meta('relief.last')!).pledges.length === shops.length);
  // players now only bring the goods; one board completes and the shop reopens
  const sari = shops.find((s) => s.account_id === 'sari.gt.test')!;
  for (const l of sari.need) if (l.token_id !== 'coin') chain.add(P, l.token_id, BigInt(l.amount));
  const lines = sari.need.filter((l) => l.token_id !== 'coin');
  const r = await chain.relay({ delegateAction: { actions: [{ functionCall: { methodName: 'restore_contribute', args: Buffer.from(JSON.stringify({ merchant: sari.account_id, contribution: lines })) } }] } }, P);
  assert.ok(r.ok, r.error);
  assert.equal((await chain.listShops()).find((s) => s.account_id === 'sari.gt.test')!.open, true, 'Sari reopened');
});

test('a new player starts with the starter kit from the config: 3 Wheat to plant and no Pickaxe item (tools are equipment)', () => {
  const econ = loadEcon();
  assert.equal(econ.starter.wheat, 3);
  assert.equal((econ.starter as Record<string, number>).tool, undefined);
  assert.deepEqual(Object.keys(econ.tools).sort(), ['axe', 'hoe', 'pickaxe', 'rod']);
});
