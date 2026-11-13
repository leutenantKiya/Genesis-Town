// Casino chips (src/game/chips.ts): bought with coin, exchangeable back (bought chips only, minus a fee); chips won at the
// tables are marked and can never be exchanged. Every outcome is drawn on the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, P, Q, fails } from './coopworld.ts';

const TOWN = 'town.gt.test';

async function setup() {
  const w = await world();
  const g = w.game, c = w.econ.chips;
  const lm = g.map!.landmarks().gamble;
  const luckPos = { x: lm.x, y: lm.y + 1 };
  const farPos = g.map!.layout.spawn;
  const at = (a: string, pos: { x: number; y: number }) => { g.positions!.setWorld(a, 'public', pos, Date.now()); g.reportPosition(a, pos, 'public'); w.adv(2_000); };
  const act = (a: string, body: Record<string, unknown>) => { w.adv(2_000); return g.act(a, { world: 'public', pos: g.positions!.lastOf(a), ...body }) as any; };
  const coin = (a: string) => g.gs.balance(a, 'coin');
  const chips = (a: string) => g.state(a).chips as { bought: number; won: number; hand: any };
  const rows = (kind: string) => g.gs.db.prepare('SELECT account, delta, ref FROM ledger WHERE kind = ? ORDER BY seq').all(kind) as Array<{ account: string; delta: number; ref: string }>;
  const pass = (a: string) => { g.gs.add(w.day(), a, 'coin', 100, 'test'); (g.extras as any).st.setPass(a, 'casino', g.now() + 3_600_000); };
  at(P, luckPos); at(Q, luckPos);
  return { ...w, g, c, luckPos, farPos, at, act, coin, chips, rows, pass };
}

test('buying chips: coin goes to the town, chips are marked bought, a ledger row each side', async () => {
  const s = await setup();
  const per = s.c.perCoin, coin0 = s.coin(P), town0 = s.coin(TOWN);
  const r = s.act(P, { action: 'chips', op: 'buy', n: 10 * per });
  assert.equal(s.coin(P), coin0 - 10);
  assert.equal(s.coin(TOWN), town0 + 10);
  assert.deepEqual(s.chips(P).bought, 10 * per);
  assert.equal(s.chips(P).won, 0);
  assert.equal(r.state.chips.bought, 10 * per, 'the act answer carries the new state');
  assert.deepEqual(s.rows('chips_buy').map((x) => [x.account, x.delta]), [[P, -10], [TOWN, 10]]);
  // steps of a whole coin, a whole number, within the daily limit, and only with the coin
  fails(() => s.act(P, { action: 'chips', op: 'buy', n: per + 1 }), 400, /steps of/);
  fails(() => s.act(P, { action: 'chips', op: 'buy', n: 0 }), 400, /whole number/);
  fails(() => s.act(P, { action: 'chips', op: 'buy', n: 15.5 }), 400, /whole number/);
  fails(() => s.act(P, { action: 'chips', op: 'buy', n: (s.c.buyMaxCoinPerDay + 1) * per }), 409, /at most/);
  s.g.gs.add(1, Q, 'coin', -s.coin(Q) + 4, 'test');
  fails(() => s.act(Q, { action: 'chips', op: 'buy', n: 5 * per }), 409, /Not enough coins/);
  assert.equal(s.chips(Q).bought, 0);
  assert.equal(s.coin(Q), 4);
});

test('the daily buy limit holds and resets the next day', async () => {
  const s = await setup();
  s.g.gs.add(s.day(), P, 'coin', 1000, 'test');
  s.act(P, { action: 'chips', op: 'buy', n: s.c.buyMaxCoinPerDay * s.c.perCoin });
  fails(() => s.act(P, { action: 'chips', op: 'buy', n: s.c.perCoin }), 409, /at most/);
  assert.equal(s.chips(P).bought, s.c.buyMaxCoinPerDay * s.c.perCoin);
});

test('selling: only bought chips go back to coin, at the same rate minus the fee, from the town fund', async () => {
  const s = await setup();
  const per = s.c.perCoin, fee = s.c.sellFeePct;
  s.act(P, { action: 'chips', op: 'buy', n: 100 * per }); // 100 coin
  const coin0 = s.coin(P), town0 = s.coin(TOWN);
  const n = 40 * per, want = Math.floor(n * (100 - fee) / (100 * per));
  assert.equal(want, 38, '40 coin of chips, 5% off');
  const r = s.act(P, { action: 'chips', op: 'sell', n });
  assert.equal(s.coin(P), coin0 + want);
  assert.equal(s.coin(TOWN), town0 - want);
  assert.equal(s.chips(P).bought, 60 * per);
  assert.deepEqual(s.rows('chips_sell').map((x) => [x.account, x.delta]), [[TOWN, -want], [P, want]]);
  assert.match(r.toast, /fee 5%/);
  // more than the bought chips: refused, nothing moves
  fails(() => s.act(P, { action: 'chips', op: 'sell', n: 61 * per }), 409, /Only chips you bought|only have/);
  fails(() => s.act(P, { action: 'chips', op: 'sell', n: per + 1 }), 400, /steps of/);
  assert.equal(s.chips(P).bought, 60 * per);
  assert.equal(s.coin(P), coin0 + want);
  // never a profit: buying then selling everything loses the fee
  const all = s.chips(P).bought;
  s.act(P, { action: 'chips', op: 'sell', n: all });
  assert.ok(s.coin(P) < coin0 + want + 60, 'the fee stays with the town');
});

test('the town fund must be able to pay a sale, and the daily sell limit holds', async () => {
  const s = await setup();
  const per = s.c.perCoin;
  s.g.gs.add(s.day(), P, 'coin', 500, 'test');
  s.act(P, { action: 'chips', op: 'buy', n: 100 * per });
  s.g.gs.add(s.day(), TOWN, 'coin', -(s.coin(TOWN) - 5), 'test'); // the town holds 5 coin
  fails(() => s.act(P, { action: 'chips', op: 'sell', n: 100 * per }), 409, /town fund has only 5/);
  assert.equal(s.chips(P).bought, 100 * per);
  s.g.gs.add(s.day(), TOWN, 'coin', 10_000, 'test');
  const lim = s.c.sellMaxChipsPerDay;
  s.g.gs.db.prepare('UPDATE chip_day SET sold_chips = ?').run(0);
  s.g.chips.st.add(P, lim, 0);
  s.act(P, { action: 'chips', op: 'sell', n: lim });
  fails(() => s.act(P, { action: 'chips', op: 'sell', n: per }), 409, /at most/);
});

test('chips won at a table cannot be exchanged; a stake spends bought chips first, then won ones', async () => {
  const s = await setup();
  s.g.chips.st.add(P, 20, 0);
  s.g.rng = () => 0.01; // wins
  s.act(P, { action: 'chips', op: 'play', game: 'luck', stake: 10 });
  assert.deepEqual([s.chips(P).bought, s.chips(P).won], [10, 20], 'bought chips paid the stake, the win (2x) is won chips');
  s.act(P, { action: 'chips', op: 'play', game: 'luck', stake: 25 }); // 10 bought + 15 won
  assert.deepEqual([s.chips(P).bought, s.chips(P).won], [0, 5 + 50]);
  const coin = s.coin(P);
  fails(() => s.act(P, { action: 'chips', op: 'sell', n: s.c.perCoin }), 409, /Chips you won cannot be exchanged|only chips you bought/i);
  assert.equal(s.coin(P), coin, 'no coin for won chips');
  assert.equal(s.chips(P).won, 55);
  // losses take bought first as well
  s.g.chips.st.add(P, 30, 0);
  s.g.rng = () => 0.99;
  s.act(P, { action: 'chips', op: 'play', game: 'luck', stake: 50 });
  assert.deepEqual([s.chips(P).bought, s.chips(P).won], [0, 35]);
});

test('the Luck Table: the server rolls (the client cannot send a result), double or nothing', async () => {
  const s = await setup();
  s.g.chips.st.add(P, 100, 0);
  s.g.rng = () => s.c.luckWin - 0.001;
  const w = s.act(P, { action: 'chips', op: 'play', game: 'luck', stake: 10, win: false, roll: 0.99, payout: 0 }); // fake outcome fields are ignored
  assert.equal(w.play.win, true); assert.equal(w.play.payout, 20);
  assert.equal(s.chips(P).won, 20); assert.equal(s.chips(P).bought, 90);
  s.g.rng = () => s.c.luckWin; // just over: loses
  const l = s.act(P, { action: 'chips', op: 'play', game: 'luck', stake: 10 });
  assert.equal(l.play.win, false);
  assert.equal(s.chips(P).bought, 80); assert.equal(s.chips(P).won, 20);
  // the rate over many rolls follows the config, whatever the client sends
  s.g.rng = (() => { let i = 0; return () => (i++ % 100) / 100; })();
  let wins = 0; s.g.chips.st.add(P, 1_000_000, 0);
  for (let i = 0; i < 100; i++) { s.g.chips.st.db.prepare("DELETE FROM chip_day WHERE account = ?").run(P); if (s.act(P, { action: 'chips', op: 'play', game: 'luck', stake: 5 }).play.win) wins++; }
  assert.equal(wins, Math.round(s.c.luckWin * 100));
});

test('stake limits: minimum, maximum, balance, whole number, daily total', async () => {
  const s = await setup();
  s.g.chips.st.add(P, 300, 0);
  const play = (stake: unknown) => s.act(P, { action: 'chips', op: 'play', game: 'luck', stake });
  fails(() => play(s.c.minStake - 1), 400, /stake is/);
  fails(() => play(s.c.maxStake + 1), 400, /stake is/);
  fails(() => play(7.5), 400, /whole number/);
  fails(() => play('10'), 400, /whole number/);
  fails(() => play(undefined), 400, /whole number/);
  s.g.chips.st.add(Q, 3, 0);
  fails(() => s.act(Q, { action: 'chips', op: 'play', game: 'luck', stake: 5 }), 409, /Not enough chips/);
  assert.equal(s.chips(Q).bought, 3);
  // daily total
  s.g.chips.st.add(P, 100_000, 0);
  s.g.rng = () => 0.99;
  for (let used = 0; used + s.c.maxStake <= s.c.stakeMaxPerDay; used += s.c.maxStake) play(s.c.maxStake);
  fails(() => play(s.c.maxStake), 409, /at most .* chips a day/);
});

test('where and with what: the Luck Table needs the table or a pass; the other tables need a casino pass', async () => {
  const s = await setup();
  s.g.chips.st.add(P, 500, 0);
  s.at(P, s.farPos);
  fails(() => s.act(P, { action: 'chips', op: 'play', game: 'luck', stake: 5 }), 409, /Luck Table/);
  s.at(P, s.luckPos);
  s.act(P, { action: 'chips', op: 'play', game: 'luck', stake: 5 });
  for (const game of ['slot', 'dice', 'cards']) fails(() => s.act(P, { action: 'chips', op: 'play', game, stake: 5, ...(game === 'dice' ? { pick: 'big' } : {}) }), 409, /casino pass/);
  s.pass(P);
  s.at(P, s.farPos);
  s.act(P, { action: 'chips', op: 'play', game: 'slot', stake: 5 });
  fails(() => s.act(P, { action: 'chips', op: 'play', game: 'poker', stake: 5 }), 400, /Unknown game/);
  fails(() => s.act(P, { action: 'chips', op: 'jump' }), 400, /Unknown chips action/);
});

test('slot: three alike pay the multiple, two alike return the stake to where it came from, else it is lost', async () => {
  const s = await setup();
  s.pass(P);
  s.g.chips.st.add(P, 10, 0); // 10 bought
  const set = (...v: number[]) => { let i = 0; const total = s.c.slot.weights.reduce((a, b) => a + b, 0); s.g.rng = () => { const x = v[i++ % v.length]; return x / total + 1e-9; }; };
  // reel indices by cumulative weight: 30,25,20,15,10 -> symbol 4 starts at 90
  set(95, 95, 95);
  const jackpot = s.act(P, { action: 'chips', op: 'play', game: 'slot', stake: 10 });
  assert.deepEqual(jackpot.play.reels, [4, 4, 4]);
  assert.equal(jackpot.play.mult, s.c.slot.pays[4]);
  assert.deepEqual([s.chips(P).bought, s.chips(P).won], [0, 10 * s.c.slot.pays[4]]);
  set(1, 1, 95); // two alike
  s.g.chips.st.add(P, 10, 0);
  const pair = s.act(P, { action: 'chips', op: 'play', game: 'slot', stake: 10 });
  assert.equal(pair.play.mult, 1);
  assert.deepEqual([s.chips(P).bought, s.chips(P).won], [10, 10 * s.c.slot.pays[4]], 'a pushed bought stake stays bought');
  set(1, 35, 95); // three different
  const lose = s.act(P, { action: 'chips', op: 'play', game: 'slot', stake: 10 });
  assert.equal(lose.play.mult, 0);
  assert.equal(s.chips(P).bought, 0);
});

test('dice: big or small decided by the server dice, a triple loses, a pick is required', async () => {
  const s = await setup();
  s.pass(P);
  s.g.chips.st.add(P, 100, 0);
  const seq = (...faces: number[]) => { let i = 0; s.g.rng = () => (faces[i++ % faces.length] - 1) / 6 + 0.01; };
  seq(6, 5, 4); // 15 big
  assert.equal(s.act(P, { action: 'chips', op: 'play', game: 'dice', stake: 10, pick: 'big' }).play.win, true);
  assert.equal(s.chips(P).won, 20);
  seq(1, 2, 3); // 6 small
  assert.equal(s.act(P, { action: 'chips', op: 'play', game: 'dice', stake: 10, pick: 'big' }).play.win, false);
  seq(4, 4, 4); // triple: both picks lose
  const t = s.act(P, { action: 'chips', op: 'play', game: 'dice', stake: 10, pick: 'small' });
  assert.equal(t.play.triple, true); assert.equal(t.play.win, false);
  const before = s.chips(P);
  fails(() => s.act(P, { action: 'chips', op: 'play', game: 'dice', stake: 10 }), 400, /big or small/);
  assert.deepEqual(s.chips(P), before, 'a refused play takes nothing');
});

test('cards: the hand lives on the server, a right guess grows the pot, a wrong one loses it, cash pays won chips', async () => {
  const s = await setup();
  s.pass(P);
  s.g.chips.st.add(P, 100, 0);
  const card = (rank: number, suit = 0) => ((suit * 13 + rank - 1) + 0.5) / 52; // rng value that draws this card
  s.g.rng = () => card(7);
  const dealt = s.act(P, { action: 'chips', op: 'play', game: 'cards', stake: 20 });
  assert.equal(dealt.play.card % 13 + 1, 7); assert.equal(dealt.play.pot, 20);
  assert.equal(s.chips(P).bought, 80);
  assert.equal(s.chips(P).hand.pot, 20, 'state carries the open hand');
  fails(() => s.act(P, { action: 'chips', op: 'play', game: 'cards', stake: 5 }), 409, /current hand/);
  fails(() => s.act(P, { action: 'chips', op: 'play', game: 'cards', pick: 'cash' }), 409, /at least once/);
  s.g.rng = () => card(11); // a Jack: higher than 7
  const right = s.act(P, { action: 'chips', op: 'play', game: 'cards', pick: 'higher' });
  assert.equal(right.play.over, false);
  assert.ok(right.play.pot > 20 && right.play.step === 1);
  const pot = right.play.pot;
  const cash = s.act(P, { action: 'chips', op: 'play', game: 'cards', pick: 'cash' });
  assert.equal(cash.play.taken, pot);
  assert.deepEqual([s.chips(P).bought, s.chips(P).won, s.chips(P).hand], [80, pot, null]);
  // a wrong guess loses the stake
  s.g.rng = () => card(7); s.act(P, { action: 'chips', op: 'play', game: 'cards', stake: 10 });
  s.g.rng = () => card(2);
  const wrong = s.act(P, { action: 'chips', op: 'play', game: 'cards', pick: 'higher' });
  assert.equal(wrong.play.lost, true);
  assert.equal(s.chips(P).hand, null);
  assert.equal(s.chips(P).bought, 70);
  // the same rank loses; an Ace cannot go lower
  s.g.rng = () => card(1); s.act(P, { action: 'chips', op: 'play', game: 'cards', stake: 5 });
  fails(() => s.act(P, { action: 'chips', op: 'play', game: 'cards', pick: 'lower' }), 409, /Nothing is lower/);
  s.g.rng = () => card(1, 1);
  assert.equal(s.act(P, { action: 'chips', op: 'play', game: 'cards', pick: 'higher' }).play.lost, true, 'same rank, other suit');
});

test('gambling makes no coin: coin only moves through buy and sell, and the town is never short from a win', async () => {
  const s = await setup();
  const per = s.c.perCoin;
  s.g.gs.add(s.day(), P, 'coin', 200, 'test');
  const total = () => s.coin(P) + s.coin(Q) + s.coin(TOWN);
  const before = total();
  s.act(P, { action: 'chips', op: 'buy', n: 100 * per });
  s.g.rng = () => 0.01;
  for (let i = 0; i < 20; i++) s.act(P, { action: 'chips', op: 'play', game: 'luck', stake: 50 }); // chips multiply, coin does not
  assert.equal(total(), before, 'playing moves no coin');
  assert.ok(s.chips(P).won > 0);
  assert.throws(() => s.act(P, { action: 'chips', op: 'sell', n: s.chips(P).won + s.chips(P).bought + per }), (e: any) => e.status === 409);
  const bought = s.chips(P).bought;
  if (bought >= per) s.act(P, { action: 'chips', op: 'sell', n: Math.floor(bought / per) * per });
  assert.ok(total() <= before, 'the town never pays out more than was put in');
});

test('chips are a game-store state: they survive a state read and are per account', async () => {
  const s = await setup();
  s.g.chips.st.add(P, 30, 7);
  assert.deepEqual([s.g.state(P).chips.bought, s.g.state(P).chips.won], [30, 7]);
  assert.deepEqual([s.g.state(Q).chips.bought, s.g.state(Q).chips.won], [0, 0]);
  const v = s.g.state(P).chips;
  assert.equal(v.perCoin, s.c.perCoin); assert.equal(v.feePct, s.c.sellFeePct);
});

test('chip text comes out in Indonesian', async () => {
  const { toId } = await import('../src/lang.ts');
  assert.equal(toId('Bought 100 chips (−10 coins).'), 'Membeli 100 chip (−10 koin).');
  assert.equal(toId('Exchanged 100 chips for 9 coins (fee 5%).'), 'Menukar 100 chip jadi 9 koin (biaya 5%).');
  assert.match(toId('Only chips you bought can be exchanged (you have 0 bought). Chips you won cannot be exchanged.'), /Chip hasil menang tidak bisa ditukar/);
  assert.equal(toId('You need a casino pass to play this table.'), 'Kamu butuh tiket kasino untuk main di meja ini.');
});
