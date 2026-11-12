// Short cache for the public read routes: shared bodies computed once per window, per-caller parts never shared.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { MockChain } from '../src/chain.ts';
import { Game } from '../src/game/game.ts';
import { loadEcon } from '../src/game/econ.ts';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { TtlCache, BoundedCache } from '../src/ttlcache.ts';

const TOWN = 'town.gt.test';

async function harness() {
  const econ = loadEcon();
  const cfg = loadConfig({ CHAIN_MODE: 'mock', GAME_CONTRACT_ID: 'game.test', PLAYERS_PARENT_ACCOUNT_ID: 'players.test', TOWN_ACCOUNT_ID: TOWN, MERCHANT_PARENT_ACCOUNT_ID: 'gt.test' } as NodeJS.ProcessEnv);
  const chain = new MockChain();
  chain.contractId = cfg.gameContractId;
  const base = Object.fromEntries(Object.entries(econ.items).map(([t, i]) => [t, i.base]));
  chain.accounts.add(TOWN);
  chain.add(TOWN, 'coin', 5000n);
  for (const [id, d] of Object.entries(econ.merchants)) chain.addMerchant(`${id}.gt.test`, d.shop, { coin: d.restore.coin, ...d.restore.items }, { coin: d.startCash, ...d.startStock }, base);
  const store = new Store(':memory:');
  const game = new Game(store, chain, { merchantParent: 'gt.test', town: TOWN, now: () => 1_800_000_000_000, rng: () => 0.99, econ, chunkSize: 5, worldSeed: 20261114 });
  await game.init();
  const { server, ...rest } = createApp({ cfg, chain, store, game, verify: async () => ({ sub: 'x' }), currentBlockHeight: async () => 0n, clientDir: '.' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const get = (path: string, account?: string) => fetch(`http://127.0.0.1:${port}${path}`, { headers: account ? { 'x-account-id': account } : {} }).then(async (r) => ({ status: r.status, json: await r.json() as any }));
  return { chain, game, get, close: () => server.close(), rest };
}

test('shared lists are computed once inside the window', async () => {
  const h = await harness();
  try {
    let listings = 0, projects = 0;
    const L = h.chain.listListings.bind(h.chain), P = h.chain.listProjects.bind(h.chain);
    h.chain.listListings = (...a: any[]) => { listings++; return (L as any)(...a); };
    h.chain.listProjects = (...a: any[]) => { projects++; return (P as any)(...a); };
    for (let i = 0; i < 3; i++) { assert.equal((await h.get('/api/listings')).status, 200); assert.equal((await h.get('/api/projects')).status, 200); }
    assert.equal(listings, 1);
    assert.equal(projects, 1);
  } finally { h.close(); }
});

test('shops: the list is shared, each caller gets only their own holding', async () => {
  const h = await harness();
  try {
    const seen: string[] = [];
    const H = h.chain.holding.bind(h.chain);
    h.chain.holding = (m: string, who: string) => { seen.push(who); return H(m, who); };
    const anon = await h.get('/api/shops');
    const a = await h.get('/api/shops', 'a.players.test');
    const b = await h.get('/api/shops', 'b.players.test');
    assert.ok(anon.json.shops.length > 0);
    assert.ok(anon.json.shops.every((s: any) => s.holding === null));
    assert.deepEqual(anon.json.shops.map((s: any) => s.id), a.json.shops.map((s: any) => s.id));
    assert.ok(a.json.shops.every((s: any) => s.holding !== null));
    assert.ok(seen.includes('a.players.test') && seen.includes('b.players.test'));
    assert.deepEqual(seen.filter((x) => x === 'a.players.test').length, anon.json.shops.length);
  } finally { h.close(); }
});

test('TtlCache: expires, clear() makes the next read fresh, a clear during compute is not stored', async () => {
  let t = 0, n = 0;
  const c = new TtlCache<number>(4000, () => t);
  const f = async () => ++n;
  assert.equal(await c.get('k', f), 1);
  assert.equal(await c.get('k', f), 1);
  assert.equal(await c.get('other', f), 2);
  t = 3999; assert.equal(await c.get('k', f), 1);
  t = 4000; assert.equal(await c.get('k', f), 3);
  c.clear();
  assert.equal(await c.get('k', f), 4);
  let release!: () => void;
  const slow = c.get('s', () => new Promise<number>((r) => { release = () => r(99); }));
  c.clear();
  release();
  assert.equal(await slow, 99);
  await new Promise((r) => setImmediate(r));
  assert.equal(await c.get('s', async () => 7), 7);
  const failing = new TtlCache<number>(4000, () => t);
  await assert.rejects(failing.get('x', async () => { throw new Error('no'); }));
  assert.equal(await failing.get('x', async () => 5), 5);
});

test('BoundedCache keeps at most max entries, oldest first out', () => {
  const c = new BoundedCache<number>(3);
  for (let i = 0; i < 5; i++) c.set(String(i), i);
  assert.equal(c.size, 3);
  assert.equal(c.get('0'), undefined);
  assert.equal(c.get('4'), 4);
});
