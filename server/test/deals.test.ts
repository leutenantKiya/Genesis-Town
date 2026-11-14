// Every purchase plays the goods-flying animation (client mods/trade.js). The server keeps a short feed of them in
// social.ts (`deal`, `dealsSince`), sent in the presence answer: both sides see a deal wherever they are, others only in
// the deal's world, and an anonymous Pasar Gelap seller is never named to anyone but themselves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { MockChain } from '../src/chain.ts';
import { Game } from '../src/game/game.ts';
import { loadEcon } from '../src/game/econ.ts';
import { Social } from '../src/social.ts';

const A = 'pa.players.test', B = 'pb.players.test', C = 'pc.players.test', SARI = 'sari.gt.test';

function social() {
  const store = new Store(':memory:');
  let now = 1_800_000_000_000;
  return { s: new Social(store, () => now), tick: (ms: number) => { now += ms; } };
}

test('a deal reaches both sides anywhere and others only in its world; the first poll gets none', () => {
  const { s } = social();
  assert.deepEqual(s.dealsSince(C, 'public', -1), [], 'the first poll (cursor -1) only learns the cursor');
  const id = s.deal('shop', 'public', A, SARI, { fish: 2 }, { coin: 30 });
  assert.equal(id, 1);
  assert.deepEqual(s.dealsSince(C, 'public', 0), [{ id: 1, kind: 'shop', a: A, b: SARI, aGot: { fish: 2 }, bGot: { coin: 30 } }]);
  assert.deepEqual(s.dealsSince(C, 'HL-3', 0), [], 'a player in another world does not see it');
  assert.equal(s.dealsSince(A, 'HL-3', 0).length, 1, 'the buyer sees it from any world');
  assert.equal(s.dealsSince(SARI, 'HL-3', 0).length, 1, 'and so does the other side');
  assert.deepEqual(s.dealsSince(C, 'public', 1), [], 'nothing after the cursor');
});

test('an anonymous seller is hidden from the buyer and from everyone else', () => {
  const { s } = social();
  s.deal('pasar', 'public', A, B, { wood: 3 }, { coin: 12 }, true);
  assert.equal(s.dealsSince(A, 'public', 0)[0].b, null, 'the buyer does not learn who sold');
  assert.deepEqual(s.dealsSince(C, 'public', 0), [], 'a bystander does not see it at all');
  assert.equal(s.dealsSince(B, 'HL-1', 0)[0].b, B, 'the seller sees their own sale');
});

test('deals expire after a few seconds and the feed stays short', () => {
  const { s, tick } = social();
  s.deal('npc', 'public', SARI, A, { fish: 1 }, { coin: 9 });
  tick(11_000);
  assert.deepEqual(s.dealsSince(A, 'public', 0), [], 'too old to animate');
  for (let i = 0; i < 100; i++) s.deal('shop', 'public', A, SARI, { fish: 1 }, { coin: 1 });
  assert.equal(s.deals.length, 80);
});

test('buying from and selling to a merchant tells the app what moved', async () => {
  const econ = loadEcon();
  econ.homeland.publicTradeOnly = false;
  const chain = new MockChain();
  const base = Object.fromEntries(Object.entries(econ.items).map(([t, i]) => [t, i.base]));
  chain.accounts.add('town.gt.test');
  chain.add('town.gt.test', 'coin', 5000n);
  for (const [id, d] of Object.entries(econ.merchants)) chain.addMerchant(`${id}.gt.test`, d.shop, { coin: d.restore.coin, ...d.restore.items }, { coin: d.startCash, ...d.startStock }, base);
  const store = new Store(':memory:');
  const now = 1_800_000_000_000;
  const game = new Game(store, chain, { merchantParent: 'gt.test', town: 'town.gt.test', now: () => now, rng: () => 0.99, econ, chunkSize: 5 });
  await game.init();
  store.addPlayer(A, 'sub-a', 'ed25519:o');
  await chain.registerPlayer(A);
  game.onNewPlayer(A);
  const seen: unknown[] = [];
  game.onDeal = (...args) => { seen.push(args); };
  for (let k = 0; k < 3; k++) game.act(A, { action: 'gather', tile: 'water', x: 0, y: 9 });
  const sold = game.act(A, { action: 'sell', merchant: 'sari', token: 'fish', qty: 2 }) as unknown as { total: number };
  assert.deepEqual(seen.pop(), ['shop', 'public', A, SARI, { coin: sold.total }, { fish: 2 }], 'selling: I get coin, the merchant gets fish');
  const sells = game.merchants().find((m) => m.id === 'sari')!.items.find((i) => i.ask != null)!;
  const bought = game.act(A, { action: 'buy', merchant: 'sari', token: sells.token, qty: 1 }) as unknown as { total: number };
  assert.deepEqual(seen.pop(), ['shop', 'public', A, SARI, { [sells.token]: 1 }, { coin: bought.total }], 'buying: I get the good, the merchant gets coin');
  assert.throws(() => game.act(A, { action: 'sell', merchant: 'sari', token: 'fish', qty: 999 }));
  assert.equal(seen.length, 0, 'a refused trade is not a deal');
});

test('the presence answer carries deals: a bystander nearby sees a merchant trade and a merchant buying a listing', async () => {
  const near = await import('near-api-js');
  const { requestMessage } = await import('../src/reqauth.ts');
  const { createApp } = await import('../src/app.ts');
  const { setup } = await import('./helpers.ts');
  const s = setup();
  const keys = new Map<string, InstanceType<typeof near.KeyPair> | ReturnType<typeof near.KeyPair.fromRandom>>();
  for (const a of [A, C]) {
    const k = near.KeyPair.fromRandom('ed25519');
    keys.set(a, k);
    s.store.addPlayer(a, 'sub' + a, 'ed25519:o');
    s.store.addSessionKey(k.getPublicKey().toString(), a);
  }
  const game = new Game(s.store, s.chain, { merchantParent: 'gt.test', town: 'town.gt.test', worldSeed: 42 });
  await game.init();
  const { server } = createApp({ ...s, game, verify: async () => ({ sub: 'x' }), currentBlockHeight: async () => 0n, clientDir: '.' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const sp = game.map!.layout.spawn;
    const poll = async (a: string, dealSince?: number) => {
      const path = '/api/presence', body = JSON.stringify({ world: 'public', x: sp.x, y: sp.y, dir: 'down', scene: 'out', since: 0, ...(dealSince === undefined ? {} : { dealSince }) });
      const ts = String(Date.now()), kp = keys.get(a)!;
      const sig = kp.sign(new TextEncoder().encode(requestMessage('POST', path, ts, body))).signature;
      const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-account-id': a, 'x-gt-key': kp.getPublicKey().toString(), 'x-gt-ts': ts, 'x-gt-sig': Buffer.from(sig).toString('base64') }, body });
      return (await res.json()) as { deals: Array<Record<string, unknown>>; dealLast: number; players: Array<Record<string, unknown>> };
    };
    const first = await poll(C);
    assert.deepEqual(first.deals, [], 'no cursor yet: nothing old is replayed');
    const folk = first.players.filter((p) => p.resident);
    assert.ok(folk.length > 0 && folk.every((p) => p.npc === true && /\.residents$/.test(String(p.account)) && typeof p.fx === 'number'), 'the townsfolk walked by the server are in the answer');
    game.onDeal!('shop', 'public', A, SARI, { fish: 2 }, { coin: 30 });
    game.npc.onBuy!(SARI, A, 'wood', 3, 21, 999);
    const next = await poll(C, first.dealLast);
    assert.deepEqual(next.deals.map((d) => [d.kind, d.a, d.b, d.aGot, d.bGot]), [
      ['shop', A, SARI, { fish: 2 }, { coin: 30 }],
      ['npc', SARI, A, { wood: 3 }, { coin: 21 }],
    ]);
    assert.deepEqual((await poll(C, next.dealLast)).deals, [], 'each deal is sent once');
  } finally {
    server.closeAllConnections(); server.close();
  }
});
