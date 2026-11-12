import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as near from 'near-api-js';
import { addDeviceKey, parseMpcSignature } from '../src/newdevice.ts';
import { setup, signedDelegateB64 } from './helpers.ts';
import { relay, RateLimiter } from '../src/relayer.ts';
import { requestMessage, verifyRequest, ReplayCache } from '../src/reqauth.ts';

const ACC = 'p1.players.test';
function world() {
  const s = setup();
  const owner = near.KeyPair.fromRandom('ed25519');
  s.store.addPlayer(ACC, 'google-oauth2|1', owner.getPublicKey().toString());
  s.store.addSessionKey(near.KeyPair.fromRandom('ed25519').getPublicKey().toString(), ACC); // the old device's key
  s.chain.mpcSign = (payload) => owner.sign(payload).signature; // stands in for NEAR Auth's MPC with the derived key
  const deps = { ...s, verify: async (t: string) => ({ sub: t }), currentBlockHeight: async () => 100n };
  return { s, owner, deps };
}
function request(o: { owner: near.KeyPair; sender?: string; contract?: string; signer?: near.KeyPair; newKey?: near.KeyPair; methods?: string[] }) {
  const newKey = o.newKey ?? near.KeyPair.fromRandom('ed25519');
  const da = near.buildDelegateAction({
    senderId: o.sender ?? ACC, receiverId: o.sender ?? ACC,
    actions: [near.actions.addFunctionCallAccessKey(newKey.getPublicKey(), o.contract ?? 'game.test', o.methods ?? [], 0n)],
    nonce: 5n, maxBlockHeight: 400n, publicKey: (o.signer ?? o.owner).getPublicKey(),
  });
  const hash = createHash('sha256').update(near.encodeDelegateAction(da)).digest();
  return {
    newKey,
    body: {
      idToken: 'google-oauth2|1',
      delegateAction: Buffer.from(serializeDA(da)).toString('base64'),
      // in production `signPayload` is the JWT's fatxn claim; here the delegate hash, which is what must be signed
      signatureRequest: { guardId: 'jwt#https://login.testnet.fast-auth.com/', verifyPayload: 'jwt', signPayload: Array.from(hash), algorithm: 'eddsa' },
    },
  };
}
function serializeDA(da: unknown) {
  // encodeDelegateAction adds the NEP-461 prefix; the browser sends the plain borsh DelegateAction
  return near.encodeDelegateAction(da as never).slice(4);
}

test('new device: the owner-signed AddKey is relayed and the new session key works', async () => {
  const { s, owner, deps } = world();
  const r = request({ owner });
  const out = await addDeviceKey(deps, r.body);
  assert.equal(out.accountId, ACC);
  assert.equal(s.store.sessionKeyOwner(r.newKey.getPublicKey().toString()), ACC);
  assert.ok(s.store.history(ACC).some((h) => h.kind === 'device'));
  // the same key cannot be added twice
  await assert.rejects(addDeviceKey(deps, request({ owner, newKey: r.newKey }).body), /already belongs/);
});

test('new device: a key signed in off-chain passes verifyRequest, is refused by the relayer, and relays after approval', async () => {
  const { s, owner, deps } = world();
  const kp = near.KeyPair.fromRandom('ed25519');
  const pkStr = kp.getPublicKey().toString();
  s.store.addSessionKey(pkStr, ACC, false); // what register() does for a new device
  // off-chain requests are signed with it
  const ts = String(Date.now());
  const sig = kp.sign(new TextEncoder().encode(requestMessage('GET', '/api/state', ts, ''))).signature;
  const hdr = { 'x-account-id': ACC, 'x-gt-key': pkStr, 'x-gt-ts': ts, 'x-gt-sig': Buffer.from(sig).toString('base64') };
  assert.equal(verifyRequest({ sessionKeyOwner: (k) => s.store.sessionKeyOwner(k), replay: new ReplayCache() }, hdr, 'GET', '/api/state', ''), ACC);
  // the relayer asks for approval
  s.chain.accounts.add(ACC); s.chain.accounts.add('p2.players.test'); s.chain.bal.set(ACC + '|fish', 5n);
  const rdeps = { ...s, limiter: new RateLimiter(30, 1000), currentBlockHeight: async () => 100n };
  const { b64 } = signedDelegateB64({ sender: ACC, key: kp });
  await assert.rejects(relay(rdeps, { signedDelegate: b64 }), (e: { status: number; code?: string }) => e.status === 409 && e.code === 'approve_device');
  // approving the same key (NEAR Auth) flips it on chain
  const out = await addDeviceKey(deps, request({ owner, newKey: kp }).body);
  assert.equal(out.accountId, ACC);
  assert.equal(s.store.sessionKeyOnchain(pkStr), true);
  const { b64: b2 } = signedDelegateB64({ sender: ACC, key: kp });
  assert.equal((await relay(rdeps, { signedDelegate: b2 })).status, 'mock');
  // a key of another account cannot be approved onto this one
  const stolen = near.KeyPair.fromRandom('ed25519');
  s.store.addPlayer('p2.players.test', 'google-oauth2|2', 'ed25519:o2');
  s.store.addSessionKey(stolen.getPublicKey().toString(), 'p2.players.test', false);
  await assert.rejects(addDeviceKey(deps, request({ owner, newKey: stolen }).body), /already belongs/);
});

test('new device: anything but one game-only AddKey on your own account, signed by your owner key, is refused', async () => {
  const { owner, deps, s } = world();
  await assert.rejects(addDeviceKey(deps, request({ owner, sender: 'p2.players.test' }).body), /your own account/);
  await assert.rejects(addDeviceKey(deps, request({ owner, contract: 'wrap.testnet' }).body), /only call the game contract/);
  await assert.rejects(addDeviceKey(deps, request({ owner, methods: ['send_item'] }).body), /only call the game contract/);
  const stranger = near.KeyPair.fromRandom('ed25519');
  await assert.rejects(addDeviceKey(deps, request({ owner, signer: stranger }).body), /your NEAR Auth key/);
  // the MPC signs with some other key: nothing is submitted
  s.chain.mpcSign = (p) => stranger.sign(p).signature;
  await assert.rejects(addDeviceKey(deps, request({ owner }).body), /does not match/);
  s.chain.mpcSign = null;
  await assert.rejects(addDeviceKey(deps, request({ owner }).body), /signing failed/);
});

test('MPC result parsing follows FastAuthSignature (base64 JSON with a 64-byte signature)', () => {
  const sig = new Array(64).fill(7);
  assert.deepEqual(Array.from(parseMpcSignature(Buffer.from(JSON.stringify({ scheme: 'Ed25519', signature: sig })).toString('base64'))), sig);
  assert.throws(() => parseMpcSignature(Buffer.from(JSON.stringify({ signature: [1, 2] })).toString('base64')), /unexpected/);
});

test('one live session: logging in on B supersedes A, logging in on A supersedes B (requests and relay)', async () => {
  const { s } = world();
  const hdrFor = (kp: near.KeyPair) => {
    const ts = String(Date.now() + Math.floor(Math.random() * 1000));
    const sig = kp.sign(new TextEncoder().encode(requestMessage('GET', '/api/state', ts, ''))).signature;
    return { 'x-account-id': ACC, 'x-gt-key': kp.getPublicKey().toString(), 'x-gt-ts': ts, 'x-gt-sig': Buffer.from(sig).toString('base64') };
  };
  const rd = { sessionKeyOwner: (k: string) => s.store.sessionKeyOwner(k), isSuperseded: (k: string, a: string) => s.store.isSuperseded(k, a), replay: new ReplayCache() };
  const A = near.KeyPair.fromRandom('ed25519'), B = near.KeyPair.fromRandom('ed25519');
  s.store.addSessionKey(A.getPublicKey().toString(), ACC); s.store.addSessionKey(B.getPublicKey().toString(), ACC);
  const isSup = (e: { status: number; code?: string }) => e.status === 409 && e.code === 'superseded';
  assert.equal(verifyRequest(rd, hdrFor(A), 'GET', '/api/state', ''), ACC, 'no active key yet: any key of the account works');
  s.store.setActiveKey(ACC, A.getPublicKey().toString());
  assert.equal(verifyRequest(rd, hdrFor(A), 'GET', '/api/state', ''), ACC);
  s.store.setActiveKey(ACC, B.getPublicKey().toString()); // login on B
  assert.throws(() => verifyRequest(rd, hdrFor(A), 'GET', '/api/state', ''), isSup);
  assert.equal(verifyRequest(rd, hdrFor(B), 'GET', '/api/state', ''), ACC);
  s.chain.accounts.add(ACC); s.chain.accounts.add('p2.players.test'); s.chain.bal.set(ACC + '|fish', 5n);
  const rdeps = { ...s, limiter: new RateLimiter(30, 1000), currentBlockHeight: async () => 100n };
  await assert.rejects(relay(rdeps, { signedDelegate: signedDelegateB64({ sender: ACC, key: A }).b64 }), isSup);
  assert.equal((await relay(rdeps, { signedDelegate: signedDelegateB64({ sender: ACC, key: B }).b64 })).status, 'mock');
  s.store.setActiveKey(ACC, A.getPublicKey().toString()); // login on A again
  assert.throws(() => verifyRequest(rd, hdrFor(B), 'GET', '/api/state', ''), isSup);
  assert.equal(verifyRequest(rd, hdrFor(A), 'GET', '/api/state', ''), ACC);
});
