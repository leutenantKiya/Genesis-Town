// Player actions that stay off-chain until the daily settlement: gathering, energy, tool wear, crafting, eating,
// farming and the shipping box. Every change is a ledger row; the server is authoritative.
import type { Econ } from './econ.ts';
import type { GameStore, PlayerState, Plot } from './gamestore.ts';
import type { Clock } from './clock.ts';
import { HttpError } from '../auth.ts';

export type Rng = () => number;

export interface ActionResult { toast: string; gained?: Record<string, number>; credit?: { account: string; token: string; n: number } }

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

  /** Takes energy from a player outside their own actions (a helper speeding up someone's build). 409 and no change when short. */
  useEnergy(account: string, cost: number) {
    const p = this.state(account);
    this.spendEnergy(p, cost);
    this.gs.savePlayer(p);
  }

  private spendEnergy(p: PlayerState, cost: number) {
    if (p.energy < cost) throw new HttpError(409, 'Out of energy. Eat Bread or Grilled Fish, or rest.');
    p.energy -= cost;
  }

  private need(account: string, token: string, n: number) {
    const have = this.gs.balance(account, token);
    if (have < n) throw new HttpError(409, `Not enough ${this.name(token)} (have ${have}, need ${n}).`);
  }

  /** Net amount of `token` the account has gained on this ledger day (the contract caps this per day at settlement). */
  dayNet(account: string, token: string, day: number): number {
    return (this.gs.db.prepare('SELECT COALESCE(SUM(delta), 0) AS s FROM ledger WHERE day = ? AND account = ? AND token = ?').get(day, account, token) as { s: number }).s;
  }

  /** Refuses (409) a gain that would push today's net gain of `token` over the daily cap, which would fail the whole
   *  settlement chunk on chain. Only for player accounts: merchants and the town are exempt on chain too. */
  checkGain(account: string, token: string, amount: number) {
    if (amount <= 0) return;
    const caps = this.econ.caps as { dailyGainPerItem: number; dailyCoinGain?: number };
    const cap = token === 'coin' ? (caps.dailyCoinGain ?? 5000) : caps.dailyGainPerItem;
    const day = this.clock.time().settleDay;
    if (this.dayNet(account, token, day) + amount > cap) {
      throw new HttpError(409, `Daily limit for ${this.name(token)} reached (${cap} per day). Continue tomorrow.`);
    }
  }

  /** Starter kit: items minted at settlement; the coin comes from the town treasury only if it can pay it. */
  starter(account: string, town: string) {
    const day = this.clock.time().settleDay;
    for (const [token, n] of Object.entries(this.econ.starter)) {
      if (token === 'coin') {
        const treasury = this.gs.balance(town, 'coin'); // settled + today's pending
        if (treasury < n) {
          console.warn(`[starter] treasury has ${treasury} coin, below the ${n} starter coin: ${account} gets the goods only`);
          continue;
        }
        this.gs.add(day, town, 'coin', -n, 'starter', account);
      }
      this.gs.add(day, account, token, n, 'starter');
    }
  }

  /** `bonus`: extra units per successful gather (Penebang bots in the owner's Homeland). */
  gather(account: string, tile: string, x: number, y: number, nodePrefix = '', bonus = 0, minLeft = 0): ActionResult {
    const g = this.econ.gather;
    const token = g.tiles[tile];
    if (!token) throw new HttpError(400, 'Nothing to gather here.');
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 999 || y > 999) throw new HttpError(400, 'bad tile');
    const def = this.econ.items[token];
    if (def.needsTool) this.need(account, 'tool', 1);
    const t = this.clock.time();
    const key = `${nodePrefix}${tile}:${x},${y}`;
    const node = this.gs.node(key);
    // A node with no row, or whose refill hour has passed, starts a fresh cycle: full charges and a new refill hour.
    const fresh = !node || t.totalHours >= node.refill_hour;
    let charges = fresh ? g.charges : node.charges;
    const refillHour = (fresh) ? t.totalHours + g.respawnGameHours : (node?.refill_hour ?? t.totalHours + g.respawnGameHours);
    if (charges <= 0) {
      const wait = refillHour - t.totalHours;
      throw new HttpError(409, `Depleted. Come back in about ${wait} hours.`);
    }
    if (charges - 1 < minLeft) throw new HttpError(409, 'Leave the last one for the owner.');
    const p = this.state(account);
    this.spendEnergy(p, g.energyCost); // in memory only: nothing is saved if the gain cap refuses below
    const mult = this.econ.seasons[t.season]?.yield[token] ?? 1;
    let amount = mult >= 1 ? 1 + (this.rng() < mult - 1 ? 1 : 0) : (this.rng() < mult ? 1 : 0);
    if (amount > 0) amount += bonus;
    this.checkGain(account, token, amount);
    charges -= 1;
    this.gs.saveNode(key, charges, charges === 0 ? t.totalHours + g.respawnGameHours : refillHour);

    if (amount > 0) this.gs.add(t.settleDay, account, token, amount, 'gather', key);
    let toast = amount > 0 ? `+${amount} ${def.name}` : `You didn't get any ${def.name.toLowerCase()} this time.`;
    if (def.needsTool) {
      p.tool_uses += 1;
      if (p.tool_uses >= (this.econ.items.tool.durability ?? 20)) {
        this.gs.add(t.settleDay, account, 'tool', -1, 'tool_break');
        p.tool_uses = 0;
        toast += ' · Your Tool broke!';
      }
    }
    this.gs.savePlayer(p);
    return { toast, gained: amount > 0 ? { [token]: amount } : {} };
  }

  craft(account: string, recipeId: string): ActionResult {
    const r = this.econ.recipes[recipeId];
    if (!r) throw new HttpError(400, 'Unknown recipe.');
    for (const [t, n] of Object.entries(r.inputs)) this.need(account, t, n);
    if (r.fee > 0) this.need(account, 'coin', r.fee);
    this.checkGain(account, r.output, 1);
    const p = r.energy ? this.state(account) : null;
    if (p && r.energy) {
      if (p.energy < r.energy) throw new HttpError(409, `Not enough energy (have ${Math.floor(p.energy)}, need ${r.energy}). Eat first or rest.`);
      p.energy -= r.energy;
    }
    const day = this.clock.time().settleDay;
    for (const [t, n] of Object.entries(r.inputs)) this.gs.add(day, account, t, -n, 'craft', recipeId);
    this.gs.add(day, account, r.output, 1, 'craft', recipeId);
    if (r.fee > 0) this.gs.add(day, account, 'coin', -r.fee, 'fee', recipeId);
    if (p) this.gs.savePlayer(p);
    const cost = r.energy ? `−${r.energy} energy` : `cost ${r.fee} coins`;
    return { toast: `+1 ${this.name(r.output)} (${cost})`, gained: { [r.output]: 1 } };
  }

  eat(account: string, token: string): ActionResult {
    const e = this.econ.items[token]?.energy;
    if (!e) throw new HttpError(400, 'That can\'t be eaten.');
    this.need(account, token, 1);
    const p = this.state(account);
    if (p.energy >= this.econ.gather.energyMax) throw new HttpError(409, 'Your energy is already full.');
    this.gs.add(this.clock.time().settleDay, account, token, -1, 'eat');
    p.energy = Math.min(this.econ.gather.energyMax, p.energy + e);
    this.gs.savePlayer(p);
    return { toast: `Yum! Energy +${e}.` };
  }

  plots(account: string, count = this.econ.farm.plots): Plot[] {
    const have = this.gs.plots(account);
    const out: Plot[] = [];
    for (let i = 0; i < count; i++) {
      out.push(have.find((p) => p.idx === i) ?? { account, idx: i, state: 'empty', planted_day: 0, grown: 0, watered_day: -1, planter: '' });
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

  /** `field` replaces the village farm with an island's: its own plot rows, plot count, growth days and extra yield. */
  farm(account: string, op: string, idx: number, field?: { plotAccount: string; count: number; growDays: number; yieldBonus: number; owner?: string; guest?: boolean }): ActionResult {
    const f = { ...this.econ.farm, plots: field?.count ?? this.econ.farm.plots, growDays: field?.growDays ?? this.econ.farm.growDays };
    if (!Number.isInteger(idx) || idx < 0 || idx >= f.plots) throw new HttpError(400, 'No such plot.');
    const plot = this.plots(field?.plotAccount ?? account, f.plots)[idx];
    const t = this.clock.time();
    const p = this.state(account);
    let toast: string;
    let credit: ActionResult['credit'];
    if (op === 'till') {
      if (plot.state !== 'empty') throw new HttpError(409, 'This plot is already hoed.');
      this.spendEnergy(p, f.energyCost);
      plot.state = 'tilled';
      toast = 'The soil is hoed.';
    } else if (op === 'plant') {
      if (plot.state !== 'tilled') throw new HttpError(409, 'Hoe the plot first.');
      if (f.noGrowthSeasons.includes(t.season)) throw new HttpError(409, 'Wheat does not grow in winter.');
      if (field?.guest) {
        const mine = this.plots(field.plotAccount, f.plots).filter((x) => x.planter === account && (x.state === 'planted' || x.state === 'ready')).length;
        if (mine >= this.econ.coop.guestPlotsPerHost) throw new HttpError(409, `You already have ${mine} crops growing here.`);
      }
      // Seeds can't run out for good: with no Gandum left, the village hands out a few seeds a day (net zero on
      // chain, since the seed goes straight into the ground). Otherwise a town whose bakery is closed can't farm.
      let gift = false;
      const seeds = f.villageSeedsPerDay ?? 0;
      if (this.gs.balance(account, f.seed) < 1 && this.gs.sumKind(t.settleDay, account, f.seed, 'village-seed') < seeds) {
        this.gs.add(t.settleDay, account, f.seed, 1, 'village-seed');
        gift = true;
      }
      if (this.gs.balance(account, f.seed) < 1) throw new HttpError(409, `You have no Wheat seed, and today's village seeds are used up (${seeds} per day). Try again tomorrow, or buy Wheat.`);
      this.gs.add(t.settleDay, account, f.seed, -1, 'plant');
      Object.assign(plot, { state: 'planted', planted_day: t.day, grown: 0, watered_day: -1, planter: account });
      toast = gift ? 'The village gives you 1 wheat seed, planted right away. Water it every day.' : 'Wheat seed planted. Water it every day.';
    } else if (op === 'water') {
      if (plot.state !== 'planted') throw new HttpError(409, 'Nothing needs watering.');
      if (plot.watered_day === t.day) throw new HttpError(409, 'Already watered today.');
      this.spendEnergy(p, f.energyCost);
      plot.watered_day = t.day;
      if (!f.noGrowthSeasons.includes(t.season)) plot.grown += 1;
      if (plot.grown >= f.growDays) plot.state = 'ready';
      toast = plot.state === 'ready' ? 'The wheat is ready to harvest!' : `Watered (${plot.grown}/${f.growDays} days).`;
    } else if (op === 'harvest') {
      if (plot.state !== 'ready') throw new HttpError(409, 'Not ready to harvest yet.');
      const n = f.harvest + (this.econ.seasons[t.season]?.harvestBonus ?? 0) + (field?.yieldBonus ?? 0);
      const receiver = plot.planter || field?.owner || account;
      this.checkGain(receiver, f.seed, n);
      this.gs.add(t.settleDay, receiver, f.seed, n, 'harvest', receiver === account ? null : `coop:${account}`);
      Object.assign(plot, { state: 'tilled', grown: 0, watered_day: -1, planter: '' });
      if (receiver === account) toast = `+${n} Wheat`;
      else { toast = 'The wheat goes to the player who planted it.'; credit = { account: receiver, token: f.seed, n }; }
    } else {
      throw new HttpError(400, 'Unknown garden action.');
    }
    this.gs.savePlayer(p);
    this.gs.savePlot(plot);
    return credit ? { toast, credit } : { toast };
  }

  /** Shipping box: items leave now; the town pays (70% of base) at the next settlement. */
  ship(account: string, token: string, qty: number): ActionResult {
    const def = this.econ.items[token];
    if (!def || token === 'coin') throw new HttpError(400, 'Unknown item.');
    if (!Number.isInteger(qty) || qty < 1 || qty > 50) throw new HttpError(400, 'Amount 1-50.');
    this.need(account, token, qty);
    this.gs.add(this.clock.time().settleDay, account, token, -qty, 'ship', String(qty));
    const pay = Math.floor(def.base * this.econ.town.shippingBoxMult * qty);
    return { toast: `${qty} ${def.name} went into the Shipping Box. Paid about ${pay} coins at 06:00.` };
  }
}
