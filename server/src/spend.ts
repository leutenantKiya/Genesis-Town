// Spend guard for relayed on-chain actions. Items and coins live off-chain until the 06:00 settlement, so an on-chain
// debit (send, list, pledge, buy) must not use what today's off-chain play already spent, nor what so far exists only
// off-chain. Otherwise the next settlement would hit a negative balance and fail for everyone in that chunk.
// Returns the extra accounts to refresh after the relay (the seller of a bought listing).
import type { Chain } from './chain.ts';
import type { Game } from './game/game.ts';
import { HttpError } from './auth.ts';

export function spendGuard(chain: Chain, game: Game) {
  return async (sender: string, method: string, args: Record<string, unknown>): Promise<string[]> => {
    const need = new Map<string, number>();
    const add = (t: unknown, n: unknown) => {
      const v = Math.max(0, Math.floor(Number(n) || 0));
      if (typeof t === 'string' && v > 0) need.set(t, (need.get(t) ?? 0) + v);
    };
    const extra: string[] = [];
    if (method === 'send_item' || method === 'list_item') add(args.token_id, args.amount);
    else if (method === 'restore_contribute' || method === 'project_contribute') for (const l of (args.contribution as Array<{ token_id: string; amount: string }>) ?? []) add(l.token_id, l.amount);
    else if (method === 'buy_island') add('coin', args.price);
    else if (method === 'buy_listing') {
      const l = await chain.getListing(Number(args.listing_id));
      if (!l) throw new HttpError(404, 'Lapak itu sudah tidak ada (terjual atau ditarik).');
      add('coin', Number(l.price_each) * Number(args.amount));
      extra.push(l.seller);
    }
    if (!need.size) return extra;
    await game.settlement.refresh([sender]);
    for (const [t, n] of need) {
      const name = game.econ.items[t]?.name ?? t;
      const spendable = game.gs.balance(sender, t);
      const onChain = game.gs.settledBalance(sender, t);
      if (spendable < n) throw new HttpError(409, `${name} tidak cukup: perlu ${n}, punya ${spendable}.`);
      if (onChain < n) throw new HttpError(409, `${name} di rantai baru ${onChain} (perlu ${n}). Hasil hari ini masuk ke rantai saat penyelesaian 06:00.`);
    }
    return extra;
  };
}
