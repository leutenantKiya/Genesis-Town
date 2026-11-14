// Sleeping in a bed (act `sleep`): energy comes back at sleep.perMinute for the real time asleep, each tick pays for at
// most sleep.maxGapSecs, never past energyMax, and a tick without lying down first is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, P, fails } from './coopworld.ts';

test('sleep gives energy back at the configured rate, capped per tick and at the maximum', async () => {
  const w = await world();
  const g = w.game, c = g.econ.sleep!, max = g.econ.gather.energyMax;
  const set = (v: number) => { const p = g.world.state(P); p.energy = v; g.gs.savePlayer(p); };
  const energy = () => g.world.state(P).energy;
  const sleep = (op: string) => g.act(P, { action: 'sleep', op, world: 'public', pos: g.positions!.lastOf(P) }) as any;
  w.game.reportPosition(P, g.map!.layout.spawn, 'public');
  fails(() => sleep('tick'), 409, 'Lie down in a bed first.');
  set(10);
  sleep('start');
  w.adv(10_000);
  sleep('tick');
  assert.ok(Math.abs(energy() - (10 + 10 * c.perMinute / 60)) < 0.6, `10 s asleep: +${c.perMinute / 6}`);
  // a long silence (a closed tab) pays only maxGapSecs (measured after the time passes: game hours also regenerate a little)
  set(10);
  w.adv(10 * 60_000);
  const before = energy();
  sleep('tick');
  assert.ok(energy() - before <= c.maxGapSecs * c.perMinute / 60 + 0.6, 'one tick pays at most maxGapSecs');
  set(max - 1);
  w.adv(15_000); sleep('tick');
  assert.equal(energy(), max, 'never past the maximum');
  sleep('stop');
  fails(() => sleep('tick'), 409, 'Lie down in a bed first.');
  assert.throws(() => sleep('nap'), /Unknown sleep action/);
});
