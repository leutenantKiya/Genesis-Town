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
