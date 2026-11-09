// Night monsters. Decided by the server, so a client cannot skip or fake a fight.
// - They live in the wild part of each player's Homeland: open forest chunks (wild boars) and open rock chunks (mine
//   bats); the centre around the Town Hall is safe. Where they roam each game hour comes from the Homeland's seed
//   (client/js/world/homeland.js monstersAt), so browser and server agree. (When the public area is not trade-only,
//   the old village forest Hutan Utara has them too.)
// - At night (19:00-06:00), gathering in the wild can run into a monster instead: a wild boar at trees, bats at the
//   rocks (more likely there). Walking into a roaming one makes it attack. The player fights (Lawan) or flees (Lari).
// - Each round costs energy; the monster hits back while it stands. Winning gathers the item plus one bonus.
// - Reaching 0 energy knocks the player out until 06:00: no action works until then. Nothing is lost, on chain or
//   off chain; the cost is time and energy, which makes wood and ore from the forest worth more at night.
// - In the village (only when it is not trade-only), the finished Pos Ronda project guards the forest. Homelands have
//   no guard post yet: opening a wild chunk brings its resources and its night danger.
// Tuning lives in economy/config.json -> monsters.
import { HttpError } from '../auth.ts';
import type { Econ } from './econ.ts';
import type { GameStore } from './gamestore.ts';
import type { Clock } from './clock.ts';
import type { World, Rng } from './world.ts';
import type { WorldMap, MonsterMap } from './worldmap.ts';

export interface MonsterDef { name: string; hp: number; hit: number; drop: string }
export interface MonsterConfig {
  chunk: string; nightFrom: number; nightTo: number; guardProject: string;
  chance: Record<string, number>; kinds: Record<string, MonsterDef>; byTile: Record<string, string>; roaming: Record<string, number>; reach: number;
  fightEnergy: number; fleeEnergy: number; hitChance: number; wakeEnergy: number;
  /** Homelands: how many roam per kind (the village's `roaming` is for the larger shared forest). */
  homeland?: { roaming: Record<string, number> };
}
export interface Encounter { kind: string; name: string; hp: number; maxHp: number; tile: string | null; x: number; y: number; id?: string }

export class Monsters {
  pending = new Map<string, Encounter>();
  cfg: MonsterConfig;
  econ: Econ; gs: GameStore; clock: Clock; world: World; map: WorldMap; rng: Rng;
  constructor(econ: Econ, gs: GameStore, clock: Clock, world: World, map: WorldMap, rng: Rng) {
    this.econ = econ; this.gs = gs; this.clock = clock; this.world = world; this.map = map; this.rng = rng;
    this.cfg = econ.monsters;
  }

  isNight(hour = this.clock.time().hour) { return hour >= this.cfg.nightFrom || hour < this.cfg.nightTo; }
  /** The village forest is guarded once Pos Ronda is built. Homelands are never guarded (`home` = true). */
  guarded(home = false) { return !home && this.map.unlocked.includes(this.cfg.guardProject); }

  /** Game hour until which the player is knocked out, or null. */
  koUntil(account: string): number | null {
    const v = this.gs.meta('ko.' + account);
    if (!v) return null;
    const until = Number(v);
    if (this.clock.hours() >= until) {
      // woke up at home: rested enough to work again
      this.gs.setMeta('ko.' + account, '');
      const p = this.world.state(account);
      p.energy = Math.max(p.energy, this.cfg.wakeEnergy);
      this.gs.savePlayer(p);
      return null;
    }
    return until;
  }
  checkAwake(account: string) {
    if (this.koUntil(account) !== null) throw new HttpError(409, 'Kamu pingsan di hutan. Warga membawamu pulang; istirahat sampai pukul 06:00.');
  }

  /** Called before a gather: maybe a monster blocks it. `map` is the world the player gathers in; `home` = a Homeland. */
  maybeEncounter(account: string, tile: string, x: number, y: number, map: MonsterMap = this.map, home = false): Encounter | null {
    if (this.pending.has(account)) return this.pending.get(account)!;
    if (this.guarded(home) || !this.isNight() || !map.wild(x, y)) return null;
    const chance = this.cfg.chance[tile] ?? 0;
    if (!(this.rng() < chance)) return null;
    const kind = this.cfg.byTile[tile] ?? Object.keys(this.cfg.kinds)[0];
    const d = this.cfg.kinds[kind];
    const e = { kind, name: d.name, hp: d.hp, maxHp: d.hp, tile, x, y };
    this.pending.set(account, e);
    return e;
  }

  /** Where the roaming monsters of `map` stand in game hour `hour` (none by day, or in a guarded village forest). */
  roaming(map: MonsterMap = this.map, home = false, hour = this.clock.hours()) {
    if (this.guarded(home) || !this.isNight(this.clock.time().hour)) return [];
    return map.monstersAt(hour, home ? (this.cfg.homeland?.roaming ?? this.cfg.roaming) : this.cfg.roaming);
  }

  /** The player walked into a roaming monster: it attacks. Checked against where it stands this hour (or last). */
  engage(account: string, id: string, pos: { x: number; y: number }, map: MonsterMap = this.map, home = false): Encounter {
    if (this.pending.has(account)) return this.pending.get(account)!;
    const h = this.clock.hours();
    const m = [...this.roaming(map, home, h), ...this.roaming(map, home, h - 1)].find((q) => q.id === id && Math.abs(q.x - pos.x) + Math.abs(q.y - pos.y) <= this.cfg.reach);
    if (!m) throw new HttpError(409, 'Tidak ada apa-apa di sini.');
    const d = this.cfg.kinds[m.kind];
    const e = { kind: m.kind, name: d.name, hp: d.hp, maxHp: d.hp, tile: null, x: m.x, y: m.y, id: m.id };
    this.pending.set(account, e);
    return e;
  }

  private knockOut(account: string) {
    const t = this.clock.time();
    const per = this.econ.time.hoursPerDay;
    const toSix = (this.econ.time.settleHour - t.hour + per) % per || per;
    this.gs.setMeta('ko.' + account, String(this.clock.hours() + toSix));
    this.pending.delete(account);
    const p = this.world.state(account);
    p.energy = 0;
    this.gs.savePlayer(p);
  }

  private spend(account: string, n: number): boolean {
    const p = this.world.state(account);
    if (p.energy < n) return false;
    p.energy -= n;
    this.gs.savePlayer(p);
    return true;
  }

  fight(account: string) {
    const e = this.pending.get(account);
    if (!e) throw new HttpError(409, 'Tidak ada yang perlu dilawan.');
    const d = this.cfg.kinds[e.kind];
    if (!this.spend(account, this.cfg.fightEnergy)) { this.knockOut(account); return { toast: `Kamu kehabisan tenaga melawan ${e.name}. Pingsan sampai pagi.`, ko: true }; }
    const hit = this.rng() < this.cfg.hitChance;
    if (hit) e.hp -= 1;
    if (e.hp <= 0) {
      this.pending.delete(account);
      // the way is clear: gather as usual, plus one for the trouble
      let toast = `${e.name} kabur!`;
      const day = this.clock.time().settleDay; // the open ledger day, like every other write
      if (e.tile) {
        try {
          const g = this.world.gather(account, e.tile, e.x, e.y);
          toast += ` ${g.toast}`;
          try {
            this.world.checkGain(account, this.econ.gather.tiles[e.tile], 1);
            this.gs.add(day, account, this.econ.gather.tiles[e.tile], 1, 'monster_bonus', e.kind);
            toast += ' +1 bonus.';
          } catch { toast += ' Bonus hilang: batas harian tercapai.'; }
        } catch (err) {
          toast += ' ' + (err as Error).message;
        }
      } else {
        // a roaming monster leaves something behind
        const drop = d.drop;
        try {
          this.world.checkGain(account, drop, 1);
          this.gs.add(day, account, drop, 1, 'monster_drop', e.kind);
          toast += ` Ia menjatuhkan 1 ${this.econ.items[drop]?.name ?? drop}.`;
        } catch { toast += ' Ia menjatuhkan sesuatu, tapi batas harianmu sudah penuh.'; }
      }
      return { toast, won: true };
    }
    if (!this.spend(account, d.hit)) { this.knockOut(account); return { toast: `${e.name} menjatuhkanmu. Pingsan sampai pagi.`, ko: true }; }
    return { toast: hit ? `Kena! ${e.name} masih melawan (${e.hp}/${e.maxHp}).` : `Meleset! ${e.name} menyerang balik.`, encounter: e };
  }

  flee(account: string) {
    const e = this.pending.get(account);
    if (!e) throw new HttpError(409, 'Tidak ada yang perlu dihindari.');
    this.pending.delete(account);
    if (!this.spend(account, this.cfg.fleeEnergy)) { this.knockOut(account); return { toast: 'Kamu terlalu lelah untuk lari. Pingsan sampai pagi.', ko: true }; }
    return { toast: `Kamu lari dari ${e.name}. Tidak dapat apa-apa kali ini.` };
  }
}
