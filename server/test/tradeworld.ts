// Shared setup for the public-area economy tests: a mock-chain game with the shared map and three registered players.
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { MockChain } from '../src/chain.ts';
import { Game } from '../src/game/game.ts';
import { loadEcon } from '../src/game/econ.ts';
import type { Pos } from '../src/game/worldmap.ts';

export const TOWN = 'town.gt.test', P = 'p1.players.test', Q = 'p2.players.test', R = 'p3.players.test';

export async function world() {
  const econ = loadEcon();
  const chain = new MockChain();
  chain.accounts.add(TOWN); chain.add(TOWN, 'coin', 5000n);
  for (const [id, d] of Object.entries(econ.merchants)) chain.addMerchant(`${id}.gt.test`, d.shop, { coin: d.restore.coin, ...d.restore.items }, { coin: d.startCash, ...d.startStock }, {});
  const store = new Store(':memory:');
  let now = 1_800_000_000_000;
  const game = new Game(store, chain, { merchantParent: 'gt.test', town: TOWN, econ, worldSeed: 42, now: () => now, rng: () => 0.99 });
  await game.init();
  for (const a of [P, Q, R]) { store.addPlayer(a, 'sub-' + a, 'ed25519:o'); await chain.registerPlayer(a); game.onNewPlayer(a); }
  store.setName(P, 'Ani'); store.setName(Q, 'Budi'); store.setName(R, 'Citra');
  const adv = (ms: number) => { now += ms; };
  const day = () => game.clock.time().settleDay;
  const give = (a: string, token: string, n: number) => game.gs.add(day(), a, token, n, 'test');
  const bal = (a: string, t: string) => game.gs.balance(a, t);
  /** Puts a player in the public area `dx` tiles east of the spot in front of a landmark. */
  const stand = (a: string, spot: 'board' | Pos, dx = 0) => {
    const l = spot === 'board' ? game.map!.landmarks()[spot] : spot;
    const t = { x: l.x + dx, y: l.y + 1 };
    assert.ok(game.map!.walkable(t.x, t.y), `walkable ${t.x},${t.y}`);
    game.positions!.reset(a);
    game.reportPosition(a, t, 'public');
    return t;
  };
  return { game, econ, adv, give, bal, stand, store, day };
}

export const fails = (fn: () => unknown, status: number, msg: RegExp | string) =>
  assert.throws(fn, (e: any) => e.status === status && (typeof msg === 'string' ? e.message === msg : msg.test(e.message)));
