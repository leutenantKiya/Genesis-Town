// Chain adapter. `TestnetChain` talks to NEAR testnet with near-api-js 7.4; `MockChain` keeps balances in memory for
// tests and for running the server without testnet (labelled "mock" everywhere it shows up).
import { Account, JsonRpcProvider, actions, teraToGas, PublicKey, type KeyPairString } from 'near-api-js';
import type { Config } from './config.ts';
import { PLAYER_METHODS } from './config.ts';

export interface TxResult { txHash: string; ok: boolean; error?: string }
export interface MintEntry { account_id: string; token_id: string; amount: string }

export interface Chain {
  readonly mode: 'testnet' | 'mock';
  createPlayerAccount(accountId: string, ownerPk: string, sessionPk: string): Promise<TxResult>;
  registerPlayer(accountId: string): Promise<TxResult>;
  mintGathered(batch: MintEntry[], mintId: string): Promise<TxResult>;
  relay(signedDelegate: unknown, senderId: string): Promise<TxResult>;
  balances(accountId: string, tokenIds: string[]): Promise<string[]>;
  isMintIdUsed(mintId: string): Promise<boolean>;
  derivedOwnerKey(sub: string): Promise<string>;
}

// Shape of the parts of FinalExecutionOutcome we read.
interface Outcome { transaction: { hash: string }; status: unknown }

function toResult(o: Outcome): TxResult {
  const st = o.status as Record<string, unknown>;
  if (st && typeof st === 'object' && 'Failure' in st) {
    return { txHash: o.transaction.hash, ok: false, error: JSON.stringify(st.Failure).slice(0, 500) };
  }
  return { txHash: o.transaction.hash, ok: true };
}

export class TestnetChain implements Chain {
  readonly mode = 'testnet' as const;
  provider: JsonRpcProvider;
  cfg: Config;
  parent: Account;
  minter: Account;
  relayer: Account;

  constructor(cfg: Config) {
    this.cfg = cfg;
    this.provider = new JsonRpcProvider({ url: cfg.rpcUrl });
    this.parent = new Account(cfg.playersParentId, this.provider, cfg.playersParentPrivateKey as KeyPairString);
    this.minter = new Account(cfg.minterAccountId, this.provider, cfg.minterPrivateKey as KeyPairString);
    this.relayer = new Account(cfg.relayerAccountId, this.provider, cfg.relayerPrivateKeys[0] as KeyPairString);
  }

  async createPlayerAccount(accountId: string, ownerPk: string, sessionPk: string): Promise<TxResult> {
    const o = await this.parent.signAndSendTransaction({
      receiverId: accountId,
      actions: [
        actions.createAccount(),
        actions.transfer(this.cfg.playerInitialNear),
        actions.addFullAccessKey(PublicKey.from(ownerPk)),
        actions.addFunctionCallAccessKey(PublicKey.from(sessionPk), this.cfg.gameContractId, [...PLAYER_METHODS], 0n),
      ],
    });
    return toResult(o as unknown as Outcome);
  }

  async registerPlayer(accountId: string): Promise<TxResult> {
    const o = await this.minter.signAndSendTransaction({
      receiverId: this.cfg.gameContractId,
      actions: [actions.functionCall('register_player', { account_id: accountId }, teraToGas('30'), 0n)],
    });
    return toResult(o as unknown as Outcome);
  }

  async mintGathered(batch: MintEntry[], mintId: string): Promise<TxResult> {
    const o = await this.minter.signAndSendTransaction({
      receiverId: this.cfg.gameContractId,
      actions: [actions.functionCall('mint_gathered', { batch, mint_id: mintId }, teraToGas('100'), 0n)],
    });
    return toResult(o as unknown as Outcome);
  }

  async relay(signedDelegate: unknown, _senderId: string): Promise<TxResult> {
    // relayMetaTransaction wraps the SignedDelegate in a transaction to the sender and pays the gas.
    const o = await this.relayer.relayMetaTransaction(signedDelegate as Parameters<Account['relayMetaTransaction']>[0]);
    return toResult(o as unknown as Outcome);
  }

  async balances(accountId: string, tokenIds: string[]): Promise<string[]> {
    return (await this.provider.callFunction({
      contractId: this.cfg.gameContractId,
      method: 'mt_batch_balance_of',
      args: { account_id: accountId, token_ids: tokenIds },
    })) as string[];
  }

  async isMintIdUsed(mintId: string): Promise<boolean> {
    return (await this.provider.callFunction({
      contractId: this.cfg.gameContractId,
      method: 'is_mint_id_used',
      args: { mint_id: mintId },
    })) as boolean;
  }

  // The NEAR Auth key for a login is derived by the MPC contract at path `jwt#https://<domain>/#<sub>` with
  // predecessor fast-auth.testnet (docs.auth.near.org protocol/concepts/auth0.md, contracts/fast-auth.md).
  async derivedOwnerKey(sub: string): Promise<string> {
    const fa = this.cfg.fastAuth;
    return (await this.provider.callFunction({
      contractId: fa.mpcContractId,
      method: 'derived_public_key',
      args: { path: `jwt#https://${fa.domain}/#${sub}`, predecessor: fa.contractId, domain_id: fa.mpcDomainId },
    })) as string;
  }
}

export class MockChain implements Chain {
  readonly mode = 'mock' as const;
  bal = new Map<string, bigint>(); // `${account}|${token}`
  accounts = new Set<string>();
  usedMints = new Set<string>();
  n = 0;
  failNext = false;

  hash(): string { return `mock-${++this.n}`; }

  async createPlayerAccount(accountId: string): Promise<TxResult> {
    if (this.accounts.has(accountId)) return { txHash: this.hash(), ok: false, error: 'AccountAlreadyExists' };
    this.accounts.add(accountId);
    return { txHash: this.hash(), ok: true };
  }
  async registerPlayer(): Promise<TxResult> { return { txHash: this.hash(), ok: true }; }
  async mintGathered(batch: MintEntry[], mintId: string): Promise<TxResult> {
    if (this.failNext) { this.failNext = false; throw new Error('mock network error'); }
    if (this.usedMints.has(mintId)) return { txHash: this.hash(), ok: false, error: 'mint_id already used' };
    this.usedMints.add(mintId);
    for (const e of batch) {
      const k = `${e.account_id}|${e.token_id}`;
      this.bal.set(k, (this.bal.get(k) ?? 0n) + BigInt(e.amount));
    }
    return { txHash: this.hash(), ok: true };
  }
  async relay(): Promise<TxResult> { return { txHash: this.hash(), ok: true }; }
  async balances(accountId: string, tokenIds: string[]): Promise<string[]> {
    return tokenIds.map((t) => String(this.bal.get(`${accountId}|${t}`) ?? 0n));
  }
  async isMintIdUsed(mintId: string): Promise<boolean> { return this.usedMints.has(mintId); }
  async derivedOwnerKey(sub: string): Promise<string> {
    // Deterministic fake key so tests can check the server never trusts a browser-supplied owner key.
    const { createHash } = await import('node:crypto');
    const { baseEncode } = await import('near-api-js');
    return 'ed25519:' + baseEncode(createHash('sha256').update('mock-owner:' + sub).digest());
  }
}
