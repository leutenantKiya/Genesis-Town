// NPC merchants on the Player Market. About every `everySecs` the server looks at the open listings on chain:
//  1. the readings go to the trend (trend.ts), which nudges the merchants' price level and can pull a good off their shelves;
//  2. each open merchant that BUYS a good may buy a player's listing of it, but only at or below its fair price (the mid
//     price from pricing.ts times `maxPayMidMult` times the cash factor), never more than a share of its cash (per buy and
//     per day), never past its daily buy cap or a stock of `maxStockOverTarget` x target, and at most `maxBuysPerRun` per look.
// The buy is one settler call, `merchant_buy_listing` (contracts/game/src/market.rs): the merchant's OWN coin on chain, the same
// escrow, 5% burn and events as a player's buy. If the contract has no such method yet (not redeployed, or the settler key may
// not call it) the feature stays off quietly and asks again after `retryMissingMinutes`.
import { cashFactor } from '../../../economy/pricing.ts';
import type { Chain, ListingInfo } from '../chain.ts';
import type { Econ } from './econ.ts';
import type { GameStore } from './gamestore.ts';
import type { Clock } from './clock.ts';
import type { Market } from './market.ts';
import type { Settlement } from './settlement.ts';

export interface NpcDeps {
  econ: Econ; gs: GameStore; clock: Clock; market: Market; settlement: Settlement; chain: Chain; now: () => number;
  /** A line in the seller's Riwayat. */
  history: (account: string, summary: string, txHash: string | null, tokens: string[]) => void;
  log?: (line: string) => void;
}

// what a contract without the method (or a settler key not allowed to call it) answers
const MISSING = /MethodNotFound|MethodResolveError|MethodNameMismatch|CodeDoesNotExist|Access Key|NotEnoughAllowance/i;

export class NpcMarket {
  d: NpcDeps;
  lastRunMs = 0;
  /** Set while the contract's method is missing (ms): nothing is asked of the chain before then. */
  missingUntil = 0;
  running = false;
  /** Told after a sale to a named seller (app.ts: Lapak popularity). */
  onSale?: (listingId: number, seller: string, units: number) => void;
  /** Told after every buy (app.ts: the goods-flying animation): merchant account, seller, good, units, coin paid. */
  onBuy?: (merchant: string, seller: string, token: string, units: number, coin: number, listingId: number) => void;
  constructor(d: NpcDeps) { this.d = d; }

  get cfg() { return this.d.econ.npcMarket; }
  /** True while the buying part is switched off by detection (method missing) rather than by config. */
  get missing(): boolean { return this.missingUntil > this.d.now(); }

  private dayKey(acct: string, day: number) { return `npc.spent.${day}.${acct}`; }
  spentToday(acct: string, day: number): number { return Number(this.d.gs.meta(this.dayKey(acct, day)) ?? 0); }

  /** The most a merchant pays per unit of `token` right now (0 when it does not buy it). */
  fairBuy(id: string, token: string): number {
    const { market, econ } = this.d, d = market.def(id);
    if (!d.buys.includes(token) || !Object.hasOwn(econ.items, token)) return 0;
    const row = market.row(id, token), inp = market.inputs(id, token, row);
    const fc = cashFactor(inp.cash, inp.rent, market.personality(d), econ.pricing);
    return Math.floor(row.mid * this.cfg.maxPayMidMult * fc);
  }

  /** How many units of a listing merchant `id` would take now (0 with a reason when none). */
  plan(id: string, l: ListingInfo): { qty: number; reason: string } {
    const { market, econ, gs, clock } = this.d, c = this.cfg, d = market.def(id), acct = market.account(id), token = l.token_id;
    const price = Number(l.price_each), have = Number(l.amount), day = clock.time().settleDay;
    if (!market.isOpen(id) || !d.buys.includes(token)) return { qty: 0, reason: 'not traded' };
    if (l.seller === acct) return { qty: 0, reason: 'own' };
    const fair = this.fairBuy(id, token);
    if (!(price >= 1) || price > fair) return { qty: 0, reason: 'above fair price' };
    const cash = gs.balance(acct, 'coin'), settled = gs.settledBalance(acct, 'coin');
    const reserve = econ.shops.rent * c.reserveRentDays;
    const spent = this.spentToday(acct, day);
    const perBuy = Math.floor((cash * c.maxCashPctPerBuy) / 100);
    const perDay = Math.floor(((cash + spent) * c.maxCashPctPerDay) / 100) - spent;
    const budget = Math.min(perBuy, perDay, cash - reserve, settled); // settled: the coin must be on chain now
    const stock = gs.balance(acct, token), target = d.target[token] ?? 10;
    const stockRoom = Math.floor(target * c.maxStockOverTarget) - stock;
    let dayUnits = 0;
    for (const t of market.tokens(d)) dayUnits += market.npcBoughtToday(acct, t, day);
    const qty = Math.min(have, market.buyRoom(id, token), stockRoom, c.maxUnitsPerDayPerMerchant - dayUnits, Math.floor(budget / price));
    return qty >= 1 ? { qty, reason: '' } : { qty: 0, reason: 'limits' };
  }

  /** One look at the open listings (rate limited by `everySecs`). Returns the units bought. Never throws. */
  async run(): Promise<number> {
    const { chain, now, settlement } = this.d, c = this.cfg;
    if (this.running || now() - this.lastRunMs < c.everySecs * 1000) return 0;
    if (!c.buyEnabled && !c.trendEnabled) return 0;
    if (settlement.busy || settlement.retry.size > 0) return 0; // balances are moving: wait for the books to settle
    this.lastRunMs = now();
    this.running = true;
    try {
      const listings = await chain.listListings(100);
      this.d.market.trend.record(listings);
      if (!c.buyEnabled || this.missing) return 0;
      return await this.buyFrom(listings);
    } catch (e) {
      this.d.log?.(`npc market: ${(e as Error).message}`);
      return 0;
    } finally { this.running = false; }
  }

  private async buyFrom(listings: ListingInfo[]): Promise<number> {
    const { market, chain, gs, clock, econ } = this.d, c = this.cfg;
    let bought = 0, buys = 0, fails = 0;
    // cheapest first: the best deals go before the cash runs out
    const open = listings.filter((l) => Number(l.amount) > 0).sort((a, b) => Number(a.price_each) - Number(b.price_each));
    for (const l of open) {
      if (buys >= c.maxBuysPerRun || fails >= 3) break;
      // the merchant that would pay most for it and has room
      let best: { id: string; qty: number; fair: number } | null = null;
      for (const id of market.ids()) {
        const p = this.plan(id, l);
        if (p.qty < 1) continue;
        const fair = this.fairBuy(id, l.token_id);
        if (!best || fair > best.fair) best = { id, qty: p.qty, fair };
      }
      if (!best) continue;
      const acct = market.account(best.id), price = Number(l.price_each), day = clock.time().settleDay;
      const r = await chain.merchantBuyListing(acct, l.id, best.qty, price);
      if (!r.ok) {
        if (MISSING.test(r.error ?? '')) {
          this.missingUntil = this.d.now() + c.retryMissingMinutes * 60_000;
          this.d.log?.('npc market: merchant_buy_listing is not available on the contract yet; buying stays off');
          break;
        }
        fails++;
        continue; // someone else bought or cancelled it first: the next look sees the new state
      }
      buys++; bought += best.qty;
      const total = price * best.qty, fee = Math.floor((total * econ.fees.marketPct) / 100);
      // the chain moved: re-read both sides (a failed read falls back to the same arithmetic on the cached balances)
      try { await this.d.settlement.refresh([acct, l.seller]); } catch {
        gs.setSettled(acct, 'coin', gs.settledBalance(acct, 'coin') - total);
        gs.setSettled(acct, l.token_id, gs.settledBalance(acct, l.token_id) + best.qty);
        gs.setSettled(l.seller, 'coin', gs.settledBalance(l.seller, 'coin') + total - fee);
      }
      market.addNpcBought(best.id, l.token_id, best.qty);
      gs.setMeta(this.dayKey(acct, day), String(this.spentToday(acct, day) + total));
      const row = market.row(best.id, l.token_id);
      row.bought += best.qty; gs.saveMarket(row);
      const name = econ.items[l.token_id].name;
      this.d.history(l.seller, `${market.def(best.id).name} bought ${best.qty} ${name} from your Market listing: +${total - fee} coins`, r.txHash || null, [l.token_id, 'coin']);
      this.onSale?.(l.id, l.seller, best.qty);
      this.onBuy?.(acct, l.seller, l.token_id, best.qty, total, l.id);
    }
    return bought;
  }
}
