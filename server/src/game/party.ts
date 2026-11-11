// Parties: up to `party.max` players who play together. Lives in SQLite (survives restarts and the Neon snapshot).
// Only the leader invites; a player without a party may invite and becomes leader when the first invite is accepted.
// Nothing here moves a player between worlds: worlds change only through `travel` at a portal.
import { HttpError } from '../auth.ts';
import type { Econ } from './econ.ts';
import type { GameStore } from './gamestore.ts';
import type { PlayerDir } from './homeland.ts';

export interface PartyMember { account: string; name: string; tag: string; leader: boolean }
export interface PartyView {
  party: { id: number; leader: string; members: PartyMember[] } | null;
  invites: Array<{ from: string; name: string; tag: string; expires_at: number }>;
}
export interface PartyDeps {
  econ: Econ; gs: GameStore; now: () => number; names: PlayerDir;
  /** Throws 403 for a frozen account (Game.assertActive). */
  assertActive: (account: string) => void;
}

export class Parties {
  d: PartyDeps;
  constructor(d: PartyDeps) { this.d = d; }

  private get db() { return this.d.gs.db; }

  idOf(a: string): number | null {
    const r = this.db.prepare('SELECT party FROM party_members WHERE account = ?').get(a) as { party: number } | undefined;
    return r ? r.party : null;
  }
  membersOf(id: number): string[] {
    return (this.db.prepare('SELECT account FROM party_members WHERE party = ? ORDER BY joined_at, account').all(id) as Array<{ account: string }>).map((r) => r.account);
  }
  /** The other members of a's party. */
  mates(a: string): string[] {
    const id = this.idOf(a);
    return id === null ? [] : this.membersOf(id).filter((m) => m !== a);
  }
  same(a: string, b: string): boolean {
    if (a === b) return false;
    const x = this.idOf(a);
    return x !== null && x === this.idOf(b);
  }
  private leaderOf(id: number): string | null {
    const r = this.db.prepare('SELECT leader FROM parties WHERE id = ?').get(id) as { leader: string } | undefined;
    return r ? r.leader : null;
  }

  private resolve(to: unknown): string {
    const s = typeof to === 'string' ? to.trim() : '';
    if (!s) throw new HttpError(400, 'Who do you mean?');
    const i = s.lastIndexOf('#');
    const acct = i > 0 ? this.d.names.accountByNameTag(s.slice(0, i), s.slice(i + 1)) : this.d.names.isPlayer(s) ? s : null;
    if (!acct) throw new HttpError(404, 'Player not found.');
    return acct;
  }

  invite(from: string, to: unknown): PartyView {
    this.d.assertActive(from);
    const target = this.resolve(to);
    if (target === from) throw new HttpError(400, 'You can\'t invite yourself.');
    if (this.idOf(target) !== null) throw new HttpError(409, 'That player is already in a party.');
    const mine = this.idOf(from);
    if (mine !== null) {
      if (this.leaderOf(mine) !== from) throw new HttpError(409, 'Only the party leader can invite.');
      if (this.membersOf(mine).length >= this.d.econ.party.max) throw new HttpError(409, 'The party is full.');
    }
    const t = this.d.now();
    const had = this.db.prepare('SELECT 1 FROM party_invites WHERE from_acct = ? AND account = ? AND expires_at > ?').get(from, target, t);
    const live = (this.db.prepare('SELECT COUNT(*) AS n FROM party_invites WHERE from_acct = ? AND expires_at > ?').get(from, t) as { n: number }).n;
    if (!had && live >= this.d.econ.party.maxPendingInvites) throw new HttpError(409, 'Too many open invites. Wait for answers first.');
    this.db.prepare('INSERT OR REPLACE INTO party_invites (from_acct, account, expires_at) VALUES (?, ?, ?)').run(from, target, t + this.d.econ.party.inviteSecs * 1000);
    return this.view(from);
  }

  accept(a: string, from: unknown): PartyView {
    this.d.assertActive(a);
    const f = this.resolve(from);
    this.d.gs.tx(() => {
      const inv = this.db.prepare('SELECT expires_at FROM party_invites WHERE from_acct = ? AND account = ?').get(f, a) as { expires_at: number } | undefined;
      if (!inv) throw new HttpError(404, 'Invite not found.');
      if (inv.expires_at <= this.d.now()) throw new HttpError(409, 'The invite expired.');
      if (this.idOf(a) !== null) throw new HttpError(409, 'You are already in a party.');
      this.d.assertActive(f);
      let id = this.idOf(f);
      if (id !== null && this.leaderOf(id) !== f) throw new HttpError(409, 'That player is no longer the party leader.');
      if (id !== null && this.membersOf(id).length >= this.d.econ.party.max) throw new HttpError(409, 'The party is full.');
      if (id === null) {
        const r = this.db.prepare('INSERT INTO parties (leader, created_at) VALUES (?, ?)').run(f, this.d.now());
        id = Number(r.lastInsertRowid);
        this.db.prepare('INSERT INTO party_members (account, party, joined_at) VALUES (?, ?, ?)').run(f, id, this.d.now());
      }
      this.db.prepare('INSERT INTO party_members (account, party, joined_at) VALUES (?, ?, ?)').run(a, id, this.d.now());
      this.db.prepare('DELETE FROM party_invites WHERE from_acct = ? AND account = ?').run(f, a);
      this.db.prepare('DELETE FROM party_invites WHERE account = ?').run(a); // joined: other invites to me are moot
    });
    return this.view(a);
  }

  decline(a: string, from: unknown): PartyView {
    const f = this.resolve(from);
    this.db.prepare('DELETE FROM party_invites WHERE from_acct = ? AND account = ?').run(f, a);
    return this.view(a);
  }

  /** Removes a member; the earliest remaining member leads on; a party of one is dissolved. */
  private remove(a: string) {
    const id = this.idOf(a);
    if (id === null) return;
    this.d.gs.tx(() => {
      const leader = this.leaderOf(id);
      this.db.prepare('DELETE FROM party_members WHERE account = ?').run(a);
      const rest = this.membersOf(id);
      if (rest.length <= 1) {
        this.db.prepare('DELETE FROM party_members WHERE party = ?').run(id);
        this.db.prepare('DELETE FROM parties WHERE id = ?').run(id);
        if (leader) this.db.prepare('DELETE FROM party_invites WHERE from_acct = ?').run(leader);
        this.db.prepare('DELETE FROM party_invites WHERE from_acct = ?').run(a);
      } else if (leader === a) {
        this.db.prepare('UPDATE parties SET leader = ? WHERE id = ?').run(rest[0], id);
        this.db.prepare('DELETE FROM party_invites WHERE from_acct = ?').run(a);
      }
    });
  }

  leave(a: string): PartyView {
    this.remove(a);
    return this.view(a);
  }

  kick(leader: string, target: unknown): PartyView {
    const id = this.idOf(leader);
    if (id === null) throw new HttpError(409, 'You are not in a party.');
    if (this.leaderOf(id) !== leader) throw new HttpError(403, 'Only the party leader can remove members.');
    const t = this.resolve(target);
    if (t === leader) throw new HttpError(400, 'Use Leave to leave the party.');
    if (this.idOf(t) !== id) throw new HttpError(409, 'That player is not in your party.');
    this.remove(t);
    return this.view(leader);
  }

  view(a: string): PartyView {
    const n = this.d.names, id = this.idOf(a);
    let party: PartyView['party'] = null;
    if (id !== null) {
      const leader = this.leaderOf(id) ?? a;
      party = { id, leader, members: this.membersOf(id).map((m) => ({ account: m, name: n.nameOf(m) ?? m, tag: n.tagOf(m), leader: m === leader })) };
    }
    const rows = this.db.prepare('SELECT from_acct, expires_at FROM party_invites WHERE account = ? AND expires_at > ? ORDER BY expires_at').all(a, this.d.now()) as Array<{ from_acct: string; expires_at: number }>;
    return { party, invites: rows.map((r) => ({ from: r.from_acct, name: n.nameOf(r.from_acct) ?? r.from_acct, tag: n.tagOf(r.from_acct), expires_at: r.expires_at })) };
  }
}
