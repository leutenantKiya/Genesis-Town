// Shared helpers for the testnet end-to-end scripts: the server's own modules on its own database (run them while the
// server is stopped), new test players with a random stand-in for the NEAR Auth owner key, and session-key delegates
// relayed exactly like the browser does.
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as near from 'near-api-js';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { TestnetChain } from '../src/chain.ts';
import { playerAccountId } from '../src/auth.ts';
import { relay, RateLimiter, blockHeightSource } from '../src/relayer.ts';
import { spendGuard } from '../src/spend.ts';
import { Game } from '../src/game/game.ts';

export async function e2eSetup() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
  process.loadEnvFile(join(root, '.env'));
  const cfg = loadConfig();
  const chain = new TestnetChain(cfg);
  const store = new Store(join(root, cfg.dbPath));
  const game = new Game(store, chain, { merchantParent: cfg.merchantParentId, town: cfg.townAccountId, chunkSize: cfg.settleChunk, worldSeed: cfg.worldSeed });
  await game.init();
  const link = (h: string | null | undefined) => (h ? cfg.explorerTxUrl + h : '(no tx)');
  const provider = new near.JsonRpcProvider({ url: cfg.rpcUrl });
  const relayDeps = {
    cfg, chain, store, limiter: new RateLimiter(30, 2000), currentBlockHeight: blockHeightSource(cfg),
    checkSpend: spendGuard(chain, game),
    afterRelay: async (s: string, m: string, _a: Record<string, unknown>, extra: string[]) => { await game.settlement.refresh([s, ...extra]); if (m === 'project_contribute') await game.syncProjects(); },
    itemName: (t: string) => game.econ.items[t]?.name ?? t,
  };

  async function newPlayer(tag: string) {
    const sub = `e2e|${tag}-${randomUUID().slice(0, 8)}`;
    const owner = near.KeyPair.fromRandom('ed25519'); // stand-in for the NEAR Auth MPC key
    const session = near.KeyPair.fromRandom('ed25519');
    const accountId = playerAccountId(sub, cfg.playersParentId);
    const c = await chain.createPlayerAccount(accountId, owner.getPublicKey().toString(), session.getPublicKey().toString());
    if (!c.ok) throw new Error('create failed: ' + c.error);
    const r = await chain.registerPlayer(accountId);
    if (!r.ok) throw new Error('register failed: ' + r.error);
    store.addPlayer(accountId, sub, owner.getPublicKey().toString());
    store.addSessionKey(session.getPublicKey().toString(), accountId);
    game.onNewPlayer(accountId);
    console.log(`${tag}: ${accountId}\n  create   ${link(c.txHash)}`);
    return { accountId, session };
  }

  async function signedCall(p: { accountId: string; session: near.KeyPair }, method: string, args: Record<string, unknown>) {
    const ak = await provider.viewAccessKey({ accountId: p.accountId, publicKey: p.session.getPublicKey() });
    const height = BigInt((await provider.viewBlock({ finality: 'final' })).header.height);
    const da = near.buildDelegateAction({
      senderId: p.accountId, receiverId: cfg.gameContractId,
      actions: [near.actions.functionCall(method, args, near.teraToGas('40'), 0n)],
      nonce: BigInt(ak.nonce) + 1n, maxBlockHeight: height + 100n, publicKey: p.session.getPublicKey(),
    });
    const sig = p.session.sign(new Uint8Array(createHash('sha256').update(near.encodeDelegateAction(da)).digest()));
    const b64 = Buffer.from(near.encodeSignedDelegate({ delegateAction: da, signature: new near.Signature({ keyType: 0, data: sig.signature }) } as never)).toString('base64');
    return relay(relayDeps, { signedDelegate: b64 });
  }

  /** Settles until every ended game day is on chain (one step settles at most 7 days). */
  async function settleAll() {
    let s = await game.devSettle();
    for (let i = 0; i < 5 && game.settlement.settledThrough() < game.clock.time().settleDay - 1; i++) { await game.step(); s = { ...s, settlements: game.gs.settlements(5) }; }
    for (const r of s.settlements as Array<{ day: number; chunk: number; status: string; tx_hash: string }>) console.log(`  day ${r.day} chunk ${r.chunk} ${r.status} ${link(r.tx_hash)}`);
  }

  const bal = async (a: string, t: string) => Number((await chain.balances(a, [t]))[0]);
  let ok = true;
  const check = (label: string, cond: boolean) => { console.log((cond ? 'PASS ' : 'FAIL ') + label); if (!cond) ok = false; };
  return { cfg, chain, store, game, link, newPlayer, signedCall, settleAll, bal, check, passed: () => ok };
}
