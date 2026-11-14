// Admin purge of old NEAR Auth accounts. "Old" = the owner (full-access) key was made by NEAR's shared (public) NEAR Auth
// instead of our own deployment: the key stored for the player is not the one our NEAR Auth derives for the same login
// (auth.ts isLegacyOwner). Never automatic: POST /api/admin/purge-legacy {dryRun: true} lists them, a real run deletes only
// the accounts the admin confirmed, and only ones that are on the current list.
//
// What goes: the account's game rows (names, session keys, Homeland with buildings, bots and invites, party membership,
// chips, tools, cosmetics, missions, passes, plots, open trades and offers) and its presence. What stays:
// the ledger (settled rows are history; unsettled rows still settle on chain, so the day's plan and Merkle root never change),
// `settled` and `shortfalls` (books of the chain), the Riwayat `history`, relays, market listings (on chain) and every token
// on chain. The account id is written to `retired_accounts`, so the same login is answered with "make a new account" instead of being adopted again.
// A purge is refused while a settlement runs or waits for a retry.
//
// Reset of ALL players (POST /api/admin/purge-players, 2026-11-15): the same deletion for every player account, the admins'
// own included; merchants, the townsfolk wallet and the treasury are not players and stay. These accounts are NOT retired:
// the same login signs in again, is adopted as a new player (new name, new Homeland, a starter kit) and still owns the
// tokens the chain and the ledger hold for its account.
import { HttpError, isLegacyOwner } from './auth.ts';
import type { Config } from './config.ts';
import type { Chain } from './chain.ts';
import type { Store } from './db.ts';
import type { Game } from './game/game.ts';
import type { Social } from './social.ts';

export interface PurgeCandidate {
  account: string; name: string | null; tag: string | null; nameTag: string; createdAt: number; lastSeen: number;
  coin: number; items: Record<string, number>; chips: { bought: number; won: number };
  homeland: { id: number; th: number; buildings: number; bots: number } | null;
}
export interface PurgeDeps { cfg: Config; chain: Chain; store: Store; game: Game; social: Social; invalidate?: (accounts: string[]) => void; log?: (line: string) => void }

// tables whose rows belong to one account, and the column that says which
const OWN: Array<[string, string]> = [
  ['player_state', 'account'], ['plots', 'account'], ['tool_state', 'account'], ['counters', 'account'], ['passes', 'account'],
  ['cosmetics_owned', 'account'], ['cosmetics_worn', 'account'], ['missions_done', 'account'], ['chips', 'account'], ['chip_day', 'account'],
  ['chip_cards', 'account'], ['homeland_buildings', 'account'], ['homeland_jobs', 'account'], ['homeland_bots', 'account'],
  ['homeland_workers', 'account'], ['homeland_furniture', 'account'], ['homeland_cosmetics', 'account'], ['homeland_tilled', 'account'],
  ['homeland_pantry', 'account'], ['homeland_forage', 'account'], ['popularity', 'account'],
  ['party_invites', 'account'], ['party_invites', 'from_acct'], ['homeland_invites', 'account'], ['homelands', 'account'],
  ['session_keys', 'account_id'], ['active_keys', 'account_id'], ['names', 'account'], ['players', 'account_id'],
];

export class Purge {
  d: PurgeDeps;
  constructor(d: PurgeDeps) { this.d = d; }

  /** A settlement is running, or a failed day waits for its retry: the books must not change under it. */
  settling(): boolean { const s = this.d.game.settlement; return s.busy || s.retry.size > 0; }

  /** Every player (not an admin) whose owner key is not the one our NEAR Auth derives. `unknown`: players the chain could not be asked about. */
  async candidates(): Promise<{ list: PurgeCandidate[]; checked: number; unknown: number }> {
    const { store, chain, cfg } = this.d;
    if (!cfg.fastAuth.enabled) throw new HttpError(409, 'The FASTAUTH_* settings are missing, so every account would look old.');
    const players = store.playersWithSeen().filter((p) => !cfg.adminAccounts.includes(p.account_id));
    const hits: typeof players = [];
    let unknown = 0;
    for (let i = 0; i < players.length; i += 8) {
      await Promise.all(players.slice(i, i + 8).map(async (p) => {
        try { if (await isLegacyOwner(chain, p)) hits.push(p); } catch { unknown++; }
      }));
    }
    hits.sort((a, b) => a.created_at - b.created_at);
    return { list: hits.map((p) => this.describe(p.account_id, p.created_at, p.last_seen)), checked: players.length, unknown };
  }

  private describe(account: string, createdAt: number, lastSeen: number): PurgeCandidate {
    const { store, game } = this.d, gs = game.gs;
    const name = store.nameOf(account), tag = name ? store.tagOf(account) : null;
    const items: Record<string, number> = {};
    for (const t of Object.keys(game.econ.items)) { const n = gs.balance(account, t); if (t !== 'coin' && n > 0) items[t] = n; }
    const ch = gs.db.prepare('SELECT bought, won FROM chips WHERE account = ?').get(account) as { bought: number; won: number } | undefined;
    const hl = gs.db.prepare('SELECT id, th FROM homelands WHERE account = ?').get(account) as { id: number; th: number } | undefined;
    const count = (sql: string) => (gs.db.prepare(sql).get(account) as { n: number }).n;
    return {
      account, name, tag, nameTag: name ? `${name}#${tag}` : account, createdAt, lastSeen,
      coin: gs.balance(account, 'coin'), items, chips: { bought: ch?.bought ?? 0, won: ch?.won ?? 0 },
      homeland: hl ? { id: hl.id, th: hl.th, buildings: count('SELECT COUNT(*) AS n FROM homeland_buildings WHERE account = ?'), bots: count('SELECT COUNT(*) AS n FROM homeland_bots WHERE account = ?') } : null
    };
  }

  /** Every player account (admins too), for the reset of all players. */
  everyone(): PurgeCandidate[] { return this.d.store.playersWithSeen().map((p) => this.describe(p.account_id, p.created_at, p.last_seen)); }
  dryRunAll() { const list = this.everyone(); return { dryRun: true, accounts: list, checked: list.length, unknown: 0, settling: this.settling() }; }
  /** Deletes exactly `accounts` (each a player now), without retiring them: the same login can start again. */
  runAll(by: string, accounts: unknown) {
    const asked = this.asked(accounts, 5000);
    if (this.settling()) throw new HttpError(409, 'Settlement is running. Try again when it is done.');
    const known = new Map(this.everyone().map((c) => [c.account, c]));
    const bad = asked.filter((a) => !known.has(a));
    if (bad.length) throw new HttpError(409, `Not a player account (dry run again): ${bad.slice(0, 5).join(', ')}`);
    return this.wipe(by, asked, known, null, 'purge-players');
  }
  private asked(accounts: unknown, max: number): string[] {
    if (!Array.isArray(accounts) || !accounts.length || accounts.length > max || accounts.some((a) => typeof a !== 'string')) throw new HttpError(400, 'accounts must list the accounts to delete (from a dry run).');
    return [...new Set(accounts as string[])];
  }

  async dryRun() {
    const { list, checked, unknown } = await this.candidates();
    return { dryRun: true, accounts: list, checked, unknown, settling: this.settling() };
  }

  /** Deletes exactly `accounts`, each of which must be on the current dry-run list. Everything is one transaction. */
  async run(by: string, accounts: unknown) {
    const asked = this.asked(accounts, 200);
    if (this.settling()) throw new HttpError(409, 'Settlement is running. Try again when it is done.');
    const { list } = await this.candidates();
    const known = new Map(list.map((c) => [c.account, c]));
    const bad = asked.filter((a) => !known.has(a));
    if (bad.length) throw new HttpError(409, `Not an old NEAR Auth account (dry run again): ${bad.join(', ')}`);
    if (this.settling()) throw new HttpError(409, 'Settlement is running. Try again when it is done.'); // started while the chain was asked
    return this.wipe(by, asked, known, 'old NEAR Auth account', 'purge-legacy');
  }

  /** The deletion itself, one transaction. `retire`: the reason written to `retired_accounts` (the login is then refused), or null to let the login start again. */
  private wipe(by: string, asked: string[], known: Map<string, PurgeCandidate>, retire: string | null, label: string) {
    const { game, store, social } = this.d, gs = game.gs;
    const have = new Set((gs.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => String(r.name)));
    const now = game.now(); // the game clock, like the trade rows it updates
    gs.tx(() => {
      for (const a of asked) {
        const c = known.get(a)!;
        game.party.leave(a);
        gs.db.prepare("UPDATE trade_sessions SET status = 'cancelled', a_ok = 0, b_ok = 0, note = 'The other player left the game.', updated_at = ? WHERE (a = ? OR b = ?) AND status IN ('invite', 'open', 'locked')").run(now, a, a);
        gs.db.prepare("UPDATE trade_offers SET status = 'cancelled' WHERE (from_acct = ? OR to_acct = ?) AND status = 'open'").run(a, a);
        gs.db.prepare('DELETE FROM homeland_invites WHERE id = (SELECT id FROM homelands WHERE account = ?)').run(a);
        for (const [table, col] of OWN) if (have.has(table)) gs.db.prepare(`DELETE FROM ${table} WHERE ${col} = ?`).run(a);
        if (retire) store.retire(a, c.name, c.tag, retire, by);
      }
    });
    for (const a of asked) {
      const c = known.get(a)!;
      social.seen.delete(a); social.lastSay.delete(a);
      game.positions?.reset(a); game.monsters?.pending.delete(a); gs.release(a); game.extras.forget(a);
      if (c.homeland) for (const k of [...game.homelands.maps.keys()]) if (k.startsWith(`${c.homeland.id}:`)) game.homelands.maps.delete(k);
      (this.d.log ?? console.log)(`${label} by ${by}: ${a} ${c.nameTag} coin=${c.coin} items=${JSON.stringify(c.items)} chips=${JSON.stringify(c.chips)} homeland=${c.homeland ? 'HL-' + c.homeland.id : 'none'}`);
    }
    this.d.invalidate?.(asked);
    return { dryRun: false, purged: asked.map((a) => known.get(a)!) };
  }
}
