// Online guests: visitors without an account walk the public village (no chat, no actions), max econ.guest.max at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as near from 'near-api-js';
import { requestMessage } from '../src/reqauth.ts';
import { createApp } from '../src/app.ts';
import { Game } from '../src/game/game.ts';
import { setup } from './helpers.ts';

async function rig() {
  const s = setup();
  const kp = near.KeyPair.fromRandom('ed25519');
  s.store.addPlayer('p1.players.test', 'sub1', 'ed25519:o');
  s.store.addSessionKey(kp.getPublicKey().toString(), 'p1.players.test');
  const game = new Game(s.store, s.chain, { merchantParent: 'gt.test', town: 'town.gt.test', worldSeed: 42 });
  await game.init();
  const { server } = createApp({ ...s, game, verify: async () => ({ sub: 'x' }), currentBlockHeight: async () => 0n, clientDir: '.' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const sp = game.map!.layout.spawn;
  const pub = async (path: string, o: unknown) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) });
    return { status: res.status, json: (await res.json()) as any };
  };
  const signed = async (path: string, o: unknown) => {
    const body = JSON.stringify(o), ts = String(Date.now());
    const sig = kp.sign(new TextEncoder().encode(requestMessage('POST', path, ts, body))).signature;
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-account-id': 'p1.players.test', 'x-gt-key': kp.getPublicKey().toString(), 'x-gt-ts': ts, 'x-gt-sig': Buffer.from(sig).toString('base64') }, body });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { game, sp, pub, signed, s, close: () => { server.closeAllConnections(); server.close(); } };
}
const at = (sp: { x: number; y: number }) => ({ x: sp.x, y: sp.y, dir: 'down' });

test('guests: five get in, the sixth is told the village is full', async () => {
  const r = await rig();
  try {
    const max = r.game.econ.guest.max;
    for (let i = 0; i < max; i++) {
      const h = await r.pub('/api/guest/hello', {});
      assert.equal(h.status, 200); assert.match(h.json.guest, /^g-/); assert.match(h.json.nick, /^Tamu-\d{4}$/);
      assert.equal((await r.pub('/api/guest/presence', { guest: h.json.guest, ...at(r.sp) })).status, 200);
    }
    const full = await r.pub('/api/guest/hello', {});
    assert.equal(full.status, 429); assert.match(full.json.error, /full of guests/);
  } finally { r.close(); }
});

test('guests see players and each other, players see the guest flagged, no chat and no actions for guests', async () => {
  const r = await rig();
  try {
    await r.signed('/api/name', { name: 'Ayu' });
    await r.signed('/api/presence', { world: 'public', ...at(r.sp), scene: 'out', since: 0 });
    const g1 = (await r.pub('/api/guest/hello', {})).json, g2 = (await r.pub('/api/guest/hello', {})).json;
    const seen1 = await r.pub('/api/guest/presence', { guest: g1.guest, ...at(r.sp) });
    assert.equal(seen1.json.guest, true);
    assert.deepEqual(seen1.json.chat, []);
    assert.ok(seen1.json.players.some((p: any) => p.nick === 'Ayu' && !p.guest), 'guest sees the player');
    assert.ok(seen1.json.players.some((p: any) => p.npc), 'guest sees merchants');
    await r.pub('/api/guest/presence', { guest: g2.guest, ...at(r.sp) });
    const again = await r.pub('/api/guest/presence', { guest: g1.guest, ...at(r.sp) });
    assert.ok(again.json.players.some((p: any) => p.guest && p.nick === g2.nick), 'guests see each other');
    const mine = await r.signed('/api/presence', { world: 'public', ...at(r.sp), scene: 'out', since: 0 });
    const gs = mine.json.players.filter((p: any) => p.guest);
    assert.deepEqual(gs.map((p: any) => p.nick).sort(), [g1.nick, g2.nick].sort());
    assert.ok(gs.every((p: any) => p.title === undefined && p.party === undefined));
    // a guest has no keys: every account endpoint refuses it
    for (const path of ['/api/presence', '/api/chat', '/api/act', '/api/relay', '/api/trade/open']) {
      const res = await r.pub(path, { guest: g1.guest, world: 'public', text: 'hi', kind: 'gather' });
      assert.ok(res.status >= 400 && res.status < 500, path + ' refused for a guest, got ' + res.status);
    }
  } finally { r.close(); }
});

test('guests: unknown id is 404, a bad position is 400, a guest idle past the limit is dropped', async () => {
  const r = await rig();
  try {
    assert.equal((await r.pub('/api/guest/presence', { guest: 'g-nope', ...at(r.sp) })).status, 404);
    const g = (await r.pub('/api/guest/hello', {})).json;
    assert.equal((await r.pub('/api/guest/presence', { guest: g.guest, x: -1, y: 0 })).status, 400);
    assert.equal((await r.pub('/api/guest/presence', { guest: g.guest, ...at(r.sp) })).status, 200);
  } finally { r.close(); }
});

test('Social: idle guests are dropped and free their slot', async () => {
  const { Social } = await import('../src/social.ts');
  let t = 1_000_000;
  const names = { nameOf: () => null, accountsByName: () => [], accountByNameTag: () => null, setName() {}, tagOf: () => '00000', lookOf: () => 0, setLook() {} };
  const soc = new Social(names, () => t);
  soc.guestCfg = { max: 2, idleSecs: 30 };
  const a = soc.guestHello('1.1.1.1'); soc.guestHello('1.1.1.1');
  assert.throws(() => soc.guestHello('1.1.1.1'), /full of guests/);
  assert.throws(() => soc.guestReport(a.guest, '2.2.2.2', { x: 1, y: 1 }), /Unknown guest/, 'bound to the address that created it');
  t += 31_000;
  assert.equal(soc.guestList().length, 0);
  assert.doesNotThrow(() => soc.guestHello('1.1.1.1'));
});
