// Titip Jual: the consignment stall. A player leaves items with the merchant and a minimum price; every game hour (also
// while the owner is offline) up to `sellPerGameHour` units per lot sell to the town at the best open merchant's buy price,
// but only when that price is at least the minimum. Deposited items sit on the town account (ledger 'consign_in'); a sale
// pays the owner as new coin within the daily faucet (kind 'consign_sale', minus the fee, which goes to the town as
// 'consign_fee'), so a lot can never sell more than was deposited.
import { HttpError } from '../auth.ts';
import type { Econ } from './econ.ts';
import type { GameStore } from './gamestore.ts';
import type { Clock } from './clock.ts';
import type { World } from './world.ts';
import type { Market } from './market.ts';

export interface Lot { token: string; qty: number; min_price: number; sold: number; earned: number }

export interface ConsignDeps {
  econ: Econ; gs: GameStore; clock: Clock; world: World; market: Market; town: string;
  /** Throws 409 unless the player stands at the stall (a no-op without the shared map). */
  atStall: (account: string) => void;
  history: (account: string, summary: string, tokens: string[]) => void;
}

export class Consign {
  d: ConsignDeps;
  constructor(d: ConsignDeps) { this.d = d; }

  private lot(account: string, token: string): Lot | undefined {
    return this.d.gs.db.prepare('SELECT token, qty, min_price, sold, earned FROM consign_lots WHERE account = ? AND token = ?').get(account, token) as Lot | undefined;
  }

  lots(account: string): Lot[] {
    return this.d.gs.db.prepare('SELECT token, qty, min_price, sold, earned FROM consign_lots WHERE account = ? ORDER BY token').all(account) as unknown as Lot[];
  }

  deposit(account: string, token: unknown, qty: unknown, minPrice: unknown): { toast: string; lots: Lot[] } {
    const { econ, gs } = this.d;
    if (typeof token !== 'string' || token === 'coin' || !Object.hasOwn(econ.items, token)) throw new HttpError(400, 'Barang tidak dikenal.');
    if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1) throw new HttpError(400, 'Jumlah harus bilangan bulat positif.');
    if (typeof minPrice !== 'number' || !Number.isInteger(minPrice) || minPrice < 1 || minPrice > 100_000) throw new HttpError(400, 'Harga minimum harus bilangan bulat positif.');
    this.d.atStall(account);
    const max = econ.consign.maxPerItem, held = this.lot(account, token)?.qty ?? 0;
    if (held + qty > max) throw new HttpError(409, `Titipan maks ${max} per barang (sudah ${held}).`);
    const name = econ.items[token].name;
    if (gs.balance(account, token) < qty) throw new HttpError(409, `${name} kurang.`);
    const day = this.d.clock.time().settleDay;
    gs.tx(() => {
      gs.add(day, account, token, -qty, 'consign_in', `consign:${token}:${qty}`);
      gs.add(day, this.d.town, token, qty, 'consign_in', `${account}:${token}:${qty}`);
      gs.db.prepare(`INSERT INTO consign_lots (account, token, qty, min_price) VALUES (?, ?, ?, ?)
        ON CONFLICT(account, token) DO UPDATE SET qty = qty + excluded.qty, min_price = excluded.min_price`).run(account, token, qty, minPrice);
    });
    const toast = `${qty} ${name} dititip ke ${econ.consign.merchant}, minimal ${minPrice} koin.`;
    this.d.history(account, toast, [token]);
    return { toast, lots: this.lots(account) };
  }

  withdraw(account: string, token: unknown): { toast: string; lots: Lot[] } {
    const { econ, gs } = this.d;
    if (typeof token !== 'string' || !Object.hasOwn(econ.items, token)) throw new HttpError(400, 'Barang tidak dikenal.');
    this.d.atStall(account);
    const lot = this.lot(account, token);
    if (!lot || lot.qty < 1) throw new HttpError(409, 'Tidak ada titipan yang bisa diambil.');
    const day = this.d.clock.time().settleDay;
    gs.tx(() => {
      gs.add(day, this.d.town, token, -lot.qty, 'consign_out', `${account}:${token}:${lot.qty}`);
      gs.add(day, account, token, lot.qty, 'consign_out', `consign:${token}:${lot.qty}`);
      gs.db.prepare('UPDATE consign_lots SET qty = 0 WHERE account = ? AND token = ?').run(account, token);
    });
    const toast = `${lot.qty} ${econ.items[token].name} diambil kembali.`;
    this.d.history(account, toast, [token]);
    return { toast, lots: this.lots(account) };
  }

  /** The best price an open merchant pays for one unit of `token` right now (0 when nobody buys). */
  bestBid(token: string): number {
    const { market, econ } = this.d;
    let best = 0;
    for (const id of market.ids()) {
      if (!market.isOpen(id) || !econ.merchants[id].buys.includes(token)) continue;
      best = Math.max(best, market.row(id, token).bid);
    }
    return best;
  }

  /** One game hour of consignment sales for every lot. */
  tick() {
    const { gs, econ, world, market, town } = this.d;
    const day = this.d.clock.time().settleDay;
    const lots = gs.db.prepare('SELECT account, token, qty, min_price FROM consign_lots WHERE qty > 0 ORDER BY account, token').all() as unknown as Array<Lot & { account: string }>;
    for (const lot of lots) {
      const unit = this.bestBid(lot.token);
      if (unit < 1 || unit < lot.min_price) continue;
      const feeOf = (k: number) => Math.floor((unit * k * econ.consign.feeBps) / 10000);
      let k = Math.min(lot.qty, econ.consign.sellPerGameHour);
      for (; k >= 1; k--) {
        if (market.faucetLeft(day) < unit * k) continue;
        try { world.checkGain(lot.account, 'coin', unit * k - feeOf(k)); } catch { continue; }
        break;
      }
      if (k < 1) continue; // faucet empty or the owner's daily coin cap reached: try again next hour
      const fee = feeOf(k), net = unit * k - fee, ref = `consign:${lot.token}:${k}@${unit}`;
      gs.tx(() => {
        gs.add(day, lot.account, 'coin', net, 'consign_sale', ref);
        if (fee > 0) gs.add(day, town, 'coin', fee, 'consign_fee', ref);
        gs.db.prepare('UPDATE consign_lots SET qty = qty - ?, sold = sold + ?, earned = earned + ? WHERE account = ? AND token = ?').run(k, k, net, lot.account, lot.token);
      });
      this.d.history(lot.account, `Titipanmu terjual: ${k} ${econ.items[lot.token].name}, +${net} koin`, [lot.token, 'coin']);
    }
  }
}
