// New device (M4): a returning player on a browser without their session key adds a fresh one, signed by their own
// NEAR Auth key. No wallet and no NEAR needed on the player's side:
// 1. the browser builds a NEP-366 delegate action on the player's account: AddKey(new session key, function-call access
//    to the game contract only), signed by the player's NEAR Auth (MPC-derived) key;
// 2. the player approves it in one NEAR Auth popup; the browser gets the signing JWT (it carries the delegate action);
// 3. here: the delegate action is checked strictly, the relayer calls `sign` on the NEAR Auth contract with the JWT,
//    the MPC signature is checked against the player's stored owner key, and the relayer submits the signed delegate;
// 4. the new key is registered as the player's session key.
// Flow and payload shapes: docs.auth.near.org/home/guides/sign-transactions.md and the installed SDK
// (@fast-auth-near/browser-sdk createSignAction / FastAuthSignature).
import { createHash } from 'node:crypto';
import { deserialize } from 'borsh';
import { SCHEMA, encodeDelegateAction, baseEncode, PublicKey } from 'near-api-js';
import type { Config } from './config.ts';
import type { Chain } from './chain.ts';
import type { Store } from './db.ts';
import { HttpError, type TokenVerifier } from './auth.ts';

export interface SignatureRequest { guardId: string; verifyPayload: string; signPayload: number[]; algorithm?: string }

interface DecodedDA {
  senderId: string; receiverId: string; nonce: bigint; maxBlockHeight: bigint;
  publicKey: { ed25519Key?: { data: ArrayLike<number> } };
  actions: Array<{ addKey?: { publicKey: { ed25519Key?: { data: ArrayLike<number> } }; accessKey: { permission: { functionCall?: { receiverId: string; methodNames: string[]; allowance?: bigint | null } } } } }>;
}

const pk = (k?: { data: ArrayLike<number> }) => (k ? 'ed25519:' + baseEncode(Uint8Array.from(k.data)) : '');

/** Reads the ed25519 signature from the NEAR Auth `sign` result (base64 JSON, as FastAuthSignature.fromBase64). */
export function parseMpcSignature(successValueB64: string): Uint8Array {
  let payload: { signature?: number[] };
  try { payload = JSON.parse(Buffer.from(successValueB64, 'base64').toString('utf8')); } catch { throw new HttpError(502, 'NEAR Auth returned no signature'); }
  if (!Array.isArray(payload.signature) || payload.signature.length !== 64) throw new HttpError(502, 'NEAR Auth returned an unexpected signature');
  return Uint8Array.from(payload.signature);
}

export interface NewDeviceDeps { cfg: Config; chain: Chain; store: Store; verify: TokenVerifier; currentBlockHeight: () => Promise<bigint> }

export async function addDeviceKey(d: NewDeviceDeps, body: { idToken?: unknown; delegateAction?: unknown; signatureRequest?: unknown }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body must be a JSON object');
  if (typeof body.idToken !== 'string' || typeof body.delegateAction !== 'string' || !body.signatureRequest) throw new HttpError(400, 'idToken, delegateAction and signatureRequest required');
  let sub: string;
  try { ({ sub } = await d.verify(body.idToken)); } catch (e) { throw new HttpError(401, 'login token rejected: ' + (e as Error).message); }
  const player = d.store.playerBySub(sub);
  if (!player) throw new HttpError(404, 'no account for this login yet');

  let da: DecodedDA;
  try { da = deserialize(SCHEMA.DelegateAction, Buffer.from(body.delegateAction, 'base64')) as DecodedDA; } catch { throw new HttpError(400, 'not a delegate action'); }
  // exactly: on the player's own account, signed by their owner key, one AddKey of a game-only function-call key
  if (da.senderId !== player.account_id || da.receiverId !== player.account_id) throw new HttpError(403, 'must act on your own account');
  if (pk(da.publicKey.ed25519Key) !== player.owner_pk) throw new HttpError(403, 'must be signed by your NEAR Auth key');
  if (da.actions.length !== 1 || !da.actions[0].addKey) throw new HttpError(403, 'exactly one AddKey');
  const add = da.actions[0].addKey;
  const fc = add.accessKey.permission.functionCall;
  if (!fc || fc.receiverId !== d.cfg.gameContractId || fc.methodNames.length !== 0) throw new HttpError(403, 'the new key may only call the game contract');
  const newKey = pk(add.publicKey.ed25519Key);
  if (!newKey) throw new HttpError(400, 'ed25519 session key required');
  // a key this device already signed in with off-chain (onchain = 0) is exactly the one being approved
  const had = d.store.sessionKeyOwner(newKey);
  if (had && (had !== player.account_id || d.store.sessionKeyOnchain(newKey))) throw new HttpError(409, 'session key already belongs to an account');
  const ahead = BigInt(da.maxBlockHeight) - (await d.currentBlockHeight());
  if (ahead <= 0n || ahead > 3000n) throw new HttpError(400, 'delegate expiry out of range');

  const sr = body.signatureRequest as SignatureRequest;
  if (typeof sr.guardId !== 'string' || typeof sr.verifyPayload !== 'string' || !Array.isArray(sr.signPayload) || sr.signPayload.length > 4096) throw new HttpError(400, 'bad signature request');

  // The MPC signs with the player's derived key; the result must verify against the stored owner key over the
  // delegate action's NEP-366 hash, or nothing is submitted.
  const signed = await d.chain.fastAuthSign({ guard_id: sr.guardId, verify_payload: sr.verifyPayload, sign_payload: sr.signPayload, algorithm: sr.algorithm ?? 'eddsa' });
  if (!signed.ok || !signed.value) throw new HttpError(502, 'NEAR Auth signing failed: ' + (signed.error ?? 'no result'));
  const sig = parseMpcSignature(signed.value);
  const hash = createHash('sha256').update(encodeDelegateAction(da as never)).digest();
  if (!PublicKey.from(player.owner_pk).verify(new Uint8Array(hash), sig)) throw new HttpError(400, 'the signature does not match this delegate action');

  const sd = { delegateAction: da, signature: { ed25519Signature: { data: Array.from(sig) } } };
  const r = await d.chain.relay(sd, player.account_id);
  if (!r.ok) throw new HttpError(502, 'adding the key failed: ' + r.error);
  d.store.addSessionKey(newKey, player.account_id);
  d.store.setActiveKey(player.account_id, newKey);
  d.store.addHistory(player.account_id, 'device', 'New device: game session key added (signed with NEAR Auth)', d.chain.mode === 'mock' ? 'mock' : 'ok', r.txHash);
  return { accountId: player.account_id, txHash: r.txHash, signTxHash: signed.txHash };
}
