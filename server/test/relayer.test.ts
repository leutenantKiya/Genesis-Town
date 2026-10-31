import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as near from 'near-api-js';
import { relay, RateLimiter, decodeSignedDelegate, verifyDelegateSignature } from '../src/relayer.ts';
import { setup, signedDelegateB64 } from './helpers.ts';

function world(perMinute = 30) {
  const s = setup();
  const key = near.KeyPair.fromRandom('ed25519');
  s.store.addPlayer('p1.players.test', 'sub-1', 'ed25519:owner');
  s.store.addSessionKey(key.getPublicKey().toString(), 'p1.players.test');
  const deps = { ...s, limiter: new RateLimiter(perMinute, 1000), currentBlockHeight: async () => 100n };
  return { ...s, key, deps };
}

test('decode round-trips and the signature verifies', () => {
  const { b64, key } = signedDelegateB64({ sender: 'p1.players.test' });
  const { sd } = decodeSignedDelegate(b64);
  assert.equal(sd.delegateAction.senderId, 'p1.players.test');
  assert.ok(verifyDelegateSignature(sd));
  const other = near.KeyPair.fromRandom('ed25519');
  const forged = signedDelegateB64({ sender: 'p1.players.test', key: other });
  const fsd = decodeSignedDelegate(forged.b64).sd;
  fsd.delegateAction.publicKey = decodeSignedDelegate(b64).sd.delegateAction.publicKey; // claim key's identity
  assert.equal(verifyDelegateSignature(fsd), false);
  assert.ok(key);
});

test('relays a valid delegate once, records history, and dedupes a resend', async () => {
  const w = world();
  const { b64 } = signedDelegateB64({ sender: 'p1.players.test', key: w.key });
  const r1 = await relay(w.deps, { signedDelegate: b64 });
  assert.equal(r1.status, 'mock');
  const r2 = await relay(w.deps, { signedDelegate: b64 });
  assert.equal(r2.duplicate, true);
  assert.equal(r2.txHash, r1.txHash);
  const h = w.store.history('p1.players.test');
  assert.equal(h.length, 1);
  assert.match(h[0].summary, /Kirim 1 fish/);
});

const rejects: Array<[string, Parameters<typeof signedDelegateB64>[0] | 'unknown-key', number]> = [
  ['unregistered session key', 'unknown-key', 403],
  ['wrong receiver', { sender: 'p1.players.test', receiver: 'evil.test' }, 403],
  ['method not allowed', { sender: 'p1.players.test', method: 'mint_gathered' }, 403],
  ['non-zero deposit', { sender: 'p1.players.test', deposit: 1n }, 403],
  ['gas over cap', { sender: 'p1.players.test', gasTera: '300' }, 403],
  ['two actions', { sender: 'p1.players.test', extraAction: true }, 403],
  ['expired', { sender: 'p1.players.test', maxBlockHeight: 99n }, 400],
  ['expiry too far ahead', { sender: 'p1.players.test', maxBlockHeight: 100000n }, 400],
  ['sender is not the key owner', { sender: 'p9.players.test' }, 403],
];
for (const [name, opts, status] of rejects) {
  test(`rejects: ${name}`, async () => {
    const w = world();
    const o = opts === 'unknown-key' ? { sender: 'p1.players.test' } : { ...opts, key: w.key };
    const { b64 } = signedDelegateB64(o);
    await assert.rejects(relay(w.deps, { signedDelegate: b64 }), (e: { status: number }) => e.status === status);
    assert.equal(w.store.history('p1.players.test').length, 0);
  });
}

test('rejects garbage and trailing bytes', async () => {
  const w = world();
  await assert.rejects(relay(w.deps, { signedDelegate: 'aGVsbG8=' }), (e: { status: number }) => e.status === 400);
  const { b64 } = signedDelegateB64({ sender: 'p1.players.test', key: w.key });
  const padded = Buffer.concat([Buffer.from(b64, 'base64'), Buffer.from([0])]).toString('base64');
  await assert.rejects(relay(w.deps, { signedDelegate: padded }), (e: { status: number }) => e.status === 400);
});

test('rate limit per account returns 429', async () => {
  const w = world(2);
  for (let i = 0; i < 2; i++) {
    const { b64 } = signedDelegateB64({ sender: 'p1.players.test', key: w.key, nonce: BigInt(i + 1) });
    await relay(w.deps, { signedDelegate: b64 });
  }
  const { b64 } = signedDelegateB64({ sender: 'p1.players.test', key: w.key, nonce: 9n });
  await assert.rejects(relay(w.deps, { signedDelegate: b64 }), (e: { status: number }) => e.status === 429);
});

test('RateLimiter: per-day cap and window expiry', () => {
  const l = new RateLimiter(100, 3);
  assert.ok(l.take('a', 0) && l.take('a', 1) && l.take('a', 2));
  assert.equal(l.take('a', 3), false);
  assert.ok(l.take('a', 86_400_000 + 10));
});
