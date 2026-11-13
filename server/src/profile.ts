// A player's public profile card (GET /api/player?name=name or name#tag): what the name tag click shows. Read-only, no economy.
import { HttpError } from './auth.ts';
import type { Social } from './social.ts';
import type { Game } from './game/game.ts';

export interface PlayerProfile {
  name: string; tag: string; look: number; worn: Record<string, string>; title: string;
  /** Town Hall level of their Homeland (null: no Homeland yet). */
  th: number | null;
  online: boolean;
  /** The plain name reaches only this player (so /msg name works without #tag). False for older duplicates. */
  unique: boolean;
  /** In the viewer's party. */
  mate: boolean;
  /** In any party. */
  inParty: boolean;
  self: boolean;
}

export const ONLINE_MS = 15_000;

/** `name` is "name#12345", or a plain name when exactly one player uses it (case ignored). 404 unknown, 409 several players share it. */
export function playerProfile(d: { social: Social; game: Game; title: (account: string) => string }, viewer: string, name: unknown): PlayerProfile {
  const q = typeof name === 'string' ? name.trim().slice(0, 40) : '';
  if (!q) throw new HttpError(400, 'Whose profile?');
  const { social, game } = d;
  const t = social.accountOf(q);
  if (!t) {
    if (social.isAmbiguous(q)) throw new HttpError(409, `Several players are named ${q}. Use name#tag.`);
    throw new HttpError(404, `No player named ${q}.`);
  }
  game.homelands.settle(t); // a finished Town Hall upgrade counts at once
  const seen = social.seen.get(t);
  return {
    name: social.nick(t), tag: social.tag(t), look: social.look(t), worn: game.extras.worn(t), title: d.title(t),
    th: game.gs.homelandOf(t)?.th ?? null,
    unique: !social.isAmbiguous(social.nick(t)),
    online: !!seen && social.now() - seen.t <= ONLINE_MS,
    mate: t !== viewer && game.party.same(viewer, t),
    inParty: social.partyOf(t) !== null,
    self: t === viewer,
  };
}
