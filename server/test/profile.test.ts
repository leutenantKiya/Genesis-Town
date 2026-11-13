// GET /api/player: the card a name tag click opens (name, look, Town Hall level, online, party).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Social } from '../src/social.ts';
import { playerProfile } from '../src/profile.ts';
import { world, fails, P, Q, R } from './tradeworld.ts';

async function setup() {
  const w = await world();
  let t = 1_800_000_000_000;
  const social = new Social(w.store, () => t);
  social.partyOf = (a) => w.game.party.idOf(a);
  const d = { social, game: w.game, title: () => 'Pedagang baru' };
  return { ...w, social, d, tick: (ms: number) => { t += ms; } };
}

test('the profile carries name, tag, look, Town Hall level, online and party flags', async () => {
  const w = await setup();
  w.store.setLook(Q, 3);
  w.game.gs.setHomelandTh(Q, 4);
  const p = playerProfile(w.d, P, 'Budi');
  assert.equal(p.name, 'Budi');
  assert.equal(p.tag, w.store.tagOf(Q));
  assert.equal(p.look, 3);
  assert.equal(p.th, 4, 'the Town Hall level of their Homeland');
  assert.equal(p.title, 'Pedagang baru');
  assert.equal(p.online, false, 'not seen yet');
  assert.equal(p.unique, true, 'the plain name reaches only this player');
  assert.equal(p.mate, false); assert.equal(p.inParty, false); assert.equal(p.self, false);
  // a Town Hall level that went up shows at once
  w.game.gs.setHomelandTh(Q, 5);
  assert.equal(playerProfile(w.d, P, 'budi').th, 5, 'any case finds the one player');
  assert.equal(playerProfile(w.d, Q, `Budi#${w.store.tagOf(Q)}`).self, true);
});

test('online follows presence (15 s); party and mate follow the party', async () => {
  const w = await setup();
  w.social.report(Q, 'public', { x: 5, y: 5, scene: 'out' });
  assert.equal(playerProfile(w.d, P, 'Budi').online, true);
  w.tick(16_000);
  assert.equal(playerProfile(w.d, P, 'Budi').online, false);
  w.game.party.invite(P, Q); w.game.party.accept(Q, P);
  const p = playerProfile(w.d, P, 'Budi');
  assert.equal(p.mate, true); assert.equal(p.inParty, true);
  assert.equal(playerProfile(w.d, R, 'Budi').mate, false, 'a stranger is not a mate, but the party shows');
  assert.equal(playerProfile(w.d, R, 'Budi').inParty, true);
});

test('unknown name 404, several players with one old name 409 (name#tag works), empty 400', async () => {
  const w = await setup();
  fails(() => playerProfile(w.d, P, 'Nobody'), 404, /No player named Nobody/);
  fails(() => playerProfile(w.d, P, ''), 400, /Whose profile/);
  fails(() => playerProfile(w.d, P, undefined), 400, /Whose profile/);
  // an old duplicate pair
  const db = (w.store as any).db;
  db.prepare('UPDATE names SET name = ?, tag = ? WHERE account = ?').run('Kembar', '11111', Q);
  db.prepare('UPDATE names SET name = ?, tag = ? WHERE account = ?').run('kembar', '22222', R);
  fails(() => playerProfile(w.d, P, 'Kembar'), 409, /Several players are named Kembar\. Use name#tag\./);
  assert.equal(playerProfile(w.d, P, 'kembar#22222').name, 'kembar');
  assert.equal(playerProfile(w.d, P, 'kembar#22222').unique, false, 'an older duplicate: the client must write name#tag');
  assert.equal(playerProfile(w.d, P, 'Kembar#11111').name, 'Kembar');
});
