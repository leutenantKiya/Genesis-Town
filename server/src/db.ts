// SQLite store (Node's built-in node:sqlite). Holds players, the Riwayat history, relay idempotency and mint batches.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface HistoryRow {
  id: number;
  account_id: string;
  kind: string;
  summary: string;
  tx_hash: string | null;
  status: 'pending' | 'ok' | 'failed' | 'mock';
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

  addHistory(accountId: string, kind: string, summary: string, status: HistoryRow['status'], txHash: string | null = null, ref: string | null = null): number {
    const r = this.db.prepare(
      'INSERT INTO history (account_id, kind, summary, tx_hash, status, ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(accountId, kind, summary, txHash, status, ref, Date.now());
    return Number(r.lastInsertRowid);
  }

  settleHistory(id: number, status: HistoryRow['status'], txHash: string | null) {
    this.db.prepare('UPDATE history SET status = ?, tx_hash = ? WHERE id = ?').run(status, txHash, id);
  }

  history(accountId: string, limit = 50): HistoryRow[] {
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
