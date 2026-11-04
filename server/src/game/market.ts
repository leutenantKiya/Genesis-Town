// Merchants: off-chain trading at pricing.ts prices, hourly price ticks with reasons, merchant crafting, and town
// demand (the only source of new coin, bounded by the same faucet formula the contract enforces at settlement).
import { tick, decay, lotUnitPrice, type MarketInputs, type Personality } from '../../../economy/pricing.ts';
import type { Econ, MerchantDef } from './econ.ts';
import type { GameStore, MarketRow } from './gamestore.ts';
import type { Clock } from './clock.ts';
import { HttpError } from '../auth.ts';

export interface MerchantView {
  id: string; account: string; name: string; shop: string; open: boolean; cash: number; rent: number;
  items: Array<{ token: string; name: string; stock: number; target: number; ask: number | null; bid: number | null; mid: number; changePct: number; reason: string }>;
}

export class Market {
  econ: Econ;
  gs: GameStore;
  clock: Clock;
  parent: string;
  town: string;
  closed = new Set<string>(); // merchant accounts whose shop is closed on chain

  constructor(econ: Econ, gs: GameStore, clock: Clock, parent: string, town: string) {
    this.econ = econ;
    this.gs = gs;
    this.clock = clock;
    this.parent = parent;
    this.town = town;
  }

  account(id: string): string { return `${id}.${this.parent}`; }
  ids(): string[] { return Object.keys(this.econ.merchants); }
  def(id: string): MerchantDef {
    const d = this.econ.merchants[id];
    if (!d) throw new HttpError(404, 'Pedagang tidak dikenal.');
    return d;
  }
  personality(d: MerchantDef): Personality { return this.econ.personalities[d.personality]; }
  tokens(d: MerchantDef): string[] { return [...new Set([...d.buys, ...d.sells, ...d.crafts])]; }
  isOpen(id: string): boolean { return !this.closed.has(this.account(id)); }

  inputs(id: string, token: string, row: MarketRow): MarketInputs {
    const d = this.def(id);
    const acct = this.account(id);
    const it = this.econ.items[token];
    return {
      item: token, itemName: it.name, base: it.base,
      stock: this.gs.balance(acct, token), target: d.target[token] ?? 10,
      bought: row.bought, sold: row.sold, cash: this.gs.balance(acct, 'coin'), rent: this.econ.shops.rent,
      buys: d.buys.includes(token),
    };
  }

  row(id: string, token: string): MarketRow {
    const acct = this.account(id);
    const existing = this.gs.market(acct, token);
    if (existing) return existing;
    const base = this.econ.items[token].base;
    const d = this.def(id);
    const r = tick(base, this.inputs(id, token, { merchant: acct, token, mid: base, bought: 0, sold: 0, ask: 0, bid: 0, reason: '', change_pct: 0, hour: 0 }), this.personality(d), this.econ.pricing);
    const row: MarketRow = { merchant: acct, token, mid: r.mid, bought: 0, sold: 0, ask: r.ask, bid: r.bid, reason: r.reason.text, change_pct: r.reason.changePct, hour: this.clock.hours() };
    this.gs.saveMarket(row);
    return row;
  }

  /** One pricing tick for every merchant item (called once per game hour). */
  tickAll() {
    const hour = this.clock.hours();
    for (const id of this.ids()) {
      const d = this.def(id);
      for (const token of this.tokens(d)) {
        const row = this.row(id, token);
        const n = Math.max(1, hour - row.hour);
        row.bought = decay(row.bought, this.econ.pricing, n);
        row.sold = decay(row.sold, this.econ.pricing, n);
        const r = tick(row.mid, this.inputs(id, token, row), this.personality(d), this.econ.pricing);
        Object.assign(row, { mid: r.mid, ask: r.ask, bid: r.bid, reason: r.reason.text, change_pct: r.reason.changePct, hour });
        this.gs.saveMarket(row);
      }
    }
  }

  quote(id: string, token: string, side: 'sell' | 'buy', qty: number): { unit: number; total: number } {
    const d = this.def(id);
    const row = this.row(id, token);
    const unit = lotUnitPrice(side === 'sell' ? 'merchant_buys' : 'merchant_sells', qty, row.mid, this.inputs(id, token, row), this.personality(d), this.econ.pricing);
    return { unit, total: unit * qty };
  }

  /** Player sells `qty` of `token` to merchant `id` (off-chain; settled at 06:00). */
  sell(account: string, id: string, token: string, qty: number) {
    const d = this.def(id);
    this.checkTrade(id, qty);
    if (!d.buys.includes(token)) throw new HttpError(409, `${d.name} tidak membeli ${this.econ.items[token]?.name ?? token}.`);
    const t = this.clock.time();
    const acct = this.account(id);
    const cap = (this.personality(d).buyCapMult ?? this.econ.pricing.dailyBuyCapPerTarget) * (d.target[token] ?? 10);
    if (this.gs.boughtToday(acct, token, t.settleDay) + qty > cap) throw new HttpError(409, `${d.name} sudah cukup membeli ${this.econ.items[token].name} hari ini.`);
    if (this.gs.balance(account, token) < qty) throw new HttpError(409, 'Barangmu tidak cukup.');
    const { unit, total } = this.quote(id, token, 'sell', qty);
    if (this.gs.balance(acct, 'coin') < total) throw new HttpError(409, `${d.name} tidak punya cukup uang.`);
    const ref = `${id}:${token}:${qty}@${unit}`;
    this.gs.add(t.settleDay, account, token, -qty, 'trade', ref);
    this.gs.add(t.settleDay, account, 'coin', total, 'trade', ref);
    this.gs.add(t.settleDay, acct, token, qty, 'trade', ref);
    this.gs.add(t.settleDay, acct, 'coin', -total, 'trade', ref);
    const row = this.row(id, token);
    row.bought += qty;
    this.gs.saveMarket(row);
    return { toast: `Terjual ${qty} ${this.econ.items[token].name} ke ${d.name}: +${total} koin`, unit, total };
  }

  /** Player buys `qty` of `token` from merchant `id`. */
  buy(account: string, id: string, token: string, qty: number) {
    const d = this.def(id);
    this.checkTrade(id, qty);
    if (!d.sells.includes(token)) throw new HttpError(409, `${d.name} tidak menjual ${this.econ.items[token]?.name ?? token}.`);
    const t = this.clock.time();
    const acct = this.account(id);
    if (this.gs.balance(acct, token) < qty) throw new HttpError(409, `Stok ${d.name} habis.`);
    const { unit, total } = this.quote(id, token, 'buy', qty);
    if (this.gs.balance(account, 'coin') < total) throw new HttpError(409, 'Uangmu tidak cukup.');
    const ref = `${id}:${token}:${qty}@${unit}`;
    this.gs.add(t.settleDay, account, token, qty, 'trade', ref);
    this.gs.add(t.settleDay, account, 'coin', -total, 'trade', ref);
    this.gs.add(t.settleDay, acct, token, -qty, 'trade', ref);
    this.gs.add(t.settleDay, acct, 'coin', total, 'trade', ref);
    const row = this.row(id, token);
    row.sold += qty;
    this.gs.saveMarket(row);
    return { toast: `Membeli ${qty} ${this.econ.items[token].name} dari ${d.name}: -${total} koin`, unit, total };
  }

  private checkTrade(id: string, qty: number) {
    if (!this.isOpen(id)) throw new HttpError(409, `Toko ${this.def(id).name} sedang TUTUP.`);
    if (!Number.isInteger(qty) || qty < 1 || qty > this.econ.pricing.maxQuoteQty) throw new HttpError(400, `Jumlah 1-${this.econ.pricing.maxQuoteQty}.`);
  }

  /** Merchants craft one unit per hour of an item they make, if below target and inputs are available. */
  merchantCraft() {
    const day = this.clock.time().settleDay;
    for (const id of this.ids()) {
      if (!this.isOpen(id)) continue;
      const d = this.def(id);
      const acct = this.account(id);
      for (const out of d.crafts) {
        const r = this.econ.recipes[out];
        if (!r || this.gs.balance(acct, out) >= (d.target[out] ?? 0)) continue;
        if (!Object.entries(r.inputs).every(([t, n]) => this.gs.balance(acct, t) >= n) || this.gs.balance(acct, 'coin') < r.fee) continue;
        for (const [t, n] of Object.entries(r.inputs)) this.gs.add(day, acct, t, -n, 'm_craft', out);
        this.gs.add(day, acct, out, 1, 'm_craft', out);
        this.gs.add(day, acct, 'coin', -r.fee, 'fee', out);
      }
    }
  }

  /** New coin the town may still pay today: W0 * k * (1 - M/Mcap), M = coin supply at the last settlement. */
  faucetLeft(day: number): number {
    const tw = this.econ.town;
    const supply = Number(this.gs.meta('coin.supply') ?? 0);
    const k = Math.min(tw.maxK, 1 + Math.floor(this.gs.activeAccounts(day) / tw.activePlayerDivisor));
    const mcap = tw.moneyCap0 * k;
    const allowed = supply >= mcap ? 0 : Math.floor((tw.faucetW0 * k * (mcap - supply)) / mcap);
    return Math.max(0, allowed - this.gs.newCoin(day));
  }

  /** Town buys its hourly share of daily demand from the cheapest open merchant (new coin, within the faucet). */
  townDemand() {
    const t = this.clock.time();
    const tw = this.econ.town;
    for (const [token, perDay] of Object.entries(tw.dailyUnits)) {
      const key = `town.acc.${token}`;
      let acc = Number(this.gs.meta(key) ?? 0) + (perDay * (this.econ.seasons[t.season]?.demand[token] ?? 1)) / this.econ.time.hoursPerDay;
      const base = this.econ.items[token].base;
      while (acc >= 1) {
        const offers = this.ids()
          .filter((id) => this.isOpen(id) && this.def(id).sells.includes(token) && this.gs.balance(this.account(id), token) >= 1)
          .map((id) => ({ id, ask: this.row(id, token).ask }))
          .filter((o) => o.ask <= tw.maxPriceMult * base)
          .sort((a, b) => a.ask - b.ask);
        const best = offers[0];
        if (!best || this.faucetLeft(t.settleDay) < best.ask) break;
        const acct = this.account(best.id);
        this.gs.add(t.settleDay, acct, token, -1, 'town_buy', String(best.ask));
        this.gs.add(t.settleDay, acct, 'coin', best.ask, 'town_buy', token);
        const row = this.row(best.id, token);
        row.sold += 1;
        this.gs.saveMarket(row);
        acc -= 1;
      }
      this.gs.setMeta(key, String(Math.min(acc, 5)));
    }
  }

  view(id: string): MerchantView {
    const d = this.def(id);
    const acct = this.account(id);
    return {
      id, account: acct, name: d.name, shop: d.shop, open: this.isOpen(id),
      cash: this.gs.balance(acct, 'coin'), rent: this.econ.shops.rent,
      items: this.tokens(d).map((token) => {
        const r = this.row(id, token);
        return {
          token, name: this.econ.items[token].name, stock: this.gs.balance(acct, token), target: d.target[token] ?? 0,
          ask: d.sells.includes(token) ? r.ask : null, bid: d.buys.includes(token) ? r.bid : null,
          mid: Math.round(r.mid * 100) / 100, changePct: r.change_pct, reason: r.reason,
        };
      }),
    };
  }
}
