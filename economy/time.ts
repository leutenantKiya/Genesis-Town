// time.ts - game clock shared by server, simulator and client. 1 game hour = realMsPerGameHour (config).
// Game time is counted in whole game hours since `epochMs`; day 0 starts at hour 0. Settlement runs at settleHour.

export interface TimeConfig { realMsPerGameHour: number; hoursPerDay: number; daysPerSeason: number; settleHour: number; seasons: string[] }

export interface GameTime {
  totalHours: number;   // whole game hours since epoch
  day: number;          // game day number (0-based)
  hour: number;         // 0..23
  season: string;       // e.g. "semi"
  seasonIndex: number;  // 0..3
  dayOfSeason: number;  // 1..daysPerSeason
  settleDay: number;    // the day whose ledger the NEXT settlement closes (day before if hour < settleHour)
}

export function gameTime(totalHours: number, t: TimeConfig): GameTime {
  const h = Math.max(0, Math.floor(totalHours));
  const day = Math.floor(h / t.hoursPerDay);
  const seasonIndex = Math.floor(day / t.daysPerSeason) % t.seasons.length;
  const hour = h % t.hoursPerDay;
  return {
    totalHours: h, day, hour, season: t.seasons[seasonIndex], seasonIndex,
    dayOfSeason: (day % t.daysPerSeason) + 1,
    settleDay: hour < t.settleHour ? day - 1 : day,
  };
}

export function hoursAt(nowMs: number, epochMs: number, offsetHours: number, t: TimeConfig): number {
  return Math.floor((nowMs - epochMs) / t.realMsPerGameHour) + offsetHours;
}
