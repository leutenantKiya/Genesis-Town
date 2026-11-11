// Seeing each other: display names, who is walking where (presence) and chat, per world ("public" or "HL-<n>").
// Players see and chat only with players in the same world; "/msg name text" is a 1:1 line and crosses worlds.
// Presence and chat live in memory: they are about right now, not history, and nothing in them touches the economy.
// Positions sent here are only drawn for other players; the anti-teleport check (game.reportPosition) still applies.
// Display names live in the Store `names` table (unique ignoring case); the Homeland invite editor resolves name#tag through it.
import { HttpError } from './auth.ts';
import { RateLimiter } from './relayer.ts';

export interface Seen { account: string; world: string; nick: string; tag: string; look: number; x: number; y: number; dir: string; scene: string; t: number; npc?: boolean; title?: string; merchant?: string; party?: boolean }
/** A merchant shown as a player in the public area (tag "NPC"). Set by the app from the economy config and the village map. */
export interface Npc { id: string; account: string; name: string; look: number; x: number; y: number; title: string }
export const NPC_TAG = 'NPC';
export interface ChatMsg { id: number; t: number; from: string; fromTag: string; to: string | null; toTag: string | null; text: string; party?: true }
interface Stored extends ChatMsg { fromAcc: string; toAcc: string | null; world: string; party: true | undefined; partyId: number | null }

/** The slice of Store that names need (src/db.ts). */
export interface NameStore {
  nameOf(account: string): string | null; accountsByName(name: string): string[]; accountByNameTag(name: string, tag: string): string | null;
  setName(account: string, name: string): void; tagOf(account: string): string; lookOf(account: string): number; setLook(account: string, look: number): void;
}

export const CHAT_MAX = 80;       // characters per line
export const CHAT_GAP_MS = 2000;  // one line per account per 2 s
export const CHAT_KEEP = 50;      // lines a newcomer gets per world

export function worldIdOk(w: unknown): w is string { return typeof w === 'string' && /^(public|HL-[1-9]\d{0,9})$/.test(w); }

const NICK_RE = /^[A-Za-z0-9 _-]{3,16}$/;
// names that would confuse players: the merchants, the town and staff words
const RESERVED = new Set(['sari', 'budi', 'wati', 'joko', 'sarah', 'ben', 'wendy', 'jack', 'town', 'desa', 'admin', 'server', 'system', 'sistem', 'moderator', 'mod', 'genesis']);
// a short list of strong insults (Indonesian, Javanese, English); matched as whole words and masked, not blocked
const ROUGH = ['anjing', 'anjir', 'bangsat', 'bajingan', 'kontol', 'memek', 'ngentot', 'ngewe', 'jancok', 'jancuk', 'asu', 'goblok', 'tolol', 'pepek', 'kampret',
  'fuck', 'fucking', 'shit', 'bitch', 'cunt', 'asshole', 'dick', 'pussy'];
const ROUGH_RE = new RegExp('\\b(' + ROUGH.join('|') + ')\\b', 'gi');
const DIRS = new Set(['up', 'down', 'left', 'right']);

export function cleanText(s: string) {
  // no control characters, one line, trimmed, and rude words masked
  return s.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e]/g, ' ').replace(/\s+/g, ' ').trim().replace(ROUGH_RE, (w) => w[0] + '*'.repeat(w.length - 1));
}
function strip(m: Stored): ChatMsg { return { id: m.id, t: m.t, from: m.from, fromTag: m.fromTag, to: m.to, toTag: m.toTag, text: m.text, ...(m.party ? { party: true as const } : {}) }; }
/** What an account without a chosen name is shown as. */
export function defaultNick(account: string) { return `Player_${account.replace(/^p/, '').slice(0, 4)}`; }

export class Social {
  seen = new Map<string, Seen>();
  chat: Stored[] = [];
  seq = 0;
  chatLimiter = new RateLimiter(8, 600);
  nickLimiter = new RateLimiter(3, 20);
  lastSay = new Map<string, number>();
  now: () => number;
  names: NameStore;
  /** Gate set by the app: may this account be in this world? (Homelands: owner and invited guests only.) */
  access: (account: string, world: string) => boolean = () => true;

  /** Set by the app (game.party): the party an account is in, and its other members. Party mates are shown at any distance and share /p chat. */
  partyOf: (a: string) => number | null = () => null;
  mates: (a: string) => string[] = () => [];

  npcs: Npc[] = [];
  /** Set by the app: a player wrote to a merchant. May throw HttpError (rate limit); the answer comes later through npcSay. */
  onNpcMsg?: (npc: Npc, fromAccount: string, text: string) => void;

  constructor(names: NameStore, now: () => number = Date.now) { this.names = names; this.now = now; }

  setNpcs(list: Npc[]) { this.npcs = list; }
  /** "Sari" or "Sari#NPC" (any case) -> the merchant. Player names cannot be a merchant's name (RESERVED). */
  npcByName(raw: string): Npc | null {
    const n = raw.replace(new RegExp('#' + NPC_TAG + '$', 'i'), '').toLowerCase();
    return this.npcs.find((m) => m.name.toLowerCase() === n) ?? null;
  }
  /** A merchant's private answer to one player. */
  npcSay(npc: Npc, toAccount: string, text: string): ChatMsg {
    const msg: Stored = { id: ++this.seq, t: this.now(), from: npc.name, fromTag: NPC_TAG, to: this.nick(toAccount), toTag: this.tag(toAccount), text: cleanText(text).slice(0, 280), fromAcc: npc.account, toAcc: toAccount, world: 'public', party: undefined, partyId: null };
    this.chat.push(msg);
    if (this.chat.length > 300) this.chat.splice(0, this.chat.length - 300);
    return strip(msg);
  }

  nick(account: string): string { return this.names.nameOf(account) || defaultNick(account); }
  tag(account: string): string { return this.names.tagOf(account); }
  look(account: string): number { return this.names.lookOf(account); }
  /** "name#12345" always resolves; a plain "name" only when exactly one player uses it. */
  accountOf(nick: string): string | null {
    const m = /^(.+)#(\d{5})$/.exec(nick);
    if (m) return this.names.accountByNameTag(m[1], m[2]);
    const all = this.names.accountsByName(nick);
    return all.length === 1 ? all[0] : null;
  }
  isAmbiguous(nick: string): boolean { return !/#\d{5}$/.test(nick) && this.names.accountsByName(nick).length > 1; }
  setLook(account: string, raw: unknown) {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > 7) throw new HttpError(400, 'Look must be 0-7.');
    this.names.setLook(account, raw);
    const s = this.seen.get(account); if (s) s.look = raw;
    return raw;
  }
  /** Display name rule: 3-16 characters, letters, digits, space, underscore, hyphen. Returns the trimmed name. */
  static validName(raw: unknown): string {
    const n = typeof raw === 'string' ? raw.trim().replace(/ {2,}/g, ' ') : '';
    if (!NICK_RE.test(n)) throw new HttpError(400, 'Name 3–16 characters: letters, digits, spaces, _ or -.');
    if (RESERVED.has(n.toLowerCase()) || /^(warga|player)_/i.test(n) || cleanText(n) !== n) throw new HttpError(400, 'That name can\'t be used.');
    return n;
  }
  setNick(account: string, raw: unknown) {
    const nick = Social.validName(raw);
    if (this.names.nameOf(account) === nick) return nick; // unchanged
    // names may repeat: the 5-digit tag tells players apart. Only real changes count toward the limit, so a typo does not lock the player out
    if (!this.nickLimiter.take(account, this.now())) throw new HttpError(429, 'You changed your name too often. Try again later.');
    this.names.setName(account, nick);
    const s = this.seen.get(account); if (s) { s.nick = nick; s.tag = this.tag(account); }
    return nick;
  }

  /** Where a player is now, in `world` (only outdoor positions are shown to others). */
  report(account: string, world: string, p: { x?: unknown; y?: unknown; dir?: unknown; scene?: unknown }) {
    const x = Number(p.x), y = Number(p.y);
    if (!worldIdOk(world)) throw new HttpError(400, 'bad world');
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 999 || y > 999) throw new HttpError(400, 'bad position');
    const dir = typeof p.dir === 'string' && DIRS.has(p.dir) ? p.dir : 'down';
    const scene = p.scene === 'out' ? 'out' : 'in';
    this.seen.set(account, { account, world, nick: this.nick(account), tag: this.tag(account), look: this.look(account), x, y, dir, scene, t: this.now() });
  }
  /** Other players outdoors in the same world within `radius` tiles who reported in the last 15 seconds. */
  nearby(account: string, world: string, radius = 30, maxAge = 15_000) {
    const me = this.seen.get(account), now = this.now(), out: Seen[] = [], mates = new Set(this.mates(account));
    if (world === 'public') {
      for (const n of this.npcs) {
        if (me && (Math.abs(n.x - me.x) > radius || Math.abs(n.y - me.y) > radius)) continue;
        out.push({ account: n.account, world, nick: n.name, tag: NPC_TAG, look: n.look, x: n.x, y: n.y, dir: 'down', scene: 'out', t: now, npc: true, title: n.title, merchant: n.id });
      }
    }
    for (const s of this.seen.values()) {
      if (now - s.t > maxAge) { this.seen.delete(s.account); continue; }
      if (s.account === account || s.scene !== 'out' || s.world !== world) continue;
      if (!this.access(s.account, world)) continue; // an uninvited guest vanishes from the Homeland at once
      const mate = mates.has(s.account); // party mates skip the radius: you can always find them
      if (!mate && me && (Math.abs(s.x - me.x) > radius || Math.abs(s.y - me.y) > radius)) continue;
      out.push(mate ? { ...s, party: true } : s);
    }
    return out.sort((p, q) => (q.party ? 1 : 0) - (p.party ? 1 : 0)).slice(0, 60);
  }
  online() { const now = this.now(); let n = 0; for (const s of this.seen.values()) if (now - s.t <= 15_000) n++; return n; }

  /** A chat line: "/msg name text" (or /w) is private (to one player, any world), anything else is for everyone in `world`. */
  say(account: string, world: string, raw: unknown): ChatMsg {
    if (typeof raw !== 'string') throw new HttpError(400, 'Empty message.');
    if (!worldIdOk(world)) throw new HttpError(400, 'bad world');
    if (raw.length > 400) throw new HttpError(400, `Message too long (max ${CHAT_MAX} characters).`);
    let text = cleanText(raw), party = false, to: string | null = null, toTag: string | null = null, toAcc: string | null = null, toNpc: Npc | null = null;
    const pm = /^\/(msg|w|pm)\b\s*([\s\S]*)$/i.exec(text);
    if (pm) {
      // the name may contain spaces: take the longest run of words that is a player's name
      const words = pm[2].split(' ').filter(Boolean);
      for (let k = Math.min(words.length - 1, 4); k >= 1 && !toNpc; k--) {
        const n = this.npcByName(words.slice(0, k).join(' '));
        if (n) { toNpc = n; text = words.slice(k).join(' '); }
      }
      if (toNpc) {
        if (world !== 'public') throw new HttpError(409, 'Merchants are in the public area.');
        to = toNpc.name; toTag = NPC_TAG;
      } else {
        for (let k = Math.min(words.length - 1, 4); k >= 1 && !toAcc; k--) {
          const t = this.accountOf(words.slice(0, k).join(' '));
          if (t) { toAcc = t; text = words.slice(k).join(' '); }
        }
        if (!toAcc) {
          for (let k = Math.min(words.length - 1, 4); k >= 1; k--) if (this.isAmbiguous(words.slice(0, k).join(' '))) throw new HttpError(409, `Several players are named ${words.slice(0, k).join(' ')}. Use name#tag.`);
          if (words.length < 2) throw new HttpError(400, 'Usage: /msg name message');
          throw new HttpError(404, `No player named ${words[0]}.`);
        }
        if (toAcc === account) throw new HttpError(400, 'That\'s your own name.');
        to = this.nick(toAcc); toTag = this.tag(toAcc);
      }
    } else if (/^\/(p|party)(\s|$)/i.test(text)) {
      // "/p text": a line for the whole party, in any world
      if (this.partyOf(account) === null) throw new HttpError(409, 'You are not in a party.');
      party = true; text = text.replace(/^\/(p|party)\s*/i, '');
    } else if (text.startsWith('/')) throw new HttpError(400, 'Commands: /msg name message · /p message · /block name · /unblock name · /name NewName · /help');
    if (!text) throw new HttpError(400, 'Empty message.');
    if (Array.from(text).length > CHAT_MAX) throw new HttpError(400, `Message too long (max ${CHAT_MAX} characters).`);
    const now = this.now(), last = this.lastSay.get(account);
    if (last !== undefined && now - last < CHAT_GAP_MS) throw new HttpError(429, 'Slow down, too fast.');
    if (!this.chatLimiter.take(account, now)) throw new HttpError(429, 'Slow down, too many messages.');
    this.lastSay.set(account, now);
    if (this.lastSay.size > 5000) for (const [a, t] of this.lastSay) if (now - t > CHAT_GAP_MS) this.lastSay.delete(a);
    if (toNpc) this.onNpcMsg?.(toNpc, account, text); // may throw 429 before anything is stored
    const msg: Stored = { id: ++this.seq, t: now, from: this.nick(account), fromTag: this.tag(account), to, toTag, text, fromAcc: account, toAcc: toAcc ?? toNpc?.account ?? null, world, party: party ? true : undefined, partyId: party ? this.partyOf(account) : null };
    this.chat.push(msg);
    if (this.chat.length > 300) this.chat.splice(0, this.chat.length - 300);
    return strip(msg);
  }
  /** Lines after `since` that this player may read in `world`: the world's public lines, plus private lines to or from them. */
  since(account: string, world: string, since: number) {
    const pid = this.partyOf(account);
    return this.chat.filter((m) => m.id > since && (m.party ? pid !== null && m.partyId === pid : m.toAcc ? m.toAcc === account || m.fromAcc === account : m.world === world)).slice(-CHAT_KEEP).map(strip);
  }
}
