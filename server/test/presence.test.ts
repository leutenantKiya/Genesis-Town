// The unified presence + chat over HTTP (/api/presence, /api/chat, /api/name): names, per-world visibility, limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as near from 'near-api-js';
import { requestMessage } from '../src/reqauth.ts';
import { createApp } from '../src/app.ts';
import { Game } from '../src/game/game.ts';
import { setup } from './helpers.ts';

function sign(kp: near.KeyPair, account: string, method: string, path: string, body: string) {
  const ts = String(Date.now());
  const sig = kp.sign(new TextEncoder().encode(requestMessage(method, path, ts, body))).signature;
  return { 'x-account-id': account, 'x-gt-key': kp.getPublicKey().toString(), 'x-gt-ts': ts, 'x-gt-sig': Buffer.from(sig).toString('base64') };
}

async function rig() {
  const s = setup();
  const keys = new Map<string, near.KeyPair>();
  for (const a of ['p1.players.test', 'p2.players.test', 'p3.players.test']) {
    const k = near.KeyPair.fromRandom('ed25519');
    keys.set(a, k);
    s.store.addPlayer(a, 'sub' + a, 'ed25519:o');
    s.store.addSessionKey(k.getPublicKey().toString(), a);
  }
  const game = new Game(s.store, s.chain, { merchantParent: 'gt.test', town: 'town.gt.test', worldSeed: 42 });
  await game.init();
  const { server } = createApp({ ...s, game, verify: async () => ({ sub: 'x' }), currentBlockHeight: async () => 0n, clientDir: '.' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const sp = game.map!.layout.spawn;
  const post = async (a: string, path: string, o: unknown) => {
    const body = JSON.stringify(o);
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...sign(keys.get(a)!, a, 'POST', path, body) }, body });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { s, game, sp, post, close: () => { server.closeAllConnections(); server.close(); } };
}
const P1 = 'p1.players.test', P2 = 'p2.players.test', P3 = 'p3.players.test';

test('names: one table, 3-16 characters, repeatable (name#tag is unique), frozen accounts refused', async () => {
  const r = await rig();
  try {
    assert.equal((await r.post(P1, '/api/name', { name: 'Ayu' })).status, 200);
    assert.equal(r.s.store.nameOf(P1), 'Ayu');
    assert.equal((await r.post(P2, '/api/name', { name: 'ayu' })).status, 200, 'names may repeat now; the tag tells them apart');
    assert.equal((await r.post(P2, '/api/name', { name: 'a' })).status, 400);
    assert.equal((await r.post(P2, '/api/name', { name: 'a<b>c' })).status, 400);
    assert.equal((await r.post(P2, '/api/name', { name: 'Budi Santoso' })).status, 200);
    const nm = await r.post(P2, '/api/name', { look: 3 });
    assert.equal(nm.status, 200); assert.equal(nm.json.name, 'Budi Santoso'); assert.equal(nm.json.look, 3); assert.match(nm.json.tag, /^[0-9]{5}$/);
    assert.equal((await r.post(P2, '/api/name', { look: 9 })).status, 400);
    r.game.gs.recordShortfall(1, 0, P3, 'fish', -5, -3);
    assert.equal((await r.post(P3, '/api/name', { name: 'Cici' })).status, 403);
    assert.equal((await r.post(P3, '/api/chat', { world: 'public', text: 'hai' })).status, 403);
  } finally { r.close(); }
});

test('chat needs a name and shows up in presence polls of the same world only', async () => {
  const r = await rig();
  try {
    assert.equal((await r.post(P1, '/api/chat', { world: 'public', text: 'halo' })).status, 409, 'pick a name first');
    await r.post(P1, '/api/name', { name: 'Ayu' });
    await r.post(P2, '/api/name', { name: 'Bude' });
    const at = { world: 'public', x: r.sp.x, y: r.sp.y, dir: 'down', scene: 'out', since: 0 };
    await r.post(P1, '/api/presence', at);
    const poll2 = await r.post(P2, '/api/presence', at);
    assert.equal(poll2.status, 200);
    assert.deepEqual(poll2.json.players.filter((p: any) => !p.npc).map((p: any) => p.nick), ['Ayu']);
    const npcs = poll2.json.players.filter((p: any) => p.npc);
    assert.deepEqual(npcs.map((p: any) => [p.nick, p.tag, p.dir]), [['Sarah', 'NPC', 'down'], ['Ben', 'NPC', 'down'], ['Wendy', 'NPC', 'down'], ['Jack', 'NPC', 'down']]);
    // a private question to a merchant is answered (local line without an AI key) as a private line to the asker only
    assert.equal((await r.post(P2, '/api/chat', { world: 'public', text: '/msg Sarah harga ikan?' })).status, 200);
    await new Promise((res) => setTimeout(res, 50));
    const asked = await r.post(P2, '/api/presence', at);
    assert.ok(asked.json.chat.some((m: any) => m.from === 'Sarah' && m.fromTag === 'NPC' && m.to === 'Bude'), 'Sari answers');
    const other = await r.post(P1, '/api/presence', at);
    assert.ok(!other.json.chat.some((m: any) => m.from === 'Sarah'), 'nobody else sees it');
    assert.equal((await r.post(P1, '/api/chat', { world: 'public', text: 'halo semua' })).status, 200);
    assert.equal((await r.post(P1, '/api/chat', { world: 'public', text: 'too fast' })).status, 429, '1 message / 2 s');
    assert.equal((await r.post(P2, '/api/chat', { world: 'public', text: 'x'.repeat(81) })).status, 400, '80 characters');
    const got = await r.post(P2, '/api/presence', at);
    assert.deepEqual(got.json.chat.filter((m: any) => !m.to).map((m: any) => [m.from, m.text]), [['Ayu', 'halo semua']]);
    assert.equal((await r.post(P1, '/api/presence', { ...at, world: 'bogus' })).status, 400);
    // the server-tracked world is public: asking for a Homeland is refused
    assert.equal((await r.post(P1, '/api/presence', { ...at, world: 'HL-1' })).status, 409);
    assert.equal((await r.post(P1, '/api/chat', { world: 'HL-1', text: 'hai' })).status, 409);
    // a private message is delivered to the receiver only
    await new Promise((res) => setTimeout(res, 2100));
    assert.equal((await r.post(P1, '/api/chat', { world: 'public', text: '/msg Bude rahasia' })).status, 200);
    assert.ok((await r.post(P2, '/api/presence', { ...at, since: got.json.last })).json.chat.some((m: any) => m.text === 'rahasia'));
    await r.post(P3, '/api/name', { name: 'Cici' });
    assert.ok(!(await r.post(P3, '/api/presence', at)).json.chat.some((m: any) => m.text === 'rahasia'));
  } finally { r.close(); }
});

test('presence on the own Homeland spawn moves a player there (reload lands at home, no 409)', async () => {
  const r = await rig();
  try {
    const row = r.game.homelands.ensure(P1);
    const spawn = r.game.homelands.map(row).layout.spawn;
    const body = { world: `HL-${row.id}`, x: spawn.x, y: spawn.y, dir: 'down', scene: 'out', since: 0 };
    const res = await r.post(P1, '/api/presence', body);
    assert.equal(res.status, 200);
    assert.equal(res.json.world, `HL-${row.id}`);
    assert.equal(r.game.positions!.worldOf(P1), `HL-${row.id}`);
    // not on the spawn: still refused
    assert.equal((await r.post(P2, '/api/presence', { ...body, world: `HL-${r.game.homelands.ensure(P2).id}`, x: spawn.x + 1 })).status, 409);
  } finally { r.close(); }
});

test('presence carries the party roster with positions only in the same world', async () => {
  const r = await rig();
  try {
    await r.post(P1, '/api/name', { name: 'Ayu' });
    await r.post(P2, '/api/name', { name: 'Bude' });
    const tag2 = r.s.store.tagOf(P2);
    assert.equal((await r.post(P1, '/api/party/invite', { to: `Bude#${tag2}` })).status, 200);
    assert.equal((await r.post(P2, '/api/party/accept', { from: P1 })).status, 200);
    const at = { world: 'public', x: r.sp.x, y: r.sp.y, dir: 'down', scene: 'out', since: 0 };
    await r.post(P2, '/api/presence', { ...at, x: r.sp.x + 1 });
    const poll = await r.post(P1, '/api/presence', at);
    const bude = poll.json.party.party.members.find((m: any) => m.account === P2);
    assert.equal(bude.online, true);
    assert.equal(bude.world, 'public');
    assert.equal(bude.x, r.sp.x + 1);
    assert.ok(poll.json.players.some((p: any) => p.account === P2 && p.party === true));
    const mine = poll.json.party.party.members.find((m: any) => m.account === P1);
    assert.equal(mine.x, undefined, 'no position for yourself');
    // a mate indoors or who never reported has no position
    await r.post(P2, '/api/presence', { ...at, scene: 'in' });
    const indoor = (await r.post(P1, '/api/presence', at)).json.party.party.members.find((m: any) => m.account === P2);
    assert.equal(indoor.online, true);
    assert.equal(indoor.x, undefined);
  } finally { r.close(); }
});
