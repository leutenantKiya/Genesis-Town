// End-to-end check on NEAR testnet using the server's own modules (no browser, no Auth0).
// What it proves: account creation with a function-call session key, minter batch mint, and a player's
// session-key-signed delegate action (send_item) relayed gas-free through our relayer policy.
// The player's NEAR Auth owner key is replaced by a random key here (labelled), because Auth0 login needs a person.
//
//   node server/scripts/e2e-testnet.ts        (reads ../.env)
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as near from 'near-api-js';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { TestnetChain } from '../src/chain.ts';
import { playerAccountId } from '../src/auth.ts';
import { Minter } from '../src/minter.ts';
import { relay, RateLimiter, blockHeightSource } from '../src/relayer.ts';

process.loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), '../../.env'));
const cfg = loadConfig();
const chain = new TestnetChain(cfg);
const store = new Store(':memory:');
const link = (h: string) => cfg.explorerTxUrl + h;
const step = (s: string) => console.log('\n== ' + s);

async function newPlayer(tag: string) {
  const sub = `e2e|${tag}-${randomUUID().slice(0, 8)}`;
  const owner = near.KeyPair.fromRandom('ed25519'); // stand-in for the NEAR Auth MPC key (see header)
  const session = near.KeyPair.fromRandom('ed25519');
  const accountId = playerAccountId(sub, cfg.playersParentId);
  const c = await chain.createPlayerAccount(accountId, owner.getPublicKey().toString(), session.getPublicKey().toString());
  if (!c.ok) throw new Error('create failed: ' + c.error);
  const r = await chain.registerPlayer(accountId);
  if (!r.ok) throw new Error('register failed: ' + r.error);
  store.addPlayer(accountId, sub, owner.getPublicKey().toString());
  store.addSessionKey(session.getPublicKey().toString(), accountId);
  console.log(`${tag}: ${accountId}\n  create ${link(c.txHash)}\n  register ${link(r.txHash)}`);
  return { accountId, session };
}

step('NEAR Auth key derivation (view call on v1.signer-prod.testnet)');
console.log('derived key for sample sub:', await chain.derivedOwnerKey('google-oauth2|e2e-sample'));

step('create two players');
const a = await newPlayer('A');
const b = await newPlayer('B');

step('gather 3 fish for A, minted in one batch by the minter');
const minter = new Minter({ cfg: { ...cfg, mintBatch: { maxItems: 10, maxWaitMs: 60_000 } }, chain, store });
for (let i = 0; i < 3; i++) minter.gather(a.accountId, 'fish');
await minter.flush();
const mintRow = store.history(a.accountId).find((h) => h.kind === 'gather');
console.log('mint:', mintRow?.status, mintRow?.tx_hash ? link(mintRow.tx_hash) : '');
console.log('A fish =', (await chain.balances(a.accountId, ['fish']))[0]);

step('A sends 1 fish to B: delegate action signed by A\'s function-call session key, relayed gas-free');
const provider = new near.JsonRpcProvider({ url: cfg.rpcUrl });
const ak = await provider.viewAccessKey({ accountId: a.accountId, publicKey: a.session.getPublicKey() });
const height = BigInt((await provider.viewBlock({ finality: 'final' })).header.height);
const da = near.buildDelegateAction({
  senderId: a.accountId,
  receiverId: cfg.gameContractId,
  actions: [near.actions.functionCall('send_item', { receiver_id: b.accountId, token_id: 'fish', amount: '1' }, near.teraToGas('30'), 0n)],
  nonce: BigInt(ak.nonce) + 1n,
  maxBlockHeight: height + 100n,
  publicKey: a.session.getPublicKey(),
});
const sig = a.session.sign(new Uint8Array(createHash('sha256').update(near.encodeDelegateAction(da)).digest()));
const b64 = Buffer.from(near.encodeSignedDelegate({ delegateAction: da, signature: new near.Signature({ keyType: 0, data: sig.signature }) } as never)).toString('base64');
const res = await relay({ cfg, chain, store, limiter: new RateLimiter(30, 2000), currentBlockHeight: blockHeightSource(cfg) }, { signedDelegate: b64 });
console.log('relay:', res.status, res.txHash ? link(res.txHash) : '', res.error ?? '');

const [fa, fb] = [(await chain.balances(a.accountId, ['fish']))[0], (await chain.balances(b.accountId, ['fish']))[0]];
console.log(`balances: A fish = ${fa}, B fish = ${fb}`);

step('policy check on testnet: the same session key may not call a non-allowlisted method');
try {
  const bad = near.buildDelegateAction({ ...da, actions: [near.actions.functionCall('mint_gathered', { batch: [], mint_id: 'x' }, near.teraToGas('30'), 0n)], nonce: BigInt(ak.nonce) + 2n });
  const s2 = a.session.sign(new Uint8Array(createHash('sha256').update(near.encodeDelegateAction(bad)).digest()));
  await relay({ cfg, chain, store, limiter: new RateLimiter(30, 2000), currentBlockHeight: blockHeightSource(cfg) }, {
    signedDelegate: Buffer.from(near.encodeSignedDelegate({ delegateAction: bad, signature: new near.Signature({ keyType: 0, data: s2.signature }) } as never)).toString('base64'),
  });
  console.log('UNEXPECTED: relayed');
  process.exitCode = 1;
} catch (e) {
  console.log('rejected as expected:', (e as Error).message);
}

const ok = mintRow?.status === 'ok' && res.status === 'ok' && fa === '2' && fb === '1';
console.log(ok ? '\nE2E PASS' : '\nE2E FAIL');
if (!ok) process.exitCode = 1;
