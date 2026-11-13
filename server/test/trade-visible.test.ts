// A live trade is visible to everyone in the same world: the presence answer carries `trading` (the other player's name)
// for both traders while their window is open, and a finished swap leaves a short public chat line (names only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as near from 'near-api-js';
import { requestMessage } from '../src/reqauth.ts';
import { createApp } from '../src/app.ts';
import { Game } from '../src/game/game.ts';
import { setup } from './helpers.ts';

const P1 = 'p1.players.test', P2 = 'p2.players.test', P3 = 'p3.players.test';
function sign(kp: near.KeyPair, account: string, method: string, path: string, body: string) {
  const ts = String(Date.now());
  const sig = kp.sign(new TextEncoder().encode(requestMessage(method, path, ts, body))).signature;
  return { 'x-account-id': account, 'x-gt-key': kp.getPublicKey().toString(), 'x-gt-ts': ts, 'x-gt-sig': Buffer.from(sig).toString('base64') };
}
async function rig() {
  const s = setup();
  const keys = new Map<string, near.KeyPair>();
  for (const a of [P1, P2, P3]) {
    const k = near.KeyPair.fromRandom('ed25519');
    keys.set(a, k);
    s.store.addPlayer(a, 'sub' + a, 'ed25519:o');
    s.store.addSessionKey(k.getPublicKey().toString(), a);
  }
  s.store.setName(P1, 'Ayu'); s.store.setName(P2, 'Bude'); s.store.setName(P3, 'Cici');
  const game = new Game(s.store, s.chain, { merchantParent: 'gt.test', town: 'town.gt.test', worldSeed: 42 });
  await game.init();
  const { server } = createApp({ ...s, game, verify: async () => ({ sub: 'x' }), currentBlockHeight: async () => 0n, clientDir: '.' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const sp = game.map!.layout.spawn;
  const poll = async (a: string, since = 0) => {
    const path = '/api/presence', body = JSON.stringify({ world: 'public', x: sp.x, y: sp.y, dir: 'down', scene: 'out', since });
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...sign(keys.get(a)!, a, 'POST', path, body) }, body });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { game, sp, poll, close: () => { server.closeAllConnections(); server.close(); } };
}

test('both traders carry `trading` for the whole world while the window is open, and it ends with the trade', async () => {
  const r = await rig();
  try {
    for (const a of [P1, P2, P3]) assert.equal((await r.poll(a)).status, 200);
    const t = r.game.trade;
    const view = async (who: string, of: string) => (await r.poll(who)).json.players.find((p: any) => p.account === of);
    const s = t.open(P1, { to: P2 });
    assert.equal((await view(P3, P1)).trading, undefined, 'an invitation nobody joined yet is not a trade');
    t.join(P2, s.id);
    const a = await view(P3, P1), b = await view(P3, P2);
    assert.equal(a.trading, 'Bude'); assert.equal(a.tradingWith, P2);
    assert.equal(b.trading, 'Ayu'); assert.equal(b.tradingWith, P1);
    assert.equal((await r.poll(P1)).json.trading, 'Bude', 'a trader is told too');
    assert.equal((await view(P3, 'p9')), undefined);
    t.close(P1, s.id);
    assert.equal((await view(P3, P1)).trading, undefined);
    assert.equal((await view(P3, P2)).trading, undefined);
    assert.equal((await r.poll(P1)).json.trading, undefined);
  } finally { r.close(); }
});

test('a finished trade leaves one public line with names only, for the world it happened in', async () => {
  const r = await rig();
  try {
    for (const a of [P1, P2, P3]) await r.poll(a);
    r.game.econ.trade.countdownMs = 0;
    const day = r.game.clock.time().settleDay;
    r.game.gs.add(day, P1, 'fish', 5, 'test');
    const t = r.game.trade, s = t.open(P1, { to: P2 });
    t.join(P2, s.id);
    const v = t.set(P1, s.id, { lines: { fish: 3 } });
    t.ready(P1, s.id, { version: v.version }); t.ready(P2, s.id, { version: v.version });
    t.finishDue();
    assert.equal(t.session(P1)!.status, 'done');
    const seen = (await r.poll(P3)).json.chat.filter((m: any) => m.sys === 'trade');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].text, 'Ayu traded with Bude');
    assert.equal(seen[0].from, 'Ayu'); assert.equal(seen[0].with, 'Bude');
    assert.ok(!/fish/i.test(seen[0].text), 'no goods in the line');
    assert.equal((await r.poll(P3, seen[0].id)).json.chat.filter((m: any) => m.sys).length, 0);
    // a cancelled trade says nothing
    const s2 = t.open(P1, { to: P2 }); t.join(P2, s2.id); t.close(P2, s2.id);
    assert.equal((await r.poll(P3, seen[0].id)).json.chat.filter((m: any) => m.sys).length, 0);
  } finally { r.close(); }
});
