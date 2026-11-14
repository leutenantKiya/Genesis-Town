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

test('the townsfolk buy to sell again at the admin\'s margin, negative allowed, and the settings live in the database', async () => {
  const { game, clock, bots } = await world();
  bots.control({ settings: { gather: { enabled: false } } }); // gathering has its own test below
  const tradeRows = () => game.gs.db.prepare("SELECT delta, ref FROM ledger WHERE account = ? AND token = 'coin' AND kind = 'trade' AND ref NOT LIKE '%-c' AND ref NOT LIKE '%-e' AND ref NOT LIKE '%-g' AND ref NOT LIKE '%-w'").all(WALLET) as Array<{ delta: number; ref: string }>;
  // off: no trading at all
  bots.control({ settings: { trade: { enabled: false } } });
  for (let h = 0; h < 6; h++) { clock.advanceHours(1); await game.step(); }
  assert.equal(tradeRows().length, 0, 'disabled: no trades');
  // a margin no merchant pays: nothing bought to resell
  bots.control({ settings: { trade: { enabled: true, marginPct: 500, perHour: 5, holdMax: 3, minWallet: 0 } } });
  for (let h = 0; h < 6; h++) { clock.advanceHours(1); await game.step(); }
  assert.equal(tradeRows().length, 0, '+500%: no merchant pays that');
  // -90%: they buy and sell at a loss, booked per resident, never holding more than holdMax
  bots.control({ settings: { trade: { marginPct: -90 } } });
  assert.equal(JSON.parse(game.gs.meta('residents.settings')!).trade.marginPct, -90, 'saved in the database');
  assert.equal(game.residents.settings().trade.perHour, 5, 'other fields kept');
  await hours(game, clock, () => tradeRows().some((r) => r.delta > 0));
  const rows = tradeRows();
  assert.ok(rows.some((r) => r.delta < 0) && rows.some((r) => r.delta > 0), 'bought and sold');
  assert.ok(rows.every((r) => /^\w+:\w+:1@\d+#r[1-5]$/.test(r.ref)), 'booked per resident');
  for (const h of Object.values(game.residents.stock())) assert.ok(h.qty <= 3);
  const st = bots.status(0);
  assert.equal(st.trade.sold - st.trade.bought, st.trade.profit);
  assert.equal(st.settings.trade.marginPct, -90);
  assert.ok(st.residents.reduce((n, r) => n + r.trade.units, 0) === st.trade.boughtUnits + st.trade.soldUnits);
  // the wallet's trace names the merchants it traded with
  const t = bots.trace(WALLET, 0);
  assert.ok(t.outflow.concat(t.inflow).filter((f) => f.kind === 'trade').every((f) => f.account && f.account.endsWith('.gt.test')));
  // the wallet target and treasury reserve are the admin's too; bad input is refused
  bots.control({ settings: { target: 900, treasuryReserve: 1000 } });
  assert.deepEqual([game.residents.settings().target, game.residents.settings().treasuryReserve], [900, 1000]);
  assert.throws(() => bots.control({ settings: { trade: { marginPct: -95 } } }), /marginPct must be a number from -90 to 500/);
  assert.throws(() => bots.control({ settings: { trade: { enabled: 'yes' } } }), /enabled must be true or false/);
  assert.throws(() => bots.control({ settings: { target: -1 } }), /target must be/);
});

test('the townsfolk craft and stock the shelves, which brings the crafted goods\' prices down', async () => {
  const off = await world(), on = await world();
  off.bots.control({ settings: { trade: { enabled: false }, craft: { enabled: false } } });
  on.bots.control({ settings: { trade: { enabled: false }, craft: { enabled: true, marginPct: 0, perHour: 6, fillPct: 200 } } });
  assert.equal(on.game.residents.settings().craft.fillPct, 200, 'saved');
  for (let h = 0; h < 12; h++) for (const w of [off, on]) { w.clock.advanceHours(1); await w.game.step(); }
  const crafts = on.game.gs.db.prepare("SELECT token, ref FROM ledger WHERE account = ? AND kind = 'resident_craft' AND delta > 0").all(WALLET) as Array<{ token: string; ref: string }>;
  assert.ok(crafts.length > 0, 'something crafted');
  assert.ok(crafts.every((c) => /^\w+#r[1-5]$/.test(c.ref)), 'booked per resident');
  assert.equal(off.game.gs.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE kind = 'resident_craft'").get()!.n, 0, 'off: nothing crafted');
  const st = on.bots.status(0);
  assert.ok(st.craft.soldUnits > 0, 'stocked a shelf');
  assert.equal(st.craft.profit, st.craft.sold - st.craft.inputs - st.craft.fees);
  assert.ok(st.craft.profit >= 0, 'crafting never sells below what it cost to make');
  // never past the fill line, and the asks of what was crafted came down against the world without crafting
  let lower = 0;
  for (const shelf of st.craft.shelves) for (const sh of shelf.shops) {
    assert.ok(sh.stock <= Math.max(sh.upTo, off.game.gs.balance(off.game.market.account(sh.id), shelf.token)), `${sh.name} ${shelf.token} within the fill line`);
    const a0 = off.game.market.row(sh.id, shelf.token).ask, a1 = on.game.market.row(sh.id, shelf.token).ask;
    if (st.craft.byGood[shelf.token]) { assert.ok(a1 <= a0, `${sh.name} ${shelf.token}: ${a1} <= ${a0}`); if (a1 < a0) lower++; }
  }
  assert.ok(lower > 0, 'at least one crafted good is cheaper');
  // a margin nobody pays: no crafting
  const n0 = crafts.length;
  on.bots.control({ settings: { craft: { marginPct: 500 } } });
  for (let h = 0; h < 4; h++) { on.clock.advanceHours(1); await on.game.step(); }
  assert.equal((on.game.gs.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE account = ? AND kind = 'resident_craft' AND delta > 0").get(WALLET) as { n: number }).n, n0);
  assert.throws(() => on.bots.control({ settings: { craft: { fillPct: 5 } } }), /fillPct must be a number from 10 to 300/);
});

test('trading and crafting fund themselves from the treasury above its reserve, never with new coin', async () => {
  const { game, clock, bots } = await world();
  const q = (sql: string) => (game.gs.db.prepare(sql).get(WALLET) as { n: number }).n;
  // the town's own shopping stays off (ceiling x1: every ask is above it), so the wallet starts empty
  bots.control({ maxPriceMult: 1 });
  bots.control({ settings: { treasuryReserve: 10_000_000, trade: { enabled: true, marginPct: -90, perHour: 4, minWallet: 50 }, craft: { enabled: true, marginPct: 0, perHour: 2 } } });
  for (let h = 0; h < 4; h++) { clock.advanceHours(1); await game.step(); }
  assert.equal(game.gs.balance(WALLET, 'coin'), 0, 'reserve above the treasury: no allowance');
  assert.equal(q("SELECT COUNT(*) AS n FROM ledger WHERE account = ? AND kind = 'trade'"), 0, 'and no trading without coin');
  // a reserve the treasury is above: the allowance comes from it and the bots trade and craft
  bots.control({ settings: { treasuryReserve: 1000 } });
  await hours(game, clock, () => q("SELECT COUNT(*) AS n FROM ledger WHERE account = ? AND kind = 'trade' AND delta > 0 AND token = 'coin'") > 0);
  assert.ok(q("SELECT COUNT(*) AS n FROM ledger WHERE account = ? AND kind = 'handout'") > 0, 'allowance from the treasury');
  assert.ok(q("SELECT COUNT(*) AS n FROM ledger WHERE account = ? AND kind = 'trade' AND delta > 0 AND token = 'coin'") > 0, 'sold to a merchant');
  assert.equal(q("SELECT COUNT(*) AS n FROM ledger WHERE account = ? AND kind = 'handout_mint'"), 0, 'no new coin for trading');
  assert.equal(q("SELECT COUNT(*) AS n FROM ledger WHERE account = ? AND kind = 'resident_buy'"), 0, 'the town itself still bought nothing');
});

test('the admin sees the townsfolk bag: books, chain, held to resell and spare', async () => {
  const { game, clock, bots } = await world();
  bots.control({ settings: { gather: { enabled: false } } }); // gathering has its own test below
  bots.control({ settings: { trade: { enabled: true, marginPct: -90, perHour: 4, holdMax: 5, minWallet: 0 }, craft: { enabled: false } } });
  for (let h = 0; h < 6; h++) { clock.advanceHours(1); await game.step(); }
  // a good the wallet holds outside the trading stock shows as spare
  game.gs.add(game.clock.time().settleDay, WALLET, 'ore', 3, 'test', null);
  const inv = bots.status(0).inventory, by = Object.fromEntries(inv.map((r) => [r.token, r]));
  assert.ok(by.coin && by.coin.books === game.gs.balance(WALLET, 'coin'), 'coin always listed');
  assert.equal(by.ore.books, 3); assert.equal(by.ore.spare, 3); assert.equal(by.ore.held, 0);
  for (const [token, h] of Object.entries(game.residents.stock())) {
    assert.equal(by[token].held, Math.min(h.qty, by[token].books));
    assert.equal(by[token].spare, by[token].books - by[token].held);
  }
  assert.ok(inv.every((r) => r.token === 'coin' || r.books !== 0 || r.chain !== 0), 'empty goods left out');
});

test('every resident eats 2 meals a game day from the bag, buying food when the bag has none', async () => {
  const { game, clock, bots } = await world();
  bots.control({ settings: { trade: { enabled: false }, craft: { enabled: false } } });
  for (let h = 0; h < 30; h++) { clock.advanceHours(1); await game.step(); }
  const rows = game.gs.db.prepare("SELECT token, ref, day FROM ledger WHERE account = ? AND kind = 'resident_eat'").all(WALLET) as Array<{ token: string; ref: string; day: number }>;
  assert.ok(rows.every((r) => ['bread', 'meal'].includes(r.token)), 'only food');
  const st = bots.status(0).meals;
  assert.equal(st.perDay, 2);
  for (const r of game.residents.walkers) {
    assert.equal(st.today[r.id], st.due, `${r.name} is fed up to now`);
    const days = new Set(rows.filter((x) => x.ref === r.id).map((x) => x.day));
    for (const d of days) if (d < game.clock.time().settleDay) assert.equal(rows.filter((x) => x.ref === r.id && x.day === d).length, 2, `${r.name}: 2 meals on day ${d}`);
  }
  assert.ok(st.bought > 0 && st.coin > 0, 'bought food to eat');
  // no meals: nobody eats
  bots.control({ settings: { meals: 0 } });
  const n0 = rows.length;
  for (let h = 0; h < 24; h++) { clock.advanceHours(1); await game.step(); }
  assert.equal((game.gs.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE account = ? AND kind = 'resident_eat'").get(WALLET) as { n: number }).n, n0);
});

test('the admin sees why the townsfolk do not buy, sell or craft', async () => {
  const { game, clock, bots } = await world();
  bots.control({ settings: { gather: { enabled: false } } }); // gathering has its own test below
  for (let h = 0; h < 2; h++) { clock.advanceHours(1); await game.step(); }
  bots.control({ settings: { trade: { enabled: true, marginPct: 500 }, craft: { enabled: true, marginPct: 500 } } });
  let why = bots.status(1).why;
  const wood = why.buy.find((b: any) => b.token === 'wood') as any;
  assert.equal(wood.code, 'margin', 'no merchant pays +500% for wood');
  assert.ok((wood.need as number) > (wood.bid as number));
  assert.notEqual(why.craft.find((c: any) => c.token === 'tool')!.code, 'no_ingredient', 'Ben sells ore now');
  assert.ok(why.craft.every((c: any) => ['too_costly', 'shelves_full', 'ingredient_out'].includes(c.code)));
  bots.control({ settings: { trade: { enabled: false } } });
  assert.ok(bots.status(1).why.buy.every((b: any) => b.code === 'off'));
  bots.control({ paused: true });
  assert.ok(bots.status(1).why.general.includes('paused'));
  // ok when the rules allow it
  bots.control({ paused: false });
  bots.control({ settings: { trade: { enabled: true, marginPct: -90, minWallet: 0 } } });
  why = bots.status(1).why;
  assert.ok(why.buy.some((b: any) => b.code === 'ok'), 'some good can be traded at -90%');
});

test('the townsfolk fish, chop and mine what is scarce or dear, cook with it, and stock the shelves', async () => {
  const { game, clock, bots } = await world();
  const sum = (kind: string, token: string) => (game.gs.db.prepare('SELECT COALESCE(SUM(delta), 0) AS n FROM ledger WHERE account = ? AND kind = ? AND token = ?').get(WALLET, kind, token) as { n: number }).n;
  // a price nothing reaches: no gathering while the merchants have stock
  bots.control({ settings: { trade: { enabled: false }, craft: { enabled: false }, gather: { enabled: true, goods: ['fish', 'wood', 'ore'], perHour: 2, dailyMax: 6, minPricePct: 500, fillPct: 200, keepMax: 4 } } });
  for (let h = 0; h < 3; h++) { clock.advanceHours(1); await game.step(); }
  assert.equal(sum('resident_gather', 'fish'), 0, 'fish is cheap enough');
  const why0 = bots.status(1).why.gather;
  assert.equal(why0.find((x: any) => x.token === 'fish')!.code, 'cheap');
  assert.equal(why0.find((x: any) => x.token === 'wheat')!.code, 'not_picked');
  // always gather: the catch goes to the shelves of the merchants that sell it (Ben sells ore now), at most dailyMax a day
  bots.control({ settings: { gather: { minPricePct: 0 } } });
  for (let h = 0; h < 6; h++) { clock.advanceHours(1); await game.step(); }
  assert.ok(sum('resident_gather', 'fish') > 0, 'fished');
  assert.ok(game.gs.balance(WALLET, 'ore') <= 4, 'never more than keepMax in the bag');
  // every unit wore the gatherer's own tool, bought new at Ben's
  const tools = game.residents.tools(), max = game.econ.tools;
  const bought = game.gs.db.prepare("SELECT ref, delta FROM ledger WHERE account = ? AND kind = 'tool_shop'").all(WALLET) as Array<{ ref: string; delta: number }>;
  assert.ok(bought.length > 0 && bought.every((b) => /^buy:(rod|axe|pickaxe|hoe)#r[1-5]$/.test(b.ref) && b.delta < 0), 'tools bought at Ben\'s');
  for (const [, t] of Object.entries(tools)) for (const [k, left] of Object.entries(t)) assert.ok(left >= 0 && left <= max[k].durability, k + ' uses within its durability');
  const benGot = (game.gs.db.prepare("SELECT COALESCE(SUM(delta), 0) AS n FROM ledger WHERE account = ? AND kind = 'tool_shop'").get(game.market.account('budi')) as { n: number }).n;
  assert.equal(benGot, -bought.reduce((n, b) => n + b.delta, 0), 'the coin went to Ben');
  const day = game.clock.time().settleDay;
  for (const g of ['fish', 'wood', 'ore']) assert.ok(game.residents.gatheredOn(day, g) <= 6, g + ': at most dailyMax a day');
  const st = bots.status(0);
  assert.ok(st.gather.soldUnits > 0 && (st.gather.soldBy.fish ?? 0) > 0, 'fish sold to a shelf');
  // cooking: with their own fish and wood the townsfolk make grilled fish (and tools from their ore) and stock the shelves
  bots.control({ settings: { craft: { enabled: true, marginPct: 0, perHour: 4, fillPct: 300 } } });
  await hours(game, clock, () => sum('resident_craft', 'meal') > 0);
  assert.ok(sum('resident_craft', 'meal') > 0, 'cooked grilled fish');
  const st2 = bots.status(0);
  assert.ok(st2.craft.profit >= 0, 'never at a loss');
  assert.ok(st2.why.craft.every((c: any) => c.code !== 'no_ingredient'), 'gathered goods are not missing');
  assert.throws(() => bots.control({ settings: { gather: { goods: ['bread'] } } }), /goods must be a list of/);
  assert.throws(() => bots.control({ settings: { gather: { dailyMax: 500 } } }), /dailyMax must be a number from 0 to 100/);
});

test('a broken tool is replaced with a new one from Ben, never repaired, and no money means no gathering', async () => {
  const { game, clock, bots } = await world();
  bots.control({ settings: { trade: { enabled: false }, craft: { enabled: false }, gather: { enabled: true, goods: ['fish'], perHour: 1, dailyMax: 50, minPricePct: 0, fillPct: 300, keepMax: 50 } } });
  // r1..r5 each hold a rod with one use left; only the men (the gatherers) fish
  game.gs.setMeta('residents.tools', JSON.stringify(Object.fromEntries(game.residents.walkers.map((w) => [w.id, { rod: 1 }]))));
  const crew = game.residents.crew();
  assert.equal(crew.length, 3, 'Haruto, Sota and Ren gather');
  for (let h = 0; h < crew.length; h++) { clock.advanceHours(1); await game.step(); }
  const buys = () => game.gs.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE account = ? AND kind = 'tool_shop'").get(WALLET) as { n: number };
  assert.equal(buys().n, 0, 'the last use of each rod needs no new one');
  assert.ok(crew.every((w) => game.residents.tools()[w.id].rod === 0), 'every gatherer rod is used up');
  assert.ok(game.residents.walkers.filter((w) => w.role === 'cook').every((w) => game.residents.tools()[w.id].rod === 1), 'the cooks never fish');
  clock.advanceHours(1); await game.step();
  assert.equal(buys().n, 1, 'a broken rod is replaced by a new one');
  const t = game.residents.tools();
  assert.ok(Object.values(t).some((x) => x.rod === game.econ.tools.rod.durability - 1), 'new rod, one use taken');
  assert.equal(game.gs.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE ref LIKE 'repair:%'").get()!.n, 0, 'never repaired');
  // no allowance possible and an empty wallet: no new rod, no fishing
  game.gs.setMeta('residents.tools', JSON.stringify(Object.fromEntries(game.residents.walkers.map((w) => [w.id, { rod: 0 }]))));
  const coin = game.gs.balance(WALLET, 'coin');
  if (coin > 0) game.gs.add(game.clock.time().settleDay, WALLET, 'coin', -coin, 'test', null);
  bots.control({ settings: { treasuryReserve: 10_000_000 } });
  for (const w of game.residents.walkers) bots.control({ resident: w.id, merchants: [] }); // no town shopping either (its allowance may print coin)
  const caught0 = (game.gs.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE account = ? AND kind = 'resident_gather'").get(WALLET) as { n: number }).n;
  clock.advanceHours(1); await game.step();
  assert.equal((game.gs.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE account = ? AND kind = 'resident_gather'").get(WALLET) as { n: number }).n, caught0, 'no rod, no fish');
  assert.equal(bots.status(1).why.gather.find((x: any) => x.token === 'fish')!.code, 'no_tool');
});
