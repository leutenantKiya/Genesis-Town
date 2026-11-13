// Chain check for spending. A spend is decided on the server's books (gamestore balance = the balance as of the last
// settlement + unsettled ledger rows). Before a spend runs, the account's tokens are also read from the NEAR contract and
// compared with the settled amount the books start from: the chain must hold at least that much. A chain balance below it
// means the books claim more than exists on the network (a move on chain the server has not seen, a damaged copy of the
// database), so the spend is refused. More on chain than in the books is normal (a gift or a market sale lands first).
// Reads are cached per account for a short time. Gains (gather, farm, collect) are never checked.
import type { Chain } from './chain.ts';
import type { Econ } from './game/econ.ts';
import { HttpError } from './auth.ts';

export type ChainCheckMode = 'strict' | 'lenient' | 'off';

export interface Mismatch { at: number; account: string; token: string; db: number; chain: number; action: string }

export interface ChainCheckDeps {
  chain: Pick<Chain, 'balances'>;
  /** The books' settled amount for an account and token (GameStore.settledBalance). */
  settled: (account: string, token: string) => number;
  mode: ChainCheckMode;
  ttlMs: number;
  /** A read slower than this counts as a failed read. */
  timeoutMs?: number;
  /** True while a settlement run is between sending `settle_day` and updating the settled amounts: chain and books differ legitimately. */
  settling?: () => boolean;
  /** True while a guarded on-chain relay holds amounts for this account (same reason). */
  holding?: (account: string) => boolean;
  now?: () => number;
  warn?: (msg: string) => void;
  debug?: (msg: string) => void;
}

const MAX_MISMATCHES = 50;
export const CHAIN_CHECK_BUSY = 'Your balance is being checked with the network; please try again in a moment.';

export class ChainCheck {
  readonly d: ChainCheckDeps;
  /** The last mismatches (newest last, at most 50), for the admin status. */
  readonly mismatches: Mismatch[] = [];
  /** `${account}|${token}` -> chain balance and when it was read. */
  private cache = new Map<string, { at: number; v: number }>();
  /** Bumped per account when its cached reads are dropped (a spend, a settlement); `all` for everyone. */
  private epochs = new Map<string, number>();
  private epochAll = 0;
  private epochOf(account: string) { return this.epochAll * 1e6 + (this.epochs.get(account) ?? 0); }
  /** Number of reads sent to the chain (for tests and the admin status). */
  reads = 0;

  constructor(d: ChainCheckDeps) { this.d = d; }

  private now() { return this.d.now ? this.d.now() : Date.now(); }
  private warn(m: string) { (this.d.warn ?? ((x) => console.warn(x)))(m); }

  /** Drops cached reads for an account (no argument: for everyone). A read still in flight is not cached. */
  invalidate(account?: string | string[]) {
    if (account === undefined) { this.epochAll++; this.cache.clear(); return; }
    const set = new Set(Array.isArray(account) ? account : [account]);
    for (const a of set) this.epochs.set(a, (this.epochs.get(a) ?? 0) + 1);
    for (const k of this.cache.keys()) if (set.has(k.slice(0, k.indexOf('|')))) this.cache.delete(k);
  }

  private async read(account: string, tokens: string[]): Promise<number[]> {
    this.reads++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('chain read timed out')), this.d.timeoutMs ?? 1500); });
    try {
      const got = await Promise.race([this.d.chain.balances(account, tokens), limit]);
      return got.map((x) => Number(x));
    } catch (e) {
      // an account the contract does not know yet holds nothing
      if (/not registered|does not exist|UNKNOWN_ACCOUNT|AccountDoesNotExist/i.test(String((e as Error)?.message ?? e))) return tokens.map(() => 0);
      throw e;
    } finally { clearTimeout(timer); }
  }

  /** Throws HttpError 409 when the chain holds less than the books' settled amount of any of `tokens` for `account`.
   *  `action` only labels the log and the admin list. Never throws for anything else in lenient mode. */
  async verify(account: string, tokens: string[], action = 'spend'): Promise<void> {
    if (this.d.mode === 'off' || !tokens.length) return;
    if (this.d.settling?.() || this.d.holding?.(account)) return;
    const want = [...new Set(tokens)];
    const t = this.now(), ttl = this.d.ttlMs;
    const stale = want.filter((tok) => { const c = this.cache.get(`${account}|${tok}`); return !c || t - c.at >= ttl; });
    // This account's settled balances may change while a read is out (its own spend, a settlement): then the read may be
    // from the other side of that change, so read again once. Other players' activity does not count (per-account epoch).
    for (let attempt = 0; stale.length; attempt++) {
      const epoch = this.epochOf(account);
      let got: number[];
      try { got = await this.read(account, stale); } catch (e) {
        const why = String((e as Error)?.message ?? e);
        if (this.d.mode === 'strict') { this.warn(`chain check: ${account} ${action}: cannot read the chain (${why}); refused (strict)`); throw new HttpError(409, CHAIN_CHECK_BUSY, 'chain_check'); }
        this.warn(`chain check: ${account} ${action}: cannot read the chain (${why}); allowed (lenient)`);
        return;
      }
      if (this.d.settling?.() || this.d.holding?.(account)) return; // settlement or a relay now in flight: books and chain legitimately differ
      if (this.epochOf(account) === epoch) { stale.forEach((tok, i) => this.cache.set(`${account}|${tok}`, { at: this.now(), v: got[i] })); break; }
      if (attempt >= 1) {
        if (this.d.mode === 'strict') { this.warn(`chain check: ${account} ${action}: balances kept changing during the read; refused (strict)`); throw new HttpError(409, CHAIN_CHECK_BUSY, 'chain_check'); }
        this.warn(`chain check: ${account} ${action}: balances kept changing during the read; allowed (lenient)`);
        return;
      }
    }
    for (const tok of want) {
      const db = this.d.settled(account, tok), chain = this.cache.get(`${account}|${tok}`)!.v;
      if (chain < db) {
        this.mismatches.push({ at: this.now(), account, token: tok, db, chain, action });
        if (this.mismatches.length > MAX_MISMATCHES) this.mismatches.shift();
        this.warn(`chain check: ${account} ${tok} ${action}: books settled ${db}, chain ${chain}; spend refused`);
        this.invalidate(account);
        throw new HttpError(409, CHAIN_CHECK_BUSY, 'chain_check');
      }
      if (chain > db) (this.d.debug ?? (() => {}))(`chain check: ${account} ${tok}: chain ${chain} above books ${db} (a move on chain landed first)`);
    }
  }
}

/** Which tokens an off-chain action can take from the player (empty: it only gives, so it is not checked).
 *  Actions whose price depends on state the check cannot see without running them (a building's cost, a tool's repair)
 *  check every token. `body` is the request body; ids in it were already checked against the config by the router. */
export function spendTokens(econ: Econ, action: string, body: Record<string, unknown>): string[] {
  const token = typeof body.token === 'string' && Object.hasOwn(econ.items, body.token) ? [body.token] : [];
  switch (action) {
    case 'sell': case 'ship': case 'eat': case 'stock': return token;
    case 'buy': return ['coin'];
    case 'craft': {
      const r = typeof body.recipe === 'string' && Object.hasOwn(econ.recipes, body.recipe) ? econ.recipes[body.recipe] : null;
      return r ? [...Object.keys(r.inputs), ...(r.fee > 0 ? ['coin'] : [])] : [];
    }
    case 'cook': case 'build': case 'repair': case 'maketool': return Object.keys(econ.items);
    case 'hire': case 'dress': case 'ride': case 'casino': return ['coin'];
    case 'mall': return body.op === 'wear' ? [] : ['coin'];
    case 'chips': return body.op === 'buy' ? ['coin'] : []; // buying chips spends coin; selling and playing only add or move chips
    default: return [];
  }
}

/** Tokens a trade or consignment request puts up from the caller: `lines` {token: qty} (set), `give` (old offer), or `token` (consign). */
export function offeredTokens(econ: Econ, body: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const k of ['lines', 'give'] as const) {
    const v = body[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const t of Object.keys(v)) if (Object.hasOwn(econ.items, t)) out.add(t);
  }
  if (typeof body.token === 'string' && Object.hasOwn(econ.items, body.token)) out.add(body.token);
  return [...out];
}
