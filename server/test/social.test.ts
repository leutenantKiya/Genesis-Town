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
  assert.equal(social.nick(A), 'Player_a1b2');
  assert.equal(social.setNick(A, 'Pemancing'), 'Pemancing');
  assert.equal(social.nick(A), 'Pemancing');
  assert.equal(store.nameOf(A), 'Pemancing', 'the Store names table is the only place names live');
  assert.equal(social.setNick(B, '  Budi Santoso  '), 'Budi Santoso', 'spaces are allowed, trimmed');
  assert.equal(social.setNick(C, 'pemancing'), 'pemancing', 'names may repeat; name#tag is unique'); store.setName(C, 'Cici_x');
  assert.throws(() => social.setNick(C, 'ab'), /3–16/);
  assert.throws(() => social.setNick(C, 'x'.repeat(17)), /3–16/);
  assert.throws(() => social.setNick(C, 'a<b>c'), /3–16/);
  assert.throws(() => social.setNick(C, 'Sari'), /can't be used/);
  assert.throws(() => social.setNick(C, 'Player_9999'), /can't be used/);
  assert.throws(() => social.setNick(C, 'bangsat'), /can't be used/);
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
  assert.equal(forB[0].toTag, social.tag(B));
  assert.equal(forB[0].fromTag, social.tag(A), 'every line carries the sender tag so equal names cannot impersonate');
  assert.match(forB2[0].fromTag, /^\d{5}$/);
  assert.deepEqual(forC.map((m) => m.text), ['Halo semua!', 'di sini publik'], 'C never sees the private line nor the island');
  assert.equal(social.since(B, P, forB2[1].id).length, 1, 'since returns only newer lines');
  assert.throws(() => social.say(A, P, '/msg'), /Usage/);
  assert.throws(() => social.say(A, P, '/msg Nobody hi'), /No player named/);
  assert.throws(() => social.say(A, P, '/msg Ani hi'), /your own name/);
  assert.throws(() => social.say(A, P, '/dance'), /Commands/);
  assert.throws(() => social.say(A, 'bogus', 'hi'), /bad world/);
  assert.equal(cleanText('a\u0007b\n\nc'), 'a b c');
  assert.equal(cleanText('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>', 'kept verbatim: clients render it as text only');
});

test('chat: names with spaces can be messaged; 80 characters; one line per 2 seconds', () => {
  const { social, tick } = world();
  social.setNick(A, 'Ani'); social.setNick(B, 'Budi Santoso');
  assert.equal(social.say(A, P, '/msg Budi Santoso halo kamu').text, 'halo kamu');
  assert.throws(() => social.say(A, P, 'lagi'), /too fast/);
  tick(2001);
  assert.equal(social.say(A, P, 'x'.repeat(80)).text.length, 80);
  tick(2001);
  assert.throws(() => social.say(A, P, 'x'.repeat(81)), /max 80/);
  assert.throws(() => social.say(A, P, '   '), /Empty/i);
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

const NPCS = [
  { id: 'sarah', account: 'sarah.gt.test', name: 'Sari', look: 3, x: 10, y: 10, title: 'Lapak Ikan Sari' },
  { id: 'ben', account: 'ben.gt.test', name: 'Budi', look: 2, x: 14, y: 10, title: 'Bengkel Budi' },
];

test('merchants appear in public presence with tag NPC, not in a Homeland, and not in the online count', () => {
  const { social } = world();
  social.setNpcs(NPCS);
  social.setNick(A, 'Ani');
  social.report(A, P, { x: 12, y: 12, scene: 'out' });
  const npcs = social.nearby(A, P).filter((s) => s.npc);
  assert.deepEqual(npcs.map((s) => [s.account, s.nick, s.tag, s.look, s.dir, s.title, s.x, s.y]),
    [['sarah.gt.test', 'Sari', 'NPC', 3, 'down', 'Lapak Ikan Sari', 10, 10], ['ben.gt.test', 'Budi', 'NPC', 2, 'down', 'Bengkel Budi', 14, 10]]);
  assert.equal(social.online(), 1);
  social.report(A, 'HL-1', { x: 12, y: 12, scene: 'out' });
  assert.equal(social.nearby(A, 'HL-1').filter((s) => s.npc).length, 0);
  social.report(A, P, { x: 200, y: 200, scene: 'out' });
  assert.equal(social.nearby(A, P).filter((s) => s.npc).length, 0, 'far merchants are not sent');
});

test('/msg to a merchant from public is a private line and asks the merchant; Sari#NPC works too', () => {
  const { social, tick } = world();
  social.setNpcs(NPCS);
  social.setNick(A, 'Ani'); social.setNick(B, 'Budi_2');
  const asked: Array<[string, string, string]> = [];
  social.onNpcMsg = (npc, from, text) => { asked.push([npc.id, from, text]); };
  const m = social.say(A, P, '/msg Sari harga ikan?');
  assert.equal(m.to, 'Sari'); assert.equal(m.toTag, 'NPC'); assert.equal(m.text, 'harga ikan?');
  tick(2100); social.say(A, P, '/msg sari#NPC halo');
  assert.deepEqual(asked, [['sarah', A, 'harga ikan?'], ['sarah', A, 'halo']]);
  social.npcSay(NPCS[0], A, 'Ikan 9 koin.');
  const mine = social.since(A, P, 0), others = social.since(B, P, 0);
  const reply = mine.find((x) => x.from === 'Sari');
  assert.ok(reply && reply.fromTag === 'NPC' && reply.to === 'Ani' && reply.text === 'Ikan 9 koin.');
  assert.equal(others.length, 0, 'other players never see the exchange');
});

test('/msg to a merchant from a Homeland answers 409 and asks nobody', () => {
  const { social } = world();
  social.setNpcs(NPCS);
  let called = 0;
  social.onNpcMsg = () => { called++; };
  assert.throws(() => social.say(A, 'HL-1', '/msg Sari harga ikan?'), (e: any) => e.status === 409 && /Merchants are in the public area\./.test(e.message));
  assert.equal(called, 0);
});
