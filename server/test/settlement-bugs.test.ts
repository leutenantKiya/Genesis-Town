import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { MockChain } from '../src/chain.ts';
import { Game } from '../src/game/game.ts';
import { loadEcon } from '../src/game/econ.ts';
import { packChunks } from '../src/game/settlement.ts';

const TOWN = 'town.gt.test';

async function world(players: string[], chunkSize = 5) {
  const econ = loadEcon();
  const chain = new MockChain();
  const base = Object.fromEntries(Object.entries(econ.items).map(([t, i]) => [t, i.base]));
  chain.accounts.add(TOWN);
  chain.add(TOWN, 'coin', 5000n);
  for (const [id, d] of Object.entries(econ.merchants)) {
    chain.addMerchant(`${id}.gt.test`, d.shop, { coin: d.restore.coin, ...d.restore.items }, { coin: d.startCash, ...d.startStock }, base);
  }
  const store = new Store(':memory:');
  let now = 1_800_000_000_000;
  const clock = { now: () => now, advanceMs: (ms: number) => { now += ms; }, advanceHours: (h: number) => { now += h * econ.time.realMsPerGameHour; } };
  const game = new Game(store, chain, { merchantParent: 'gt.test', town: TOWN, now: clock.now, rng: () => 0.99, econ, chunkSize });
  await game.init();
  for (const a of players) {
    store.addPlayer(a, 'sub-' + a, 'ed25519:o');
    await chain.registerPlayer(a);
    game.onNewPlayer(a);
  }
  return { econ, chain, store, game, clock };
}

const quiet = () => { const orig = console.error; console.error = () => {}; return () => { console.error = orig; }; };

test('packChunks puts accounts that pay coin first and keeps an account together', () => {
  const e = (a: string, t: string, d: number) => ({ account_id: a, token_id: t, delta: String(d) });
  const chunks = packChunks([e('a.players.t', 'coin', 100), e('a.players.t', 'fish', 1), e('b.players.t', 'coin', -50), e('b.players.t', 'wood', 2), e('c.players.t', 'fish', 3)], 3);
  assert.deepEqual(chunks.map((c) => c.map((x) => x.account_id + ':' + x.token_id)), [['b.players.t:coin', 'b.players.t:wood', 'c.players.t:fish'], ['a.players.t:coin', 'a.players.t:fish']]);
});

test('mock chain applies the contract rules: gain caps and the coin faucet; unregistered entries are skipped', async () => {
  const chain = new MockChain();
  chain.accounts.add('a.players.t');
  chain.accounts.add('b.players.t');
  chain.add('b.players.t', 'coin', 20000n); // supply 20000 -> allowance 1200 * 5000 / 25000 = 240
  const e = (a: string, t: string, d: number) => ({ account_id: a, token_id: t, delta: String(d) });
  assert.match((await chain.settleDay(1, 0, [e('a.players.t', 'fish', 201)], 'r1', 1)).error ?? '', /daily gain cap/);
  assert.equal((await chain.settleDay(1, 0, [e('a.players.t', 'fish', 200), e('ghost.players.t', 'fish', 5)], 'r1', 1)).ok, true);
  assert.equal(chain.get('ghost.players.t', 'fish'), 0n, 'unregistered account skipped');
  assert.match((await chain.settleDay(1, 1, [e('a.players.t', 'fish', 1)], 'r1', 1)).error ?? '', /daily gain cap/, 'cap is per day');
  assert.match((await chain.settleDay(2, 0, [e('a.players.t', 'coin', 300)], 'r2', 1)).error ?? '', /coin faucet exceeded/);
  // running net: +200 then -100 then +100 is fine (net 200 <= 240), a gross of 300 is not
  assert.equal((await chain.settleDay(3, 0, [e('a.players.t', 'coin', 200)], 'r3', 1)).ok, true);
  assert.equal((await chain.settleDay(3, 1, [e('b.players.t', 'coin', -100)], 'r3', 1)).ok, true);
  assert.equal((await chain.settleDay(3, 2, [e('a.players.t', 'coin', 100)], 'r3', 1)).ok, true);
  assert.match((await chain.settleDay(3, 3, [e('a.players.t', 'coin', 100)], 'r3', 1)).error ?? '', /coin faucet exceeded/);
});

test('chunks list coin payers first, so six sellers settle under a faucet smaller than the gross transfers', async () => {
  const ps = [1, 2, 3, 4, 5, 6].map((i) => `p${i}.players.test`);
  const { game, chain } = await world(ps, 5);
  chain.add('sari.gt.test', 'coin', 2000n);
  chain.add('joko.gt.test', 'coin', 2000n);
  for (const p of ps) chain.add(p, 'fish', 3n);
  await game.settlement.refresh(['sari.gt.test', 'joko.gt.test', ...ps]);
  const day = game.clock.time().settleDay;
  ps.forEach((p, i) => {
    const m = i % 2 ? 'joko.gt.test' : 'sari.gt.test';
    game.gs.add(day, p, 'fish', -3, 'trade');
    game.gs.add(day, p, 'coin', 150, 'trade');
    game.gs.add(day, m, 'coin', -150, 'trade');
  });
  const allowed = chain.faucetAllowed(chain.supplyBig(), ps.length);
  assert.ok(allowed < 1500n, `allowance ${allowed} is below the 1500 of gross payouts`);
  await game.devSettle();
  assert.equal(game.settlement.settledThrough(), day, 'day settled');
  assert.ok(chain.applied.size > 1, 'the day was split into chunks');
  for (const p of ps) assert.equal(String(game.gs.balance(p, 'coin')), String(chain.get(p, 'coin')));
});

test('a refresh between chunks does not count the applied chunk twice, and the day completes to the chain balances', async () => {
  const ps = [1, 2, 3, 4].map((i) => `p${i}.players.test`);
  const { game, chain, clock } = await world(ps, 2);
  const day = game.clock.time().settleDay;
  ps.forEach((p) => game.gs.add(day, p, 'wood', 7, 'gather'));
  const all = [...ps, TOWN, ...Object.keys(game.econ.merchants).map((id) => `${id}.gt.test`)];
  const tokens = Object.keys(game.econ.items);
  const snap = () => all.map((a) => tokens.map((t) => game.gs.balance(a, t)).join(','));
  const orig = chain.settleDay.bind(chain);
  let fail = true;
  chain.settleDay = async (d, c, ...rest) => { if (c === 1 && fail) throw new Error('boom'); return orig(d, c, ...rest); };
  const restore = quiet();
  await game.devSettle();
  const before = snap(); // spendable balances after chunk 0 landed and chunk 1 failed
  assert.equal(game.settlement.settledThrough(), day - 1);
  assert.ok(chain.applied.has(`${day}:0`) && !chain.applied.has(`${day}:1`), 'chunk 0 applied, chunk 1 not');
  await game.settlement.refresh(all);
  assert.deepEqual(snap(), before, 'balances after refresh in the middle of the day equal the balances before');
  fail = false;
  clock.advanceHours(1);
  await game.step();
  restore();
  assert.equal(game.settlement.settledThrough(), day);
  await game.settlement.refresh(all);
  for (const a of all) for (const t of tokens) assert.equal(String(game.gs.settledBalance(a, t)), String(chain.get(a, t)), `${a} ${t}`);
  assert.equal(game.gs.dayRows(day).filter((r) => !r.settled).length, 0);
});

test('a failing settlement is retried with backoff (30 s, doubling) and logged once per attempt', async () => {
  const { game, chain, clock } = await world(['p1.players.test']);
  chain.settleError = 'rpc down';
  const logs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { logs.push(a.join(' ')); };
  try {
    await game.devSettle();
    const calls = () => chain.settleCalls.length;
    assert.equal(calls(), 1);
    await game.step();
    clock.advanceMs(29_000); await game.step();
    assert.equal(calls(), 1, 'no retry inside the first 30 s');
    clock.advanceMs(1_000); await game.step();
    assert.equal(calls(), 2, 'retry after 30 s');
    clock.advanceMs(59_000); await game.step();
    assert.equal(calls(), 2, 'second delay is 60 s');
    clock.advanceMs(1_000); await game.step();
    assert.equal(calls(), 3);
    assert.equal(logs.filter((l) => /rpc down/.test(l)).length, 3, 'one error line per attempt');
    chain.settleError = null;
    clock.advanceMs(120_000); await game.step();
    assert.equal(game.settlement.settledThrough(), game.clock.time().settleDay - 1, 'settled once the chain is back');
  } finally {
    console.error = orig;
  }
});

test('dividends are planned before settling and paid once, even after a crash or a failed payment', async () => {
  const { game, chain, clock } = await world(['p1.players.test']);
  const day = game.clock.time().settleDay;
  game.gs.add(day, 'wati.gt.test', 'coin', 500, 'trade');
  game.gs.add(day, TOWN, 'coin', -500, 'test');
  const paid: number[] = [];
  const orig = chain.payDividend.bind(chain);
  let mode: 'crash' | 'fail' | 'ok' = 'crash';
  chain.payDividend = async (m, d, amount) => {
    if (mode === 'crash') throw new Error('process died');
    if (mode === 'fail') return { txHash: 'x', ok: false, error: 'rpc busy' };
    const r = await orig(m, d, amount);
    if (r.ok) paid.push(amount);
    return r;
  };
  const restore = quiet();
  await game.devSettle();
  assert.equal(game.settlement.settledThrough(), day - 1, 'day is not closed while a dividend is unpaid');
  assert.equal(game.gs.dayRows(day).filter((r) => !r.settled).length, 0, 'all rows were already settled (the old profit source)');
  mode = 'fail';
  clock.advanceHours(1); await game.step();
  assert.equal(paid.length, 0);
  mode = 'ok';
  clock.advanceHours(1); await game.step();
  restore();
  assert.equal(game.settlement.settledThrough(), day);
  const share = game.econ.shops.dividendShare;
  const profit = game.gs.dayRows(day).filter((r) => r.account === 'wati.gt.test' && r.token === 'coin').reduce((s, r) => s + r.delta, 0);
  assert.ok(profit >= 460);
  assert.deepEqual(paid, [Math.floor(profit * share)],'the planned dividend was paid exactly once');
  const h = await chain.holding('wati.gt.test', 'town');
  assert.ok(Number(h.claimable) > 0);
  assert.equal(String(game.gs.settledBalance('wati.gt.test', 'coin')), String(chain.get('wati.gt.test', 'coin')));
});

test('days on which nothing happened close without a transaction, so a server that was off does not spend gas on them', async () => {
  const p = 'a.players.test';
  const { game, chain, clock } = await world([p]);
  const day0 = game.clock.time().settleDay;
  game.gs.add(day0, p, 'wood', 3, 'gather');
  // the server is off for 30 game days: no rows are written for them (the loop catches up only the last 24 hours)
  game.gs.setMeta('clock.hour', String(game.clock.hours() + 30 * game.econ.time.hoursPerDay));
  clock.advanceHours(30 * game.econ.time.hoursPerDay);
  const upTo = game.clock.time().settleDay - 1;
  const busy = new Set(Array.from({ length: upTo - day0 + 1 }, (_, i) => day0 + i).filter((d) => game.gs.dayRows(d).length > 0));
  assert.ok(busy.has(day0) && busy.size < 5, `only a few days have rows (${[...busy]})`);
  for (let i = 0; i < 6 && game.settlement.settledThrough() < upTo; i++) await game.step();
  assert.equal(game.settlement.settledThrough(), upTo, 'every day up to yesterday is closed');
  assert.deepEqual([...new Set(chain.settleCalls.map((c) => c.day))].sort((a, b) => a - b), [...busy].sort((a, b) => a - b), 'settle_day was sent only for days with rows');
  assert.equal(String(chain.get(p, 'wood')), '3', 'the real day still reached the chain');
});

test('an empty day between two busy days is skipped, and the busy day after it settles in the same run', async () => {
  const p = 'b.players.test';
  const { game, chain, clock } = await world([p]);
  const d = game.clock.time().settleDay;
  game.gs.add(d, p, 'fish', 1, 'gather');
  game.gs.add(d + 2, p, 'fish', 2, 'gather'); // d + 1 has nothing
  clock.advanceHours(3 * game.econ.time.hoursPerDay);
  game.gs.setMeta('clock.hour', String(game.clock.hours()));
  const upTo = game.clock.time().settleDay - 1;
  await game.settlement.settleDue();
  assert.ok(game.settlement.settledThrough() >= d + 2 && game.settlement.settledThrough() <= upTo);
  assert.ok(!chain.settleCalls.some((c) => c.day === d + 1), 'no transaction for the empty day');
  assert.ok(chain.settleCalls.some((c) => c.day === d) && chain.settleCalls.some((c) => c.day === d + 2));
  assert.equal(String(chain.get(p, 'fish')), '3');
});

test('close_shop reporting ok:false (shop already closed, as testnet now returns it) does not block the day', async () => {
  const p = 'c.players.test';
  const { game, chain } = await world([p]);
  const day = game.clock.time().settleDay - 1;
  game.gs.add(day, p, 'wood', 1, 'gather');
  game.gs.add(day, 'wati.gt.test', 'coin', -100000, 'test'); // cannot pay the rent: planned to close
  const calls: string[] = [];
  chain.closeShop = async (m: string) => { calls.push(m); return { txHash: 'x', ok: false, error: 'shop is already closed' }; };
  const restore = quiet();
  await game.devSettle();
  restore();
  assert.ok(calls.includes('wati.gt.test'), 'close_shop was attempted');
  assert.ok(game.settlement.settledThrough() >= day, 'the day still finished');
});

test('a database behind the chain stops settling instead of paying gas for days the contract already closed', async () => {
  const { game, chain } = await world(['p1.players.test']);
  chain.lastSettled = 1000; // another database (or server) already closed day 1000 on this contract
  const restore = quiet();
  try {
    await game.devSettle();
    await game.step();
  } finally { restore(); }
  assert.equal(chain.settleCalls.length, 0, 'no settle_day sent');
  assert.ok(game.settlement.blocked && game.settlement.blocked.chainDay === 1000);
  const { healthProblems } = await import('../src/app.ts');
  const problems = healthProblems({ settleDay: 5, settledThrough: 3, settleBlocked: game.settlement.blocked });
  assert.match(problems.join('\n'), /settlement stopped: the contract already closed day 1000/);
});

test('a database level with the chain settles as before', async () => {
  const { game, chain } = await world(['p1.players.test']);
  await game.devSettle();
  assert.equal(game.settlement.blocked, null);
  assert.ok(chain.settleCalls.length > 0);
  assert.equal(chain.lastSettled, game.settlement.settledThrough());
});

test('a refresh asked for while a settlement runs is read only after it, so the day is not counted twice', async () => {
  const P = 'p1.players.gt.test';
  const { chain, store, game } = await world([P]);
  const coin = () => store.db.prepare("SELECT amount FROM settled WHERE account = ? AND token = 'coin'").get(P) as { amount: number } | undefined;
  const before = coin()?.amount ?? 0;
  chain.add(P, 'coin', 7n); // a move on chain (e.g. a top-up) that the books learn through refresh
  game.settlement.busy = true;
  await game.settlement.refresh([P]);
  assert.equal(coin()?.amount ?? 0, before, 'not read during the settlement');
  game.settlement.busy = false;
  await game.settlement.settleDue(); // nothing due; its finally runs the deferred read
  assert.equal(coin()?.amount, before + 7, 'read once the settlement finished');
});
