import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as near from 'near-api-js';
import { Store } from '../src/db.ts';
import { relayTokens } from '../src/relayer.ts';
import { requestMessage } from '../src/reqauth.ts';
import { createApp } from '../src/app.ts';
import { Game } from '../src/game/game.ts';
import { setup } from './helpers.ts';

const ACC = 'p1.players.test';

test('an old-schema database gets the tokens column and keeps its rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gt-hist-'));
  const path = join(dir, 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL,
    tx_hash TEXT, status TEXT NOT NULL, ref TEXT, created_at INTEGER NOT NULL);
    INSERT INTO history (account_id, kind, summary, status, created_at) VALUES ('a', 'gather', '+1 Ikan', 'offchain', 1);`);
  old.close();
  const s = new Store(path);
  const rows = s.history('a');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tokens, null);
  s.addHistory('a', 'gather', '+1 Kayu', 'offchain', null, null, ['wood']);
  assert.deepEqual(s.history('a', 50, 'wood').map((r) => r.summary), ['+1 Kayu']);
  assert.equal(new Store(path).history('a').length, 2, 'reopening does not fail on the existing column');
});

test('rows are tagged by item and the token filter returns only that item', async () => {
  const s = setup();
  s.store.addPlayer(ACC, 'sub', 'ed25519:o');
  const game = new Game(s.store, s.chain, { merchantParent: 'gt.test', town: 'town.gt.test', rng: () => 0.99 });
  await game.init();
  game.onNewPlayer(ACC);
  game.gs.add(0, ACC, 'wheat', 2, 'test');
  game.act(ACC, { action: 'craft', recipe: 'bread' });
  game.gs.add(0, ACC, 'ore', 2, 'test');
  game.gs.add(0, ACC, 'wood', 1, 'test');
  game.act(ACC, { action: 'craft', recipe: 'tool' });
  const tags = (t?: string) => s.store.history(ACC, 50, t).map((r) => r.tokens);
  assert.ok(s.store.history(ACC, 50, 'bread').length === 1 && tags('bread')[0] === ',bread,wheat,');
  assert.ok(tags('tool')[0]?.includes(',coin,'), 'tool crafting costs coin');
  assert.equal(s.store.history(ACC, 50, 'fish').length, 0);
  assert.equal(s.store.history(ACC).length, 2);
  assert.deepEqual(relayTokens('send_item', { token_id: 'fish' }), ['fish']);
  assert.deepEqual(relayTokens('project_contribute', { contribution: [{ token_id: 'wood' }, { token_id: 'ore' }] }), ['wood', 'ore']);
  assert.deepEqual(relayTokens('buy_listing', { listing_id: 1 }), ['coin']);
});

test('/api/history?token= filters, and an unknown item is a 400', async () => {
  const s = setup();
  const kp = near.KeyPair.fromRandom('ed25519');
  s.store.addPlayer(ACC, 'sub', 'ed25519:o');
  s.store.addSessionKey(kp.getPublicKey().toString(), ACC);
  const game = new Game(s.store, s.chain, { merchantParent: 'gt.test', town: 'town.gt.test' });
  await game.init();
  s.store.addHistory(ACC, 'gather', '+1 Ikan', 'offchain', null, null, ['fish']);
  s.store.addHistory(ACC, 'gather', '+1 Kayu', 'offchain', null, null, ['wood']);
  const { server } = createApp({ ...s, game, verify: async () => ({ sub: 'x' }), currentBlockHeight: async () => 0n, clientDir: '.' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const get = (path: string) => {
    const ts = String(Date.now());
    const sig = kp.sign(new TextEncoder().encode(requestMessage('GET', path, ts, ''))).signature;
    return fetch(base + path, { headers: { 'x-account-id': ACC, 'x-gt-key': kp.getPublicKey().toString(), 'x-gt-ts': ts, 'x-gt-sig': Buffer.from(sig).toString('base64') } });
  };
  try {
    const ok = await get('/api/history?token=fish');
    assert.equal(ok.status, 200);
    assert.deepEqual(((await ok.json()) as { history: Array<{ summary: string }> }).history.map((h) => h.summary), ['+1 Ikan']);
    assert.equal((await get('/api/history?token=bogus')).status, 400);
    assert.equal(((await (await get('/api/history')).json()) as { history: unknown[] }).history.length, 2);
  } finally {
    server.close();
  }
});
