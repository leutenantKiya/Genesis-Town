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
      CREATE TABLE IF NOT EXISTS names (
        account TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE
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
    // Older databases have no tokens column on history.
    const cols = this.db.prepare('PRAGMA table_info(history)').all() as unknown as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'tokens')) this.db.exec('ALTER TABLE history ADD COLUMN tokens TEXT');
  }

  nameOf(account: string): string | null {
    return (this.db.prepare('SELECT name FROM names WHERE account = ?').get(account) as { name: string } | undefined)?.name ?? null;
  }

  /** The account that uses this display name (ignoring case), if any. */
  accountByName(name: string): string | null {
    return (this.db.prepare('SELECT account FROM names WHERE name = ?').get(name) as { account: string } | undefined)?.account ?? null;
  }

  isPlayer(account: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM players WHERE account_id = ?').get(account);
  }

  /** Sets (or changes) the display name; names are unique ignoring case. */
  setName(account: string, name: string) {
    try {
      this.db.prepare('INSERT INTO names (account, name) VALUES (?, ?) ON CONFLICT(account) DO UPDATE SET name = excluded.name').run(account, name);
    } catch (e) {
      if (/UNIQUE/i.test(String((e as Error).message))) throw new HttpError(409, 'Nama itu sudah dipakai pemain lain');
      throw e;
    }
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
