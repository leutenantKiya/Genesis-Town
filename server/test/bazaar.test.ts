import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { Bazaar, sellerTag, titleFor } from '../src/game/bazaar.ts';

const L = (id: number, seller: string, token = 'wood', amount = '3', price = '10') => ({ id, seller, token_id: token, amount, price_each: price, created_ns: id });

test('Lapak sales earn popularity; Pasar Gelap listings hide the seller and earn nothing', () => {
  const b = new Bazaar(new Store(':memory:').db);
  const ana = 'pana.players.test', budi = 'pbudi.players.test';
  assert.equal(b.recordListing([L(1, ana)], ana, { token_id: 'wood', amount: '3', price_each: '10' }, false), 1);
  assert.equal(b.recordListing([L(1, ana), L(2, budi, 'ore', '2', '30')], budi, { token_id: 'ore', amount: '2', price_each: '30' }, true), 2);
  assert.equal(b.recordSale(1, ana, 2), 2, 'named sale: +2');
  assert.equal(b.recordSale(2, budi, 2), 0, 'anonymous sale: nothing');
  const v = b.view([L(1, ana), L(2, budi, 'ore', '2', '30')]) as Array<Record<string, unknown>>;
  assert.equal(v[0].seller, ana);
  assert.equal(v[0].popularity, 2);
  assert.equal(v[1].seller, null, 'seller hidden in the game');
  assert.equal(v[1].sellerTag, sellerTag(budi), 'but the seller can recognise it');
  assert.deepEqual(b.top().map((r) => r.account), [ana]);
  assert.equal(titleFor(0), 'New merchant'); assert.equal(titleFor(12), 'Known'); assert.equal(titleFor(150), 'Market Legend');
  // a second identical listing by the same seller is told apart by its id
  assert.equal(b.recordListing([L(1, ana), L(3, ana)], ana, { token_id: 'wood', amount: '3', price_each: '10' }, true), 3);
  assert.equal(b.isAnonymous(3), true);
});
