// Admin "Bot warga" view: the townsfolk's shared wallet (game/residents.ts) under the admin's hand.
//  - GET  /api/admin/bots?days=     the wallet, where its coin came from (treasury handouts, faucet) and went (each
//                                   merchant, each resident), what every resident may buy from, the latest movements;
//  - POST /api/admin/bots           {paused: bool} stops or restarts the town's shopping, {resident, merchants: [ids] |
//                                   null} sets which merchants that resident may buy from (null = all), {maxPriceMult:
//                                   number | null} sets the town's price ceiling (x a good's base value; null = the config's),
//                                   {settings: {target?, treasuryReserve?, trade?: {enabled?, marginPct?, perHour?, holdMax?,
//                                   minWallet?}}} saves the townsfolk's settings in meta (residents.ts settings());
//  - GET  /api/admin/trace?account=&days=   where any account's coin came from and went to, by counterpart: the other
//                                   side of each ledger row (see `other` below), so a coin can be followed hop by hop.
// Only the game's books (the ledger) are read: on-chain moves (Pasar listings, gifts, shares) are not in it.
import { HttpError } from './auth.ts';
import type { Game } from './game/game.ts';
import type { Social } from './social.ts';

const MAX_DAYS = 60, RECENT = 40, TOP = 40, SCAN = 20_000, MULT_MIN = 1, MULT_MAX = 5;
/** What the admin may set, and the allowed range of each number. */
const LIMITS = { target: [0, 100_000], treasuryReserve: [0, 10_000_000], marginPct: [-90, 500], perHour: [0, 20], holdMax: [0, 50], minWallet: [0, 100_000], fillPct: [10, 300], craftMarginPct: [0, 500], meals: [0, 5], dailyMax: [0, 100], minPricePct: [0, 500], keepMax: [0, 100] } as const;
/** A trade row's ref: `<merchant>:<token>:<qty>@<unit>#<resident>` (market.buy / market.sell with a tag); crafting tags
 *  `#<resident>-c` (its inputs bought and the crafted good sold to a shelf, residents.craft). */
const TRADE_REF = /^([^:]+):([^:]+):(\d+)@(\d+)(?:#([a-z]\d+)(-[ceg])?)?$/; // -c crafting, -e a meal bought, -g the catch to a shelf
type Flow = { account: string | null; name: string; kind: string; amount: number; count: number };

export class AdminBots {
  private d: { game: Game; social: Social };
  constructor(d: { game: Game; social: Social }) { this.d = d; }

  private get gs() { return this.d.game.gs; }
  private get res() { return this.d.game.residents; }

  /** First game day inside the window (`days` back from today; 0 or missing = from day 0). */
  private since(days: unknown): number {
    const n = Math.floor(Number(days));
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.max(0, this.d.game.clock.time().settleDay - Math.min(n, MAX_DAYS) + 1);
  }

  /** A readable name for any account the ledger mentions. */
  name(account: string | null): string {
    if (!account) return '?';
    const { market, town } = this.d.game;
    if (account === town) return 'Town treasury';
    if (account === this.res.wallet) return 'Townsfolk wallet';
    for (const id of market.ids()) if (market.account(id) === account) return `${market.def(id).name} · ${market.def(id).shop}`;
    const r = this.res.walkers.find((w) => this.res.account(w.id) === account);
    if (r) return r.name;
    const nick = this.d.social.nick(account), tag = this.d.social.tag(account);
    return nick ? nick + (tag ? '#' + tag : '') : account;
  }

  status(days: unknown) {
    const { gs, res } = this, { market } = this.d.game, from = this.since(days), w = res.wallet, ctl = res.controls();
    const rows = gs.db.prepare("SELECT seq, kind, delta, ref, day, created_at FROM ledger WHERE account = ? AND token = 'coin' AND day >= ? ORDER BY seq DESC LIMIT ?")
      .all(w, from, SCAN) as Array<{ seq: number; kind: string; delta: number; ref: string | null; day: number; created_at: number }>;
    const inflow = { treasury: 0, faucet: 0, other: 0 }, byMerchant: Record<string, { coin: number; units: number }> = {};
    const per: Record<string, { spent: number; units: number; byMerchant: Record<string, number>; last: { merchant: string; token: string; coin: number; at: number } | null }> = {};
    for (const x of res.walkers) per[x.id] = { spent: 0, units: 0, byMerchant: {}, last: null };
    // buying to sell again: kind `trade` (a negative coin row is a buy, a positive one a sale)
    const trade = { bought: 0, boughtUnits: 0, sold: 0, soldUnits: 0 }, perTrade: Record<string, { bought: number; sold: number; units: number; crafted: number }> = {};
    for (const x of res.walkers) perTrade[x.id] = { bought: 0, sold: 0, units: 0, crafted: 0 };
    const craft = { inputs: 0, fees: 0, sold: 0, soldUnits: 0, byGood: {} as Record<string, number> }, meals = { coin: 0, bought: 0 };
    const gathered = { sold: 0, soldUnits: 0, soldBy: {} as Record<string, number>, toolsSpent: 0, toolsBought: 0 };
    for (const r of rows) {
      const tc = r.kind === 'trade' ? TRADE_REF.exec(r.ref ?? '') : null;
      if (tc && tc[6] === '-e') { meals.coin -= r.delta; meals.bought += Number(tc[3]); continue; } // food bought to eat
      if (tc && tc[6] === '-g') { gathered.sold += r.delta; gathered.soldUnits += Number(tc[3]); gathered.soldBy[tc[2]] = (gathered.soldBy[tc[2]] ?? 0) + Number(tc[3]); continue; } // the catch to a shelf
      if (tc && tc[6]) {
        // crafting: inputs bought (negative) and the crafted good sold to a shelf (positive)
        const units = Number(tc[3]);
        if (r.delta < 0) craft.inputs -= r.delta;
        else { craft.sold += r.delta; craft.soldUnits += units; craft.byGood[tc[2]] = (craft.byGood[tc[2]] ?? 0) + units; const pc = perTrade[tc[5]]; if (pc) pc.crafted += units; }
        continue;
      }
      if (r.kind === 'fee' && r.delta < 0) { craft.fees -= r.delta; continue; } // the wallet pays fees only for crafting
      if (r.kind === 'tool_shop' && r.delta < 0) { gathered.toolsSpent -= r.delta; gathered.toolsBought += 1; continue; } // a new tool at Ben's
      if (r.kind === 'trade') {
        const t = TRADE_REF.exec(r.ref ?? ''), units = t ? Number(t[3]) : 1, pt = t && t[5] ? perTrade[t[5]] : undefined;
        if (r.delta < 0) { trade.bought -= r.delta; trade.boughtUnits += units; if (pt) pt.bought -= r.delta; }
        else { trade.sold += r.delta; trade.soldUnits += units; if (pt) pt.sold += r.delta; }
        if (pt) pt.units += units;
        continue;
      }
      if (r.delta > 0) { if (r.kind === 'handout') inflow.treasury += r.delta; else if (r.kind === 'handout_mint') inflow.faucet += r.delta; else inflow.other += r.delta; continue; }
      if (r.kind !== 'resident_buy' || !r.ref) continue;
      const [rid, mid, token] = r.ref.split(':'), coin = -r.delta;
      const m = byMerchant[mid] ?? (byMerchant[mid] = { coin: 0, units: 0 }); m.coin += coin; m.units += 1;
      const p = per[rid]; if (!p) continue;
      p.spent += coin; p.units += 1; p.byMerchant[mid] = (p.byMerchant[mid] ?? 0) + coin;
      if (!p.last) p.last = { merchant: mid, token, coin, at: r.created_at }; // rows come newest first
    }
    const label = (r: { kind: string; ref: string | null }) => {
      if (r.kind === 'resident_buy' && r.ref) { const [rid, mid, token] = r.ref.split(':'); return { who: res.walkers.find((x) => x.id === rid)?.name ?? rid, to: market.ids().includes(mid) ? market.def(mid).name : mid, token }; }
      if (r.kind === 'trade') { const t = TRADE_REF.exec(r.ref ?? ''); if (t) return { who: res.walkers.find((x) => x.id === t[5])?.name ?? t[5] ?? null, to: market.ids().includes(t[1]) ? market.def(t[1]).name : t[1], token: t[2], craft: t[6] === '-c', meal: t[6] === '-e', gather: t[6] === '-g' }; }
      if (r.kind === 'tool_shop' && r.ref) { const [k, rid] = r.ref.replace(/^buy:/, '').split('#'); const ts = this.d.game.econ.toolShop; return { who: res.walkers.find((x) => x.id === rid)?.name ?? rid ?? null, to: ts && market.ids().includes(ts.merchant) ? market.def(ts.merchant).name : null, token: this.d.game.econ.tools[k]?.name ?? k, tool: true }; }
      if (r.kind === 'handout') return { who: null, to: 'Town treasury', token: null };
      if (r.kind === 'handout_mint') return { who: null, to: 'Faucet (new coin)', token: null };
      return { who: null, to: r.ref, token: null };
    };
    return {
      wallet: { account: w, coin: gs.balance(w, 'coin'), chain: gs.settledBalance(w, 'coin'), ready: res.ready,
        // what an allowance can still take from the treasury (above its reserve; residents.handout)
        treasuryFree: Math.max(0, Math.min(gs.settledBalance(this.d.game.town, 'coin'), gs.balance(this.d.game.town, 'coin')) - res.settings().treasuryReserve) },
      enabled: res.cfg.enabled, paused: ctl.paused, from, scanned: rows.length, truncated: rows.length >= SCAN,
      inflow, spent: Object.values(byMerchant).reduce((s, m) => s + m.coin, 0),
      merchants: market.ids().map((id) => ({ id, name: market.def(id).name, shop: market.def(id).shop, account: market.account(id), open: market.isOpen(id), coin: byMerchant[id]?.coin ?? 0, units: byMerchant[id]?.units ?? 0 })),
      residents: res.walkers.map((x) => ({ id: x.id, name: x.name, look: x.look, account: res.account(x.id), allow: ctl.allow[x.id] ?? null, ...per[x.id], trade: perTrade[x.id], tools: res.tools()[x.id] ?? {} })),
      toolDefs: Object.fromEntries(Object.entries(this.d.game.econ.tools ?? {}).map(([k, t]) => [k, { name: t.name, durability: t.durability, price: this.d.game.econ.toolShop?.price?.[k] ?? null }])),
      settings: res.settings(), limits: LIMITS, trade: { ...trade, profit: trade.sold - trade.bought, holding: this.holding() },
      craft: { ...craft, profit: craft.sold - craft.inputs - craft.fees, shelves: this.shelves() },
      meals: this.mealsView(from, meals),
      gather: { ...gathered, caught: Object.fromEntries((gs.db.prepare("SELECT token, SUM(delta) AS n FROM ledger WHERE account = ? AND kind = 'resident_gather' AND day >= ? GROUP BY token").all(w, from) as Array<{ token: string; n: number }>).map((x) => [x.token, x.n])) },
      why: this.why(),
      recent: rows.slice(0, RECENT).map((r) => ({ seq: r.seq, day: r.day, at: r.created_at, kind: r.kind, coin: r.delta, ...label(r) })),
      price: this.price(),
      inventory: this.inventory(),
    };
  }

  /** The goods the wallet holds to sell again: how many, the average cost, the best price a merchant pays now, and the
   *  price it sells at under the current margin. */
  holding() {
    const { market, econ, gs } = this.d.game, m = 1 + this.res.settings().trade.marginPct / 100;
    return Object.entries(this.res.stock()).filter(([, h]) => h.qty > 0).map(([token, h]) => {
      const bids = market.ids().filter((id) => market.isOpen(id) && market.def(id).buys.includes(token)).map((id) => ({ id, unit: market.quote(id, token, 'sell', 1).unit }));
      const best = bids.sort((a, b) => b.unit - a.unit)[0] ?? null, avg = h.cost / h.qty;
      return { token, name: econ.items[token]?.name ?? token, qty: h.qty, inWallet: gs.balance(this.res.wallet, token), avgCost: Math.round(avg * 100) / 100, sellAt: Math.ceil(avg * m), bestBid: best ? best.unit : null, bestBidder: best ? market.def(best.id).name : null };
    });
  }

  /** The townsfolk's shared bag (one wallet for all five): every token it holds in the game books and on chain (as of
   *  the last settlement); of the goods, how many are held to sell again (and what they cost) and how many are spare
   *  (ingredients or crafted goods waiting for a shelf). */
  inventory() {
    const { econ, gs } = this.d.game, w = this.res.wallet, stock = this.res.stock();
    return Object.keys(econ.items).map((token) => {
      const books = gs.balance(w, token), chain = gs.settledBalance(w, token), h = stock[token], held = token === 'coin' ? 0 : Math.min(books, h?.qty ?? 0);
      return { token, name: econ.items[token].name, books, chain, held, avgCost: h && h.qty > 0 ? Math.round((h.cost / h.qty) * 100) / 100 : null, spare: token === 'coin' ? 0 : Math.max(0, books - held) };
    }).filter((r) => r.books !== 0 || r.chain !== 0 || r.token === 'coin');
  }

  /** The meals rule: foods a day, how many each resident has had today against how many are due by now, and what they
   *  ate in the window (by food) and spent buying food. */
  mealsView(from: number, bought: { coin: number; bought: number }) {
    const { gs, clock } = this.d.game, t = clock.time(), set = this.res.settings(), log = this.res.meals(t.settleDay), due = this.res.mealsDue(t.hour, set.meals);
    const eaten = gs.db.prepare("SELECT token, COUNT(*) AS n FROM ledger WHERE account = ? AND kind = 'resident_eat' AND day >= ? GROUP BY token").all(this.res.wallet, from) as Array<{ token: string; n: number }>;
    return { perDay: set.meals, due, today: Object.fromEntries(this.res.walkers.map((w) => [w.id, log.ate[w.id] ?? 0])), eaten: Object.fromEntries(eaten.map((e) => [e.token, e.n])), ...bought };
  }

  /** Why the townsfolk buy or sell something right now, or not: the same rules residents.trade() / craft() follow, read
   *  without doing anything. Each line has a `code` (ok or the first rule that stops it) and the numbers behind it. */
  why() {
    const { market, econ, gs, town } = this.d.game, res = this.res, set = res.settings(), c = res.controls(), stock = res.stock();
    const w = res.wallet, coin = gs.balance(w, 'coin');
    const free = Math.max(0, Math.min(gs.settledBalance(town, 'coin'), gs.balance(town, 'coin')) - set.treasuryReserve);
    // can the wallet pay `amount` and keep its floor, after an allowance from the treasury if needed?
    const funded = (amount: number) => Math.max(coin, Math.min(set.target, coin + free)) - amount >= set.trade.minWallet;
    const ids = market.ids().filter((id) => market.isOpen(id) && res.walkers.some((x) => !c.allow[x.id] || c.allow[x.id].includes(id)));
    const name = (id: string) => market.def(id).name;
    const general: string[] = [];
    if (!res.ready) general.push('not_ready');
    if (c.paused) general.push('paused');
    const tm = 1 + set.trade.marginPct / 100, cm = 1 + set.craft.marginPct / 100;
    const bestBid = (token: string) => ids.filter((id) => market.def(id).buys.includes(token)).map((id) => ({ id, unit: market.quote(id, token, 'sell', 1).unit, room: market.buyRoom(id, token), cash: gs.balance(market.account(id), 'coin') }));
    // buying to sell again: every good some merchant sells and some merchant buys
    const goods = Object.keys(econ.items).filter((t) => t !== 'coin' && market.ids().some((id) => market.def(id).sells.includes(t)) && market.ids().some((id) => market.def(id).buys.includes(t)));
    const buy = goods.map((token) => {
      const out: Record<string, unknown> = { token, name: econ.items[token].name };
      const sellers = ids.filter((id) => market.def(id).sells.includes(token));
      const stocked = sellers.filter((id) => gs.balance(market.account(id), token) >= 1);
      const bids = bestBid(token), ok = bids.filter((b) => b.room >= 1 && b.cash >= b.unit).sort((a, b) => b.unit - a.unit);
      if (!set.trade.enabled) return { ...out, code: 'off' };
      if (!sellers.length) return { ...out, code: 'no_seller' };
      if (market.trend.withdrawn(token)) return { ...out, code: 'withdrawn' };
      if (!stocked.length) return { ...out, code: 'out_of_stock', from: sellers.map(name).join(', ') };
      const ask = stocked.map((id) => ({ id, unit: market.quote(id, token, 'buy', 1).unit })).sort((a, b) => a.unit - b.unit)[0];
      Object.assign(out, { ask: ask.unit, from: name(ask.id) });
      if (!bids.length) return { ...out, code: 'no_buyer' };
      if (!ok.length) return { ...out, code: bids.every((b) => b.room < 1) ? 'buyer_full' : 'buyer_broke', to: bids.map((b) => name(b.id)).join(', ') };
      Object.assign(out, { bid: ok[0].unit, to: name(ok[0].id), need: Math.ceil(ask.unit * tm) });
      if (ok[0].unit < ask.unit * tm) return { ...out, code: 'margin' };
      if ((stock[token]?.qty ?? 0) >= set.trade.holdMax) return { ...out, code: 'hold_max', held: stock[token]?.qty ?? 0 };
      if (!funded(ask.unit)) return { ...out, code: 'no_money' };
      return { ...out, code: 'ok' };
    });
    // selling what is held
    const sell = Object.entries(stock).filter(([, h]) => h.qty > 0).map(([token, h]) => {
      const avg = h.cost / h.qty, out: Record<string, unknown> = { token, name: econ.items[token]?.name ?? token, held: h.qty, cost: Math.round(avg * 100) / 100, need: Math.ceil(avg * tm) };
      if (!set.trade.enabled) return { ...out, code: 'off' };
      const bids = bestBid(token), ok = bids.filter((b) => b.room >= 1 && b.cash >= b.unit).sort((a, b) => b.unit - a.unit);
      if (!bids.length) return { ...out, code: 'no_buyer' };
      if (!ok.length) return { ...out, code: bids.every((b) => b.room < 1) ? 'buyer_full' : 'buyer_broke', to: bids.map((b) => name(b.id)).join(', ') };
      Object.assign(out, { bid: ok[0].unit, to: name(ok[0].id) });
      return { ...out, code: ok[0].unit < avg * tm ? 'margin' : 'ok' };
    });
    // crafting: every recipe
    const held = (tk: string) => Math.max(0, gs.balance(w, tk) - (stock[tk]?.qty ?? 0));
    const craft = Object.entries(econ.recipes).map(([, r]) => {
      const outTok = r.output, out: Record<string, unknown> = { token: outTok, name: econ.items[outTok].name };
      if (!set.craft.enabled) return { ...out, code: 'off' };
      // an ingredient nobody sells and the bag lacks stops it whatever the shelves say
      const gathers = (tk: string) => set.gather.enabled && set.gather.goods.includes(tk);
      for (const [tk, n] of Object.entries(r.inputs)) if (held(tk) < n && !ids.some((id) => market.def(id).sells.includes(tk))) return { ...out, code: gathers(tk) ? 'await_gather' : 'no_ingredient', input: econ.items[tk].name };
      const shops = ids.filter((id) => market.def(id).sells.includes(outTok)).map((id) => {
        const target = market.def(id).target[outTok] ?? 10, upTo = Math.floor((target * set.craft.fillPct) / 100);
        return { id, stock: gs.balance(market.account(id), outTok), upTo, ask: market.quote(id, outTok, 'buy', 1).unit, cash: gs.balance(market.account(id), 'coin') };
      });
      if (!shops.length) return { ...out, code: 'no_shop' };
      const open = shops.filter((s) => s.upTo - s.stock >= 1).sort((a, b) => b.ask - a.ask);
      if (!open.length) return { ...out, code: 'shelves_full', shelves: shops.map((s) => `${name(s.id)} ${s.stock}/${s.upTo}`).join(', ') };
      const shop = open[0];
      Object.assign(out, { ask: shop.ask, to: name(shop.id) });
      let cost = r.fee ?? 0, coinNeed = r.fee ?? 0;
      for (const [tk, n] of Object.entries(r.inputs)) {
        const own = Math.min(n, held(tk)), need = n - own;
        if (need < 1) { cost += own * econ.items[tk].base; continue; }
        const sellers = ids.filter((id) => market.def(id).sells.includes(tk));
        if (!sellers.length) return { ...out, code: gathers(tk) ? 'await_gather' : 'no_ingredient', input: econ.items[tk].name };
        const offer = sellers.filter((id) => !market.trend.withdrawn(tk) && gs.balance(market.account(id), tk) >= need).map((id) => market.quote(id, tk, 'buy', need).unit).sort((a, b) => a - b)[0];
        if (offer == null) return { ...out, code: gathers(tk) ? 'await_gather' : 'ingredient_out', input: econ.items[tk].name };
        cost += own * econ.items[tk].base + offer * need; coinNeed += offer * need;
      }
      Object.assign(out, { cost: Math.round(cost), need: Math.ceil(cost * cm) });
      if (cost * cm >= shop.ask) return { ...out, code: 'too_costly' };
      if (shop.cash < Math.ceil(cost)) return { ...out, code: 'shop_broke' };
      if (!funded(coinNeed)) return { ...out, code: 'no_money' };
      return { ...out, code: 'ok' };
    });
    // gathering: every raw good
    const g = set.gather, day = this.d.game.clock.time().settleDay;
    const gather = Object.keys(econ.items).filter((k) => econ.items[k].kind === 'raw').map((good) => {
      const base = econ.items[good].base, out: Record<string, unknown> = { token: good, name: econ.items[good].name, today: res.gatheredOn(day, good), spare: held(good) };
      if (!g.enabled) return { ...out, code: 'off' };
      if (!g.goods.includes(good)) return { ...out, code: 'not_picked' };
      const seller = ids.filter((id) => market.def(id).sells.includes(good) && gs.balance(market.account(id), good) >= 1).map((id) => ({ id, unit: market.quote(id, good, 'buy', 1).unit })).sort((a, b) => a.unit - b.unit)[0];
      Object.assign(out, { ask: seller ? seller.unit : null, need: Math.ceil((base * g.minPricePct) / 100), from: seller ? name(seller.id) : null });
      if (seller && seller.unit < (base * g.minPricePct) / 100) return { ...out, code: 'cheap' };
      if ((out.today as number) >= g.dailyMax) return { ...out, code: 'day_max', max: g.dailyMax };
      if ((out.spare as number) >= g.keepMax) return { ...out, code: 'bag_full', max: g.keepMax };
      // the tool it takes: some resident's own still has a use, or a new one can be bought at Ben's
      const tool = res.toolFor(good);
      if (tool) {
        const tl = res.tools(), def = econ.tools[tool], ts = econ.toolShop, price = ts?.price?.[tool] ?? 0;
        const uses = res.walkers.reduce((n, x) => n + Math.max(0, tl[x.id]?.[tool] ?? 0), 0);
        Object.assign(out, { tool: def.name, uses, price, owners: res.walkers.filter((x) => (tl[x.id]?.[tool] ?? 0) >= 1).length });
        const canBuy = !!ts && market.isOpen(ts.merchant) && Math.max(coin, Math.min(set.target, coin + free)) >= price;
        if (uses < 1 && !canBuy) return { ...out, code: 'no_tool', from: ts ? name(ts.merchant) : null };
      }
      return { ...out, code: 'ok' };
    });
    return { general, wallet: coin, treasuryFree: free, minWallet: set.trade.minWallet, buy, sell, craft, gather };
  }

  /** For each recipe: the merchants that sell the good, their stock against the fill line, and their ask and bid now. */
  shelves() {
    const { market, econ, gs } = this.d.game, fill = this.res.settings().craft.fillPct;
    return Object.values(econ.recipes).map((r) => ({
      token: r.output, name: econ.items[r.output].name, inputs: r.inputs,
      shops: market.ids().filter((id) => market.def(id).sells.includes(r.output)).map((id) => {
        const target = market.def(id).target[r.output] ?? 10;
        return { id, name: market.def(id).name, stock: gs.balance(market.account(id), r.output), target, upTo: Math.floor((target * fill) / 100), ask: market.row(id, r.output).ask, bid: market.quote(id, r.output, 'sell', 1).unit };
      }),
    }));
  }

  /** The town's price ceiling and, for each good the town needs, every merchant's ask against it: does the town buy now? */
  price() {
    const { market, econ, gs } = this.d.game, mult = market.priceMult();
    return {
      mult, default: econ.town.maxPriceMult, min: MULT_MIN, max: MULT_MAX,
      goods: Object.keys(econ.town.dailyUnits).map((token) => {
        const base = econ.items[token].base, ceiling = Math.floor(mult * base), withdrawn = market.trend.withdrawn(token);
        const offers = market.ids().filter((id) => market.def(id).sells.includes(token)).map((id) => {
          const ask = market.row(id, token).ask, stock = gs.balance(market.account(id), token), open = market.isOpen(id);
          const why = !open ? 'closed' : withdrawn ? 'withdrawn' : stock < 1 ? 'empty' : ask > mult * base ? 'expensive' : !this.res.canBuyFrom(id) ? 'blocked' : null;
          return { id, name: market.def(id).name, ask, stock, why };
        });
        return { token, name: econ.items[token].name, base, ceiling, buys: offers.some((o) => !o.why), offers };
      }),
    };
  }

  /** Admin controls: pause the shopping, or set one resident's merchants (null = all). */
  control(body: Record<string, unknown>) {
    const { res } = this, { market } = this.d.game, ctl = res.controls();
    if ('maxPriceMult' in body) {
      const v = body.maxPriceMult;
      if (v === null) this.gs.setMeta('town.maxPriceMult', '');
      else {
        const n = Number(v);
        if (typeof v !== 'number' || !Number.isFinite(n) || n < MULT_MIN || n > MULT_MAX) throw new HttpError(400, `maxPriceMult must be between ${MULT_MIN} and ${MULT_MAX}.`);
        this.gs.setMeta('town.maxPriceMult', String(Math.round(n * 100) / 100));
      }
      return this.status(1);
    }
    if (body.settings && typeof body.settings === 'object') {
      const s = res.settings(), b = body.settings as Record<string, unknown>, t = (b.trade && typeof b.trade === 'object' ? b.trade : {}) as Record<string, unknown>;
      const num = (v: unknown, key: keyof typeof LIMITS, cur: number) => {
        if (v === undefined) return cur;
        const [lo, hi] = LIMITS[key];
        if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new HttpError(400, `${key} must be a number from ${lo} to ${hi}.`);
        return key === 'marginPct' || key === 'craftMarginPct' ? Math.round(v * 10) / 10 : Math.round(v);
      };
      const cr = (b.craft && typeof b.craft === 'object' ? b.craft : {}) as Record<string, unknown>;
      const ga = (b.gather && typeof b.gather === 'object' ? b.gather : {}) as Record<string, unknown>;
      if ([t, cr, ga].some((x) => x.enabled !== undefined && typeof x.enabled !== 'boolean')) throw new HttpError(400, 'enabled must be true or false.');
      const raw = Object.keys(this.d.game.econ.items).filter((k) => this.d.game.econ.items[k].kind === 'raw');
      if (ga.goods !== undefined && (!Array.isArray(ga.goods) || ga.goods.some((g) => !raw.includes(String(g))))) throw new HttpError(400, `goods must be a list of: ${raw.join(', ')}.`);
      res.setSettings({
        target: num(b.target, 'target', s.target), treasuryReserve: num(b.treasuryReserve, 'treasuryReserve', s.treasuryReserve), meals: num(b.meals, 'meals', s.meals),
        trade: {
          enabled: typeof t.enabled === 'boolean' ? t.enabled : s.trade.enabled, marginPct: num(t.marginPct, 'marginPct', s.trade.marginPct),
          perHour: num(t.perHour, 'perHour', s.trade.perHour), holdMax: num(t.holdMax, 'holdMax', s.trade.holdMax), minWallet: num(t.minWallet, 'minWallet', s.trade.minWallet),
        },
        craft: {
          enabled: typeof cr.enabled === 'boolean' ? cr.enabled : s.craft.enabled, marginPct: num(cr.marginPct, 'craftMarginPct', s.craft.marginPct),
          perHour: num(cr.perHour, 'perHour', s.craft.perHour), fillPct: num(cr.fillPct, 'fillPct', s.craft.fillPct),
        },
        gather: {
          enabled: typeof ga.enabled === 'boolean' ? ga.enabled : s.gather.enabled,
          goods: Array.isArray(ga.goods) ? [...new Set(ga.goods.map(String))] : s.gather.goods,
          perHour: num(ga.perHour, 'perHour', s.gather.perHour), dailyMax: num(ga.dailyMax, 'dailyMax', s.gather.dailyMax),
          minPricePct: num(ga.minPricePct, 'minPricePct', s.gather.minPricePct), fillPct: num(ga.fillPct, 'fillPct', s.gather.fillPct), keepMax: num(ga.keepMax, 'keepMax', s.gather.keepMax),
        },
      });
      return this.status(1);
    }
    if (typeof body.paused === 'boolean') ctl.paused = body.paused;
    else if (typeof body.resident === 'string') {
      const id = body.resident;
      if (!res.walkers.some((x) => x.id === id)) throw new HttpError(404, 'No such resident.');
      if (body.merchants === null) delete ctl.allow[id];
      else if (Array.isArray(body.merchants)) {
        const ids = market.ids(), pick = [...new Set(body.merchants.map(String))];
        if (pick.some((m) => !ids.includes(m))) throw new HttpError(400, 'Unknown merchant.');
        if (pick.length === ids.length) delete ctl.allow[id]; else ctl.allow[id] = pick;
      } else throw new HttpError(400, 'merchants must be a list of merchant ids or null');
    } else throw new HttpError(400, 'Send {paused}, {resident, merchants}, {maxPriceMult} or {settings}.');
    res.setControls(ctl);
    return this.status(1);
  }

  /** Where one account's coin came from and went to inside the window, grouped by counterpart and kind. */
  trace(account: unknown, days: unknown) {
    const acct = typeof account === 'string' ? account.trim().slice(0, 100) : '';
    if (!acct) throw new HttpError(400, 'account required');
    const { gs, res } = this, { market, town } = this.d.game, from = this.since(days);
    // The other side of a coin row: rows of one move are written together (same kind, same millisecond, opposite sign,
    // usually the same ref), so the nearest such row of another account is the counterpart. Kinds whose two sides differ
    // are read from the ref instead (below).
    const joined = gs.db.prepare(`SELECT m.seq, m.kind, m.delta, m.ref, p.seq AS pseq, p.account AS other, p.ref AS pref
      FROM (SELECT * FROM ledger WHERE account = ? AND token = 'coin' AND day >= ? ORDER BY seq DESC LIMIT ?) m
      LEFT JOIN ledger p ON p.seq BETWEEN m.seq - 8 AND m.seq + 8 AND p.token = 'coin' AND p.account <> m.account
        AND p.kind = m.kind AND p.created_at = m.created_at AND (p.delta > 0) <> (m.delta > 0)`)
      .all(acct, from, SCAN) as Array<{ seq: number; kind: string; delta: number; ref: string | null; pseq: number | null; other: string | null; pref: string | null }>;
    // one row per ledger row: the candidate with the same ref first, then the nearest
    const best = new Map<number, (typeof joined)[number]>();
    const score = (x: (typeof joined)[number]) => x.pseq == null ? Infinity : (x.pref === x.ref ? 0 : 100) + Math.abs(x.pseq - x.seq);
    for (const x of joined) { const b = best.get(x.seq); if (!b || score(x) < score(b)) best.set(x.seq, x); }
    const rows = [...best.values()];
    const merchantAcct = (id: string) => (market.ids().includes(id) ? market.account(id) : null);
    const groups = new Map<string, Flow & { dir: 'in' | 'out' }>();
    let totalIn = 0, totalOut = 0;
    for (const r of rows) {
      let other = r.other, name: string | null = null;
      if (r.kind === 'resident_buy' && r.ref) other = merchantAcct(r.ref.split(':')[1]);
      else if (r.kind === 'resident_sale') other = res.wallet;
      else if (r.kind === 'handout') other = acct === town ? res.wallet : town;
      else if (r.kind === 'handout_mint') name = 'Faucet (new coin)';
      else if (r.kind === 'town_buy') name = 'Town demand (new coin)';
      else if (r.kind === 'trade' && !other && r.ref) other = merchantAcct(r.ref.split(':')[0]);
      else if (!other && r.ref && r.ref.includes('.') && !r.ref.includes(':')) other = r.ref; // refs that are an account id (starter, handout)
      const dir = r.delta > 0 ? 'in' : 'out', key = `${dir}|${r.kind}|${other ?? name ?? ''}`;
      const g = groups.get(key) ?? { dir, account: other, name: name ?? (other ? this.name(other) : 'Unknown'), kind: r.kind, amount: 0, count: 0 };
      g.amount += Math.abs(r.delta); g.count += 1; groups.set(key, g);
      if (r.delta > 0) totalIn += r.delta; else totalOut -= r.delta;
    }
    const pick = (dir: 'in' | 'out') => [...groups.values()].filter((g) => g.dir === dir).sort((a, b) => b.amount - a.amount).slice(0, TOP)
      .map(({ dir: _d, ...g }) => g);
    return {
      account: acct, name: this.name(acct), from, coin: gs.balance(acct, 'coin'), totalIn, totalOut,
      inflow: pick('in'), outflow: pick('out'), rows: rows.length, truncated: rows.length >= SCAN,
    };
  }
}
