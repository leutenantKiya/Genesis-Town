import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { MockChain } from '../src/chain.ts';
import { Game } from '../src/game/game.ts';
import { loadEcon } from '../src/game/econ.ts';

const TOWN = 'town.gt.test', P = 'p1.players.test';

// a world with the shared map, a clock we control, and a scripted random sequence
async function world() {
  const econ = loadEcon();
  const chain = new MockChain();
  chain.accounts.add(TOWN); chain.add(TOWN, 'coin', 5000n);
  for (const [id, d] of Object.entries(econ.merchants)) chain.addMerchant(`${id}.gt.test`, d.shop, { coin: d.restore.coin, ...d.restore.items }, { coin: d.startCash, ...d.startStock }, {});
  for (const p of econ.projects) chain.addProject(p.id, p.name, p.chunk, p.need);
  const store = new Store(':memory:');
  let now = 1_800_000_000_000;
  const queue: number[] = [];
  const rng = () => (queue.length ? queue.shift()! : 0.99);
  const game = new Game(store, chain, { merchantParent: 'gt.test', town: TOWN, econ, worldSeed: 42, now: () => now, rng });
  await game.init();
  store.addPlayer(P, 'sub-' + P, 'ed25519:o'); await chain.registerPlayer(P); game.onNewPlayer(P);
  const L = game.map!.layout;
  // a forest tree with a walkable tile beside it
  let spot: { tree: { x: number; y: number }; stand: { x: number; y: number } } | null = null;
  for (let y = 1; y < L.h - 1 && !spot; y++) for (let x = 1; x < L.w - 1 && !spot; x++) {
    if (L.tiles[y * L.w + x] !== 'tree' || game.map!.chunkAt(x, y).id !== 'hutan') continue;
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) if (game.map!.walkable(x + dx, y + dy)) { spot = { tree: { x, y }, stand: { x: x + dx, y: y + dy } }; break; }
  }
  const advanceTo = (hour: number) => { while (game.clock.time().hour !== hour) now += econ.time.realMsPerGameHour; };
  const gather = () => { now += 60_000; return game.act(P, { action: 'gather', tile: 'tree', x: spot!.tree.x, y: spot!.tree.y, pos: spot!.stand }); };
  const act = (action: string) => { now += 1000; return game.act(P, { action, pos: spot!.stand }); };
  const rolls = (r: number[]) => { queue.length = 0; queue.push(...r); };
  return { game, econ, chain, spot: spot!, advanceTo, gather, act, rolls, nowAdd: (ms: number) => { now += ms; } };
}

test('by day the forest is quiet; at night a boar can block a gather, and beating it gives the wood plus one', async () => {
  const w = await world();
  w.advanceTo(12);
  assert.match(w.gather().toast, /Kayu/, 'daytime gather works');
  w.advanceTo(21);
  w.rolls([0.1, 0.1, 0.1]); // encounter (0.1 < 0.15), then two hits (0.1 < 0.7)
  const r = w.gather() as { toast: string; state: { encounter: { name: string } | null } };
  assert.match(r.toast, /Babi hutan menghadang/);
  assert.equal(r.state.encounter?.name, 'Babi hutan');
  assert.throws(() => w.act('eat'), /menghadang/, 'nothing else until the boar is dealt with');
  const wood0 = w.game.gs.balance(P, 'wood');
  w.act('fight');
  const won = w.act('fight') as { toast: string; won?: boolean };
  assert.equal(won.won, true);
  assert.equal(w.game.gs.balance(P, 'wood'), wood0 + 2, 'the wood and one bonus');
});

test('running out of energy in a fight knocks the player out until 06:00; nothing is lost', async () => {
  const w = await world();
  w.advanceTo(22);
  w.rolls([0.1, ...new Array(40).fill(0.9)]); // encounter, then misses (0.9 > 0.7)
  w.gather();
  const coin0 = w.game.gs.balance(P, 'coin'), bread0 = w.game.gs.balance(P, 'bread');
  let r: { ko?: boolean } = {};
  for (let i = 0; i < 20 && !r.ko; i++) r = w.act('fight') as { ko?: boolean };
  assert.equal(r.ko, true);
  assert.throws(() => w.act('eat'), /pingsan/);
  assert.equal(w.game.gs.balance(P, 'coin'), coin0); assert.equal(w.game.gs.balance(P, 'bread'), bread0);
  w.advanceTo(6);
  w.nowAdd(1000);
  assert.ok(w.game.state(P).energy >= w.econ.monsters.wakeEnergy, 'rested at home');
  assert.equal(w.game.state(P).koUntil, null);
});

test('fleeing costs a little energy and gathers nothing; a finished Pos Ronda keeps the forest safe', async () => {
  const w = await world();
  w.advanceTo(20);
  w.rolls([0.1]);
  w.gather();
  const wood0 = w.game.gs.balance(P, 'wood');
  assert.match(w.act('flee').toast, /lari/);
  assert.equal(w.game.gs.balance(P, 'wood'), wood0);
  // the town builds Pos Ronda on chain
  await w.game.devSettle();
  w.advanceTo(20);
  const a = 'p1.players.test';
  w.chain.add(a, 'wood', 40n); w.chain.add(a, 'ore', 10n); w.chain.add(a, 'coin', 150n);
  const call = (args: Record<string, unknown>) => w.chain.relay({ delegateAction: { actions: [{ functionCall: { methodName: 'project_contribute', args: Buffer.from(JSON.stringify(args)) } }] } }, a);
  assert.ok((await call({ id: 'pos-ronda', contribution: [{ token_id: 'wood', amount: '40' }, { token_id: 'ore', amount: '10' }, { token_id: 'coin', amount: '150' }] })).ok);
  assert.deepEqual(await w.game.syncProjects(), ['pos-ronda']);
  assert.equal(w.game.state(P).night?.guarded, true);
  // this roll (0.1) would be an encounter; with the guard post it is just a gather
  w.rolls([0.1]);
  assert.match(w.gather().toast, /Kayu/);
});
