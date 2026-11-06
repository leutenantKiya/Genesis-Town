// Night monsters in Hutan Utara (M4). Decided by the server, so a client cannot skip or fake a fight.
// - At night (19:00-06:00), gathering in Hutan Utara can run into a monster instead: a wild boar at trees, mine bats
//   at the rocks (more likely there). The player then fights (Lawan) or flees (Lari).
// - Each round costs energy; the monster hits back while it stands. Winning gathers the item plus one bonus.
// - Reaching 0 energy knocks the player out until 06:00: no action works until then. Nothing is lost, on chain or
//   off chain; the cost is time and energy, which makes wood and ore from the forest worth more at night.
// - When the town finishes the Pos Ronda project (on chain), the forest is guarded and no monster appears.
// Tuning lives in economy/config.json -> monsters.
import { HttpError } from '../auth.ts';
import type { Econ } from './econ.ts';
import type { GameStore } from './gamestore.ts';
import type { Clock } from './clock.ts';
import type { World, Rng } from './world.ts';
import type { WorldMap } from './worldmap.ts';

export interface MonsterDef { name: string; hp: number; hit: number; drop: string }
export interface MonsterConfig {
  chunk: string; nightFrom: number; nightTo: number; guardProject: string;
  chance: Record<string, number>; kinds: Record<string, MonsterDef>; byTile: Record<string, string>; roaming: Record<string, number>; reach: number;
  fightEnergy: number; fleeEnergy: number; hitChance: number; wakeEnergy: number;
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
  guarded() { return this.map.unlocked.includes(this.cfg.guardProject); }

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

  /** Called before a gather: maybe a monster blocks it. */
  maybeEncounter(account: string, tile: string, x: number, y: number): Encounter | null {
    if (this.pending.has(account)) return this.pending.get(account)!;
    if (this.guarded() || !this.isNight() || this.map.chunkAt(x, y).id !== this.cfg.chunk) return null;
    const chance = this.cfg.chance[tile] ?? 0;
    if (!(this.rng() < chance)) return null;
    const kind = this.cfg.byTile[tile] ?? Object.keys(this.cfg.kinds)[0];
    const d = this.cfg.kinds[kind];
    const e = { kind, name: d.name, hp: d.hp, maxHp: d.hp, tile, x, y };
    this.pending.set(account, e);
    return e;
  }

  /** Where the roaming monsters stand this game hour (none by day or once Pos Ronda guards the forest). */
  roaming(hour = this.clock.hours()) {
    if (this.guarded() || !this.isNight(this.clock.time().hour)) return [];
    return this.map.monstersAt(hour, this.cfg.roaming);
  }

  /** The player walked into a roaming monster: it attacks. Checked against where it stands this hour (or last). */
  engage(account: string, id: string, pos: { x: number; y: number }): Encounter {
    if (this.pending.has(account)) return this.pending.get(account)!;
    const h = this.clock.hours();
    const m = [...this.roaming(h), ...this.roaming(h - 1)].find((q) => q.id === id && Math.abs(q.x - pos.x) + Math.abs(q.y - pos.y) <= this.cfg.reach);
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
