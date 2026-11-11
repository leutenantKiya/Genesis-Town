// Player-visible server text is English. A client that plays in Bahasa Indonesia sends `X-GT-Lang: id`, and every JSON
// response is then run through toId(): known sentences (i18n-id.ts) are swapped for their Indonesian text, with the item,
// merchant and building names inside them translated too. Anything unknown stays English, which is always readable.
import { EXACT, PATTERNS, NAMES } from './i18n-id.ts';

export type Lang = 'en' | 'id';

export function langOf(header: unknown): Lang { return header === 'id' ? 'id' : 'en'; }

const NAME_LOWER = new Map<string, string>(Object.entries(NAMES).map(([en, id]) => [en.toLowerCase(), id.toLowerCase()]));
export function mapName(s: string): string {
  const hit = NAMES[s];
  if (hit !== undefined) return hit;
  const lower = NAME_LOWER.get(s.toLowerCase());
  return lower !== undefined ? (s[0] === s[0].toUpperCase() ? lower[0].toUpperCase() + lower.slice(1) : lower) : s;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const COMPILED = [...PATTERNS].sort((a, b) => b[0].replace(/\{\d+\}/g, '').length - a[0].replace(/\{\d+\}/g, '').length).map(([en, id]) => {
  const slots: number[] = [];
  const src = en.split(/(\{\d+\})/).map((part) => {
    const m = /^\{(\d+)\}$/.exec(part);
    if (m) { slots.push(+m[1]); return '((?:(?![.!?]\\s)[\\s\\S])+?)'; }
    return esc(part);
  }).join('');
  return { re: new RegExp('^' + src + '$', 's'), slots, id };
});

function sentence(s: string): string {
  const exact = EXACT[s];
  if (exact !== undefined) return exact;
  for (const c of COMPILED) {
    const m = c.re.exec(s);
    if (!m) continue;
    const vals: Record<number, string> = {};
    c.slots.forEach((slot, i) => { vals[slot] = mapName(m[i + 1]); });
    return c.id.replace(/\{(\d+)\}/g, (_x, i) => vals[+i] ?? '');
  }
  return NAMES[s] ?? s;
}

/** One string: tried whole, then piece by piece (sentences and " · " parts that the server glues together). */
export function toId(s: string): string {
  if (s.length < 2 || s.length > 600) return s;
  const whole = sentence(s);
  if (whole !== s) return whole;
  const parts = s.split(/(\s·\s|(?<=[.!?])\s+)/);
  if (parts.length < 3) return s;
  return parts.map((p, i) => (i % 2 === 1 ? p : p ? sentence(p) : p)).join('');
}

// keys whose strings are player input or ids, never translated
const SKIP = new Set(['account', 'account_id', 'id', 'tx_hash', 'token', 'token_id', 'tag', 'sender', 'receiver_id', 'seller', 'root', 'key', 'public_key']);
// player names: only the merchants' own names are translated (players cannot take those names)
const PERSON = new Set(['nick', 'from', 'to', 'who', 'owner']);
const MERCHANT_NAMES = new Set(['Sarah', 'Ben', 'Wendy', 'Jack', 'Granny Daisy']);

export function localizeJson(v: unknown, key = '', chat = false): unknown {
  if (typeof v === 'string') {
    if (SKIP.has(key) || (chat && key === 'text')) return v;
    if (PERSON.has(key)) return MERCHANT_NAMES.has(v) ? (NAMES[v] ?? v) : v;
    return toId(v);
  }
  if (Array.isArray(v)) return v.map((x) => localizeJson(x, key, chat));
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    const obj = v as Record<string, unknown>;
    const isChat = 'from' in obj && 'text' in obj; // a chat line: the text is what a player typed
    for (const [k, x] of Object.entries(obj)) o[k] = localizeJson(x, k, isChat);
    return o;
  }
  return v;
}
