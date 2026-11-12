import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, standNear, P, Q, R, fails } from './coopworld.ts';

const travelTo = (w: Awaited<ReturnType<typeof world>>, a: string, to: string) => {
  w.adv(60_000);
  return w.game.act(a, { action: 'travel', to, world: 'public', pos: standNear(w.game.map!, w.game.map!.portal(), 2) }) as any;
};

test('a party mate may travel into the owner\'s Homeland and eat there', async () => {
  const w = await world();
  const h = w.home(P);
  w.party(P, Q);
  const r = travelTo(w, Q, h.wid);
  assert.equal(r.world, h.wid);
  w.adv(1000);
  fails(() => w.game.act(Q, { action: 'eat', token: 'bread', world: h.wid, pos: h.map.layout.spawn }), 409, /energy is already full/); // past the world check
  assert.equal(w.game.state(Q).worldId, h.wid);
});

test('a stranger is still refused without a party or an invite', async () => {
  const w = await world();
  const h = w.home(P);
  w.party(P, Q);
  w.adv(60_000);
  fails(() => w.game.act(R, { action: 'travel', to: h.wid, world: 'public', pos: standNear(w.game.map!, w.game.map!.portal(), 2) }), 409, 'You are not invited to this world.');
});

test('party_role none shuts party mates out; an invite still works', async () => {
  const w = await world();
  const h = w.home(P);
  w.party(P, Q);
  w.game.gs.setHomelandPartyRole(P, 'none');
  w.adv(60_000);
  fails(() => w.game.act(Q, { action: 'travel', to: h.wid, world: 'public', pos: standNear(w.game.map!, w.game.map!.portal(), 2) }), 409, 'You are not invited to this world.');
  assert.equal(w.game.homelands.invitedTo(Q).length, 0);
  w.game.homelands.setInvites(P, [Q]);
  assert.equal(travelTo(w, Q, h.wid).world, h.wid);
  assert.equal(w.game.homelands.invitedTo(Q)[0].via, 'invite');
});

test('leaving the party sends a visitor back to public and clears a pending encounter', async () => {
  const w = await world();
  w.party(P, Q);
  const h = w.enter(Q, P);
  assert.equal(w.game.state(Q).worldId, h.wid);
  w.game.monsters!.pending.set(Q, { name: 'Boar' } as any);
  w.game.party.leave(Q);
  assert.equal(w.game.state(Q).worldId, 'public');
  assert.equal(w.game.monsters!.pending.has(Q), false);
});

test('kicking a visitor out of the party sends them home the same way', async () => {
  const w = await world();
  w.party(P, Q);
  const h = w.enter(Q, P);
  assert.equal(w.game.state(Q).worldId, h.wid);
  w.game.party.kick(P, Q);
  assert.equal(w.game.state(Q).worldId, 'public');
});

test('a visitor still cannot gather, farm or build', async () => {
  const w = await world();
  w.party(P, Q);
  const h = w.enter(Q, P);
  const pos = h.map.layout.spawn;
  w.adv(1000);
  fails(() => w.game.act(Q, { action: 'gather', tile: 'tree', x: 1, y: 1, world: h.wid, pos }), 409, /Helper/);
  fails(() => w.game.act(Q, { action: 'farm', op: 'plant', plot: 0, world: h.wid, pos }), 409, /Helper/);
  fails(() => w.game.act(Q, { action: 'build', kind: 'build', target: 'x', world: h.wid, pos }), 409, /Builder/);
  fails(() => w.game.act(Q, { action: 'hire', job: 'builder', world: h.wid, pos }), 409, /isn't your Homeland/);
});

test('invitedTo lists party Homelands with via party and the owner name', async () => {
  const w = await world();
  const h = w.home(P);
  w.party(P, Q);
  const l = w.game.homelands.invitedTo(Q);
  assert.equal(l.length, 1);
  assert.deepEqual([l[0].world, l[0].via, l[0].owner_name], [h.wid, 'party', 'Ani']);
  // listed on the invite list as well: one entry, the invite is not duplicated
  w.game.homelands.setInvites(P, [Q]);
  assert.equal(w.game.homelands.invitedTo(Q).length, 1);
});

test('re-saving the invite list keeps each guest\'s role', async () => {
  const w = await world();
  const h = w.home(P);
  w.game.homelands.setInvites(P, [Q, R]);
  w.game.store.db.exec(`UPDATE homeland_invites SET role = 'helper' WHERE id = ${h.row.id} AND account = '${Q}'`);
  w.game.homelands.setInvites(P, [Q]);
  assert.deepEqual(w.game.gs.homelandInviteRoles(h.row.id).map((r) => ({ ...r })), [{ account: Q, role: 'helper' }]);
});

test('a visitor in the friend\'s world cannot act in their own world by sending the own spawn; only the presence poll lands a reload', async () => {
  const w = await world();
  w.party(P, Q);
  const friend = w.enter(Q, P);           // Q stands in P's Homeland
  const mine = w.home(Q);                  // Q's own Homeland: same spawn, same Town Hall door
  assert.equal(w.game.positions!.worldOf(Q), friend.wid);
  w.adv(1000);
  // an upgrade aimed at "own" Homeland while the server has Q in the friend's: refused, nothing moved, nothing built
  fails(() => w.game.act(Q, { action: 'build', kind: 'th', target: 'th', world: mine.wid, pos: mine.map.layout.spawn }), 409, 'Change worlds through the portal.');
  fails(() => w.game.act(Q, { action: 'eat', token: 'bread', world: mine.wid, pos: mine.map.layout.spawn }), 409, 'Change worlds through the portal.');
  assert.equal(w.game.positions!.worldOf(Q), friend.wid);
  assert.equal(w.game.homelands.ensure(Q).th, 1);
  assert.equal(w.game.homelands.ensure(P).th, 1);
  // the presence poll (page reload) does land the client on its own spawn
  w.game.reportPosition(Q, mine.map.layout.spawn, mine.wid);
  assert.equal(w.game.positions!.worldOf(Q), mine.wid);
  assert.equal(w.game.state(Q).worldId, mine.wid);
});
