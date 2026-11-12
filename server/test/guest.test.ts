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
  const { server } = createApp({ ...s, cfg: { ...s.cfg, trustProxy: true }, game, verify: async () => ({ sub: 'x' }), currentBlockHeight: async () => 0n, clientDir: '.' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const sp = game.map!.layout.spawn;
  const pub = async (path: string, o: unknown, ip = '9.9.9.1') => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(o) });
    return { status: res.status, json: (await res.json()) as any };
  };
  const signed = async (path: string, o: unknown) => {
    const body = JSON.stringify(o), ts = String(Date.now());
    const sig = kp.sign(new TextEncoder().encode(requestMessage('POST', path, ts, body))).signature;
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-account-id': 'p1.players.test', 'x-gt-key': kp.getPublicKey().toString(), 'x-gt-ts': ts, 'x-gt-sig': Buffer.from(sig).toString('base64') }, body });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { game, sp, pub, signed, s, kp, base, cfg: s.cfg, close: () => { server.closeAllConnections(); server.close(); } };
}
const at = (sp: { x: number; y: number }) => ({ x: sp.x, y: sp.y, dir: 'down' });

test('guests: five get in, the sixth is told the village is full', async () => {
  const r = await rig();
  try {
    const max = r.game.econ.guest.max;
    for (let i = 0; i < max; i++) {
      const ip = '9.9.9.' + (i + 1), h = await r.pub('/api/guest/hello', {}, ip);
      assert.equal(h.status, 200); assert.match(h.json.guest, /^g-/); assert.match(h.json.nick, /^Tamu-\d{4}$/);
      assert.equal((await r.pub('/api/guest/presence', { guest: h.json.guest, ...at(r.sp) }, ip)).status, 200);
    }
    const full = await r.pub('/api/guest/hello', {}, '9.9.9.77');
    assert.equal(full.status, 429); assert.match(full.json.error, /full of guests/);
  } finally { r.close(); }
});

test('guests see players and each other, players see the guest flagged, no chat and no actions for guests', async () => {
  const r = await rig();
  try {
    await r.signed('/api/name', { name: 'Ayu' });
    await r.signed('/api/presence', { world: 'public', ...at(r.sp), scene: 'out', since: 0 });
    const g1 = (await r.pub('/api/guest/hello', {}, '9.9.9.1')).json, g2 = (await r.pub('/api/guest/hello', {}, '9.9.9.2')).json;
    const seen1 = await r.pub('/api/guest/presence', { guest: g1.guest, ...at(r.sp) }, '9.9.9.1');
    assert.equal(seen1.json.guest, true);
    assert.deepEqual(seen1.json.chat, []);
    assert.ok(seen1.json.players.some((p: any) => p.nick === 'Ayu' && !p.guest), 'guest sees the player');
    assert.ok(seen1.json.players.some((p: any) => p.npc), 'guest sees merchants');
    await r.pub('/api/guest/presence', { guest: g2.guest, ...at(r.sp) }, '9.9.9.2');
    const again = await r.pub('/api/guest/presence', { guest: g1.guest, ...at(r.sp) }, '9.9.9.1');
    const handle = again.json.players.find((p: any) => p.guest && p.nick === g2.nick).account;
    assert.notEqual(handle, g2.guest, 'others see a public handle, not the secret id');
    assert.equal((await r.pub('/api/guest/presence', { guest: handle, ...at(r.sp) }, '9.9.9.2')).status, 404, 'the handle does not authorize');
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
  soc.guestCfg = { max: 2, idleSecs: 30, perIp: 1, maxMinutes: 30 };
  const a = soc.guestHello('1.1.1.1'); soc.guestHello('1.1.1.2');
  assert.equal(soc.guestHello('1.1.1.1').guest, a.guest, 'a second hello from the same address returns the same guest');
  assert.throws(() => soc.guestHello('1.1.1.3'), /full of guests/);
  assert.throws(() => soc.guestReport(a.guest, '2.2.2.2', { x: 1, y: 1 }), /Unknown guest/, 'bound to the address that created it');
  t += 31_000;
  assert.equal(soc.guestList().length, 0);
  assert.doesNotThrow(() => soc.guestHello('1.1.1.1'));
});

test('Social: a guest is dropped after maxMinutes even when active', async () => {
  const { Social } = await import('../src/social.ts');
  let t = 1_000_000;
  const names = { nameOf: () => null, accountsByName: () => [], accountByNameTag: () => null, setName() {}, tagOf: () => '00000', lookOf: () => 0, setLook() {} };
  const soc = new Social(names, () => t);
  soc.guestCfg = { max: 5, idleSecs: 30, perIp: 1, maxMinutes: 30 };
  const a = soc.guestHello('1.1.1.1');
  for (let i = 0; i < 31; i++) { t += 20_000; try { soc.guestReport(a.guest, '1.1.1.1', { x: 1, y: 1 }); } catch { break; } }
  for (let i = 0; i < 100; i++) { t += 20_000; try { soc.guestReport(a.guest, '1.1.1.1', { x: 1, y: 1 }); } catch { break; } }
  assert.throws(() => soc.guestReport(a.guest, '1.1.1.1', { x: 1, y: 1 }), /Unknown guest/);
  assert.notEqual(soc.guestHello('1.1.1.1').guest, a.guest, 'must say hello again, new secret');
});

test('admin: only ADMIN_ACCOUNTS; list, kick (id refused), ban (hello and register refused), unban', async () => {
  const r = await rig();
  try {
    const get = async (path: string) => {
      const ts = String(Date.now()), sig = r.kp.sign(new TextEncoder().encode(requestMessage('GET', path, ts, ''))).signature;
      const res = await fetch(r.base + path, { headers: { 'x-account-id': 'p1.players.test', 'x-gt-key': r.kp.getPublicKey().toString(), 'x-gt-ts': ts, 'x-gt-sig': Buffer.from(sig).toString('base64') } });
      return { status: res.status, json: (await res.json()) as any };
    };
    assert.equal((await get('/api/admin/guests')).status, 403);
    assert.equal((await r.signed('/api/admin/ban', { ip: '1.2.3.4' })).status, 403);
    assert.equal((await get('/api/state')).json.admin, undefined);
    r.cfg.adminAccounts.push('p1.players.test');
    assert.equal((await get('/api/state')).json.admin, true);
    const g = (await r.pub('/api/guest/hello', {}, '5.5.5.5')).json, g2 = (await r.pub('/api/guest/hello', {}, '6.6.6.6')).json;
    const list = (await get('/api/admin/guests')).json.guests;
    assert.equal(list.length, 2);
    const row = list.find((x: any) => x.ip === '5.5.5.5');
    assert.ok(row.nick && row.since && row.guest !== g.guest, 'the list shows a public handle, not the secret');
    assert.equal((await r.signed('/api/admin/kick', { guest: row.guest })).json.guests.length, 1);
    assert.equal((await r.pub('/api/guest/presence', { guest: g.guest, ...at(r.sp) }, '5.5.5.5')).status, 403, 'kicked id refused');
    assert.equal((await r.signed('/api/admin/ban', { ip: '6.6.6.6', note: 'rude' })).json.bans.length, 1);
    assert.equal((await r.pub('/api/guest/presence', { guest: g2.guest, ...at(r.sp) }, '6.6.6.6')).status, 403);
    const hb = await r.pub('/api/guest/hello', {}, '6.6.6.6');
    assert.equal(hb.status, 403); assert.match(hb.json.error, /banned/);
    assert.equal((await r.pub('/api/auth/register', {}, '6.6.6.6')).status, 403);
    assert.equal((await r.pub('/api/transfer/redeem', { id: 'x' }, '6.6.6.6')).status, 403);
    assert.equal((await get('/api/admin/bans')).json.bans[0].note, 'rude');
    await r.signed('/api/admin/unban', { ip: '6.6.6.6' });
    assert.equal((await r.pub('/api/guest/hello', {}, '6.6.6.6')).status, 200);
  } finally { r.close(); }
});
