// pricing.ts - the ONLY pricing rule in Genesis Town. Used by the live server and by the fast-forward simulator.
// Formula and worked example: docs/economy.md section 4. Constants: economy/config.json ("pricing", "personalities").
//
// Per merchant and item, once per game hour (a tick):
//   fs  = clamp((target / max(stock,1)) ^ elasticity, fsMin, fsMax)          stock factor
//   fd  = clamp(1 + w * (sold - bought) / (sold + bought + damping), ...)    demand factor (decayed volumes)
//   mid* = base * fs * fd, moved at most +-maxStepPerTick per tick, kept in [minMult, maxMult] * base
//   fc  = clamp((cash / (comfortDays * rent)) ^ (0.5 * cashSensitivity), fcMin, 1)   short on cash -> lower bids
//   ask = ceil(mid * (1 + spread/2))     bid = max(1, floor(mid * (1 - spread/2) * fc), floor(minBidMult * base))
// A personality may set minBidMult (never bid below that share of base value: a generous merchant who overpays)
// and buyCapMult (daily buy cap = buyCapMult x target stock; default from config.pricing).
// Every tick produces a one-sentence reason (Indonesian) for the tooltip.

export interface PricingConfig {
  demandWeight: number; demandDamping: number;
  fsMin: number; fsMax: number; fdMin: number; fdMax: number;
  maxStepPerTick: number; minMult: number; maxMult: number;
  fcMin: number; cashComfortDays: number; volumeHalfLifeTicks: number;
  maxQuoteQty: number;
}
export interface Personality { spread: number; elasticity: number; cashSensitivity: number; minBidMult?: number; buyCapMult?: number }

export interface MarketInputs {
  item: string;          // token id, e.g. "fish"
  itemName: string;      // UI name, e.g. "Ikan"
  base: number;          // base value in coins
  stock: number;         // merchant's current stock (settled + today)
  target: number;        // merchant's target stock
  bought: number;        // decayed units the merchant bought recently
  sold: number;          // decayed units the merchant sold recently
  cash: number;          // merchant's coins
  rent: number;          // daily rent
  buys?: boolean;        // does this merchant buy the item from players? (default yes; the cash note is only about bids)
}

export type ReasonCode = 'stock_high' | 'stock_low' | 'demand_up' | 'demand_down' | 'cash_low' | 'steady';
export interface Reason { code: ReasonCode; text: string; changePct: number; clamped: boolean }

export interface PriceState { mid: number; bought: number; sold: number }
export interface TickResult { mid: number; ask: number; bid: number; fs: number; fd: number; fc: number; reason: Reason }

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export function stockFactor(stock: number, target: number, p: Personality, c: PricingConfig): number {
  return clamp(Math.pow(target / Math.max(stock, 1), p.elasticity), c.fsMin, c.fsMax);
}

export function demandFactor(sold: number, bought: number, c: PricingConfig): number {
  return clamp(1 + c.demandWeight * (sold - bought) / (sold + bought + c.demandDamping), c.fdMin, c.fdMax);
}

export function cashFactor(cash: number, rent: number, p: Personality, c: PricingConfig): number {
  if (p.cashSensitivity <= 0) return 1;
  const comfort = Math.max(1, c.cashComfortDays * rent);
  return clamp(Math.pow(Math.max(cash, 0) / comfort, 0.5 * p.cashSensitivity), c.fcMin, 1);
}

/** Decay recent volumes by one tick (exponential, half-life in ticks). */
export function decay(v: number, c: PricingConfig, ticks = 1): number {
  return v * Math.pow(0.5, ticks / c.volumeHalfLifeTicks);
}

export function askBid(mid: number, fc: number, p: Personality, base = 0): { ask: number; bid: number } {
  const ask = Math.max(1, Math.ceil(mid * (1 + p.spread / 2)));
  const floorBid = p.minBidMult ? Math.floor(p.minBidMult * base) : 1;
  return { ask, bid: Math.min(ask - 1 > 0 ? ask - 1 : 1, Math.max(1, floorBid, Math.floor(mid * (1 - p.spread / 2) * fc))) };
}

/** One pricing tick: move the mid price toward its target, bounded, and explain why. */
export function tick(prevMid: number, m: MarketInputs, p: Personality, c: PricingConfig): TickResult {
  const fs = stockFactor(m.stock, m.target, p, c);
  const fd = demandFactor(m.sold, m.bought, c);
  const fc = cashFactor(m.cash, m.rent, p, c);
  const wanted = m.base * fs * fd;
  const stepped = clamp(wanted, prevMid * (1 - c.maxStepPerTick), prevMid * (1 + c.maxStepPerTick));
  const mid = clamp(stepped, c.minMult * m.base, c.maxMult * m.base);
  const clamped = Math.abs(stepped - wanted) > 1e-9;
  const { ask, bid } = askBid(mid, fc, p, m.base);
  return { mid, ask, bid, fs, fd, fc, reason: explain(prevMid, mid, fs, fd, fc, clamped, m) };
}

/** Price for a lot of `qty` units: the stock factor is taken at the stock midway through the lot. */
export function lotUnitPrice(side: 'merchant_buys' | 'merchant_sells', qty: number, mid: number, m: MarketInputs, p: Personality, c: PricingConfig): number {
  const q = Math.min(Math.max(1, Math.floor(qty)), c.maxQuoteQty);
  const fsNow = stockFactor(m.stock, m.target, p, c);
  const fsLot = stockFactor(side === 'merchant_buys' ? m.stock + q / 2 : Math.max(0, m.stock - q / 2), m.target, p, c);
  const lotMid = clamp(mid * fsLot / fsNow, c.minMult * m.base, c.maxMult * m.base);
  const fc = cashFactor(m.cash, m.rent, p, c);
  const { ask, bid } = askBid(lotMid, fc, p, m.base);
  return side === 'merchant_buys' ? bid : ask;
}

export function explain(prevMid: number, mid: number, fs: number, fd: number, fc: number, clamped: boolean, m: MarketInputs): Reason {
  const changePct = prevMid > 0 ? Math.round(((mid - prevMid) / prevMid) * 100) : 0;
  const dir = changePct > 0 ? `Harga naik ${changePct}%` : changePct < 0 ? `Harga turun ${-changePct}%` : 'Harga tetap';
  const tail = clamped ? ' (dibatasi 10% per jam)' : '';
  const n = m.itemName.toLowerCase();
  const stockEffect = Math.abs(Math.log(fs));
  const demandEffect = Math.abs(Math.log(fd));
  let code: ReasonCode;
  let why: string;
  if (stockEffect < 0.03 && demandEffect < 0.03 && changePct === 0) {
    code = 'steady';
    why = `Stok ${n} saya pas (${Math.round(m.stock)}, target ${m.target}).`;
  } else if (stockEffect >= demandEffect) {
    code = fs < 1 ? 'stock_high' : 'stock_low';
    why = fs < 1
      ? `Stok ${n} saya ${Math.round(m.stock)}, targetnya ${m.target}.`
      : `Stok ${n} saya tinggal ${Math.round(m.stock)}, targetnya ${m.target}.`;
  } else {
    code = fd > 1 ? 'demand_up' : 'demand_down';
    why = fd > 1 ? `Banyak yang beli ${n} akhir-akhir ini.` : `Banyak yang jual ${n} ke saya akhir-akhir ini.`;
  }
  // Short on cash only lowers what the merchant pays, so it is mentioned (after the item's own reason) only for items
  // the merchant buys. Every item then still says something about itself.
  if (fc < 0.95 && m.buys !== false) {
    if (changePct <= 0) code = 'cash_low';
    why += ` Kas saya tipis (${Math.round(m.cash)} koin), jadi tawaran beli saya rendah.`;
  }
  return { code, text: `${why} ${dir}${tail}.`, changePct, clamped };
}
