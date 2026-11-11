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

test('two accounts may share a name with different tags', () => {
  const { store, social } = mk();
  social.setNick(A, 'Ayu'); social.setNick(B, 'ayu');
  assert.notEqual(store.tagOf(A), store.tagOf(B));
  assert.equal(social.accountOf('Ayu'), null, 'plain name is ambiguous');
  assert.equal(social.accountOf(`Ayu#${store.tagOf(B)}`), B);
  assert.equal(social.accountOf(`ayu#${store.tagOf(A)}`), A);
});

test('same name+tag cannot be taken', () => {
  const { store } = mk();
  store.setName(A, 'Ayu', '12345');
  assert.throws(() => store.setName(B, 'AYU', '12345'), /already taken/);
  store.setName(B, 'Ayu', '12346');
  assert.equal(store.accountByNameTag('Ayu', '12346'), B);
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
  store.setName('pb', 'lama');
});
