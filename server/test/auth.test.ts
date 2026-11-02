import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from 'jose';
import * as near from 'near-api-js';
import { auth0Verifier, register, playerAccountId } from '../src/auth.ts';
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
  // A different login in the same browser must not reuse the first account's session key.
  await assert.rejects(register({ ...s, verify }, { idToken: await iss.sign('google-oauth2|43'), sessionPublicKey: session }), /already belongs to another account/);
  assert.equal(s.store.playerBySub('google-oauth2|43'), undefined, 'no account created');
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

test('dev login works only with the mock chain and DEV_LOGIN=1', async () => {
  const { loadConfig } = await import('../src/config.ts');
  const { withDevLogin } = await import('../src/auth.ts');
  const reject = async () => { throw new Error('real verifier'); };
  const on = loadConfig({ CHAIN_MODE: 'mock', DEV_LOGIN: '1' } as NodeJS.ProcessEnv);
  assert.deepEqual(await withDevLogin(on, reject)('dev:alice'), { sub: 'dev|alice' });
  await assert.rejects(withDevLogin(on, reject)('dev:Bad Name!'));
  const off = loadConfig({ CHAIN_MODE: 'mock' } as NodeJS.ProcessEnv);
  await assert.rejects(withDevLogin(off, reject)('dev:alice'));
  assert.equal(loadConfig({ DEV_LOGIN: '1', GAME_CONTRACT_ID: 'g', RELAYER_ACCOUNT_ID: 'r', RELAYER_PRIVATE_KEYS: 'k', SETTLER_ACCOUNT_ID: 'm', SETTLER_PRIVATE_KEY: 'k', TOWN_ACCOUNT_ID: 't', MERCHANT_PARENT_ACCOUNT_ID: 'gt', PLAYERS_PARENT_ACCOUNT_ID: 'p', PLAYERS_PARENT_PRIVATE_KEY: 'k' } as NodeJS.ProcessEnv).devLogin, false);
});
