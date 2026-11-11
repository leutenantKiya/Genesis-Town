import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as near from 'near-api-js';
import { Store } from '../src/db.ts';
import { MockChain } from '../src/chain.ts';
import { Game } from '../src/game/game.ts';
import { loadEcon } from '../src/game/econ.ts';
import { loadConfig } from '../src/config.ts';
import { relay, RateLimiter } from '../src/relayer.ts';
import { spendGuard } from '../src/spend.ts';
import { signedDelegateB64 } from './helpers.ts';

const TOWN = 'town.gt.test';
const P = 'p1.players.test';
const Q = 'p2.players.test';

async function world() {
  const econ = loadEcon();
  const chain = new MockChain();
  const base = Object.fromEntries(Object.entries(econ.items).map(([t, i]) => [t, i.base]));
  chain.accounts.add(TOWN);
  chain.add(TOWN, 'coin', 5000n);
  for (const [id, d] of Object.entries(econ.merchants)) chain.addMerchant(`${id}.gt.test`, d.shop, { coin: d.restore.coin, ...d.restore.items }, { coin: d.startCash, ...d.startStock }, base);
  const store = new Store(':memory:');
  let now = 1_800_000_000_000;
  const clock = { advanceHours: (h: number) => { now += h * econ.time.realMsPerGameHour; } };
  const game = new Game(store, chain, { merchantParent: 'gt.test', town: TOWN, now: () => now, rng: () => 0.99, econ, chunkSize: 5 });
  await game.init();
  for (const a of [P, Q]) { store.addPlayer(a, 'sub-' + a, 'ed25519:o'); await chain.registerPlayer(a); game.onNewPlayer(a); }
  return { econ, chain, store, game, clock };
}

test('a gathering node gives exactly its charges per cycle, every cycle', async () => {
  const { game, clock, econ } = await world();
  const g = () => game.act(P, { action: 'gather', tile: 'water', x: 5, y: 5 });
  for (let cycle = 0; cycle < 3; cycle++) {
    for (let i = 0; i < econ.gather.charges; i++) g();
    assert.throws(g, /Depleted/, `cycle ${cycle}: refused after ${econ.gather.charges}`);
    clock.advanceHours(econ.gather.respawnGameHours);
    game.gs.savePlayer({ account: P, energy: 100, energy_hour: game.clock.hours(), tool_uses: 0 });
  }
});

test('a Homeland node is limited per cycle too', async () => {
  const { game, clock, econ } = await world();
  const g = () => game.world.gather(P, 'water', 7, 7, 'HL-1:');
  for (let cycle = 0; cycle < 2; cycle++) {
    for (let i = 0; i < econ.gather.charges; i++) g();
    assert.throws(g, /Depleted/);
    clock.advanceHours(econ.gather.respawnGameHours);
    game.gs.savePlayer({ account: P, energy: 100, energy_hour: game.clock.hours(), tool_uses: 0 });
  }
});

async function relayWorld() {
  const w = await world();
  await w.game.devSettle(); // bread 3 + wheat 3 now on chain for P
  const key = near.KeyPair.fromRandom('ed25519');
  w.store.addSessionKey(key.getPublicKey().toString(), P);
  const cfg = loadConfig({ CHAIN_MODE: 'mock', GAME_CONTRACT_ID: 'game.test', PLAYERS_PARENT_ACCOUNT_ID: 'players.test', TOWN_ACCOUNT_ID: TOWN, MERCHANT_PARENT_ACCOUNT_ID: 'gt.test' } as NodeJS.ProcessEnv);
  const deps = {
    cfg, store: w.store, chain: w.chain, limiter: new RateLimiter(100, 1000), currentBlockHeight: async () => 100n,
    checkSpend: spendGuard(w.chain, w.game),
    afterRelay: async (s: string) => { await w.game.settlement.refresh([s]); },
  };
  const send = (nonce: bigint, amount = '3') => signedDelegateB64({ sender: P, key, nonce, args: { receiver_id: Q, token_id: 'bread', amount } }).b64;
  return { ...w, deps, send };
}

test('two concurrent send_item of the same bread: one goes through, the other is refused', async () => {
  const w = await relayWorld();
  assert.equal(w.game.gs.settledBalance(P, 'bread'), 3);
  const res = await Promise.allSettled([relay(w.deps, { signedDelegate: w.send(1n) }), relay(w.deps, { signedDelegate: w.send(2n) })]);
  const ok = res.filter((r) => r.status === 'fulfilled'), bad = res.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
  assert.equal(ok.length, 1);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].reason.status, 409);
  assert.equal(w.chain.get(P, 'bread'), 0n);
});

test('the same signed delegate posted twice at once is submitted once', async () => {
  const w = await relayWorld();
  let submits = 0;
  const orig = w.chain.relay.bind(w.chain);
  w.chain.relay = async (...a: Parameters<typeof orig>) => { submits++; return orig(...a); };
  const b64 = w.send(1n, '1');
  const [a, b] = await Promise.all([relay(w.deps, { signedDelegate: b64 }), relay(w.deps, { signedDelegate: b64 })]);
  assert.equal(submits, 1);
  assert.equal([a, b].filter((r) => (r as { duplicate?: boolean }).duplicate).length, 1);
});

test('the spend guard refuses zero, negative and fractional amounts', async () => {
  const { game, chain } = await world();
  await game.devSettle();
  const guard = spendGuard(chain, game);
  for (const amount of ['-5', '0', '1.5', 'abc']) {
    await assert.rejects(guard(P, 'send_item', { receiver_id: Q, token_id: 'bread', amount }), (e: { status: number }) => e.status === 400, amount);
  }
  await assert.rejects(guard(P, 'list_item', { token_id: 'bread', amount: '-1', price_each: '5' }), (e: { status: number }) => e.status === 400);
  await assert.rejects(guard(P, 'project_contribute', { id: 'x', contribution: [{ token_id: 'bread', amount: '-2' }] }), (e: { status: number }) => e.status === 400);
  await guard(P, 'send_item', { receiver_id: Q, token_id: 'bread', amount: '2' });
});

test('the off-chain daily gain cap refuses items and coin past what the contract would accept', async () => {
  const { game, econ } = await world();
  const day = game.clock.time().settleDay;
  game.gs.add(day, P, 'fish', econ.caps.dailyGainPerItem - 1, 'test');
  game.act(P, { action: 'gather', tile: 'water', x: 5, y: 5 }); // the last allowed unit
  assert.throws(() => game.act(P, { action: 'gather', tile: 'water', x: 6, y: 5 }), (e: { status: number; message: string }) => e.status === 409 && /limit/i.test(e.message));
  // coin: a sale that would push today's net coin gain over the cap
  game.gs.add(day, P, 'coin', 4990, 'test');
  game.gs.add(day, P, 'wheat', 10, 'test');
  assert.throws(() => game.act(P, { action: 'sell', merchant: 'sarah', token: 'wheat', qty: 10 }), (e: { status: number }) => e.status === 409);
});

test('starter coin comes from the treasury only when it can pay; otherwise goods only', async () => {
  const { game } = await world();
  const day = game.clock.time().settleDay;
  game.gs.add(day, TOWN, 'coin', -(game.gs.balance(TOWN, 'coin') - 50), 'test'); // 50 coin left
  game.world.starter('p9.players.test', TOWN);
  assert.equal(game.gs.balance('p9.players.test', 'coin'), 0);
  assert.equal(game.gs.balance('p9.players.test', 'bread'), 3);
  assert.equal(game.gs.balance(TOWN, 'coin'), 50, 'treasury untouched');
});
