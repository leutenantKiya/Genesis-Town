// Market trend: what players ask on the Player Market (open listings on chain) nudges the merchants' price level.
// Once per run the listings are reduced to ONE number per good: the median over sellers of each seller's median price, so a
// single seller (or a few listings by one account) cannot move it. At least `minSellers` different sellers are needed;
// the last `histLen` such readings are kept and their median is the trend. Once per game day each good's multiplier moves
// toward trend / base value by at most `maxMovePctPerDay` and stays inside [multMin, multMax]; pricing.ts then uses
// base * multiplier as the item's base value (the pricing rule itself is unchanged). When the trend sits far from normal
// (>= withdrawHighMult x or <= withdrawLowMult x base for most of the recent readings) merchants withdraw their own
// sell offers of that good until it comes back. State lives in `meta` (`npc.trend.<token>`).
import type { Econ, TrendConfig } from './econ.ts';
import type { GameStore } from './gamestore.ts';
import type { Clock } from './clock.ts';
import type { ListingInfo } from '../chain.ts';

interface State { hist: number[]; mult: number; day: number }

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** One reading from the open listings: per token the median over sellers of each seller's median price, for tokens with enough sellers. */
export function readListings(listings: ListingInfo[], minSellers: number): Record<string, number> {
  const bySeller = new Map<string, Map<string, number[]>>();
  for (const l of listings) {
    const price = Number(l.price_each);
    if (!(price > 0) || l.token_id === 'coin') continue;
    const m = bySeller.get(l.token_id) ?? new Map<string, number[]>();
    const arr = m.get(l.seller) ?? [];
    arr.push(price); m.set(l.seller, arr); bySeller.set(l.token_id, m);
  }
  const out: Record<string, number> = {};
  for (const [token, sellers] of bySeller) {
    if (sellers.size < minSellers) continue;
    out[token] = median([...sellers.values()].map(median));
  }
  return out;
}

export class Trend {
  econ: Econ;
  gs: GameStore;
  clock: Clock;
  constructor(econ: Econ, gs: GameStore, clock: Clock) { this.econ = econ; this.gs = gs; this.clock = clock; }

  get cfg(): TrendConfig { return this.econ.npcMarket.trend; }
  private on(): boolean { return this.econ.npcMarket.trendEnabled; }
  private key(token: string) { return `npc.trend.${token}`; }
  private load(token: string): State {
    try { const s = JSON.parse(this.gs.meta(this.key(token)) ?? ''); if (s && Array.isArray(s.hist)) return s as State; } catch { /* none yet */ }
    return { hist: [], mult: 1, day: -1 };
  }

  /** Feeds one reading (see readListings) and, once per game day, moves every good's multiplier. */
  record(listings: ListingInfo[]) {
    if (!this.on()) return;
    const c = this.cfg, day = this.clock.time().settleDay, read = readListings(listings, c.minSellers);
    for (const token of Object.keys(this.econ.items)) {
      if (token === 'coin') continue;
      const s = this.load(token), base = this.econ.items[token].base;
      if (read[token] !== undefined) s.hist = [...s.hist, read[token]].slice(-c.histLen);
      // the daily step, once there is enough data to read (or none today): toward the trend when there is one, else back toward 1
      if (s.day !== day && !(read[token] !== undefined && s.hist.length < 3)) {
        if (read[token] === undefined && s.hist.length) s.hist = s.hist.slice(1); // old readings fade when nobody lists
        const trendRatio = s.hist.length >= 3 ? median(s.hist) / base : 1;
        const target = Math.min(c.multMax, Math.max(c.multMin, trendRatio));
        const step = Math.max(-c.maxMovePctPerDay / 100, Math.min(c.maxMovePctPerDay / 100, target - s.mult));
        s.mult = Math.round((s.mult + step) * 1000) / 1000;
        s.day = day;
      }
      this.gs.setMeta(this.key(token), JSON.stringify(s));
    }
  }

  /** The multiplier on a good's base value (1 without data or with the feature off). */
  mult(token: string): number { return this.on() ? this.load(token).mult : 1; }

  /** The current trend price (median of recent readings), or null without enough data. */
  price(token: string): number | null {
    const s = this.load(token);
    return s.hist.length >= 3 ? median(s.hist) : null;
  }

  /** True while the trend is far above or below the normal value for most of the recent readings: merchants don't offer it themselves. */
  withdrawn(token: string): boolean {
    if (!this.on() || !Object.hasOwn(this.econ.items, token)) return false;
    const c = this.cfg, base = this.econ.items[token].base, h = this.load(token).hist;
    if (h.length < c.withdrawMinSamples) return false;
    const far = h.filter((p) => p >= base * c.withdrawHighMult || p <= base * c.withdrawLowMult).length;
    return far >= c.withdrawMinSamples && far * 2 > h.length;
  }
}
