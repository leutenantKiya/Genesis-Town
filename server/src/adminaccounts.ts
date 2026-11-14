// Admin "Akun" view (GET /api/admin/accounts, /api/admin/wallet): every account that holds a wallet in the game, grouped
// as admins, players and NPCs (the merchants and the town treasury), filterable by name, and one account's wallet: each
// token's balance in the game books (settled + today's moves) and on chain as of the last settlement. Read-only.
import { HttpError } from './auth.ts';
import type { Store } from './db.ts';
import type { Game } from './game/game.ts';

export type AccountRole = 'admin' | 'player' | 'npc';
export interface AccountRow { account: string; name: string; tag: string | null; role: AccountRole; coin: number; lastSeen: number | null }

const MAX_ROWS = 300;

export class AdminAccounts {
  private d: { game: Game; store: Store; admins: () => string[] };
  constructor(d: { game: Game; store: Store; admins: () => string[] }) { this.d = d; }

  /** The NPC accounts: each merchant (by its shop's keeper name) and the town treasury. */
  private npcs(): Array<{ account: string; name: string }> {
    const { market, town } = this.d.game;
    const rows = market.ids().map((id) => ({ account: market.account(id), name: `${market.def(id).name} · ${market.def(id).shop}` }));
    rows.push({ account: town, name: 'Town treasury' });
    return rows;
  }

  /** Every account, admins first, then players, then NPCs; `q` filters by name, name#tag or account id (case-insensitive). */
  list(q: unknown): { rows: AccountRow[]; total: number; shown: number } {
    const { game, store } = this.d, admins = new Set(this.d.admins());
    const needle = typeof q === 'string' ? q.trim().toLowerCase().slice(0, 60) : '';
    const all: AccountRow[] = [];
    for (const p of store.playersWithSeen()) {
      const name = store.nameOf(p.account_id) ?? '', tag = store.tagOf(p.account_id) ?? null;
      all.push({ account: p.account_id, name, tag, role: admins.has(p.account_id) ? 'admin' : 'player', coin: game.gs.balance(p.account_id, 'coin'), lastSeen: p.last_seen });
    }
    for (const n of this.npcs()) all.push({ account: n.account, name: n.name, tag: null, role: 'npc', coin: game.gs.balance(n.account, 'coin'), lastSeen: null });
    const hit = needle ? all.filter((r) => `${r.name}#${r.tag ?? ''} ${r.account}`.toLowerCase().includes(needle)) : all;
    const order: Record<AccountRole, number> = { admin: 0, player: 1, npc: 2 };
    hit.sort((a, b) => order[a.role] - order[b.role] || a.name.localeCompare(b.name) || a.account.localeCompare(b.account));
    return { rows: hit.slice(0, MAX_ROWS), total: hit.length, shown: Math.min(hit.length, MAX_ROWS) };
  }

  /** One account's wallet: every game token it holds (or held before today's moves), books and chain side by side. */
  wallet(account: unknown) {
    const { game, store } = this.d;
    const acct = typeof account === 'string' ? account.trim().slice(0, 100) : '';
    const npc = this.npcs().find((n) => n.account === acct);
    if (!acct || (!npc && !store.isPlayer(acct))) throw new HttpError(404, 'No such account.');
    const items = Object.keys(game.econ.items).map((token) => ({
      token, name: game.econ.items[token].name, books: game.gs.balance(acct, token), chain: game.gs.settledBalance(acct, token),
    })).filter((r) => r.books !== 0 || r.chain !== 0);
    const admins = new Set(this.d.admins());
    return {
      account: acct, name: npc ? npc.name : (store.nameOf(acct) ?? ''), tag: npc ? null : (store.tagOf(acct) ?? null),
      role: (npc ? 'npc' : admins.has(acct) ? 'admin' : 'player') as AccountRole, items,
    };
  }
}
