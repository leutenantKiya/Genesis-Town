import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as near from 'near-api-js';
import { addDeviceKey, parseMpcSignature } from '../src/newdevice.ts';
import { setup } from './helpers.ts';

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
