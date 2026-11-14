// Merchants: off-chain trading at pricing.ts prices, hourly price ticks with reasons, merchant crafting, and town
// demand (the only source of new coin, bounded by the same faucet formula the contract enforces at settlement).
import { tick, decay, lotUnitPrice, type MarketInputs, type Personality } from '../../../economy/pricing.ts';
import type { Econ, MerchantDef } from './econ.ts';
import type { GameStore, MarketRow } from './gamestore.ts';
import type { Clock } from './clock.ts';
import { HttpError } from '../auth.ts';
import { Trend } from './trend.ts';
import type { Residents } from './residents.ts';

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
  /** What players ask on the Player Market: scales the base values below and can pull a good off the merchants' shelves. */
  trend: Trend;

  /** The townsfolk's shared wallet (residents.ts): once registered on chain it pays for the town's shopping. */
  residents?: Residents;

  constructor(econ: Econ, gs: GameStore, clock: Clock, parent: string, town: string) {
    this.econ = econ;
    this.gs = gs;
    this.clock = clock;
    this.parent = parent;
    this.town = town;
    this.trend = new Trend(econ, gs, clock);
  }

  account(id: string): string { return `${id}.${this.parent}`; }
  ids(): string[] { return Object.keys(this.econ.merchants); }
  def(id: string): MerchantDef {
    const d = Object.hasOwn(this.econ.merchants, id) ? this.econ.merchants[id] : undefined;
    if (!d) throw new HttpError(404, 'Unknown merchant.');
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
      item: token, itemName: it.name, base: it.base * this.trend.mult(token),
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
    if (!Object.hasOwn(this.econ.items, token) || !this.tokens(d).includes(token)) throw new HttpError(404, 'Unknown item.');
    if (!Number.isInteger(qty) || qty < 1 || qty > this.econ.pricing.maxQuoteQty) throw new HttpError(400, `Amount 1-${this.econ.pricing.maxQuoteQty}.`);
    const row = this.row(id, token);
    const unit = lotUnitPrice(side === 'sell' ? 'merchant_buys' : 'merchant_sells', qty, row.mid, this.inputs(id, token, row), this.personality(d), this.econ.pricing);
    return { unit, total: unit * qty };
  }

  private npcKey(acct: string, token: string, day: number) { return `npc.bought.${day}.${acct}.${token}`; }
  /** Units merchant `acct` bought from the Player Market today (npc.ts); they count against its daily buy cap. */
  npcBoughtToday(acct: string, token: string, day: number): number { return Number(this.gs.meta(this.npcKey(acct, token, day)) ?? 0); }
  addNpcBought(id: string, token: string, qty: number) {
    const acct = this.account(id), day = this.clock.time().settleDay;
    this.gs.setMeta(this.npcKey(acct, token, day), String(this.npcBoughtToday(acct, token, day) + qty));
  }
  /** How many more units of `token` merchant `id` will still buy today (the cap `sell` enforces). */
  buyRoom(id: string, token: string): number {
    const d = this.def(id), acct = this.account(id), day = this.clock.time().settleDay;
    const cap = (this.personality(d).buyCapMult ?? this.econ.pricing.dailyBuyCapPerTarget) * (d.target[token] ?? 10);
    return Math.max(0, cap - this.gs.boughtToday(acct, token, day) - this.npcBoughtToday(acct, token, day));
  }

  /** Player sells `qty` of `token` to merchant `id` (off-chain; settled at 06:00). */
  sell(account: string, id: string, token: string, qty: number) {
    const d = this.def(id);
    this.checkTrade(id, qty);
    if (!d.buys.includes(token)) throw new HttpError(409, `${d.name} doesn't buy ${this.itemName(token)}.`);
    const t = this.clock.time();
    const acct = this.account(id);
    const cap = (this.personality(d).buyCapMult ?? this.econ.pricing.dailyBuyCapPerTarget) * (d.target[token] ?? 10);
    if (this.gs.boughtToday(acct, token, t.settleDay) + this.npcBoughtToday(acct, token, t.settleDay) + qty > cap) throw new HttpError(409, `${d.name} has bought enough ${this.econ.items[token].name} today.`);
    if (this.gs.balance(account, token) < qty) throw new HttpError(409, 'You don\'t have enough.');
    const { unit, total } = this.quote(id, token, 'sell', qty);
    if (this.gs.balance(acct, 'coin') < total) throw new HttpError(409, `${d.name} doesn't have enough money.`);
    const ref = `${id}:${token}:${qty}@${unit}`;
    this.gs.add(t.settleDay, account, token, -qty, 'trade', ref);
    this.gs.add(t.settleDay, account, 'coin', total, 'trade', ref);
    this.gs.add(t.settleDay, acct, token, qty, 'trade', ref);
    this.gs.add(t.settleDay, acct, 'coin', -total, 'trade', ref);
    const row = this.row(id, token);
    row.bought += qty;
    this.gs.saveMarket(row);
    return { toast: `Sold ${qty} ${this.econ.items[token].name} to ${d.name}: +${total} coins`, unit, total };
  }

  /** Player buys `qty` of `token` from merchant `id`. */
  buy(account: string, id: string, token: string, qty: number) {
    const d = this.def(id);
    this.checkTrade(id, qty);
    if (!d.sells.includes(token)) throw new HttpError(409, `${d.name} doesn't sell ${this.itemName(token)}.`);
    if (this.trend.withdrawn(token)) throw new HttpError(409, `${d.name} isn't offering ${this.itemName(token)} right now: the Player Market price is far from normal.`);
    const t = this.clock.time();
    const acct = this.account(id);
    if (this.gs.balance(acct, token) < qty) throw new HttpError(409, `${d.name} is out of stock.`);
    const { unit, total } = this.quote(id, token, 'buy', qty);
    if (this.gs.balance(account, 'coin') < total) throw new HttpError(409, 'You don\'t have enough coins.');
    const ref = `${id}:${token}:${qty}@${unit}`;
    this.gs.add(t.settleDay, account, token, qty, 'trade', ref);
    this.gs.add(t.settleDay, account, 'coin', -total, 'trade', ref);
    this.gs.add(t.settleDay, acct, token, -qty, 'trade', ref);
    this.gs.add(t.settleDay, acct, 'coin', total, 'trade', ref);
    const row = this.row(id, token);
    row.sold += qty;
    this.gs.saveMarket(row);
    return { toast: `Bought ${qty} ${this.econ.items[token].name} from ${d.name}: -${total} coins`, unit, total };
  }

  private itemName(token: string): string { return Object.hasOwn(this.econ.items, token) ? this.econ.items[token].name : token; }

  private checkTrade(id: string, qty: number) {
    if (!this.isOpen(id)) throw new HttpError(409, `The shop of ${this.def(id).name} is CLOSED.`);
    if (!Number.isInteger(qty) || qty < 1 || qty > this.econ.pricing.maxQuoteQty) throw new HttpError(400, `Amount 1-${this.econ.pricing.maxQuoteQty}.`);
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
        if (!Object.entries(r.inputs).every(([t, n]) => this.gs.balance(acct, t) >= n) || this.gs.balance(acct, 'coin') < this.econ.craft.merchantFee) continue;
        for (const [t, n] of Object.entries(r.inputs)) this.gs.add(day, acct, t, -n, 'm_craft', out);
        this.gs.add(day, acct, out, 1, 'm_craft', out);
        this.gs.add(day, acct, 'coin', -this.econ.craft.merchantFee, 'fee', out);
        this.gs.add(day, this.town, 'coin', this.econ.craft.merchantFee, 'fee', `${out}:${id}`); // the fee goes to the town treasury
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
          .filter((id) => this.isOpen(id) && this.def(id).sells.includes(token) && !this.trend.withdrawn(token) && this.gs.balance(this.account(id), token) >= 1)
          .map((id) => ({ id, ask: this.row(id, token).ask }))
          .filter((o) => o.ask <= tw.maxPriceMult * base)
          .sort((a, b) => a.ask - b.ask);
        const best = offers[0];
        if (!best) break;
        const acct = this.account(best.id);
        if (this.residents?.ready) {
          // the townsfolk's shared wallet pays (residents.ts): coin moves wallet -> merchant, nothing new is made here
          const rid = this.residents.pay(t.settleDay, best.id, token, best.ask);
          if (rid === null) break;
          this.gs.add(t.settleDay, acct, token, -1, 'resident_sale', rid);
          this.gs.add(t.settleDay, acct, 'coin', best.ask, 'resident_sale', `${rid}:${token}`);
        } else {
          if (this.faucetLeft(t.settleDay) < best.ask) break;
          this.gs.add(t.settleDay, acct, token, -1, 'town_buy', String(best.ask));
          this.gs.add(t.settleDay, acct, 'coin', best.ask, 'town_buy', token);
        }
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
      cash: this.gs.balance(acct, 'coin'), rent: this.econ.shops.chargeRent === false ? 0 : this.econ.shops.rent,
      items: this.tokens(d).map((token) => {
        const r = this.row(id, token);
        return {
          token, name: this.econ.items[token].name, stock: this.gs.balance(acct, token), target: d.target[token] ?? 0,
          ask: d.sells.includes(token) && !this.trend.withdrawn(token) ? r.ask : null, bid: d.buys.includes(token) ? r.bid : null,
          mid: Math.round(r.mid * 100) / 100, changePct: r.change_pct, reason: r.reason,
        };
      }),
    };
  }
}
