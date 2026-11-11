import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dialogue, localLine, clean, facts } from '../src/dialogue.ts';
import type { MerchantView } from '../src/game/market.ts';

const sarah: MerchantView = {
  id: 'sarah', account: 'sarah.gt.test', name: 'Sarah', shop: "Sarah's Fish Stall", open: true, cash: 600, rent: 40,
  items: [
    { token: 'fish', name: 'Fish', stock: 50, target: 20, ask: 9, bid: 6, mid: 7.5, changePct: -10, reason: 'My fish stock is 50, target 20. Price down 10%.' },
    { token: 'wood', name: 'Wood', stock: 10, target: 10, ask: null, bid: 4, mid: 4.4, changePct: 0, reason: 'Stock is right. Price steady.' },
  ],
};
const cfg = { apiKey: 'test-key', baseUrl: 'https://example.invalid/v1', timeoutMs: 1000 };

test('local line answers about the item asked, else the biggest price move, and explains a closed shop', () => {
  assert.match(localLine(sarah, 'how much is wood?'), /^Wood: I buy 4 coins/);
  assert.match(localLine(sarah, 'halo'), /^Fish: I buy 6, I sell 9 coins\. My fish stock is 50/);
  assert.match(localLine({ ...sarah, open: false }, 'halo'), /closed/);
});

test('facts carry the real prices and reasons; clean strips reasoning and markup', () => {
  const f = facts(sarah, 'fair');
  assert.match(f, /Fish: stock 50\/20; buys from players at 6, sells at 9 coins; My fish stock is 50/);
  assert.equal(clean('<think>hmm</think> **Halo!**  Ikan murah.'), 'Halo! Ikan murah.');
});

test('without a key the reply is local and no request is made', async () => {
  let calls = 0;
  const d = new Dialogue({ ...cfg, apiKey: undefined }, (async () => { calls++; return new Response('{}'); }) as typeof fetch);
  const r = await d.reply(sarah, 'fair', 'ikan?');
  assert.equal(r.source, 'local');
  assert.equal(calls, 0);
});

test('with a key: discovers the model, sends facts as the system prompt, returns the line and chat id', async () => {
  const seen: Array<{ url: string; body?: { model: string; messages: Array<{ role: string; content: string }> } }> = [];
  const f = (async (url: string, init?: RequestInit) => {
    seen.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'provider/model-a' }, { id: 'provider/model-b' }] });
    return Response.json({ id: 'chatcmpl-1', choices: [{ message: { content: 'Ikan lagi banyak, aku beli 6 saja.' } }] });
  }) as typeof fetch;
  const d = new Dialogue(cfg, f);
  const r = await d.reply(sarah, 'fair', 'jual ikan dong');
  assert.deepEqual(r, { line: 'Ikan lagi banyak, aku beli 6 saja.', source: 'nearai', model: 'provider/model-a', chatId: 'chatcmpl-1' });
  const chat = seen.find((s) => s.url.endsWith('/chat/completions'))!;
  assert.equal(chat.body!.model, 'provider/model-a');
  assert.match(chat.body!.messages[0].content, /buys from players at 6, sells at 9/);
  assert.equal(chat.body!.messages[1].content, 'jual ikan dong');
});

test('a pinned model skips discovery; provider errors fall back to the local line', async () => {
  const urls: string[] = [];
  const d = new Dialogue({ ...cfg, model: 'pinned/model' }, (async (url: string) => { urls.push(url); return new Response('nope', { status: 500 }); }) as typeof fetch);
  const r = await d.reply(sarah, 'fair', 'wood?');
  assert.equal(r.source, 'local');
  assert.match(r.line, /^Wood/);
  assert.deepEqual(urls, ['https://example.invalid/v1/chat/completions']);
});
