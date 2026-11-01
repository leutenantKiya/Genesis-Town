import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSim } from '../src/game/sim.ts';

test('1-week simulation (25 players): a merchant goes bankrupt and is restored; money and prices stay bounded', async () => {
  const r = await runSim({ days: 7, players: 25, seed: 42 });
  assert.equal(r.frames.length, 7 * 24);
  const s = r.summary as { moneyMax: number; moneyCap: number; bankruptcies: number; recoveries: number; priceRange: Record<string, { min: number; max: number; base: number }> };
  assert.ok(s.bankruptcies >= 1, 'someone closes');
  assert.ok(s.recoveries >= 1, 'investors reopen a shop');
  assert.ok(s.moneyMax <= s.moneyCap);
  for (const [t, p] of Object.entries(s.priceRange)) assert.ok(p.min >= 0.25 * p.base - 1e-9 && p.max <= 4 * p.base + 1e-9, t);
});

test('simulation is deterministic for a seed', async () => {
  const a = await runSim({ days: 2, players: 8, seed: 7 });
  const b = await runSim({ days: 2, players: 8, seed: 7 });
  assert.deepEqual(a.frames[a.frames.length - 1], b.frames[b.frames.length - 1]);
});
