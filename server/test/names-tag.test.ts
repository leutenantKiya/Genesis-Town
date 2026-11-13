import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/db.ts';
import { Social } from '../src/social.ts';

const A = 'pa.players.test', B = 'pb.players.test';
function mk() {
  const store = new Store(':memory:');
  for (const a of [A, B]) store.addPlayer(a, 'sub-' + a, 'ed25519:o');
  return { store, social: new Social(store) };
}

test('tag is 5 digits and stable', () => {
  const { store, social } = mk();
  const t = store.tagOf(A);
  assert.match(t, /^[1-9]\d{4}$/);
  assert.equal(store.tagOf(A), t);
  social.setNick(A, 'Ayu');
  assert.equal(store.tagOf(A), t, 'renaming keeps the tag');
  assert.equal(social.tag(A), t);
});

test('a new name is refused when another player has it in any case, and the same player may change its case', () => {
  const { store, social } = mk();
  social.setNick(A, 'Ayu');
  for (const n of ['ayu', 'AYU', 'aYu']) assert.throws(() => social.setNick(B, n), (e: any) => e.status === 409 && /already taken/.test(e.message));
  assert.equal(store.nameOf(B), null, 'nothing was written');
  assert.throws(() => store.setName(B, 'AYU'), (e: any) => e.status === 409);
  assert.equal(social.accountOf('ayu'), A, 'a bare name in any case finds the one player');
  assert.equal(social.setNick(A, 'AYU'), 'AYU', 'the owner may re-case the own name');
  assert.equal(social.accountOf('ayu'), A);
  social.setNick(B, 'Budi_b'); // free names still work
});

test('a refused taken name does not use up the rename limit', () => {
  const { social } = mk();
  social.setNick(A, 'Ayu');
  for (let i = 0; i < 6; i++) assert.throws(() => social.setNick(B, 'ayu'), (e: any) => e.status === 409);
  assert.equal(social.setNick(B, 'Bayu'), 'Bayu');
});

test('old duplicates (made before names were unique) still load and still tell apart by name#tag', () => {
  const { store, social } = mk();
  // two rows with the same name in different case, as an older database could hold them
  const db = (store as any).db as DatabaseSync;
  db.prepare('INSERT INTO names (account, name, tag) VALUES (?, ?, ?)').run(A, 'Ayu', '11111');
  db.prepare('INSERT INTO names (account, name, tag) VALUES (?, ?, ?)').run(B, 'ayu', '22222');
  assert.equal(store.nameOf(A), 'Ayu'); assert.equal(store.nameOf(B), 'ayu');
  assert.equal(social.accountOf('Ayu'), null, 'the plain name is ambiguous');
  assert.ok(social.isAmbiguous('Ayu'));
  assert.equal(social.accountOf('Ayu#22222'), B);
  assert.equal(social.accountOf('ayu#11111'), A);
  // a third player cannot take the name, an old owner keeps playing under it
  const C = 'pc.players.test'; store.addPlayer(C, 'sub-c', 'ed25519:o');
  assert.throws(() => social.setNick(C, 'AYU'), (e: any) => e.status === 409);
  assert.equal(social.setNick(A, 'Ayu'), 'Ayu', 'unchanged name is a no-op');
  assert.equal(store.tagOf(A), '11111');
});

test('/msg by bare name: one player delivers, several is a clear error, name#tag still works', () => {
  const { store, social } = mk();
  const db = (store as any).db as DatabaseSync;
  const D = 'pd.players.test', E = 'pe.players.test';
  for (const a of [D, E]) store.addPlayer(a, 'sub-' + a, 'ed25519:o');
  social.setNick(A, 'Ani'); social.setNick(B, 'Budi_b');
  // old duplicate pair
  db.prepare('INSERT INTO names (account, name, tag) VALUES (?, ?, ?)').run(D, 'Twin', '33333');
  db.prepare('INSERT INTO names (account, name, tag) VALUES (?, ?, ?)').run(E, 'TWIN', '44444');
  let t = 1_800_000_000_000; const s = new Social(store, () => t);
  s.say(A, 'public', '/msg budi_b hai');                       // lower case, no tag
  assert.deepEqual(s.since(B, 'public', 0).map((m) => m.text), ['hai']);
  t += 2100;
  assert.throws(() => s.say(A, 'public', '/msg twin halo'), (e: any) => e.status === 409 && /Several players are named twin\. Use name#tag\./.test(e.message));
  t += 2100;
  s.say(A, 'public', '/msg Twin#44444 halo');                 // name#tag works for the ambiguous name
  assert.deepEqual(s.since(E, 'public', 0).map((m) => m.text), ['halo']);
  assert.deepEqual(s.since(D, 'public', 0).map((m) => m.text), []);
  t += 2100;
  assert.throws(() => s.say(A, 'public', '/msg Nobody hi'), (e: any) => e.status === 404);
});

test('same name+tag cannot be taken, and a taken name is refused whatever tag is asked for', () => {
  const { store } = mk();
  store.setName(A, 'Ayu', '12345');
  assert.throws(() => store.setName(B, 'AYU', '12345'), /already taken/);
  assert.throws(() => store.setName(B, 'Ayu', '12346'), /already taken/);
  store.setName(B, 'Bayu', '12346');
  assert.equal(store.accountByNameTag('Bayu', '12346'), B);
});

test('look outside 0-7 answers 400', () => {
  const { store, social } = mk();
  assert.equal(store.lookOf(A), 0);
  assert.equal(social.setLook(A, 5), 5);
  assert.equal(store.lookOf(A), 5);
  for (const bad of [8, -1, 1.5, '3', null]) assert.throws(() => social.setLook(A, bad), (e: any) => e.status === 400);
  assert.equal(store.lookOf(A), 5);
});

test('old names table is migrated: names kept, tags given lazily', () => {
  const dir = ':memory:';
  const store = new Store(dir);
  const db = (store as any).db as DatabaseSync;
  db.exec('DROP TABLE names; CREATE TABLE names (account TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE); INSERT INTO names VALUES (\'pa\', \'Lama\')');
  (store as any).migrateNames();
  assert.equal(store.nameOf('pa'), 'Lama');
  assert.match(store.tagOf('pa'), /^\d{5}$/);
  assert.throws(() => store.setName('pb', 'lama'), (e: any) => e.status === 409, 'the migrated name is taken ignoring case');
  store.setName('pb', 'lama2');
});

test('a database that lost the names row gives the player the same tag again', () => {
  const a = mk(), b = mk(); // b: the same accounts on a fresh database (a restart from an older copy)
  a.social.setNick(A, 'Ayu');
  b.social.setNick(A, 'Ayu');
  assert.equal(b.store.tagOf(A), a.store.tagOf(A));
  assert.equal(b.store.tagOf(B), a.store.tagOf(B), 'also without a name');
  assert.notEqual(a.store.tagOf(A), a.store.tagOf(B));
});

test('old data: a name+tag clash moves to the next tag of the same account, the same way every time', () => {
  // a duplicate name made before names were unique: B already holds name+tag, A has the name and gets its tag now
  const tagOn = (first: string) => {
    const { store } = mk(), db = (store as any).db as DatabaseSync;
    db.prepare('INSERT INTO names (account, name, tag) VALUES (?, ?, ?)').run(B, 'Ayu', first);
    db.prepare('INSERT INTO names (account, name) VALUES (?, ?)').run(A, 'Ayu');
    return store.tagOf(A);
  };
  const own = mk().store.tagOf(A);
  const moved = tagOn(own);
  assert.notEqual(moved, own);
  assert.equal(tagOn(own), moved);
});
