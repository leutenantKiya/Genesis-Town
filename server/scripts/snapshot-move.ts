// Puts a local database file into the Neon copy that a host with no disk (Railway) restores at start.
// Used when the deployed server ran on an older database than the chain (two servers on one contract, 2026-11-12).
//
//   DATABASE_URL=… GAME_CONTRACT_ID=game.genesistown.testnet node server/scripts/snapshot-move.ts [--dry-run] [--db data/genesis-town.db]
//
// --dry-run only reads: what the local file and the stored copy hold, and which players exist only in the stored copy
// (signed up on the other server; their NEAR accounts exist and are adopted at their next login, but their unsettled
// progress there is not in the local file). Without --dry-run it uploads the local file; the copy refuses it when the
// stored one is settled further. The connection string is never printed.
//
// Order on the host: pause the service first (stopping it saves its own database to the copy), run this, then start it.
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pgRemote, startSnapshots } from '../src/snapshot.ts';

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const dbPath = args.includes('--db') ? args[args.indexOf('--db') + 1] : 'data/genesis-town.db';
const url = process.env.DATABASE_URL_UNPOOLED?.trim() || process.env.DATABASE_URL?.trim();
const key = process.env.GAME_CONTRACT_ID?.trim();
if (!url || !key) { console.error('Set DATABASE_URL (or DATABASE_URL_UNPOOLED) and GAME_CONTRACT_ID.'); process.exit(2); }

function facts(db: DatabaseSync) {
  const meta = (k: string) => (db.prepare('SELECT value FROM meta WHERE key = ?').get(k) as { value: string } | undefined)?.value;
  const players = (db.prepare('SELECT account_id FROM players').all() as Array<{ account_id: string }>).map((r) => r.account_id);
  return { settledThrough: Number(meta('settle.through') ?? -1), epoch: Number(meta('clock.epoch') ?? 0), players };
}

const local = new DatabaseSync(dbPath);
const mine = facts(local);
console.log(`local ${dbPath}: settled through day ${mine.settledThrough}, ${mine.players.length} players`);

const remote = pgRemote(url);
const gz = await remote.load(key);
let theirs: ReturnType<typeof facts> | null = null;
if (gz) {
  const dir = mkdtempSync(join(tmpdir(), 'gt-move-'));
  try {
    writeFileSync(join(dir, 'copy.db'), gunzipSync(gz));
    const c = new DatabaseSync(join(dir, 'copy.db'), { readOnly: true });
    theirs = facts(c); c.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const only = theirs.players.filter((p) => !mine.players.includes(p));
  console.log(`stored copy for ${key}: settled through day ${theirs.settledThrough}, ${theirs.players.length} players, ${only.length} only there`);
  for (const p of only) console.log(`  only in the stored copy: ${p}`);
} else console.log(`no stored copy for ${key} yet`);

if (dry) { console.log('dry run: nothing uploaded'); local.close(); process.exit(0); }
if (theirs && theirs.settledThrough > mine.settledThrough) {
  console.error(`refusing: the stored copy is settled further (day ${theirs.settledThrough}) than the local file (day ${mine.settledThrough})`);
  process.exit(1);
}
const s = startSnapshots({ db: local, path: dbPath, key, remote, settledThrough: () => mine.settledThrough, timer: false, log: (m) => console.error(m) });
await s.flush(60_000);
const st = s.status();
local.close();
if (st.lastError || !st.saves) { console.error(`upload failed: ${st.lastError ?? 'nothing saved'}`); process.exit(1); }
console.log(`uploaded: ${st.lastSize} bytes gzipped, settled through day ${mine.settledThrough}. Start the service now; its log should say "snapshot: restored".`);
