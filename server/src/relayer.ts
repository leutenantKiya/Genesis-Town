// NEP-366 relayer. Accepts a base64 Borsh SignedDelegate from a player's browser, checks it against a strict policy,
// rate-limits per account, submits it with the relayer's key (which pays the gas) and records it in Riwayat.
// Policy: sender is a registered player, the signing key is that player's registered session key, receiver is the
// game contract, exactly one FunctionCall to an allowlisted method, zero deposit, gas under the cap, short expiry.
import { createHash } from 'node:crypto';
import { deserialize, serialize } from 'borsh';
import { SCHEMA, encodeDelegateAction, baseEncode, PublicKey, JsonRpcProvider } from 'near-api-js';
import { RELAY_METHODS, type Config } from './config.ts';
import type { Chain } from './chain.ts';
import type { Store } from './db.ts';
import { HttpError } from './auth.ts';

interface FunctionCallAction { functionCall: { methodName: string; args: Uint8Array; gas: bigint; deposit: bigint } }
export interface DecodedDelegate {
  delegateAction: {
    senderId: string;
    receiverId: string;
    actions: Array<Partial<FunctionCallAction> & Record<string, unknown>>;
    nonce: bigint;
    maxBlockHeight: bigint;
    publicKey: { ed25519Key?: { data: ArrayLike<number> } } & Record<string, unknown>;
  };
  signature: { ed25519Signature?: { data: ArrayLike<number> } } & Record<string, unknown>;
}

export function decodeSignedDelegate(b64: string): { sd: DecodedDelegate; bytes: Uint8Array } {
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(Buffer.from(b64, 'base64')); } catch { throw new HttpError(400, 'bad base64'); }
  let sd: DecodedDelegate;
  try { sd = deserialize(SCHEMA.SignedDelegate, bytes) as DecodedDelegate; } catch (e) {
    throw new HttpError(400, 'not a SignedDelegate: ' + (e as Error).message);
  }
  // Re-encode and compare so trailing bytes or alternate encodings are rejected.
  const again = serialize(SCHEMA.SignedDelegate, sd);
  if (Buffer.compare(Buffer.from(again), Buffer.from(bytes)) !== 0) throw new HttpError(400, 'non-canonical encoding');
  return { sd, bytes };
}

export function delegateKey(sd: DecodedDelegate): string {
  const d = sd.delegateAction.publicKey.ed25519Key?.data;
  if (!d) throw new HttpError(400, 'only ed25519 session keys are accepted');
  return 'ed25519:' + baseEncode(Uint8Array.from(d));
}

export function verifyDelegateSignature(sd: DecodedDelegate): boolean {
  const sig = sd.signature.ed25519Signature?.data;
  if (!sig) return false;
  const msg = createHash('sha256').update(encodeDelegateAction(sd.delegateAction as never)).digest();
  return PublicKey.from(delegateKey(sd)).verify(new Uint8Array(msg), Uint8Array.from(sig));
}

export class RateLimiter {
  perMinute: number;
  perDay: number;
  hits = new Map<string, number[]>();
  constructor(perMinute: number, perDay: number) { this.perMinute = perMinute; this.perDay = perDay; }
  take(key: string, now = Date.now()): boolean {
    const day = 86_400_000;
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < day);
    const lastMinute = arr.filter((t) => now - t < 60_000).length;
    if (lastMinute >= this.perMinute || arr.length >= this.perDay) { this.hits.set(key, arr); return false; }
    arr.push(now);
    this.hits.set(key, arr);
    return true;
  }
}

export interface RelayDeps {
  cfg: Config;
  chain: Chain;
  store: Store;
  limiter: RateLimiter;
  currentBlockHeight: () => Promise<bigint>;
  /** Runs before submitting; throws to refuse (e.g. the spend guard). Returns extra accounts to refresh afterwards. */
  checkSpend?: (sender: string, method: string, args: Record<string, unknown>) => Promise<string[] | void>;
  /** Display name of an item for Riwayat summaries. */
  itemName?: (token: string) => string;
  afterRelay?: (sender: string, method: string, args: Record<string, unknown>, extra: string[]) => Promise<void>;
}

export function blockHeightSource(cfg: Config): () => Promise<bigint> {
  const p = new JsonRpcProvider({ url: cfg.rpcUrl });
  return async () => BigInt((await p.viewBlock({ finality: 'final' })).header.height);
}

const SUMMARY: Record<string, (a: Record<string, unknown>, n: (t: unknown) => string) => string> = {
  send_item: (a, n) => `Kirim ${a.amount} ${n(a.token_id)} ke ${a.receiver_id}`,
  restore_contribute: (a, n) => `Sumbang ke papan pemulihan ${String(a.merchant).split('.')[0]}: ${((a.contribution as Array<{ token_id: string; amount: string }>) ?? []).map((l) => `${l.amount} ${n(l.token_id)}`).join(', ')}`,
  restore_withdraw: (a) => `Tarik sumbangan dari ${String(a.merchant).split('.')[0]}`,
  claim_dividends: (a) => `Ambil dividen dari ${String(a.merchant).split('.')[0]}`,
  list_item: (a, n) => `Pasang ${a.amount} ${n(a.token_id)} di Pasar Pemain, ${a.price_each} koin/buah`,
  buy_listing: (a) => `Beli ${a.amount} dari lapak #${a.listing_id} (maks ${a.max_price_each} koin/buah)`,
  cancel_listing: (a) => `Tarik lapak #${a.listing_id} dari Pasar Pemain`,
  project_contribute: (a, n) => `Sumbang ke proyek desa ${a.id}: ${((a.contribution as Array<{ token_id: string; amount: string }>) ?? []).map((l) => `${l.amount} ${n(l.token_id)}`).join(', ')}`,
  project_withdraw: (a) => `Tarik sumbangan dari proyek desa ${a.id}`,
  buy_island: (a) => `Beli Pulau Pribadi #${a.island_id} seharga ${a.price} koin`,
  save_island: (a) => `Simpan Dunia Pulau #${a.island_id}: versi ${a.from_version} jadi ${Number(a.from_version) + 1}`,
};

/** Items a relayed method is about (buy_listing doesn't say which item; it only moves coin). */
export function relayTokens(method: string, args: Record<string, unknown>): string[] {
  const out = new Set<string>();
  if (typeof args.token_id === 'string') out.add(args.token_id);
  if (Array.isArray(args.contribution)) for (const l of args.contribution as Array<{ token_id?: unknown }>) if (typeof l?.token_id === 'string') out.add(l.token_id);
  if (method === 'buy_listing' || method === 'claim_dividends' || method === 'buy_island') out.add('coin');
  return [...out];
}

// Relays being processed right now (by delegate hash), and a per-account queue: spend-guarded relays of one account
// run one after another, so the second guard sees what the first one spent. Both are in memory on purpose.
const inflight = new Set<string>();
const accountQueue = new Map<string, Promise<unknown>>();

async function serialized<T>(account: string, fn: () => Promise<T>): Promise<T> {
  const prev = accountQueue.get(account) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  accountQueue.set(account, tail);
  try { return await run; } finally { if (accountQueue.get(account) === tail) accountQueue.delete(account); }
}

export interface RelayResult { txHash: string | null; status: string; duplicate?: boolean; error?: string }

export async function relay(deps: RelayDeps, body: { signedDelegate?: unknown }): Promise<RelayResult> {
  if (typeof body.signedDelegate !== 'string') throw new HttpError(400, 'signedDelegate (base64) required');
  const { sd, bytes } = decodeSignedDelegate(body.signedDelegate);
  const da = sd.delegateAction;
  const hash = createHash('sha256').update(bytes).digest('hex');

  const seen = deps.store.relayGet(hash);
  if (seen) return { txHash: seen.tx_hash, status: seen.status, duplicate: true };
  // an identical post that is still being processed is a duplicate too (its 'pending' row is only written later)
  if (inflight.has(hash)) return { txHash: null as string | null, status: 'pending', duplicate: true };
  const key = delegateKey(sd);
  const owner = deps.store.sessionKeyOwner(key);
  if (!owner || owner !== da.senderId) throw new HttpError(403, 'unknown session key for this sender');
  if (da.receiverId !== deps.cfg.gameContractId) throw new HttpError(403, 'receiver must be the game contract');
  if (da.actions.length !== 1 || !da.actions[0].functionCall) throw new HttpError(403, 'exactly one function call allowed');
  const fc = da.actions[0].functionCall;
  if (!(RELAY_METHODS as readonly string[]).includes(fc.methodName)) throw new HttpError(403, `method ${fc.methodName} not allowed`);
  if (BigInt(fc.deposit) !== 0n) throw new HttpError(403, 'deposit must be 0');
  if (BigInt(fc.gas) > BigInt(deps.cfg.relay.maxGasTera) * 10n ** 12n) throw new HttpError(403, 'gas above cap');
  if (!verifyDelegateSignature(sd)) throw new HttpError(403, 'bad signature');
  inflight.add(hash);
  try {
    return await serialized(da.senderId, () => relayLocked(deps, sd, da, fc, hash));
  } finally {
    inflight.delete(hash);
  }
}

async function relayLocked(deps: RelayDeps, sd: ReturnType<typeof decodeSignedDelegate>['sd'], da: ReturnType<typeof decodeSignedDelegate>['sd']['delegateAction'], fc: { methodName: string; args: Uint8Array }, hash: string): Promise<RelayResult> {
  const height = await deps.currentBlockHeight();
  const ahead = BigInt(da.maxBlockHeight) - height;
  if (ahead <= 0n) throw new HttpError(400, 'delegate expired');
  if (ahead > BigInt(deps.cfg.relay.maxBlocksAhead)) throw new HttpError(400, 'delegate expiry too far ahead');
  if (!deps.limiter.take(da.senderId)) throw new HttpError(429, 'Pelan-pelan… terlalu banyak aksi');

  let args: Record<string, unknown> = {};
  try { args = JSON.parse(Buffer.from(fc.args).toString('utf8')); } catch { /* summary falls back below */ }
  const name = (t: unknown) => (deps.itemName ? deps.itemName(String(t)) : String(t));
  const summary = SUMMARY[fc.methodName]?.(args, name) ?? fc.methodName;
  const extra = (await deps.checkSpend?.(da.senderId, fc.methodName, args)) ?? [];
  deps.store.relayPut(hash, da.senderId, 'pending', null);
  const hid = deps.store.addHistory(da.senderId, fc.methodName, summary, 'pending', null, null, relayTokens(fc.methodName, args));
  try {
    const r = await deps.chain.relay(sd, da.senderId);
    const status = r.ok ? (deps.chain.mode === 'mock' ? 'mock' : 'ok') : 'failed';
    deps.store.relayPut(hash, da.senderId, status, r.txHash);
    deps.store.settleHistory(hid, status, r.txHash);
    if (r.ok) await deps.afterRelay?.(da.senderId, fc.methodName, args, extra);
    return { txHash: r.txHash, status, error: r.error };
  } catch (e) {
    deps.store.relayPut(hash, da.senderId, 'failed', null);
    deps.store.settleHistory(hid, 'failed', null);
    throw new HttpError(502, 'relay failed: ' + (e as Error).message);
  }
}
