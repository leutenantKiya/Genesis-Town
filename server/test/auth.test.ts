import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from 'jose';
import * as near from 'near-api-js';
import { auth0Verifier, googleVerifier, register, playerAccountId } from '../src/auth.ts';
import { setup } from './helpers.ts';

async function issuer(cfgDomain: string, clientId: string, defaultIss = `https://${cfgDomain}/`) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const sign = (sub: string, o: { iss?: string; aud?: string } = {}) =>
    new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setSubject(sub)
      .setIssuer(o.iss ?? defaultIss).setAudience(o.aud ?? clientId)
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
  // Same login, new device: no key is added here; the answer says to run the new-device flow with the owner key.
  const other = near.KeyPair.fromRandom('ed25519').getPublicKey().toString();
  const nd = await register({ ...s, verify }, { idToken: await iss.sign('google-oauth2|42'), sessionPublicKey: other });
  assert.equal(nd.needsKey, true);
  assert.equal(nd.ownerPublicKey, await s.chain.derivedOwnerKey('google-oauth2|42'));
  assert.equal(s.store.sessionKeyOwner(other), undefined);
  // A different login in the same browser must not reuse the first account's session key.
  await assert.rejects(register({ ...s, verify }, { idToken: await iss.sign('google-oauth2|43'), sessionPublicKey: session }), /already belongs to another account/);
  assert.equal(s.store.playerBySub('google-oauth2|43'), undefined, 'no account created');
});

test('register: an account already on chain but missing from a fresh database is adopted, not created again', async () => {
  const s = setup();
  const iss = await issuer(s.cfg.fastAuth.domain, s.cfg.fastAuth.clientId);
  const verify = auth0Verifier(s.cfg, iss.jwks);
  const session = near.KeyPair.fromRandom('ed25519').getPublicKey().toString();
  const first = await register({ ...s, verify }, { idToken: await iss.sign('google-oauth2|77'), sessionPublicKey: session });
  assert.equal(first.created, true);
  // the server redeploys with an empty database; the chain (and the account on it) stays
  const fresh = { ...setup(), chain: s.chain };
  // same browser: its session key is on the account already, so the player is straight back in
  const back = await register({ ...fresh, verify }, { idToken: await iss.sign('google-oauth2|77'), sessionPublicKey: session });
  assert.deepEqual([back.accountId, back.created, back.needsKey], [first.accountId, false, undefined]);
  assert.equal(fresh.store.sessionKeyOwner(session), first.accountId);
  // another browser on yet another fresh database: the new-device flow adds its key with the owner key
  const other = near.KeyPair.fromRandom('ed25519').getPublicKey().toString();
  const fresh2 = { ...setup(), chain: s.chain };
  const nd = await register({ ...fresh2, verify }, { idToken: await iss.sign('google-oauth2|77'), sessionPublicKey: other });
  assert.deepEqual([nd.accountId, nd.created, nd.needsKey, nd.ownerPublicKey], [first.accountId, false, true, await s.chain.derivedOwnerKey('google-oauth2|77')]);
  assert.equal(fresh2.store.playerBySub('google-oauth2|77')?.account_id, first.accountId);
  assert.equal(fresh2.store.sessionKeyOwner(other), undefined);
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

test('Google login: checks Google\'s token and lands on the same account NEAR Auth gives that Google user', async () => {
  const s = setup();
  const near1 = await issuer(s.cfg.fastAuth.domain, s.cfg.fastAuth.clientId);
  const g = await issuer('', 'gt-google-client', 'https://accounts.google.com');
  const deps = { ...s, verify: auth0Verifier(s.cfg, near1.jwks), verifyGoogle: googleVerifier('gt-google-client', g.jwks) };
  const session = near.KeyPair.fromRandom('ed25519').getPublicKey().toString();
  const r = await register(deps, { idToken: await g.sign('103547991597142817347'), sessionPublicKey: session, provider: 'google' });
  assert.equal(r.created, true);
  assert.equal(r.accountId, playerAccountId('google-oauth2|103547991597142817347', 'players.test'));
  assert.equal(s.store.playerBySub('google-oauth2|103547991597142817347')?.owner_pk, await s.chain.derivedOwnerKey('google-oauth2|103547991597142817347'));
  // the same Google account through NEAR Auth, same browser: the same account, nothing new created
  const viaNear = await register(deps, { idToken: await near1.sign('google-oauth2|103547991597142817347'), sessionPublicKey: session });
  assert.deepEqual([viaNear.accountId, viaNear.created], [r.accountId, false]);
  // both issuer spellings Google documents are accepted
  const other = near.KeyPair.fromRandom('ed25519').getPublicKey().toString();
  const r2 = await register(deps, { idToken: await g.sign('7', { iss: 'accounts.google.com' }), sessionPublicKey: other, provider: 'google' });
  assert.equal(r2.created, true);
});

test('Google login: rejects other audiences, other issuers, a NEAR Auth token, and servers without a client id', async () => {
  const s = setup();
  const near1 = await issuer(s.cfg.fastAuth.domain, s.cfg.fastAuth.clientId);
  const g = await issuer('', 'gt-google-client', 'https://accounts.google.com');
  const deps = { ...s, verify: auth0Verifier(s.cfg, near1.jwks), verifyGoogle: googleVerifier('gt-google-client', g.jwks) };
  const session = near.KeyPair.fromRandom('ed25519').getPublicKey().toString();
  for (const idToken of [await g.sign('1', { aud: 'another-app' }), await g.sign('1', { iss: 'https://evil.example' }), await near1.sign('google-oauth2|1'), await g.sign('google-oauth2|1')]) {
    await assert.rejects(register(deps, { idToken, sessionPublicKey: session, provider: 'google' }), (e: { status: number }) => e.status === 401);
  }
  await assert.rejects(register({ ...s, verify: deps.verify }, { idToken: await g.sign('1'), sessionPublicKey: session, provider: 'google' }), (e: { status: number; message: string }) => e.status === 400 && /not set up/.test(e.message));
  await assert.rejects(register(deps, { idToken: await g.sign('1'), sessionPublicKey: session, provider: 'apple' }), (e: { status: number }) => e.status === 400);
  assert.equal(s.chain.accounts.size, 0);
});
