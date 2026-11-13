// Admin purge of old NEAR Auth accounts (src/purge.ts): dry run first, only confirmed accounts go, never during settlement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as near from 'near-api-js';
import { Store } from '../src/db.ts';
import { MockChain } from '../src/chain.ts';
import { Game } from '../src/game/game.ts';
import { loadEcon } from '../src/game/econ.ts';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { register, playerAccountId } from '../src/auth.ts';
import { requestMessage } from '../src/reqauth.ts';

const TOWN = 'town.gt.test', ADM = 'p1.players.test', L1 = 'p2.players.test', L2 = 'p3.players.test', C = 'p4.players.test';
const NOW = 1_800_000_000_000;
const rnd = () => near.KeyPair.fromRandom('ed25519').getPublicKey().toString();

async function harness() {
  const econ = loadEcon();
  const cfg = loadConfig({ CHAIN_MODE: 'mock', GAME_CONTRACT_ID: 'game.test', PLAYERS_PARENT_ACCOUNT_ID: 'players.test', TOWN_ACCOUNT_ID: TOWN, MERCHANT_PARENT_ACCOUNT_ID: 'gt.test', ADMIN_ACCOUNTS: ADM } as NodeJS.ProcessEnv);
  const chain = new MockChain();
  chain.contractId = cfg.gameContractId; chain.townAccount = TOWN;
  chain.accounts.add(TOWN); chain.add(TOWN, 'coin', 20_000n);
  for (const [id, d] of Object.entries(econ.merchants)) chain.addMerchant(`${id}.gt.test`, d.shop, { coin: d.restore.coin, ...d.restore.items }, { coin: d.startCash, ...d.startStock }, {});
  const store = new Store(':memory:');
  const game = new Game(store, chain, { merchantParent: 'gt.test', town: TOWN, now: () => NOW, rng: () => 0.99, econ, chunkSize: 5, worldSeed: 20261114 });
  await game.init();
  const keys: Record<string, near.KeyPair> = {};
  // ADM, L1, L2 hold an owner key that is not the one our NEAR Auth derives (the public NEAR Auth made it); C holds the derived one
  for (const [a, name, legacy] of [[ADM, 'Ani', true], [L1, 'Lama', true], [L2, 'Tua', true], [C, 'Baru', false]] as const) {
    const sess = near.KeyPair.fromRandom('ed25519');
    store.addPlayer(a, 'sub-' + a, legacy ? rnd() : await chain.derivedOwnerKey('sub-' + a));
    store.addSessionKey(sess.getPublicKey().toString(), a);
    store.setActiveKey(a, sess.getPublicKey().toString());
    await chain.registerPlayer(a); game.onNewPlayer(a);
    store.setName(a, name);
    keys[a] = sess;
  }
  const { server } = createApp({ cfg, chain, store, game, verify: async (t) => ({ sub: t }), currentBlockHeight: async () => 100n, clientDir: '.' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const call = async (as: string, path: string, body: unknown) => {
    const kp = keys[as], raw = JSON.stringify(body), ts = String(Date.now());
    const sig = kp.sign(new TextEncoder().encode(requestMessage('POST', path, ts, raw))).signature;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body: raw, headers: { 'x-account-id': as, 'x-gt-key': kp.getPublicKey().toString(), 'x-gt-ts': ts, 'x-gt-sig': Buffer.from(sig).toString('base64') } });
    return { status: res.status, json: await res.json().catch(() => null) as any };
  };
  const purge = (as: string, body: unknown) => call(as, '/api/admin/purge-legacy', body);
  const count = (table: string, col: string, a: string) => (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).get(a) as { n: number }).n;
  return { cfg, chain, game, store, call, purge, count, close: () => { server.closeAllConnections(); server.close(); } };
}

test('a non-admin is refused with 403, for a dry run and a real run', async () => {
  const h = await harness();
  try {
    assert.equal((await h.purge(C, { dryRun: true })).status, 403);
    assert.equal((await h.purge(L1, { dryRun: false, accounts: [L2] })).status, 403);
    assert.equal(h.store.isPlayer(L2), true);
  } finally { h.close(); }
});

test('the dry run lists only old accounts with their books and Homeland, and changes nothing', async () => {
  const h = await harness();
  try {
    h.game.homelands.ensure(L1);
    h.store.db.prepare('INSERT INTO chips (account, bought, won) VALUES (?, 7, 3)').run(L1);
    const r = await h.purge(ADM, { dryRun: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.accounts.map((a: any) => a.account), [L1, L2], 'not the current account, not the admin');
    assert.equal(r.json.checked, 3); assert.equal(r.json.unknown, 0); assert.equal(r.json.settling, false);
    const a = r.json.accounts[0];
    assert.equal(a.nameTag, 'Lama#' + h.store.tagOf(L1));
    assert.equal(a.coin, 100); assert.equal(a.items.bread, 3);
    assert.deepEqual(a.chips, { bought: 7, won: 3 });
    assert.equal(a.homeland.th, 1); assert.ok(a.lastSeen > 0);
    assert.equal(r.json.accounts[1].homeland.buildings, 0);
    assert.equal(h.store.isPlayer(L1), true); assert.equal(h.store.isPlayer(L2), true);
    assert.equal((await h.purge(ADM, { dryRun: 'yes' })).status, 400);
  } finally { h.close(); }
});

test('a real run deletes exactly the confirmed accounts and keeps the ledger', async () => {
  const h = await harness();
  const logs: string[] = []; const log = console.log; console.log = (s: unknown) => { logs.push(String(s)); };
  try {
    h.game.homelands.ensure(L1); h.game.homelands.ensure(L2);
    h.store.db.prepare('INSERT INTO chips (account, bought, won) VALUES (?, 7, 3)').run(L1);
    const ledgerBefore = h.game.gs.db.prepare('SELECT COUNT(*) AS n FROM ledger WHERE account = ?').get(L1) as { n: number };
    assert.ok(ledgerBefore.n > 0, 'the starter kit is in the ledger');
    const tagL1 = h.store.tagOf(L1);
    // not on the list: a current account, the admin, a stranger -> nothing is deleted
    for (const bad of [C, ADM, 'nobody.players.test']) {
      const r = await h.purge(ADM, { dryRun: false, accounts: [L1, bad] });
      assert.equal(r.status, 409, bad); assert.match(r.json.error, /Not an old NEAR Auth account/);
    }
    assert.equal((await h.purge(ADM, { dryRun: false })).status, 400);
    assert.equal((await h.purge(ADM, { dryRun: false, accounts: [] })).status, 400);
    assert.equal(h.store.isPlayer(L1), true);
    const r = await h.purge(ADM, { dryRun: false, accounts: [L1] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.purged.map((a: any) => a.account), [L1]);
    // L1 is gone from every game table; L2, C and the admin are untouched
    for (const [t, c] of [['players', 'account_id'], ['session_keys', 'account_id'], ['active_keys', 'account_id'], ['names', 'account'], ['homelands', 'account'], ['chips', 'account'], ['player_state', 'account'], ['tool_state', 'account']] as const) {
      assert.equal(h.count(t, c, L1), 0, t + ' of the purged account');
    }
    assert.equal(h.store.nameOf(L1), null); assert.equal(h.store.isPlayer(L1), false);
    for (const a of [L2, C, ADM]) { assert.equal(h.store.isPlayer(a), true); assert.equal(h.count('names', 'account', a), 1); }
    assert.equal(h.count('homelands', 'account', L2), 1);
    assert.equal(h.count('ledger', 'account', L1), ledgerBefore.n, 'ledger rows stay: unsettled ones still settle, settled ones are history');
    assert.equal(h.store.isRetired(L1), true); assert.equal(h.store.isRetired(L2), false);
    assert.ok(logs.some((l) => l.includes(`purge-legacy by ${ADM}: ${L1} Lama#${tagL1}`)), 'every purge is logged');
    // a second run no longer finds it; the next dry run lists only L2
    assert.equal((await h.purge(ADM, { dryRun: false, accounts: [L1] })).status, 409);
    assert.deepEqual((await h.purge(ADM, { dryRun: true })).json.accounts.map((a: any) => a.account), [L2]);
    // its old session is answered with a clear message, not a bare unknown key
    const k = await h.call(L1, '/api/presence', {});
    assert.equal(k.status, 409); assert.equal(k.json.code, 'legacy_account'); assert.match(k.json.error, /make a new account/i);
  } finally { console.log = log; h.close(); }
});

test('a purge is refused while a settlement runs or waits for a retry', async () => {
  const h = await harness();
  try {
    h.game.settlement.busy = true;
    const dry = await h.purge(ADM, { dryRun: true });
    assert.equal(dry.json.settling, true);
    const r = await h.purge(ADM, { dryRun: false, accounts: [L1] });
    assert.equal(r.status, 409); assert.match(r.json.error, /Settlement is running/);
    h.game.settlement.busy = false;
    h.game.settlement.retry.set(1, { until: Date.now() + 60_000, delay: 30_000 });
    assert.equal((await h.purge(ADM, { dryRun: false, accounts: [L1] })).status, 409);
    h.game.settlement.retry.clear();
    assert.equal(h.store.isPlayer(L1), true, 'nothing was deleted');
    assert.equal((await h.purge(ADM, { dryRun: false, accounts: [L1] })).status, 200);
  } finally { h.close(); }
});

test('a purge cancels open trades and leaves the party; the other side is not harmed', async () => {
  const h = await harness();
  try {
    const sp = h.game.map!.layout.spawn;
    for (const a of [L1, C]) { h.game.positions!.reset(a); h.game.reportPosition(a, sp, 'public'); }
    h.game.trade.open(L1, { to: C });
    h.game.party.invite(C, 'Lama#' + h.store.tagOf(L1));
    h.game.party.accept(L1, 'Baru#' + h.store.tagOf(C));
    assert.ok(h.game.party.idOf(C) !== null);
    assert.equal((await h.purge(ADM, { dryRun: false, accounts: [L1] })).status, 200);
    assert.equal(h.game.trade.session(C)?.status, 'cancelled');
    assert.equal(h.game.party.idOf(C), null, 'a party of one is dissolved');
  } finally { h.close(); }
});

test('login: an old NEAR Auth account is answered with "make a new account", also after its purge', async () => {
  const h = await harness();
  try {
    // an old player whose account id is the one its login derives
    const sub = 'google-oauth2|777', acct = playerAccountId(sub, 'players.test');
    h.store.addPlayer(acct, sub, rnd()); h.store.addSessionKey(rnd(), acct); h.store.setName(acct, 'Kuno');
    const deps = { cfg: h.cfg, chain: h.chain, store: h.store, verify: async (t: string) => ({ sub: t, iat: Math.floor(Date.now() / 1000) }) };
    await assert.rejects(register(deps, { idToken: sub, sessionPublicKey: rnd() }), (e: any) => e.status === 409 && e.code === 'legacy_account' && /make a new account/i.test(e.message));
    assert.equal((await h.purge(ADM, { dryRun: false, accounts: [acct] })).status, 200);
    // the same login again: its account id is on the retired list
    await assert.rejects(register(deps, { idToken: sub, sessionPublicKey: rnd() }), (e: any) => e.status === 409 && e.code === 'legacy_account');
    // a current account still signs in
    const ok = await register(deps, { idToken: 'sub-new', sessionPublicKey: rnd() });
    assert.equal(ok.created, true);
  } finally { h.close(); }
});

test('login: an admin whose account was made with the old NEAR Auth still signs in (admins are never locked out)', async () => {
  const h = await harness();
  try {
    const sub = 'google-oauth2|admin-old', acct = playerAccountId(sub, 'players.test');
    h.store.addPlayer(acct, sub, rnd()); h.store.addSessionKey(rnd(), acct); h.store.setName(acct, 'Bos');
    const cfg = { ...h.cfg, adminAccounts: [...h.cfg.adminAccounts, acct] };
    const deps = { cfg, chain: h.chain, store: h.store, verify: async (t: string) => ({ sub: t, iat: Math.floor(Date.now() / 1000) }) };
    const r = await register(deps, { idToken: sub, sessionPublicKey: rnd() });
    assert.equal(r.accountId ?? (r as any).account_id ?? acct, acct);
  } finally { h.close(); }
});
