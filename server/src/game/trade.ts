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
  history: (account: string, summary: string, tokens: string[], ref?: string | null) => void;
  /** Party mates may trade at any distance in the same world. */
  party: { same(a: string, b: string): boolean };
  /** Throws 403 for a frozen account (Game.assertActive). */
  assertActive: (account: string) => void;
}

export interface SessionView {
  id: number; status: string; me: 'a' | 'b'; other: { account: string; name: string; tag: string }; self: { name: string; tag: string };
  mine: Lines; theirs: Lines; my_ok: boolean; their_ok: boolean; version: number; swap_at: number; note: string | null; world: string;
  /** Only when status is 'done': what the swap really moved, from the caller's side (`gave` left their bag, `got` arrived), and when. Both windows read it to play the trade animation. */
  result?: { gave: Lines; got: Lines; at: number };
}
interface SessionRow { id: number; a: string; b: string; world: string; a_lines: string; b_lines: string; a_ok: number; b_ok: number; version: number; status: string; swap_at: number; note: string | null; created_at: number; updated_at: number }

const ENDED_VISIBLE_MS = 30_000;
const MAX_OPEN = 10;
const NEAR = 3;

export class Trade {
  d: TradeDeps;
  /** Throws HttpError 409 (chain_check) when the chain cannot back `account`'s `tokens`; wired by app.ts to the ChainCheck. */
  verify?: (account: string, tokens: string[]) => Promise<void>;
  /** Told after a live trade really swapped (wired by app.ts to a public chat line in the trade's world). */
  onDone?: (a: string, b: string, world: string) => void;
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

  /* ------------------------------------------------------------ live sessions (two-sided, confirmed by both) */

  /** Both in the same world (public or one Homeland); strangers also within 3 tiles, party members at any distance. Skipped without the shared map. */
  private near(a: string, b: string) {
    const wa = this.d.where(a), wb = this.d.where(b);
    if (!wa && !wb) return;
    const msg = 'Stand close together in the same place (party members: anywhere in the same world).';
    if (!wa || !wb || wa.world !== wb.world) throw new HttpError(409, msg);
    if (this.d.party.same(a, b)) return;
    if (!wa.pos || !wb.pos || Math.abs(wa.pos.x - wb.pos.x) + Math.abs(wa.pos.y - wb.pos.y) > NEAR) throw new HttpError(409, msg);
  }

  private row(id: unknown): SessionRow | undefined {
    return Number.isInteger(id) ? this.d.gs.db.prepare('SELECT * FROM trade_sessions WHERE id = ?').get(id as number) as SessionRow | undefined : undefined;
  }

  /** Old invitations and idle windows become 'expired'. */
  private expire() {
    const t = this.d.now(), tr = this.d.econ.trade, db = this.d.gs.db;
    db.prepare("UPDATE trade_sessions SET status = 'expired', updated_at = ? WHERE status = 'invite' AND created_at < ?").run(t, t - tr.inviteSecs * 1000);
    db.prepare("UPDATE trade_sessions SET status = 'expired', updated_at = ? WHERE status = 'open' AND updated_at < ?").run(t, t - tr.sessionIdleSecs * 1000);
  }

  private liveOf(account: string): SessionRow | undefined {
    return this.d.gs.db.prepare("SELECT * FROM trade_sessions WHERE (a = ? OR b = ?) AND status IN ('invite', 'open', 'locked') ORDER BY id DESC LIMIT 1").get(account, account) as SessionRow | undefined;
  }

  /** A session the caller takes part in, in one of `statuses`. */
  private mine(account: string, id: unknown, statuses: string[]): SessionRow {
    this.expire();
    const r = this.row(id);
    if (!r || (r.a !== account && r.b !== account)) throw new HttpError(404, 'Trade not found.');
    if (!statuses.includes(r.status)) throw new HttpError(409, 'The trade is already over.');
    return r;
  }

  private sview(r: SessionRow, me: string): SessionView {
    const mineIsA = r.a === me, other = mineIsA ? r.b : r.a, n = this.d.names;
    return {
      id: r.id, status: r.status, me: mineIsA ? 'a' : 'b',
      other: { account: other, name: n.nameOf(other) ?? other, tag: n.tagOf(other) },
      self: { name: n.nameOf(me) ?? me, tag: n.tagOf(me) },
      mine: JSON.parse(mineIsA ? r.a_lines : r.b_lines), theirs: JSON.parse(mineIsA ? r.b_lines : r.a_lines),
      my_ok: !!(mineIsA ? r.a_ok : r.b_ok), their_ok: !!(mineIsA ? r.b_ok : r.a_ok),
      version: r.version, swap_at: r.swap_at, note: r.note, world: r.world,
      ...(r.status === 'done' ? { result: { gave: JSON.parse(mineIsA ? r.a_lines : r.b_lines), got: JSON.parse(mineIsA ? r.b_lines : r.a_lines), at: r.updated_at } } : {}),
    };
  }

  /** The caller's live session; a session that just ended (done, cancelled, expired) stays visible for a short while so the other window sees how it ended. */
  session(account: string): SessionView | null {
    this.expire();
    const live = this.liveOf(account);
    if (live) return this.sview(live, account);
    const ended = this.d.gs.db.prepare("SELECT * FROM trade_sessions WHERE (a = ? OR b = ?) AND status IN ('done', 'cancelled', 'expired') AND updated_at > ? ORDER BY id DESC LIMIT 1")
      .get(account, account, this.d.now() - ENDED_VISIBLE_MS) as SessionRow | undefined;
    return ended ? this.sview(ended, account) : null;
  }

  /** Who is in an open live trade right now (window open, countdown included; an invitation not yet joined does not count),
   *  as account -> the other account, for the presence answer: everyone in the world sees "A <-> B". */
  tradingPairs(): Map<string, string> {
    const out = new Map<string, string>();
    for (const r of this.d.gs.db.prepare("SELECT a, b, updated_at, status FROM trade_sessions WHERE status IN ('open', 'locked')").all() as unknown as Array<{ a: string; b: string; updated_at: number; status: string }>) {
      if (this.d.now() - r.updated_at > this.d.econ.trade.sessionIdleSecs * 1000) continue; // idle windows expire on the next trade call
      out.set(r.a, r.b); out.set(r.b, r.a);
    }
    return out;
  }

  /** Invitations waiting for the caller to join. */
  invites(account: string): SessionView[] {
    this.expire();
    const rows = this.d.gs.db.prepare("SELECT * FROM trade_sessions WHERE b = ? AND status = 'invite' ORDER BY id").all(account) as unknown as SessionRow[];
    return rows.map((r) => this.sview(r, account));
  }

  open(a: string, body: { to?: unknown }): SessionView {
    this.d.assertActive(a);
    const b = this.resolve(body.to);
    if (b === a) throw new HttpError(400, 'You can\'t trade with yourself.');
    this.d.assertActive(b);
    this.expire();
    if (this.liveOf(a)) throw new HttpError(409, 'You are already trading.');
    if (this.liveOf(b)) throw new HttpError(409, `${this.d.names.nameOf(b) ?? b} is already trading.`);
    this.near(a, b);
    const t = this.d.now(), w = this.d.where(a)?.world ?? 'public';
    const r = this.d.gs.db.prepare('INSERT INTO trade_sessions (a, b, world, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(a, b, w, t, t);
    return this.sview(this.row(Number(r.lastInsertRowid))!, a);
  }

  join(b: string, id: unknown): SessionView {
    this.d.assertActive(b);
    const r = this.mine(b, id, ['invite']);
    if (r.b !== b) throw new HttpError(404, 'Trade not found.');
    this.d.assertActive(r.a);
    this.near(r.a, b);
    this.d.gs.db.prepare("UPDATE trade_sessions SET status = 'open', updated_at = ? WHERE id = ?").run(this.d.now(), r.id);
    return this.sview(this.row(r.id)!, b);
  }

  /** Replaces the caller's side. Any change clears both confirmations and stops a running countdown. */
  set(account: string, id: unknown, body: { lines?: unknown }): SessionView {
    this.d.assertActive(account);
    const r = this.mine(account, id, ['open', 'locked']);
    const lines = this.lines(body.lines, 'lines');
    this.near(r.a, r.b);
    this.need(account, lines);
    this.d.gs.db.prepare(`UPDATE trade_sessions SET ${r.a === account ? 'a_lines' : 'b_lines'} = ?, a_ok = 0, b_ok = 0, version = version + 1, status = 'open', note = NULL, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(lines), this.d.now(), r.id);
    return this.sview(this.row(r.id)!, account);
  }

  /** Confirms the trade as the caller last saw it. When both have confirmed, the countdown starts. */
  ready(account: string, id: unknown, body: { version?: unknown }): SessionView {
    this.d.assertActive(account);
    const r = this.mine(account, id, ['open', 'locked']);
    if (body.version !== r.version) throw new HttpError(409, 'The trade changed. Check it again.');
    if (!Object.keys(JSON.parse(r.a_lines)).length && !Object.keys(JSON.parse(r.b_lines)).length) throw new HttpError(400, 'Empty trade.');
    this.near(r.a, r.b);
    const t = this.d.now(), isA = r.a === account;
    const aOk = isA ? 1 : r.a_ok, bOk = isA ? r.b_ok : 1;
    if (aOk && bOk) {
      if (r.status !== 'locked') this.d.gs.db.prepare("UPDATE trade_sessions SET a_ok = 1, b_ok = 1, status = 'locked', swap_at = ?, updated_at = ? WHERE id = ?").run(t + this.d.econ.trade.countdownMs, t, r.id);
    } else {
      this.d.gs.db.prepare(`UPDATE trade_sessions SET ${isA ? 'a_ok' : 'b_ok'} = 1, updated_at = ? WHERE id = ?`).run(t, r.id);
    }
    return this.sview(this.row(r.id)!, account);
  }

  /** Either side walks away (or the invitee declines). */
  close(account: string, id: unknown): SessionView {
    const r = this.mine(account, id, ['invite', 'open', 'locked']);
    this.d.gs.db.prepare("UPDATE trade_sessions SET status = 'cancelled', updated_at = ? WHERE id = ?").run(this.d.now(), r.id);
    return this.sview(this.row(r.id)!, account);
  }

  /** Swaps every locked session whose countdown has run out, without the chain check (unit tests; see finishDueChecked). Safe to call from several places: one claim wins. */
  finishDue() {
    this.expire();
    for (const { id, version } of this.due()) this.finishOne(id, version);
  }

  private due() {
    return this.d.gs.db.prepare("SELECT id, version FROM trade_sessions WHERE status = 'locked' AND swap_at <= ? ORDER BY id").all(this.d.now()) as unknown as Array<{ id: number; version: number }>;
  }

  private finishOne(id: number, version: number) {
    try {
      this.d.gs.tx(() => this.swap(id, version));
    } catch (e) {
      // nothing was written; both windows go back to 'open' with the reason
      const note = e instanceof HttpError ? e.message : 'The swap failed.';
      this.d.gs.db.prepare("UPDATE trade_sessions SET status = 'open', a_ok = 0, b_ok = 0, version = version + 1, note = ?, updated_at = ? WHERE id = ? AND status = 'locked'")
        .run(note, this.d.now(), id);
    }
  }

  /** Like finishDue, but right before each swap BOTH sides' offered tokens are compared with the chain (`verify`, set by
   *  the router). A side the chain cannot back cancels the whole trade (status 'cancelled', the 409 chain_check message
   *  as its note) and nothing moves. The check awaits the chain; the swap itself runs in the same tick as the check's
   *  end, and a trade that changed or ended meanwhile is not swapped (the claim in `swap` matches the version). */
  async finishDueChecked() {
    const verify = this.verify;
    if (!verify) return this.finishDue();
    this.expire();
    for (const { id, version } of this.due()) {
      const r = this.row(id);
      if (!r || r.status !== 'locked' || r.version !== version) continue;
      try {
        await verify(r.a, Object.keys(JSON.parse(r.a_lines)));
        await verify(r.b, Object.keys(JSON.parse(r.b_lines)));
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        this.d.gs.db.prepare("UPDATE trade_sessions SET status = 'cancelled', a_ok = 0, b_ok = 0, note = ?, updated_at = ? WHERE id = ? AND status = 'locked' AND version = ?")
          .run(e.message, this.d.now(), id, version);
        continue;
      }
      this.finishOne(id, version);
    }
  }

  private swap(id: number, version: number) {
    const { gs, world } = this.d;
    // claim first: of two finishers exactly one flips the status
    if (Number(gs.db.prepare("UPDATE trade_sessions SET status = 'done', updated_at = ? WHERE id = ? AND status = 'locked' AND version = ?").run(this.d.now(), id, version).changes) !== 1) return;
    const r = this.row(id)!;
    this.d.assertActive(r.a); this.d.assertActive(r.b);
    this.near(r.a, r.b);
    const la = JSON.parse(r.a_lines) as Lines, lb = JSON.parse(r.b_lines) as Lines;
    this.need(r.a, la); this.need(r.b, lb);
    for (const [t, q] of Object.entries(la)) world.checkGain(r.b, t, q - (lb[t] ?? 0));
    for (const [t, q] of Object.entries(lb)) world.checkGain(r.a, t, q - (la[t] ?? 0));
    const day = this.d.clock.time().settleDay, ref = `p2p:s${r.id}`;
    for (const [t, q] of Object.entries(la)) { gs.add(day, r.a, t, -q, 'trade', ref); gs.add(day, r.b, t, q, 'trade', ref); }
    for (const [t, q] of Object.entries(lb)) { gs.add(day, r.b, t, -q, 'trade', ref); gs.add(day, r.a, t, q, 'trade', ref); }
    const fmt = (l: Lines) => Object.entries(l).map(([t, q]) => `${q} ${this.name(t)}`).join(', ') || 'none';
    const n = this.d.names, tokens = [...Object.keys(la), ...Object.keys(lb)];
    this.d.history(r.a, `Trade with ${n.nameOf(r.b) ?? r.b}: give ${fmt(la)}, receive ${fmt(lb)}`, tokens, ref);
    this.d.history(r.b, `Trade with ${n.nameOf(r.a) ?? r.a}: give ${fmt(lb)}, receive ${fmt(la)}`, tokens, ref);
    this.onDone?.(r.a, r.b, r.world);
  }
}
