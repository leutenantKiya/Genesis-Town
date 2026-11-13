// Papan Juara: the top sellers by quantity, read from the ledger. Counted: items a player sold to a merchant (ledger kind
// 'trade', ref not 'p2p:...'), items a
// player gave in a direct trade that paid them coin.
import type { GameStore } from './gamestore.ts';

export interface BoardRow { rank: number; account: string; name: string; tag: string; sold_qty: number; coin: number }
export interface Board { period: 'day' | 'all'; rows: BoardRow[]; me: BoardRow | null }

export function leaderboard(
  gs: GameStore, period: 'day' | 'all', day: number, me: string | null,
  isPlayer: (account: string) => boolean, who: (account: string) => { name: string; tag: string },
): Board {
  const rows = (period === 'day'
    ? gs.db.prepare("SELECT account, token, delta, kind, ref FROM ledger WHERE day = ? AND kind = 'trade'").all(day)
    : gs.db.prepare("SELECT account, token, delta, kind, ref FROM ledger WHERE kind = 'trade'").all()) as unknown as Array<{ account: string; token: string; delta: number; kind: string; ref: string | null }>;
  const totals = new Map<string, { qty: number; coin: number }>();
  const bump = (a: string, qty: number, coin: number) => { const t = totals.get(a) ?? { qty: 0, coin: 0 }; t.qty += qty; t.coin += coin; totals.set(a, t); };
  // direct trades: an account's items out count only when the same trade paid it coin
  const p2p = new Map<string, { account: string; out: number; coin: number }>();
  for (const r of rows) {
    if (!isPlayer(r.account)) continue;
    if (r.ref?.startsWith('p2p:')) {
      const e = p2p.get(r.account + '|' + r.ref) ?? { account: r.account, out: 0, coin: 0 };
      if (r.token === 'coin') { if (r.delta > 0) e.coin += r.delta; } else if (r.delta < 0) e.out += -r.delta;
      p2p.set(r.account + '|' + r.ref, e);
    } else if (r.token === 'coin') {
      if (r.delta > 0) bump(r.account, 0, r.delta); // merchant sale: the coin received
    } else if (r.delta < 0) bump(r.account, -r.delta, 0); // merchant sale: items out
  }
  for (const e of p2p.values()) if (e.coin > 0 && e.out > 0) bump(e.account, e.out, e.coin);
  const ranked = [...totals.entries()].filter(([, t]) => t.qty > 0)
    .sort((a, b) => b[1].qty - a[1].qty || b[1].coin - a[1].coin || (a[0] < b[0] ? -1 : 1))
    .map(([account, t], i): BoardRow => ({ rank: i + 1, account, ...who(account), sold_qty: t.qty, coin: t.coin }));
  return { period, rows: ranked.slice(0, 10), me: me ? ranked.find((r) => r.account === me) ?? null : null };
}
