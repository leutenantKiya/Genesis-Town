// Shared setup for the co-op tests (Homelands with a party): the three-player world of tradeworld.ts plus helpers to
// look at a player's Homeland, put a player inside it and form a party.
import type { Pos } from '../src/game/worldmap.ts';
import { world as baseWorld, P, Q, R, fails } from './tradeworld.ts';

export { P, Q, R, fails };

export async function world() {
  const w = await baseWorld();
  const { game } = w;
  /** The Homeland of `a`: its row, world id and map. */
  const home = (a: string) => { const row = game.homelands.ensure(a); return { row, wid: `HL-${row.id}`, map: game.homelands.map(row) }; };
  /** Puts `a` inside `owner`'s Homeland at its spawn (as if they travelled there). */
  const enter = (a: string, owner: string) => {
    const h = home(owner);
    game.positions!.setWorld(a, h.wid, h.map.layout.spawn, Date.now());
    game.reportPosition(a, h.map.layout.spawn, h.wid);
    return h;
  };
  /** The first account invites the others, who all accept. */
  const party = (...accounts: string[]) => {
    const [lead, ...rest] = accounts;
    for (const a of rest) { game.party.invite(lead, a); game.party.accept(a, lead); }
  };
  return { ...w, home, enter, party };
}

/** A walkable tile within `d` of `target` on a map. */
export function standNear(m: { walkable(x: number, y: number): boolean }, target: Pos, d = 1): Pos {
  for (let dy = -d; dy <= d; dy++) for (let dx = -d; dx <= d; dx++) {
    if (Math.abs(dx) + Math.abs(dy) > d) continue;
    if (m.walkable(target.x + dx, target.y + dy)) return { x: target.x + dx, y: target.y + dy };
  }
  throw new Error('nowhere to stand');
}
