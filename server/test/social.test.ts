import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { Social, cleanText, defaultNick } from '../src/social.ts';

const A = 'pa1b2c3d4.players.test', B = 'pb9f8e7d6.players.test', C = 'pc0ffee00.players.test';
const P = 'public';
function world() {
  const store = new Store(':memory:');
  for (const a of [A, B, C]) store.addPlayer(a, 'sub-' + a, 'ed25519:o');
  let now = 1_800_000_000_000;
  const social = new Social(store, () => now);
  return { social, store, tick: (ms: number) => { now += ms; } };
}

test('names: a default for unnamed accounts, rules on new names, unique ignoring case, one table', () => {
  const { social, store } = world();
  assert.equal(social.nick(A), defaultNick(A));
  assert.equal(social.nick(A), 'Warga_a1b2');
  assert.equal(social.setNick(A, 'Pemancing'), 'Pemancing');
  assert.equal(social.nick(A), 'Pemancing');
  assert.equal(store.nameOf(A), 'Pemancing', 'the Store names table is the only place names live');
  assert.equal(social.setNick(B, '  Budi Santoso  '), 'Budi Santoso', 'spaces are allowed, trimmed');
  assert.equal(social.setNick(C, 'pemancing'), 'pemancing', 'names may repeat; name#tag is unique'); store.setName(C, 'Cici_x');
  assert.throws(() => social.setNick(C, 'ab'), /3–16/);
  assert.throws(() => social.setNick(C, 'x'.repeat(17)), /3–16/);
  assert.throws(() => social.setNick(C, 'a<b>c'), /3–16/);
  assert.throws(() => social.setNick(C, 'Sari'), /tidak bisa dipakai/);
  assert.throws(() => social.setNick(C, 'Warga_9999'), /tidak bisa dipakai/);
  assert.throws(() => social.setNick(C, 'bangsat'), /tidak bisa dipakai/);
  assert.equal(social.accountOf('PEMANCING'), A);
});

test('chat: per world, /msg only for the two players (any world), rude words masked, limits hold', () => {
  const { social, tick } = world();
  social.setNick(A, 'Ani'); social.setNick(B, 'Budi_2'); social.setNick(C, 'Cici');
  social.say(A, P, 'Halo semua!');
  tick(2100); social.say(A, P, '/msg Budi_2 mau beli ikan?');
  social.say(B, 'HL-1', 'dasar goblok');
  social.say(C, P, 'di sini publik');
  const forB = social.since(B, 'HL-1', 0), forB2 = social.since(B, P, 0), forC = social.since(C, P, 0);
  assert.deepEqual(forB.map((m) => m.text), ['mau beli ikan?', 'dasar g*****'], 'B hears its island plus its private line, not the public square');
  assert.deepEqual(forB2.map((m) => m.text), ['Halo semua!', 'mau beli ikan?', 'di sini publik']);
  assert.equal(forB[0].to, 'Budi_2');
  assert.deepEqual(forC.map((m) => m.text), ['Halo semua!', 'di sini publik'], 'C never sees the private line nor the island');
  assert.equal(social.since(B, P, forB2[1].id).length, 1, 'since returns only newer lines');
  assert.throws(() => social.say(A, P, '/msg'), /Cara pakai/);
  assert.throws(() => social.say(A, P, '/msg Nobody hi'), /Tidak ada pemain/);
  assert.throws(() => social.say(A, P, '/msg Ani hi'), /namamu sendiri/);
  assert.throws(() => social.say(A, P, '/dance'), /Perintah/);
  assert.throws(() => social.say(A, 'bogus', 'hi'), /bad world/);
  assert.equal(cleanText('a\u0007b\n\nc'), 'a b c');
  assert.equal(cleanText('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>', 'kept verbatim: clients render it as text only');
});

test('chat: names with spaces can be messaged; 80 characters; one line per 2 seconds', () => {
  const { social, tick } = world();
  social.setNick(A, 'Ani'); social.setNick(B, 'Budi Santoso');
  assert.equal(social.say(A, P, '/msg Budi Santoso halo kamu').text, 'halo kamu');
  assert.throws(() => social.say(A, P, 'lagi'), /terlalu cepat/);
  tick(2001);
  assert.equal(social.say(A, P, 'x'.repeat(80)).text.length, 80);
  tick(2001);
  assert.throws(() => social.say(A, P, 'x'.repeat(81)), /maks 80/);
  assert.throws(() => social.say(A, P, '   '), /kosong/i);
  tick(2001);
  social.say(B, P, 'akun lain tidak dibatasi oleh A');
});

test('chat: only the last 50 lines of a world are kept for a newcomer', () => {
  const { social, tick } = world();
  for (let i = 0; i < 60; i++) { tick(8001); social.say(i % 2 ? B : C, 'HL-3', 'm' + i); }
  const r = social.since(A, 'HL-3', 0);
  assert.equal(r.length, 50);
  assert.equal(r[0].text, 'm10');
  assert.equal(social.since(A, P, 0).length, 0);
});

test('presence: only players outdoors, in the same world, nearby, seen in the last 15 seconds and still allowed there', () => {
  const { social, tick } = world();
  social.report(A, P, { x: 10, y: 10, dir: 'left', scene: 'out' });
  social.report(B, P, { x: 20, y: 12, dir: 'up', scene: 'out' });
  social.report(C, P, { x: 11, y: 10, dir: 'down', scene: 'in' });
  assert.deepEqual(social.nearby(A, P).map((s) => s.account), [B], 'indoor players are hidden');
  social.report(B, 'HL-1', { x: 20, y: 12, scene: 'out' });
  assert.deepEqual(social.nearby(A, P), [], 'another world is invisible');
  social.report(A, 'HL-1', { x: 10, y: 10, scene: 'out' });
  assert.deepEqual(social.nearby(A, 'HL-1').map((s) => s.account), [B]);
  social.access = (acct, w) => !(acct === B && w === 'HL-1'); // B is taken off the invite list
  assert.deepEqual(social.nearby(A, 'HL-1'), [], 'an uninvited guest disappears at once');
  social.access = () => true;
  social.report(B, 'HL-1', { x: 80, y: 80, scene: 'out' });
  assert.deepEqual(social.nearby(A, 'HL-1'), [], 'too far away');
  social.report(B, 'HL-1', { x: 12, y: 12, scene: 'out' });
  tick(16_000);
  social.report(A, 'HL-1', { x: 10, y: 10, scene: 'out' });
  assert.deepEqual(social.nearby(A, 'HL-1'), [], 'stale players drop out');
  assert.throws(() => social.report(A, P, { x: -1, y: 3 }), /bad position/);
});
