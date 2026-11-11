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
  econ.homeland.publicTradeOnly = false; // these tests are about village mechanics
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
  assert.match(w.gather().toast, /Wood/, 'daytime gather works');
  w.advanceTo(21);
  w.rolls([0.1, 0.1, 0.1]); // encounter (0.1 < 0.15), then two hits (0.1 < 0.7)
  const r = w.gather() as { toast: string; state: { encounter: { name: string } | null } };
  assert.match(r.toast, /Wild Boar blocks your way/);
  assert.equal(r.state.encounter?.name, 'Wild Boar');
  assert.throws(() => w.act('eat'), /blocks your way/, 'nothing else until the boar is dealt with');
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
  assert.throws(() => w.act('eat'), /passed out/);
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
  assert.match(w.act('flee').toast, /ran away/);
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
  assert.match(w.gather().toast, /Wood/);
});

test('roaming monsters: walking into one starts a fight, beating it drops wood or ore; far away nothing happens', async () => {
  const w = await world();
  w.advanceTo(12);
  assert.deepEqual(w.game.monsters!.roaming(), [], 'none by day');
  w.advanceTo(21);
  const ms = w.game.monsters!.roaming();
  assert.equal(ms.length, 8);
  const boar = ms.find((m) => m.kind === 'boar')!;
  const near = [[0, 1], [0, -1], [1, 0], [-1, 0], [0, 0]].map(([dx, dy]) => ({ x: boar.x + dx, y: boar.y + dy })).find((p) => w.game.map!.walkable(p.x, p.y))!;
  w.nowAdd(3_600_000); // walking there takes a while
  w.advanceTo(21);
  const at = w.game.monsters!.roaming().find((m) => m.id === boar.id)!;
  const stand = [[0, 1], [0, -1], [1, 0], [-1, 0], [0, 0]].map(([dx, dy]) => ({ x: at.x + dx, y: at.y + dy })).find((p) => w.game.map!.walkable(p.x, p.y))!;
  assert.ok(near);
  w.rolls([0.1, 0.1]);
  const r = w.game.act(P, { action: 'engage', monster: at.id, pos: stand }) as { toast: string };
  assert.match(r.toast, /Wild Boar attacks/);
  const wood0 = w.game.gs.balance(P, 'wood');
  w.game.act(P, { action: 'fight', pos: stand });
  const won = w.game.act(P, { action: 'fight', pos: stand }) as { won?: boolean; toast: string };
  assert.equal(won.won, true);
  assert.match(won.toast, /dropped 1 Wood/);
  assert.equal(w.game.gs.balance(P, 'wood'), wood0 + 1);
  // a monster that is not next to you cannot be engaged
  const far = w.game.monsters!.roaming().find((m) => Math.abs(m.x - stand.x) + Math.abs(m.y - stand.y) > 2);
  if (far) assert.throws(() => w.game.act(P, { action: 'engage', monster: far.id, pos: stand }), /nothing here/);
});

test('rain waters planted plots by itself, once per rainy day', async () => {
  const w = await world();
  const L = w.game.map!.layout;
  const farm = (L as unknown as { farm: { plots: Array<{ x: number; y: number }> } }).farm;
  const plot = farm.plots[0];
  const stand = [[0, 1], [0, -1], [1, 0], [-1, 0]].map(([dx, dy]) => ({ x: plot.x + dx, y: plot.y + dy })).find((p) => w.game.map!.walkable(p.x, p.y)) ?? { x: plot.x, y: plot.y + 1 };
  // find a dry day in a growing season to plant, then wait for rain
  let guard = 0;
  while ((w.game.weather()!.wet || w.game.clock.time().season === 'dingin') && guard++ < 200) w.nowAdd(w.econ.time.realMsPerGameHour * 24);
  w.nowAdd(60_000);
  w.game.act(P, { action: 'farm', op: 'till', plot: 0, pos: stand });
  w.nowAdd(1000);
  w.game.act(P, { action: 'farm', op: 'plant', plot: 0, pos: stand });
  guard = 0;
  while (!w.game.weather()!.wet && guard++ < 200) w.nowAdd(w.econ.time.realMsPerGameHour * 24);
  assert.ok(w.game.weather()!.wet, 'a rainy day came');
  const s1 = w.game.state(P) as { plots: Array<{ grown: number; wateredToday: boolean }>; weather: { label: string } };
  assert.equal(s1.weather.label, 'Rain');
  assert.equal(s1.plots[0].wateredToday, true);
  const g = s1.plots[0].grown;
  assert.equal((w.game.state(P) as { plots: Array<{ grown: number }> }).plots[0].grown, g, 'only once per day');
});

test('a monster bonus at 02:00 lands on the same ledger day as every other write (the settle day, not the calendar day)', async () => {
  const w = await world();
  w.advanceTo(2);
  const t = w.game.clock.time();
  assert.equal(t.settleDay, t.day - 1, 'before 06:00 the open ledger day is yesterday');
  w.rolls([0.1, 0.1, 0.1]);
  w.gather();
  w.act('fight');
  const won = w.act('fight') as { won?: boolean };
  assert.equal(won.won, true);
  const rows = w.game.gs.openRows(1e9).filter((r) => r.account === P && ['gather', 'monster_bonus'].includes(r.kind));
  assert.ok(rows.some((r) => r.kind === 'monster_bonus'), 'bonus row written');
  for (const r of rows) assert.equal(r.day, t.settleDay, `${r.kind} row is on the settle day`);
});
