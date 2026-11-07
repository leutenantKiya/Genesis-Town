// Seeing each other: display names, who is walking where (presence) and chat, per world ("public" or "IS-<id>").
// Players see and chat only with players in the same world; "/msg name text" is a 1:1 line and crosses worlds.
// Presence and chat live in memory: they are about right now, not history, and nothing in them touches the economy.
// Positions sent here are only drawn for other players; the anti-teleport check (game.reportPosition) still applies.
// Display names live in the Store `names` table (unique ignoring case); the invite editor of Private Islands uses it too.
import { HttpError } from './auth.ts';
import { RateLimiter } from './relayer.ts';

export interface Seen { account: string; world: string; nick: string; x: number; y: number; dir: string; scene: string; t: number }
export interface ChatMsg { id: number; t: number; from: string; to: string | null; text: string }
interface Stored extends ChatMsg { fromAcc: string; toAcc: string | null; world: string }

/** The slice of Store that names need (src/db.ts). */
export interface NameStore { nameOf(account: string): string | null; accountByName(name: string): string | null; setName(account: string, name: string): void }

export const CHAT_MAX = 80;       // characters per line
export const CHAT_GAP_MS = 2000;  // one line per account per 2 s
export const CHAT_KEEP = 50;      // lines a newcomer gets per world

export function worldIdOk(w: unknown): w is string { return typeof w === 'string' && /^(public|IS-[1-9]\d{0,9})$/.test(w); }

const NICK_RE = /^[A-Za-z0-9 _-]{3,16}$/;
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
/** What an account without a chosen name is shown as. */
export function defaultNick(account: string) { return 'Warga_' + account.replace(/^p/, '').slice(0, 4); }

export class Social {
  seen = new Map<string, Seen>();
  chat: Stored[] = [];
  seq = 0;
  chatLimiter = new RateLimiter(8, 600);
  nickLimiter = new RateLimiter(3, 20);
  lastSay = new Map<string, number>();
  now: () => number;
  names: NameStore;
  /** Gate set by the app: may this account be in this world? (Private Islands: owner and invited guests only.) */
  access: (account: string, world: string) => boolean = () => true;

  constructor(names: NameStore, now: () => number = Date.now) { this.names = names; this.now = now; }

  nick(account: string): string { return this.names.nameOf(account) || defaultNick(account); }
  accountOf(nick: string): string | null { return this.names.accountByName(nick); }
  /** Display name rule: 3-16 characters, letters, digits, space, underscore, hyphen. Returns the trimmed name. */
  static validName(raw: unknown): string {
    const n = typeof raw === 'string' ? raw.trim().replace(/ {2,}/g, ' ') : '';
    if (!NICK_RE.test(n)) throw new HttpError(400, 'Nama 3–16 karakter: huruf, angka, spasi, _ atau -.');
    if (RESERVED.has(n.toLowerCase()) || /^warga_/i.test(n) || cleanText(n) !== n) throw new HttpError(400, 'Nama itu tidak bisa dipakai.');
    return n;
  }
  setNick(account: string, raw: unknown) {
    const nick = Social.validName(raw);
    const other = this.accountOf(nick);
    if (other && other !== account) throw new HttpError(409, 'Nama itu sudah dipakai pemain lain.');
    // only real changes count toward the limit, so a typo does not lock the player out
    if (!this.nickLimiter.take(account, this.now())) throw new HttpError(429, 'Terlalu sering ganti nama. Coba lagi nanti.');
    this.names.setName(account, nick);
    const s = this.seen.get(account); if (s) s.nick = nick;
    return nick;
  }

  /** Where a player is now, in `world` (only outdoor positions are shown to others). */
  report(account: string, world: string, p: { x?: unknown; y?: unknown; dir?: unknown; scene?: unknown }) {
    const x = Number(p.x), y = Number(p.y);
    if (!worldIdOk(world)) throw new HttpError(400, 'bad world');
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 999 || y > 999) throw new HttpError(400, 'bad position');
    const dir = typeof p.dir === 'string' && DIRS.has(p.dir) ? p.dir : 'down';
    const scene = p.scene === 'out' ? 'out' : 'in';
    this.seen.set(account, { account, world, nick: this.nick(account), x, y, dir, scene, t: this.now() });
  }
  /** Other players outdoors in the same world within `radius` tiles who reported in the last 15 seconds. */
  nearby(account: string, world: string, radius = 30, maxAge = 15_000) {
    const me = this.seen.get(account), now = this.now(), out: Seen[] = [];
    for (const s of this.seen.values()) {
      if (now - s.t > maxAge) { this.seen.delete(s.account); continue; }
      if (s.account === account || s.scene !== 'out' || s.world !== world) continue;
      if (!this.access(s.account, world)) continue; // an uninvited guest vanishes from the island at once
      if (me && (Math.abs(s.x - me.x) > radius || Math.abs(s.y - me.y) > radius)) continue;
      out.push(s);
    }
    return out.slice(0, 60);
  }
  online() { const now = this.now(); let n = 0; for (const s of this.seen.values()) if (now - s.t <= 15_000) n++; return n; }

  /** A chat line: "/msg name text" (or /w) is private (to one player, any world), anything else is for everyone in `world`. */
  say(account: string, world: string, raw: unknown): ChatMsg {
    if (typeof raw !== 'string') throw new HttpError(400, 'Pesan kosong.');
    if (!worldIdOk(world)) throw new HttpError(400, 'bad world');
    if (raw.length > 400) throw new HttpError(400, `Pesan terlalu panjang (maks ${CHAT_MAX} huruf).`);
    let text = cleanText(raw), to: string | null = null, toAcc: string | null = null;
    const pm = /^\/(msg|w|pm)\b\s*([\s\S]*)$/i.exec(text);
    if (pm) {
      // the name may contain spaces: take the longest run of words that is a player's name
      const words = pm[2].split(' ').filter(Boolean);
      for (let k = Math.min(words.length - 1, 4); k >= 1 && !toAcc; k--) {
        const t = this.accountOf(words.slice(0, k).join(' '));
        if (t) { toAcc = t; text = words.slice(k).join(' '); }
      }
      if (!toAcc) {
        if (words.length < 2) throw new HttpError(400, 'Cara pakai: /msg nama pesan');
        throw new HttpError(404, `Tidak ada pemain bernama ${words[0]}.`);
      }
      if (toAcc === account) throw new HttpError(400, 'Itu namamu sendiri.');
      to = this.nick(toAcc);
    } else if (text.startsWith('/')) throw new HttpError(400, 'Perintah: /msg nama pesan · /block nama · /unblock nama · /nama NamaBaru · /help');
    if (!text) throw new HttpError(400, 'Pesan kosong.');
    if (Array.from(text).length > CHAT_MAX) throw new HttpError(400, `Pesan terlalu panjang (maks ${CHAT_MAX} huruf).`);
    const now = this.now(), last = this.lastSay.get(account);
    if (last !== undefined && now - last < CHAT_GAP_MS) throw new HttpError(429, 'Pelan-pelan, terlalu cepat.');
    if (!this.chatLimiter.take(account, now)) throw new HttpError(429, 'Pelan-pelan, terlalu banyak pesan.');
    this.lastSay.set(account, now);
    if (this.lastSay.size > 5000) for (const [a, t] of this.lastSay) if (now - t > CHAT_GAP_MS) this.lastSay.delete(a);
    const msg: Stored = { id: ++this.seq, t: now, from: this.nick(account), to, text, fromAcc: account, toAcc, world };
    this.chat.push(msg);
    if (this.chat.length > 300) this.chat.splice(0, this.chat.length - 300);
    return strip(msg);
  }
  /** Lines after `since` that this player may read in `world`: the world's public lines, plus private lines to or from them. */
  since(account: string, world: string, since: number) {
    return this.chat.filter((m) => m.id > since && (m.toAcc ? m.toAcc === account || m.fromAcc === account : m.world === world)).slice(-CHAT_KEEP).map(strip);
  }
}
