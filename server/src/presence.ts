// Live presence and chat, in memory only (nothing here touches the chain or the database). Per world ("public" or
// "IS-<id>") the server remembers where each player last said they stood, and the last 50 chat lines. The app
// streams both to the players of that world over Server-Sent Events (see /api/stream in app.ts).
import { HttpError } from './auth.ts';

export const STALE_MS = 10_000;
export const CHAT_MAX = 80;
export const CHAT_GAP_MS = 2000;
export const CHAT_KEEP = 50;

export interface Pos { x: number; y: number }
export interface PresenceEntry { account: string; name: string; x: number; y: number; dir: string; scene: string }
export interface ChatMsg { account: string; name: string; text: string; t: number }

const DIRS = new Set(['up', 'down', 'left', 'right']);

/** A deliberately small word list (Indonesian and English); matches are masked with asterisks. */
const BAD_WORDS = ['anjing', 'bangsat', 'kontol', 'memek', 'goblok', 'tolol', 'bajingan', 'fuck', 'shit', 'bitch'];
const BAD_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${BAD_WORDS.join('|')})(?![\\p{L}\\p{N}])`, 'giu');

export function worldIdOk(w: unknown): w is string { return typeof w === 'string' && /^(public|IS-[1-9]\d{0,9})$/.test(w); }

/** Display name rule: 3-16 characters, letters, digits, space, underscore, hyphen. Returns the trimmed name. */
export function validName(raw: unknown): string {
  const n = typeof raw === 'string' ? raw.trim().replace(/ {2,}/g, ' ') : '';
  if (!/^[A-Za-z0-9 _-]{3,16}$/.test(n)) throw new HttpError(400, 'Nama harus 3-16 karakter: huruf, angka, spasi, _ atau -');
  return n;
}

export class Presence {
  private worlds = new Map<string, Map<string, { x: number; y: number; dir: string; scene: string; t: number }>>();
  private where = new Map<string, string>();
  private lastChat = new Map<string, number>();
  private log = new Map<string, ChatMsg[]>();
  private listeners = new Map<string, Set<(m: ChatMsg) => void>>();
  /** Optional gate set by the islands code: may this account be in this world? Default: everyone. */
  access: (account: string, world: string) => boolean = () => true;

  private nameOf: (account: string) => string | null;
  constructor(nameOf: (account: string) => string | null) { this.nameOf = nameOf; }

  displayName(account: string): string { return this.nameOf(account) ?? account.split('.')[0].slice(0, 16); }

  update(account: string, world: string, pos: Pos, dir: string, scene: string, now = Date.now()) {
    const prev = this.where.get(account);
    if (prev && prev !== world) this.worlds.get(prev)?.delete(account);
    this.where.set(account, world);
    let m = this.worlds.get(world);
    if (!m) this.worlds.set(world, (m = new Map()));
    m.set(account, { x: pos.x, y: pos.y, dir: DIRS.has(dir) ? dir : 'down', scene: String(scene || 'out').slice(0, 24), t: now });
  }

  /** Everyone in `world` seen in the last 10 s except `except`. Stale entries are dropped here. */
  others(world: string, except: string, now = Date.now()): PresenceEntry[] {
    const m = this.worlds.get(world);
    if (!m) return [];
    const out: PresenceEntry[] = [];
    for (const [account, e] of m) {
      if (now - e.t > STALE_MS) { m.delete(account); if (this.where.get(account) === world) this.where.delete(account); continue; }
      if (account !== except) out.push({ account, name: this.displayName(account), x: e.x, y: e.y, dir: e.dir, scene: e.scene });
    }
    return out;
  }

  chat(account: string, world: string, raw: unknown, now = Date.now()): ChatMsg {
    // eslint-disable-next-line no-control-regex
    const text = (typeof raw === 'string' ? raw : '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (!text) throw new HttpError(400, 'Pesan kosong');
    if (Array.from(text).length > CHAT_MAX) throw new HttpError(400, `Pesan maksimal ${CHAT_MAX} karakter`);
    const last = this.lastChat.get(account);
    if (last !== undefined && now - last < CHAT_GAP_MS) throw new HttpError(429, 'Terlalu cepat, tunggu sebentar');
    this.lastChat.set(account, now);
    if (this.lastChat.size > 5000) for (const [a, t] of this.lastChat) if (now - t > CHAT_GAP_MS) this.lastChat.delete(a);
    const msg: ChatMsg = { account, name: this.displayName(account), text: text.replace(BAD_RE, (w) => '*'.repeat(w.length)), t: now };
    const l = this.log.get(world) ?? [];
    l.push(msg);
    if (l.length > CHAT_KEEP) l.splice(0, l.length - CHAT_KEEP);
    this.log.set(world, l);
    this.listeners.get(world)?.forEach((fn) => fn(msg));
    return msg;
  }

  recent(world: string): ChatMsg[] { return [...(this.log.get(world) ?? [])]; }

  /** Calls `fn` for each new chat line in `world`; returns the unsubscribe function. */
  subscribe(world: string, fn: (m: ChatMsg) => void): () => void {
    let s = this.listeners.get(world);
    if (!s) this.listeners.set(world, (s = new Set()));
    s.add(fn);
    return () => { s!.delete(fn); };
  }
}
