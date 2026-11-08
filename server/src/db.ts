// SQLite store (Node's built-in node:sqlite). Holds players, the Riwayat history, relay idempotency and mint batches.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { HttpError } from './auth.ts';

export interface HistoryRow {
  id: number;
  account_id: string;
  kind: string;
  summary: string;
  tx_hash: string | null;
  status: 'pending' | 'ok' | 'failed' | 'mock' | 'offchain';
  /** Items this row is about, as ',fish,wood,' (null on rows from before tagging). */
  tokens: string | null;
  created_at: number;
}

export class Store {
  db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS players (
        account_id TEXT PRIMARY KEY,
        sub TEXT UNIQUE NOT NULL,
        owner_pk TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_keys (
        public_key TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES players(account_id),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        tx_hash TEXT,
        status TEXT NOT NULL,
        ref TEXT,
        tokens TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS history_by_account ON history(account_id, id);
      CREATE TABLE IF NOT EXISTS relays (
        delegate_hash TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        tx_hash TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_mints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        amount INTEGER NOT NULL,
        mint_id TEXT,
        history_id INTEGER,
        created_at INTEGER NOT NULL
      );
    `);
    this.migrateNames();
    // Older databases have no tokens column on history.
    const cols = this.db.prepare('PRAGMA table_info(history)').all() as unknown as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'tokens')) this.db.exec('ALTER TABLE history ADD COLUMN tokens TEXT');
  }

  /** names: display name (may repeat; unique together with the 5-digit tag), tag, look (palette 0-7). Older tables had a UNIQUE name column: rebuild without it, keep the rows, tags come lazily. */
  private migrateNames() {
    const cols = this.db.prepare('PRAGMA table_info(names)').all() as unknown as Array<{ name: string }>;
    if (!cols.length) {
      this.db.exec('CREATE TABLE names (account TEXT PRIMARY KEY, name TEXT, tag TEXT, look INTEGER NOT NULL DEFAULT 0)');
    } else if (!cols.some((c) => c.name === 'tag')) {
      this.db.exec(`
        ALTER TABLE names RENAME TO names_old;
        CREATE TABLE names (account TEXT PRIMARY KEY, name TEXT, tag TEXT, look INTEGER NOT NULL DEFAULT 0);
        INSERT INTO names (account, name) SELECT account, name FROM names_old;
        DROP TABLE names_old;`);
    }
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS names_name_tag ON names (name COLLATE NOCASE, tag)');
  }

  nameOf(account: string): string | null {
    return (this.db.prepare('SELECT name FROM names WHERE account = ?').get(account) as { name: string | null } | undefined)?.name ?? null;
  }

  /** The account that uses this display name (ignoring case), if exactly one does. */
  accountByName(name: string): string | null {
    const rows = this.accountsByName(name);
    return rows.length === 1 ? rows[0] : null;
  }
  /** Every account using this display name (ignoring case); names may repeat, name#tag may not. */
  accountsByName(name: string): string[] {
    return (this.db.prepare('SELECT account FROM names WHERE name = ? COLLATE NOCASE').all(name) as Array<{ account: string }>).map((r) => r.account);
  }
  accountByNameTag(name: string, tag: string): string | null {
    return (this.db.prepare('SELECT account FROM names WHERE name = ? COLLATE NOCASE AND tag = ?').get(name, tag) as { account: string } | undefined)?.account ?? null;
  }

  /** The account's 5-digit tag (10000-99999); a random free one is assigned on first call and then never changes. */
  tagOf(account: string): string {
    const row = this.db.prepare('SELECT name, tag FROM names WHERE account = ?').get(account) as { name: string | null; tag: string | null } | undefined;
    if (row?.tag) return row.tag;
    const tag = this.freeTag(row?.name ?? null);
    this.db.prepare('INSERT INTO names (account, tag) VALUES (?, ?) ON CONFLICT(account) DO UPDATE SET tag = excluded.tag').run(account, tag);
    return tag;
  }
  private freeTag(name: string | null): string {
    for (let i = 0; i < 200; i++) {
      const tag = String(10000 + Math.floor(Math.random() * 90000));
      if (!name || !this.accountByNameTag(name, tag)) return tag;
    }
    throw new HttpError(503, 'Tidak ada tag kosong, coba nama lain');
  }

  lookOf(account: string): number {
    return (this.db.prepare('SELECT look FROM names WHERE account = ?').get(account) as { look: number } | undefined)?.look ?? 0;
  }
  setLook(account: string, look: number) {
    if (!Number.isInteger(look) || look < 0 || look > 7) throw new HttpError(400, 'Penampilan harus 0-7.');
    this.db.prepare('INSERT INTO names (account, look) VALUES (?, ?) ON CONFLICT(account) DO UPDATE SET look = excluded.look').run(account, look);
  }

  isPlayer(account: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM players WHERE account_id = ?').get(account);
  }

  /** Sets (or changes) the display name. The tag is kept; name+tag must be free (ignoring case): a clash re-rolls the tag, unless one was given explicitly (then 409). */
  setName(account: string, name: string, tag?: string) {
    const cur = this.db.prepare('SELECT tag FROM names WHERE account = ?').get(account) as { tag: string | null } | undefined;
    let use = tag ?? cur?.tag ?? null;
    const holder = use ? this.accountByNameTag(name, use) : null;
    if (holder && holder !== account) {
      if (tag) throw new HttpError(409, 'Nama itu sudah dipakai pemain lain');
      use = null;
    }
    if (!use) use = this.freeTag(name);
    this.db.prepare('INSERT INTO names (account, name, tag) VALUES (?, ?, ?) ON CONFLICT(account) DO UPDATE SET name = excluded.name, tag = excluded.tag').run(account, name, use);
  }

  playerBySub(sub: string) {
    return this.db.prepare('SELECT * FROM players WHERE sub = ?').get(sub) as
      | { account_id: string; sub: string; owner_pk: string; created_at: number }
      | undefined;
  }

  addPlayer(accountId: string, sub: string, ownerPk: string) {
    this.db.prepare('INSERT INTO players (account_id, sub, owner_pk, created_at) VALUES (?, ?, ?, ?)')
      .run(accountId, sub, ownerPk, Date.now());
  }

  addSessionKey(publicKey: string, accountId: string) {
    this.db.prepare('INSERT OR IGNORE INTO session_keys (public_key, account_id, created_at) VALUES (?, ?, ?)')
      .run(publicKey, accountId, Date.now());
  }

  sessionKeyOwner(publicKey: string): string | undefined {
    const r = this.db.prepare('SELECT account_id FROM session_keys WHERE public_key = ?').get(publicKey) as
      | { account_id: string }
      | undefined;
    return r?.account_id;
  }

  addHistory(accountId: string, kind: string, summary: string, status: HistoryRow['status'], txHash: string | null = null, ref: string | null = null, tokens: string[] = []): number {
    const tags = tokens.length ? `,${[...new Set(tokens)].join(',')},` : null;
    const r = this.db.prepare(
      'INSERT INTO history (account_id, kind, summary, tx_hash, status, ref, tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(accountId, kind, summary, txHash, status, ref, tags, Date.now());
    return Number(r.lastInsertRowid);
  }

  settleHistory(id: number, status: HistoryRow['status'], txHash: string | null) {
    this.db.prepare('UPDATE history SET status = ?, tx_hash = ? WHERE id = ?').run(status, txHash, id);
  }

  /** Off-chain actions become settled: they point at the settlement transaction that included the account. */
  settleOffchain(accountId: string, status: HistoryRow['status'], txHash: string | null) {
    this.db.prepare("UPDATE history SET status = ?, tx_hash = ? WHERE account_id = ? AND status = 'offchain'").run(status, txHash, accountId);
  }

  history(accountId: string, limit = 50, token?: string): HistoryRow[] {
    if (token) {
      return this.db.prepare('SELECT * FROM history WHERE account_id = ? AND tokens LIKE ? ORDER BY id DESC LIMIT ?')
        .all(accountId, `%,${token},%`, limit) as unknown as HistoryRow[];
    }
    return this.db.prepare('SELECT * FROM history WHERE account_id = ? ORDER BY id DESC LIMIT ?')
      .all(accountId, limit) as unknown as HistoryRow[];
  }

  relayGet(hash: string) {
    return this.db.prepare('SELECT * FROM relays WHERE delegate_hash = ?').get(hash) as
      | { delegate_hash: string; account_id: string; tx_hash: string | null; status: string }
      | undefined;
  }

  relayPut(hash: string, accountId: string, status: string, txHash: string | null) {
    this.db.prepare(
      `INSERT INTO relays (delegate_hash, account_id, tx_hash, status, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(delegate_hash) DO UPDATE SET status = excluded.status, tx_hash = excluded.tx_hash`,
    ).run(hash, accountId, txHash, status, Date.now());
  }

  queueMint(accountId: string, tokenId: string, amount: number, historyId: number) {
    this.db.prepare('INSERT INTO pending_mints (account_id, token_id, amount, history_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(accountId, tokenId, amount, historyId, Date.now());
  }

  unassignedMints() {
    return this.db.prepare('SELECT * FROM pending_mints WHERE mint_id IS NULL ORDER BY id').all() as unknown as {
      id: number; account_id: string; token_id: string; amount: number; history_id: number; created_at: number;
    }[];
  }

  assignMintId(ids: number[], mintId: string) {
    const st = this.db.prepare('UPDATE pending_mints SET mint_id = ? WHERE id = ?');
    for (const id of ids) st.run(mintId, id);
  }

  mintsById(mintId: string) {
    return this.db.prepare('SELECT * FROM pending_mints WHERE mint_id = ?').all(mintId) as unknown as {
      id: number; account_id: string; token_id: string; amount: number; history_id: number;
    }[];
  }

  openMintIds(): string[] {
    return (this.db.prepare('SELECT DISTINCT mint_id FROM pending_mints WHERE mint_id IS NOT NULL').all() as { mint_id: string }[])
      .map((r) => r.mint_id);
  }

  clearMint(mintId: string) {
    this.db.prepare('DELETE FROM pending_mints WHERE mint_id = ?').run(mintId);
  }
}
