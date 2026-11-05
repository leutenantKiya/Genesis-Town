// Seeing each other: nicknames, who is walking where (presence) and the global chat with /msg for private messages.
// Presence and chat live in memory: they are about right now, not history, and nothing in them touches the economy.
// Positions sent here are only drawn for other players; the anti-teleport check (game.reportPosition) still applies.
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './auth.ts';
import { RateLimiter } from './relayer.ts';

export interface Seen { account: string; nick: string; x: number; y: number; dir: string; scene: string; t: number }
export interface ChatMsg { id: number; t: number; from: string; to: string | null; text: string }
interface Stored extends ChatMsg { fromAcc: string; toAcc: string | null }

const NICK_RE = /^[A-Za-z0-9_]{3,16}$/;
// names that would confuse players: the merchants, the town and staff words
const RESERVED = new Set(['sari', 'budi', 'wati', 'joko', 'town', 'desa', 'admin', 'server', 'system', 'sistem', 'moderator', 'mod', 'genesis']);
// a short list of strong insults (Indonesian, Javanese, English); matched as whole words and masked, not blocked
const ROUGH = ['anjing', 'anjir', 'bangsat', 'bajingan', 'kontol', 'memek', 'ngentot', 'ngewe', 'jancok', 'jancuk', 'asu', 'goblok', 'tolol', 'pepek', 'kampret',
  'fuck', 'fucking', 'shit', 'bitch', 'cunt', 'asshole', 'dick', 'pussy'];
const ROUGH_RE = new RegExp('\\b(' + ROUGH.join('|') + ')\\b', 'gi');
const DIRS = new Set(['up', 'down', 'left', 'right']);

export function cleanText(s: string) {
  // no control characters, one line, trimmed, and rude words masked
  return s.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e]/g, ' ').replace(/\s+/g, ' ').trim().replace(ROUGH_RE, (w) => w[0] + '*'.repeat(w.length - 1));
}
function strip(m: Stored): ChatMsg { return { id: m.id, t: m.t, from: m.from, to: m.to, text: m.text }; }
export function defaultNick(account: string) { return 'Warga_' + account.replace(/^p/, '').slice(0, 4); }

export class Social {
  db: DatabaseSync;
  seen = new Map<string, Seen>();
  chat: Stored[] = [];
  seq = 0;
  chatLimiter = new RateLimiter(8, 600);
  nickLimiter = new RateLimiter(3, 20);
  now: () => number;

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db; this.now = now;
    const cols = db.prepare('PRAGMA table_info(players)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'nick')) db.exec('ALTER TABLE players ADD COLUMN nick TEXT');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS players_nick ON players(lower(nick))');
  }

  nick(account: string): string {
    const r = this.db.prepare('SELECT nick FROM players WHERE account_id = ?').get(account) as { nick: string | null } | undefined;
    return r?.nick || defaultNick(account);
  }
  accountOf(nick: string): string | null {
    const r = this.db.prepare('SELECT account_id FROM players WHERE lower(nick) = lower(?)').get(nick) as { account_id: string } | undefined;
    if (r) return r.account_id;
    // default names are not stored: match them against the accounts they come from
    const m = /^warga_([0-9a-f]{4})$/i.exec(nick);
    if (!m) return null;
    const rows = this.db.prepare("SELECT account_id FROM players WHERE nick IS NULL AND account_id LIKE ?").all('p' + m[1].toLowerCase() + '%') as Array<{ account_id: string }>;
    return rows.length === 1 ? rows[0].account_id : null;
  }
  setNick(account: string, nick: string) {
    if (!NICK_RE.test(nick)) throw new HttpError(400, 'Nama 3–16 huruf, angka atau _ (tanpa spasi).');
    if (RESERVED.has(nick.toLowerCase()) || /^warga_/i.test(nick) || cleanText(nick) !== nick) throw new HttpError(400, 'Nama itu tidak bisa dipakai.');
    const other = this.accountOf(nick);
    if (other && other !== account) throw new HttpError(409, 'Nama itu sudah dipakai pemain lain.');
    // only real changes count toward the limit, so a typo does not lock the player out
    if (!this.nickLimiter.take(account, this.now())) throw new HttpError(429, 'Terlalu sering ganti nama. Coba lagi nanti.');
    this.db.prepare('UPDATE players SET nick = ? WHERE account_id = ?').run(nick, account);
    const s = this.seen.get(account); if (s) s.nick = nick;
    return nick;
  }

  /** Where a player is now (only outdoor positions are shown to others). */
  report(account: string, p: { x?: unknown; y?: unknown; dir?: unknown; scene?: unknown }) {
    const x = Number(p.x), y = Number(p.y);
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 999 || y > 999) throw new HttpError(400, 'bad position');
    const dir = typeof p.dir === 'string' && DIRS.has(p.dir) ? p.dir : 'down';
    const scene = p.scene === 'out' ? 'out' : 'in';
    this.seen.set(account, { account, nick: this.nick(account), x, y, dir, scene, t: this.now() });
  }
  /** Other players outdoors within `radius` tiles who reported in the last 15 seconds. */
  nearby(account: string, radius = 30, maxAge = 15_000) {
    const me = this.seen.get(account), now = this.now(), out: Seen[] = [];
    for (const s of this.seen.values()) {
      if (now - s.t > maxAge) { this.seen.delete(s.account); continue; }
      if (s.account === account || s.scene !== 'out') continue;
      if (me && (Math.abs(s.x - me.x) > radius || Math.abs(s.y - me.y) > radius)) continue;
      out.push(s);
    }
    return out.slice(0, 60);
  }
  online() { const now = this.now(); let n = 0; for (const s of this.seen.values()) if (now - s.t <= 15_000) n++; return n; }

  /** A chat line: "/msg name text" (or /w) is private, anything else is for everyone. */
  say(account: string, raw: unknown): ChatMsg {
    if (typeof raw !== 'string') throw new HttpError(400, 'Pesan kosong.');
    if (raw.length > 400) throw new HttpError(400, 'Pesan terlalu panjang (maks 160 huruf).');
    let text = cleanText(raw), to: string | null = null, toAcc: string | null = null;
    const m = /^\/(msg|w|pm)\s+(\S+)\s+([\s\S]+)$/i.exec(text);
    if (/^\/(msg|w|pm)\b/i.test(text) && !m) throw new HttpError(400, 'Cara pakai: /msg nama pesan');
    if (m) {
      const target = this.accountOf(m[2]);
      if (!target) throw new HttpError(404, `Tidak ada pemain bernama ${m[2]}.`);
      if (target === account) throw new HttpError(400, 'Itu namamu sendiri.');
      to = this.nick(target); toAcc = target; text = m[3].trim();
    } else if (text.startsWith('/')) throw new HttpError(400, 'Perintah: /msg nama pesan · /block nama · /unblock nama · /help');
    if (!text) throw new HttpError(400, 'Pesan kosong.');
    if (text.length > 160) throw new HttpError(400, 'Pesan terlalu panjang (maks 160 huruf).');
    if (!this.chatLimiter.take(account, this.now())) throw new HttpError(429, 'Pelan-pelan, terlalu banyak pesan.');
    const msg: Stored = { id: ++this.seq, t: this.now(), from: this.nick(account), to, text, fromAcc: account, toAcc };
    this.chat.push(msg);
    if (this.chat.length > 300) this.chat.splice(0, this.chat.length - 300);
    return strip(msg);
  }
  /** Lines after `since` that this player may read: everything public, plus private lines to or from them. */
  since(account: string, since: number) {
    return this.chat.filter((m) => m.id > since && (!m.toAcc || m.toAcc === account || m.fromAcc === account)).slice(-50).map(strip);
  }
}
