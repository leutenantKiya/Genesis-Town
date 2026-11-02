// Signed off-chain requests (M4). Every request a signed-in player makes to the game server (state, actions, history,
// chat) is signed with that player's session key, the same ed25519 key that signs their relayed transactions. The
// server accepts it only when:
// - the key is a session key the server registered for that account (store.session_keys);
// - the signature covers the method, path with query, timestamp and the body's hash;
// - the timestamp is within 2 minutes of the server clock;
// - the same signature has not been seen before (replay cache for the 2-minute window).
// Before M4 the server trusted an `x-account-id` header, so anyone could act as any player off-chain.
//
// Headers: x-account-id, x-gt-key ("ed25519:<base58>"), x-gt-ts (ms since epoch), x-gt-sig (base64, 64 bytes).
// Signed message (UTF-8): "GT1\n<METHOD>\n<path?query>\n<ts>\n<sha256 hex of the body, or of '' when none>".
import { createHash } from 'node:crypto';
import { PublicKey } from 'near-api-js';
import type { IncomingHttpHeaders } from 'node:http';
import { HttpError } from './auth.ts';

export const SKEW_MS = 120_000;

export function requestMessage(method: string, pathQuery: string, ts: string, body: string): string {
  return `GT1\n${method.toUpperCase()}\n${pathQuery}\n${ts}\n${createHash('sha256').update(body).digest('hex')}`;
}

export class ReplayCache {
  seen = new Map<string, number>();
  /** Returns false when `sig` was already used; remembers it until it can no longer pass the time check. */
  take(sig: string, now: number): boolean {
    if (this.seen.size > 50_000) for (const [k, t] of this.seen) if (now - t > 2 * SKEW_MS) this.seen.delete(k);
    if (this.seen.has(sig)) return false;
    this.seen.set(sig, now);
    return true;
  }
}

export interface ReqAuthDeps { sessionKeyOwner(key: string): string | undefined; replay: ReplayCache; now?: () => number }

/** Verifies a signed request and returns the account it acts for. */
export function verifyRequest(d: ReqAuthDeps, h: IncomingHttpHeaders, method: string, pathQuery: string, body: string): string {
  const account = h['x-account-id'], key = h['x-gt-key'], ts = h['x-gt-ts'], sig = h['x-gt-sig'];
  if (typeof account !== 'string' || typeof key !== 'string' || typeof ts !== 'string' || typeof sig !== 'string') throw new HttpError(401, 'not signed in');
  if (d.sessionKeyOwner(key) !== account) throw new HttpError(401, 'unknown session key for this account');
  const now = (d.now ?? Date.now)();
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(now - t) > SKEW_MS) throw new HttpError(401, 'request expired: check your clock');
  let ok = false;
  try {
    const raw = Buffer.from(sig, 'base64');
    ok = raw.length === 64 && PublicKey.from(key).verify(new TextEncoder().encode(requestMessage(method, pathQuery, ts, body)), new Uint8Array(raw));
  } catch { ok = false; }
  if (!ok) throw new HttpError(401, 'bad request signature');
  if (!d.replay.take(sig, now)) throw new HttpError(401, 'request already used');
  return account;
}
