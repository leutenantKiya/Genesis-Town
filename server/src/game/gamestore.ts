// Off-chain game state in SQLite: the day ledger (every off-chain change), cached settled balances, players'
// energy/tool/farm state, shared gathering nodes, merchant market state, and settlement progress.
// A player's spendable balance = settled (on chain, cached) + the sum of not-yet-settled ledger deltas.
import type { DatabaseSync } from 'node:sqlite';

export interface LedgerRow { seq: number; day: number; account: string; token: string; delta: number; kind: string; ref: string | null; settled: number; created_at: number }
export interface PlayerState { account: string; energy: number; energy_hour: number; tool_uses: number }
export interface Plot { account: string; idx: number; state: 'empty' | 'tilled' | 'planted' | 'ready'; planted_day: number; grown: number; watered_day: number }
export interface MarketRow { merchant: string; token: string; mid: number; bought: number; sold: number; ask: number; bid: number; reason: string; change_pct: number; hour: number }


export interface HomelandRow { account: string; id: number; seed: number; gen: number; th: number; open: string[]; created_at: number }
export interface HomelandBuildingRow { account: string; lot: string; kind: string; last_collect: number }
export interface HomelandJobRow { account: string; target: string; kind: 'th' | 'chunk' | 'build'; ends_at: number }

export class GameStore {
  db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ledger (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, day INTEGER NOT NULL, account TEXT NOT NULL, token TEXT NOT NULL,
        delta INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT, settled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS ledger_open ON ledger(settled, account, token);
      CREATE INDEX IF NOT EXISTS ledger_day ON ledger(day, seq);
      CREATE TABLE IF NOT EXISTS shortfalls (day INTEGER NOT NULL, chunk INTEGER NOT NULL, account TEXT NOT NULL, token TEXT NOT NULL,
        wanted INTEGER NOT NULL, applied INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'shortfall', resolved INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, chunk, account, token));
      CREATE TABLE IF NOT EXISTS settled (account TEXT NOT NULL, token TEXT NOT NULL, amount INTEGER NOT NULL, PRIMARY KEY (account, token));
      CREATE TABLE IF NOT EXISTS player_state (account TEXT PRIMARY KEY, energy REAL NOT NULL, energy_hour INTEGER NOT NULL, tool_uses INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS plots (account TEXT NOT NULL, idx INTEGER NOT NULL, state TEXT NOT NULL, planted_day INTEGER NOT NULL DEFAULT 0,
        grown INTEGER NOT NULL DEFAULT 0, watered_day INTEGER NOT NULL DEFAULT -1, PRIMARY KEY (account, idx));
      CREATE TABLE IF NOT EXISTS nodes (key TEXT PRIMARY KEY, charges INTEGER NOT NULL, refill_hour INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS market (merchant TEXT NOT NULL, token TEXT NOT NULL, mid REAL NOT NULL, bought REAL NOT NULL, sold REAL NOT NULL,
        ask INTEGER NOT NULL, bid INTEGER NOT NULL, reason TEXT NOT NULL, change_pct INTEGER NOT NULL, hour INTEGER NOT NULL, PRIMARY KEY (merchant, token));
      CREATE TABLE IF NOT EXISTS settlements (day INTEGER NOT NULL, chunk INTEGER NOT NULL, root TEXT NOT NULL, tx_hash TEXT, status TEXT NOT NULL,
        accounts TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (day, chunk));
      CREATE TABLE IF NOT EXISTS homelands (account TEXT PRIMARY KEY, id INTEGER UNIQUE NOT NULL, seed INTEGER NOT NULL, gen INTEGER NOT NULL,
        th INTEGER NOT NULL, open TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS homeland_buildings (account TEXT NOT NULL, lot TEXT NOT NULL, kind TEXT NOT NULL, last_collect INTEGER NOT NULL, PRIMARY KEY (account, lot));
      CREATE TABLE IF NOT EXISTS homeland_jobs (account TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL, ends_at INTEGER NOT NULL, PRIMARY KEY (account, target));
      CREATE TABLE IF NOT EXISTS homeland_invites (id INTEGER NOT NULL, account TEXT NOT NULL, PRIMARY KEY (id, account));
    `);
  }

  meta(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }
  setMeta(key: string, value: string) {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /* ------------------------------------------------------------ ledger and balances */

  add(day: number, account: string, token: string, delta: number, kind: string, ref: string | null = null): number {
    if (!Number.isInteger(delta) || delta === 0) return 0;
    const r = this.db.prepare('INSERT INTO ledger (day, account, token, delta, kind, ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(day, account, token, delta, kind, ref, Date.now());
    return Number(r.lastInsertRowid);
  }

  settledBalance(account: string, token: string): number {
    return (this.db.prepare('SELECT amount FROM settled WHERE account = ? AND token = ?').get(account, token) as { amount: number } | undefined)?.amount ?? 0;
  }

  pending(account: string, token: string): number {
    return (this.db.prepare('SELECT COALESCE(SUM(delta), 0) AS s FROM ledger WHERE settled = 0 AND account = ? AND token = ?').get(account, token) as { s: number }).s;
  }

  /** Balance as it will be on chain once ledger days up to `day` are settled (ignores later days). */
  balanceThrough(account: string, token: string, day: number): number {
    const p = (this.db.prepare('SELECT COALESCE(SUM(delta), 0) AS s FROM ledger WHERE settled = 0 AND day <= ? AND account = ? AND token = ?').get(day, account, token) as { s: number }).s;
    return this.settledBalance(account, token) + p;
  }

  balance(account: string, token: string): number {
    return this.settledBalance(account, token) + this.pending(account, token) - this.reservedOf(account, token);
  }

  /** Amounts held back by a guarded on-chain relay that is in flight (memory only): off-chain play cannot spend them. */
  private reserved = new Map<string, Map<string, number>>();
  reservedOf(account: string, token: string): number { return this.reserved.get(account)?.get(token) ?? 0; }
  reserve(account: string, need: Map<string, number>) { this.reserved.set(account, new Map(need)); }
  release(account: string) { this.reserved.delete(account); }

  /**
   * A settlement debit the chain could not cover (or an entry dropped for an unregistered account). `wanted` and `applied`
   * are signed deltas. kind 'shortfall' freezes the account; 'cap_clamp' (credit above the daily gain cap) does not.
   * A retry of the same chunk keeps the first `wanted`.
   */
  recordShortfall(day: number, chunk: number, account: string, token: string, wanted: number, applied: number, kind = 'shortfall') {
    this.db.prepare(`INSERT INTO shortfalls (day, chunk, account, token, wanted, applied, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(day, chunk, account, token) DO UPDATE SET applied = excluded.applied`).run(day, chunk, account, token, wanted, applied, kind, Date.now());
  }
  shortfalls(): Array<{ day: number; chunk: number; account: string; token: string; wanted: number; applied: number; kind: string; resolved: number }> {
    return this.db.prepare('SELECT day, chunk, account, token, wanted, applied, kind, resolved FROM shortfalls ORDER BY day, chunk, account, token').all() as never;
  }
  isFrozen(account: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM shortfalls WHERE account = ? AND kind = 'shortfall' AND resolved = 0 LIMIT 1").get(account);
  }
  unfreeze(account: string): number {
    return Number(this.db.prepare('UPDATE shortfalls SET resolved = 1 WHERE account = ? AND resolved = 0').run(account).changes);
  }

  setSettled(account: string, token: string, amount: number) {
    this.db.prepare('INSERT INTO settled (account, token, amount) VALUES (?, ?, ?) ON CONFLICT(account, token) DO UPDATE SET amount = excluded.amount')
      .run(account, token, amount);
  }

  openRows(maxDay: number): LedgerRow[] {
    return this.db.prepare('SELECT * FROM ledger WHERE settled = 0 AND day <= ? ORDER BY seq').all(maxDay) as unknown as LedgerRow[];
  }

  dayRows(day: number): LedgerRow[] {
    return this.db.prepare('SELECT * FROM ledger WHERE day = ? ORDER BY seq').all(day) as unknown as LedgerRow[];
  }

  /** After a settlement landed on chain: mark its rows settled and move their net deltas into the cached on-chain
   *  balances, in one transaction. Computed locally because a read right after the write may hit an RPC node that
   *  hasn't seen it yet (that once cached a pre-settlement balance and let a player spend items twice). */
  applySettlement(seqs: number[], entries: Array<{ account_id: string; token_id: string; delta: string }>, marker?: [string, string]) {
    this.db.exec('BEGIN');
    try {
      for (const e of entries) this.setSettled(e.account_id, e.token_id, this.settledBalance(e.account_id, e.token_id) + Number(e.delta));
      this.markSettled(seqs);
      if (marker) this.setMeta(marker[0], marker[1]);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  markSettled(seqs: number[]) {
    const st = this.db.prepare('UPDATE ledger SET settled = 1 WHERE seq = ?');
    for (const s of seqs) st.run(s);
  }

  activeAccounts(day: number): number {
    return (this.db.prepare("SELECT COUNT(DISTINCT account) AS n FROM ledger WHERE day = ? AND account LIKE '%.players.%'").get(day) as { n: number }).n;
  }

  /** New coin created today (town purchases and shipping), for the off-chain faucet check. */
  newCoin(day: number): number {
    return (this.db.prepare("SELECT COALESCE(SUM(delta), 0) AS s FROM ledger WHERE day = ? AND token = 'coin' AND kind IN ('town_buy', 'ship_pay')").get(day) as { s: number }).s;
  }

  /* ------------------------------------------------------------ players */

  player(account: string): PlayerState | undefined {
    return this.db.prepare('SELECT * FROM player_state WHERE account = ?').get(account) as PlayerState | undefined;
  }
  savePlayer(p: PlayerState) {
    this.db.prepare(`INSERT INTO player_state (account, energy, energy_hour, tool_uses) VALUES (?, ?, ?, ?)
      ON CONFLICT(account) DO UPDATE SET energy = excluded.energy, energy_hour = excluded.energy_hour, tool_uses = excluded.tool_uses`)
      .run(p.account, p.energy, p.energy_hour, p.tool_uses);
  }

  plots(account: string): Plot[] {
    return this.db.prepare('SELECT * FROM plots WHERE account = ? ORDER BY idx').all(account) as unknown as Plot[];
  }
  savePlot(p: Plot) {
    this.db.prepare(`INSERT INTO plots (account, idx, state, planted_day, grown, watered_day) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(account, idx) DO UPDATE SET state = excluded.state, planted_day = excluded.planted_day, grown = excluded.grown, watered_day = excluded.watered_day`)
      .run(p.account, p.idx, p.state, p.planted_day, p.grown, p.watered_day);
  }

  node(key: string): { key: string; charges: number; refill_hour: number } | undefined {
    return this.db.prepare('SELECT * FROM nodes WHERE key = ?').get(key) as { key: string; charges: number; refill_hour: number } | undefined;
  }
  saveNode(key: string, charges: number, refillHour: number) {
    this.db.prepare('INSERT INTO nodes (key, charges, refill_hour) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET charges = excluded.charges, refill_hour = excluded.refill_hour')
      .run(key, charges, refillHour);
  }

  /* ------------------------------------------------------------ market */

  market(merchant: string, token: string): MarketRow | undefined {
    return this.db.prepare('SELECT * FROM market WHERE merchant = ? AND token = ?').get(merchant, token) as MarketRow | undefined;
  }
  markets(): MarketRow[] {
    return this.db.prepare('SELECT * FROM market ORDER BY merchant, token').all() as unknown as MarketRow[];
  }
  saveMarket(m: MarketRow) {
    this.db.prepare(`INSERT INTO market (merchant, token, mid, bought, sold, ask, bid, reason, change_pct, hour) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(merchant, token) DO UPDATE SET mid = excluded.mid, bought = excluded.bought, sold = excluded.sold, ask = excluded.ask,
      bid = excluded.bid, reason = excluded.reason, change_pct = excluded.change_pct, hour = excluded.hour`)
      .run(m.merchant, m.token, m.mid, m.bought, m.sold, m.ask, m.bid, m.reason, m.change_pct, m.hour);
  }

  /** Units a merchant bought from players today (for the daily buy cap). */
  /** Sum of one kind of ledger row for an account on a day (e.g. village seeds handed out). */
  sumKind(day: number, account: string, token: string, kind: string): number {
    return (this.db.prepare('SELECT COALESCE(SUM(delta), 0) AS s FROM ledger WHERE day = ? AND account = ? AND token = ? AND kind = ? AND delta > 0').get(day, account, token, kind) as { s: number }).s;
  }
  boughtToday(merchant: string, token: string, day: number): number {
    return (this.db.prepare("SELECT COALESCE(SUM(delta), 0) AS s FROM ledger WHERE day = ? AND account = ? AND token = ? AND kind = 'trade' AND delta > 0").get(day, merchant, token) as { s: number }).s;
  }

  /* ------------------------------------------------------------ settlements */

  settlement(day: number, chunk: number) {
    return this.db.prepare('SELECT * FROM settlements WHERE day = ? AND chunk = ?').get(day, chunk) as
      | { day: number; chunk: number; root: string; tx_hash: string | null; status: string; accounts: string }
      | undefined;
  }
  saveSettlement(day: number, chunk: number, root: string, status: string, txHash: string | null, accounts: string[]) {
    this.db.prepare(`INSERT INTO settlements (day, chunk, root, tx_hash, status, accounts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(day, chunk) DO UPDATE SET status = excluded.status, tx_hash = excluded.tx_hash`)
      .run(day, chunk, root, txHash, status, JSON.stringify(accounts), Date.now());
  }
  settlements(limit = 20) {
    return this.db.prepare('SELECT day, chunk, root, tx_hash, status, created_at FROM settlements ORDER BY day DESC, chunk DESC LIMIT ?').all(limit);
  }

  /** True when every one of these ledger rows is part of a finished settlement. */
  rowsSettled(seqs: number[]): boolean {
    const st = this.db.prepare('SELECT settled FROM ledger WHERE seq = ?');
    return seqs.every((q) => (st.get(q) as { settled: number } | undefined)?.settled === 1);
  }

  /* ------------------------------------------------------------ homelands (off-chain; costs and gains are ledger rows) */

  private homelandRow(r: Record<string, unknown> | undefined): HomelandRow | undefined {
    return r ? { ...(r as unknown as Omit<HomelandRow, 'open'>), open: JSON.parse(String(r.open)) as string[] } : undefined;
  }
  homelandOf(account: string): HomelandRow | undefined {
    return this.homelandRow(this.db.prepare('SELECT * FROM homelands WHERE account = ?').get(account));
  }
  homelandById(id: number): HomelandRow | undefined {
    return this.homelandRow(this.db.prepare('SELECT * FROM homelands WHERE id = ?').get(id));
  }
  createHomeland(account: string, seed: number, gen: number, now: number): HomelandRow {
    const id = ((this.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM homelands').get() as { m: number }).m) + 1;
    this.db.prepare('INSERT INTO homelands (account, id, seed, gen, th, open, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)').run(account, id, seed, gen, '[]', now);
    return this.homelandOf(account)!;
  }
  setHomelandTh(account: string, th: number) { this.db.prepare('UPDATE homelands SET th = ? WHERE account = ?').run(th, account); }
  setHomelandOpen(account: string, open: string[]) { this.db.prepare('UPDATE homelands SET open = ? WHERE account = ?').run(JSON.stringify(open), account); }
  homelandBuildings(account: string): HomelandBuildingRow[] {
    return this.db.prepare('SELECT * FROM homeland_buildings WHERE account = ? ORDER BY lot').all(account) as unknown as HomelandBuildingRow[];
  }
  addHomelandBuilding(account: string, lot: string, kind: string, lastCollect: number) {
    this.db.prepare('INSERT OR IGNORE INTO homeland_buildings (account, lot, kind, last_collect) VALUES (?, ?, ?, ?)').run(account, lot, kind, lastCollect);
  }
  setHomelandCollect(account: string, lot: string, lastCollect: number) {
    this.db.prepare('UPDATE homeland_buildings SET last_collect = ? WHERE account = ? AND lot = ?').run(lastCollect, account, lot);
  }
  homelandJobs(account: string): HomelandJobRow[] {
    return this.db.prepare('SELECT * FROM homeland_jobs WHERE account = ? ORDER BY ends_at, target').all(account) as unknown as HomelandJobRow[];
  }
  addHomelandJob(account: string, target: string, kind: string, endsAt: number) {
    this.db.prepare('INSERT INTO homeland_jobs (account, target, kind, ends_at) VALUES (?, ?, ?, ?)').run(account, target, kind, endsAt);
  }
  /** True when this call removed the job (so exactly one caller applies its result). */
  deleteHomelandJob(account: string, target: string): boolean {
    return Number(this.db.prepare('DELETE FROM homeland_jobs WHERE account = ? AND target = ?').run(account, target).changes) === 1;
  }
  homelandInvites(id: number): string[] {
    return (this.db.prepare('SELECT account FROM homeland_invites WHERE id = ? ORDER BY account').all(id) as unknown as Array<{ account: string }>).map((r) => r.account);
  }
  setHomelandInvites(id: number, accounts: string[]) {
    this.db.prepare('DELETE FROM homeland_invites WHERE id = ?').run(id);
    const st = this.db.prepare('INSERT OR IGNORE INTO homeland_invites (id, account) VALUES (?, ?)');
    for (const a of accounts) st.run(id, a);
  }
  /** Homelands whose invite list holds this account. */
  homelandsInvitedTo(account: string): HomelandRow[] {
    return this.db.prepare('SELECT h.* FROM homelands h JOIN homeland_invites v ON v.id = h.id WHERE v.account = ? ORDER BY h.id').all(account).map((r) => this.homelandRow(r)!);
  }
}
