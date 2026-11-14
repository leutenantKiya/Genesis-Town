// Admin "Bot warga" view: the townsfolk's shared wallet (game/residents.ts) under the admin's hand.
//  - GET  /api/admin/bots?days=     the wallet, where its coin came from (treasury handouts, faucet) and went (each
//                                   merchant, each resident), what every resident may buy from, the latest movements;
//  - POST /api/admin/bots           {paused: bool} stops or restarts the town's shopping, {resident, merchants: [ids] |
//                                   null} sets which merchants that resident may buy from (null = all), {maxPriceMult:
//                                   number | null} sets the town's price ceiling (x a good's base value; null = the config's);
//  - GET  /api/admin/trace?account=&days=   where any account's coin came from and went to, by counterpart: the other
//                                   side of each ledger row (see `other` below), so a coin can be followed hop by hop.
// Only the game's books (the ledger) are read: on-chain moves (Pasar listings, gifts, shares) are not in it.
import { HttpError } from './auth.ts';
import type { Game } from './game/game.ts';
import type { Social } from './social.ts';

const MAX_DAYS = 60, RECENT = 40, TOP = 40, SCAN = 20_000, MULT_MIN = 1, MULT_MAX = 5;
type Flow = { account: string | null; name: string; kind: string; amount: number; count: number };

export class AdminBots {
  private d: { game: Game; social: Social };
  constructor(d: { game: Game; social: Social }) { this.d = d; }

  private get gs() { return this.d.game.gs; }
  private get res() { return this.d.game.residents; }

  /** First game day inside the window (`days` back from today; 0 or missing = from day 0). */
  private since(days: unknown): number {
    const n = Math.floor(Number(days));
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.max(0, this.d.game.clock.time().settleDay - Math.min(n, MAX_DAYS) + 1);
  }

  /** A readable name for any account the ledger mentions. */
  name(account: string | null): string {
    if (!account) return '?';
    const { market, town } = this.d.game;
    if (account === town) return 'Town treasury';
    if (account === this.res.wallet) return 'Townsfolk wallet';
    for (const id of market.ids()) if (market.account(id) === account) return `${market.def(id).name} · ${market.def(id).shop}`;
    const r = this.res.walkers.find((w) => this.res.account(w.id) === account);
    if (r) return r.name;
    const nick = this.d.social.nick(account), tag = this.d.social.tag(account);
    return nick ? nick + (tag ? '#' + tag : '') : account;
  }

  status(days: unknown) {
    const { gs, res } = this, { market } = this.d.game, from = this.since(days), w = res.wallet, ctl = res.controls();
    const rows = gs.db.prepare("SELECT seq, kind, delta, ref, day, created_at FROM ledger WHERE account = ? AND token = 'coin' AND day >= ? ORDER BY seq DESC LIMIT ?")
      .all(w, from, SCAN) as Array<{ seq: number; kind: string; delta: number; ref: string | null; day: number; created_at: number }>;
    const inflow = { treasury: 0, faucet: 0, other: 0 }, byMerchant: Record<string, { coin: number; units: number }> = {};
    const per: Record<string, { spent: number; units: number; byMerchant: Record<string, number>; last: { merchant: string; token: string; coin: number; at: number } | null }> = {};
    for (const x of res.walkers) per[x.id] = { spent: 0, units: 0, byMerchant: {}, last: null };
    for (const r of rows) {
      if (r.delta > 0) { if (r.kind === 'handout') inflow.treasury += r.delta; else if (r.kind === 'handout_mint') inflow.faucet += r.delta; else inflow.other += r.delta; continue; }
      if (r.kind !== 'resident_buy' || !r.ref) continue;
      const [rid, mid, token] = r.ref.split(':'), coin = -r.delta;
      const m = byMerchant[mid] ?? (byMerchant[mid] = { coin: 0, units: 0 }); m.coin += coin; m.units += 1;
      const p = per[rid]; if (!p) continue;
      p.spent += coin; p.units += 1; p.byMerchant[mid] = (p.byMerchant[mid] ?? 0) + coin;
      if (!p.last) p.last = { merchant: mid, token, coin, at: r.created_at }; // rows come newest first
    }
    const label = (r: { kind: string; ref: string | null }) => {
      if (r.kind === 'resident_buy' && r.ref) { const [rid, mid, token] = r.ref.split(':'); return { who: res.walkers.find((x) => x.id === rid)?.name ?? rid, to: market.ids().includes(mid) ? market.def(mid).name : mid, token }; }
      if (r.kind === 'handout') return { who: null, to: 'Town treasury', token: null };
      if (r.kind === 'handout_mint') return { who: null, to: 'Faucet (new coin)', token: null };
      return { who: null, to: r.ref, token: null };
    };
    return {
      wallet: { account: w, coin: gs.balance(w, 'coin'), chain: gs.settledBalance(w, 'coin'), ready: res.ready, target: res.cfg.target, treasuryReserve: res.cfg.treasuryReserve },
      enabled: res.cfg.enabled, paused: ctl.paused, from, scanned: rows.length, truncated: rows.length >= SCAN,
      inflow, spent: Object.values(byMerchant).reduce((s, m) => s + m.coin, 0),
      merchants: market.ids().map((id) => ({ id, name: market.def(id).name, shop: market.def(id).shop, account: market.account(id), open: market.isOpen(id), coin: byMerchant[id]?.coin ?? 0, units: byMerchant[id]?.units ?? 0 })),
      residents: res.walkers.map((x) => ({ id: x.id, name: x.name, look: x.look, account: res.account(x.id), allow: ctl.allow[x.id] ?? null, ...per[x.id] })),
      recent: rows.slice(0, RECENT).map((r) => ({ seq: r.seq, day: r.day, at: r.created_at, kind: r.kind, coin: r.delta, ...label(r) })),
      price: this.price(),
    };
  }

  /** The town's price ceiling and, for each good the town needs, every merchant's ask against it: does the town buy now? */
  price() {
    const { market, econ, gs } = this.d.game, mult = market.priceMult();
    return {
      mult, default: econ.town.maxPriceMult, min: MULT_MIN, max: MULT_MAX,
      goods: Object.keys(econ.town.dailyUnits).map((token) => {
        const base = econ.items[token].base, ceiling = Math.floor(mult * base), withdrawn = market.trend.withdrawn(token);
        const offers = market.ids().filter((id) => market.def(id).sells.includes(token)).map((id) => {
          const ask = market.row(id, token).ask, stock = gs.balance(market.account(id), token), open = market.isOpen(id);
          const why = !open ? 'closed' : withdrawn ? 'withdrawn' : stock < 1 ? 'empty' : ask > mult * base ? 'expensive' : !this.res.canBuyFrom(id) ? 'blocked' : null;
          return { id, name: market.def(id).name, ask, stock, why };
        });
        return { token, name: econ.items[token].name, base, ceiling, buys: offers.some((o) => !o.why), offers };
      }),
    };
  }

  /** Admin controls: pause the shopping, or set one resident's merchants (null = all). */
  control(body: Record<string, unknown>) {
    const { res } = this, { market } = this.d.game, ctl = res.controls();
    if ('maxPriceMult' in body) {
      const v = body.maxPriceMult;
      if (v === null) this.gs.setMeta('town.maxPriceMult', '');
      else {
        const n = Number(v);
        if (typeof v !== 'number' || !Number.isFinite(n) || n < MULT_MIN || n > MULT_MAX) throw new HttpError(400, `maxPriceMult must be between ${MULT_MIN} and ${MULT_MAX}.`);
        this.gs.setMeta('town.maxPriceMult', String(Math.round(n * 100) / 100));
      }
      return this.status(1);
    }
    if (typeof body.paused === 'boolean') ctl.paused = body.paused;
    else if (typeof body.resident === 'string') {
      const id = body.resident;
      if (!res.walkers.some((x) => x.id === id)) throw new HttpError(404, 'No such resident.');
      if (body.merchants === null) delete ctl.allow[id];
      else if (Array.isArray(body.merchants)) {
        const ids = market.ids(), pick = [...new Set(body.merchants.map(String))];
        if (pick.some((m) => !ids.includes(m))) throw new HttpError(400, 'Unknown merchant.');
        if (pick.length === ids.length) delete ctl.allow[id]; else ctl.allow[id] = pick;
      } else throw new HttpError(400, 'merchants must be a list of merchant ids or null');
    } else throw new HttpError(400, 'Send {paused}, {resident, merchants} or {maxPriceMult}.');
    res.setControls(ctl);
    return this.status(1);
  }

  /** Where one account's coin came from and went to inside the window, grouped by counterpart and kind. */
  trace(account: unknown, days: unknown) {
    const acct = typeof account === 'string' ? account.trim().slice(0, 100) : '';
    if (!acct) throw new HttpError(400, 'account required');
    const { gs, res } = this, { market, town } = this.d.game, from = this.since(days);
    // The other side of a coin row: rows of one move are written together (same kind, same millisecond, opposite sign,
    // usually the same ref), so the nearest such row of another account is the counterpart. Kinds whose two sides differ
    // are read from the ref instead (below).
    const joined = gs.db.prepare(`SELECT m.seq, m.kind, m.delta, m.ref, p.seq AS pseq, p.account AS other, p.ref AS pref
      FROM (SELECT * FROM ledger WHERE account = ? AND token = 'coin' AND day >= ? ORDER BY seq DESC LIMIT ?) m
      LEFT JOIN ledger p ON p.seq BETWEEN m.seq - 8 AND m.seq + 8 AND p.token = 'coin' AND p.account <> m.account
        AND p.kind = m.kind AND p.created_at = m.created_at AND (p.delta > 0) <> (m.delta > 0)`)
      .all(acct, from, SCAN) as Array<{ seq: number; kind: string; delta: number; ref: string | null; pseq: number | null; other: string | null; pref: string | null }>;
    // one row per ledger row: the candidate with the same ref first, then the nearest
    const best = new Map<number, (typeof joined)[number]>();
    const score = (x: (typeof joined)[number]) => x.pseq == null ? Infinity : (x.pref === x.ref ? 0 : 100) + Math.abs(x.pseq - x.seq);
    for (const x of joined) { const b = best.get(x.seq); if (!b || score(x) < score(b)) best.set(x.seq, x); }
    const rows = [...best.values()];
    const merchantAcct = (id: string) => (market.ids().includes(id) ? market.account(id) : null);
    const groups = new Map<string, Flow & { dir: 'in' | 'out' }>();
    let totalIn = 0, totalOut = 0;
    for (const r of rows) {
      let other = r.other, name: string | null = null;
      if (r.kind === 'resident_buy' && r.ref) other = merchantAcct(r.ref.split(':')[1]);
      else if (r.kind === 'resident_sale') other = res.wallet;
      else if (r.kind === 'handout') other = acct === town ? res.wallet : town;
      else if (r.kind === 'handout_mint') name = 'Faucet (new coin)';
      else if (r.kind === 'town_buy') name = 'Town demand (new coin)';
      else if (!other && r.ref && r.ref.includes('.') && !r.ref.includes(':')) other = r.ref; // refs that are an account id (starter, handout)
      const dir = r.delta > 0 ? 'in' : 'out', key = `${dir}|${r.kind}|${other ?? name ?? ''}`;
      const g = groups.get(key) ?? { dir, account: other, name: name ?? (other ? this.name(other) : 'Unknown'), kind: r.kind, amount: 0, count: 0 };
      g.amount += Math.abs(r.delta); g.count += 1; groups.set(key, g);
      if (r.delta > 0) totalIn += r.delta; else totalOut -= r.delta;
    }
    const pick = (dir: 'in' | 'out') => [...groups.values()].filter((g) => g.dir === dir).sort((a, b) => b.amount - a.amount).slice(0, TOP)
      .map(({ dir: _d, ...g }) => g);
    return {
      account: acct, name: this.name(acct), from, coin: gs.balance(acct, 'coin'), totalIn, totalOut,
      inflow: pick('in'), outflow: pick('out'), rows: rows.length, truncated: rows.length >= SCAN,
    };
  }
}
