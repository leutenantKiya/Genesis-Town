// Off-chain game state in SQLite: the day ledger (every off-chain change), cached settled balances, players'
// energy/tool/farm state, shared gathering nodes, merchant market state, and settlement progress.
// A player's spendable balance = settled (on chain, cached) + the sum of not-yet-settled ledger deltas.
import type { DatabaseSync } from 'node:sqlite';

export interface LedgerRow { seq: number; day: number; account: string; token: string; delta: number; kind: string; ref: string | null; settled: number; created_at: number }
export interface PlayerState { account: string; energy: number; energy_hour: number; tool_uses: number }
export interface Plot { account: string; idx: number; state: 'empty' | 'tilled' | 'planted' | 'ready'; planted_at: number; planter: string }
export interface MarketRow { merchant: string; token: string; mid: number; bought: number; sold: number; ask: number; bid: number; reason: string; change_pct: number; hour: number }


export interface HomelandRow { account: string; id: number; seed: number; gen: number; th: number; open: string[]; created_at: number; party_role?: string | null }
export interface HomelandBuildingRow { account: string; lot: string; kind: string; last_collect: number }
export interface HomelandJobRow { account: string; target: string; kind: 'th' | 'chunk' | 'light' | 'build' | 'furniture' | 'upgrade'; ends_at: number; worker: number; base_secs: number; started_at: number; assisted: number }
export interface WorkerRow { account: string; slot: number; fatigue: number; updated_at: number; sick_until: number }

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
      CREATE TABLE IF NOT EXISTS homeland_jobs (account TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL, ends_at INTEGER NOT NULL, worker INTEGER NOT NULL DEFAULT 0, base_secs INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account, target));
      CREATE TABLE IF NOT EXISTS homeland_bots (account TEXT NOT NULL, id INTEGER NOT NULL, job TEXT NOT NULL, hired_at INTEGER NOT NULL, PRIMARY KEY (account, id));
      CREATE TABLE IF NOT EXISTS homeland_workers (account TEXT NOT NULL, slot INTEGER NOT NULL, fatigue REAL NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, sick_until INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account, slot));
      CREATE TABLE IF NOT EXISTS homeland_furniture (account TEXT NOT NULL, key TEXT NOT NULL, level INTEGER NOT NULL, PRIMARY KEY (account, key));
      CREATE TABLE IF NOT EXISTS homeland_cosmetics (account TEXT NOT NULL, slot INTEGER NOT NULL, cosmetic TEXT NOT NULL, PRIMARY KEY (account, slot));
      CREATE TABLE IF NOT EXISTS homeland_tilled (account TEXT NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL, PRIMARY KEY (account, x, y));
      CREATE TABLE IF NOT EXISTS homeland_pantry (account TEXT PRIMARY KEY, pantry INTEGER NOT NULL DEFAULT 0, tick_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS homeland_forage (account TEXT PRIMARY KEY, last INTEGER NOT NULL, carry REAL NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS trade_offers (id INTEGER PRIMARY KEY AUTOINCREMENT, from_acct TEXT NOT NULL, to_acct TEXT NOT NULL,
        give TEXT NOT NULL, want TEXT NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS trade_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT NOT NULL, b TEXT NOT NULL, world TEXT NOT NULL,
        a_lines TEXT NOT NULL DEFAULT '{}', b_lines TEXT NOT NULL DEFAULT '{}', a_ok INTEGER NOT NULL DEFAULT 0, b_ok INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'invite', swap_at INTEGER NOT NULL DEFAULT 0, note TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS trade_sessions_a ON trade_sessions(a, status);
      CREATE INDEX IF NOT EXISTS trade_sessions_b ON trade_sessions(b, status);
      CREATE TABLE IF NOT EXISTS homeland_invites (id INTEGER NOT NULL, account TEXT NOT NULL, PRIMARY KEY (id, account));
      CREATE TABLE IF NOT EXISTS parties (id INTEGER PRIMARY KEY AUTOINCREMENT, leader TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS party_members (account TEXT PRIMARY KEY, party INTEGER NOT NULL, joined_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS party_members_by_party ON party_members(party);
      CREATE TABLE IF NOT EXISTS party_invites (from_acct TEXT NOT NULL, account TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (from_acct, account));
    `);
    const jc = (this.db.prepare('PRAGMA table_info(homeland_jobs)').all() as Array<{ name: string }>).map((c) => c.name);
    const bc = (this.db.prepare('PRAGMA table_info(homeland_bots)').all() as Array<{ name: string }>).map((c) => c.name);
    const hc = (this.db.prepare('PRAGMA table_info(homelands)').all() as Array<{ name: string }>).map((c) => c.name);
    const ic = (this.db.prepare('PRAGMA table_info(homeland_invites)').all() as Array<{ name: string }>).map((c) => c.name);
    const pc = (this.db.prepare('PRAGMA table_info(plots)').all() as Array<{ name: string }>).map((c) => c.name);
    if (!pc.includes('planter')) this.db.exec("ALTER TABLE plots ADD COLUMN planter TEXT NOT NULL DEFAULT ''");
    if (!pc.includes('planted_at')) this.db.exec('ALTER TABLE plots ADD COLUMN planted_at INTEGER NOT NULL DEFAULT 0'); // ms since epoch; the old day-based columns stay unused
    if (!hc.includes('party_role')) this.db.exec('ALTER TABLE homelands ADD COLUMN party_role TEXT');
    if (!ic.includes('role')) this.db.exec("ALTER TABLE homeland_invites ADD COLUMN role TEXT NOT NULL DEFAULT 'visitor'");
    if (!bc.includes('house')) this.db.exec("ALTER TABLE homeland_bots ADD COLUMN house TEXT NOT NULL DEFAULT ''");
    for (const c of ['worker', 'base_secs', 'started_at', 'assisted']) if (!jc.includes(c)) this.db.exec(`ALTER TABLE homeland_jobs ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 0`);
  }

  /** Runs `fn` in one sqlite transaction (joins an outer one); any throw undoes every row. */
  tx<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
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
  /** True while a guarded on-chain relay holds amounts back for this account (its chain and settled balances differ for a moment). */
  hasReserved(account: string): boolean { return this.reserved.has(account); }

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
    this.db.prepare(`INSERT INTO plots (account, idx, state, planted_at, planter) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account, idx) DO UPDATE SET state = excluded.state, planted_at = excluded.planted_at, planter = excluded.planter`)
      .run(p.account, p.idx, p.state, p.planted_at, p.planter ?? '');
  }

  node(key: string): { key: string; charges: number; refill_hour: number } | undefined {
    return this.db.prepare('SELECT * FROM nodes WHERE key = ?').get(key) as { key: string; charges: number; refill_hour: number } | undefined;
  }
  /** Emptied nodes of one kind in one world (key prefix '' = the village, 'HL-<n>:' = a Homeland) that have not refilled yet. */
  emptyNodes(prefix: string, tile: string, nowHours: number): Array<{ x: number; y: number; refill_hour: number }> {
    const rows = this.db.prepare('SELECT key, refill_hour FROM nodes WHERE charges = 0 AND refill_hour > ? AND key LIKE ?')
      .all(nowHours, `${prefix}${tile}:%`) as Array<{ key: string; refill_hour: number }>;
    return rows.flatMap((r) => {
      const m = /:(\d+),(\d+)$/.exec(r.key);
      return m && r.key === `${prefix}${tile}:${m[1]},${m[2]}` ? [{ x: Number(m[1]), y: Number(m[2]), refill_hour: r.refill_hour }] : [];
    });
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
  workerRows(account: string): WorkerRow[] {
    return this.db.prepare('SELECT * FROM homeland_workers WHERE account = ? ORDER BY slot').all(account) as unknown as WorkerRow[];
  }
  saveWorker(w: WorkerRow) {
    this.db.prepare('INSERT INTO homeland_workers (account, slot, fatigue, updated_at, sick_until) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account, slot) DO UPDATE SET fatigue = excluded.fatigue, updated_at = excluded.updated_at, sick_until = excluded.sick_until').run(w.account, w.slot, w.fatigue, w.updated_at, w.sick_until);
  }
  /** Ground a hoe has turned inside a Homeland's farm fence (the owner's account), as [x, y] tiles. */
  tilledOf(account: string): Array<[number, number]> {
    return (this.db.prepare('SELECT x, y FROM homeland_tilled WHERE account = ? ORDER BY y, x').all(account) as Array<{ x: number; y: number }>).map((r) => [r.x, r.y]);
  }
  addTilled(account: string, x: number, y: number): boolean {
    return Number(this.db.prepare('INSERT OR IGNORE INTO homeland_tilled (account, x, y) VALUES (?, ?, ?)').run(account, x, y).changes) > 0;
  }
  pantryOf(account: string): { pantry: number; tick_at: number } | undefined {
    return this.db.prepare('SELECT pantry, tick_at FROM homeland_pantry WHERE account = ?').get(account) as { pantry: number; tick_at: number } | undefined;
  }
  savePantry(account: string, pantry: number, tickAt: number) {
    this.db.prepare('INSERT INTO homeland_pantry (account, pantry, tick_at) VALUES (?, ?, ?) ON CONFLICT(account) DO UPDATE SET pantry = excluded.pantry, tick_at = excluded.tick_at').run(account, pantry, tickAt);
  }
  homelandJobs(account: string): HomelandJobRow[] {
    return this.db.prepare('SELECT * FROM homeland_jobs WHERE account = ? ORDER BY ends_at, target').all(account) as unknown as HomelandJobRow[];
  }
  addHomelandJob(account: string, target: string, kind: string, endsAt: number, worker = 0, baseSecs = 0, startedAt = 0) {
    this.db.prepare('INSERT INTO homeland_jobs (account, target, kind, ends_at, worker, base_secs, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(account, target, kind, endsAt, worker, baseSecs, startedAt);
  }
  /** An assist: the job ends `cut` ms sooner and remembers how much was cut. */
  assistJob(account: string, target: string, cut: number) {
    this.db.prepare('UPDATE homeland_jobs SET ends_at = ends_at - ?, assisted = assisted + ? WHERE account = ? AND target = ?').run(cut, cut, account, target);
  }
  /** True when this call removed the job (so exactly one caller applies its result). */
  deleteHomelandJob(account: string, target: string): boolean {
    return Number(this.db.prepare('DELETE FROM homeland_jobs WHERE account = ? AND target = ?').run(account, target).changes) === 1;
  }
  homelandBots(account: string): Array<{ account: string; id: number; job: string; hired_at: number; house: string }> {
    return this.db.prepare('SELECT * FROM homeland_bots WHERE account = ? ORDER BY id').all(account) as unknown as Array<{ account: string; id: number; job: string; hired_at: number; house: string }>;
  }
  addHomelandBot(account: string, job: string, hiredAt: number, house = ''): number {
    const id = ((this.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM homeland_bots WHERE account = ?').get(account) as { m: number }).m) + 1;
    this.db.prepare('INSERT INTO homeland_bots (account, id, job, hired_at, house) VALUES (?, ?, ?, ?, ?)').run(account, id, job, hiredAt, house);
    return id;
  }
  furnitureLevel(account: string, key: string): number {
    return (this.db.prepare('SELECT level FROM homeland_furniture WHERE account = ? AND key = ?').get(account, key) as { level: number } | undefined)?.level ?? 0;
  }
  setFurnitureLevel(account: string, key: string, level: number) {
    this.db.prepare('INSERT INTO homeland_furniture (account, key, level) VALUES (?, ?, ?) ON CONFLICT(account, key) DO UPDATE SET level = excluded.level').run(account, key, level);
  }
  cosmeticsOf(account: string): Record<number, string> {
    const r: Record<number, string> = {};
    for (const x of this.db.prepare('SELECT slot, cosmetic FROM homeland_cosmetics WHERE account = ?').all(account) as unknown as Array<{ slot: number; cosmetic: string }>) r[x.slot] = x.cosmetic;
    return r;
  }
  setCosmetic(account: string, slot: number, cosmetic: string) {
    this.db.prepare('INSERT INTO homeland_cosmetics (account, slot, cosmetic) VALUES (?, ?, ?) ON CONFLICT(account, slot) DO UPDATE SET cosmetic = excluded.cosmetic').run(account, slot, cosmetic);
  }
  forageOf(account: string): { last: number; carry: number } | undefined {
    return this.db.prepare('SELECT last, carry FROM homeland_forage WHERE account = ?').get(account) as { last: number; carry: number } | undefined;
  }
  setForage(account: string, last: number, carry: number) {
    this.db.prepare('INSERT INTO homeland_forage (account, last, carry) VALUES (?, ?, ?) ON CONFLICT(account) DO UPDATE SET last = excluded.last, carry = excluded.carry').run(account, last, carry);
  }
  homelandInvites(id: number): string[] {
    return (this.db.prepare('SELECT account FROM homeland_invites WHERE id = ? ORDER BY account').all(id) as unknown as Array<{ account: string }>).map((r) => r.account);
  }
  /** The invite list with each guest's role. */
  homelandInviteRoles(id: number): Array<{ account: string; role: string }> {
    return this.db.prepare('SELECT account, role FROM homeland_invites WHERE id = ? ORDER BY account').all(id) as unknown as Array<{ account: string; role: string }>;
  }
  /** Replaces the list; an account that stays keeps its role, a new one starts as a visitor. */
  setHomelandInvites(id: number, accounts: string[]) {
    this.tx(() => {
      const keep = new Map(this.homelandInviteRoles(id).map((r) => [r.account, r.role]));
      this.db.prepare('DELETE FROM homeland_invites WHERE id = ?').run(id);
      const st = this.db.prepare('INSERT OR IGNORE INTO homeland_invites (id, account, role) VALUES (?, ?, ?)');
      for (const a of accounts) st.run(id, a, keep.get(a) ?? 'visitor');
    });
  }
  /** Units this account took in one world today from gathering and monsters (ledger refs start with `<wid>:`). */
  guestTaken(day: number, account: string, wid: string): number {
    const r = this.db.prepare("SELECT COALESCE(SUM(delta),0) AS n FROM ledger WHERE day = ? AND account = ? AND delta > 0 AND kind IN ('gather','monster_bonus','monster_drop') AND ref LIKE ?").get(day, account, `${wid}:%`) as { n: number };
    return r.n;
  }
  setHomelandPartyRole(account: string, role: string | null) { this.db.prepare('UPDATE homelands SET party_role = ? WHERE account = ?').run(role, account); }
  /** Homelands whose invite list holds this account, with the invite role. */
  homelandsInvitedTo(account: string): Array<HomelandRow & { role: string }> {
    return this.db.prepare('SELECT h.*, v.role AS role FROM homelands h JOIN homeland_invites v ON v.id = h.id WHERE v.account = ? ORDER BY h.id').all(account).map((r) => ({ ...this.homelandRow(r)!, role: String((r as { role: unknown }).role) }));
  }
}
