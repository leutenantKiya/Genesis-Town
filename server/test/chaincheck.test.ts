// Spending is also checked against the chain's balance (src/chaincheck.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as near from 'near-api-js';
import { ChainCheck, spendTokens, offeredTokens, CHAIN_CHECK_BUSY, type ChainCheckMode } from '../src/chaincheck.ts';
import { loadEcon } from '../src/game/econ.ts';
import { Store } from '../src/db.ts';
import { MockChain } from '../src/chain.ts';
import { Game } from '../src/game/game.ts';
import { createApp } from '../src/app.ts';
import { requestMessage } from '../src/reqauth.ts';
import { loadConfig } from '../src/config.ts';
import { standNear } from './coopworld.ts';

const A = 'p1.players.test';

/** A chain whose balances the test sets, counting reads; `fail` makes every read throw, `delay` makes it slow. */
function fake(bal: Record<string, number> = {}) {
  const f = { bal, reads: 0, fail: null as string | null, delay: 0, balances: async (_a: string, toks: string[]) => {
    f.reads++;
    if (f.delay) await new Promise((r) => setTimeout(r, f.delay));
    if (f.fail) throw new Error(f.fail);
    return toks.map((t) => String(f.bal[t] ?? 0));
  } };
  return f;
}
function make(chain: ReturnType<typeof fake>, settled: Record<string, number>, o: { mode?: ChainCheckMode; settling?: () => boolean; holding?: () => boolean; now?: () => number; ttlMs?: number; timeoutMs?: number } = {}) {
  const logs: string[] = [];
  const cc = new ChainCheck({ chain, settled: (_a, t) => settled[t] ?? 0, mode: o.mode ?? 'lenient', ttlMs: o.ttlMs ?? 15_000, timeoutMs: o.timeoutMs, settling: o.settling, holding: o.holding, now: o.now, warn: (m) => logs.push(m) });
  return { cc, logs };
}
const refuses = (p: Promise<void>) => assert.rejects(p, (e: any) => e.status === 409 && e.message === CHAIN_CHECK_BUSY && e.code === 'chain_check');

test('a chain balance below the books refuses the spend, logs it and lists it for the admin', async () => {
  const c = fake({ fish: 3 });
  const { cc, logs } = make(c, { fish: 5 });
  await refuses(cc.verify(A, ['fish'], 'sell'));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /p1\.players\.test fish sell: books settled 5, chain 3/);
  assert.deepEqual(cc.mismatches.map((m) => ({ account: m.account, token: m.token, db: m.db, chain: m.chain, action: m.action })), [{ account: A, token: 'fish', db: 5, chain: 3, action: 'sell' }]);
  // the cache was dropped: when the chain is fixed, the next spend reads again and passes
  c.bal.fish = 5;
  await cc.verify(A, ['fish'], 'sell');
  assert.equal(c.reads, 2);
});

test('equal or higher on chain passes; an account the chain does not know yet counts as 0', async () => {
  const c = fake({ fish: 5, wood: 9 });
  const { cc } = make(c, { fish: 5, wood: 2 });
  await cc.verify(A, ['fish', 'wood']);
  assert.equal(cc.mismatches.length, 0);
  const n = fake();
  n.fail = 'account p1.players.test does not exist while viewing';
  await make(n, { coin: 0 }).cc.verify(A, ['coin'], 'buy'); // new player: books 0, chain unknown = 0
  const n2 = fake(); n2.fail = 'account p1.players.test does not exist while viewing';
  await refuses(make(n2, { coin: 4 }).cc.verify(A, ['coin'], 'buy')); // books claim 4 on a chain that has nothing
});

test('the mismatch list keeps the last 50', async () => {
  const c = fake({});
  const { cc } = make(c, { fish: 1 });
  for (let i = 0; i < 60; i++) await refuses(cc.verify(A, ['fish'], `a${i}`));
  assert.equal(cc.mismatches.length, 50);
  assert.equal(cc.mismatches[49].action, 'a59');
});

test('a settlement in progress, or a relay holding the account, is not checked', async () => {
  const c = fake({});
  let busy = true;
  const { cc } = make(c, { fish: 5 }, { settling: () => busy });
  await cc.verify(A, ['fish']);
  assert.equal(c.reads, 0);
  busy = false;
  await refuses(cc.verify(A, ['fish']));
  const c2 = fake({});
  await make(c2, { fish: 5 }, { holding: () => true }).cc.verify(A, ['fish']);
  assert.equal(c2.reads, 0);
  // a settlement that starts while the read is out: that read may be from the other side of it, so it is not used
  const c3 = fake({}); c3.delay = 20;
  let started = false;
  const t = make(c3, { fish: 5 }, { settling: () => started });
  const p = t.cc.verify(A, ['fish']);
  started = true;
  await p;
});

test('RPC failure or a slow read: lenient lets the spend through and logs, strict refuses, off never reads', async () => {
  const c = fake({ fish: 0 }); c.fail = 'rpc down';
  const lenient = make(c, { fish: 5 });
  await lenient.cc.verify(A, ['fish']);
  assert.match(lenient.logs[0], /cannot read the chain \(rpc down\); allowed \(lenient\)/);
  const strict = make(c, { fish: 5 }, { mode: 'strict' });
  await refuses(strict.cc.verify(A, ['fish']));
  assert.match(strict.logs[0], /refused \(strict\)/);
  const slow = fake({ fish: 5 }); slow.delay = 80;
  await make(slow, { fish: 5 }, { timeoutMs: 20 }).cc.verify(A, ['fish']);
  await refuses(make(slow, { fish: 5 }, { mode: 'strict', timeoutMs: 20 }).cc.verify(A, ['fish']));
  const off = fake({}); const o = make(off, { fish: 5 }, { mode: 'off' });
  await o.cc.verify(A, ['fish']);
  assert.equal(off.reads, 0);
});

test('reads are cached for the TTL, per token, and invalidate drops them', async () => {
  const c = fake({ fish: 5, wood: 5 });
  let t = 1000;
  const { cc } = make(c, { fish: 5, wood: 5 }, { now: () => t, ttlMs: 15_000 });
  await cc.verify(A, ['fish']);
  await cc.verify(A, ['fish']);
  assert.equal(c.reads, 1);
  await cc.verify(A, ['fish', 'wood']); // only the new token is read
  assert.equal(c.reads, 2);
  t += 14_000; await cc.verify(A, ['fish']);
  assert.equal(c.reads, 2, 'still fresh');
  t += 2_000; await cc.verify(A, ['fish']);
  assert.equal(c.reads, 3, 'older than the TTL');
  cc.invalidate(A);
  await cc.verify(A, ['fish']);
  assert.equal(c.reads, 4);
  cc.invalidate('someone.else'); await cc.verify(A, ['fish']);
  assert.equal(c.reads, 4);
});

test('which tokens an action can take: spends only, never gains', () => {
  const econ = loadEcon();
  const rid = Object.keys(econ.recipes)[0], r = econ.recipes[rid];
  assert.deepEqual(spendTokens(econ, 'sell', { token: 'fish' }), ['fish']);
  assert.deepEqual(spendTokens(econ, 'buy', { token: 'fish' }), ['coin']);
  assert.deepEqual(spendTokens(econ, 'craft', { recipe: rid }).sort(), [...Object.keys(r.inputs), ...(r.fee > 0 ? ['coin'] : [])].sort());
  for (const a of ['eat', 'ship', 'gamble', 'stock']) assert.deepEqual(spendTokens(econ, a, { token: 'bread' }), ['bread'], a);
  for (const a of ['hire', 'dress', 'ride', 'casino']) assert.deepEqual(spendTokens(econ, a, {}), ['coin'], a);
  assert.deepEqual(spendTokens(econ, 'mall', { op: 'buy' }), ['coin']);
  assert.deepEqual(spendTokens(econ, 'mall', { op: 'wear' }), []);
  for (const a of ['cook', 'build', 'repair', 'maketool']) assert.ok(spendTokens(econ, a, {}).includes('coin') && spendTokens(econ, a, {}).includes('wood'), a);
  for (const a of ['gather', 'farm', 'collect', 'forage', 'mission', 'fight', 'flee', 'engage', 'travel', 'boat', 'hoe', 'assist']) assert.deepEqual(spendTokens(econ, a, { token: 'fish' }), [], a);
  assert.deepEqual(spendTokens(econ, 'sell', { token: '__proto__' }), []);
  assert.deepEqual(offeredTokens(econ, { lines: { fish: 2, coin: 3, nope: 1 } }).sort(), ['coin', 'fish']);
  assert.deepEqual(offeredTokens(econ, { give: { wood: 1 }, want: { coin: 9 } }), ['wood']);
  assert.deepEqual(offeredTokens(econ, { token: 'ore', qty: 3 }), ['ore']);
});

/* ------------------------------------------------------------ over HTTP, on the mock chain */

async function harness(env: Record<string, string> = {}) {
  const econ = loadEcon();
  const TOWN = 'town.gt.test';
  const cfg = loadConfig({ CHAIN_MODE: 'mock', GAME_CONTRACT_ID: 'game.test', PLAYERS_PARENT_ACCOUNT_ID: 'players.test', TOWN_ACCOUNT_ID: TOWN, MERCHANT_PARENT_ACCOUNT_ID: 'gt.test', ...env } as NodeJS.ProcessEnv);
  const chain = new MockChain();
  chain.contractId = cfg.gameContractId;
  const base = Object.fromEntries(Object.entries(econ.items).map(([t, i]) => [t, i.base]));
  chain.accounts.add(TOWN);
  chain.add(TOWN, 'coin', 5000n);
  for (const [id, d] of Object.entries(econ.merchants)) chain.addMerchant(`${id}.gt.test`, d.shop, { coin: d.restore.coin, ...d.restore.items }, { coin: d.startCash, ...d.startStock }, base);
  const store = new Store(':memory:');
  const game = new Game(store, chain, { merchantParent: 'gt.test', town: TOWN, now: () => 1_800_000_000_000, rng: () => 0.99, econ, chunkSize: 5, worldSeed: 20261114 });
  await game.init();
  store.addPlayer(A, 'sub-p1', 'ed25519:o');
  await chain.registerPlayer(A);
  game.onNewPlayer(A);
  const kp = near.KeyPair.fromRandom('ed25519');
  store.addSessionKey(kp.getPublicKey().toString(), A);
  const { server } = createApp({ cfg, chain, store, game, verify: async () => ({ sub: 'x' }), currentBlockHeight: async () => 0n, clientDir: '.' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const call = async (method: string, path: string, body?: unknown) => {
    const raw = body === undefined ? '' : JSON.stringify(body), ts = String(Date.now());
    const sig = kp.sign(new TextEncoder().encode(requestMessage(method, path, ts, raw))).signature;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, body: raw || undefined, headers: { 'x-account-id': A, 'x-gt-key': kp.getPublicKey().toString(), 'x-gt-ts': ts, 'x-gt-sig': Buffer.from(sig).toString('base64') } });
    return { status: res.status, json: await res.json().catch(() => null) as any };
  };
  // chain reads the check makes (the mock's own `balances`, counted)
  const counter = { reads: 0 };
  const orig = chain.balances.bind(chain);
  chain.balances = async (a: string, t: string[]) => { counter.reads++; return orig(a, t); };
  const sell = (hh?: unknown) => { void hh; return { action: 'sell', merchant: 'sari', token: 'fish', qty: 1, pos: standNear(game.map!, game.map!.layout.market.stalls[0], 1) }; };
  return { cfg, chain, game, call, counter, sell, close: () => server.close() };
}

test('over HTTP: a spend the chain cannot back is refused with 409 and shows in the admin status; the same spend passes once the chain agrees', async () => {
  const h = await harness({ ADMIN_ACCOUNTS: A });
  try {
    h.chain.add(A, 'fish', 3n);
    await h.game.settlement.refresh([A]); // books now start from 3 bread, the chain has 3
    h.chain.add(A, 'fish', -2n); // the player moved 2 away on chain; the books have not seen it
    const before = h.game.gs.balance(A, 'fish');
    const bad = await h.call('POST', '/api/act', h.sell());
    assert.equal(bad.status, 409);
    assert.equal(bad.json.error, CHAIN_CHECK_BUSY);
    assert.equal(bad.json.code, 'chain_check');
    assert.equal(h.game.gs.balance(A, 'fish'), before, 'nothing was spent');
    const st = await h.call('GET', '/api/admin/status');
    assert.equal(st.status, 200);
    assert.equal(st.json.chainCheck.mode, 'lenient');
    assert.deepEqual(st.json.chainCheck.mismatches.map((m: any) => [m.account, m.token, m.db, m.chain, m.action]), [[A, 'fish', 3, 1, 'sell']]);
    h.chain.add(A, 'fish', 2n);
    const ok = await h.call('POST', '/api/act', h.sell());
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(h.game.gs.balance(A, 'fish'), before - 1);
  } finally { h.close(); }
});

test('over HTTP: gains are not checked, chain-higher passes, and off turns the check off', async () => {
  const h = await harness();
  try {
    h.chain.add(A, 'fish', 3n);
    await h.game.settlement.refresh([A]);
    h.chain.add(A, 'fish', -3n); // chain below the books
    h.counter.reads = 0;
    const g = await h.call('POST', '/api/act', { action: 'mission', op: 'nope' }); // not a spend (a 400 from the game itself)
    assert.notEqual(g.json?.code, 'chain_check');
    assert.equal(h.counter.reads, 0, 'no chain read for something that only gives');
    h.chain.add(A, 'fish', 10n); // chain above the books: fine
    const ok = await h.call('POST', '/api/act', h.sell());
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
  } finally { h.close(); }
  const o = await harness({ CHAIN_CHECK: 'off' });
  try {
    o.chain.add(A, 'fish', 3n);
    await o.game.settlement.refresh([A]);
    o.chain.add(A, 'fish', -3n);
    o.counter.reads = 0;
    const r = await o.call('POST', '/api/act', o.sell());
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(o.counter.reads, 0);
  } finally { o.close(); }
});

test('over HTTP: while settlement runs nothing is checked, and trade sets and consignments are', async () => {
  const h = await harness();
  try {
    h.chain.add(A, 'fish', 3n);
    await h.game.settlement.refresh([A]);
    h.chain.add(A, 'fish', -2n);
    h.game.settlement.busy = true; // between settle_day and the settled update
    const ok = await h.call('POST', '/api/act', h.sell());
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    h.game.settlement.busy = false;
    h.chain.add(A, 'fish', 1n); // chain 2, books 3
    h.game.gs.setSettled(A, 'fish', 3);
    const c = await h.call('POST', '/api/consign', { token: 'fish', qty: 1, min_price: 5 });
    assert.equal(c.status, 409);
    assert.equal(c.json.code, 'chain_check');
    const s = await h.call('POST', '/api/trade/set', { id: 1, lines: { fish: 1 }, world: 'public' });
    assert.equal(s.json.code, 'chain_check', JSON.stringify(s.json));
  } finally { h.close(); }
});

test('a change to another account during the read does not skip the check; a change to this account reads again', async () => {
  const c = fake({ fish: 3 });
  c.delay = 20;
  const { cc } = make(c, { fish: 5 });
  // another player's spend while my read is out: my mismatch is still caught
  const p = cc.verify(A, ['fish'], 'sell');
  cc.invalidate('someone.else');
  await refuses(p);
  // my own balances change during the first read: the check reads again instead of passing
  const c2 = fake({ fish: 3 });
  c2.delay = 20;
  const { cc: cc2 } = make(c2, { fish: 5 });
  const p2 = cc2.verify(A, ['fish'], 'sell');
  setTimeout(() => cc2.invalidate(A), 5);
  await refuses(p2);
  assert.equal(c2.reads, 2, 'read again after this account changed');
  // it keeps changing on every read: strict refuses
  const c3 = fake({ fish: 9 });
  c3.delay = 20;
  const { cc: cc3 } = make(c3, { fish: 5 }, { mode: 'strict' });
  const p3 = cc3.verify(A, ['fish'], 'sell');
  const iv = setInterval(() => cc3.invalidate(A), 5);
  await refuses(p3).finally(() => clearInterval(iv));
});
