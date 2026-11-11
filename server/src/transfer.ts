// "Move to another device" (client/js/mods/chain.js). The old device encrypts {account, game key} in the browser with a
// random secret S that only ever goes into the code the player types on the other device (code = id + S). The server
// holds the ciphertext for 10 minutes, hands it out ONCE, and forgets it. It never sees S, so it cannot read the key,
// and an old or used code is useless. In memory only: a restart simply invalidates open codes.
import { randomBytes } from 'node:crypto';
import { HttpError } from './auth.ts';

export const TRANSFER_TTL_MS = 10 * 60 * 1000;
export const TRANSFER_MAX_PER_ACCOUNT = 3;
const B64URL = /^[A-Za-z0-9_-]+$/;

interface Entry { account: string; ct: string; iv: string; exp: number }

export class TransferStore {
  entries = new Map<string, Entry>();
  now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }

  /** Drops every expired code. */
  sweep() {
    const t = this.now();
    for (const [id, e] of this.entries) if (e.exp <= t) this.entries.delete(id);
  }

  /** ct and iv are base64url strings from the browser (AES-GCM output). Returns the id half of the code. */
  create(account: string, ct: unknown, iv: unknown): { id: string; expiresInMs: number } {
    if (typeof ct !== 'string' || typeof iv !== 'string' || !B64URL.test(ct) || !B64URL.test(iv) || ct.length > 1024 || iv.length > 64) throw new HttpError(400, 'bad transfer data');
    this.sweep();
    let live = 0;
    for (const e of this.entries.values()) if (e.account === account) live++;
    if (live >= TRANSFER_MAX_PER_ACCOUNT) throw new HttpError(429, 'Too many open codes. Wait for one to expire.');
    const id = randomBytes(12).toString('base64url');
    this.entries.set(id, { account, ct, iv, exp: this.now() + TRANSFER_TTL_MS });
    return { id, expiresInMs: TRANSFER_TTL_MS };
  }

  /** Single use: the code is gone after this call, whatever happens next. */
  redeem(id: unknown): { account: string; ct: string; iv: string } {
    if (typeof id !== 'string' || !B64URL.test(id) || id.length > 64) throw new HttpError(404, 'This code has expired or was already used.');
    const e = this.entries.get(id);
    this.entries.delete(id);
    if (!e || e.exp <= this.now()) throw new HttpError(404, 'This code has expired or was already used.');
    return { account: e.account, ct: e.ct, iv: e.iv };
  }
}
