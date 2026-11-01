// End-to-end check of M2 on NEAR testnet, using the server's own modules and the server's database (run it while the
// server is stopped). Proves: account creation with a session key, off-chain play (gather, sell to a merchant, craft,
// ship), a daily settlement written on chain with the ledger root, a gas-free player transfer, and a shop that
// closes on chain and is reopened through its restoration board (shares issued).
// The player's NEAR Auth owner key is replaced by a random key (Auth0 login needs a person), and Budi's bankruptcy
// is forced with rows labelled "scripted" so the whole cycle fits in one run. Both are printed as such.
//
//   node server/scripts/e2e-testnet.ts
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as near from 'near-api-js';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { TestnetChain } from '../src/chain.ts';
import { playerAccountId } from '../src/auth.ts';
import { relay, RateLimiter, blockHeightSource } from '../src/relayer.ts';
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
const relayDeps = { cfg, chain, store, limiter: new RateLimiter(30, 2000), currentBlockHeight: blockHeightSource(cfg), afterRelay: async (s: string, _m: string, a: Record<string, unknown>) => { await game.settlement.refresh([s, ...(typeof a.receiver_id === 'string' ? [a.receiver_id] : []), ...(typeof a.merchant === 'string' ? [a.merchant] : [])]); await game.settlement.refreshShops(); } };
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
  console.log(`${tag}: ${accountId}\n  create   ${link(c.txHash)}\n  register ${link(r.txHash)}`);
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

const tokens = ['coin', 'fish', 'ore', 'wood', 'bread', 'tool'];
const chainBal = async (a: string) => Object.fromEntries((await chain.balances(a, tokens)).map((v, i) => [tokens[i], Number(v)]));
const offBal = (a: string) => Object.fromEntries(tokens.map((t) => [t, game.gs.balance(a, t)]));
let ok = true;
const check = (label: string, cond: boolean) => { console.log((cond ? 'PASS ' : 'FAIL ') + label); if (!cond) ok = false; };

step('create two players (starter kit: 100 coin, 1 Alat, 3 Roti, 3 Gandum, settled at 06:00)');
const A = await newPlayer('A');
const B = await newPlayer('B');

step('off-chain play by A: gather, sell to Sari, craft, ship (instant, no transactions)');
for (let i = 0; i < 4; i++) console.log('  ' + game.act(A.accountId, { action: 'gather', tile: 'water', x: 900, y: 900 + i % 1 }).toast);
console.log('  ' + game.act(A.accountId, { action: 'sell', merchant: 'sari', token: 'fish', qty: 2 }).toast);
console.log('  ' + game.act(A.accountId, { action: 'craft', recipe: 'bread' }).toast);
console.log('  ' + game.act(A.accountId, { action: 'ship', token: 'bread', qty: 1 }).toast);
for (let i = 0; i < 10; i++) game.act(A.accountId, { action: 'gather', tile: 'rock', x: 800 + i, y: 800 });
for (let i = 0; i < 5; i++) game.act(A.accountId, { action: 'gather', tile: 'tree', x: 700 + i, y: 700 });
console.log(`  +10 Bijih, +5 Kayu (energy left ${game.state(A.accountId).energy})`);

step('scripted: drain Budi so he cannot pay rent (labelled rows, demo only)');
const budi = game.market.account('budi');
const day = game.clock.time().settleDay;
const drain = game.gs.balance(budi, 'coin') - 10;
game.gs.add(day, budi, 'coin', -drain, 'scripted', 'e2e bankruptcy demo');
game.gs.add(day, A.accountId, 'coin', drain, 'scripted', 'e2e bankruptcy demo');
game.gs.add(day, budi, 'tool', -game.gs.balance(budi, 'tool'), 'scripted', 'e2e bankruptcy demo');
const offA = offBal(A.accountId);

step('daily settlement (Dev: jump to 06:00 and settle)');
const s = await game.devSettle();
for (const r of s.settlements as Array<{ day: number; chunk: number; status: string; tx_hash: string }>) console.log(`  day ${r.day} chunk ${r.chunk} ${r.status} ${link(r.tx_hash)}`);
const onA = await chainBal(A.accountId);
const shipPay = game.gs.dayRows(day).filter((r) => r.account === A.accountId && r.kind === 'ship_pay').reduce((x, r) => x + r.delta, 0);
check(`A on chain = A off-chain before settlement (+${shipPay} shipping payout): ${JSON.stringify(onA)}`,
  tokens.every((t) => onA[t] === offA[t] + (t === 'coin' ? shipPay : 0)));
const ledger = game.gs.dayRows(day);
const stored = (await provider.callFunction({ contractId: cfg.gameContractId, method: 'get_day_root', args: { day } })) as string;
const { leafHash, merkleRoot } = await import('../src/game/merkle.ts');
check(`ledger root on chain matches the published ledger (${ledger.length} rows)`, stored === merkleRoot(ledger.map(leafHash)));
const shops = await chain.listShops();
check('Budi closed on chain after failing rent', shops.find((x) => x.account_id === budi)?.open === false);

step('A sends 1 fish to B: session-key delegate, relayed gas-free (on-chain immediately)');
const sent = await signedCall(A, 'send_item', { receiver_id: B.accountId, token_id: 'fish', amount: '1' });
console.log(`  ${sent.status} ${link(sent.txHash)}`);
check('B received the fish', (await chainBal(B.accountId)).fish === 1);

step('A restores Budi: pledges 200 coin, 10 Bijih, 5 Kayu on chain');
const pledge = await signedCall(A, 'restore_contribute', { merchant: budi, contribution: [{ token_id: 'coin', amount: '200' }, { token_id: 'ore', amount: '10' }, { token_id: 'wood', amount: '5' }] });
console.log(`  ${pledge.status} ${link(pledge.txHash)} ${pledge.error ?? ''}`);
const after = await chain.listShops();
check('Budi reopened', after.find((x) => x.account_id === budi)?.open === true);
const h = await chain.holding(budi, A.accountId);
check(`A holds shares in Budi (${h.shares} of ${h.total_shares})`, Number(h.shares) > 0);

console.log(ok ? '\nE2E PASS' : '\nE2E FAIL');
if (!ok) process.exitCode = 1;
