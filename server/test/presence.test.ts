import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as near from 'near-api-js';
import { Presence, validName } from '../src/presence.ts';
import { requestMessage } from '../src/reqauth.ts';
import { createApp } from '../src/app.ts';
import { Game } from '../src/game/game.ts';
import { setup } from './helpers.ts';

const names = new Map<string, string>([['a.t', 'Ayu'], ['b.t', 'Budi']]);
const mk = () => new Presence((a) => names.get(a) ?? null);

test('presence_only_within_world', () => {
  const p = mk();
  p.update('a.t', 'public', { x: 1, y: 2 }, 'down', 'out', 1000);
  p.update('b.t', 'IS-1', { x: 3, y: 4 }, 'up', 'out', 1000);
  p.update('c.t', 'public', { x: 5, y: 6 }, 'left', 'out', 1000);
  assert.deepEqual(p.others('public', 'a.t', 1000).map((o) => o.account), ['c.t']);
  assert.deepEqual(p.others('IS-1', 'a.t', 1000).map((o) => o.account), ['b.t']);
  assert.equal(p.others('IS-1', 'a.t', 1000)[0].name, 'Budi');
  p.update('b.t', 'public', { x: 3, y: 4 }, 'up', 'out', 1100); // moving world removes it from the old one
  assert.equal(p.others('IS-1', 'a.t', 1100).length, 0);
});

test('presence_drops_stale_after_10s', () => {
  const p = mk();
  p.update('a.t', 'public', { x: 1, y: 2 }, 'down', 'out', 1000);
  assert.equal(p.others('public', 'z.t', 10_999).length, 1);
  assert.equal(p.others('public', 'z.t', 11_001).length, 0);
});

test('chat_rejects_over_80_chars', () => {
  const p = mk();
  assert.equal(p.chat('a.t', 'public', 'x'.repeat(80), 1000).text.length, 80);
  assert.throws(() => p.chat('b.t', 'public', 'x'.repeat(81), 1000), /80/);
  assert.throws(() => p.chat('b.t', 'public', '   ', 1000), /kosong/i);
});

test('chat_rate_limit_2s', () => {
  const p = mk();
  p.chat('a.t', 'public', 'halo', 1000);
  assert.throws(() => p.chat('a.t', 'public', 'lagi', 2999), /terlalu cepat/i);
  p.chat('a.t', 'public', 'lagi', 3000);
  p.chat('b.t', 'public', 'other account is not limited', 1500);
});

test('chat_keeps_last_50', () => {
  const p = mk();
  for (let i = 0; i < 60; i++) p.chat('a.t', 'public', 'm' + i, 1000 + i * 2000);
  const r = p.recent('public');
  assert.equal(r.length, 50);
  assert.equal(r[0].text, 'm10');
  assert.equal(r[49].text, 'm59');
  assert.equal(p.recent('IS-1').length, 0);
});

test('chat_filter_masks_words', () => {
  const p = mk();
  assert.equal(p.chat('a.t', 'public', 'dasar Anjing kamu', 1000).text, 'dasar ****** kamu');
  assert.equal(p.chat('b.t', 'public', 'what the FUCK', 1000).text, 'what the ****');
  assert.equal(p.chat('a.t', 'public', '<img src=x onerror=alert(1)>', 3000).text, '<img src=x onerror=alert(1)>', 'text is kept verbatim: clients render it as text only');
});

test('name_rules_and_uniqueness', () => {
  assert.equal(validName('Ayu'), 'Ayu');
  assert.equal(validName('  Budi Santoso  '), 'Budi Santoso');
  for (const bad of ['ab', 'x'.repeat(17), 'a<b>c', 'nama!', 'é é é', '']) assert.throws(() => validName(bad), /3|16|huruf/i, bad);
  const s = setup();
  s.store.addPlayer('a.t', 's1', 'ed25519:o');
  s.store.addPlayer('b.t', 's2', 'ed25519:o');
  s.store.setName('a.t', 'Ayu');
  assert.equal(s.store.nameOf('a.t'), 'Ayu');
  assert.throws(() => s.store.setName('b.t', 'ayu'), /dipakai/i);
  s.store.setName('a.t', 'AYU'); // the owner may re-case their own name
  assert.equal(s.store.nameOf('a.t'), 'AYU');
  s.store.setName('b.t', 'Budi');
  assert.equal(s.store.nameOf('nobody'), null);
});

function sign(kp: near.KeyPair, account: string, method: string, path: string, body: string) {
  const ts = String(Date.now());
  const sig = kp.sign(new TextEncoder().encode(requestMessage(method, path, ts, body))).signature;
  return { 'x-account-id': account, 'x-gt-key': kp.getPublicKey().toString(), 'x-gt-ts': ts, 'x-gt-sig': Buffer.from(sig).toString('base64') };
}

test('stream_sends_presence_and_chat', async () => {
  const s = setup();
  const k1 = near.KeyPair.fromRandom('ed25519'), k2 = near.KeyPair.fromRandom('ed25519');
  for (const [a, k] of [['p1.players.test', k1], ['p2.players.test', k2]] as const) {
    s.store.addPlayer(a, 'sub' + a, 'ed25519:o');
    s.store.addSessionKey(k.getPublicKey().toString(), a);
  }
  const game = new Game(s.store, s.chain, { merchantParent: 'gt.test', town: 'town.gt.test', worldSeed: 42 });
  await game.init();
  const { server } = createApp({ ...s, game, verify: async () => ({ sub: 'x' }), currentBlockHeight: async () => 0n, clientDir: '.' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const sp = game.map!.layout.spawn;
  const post = (k: near.KeyPair, a: string, path: string, o: unknown) => {
    const body = JSON.stringify(o);
    return fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...sign(k, a, 'POST', path, body) }, body });
  };
  const ac = new AbortController();
  try {
    assert.equal((await fetch(base + '/api/stream?world=public')).status, 401, 'stream needs a signed request');
    assert.equal((await post(k1, 'p1.players.test', '/api/name', { name: 'Ayu' })).status, 200);
    assert.equal((await post(k2, 'p2.players.test', '/api/name', { name: 'ayu' })).status, 409);
    assert.equal((await post(k2, 'p2.players.test', '/api/name', { name: 'Budi' })).status, 200);
    assert.equal((await post(k2, 'p2.players.test', '/api/name', { name: 'a' })).status, 400);
    // p2 reports a position with a state poll and p1 listens
    const sPath = `/api/state?x=${sp.x}&y=${sp.y}`;
    const st = await (await fetch(base + sPath, { headers: sign(k2, 'p2.players.test', 'GET', sPath, '') })).json();
    assert.equal(st.name, 'Budi');
    const res = await fetch(base + '/api/stream?world=public', { headers: sign(k1, 'p1.players.test', 'GET', '/api/stream?world=public', ''), signal: ac.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.equal((await post(k2, 'p2.players.test', '/api/chat', { world: 'public', text: 'halo semua' })).status, 200);
    assert.equal((await post(k2, 'p2.players.test', '/api/chat', { world: 'public', text: 'x'.repeat(81) })).status, 400);
    let buf = '';
    const dec = new TextDecoder();
    const reader = res.body!.getReader();
    const t0 = Date.now();
    while (Date.now() - t0 < 4000 && !(/event: presence\ndata: .*Budi/.test(buf) && /event: chat/.test(buf))) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
    }
    assert.match(buf, /event: presence\ndata: .*"name":"Budi"/);
    assert.match(buf, /event: chat\ndata: .*"text":"halo semua"/);
    assert.doesNotMatch(buf, /"account":"p1\.players\.test","name":"Ayu","x"/, 'you do not see yourself');
  } finally {
    ac.abort();
    server.closeAllConnections();
    server.close();
  }
});
