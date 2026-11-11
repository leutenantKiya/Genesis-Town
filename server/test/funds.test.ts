import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockChain } from '../src/chain.ts';
import { watchFunds } from '../src/funds.ts';

test('the server warns once when one of its accounts runs low on NEAR for gas, and shows the balances', async () => {
  const chain = new MockChain();
  const near: Record<string, bigint> = { 'settler.t': 2n * 10n ** 23n, 'relayer.t': 3n * 10n ** 24n }; // 0.2 and 3 NEAR
  chain.spendableNear = async (a: string) => near[a] ?? 0n;
  const logs: string[] = [];
  const f = watchFunds(chain, ['settler.t', 'relayer.t'], { lowNear: 0.25, everyMs: 0, log: (m) => logs.push(m), now: () => 42 });
  await f.ready;
  assert.deepEqual(f.status().near, { 'settler.t': '0.2000', 'relayer.t': '3.0000' });
  assert.deepEqual(f.status().low, ['settler.t']);
  assert.equal(f.status().checkedAt, 42);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /settler\.t has only 0\.2000 NEAR/);
  await f.check();
  assert.equal(logs.length, 1, 'no repeat while it stays low');
  near['settler.t'] = 10n ** 24n;
  await f.check();
  assert.deepEqual(f.status().low, []);
  near['settler.t'] = 10n ** 22n;
  await f.check();
  assert.equal(logs.length, 2, 'a new warning when it runs low again');
});
