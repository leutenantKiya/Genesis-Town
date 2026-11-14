// The townsfolk at work (residents.ts): the women cook and the men gather, everyone burns firewood bought every evening,
// the work is shown on the spot (presence `act` / `fish`), the admin sees each one's step now and next, and a catch moves
// the ripples on (game.ts moveRipple).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { MockChain } from '../src/chain.ts';
import { Game } from '../src/game/game.ts';
import { loadEcon } from '../src/game/econ.ts';
import { AdminBots } from '../src/adminbots.ts';
import { Social } from '../src/social.ts';
import { Village } from '../src/game/worldmap.ts';

const TOWN = 'town.gt.test', WALLET = 'warga.gt.test';

async function world() {
  const econ = loadEcon();
  const chain = new MockChain();
  const base = Object.fromEntries(Object.entries(econ.items).map(([t, i]) => [t, i.base]));
  chain.accounts.add(TOWN);
  chain.add(TOWN, 'coin', 5000n);
  for (const [id, d] of Object.entries(econ.merchants)) chain.addMerchant(`${id}.gt.test`, d.shop, { coin: d.restore.coin, ...d.restore.items }, { coin: d.startCash, ...d.startStock }, base);
  const store = new Store(':memory:');
  let now = 1_800_000_000_000;
  const clock = { now: () => now, advanceHours: (h: number) => { now += h * econ.time.realMsPerGameHour; }, advanceMs: (ms: number) => { now += ms; } };
  const game = new Game(store, chain, { merchantParent: 'gt.test', town: TOWN, now: clock.now, rng: () => 0.99, econ, chunkSize: 25, worldSeed: 42 });
  await game.init();
  return { game, clock, bots: new AdminBots({ game, social: new Social(store) }) };
}
const rows = (g: Game, kind: string) => g.gs.db.prepare('SELECT token, delta, ref FROM ledger WHERE account = ? AND kind = ?').all(WALLET, kind) as Array<{ token: string; delta: number; ref: string }>;
const day = async (game: Game, clock: { advanceHours: (h: number) => void }) => { for (let h = 0; h < 24; h++) { clock.advanceHours(1); await game.step(); } };

test('the women cook the food and the men gather and make the tools', async () => {
  const { game, clock, bots } = await world();
  const roles = Object.fromEntries(game.residents.walkers.map((w) => [w.name, w.role]));
  assert.deepEqual(roles, { Haruto: 'gather', Yui: 'cook', Sota: 'gather', Hina: 'cook', Ren: 'gather' });
  bots.control({ settings: { trade: { enabled: false }, gather: { enabled: true, minPricePct: 0, perHour: 2 } } });
  await day(game, clock);
  const cooks = new Set(game.residents.walkers.filter((w) => w.role === 'cook').map((w) => w.id));
  const gathered = rows(game, 'resident_gather');
  assert.ok(gathered.length > 0, 'they gathered');
  assert.ok(gathered.every((r) => !cooks.has(r.ref.split('#')[1])), 'only the men gather');
  const made = rows(game, 'resident_craft').filter((r) => r.delta > 0);
  assert.ok(made.length > 0, 'they crafted');
  for (const r of made) {
    const who = r.ref.split('#')[1], food = !!game.econ.items[r.token].energy;
    assert.equal(cooks.has(who), food, `${r.token} made by ${who}`);
  }
  assert.ok(made.some((r) => game.econ.items[r.token].energy), 'some food was cooked');
});

test('every resident burns one wood each evening, bought from a merchant every time', async () => {
  const { game, clock, bots } = await world();
  bots.control({ settings: { trade: { enabled: false }, craft: { enabled: false }, gather: { enabled: false } } });
  await day(game, clock);
  const burnt = rows(game, 'resident_burn');
  const per: Record<string, number> = {};
  for (const r of burnt) { assert.equal(r.token, 'wood'); per[r.ref] = (per[r.ref] ?? 0) + 1; }
  assert.deepEqual(Object.keys(per).sort(), ['r1', 'r2', 'r3', 'r4', 'r5'], 'everyone burnt wood');
  assert.ok(Object.values(per).every((n) => n === 1), 'one a day each');
  const bought = game.gs.db.prepare("SELECT ref FROM ledger WHERE account = ? AND kind = 'trade' AND token = 'wood' AND delta > 0 AND ref LIKE '%-w'").all(WALLET) as Array<{ ref: string }>;
  assert.equal(bought.length, burnt.length, 'every fire was bought wood');
  const s = bots.status(1);
  assert.equal(s.fire.perDay, 1);
  const s7 = bots.status(7); assert.ok(s7.fire.coin > 0 && s7.fire.bought === burnt.length, 'the admin sees the firewood bill');
  // the admin can change it, and it is saved
  bots.control({ settings: { burnWood: 2 } });
  assert.equal(JSON.parse(game.gs.meta('residents.settings')!).burnWood, 2);
  assert.equal(game.residents.burnDue(18, 2), 1, 'the first fire at 18:00');
  assert.equal(game.residents.burnDue(5, 2), 2, 'both by the end of the day');
  // and they still eat twice a day
  assert.equal(rows(game, 'resident_eat').length, 10, 'two meals each');
});

test('the work is shown on the spot, and the admin sees each resident\'s step now and next', async () => {
  const { game, clock, bots } = await world();
  bots.control({ settings: { trade: { enabled: false }, craft: { enabled: false }, gather: { enabled: true, minPricePct: 0, goods: ['wood', 'ore'] } } });
  clock.advanceHours(1); await game.step();
  const plan = bots.status(1).residents;
  const queued = plan.flatMap((r: any) => r.plan.next.map((x: any) => x.kind));
  assert.ok(queued.includes('chop') || queued.includes('mine'), `work queued: ${queued.join(',')}`);
  assert.ok(plan.every((r: any) => r.plan && r.plan.doing && r.plan.doing.kind), 'everyone has a step now');
  assert.ok(plan.every((r: any) => r.plan.nextMeal === null || (r.plan.nextMeal >= 0 && r.plan.nextMeal < 24)), 'the next meal hour');
  // walk the residents until someone works on the spot
  let seen: any = null;
  for (let i = 0; i < 600 && !seen; i++) { clock.advanceMs(500); game.residents.tick(game.now()); seen = game.residents.view(game.now()).find((v) => v.act); }
  assert.ok(seen, 'someone works on the spot');
  assert.ok(['chop', 'mine'].includes(seen.act.kind));
  const tile = game.map!.tileAt(seen.act.x, seen.act.y);
  assert.equal(tile, seen.act.kind === 'chop' ? 'tree' : 'rock', 'at a tree or a rock');
  assert.ok(Math.abs(seen.x - seen.act.x) + Math.abs(seen.y - seen.act.y) <= 1, 'standing next to it');
  // presence carries it to every player (social.ts nearby -> app.ts)
  const social = new Social(game.store as any);
  social.residents = () => game.residents.view(game.now());
  const near = social.nearby('someone.gt.test', 'public').find((x) => x.account === seen.account)!;
  assert.deepEqual(near.act, seen.act, 'presence sends the work');
  const who = game.residents.walkers.find((w) => w.id === seen.id)!;
  assert.equal(who.role, 'gather', 'a man at work');
  const p = bots.status(1).residents.find((r: any) => r.id === seen.id).plan;
  assert.equal(p.doing.kind, seen.act.kind, 'the admin sees it now');
});

test('a catch moves the ripples: the fished spot stops and one nearby starts, and presence carries it', async () => {
  const { game } = await world();
  const map = game.map!, L = map.layout as any, t = game.clock.time().totalHours;
  let spot: { x: number; y: number } | null = null;
  for (let y = 0; y < L.h && !spot; y++) for (let x = 0; x < L.w && !spot; x++) if (map.fishSpot(x, y, t)) spot = { x, y };
  assert.ok(spot, 'a spot');
  assert.equal(game.ripplesView('public'), null, 'nothing moved yet');
  game.moveRipple('public', map, spot!.x, spot!.y);
  assert.equal(game.fishSpotAt('public', map, spot!.x, spot!.y), false, 'the fished spot stops');
  const v = game.ripplesView('public')!;
  assert.deepEqual(v.gone, [`${spot!.x},${spot!.y}`]);
  assert.equal(v.extra.length, 1, 'one new spot');
  const [nx, ny] = v.extra[0].split(',').map(Number);
  assert.ok(Village.fishShore(L, nx, ny), 'on shore water');
  assert.ok(Math.abs(nx - spot!.x) <= 10 && Math.abs(ny - spot!.y) <= 10, 'nearby');
  assert.equal(game.fishSpotAt('public', map, nx, ny), true, 'the new spot can be fished');
  assert.equal(game.ripplesView('HL-1'), null, 'other worlds keep their own');
});
