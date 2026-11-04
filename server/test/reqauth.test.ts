import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as near from 'near-api-js';
import { requestMessage, verifyRequest, ReplayCache, SKEW_MS } from '../src/reqauth.ts';
import { createApp } from '../src/app.ts';
import { Game } from '../src/game/game.ts';
import { setup } from './helpers.ts';

const ACC = 'p1.players.test';
function sign(kp: near.KeyPair, method: string, path: string, body: string, ts = String(Date.now()), account = ACC) {
  const sig = kp.sign(new TextEncoder().encode(requestMessage(method, path, ts, body))).signature;
  return { 'x-account-id': account, 'x-gt-key': kp.getPublicKey().toString(), 'x-gt-ts': ts, 'x-gt-sig': Buffer.from(sig).toString('base64') };
}

test('signed requests: accepted once; wrong key, account, body, path, time or a replay are refused', () => {
  const kp = near.KeyPair.fromRandom('ed25519'), other = near.KeyPair.fromRandom('ed25519');
  const owners = new Map([[kp.getPublicKey().toString(), ACC], [other.getPublicKey().toString(), 'p2.players.test']]);
  const d = { sessionKeyOwner: (k: string) => owners.get(k), replay: new ReplayCache() };
  const body = '{"action":"eat"}';
  const h = sign(kp, 'POST', '/api/act', body);
  assert.equal(verifyRequest(d, h, 'POST', '/api/act', body), ACC);
  assert.throws(() => verifyRequest(d, h, 'POST', '/api/act', body), /already used/);
  assert.throws(() => verifyRequest(d, sign(kp, 'POST', '/api/act', body), 'POST', '/api/act', '{"action":"ship"}'), /bad request signature/);
  assert.throws(() => verifyRequest(d, sign(kp, 'GET', '/api/state', ''), 'GET', '/api/history', ''), /bad request signature/);
  assert.throws(() => verifyRequest(d, sign(other, 'GET', '/api/state', ''), 'GET', '/api/state', ''), /unknown session key/, 'p2 key cannot act for p1');
  assert.throws(() => verifyRequest(d, sign(kp, 'GET', '/api/state', '', String(Date.now() - SKEW_MS - 1000)), 'GET', '/api/state', ''), /expired/);
  assert.throws(() => verifyRequest(d, { 'x-account-id': ACC }, 'GET', '/api/state', ''), /not signed in/);
  assert.equal(createHash('sha256').update('').digest('hex').length, 64);
});

test('the HTTP server refuses the old account header and accepts signed requests', async () => {
  const s = setup();
  const kp = near.KeyPair.fromRandom('ed25519');
  s.store.addPlayer(ACC, 'sub', 'ed25519:o');
  s.store.addSessionKey(kp.getPublicKey().toString(), ACC);
  const game = new Game(s.store, s.chain, { merchantParent: 'gt.test', town: 'town.gt.test' });
  await game.init();
  const { server } = createApp({ ...s, game, verify: async () => ({ sub: 'x' }), currentBlockHeight: async () => 0n, clientDir: '.' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const old = await fetch(base + '/api/state', { headers: { 'x-account-id': ACC } });
    assert.equal(old.status, 401, 'header alone is not enough any more');
    const ok = await fetch(base + '/api/state', { headers: sign(kp, 'GET', '/api/state', '') });
    assert.equal(ok.status, 200);
    const body = JSON.stringify({ action: 'eat', token: 'bread' });
    const act = await fetch(base + '/api/act', { method: 'POST', headers: { 'content-type': 'application/json', ...sign(kp, 'POST', '/api/act', body) }, body });
    assert.notEqual(act.status, 401);
  } finally {
    server.close();
  }
});

test('dev tools answer only a direct request from this machine, never one through a proxy', async () => {
  const s = setup();
  s.cfg.devTools = true;
  const game = new Game(s.store, s.chain, { merchantParent: 'gt.test', town: 'town.gt.test' });
  await game.init();
  const { server } = createApp({ ...s, game, verify: async () => ({ sub: 'x' }), currentBlockHeight: async () => 0n, clientDir: '.' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    assert.equal((await (await fetch(base + '/api/config')).json()).devTools, true);
    const proxied = { 'x-forwarded-for': '203.0.113.7' };
    assert.equal((await (await fetch(base + '/api/config', { headers: proxied })).json()).devTools, false);
    assert.equal((await fetch(base + '/api/dev/night', { method: 'POST', headers: proxied })).status, 403);
    assert.equal((await fetch(base + '/api/dev/settle', { method: 'POST', headers: proxied })).status, 403);
    assert.equal((await fetch(base + '/api/dev/night', { method: 'POST' })).status, 200);
  } finally {
    server.close();
  }
});
