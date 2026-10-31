// Login verification and account creation.
// The browser sends the Auth0 id token from NEAR Auth's login and a fresh session public key. The server verifies the
// token against the tenant's JWKS, derives the player's NEAR Auth key itself (never trusting the browser for it) and
// creates the player's account with: the NEAR Auth key as full access, the session key as a function-call key that
// can only call the game contract's player methods.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { createHash } from 'node:crypto';
import { PublicKey } from 'near-api-js';
import type { Config } from './config.ts';
import type { Chain } from './chain.ts';
import type { Store } from './db.ts';

export type TokenVerifier = (idToken: string) => Promise<{ sub: string }>;

export function auth0Verifier(cfg: Config, keys?: JWTVerifyGetKey): TokenVerifier {
  // jwks_uri and issuer come from https://login.testnet.fast-auth.com/.well-known/openid-configuration
  const issuer = `https://${cfg.fastAuth.domain}/`;
  const jwks = keys ?? createRemoteJWKSet(new URL(`${issuer}.well-known/jwks.json`));
  return async (idToken) => {
    const { payload } = await jwtVerify(idToken, jwks, {
      issuer,
      audience: cfg.fastAuth.clientId,
      algorithms: ['RS256'],
    });
    if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('token has no sub');
    return { sub: payload.sub };
  };
}

// Deterministic, privacy-preserving account name: p<hash of sub>.<players parent>.
export function playerAccountId(sub: string, parent: string): string {
  const h = createHash('sha256').update('genesis-town:' + sub).digest('hex').slice(0, 16);
  return `p${h}.${parent}`;
}

export function isEd25519Key(s: unknown): s is string {
  if (typeof s !== 'string' || !s.startsWith('ed25519:')) return false;
  try { PublicKey.from(s); return true; } catch { return false; }
}

export interface RegisterResult { accountId: string; created: boolean; txHashes: string[] }

export async function register(
  deps: { cfg: Config; chain: Chain; store: Store; verify: TokenVerifier },
  body: { idToken?: unknown; sessionPublicKey?: unknown },
): Promise<RegisterResult> {
  if (typeof body.idToken !== 'string') throw new HttpError(400, 'idToken required');
  if (!isEd25519Key(body.sessionPublicKey)) throw new HttpError(400, 'sessionPublicKey must be an ed25519 public key');
  let sub: string;
  try { ({ sub } = await deps.verify(body.idToken)); } catch (e) {
    throw new HttpError(401, 'login token rejected: ' + (e as Error).message);
  }
  const existing = deps.store.playerBySub(sub);
  if (existing) {
    // Same login again. Adding another session key needs the owner's NEAR Auth signature (planned, M4).
    const owner = deps.store.sessionKeyOwner(body.sessionPublicKey);
    if (owner === existing.account_id) return { accountId: existing.account_id, created: false, txHashes: [] };
    throw new HttpError(409, 'account exists; this device has no session key yet (new-device flow is planned for M4)');
  }
  const ownerPk = await deps.chain.derivedOwnerKey(sub);
  const accountId = playerAccountId(sub, deps.cfg.playersParentId);
  const created = await deps.chain.createPlayerAccount(accountId, ownerPk, body.sessionPublicKey);
  if (!created.ok) throw new HttpError(502, 'account creation failed: ' + created.error);
  deps.store.addPlayer(accountId, sub, ownerPk);
  deps.store.addSessionKey(body.sessionPublicKey, accountId);
  deps.store.addHistory(accountId, 'account', 'Akun dibuat (kunci NEAR Auth + kunci sesi game)', deps.chain.mode === 'mock' ? 'mock' : 'ok', created.txHash);
  const reg = await deps.chain.registerPlayer(accountId);
  deps.store.addHistory(accountId, 'storage', 'Terdaftar di kontrak game', reg.ok ? (deps.chain.mode === 'mock' ? 'mock' : 'ok') : 'failed', reg.txHash);
  return { accountId, created: true, txHashes: [created.txHash, reg.txHash] };
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
