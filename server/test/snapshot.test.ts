import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { restoreSnapshot, startSnapshots, type SnapshotRemote } from '../src/snapshot.ts';

// An in-memory stand-in for Neon: one row per key, as gt_snapshot keeps it.
function memRemote() {
  const rows = new Map<string, Buffer>();
  let fail = false, saves = 0;
  const r: SnapshotRemote & { rows: Map<string, Buffer>; saves: () => number; failNext: (v: boolean) => void } = {
    rows, saves: () => saves, failNext: (v) => { fail = v; },
    load: async (key) => rows.get(key) ?? null,
    save: async (key, gz) => { if (fail) throw new Error('neon down'); rows.set(key, gz); saves++; },
  };
  return r;
}
function tmpDb() { const dir = mkdtempSync(join(tmpdir(), 'gt-snap-')); return { dir, path: join(dir, 'game.db') }; }

test('saves a copy only when something changed, at the interval or right after a settlement, and brings it back on a host with no disk', async () => {
  const { dir, path } = tmpDb(), remote = memRemote();
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE ledger (id INTEGER PRIMARY KEY, what TEXT)');
  let now = 1_000_000, settled = 3;
  const s = startSnapshots({ db, path, key: 'game.test', remote, everyMinutes: 5, settledThrough: () => settled, now: () => now, timer: false, log: () => {} });
  await s.tick(); // first look: the table was just made
  assert.equal(remote.saves(), 1);
  assert.equal(s.tick(), null, 'nothing changed: no save');
  db.prepare('INSERT INTO ledger (what) VALUES (?)').run('+1 kayu');
  assert.equal(s.tick(), null, 'changed, but the five minutes are not up');
  now += 5 * 60_000;
  await s.tick();
  assert.equal(remote.saves(), 2, 'changed and the interval passed');
  db.prepare('INSERT INTO ledger (what) VALUES (?)').run('+2 ikan');
  settled = 4; now += 1000;
  await s.tick();
  assert.equal(remote.saves(), 3, 'a settlement just finished: save at once');
  assert.equal(s.status().saves, 3);
  assert.ok(s.status().lastSize! > 0 && s.status().lastSize! < 8192, 'gzipped');
  db.close();

  // a fresh host (Railway without a volume): no file, so the copy comes back
  rmSync(path);
  assert.equal(await restoreSnapshot(path, 'game.test', remote), 'restored');
  const back = new DatabaseSync(path);
  assert.deepEqual((back.prepare('SELECT what FROM ledger ORDER BY id').all() as Array<{ what: string }>).map((r) => r.what), ['+1 kayu', '+2 ikan']);
  back.close();
  // a host with a disk keeps its own (newer) file; a key with no copy has nothing to bring back
  assert.equal(await restoreSnapshot(path, 'game.test', remote), 'kept-local');
  assert.equal(await restoreSnapshot(join(dir, 'other.db'), 'other.key', remote), 'none');
  assert.equal(existsSync(join(dir, 'other.db')), false);
  rmSync(dir, { recursive: true, force: true });
});

test('a failed save is reported and tried again; an unchanged database is not uploaded; stopping saves what changed', async () => {
  const { dir, path } = tmpDb(), remote = memRemote();
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE t (v TEXT)');
  let now = 0;
  const s = startSnapshots({ db, path, key: 'k', remote, everyMinutes: 1, now: () => now, timer: false, log: () => {} });
  remote.failNext(true);
  await s.tick();
  assert.equal(remote.saves(), 0);
  assert.match(s.status().lastError ?? '', /neon down/);
  remote.failNext(false);
  db.prepare('INSERT INTO t VALUES (?)').run('a'); now += 60_000;
  await s.tick();
  assert.equal(remote.saves(), 1);
  assert.equal(s.status().lastError, null);
  // no change since the last save: nothing is uploaded, however long it has been
  now += 10 * 60_000;
  assert.equal(s.tick(), null);
  assert.equal(remote.saves(), 1);
  db.prepare('INSERT INTO t VALUES (?)').run('c');
  await s.flush(); // SIGTERM: save now, whatever the interval says
  assert.equal(remote.saves(), 2);
  writeFileSync(join(dir, 'check.db'), gunzipSync(remote.rows.get('k')!));
  const check = new DatabaseSync(join(dir, 'check.db'));
  assert.deepEqual((check.prepare('SELECT v FROM t').all() as Array<{ v: string }>).map((r) => r.v), ['a', 'c']);
  check.close(); db.close();
  rmSync(dir, { recursive: true, force: true });
});
