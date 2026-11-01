import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tick, lotUnitPrice, stockFactor, decay, type MarketInputs, type PricingConfig, type Personality } from './pricing.ts';

const cfg = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const C: PricingConfig = cfg.pricing;
const fair: Personality = cfg.personalities.fair;
const generous: Personality = cfg.personalities.generous;

const fish = (o: Partial<MarketInputs> = {}): MarketInputs => ({
  item: 'fish', itemName: 'Ikan', base: 8, stock: 20, target: 20, bought: 0, sold: 0, cash: 600, rent: 40, ...o,
});

test('worked example from docs/economy.md: flooding Sari with fish', () => {
  const m = fish({ stock: 50, bought: 30, sold: 4 });
  let mid = 8;
  const seq: number[] = [];
  for (let i = 0; i < 8; i++) { mid = tick(mid, m, fair, C).mid; seq.push(+mid.toFixed(2)); }
  assert.deepEqual(seq, [7.2, 6.48, 5.83, 5.25, 4.72, 4.25, 3.83, 3.71]);
  const r = tick(8, m, fair, C);
  assert.equal(r.ask, 8); assert.equal(r.bid, 6);
  assert.equal(r.reason.code, 'stock_high');
  assert.match(r.reason.text, /Stok ikan saya 50, targetnya 20\. Harga turun 10% \(dibatasi 10% per jam\)\./);
});

test('price is monotonic (non-increasing) in stock', () => {
  let last = Infinity;
  for (let s = 0; s <= 200; s += 5) {
    const r = tick(8, fish({ stock: s }), fair, C);
    const target = 8 * r.fs * r.fd;
    assert.ok(target <= last + 1e-9, `stock ${s}`);
    last = target;
  }
});

test('each tick moves at most 10% and stays within [0.25, 4] x base', () => {
  const extremes = [fish({ stock: 0, sold: 500 }), fish({ stock: 10_000, bought: 500 }), fish({ cash: 0 })];
  for (const m of extremes) {
    let mid = 8;
    for (let i = 0; i < 500; i++) {
      const r = tick(mid, m, fair, C);
      assert.ok(Math.abs(r.mid - mid) <= mid * 0.1 + 1e-9);
      assert.ok(r.mid >= 2 - 1e-9 && r.mid <= 32 + 1e-9);
      assert.ok(Number.isFinite(r.ask) && r.ask >= 1 && r.bid >= 1);
      mid = r.mid;
    }
  }
});

test('short on cash lowers bids, except for a cash-blind (generous) merchant', () => {
  const rich = tick(8, fish({ cash: 1000 }), fair, C).bid;
  const poor = tick(8, fish({ cash: 20 }), fair, C);
  assert.ok(poor.bid < rich);
  assert.equal(poor.reason.code, 'cash_low');
  assert.equal(tick(8, fish({ cash: 20 }), generous, C).bid, tick(8, fish({ cash: 1000 }), generous, C).bid);
});

test('selling a big lot gets a worse unit price than a single unit', () => {
  const m = fish({ stock: 20 });
  assert.ok(lotUnitPrice('merchant_buys', 10, 8, m, fair, C) <= lotUnitPrice('merchant_buys', 1, 8, m, fair, C));
  assert.ok(lotUnitPrice('merchant_sells', 10, 8, m, fair, C) >= lotUnitPrice('merchant_sells', 1, 8, m, fair, C));
});

test('scarcity and buying pressure raise the price with a matching reason', () => {
  const low = tick(8, fish({ stock: 3 }), fair, C);
  assert.ok(low.mid > 8);
  assert.equal(low.reason.code, 'stock_low');
  const hot = tick(8, fish({ sold: 40, bought: 0 }), fair, C);
  assert.equal(hot.reason.code, 'demand_up');
  assert.match(hot.reason.text, /Harga naik/);
});

test('volumes halve after the configured half-life', () => {
  assert.ok(Math.abs(decay(100, C, C.volumeHalfLifeTicks) - 50) < 1e-9);
  assert.equal(stockFactor(20, 20, fair, C), 1);
});
