// The townsfolk (residents.ts): one shared wallet does the town's shopping, booked per resident, and lives on handouts:
// the town treasury above its reserve first, new coin from the faucet only after that. Until the wallet is registered
// on chain the town buys the old way. The residents' walks are shown only: a walk that reaches a stall makes the goods fly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { MockChain } from '../src/chain.ts';
import { Game } from '../src/game/game.ts';
import { loadEcon } from '../src/game/econ.ts';

const TOWN = 'town.gt.test', WALLET = 'warga.gt.test';

async function world(o: { seed?: number; noRegister?: boolean; treasury?: bigint } = {}) {
  const econ = loadEcon();
  const chain = new MockChain();
  const base = Object.fromEntries(Object.entries(econ.items).map(([t, i]) => [t, i.base]));
  chain.accounts.add(TOWN);
  chain.add(TOWN, 'coin', o.treasury ?? 5000n);
  for (const [id, d] of Object.entries(econ.merchants)) chain.addMerchant(`${id}.gt.test`, d.shop, { coin: d.restore.coin, ...d.restore.items }, { coin: d.startCash, ...d.startStock }, base);
  if (o.noRegister) chain.registerPlayer = async () => { throw new Error('settler offline'); };
  const store = new Store(':memory:');
  let now = 1_800_000_000_000;
  const clock = { now: () => now, advanceHours: (h: number) => { now += h * econ.time.realMsPerGameHour; }, advanceMs: (ms: number) => { now += ms; } };
  const game = new Game(store, chain, { merchantParent: 'gt.test', town: TOWN, now: clock.now, rng: () => 0.99, econ, chunkSize: 25, ...(o.seed != null ? { worldSeed: o.seed } : {}) });
  await game.init();
  return { econ, chain, game, clock };
}
const rows = (g: Game, kind: string) => g.gs.db.prepare('SELECT account, token, delta, ref FROM ledger WHERE kind = ?').all(kind) as Array<{ account: string; token: string; delta: number; ref: string }>;

test('the shared wallet does the town\'s shopping, each buy booked under a resident, paid from the treasury first', async () => {
  const { game, clock } = await world();
  assert.equal(game.residents.wallet, WALLET);
  assert.ok(game.residents.ready, 'registered on the (mock) chain at start');
  const town0 = game.gs.balance(TOWN, 'coin');
  for (let h = 0; h < 6; h++) { clock.advanceHours(1); await game.step(); }
  const buys = rows(game, 'resident_buy'), sales = rows(game, 'resident_sale');
  assert.ok(buys.length > 0, 'the town bought something');
  assert.ok(buys.every((r) => r.account === WALLET && r.token === 'coin' && r.delta < 0 && /^r[1-5]:(sari|budi|wati|joko):\w+$/.test(r.ref)), 'booked per resident');
  assert.equal(new Set(buys.map((r) => r.ref.split(':')[0])).size, Math.min(5, buys.length), 'the residents take turns');
  // what the wallet paid is what the merchants got: a transfer, not new money
  const paid = -buys.reduce((s, r) => s + r.delta, 0), got = sales.filter((r) => r.token === 'coin').reduce((s, r) => s + r.delta, 0);
  assert.equal(paid, got);
  assert.equal(rows(game, 'town_buy').length, 0, 'the old new-coin purchase is not used');
  const fromTown = -rows(game, 'handout').filter((r) => r.account === TOWN).reduce((s, r) => s + r.delta, 0);
  assert.ok(fromTown > 0 && game.gs.balance(TOWN, 'coin') === town0 - fromTown);
  assert.ok(game.gs.balance(TOWN, 'coin') >= game.econ.residents.treasuryReserve, 'the treasury keeps its reserve for starter kits');
  assert.equal(rows(game, 'handout_mint').length, 0, 'no new coin while the treasury can pay');
  assert.ok(game.gs.balance(WALLET, 'coin') >= 0);
});

test('with the treasury at its reserve the handout is new coin, inside the faucet; past the money cap the town stops', async () => {
  const { game, clock } = await world({ treasury: 1000n }); // below the 2000 reserve
  for (let h = 0; h < 4; h++) { clock.advanceHours(1); await game.step(); }
  const day = game.clock.time().settleDay;
  assert.ok(rows(game, 'handout_mint').length > 0, 'the faucet tops the wallet up');
  assert.equal(rows(game, 'handout').length, 0, 'nothing taken from a treasury at its reserve');
  assert.ok(game.market.faucetLeft(day) >= 0 && game.gs.newCoin(day) > 0);
  game.gs.setMeta('coin.supply', '1000000'); // above the money cap: no faucet
  const w = game.gs.balance(WALLET, 'coin');
  game.gs.add(day, WALLET, 'coin', -w, 'test', 'drain');
  const before = rows(game, 'resident_buy').length;
  clock.advanceHours(1); await game.step();
  assert.equal(rows(game, 'resident_buy').length, before, 'an empty wallet with no handout buys nothing');
});

test('until the wallet is registered the town buys the old way (new coin straight to the merchant)', async () => {
  const { game, clock } = await world({ noRegister: true });
  assert.equal(game.residents.ready, false);
  for (let h = 0; h < 3; h++) { clock.advanceHours(1); await game.step(); }
  assert.ok(rows(game, 'town_buy').length > 0);
  assert.equal(rows(game, 'resident_buy').length, 0);
  assert.equal(game.gs.balance(WALLET, 'coin'), 0);
});

test('settlement puts the wallet on chain like any account, and the books match', async () => {
  const { game, chain, clock } = await world();
  for (let h = 0; h < 3; h++) { clock.advanceHours(1); await game.step(); }
  const off = game.gs.balance(WALLET, 'coin');
  assert.ok(off > 0);
  await game.devSettle();
  assert.deepEqual(await chain.balances(WALLET, ['coin']), [String(off)]);
  assert.equal(game.gs.settledBalance(WALLET, 'coin'), off);
});

test('residents walk the village; one who bought walks to that stall and the goods fly when it arrives', async () => {
  const { game, clock } = await world({ seed: 42 });
  const r = game.residents;
  assert.equal(r.walkers.length, 5);
  const deals: unknown[][] = [];
  r.d.onDeal = (...a) => { deals.push(a); };
  const view0 = r.view(clock.now());
  assert.equal(view0.length, 5);
  for (const v of view0) assert.ok(game.map!.walkable(v.x, v.y), `${v.name} stands on a walkable tile`);
  assert.ok(view0.every((v) => v.account.endsWith('.residents')), 'a resident is not a wallet');
  // one purchase: the next resident is sent to Sari's stall
  const day = game.clock.time().settleDay;
  const rid = r.pay(day, 'sari', 'bread', 7);
  assert.equal(rid, 'r1');
  const front = r.stallFront('sari')!;
  assert.ok(game.map!.nearStall(front) && game.map!.walkable(front.x, front.y));
  for (let i = 0; i < 200 && !deals.length; i++) { clock.advanceMs(500); r.tick(clock.now()); }
  assert.equal(deals.length, 1, 'the walk ended at the stall');
  const [who, merchant, got, paid] = deals[0];
  assert.match(String(who), /^r\d\.residents$/);
  assert.equal(merchant, 'sari.gt.test');
  assert.deepEqual(got, { bread: 1 });
  assert.deepEqual(paid, { coin: 7 });
  const buyer = r.view(clock.now()).find((v) => v.account === who)!;
  assert.deepEqual({ x: buyer.x, y: buyer.y }, front, 'it stands at the stall');
});

test('a path only crosses walkable tiles, one step at a time', async () => {
  const { game } = await world({ seed: 42 });
  const r = game.residents, a = r.stallFront('sari')!, b = r.stallFront('joko')!;
  const p = r.route(game.map!.layout.spawn, a)!;
  assert.ok(p && p.length > 1);
  for (let i = 1; i < p.length; i++) assert.equal(Math.abs(p[i].x - p[i - 1].x) + Math.abs(p[i].y - p[i - 1].y), 1);
  assert.ok(p.every((q) => game.map!.walkable(q.x, q.y)));
  assert.deepEqual(r.route(a, b)!.at(-1), b);
});

test('a crafting fee goes to the town treasury, so it can fund the handouts', async () => {
  const { game, chain, econ } = await world();
  const P = 'p1.players.test';
  game.store.addPlayer(P, 'sub-p1', 'ed25519:o');
  await chain.registerPlayer(P);
  game.onNewPlayer(P);
  const id = Object.keys(econ.recipes).find((k) => econ.recipes[k].fee > 0 && !econ.recipes[k].energy)!, r = econ.recipes[id];
  const day = game.clock.time().settleDay;
  for (const [t, n] of Object.entries(r.inputs)) game.gs.add(day, P, t, n, 'test', 'kit');
  const town0 = game.gs.balance(TOWN, 'coin'), coin0 = game.gs.balance(P, 'coin');
  game.act(P, { action: 'craft', recipe: id });
  assert.equal(game.gs.balance(P, 'coin'), coin0 - r.fee);
  assert.equal(game.gs.balance(TOWN, 'coin'), town0 + r.fee, 'the fee is not burned: the treasury gets it');
});
