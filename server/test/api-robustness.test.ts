// Bad HTTP input must give a 4xx with a short message, never a 500.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as near from 'near-api-js';
import { Store } from '../src/db.ts';
import { MockChain } from '../src/chain.ts';
import { Game } from '../src/game/game.ts';
import { loadEcon } from '../src/game/econ.ts';
import { createApp, healthProblems } from '../src/app.ts';
import { requestMessage } from '../src/reqauth.ts';
import { loadConfig } from '../src/config.ts';
import { relay, relayTokens, RateLimiter } from '../src/relayer.ts';
import { signedDelegateB64 } from './helpers.ts';

const TOWN = 'town.gt.test';
const P = 'p1.players.test';

async function harness(clientDir = '.') {
  const econ = loadEcon();
  const cfg = loadConfig({ CHAIN_MODE: 'mock', GAME_CONTRACT_ID: 'game.test', PLAYERS_PARENT_ACCOUNT_ID: 'players.test', TOWN_ACCOUNT_ID: TOWN, MERCHANT_PARENT_ACCOUNT_ID: 'gt.test' } as NodeJS.ProcessEnv);
  const chain = new MockChain();
  chain.contractId = cfg.gameContractId;
  const base = Object.fromEntries(Object.entries(econ.items).map(([t, i]) => [t, i.base]));
  chain.accounts.add(TOWN);
  chain.add(TOWN, 'coin', 5000n);
  for (const [id, d] of Object.entries(econ.merchants)) chain.addMerchant(`${id}.gt.test`, d.shop, { coin: d.restore.coin, ...d.restore.items }, { coin: d.startCash, ...d.startStock }, base);
  const store = new Store(':memory:');
  const game = new Game(store, chain, { merchantParent: 'gt.test', town: TOWN, now: () => 1_800_000_000_000, rng: () => 0.99, econ, chunkSize: 5, worldSeed: 20261114 });
  await game.init();
  store.addPlayer(P, 'sub-p1', 'ed25519:o');
  await chain.registerPlayer(P);
  game.onNewPlayer(P);
  const kp = near.KeyPair.fromRandom('ed25519');
  store.addSessionKey(kp.getPublicKey().toString(), P);
  const { server } = createApp({ cfg, chain, store, game, verify: async () => ({ sub: 'x' }), currentBlockHeight: async () => 0n, clientDir });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const call = async (method: string, path: string, rawBody?: string) => {
    const raw = rawBody ?? '', ts = String(Date.now());
    const sig = kp.sign(new TextEncoder().encode(requestMessage(method, path, ts, raw))).signature;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, body: raw || undefined, headers: { 'x-account-id': P, 'x-gt-key': kp.getPublicKey().toString(), 'x-gt-ts': ts, 'x-gt-sig': Buffer.from(sig).toString('base64') } });
    const text = await res.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json };
  };
  const raw = (method: string, path: string, body?: string) => fetch(`http://127.0.0.1:${port}${path}`, { method, body, headers: { 'content-type': 'application/json' } }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) as any }));
  return { cfg, chain, store, game, call, raw, port, close: () => server.close() };
}

test('JSON bodies that are not objects are 400 on every POST', async () => {
  const h = await harness();
  try {
    for (const body of ['null', '[]', '5', '"x"', 'true']) {
      // register and add-key have per-address limits (10 and 3 a minute): three bodies each is all they can take
      const paths = ['null', '[]', '5'].includes(body) ? ['/api/auth/register', '/api/auth/add-key', '/api/relay', '/api/sim'] : ['/api/relay', '/api/sim'];
      for (const path of paths) {
        const r = await h.raw('POST', path, body);
        assert.equal(r.status, 400, `${path} ${body}`);
        assert.equal(r.json.error, 'body must be a JSON object');
      }
      for (const path of ['/api/act', '/api/presence', '/api/chat', '/api/name', '/api/talk', '/api/homeland/invite']) {
        const r = await h.call('POST', path, body);
        assert.equal(r.status, 400, `${path} ${body}`);
      }
    }
  } finally { h.close(); }
});

test('relay survives call args of the wrong shape', async () => {
  const h = await harness();
  try {
    const key = near.KeyPair.fromRandom('ed25519');
    h.store.addSessionKey(key.getPublicKey().toString(), P);
    h.chain.accounts.add(P);
    const deps = { cfg: h.cfg, chain: h.chain, store: h.store, limiter: new RateLimiter(100, 1000), currentBlockHeight: async () => 100n };
    let nonce = 1n;
    for (const method of ['project_contribute', 'restore_contribute', 'send_item', 'list_item']) {
      for (const args of ['x', [null], null, { contribution: 'x' }, { contribution: [null] }, { contribution: 5 }, { contribution: [1, 'a'] }, 7] as unknown[]) {
        const { b64 } = signedDelegateB64({ sender: P, key, method, args: args as never, nonce: nonce++ });
        try { await relay({ ...deps, itemName: (t) => String(t) }, { signedDelegate: b64 }); } catch (e) {
          assert.ok((e as { status?: number }).status && (e as { status: number }).status < 500, `${method} ${JSON.stringify(args)}: ${(e as Error).message}`);
        }
      }
    }
    for (const a of [null, 'x', [null], { contribution: 'x' }, { contribution: [null] }]) assert.doesNotThrow(() => relayTokens('project_contribute', a as never));
  } finally { h.close(); }
});

test('ids that exist on Object.prototype are unknown, not a crash', async () => {
  const h = await harness();
  try {
    for (const bad of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      for (const q of [`merchant=${bad}&token=fish`, `merchant=sari&token=${bad}`]) {
        const r = await h.raw('GET', `/api/quote?${q}&qty=1`);
        assert.ok(r.status >= 400 && r.status < 500, `quote ${q} -> ${r.status}`);
      }
      const t = await h.call('POST', '/api/talk', JSON.stringify({ merchant: bad, text: 'hai' }));
      assert.equal(t.status, 404, `talk ${bad}`);
      const pos = { x: 1, y: 1 };
      for (const body of [
        { action: 'sell', merchant: bad, token: 'fish', qty: 1, pos }, { action: 'buy', merchant: 'sari', token: bad, qty: 1, pos },
        { action: 'sell', merchant: 'sari', token: bad, qty: 1, pos }, { action: 'ship', token: bad, qty: 1, pos },
        { action: 'eat', token: bad, pos }, { action: 'craft', recipe: bad, pos },
      ]) {
        const r = await h.call('POST', '/api/act', JSON.stringify(body));
        assert.ok(r.status >= 400 && r.status < 500, `act ${JSON.stringify(body)} -> ${r.status}`);
      }
      const hist = await h.call('GET', `/api/history?token=${bad}`);
      assert.equal(hist.status, 400);
    }
  } finally { h.close(); }
});

test('a malformed percent-escape in a static path is 400', async () => {
  const h = await harness();
  try {
    const r = await h.raw('GET', '/%E0%A4%A');
    assert.equal(r.status, 400);
  } finally { h.close(); }
});

test('quote and trade quantities must be positive integers within the limit', async () => {
  const h = await harness();
  try {
    const max = h.game.econ.pricing.maxQuoteQty;
    for (const qty of ['Infinity', '1e308', 'NaN', '', 'null', '0', '-1', '1.5', String(max + 1), 'abc', ' 1 ']) {
      const r = await h.raw('GET', `/api/quote?merchant=sari&token=fish&qty=${encodeURIComponent(qty)}`);
      assert.equal(r.status, 400, `qty=${JSON.stringify(qty)}`);
    }
    assert.equal((await h.raw('GET', '/api/quote?merchant=sari&token=fish&qty=2')).status, 200);
    assert.equal((await h.raw('GET', '/api/quote?merchant=sari&token=fish')).status, 200, 'qty defaults to 1');
    const spawn = h.game.map!.layout.spawn;
    for (const qty of [null, true, [1], ' 1 ', '1', 1.5, 0, -1, {}]) {
      for (const action of ['sell', 'buy', 'ship']) {
        const r = await h.call('POST', '/api/act', JSON.stringify({ action, merchant: 'sari', token: 'fish', qty, pos: spawn }));
        assert.equal(r.status, 400, `${action} qty=${JSON.stringify(qty)} -> ${r.status} ${JSON.stringify(r.json)}`);
      }
    }
  } finally { h.close(); }
});

test('invite accounts must be an array', async () => {
  const h = await harness();
  try {
    for (const accounts of ['p2.players.test', null, 5, {}, undefined]) {
      const r = await h.call('POST', '/api/homeland/invite', JSON.stringify({ accounts }));
      assert.equal(r.status, 400, JSON.stringify(accounts));
    }
  } finally { h.close(); }
});

test('POST /api/sim is rate limited per address', async () => {
  const h = await harness();
  try {
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) seen.push((await h.raw('POST', '/api/sim', JSON.stringify({ days: 1, players: 1, seed: 1 }))).status);
    assert.deepEqual(seen.slice(0, 6), [200, 200, 200, 200, 200, 200]);
    assert.deepEqual(seen.slice(6), [429, 429]);
  } finally { h.close(); }
});

test('sim input that is not a number falls back to the defaults instead of crashing', async () => {
  const h = await harness();
  try {
    const r = await h.raw('POST', '/api/sim', JSON.stringify({ days: 'x', players: null, seed: 'y' }));
    assert.equal(r.status, 200);
  } finally { h.close(); }
});

test('chat only in the world the server has the player in', async () => {
  const h = await harness();
  try {
    h.store.setName(P, 'Ayu');
    const ok = await h.call('POST', '/api/chat', JSON.stringify({ world: 'public', text: 'halo' }));
    assert.equal(ok.status, 200, 'on the public island, public chat works');
    const spawn = h.game.map!.layout.spawn;
    h.game.positions!.setWorld(P, 'IS-1-1', spawn, Date.now());
    const r = await h.call('POST', '/api/chat', JSON.stringify({ world: 'public', text: 'dari pulau' }));
    assert.equal(r.status, 409);
  } finally { h.close(); }
});

test('a client on another origin listed in CORS_ORIGINS may call the API, others get no CORS headers', async () => {
  const h = await harness();
  h.cfg.corsOrigins = ['https://genesis.example'];
  try {
    const base = `http://127.0.0.1:${h.port}`;
    const pre = await fetch(`${base}/api/act`, { method: 'OPTIONS', headers: { origin: 'https://genesis.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-gt-sig' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'https://genesis.example');
    assert.match(pre.headers.get('access-control-allow-headers') ?? '', /x-gt-sig/);
    const ok = await fetch(`${base}/api/config`, { headers: { origin: 'https://genesis.example' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://genesis.example');
    const other = await fetch(`${base}/api/config`, { headers: { origin: 'https://evil.example' } });
    assert.equal(other.headers.get('access-control-allow-origin'), null);
    const otherPre = await fetch(`${base}/api/act`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    assert.equal(otherPre.headers.get('access-control-allow-origin'), null);
  } finally { h.close(); }
});

test('static files never leak from a sibling folder whose name starts with the client folder', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const http = await import('node:http');
  const root = mkdtempSync(join(tmpdir(), 'gt-static-'));
  mkdirSync(join(root, 'client')); mkdirSync(join(root, 'client-secret'));
  writeFileSync(join(root, 'client', 'index.html'), 'ok');
  writeFileSync(join(root, 'client-secret', 'x.txt'), 'secret');
  const h = await harness(join(root, 'client'));
  // %2f survives URL parsing and decodes to ../ afterwards; raw http.get so nothing normalises it first
  const get = (path: string) => new Promise<{ status: number; body: string }>((res, rej) => {
    http.get({ host: '127.0.0.1', port: h.port, path }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ status: r.statusCode ?? 0, body: b })); }).on('error', rej);
  });
  try {
    assert.equal((await get('/')).body, 'ok');
    const leak = await get('/..%2fclient-secret/x.txt');
    assert.equal(leak.status, 403);
    assert.notEqual(leak.body, 'secret');
  } finally { h.close(); rmSync(root, { recursive: true, force: true }); }
});

test('health lists settlement lag, low gas and a failing db copy, and stays 200 unless strict', async () => {
  assert.deepEqual(healthProblems({ settleDay: 10, settledThrough: 9 }), []);
  assert.deepEqual(healthProblems({ settleDay: 10, settledThrough: 8 }), [], 'one day of slack for retries');
  assert.match(healthProblems({ settleDay: 10, settledThrough: 7 })[0], /2 days behind/);
  assert.deepEqual(healthProblems({ settleDay: 10, settledThrough: 9, fundsLow: ['relayer.test'] }), ['relayer.test is low on NEAR for gas']);
  assert.match(healthProblems({ settleDay: 10, settledThrough: 9, snapshotError: 'timeout' })[0], /database copy failing: timeout/);
  const h = await harness();
  try {
    const t = h.game.clock.time();
    h.game.gs.setMeta('settle.through', String(t.settleDay - 10));
    const loose = await h.raw('GET', '/api/health');
    assert.equal(loose.status, 200);
    assert.equal(loose.json.ok, false);
    assert.match(loose.json.problems[0], /days behind/);
    assert.equal((await h.raw('GET', '/api/health?strict=1')).status, 503);
    h.game.gs.setMeta('settle.through', String(t.settleDay - 1));
    const good = await h.raw('GET', '/api/health?strict=1');
    assert.equal(good.status, 200);
    assert.equal(good.json.ok, true);
  } finally { h.close(); }
});
