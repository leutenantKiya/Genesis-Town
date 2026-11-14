// Admin "Bot warga" (adminbots.ts): the admin pauses the townsfolk's shopping or limits each resident to some merchants,
// watches the shared wallet's coin (in from the treasury and faucet, out to each merchant and per resident), and traces
// any account's coin by counterpart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { MockChain } from '../src/chain.ts';
import { Game } from '../src/game/game.ts';
import { loadEcon } from '../src/game/econ.ts';
import { AdminBots } from '../src/adminbots.ts';
import { Social } from '../src/social.ts';

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
  const clock = { now: () => now, advanceHours: (h: number) => { now += h * econ.time.realMsPerGameHour; } };
  const game = new Game(store, chain, { merchantParent: 'gt.test', town: TOWN, now: clock.now, rng: () => 0.99, econ, chunkSize: 25 });
  await game.init();
  const social = new Social(store);
  return { game, clock, bots: new AdminBots({ game, social }) };
}
// town demand comes in bursts (a merchant out of stock waits): step game hours until the condition holds, at most 24
async function hours(game: Game, clock: { advanceHours: (h: number) => void }, until: () => boolean) { for (let h = 0; h < 24 && !until(); h++) { clock.advanceHours(1); await game.step(); } }
const buys = (g: Game) => g.gs.db.prepare("SELECT ref FROM ledger WHERE kind = 'resident_buy'").all() as Array<{ ref: string }>;

test('the admin watches the wallet, pauses the shopping and picks the merchants each resident buys from', async () => {
  const { game, clock, bots } = await world();
  for (let h = 0; h < 6; h++) { clock.advanceHours(1); await game.step(); }
  const s = bots.status(0);
  assert.equal(s.wallet.account, WALLET);
  assert.ok(s.spent > 0, 'the town bought something');
  assert.equal(s.spent, s.merchants.reduce((n, m) => n + m.coin, 0), 'spent = sum over merchants');
  assert.equal(s.spent, s.residents.reduce((n, r) => n + r.spent, 0), 'spent = sum over residents');
  assert.ok(s.inflow.treasury > 0, 'topped up from the treasury');
  assert.ok(s.recent.length > 0 && s.recent[0].seq > s.recent[s.recent.length - 1].seq, 'newest first');

  // paused: no purchase at all
  const n0 = buys(game).length;
  bots.control({ paused: true });
  for (let h = 0; h < 4; h++) { clock.advanceHours(1); await game.step(); }
  assert.equal(buys(game).length, n0, 'nothing bought while paused');
  assert.equal(bots.status(1).paused, true);

  // every resident limited to one merchant: only that merchant is paid, and the setting survives a fresh read
  bots.control({ paused: false });
  const only = s.merchants.slice().sort((a, b) => b.units - a.units)[0].id;
  for (const r of s.residents) bots.control({ resident: r.id, merchants: [only] });
  assert.deepEqual(game.residents.controls().allow.r1, [only]);
  await hours(game, clock, () => buys(game).length > n0);
  const after = buys(game).slice(n0);
  assert.ok(after.length > 0, 'still buying');
  assert.ok(after.every((r) => r.ref.split(':')[1] === only), 'only from the allowed merchant');

  // one resident barred everywhere but another merchant: the others keep buying from `only`, never booked under r1
  const other = s.merchants.find((m) => m.id !== only)!.id;
  bots.control({ resident: 'r1', merchants: [other] });
  const n1 = buys(game).length;
  for (let h = 0; h < 6; h++) { clock.advanceHours(1); await game.step(); }
  assert.ok(buys(game).slice(n1).every((r) => !(r.ref.startsWith('r1:') && r.ref.split(':')[1] === only)));
  // null = all merchants again; bad input is refused
  bots.control({ resident: 'r1', merchants: null });
  assert.equal(game.residents.controls().allow.r1, undefined);
  assert.throws(() => bots.control({ resident: 'r9', merchants: null }), /No such resident/);
  assert.throws(() => bots.control({ resident: 'r1', merchants: ['nobody'] }), /Unknown merchant/);
  assert.throws(() => bots.control({}), /paused/);
});

test('the admin sets the town price ceiling: too low and the town stops buying, null goes back to the config', async () => {
  const { game, clock, bots } = await world();
  const def = game.econ.town.maxPriceMult;
  assert.equal(bots.status(1).price.mult, def);
  bots.control({ maxPriceMult: 1 });
  assert.equal(game.market.priceMult(), 1);
  const p = bots.status(1).price;
  assert.equal(p.mult, 1);
  for (const g of p.goods) {
    assert.equal(g.ceiling, Math.floor(g.base));
    for (const o of g.offers) if (o.ask > g.base && o.stock >= 1) assert.equal(o.why, 'expensive');
  }
  // every ask is above its base value: at x1 nothing is bought
  const priced = p.goods.every((g) => g.offers.every((o) => o.ask > g.base || o.stock < 1));
  const n0 = buys(game).length;
  for (let h = 0; h < 6; h++) { clock.advanceHours(1); await game.step(); }
  if (priced) assert.equal(buys(game).length, n0, 'nothing under the ceiling, nothing bought');
  bots.control({ maxPriceMult: 5 });
  await hours(game, clock, () => buys(game).length > n0);
  assert.ok(buys(game).length > n0, 'a high ceiling buys again');
  bots.control({ maxPriceMult: null });
  assert.equal(game.market.priceMult(), def);
  assert.throws(() => bots.control({ maxPriceMult: 0.5 }), /between 1 and 5/);
  assert.throws(() => bots.control({ maxPriceMult: '2' }), /between 1 and 5/);
});

test('trace follows the coin: wallet -> merchants, treasury -> wallet, merchant <- wallet', async () => {
  const { game, clock, bots } = await world();
  for (let h = 0; h < 6; h++) { clock.advanceHours(1); await game.step(); }
  const s = bots.status(0);
  const t = bots.trace(WALLET, 0);
  const toMerchants = t.outflow.filter((f) => f.kind === 'resident_buy');
  assert.equal(toMerchants.reduce((n, f) => n + f.amount, 0), s.spent, 'every coin spent goes to a named merchant');
  assert.ok(toMerchants.every((f) => f.account && /\.gt\.test$/.test(f.account) && f.name.includes('·')));
  const fromTown = t.inflow.find((f) => f.kind === 'handout' && f.account === TOWN);
  assert.ok(fromTown && fromTown.amount === s.inflow.treasury && fromTown.name === 'Town treasury');
  const m = s.merchants.find((x) => x.coin > 0)!;
  const tm = bots.trace(m.account, 0);
  const fromWallet = tm.inflow.find((f) => f.kind === 'resident_sale');
  assert.ok(fromWallet && fromWallet.account === WALLET && fromWallet.amount === m.coin && fromWallet.name === 'Townsfolk wallet');
  const tt = bots.trace(TOWN, 0);
  assert.ok(tt.outflow.some((f) => f.kind === 'handout' && f.account === WALLET));
  assert.throws(() => bots.trace('', 0), /account required/);
});
