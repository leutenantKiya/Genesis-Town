// Direct player-to-player trade in the public area. Off-chain like merchant trades: ledger rows (kind 'trade', ref
// 'p2p:<offer id>') settled with the day. An offer reserves nothing; every check is repeated when it is accepted, and the
// four-plus ledger rows of one trade are written in one sqlite transaction.
import { HttpError } from '../auth.ts';
import type { Econ } from './econ.ts';
import type { GameStore } from './gamestore.ts';
import type { Clock } from './clock.ts';
import type { World } from './world.ts';
import type { Pos } from './worldmap.ts';

export type Lines = Record<string, number>;
export interface OfferView {
  id: number; from: string; from_tag: string; from_account: string; to: string; to_tag: string; to_account: string;
  give: Lines; want: Lines; expires_at: number;
}
interface OfferRow { id: number; from_acct: string; to_acct: string; give: string; want: string; expires_at: number; status: string }

export interface TradeDeps {
  econ: Econ; gs: GameStore; clock: Clock; world: World; now: () => number;
  names: { nameOf(a: string): string | null; tagOf(a: string): string; accountByNameTag(n: string, t: string): string | null; isPlayer(a: string): boolean };
  /** Where a player stands: null when the server has no shared map (unit tests), else their world and last tile. */
  where: (account: string) => { world: string; pos: Pos | null } | null;
  history: (account: string, summary: string, tokens: string[]) => void;
  /** Throws 403 for a frozen account (Game.assertActive). */
  assertActive: (account: string) => void;
}

const MAX_OPEN = 10;
const NEAR = 3;

export class Trade {
  d: TradeDeps;
  constructor(d: TradeDeps) { this.d = d; }

  private name(token: string) { return this.d.econ.items[token]?.name ?? token; }

  /** Items and coin lines from a request body: known tokens, whole positive quantities, at most `maxLines` of them. */
  private lines(v: unknown, what: string): Lines {
    if (v === undefined || v === null) return {};
    if (typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, `${what} must be a list of items.`);
    const out: Lines = {};
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length > this.d.econ.trade.maxLines) throw new HttpError(400, `At most ${this.d.econ.trade.maxLines} kinds of items.`);
    for (const [t, q] of entries) {
      if (!Object.hasOwn(this.d.econ.items, t)) throw new HttpError(400, 'Unknown item.');
      if (typeof q !== 'number' || !Number.isInteger(q) || q < 1 || q > 100_000) throw new HttpError(400, 'The amount must be a positive whole number.');
      out[t] = q;
    }
    return out;
  }

  private resolve(to: unknown): string {
    const s = typeof to === 'string' ? to.trim() : '';
    if (!s) throw new HttpError(400, 'Who do you want to trade with?');
    const i = s.lastIndexOf('#');
    const acct = i > 0 ? this.d.names.accountByNameTag(s.slice(0, i), s.slice(i + 1)) : this.d.names.isPlayer(s) ? s : null;
    if (!acct) throw new HttpError(404, 'Player not found.');
    return acct;
  }

  /** Both players in the public area within 3 tiles of each other (skipped without the shared map). */
  private together(a: string, b: string) {
    const wa = this.d.where(a), wb = this.d.where(b);
    if (!wa && !wb) return;
    const ok = wa && wb && wa.world === 'public' && wb.world === 'public' && wa.pos && wb.pos
      && Math.abs(wa.pos.x - wb.pos.x) + Math.abs(wa.pos.y - wb.pos.y) <= NEAR;
    if (!ok) throw new HttpError(409, 'You both must be close together in the public area.');
  }

  private need(account: string, lines: Lines) {
    for (const [t, q] of Object.entries(lines)) if (this.d.gs.balance(account, t) < q) throw new HttpError(409, `Not enough ${this.name(t)}.`);
  }

  offer(from: string, body: { to?: unknown; give?: unknown; want?: unknown }): { id: number; expires_at: number } {
    this.d.assertActive(from);
    const to = this.resolve(body.to);
    if (to === from) throw new HttpError(400, 'You can\'t trade with yourself.');
    const give = this.lines(body.give, 'give'), want = this.lines(body.want, 'want');
    if (!Object.keys(give).length && !Object.keys(want).length) throw new HttpError(400, 'Empty offer.');
    this.together(from, to);
    this.need(from, give);
    const { gs, now } = this.d;
    const t = now();
    const open = gs.db.prepare("SELECT COUNT(*) AS n FROM trade_offers WHERE from_acct = ? AND status = 'open' AND expires_at > ?").get(from, t) as { n: number };
    if (open.n >= MAX_OPEN) throw new HttpError(409, 'Too many open offers. Cancel some first.');
    const expires = t + this.d.econ.trade.expireSecs * 1000;
    const r = gs.db.prepare('INSERT INTO trade_offers (from_acct, to_acct, give, want, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(from, to, JSON.stringify(give), JSON.stringify(want), expires, t);
    return { id: Number(r.lastInsertRowid), expires_at: expires };
  }

  private view(r: OfferRow): OfferView {
    const n = this.d.names;
    return {
      id: r.id, from: n.nameOf(r.from_acct) ?? r.from_acct, from_tag: n.tagOf(r.from_acct), from_account: r.from_acct,
      to: n.nameOf(r.to_acct) ?? r.to_acct, to_tag: n.tagOf(r.to_acct), to_account: r.to_acct,
      give: JSON.parse(r.give), want: JSON.parse(r.want), expires_at: r.expires_at,
    };
  }

  list(account: string): { incoming: OfferView[]; outgoing: OfferView[] } {
    const rows = this.d.gs.db.prepare("SELECT * FROM trade_offers WHERE status = 'open' AND expires_at > ? AND (from_acct = ? OR to_acct = ?) ORDER BY id")
      .all(this.d.now(), account, account) as unknown as OfferRow[];
    return { incoming: rows.filter((r) => r.to_acct === account).map((r) => this.view(r)), outgoing: rows.filter((r) => r.from_acct === account).map((r) => this.view(r)) };
  }

  private load(id: unknown, who: string, receiverOnly: boolean): OfferRow {
    const r = Number.isInteger(id) ? this.d.gs.db.prepare('SELECT * FROM trade_offers WHERE id = ?').get(id as number) as OfferRow | undefined : undefined;
    if (!r || (receiverOnly ? r.to_acct !== who : r.to_acct !== who && r.from_acct !== who)) throw new HttpError(404, 'Offer not found.');
    if (r.status !== 'open') throw new HttpError(409, 'The offer is already done.');
    return r;
  }

  accept(account: string, id: unknown): { toast: string } {
    const r = this.load(id, account, true);
    this.d.assertActive(r.from_acct); this.d.assertActive(r.to_acct);
    if (r.expires_at <= this.d.now()) throw new HttpError(409, 'The offer expired.');
    this.together(r.from_acct, r.to_acct);
    const give = JSON.parse(r.give) as Lines, want = JSON.parse(r.want) as Lines;
    const { gs, world } = this.d;
    return gs.tx(() => {
      // claim first: of two accepts at once exactly one flips the status
      if (Number(gs.db.prepare("UPDATE trade_offers SET status = 'done' WHERE id = ? AND status = 'open'").run(r.id).changes) !== 1) throw new HttpError(409, 'The offer is already done.');
      this.need(r.from_acct, give);
      this.need(r.to_acct, want);
      for (const [t, q] of Object.entries(give)) world.checkGain(r.to_acct, t, q - (want[t] ?? 0));
      for (const [t, q] of Object.entries(want)) world.checkGain(r.from_acct, t, q - (give[t] ?? 0));
      const day = this.d.clock.time().settleDay, ref = `p2p:${r.id}`;
      for (const [t, q] of Object.entries(give)) { gs.add(day, r.from_acct, t, -q, 'trade', ref); gs.add(day, r.to_acct, t, q, 'trade', ref); }
      for (const [t, q] of Object.entries(want)) { gs.add(day, r.to_acct, t, -q, 'trade', ref); gs.add(day, r.from_acct, t, q, 'trade', ref); }
      const fmt = (l: Lines) => Object.entries(l).map(([t, q]) => `${q} ${this.name(t)}`).join(', ') || 'none';
      const n = this.d.names;
      this.d.history(r.to_acct, `Trade with ${n.nameOf(r.from_acct) ?? r.from_acct}: receive ${fmt(give)}, give ${fmt(want)}`, [...Object.keys(give), ...Object.keys(want)]);
      this.d.history(r.from_acct, `Trade with ${n.nameOf(r.to_acct) ?? r.to_acct}: give ${fmt(give)}, receive ${fmt(want)}`, [...Object.keys(give), ...Object.keys(want)]);
      return { toast: `Trade complete: received ${fmt(give)}, gave ${fmt(want)}` };
    });
  }

  cancel(account: string, id: unknown): { ok: true } {
    const r = this.load(id, account, false);
    this.d.gs.db.prepare("UPDATE trade_offers SET status = 'cancelled' WHERE id = ? AND status = 'open'").run(r.id);
    return { ok: true };
  }
}
