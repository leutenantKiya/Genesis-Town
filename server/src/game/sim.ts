// Fast-forward simulator. Runs the REAL game code (World, Market with economy/pricing.ts, town demand, daily
// settlement) on an in-memory database and an in-memory chain (MockChain), with simulated players, and records
// hourly frames for charts. Off-chain by design and labelled so in the UI. Deterministic for a given seed.
import { Store } from '../db.ts';
import { MockChain } from '../chain.ts';
import { Game } from './game.ts';
import { loadEcon, type Econ } from './econ.ts';

export interface SimOptions { days: number; players: number; seed: number; econ?: Econ }
export interface SimFrame {
  hour: number; day: number; hourOfDay: number; season: string;
  prices: Record<string, number>;                 // average mid price per item across merchants that trade it
  merchants: Record<string, { cash: number; open: boolean }>;
  moneySupply: number;                            // all coin held by anyone (settled + today)
}
export interface SimEvent { hour: number; day: number; kind: 'closed' | 'reopened' | 'settled'; merchant?: string; text: string }
export interface SimResult { options: SimOptions; frames: SimFrame[]; events: SimEvent[]; summary: Record<string, unknown> }

function mulberry(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

type Role = 'fisher' | 'miner' | 'woodcutter' | 'farmer' | 'cook';
const ROLES: Role[] = ['fisher', 'miner', 'woodcutter', 'farmer', 'cook', 'miner', 'fisher'];
const TILE: Record<string, string> = { fisher: 'water', miner: 'rock', woodcutter: 'tree' };

export async function runSim(o: SimOptions): Promise<SimResult> {
  const econ = o.econ ?? loadEcon();
  const rnd = mulberry(o.seed);
  const chain = new MockChain();
  const base = Object.fromEntries(Object.entries(econ.items).map(([t, i]) => [t, i.base]));
  const TOWN = 'town.sim', PARENT = 'sim';
  chain.accounts.add(TOWN);
  chain.add(TOWN, 'coin', 5000n);
  for (const [id, d] of Object.entries(econ.merchants)) {
    chain.addMerchant(`${id}.${PARENT}`, d.shop, { coin: d.restore.coin, ...d.restore.items }, { coin: d.startCash, ...d.startStock }, base);
  }
  const store = new Store(':memory:');
  let now = 1_800_000_000_000;
  const game = new Game(store, chain, { merchantParent: PARENT, town: TOWN, now: () => now, rng: rnd, econ, chunkSize: 200 });
  await game.init();

  const players = Array.from({ length: o.players }, (_, i) => ({ id: `bot${i}.players.sim`, role: ROLES[i % ROLES.length], node: 0 }));
  for (const p of players) {
    store.addPlayer(p.id, 'sim|' + p.id, 'ed25519:sim');
    await chain.registerPlayer(p.id);
    game.onNewPlayer(p.id);
  }
  const merchants = game.market.ids();
  const bal = (a: string, t: string) => game.gs.balance(a, t);
  const tryAct = (a: string, body: Record<string, unknown>) => { try { game.act(a, body); return true; } catch { return false; } };

  function bestSell(token: string): string | null {
    let best: string | null = null, bid = 0;
    for (const id of merchants) {
      const d = econ.merchants[id];
      if (!game.market.isOpen(id) || !d.buys.includes(token)) continue;
      const r = game.market.row(id, token);
      if (r.bid > bid) { bid = r.bid; best = id; }
    }
    return best;
  }
  function cheapestBuy(token: string): string | null {
    let best: string | null = null, ask = Infinity;
    for (const id of merchants) {
      const d = econ.merchants[id];
      if (!game.market.isOpen(id) || !d.sells.includes(token) || bal(game.market.account(id), token) < 1) continue;
      const r = game.market.row(id, token);
      if (r.ask < ask) { ask = r.ask; best = id; }
    }
    return best;
  }

  // goods still missing on open restoration boards; producers hold these back instead of selling (community spirit)
  let wanted: Record<string, number> = {};
  async function botHour(p: (typeof players)[number], hourOfDay: number) {
    const a = p.id;
    if (hourOfDay < 6 || hourOfDay > 21) return; // bots sleep at night
    const st = game.world.state(a);
    // eat when tired: own food first, else buy bread
    if (st.energy < 24) {
      if (!tryAct(a, { action: 'eat', token: 'meal' }) && !tryAct(a, { action: 'eat', token: 'bread' })) {
        const m = cheapestBuy('bread');
        if (m && tryAct(a, { action: 'buy', merchant: m, token: 'bread', qty: 1 })) tryAct(a, { action: 'eat', token: 'bread' });
      }
    }
    // a worn-out tool is repaired (wood and a little coin); with nothing to repair it with, the bot buys wood first
    const kind = { miner: 'pickaxe', woodcutter: 'axe', fisher: 'rod', farmer: 'hoe', cook: 'rod' }[p.role];
    if (game.extras.toolsView(a)[kind].uses <= 0 && !tryAct(a, { action: 'repair', tool: kind })) {
      const m = cheapestBuy('wood');
      if (m && tryAct(a, { action: 'buy', merchant: m, token: 'wood', qty: 1 })) tryAct(a, { action: 'repair', tool: kind });
    }
    // work
    if (p.role === 'farmer') {
      for (let i = 0; i < 6; i++) {
        const plot = game.world.plots(a)[i];
        const op = plot.state === 'empty' ? 'till' : plot.state === 'tilled' ? 'plant' : plot.state === 'ready' ? 'harvest' : '';
        if (op) tryAct(a, { action: 'farm', op, plot: i });
      }
    } else if (p.role === 'cook') {
      if (bal(a, 'fish') < 1) { const m = cheapestBuy('fish'); if (m) tryAct(a, { action: 'buy', merchant: m, token: 'fish', qty: 2 }); }
      if (bal(a, 'wood') < 1) { const m = cheapestBuy('wood'); if (m) tryAct(a, { action: 'buy', merchant: m, token: 'wood', qty: 2 }); }
      tryAct(a, { action: 'craft', recipe: 'meal' });
      tryAct(a, { action: 'gather', tile: 'water', x: 500 + players.indexOf(p), y: (p.node++ % 4) });
    } else {
      const tile = TILE[p.role];
      for (let i = 0; i < 2; i++) tryAct(a, { action: 'gather', tile, x: players.indexOf(p) * 3 + (p.node % 3), y: Math.floor(p.node++ / 3) % 50 });
    }
    // sell twice a day; keep a little food
    if (hourOfDay === 11 || hourOfDay === 18) {
      for (const token of ['fish', 'ore', 'wood', 'wheat', 'meal', 'bread']) {
        let have = bal(a, token) - (token === 'bread' || token === 'meal' ? 2 : token === 'wheat' && p.role === 'farmer' ? 2 : 0) - Math.min(wanted[token] ?? 0, 10);
        while (have > 0) {
          const m = bestSell(token);
          const q = Math.min(10, have);
          if (!m || !tryAct(a, { action: 'sell', merchant: m, token, qty: q })) { if (token !== 'meal') tryAct(a, { action: 'ship', token, qty: Math.min(q, 5) }); break; }
          have -= q;
        }
      }
    }
  }

  // Restoration: when a shop is closed, players with settled coin and fitting goods pledge (as the relayer would).
  async function investors(day: number) {
    wanted = {};
    for (const s0 of await chain.listShops()) {
      if (s0.open) continue;
      for (const p of players) {
        if (rnd() < 0.5) continue;
        const s = (await chain.listShops()).find((x) => x.account_id === s0.account_id)!;
        if (s.open) break;
        const lines = s.need.map((n) => {
          const got = Number((s.pledged.find((x) => x.token_id === n.token_id) || { amount: '0' }).amount);
          const have = game.gs.settledBalance(p.id, n.token_id) - (n.token_id === 'coin' ? 40 : 0);
          return { token_id: n.token_id, amount: String(Math.max(0, Math.min(Number(n.amount) - got, have, n.token_id === 'coin' ? 120 : 6))) };
        }).filter((l) => l.amount !== '0');
        if (!lines.length) continue;
        const res = await chain.relay({ delegateAction: { actions: [{ functionCall: { methodName: 'restore_contribute', args: Buffer.from(JSON.stringify({ merchant: s.account_id, contribution: lines })) } }] } }, p.id);
        void res;
        await game.settlement.refresh([p.id, s.account_id]);
        if ((await chain.listShops()).find((x) => x.account_id === s.account_id)?.open) break;
      }
      const after = (await chain.listShops()).find((x) => x.account_id === s0.account_id)!;
      if (!after.open) for (const n of after.need) {
        const got = Number((after.pledged.find((x) => x.token_id === n.token_id) || { amount: '0' }).amount);
        if (n.token_id !== 'coin' && got < Number(n.amount)) wanted[n.token_id] = (wanted[n.token_id] ?? 0) + Number(n.amount) - got;
      }
    }
    void day;
  }

  const frames: SimFrame[] = [];
  const events: SimEvent[] = [];
  let wasClosed = new Set<string>();
  const hours = o.days * econ.time.hoursPerDay;
  const moneySupply = () => {
    const a = (store.db.prepare("SELECT COALESCE(SUM(amount),0) s FROM settled WHERE token = 'coin'").get() as { s: number }).s;
    const b = (store.db.prepare("SELECT COALESCE(SUM(delta),0) s FROM ledger WHERE settled = 0 AND token = 'coin'").get() as { s: number }).s;
    return a + b;
  };
  let settled = game.settlement.settledThrough();
  for (let h = 0; h < hours; h++) {
    now += econ.time.realMsPerGameHour;
    const t = game.clock.time();
    for (const p of players) await botHour(p, t.hour);
    await game.step();
    if (game.settlement.settledThrough() !== settled) {
      settled = game.settlement.settledThrough();
      events.push({ hour: h, day: t.day, kind: 'settled', text: `Settlement day ${settled}` });
      await game.settlement.refresh(players.map((p) => p.id));
      await investors(t.day);
    }
    const closed = game.market.closed;
    for (const acct of closed) if (!wasClosed.has(acct)) events.push({ hour: h, day: t.day, kind: 'closed', merchant: acct.split('.')[0], text: `${econ.merchants[acct.split('.')[0]].name} went bankrupt (CLOSED)` });
    for (const acct of wasClosed) if (!closed.has(acct)) events.push({ hour: h, day: t.day, kind: 'reopened', merchant: acct.split('.')[0], text: `${econ.merchants[acct.split('.')[0]].name} reopened thanks to investors` });
    wasClosed = new Set(closed);
    const prices: Record<string, number> = {};
    for (const token of Object.keys(econ.items).filter((x) => x !== 'coin')) {
      const mids = merchants.filter((id) => game.market.tokens(econ.merchants[id]).includes(token)).map((id) => game.market.row(id, token).mid);
      if (mids.length) prices[token] = Math.round((mids.reduce((x, y) => x + y, 0) / mids.length) * 100) / 100;
    }
    frames.push({
      hour: h, day: t.day, hourOfDay: t.hour, season: t.season, prices,
      merchants: Object.fromEntries(merchants.map((id) => [id, { cash: bal(game.market.account(id), 'coin'), open: game.market.isOpen(id) }])),
      moneySupply: moneySupply(),
    });
  }

  const priceRange: Record<string, { min: number; max: number; base: number }> = {};
  for (const f of frames) for (const [t, v] of Object.entries(f.prices)) {
    const r = priceRange[t] ?? { min: Infinity, max: -Infinity, base: econ.items[t].base };
    r.min = Math.min(r.min, v); r.max = Math.max(r.max, v); priceRange[t] = r;
  }
  const ms = frames.map((f) => f.moneySupply);
  // what a bot holds at the end: coin, and coin plus its goods at base price
  const worth = players.map((p) => Object.keys(econ.items).reduce((sum, t) => sum + bal(p.id, t) * (t === 'coin' ? 1 : econ.items[t].base), 0));
  const coins = players.map((p) => bal(p.id, 'coin'));
  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const k = Math.min(econ.town.maxK, 1 + Math.floor(o.players / econ.town.activePlayerDivisor));
  return {
    options: o, frames, events,
    summary: {
      moneyStart: ms[0], moneyEnd: ms[ms.length - 1], moneyMax: Math.max(...ms), moneyCap: econ.town.moneyCap0 * k,
      priceRange,
      bankruptcies: events.filter((e) => e.kind === 'closed').length,
      recoveries: events.filter((e) => e.kind === 'reopened').length,
      settlements: events.filter((e) => e.kind === 'settled').length,
      avgPlayerCoin: avg(coins), avgPlayerWorth: avg(worth),
      coinPerDayByRole: Object.fromEntries([...new Set(ROLES)].map((r) => [r, avg(coins.filter((_, i) => players[i].role === r)) / o.days])),
    },
  };
}
