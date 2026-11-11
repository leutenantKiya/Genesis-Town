// Spend guard for relayed on-chain actions. Items and coins live off-chain until the 06:00 settlement, so an on-chain
// debit (send, list, pledge, buy) must not use what today's off-chain play already spent, nor what so far exists only
// off-chain. Otherwise the next settlement would hit a negative balance and fail for everyone in that chunk.
// With `reserve`, the guarded amounts are also held back from off-chain spending while the relay is in flight.
// Returns the extra accounts to refresh after the relay (the seller of a bought listing).
import type { Chain } from './chain.ts';
import type { Game } from './game/game.ts';
import { HttpError } from './auth.ts';

export function spendGuard(chain: Chain, game: Game) {
  return async (sender: string, method: string, args: Record<string, unknown>, reserve = false): Promise<string[]> => {
    const need = new Map<string, number>();
    const add = (t: unknown, n: unknown) => {
      const v = Number(n);
      if (typeof t !== 'string' || !Number.isInteger(v) || v <= 0) throw new HttpError(400, 'The amount must be a whole number greater than 0.');
      need.set(t, (need.get(t) ?? 0) + v);
    };
    const extra: string[] = [];
    if (method === 'project_contribute') {
      const r = game.econ.projects.find((p) => p.id === args.id)?.retired;
      if (r) throw new HttpError(409, `This project was halted. ${r} Donations already made can be withdrawn.`);
    }
    if (method === 'send_item' || method === 'list_item') add(args.token_id, args.amount);
    else if (method === 'restore_contribute' || method === 'project_contribute') for (const l of (args.contribution as Array<{ token_id: string; amount: string }>) ?? []) add(l.token_id, l.amount);
    else if (method === 'buy_listing') {
      const l = await chain.getListing(Number(args.listing_id));
      if (!l) throw new HttpError(404, 'That stall is gone (sold or withdrawn).');
      add('coin', Number(l.price_each) * Number(args.amount));
      extra.push(l.seller);
    }
    if (!need.size) return extra;
    await game.settlement.refresh([sender]);
    for (const [t, n] of need) {
      const name = game.econ.items[t]?.name ?? t;
      const spendable = game.gs.balance(sender, t);
      const onChain = game.gs.settledBalance(sender, t);
      if (spendable < n) throw new HttpError(409, `Not enough ${name}: need ${n}, have ${spendable}.`);
      if (onChain < n) throw new HttpError(409, `${name} on the chain is only ${onChain} (need ${n}). Today's results reach the chain at the 06:00 settlement.`);
    }
    // Hold the amounts back from off-chain play until the relay is done (the caller releases them).
    if (reserve) game.gs.reserve(sender, need);
    return extra;
  };
}
