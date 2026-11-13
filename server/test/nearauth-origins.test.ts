import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';
import { Game } from '../src/game/game.ts';
import { createApp } from '../src/app.ts';
import { setup } from './helpers.ts';

// NEAR Auth's login only returns to page addresses it has allowed. The server lists them so the client can hide NEAR
// Auth elsewhere instead of opening a popup that fails with "Callback URL mismatch".

test('NEAR_AUTH_ORIGINS: localhost:3000 by default, a trimmed list when set', () => {
  assert.deepEqual(loadConfig({ CHAIN_MODE: 'mock' } as NodeJS.ProcessEnv).fastAuth.origins, ['http://localhost:3000']);
  const c = loadConfig({ CHAIN_MODE: 'mock', NEAR_AUTH_ORIGINS: ' https://genesistown.up.railway.app/ , http://localhost:3000,' } as NodeJS.ProcessEnv);
  assert.deepEqual(c.fastAuth.origins, ['https://genesistown.up.railway.app', 'http://localhost:3000']);
});

test('/api/config tells the client where NEAR Auth works', async () => {
  const s = setup();
  const game = new Game(s.store, s.chain, { merchantParent: 'gt.test', town: 'town.gt.test', worldSeed: 42 });
  await game.init();
  const { server } = createApp({ ...s, game, verify: async () => ({ sub: 'x' }), currentBlockHeight: async () => 0n, clientDir: '.' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = (server.address() as { port: number }).port;
    const cfg = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json() as { fastAuth: { origins: string[] } };
    assert.deepEqual(cfg.fastAuth.origins, s.cfg.fastAuth.origins);
  } finally { server.closeAllConnections(); server.close(); }
});

test('no fallback to the public NEAR Auth: with the FASTAUTH_* settings unset a real config has NEAR Auth off and login refused', async () => {
  const real = { GAME_CONTRACT_ID: 'g', RELAYER_ACCOUNT_ID: 'r', RELAYER_PRIVATE_KEYS: 'k', SETTLER_ACCOUNT_ID: 'm', SETTLER_PRIVATE_KEY: 'k', TOWN_ACCOUNT_ID: 't', MERCHANT_PARENT_ACCOUNT_ID: 'gt', PLAYERS_PARENT_ACCOUNT_ID: 'p', PLAYERS_PARENT_PRIVATE_KEY: 'k' };
  const off = loadConfig(real as NodeJS.ProcessEnv);
  assert.equal(off.fastAuth.enabled, false);
  assert.equal(off.fastAuth.domain, ''); assert.equal(off.fastAuth.contractId, '');
  const on = loadConfig({ ...real, FASTAUTH_DOMAIN: 'a.auth0.com', FASTAUTH_CLIENT_ID: 'c', FASTAUTH_CONTRACT_ID: 'fa.t', FASTAUTH_SIGNING_AUDIENCE: 'aud' } as NodeJS.ProcessEnv);
  assert.equal(on.fastAuth.enabled, true); assert.equal(on.fastAuth.contractId, 'fa.t');
  const { register } = await import('../src/auth.ts');
  await assert.rejects(register({ cfg: off, chain: {} as never, store: {} as never, verify: async () => ({ sub: 'x' }) }, { idToken: 't', sessionPublicKey: 'ed25519:' + '1'.repeat(44) }), (e: { status: number }) => e.status === 503);
});
