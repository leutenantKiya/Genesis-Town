import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, fails, P, Q, R } from './tradeworld.ts';
import { Game } from '../src/game/game.ts';
import { MockChain } from '../src/chain.ts';

const S = 'p4.players.test', T = 'p5.players.test';
async function more(w: Awaited<ReturnType<typeof world>>): Promise<void> {
  for (const [a, n] of [[S, 'Dewi'], [T, 'Eka']] as const) { w.store.addPlayer(a, 'sub-' + a, 'ed25519:o'); w.store.setName(a, n); }
}
const tag = (w: Awaited<ReturnType<typeof world>>, a: string) => `${w.store.nameOf(a)}#${w.store.tagOf(a)}`;

test('invite and accept forms a party with the inviter as leader', async () => {
  const w = await world();
  w.game.party.invite(P, tag(w, Q));
  assert.equal(w.game.party.view(Q).invites.length, 1);
  assert.equal(w.game.party.idOf(P), null); // nothing exists until the invite is accepted
  const v = w.game.party.accept(Q, P);
  assert.equal(w.game.party.idOf(P), w.game.party.idOf(Q));
  assert.equal(v.party!.members.length, 2);
  assert.equal(v.party!.leader, P);
  assert.deepEqual(v.party!.members.map((m) => [m.name, m.leader]), [['Ani', true], ['Budi', false]]);
  assert.equal(v.invites.length, 0);
  assert.ok(w.game.party.same(P, Q));
  assert.deepEqual(w.game.party.mates(P), [Q]);
  assert.ok(!w.game.party.same(P, R));
});

test('max 4, one party per account, leader-only invites', async () => {
  const w = await world();
  await more(w);
  w.game.party.invite(P, Q); w.game.party.accept(Q, P);
  // a non-leader member cannot invite
  fails(() => w.game.party.invite(Q, R), 409, /Only the party leader/);
  w.game.party.invite(P, R); w.game.party.accept(R, P);
  // someone who already has a party cannot be invited
  w.game.party.invite(P, S); w.game.party.accept(S, P);
  assert.equal(w.game.party.view(P).party!.members.length, 4);
  fails(() => w.game.party.invite(P, T), 409, /full/);
  fails(() => w.game.party.invite(P, Q), 409, /already in a party/);
  // a 5th accept gives 409: the invite was sent while the party had room
  w.game.party.leave(S);
  w.game.party.invite(P, T);
  w.game.party.invite(P, S);
  w.game.party.accept(S, P);
  fails(() => w.game.party.accept(T, P), 409, /full/);
  assert.equal(w.game.party.idOf(T), null);
});

test('too many open invites are refused', async () => {
  const w = await world();
  await more(w);
  const max = w.econ.party.maxPendingInvites;
  const fake = Array.from({ length: max }, (_, i) => { const a = `x${i}.players.test`; w.store.addPlayer(a, 'sub-' + a, 'ed25519:o'); w.store.setName(a, 'X' + i); return a; });
  for (const a of fake) w.game.party.invite(P, a);
  fails(() => w.game.party.invite(P, Q), 409, /Too many open invites/);
  w.game.party.invite(P, fake[0]); // re-inviting an open one is fine
});

test('invites expire and can be declined', async () => {
  const w = await world();
  w.game.party.invite(P, Q);
  w.adv(121_000);
  fails(() => w.game.party.accept(Q, P), 409, /expired/);
  assert.equal(w.game.party.view(Q).invites.length, 0);
  w.game.party.invite(P, Q);
  w.game.party.decline(Q, P);
  assert.equal(w.game.party.view(Q).invites.length, 0);
  fails(() => w.game.party.accept(Q, P), 404, /not found/);
  fails(() => w.game.party.invite(P, P), 400, /yourself/);
  fails(() => w.game.party.invite(P, 'Nobody#00000'), 404, /not found/);
});

test('leave passes the lead and a party of one dissolves', async () => {
  const w = await world();
  w.game.party.invite(P, Q); w.game.party.accept(Q, P);
  w.game.party.invite(P, R); w.game.party.accept(R, P);
  w.game.party.leave(P);
  const v = w.game.party.view(Q);
  assert.equal(v.party!.leader, Q);
  assert.equal(v.party!.members.length, 2);
  assert.equal(w.game.party.idOf(P), null);
  w.game.party.leave(R);
  assert.equal(w.game.party.view(Q).party, null);
  assert.equal(w.game.party.idOf(Q), null);
  assert.equal(w.game.party.view(P).party, null);
});

test('kick is leader-only', async () => {
  const w = await world();
  w.game.party.invite(P, Q); w.game.party.accept(Q, P);
  w.game.party.invite(P, R); w.game.party.accept(R, P);
  fails(() => w.game.party.kick(Q, R), 403, /leader/);
  fails(() => w.game.party.kick(P, P), 400, /Leave/);
  w.game.party.kick(P, R);
  assert.equal(w.game.party.idOf(R), null);
  assert.ok(w.game.party.same(P, Q));
  fails(() => w.game.party.kick(P, R), 409, /not in your party/);
  w.game.party.kick(P, Q); // a party of one is gone
  assert.equal(w.game.party.view(P).party, null);
  fails(() => w.game.party.kick(P, Q), 409, /not in a party/);
});

test('party survives a new Game on the same Store', async () => {
  const w = await world();
  w.game.party.invite(P, Q); w.game.party.accept(Q, P);
  const id = w.game.party.idOf(P);
  const g2 = new Game(w.store, new MockChain(), { merchantParent: 'gt.test', town: 'town.gt.test', econ: w.econ, worldSeed: 42, now: () => Date.now(), rng: () => 0.99 });
  assert.equal(g2.party.idOf(P), id);
  assert.equal(g2.party.idOf(Q), id);
  assert.equal(g2.party.view(Q).party!.leader, P);
});

test('frozen accounts cannot invite or accept', async () => {
  const w = await world();
  w.game.party.invite(P, Q);
  w.game.gs.recordShortfall(1, 0, Q, 'fish', -5, -3);
  fails(() => w.game.party.accept(Q, P), 403, /frozen/);
  fails(() => w.game.party.invite(Q, P), 403, /frozen/);
  w.game.gs.recordShortfall(1, 0, R, 'fish', -5, -3);
  w.game.party.invite(P, R); // inviting a frozen player is allowed, they just cannot accept
  fails(() => w.game.party.accept(R, P), 403, /frozen/);
});

test('party routes over HTTP, and presence carries the party', async () => {
  const { createApp } = await import('../src/app.ts');
  const near = await import('near-api-js');
  const { requestMessage } = await import('../src/reqauth.ts');
  const { setup } = await import('./helpers.ts');
  const s = setup(), keys = new Map<string, any>();
  for (const a of [P, Q]) { const k = near.KeyPair.fromRandom('ed25519'); keys.set(a, k); s.store.addPlayer(a, 'sub' + a, 'ed25519:o'); s.store.addSessionKey(k.getPublicKey().toString(), a); }
  const game = new Game(s.store, s.chain, { merchantParent: 'gt.test', town: 'town.gt.test', worldSeed: 42 });
  await game.init();
  const { server } = createApp({ ...s, game, verify: async () => ({ sub: 'x' }), currentBlockHeight: async () => 0n, clientDir: '.' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (a: string, method: string, path: string, o?: unknown) => {
    const body = o === undefined ? '' : JSON.stringify(o), ts = String(Date.now());
    const sig = keys.get(a).sign(new TextEncoder().encode(requestMessage(method, path, ts, body))).signature;
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-account-id': a, 'x-gt-key': keys.get(a).getPublicKey().toString(), 'x-gt-ts': ts, 'x-gt-sig': Buffer.from(sig).toString('base64') }, ...(method === 'POST' ? { body } : {}) });
    return { status: res.status, json: (await res.json()) as any };
  };
  try {
    s.store.setName(P, 'Ayu'); s.store.setName(Q, 'Bude');
    const inv = await call(P, 'POST', '/api/party/invite', { to: `Bude#${s.store.tagOf(Q)}` });
    assert.equal(inv.status, 200);
    const sp = game.map!.layout.spawn;
    const pres = await call(Q, 'POST', '/api/presence', { world: 'public', x: sp.x, y: sp.y, dir: 'down', scene: 'out', since: 0 });
    assert.equal(pres.json.party.party, null);
    assert.equal(pres.json.party.invites[0].from, P);
    assert.equal((await call(Q, 'POST', '/api/party/accept', { from: P })).json.party.members.length, 2);
    assert.equal((await call(Q, 'GET', '/api/party')).json.party.leader, P);
    assert.equal((await call(Q, 'POST', '/api/party/kick', { account: P })).status, 403);
    assert.equal((await call(P, 'POST', '/api/party/kick', { account: Q })).json.party, null);
  } finally { server.closeAllConnections(); server.close(); }
});
