// Server-authoritative game clock. Real time drives it (1 game hour = realMsPerGameHour); the Dev panel can skip
// ahead (offset), e.g. "Settle sekarang" jumps to the next 06:00. Both values persist in the meta table.
import { gameTime, type GameTime } from '../../../economy/time.ts';
import type { Econ } from './econ.ts';
import type { GameStore } from './gamestore.ts';

export class Clock {
  econ: Econ;
  gs: GameStore;
  now: () => number;
  epochMs: number;

  constructor(econ: Econ, gs: GameStore, now: () => number = Date.now) {
    this.econ = econ;
    this.gs = gs;
    this.now = now;
    const saved = gs.meta('clock.epoch');
    if (saved) this.epochMs = Number(saved);
    else {
      // A new world starts at day 0, 06:00 (right after a settlement point).
      this.epochMs = now() - econ.time.settleHour * econ.time.realMsPerGameHour;
      gs.setMeta('clock.epoch', String(this.epochMs));
    }
  }

  offsetHours(): number {
    return Number(this.gs.meta('clock.offset') ?? 0);
  }

  hours(): number {
    return Math.floor((this.now() - this.epochMs) / this.econ.time.realMsPerGameHour) + this.offsetHours();
  }

  time(): GameTime {
    return gameTime(this.hours(), this.econ.time);
  }

  /** Fraction of the current game hour that has passed (for smooth client clocks). */
  hourFraction(): number {
    const ms = this.econ.time.realMsPerGameHour;
    return ((this.now() - this.epochMs) % ms) / ms;
  }

  skipHours(n: number) {
    this.gs.setMeta('clock.offset', String(this.offsetHours() + Math.max(0, Math.floor(n))));
  }

  /** Jump to the next settlement point (06:00). */
  skipToNextSettlement() {
    const t = this.time();
    const per = this.econ.time.hoursPerDay;
    const toSix = (this.econ.time.settleHour - t.hour + per) % per || per;
    this.skipHours(toSix);
  }
}
