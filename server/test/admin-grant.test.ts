// Admin coin grants (src/admingrant.ts): town treasury -> player, off-chain ledger rows settled at the daily settlement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as near from 'near-api-js';
import { Store } from '../src/db.ts';
import { MockChain } from '../src/chain.ts';
import { Game } from '../src/game/game.ts';
import { loadEcon } from '../src/game/econ.ts';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { requestMessage } from '../src/reqauth.ts';
import { ChainCheck } from '../src/chaincheck.ts';
import { mkdtempSync, writeFileSync as wf } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOWN = 'town.gt.test', ADM = 'p1.players.test', Q = 'p2.players.test', R = 'p3.players.test';
const NOW = 1_800_000_000_000;

async function harness(opts: { admin?: boolean; treasury?: bigint; limits?: { maxPerGrant: number; maxPerDay: number }; clientDir?: string } = {}) {
  const econ = loadEcon();
  if (opts.limits) econ.adminGrant = opts.limits;
  const cfg = loadConfig({ CHAIN_MODE: 'mock', GAME_CONTRACT_ID: 'game.test', PLAYERS_PARENT_ACCOUNT_ID: 'players.test', TOWN_ACCOUNT_ID: TOWN, MERCHANT_PARENT_ACCOUNT_ID: 'gt.test', ...(opts.admin === false ? {} : { ADMIN_ACCOUNTS: ADM }) } as NodeJS.ProcessEnv);
  const chain = new MockChain();
  chain.contractId = cfg.gameContractId;
  chain.townAccount = TOWN;
  chain.accounts.add(TOWN); chain.add(TOWN, 'coin', opts.treasury ?? 20_000n);
  for (const [id, d] of Object.entries(econ.merchants)) chain.addMerchant(`${id}.gt.test`, d.shop, { coin: d.restore.coin, ...d.restore.items }, { coin: d.startCash, ...d.startStock }, {});
  const store = new Store(':memory:');
  const game = new Game(store, chain, { merchantParent: 'gt.test', town: TOWN, now: () => NOW, rng: () => 0.99, econ, chunkSize: 5, worldSeed: 20261114 });
  await game.init();
  const keys: Record<string, near.KeyPair> = {};
  for (const [a, name] of [[ADM, 'Ani'], [Q, 'Budi'], [R, 'budi']] as const) {
    const sess = near.KeyPair.fromRandom('ed25519');
    store.addPlayer(a, 'sub-' + a, near.KeyPair.fromRandom('ed25519').getPublicKey().toString());
    store.addSessionKey(sess.getPublicKey().toString(), a);
    await chain.registerPlayer(a); game.onNewPlayer(a);
    // R is an old duplicate of Q's name (setName refuses a taken name now), so its row is written directly
    if (a === R) store.db.prepare('INSERT OR REPLACE INTO names (account, name, tag, look) VALUES (?, ?, ?, 0)').run(a, name, '77777');
    else store.setName(a, name);
    keys[a] = sess;
  }
  const { server } = createApp({ cfg, chain, store, game, verify: async (t) => ({ sub: t }), currentBlockHeight: async () => 100n, clientDir: opts.clientDir ?? '.' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const call = async (as: string, method: string, path: string, body?: unknown) => {
    const kp = keys[as], raw = body === undefined ? '' : JSON.stringify(body), ts = String(Date.now());
    const sig = kp.sign(new TextEncoder().encode(requestMessage(method, path, ts, raw))).signature;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, body: raw || undefined, headers: { 'x-account-id': as, 'x-gt-key': kp.getPublicKey().toString(), 'x-gt-ts': ts, 'x-gt-sig': Buffer.from(sig).toString('base64') } });
    return { status: res.status, json: await res.json().catch(() => null) as any };
  };
  const grant = (to: string, coin: unknown, note?: string) => call(ADM, 'POST', '/api/admin/grant', { to, coin, ...(note !== undefined ? { note } : {}) });
  const ledger = () => game.gs.db.prepare("SELECT account, delta, ref FROM ledger WHERE kind = 'admin_grant' ORDER BY seq").all() as Array<{ account: string; delta: number; ref: string }>;
  return { cfg, chain, game, store, call, grant, ledger, port, close: () => { server.closeAllConnections(); server.close(); } };
}
const quiet = () => { const w = console.warn; console.warn = () => {}; return () => { console.warn = w; }; };

test('a non-admin is refused with 403 and nothing moves', async () => {
  const h = await harness({ admin: false });
  try {
    const r = await h.grant('Budi#' + h.store.tagOf(Q), 100);
    assert.equal(r.status, 403);
    assert.equal(h.ledger().length, 0);
    assert.equal((await h.call(ADM, 'GET', '/api/admin/resolve?name=Ani')).status, 403);
    assert.equal((await h.call(ADM, 'GET', '/api/state')).json.treasury, undefined, 'non-admins never see the treasury');
  } finally { h.close(); }
});

test('an admin moves coin from the town treasury to a player: ledger rows, history, state, status', async () => {
  const h = await harness();
  const unquiet = quiet();
  try {
    const tag = h.store.tagOf(Q);
    const treasury0 = h.game.gs.balance(TOWN, 'coin'), q0 = h.game.gs.balance(Q, 'coin');
    assert.equal(treasury0, 20_000 - 300, 'the three starter kits already took 100 coin each');
    const st0 = await h.call(ADM, 'GET', '/api/state');
    assert.equal(st0.json.admin, true); assert.equal(st0.json.treasury, treasury0);
    const r = await h.grant('Budi#' + tag, 300, 'prize');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.coin, 300); assert.equal(r.json.treasury, treasury0 - 300);
    assert.equal(h.game.gs.balance(TOWN, 'coin'), treasury0 - 300);
    assert.equal(h.game.gs.balance(Q, 'coin'), q0 + 300);
    assert.deepEqual(h.ledger().map((x) => [x.account, x.delta, x.ref]), [[TOWN, -300, `${ADM}|prize`], [Q, 300, `${ADM}|prize`]]);
    assert.match(h.store.history(Q, 5)[0].summary, /sent you 300 coin: prize/);
    assert.match(h.store.history(ADM, 5)[0].summary, /You sent 300 coin from the town treasury to Budi/);
    // by account id too
    assert.equal((await h.grant(Q, 50)).status, 200);
    const st = (await h.call(ADM, 'GET', '/api/admin/status')).json;
    assert.equal(st.treasury, treasury0 - 350);
    assert.deepEqual(st.grants.map((g: any) => [g.admin, g.to, g.coin, g.note]), [[ADM, Q, 50, ''], [ADM, Q, 300, 'prize']]);
    assert.equal((await h.call(ADM, 'GET', '/api/state')).json.grantLimits.sentToday, 350);
    const who = await h.call(ADM, 'GET', `/api/admin/resolve?name=${encodeURIComponent('Budi#' + tag)}`);
    assert.deepEqual(who.json, { account: Q, nick: 'Budi', tag, look: 0, gainLeft: 5000 - h.game.world.dayNet(Q, 'coin', h.game.clock.time().settleDay), gainCap: 5000 });
    assert.equal(st.treasuryChain, 20_000, 'the chain figure sits next to the books figure');
    assert.equal(st.grantLimits.receiverDailyCap, 5000);
    assert.equal(st.grantLimits.sentToday, 350);
    assert.ok(st.grants[0].at > 0 && st.grants[0].toName === 'Budi', 'recent grants come from the ledger');
  } finally { unquiet(); h.close(); }
});

test('unknown, ambiguous, town and bad amounts are refused; a merchant is reached by its account id only', async () => {
  const h = await harness();
  const unquiet = quiet();
  try {
    assert.equal((await h.grant('Nobody', 10)).status, 404);
    assert.equal((await h.grant('Nobody#12345', 10)).status, 404);
    // Budi (Q) and budi (R) are an old duplicate pair: the plain name is ambiguous, name#tag is not
    const amb = await h.grant('budi', 10);
    assert.equal(amb.status, 409); assert.match(amb.json.error, /Several players/);
    assert.equal((await h.grant('budi#77777', 10)).status, 200);
    assert.equal((await h.grant('sari.gt.test', 10)).status, 200, 'a merchant account: working capital for its shop');
    assert.equal((await h.grant('Sari', 10)).status, 404, 'not by its name');
    assert.equal((await h.grant(TOWN, 10)).status, 404, 'the town account');
    assert.equal((await h.grant('', 10)).status, 400);
    for (const bad of [0, -5, 1.5, '10', null]) assert.equal((await h.grant(Q, bad)).status, 400, String(bad));
    assert.equal(h.ledger().length, 4, 'only the two good grants');
  } finally { unquiet(); h.close(); }
});

test('over maxPerGrant, over maxPerDay and a short treasury are refused', async () => {
  const h = await harness({ limits: { maxPerGrant: 200, maxPerDay: 350 } });
  const unquiet = quiet();
  try {
    const over = await h.grant(Q, 201);
    assert.equal(over.status, 409); assert.match(over.json.error, /at most 200/);
    assert.equal((await h.grant(Q, 200)).status, 200);
    const day = await h.grant(Q, 200);
    assert.equal(day.status, 409); assert.match(day.json.error, /350 coin a day/);
    assert.equal((await h.grant(Q, 150)).status, 200, 'exactly up to the daily limit');
    assert.equal((await h.grant(Q, 1)).status, 409);
    assert.equal(h.ledger().length, 4);
  } finally { unquiet(); h.close(); }
  const s = await harness({ treasury: 400n }) // the starter kits take 300, 100 is left;
  const unquiet2 = quiet();
  try {
    const r = await s.grant(Q, 101);
    assert.equal(r.status, 409); assert.match(r.json.error, /treasury has only 100/);
    assert.equal((await s.grant(Q, 100)).status, 200);
    assert.equal(s.game.gs.balance(TOWN, 'coin'), 0);
    assert.equal((await s.grant(Q, 1)).status, 409);
  } finally { unquiet2(); s.close(); }
});

test("the receiver's daily coin gain cap still holds", async () => {
  const h = await harness({ limits: { maxPerGrant: 6000, maxPerDay: 60000 } });
  const unquiet = quiet();
  try {
    assert.equal((await h.grant(Q, 4900)).status, 200, 'with the 100 starter coin that is the 5000 cap');
    const r = await h.grant(Q, 1);
    assert.equal(r.status, 409); assert.match(r.json.error, /Daily limit/);
  } finally { unquiet(); h.close(); }
});

test('the daily settlement moves a grant on chain and the chain check finds no mismatch afterwards', async () => {
  const h = await harness();
  const unquiet = quiet();
  try {
    assert.equal((await h.grant(Q, 400, 'x')).status, 200);
    const q1 = h.game.gs.balance(Q, 'coin'), t1 = h.game.gs.balance(TOWN, 'coin'); // books incl. the grant
    await h.game.devSettle();
    assert.equal(Number(h.chain.get(Q, 'coin')), q1);
    assert.equal(Number(h.chain.get(TOWN, 'coin')), t1);
    assert.equal(h.ledger().length, 2);
    for (const a of [Q, TOWN]) assert.equal(h.game.gs.settledBalance(a, 'coin'), Number(h.chain.get(a, 'coin')), a);
    assert.equal(h.game.gs.balance(Q, 'coin'), q1);
    // the receiver spends it: the chain check compares the chain with the settled amount and passes
    const cc = new ChainCheck({ chain: h.chain, settled: (a, t) => h.game.gs.settledBalance(a, t), mode: 'strict', ttlMs: 0 });
    await cc.verify(Q, ['coin'], 'buy');
    await cc.verify(TOWN, ['coin'], 'buy');
    assert.equal(cc.mismatches.length, 0);
    const st = (await h.call(ADM, 'GET', '/api/admin/status')).json;
    assert.deepEqual(st.chainCheck.mismatches, []);
  } finally { unquiet(); h.close(); }
});

test('server text comes out in Indonesian', async () => {
  const { toId } = await import('../src/lang.ts');
  assert.equal(toId('The town treasury has only 100 coin.'), 'Kas kota hanya punya 100 koin.');
  assert.equal(toId('The town treasury sent you 300 coin: prize'), 'Kas kota mengirimmu 300 koin: prize');
  assert.equal(toId('You sent 5 coin from the town treasury to Budi.'), 'Kamu mengirim 5 koin dari kas kota ke Budi.');
  assert.equal(toId('One grant can be at most 200 coin.'), 'Satu kiriman paling banyak 200 koin.');
});

test('the old top-up is gone: no /api/topup routes, no config switch, the page /topup is not special', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gt-client-'));
  wf(join(dir, 'index.html'), '<title>game</title>');
  const h = await harness({ clientDir: dir });
  try {
    for (const [m, path] of [['GET', '/api/topup/info'], ['GET', '/api/topup/resolve?name=x'], ['POST', '/api/topup/relay']] as const) {
      assert.equal((await h.call(ADM, m, path, m === 'POST' ? {} : undefined)).status, 404, path);
    }
    const cfg = await (await fetch(`http://127.0.0.1:${(h as any).port}/api/config`)).json().catch(() => null);
    if (cfg) assert.equal('topup' in cfg, false, '/api/config has no top-up block');
    assert.equal((h.cfg as any).topupEnabled, undefined);
    assert.equal((h.game.econ as any).topup, undefined);
    assert.equal((await fetch(`http://127.0.0.1:${(h as any).port}/topup`)).status, 404);
  } finally { h.close(); }
});

test('/admin serves the game page to everyone; its APIs stay admin-only, a non-admin gets nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gt-client-'));
  wf(join(dir, 'index.html'), '<title>game</title>');
  const h = await harness({ clientDir: dir });
  const g = await harness({ admin: false, clientDir: dir });
  try {
    const page = await fetch(`http://127.0.0.1:${(h as any).port}/admin`);
    assert.equal(page.status, 200); assert.match(await page.text(), /game/);
    assert.equal((await fetch(`http://127.0.0.1:${(g as any).port}/admin`)).status, 200, 'the page itself is public: it is the game');
    for (const path of ['/api/admin/status', '/api/admin/guests', '/api/admin/frozen', '/api/admin/bans', '/api/admin/resolve?name=Ani']) {
      assert.equal((await g.call(ADM, 'GET', path)).status, 403, path);
      assert.equal((await h.call(Q, 'GET', path)).status, 403, 'a signed-in player who is not an admin: ' + path);
    }
    assert.equal((await g.call(Q, 'POST', '/api/admin/grant', { to: Q, coin: 5 })).status, 403);
    const st = await h.call(Q, 'GET', '/api/state');
    assert.equal(st.json.admin, undefined); assert.equal(st.json.treasury, undefined);
  } finally { h.close(); g.close(); }
});
