import { createHash } from 'node:crypto';
import * as near from 'near-api-js';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { MockChain } from '../src/chain.ts';

export function setup() {
  const cfg = loadConfig({ CHAIN_MODE: 'mock', GAME_CONTRACT_ID: 'game.test', PLAYERS_PARENT_ACCOUNT_ID: 'players.test', TOWN_ACCOUNT_ID: 'town.gt.test', MERCHANT_PARENT_ACCOUNT_ID: 'gt.test' } as NodeJS.ProcessEnv);
  const store = new Store(':memory:');
  const chain = new MockChain();
  return { cfg, store, chain };
}

export interface DelegateOpts {
  sender: string;
  receiver?: string;
  method?: string;
  args?: Record<string, unknown>;
  deposit?: bigint;
  gasTera?: string;
  maxBlockHeight?: bigint;
  nonce?: bigint;
  key?: near.KeyPair;
  extraAction?: boolean;
}

export function signedDelegateB64(o: DelegateOpts): { b64: string; key: near.KeyPair } {
  const key = o.key ?? near.KeyPair.fromRandom('ed25519');
  const acts = [near.actions.functionCall(o.method ?? 'send_item', o.args ?? { receiver_id: 'p2.players.test', token_id: 'fish', amount: '1' }, near.teraToGas((o.gasTera ?? '10') as `${number}`), o.deposit ?? 0n)];
  if (o.extraAction) acts.push(near.actions.transfer(1n));
  const da = near.buildDelegateAction({
    senderId: o.sender,
    receiverId: o.receiver ?? 'game.test',
    actions: acts,
    nonce: o.nonce ?? 1n,
    maxBlockHeight: o.maxBlockHeight ?? 150n,
    publicKey: key.getPublicKey(),
  });
  const msg = new Uint8Array(createHash('sha256').update(near.encodeDelegateAction(da)).digest());
  const sig = key.sign(msg);
  const sd = { delegateAction: da, signature: new near.Signature({ keyType: 0, data: sig.signature }) };
  return { b64: Buffer.from(near.encodeSignedDelegate(sd as never)).toString('base64'), key };
}
