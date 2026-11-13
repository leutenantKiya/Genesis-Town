import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world as baseWorld, fails, P, Q, R } from './tradeworld.ts';
import { world as coopWorld, standNear } from './coopworld.ts';

const rows = (w: any, ref: string) => w.game.gs.db.prepare('SELECT * FROM ledger WHERE ref = ?').all(ref) as any[];

/** P and Q side by side in the village, P holds fish, Q holds coin. */
async function pair() {
  const w = await baseWorld();
  w.give(P, 'fish', 10); w.give(Q, 'coin', 100);
  w.stand(P, 'consign'); w.stand(Q, 'consign', 1);
  return w;
}
/** Opens, joins, fills both sides (5 fish for 40 coin) and returns the session id. */
function fill(w: any) {
  const t = w.game.trade;
  const s = t.open(P, { to: 'Budi#' + w.store.tagOf(Q) });
  t.join(Q, s.id);
  t.set(P, s.id, { lines: { fish: 5 } });
  t.set(Q, s.id, { lines: { coin: 40 } });
  return s.id as number;
}

test('open, join, both set, both ready, countdown, swap', async () => {
  const w = await pair();
  const t = w.game.trade;
  const pc = w.bal(P, 'coin'), qc = w.bal(Q, 'coin'), pf = w.bal(P, 'fish'), qf = w.bal(Q, 'fish');
  const s = t.open(P, { to: 'Budi#' + w.store.tagOf(Q) });
  assert.equal(s.status, 'invite');
  assert.equal(t.invites(Q).length, 1);
  assert.equal(t.invites(P).length, 0);
  t.join(Q, s.id);
  t.set(P, s.id, { lines: { fish: 5 } });
  let v = t.set(Q, s.id, { lines: { coin: 40 } });
  assert.equal(v.status, 'open');
  assert.equal(v.version, 2);
  assert.deepEqual(t.session(P)!.theirs, { coin: 40 });
  t.ready(P, s.id, { version: 2 });
  v = t.ready(Q, s.id, { version: 2 });
  assert.equal(v.status, 'locked');
  assert.ok(v.swap_at > 0);
  t.finishDue();
  assert.equal(t.session(P)!.status, 'locked', 'countdown not over yet');
  w.adv(w.econ.trade.countdownMs + 1);
  t.finishDue();
  assert.equal(w.bal(P, 'fish'), pf - 5); assert.equal(w.bal(Q, 'fish'), qf + 5);
  assert.equal(w.bal(P, 'coin'), pc + 40); assert.equal(w.bal(Q, 'coin'), qc - 40);
  const r = rows(w, `p2p:s${s.id}`);
  assert.equal(r.length, 4);
  assert.ok(r.every((x) => x.kind === 'trade'));
  assert.equal(t.session(P)!.status, 'done');
  // the live session is gone, so both may trade again
  assert.equal(t.open(Q, { to: P }).status, 'invite');
});

test('any change resets both confirmations and stops the countdown', async () => {
  const w = await pair();
  const t = w.game.trade;
  const id = fill(w);
  t.ready(P, id, { version: 2 });
  assert.equal(t.ready(Q, id, { version: 2 }).status, 'locked');
  const v = t.set(Q, id, { lines: { coin: 41 } });
  assert.equal(v.status, 'open');
  assert.equal(v.my_ok, false); assert.equal(v.their_ok, false);
  assert.equal(v.version, 3);
  fails(() => t.ready(P, id, { version: 2 }), 409, 'The trade changed. Check it again.');
  w.adv(w.econ.trade.countdownMs + 1);
  t.finishDue();
  assert.equal(t.session(P)!.status, 'open');
  assert.equal(rows(w, `p2p:s${id}`).length, 0);
  fails(() => t.ready(P, id, { version: 'x' }), 409, /changed/);
});

test('an empty trade cannot be confirmed', async () => {
  const w = await pair();
  const s = w.game.trade.open(P, { to: Q });
  w.game.trade.join(Q, s.id);
  fails(() => w.game.trade.ready(P, s.id, { version: 0 }), 400, 'Empty trade.');
});

test('one live session per player', async () => {
  const w = await pair();
  const t = w.game.trade;
  w.stand(R, 'consign', 2);
  const s = t.open(P, { to: Q });
  fails(() => t.open(R, { to: Q }), 409, 'Budi is already trading.');
  fails(() => t.open(Q, { to: R }), 409, 'You are already trading.');
  fails(() => t.open(P, { to: P }), 400, /yourself/);
  t.close(Q, s.id); // the invitee declines
  assert.equal(t.session(P)!.status, 'cancelled');
  assert.equal(t.open(R, { to: Q }).status, 'invite');
  fails(() => t.join(P, s.id), 409, 'The trade is already over.');
  fails(() => t.set(R, s.id, { lines: {} }), 404, 'Trade not found.');
});

test('strangers need 3 tiles, party members only the same world, never across worlds', async () => {
  const w = await coopWorld();
  const t = w.game.trade;
  w.give(P, 'fish', 10);
  w.stand(P, 'consign');
  // a stranger far away
  let far = 4;
  for (; far < 30; far++) { try { w.stand(Q, 'consign', far); break; } catch { /* not walkable */ } }
  assert.ok(far < 30);
  fails(() => t.open(P, { to: Q }), 409, /Stand close together/);
  w.stand(Q, 'consign', 1);
  t.close(P, t.open(P, { to: Q }).id);
  // party mates: far apart in the same world is fine
  w.party(P, Q);
  w.stand(Q, 'consign', far);
  assert.equal(t.open(P, { to: Q }).status, 'invite');
  t.close(P, t.session(P)!.id);
  // never across worlds, party or not
  w.enter(Q, P);
  fails(() => t.open(P, { to: Q }), 409, /Stand close together/);
  w.enter(P, P);
  assert.equal(t.open(P, { to: Q }).world, w.home(P).wid);
});

test('works inside a Homeland between owner and guest, and between two guests', async () => {
  const w = await coopWorld();
  const t = w.game.trade;
  w.party(P, Q, R);
  w.give(P, 'fish', 10); w.give(Q, 'wood', 10); w.give(R, 'coin', 50);
  w.enter(P, P); w.enter(Q, P); w.enter(R, P);
  const qf = w.bal(Q, 'fish');
  const s = t.open(P, { to: Q });
  assert.equal(s.world, w.home(P).wid);
  t.join(Q, s.id);
  t.set(P, s.id, { lines: { fish: 3 } }); t.set(Q, s.id, { lines: { wood: 2 } });
  t.ready(P, s.id, { version: 2 }); t.ready(Q, s.id, { version: 2 });
  w.adv(w.econ.trade.countdownMs + 1); t.finishDue();
  assert.equal(t.session(Q)!.status, 'done');
  assert.equal(w.bal(Q, 'fish'), qf + 3);
  assert.equal(rows(w, `p2p:s${s.id}`).length, 4);
  // two guests, far apart in the Homeland
  const m = w.home(P).map;
  w.game.positions!.reset(R);
  w.game.positions!.setWorld(R, w.home(P).wid, standNear(m, m.layout.spawn, 6), Date.now());
  const s2 = t.open(Q, { to: R });
  t.join(R, s2.id);
  t.set(R, s2.id, { lines: { coin: 10 } });
  t.set(Q, s2.id, { lines: { wood: 1 } });
  t.ready(Q, s2.id, { version: 2 }); t.ready(R, s2.id, { version: 2 });
  w.adv(w.econ.trade.countdownMs + 1); t.finishDue();
  assert.equal(t.session(R)!.status, 'done');
});

test('a failed swap reopens with a note and changes nothing', async () => {
  const w = await pair();
  const t = w.game.trade;
  const id = fill(w);
  t.ready(P, id, { version: 2 }); t.ready(Q, id, { version: 2 });
  w.game.gs.add(w.day(), P, 'fish', -(w.bal(P, 'fish') - 2), 'test'); // P spends down to 2 during the countdown
  const snap = () => [P, Q].flatMap((a) => ['fish', 'coin'].map((x) => w.bal(a, x)));
  const before = snap();
  w.adv(w.econ.trade.countdownMs + 1); t.finishDue();
  const v = t.session(P)!;
  assert.equal(v.status, 'open');
  assert.equal(v.note, 'Not enough Fish.');
  assert.equal(v.my_ok, false); assert.equal(v.their_ok, false);
  assert.deepEqual(snap(), before);
  assert.equal(rows(w, `p2p:s${id}`).length, 0);
  assert.equal(w.game.store.history(P, 50, undefined, 'trade').length, 0);
});

test('two finishDue calls swap once', async () => {
  const w = await pair();
  const t = w.game.trade;
  const id = fill(w);
  t.ready(P, id, { version: 2 }); t.ready(Q, id, { version: 2 });
  w.adv(w.econ.trade.countdownMs + 1);
  const pf = w.bal(P, 'fish');
  t.finishDue(); t.finishDue();
  assert.equal(w.bal(P, 'fish'), pf - 5);
  assert.equal(rows(w, `p2p:s${id}`).length, 4);
  assert.equal(w.game.store.history(P, 50, undefined, 'trade').length, 1);
});

test('receiver\'s daily cap is enforced at swap time', async () => {
  const w = await pair();
  const t = w.game.trade;
  const cap = w.econ.caps.dailyGainPerItem;
  w.give(P, 'fish', cap + 5);
  const s = t.open(P, { to: Q });
  t.join(Q, s.id);
  t.set(P, s.id, { lines: { fish: cap + 1 } });
  t.set(Q, s.id, { lines: { coin: 1 } });
  t.ready(P, s.id, { version: 2 }); t.ready(Q, s.id, { version: 2 });
  const before = w.bal(Q, 'fish');
  w.adv(w.econ.trade.countdownMs + 1); t.finishDue();
  assert.match(t.session(Q)!.note!, /Daily limit/);
  assert.equal(w.bal(Q, 'fish'), before);
});

test('frozen account cannot open, join or be swapped', async () => {
  const w = await pair();
  const t = w.game.trade;
  let chunk = 0;
  const freeze = (a: string) => w.game.gs.recordShortfall(w.day(), ++chunk, a, 'coin', 5, 0);
  freeze(R);
  w.stand(R, 'consign', 2);
  fails(() => t.open(R, { to: P }), 403, /frozen/);
  fails(() => t.open(P, { to: R }), 403, /frozen/);
  // frozen while the trade runs: the swap does not happen
  const id = fill(w);
  t.ready(P, id, { version: 2 }); t.ready(Q, id, { version: 2 });
  freeze(Q);
  const pf = w.bal(P, 'fish');
  w.adv(w.econ.trade.countdownMs + 1); t.finishDue();
  assert.equal(w.bal(P, 'fish'), pf);
  assert.equal(t.session(P)!.status, 'open');
  assert.match(t.session(P)!.note!, /frozen/);
  // an invitee who is frozen cannot join
  w.game.gs.unfreeze(Q); w.game.gs.unfreeze(R);
  t.close(P, id);
  const s = t.open(P, { to: Q });
  freeze(Q);
  fails(() => t.join(Q, s.id), 403, /frozen/);
});

test('invite and idle expiry', async () => {
  const w = await pair();
  const t = w.game.trade;
  const s = t.open(P, { to: Q });
  w.adv(w.econ.trade.inviteSecs * 1000 + 1);
  assert.equal(t.invites(Q).length, 0);
  assert.equal(t.session(P)!.status, 'expired');
  fails(() => t.join(Q, s.id), 409, 'The trade is already over.');
  // an idle open session expires; activity keeps it alive
  const s2 = t.open(P, { to: Q });
  t.join(Q, s2.id);
  w.adv((w.econ.trade.sessionIdleSecs - 10) * 1000);
  t.set(P, s2.id, { lines: { fish: 1 } });
  w.adv((w.econ.trade.sessionIdleSecs - 10) * 1000);
  assert.equal(t.session(P)!.status, 'open');
  w.adv(20_000);
  assert.equal(t.session(P)!.status, 'expired');
  // an expired session is no longer live
  assert.equal(t.open(P, { to: Q }).status, 'invite');
});

test('trades move coin but never create it, and the day still settles', async () => {
  const w = await pair();
  const t = w.game.trade;
  const day = w.day();
  const before = w.game.gs.newCoin(day);
  const total = () => w.bal(P, 'coin') + w.bal(Q, 'coin');
  const sum = total();
  const id = fill(w);
  t.ready(P, id, { version: 2 }); t.ready(Q, id, { version: 2 });
  w.adv(w.econ.trade.countdownMs + 1); t.finishDue();
  assert.equal(t.session(P)!.status, 'done');
  assert.equal(w.game.gs.newCoin(day), before);
  assert.equal(total(), sum);
  const settled = w.day();
  await w.game.devSettle();
  assert.equal(w.game.settlement.settledThrough(), settled, 'day settled');
  const n = w.game.gs.db.prepare('SELECT COUNT(*) AS n FROM shortfalls').get() as { n: number };
  assert.equal(n.n, 0);
  const chain = w.game.chain as any;
  for (const a of [P, Q]) for (const tk of ['fish', 'coin']) assert.equal(String(w.bal(a, tk)), String(chain.get(a, tk)), `${a} ${tk}`);
});

test('history kind=trade lists both sides', async () => {
  const w = await pair();
  const t = w.game.trade;
  const id = fill(w);
  t.ready(P, id, { version: 2 }); t.ready(Q, id, { version: 2 });
  w.adv(w.econ.trade.countdownMs + 1); t.finishDue();
  for (const a of [P, Q]) {
    const h = w.game.store.history(a, 50, undefined, 'trade');
    assert.equal(h.length, 1);
    assert.equal((h[0] as any).ref, `p2p:s${id}`);
    assert.match(h[0].summary, /^Trade with /);
  }
  assert.match(w.game.store.history(P, 50, undefined, 'trade')[0].summary, /give 5 Fish, receive 40 Coin/);
  assert.equal(w.game.store.history(P, 50, 'fish', 'trade').length, 1);
  assert.equal(w.game.store.history(P, 50, undefined, 'harvest').length, 0);
});

test('a finished trade tells both sides what moved (the trade animation reads it); other states carry no result', async () => {
  const w = await pair();
  const t = w.game.trade;
  const id = fill(w);
  assert.equal(t.session(P)!.result, undefined, 'nothing moved yet');
  t.ready(P, id, { version: 2 }); t.ready(Q, id, { version: 2 });
  assert.equal(t.session(Q)!.result, undefined, 'locked, countdown running');
  w.adv(w.econ.trade.countdownMs + 1);
  t.finishDue();
  const p = t.session(P)!, q = t.session(Q)!;
  assert.equal(p.status, 'done'); assert.equal(q.status, 'done');
  assert.deepEqual(p.result!.gave, { fish: 5 }); assert.deepEqual(p.result!.got, { coin: 40 });
  assert.deepEqual(q.result!.gave, { coin: 40 }); assert.deepEqual(q.result!.got, { fish: 5 });
  assert.equal(p.result!.at, q.result!.at, 'one moment for both windows');
  assert.ok(p.result!.at >= p.swap_at);
  // a cancelled trade has no result
  const w2 = await pair();
  const s2 = w2.game.trade.open(P, { to: 'Budi#' + w2.store.tagOf(Q) });
  assert.equal(w2.game.trade.close(Q, s2.id).result, undefined);
  assert.equal(w2.game.trade.session(P)!.result, undefined);
});
