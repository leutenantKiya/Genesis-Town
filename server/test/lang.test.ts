import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toId, localizeJson, langOf } from '../src/lang.ts';
import { localLine, rulesFor } from '../src/dialogue.ts';
import type { MerchantView } from '../src/game/market.ts';

test('known sentences, with names inside them, come out in Indonesian', () => {
  assert.equal(toId('Sold 10 Fish to Sarah: +60 coins'), 'Terjual 10 Ikan ke Sari: +60 koin');
  assert.equal(toId('Unknown merchant.'), 'Pedagang tidak dikenal.');
  assert.equal(toId('Fish'), 'Ikan');
  assert.equal(toId('+1 Wood · −4 energy'), '+1 Kayu · −4 energi');
});

test('price reasons are translated sentence by sentence and keep the item name', () => {
  assert.equal(toId('My fish stock is 50, target 20. Price down 10% (capped at 10% per hour).'), 'Stok ikan saya 50, targetnya 20. Harga turun 10% (dibatasi 10% per jam).');
});

test('the more specific sentence wins', () => {
  assert.equal(toId('My fish stock is down to 16, target 20.'), 'Stok ikan saya tinggal 16, targetnya 20.');
});

test('unknown text stays English, chat text and ids are never touched', () => {
  assert.equal(toId('Something nobody translated'), 'Something nobody translated');
  const out = localizeJson({ chat: [{ from: 'Ani', text: 'Unknown merchant.' }], error: 'Unknown merchant.', token: 'Fish', nick: 'Sarah' }) as any;
  assert.equal(out.chat[0].text, 'Unknown merchant.');
  assert.equal(out.error, 'Pedagang tidak dikenal.');
  assert.equal(out.token, 'Fish');
  assert.equal(out.nick, 'Sari');
});

test('the language header only accepts id', () => {
  assert.equal(langOf('id'), 'id');
  assert.equal(langOf('en'), 'en');
  assert.equal(langOf(undefined), 'en');
  assert.equal(langOf('fr'), 'en');
});

const m: MerchantView = {
  id: 'sari', account: 'sari.gt.test', name: 'Sarah', shop: "Sarah's Fish Stall", open: true, cash: 600, rent: 40,
  items: [{ token: 'fish', name: 'Fish', stock: 50, target: 20, ask: 9, bid: 6, mid: 7.5, changePct: -10, reason: 'My fish stock is 50, target 20. Price down 10%.' }],
};

test('merchant dialogue: English by default, Indonesian rules carry the Indonesian names; the local line translates on the way out', () => {
  assert.match(localLine(m, 'fish?'), /^Fish: I buy 6, I sell 9 coins\./);
  assert.match(rulesFor(m, 'en'), /casual English/);
  const id = rulesFor(m, 'id');
  assert.match(id, /Bahasa Indonesia/);
  assert.match(id, /Sarah = Sari/);
  assert.match(id, /Fish = Ikan/);
  assert.equal(toId(localLine(m, 'fish?')), 'Ikan: aku beli 6, aku jual 9 koin. Stok ikan saya 50, targetnya 20. Harga turun 10%.');
});
