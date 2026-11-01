// Daily settlement: at 06:00 game time, the previous ledger day is closed and written on chain.
// 1. prepare (once per day): shipping-box payouts (new coin, within the faucet) and shop rent rows;
// 2. net every (account, token) over the day's rows; Merkle root over the rows;
// 3. send `settle_day` in chunks (each chunk idempotent: skipped if already applied on chain);
// 4. finalize: mark rows settled, refresh cached balances from chain, close bankrupt shops, pay dividends,
//    refresh shop status and coin supply, and update Riwayat.
import type { Econ } from './econ.ts';
import type { GameStore, LedgerRow } from './gamestore.ts';
import type { Clock } from './clock.ts';
import type { Market } from './market.ts';
import type { Chain, DeltaEntry } from '../chain.ts';
import type { Store } from '../db.ts';
import { leafHash, merkleRoot } from './merkle.ts';

export interface SettleDeps { econ: Econ; gs: GameStore; store: Store; chain: Chain; clock: Clock; market: Market; town: string; chunkSize: number }

export function netEntries(rows: LedgerRow[]): DeltaEntry[] {
  const net = new Map<string, number>();
  for (const r of rows) net.set(`${r.account}|${r.token}`, (net.get(`${r.account}|${r.token}`) ?? 0) + r.delta);
  return [...net]
    .filter(([, d]) => d !== 0)
    .map(([k, d]) => { const [account_id, token_id] = k.split('|'); return { account_id, token_id, delta: String(d) }; })
    .sort((a, b) => (a.account_id + a.token_id < b.account_id + b.token_id ? -1 : 1));
}

export class Settlement {
  d: SettleDeps;
  busy = false;

  constructor(d: SettleDeps) { this.d = d; }

  settledThrough(): number { return Number(this.d.gs.meta('settle.through') ?? -1); }

  /** Settles every ledger day that has ended (at most 7 per call). Returns the days settled. */
  async settleDue(): Promise<number[]> {
    if (this.busy) return [];
    this.busy = true;
    const done: number[] = [];
    try {
      const upTo = this.d.clock.time().settleDay - 1;
      for (let day = this.settledThrough() + 1; day <= upTo && done.length < 7; day++) {
        if (!(await this.settleDay(day))) break;
        done.push(day);
      }
    } finally {
      this.busy = false;
    }
    return done;
  }

  private prepare(day: number) {
    const { gs, econ, market } = this.d;
    if (gs.meta(`settle.prepared.${day}`)) return;
    // Shipping box: the town pays 70% of base for each shipped item, as new coin within today's faucet.
    for (const r of gs.dayRows(day).filter((x) => x.kind === 'ship')) {
      const want = Math.floor(econ.items[r.token].base * econ.town.shippingBoxMult * -r.delta);
      const pay = Math.min(want, market.faucetLeft(day));
      if (pay > 0) gs.add(day, r.account, 'coin', pay, 'ship_pay', String(r.seq));
    }
    // Rent: each open shop pays what it can; a shop that cannot pay in full is closed after settlement.
    const toClose: string[] = [];
    for (const id of market.ids()) {
      if (!market.isOpen(id)) continue;
      const acct = market.account(id);
      const cash = gs.balanceThrough(acct, 'coin', day);
      const rent = econ.shops.rent;
      const pay = Math.min(rent, cash);
      if (pay > 0) gs.add(day, acct, 'coin', -pay, 'rent');
      if (cash < rent) toClose.push(acct);
    }
    gs.setMeta(`settle.close.${day}`, JSON.stringify(toClose));
    gs.setMeta(`settle.prepared.${day}`, '1');
  }

  /** Returns true when the day is fully settled. */
  async settleDay(day: number): Promise<boolean> {
    const { gs, chain, store } = this.d;
    this.prepare(day);
    const all = gs.dayRows(day);
    const open = all.filter((r) => !r.settled);
    const root = merkleRoot(all.map(leafHash));
    const entries = netEntries(open);
    const active = gs.activeAccounts(day);
    const chunks: DeltaEntry[][] = [];
    for (let i = 0; i < entries.length; i += this.d.chunkSize) chunks.push(entries.slice(i, i + this.d.chunkSize));
    if (chunks.length === 0) chunks.push([]);

    const txByAccount = new Map<string, string>();
    for (let c = 0; c < chunks.length; c++) {
      const accounts = [...new Set(chunks[c].map((e) => e.account_id))];
      const rec = gs.settlement(day, c);
      if (rec?.status === 'ok') { for (const a of accounts) txByAccount.set(a, rec.tx_hash ?? ''); continue; }
      if (await chain.isChunkApplied(day, c)) {
        gs.saveSettlement(day, c, root, 'ok', rec?.tx_hash ?? null, accounts);
        continue;
      }
      let res;
      try {
        res = await chain.settleDay(day, c, chunks[c], root, active);
      } catch (e) {
        gs.saveSettlement(day, c, root, 'error', null, accounts);
        console.error(`settlement day ${day} chunk ${c}:`, (e as Error).message);
        return false;
      }
      gs.saveSettlement(day, c, root, res.ok ? 'ok' : 'failed', res.txHash, accounts);
      if (!res.ok) { console.error(`settlement day ${day} chunk ${c} failed:`, res.error); return false; }
      for (const a of accounts) txByAccount.set(a, res.txHash);
    }

    // Finalize.
    gs.markSettled(open.map((r) => r.seq));
    const touched = [...new Set(entries.map((e) => e.account_id))];
    await this.refresh(touched);
    const status = chain.mode === 'mock' ? 'mock' : 'ok';
    for (const a of touched.filter((x) => x.includes('.players.'))) {
      const tx = txByAccount.get(a) ?? null;
      store.settleOffchain(a, status, tx);
      store.addHistory(a, 'settle', `Settlement hari ${day}: ${entries.filter((e) => e.account_id === a).map((e) => `${Number(e.delta) > 0 ? '+' : ''}${e.delta} ${this.d.econ.items[e.token_id]?.name ?? e.token_id}`).join(', ')}`, status, tx);
    }
    await this.shops(day, open);
    gs.setMeta('settle.through', String(day));
    return true;
  }

  private async shops(day: number, rows: LedgerRow[]) {
    const { gs, chain, market, econ } = this.d;
    const toClose: string[] = JSON.parse(gs.meta(`settle.close.${day}`) ?? '[]');
    for (const acct of toClose) {
      const r = await chain.closeShop(acct);
      if (!r.ok) console.error('close_shop', acct, r.error);
    }
    // Dividends: 40% of a shop's positive net coin change for the day.
    for (const id of market.ids()) {
      const acct = market.account(id);
      if (toClose.includes(acct) || !market.isOpen(id)) continue;
      const profit = rows.filter((r) => r.account === acct && r.token === 'coin').reduce((s, r) => s + r.delta, 0);
      const amount = Math.floor(profit * econ.shops.dividendShare);
      if (amount > 0 && gs.settledBalance(acct, 'coin') >= amount) {
        const r = await chain.payDividend(acct, day, amount);
        if (!r.ok) console.error('pay_dividend', acct, r.error);
      }
    }
    await this.refresh(market.ids().map((id) => market.account(id)));
    await this.refreshShops();
  }

  /** Re-reads settled balances from chain for the given accounts. */
  async refresh(accounts: string[]) {
    const tokens = Object.keys(this.d.econ.items);
    for (const a of accounts) {
      const b = await this.d.chain.balances(a, tokens);
      tokens.forEach((t, i) => this.d.gs.setSettled(a, t, Number(b[i])));
    }
  }

  async refreshShops() {
    const shops = await this.d.chain.listShops();
    this.d.market.closed = new Set(shops.filter((s) => !s.open).map((s) => s.account_id));
    this.d.gs.setMeta('coin.supply', await this.d.chain.coinSupply());
    return shops;
  }
}
