// Daily settlement: at 06:00 game time, the previous ledger day is closed and written on chain.
// 1. prepare (once per day): shipping-box payouts (new coin, within the faucet) and shop rent rows;
// 2. net every (account, token) over the day's rows; Merkle root over the rows;
// 3. send `settle_day` in chunks (each chunk idempotent: skipped if already applied on chain);
// 4. finalize: mark rows settled and apply their net deltas to the cached balances (one DB transaction), close
//    bankrupt shops, pay dividends,
//    refresh shop status and coin supply, and update Riwayat.
import type { Econ } from './econ.ts';
import type { GameStore, LedgerRow } from './gamestore.ts';
import type { Clock } from './clock.ts';
import type { Market } from './market.ts';
import type { Chain, DeltaEntry } from '../chain.ts';
import type { Store } from '../db.ts';
import { leafHash, merkleRoot } from './merkle.ts';

export interface SettleDeps { econ: Econ; gs: GameStore; store: Store; chain: Chain; clock: Clock; market: Market; town: string; chunkSize: number }

const RETRY_FIRST_MS = 30_000;
const RETRY_MAX_MS = 600_000;

interface PlanChunk { entries: DeltaEntry[]; seqs: number[] }
interface Plan { root: string; active: number; chunks: PlanChunk[]; div: Array<{ account: string; amount: number }> }

/**
 * Splits net entries into chunks of at most `size`, keeping an account's entries together (unless it alone is larger
 * than a chunk) and putting accounts with the lowest coin delta first. The contract tracks a running coin net over the
 * day's chunks; with payers first it never exceeds the final net, so gross transfers don't hit the faucet.
 */
export function packChunks(entries: DeltaEntry[], size: number): DeltaEntry[][] {
  const by = new Map<string, DeltaEntry[]>();
  for (const e of entries) { if (!by.has(e.account_id)) by.set(e.account_id, []); by.get(e.account_id)!.push(e); }
  const coin = (l: DeltaEntry[]) => Number(l.find((e) => e.token_id === 'coin')?.delta ?? 0);
  const groups = [...by].map(([a, l]) => ({ a, l: [...l].sort((x, y) => Number(y.token_id === 'coin') - Number(x.token_id === 'coin')), c: coin(l) }))
    .sort((x, y) => x.c - y.c || (x.a < y.a ? -1 : 1));
  const chunks: DeltaEntry[][] = [];
  let cur: DeltaEntry[] = [];
  for (const g of groups) {
    if (cur.length && cur.length + g.l.length > size) { chunks.push(cur); cur = []; }
    for (const e of g.l) { if (cur.length >= size) { chunks.push(cur); cur = []; } cur.push(e); }
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

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
  /** Per-day retry backoff after a failed settlement (memory only): next attempt time and current delay. */
  retry = new Map<number, { until: number; delay: number }>();

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
        const r = this.retry.get(day);
        if (r && this.d.clock.now() < r.until) break;
        let ok = false;
        try { ok = await this.settleDay(day); } catch (e) { console.error(`settlement day ${day}:`, (e as Error).message); }
        if (!ok) {
          const delay = r ? Math.min(r.delay * 2, RETRY_MAX_MS) : RETRY_FIRST_MS;
          this.retry.set(day, { until: this.d.clock.now() + delay, delay });
          console.error(`settlement day ${day} not finished; next attempt in ${Math.round(delay / 1000)} s`);
          break;
        }
        this.retry.delete(day);
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
    // Rent plus storage (gudang) fees: 0.5 coin per unit held above target stock, burned. Each open shop pays what
    // it can; a shop that cannot pay in full is closed after settlement (the contract re-checks coin < rent).
    // No players that day means no customers: shops pay no rent and nobody closes, so a quiet town keeps its shops.
    const toClose: string[] = [];
    const idle = gs.activeAccounts(day) === 0;
    for (const id of idle ? [] : market.ids()) {
      if (!market.isOpen(id)) continue;
      const acct = market.account(id);
      const d = econ.merchants[id];
      const cash = gs.balanceThrough(acct, 'coin', day);
      let over = 0;
      for (const token of market.tokens(d)) over += Math.max(0, gs.balanceThrough(acct, token, day) - (d.target[token] ?? 0));
      const storage = Math.floor(over * (econ.shops.storageFeePerUnit ?? 0));
      const due = econ.shops.rent + storage;
      const pay = Math.min(due, cash);
      if (pay > 0) gs.add(day, acct, 'coin', -pay, 'rent', storage ? `rent ${econ.shops.rent} + gudang ${storage}` : null);
      if (cash < due) toClose.push(acct);
    }
    gs.setMeta(`settle.close.${day}`, JSON.stringify(toClose));
    gs.setMeta(`settle.prepared.${day}`, '1');
  }

  /**
   * The day's settlement plan, written once and then reused by every retry: the chunks (accounts that pay coin first,
   * so the contract's running coin net never exceeds the day's final net), the ledger rows each chunk covers, the
   * root, and the dividends owed. A stable plan keeps chunk numbers meaningful after some chunks were applied.
   */
  private plan(day: number): Plan {
    const { gs, market, econ } = this.d;
    const saved = gs.meta(`settle.plan.${day}`);
    if (saved) return JSON.parse(saved) as Plan;
    const all = gs.dayRows(day);
    const open = all.filter((r) => !r.settled);
    const entries = netEntries(open);
    // A debit larger than the chain balance makes the contract refuse the chunk, and every retry would fail the same
    // way. Say so loudly (the town treasury paying starter kits is the usual cause).
    for (const e of entries) {
      if (Number(e.delta) < 0 && -Number(e.delta) > gs.settledBalance(e.account_id, e.token_id)) {
        console.error(`settlement day ${day}: ${e.account_id} owes ${-Number(e.delta)} ${e.token_id} but holds ${gs.settledBalance(e.account_id, e.token_id)} on chain`);
      }
    }
    const chunks: PlanChunk[] = packChunks(entries, this.d.chunkSize).map((e) => ({ entries: e, seqs: [] }));
    if (chunks.length === 0) chunks.push({ entries: [], seqs: [] });
    const where = new Map<string, number>();
    chunks.forEach((c, i) => c.entries.forEach((e) => where.set(`${e.account_id}|${e.token_id}`, i)));
    for (const r of open) chunks[where.get(`${r.account}|${r.token}`) ?? 0].seqs.push(r.seq);
    // Dividends: 40% of a shop's positive net coin change for the day (not for shops closing today).
    const toClose: string[] = JSON.parse(gs.meta(`settle.close.${day}`) ?? '[]');
    const div: Array<{ account: string; amount: number }> = [];
    for (const id of market.ids()) {
      const acct = market.account(id);
      if (toClose.includes(acct) || !market.isOpen(id)) continue;
      const profit = open.filter((r) => r.account === acct && r.token === 'coin').reduce((x, r) => x + r.delta, 0);
      const amount = Math.floor(profit * econ.shops.dividendShare);
      if (amount > 0) div.push({ account: acct, amount });
    }
    const plan: Plan = { root: merkleRoot(all.map(leafHash)), active: gs.activeAccounts(day), chunks, div };
    gs.setMeta(`settle.plan.${day}`, JSON.stringify(plan));
    return plan;
  }

  /**
   * Checks a not-yet-applied chunk against the chain before it is sent. A debit the chain balance cannot cover would
   * make the contract refuse the whole chunk (blocking the day for everyone), and an unregistered account's entries are
   * skipped by the contract. So: unregistered -> drop that account's entries; debit above the balance -> clamp it to
   * what the account holds; credit above the daily gain cap -> clamp it (defensive). Every change is recorded as a
   * shortfall (debits and unregistered freeze the account; cap clamps do not) and written back to the persisted plan.
   * A coin debit that is clamped means the counterpart may receive coin nobody paid; the contract's faucet bounds it.
   */
  private async preflight(day: number, c: number, plan: Plan) {
    const { gs, chain, market, econ, town } = this.d;
    const chunk = plan.chunks[c];
    const exempt = new Set<string>([town, ...market.ids().map((id) => market.account(id))]);
    const caps = econ.caps as { dailyGainPerItem: number; dailyCoinGain?: number };
    const next: DeltaEntry[] = [];
    let changed = false;
    const note = (a: string, t: string, wanted: number, applied: number, kind: string, why: string) => {
      gs.recordShortfall(day, c, a, t, wanted, applied, kind);
      console.error(`settlement shortfall day ${day} chunk ${c}: ${a} ${t} wanted ${wanted} applied ${applied} (${why})${t === 'coin' && wanted < 0 ? '; the counterpart may receive coin nobody paid' : ''}`);
    };
    for (const account of [...new Set(chunk.entries.map((e) => e.account_id))]) {
      const mine = chunk.entries.filter((e) => e.account_id === account);
      if (exempt.has(account)) { next.push(...mine); continue; }
      if (!(await chain.isRegistered(account))) {
        for (const e of mine) note(account, e.token_id, Number(e.delta), 0, 'shortfall', 'account not registered');
        changed = true;
        continue;
      }
      const debits = mine.filter((e) => Number(e.delta) < 0);
      const held = debits.length ? await chain.balances(account, debits.map((e) => e.token_id)) : [];
      for (const e of mine) {
        let d = Number(e.delta);
        const i = debits.indexOf(e);
        if (d < 0 && -d > Number(held[i])) {
          const applied = -Number(held[i]);
          note(account, e.token_id, d, applied, 'shortfall', 'chain balance too low');
          d = applied; changed = true;
        } else if (d > 0) {
          const cap = e.token_id === 'coin' ? (caps.dailyCoinGain ?? 5000) : caps.dailyGainPerItem;
          if (d > cap) { note(account, e.token_id, d, cap, 'cap_clamp', 'daily gain cap'); d = cap; changed = true; }
        }
        if (d !== 0) next.push({ ...e, delta: String(d) });
      }
    }
    if (changed) {
      chunk.entries = next;
      gs.setMeta(`settle.plan.${day}`, JSON.stringify(plan));
    }
  }

  /** Returns true when the day is fully settled. */
  async settleDay(day: number): Promise<boolean> {
    const { gs, chain, store } = this.d;
    this.prepare(day);
    const plan = this.plan(day);
    const root = plan.root;

    for (let c = 0; c < plan.chunks.length; c++) {
      const accounts = [...new Set(plan.chunks[c].entries.map((e) => e.account_id))];
      const rec = gs.settlement(day, c);
      if (rec?.status !== 'ok') {
        if (await chain.isChunkApplied(day, c)) {
          gs.saveSettlement(day, c, root, 'ok', rec?.tx_hash ?? null, accounts);
        } else {
          let res;
          try {
            // Pre-flight on every attempt: the player may have moved tokens on chain since the last one.
            await this.preflight(day, c, plan);
            res = await chain.settleDay(day, c, plan.chunks[c].entries, root, plan.active);
          } catch (e) {
            gs.saveSettlement(day, c, root, 'error', null, accounts);
            console.error(`settlement day ${day} chunk ${c}:`, (e as Error).message);
            return false;
          }
          gs.saveSettlement(day, c, root, res.ok ? 'ok' : 'failed', res.txHash, accounts);
          if (!res.ok) { console.error(`settlement day ${day} chunk ${c} failed:`, res.error); return false; }
        }
      }
      // The chunk is on chain: from now its rows are settled and its deltas are in the cached chain balances, so a
      // refresh() between chunks never counts them twice.
      const marker = `settle.applied.${day}.${c}`;
      if (!gs.meta(marker)) gs.applySettlement(plan.chunks[c].seqs, plan.chunks[c].entries, [marker, '1']);
    }

    // Finalize.
    if (!gs.meta(`settle.hist.${day}`)) {
      const entries = plan.chunks.flatMap((c) => c.entries);
      const txByAccount = new Map<string, string>();
      plan.chunks.forEach((c, i) => { const tx = gs.settlement(day, i)?.tx_hash ?? ''; for (const e of c.entries) txByAccount.set(e.account_id, tx); });
      const status = chain.mode === 'mock' ? 'mock' : 'ok';
      for (const a of [...new Set(entries.map((e) => e.account_id))].filter((x) => x.includes('.players.'))) {
        const tx = txByAccount.get(a) || null;
        store.settleOffchain(a, status, tx);
        store.addHistory(a, 'settle', `Settlement hari ${day}: ${entries.filter((e) => e.account_id === a).map((e) => `${Number(e.delta) > 0 ? '+' : ''}${e.delta} ${this.d.econ.items[e.token_id]?.name ?? e.token_id}`).join(', ')}`, status, tx, null, [...new Set(entries.filter((e) => e.account_id === a).map((e) => e.token_id))]);
      }
      gs.setMeta(`settle.hist.${day}`, '1');
    }
    if (!(await this.shops(day, plan))) return false;
    gs.setMeta('settle.through', String(day));
    return true;
  }

  /** Closes bankrupt shops and pays the planned dividends. False when a dividend must be retried. */
  private async shops(day: number, plan: Plan): Promise<boolean> {
    const { gs, chain, market } = this.d;
    if (!gs.meta(`settle.closed.${day}`)) {
      const toClose: string[] = JSON.parse(gs.meta(`settle.close.${day}`) ?? '[]');
      for (const acct of toClose) {
        const r = await chain.closeShop(acct);
        if (!r.ok) console.error('close_shop', acct, r.error);
        else market.closed.add(acct);
      }
      gs.setMeta(`settle.closed.${day}`, '1');
    }
    let complete = true;
    for (const { account, amount } of plan.div) {
      const key = `settle.div.${day}.${account}`;
      if (gs.meta(key)) continue;
      if (gs.settledBalance(account, 'coin') < amount) { gs.setMeta(key, 'skipped'); continue; }
      const r = await chain.payDividend(account, day, amount);
      if (r.ok) {
        gs.db.exec('BEGIN');
        gs.setSettled(account, 'coin', gs.settledBalance(account, 'coin') - amount);
        gs.setMeta(key, 'paid');
        gs.db.exec('COMMIT');
      } else if (/already paid/.test(r.error ?? '')) {
        await this.refresh([account]); // a crash lost the local debit; the chain has it
        gs.setMeta(key, 'paid');
      } else {
        const tries = Number(gs.meta(`${key}.tries`) ?? 0) + 1;
        gs.setMeta(`${key}.tries`, String(tries));
        console.error(`pay_dividend ${account} day ${day} (attempt ${tries}):`, r.error);
        if (tries >= 5) gs.setMeta(key, 'failed'); else complete = false;
      }
    }
    if (!complete) return false;
    await this.relief(day);
    await this.refreshShops();
    return true;
  }

  /**
   * Village relief fund (dana desa): when every shop is closed, nobody can sell for coin, so the town treasury pledges
   * the coin part of each restoration board on chain (as the town account; the town gets shares like anyone else).
   * Players still bring the goods. Keeps a reserve for new players' starter kits. At most once per game day.
   */
  async relief(day: number) {
    const { gs, chain, town, econ } = this.d;
    const shops = await chain.listShops();
    if (!shops.length || shops.some((s) => s.open) || gs.meta('relief.day') === String(day)) return [];
    gs.setMeta('relief.day', String(day));
    const reserve = (econ.starter.coin ?? 100) * 5;
    const done: Array<{ merchant: string; amount: number; tx: string }> = [];
    for (const s of shops) {
      const need = Number(s.need.find((l) => l.token_id === 'coin')?.amount ?? 0) - Number(s.pledged.find((l) => l.token_id === 'coin')?.amount ?? 0);
      const free = Math.min(gs.settledBalance(town, 'coin'), gs.balance(town, 'coin')) - reserve;
      const amount = Math.min(need, free);
      if (amount <= 0) continue;
      const r = await chain.townPledge(s.account_id, [{ token_id: 'coin', amount: String(amount) }]);
      if (!r.ok) { console.error('relief', s.account_id, r.error); continue; }
      gs.setSettled(town, 'coin', gs.settledBalance(town, 'coin') - amount);
      done.push({ merchant: s.account_id, amount, tx: r.txHash });
    }
    if (done.length) gs.setMeta('relief.last', JSON.stringify({ day, pledges: done }));
    return done;
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
