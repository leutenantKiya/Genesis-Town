import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSim } from '../src/game/sim.ts';
import { loadEcon } from '../src/game/econ.ts';

test('1-week simulation (25 players): a merchant goes bankrupt and is restored; money and prices stay bounded', async () => {
  const econ = loadEcon(); econ.shops.chargeRent = true; // the rent mechanism (the live config runs the merchants rent free)
  // The scenario below was found with the shops' earlier goods; since 2026-11-14 every merchant also sells what it buys,
  // which keeps Jack afloat. The test is about the bankruptcy and restore mechanism, so it pins those goods.
  Object.assign(econ.merchants.sari, { sells: ['fish', 'meal'] }); Object.assign(econ.merchants.budi, { sells: ['tool'] });
  Object.assign(econ.merchants.wati, { sells: ['bread', 'wheat'] }); Object.assign(econ.merchants.joko, { sells: ['wood', 'bread'] });
  econ.residents.burnWood = 0; // and the townsfolk's daily firewood (2026-11-14), which also keeps Jack's wood selling
  const r = await runSim({ days: 7, players: 25, seed: 1, econ }); // seed 1: Jack closes by day 5 and is restored by day 6. Seeds 42/7/99 close him on day 5-6 too, but the restore needs a settlement after the closing, so it flips with any small economy change (even the starter wheat).
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
