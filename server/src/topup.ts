// Coin top-up: a player pays NEAR for coin out of the town treasury (contracts/game/src/coin_sale.rs `buy_coin`).
// The payment is NOT a gameplay call (those are function-call session keys with zero deposit, relayer.ts): the player signs a
// NEP-366 delegate action with their NEAR Auth owner key (full access, one NEAR Auth popup, signed by the MPC exactly like
// the new-device approval in newdevice.ts) and the relayer pays only the gas; the deposit comes out of the player's wallet.
// relayer.ts stays strict (game contract, zero deposit, allowlisted methods). This file is the one narrow exception, and it
// accepts exactly one shape: one FunctionCall `buy_coin {receiver_id?}` on the game contract, deposit equal to one of the packs.
import { createHash } from 'node:crypto';
import { deserialize, serialize } from 'borsh';
import { SCHEMA, encodeDelegateAction, baseEncode, PublicKey } from 'near-api-js';
import type { Config } from './config.ts';
import type { Chain, CoinSaleInfo } from './chain.ts';
import type { Store } from './db.ts';
import type { Game } from './game/game.ts';
import { HttpError, type TokenVerifier } from './auth.ts';
import { parseMpcSignature, type SignatureRequest } from './newdevice.ts';

const YOCTO_PER_NEAR = 10n ** 24n;
const MAX_GAS = 30n * 10n ** 12n; // 30 Tgas
const DAY_MS = 86_400_000;
const SALE_CACHE_MS = 30_000;

export interface TopupDeps {
  cfg: Config; chain: Chain; store: Store; game: Game; verify: TokenVerifier;
  currentBlockHeight: () => Promise<bigint>;
  /** Drops cached chain reads for these accounts (chaincheck.ts). */
  invalidate: (accounts: string[]) => void;
}

interface DecodedDA {
  senderId: string; receiverId: string; nonce: bigint; maxBlockHeight: bigint;
  publicKey: { ed25519Key?: { data: ArrayLike<number> } };
  actions: Array<{ functionCall?: { methodName: string; args: Uint8Array; gas: bigint; deposit: bigint } } & Record<string, unknown>>;
}
const pk = (k?: { data: ArrayLike<number> }) => (k ? 'ed25519:' + baseEncode(Uint8Array.from(k.data)) : '');

export interface TopupConfig { rate: number; packs: number[]; dailyMaxCoin: number; reserveNear: number }
function topupCfg(d: TopupDeps): TopupConfig {
  const t = d.game.econ.topup;
  if (!t) throw new HttpError(403, 'Top up is not open yet.');
  return t;
}
/** Price of a pack in yoctoNEAR: coin / rate NEAR. */
export const packYocto = (coin: number, rate: number): bigint => BigInt(coin) * YOCTO_PER_NEAR / BigInt(rate);
const utcDay = (d: TopupDeps) => Math.floor(d.game.now() / DAY_MS);

function assertEnabled(d: TopupDeps) {
  if (!d.cfg.topupEnabled) throw new HttpError(403, 'Top up is not open yet.');
}

/* ------------------------------------------------------------ info */

const saleCache = new WeakMap<Chain, { at: number; sale: CoinSaleInfo | null }>();
async function readSale(d: TopupDeps): Promise<CoinSaleInfo | null> {
  const hit = saleCache.get(d.chain), now = Date.now();
  if (hit && now - hit.at < SALE_CACHE_MS) return hit.sale;
  let sale: CoinSaleInfo | null = null;
  try { sale = await d.chain.coinSale(); } catch { sale = null; } // an unreadable chain is "not open" for now
  saleCache.set(d.chain, { at: now, sale });
  return sale;
}

const legacyCache = new Map<string, boolean>();
async function legacyOwner(d: TopupDeps, sub: string, ownerPk: string): Promise<boolean> {
  const k = `${sub}|${ownerPk}`, hit = legacyCache.get(k);
  if (hit !== undefined) return hit;
  let v = false;
  try { v = (await d.chain.derivedOwnerKey(sub)) !== ownerPk; } catch { return false; } // unknown: let the signature check decide
  if (legacyCache.size > 2000) legacyCache.clear();
  legacyCache.set(k, v);
  return v;
}

/** GET /api/topup/info. `open` is false when the switch is off, the contract has no `coin_sale` (not redeployed) or it is
 *  unconfigured or disabled, or its rate differs from the economy config's. */
export async function topupInfo(d: TopupDeps, account: string) {
  if (!d.cfg.topupEnabled || !d.game.econ.topup) return { open: false };
  const t = d.game.econ.topup, sale = await readSale(d);
  if (!sale || !sale.enabled || sale.coin_per_near !== t.rate) return { open: false };
  const max = Number(sale.max_coin_per_call);
  const player = d.store.playerByAccount(account);
  const used = d.game.gs.topupUsed(account, utcDay(d));
  return {
    open: true, rate: t.rate, packs: t.packs.filter((c) => c <= max), dailyMaxCoin: t.dailyMaxCoin, used, reserveNear: t.reserveNear,
    gameContractId: d.cfg.gameContractId,
    ownerPublicKey: player?.owner_pk ?? null,
    legacyOwner: player ? await legacyOwner(d, player.sub, player.owner_pk) : false,
  };
}

/* ------------------------------------------------------------ resolve */

/** GET /api/topup/resolve?name=nick%23tag: who a top-up would go to. */
export function topupResolve(d: TopupDeps, nameTag: unknown) {
  assertEnabled(d);
  const s = typeof nameTag === 'string' ? nameTag.trim() : '';
  const i = s.lastIndexOf('#');
  const acct = i > 0 ? d.store.accountByNameTag(s.slice(0, i), s.slice(i + 1)) : null;
  if (!acct || !d.store.isPlayer(acct)) throw new HttpError(404, 'Player not found.');
  return { account: acct, nick: d.store.nameOf(acct) ?? acct, tag: d.store.tagOf(acct) };
}

/* ------------------------------------------------------------ relay */

export interface TopupResult { coin: number; tx: string | null; receiver: string; duplicate?: boolean }
const inflight = new Set<string>();

/** The one shape allowed: `buy_coin` with an optional known `receiver_id` and a deposit equal to a pack. Throws 403 otherwise.
 *  Returns the receiver and the coin the deposit buys. */
export function validateBuyCoin(d: TopupDeps, player: { account_id: string; owner_pk: string }, da: DecodedDA): { receiver: string; coin: number; yocto: bigint } {
  const t = topupCfg(d);
  if (da.senderId !== player.account_id) throw new HttpError(403, 'You can only pay from your own account.');
  if (da.receiverId !== d.cfg.gameContractId) throw new HttpError(403, 'receiver must be the game contract');
  if (pk(da.publicKey.ed25519Key) !== player.owner_pk) throw new HttpError(403, 'must be signed by your NEAR Auth key');
  if (da.actions.length !== 1 || !da.actions[0].functionCall) throw new HttpError(403, 'exactly one function call allowed');
  const fc = da.actions[0].functionCall;
  if (fc.methodName !== 'buy_coin') throw new HttpError(403, `method ${fc.methodName} not allowed`);
  if (BigInt(fc.gas) > MAX_GAS) throw new HttpError(403, 'gas above cap');
  const deposit = BigInt(fc.deposit);
  const pack = t.packs.find((c) => packYocto(c, t.rate) === deposit);
  if (pack === undefined) throw new HttpError(403, 'deposit must be the price of a coin pack');
  let args: unknown;
  try { args = JSON.parse(Buffer.from(fc.args).toString('utf8')); } catch { throw new HttpError(403, 'bad call arguments'); }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new HttpError(403, 'bad call arguments');
  const keys = Object.keys(args);
  if (keys.some((k) => k !== 'receiver_id')) throw new HttpError(403, 'bad call arguments');
  const r = (args as { receiver_id?: unknown }).receiver_id;
  if (r !== undefined && r !== null && typeof r !== 'string') throw new HttpError(403, 'bad call arguments');
  const receiver = typeof r === 'string' ? r : player.account_id;
  if (!d.store.isPlayer(receiver)) throw new HttpError(403, 'The receiver is not a known player.');
  return { receiver, coin: pack, yocto: deposit };
}

/** POST /api/topup/relay (signed request from `account`): { idToken, delegateAction, signatureRequest, pack?, receiver? }. */
export async function topupRelay(d: TopupDeps, account: string, body: Record<string, unknown>): Promise<TopupResult> {
  assertEnabled(d);
  const t = topupCfg(d);
  if (typeof body.idToken !== 'string' || typeof body.delegateAction !== 'string' || !body.signatureRequest || typeof body.signatureRequest !== 'object') throw new HttpError(400, 'idToken, delegateAction and signatureRequest required');
  let sub: string;
  try { ({ sub } = await d.verify(body.idToken)); } catch (e) { throw new HttpError(401, 'login token rejected: ' + (e as Error).message); }
  const player = d.store.playerBySub(sub);
  if (!player || player.account_id !== account) throw new HttpError(403, 'This login is not the account you are playing.');

  let bytes: Uint8Array, da: DecodedDA;
  try {
    bytes = new Uint8Array(Buffer.from(body.delegateAction, 'base64'));
    da = deserialize(SCHEMA.DelegateAction, bytes) as DecodedDA;
    if (Buffer.compare(Buffer.from(serialize(SCHEMA.DelegateAction, da)), Buffer.from(bytes)) !== 0) throw new Error('non-canonical');
  } catch { throw new HttpError(400, 'not a delegate action'); }
  const { receiver, coin, yocto } = validateBuyCoin(d, player, da);
  // what the player's screen said must be what was signed
  if (body.pack !== undefined && body.pack !== coin) throw new HttpError(400, 'The pack does not match what was signed.');
  if (body.receiver !== undefined && body.receiver !== null && body.receiver !== receiver) throw new HttpError(400, 'The receiver does not match what was signed.');
  const ahead = BigInt(da.maxBlockHeight) - (await d.currentBlockHeight());
  if (ahead <= 0n || ahead > 3000n) throw new HttpError(400, 'delegate expiry out of range');
  const sr = body.signatureRequest as SignatureRequest;
  if (typeof sr.guardId !== 'string' || typeof sr.verifyPayload !== 'string' || !Array.isArray(sr.signPayload) || sr.signPayload.length > 4096) throw new HttpError(400, 'bad signature request');

  const hash = createHash('sha256').update(encodeDelegateAction(da as never)).digest('hex');
  const seen = d.game.gs.topupByDelegate(hash);
  if (seen) {
    if (seen.status === 'ok') return { coin: seen.coin, tx: seen.tx_hash, receiver: seen.receiver, duplicate: true };
    if (seen.status === 'pending') throw new HttpError(409, 'This top-up is still being processed.');
    throw new HttpError(409, 'This top-up did not go through. Start a new one.');
  }
  if (inflight.has(hash)) throw new HttpError(409, 'This top-up is still being processed.');
  inflight.add(hash);
  try {
    d.game.assertActive(account);
    if (!(await d.chain.isRegistered(receiver))) throw new HttpError(409, 'The receiver has no game account on the network yet.');
    const [townCoin] = await d.chain.balances(d.game.town, ['coin']);
    if (Number(townCoin) < coin) throw new HttpError(409, 'The town treasury is short of coin right now. Try a smaller pack later.');
    // from here to the insert nothing is awaited: the daily cap check and the pending row are one step
    const day = utcDay(d);
    if (d.game.gs.topupUsed(account, day) + coin > t.dailyMaxCoin) throw new HttpError(409, 'You reached today\'s top-up limit.');
    d.game.gs.topupBegin(hash, account, receiver, String(yocto), coin, day, d.game.now());

    let tx: string | null = null;
    try {
      const signed = await d.chain.fastAuthSign({ guard_id: sr.guardId, verify_payload: sr.verifyPayload, sign_payload: sr.signPayload, algorithm: sr.algorithm ?? 'eddsa' });
      if (!signed.ok || !signed.value) throw new HttpError(502, 'NEAR Auth signing failed: ' + (signed.error ?? 'no result'));
      const sig = parseMpcSignature(signed.value);
      const digest = createHash('sha256').update(encodeDelegateAction(da as never)).digest();
      if (!PublicKey.from(player.owner_pk).verify(new Uint8Array(digest), sig)) throw new HttpError(400, 'the signature does not match this delegate action');
      const sd = { delegateAction: da, signature: { ed25519Signature: { data: Array.from(sig) } } };
      const r = await d.chain.relay(sd, account);
      if (!r.ok) throw new HttpError(502, 'The top-up did not go through' + (r.error ? ': ' + r.error : '.'));
      tx = r.txHash;
    } catch (e) {
      d.game.gs.topupFail(hash);
      throw e;
    }
    try { d.game.gs.topupDone(hash, tx); } catch (e) { console.error('topup: could not book', tx, (e as Error).message); }
    // the coin moved on chain: the books start from what the chain holds now, so the chain check stays quiet
    try { await d.game.settlement.refresh([receiver, d.game.town]); } catch (e) { console.error('topup: refresh failed:', (e as Error).message); }
    d.invalidate([account, receiver, d.game.town]);
    const status = d.chain.mode === 'mock' ? 'mock' : 'ok';
    const who = d.store.nameOf(receiver) ?? receiver;
    d.store.addHistory(receiver, 'topup', account === receiver ? `Top up: bought ${coin} coin with NEAR` : `Top up: ${d.store.nameOf(account) ?? account} bought you ${coin} coin`, status, tx, null, ['coin']);
    if (account !== receiver) d.store.addHistory(account, 'topup', `Top up: bought ${coin} coin for ${who}`, status, tx, null, ['coin']);
    return { coin, tx, receiver };
  } finally { inflight.delete(hash); }
}
