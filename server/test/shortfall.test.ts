import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as near from 'near-api-js';
import { Store } from '../src/db.ts';
import { MockChain } from '../src/chain.ts';
import { Game } from '../src/game/game.ts';
import { loadEcon } from '../src/game/econ.ts';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { relay, RateLimiter } from '../src/relayer.ts';
import { spendGuard } from '../src/spend.ts';
import { signedDelegateB64 } from './helpers.ts';

const TOWN = 'town.gt.test';
const P = 'p1.players.test';
const Q = 'p2.players.test';
const FROZEN = /Akun ini dibekukan karena saldo on-chain tidak cocok dengan permainan\. Hubungi pengelola\./;

async function world(opts: { seed?: number; rng?: () => number } = {}) {
  const econ = loadEcon();
  const chain = new MockChain();
  const base = Object.fromEntries(Object.entries(econ.items).map(([t, i]) => [t, i.base]));
  chain.accounts.add(TOWN);
  chain.add(TOWN, 'coin', 5000n);
  for (const [id, d] of Object.entries(econ.merchants)) chain.addMerchant(`${id}.gt.test`, d.shop, { coin: d.restore.coin, ...d.restore.items }, { coin: d.startCash, ...d.startStock }, base);
  for (const p of econ.projects) chain.addProject(p.id, p.name, p.chunk, p.need);
  const store = new Store(':memory:');
  let now = 1_800_000_000_000;
  const clock = { now: () => now, advanceMs: (ms: number) => { now += ms; }, advanceHours: (h: number) => { now += h * econ.time.realMsPerGameHour; } };
  const game = new Game(store, chain, { merchantParent: 'gt.test', town: TOWN, now: clock.now, rng: opts.rng ?? (() => 0.99), econ, chunkSize: 5, ...(opts.seed ? { worldSeed: opts.seed } : {}) });
  await game.init();
  for (const a of [P, Q]) { store.addPlayer(a, 'sub-' + a, 'ed25519:o'); await chain.registerPlayer(a); game.onNewPlayer(a); }
  // P holds 10 settled fish on chain.
  chain.add(P, 'fish', 10n);
  await game.settlement.refresh([P]);
  return { econ, chain, store, game, clock };
}
type W = Awaited<ReturnType<typeof world>>;

const quiet = () => { const o = console.error; const lines: string[] = []; console.error = (...a: unknown[]) => { lines.push(a.join(' ')); }; return { lines, restore: () => { console.error = o; } }; };
const sell = (w: W, qty = 10) => w.game.act(P, { action: 'sell', merchant: 'sari', token: 'fish', qty });
const gather = (w: W) => w.game.act(P, { action: 'gather', tile: 'water', x: 0, y: 9 });

test('mt_transfer_after_offchain_sale_does_not_block_settlement', async () => {
  const w = await world();
  const day = w.game.clock.time().settleDay;
  const sariFish = Number(w.chain.get('sari.gt.test', 'fish'));
  sell(w);
  w.chain.add(P, 'fish', -10n); // the player moves the fish away on chain with mt_transfer
  const q = quiet();
  try { await w.game.devSettle(); } finally { q.restore(); }
  assert.equal(w.game.settlement.settledThrough(), day, 'day completes');
  assert.equal(Number(w.chain.get('sari.gt.test', 'fish')), sariFish + 10, 'sari still receives the fish');
  assert.equal(Number(w.chain.get(P, 'fish')), 0);
  const f = w.game.gs.shortfalls().find((x) => x.account === P && x.token === 'fish')!;
  assert.ok(f, 'shortfall recorded');
  assert.equal(f.day, day);
  assert.equal(f.wanted, -10);
  assert.equal(f.applied, 0);
  assert.ok(q.lines.some((l) => /shortfall/i.test(l) && l.includes(P)), 'logged');
  assert.equal(w.game.gs.isFrozen(P), true);
  assert.throws(() => sell(w), (e: any) => e.status === 403 && FROZEN.test(e.message));
  assert.throws(() => gather(w), (e: any) => e.status === 403);
  assert.equal(w.game.gs.dayRows(day).filter((r) => !r.settled).length, 0, 'rows settled');
  await w.game.settlement.refresh([P, 'sari.gt.test']);
  assert.equal(w.game.gs.settledBalance('sari.gt.test', 'fish'), Number(w.chain.get('sari.gt.test', 'fish')));
});

test('unregistered_account_entries_dropped_and_frozen', async () => {
  const w = await world();
  const day = w.game.clock.time().settleDay;
  const sariFish = Number(w.chain.get('sari.gt.test', 'fish'));
  sell(w);
  w.chain.accounts.delete(P); // storage_unregister
  const q = quiet();
  try { await w.game.devSettle(); } finally { q.restore(); }
  assert.equal(w.game.settlement.settledThrough(), day);
  assert.equal(Number(w.chain.get('sari.gt.test', 'fish')), sariFish + 10);
  const rows = w.game.gs.shortfalls().filter((x) => x.account === P);
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => r.applied === 0));
  assert.ok(rows.some((r) => r.token === 'fish' && r.wanted === -10));
  assert.equal(w.game.gs.isFrozen(P), true);
  assert.throws(() => sell(w), (e: any) => e.status === 403);
});

test('race_between_preflight_and_submit_completes_on_retry', async () => {
  const w = await world();
  const day = w.game.clock.time().settleDay;
  sell(w);
  const orig = w.chain.balances.bind(w.chain);
  let raced = false;
  w.chain.balances = async (a, t) => {
    const r = await orig(a, t);
    if (!raced && a === P) { raced = true; w.chain.add(P, 'fish', -10n); } // moved after pre-flight, before submit
    return r;
  };
  const q = quiet();
  try {
    await w.game.devSettle();
    assert.ok(raced);
    assert.equal(w.game.settlement.settledThrough(), day - 1, 'first attempt failed');
    const calls = w.chain.settleCalls.length;
    await w.game.step();
    assert.equal(w.chain.settleCalls.length, calls, 'backoff applies');
    w.clock.advanceMs(31_000);
    await w.game.step();
  } finally { q.restore(); }
  assert.equal(w.game.settlement.settledThrough(), day, 'completes on retry');
  assert.equal(w.game.gs.isFrozen(P), true);
  assert.equal(w.game.gs.shortfalls().find((x) => x.account === P && x.token === 'fish')!.wanted, -10);
});

test('unfreeze_dev_route', async () => {
  const w = await world();
  const cfg = loadConfig({ CHAIN_MODE: 'mock', GAME_CONTRACT_ID: 'game.test', PLAYERS_PARENT_ACCOUNT_ID: 'players.test', TOWN_ACCOUNT_ID: TOWN, MERCHANT_PARENT_ACCOUNT_ID: 'gt.test', DEV_TOOLS: '1' } as NodeJS.ProcessEnv);
  const { server } = createApp({ cfg, chain: w.chain, store: w.store, game: w.game, verify: async () => ({ sub: 'x' }), currentBlockHeight: async () => 0n, clientDir: '.' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    w.game.gs.recordShortfall(0, 0, P, 'fish', -10, 0);
    assert.equal(w.game.gs.isFrozen(P), true);
    assert.throws(() => gather(w), (e: any) => e.status === 403);
    const res = await fetch(base + '/api/dev/unfreeze', { method: 'POST', body: JSON.stringify({ account: P }) });
    assert.equal(res.status, 200);
    assert.equal(w.game.gs.isFrozen(P), false);
    assert.doesNotThrow(() => gather(w));
    assert.equal(w.game.gs.shortfalls().length, 1, 'the record stays');
  } finally { server.close(); }
});

test('frozen_account_cannot_relay', async () => {
  const w = await world();
  const key = near.KeyPair.fromRandom('ed25519');
  w.store.addSessionKey(key.getPublicKey().toString(), P);
  const cfg = loadConfig({ CHAIN_MODE: 'mock', GAME_CONTRACT_ID: 'game.test', PLAYERS_PARENT_ACCOUNT_ID: 'players.test', TOWN_ACCOUNT_ID: TOWN, MERCHANT_PARENT_ACCOUNT_ID: 'gt.test' } as NodeJS.ProcessEnv);
  const deps = { cfg, store: w.store, chain: w.chain, limiter: new RateLimiter(100, 1000), currentBlockHeight: async () => 100n, assertActive: (a: string) => w.game.assertActive(a) };
  const b64 = signedDelegateB64({ sender: P, key, nonce: 1n, args: { receiver_id: Q, token_id: 'fish', amount: '1' } }).b64;
  w.game.gs.recordShortfall(0, 0, P, 'fish', -1, 0);
  await assert.rejects(relay(deps, { signedDelegate: b64 }), (e: any) => e.status === 403 && FROZEN.test(e.message));
});

test('in_flight_relay_reserves_its_amount_from_offchain_spending', async () => {
  const w = await world();
  const key = near.KeyPair.fromRandom('ed25519');
  w.store.addSessionKey(key.getPublicKey().toString(), P);
  const cfg = loadConfig({ CHAIN_MODE: 'mock', GAME_CONTRACT_ID: 'game.test', PLAYERS_PARENT_ACCOUNT_ID: 'players.test', TOWN_ACCOUNT_ID: TOWN, MERCHANT_PARENT_ACCOUNT_ID: 'gt.test' } as NodeJS.ProcessEnv);
  const deps = {
    cfg, store: w.store, chain: w.chain, limiter: new RateLimiter(100, 1000), currentBlockHeight: async () => 100n,
    checkSpend: spendGuard(w.chain, w.game), releaseSpend: (a: string) => w.game.gs.release(a),
    afterRelay: async (s: string) => { await w.game.settlement.refresh([s]); },
  };
  // leave exactly 4 fish
  w.chain.add(P, 'fish', -6n);
  await w.game.settlement.refresh([P]);
  assert.equal(w.game.gs.balance(P, 'fish'), 4);
  let started!: () => void;
  const inGuard = new Promise<void>((r) => { started = r; });
  let go!: () => void;
  const gate = new Promise<void>((r) => { go = r; });
  const orig = w.chain.relay.bind(w.chain);
  w.chain.relay = async (...a: Parameters<typeof orig>) => { started(); await gate; return orig(...a); };
  const b64 = signedDelegateB64({ sender: P, key, nonce: 1n, args: { receiver_id: Q, token_id: 'fish', amount: '4' } }).b64;
  const pending = relay(deps, { signedDelegate: b64 });
  await inGuard;
  assert.equal(w.game.gs.balance(P, 'fish'), 0, 'reserved while the relay is in flight');
  assert.throws(() => sell(w, 4), (e: any) => e.status === 409);
  go();
  const r = await pending;
  assert.equal(r.status, 'mock');
  assert.equal(w.game.gs.reservedOf(P, 'fish'), 0, 'reservation released');
  assert.equal(w.game.gs.balance(P, 'fish'), 0, 'the fish are really gone');
  assert.equal(Number(w.chain.get(Q, 'fish')), 4);
});

test('reservation_is_released_when_the_relay_fails', async () => {
  const w = await world();
  const key = near.KeyPair.fromRandom('ed25519');
  w.store.addSessionKey(key.getPublicKey().toString(), P);
  const cfg = loadConfig({ CHAIN_MODE: 'mock', GAME_CONTRACT_ID: 'game.test', PLAYERS_PARENT_ACCOUNT_ID: 'players.test', TOWN_ACCOUNT_ID: TOWN, MERCHANT_PARENT_ACCOUNT_ID: 'gt.test' } as NodeJS.ProcessEnv);
  const deps = { cfg, store: w.store, chain: w.chain, limiter: new RateLimiter(100, 1000), currentBlockHeight: async () => 100n, checkSpend: spendGuard(w.chain, w.game), releaseSpend: (a: string) => w.game.gs.release(a) };
  w.chain.relay = async () => { throw new Error('rpc down'); };
  const b64 = signedDelegateB64({ sender: P, key, nonce: 1n, args: { receiver_id: Q, token_id: 'fish', amount: '4' } }).b64;
  await assert.rejects(relay(deps, { signedDelegate: b64 }));
  assert.equal(w.game.gs.reservedOf(P, 'fish'), 0);
});

test('monster_drop_respects_the_daily_gain_cap', async () => {
  const w = await world({ seed: 42, rng: () => 0.1 });
  const m = w.game.monsters!;
  const drop = w.econ.monsters.kinds.boar.drop;
  const day = w.game.clock.time().settleDay;
  w.game.gs.add(day, P, drop, (w.econ.caps as { dailyGainPerItem: number }).dailyGainPerItem, 'gather');
  m.pending.set(P, { kind: 'boar', name: 'Babi hutan', hp: 1, maxHp: 1, tile: null, x: 1, y: 1 });
  const before = w.game.gs.balance(P, drop);
  const r = m.fight(P) as { toast: string; won?: boolean };
  assert.equal(r.won, true, 'the fight still ends in a win');
  assert.equal(w.game.gs.balance(P, drop), before, 'no drop above the cap');
  assert.equal(w.game.gs.dayRows(day).filter((x) => x.kind === 'monster_drop').length, 0);
  assert.match(r.toast, /batas/i);
});

test('cap_clamp_in_preflight_is_recorded_without_freezing', async () => {
  const w = await world();
  const day = w.game.clock.time().settleDay;
  const cap = (w.econ.caps as { dailyGainPerItem: number }).dailyGainPerItem;
  w.game.gs.add(day, P, 'wood', cap + 50, 'gather'); // a bug elsewhere wrote too much
  const q = quiet();
  try { await w.game.devSettle(); } finally { q.restore(); }
  assert.equal(w.game.settlement.settledThrough(), day, 'the day completes instead of blocking');
  assert.equal(Number(w.chain.get(P, 'wood')), cap);
  const f = w.game.gs.shortfalls().find((x) => x.account === P && x.token === 'wood')!;
  assert.equal(f.kind, 'cap_clamp');
  assert.equal(f.wanted, cap + 50);
  assert.equal(f.applied, cap);
  assert.equal(w.game.gs.isFrozen(P), false);
});

test('shortfall_withholds_the_accounts_credits', async () => {
  const w = await world();
  const day = w.game.clock.time().settleDay;
  const sariFish = Number(w.chain.get('sari.gt.test', 'fish'));
  const coinBefore = Number(w.chain.get(P, 'coin'));
  const cacheBefore = w.game.gs.settledBalance(P, 'coin');
  sell(w); // fish -10, coin +N off-chain
  w.chain.add(P, 'fish', -10n); // moved away on chain
  const q = quiet();
  try { await w.game.devSettle(); } finally { q.restore(); }
  assert.equal(w.game.settlement.settledThrough(), day);
  assert.equal(Number(w.chain.get(P, 'coin')), coinBefore, 'no coin credited on chain');
  await w.game.settlement.refresh([P]);
  assert.equal(w.game.gs.settledBalance(P, 'coin'), cacheBefore, 'cache matches');
  assert.equal(Number(w.chain.get('sari.gt.test', 'fish')), sariFish + 10, 'sari still gets the fish');
  const rows = w.game.gs.shortfalls().filter((x) => x.account === P);
  assert.ok(rows.some((x) => x.token === 'fish' && x.kind === 'shortfall'));
  const wh = rows.find((x) => x.token === 'coin' && x.kind === 'withheld')!;
  assert.ok(wh, 'withheld row');
  assert.ok(wh.wanted > 0);
  assert.equal(wh.applied, 0);
  assert.equal(w.game.gs.isFrozen(P), true);
});
