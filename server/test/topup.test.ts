// Coin top-up (src/topup.ts): buy_coin signed by the player's NEAR Auth owner key, relayed on the mock chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as near from 'near-api-js';
import { Store } from '../src/db.ts';
import { MockChain } from '../src/chain.ts';
import { Game } from '../src/game/game.ts';
import { loadEcon } from '../src/game/econ.ts';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { requestMessage } from '../src/reqauth.ts';

const TOWN = 'town.gt.test', P = 'p1.players.test', Q = 'p2.players.test';
const NEAR1 = 10n ** 24n;
const NOW = 1_800_000_000_000;

async function harness(env: Record<string, string> = { TOPUP_ENABLED: '1' }) {
  const econ = loadEcon();
  const cfg = loadConfig({ CHAIN_MODE: 'mock', GAME_CONTRACT_ID: 'game.test', PLAYERS_PARENT_ACCOUNT_ID: 'players.test', TOWN_ACCOUNT_ID: TOWN, MERCHANT_PARENT_ACCOUNT_ID: 'gt.test', ...env } as NodeJS.ProcessEnv);
  const chain = new MockChain();
  chain.contractId = cfg.gameContractId;
  chain.townAccount = TOWN;
  chain.accounts.add(TOWN); chain.add(TOWN, 'coin', 20_000n);
  for (const [id, d] of Object.entries(econ.merchants)) chain.addMerchant(`${id}.gt.test`, d.shop, { coin: d.restore.coin, ...d.restore.items }, { coin: d.startCash, ...d.startStock }, {});
  const store = new Store(':memory:');
  const game = new Game(store, chain, { merchantParent: 'gt.test', town: TOWN, now: () => NOW, rng: () => 0.99, econ, chunkSize: 5, worldSeed: 20261114 });
  await game.init();
  const who: Record<string, { sess: near.KeyPair; owner: near.KeyPair; sub: string }> = {};
  for (const [a, name] of [[P, 'Ani'], [Q, 'Budi']]) {
    const owner = near.KeyPair.fromRandom('ed25519'), sess = near.KeyPair.fromRandom('ed25519');
    store.addPlayer(a, 'sub-' + a, owner.getPublicKey().toString());
    store.addSessionKey(sess.getPublicKey().toString(), a);
    await chain.registerPlayer(a); game.onNewPlayer(a); store.setName(a, name);
    who[a] = { sess, owner, sub: 'sub-' + a };
  }
  chain.mpcSign = (payload) => who[P].owner.sign(payload).signature; // stands in for NEAR Auth's MPC: signs as P's derived key
  const { server } = createApp({ cfg, chain, store, game, verify: async (t) => ({ sub: t }), currentBlockHeight: async () => 100n, clientDir: '.' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const call = async (as: string, method: string, path: string, body?: unknown) => {
    const kp = who[as].sess, raw = body === undefined ? '' : JSON.stringify(body), ts = String(Date.now());
    const sig = kp.sign(new TextEncoder().encode(requestMessage(method, path, ts, raw))).signature;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, body: raw || undefined, headers: { 'x-account-id': as, 'x-gt-key': kp.getPublicKey().toString(), 'x-gt-ts': ts, 'x-gt-sig': Buffer.from(sig).toString('base64') } });
    return { status: res.status, json: await res.json().catch(() => null) as any };
  };
  const config = async () => (await fetch(`http://127.0.0.1:${port}/api/config`)).json() as Promise<any>;
  return { cfg, chain, game, store, who, call, config, close: () => server.close() };
}
type H = Awaited<ReturnType<typeof harness>>;

interface Opts { sender?: string; receiver?: string; method?: string; args?: Record<string, unknown>; coin?: number; deposit?: bigint; signer?: near.KeyPair; twoActions?: boolean; nonce?: bigint; sub?: string; pack?: unknown; bodyReceiver?: unknown }
/** The body of POST /api/topup/relay as the browser sends it: the plain borsh DelegateAction plus the signature request NEAR Auth gives it. */
function request(h: H, as: string, o: Opts = {}) {
  const coin = o.coin ?? 100;
  const acts = [near.actions.functionCall(o.method ?? 'buy_coin', o.args ?? {}, near.teraToGas('30'), o.deposit ?? BigInt(coin) * NEAR1 / 1000n)];
  if (o.twoActions) acts.push(near.actions.transfer(1n));
  const da = near.buildDelegateAction({
    senderId: o.sender ?? as, receiverId: o.receiver ?? 'game.test', actions: acts,
    nonce: o.nonce ?? 5n, maxBlockHeight: 400n, publicKey: (o.signer ?? h.who[as].owner).getPublicKey(),
  });
  const hash = createHash('sha256').update(near.encodeDelegateAction(da)).digest();
  return {
    idToken: o.sub ?? h.who[as].sub,
    delegateAction: Buffer.from(near.encodeDelegateAction(da).slice(4)).toString('base64'),
    signatureRequest: { guardId: 'jwt#https://login.testnet.fast-auth.com/', verifyPayload: 'jwt', signPayload: Array.from(hash), algorithm: 'eddsa' },
    pack: o.pack ?? coin, ...(o.bodyReceiver !== undefined ? { receiver: o.bodyReceiver } : {}),
  };
}
const relay = (h: H, as: string, o?: Opts) => h.call(as, 'POST', '/api/topup/relay', request(h, as, o));
const coinOn = (h: H, a: string) => Number(h.chain.get(a, 'coin'));
const rows = (h: H) => (h.game.gs.db.prepare('SELECT * FROM topups').all() as any[]);

test('resolve finds a player by name#tag and answers 404 for anyone else', async () => {
  const h = await harness();
  try {
    const q = await h.call(P, 'GET', `/api/topup/resolve?name=${encodeURIComponent('Budi#' + h.store.tagOf(Q))}`);
    assert.equal(q.status, 200, JSON.stringify(q.json));
    assert.deepEqual(q.json, { account: Q, nick: 'Budi', tag: h.store.tagOf(Q) });
    assert.equal((await h.call(P, 'GET', `/api/topup/resolve?name=${encodeURIComponent('Budi#00000')}`)).status, 404);
    assert.equal((await h.call(P, 'GET', `/api/topup/resolve?name=${encodeURIComponent('Nobody#12345')}`)).status, 404);
    assert.equal((await h.call(P, 'GET', '/api/topup/resolve?name=Budi')).status, 404);
  } finally { h.close(); }
});

test('info: open on the mock chain with the packs, closed when the contract has no sale, a disabled sale or another rate', async () => {
  const h = await harness();
  try {
    const i = await h.call(P, 'GET', '/api/topup/info');
    assert.equal(i.status, 200);
    assert.equal(i.json.open, true);
    assert.deepEqual(i.json.packs, [100, 500, 1000, 5000]);
    assert.equal(i.json.rate, 1000);
    assert.equal(i.json.ownerPublicKey, h.who[P].owner.getPublicKey().toString());
    assert.equal(i.json.used, 0);
  } finally { h.close(); }
  for (const sale of [null, { dev_id: 'd', coin_per_near: 1000, dev_bps: 1000, max_coin_per_call: '5000', enabled: false }, { dev_id: 'd', coin_per_near: 500, dev_bps: 1000, max_coin_per_call: '5000', enabled: true }]) {
    const c = await harness();
    try {
      c.chain.sale = sale;
      assert.deepEqual((await c.call(P, 'GET', '/api/topup/info')).json, { open: false });
    } finally { c.close(); }
  }
  // a contract that cannot answer coin_sale at all (the method is not deployed yet) is closed too
  const m = await harness();
  try {
    m.chain.coinSale = async () => { throw new Error('MethodNotFound'); };
    assert.deepEqual((await m.call(P, 'GET', '/api/topup/info')).json, { open: false });
  } finally { m.close(); }
  // packs above the contract's per-call limit are not offered
  const l = await harness();
  try {
    l.chain.sale = { ...l.chain.sale!, max_coin_per_call: '1000' };
    assert.deepEqual((await l.call(P, 'GET', '/api/topup/info')).json.packs, [100, 500, 1000]);
  } finally { l.close(); }
});

test('relay: the coin moves from the town to the player, the books follow the chain, and the same payment is never booked twice', async () => {
  const h = await harness();
  try {
    const town0 = coinOn(h, TOWN), p0 = coinOn(h, P);
    const body = request(h, P, { coin: 500 });
    const r = await h.call(P, 'POST', '/api/topup/relay', body);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.coin, 500);
    assert.match(r.json.tx, /^mock-/);
    assert.equal(coinOn(h, P), p0 + 500);
    assert.equal(coinOn(h, TOWN), town0 - 500);
    // the books were re-read from the chain
    assert.equal(h.game.gs.settledBalance(P, 'coin'), coinOn(h, P));
    assert.equal(h.game.gs.settledBalance(TOWN, 'coin'), coinOn(h, TOWN));
    const t = rows(h);
    assert.equal(t.length, 1);
    assert.deepEqual([t[0].payer, t[0].receiver, t[0].near_yocto, t[0].coin, t[0].status, t[0].tx_hash], [P, P, String(NEAR1 / 2n), 500, 'ok', r.json.tx]);
    assert.ok(h.store.history(P).some((x) => x.kind === 'topup' && x.tx_hash === r.json.tx));
    // posting the same signed payment again answers with the same result and moves nothing
    const again = await h.call(P, 'POST', '/api/topup/relay', body);
    assert.equal(again.status, 200);
    assert.equal(again.json.tx, r.json.tx);
    assert.equal(again.json.duplicate, true);
    assert.equal(coinOn(h, P), p0 + 500);
    assert.equal(rows(h).length, 1);
    assert.equal((await h.call(P, 'GET', '/api/topup/info')).json.used, 500);
  } finally { h.close(); }
});

test('relay: a top-up for another player credits that player, and the payer is the one who is capped', async () => {
  const h = await harness();
  try {
    const q0 = coinOn(h, Q), p0 = coinOn(h, P);
    const r = await relay(h, P, { coin: 1000, args: { receiver_id: Q }, bodyReceiver: Q });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.receiver, Q);
    assert.equal(coinOn(h, Q), q0 + 1000);
    assert.equal(coinOn(h, P), p0);
    assert.equal(h.game.gs.settledBalance(Q, 'coin'), coinOn(h, Q));
    assert.equal(rows(h)[0].payer, P); assert.equal(rows(h)[0].receiver, Q);
    assert.ok(h.store.history(Q).some((x) => x.kind === 'topup'));
  } finally { h.close(); }
});

test('relay refuses anything but one buy_coin with a pack deposit, and nothing moves', async () => {
  const h = await harness();
  try {
    const snap = () => [...h.chain.bal].map(([k, v]) => k + '=' + v).join(',');
    const before = snap();
    const refused = async (label: string, as: string, o: Opts, status: number, msg: RegExp) => {
      const r = await relay(h, as, o);
      assert.equal(r.status, status, `${label}: ${JSON.stringify(r.json)}`);
      assert.match(r.json.error, msg, label);
      assert.equal(snap(), before, `${label}: chain unchanged`);
      assert.equal(rows(h).length, 0, `${label}: no booking`);
    };
    await refused('wrong sender account', P, { sender: Q }, 403, /own account/);
    await refused('a login that is not the signed-in account', P, { sub: h.who[Q].sub }, 403, /not the account you are playing/);
    await refused('wrong receiver contract', P, { receiver: 'wrap.testnet' }, 403, /game contract/);
    await refused('wrong method', P, { method: 'send_item', args: { receiver_id: Q, token_id: 'fish', amount: '1' } }, 403, /not allowed/);
    await refused('two actions', P, { twoActions: true }, 403, /exactly one/);
    await refused('deposit not a pack', P, { deposit: NEAR1 / 10n + 1n }, 403, /price of a coin pack/);
    await refused('deposit zero', P, { deposit: 0n }, 403, /price of a coin pack/);
    await refused('unknown receiver', P, { args: { receiver_id: 'stranger.testnet' } }, 403, /not a known player/);
    await refused('a shop as receiver', P, { args: { receiver_id: 'sari.gt.test' } }, 403, /not a known player/);
    await refused('extra argument', P, { args: { receiver_id: Q, memo: 'x' } }, 403, /bad call arguments/);
    await refused('signed by another key', P, { signer: near.KeyPair.fromRandom('ed25519') }, 403, /NEAR Auth key/);
    await refused('the screen said a bigger pack', P, { pack: 5000 }, 400, /does not match/);
    await refused('the screen said another receiver', P, { bodyReceiver: Q }, 400, /does not match/);
    // the MPC signs with another key: the signature is refused after the guards, and the pending row is marked failed
    h.chain.mpcSign = (payload) => h.who[Q].owner.sign(payload).signature;
    const bad = await relay(h, P, {});
    assert.equal(bad.status, 400);
    assert.deepEqual(rows(h).map((x) => x.status), ['failed']);
    assert.equal(snap(), before);
  } finally { h.close(); }
});

test('relay: the daily cap per payer (counted in coin) and a town treasury short of coin refuse', async () => {
  const h = await harness();
  try {
    assert.equal((await relay(h, P, { coin: 5000, nonce: 1n })).status, 200);
    const over = await relay(h, P, { coin: 100, nonce: 2n });
    assert.equal(over.status, 409, JSON.stringify(over.json));
    assert.match(over.json.error, /today's top-up limit/);
    // the cap is per payer: another player may still buy
    h.chain.mpcSign = (payload) => h.who[Q].owner.sign(payload).signature;
    assert.equal((await relay(h, Q, { coin: 100, nonce: 3n })).status, 200);
    assert.equal(rows(h).length, 2);
  } finally { h.close(); }
  const s = await harness();
  try {
    s.chain.add(TOWN, 'coin', -19_950n); // 50 left in the treasury
    const r = await relay(s, P, { coin: 100 });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /treasury is short/);
    assert.equal(rows(s).length, 0);
  } finally { s.close(); }
});

test('relay: a failed payment on the chain is booked as failed, does not count against the cap and can be tried again', async () => {
  const h = await harness();
  try {
    h.chain.sale = { ...h.chain.sale!, enabled: false }; // the contract turns the sale off after info was read: buy_coin fails
    const r = await relay(h, P, { coin: 5000 });
    assert.equal(r.status, 502, JSON.stringify(r.json));
    assert.deepEqual(rows(h).map((x) => x.status), ['failed']);
    assert.equal(h.game.gs.topupUsed(P, Math.floor(NOW / 86_400_000)), 0);
    h.chain.sale = { ...h.chain.sale!, enabled: true };
    assert.equal((await relay(h, P, { coin: 5000, nonce: 9n })).status, 200);
  } finally { h.close(); }
});

test('off by default: info says closed, resolve and relay answer 403, /api/config says so; TOPUP_ENABLED=1 turns it on', async () => {
  const h = await harness({});
  try {
    assert.deepEqual((await h.call(P, 'GET', '/api/topup/info')).json, { open: false });
    assert.equal((await h.call(P, 'GET', `/api/topup/resolve?name=${encodeURIComponent('Budi#' + h.store.tagOf(Q))}`)).status, 403);
    const p0 = coinOn(h, P);
    assert.equal((await relay(h, P, {})).status, 403);
    assert.equal(coinOn(h, P), p0);
    assert.equal(rows(h).length, 0);
    assert.deepEqual((await h.config()).topup, { enabled: false });
  } finally { h.close(); }
  const on = await harness();
  try {
    assert.deepEqual((await on.config()).topup, { enabled: true });
  } finally { on.close(); }
});
