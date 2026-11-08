import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dialogue, resolveProvider } from '../src/dialogue.ts';
import type { MerchantView } from '../src/game/market.ts';

const sari: MerchantView = {
  id: 'sari', account: 'sari.gt.test', name: 'Sari', shop: 'Lapak Ikan Sari', open: true, cash: 600, rent: 40,
  items: [{ token: 'fish', name: 'Ikan', stock: 50, target: 20, ask: 9, bid: 6, mid: 7.5, changePct: -10, reason: 'Stok ikan saya 50, targetnya 20.' }],
};
const base = { baseUrl: 'https://example.invalid/v1', timeoutMs: 1000 };
const cfg = { ...base, provider: 'anthropic', anthropicKey: 'sk-test-key' };

test('provider choice: explicit wins, else anthropic key, else nearai key, else local', () => {
  assert.equal(resolveProvider({ ...base }), 'local');
  assert.equal(resolveProvider({ ...base, apiKey: 'n' }), 'nearai');
  assert.equal(resolveProvider({ ...base, apiKey: 'n', anthropicKey: 'a' }), 'anthropic');
  assert.equal(resolveProvider({ ...base, apiKey: 'n', anthropicKey: 'a', provider: 'nearai' }), 'nearai');
  assert.equal(resolveProvider({ ...base, apiKey: 'n', anthropicKey: 'a', provider: 'local' }), 'local');
  assert.equal(resolveProvider({ ...base, provider: 'anthropic' }), 'local', 'explicit provider without its key is local');
});

test('anthropic provider sends model claude-sonnet-5-5 at low effort and returns its text', async () => {
  const seen: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const f = (async (url: string, init?: RequestInit) => {
    seen.push({ url, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    return Response.json({ id: 'msg_1', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Ikan murah, aku beli 6 koin.' }] });
  }) as typeof fetch;
  const d = new Dialogue(cfg, f);
  assert.equal(d.enabled, true);
  const r = await d.reply(sari, 'fair', 'harga ikan?');
  assert.equal(r.source, 'anthropic');
  assert.equal(r.line, 'Ikan murah, aku beli 6 koin.');
  assert.equal(r.model, 'claude-sonnet-5-5');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen[0].headers['x-api-key'], 'sk-test-key');
  assert.equal(seen[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(seen[0].body.model, 'claude-sonnet-5-5');
  assert.deepEqual(seen[0].body.output_config, { effort: 'low' });
  assert.ok(seen[0].body.max_tokens <= 300);
  assert.match(seen[0].body.system, /Ikan: stok 50\/20/);
  assert.deepEqual(seen[0].body.messages, [{ role: 'user', content: 'harga ikan?' }]);
  assert.equal('temperature' in seen[0].body, false);
});

test('DIALOGUE_MODEL overrides the model', async () => {
  let model = '';
  const f = (async (_u: string, init?: RequestInit) => { model = JSON.parse(String(init?.body)).model; return Response.json({ content: [{ type: 'text', text: 'ok' }] }); }) as typeof fetch;
  const r = await new Dialogue({ ...cfg, anthropicModel: 'claude-haiku-5-5' }, f).reply(sari, 'fair', 'hai');
  assert.equal(model, 'claude-haiku-5-5');
  assert.equal(r.source, 'anthropic');
});

test('anthropic error, refusal, empty text or timeout falls back to a local line', async () => {
  const cases: Array<typeof fetch> = [
    (async () => new Response('boom', { status: 500 })) as typeof fetch,
    (async () => Response.json({ stop_reason: 'refusal', content: [{ type: 'text', text: 'no' }] })) as typeof fetch,
    (async () => Response.json({ content: [] })) as typeof fetch,
    (async () => { throw new Error('network down'); }) as typeof fetch,
    ((_u: string, init?: RequestInit) => new Promise((_res, rej) => { init?.signal?.addEventListener('abort', () => rej(new Error('timeout'))); })) as typeof fetch,
  ];
  for (const f of cases) {
    const r = await new Dialogue({ ...cfg, timeoutMs: 50 }, f).reply(sari, 'fair', 'ikan?');
    assert.equal(r.source, 'local');
    assert.match(r.line, /^Ikan:/);
  }
});

test('no key uses local and makes no request', async () => {
  let calls = 0;
  const d = new Dialogue({ ...base, provider: 'anthropic' }, (async () => { calls++; return new Response('{}'); }) as typeof fetch);
  assert.equal(d.enabled, false);
  assert.equal((await d.reply(sari, 'fair', 'ikan?')).source, 'local');
  assert.equal(calls, 0);
});
