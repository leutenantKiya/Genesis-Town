// Moving to another device: one-time codes that the server forgets after one use or ten minutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as near from 'near-api-js';
import { Store } from '../src/db.ts';
import { MockChain } from '../src/chain.ts';
import { Game } from '../src/game/game.ts';
import { loadEcon } from '../src/game/econ.ts';
import { createApp } from '../src/app.ts';
import { requestMessage } from '../src/reqauth.ts';
import { loadConfig } from '../src/config.ts';
import { TransferStore, TRANSFER_TTL_MS, TRANSFER_MAX_PER_ACCOUNT } from '../src/transfer.ts';

const TOWN = 'town.gt.test';
const P = 'p1.players.test';
const CT = 'AAAA_bbbb-CCCC', IV = 'dddd_EEEE';

async function harness() {
  const econ = loadEcon();
  const cfg = loadConfig({ CHAIN_MODE: 'mock', GAME_CONTRACT_ID: 'game.test', PLAYERS_PARENT_ACCOUNT_ID: 'players.test', TOWN_ACCOUNT_ID: TOWN, MERCHANT_PARENT_ACCOUNT_ID: 'gt.test' } as NodeJS.ProcessEnv);
  const chain = new MockChain();
  chain.contractId = cfg.gameContractId;
  chain.accounts.add(TOWN);
  const store = new Store(':memory:');
  const game = new Game(store, chain, { merchantParent: 'gt.test', town: TOWN, now: () => 1_800_000_000_000, rng: () => 0.99, econ, chunkSize: 5, worldSeed: 20261114 });
  await game.init();
  store.addPlayer(P, 'sub-p1', 'ed25519:o');
  await chain.registerPlayer(P);
  game.onNewPlayer(P);
  const kp = near.KeyPair.fromRandom('ed25519');
  store.addSessionKey(kp.getPublicKey().toString(), P);
  let clock = 1_000_000;
  const transfers = new TransferStore(() => clock);
  const { server } = createApp({ cfg, chain, store, game, verify: async () => ({ sub: 'x' }), currentBlockHeight: async () => 0n, clientDir: '.', transfers });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const signed = async (method: string, path: string, raw: string) => {
    const ts = String(Date.now());
    const sig = kp.sign(new TextEncoder().encode(requestMessage(method, path, ts, raw))).signature;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, body: raw, headers: { 'x-account-id': P, 'x-gt-key': kp.getPublicKey().toString(), 'x-gt-ts': ts, 'x-gt-sig': Buffer.from(sig).toString('base64') } });
    return { status: res.status, json: await res.json().catch(() => null) as any };
  };
  const plain = async (path: string, body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    return { status: res.status, json: await res.json().catch(() => null) as any };
  };
  // a second key that signed in on a new device: allowed off-chain (onchain = 0), not yet approved with NEAR Auth
  const kp2 = near.KeyPair.fromRandom('ed25519');
  store.addSessionKey(kp2.getPublicKey().toString(), P, false);
  const signedOff = async (method: string, path: string, raw: string) => {
    const ts = String(Date.now());
    const sig = kp2.sign(new TextEncoder().encode(requestMessage(method, path, ts, raw))).signature;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, body: raw, headers: { 'x-account-id': P, 'x-gt-key': kp2.getPublicKey().toString(), 'x-gt-ts': ts, 'x-gt-sig': Buffer.from(sig).toString('base64') } });
    return { status: res.status, json: await res.json().catch(() => null) as any };
  };
  const approve = () => store.addSessionKey(kp2.getPublicKey().toString(), P);
  return { signed, signedOff, approve, plain, advance: (ms: number) => { clock += ms; }, transfers, close: () => server.close() };
}

test('a signed create gives an id; redeeming returns the ciphertext once and then forgets it', async () => {
  const h = await harness();
  try {
    const c = await h.signed('POST', '/api/transfer', JSON.stringify({ ct: CT, iv: IV }));
    assert.equal(c.status, 200);
    assert.match(c.json.id, /^[A-Za-z0-9_-]{16}$/);
    const r1 = await h.plain('/api/transfer/redeem', { id: c.json.id });
    assert.equal(r1.status, 200);
    assert.deepEqual(r1.json, { account: P, ct: CT, iv: IV });
    const r2 = await h.plain('/api/transfer/redeem', { id: c.json.id });
    assert.equal(r2.status, 404);
    assert.match(r2.json.error, /expired or was already used/);
  } finally { h.close(); }
});

test('a code older than ten minutes is gone, and is not kept in memory either', async () => {
  const h = await harness();
  try {
    const c = await h.signed('POST', '/api/transfer', JSON.stringify({ ct: CT, iv: IV }));
    h.advance(TRANSFER_TTL_MS - 1000);
    assert.equal(h.transfers.entries.size, 1);
    h.advance(2000);
    const r = await h.plain('/api/transfer/redeem', { id: c.json.id });
    assert.equal(r.status, 404);
    assert.equal(h.transfers.entries.size, 0);
  } finally { h.close(); }
});

test('an unsigned or wrongly signed create is refused, and unknown or malformed ids are 404', async () => {
  const h = await harness();
  try {
    assert.equal((await h.plain('/api/transfer', { ct: CT, iv: IV })).status, 401);
    assert.equal(h.transfers.entries.size, 0);
    assert.equal((await h.plain('/api/transfer/redeem', { id: 'nope' })).status, 404);
    assert.equal((await h.plain('/api/transfer/redeem', { id: 5 })).status, 404);
    assert.equal((await h.plain('/api/transfer/redeem', {})).status, 404);
    assert.equal((await h.signed('POST', '/api/transfer', JSON.stringify({ ct: 'not base64!', iv: IV }))).status, 400);
    assert.equal((await h.signed('POST', '/api/transfer', JSON.stringify({ ct: CT }))).status, 400);
  } finally { h.close(); }
});

test('an account can keep at most three live codes; a used or expired one frees a place', async () => {
  const h = await harness();
  try {
    const ids: string[] = [];
    for (let i = 0; i < TRANSFER_MAX_PER_ACCOUNT; i++) ids.push((await h.signed('POST', '/api/transfer', JSON.stringify({ ct: CT, iv: IV }))).json.id);
    assert.equal(new Set(ids).size, TRANSFER_MAX_PER_ACCOUNT);
    const over = await h.signed('POST', '/api/transfer', JSON.stringify({ ct: CT, iv: IV }));
    assert.equal(over.status, 429);
    await h.plain('/api/transfer/redeem', { id: ids[0] });
    assert.equal((await h.signed('POST', '/api/transfer', JSON.stringify({ ct: CT, iv: IV }))).status, 200);
    h.advance(TRANSFER_TTL_MS + 1);
    assert.equal((await h.signed('POST', '/api/transfer', JSON.stringify({ ct: CT, iv: IV }))).status, 200);
  } finally { h.close(); }
});

test('a device not yet approved with NEAR Auth is refused the transfer code and trading, but can still gather; approval opens trading', async () => {
  const h = await harness();
  try {
    const gate = (r: { status: number; json: any }) => assert.deepEqual([r.status, r.json.code], [409, 'approve_device']);
    gate(await h.signedOff('POST', '/api/transfer', JSON.stringify({ ct: CT, iv: IV })));
    for (const p of ['open', 'join', 'set', 'ready', 'offer', 'accept']) gate(await h.signedOff('POST', '/api/trade/' + p, JSON.stringify({ world: 'public' })));
    // not gated: everything else an off-chain key does (the gate answers before any game rule, so these reach the game)
    const act = await h.signedOff('POST', '/api/act', JSON.stringify({ action: 'gather', tile: 'x', pos: { x: 0, y: 0 } }));
    assert.notEqual(act.json?.code, 'approve_device');
    const close = await h.signedOff('POST', '/api/trade/close', JSON.stringify({ id: 'x', world: 'public' }));
    assert.notEqual(close.json?.code, 'approve_device');
    h.approve();
    assert.equal((await h.signedOff('POST', '/api/transfer', JSON.stringify({ ct: CT, iv: IV }))).status, 200);
    const open = await h.signedOff('POST', '/api/trade/open', JSON.stringify({ world: 'public' }));
    assert.notEqual(open.json?.code, 'approve_device');
  } finally { h.close(); }
});
