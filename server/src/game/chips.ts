// Casino chips, kept on the server (never in the browser). Two kinds per account:
//   bought  chips paid for with coin (coin goes to the town fund) at `chips.perCoin` chips per coin. Only these can be sold
//           back, at the same rate minus `chips.sellFeePct` (coin comes out of the town fund). Ledger kinds chips_buy / chips_sell.
//   won     chips won at the tables. They can be staked again but never turned into coin or goods, so gambling creates no coin.
// A stake spends bought chips first, then won chips; every win is paid in won chips (a pushed stake goes back to the kind it
// came from). The outcome of every game is drawn here with the server's rng; the client only shows it.
// Games: luck (double or nothing), slot, dice (big / small), cards (higher / lower, a pot that grows; the open hand is saved).
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from '../auth.ts';
import type { ChipsConfig } from './econ.ts';

export interface ChipBalance { bought: number; won: number }
export interface CardHand { card: number; pot: number; step: number; bet: number; fromBought: number; fromWon: number }
type Res = { toast: string; tags: string[] };

export class ChipsStore {
  db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS chips (account TEXT PRIMARY KEY, bought INTEGER NOT NULL DEFAULT 0, won INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS chip_day (account TEXT NOT NULL, day INTEGER NOT NULL, bought_coin INTEGER NOT NULL DEFAULT 0,
        sold_chips INTEGER NOT NULL DEFAULT 0, staked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account, day));
      CREATE TABLE IF NOT EXISTS chip_cards (account TEXT PRIMARY KEY, card INTEGER NOT NULL, pot INTEGER NOT NULL, step INTEGER NOT NULL,
        bet INTEGER NOT NULL, from_bought INTEGER NOT NULL, from_won INTEGER NOT NULL);
    `);
  }
  balance(account: string): ChipBalance {
    const r = this.db.prepare('SELECT bought, won FROM chips WHERE account = ?').get(account) as ChipBalance | undefined;
    return r ? { bought: r.bought, won: r.won } : { bought: 0, won: 0 };
  }
  add(account: string, bought: number, won: number) {
    this.db.prepare('INSERT INTO chips (account, bought, won) VALUES (?, ?, ?) ON CONFLICT(account) DO UPDATE SET bought = bought + excluded.bought, won = won + excluded.won').run(account, bought, won);
  }
  day(account: string, day: number) {
    const r = this.db.prepare('SELECT bought_coin AS boughtCoin, sold_chips AS soldChips, staked FROM chip_day WHERE account = ? AND day = ?').get(account, day) as { boughtCoin: number; soldChips: number; staked: number } | undefined;
    return r ? { boughtCoin: r.boughtCoin, soldChips: r.soldChips, staked: r.staked } : { boughtCoin: 0, soldChips: 0, staked: 0 };
  }
  addDay(account: string, day: number, boughtCoin: number, soldChips: number, staked: number) {
    this.db.prepare('INSERT INTO chip_day (account, day, bought_coin, sold_chips, staked) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account, day) DO UPDATE SET bought_coin = bought_coin + excluded.bought_coin, sold_chips = sold_chips + excluded.sold_chips, staked = staked + excluded.staked').run(account, day, boughtCoin, soldChips, staked);
    this.db.prepare('DELETE FROM chip_day WHERE day < ?').run(day - 3);
  }
  hand(account: string): CardHand | null {
    const r = this.db.prepare('SELECT card, pot, step, bet, from_bought AS fromBought, from_won AS fromWon FROM chip_cards WHERE account = ?').get(account) as CardHand | undefined;
    return r ? { card: r.card, pot: r.pot, step: r.step, bet: r.bet, fromBought: r.fromBought, fromWon: r.fromWon } : null;
  }
  setHand(account: string, h: CardHand) {
    this.db.prepare('INSERT INTO chip_cards (account, card, pot, step, bet, from_bought, from_won) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account) DO UPDATE SET card = excluded.card, pot = excluded.pot, step = excluded.step, bet = excluded.bet, from_bought = excluded.from_bought, from_won = excluded.from_won')
      .run(account, h.card, h.pot, h.step, h.bet, h.fromBought, h.fromWon);
  }
  clearHand(account: string) { this.db.prepare('DELETE FROM chip_cards WHERE account = ?').run(account); }
}

export interface ChipsDeps {
  cfg: () => ChipsConfig;
  db: DatabaseSync;
  town: string;
  rng: () => number;
  day: () => number;
  coinOf: (account: string) => number;
  addCoin: (account: string, delta: number, kind: string, ref: string) => void;
  /** Takes coin from a player into the town fund (409 when short). */
  payTown: (account: string, coin: number, kind: string, ref: string) => void;
  /** 409 when the player's daily coin gain cap would be passed. */
  checkGain: (account: string, coin: number) => void;
  passUntil: (account: string) => number;
  /** Whether the player stands at the market's Luck Table (true when the village has none to check). */
  atLuckTable: (account: string) => boolean;
}

const RANK = (card: number) => card % 13 + 1; // 1 (A) .. 13 (K); card = 0..51, suit = floor(card / 13)

export class Chips {
  st: ChipsStore;
  d: ChipsDeps;
  constructor(d: ChipsDeps) { this.d = d; this.st = new ChipsStore(d.db); }

  private cfg() { return this.d.cfg(); }

  /** What /api/state shows: both balances, the open card hand, today's limits left, and the exchange rules. */
  view(account: string) {
    const c = this.cfg(), b = this.st.balance(account), day = this.st.day(account, this.d.day()), hand = this.st.hand(account);
    return {
      bought: b.bought, won: b.won,
      hand: hand ? { card: hand.card, pot: hand.pot, step: hand.step, bet: hand.bet } : null,
      perCoin: c.perCoin, feePct: c.sellFeePct, minStake: c.minStake, maxStake: c.maxStake, luckWin: c.luckWin, cardsEdge: c.cardsEdge, cardsMaxSteps: c.cardsMaxSteps,
      buyLeftCoin: Math.max(0, c.buyMaxCoinPerDay - day.boughtCoin), sellLeftChips: Math.max(0, c.sellMaxChipsPerDay - day.soldChips), stakeLeft: Math.max(0, c.stakeMaxPerDay - day.staked),
    };
  }

  private whole(v: unknown, what: string): number {
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) throw new HttpError(400, `${what} must be a whole number above 0.`);
    return v;
  }

  /** `n` chips for n / perCoin coin (n must be a whole number of coin's worth). */
  buy(account: string, nRaw: unknown): Res {
    const c = this.cfg(), n = this.whole(nRaw, 'Chips');
    if (n % c.perCoin !== 0) throw new HttpError(400, `Chips come in steps of ${c.perCoin} (1 coin each step).`);
    const coin = n / c.perCoin, day = this.d.day(), used = this.st.day(account, day).boughtCoin;
    if (used + coin > c.buyMaxCoinPerDay) throw new HttpError(409, `You can buy chips for at most ${c.buyMaxCoinPerDay} coin a day (${used} used today).`);
    this.d.payTown(account, coin, 'chips_buy', `${n}`);
    this.st.add(account, n, 0);
    this.st.addDay(account, day, coin, 0, 0);
    return { toast: `Bought ${n} chips (−${coin} coins).`, tags: ['coin'] };
  }

  /** Only bought chips go back to coin: n chips give floor(n / perCoin x (100 - fee) / 100) coin from the town fund. */
  sell(account: string, nRaw: unknown): Res {
    const c = this.cfg(), n = this.whole(nRaw, 'Chips');
    if (n % c.perCoin !== 0) throw new HttpError(400, `Chips are exchanged in steps of ${c.perCoin}.`);
    const b = this.st.balance(account), day = this.d.day(), used = this.st.day(account, day).soldChips;
    if (n > b.bought) throw new HttpError(409, b.won > 0 ? `Only chips you bought can be exchanged (you have ${b.bought} bought). Chips you won cannot be exchanged.` : `You only have ${b.bought} chips that can be exchanged.`);
    if (used + n > c.sellMaxChipsPerDay) throw new HttpError(409, `You can exchange at most ${c.sellMaxChipsPerDay} chips a day (${used} used today).`);
    const coin = Math.floor(n * (100 - c.sellFeePct) / (100 * c.perCoin));
    if (coin < 1) throw new HttpError(409, 'That is too few chips to give a coin.');
    const town = this.d.coinOf(this.d.town);
    if (town < coin) throw new HttpError(409, `The town fund has only ${town} coin right now. Try fewer chips.`);
    this.d.checkGain(account, coin);
    this.d.addCoin(this.d.town, -coin, 'chips_sell', `${n}`);
    this.d.addCoin(account, coin, 'chips_sell', `${n}`);
    this.st.add(account, -n, 0);
    this.st.addDay(account, day, 0, n, 0);
    return { toast: `Exchanged ${n} chips for ${coin} coins (fee ${c.sellFeePct}%).`, tags: ['coin'] };
  }

  /** Takes a stake: bought chips first, then won ones. Returns where it came from. */
  private stake(account: string, stakeRaw: unknown): { stake: number; fromBought: number; fromWon: number } {
    const c = this.cfg(), stake = this.whole(stakeRaw, 'The stake');
    if (stake < c.minStake || stake > c.maxStake) throw new HttpError(400, `A stake is ${c.minStake} to ${c.maxStake} chips.`);
    const day = this.d.day(), used = this.st.day(account, day).staked;
    if (used + stake > c.stakeMaxPerDay) throw new HttpError(409, `You can play for at most ${c.stakeMaxPerDay} chips a day (${used} played today).`);
    const b = this.st.balance(account);
    if (b.bought + b.won < stake) throw new HttpError(409, `Not enough chips (have ${b.bought + b.won}, need ${stake}).`);
    const fromBought = Math.min(b.bought, stake), fromWon = stake - fromBought;
    this.st.add(account, -fromBought, -fromWon);
    this.st.addDay(account, day, 0, 0, stake);
    return { stake, fromBought, fromWon };
  }

  private access(account: string, game: string) {
    const pass = this.d.passUntil(account) > 0;
    if (game === 'luck') { if (!pass && !this.d.atLuckTable(account)) throw new HttpError(409, 'Come to the Luck Table at the market.'); }
    else if (!pass) throw new HttpError(409, 'You need a casino pass to play this table.');
  }

  private pickSlot(): number {
    const w = this.cfg().slot.weights, total = w.reduce((a, b) => a + b, 0);
    let r = this.d.rng() * total;
    for (let i = 0; i < w.length; i++) { r -= w[i]; if (r < 0) return i; }
    return 0;
  }
  private die() { return 1 + Math.min(5, Math.floor(this.d.rng() * 6)); }
  private drawCard() { return Math.min(51, Math.floor(this.d.rng() * 52)); }

  /** One play. `game`: luck | slot | dice | cards. The reply carries `play` (what to show); the new balances are in state.chips. */
  play(account: string, game: unknown, body: Record<string, unknown>): Res & { play: Record<string, unknown> } {
    if (typeof game !== 'string' || !['luck', 'slot', 'dice', 'cards'].includes(game)) throw new HttpError(400, 'Unknown game.');
    const c = this.cfg();
    if (game === 'cards') return this.cards(account, body);
    this.access(account, game);
    if (game === 'dice' && body.pick !== 'big' && body.pick !== 'small') throw new HttpError(400, 'Pick big or small.');
    const s = this.stake(account, body.stake);
    const pay = (chips: number) => { if (chips > 0) this.st.add(account, 0, chips); };
    if (game === 'luck') {
      const win = this.d.rng() < c.luckWin;
      if (win) pay(2 * s.stake);
      return { toast: win ? `You win! +${s.stake} chips.` : `You lose. −${s.stake} chips.`, tags: [], play: { game, win, stake: s.stake, payout: win ? 2 * s.stake : 0 } };
    }
    if (game === 'slot') {
      const reels = [this.pickSlot(), this.pickSlot(), this.pickSlot()];
      const mult = reels[0] === reels[1] && reels[1] === reels[2] ? c.slot.pays[reels[0]] : (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2]) ? 1 : 0;
      if (mult === 1) this.st.add(account, s.fromBought, s.fromWon); // two alike: the stake goes back to the kind it came from
      else pay(mult * s.stake);
      return { toast: mult > 1 ? `Three alike! +${(mult - 1) * s.stake} chips.` : mult === 1 ? 'Two alike: your stake comes back.' : `No luck. −${s.stake} chips.`, tags: [], play: { game, reels, mult, stake: s.stake, payout: mult * s.stake } };
    }
    // dice: three dice, big (11-17) or small (4-10); a triple loses both
    const dice = [this.die(), this.die(), this.die()], total = dice[0] + dice[1] + dice[2], triple = dice[0] === dice[1] && dice[1] === dice[2];
    const win = !triple && (body.pick === 'big' ? total >= 11 : total <= 10);
    if (win) pay(2 * s.stake);
    return { toast: win ? `Total ${total}: you win! +${s.stake} chips.` : triple ? `Triple ${dice[0]}: everyone loses. −${s.stake} chips.` : `Total ${total}: you lose. −${s.stake} chips.`, tags: [], play: { game, dice, total, triple, win, stake: s.stake, payout: win ? 2 * s.stake : 0 } };
  }

  private cards(account: string, body: Record<string, unknown>): Res & { play: Record<string, unknown> } {
    const c = this.cfg(), pick = body.pick, hand = this.st.hand(account);
    if (pick === undefined || pick === null || pick === 'start') {
      if (hand) throw new HttpError(409, 'Finish your current hand first.');
      this.access(account, 'cards');
      const s = this.stake(account, body.stake), card = this.drawCard();
      this.st.setHand(account, { card, pot: s.stake, step: 0, bet: s.stake, fromBought: s.fromBought, fromWon: s.fromWon });
      return { toast: `Cards dealt. Stake ${s.stake} chips.`, tags: [], play: { game: 'cards', card, pot: s.stake, step: 0, bet: s.stake, over: false } };
    }
    if (!hand) throw new HttpError(409, 'No hand in play. Deal first.');
    const cashOut = (h: CardHand): Res & { play: Record<string, unknown> } => {
      this.st.add(account, 0, h.pot); this.st.clearHand(account);
      return { toast: `You take ${h.pot} chips.`, tags: [], play: { game: 'cards', card: h.card, pot: h.pot, step: h.step, bet: h.bet, over: true, taken: h.pot } };
    };
    if (pick === 'cash') {
      if (hand.step < 1) throw new HttpError(409, 'Guess at least once before you take the pot.');
      return cashOut(hand);
    }
    if (pick !== 'higher' && pick !== 'lower') throw new HttpError(400, 'Pick higher, lower or cash.');
    const r = RANK(hand.card), hi = pick === 'higher', p = hi ? (13 - r) / 13 : (r - 1) / 13;
    if (p <= 0) throw new HttpError(409, hi ? 'Nothing is higher than a King.' : 'Nothing is lower than an Ace.');
    const next = this.drawCard(), nr = RANK(next), win = hi ? nr > r : nr < r;
    if (!win) {
      this.st.clearHand(account);
      return { toast: `${nr === r ? 'Same rank: you lose.' : 'Wrong.'} −${hand.bet} chips.`, tags: [], play: { game: 'cards', card: hand.card, next, pot: 0, step: hand.step, bet: hand.bet, over: true, lost: true } };
    }
    const mult = Math.round(c.cardsEdge / p * 100) / 100;
    const nh: CardHand = { ...hand, card: next, pot: Math.max(hand.pot + 1, Math.floor(hand.pot * mult)), step: hand.step + 1 };
    this.st.setHand(account, nh);
    if (nh.step >= c.cardsMaxSteps) return cashOut(nh);
    return { toast: `Right! The pot is ${nh.pot} chips.`, tags: [], play: { game: 'cards', card: next, prev: hand.card, pot: nh.pot, step: nh.step, bet: nh.bet, over: false } };
  }
}
