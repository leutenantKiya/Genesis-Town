// Player actions that stay off-chain until the daily settlement: gathering, energy, tool wear, crafting, eating,
// farming and the shipping box. Every change is a ledger row; the server is authoritative.
import type { Econ } from './econ.ts';
import type { GameStore, PlayerState, Plot } from './gamestore.ts';
import type { Clock } from './clock.ts';
import { HttpError } from '../auth.ts';

export type Rng = () => number;

export interface ActionResult { toast: string; gained?: Record<string, number> }

export class World {
  econ: Econ;
  gs: GameStore;
  clock: Clock;
  rng: Rng;

  constructor(econ: Econ, gs: GameStore, clock: Clock, rng: Rng = Math.random) {
    this.econ = econ;
    this.gs = gs;
    this.clock = clock;
    this.rng = rng;
  }

  name(token: string): string {
    return this.econ.items[token]?.name ?? token;
  }

  /** Current player state with energy regenerated up to now. */
  state(account: string): PlayerState {
    const hour = this.clock.hours();
    const g = this.econ.gather;
    const p = this.gs.player(account) ?? { account, energy: g.energyMax, energy_hour: hour, tool_uses: 0 };
    if (hour > p.energy_hour) {
      p.energy = Math.min(g.energyMax, p.energy + (hour - p.energy_hour) * g.energyRegenPerHour);
      p.energy_hour = hour;
    }
    return p;
  }

  private spendEnergy(p: PlayerState, cost: number) {
    if (p.energy < cost) throw new HttpError(409, 'Energi habis. Makan Roti atau Ikan Bakar, atau istirahat.');
    p.energy -= cost;
  }

  private need(account: string, token: string, n: number) {
    const have = this.gs.balance(account, token);
    if (have < n) throw new HttpError(409, `${this.name(token)} kurang (punya ${have}, perlu ${n}).`);
  }

  /** Starter kit: coin from the town treasury, items minted at settlement. */
  starter(account: string, town: string) {
    const day = this.clock.time().settleDay;
    for (const [token, n] of Object.entries(this.econ.starter)) {
      if (token === 'coin') {
        this.gs.add(day, town, 'coin', -n, 'starter', account);
      }
      this.gs.add(day, account, token, n, 'starter');
    }
  }

  gather(account: string, tile: string, x: number, y: number): ActionResult {
    const g = this.econ.gather;
    const token = g.tiles[tile];
    if (!token) throw new HttpError(400, 'Tidak ada yang bisa dikumpulkan di sini.');
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 999 || y > 999) throw new HttpError(400, 'bad tile');
    const def = this.econ.items[token];
    if (def.needsTool) this.need(account, 'tool', 1);
    const t = this.clock.time();
    const key = `${tile}:${x},${y}`;
    const node = this.gs.node(key);
    let charges = node && t.totalHours < node.refill_hour ? node.charges : g.charges;
    if (charges <= 0) {
      const wait = (node?.refill_hour ?? 0) - t.totalHours;
      throw new HttpError(409, `Sudah habis. Kembali sekitar ${wait} jam lagi.`);
    }
    const p = this.state(account);
    this.spendEnergy(p, g.energyCost);
    charges -= 1;
    this.gs.saveNode(key, charges, charges === 0 ? t.totalHours + g.respawnGameHours : (node?.refill_hour ?? t.totalHours + g.respawnGameHours));

    const mult = this.econ.seasons[t.season]?.yield[token] ?? 1;
    const amount = mult >= 1 ? 1 + (this.rng() < mult - 1 ? 1 : 0) : (this.rng() < mult ? 1 : 0);
    if (amount > 0) this.gs.add(t.settleDay, account, token, amount, 'gather', key);
    let toast = amount > 0 ? `+${amount} ${def.name}` : `Tidak dapat ${def.name.toLowerCase()} kali ini.`;
    if (def.needsTool) {
      p.tool_uses += 1;
      if (p.tool_uses >= (this.econ.items.tool.durability ?? 20)) {
        this.gs.add(t.settleDay, account, 'tool', -1, 'tool_break');
        p.tool_uses = 0;
        toast += ' · Alatmu patah!';
      }
    }
    this.gs.savePlayer(p);
    return { toast, gained: amount > 0 ? { [token]: amount } : {} };
  }

  craft(account: string, recipeId: string): ActionResult {
    const r = this.econ.recipes[recipeId];
    if (!r) throw new HttpError(400, 'Resep tidak dikenal.');
    for (const [t, n] of Object.entries(r.inputs)) this.need(account, t, n);
    if (r.fee > 0) this.need(account, 'coin', r.fee);
    const p = r.energy ? this.state(account) : null;
    if (p && r.energy) {
      if (p.energy < r.energy) throw new HttpError(409, `Energi kurang (punya ${Math.floor(p.energy)}, perlu ${r.energy}). Makan dulu atau istirahat.`);
      p.energy -= r.energy;
    }
    const day = this.clock.time().settleDay;
    for (const [t, n] of Object.entries(r.inputs)) this.gs.add(day, account, t, -n, 'craft', recipeId);
    this.gs.add(day, account, r.output, 1, 'craft', recipeId);
    if (r.fee > 0) this.gs.add(day, account, 'coin', -r.fee, 'fee', recipeId);
    if (p) this.gs.savePlayer(p);
    const cost = r.energy ? `−${r.energy} energi` : `biaya ${r.fee} koin`;
    return { toast: `+1 ${this.name(r.output)} (${cost})`, gained: { [r.output]: 1 } };
  }

  eat(account: string, token: string): ActionResult {
    const e = this.econ.items[token]?.energy;
    if (!e) throw new HttpError(400, 'Itu tidak bisa dimakan.');
    this.need(account, token, 1);
    const p = this.state(account);
    if (p.energy >= this.econ.gather.energyMax) throw new HttpError(409, 'Energimu sudah penuh.');
    this.gs.add(this.clock.time().settleDay, account, token, -1, 'eat');
    p.energy = Math.min(this.econ.gather.energyMax, p.energy + e);
    this.gs.savePlayer(p);
    return { toast: `Nyam! Energi +${e}.` };
  }

  plots(account: string): Plot[] {
    const have = this.gs.plots(account);
    const out: Plot[] = [];
    for (let i = 0; i < this.econ.farm.plots; i++) {
      out.push(have.find((p) => p.idx === i) ?? { account, idx: i, state: 'empty', planted_day: 0, grown: 0, watered_day: -1 });
    }
    return out;
  }

  /** Rain waters every planted plot once per rainy day (the weather comes from the shared village file). */
  rainWater(account: string, wet: boolean): number {
    if (!wet) return 0;
    const t = this.clock.time(), f = this.econ.farm;
    let n = 0;
    for (const plot of this.plots(account)) {
      if (plot.state !== 'planted' || plot.watered_day === t.day) continue;
      plot.watered_day = t.day;
      if (!f.noGrowthSeasons.includes(t.season)) plot.grown += 1;
      if (plot.grown >= f.growDays) plot.state = 'ready';
      this.gs.savePlot(plot);
      n++;
    }
    return n;
  }

  farm(account: string, op: string, idx: number): ActionResult {
    const f = this.econ.farm;
    if (!Number.isInteger(idx) || idx < 0 || idx >= f.plots) throw new HttpError(400, 'Petak tidak ada.');
    const plot = this.plots(account)[idx];
    const t = this.clock.time();
    const p = this.state(account);
    let toast: string;
    if (op === 'till') {
      if (plot.state !== 'empty') throw new HttpError(409, 'Petak ini sudah dicangkul.');
      this.spendEnergy(p, f.energyCost);
      plot.state = 'tilled';
      toast = 'Tanah dicangkul.';
    } else if (op === 'plant') {
      if (plot.state !== 'tilled') throw new HttpError(409, 'Cangkul dulu petaknya.');
      if (f.noGrowthSeasons.includes(t.season)) throw new HttpError(409, 'Gandum tidak tumbuh di musim dingin.');
      // Seeds can't run out for good: with no Gandum left, the village hands out a few seeds a day (net zero on
      // chain, since the seed goes straight into the ground). Otherwise a town whose bakery is closed can't farm.
      let gift = false;
      const seeds = f.villageSeedsPerDay ?? 0;
      if (this.gs.balance(account, f.seed) < 1 && this.gs.sumKind(t.settleDay, account, f.seed, 'village-seed') < seeds) {
        this.gs.add(t.settleDay, account, f.seed, 1, 'village-seed');
        gift = true;
      }
      if (this.gs.balance(account, f.seed) < 1) throw new HttpError(409, `Kamu tidak punya benih Gandum, dan benih desa hari ini sudah habis (${seeds} per hari). Coba lagi besok, atau beli Gandum.`);
      this.gs.add(t.settleDay, account, f.seed, -1, 'plant');
      Object.assign(plot, { state: 'planted', planted_day: t.day, grown: 0, watered_day: -1 });
      toast = gift ? 'Desa memberimu 1 benih gandum, dan langsung ditanam. Siram setiap hari.' : 'Benih gandum ditanam. Siram setiap hari.';
    } else if (op === 'water') {
      if (plot.state !== 'planted') throw new HttpError(409, 'Tidak ada yang perlu disiram.');
      if (plot.watered_day === t.day) throw new HttpError(409, 'Sudah disiram hari ini.');
      this.spendEnergy(p, f.energyCost);
      plot.watered_day = t.day;
      if (!f.noGrowthSeasons.includes(t.season)) plot.grown += 1;
      if (plot.grown >= f.growDays) plot.state = 'ready';
      toast = plot.state === 'ready' ? 'Gandum siap dipanen!' : `Disiram (${plot.grown}/${f.growDays} hari).`;
    } else if (op === 'harvest') {
      if (plot.state !== 'ready') throw new HttpError(409, 'Belum siap dipanen.');
      const n = f.harvest + (this.econ.seasons[t.season]?.harvestBonus ?? 0);
      this.gs.add(t.settleDay, account, f.seed, n, 'harvest');
      Object.assign(plot, { state: 'tilled', grown: 0, watered_day: -1 });
      toast = `+${n} Gandum`;
    } else {
      throw new HttpError(400, 'Aksi kebun tidak dikenal.');
    }
    this.gs.savePlayer(p);
    this.gs.savePlot(plot);
    return { toast };
  }

  /** Shipping box: items leave now; the town pays (70% of base) at the next settlement. */
  ship(account: string, token: string, qty: number): ActionResult {
    const def = this.econ.items[token];
    if (!def || token === 'coin') throw new HttpError(400, 'Barang tidak dikenal.');
    if (!Number.isInteger(qty) || qty < 1 || qty > 50) throw new HttpError(400, 'Jumlah 1-50.');
    this.need(account, token, qty);
    this.gs.add(this.clock.time().settleDay, account, token, -qty, 'ship', String(qty));
    const pay = Math.floor(def.base * this.econ.town.shippingBoxMult * qty);
    return { toast: `${qty} ${def.name} masuk Kotak Kirim. Dibayar sekitar ${pay} koin pukul 06:00.` };
  }
}
