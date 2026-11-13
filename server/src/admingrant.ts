// Admin coin grants: an account in ADMIN_ACCOUNTS moves coin from the town treasury to a player. Off-chain like the
// starter kit (game/world.ts starter()): ledger rows town -N and player +N (kind 'admin_grant'), settled at the next daily
// settlement. Nothing is minted. The chain check (chaincheck.ts) only compares a SPENDER's chain balance with the books'
// settled amount, and the town never spends through it, so the town's debit and the player's gain need no invalidation;
// it is dropped for the receiver anyway so the next read is fresh. Limits: economy/config.json `adminGrant`.
import type { Game } from './game/game.ts';
import type { Store } from './db.ts';
import type { Social } from './social.ts';
import { HttpError } from './auth.ts';

export interface AdminGrantConfig { maxPerGrant: number; maxPerDay: number }
export interface GrantRecord { at: number; admin: string; to: string; toName: string; coin: number; note: string; day: number }

const MAX_KEPT = 50;
const NOTE_MAX = 120;

export class AdminGrants {
  /** The last grants, newest last (memory only; the ledger is the permanent record). */
  readonly log: GrantRecord[] = [];
  private d: { game: Game; store: Store; social: Social; invalidate: (accounts: string[]) => void };

  constructor(d: { game: Game; store: Store; social: Social; invalidate: (accounts: string[]) => void }) { this.d = d; }

  limits(): AdminGrantConfig {
    const c = this.d.game.econ.adminGrant;
    return { maxPerGrant: c?.maxPerGrant ?? 5000, maxPerDay: c?.maxPerDay ?? 50000 };
  }

  /** Town treasury coin (settled plus today's pending). */
  treasury(): number { return this.d.game.gs.balance(this.d.game.town, 'coin'); }

  /** Coin this admin already sent on this ledger day. */
  sentToday(admin: string): number {
    const day = this.d.game.clock.time().settleDay, prefix = `${admin}|`;
    const row = this.d.game.gs.db.prepare("SELECT COALESCE(SUM(-delta), 0) AS s FROM ledger WHERE day = ? AND account = ? AND token = 'coin' AND kind = 'admin_grant' AND substr(ref, 1, ?) = ?")
      .get(day, this.d.game.town, prefix.length, prefix) as { s: number };
    return row.s;
  }

  /** `to`: a unique name, name#tag, or an account id. 404 unknown (merchants, the town and guests are not players), 409 ambiguous. */
  resolve(to: unknown): string {
    const q = typeof to === 'string' ? to.trim().slice(0, 80) : '';
    if (!q) throw new HttpError(400, 'Who gets the coin?');
    const { store, social } = this.d;
    if (store.isPlayer(q)) return q;
    const acct = social.accountOf(q);
    if (!acct) {
      if (social.isAmbiguous(q)) throw new HttpError(409, `Several players are named ${q}. Use name#tag.`);
      throw new HttpError(404, 'Player not found.');
    }
    if (!store.isPlayer(acct)) throw new HttpError(404, 'Player not found.');
    return acct;
  }

  /** The player a grant would reach (for the confirmation line in the window). */
  who(to: unknown) {
    const acct = this.resolve(to);
    return { account: acct, nick: this.d.store.nameOf(acct) ?? acct, tag: this.d.store.tagOf(acct) };
  }

  grant(admin: string, body: Record<string, unknown>) {
    const { game, store } = this.d;
    const coin = body.coin;
    if (typeof coin !== 'number' || !Number.isInteger(coin) || coin <= 0) throw new HttpError(400, 'coin must be a whole number above 0.');
    const note = typeof body.note === 'string' ? body.note.replace(/[\r\n|]+/g, ' ').trim().slice(0, NOTE_MAX) : '';
    const to = this.resolve(body.to);
    const lim = this.limits();
    if (coin > lim.maxPerGrant) throw new HttpError(409, `One grant can be at most ${lim.maxPerGrant} coin.`);
    const sent = this.sentToday(admin);
    if (sent + coin > lim.maxPerDay) throw new HttpError(409, `You can send at most ${lim.maxPerDay} coin a day (${sent} sent today).`);
    const treasury = this.treasury();
    if (treasury < coin) throw new HttpError(409, `The town treasury has only ${treasury} coin.`);
    game.world.checkGain(to, 'coin', coin); // the contract caps a player's coin gain per day; a clamp at settlement would unbalance the town
    const day = game.clock.time().settleDay, ref = `${admin}|${note}`;
    game.gs.add(day, game.town, 'coin', -coin, 'admin_grant', ref);
    game.gs.add(day, to, 'coin', coin, 'admin_grant', ref);
    const toName = store.nameOf(to) ?? to, adminName = store.nameOf(admin) ?? admin;
    store.addHistory(to, 'admin_grant', `The town treasury sent you ${coin} coin${note ? `: ${note}` : '.'}`, 'offchain', null, null, []);
    store.addHistory(admin, 'admin_grant', `You sent ${coin} coin from the town treasury to ${toName}.`, 'offchain', null, null, []);
    const rec: GrantRecord = { at: game.now(), admin, to, toName, coin, note, day };
    this.log.push(rec);
    if (this.log.length > MAX_KEPT) this.log.shift();
    console.warn(`[admin grant] ${adminName} (${admin}) -> ${toName} (${to}): ${coin} coin, note: ${note || '-'}`);
    this.d.invalidate([to]);
    return { ok: true, to, toName, coin, treasury: this.treasury(), sentToday: sent + coin, ...lim };
  }
}
