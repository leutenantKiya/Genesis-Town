// End-to-end check of the player market (contract v3) on NEAR testnet, using the server's own modules and database
// (run it while the server is stopped). Two new players get their starter kit settled, then: A lists 3 Gandum at
// 10 coin each (escrowed), the spend guard refuses a listing of items A doesn't have on chain, B buys 2 (5% of the
// price is burned), and A cancels the rest. Every market call is signed with the player's session key and relayed
// gas-free. As in e2e-testnet.ts, the NEAR Auth owner key is replaced by a random key (Auth0 login needs a person).
//
//   node server/scripts/e2e-market.ts
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

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
process.loadEnvFile(join(root, '.env'));
const cfg = loadConfig();
const chain = new TestnetChain(cfg);
const store = new Store(join(root, cfg.dbPath));
const game = new Game(store, chain, { merchantParent: cfg.merchantParentId, town: cfg.townAccountId, chunkSize: cfg.settleChunk });
await game.init();
const link = (h: string | null | undefined) => (h ? cfg.explorerTxUrl + h : '(no tx)');
const step = (s: string) => console.log('\n== ' + s);
const relayDeps = {
  cfg, chain, store, limiter: new RateLimiter(30, 2000), currentBlockHeight: blockHeightSource(cfg),
  checkSpend: spendGuard(chain, game),
  afterRelay: async (s: string, _m: string, _a: Record<string, unknown>, extra: string[]) => { await game.settlement.refresh([s, ...extra]); },
  itemName: (t: string) => game.econ.items[t]?.name ?? t,
};
const provider = new near.JsonRpcProvider({ url: cfg.rpcUrl });

async function newPlayer(tag: string) {
  const sub = `e2e|${tag}-${randomUUID().slice(0, 8)}`;
  const owner = near.KeyPair.fromRandom('ed25519'); // stand-in for the NEAR Auth MPC key (see header)
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

const bal = async (a: string, t: string) => Number((await chain.balances(a, [t]))[0]);
let ok = true;
const check = (label: string, cond: boolean) => { console.log((cond ? 'PASS ' : 'FAIL ') + label); if (!cond) ok = false; };

step('create two players and settle their starter kits (100 coin, 3 Gandum, ...)');
const A = await newPlayer('A');
const B = await newPlayer('B');
let s = await game.devSettle();
// One step settles at most 7 days; keep going until the starter kits' day is on chain.
for (let i = 0; i < 5 && game.settlement.settledThrough() < game.clock.time().settleDay - 1; i++) { await game.step(); s = { ...s, settlements: game.gs.settlements(5) }; }
for (const r of s.settlements as Array<{ day: number; chunk: number; status: string; tx_hash: string }>) console.log(`  day ${r.day} chunk ${r.chunk} ${r.status} ${link(r.tx_hash)}`);
check('A has 3 Gandum on chain', (await bal(A.accountId, 'wheat')) === 3);

step('spend guard: A tries to list 4 Gandum (has 3) and is refused before anything is sent');
const refused = await signedCall(A, 'list_item', { token_id: 'wheat', amount: '4', price_each: '10' }).then(() => '', (e: Error) => e.message);
console.log('  ' + refused);
check('refused by the spend guard', /tidak cukup/.test(refused));

step('A lists 3 Gandum at 10 coin each (escrowed in the contract)');
const listed = await signedCall(A, 'list_item', { token_id: 'wheat', amount: '3', price_each: '10' });
console.log(`  ${listed.status} ${link(listed.txHash)} ${listed.error ?? ''}`);
const mine = (await chain.listListings(20)).find((l) => l.seller === A.accountId);
check(`listing #${mine?.id} is open with 3 Gandum`, mine?.amount === '3');
check('A has 0 Gandum, the contract holds the escrow', (await bal(A.accountId, 'wheat')) === 0);

step('B buys 2 (20 coin; 1 coin fee burned, 19 to A)');
const supply0 = BigInt(await chain.coinSupply());
const bought = await signedCall(B, 'buy_listing', { listing_id: mine!.id, amount: '2', max_price_each: '10' });
console.log(`  ${bought.status} ${link(bought.txHash)} ${bought.error ?? ''}`);
check('B has 5 Gandum and 80 coin', (await bal(B.accountId, 'wheat')) === 5 && (await bal(B.accountId, 'coin')) === 80);
check('A has 119 coin', (await bal(A.accountId, 'coin')) === 119);
check('coin supply fell by the 1 coin fee', BigInt(await chain.coinSupply()) === supply0 - 1n);

step('A cancels the rest of the listing');
const cancelled = await signedCall(A, 'cancel_listing', { listing_id: mine!.id });
console.log(`  ${cancelled.status} ${link(cancelled.txHash)} ${cancelled.error ?? ''}`);
check('A got 1 Gandum back and the listing is gone', (await bal(A.accountId, 'wheat')) === 1 && (await chain.getListing(mine!.id)) === null);

console.log(ok ? '\nMARKET E2E PASS' : '\nMARKET E2E FAIL');
if (!ok) process.exitCode = 1;
