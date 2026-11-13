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

export type TokenVerifier = (idToken: string) => Promise<{ sub: string; iat?: number }>;

// Mock-chain development only (DEV_LOGIN=1 with CHAIN_MODE=mock): "dev:<name>" logs in as sub "dev|<name>".
export function withDevLogin(cfg: Config, inner: TokenVerifier): TokenVerifier {
  if (!cfg.devLogin) return inner;
  return async (idToken) => {
    const m = /^dev:([a-z0-9_-]{1,32})$/.exec(idToken);
    return m ? { sub: 'dev|' + m[1] } : inner(idToken);
  };
}

export function auth0Verifier(cfg: Config, keys?: JWTVerifyGetKey): TokenVerifier {
  // jwks_uri and issuer come from our Auth0 tenant's https://<FASTAUTH_DOMAIN>/.well-known/openid-configuration
  const issuer = `https://${cfg.fastAuth.domain}/`;
  const jwks = keys ?? createRemoteJWKSet(new URL(`${issuer}.well-known/jwks.json`));
  return async (idToken) => {
    const { payload } = await jwtVerify(idToken, jwks, {
      issuer,
      audience: cfg.fastAuth.clientId,
      algorithms: ['RS256'],
    });
    if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('token has no sub');
    return { sub: payload.sub, iat: payload.iat };
  };
}

// "Masuk dengan Google" without NEAR Auth (it only accepts allow-listed domains). Google's ID token is checked as
// https://developers.google.com/identity/gsi/web/guides/verify-google-id-token says: signed by a key from
// https://www.googleapis.com/oauth2/v3/certs, `iss` accounts.google.com or https://accounts.google.com, `aud` our
// client id, `exp` not passed. The player is filed under "google-oauth2|<sub>", the id NEAR Auth's Auth0 tenant gives
// the same Google account, so both buttons lead to one account and one MPC-derived owner key.
export const GOOGLE_CERTS = 'https://www.googleapis.com/oauth2/v3/certs';
export function googleVerifier(clientId: string, keys?: JWTVerifyGetKey): TokenVerifier {
  const jwks = keys ?? createRemoteJWKSet(new URL(GOOGLE_CERTS));
  return async (idToken) => {
    const { payload } = await jwtVerify(idToken, jwks, {
      issuer: ['accounts.google.com', 'https://accounts.google.com'],
      audience: clientId,
      algorithms: ['RS256'],
    });
    if (typeof payload.sub !== 'string' || !/^[0-9]{1,64}$/.test(payload.sub)) throw new Error('token has no Google account id');
    return { sub: 'google-oauth2|' + payload.sub, iat: payload.iat };
  };
}

// Deterministic, privacy-preserving account name: p<hash of sub>.<players parent>. The salt changed in M2
// ("genesis-town:m2:") because M1 accounts carry a session key limited to `send_item`.
export function playerAccountId(sub: string, parent: string): string {
  const h = createHash('sha256').update('genesis-town:m2:' + sub).digest('hex').slice(0, 16);
  return `p${h}.${parent}`;
}

export function isEd25519Key(s: unknown): s is string {
  if (typeof s !== 'string' || !s.startsWith('ed25519:')) return false;
  try { PublicKey.from(s); return true; } catch { return false; }
}

/** A key added to an existing account without NEAR Auth needs a login token issued in the last 10 minutes (a stolen old token is not enough). Dev logins have no iat. */
export const FRESH_LOGIN_SECS = 600;
function requireFreshLogin(iat: number | undefined, now = Date.now()) {
  if (iat !== undefined && now / 1000 - iat > FRESH_LOGIN_SECS) throw new HttpError(401, 'Please sign in again.');
}

// Accounts known to be registered in the contract, per chain, so the on-chain check runs at most once per account per run.
const knownRegistered = new WeakMap<object, Set<string>>();

/** A player row can exist without the contract registration (registerPlayer failed after the account was created). Retry on later logins. */
export async function ensureRegistered(deps: { chain: Chain; store: Store }, accountId: string): Promise<string[]> {
  let known = knownRegistered.get(deps.chain);
  if (!known) { known = new Set(); knownRegistered.set(deps.chain, known); }
  if (known.has(accountId)) return [];
  const txHashes: string[] = [];
  try {
    if (await deps.chain.isRegistered(accountId)) { known.add(accountId); return txHashes; }
    const reg = await deps.chain.registerPlayer(accountId);
    txHashes.push(reg.txHash);
    deps.store.addHistory(accountId, 'storage', 'Registered in the game contract', reg.ok ? (deps.chain.mode === 'mock' ? 'mock' : 'ok') : 'failed', reg.txHash);
    if (reg.ok) known.add(accountId);
  } catch { /* RPC hiccup: the next login tries again */ }
  return txHashes;
}

export interface RegisterResult { accountId: string; created: boolean; txHashes: string[]; needsChainApproval?: boolean; ownerPublicKey?: string }

export const LEGACY_MESSAGE = 'This account was made with the old NEAR Auth and is retired. Please make a new account with a different login.';
/** A player made with NEAR's shared (public) NEAR Auth before we ran our own: the owner key stored for them is not the one
 *  our NEAR Auth derives for the same login. Such accounts cannot be approved on a new device and are retired by an admin
 *  (src/purge.ts); their logins are answered with LEGACY_MESSAGE. */
export async function isLegacyOwner(chain: Chain, p: { sub: string; owner_pk: string }): Promise<boolean> {
  return (await chain.derivedOwnerKey(p.sub)) !== p.owner_pk;
}

export async function register(
  deps: { cfg: Config; chain: Chain; store: Store; verify: TokenVerifier; verifyGoogle?: TokenVerifier; onNewPlayer?: (accountId: string) => void },
  body: { idToken?: unknown; sessionPublicKey?: unknown; provider?: unknown },
): Promise<RegisterResult> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body must be a JSON object');
  if (!deps.cfg.fastAuth.enabled) throw new HttpError(503, 'Login is not set up on this server (the FASTAUTH_* settings are missing).');
  if (typeof body.idToken !== 'string') throw new HttpError(400, 'idToken required');
  if (!isEd25519Key(body.sessionPublicKey)) throw new HttpError(400, 'sessionPublicKey must be an ed25519 public key');
  if (body.provider !== undefined && body.provider !== 'near' && body.provider !== 'google') throw new HttpError(400, 'provider must be "near" or "google"');
  const verify = body.provider === 'google' ? deps.verifyGoogle : deps.verify;
  if (!verify) throw new HttpError(400, 'Google login is not set up on this server');
  let sub: string, iat: number | undefined;
  try { ({ sub, iat } = await verify(body.idToken)); } catch (e) {
    throw new HttpError(401, 'login token rejected: ' + (e as Error).message);
  }
  const existing = deps.store.playerBySub(sub);
  if (existing) {
    // admins keep their account even when it was made with the old NEAR Auth (they run the purge, and are never purged)
    if (!deps.cfg.adminAccounts.includes(existing.account_id) && await isLegacyOwner(deps.chain, existing).catch(() => false)) throw new HttpError(409, LEGACY_MESSAGE, 'legacy_account');
    // Same login again, or the same login on a new device. The verified login token is the proof of identity, so a new
    // device plays off-chain at once with its key stored as onchain = 0. The key is added to the NEAR account (signed by
    // the player's NEAR Auth key, POST /api/auth/add-key, src/newdevice.ts) only when the player first needs the relayer.
    const owner = deps.store.sessionKeyOwner(body.sessionPublicKey);
    if (owner && owner !== existing.account_id) throw new HttpError(409, 'session key already belongs to another account');
    if (!owner) { requireFreshLogin(iat); deps.store.addSessionKey(body.sessionPublicKey, existing.account_id, false); }
    deps.store.setActiveKey(existing.account_id, body.sessionPublicKey);
    await ensureRegistered(deps, existing.account_id);
    if (deps.store.sessionKeyOnchain(body.sessionPublicKey)) return { accountId: existing.account_id, created: false, txHashes: [] };
    return { accountId: existing.account_id, created: false, txHashes: [], needsChainApproval: true, ownerPublicKey: existing.owner_pk };
  }
  // A session key belongs to exactly one account. A second login in the same browser must bring a fresh key.
  if (deps.store.sessionKeyOwner(body.sessionPublicKey)) throw new HttpError(409, 'session key already belongs to another account');
  const ownerPk = await deps.chain.derivedOwnerKey(sub);
  const accountId = playerAccountId(sub, deps.cfg.playersParentId);
  if (deps.store.isRetired(accountId)) throw new HttpError(409, LEGACY_MESSAGE, 'legacy_account');
  // The account name comes from the login, so the account can already be on chain while this server's database has
  // no row for it (a fresh database after a redeploy, or another server on the same parent). Adopt it instead of
  // trying to create it again, which fails with AccountAlreadyExists on every login.
  const onChain = await deps.chain.accountHasKey(accountId, body.sessionPublicKey);
  if (onChain !== null) return adopt(deps, sub, accountId, ownerPk, body.sessionPublicKey, onChain, iat);
  let created: Awaited<ReturnType<Chain['createPlayerAccount']>>;
  try { created = await deps.chain.createPlayerAccount(accountId, ownerPk, body.sessionPublicKey); } catch (e) {
    // created in between (two logins at once): adopt it like above
    if (!/already exists|AccountAlreadyExists/i.test(String((e as Error)?.message ?? e))) throw e;
    return adopt(deps, sub, accountId, ownerPk, body.sessionPublicKey, !!(await deps.chain.accountHasKey(accountId, body.sessionPublicKey)), iat);
  }
  if (!created.ok) {
    if (/AccountAlreadyExists|already exists/i.test(created.error ?? '')) return adopt(deps, sub, accountId, ownerPk, body.sessionPublicKey, !!(await deps.chain.accountHasKey(accountId, body.sessionPublicKey)), iat);
    throw new HttpError(502, 'account creation failed: ' + created.error);
  }
  deps.store.addPlayer(accountId, sub, ownerPk);
  deps.store.addSessionKey(body.sessionPublicKey, accountId);
  deps.store.setActiveKey(accountId, body.sessionPublicKey);
  deps.store.addHistory(accountId, 'account', 'Account created (NEAR Auth key + game session key)', deps.chain.mode === 'mock' ? 'mock' : 'ok', created.txHash);
  const reg = await deps.chain.registerPlayer(accountId);
  deps.store.addHistory(accountId, 'storage', 'Registered in the game contract', reg.ok ? (deps.chain.mode === 'mock' ? 'mock' : 'ok') : 'failed', reg.txHash);
  if (reg.ok) { let k = knownRegistered.get(deps.chain); if (!k) knownRegistered.set(deps.chain, k = new Set()); k.add(accountId); }
  deps.onNewPlayer?.(accountId);
  return { accountId, created: true, txHashes: [created.txHash, reg.txHash] };
}

// An account that exists on chain but not in this database. Its name and its owner key both come from the login, so it
// is this player's. With the browser's session key already on it the key is stored as on chain; otherwise it plays
// off-chain and is approved later like any new device (needsChainApproval).
async function adopt(
  deps: { chain: Chain; store: Store },
  sub: string, accountId: string, ownerPk: string, sessionPk: string, hasKey: boolean, iat?: number,
): Promise<RegisterResult> {
  if (!hasKey) {
    requireFreshLogin(iat);
    // the account was made under another NEAR Auth deployment: its owner key is not this one, nobody here can approve it
    if ((await deps.chain.accountHasKey(accountId, ownerPk)) !== true) throw new HttpError(409, LEGACY_MESSAGE, 'legacy_account');
  }
  deps.store.addPlayer(accountId, sub, ownerPk);
  const txHashes = await ensureRegistered(deps, accountId);
  deps.store.setActiveKey(accountId, sessionPk);
  if (!hasKey) {
    deps.store.addSessionKey(sessionPk, accountId, false);
    return { accountId, created: false, txHashes, needsChainApproval: true, ownerPublicKey: ownerPk };
  }
  deps.store.addSessionKey(sessionPk, accountId);
  return { accountId, created: false, txHashes };
}

export class HttpError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) { super(message); this.status = status; this.code = code; }
}
