// One-time clean-up for the removed consignment stall (Titip Jual). Goods players still had in a consignment lot sit on the
// town account (ledger 'consign_in'); at startup each lot is returned to its owner with ledger rows (kind 'consign_return',
// settled with the next day like any off-chain row) and a Riwayat line, then the old table is dropped. Idempotent: with no
// `consign_lots` table there is nothing to do, and the rows and the DROP happen in one transaction.
import type { GameStore } from './gamestore.ts';
import type { Clock } from './clock.ts';

export function returnConsignedGoods(gs: GameStore, clock: Clock, town: string, nameOf: (token: string) => string, history: (account: string, summary: string, tokens: string[]) => void): number {
  const has = gs.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'consign_lots'").get();
  if (!has) return 0;
  const lots = gs.db.prepare('SELECT account, token, qty FROM consign_lots WHERE qty > 0 ORDER BY account, token').all() as unknown as Array<{ account: string; token: string; qty: number }>;
  const day = clock.time().settleDay;
  gs.tx(() => {
    for (const l of lots) {
      gs.add(day, town, l.token, -l.qty, 'consign_return', `${l.account}:${l.token}:${l.qty}`);
      gs.add(day, l.account, l.token, l.qty, 'consign_return', `consign:${l.token}:${l.qty}`);
    }
    gs.db.exec('DROP TABLE consign_lots');
  });
  for (const l of lots) history(l.account, `The consignment stall closed: ${l.qty} ${nameOf(l.token)} returned to you.`, [l.token]);
  return lots.length;
}
