// Keeps a copy of the game's SQLite database in Neon Postgres, so the server can run on a host without a persistent
// disk (Railway without a volume) and still survive restarts and redeploys.
//
// The server keeps working on SQLite exactly as before. This module only:
//   - at start, before the Store opens: when there is no local database file, loads the last copy from Neon;
//   - every few minutes, when something changed (SQLite's total_changes()), copies the database with node:sqlite's
//     backup() (it does not block the game loop), gzips it and saves it as one row in Neon (overwritten, never added);
//   - right after a daily settlement and when the process is told to stop, saves at once.
// At most `everyMinutes` of play is lost if the process dies without warning; what is on chain is never at risk.
// The row is keyed by the game contract, so a testnet and a mock server never share a copy.
//
// Driver: node-postgres (`pg`), the Neon docs' choice for a long-running Node server, over the direct (not `-pooler`)
// connection string. One short connection per save: Neon suspends an idle compute after a few minutes anyway.
import { backup, type DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';

/** Where the copy lives. `pgRemote` is the real one; tests pass an in-memory one. */
export interface SnapshotRemote {
  load(key: string): Promise<Buffer | null>;
  save(key: string, gz: Buffer, sha256: string, size: number): Promise<void>;
}

export function pgRemote(url: string): SnapshotRemote {
  async function withClient<T>(fn: (c: import('pg').Client) => Promise<T>): Promise<T> {
    const { default: pg } = await import('pg');
    // Neon's strings say sslmode=require, which pg 8 already treats as verify-full; say so, and pg stops warning
    const conn = url.replace(/([?&]sslmode=)(prefer|require|verify-ca)\b/, '$1verify-full');
    const c = new pg.Client({ connectionString: conn, connectionTimeoutMillis: 15_000 });
    await c.connect();
    try {
      await c.query(`CREATE TABLE IF NOT EXISTS gt_snapshot (
        id TEXT PRIMARY KEY, saved_at TIMESTAMPTZ NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, data BYTEA NOT NULL)`);
      return await fn(c);
    } finally { await c.end().catch(() => {}); }
  }
  return {
    load: (key) => withClient(async (c) => {
      const r = await c.query('SELECT data FROM gt_snapshot WHERE id = $1', [key]);
      return r.rows.length ? (r.rows[0].data as Buffer) : null;
    }),
    save: (key, gz, sha256, size) => withClient(async (c) => {
      await c.query(`INSERT INTO gt_snapshot (id, saved_at, size, sha256, data) VALUES ($1, now(), $2, $3, $4)
        ON CONFLICT (id) DO UPDATE SET saved_at = now(), size = $2, sha256 = $3, data = $4`, [key, size, sha256, gz]);
    }),
  };
}

function hasLocal(path: string): boolean {
  try { return existsSync(path) && statSync(path).size > 0; } catch { return false; }
}

/** Before the Store opens: brings back the last copy when this host has no database file. Returns what it did. */
export async function restoreSnapshot(path: string, key: string, remote: SnapshotRemote): Promise<'restored' | 'kept-local' | 'none'> {
  if (path === ':memory:') return 'none';
  if (hasLocal(path)) return 'kept-local'; // a persistent disk is newer than the copy: it wins, and the next save updates the copy
  const gz = await remote.load(key);
  if (!gz) return 'none';
  const tmp = path + '.restore';
  writeFileSync(tmp, gunzipSync(gz));
  for (const f of [path + '-wal', path + '-shm']) rmSync(f, { force: true });
  renameSync(tmp, path);
  return 'restored';
}

export interface SnapshotStatus { lastSavedAt: number | null; lastSize: number | null; lastError: string | null; saves: number }

/** Saves the database to the remote now and then. `tick()` is called by its own timer; tests call it by hand. */
export function startSnapshots(o: {
  db: DatabaseSync; path: string; key: string; remote: SnapshotRemote;
  everyMinutes?: number; settledThrough?: () => number; now?: () => number; timer?: boolean; log?: (m: string) => void;
}) {
  const now = o.now ?? Date.now, every = (o.everyMinutes ?? 5) * 60_000, log = o.log ?? ((m: string) => console.log(m));
  const status: SnapshotStatus = { lastSavedAt: null, lastSize: null, lastError: null, saves: 0 };
  let lastChanges = -1, lastSha = '', lastAt = -Infinity, lastSettled = o.settledThrough ? o.settledThrough() : 0, busy: Promise<void> | null = null;
  const changes = () => Number((o.db.prepare('SELECT total_changes() AS n').get() as { n: number | bigint }).n);

  async function save(): Promise<void> {
    const tmp = `${o.path === ':memory:' ? 'genesis-town' : o.path}.snapshot`;
    const seen = changes();
    try {
      await backup(o.db, tmp);
      const raw = readFileSync(tmp), sha = createHash('sha256').update(raw).digest('hex');
      lastChanges = seen; lastAt = now();
      if (sha === lastSha) return; // nothing that matters changed
      const gz = gzipSync(raw);
      await o.remote.save(o.key, gz, sha, gz.length);
      lastSha = sha; status.lastSavedAt = now(); status.lastSize = gz.length; status.lastError = null; status.saves++;
    } catch (e) {
      status.lastError = (e as Error).message;
      log(`snapshot: save failed (${status.lastError}); will retry`);
    } finally { rmSync(tmp, { force: true }); }
  }
  function run(): Promise<void> {
    if (!busy) busy = save().finally(() => { busy = null; });
    return busy;
  }
  /** Saves when the database changed and either the interval passed or a settlement just finished. */
  function tick(): Promise<void> | null {
    const settled = o.settledThrough ? o.settledThrough() : 0, justSettled = settled !== lastSettled;
    lastSettled = settled;
    if (changes() === lastChanges) return null;
    if (!justSettled && now() - lastAt < every) return null;
    return run();
  }
  const t = o.timer === false ? null : setInterval(tick, 30_000);
  t?.unref();
  return {
    status: () => ({ ...status }),
    tick,
    /** Saves now (when stopping), waiting at most `ms`. */
    flush: async (ms = 8000) => { if (t) clearInterval(t); if (changes() !== lastChanges) await Promise.race([run(), new Promise((r) => setTimeout(r, ms))]); },
  };
}
