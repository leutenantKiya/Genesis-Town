import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { MockChain } from '../src/chain.ts';
import { Game } from '../src/game/game.ts';
import { loadEcon } from '../src/game/econ.ts';
import type { Pos } from '../src/game/worldmap.ts';

const TOWN = 'town.gt.test', P = 'p1.players.test';

// The default economy: the public area is trade-only, so monsters live only in Homelands.
async function world() {
  const econ = loadEcon();
  assert.equal(econ.homeland.publicTradeOnly, true);
  const chain = new MockChain();
  chain.accounts.add(TOWN); chain.add(TOWN, 'coin', 5000n);
  for (const [id, d] of Object.entries(econ.merchants)) chain.addMerchant(`${id}.gt.test`, d.shop, { coin: d.restore.coin, ...d.restore.items }, { coin: d.startCash, ...d.startStock }, {});
  const store = new Store(':memory:');
  let now = 1_800_000_000_000;
  const queue: number[] = [];
  const rng = () => (queue.length ? queue.shift()! : 0.99);
  const game = new Game(store, chain, { merchantParent: 'gt.test', town: TOWN, econ, worldSeed: 42, now: () => now, rng });
  await game.init();
  store.addPlayer(P, 'sub-' + P, 'ed25519:o'); await chain.registerPlayer(P); game.onNewPlayer(P);
  const row = () => game.homelands.ensure(P);
  const wid = `HL-${row().id}`;
  const map = () => game.homelands.map(row());
  const advanceTo = (hour: number) => { while (game.clock.time().hour !== hour) now += econ.time.realMsPerGameHour; };
  const rolls = (r: number[]) => { queue.length = 0; queue.push(...r); };
  // arrive at the Homeland spawn, as the client does after Start
  game.reportPosition(P, map().layout.spawn, wid);
  const act = (body: Record<string, unknown>) => { now += 60_000; return game.act(P, { world: wid, ...body }); };
  return { game, econ, wid, map, row, advanceTo, rolls, act };
}

/** A tile of `tile` type in chunk `cid` with a walkable tile beside it. */
function nodeIn(m: ReturnType<Awaited<ReturnType<typeof world>>['map']>, cid: string, tile: string): { at: Pos; stand: Pos } {
  const L = m.layout;
  for (let y = 1; y < L.h - 1; y++) for (let x = 1; x < L.w - 1; x++) {
    if (L.tiles[y * L.w + x] !== tile || m.chunkAt(x, y).id !== cid) continue;
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) if (m.walkable(x + dx, y + dy)) return { at: { x, y }, stand: { x: x + dx, y: y + dy } };
  }
  throw new Error(`no ${tile} in ${cid}`);
}

test('a new Homeland has no monsters: the wild is still closed and the centre is safe', async () => {
  const w = await world();
  w.advanceTo(22);
  assert.deepEqual(w.game.monsters!.roaming(w.map(), true), []);
  const tree = nodeIn(w.map(), 'c', 'tree');
  w.rolls([0, 0, 0]); // any chance would hit
  const r = w.act({ action: 'gather', tile: 'tree', x: tree.at.x, y: tree.at.y, pos: tree.stand }) as { toast: string; state: { encounter: unknown } };
  assert.equal(r.state.encounter, null, 'the centre around the Town Hall never has monsters');
});

test('opening a forest and a rock chunk brings boars and bats at night, none by day', async () => {
  const w = await world();
  const chunks = w.map().layout.chunks;
  const forest = chunks.find((c) => c.biome === 'forest')!.id, rock = chunks.find((c) => c.biome === 'rock')!.id;
  w.game.gs.setHomelandOpen(P, [forest, rock]);
  w.advanceTo(12);
  assert.deepEqual(w.game.monsters!.roaming(w.map(), true), [], 'by day the wild is quiet');
  w.advanceTo(21);
  const m = w.game.monsters!.roaming(w.map(), true);
  const counts = w.econ.monsters.homeland!.roaming;
  assert.equal(m.filter((q) => q.kind === 'boar').length, counts.boar);
  assert.equal(m.filter((q) => q.kind === 'bat').length, counts.bat);
  for (const q of m) assert.equal(w.map().chunkAt(q.x, q.y).id, q.kind === 'boar' ? forest : rock, 'boars in the forest, bats by the rocks');
  assert.equal(w.game.state(P).night?.guarded, false, 'Homelands have no guard post');
});

test('at night a gather in the open forest can be blocked by a boar; beating it gives the wood plus one', async () => {
  const w = await world();
  const forest = w.map().layout.chunks.find((c) => c.biome === 'forest')!.id;
  w.game.gs.setHomelandOpen(P, [forest]);
  const tree = nodeIn(w.map(), forest, 'tree');
  w.advanceTo(21);
  w.rolls([0.1, 0.1, 0.1]); // encounter (0.1 < 0.15), then two hits (0.1 < 0.7)
  const r = w.act({ action: 'gather', tile: 'tree', x: tree.at.x, y: tree.at.y, pos: tree.stand }) as { toast: string; state: { encounter: { name: string } | null } };
  assert.match(r.toast, /Babi hutan menghadang/);
  assert.equal(r.state.encounter?.name, 'Babi hutan');
  const wood0 = w.game.gs.balance(P, 'wood');
  w.act({ action: 'fight', pos: tree.stand });
  const won = w.act({ action: 'fight', pos: tree.stand }) as { won?: boolean };
  assert.equal(won.won, true);
  assert.ok(w.game.gs.balance(P, 'wood') >= wood0 + 2, 'the wood and one bonus');
});

test('walking into a roaming monster in the Homeland makes it attack; the public area still refuses', async () => {
  const w = await world();
  const forest = w.map().layout.chunks.find((c) => c.biome === 'forest')!.id;
  w.game.gs.setHomelandOpen(P, [forest]);
  w.advanceTo(22);
  const boar = w.game.monsters!.roaming(w.map(), true).find((q) => q.kind === 'boar')!;
  const m = w.map();
  const stand = [[0, 1], [0, -1], [1, 0], [-1, 0]].map(([dx, dy]) => ({ x: boar.x + dx, y: boar.y + dy })).find((p) => m.walkable(p.x, p.y))!;
  const r = w.act({ action: 'engage', monster: boar.id, pos: stand }) as { toast: string; state: { encounter: { name: string } | null } };
  assert.match(r.toast, /menyerang/);
  assert.equal(r.state.encounter?.name, 'Babi hutan');
  w.act({ action: 'flee', pos: stand });
  assert.throws(() => w.game.act(P, { action: 'engage', monster: boar.id, world: 'public', pos: w.game.map!.layout.spawn }), /Area publik hanya untuk berdagang/);
});

test('Pos Ronda is retired: new pledges are refused with the reason, other projects are not', async () => {
  const { spendGuard } = await import('../src/spend.ts');
  const w = await world();
  const guard = spendGuard(w.game.chain, w.game);
  await assert.rejects(guard(P, 'project_contribute', { id: 'pos-ronda', contribution: [{ token_id: 'wood', amount: '1' }] }), (e: any) => e.status === 409 && /dihentikan/.test(e.message) && /bisa ditarik/.test(e.message));
  await assert.rejects(guard(P, 'project_contribute', { id: 'jembatan-timur', contribution: [{ token_id: 'wood', amount: '999' }] }), (e: any) => !/dihentikan/.test(e.message), 'the bridge is still open (this one fails only for lack of wood)');
});
