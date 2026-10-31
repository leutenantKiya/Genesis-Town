import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from 'jose';
import * as near from 'near-api-js';
import { auth0Verifier, register, playerAccountId } from '../src/auth.ts';
import { Minter } from '../src/minter.ts';
import { setup } from './helpers.ts';

async function issuer(cfgDomain: string, clientId: string) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const sign = (sub: string, o: { iss?: string; aud?: string } = {}) =>
    new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setSubject(sub)
      .setIssuer(o.iss ?? `https://${cfgDomain}/`).setAudience(o.aud ?? clientId)
      .setIssuedAt().setExpirationTime('5m').sign(privateKey);
  return { jwks, sign };
}

test('register: verifies token, uses the server-derived owner key, creates account once', async () => {
  const s = setup();
  const iss = await issuer(s.cfg.fastAuth.domain, s.cfg.fastAuth.clientId);
  const verify = auth0Verifier(s.cfg, iss.jwks);
  const session = near.KeyPair.fromRandom('ed25519').getPublicKey().toString();
  const r = await register({ ...s, verify }, { idToken: await iss.sign('google-oauth2|42'), sessionPublicKey: session });
  assert.equal(r.created, true);
  assert.equal(r.accountId, playerAccountId('google-oauth2|42', 'players.test'));
  assert.match(r.accountId, /^p[0-9a-f]{16}\.players\.test$/);
  assert.equal(s.store.playerBySub('google-oauth2|42')?.owner_pk, await s.chain.derivedOwnerKey('google-oauth2|42'));
  // Same login and same device: no new account.
  const again = await register({ ...s, verify }, { idToken: await iss.sign('google-oauth2|42'), sessionPublicKey: session });
  assert.equal(again.created, false);
  // Same login, new device: refused until the M4 new-device flow.
  const other = near.KeyPair.fromRandom('ed25519').getPublicKey().toString();
  await assert.rejects(register({ ...s, verify }, { idToken: await iss.sign('google-oauth2|42'), sessionPublicKey: other }), (e: { status: number }) => e.status === 409);
});

test('register: rejects wrong issuer, wrong audience, garbage token, bad session key', async () => {
  const s = setup();
  const iss = await issuer(s.cfg.fastAuth.domain, s.cfg.fastAuth.clientId);
  const verify = auth0Verifier(s.cfg, iss.jwks);
  const session = near.KeyPair.fromRandom('ed25519').getPublicKey().toString();
  for (const idToken of [await iss.sign('x', { iss: 'https://evil.example/' }), await iss.sign('x', { aud: 'someone-else' }), 'not.a.jwt']) {
    await assert.rejects(register({ ...s, verify }, { idToken, sessionPublicKey: session }), (e: { status: number }) => e.status === 401);
  }
  await assert.rejects(register({ ...s, verify }, { idToken: await iss.sign('x'), sessionPublicKey: 'ed25519:nope' }), (e: { status: number }) => e.status === 400);
  assert.equal(s.chain.accounts.size, 0);
});

test('minter: batches gathers into one mint and settles history', async () => {
  const s = setup();
  s.store.addPlayer('p1.players.test', 'sub', 'ed25519:o');
  const m = new Minter(s);
  for (let i = 0; i < 3; i++) m.gather('p1.players.test', 'fish');
  m.gather('p1.players.test', 'wood');
  assert.equal(s.store.history('p1.players.test').filter((h) => h.status === 'pending').length, 4);
  await m.flush();
  assert.deepEqual(await s.chain.balances('p1.players.test', ['fish', 'wood']), ['3', '1']);
  const h = s.store.history('p1.players.test');
  assert.ok(h.every((x) => x.status === 'mock' && x.tx_hash === h[0].tx_hash), 'one tx for the whole batch');
});

test('minter: a failed send is retried with the same mint_id and never double-mints', async () => {
  const s = setup();
  s.store.addPlayer('p1.players.test', 'sub', 'ed25519:o');
  const m = new Minter(s);
  m.gather('p1.players.test', 'ore');
  s.chain.failNext = true;
  await m.flush();
  assert.deepEqual(await s.chain.balances('p1.players.test', ['ore']), ['0']);
  const [mintId] = s.store.openMintIds();
  assert.ok(mintId, 'batch kept for retry');
  // Simulate: the first attempt actually landed on chain but the response was lost.
  s.chain.usedMints.add(mintId);
  s.chain.bal.set('p1.players.test|ore', 1n);
  await m.flush();
  assert.deepEqual(await s.chain.balances('p1.players.test', ['ore']), ['1']);
  assert.equal(s.store.openMintIds().length, 0);
  assert.equal(s.store.history('p1.players.test')[0].status, 'mock');
});

test('minter: rejects unknown items and rate-limits', () => {
  const s = setup();
  const m = new Minter(s);
  assert.throws(() => m.gather('p1.players.test', 'gold'), (e: { status: number }) => e.status === 400);
  for (let i = 0; i < 20; i++) m.gather('p1.players.test', 'fish');
  assert.throws(() => m.gather('p1.players.test', 'fish'), (e: { status: number }) => e.status === 429);
});

test('dev login works only with the mock chain and DEV_LOGIN=1', async () => {
  const { loadConfig } = await import('../src/config.ts');
  const { withDevLogin } = await import('../src/auth.ts');
  const reject = async () => { throw new Error('real verifier'); };
  const on = loadConfig({ CHAIN_MODE: 'mock', DEV_LOGIN: '1' } as NodeJS.ProcessEnv);
  assert.deepEqual(await withDevLogin(on, reject)('dev:alice'), { sub: 'dev|alice' });
  await assert.rejects(withDevLogin(on, reject)('dev:Bad Name!'));
  const off = loadConfig({ CHAIN_MODE: 'mock' } as NodeJS.ProcessEnv);
  await assert.rejects(withDevLogin(off, reject)('dev:alice'));
  assert.equal(loadConfig({ DEV_LOGIN: '1', GAME_CONTRACT_ID: 'g', RELAYER_ACCOUNT_ID: 'r', RELAYER_PRIVATE_KEYS: 'k', MINTER_ACCOUNT_ID: 'm', MINTER_PRIVATE_KEY: 'k', PLAYERS_PARENT_ACCOUNT_ID: 'p', PLAYERS_PARENT_PRIVATE_KEY: 'k' } as NodeJS.ProcessEnv).devLogin, false);
});
