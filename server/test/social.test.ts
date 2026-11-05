import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { Social, cleanText, defaultNick } from '../src/social.ts';

const A = 'pa1b2c3d4.players.test', B = 'pb9f8e7d6.players.test', C = 'pc0ffee00.players.test';
function world() {
  const store = new Store(':memory:');
  for (const a of [A, B, C]) store.addPlayer(a, 'sub-' + a, 'ed25519:o');
  let now = 1_800_000_000_000;
  const social = new Social(store.db, () => now);
  return { social, tick: (ms: number) => { now += ms; } };
}

test('nicknames: a default from the account, rules on new names, unique ignoring case', () => {
  const { social } = world();
  assert.equal(social.nick(A), defaultNick(A));
  assert.equal(social.nick(A), 'Warga_a1b2');
  assert.equal(social.setNick(A, 'Pemancing'), 'Pemancing');
  assert.equal(social.nick(A), 'Pemancing');
  assert.throws(() => social.setNick(B, 'pemancing'), /sudah dipakai/);
  assert.throws(() => social.setNick(B, 'ab'), /3–16/);
  assert.throws(() => social.setNick(B, 'dua kata'), /3–16/);
  assert.throws(() => social.setNick(B, 'Sari'), /tidak bisa dipakai/);
  assert.throws(() => social.setNick(B, 'Warga_9999'), /tidak bisa dipakai/);
  assert.throws(() => social.setNick(B, 'bangsat'), /tidak bisa dipakai/);
  assert.equal(social.accountOf('PEMANCING'), A);
  assert.equal(social.accountOf('Warga_b9f8'), B, 'default names can be messaged too');
});

test('chat: public lines for all, /msg only for the two players, rude words masked, limits hold', () => {
  const { social } = world();
  social.setNick(A, 'Ani'); social.setNick(B, 'Budi_2');
  social.say(A, 'Halo semua!');
  social.say(A, '/msg Budi_2 mau beli ikan?');
  social.say(B, 'dasar goblok');
  const forB = social.since(B, 0), forC = social.since(C, 0);
  assert.deepEqual(forB.map((m) => m.text), ['Halo semua!', 'mau beli ikan?', 'dasar g*****']);
  assert.equal(forB[1].to, 'Budi_2');
  assert.deepEqual(forC.map((m) => m.text), ['Halo semua!', 'dasar g*****'], 'C never sees the private line');
  assert.equal(social.since(B, forB[1].id).length, 1, 'since returns only newer lines');
  assert.throws(() => social.say(A, '/msg'), /Cara pakai/);
  assert.throws(() => social.say(A, '/msg Nobody hi'), /Tidak ada pemain/);
  assert.throws(() => social.say(A, '/msg Ani hi'), /namamu sendiri/);
  assert.throws(() => social.say(A, '/dance'), /Perintah/);
  assert.throws(() => social.say(A, 'x'.repeat(161)), /terlalu panjang/);
  for (let i = 0; i < 5; i++) social.say(C, 'spam ' + i);
  assert.throws(() => { for (let i = 0; i < 5; i++) social.say(C, 'lagi ' + i); }, /Pelan-pelan/);
  assert.equal(cleanText('a\u0007b\n\nc'), 'a b c');
});

test('presence: only players outdoors, nearby and seen in the last 15 seconds', () => {
  const { social, tick } = world();
  social.report(A, { x: 10, y: 10, dir: 'left', scene: 'out' });
  social.report(B, { x: 20, y: 12, dir: 'up', scene: 'out' });
  social.report(C, { x: 11, y: 10, dir: 'down', scene: 'in' });
  assert.deepEqual(social.nearby(A).map((s) => s.account), [B], 'indoor players are hidden');
  social.report(B, { x: 80, y: 80, scene: 'out' });
  assert.deepEqual(social.nearby(A), [], 'too far away');
  social.report(B, { x: 12, y: 12, scene: 'out' });
  tick(16_000);
  social.report(A, { x: 10, y: 10, scene: 'out' });
  assert.deepEqual(social.nearby(A), [], 'stale players drop out');
  assert.throws(() => social.report(A, { x: -1, y: 3 }), /bad position/);
});
