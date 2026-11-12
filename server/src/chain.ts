// Chain adapter. `TestnetChain` talks to the game contract on NEAR testnet (near-api-js 7.4); `MockChain` mirrors the
// contract's rules in memory for tests and for running without testnet (labelled "mock" everywhere it shows up).
import { Account, JsonRpcProvider, actions, teraToGas, PublicKey, type KeyPairString } from 'near-api-js';
import type { Config } from './config.ts';

export interface TxResult { txHash: string; ok: boolean; error?: string }
export interface DeltaEntry { account_id: string; token_id: string; delta: string }
export interface ShopInfo { account_id: string; name: string; open: boolean; coin: string; total_shares: string; need: Array<{ token_id: string; amount: string }>; pledged: Array<{ token_id: string; amount: string }>; contributors: number; times_closed: number }
export interface HoldingInfo { shares: string; total_shares: string; claimable: string }
export interface ProjectInfo { id: string; name: string; chunk: string; need: Array<{ token_id: string; amount: string }>; pledged: Array<{ token_id: string; amount: string }>; contributors: Array<{ account_id: string; lines: Array<{ token_id: string; amount: string }> }>; done: boolean; done_ns: number }
export interface ListingInfo { id: number; seller: string; token_id: string; amount: string; price_each: string; created_ns: number }


export interface Chain {
  readonly mode: 'testnet' | 'mock';
  createPlayerAccount(accountId: string, ownerPk: string, sessionPk: string): Promise<TxResult>;
  /** null when the account does not exist; otherwise whether `publicKey` is one of its access keys. */
  accountHasKey(accountId: string, publicKey: string): Promise<boolean | null>;
  registerPlayer(accountId: string): Promise<TxResult>;
  settleDay(day: number, chunk: number, entries: DeltaEntry[], root: string, active: number): Promise<TxResult>;
  isChunkApplied(day: number, chunk: number): Promise<boolean>;
  /** The last day the contract has closed (`get_config().last_settled_day`); `settle_day` refuses any earlier day. */
  lastSettledDay(): Promise<number>;
  closeShop(merchant: string): Promise<TxResult>;
  payDividend(merchant: string, day: number, amount: number): Promise<TxResult>;
  relay(signedDelegate: unknown, senderId: string): Promise<TxResult>;
  balances(accountId: string, tokenIds: string[]): Promise<string[]>;
  /** Whether the account is registered with the game contract (`is_registered`); unregistered entries are skipped by `settle_day`. */
  isRegistered(accountId: string): Promise<boolean>;
  listShops(): Promise<ShopInfo[]>;
  holding(merchant: string, holder: string): Promise<HoldingInfo>;
  coinSupply(): Promise<string>;
  listListings(limit?: number): Promise<ListingInfo[]>;
  getListing(id: number): Promise<ListingInfo | null>;
  listProjects(): Promise<ProjectInfo[]>;
  /** The town treasury pledges to a restoration board (village relief fund). */
  townPledge(merchant: string, contribution: Array<{ token_id: string; amount: string }>): Promise<TxResult>;
  getProject(id: string): Promise<ProjectInfo | null>;
  derivedOwnerKey(sub: string): Promise<string>;
  /** Calls `sign` on the NEAR Auth contract (paid by the relayer); `value` is the base64 result (the MPC signature). */
  fastAuthSign(args: { guard_id: string; verify_payload: string; sign_payload: number[]; algorithm: string }): Promise<TxResult & { value?: string }>;
  /** NEAR an account can still spend on gas and transfers (yoctoNEAR): its balance minus what its storage locks. */
  spendableNear(accountId: string): Promise<bigint>;
}
// NEAR locks 10^19 yoctoNEAR per byte of account storage (1 NEAR per 100 kB; testnet RPC `storage_amount_per_byte`)
const STORAGE_YOCTO_PER_BYTE = 10n ** 19n;

interface Outcome { transaction: { hash: string }; status: unknown }

function toResult(o: Outcome): TxResult {
  const st = o.status as Record<string, unknown>;
  if (st && typeof st === 'object' && 'Failure' in st) {
    return { txHash: o.transaction.hash, ok: false, error: JSON.stringify(st.Failure).slice(0, 500) };
  }
  return { txHash: o.transaction.hash, ok: true };
}

export class TestnetChain implements Chain {
  readonly mode = 'testnet' as const;
  provider: JsonRpcProvider;
  cfg: Config;
  parent: Account;
  settler: Account;
  relayer: Account;
  town: Account | null;

  constructor(cfg: Config) {
    this.cfg = cfg;
    this.provider = new JsonRpcProvider({ url: cfg.rpcUrl });
    this.parent = new Account(cfg.playersParentId, this.provider, cfg.playersParentPrivateKey as KeyPairString);
    this.settler = new Account(cfg.settlerAccountId, this.provider, cfg.settlerPrivateKey as KeyPairString);
    this.relayer = new Account(cfg.relayerAccountId, this.provider, cfg.relayerPrivateKeys[0] as KeyPairString);
    this.town = cfg.townPrivateKey ? new Account(cfg.townAccountId, this.provider, cfg.townPrivateKey as KeyPairString) : null;
  }

  private view<T>(method: string, args: Record<string, unknown>): Promise<T> {
    return this.provider.callFunction({ contractId: this.cfg.gameContractId, method, args }) as Promise<T>;
  }

  private async settlerCall(method: string, args: Record<string, unknown>, tgas = '100'): Promise<TxResult> {
    // Wait for FINAL so that the server's next read (possibly from another RPC node) already sees the change.
    const o = await this.settler.signAndSendTransaction({ throwOnFailure: false,
      receiverId: this.cfg.gameContractId,
      actions: [actions.functionCall(method, args, teraToGas(tgas as `${number}`), 0n)],
      waitUntil: 'FINAL',
    });
    return toResult(o as unknown as Outcome);
  }

  async createPlayerAccount(accountId: string, ownerPk: string, sessionPk: string): Promise<TxResult> {
    // The session key may call any method on the game contract (empty method list); the relayer allowlist and the
    // contract's own checks decide what a player can do. It can never move NEAR or attach a deposit.
    const o = await this.parent.signAndSendTransaction({ throwOnFailure: false,
      receiverId: accountId,
      actions: [
        actions.createAccount(),
        actions.transfer(this.cfg.playerInitialNear),
        actions.addFullAccessKey(PublicKey.from(ownerPk)),
        actions.addFunctionCallAccessKey(PublicKey.from(sessionPk), this.cfg.gameContractId, [], 0n),
      ],
    });
    return toResult(o as unknown as Outcome);
  }

  async accountHasKey(accountId: string, publicKey: string): Promise<boolean | null> {
    try { await this.provider.viewAccount({ accountId }); } catch (e) {
      const err = e as { message?: string; type?: string };
      if (/does not exist|UNKNOWN_ACCOUNT|AccountDoesNotExist/i.test(`${err?.type ?? ''} ${err?.message ?? e}`)) return null;
      throw e;
    }
    try { await this.provider.viewAccessKey({ accountId, publicKey: PublicKey.from(publicKey) }); return true; } catch { return false; }
  }

  async spendableNear(accountId: string): Promise<bigint> {
    const a = await this.provider.viewAccount({ accountId });
    return BigInt(a.amount) - BigInt(a.storage_usage) * STORAGE_YOCTO_PER_BYTE;
  }

  registerPlayer(accountId: string) { return this.settlerCall('register_player', { account_id: accountId }, '30'); }
  // Measured on testnet: about 2.5 Tgas plus 0.65 per entry (18 entries burnt 14.4 Tgas), so a server chunk of 25 needs
  // about 19 and the contract's limit of 50 about 35. A function-call key pays for the gas ATTACHED, not the gas used,
  // so 300 Tgas drained the settler key's allowance a hundred times faster than the work did.
  settleDay(day: number, chunk: number, entries: DeltaEntry[], root: string, active: number) {
    return this.settlerCall('settle_day', { day, chunk, entries, ledger_root: root, active_players: active }, '100');
  }
  isChunkApplied(day: number, chunk: number) { return this.view<boolean>('is_chunk_applied', { day, chunk }); }
  async lastSettledDay() { return Number((await this.view<{ last_settled_day: number }>('get_config', {})).last_settled_day); }
  closeShop(merchant: string) { return this.settlerCall('close_shop', { merchant }, '50'); }
  payDividend(merchant: string, day: number, amount: number) { return this.settlerCall('pay_dividend', { merchant, day, amount: String(amount) }, '50'); }

  async relay(signedDelegate: unknown, _senderId: string): Promise<TxResult> {
    // Same as Account.relayMetaTransaction, but waits for FINAL (see settlerCall).
    const sd = signedDelegate as Parameters<Account['relayMetaTransaction']>[0];
    const o = await this.relayer.signAndSendTransaction({ throwOnFailure: false, receiverId: sd.delegateAction.senderId, actions: [actions.signedDelegate(sd)], waitUntil: 'FINAL' });
    return toResult(o as unknown as Outcome);
  }

  balances(accountId: string, tokenIds: string[]) { return this.view<string[]>('mt_batch_balance_of', { account_id: accountId, token_ids: tokenIds }); }
  isRegistered(accountId: string) { return this.view<boolean>('is_registered', { account_id: accountId }); }
  listShops() { return this.view<ShopInfo[]>('list_shops', {}); }
  holding(merchant: string, holder: string) { return this.view<HoldingInfo>('get_holding', { merchant, holder }); }
  async coinSupply() { return (await this.view<string | null>('mt_supply', { token_id: 'coin' })) ?? '0'; }
  listListings(limit = 50) { return this.view<ListingInfo[]>('list_listings', { limit }); }
  getListing(id: number) { return this.view<ListingInfo | null>('get_listing', { listing_id: id }); }
  listProjects() { return this.view<ProjectInfo[]>('list_projects', {}); }
  async townPledge(merchant: string, contribution: Array<{ token_id: string; amount: string }>): Promise<TxResult> {
    if (!this.town) return { txHash: '', ok: false, error: 'TOWN_PRIVATE_KEY not set' };
    const o = await this.town.signAndSendTransaction({ throwOnFailure: false,
      receiverId: this.cfg.gameContractId,
      actions: [actions.functionCall('restore_contribute', { merchant, contribution }, teraToGas('100'), 0n)],
      waitUntil: 'FINAL',
    });
    return toResult(o as unknown as Outcome);
  }
  getProject(id: string) { return this.view<ProjectInfo | null>('get_project', { id }); }

  // NEAR Auth `sign` (docs.auth.near.org/home/guides/sign-transactions.md: 300 Tgas, deposit 1 yoctoNEAR in the example).
  async fastAuthSign(args: { guard_id: string; verify_payload: string; sign_payload: number[]; algorithm: string }) {
    const o = (await this.relayer.signAndSendTransaction({ throwOnFailure: false,
      receiverId: this.cfg.fastAuth.contractId,
      actions: [actions.functionCall('sign', args, teraToGas('300'), 1n)],
      waitUntil: 'FINAL',
    })) as unknown as Outcome;
    const r = toResult(o);
    const st = o.status as { SuccessValue?: string };
    return { ...r, value: r.ok && typeof st.SuccessValue === 'string' && st.SuccessValue ? st.SuccessValue : undefined, error: r.error ?? (r.ok && !st.SuccessValue ? 'empty result' : undefined) };
  }

  // The NEAR Auth key for a login is derived by the MPC contract at path `jwt#https://<domain>/#<sub>` with
  // predecessor fast-auth.testnet (docs.auth.near.org protocol/concepts/auth0.md, contracts/fast-auth.md).
  async derivedOwnerKey(sub: string): Promise<string> {
    const fa = this.cfg.fastAuth;
    return (await this.provider.callFunction({
      contractId: fa.mpcContractId,
      method: 'derived_public_key',
      args: { path: `jwt#https://${fa.domain}/#${sub}`, predecessor: fa.contractId, domain_id: fa.mpcDomainId },
    })) as string;
  }
}

/* ======================================================================= mock */

interface MockShop { name: string; open: boolean; shares: Map<string, number>; total: number; need: Map<string, number>; pledged: Map<string, number>; contrib: Map<string, Map<string, number>>; claimable: Map<string, number>; closes: number; base: Record<string, number>; atClose: { book: number; shares: number } }

export class MockChain implements Chain {
  readonly mode = 'mock' as const;
  bal = new Map<string, bigint>(); // `${account}|${token}`
  accounts = new Set<string>();
  applied = new Set<string>();
  roots = new Map<number, string>();
  shops = new Map<string, MockShop>();
  rent = 40;
  listings = new Map<number, ListingInfo>();
  projects = new Map<string, ProjectInfo>();
  nextListing = 0;
  contractId = 'game.genesistown.mock';
  n = 0;
  failNext = false;
  /** When set, every settle_day call throws this message (a down RPC node). */
  settleError: string | null = null;
  settleCalls: Array<{ day: number; chunk: number }> = [];
  /** Contract limits, defaults from contracts/game/init-testnet.json. */
  limits = { faucetW0: 1200, moneyCap0: 25000, activeDivisor: 10, maxK: 6, dailyGainCap: 200, dailyCoinGainCap: 5000 };
  dayFaucet = new Map<number, { start: bigint; net: bigint }>();
  gainUsed = new Map<string, { day: number; used: bigint }>();
  dividendsPaid = new Set<string>();

  hash(): string { return `mock-${++this.n}`; }
  get(a: string, t: string): bigint { return this.bal.get(`${a}|${t}`) ?? 0n; }
  add(a: string, t: string, d: bigint) {
    const v = this.get(a, t) + d;
    if (v < 0n) throw new Error(`not enough ${t} for ${a}`);
    this.bal.set(`${a}|${t}`, v);
  }

  /** Mirrors `register_merchant`: shop, board and opening stock. */
  addMerchant(account: string, name: string, restore: Record<string, number>, start: Record<string, number>, base: Record<string, number>) {
    this.accounts.add(account);
    this.shops.set(account, { name, open: true, shares: new Map([['town', 1000]]), total: 1000, need: new Map(Object.entries(restore)), pledged: new Map(), contrib: new Map(), claimable: new Map(), closes: 0, base, atClose: { book: 0, shares: 0 } });
    for (const [t, a] of Object.entries(start)) this.add(account, t, BigInt(a));
  }

  /** Access keys per created account (mirrors the account on chain, which outlives the server's database). */
  keys = new Map<string, Set<string>>();
  async createPlayerAccount(accountId: string, ownerPk?: string, sessionPk?: string): Promise<TxResult> {
    if (this.accounts.has(accountId) || this.keys.has(accountId)) return { txHash: this.hash(), ok: false, error: 'AccountAlreadyExists' };
    this.keys.set(accountId, new Set([ownerPk, sessionPk].filter((k): k is string => !!k)));
    return { txHash: this.hash(), ok: true };
  }
  async accountHasKey(accountId: string, publicKey: string): Promise<boolean | null> {
    const k = this.keys.get(accountId);
    if (k) return k.has(publicKey);
    return this.accounts.has(accountId) ? false : null;
  }
  async registerPlayer(accountId: string): Promise<TxResult> { this.accounts.add(accountId); return { txHash: this.hash(), ok: true }; }

  /** Mirrors `settle_day` in contracts/game/src/settle.rs (defaults are contracts/game/init-testnet.json). */
  async settleDay(day: number, chunk: number, entries: DeltaEntry[], root: string, active = 0): Promise<TxResult> {
    if (this.failNext) { this.failNext = false; throw new Error('mock network error'); }
    this.settleCalls.push({ day, chunk });
    if (this.settleError) throw new Error(this.settleError);
    const k = `${day}:${chunk}`;
    if (this.applied.has(k)) return { txHash: this.hash(), ok: false, error: 'chunk already applied' };
    if (day < this.lastSettled) return { txHash: this.hash(), ok: false, error: 'day already closed' };
    if (this.roots.has(day) && this.roots.get(day) !== root) return { txHash: this.hash(), ok: false, error: 'ledger_root differs' };
    const snapshot = new Map(this.bal);
    const gainSnapshot = new Map(this.gainUsed);
    const faucetSnapshot = this.dayFaucet.get(day);
    try {
      // Entries for accounts that are not registered are skipped (the contract ignores them).
      const parsed = entries.filter((e) => this.accounts.has(e.account_id)).map((e) => ({ ...e, d: BigInt(e.delta) }));
      // Coin faucet: running signed net of coin over the day's chunks; it may only grow within the allowance.
      const net = parsed.filter((e) => e.token_id === 'coin').reduce((x, e) => x + e.d, 0n);
      const f = { ...(faucetSnapshot ?? { start: this.supplyBig(), net: 0n }) };
      f.net += net;
      if (net > 0n) {
        const allowed = this.faucetAllowed(f.start, active);
        if (f.net > allowed) throw new Error(`coin faucet exceeded: ${f.net} > ${allowed} allowed today`);
      }
      this.dayFaucet.set(day, f);
      for (const e of parsed.filter((x) => x.d < 0n)) this.add(e.account_id, e.token_id, e.d);
      for (const e of parsed.filter((x) => x.d > 0n)) {
        if (!this.shops.has(e.account_id) && e.account_id !== this.townAccount) {
          const cap = BigInt(e.token_id === 'coin' ? this.limits.dailyCoinGainCap : this.limits.dailyGainCap);
          const key = `${e.account_id}|${e.token_id}`;
          const g = this.gainUsed.get(key);
          const next = (g && g.day === day ? g.used : 0n) + e.d;
          if (next > cap) throw new Error(`daily gain cap reached for ${e.account_id} ${e.token_id}`);
          this.gainUsed.set(key, { day, used: next });
        }
        this.add(e.account_id, e.token_id, e.d);
      }
    } catch (err) {
      this.bal = snapshot;
      this.gainUsed = gainSnapshot;
      if (faucetSnapshot) this.dayFaucet.set(day, faucetSnapshot); else this.dayFaucet.delete(day);
      return { txHash: this.hash(), ok: false, error: (err as Error).message };
    }
    this.applied.add(k);
    this.roots.set(day, root);
    this.lastSettled = Math.max(this.lastSettled, day);
    return { txHash: this.hash(), ok: true };
  }
  supplyBig(): bigint { let x = 0n; for (const [key, v] of this.bal) if (key.endsWith('|coin')) x += v; return x; }
  /** W_day = W0 * k * (Mcap - M) / Mcap, Mcap = Mcap0 * k, k = min(max_k, 1 + active / divisor). */
  faucetAllowed(supplyAtStart: bigint, active: number): bigint {
    const L = this.limits;
    const registered = [...this.accounts].filter((a) => !this.shops.has(a) && a !== this.townAccount).length;
    const kk = BigInt(Math.min(L.maxK, 1 + Math.floor(Math.min(active, registered) / Math.max(1, L.activeDivisor))));
    const mcap = BigInt(L.moneyCap0) * kk;
    if (mcap === 0n || supplyAtStart >= mcap) return 0n;
    return (BigInt(L.faucetW0) * kk * (mcap - supplyAtStart)) / mcap;
  }
  async isChunkApplied(day: number, chunk: number) { return this.applied.has(`${day}:${chunk}`); }
  lastSettled = 0; // like the contract's last_settled_day
  async lastSettledDay() { return this.lastSettled; }

  async closeShop(merchant: string): Promise<TxResult> {
    const s = this.shops.get(merchant);
    if (!s || !s.open) return { txHash: this.hash(), ok: false, error: 'not open' };
    if (this.get(merchant, 'coin') >= BigInt(this.rent)) return { txHash: this.hash(), ok: false, error: 'shop can still pay rent' };
    let book = Number(this.get(merchant, 'coin'));
    for (const [t, b] of Object.entries(s.base)) if (t !== 'coin') book += Number(this.get(merchant, t)) * b;
    Object.assign(s, { open: false, closes: s.closes + 1, pledged: new Map(), contrib: new Map(), atClose: { book, shares: s.total } });
    return { txHash: this.hash(), ok: true };
  }

  async payDividend(merchant: string, _day: number, amount: number): Promise<TxResult> {
    const s = this.shops.get(merchant);
    if (!s || !s.open) return { txHash: this.hash(), ok: false, error: 'closed' };
    if (!this.dividendsPaid.has(`${merchant}|${_day}`)) this.dividendsPaid.add(`${merchant}|${_day}`);
    else return { txHash: this.hash(), ok: false, error: 'dividend already paid for this day' };
    this.add(merchant, 'coin', -BigInt(amount));
    for (const [h, n] of s.shares) s.claimable.set(h, (s.claimable.get(h) ?? 0) + Math.floor((amount * n) / s.total));
    return { txHash: this.hash(), ok: true };
  }

  private mockMethod(sender: string, method: string, a: Record<string, unknown>) {
    if (method === 'send_item') {
      const r = a as { receiver_id: string; token_id: string; amount: string };
      if (!this.accounts.has(r.receiver_id) || this.shops.has(r.receiver_id)) throw new Error('receiver is not a registered player');
      this.add(sender, r.token_id, -BigInt(r.amount));
      this.add(r.receiver_id, r.token_id, BigInt(r.amount));
    } else if (method === 'restore_contribute') {
      const s = this.shops.get(String(a.merchant));
      if (!s || s.open) throw new Error('shop is open');
      const mine = s.contrib.get(sender) ?? new Map<string, number>();
      for (const l of a.contribution as Array<{ token_id: string; amount: string }>) {
        const take = Math.min(Number(l.amount), (s.need.get(l.token_id) ?? 0) - (s.pledged.get(l.token_id) ?? 0));
        if (take <= 0) continue;
        this.add(sender, l.token_id, -BigInt(take));
        s.pledged.set(l.token_id, (s.pledged.get(l.token_id) ?? 0) + take);
        mine.set(l.token_id, (mine.get(l.token_id) ?? 0) + take);
      }
      s.contrib.set(sender, mine);
      if ([...s.need].every(([t, n]) => (s.pledged.get(t) ?? 0) >= n)) {
        const book = Math.max(s.atClose.book, Math.floor(s.atClose.shares / 20), 1);
        for (const [who, lines] of s.contrib) {
          let value = 0;
          for (const [t, n] of lines) value += n * (s.base[t] ?? 1);
          const add = Math.floor((value * s.atClose.shares) / book);
          s.shares.set(who, (s.shares.get(who) ?? 0) + add);
          s.total += add;
        }
        for (const [t, n] of s.pledged) this.add(String(a.merchant), t, BigInt(n));
        Object.assign(s, { open: true, pledged: new Map(), contrib: new Map() });
      }
    } else if (method === 'restore_withdraw') {
      const s = this.shops.get(String(a.merchant));
      const mine = s?.contrib.get(sender);
      if (!s || s.open || !mine) throw new Error('no pledge to withdraw');
      for (const [t, n] of mine) { this.add(sender, t, BigInt(n)); s.pledged.set(t, (s.pledged.get(t) ?? 0) - n); }
      s.contrib.delete(sender);
    } else if (method === 'list_item') {
      const r = a as { token_id: string; amount: string; price_each: string };
      const amount = Number(r.amount), price = Number(r.price_each);
      if (!this.accounts.has(sender) || this.shops.has(sender)) throw new Error('not a registered player');
      if (r.token_id === 'coin') throw new Error('coin cannot be listed');
      if (!(amount >= 1 && amount <= 50)) throw new Error('amount must be 1-50');
      if (!(price >= 1 && price <= 100_000)) throw new Error('price out of range');
      if ([...this.listings.values()].filter((l) => l.seller === sender).length >= 5) throw new Error('at most 5 open listings');
      this.add(sender, r.token_id, -BigInt(amount));
      this.add(this.contractId, r.token_id, BigInt(amount));
      const id = this.nextListing++;
      this.listings.set(id, { id, seller: sender, token_id: r.token_id, amount: String(amount), price_each: String(price), created_ns: Date.now() * 1e6 });
    } else if (method === 'buy_listing') {
      const r = a as { listing_id: number; amount: string; max_price_each: string };
      const l = this.listings.get(Number(r.listing_id));
      if (!l) throw new Error('no such listing');
      if (l.seller === sender) throw new Error('cannot buy your own listing');
      if (BigInt(l.price_each) > BigInt(r.max_price_each)) throw new Error('price is above your limit');
      const amount = BigInt(r.amount);
      if (amount < 1n || amount > BigInt(l.amount)) throw new Error('amount not available');
      const total = BigInt(l.price_each) * amount;
      const fee = (total * 500n) / 10_000n;
      this.add(sender, 'coin', -total);
      this.add(l.seller, 'coin', total - fee);
      this.add(this.contractId, l.token_id, -amount);
      this.add(sender, l.token_id, amount);
      const left = BigInt(l.amount) - amount;
      if (left === 0n) this.listings.delete(l.id); else l.amount = String(left);
    } else if (method === 'cancel_listing') {
      const l = this.listings.get(Number(a.listing_id));
      if (!l) throw new Error('no such listing');
      if (l.seller !== sender) throw new Error('only the seller can cancel');
      this.add(this.contractId, l.token_id, -BigInt(l.amount));
      this.add(sender, l.token_id, BigInt(l.amount));
      this.listings.delete(l.id);
    } else if (method === 'project_contribute') {
      const p = this.projects.get(String(a.id));
      if (!p) throw new Error('no such project');
      if (p.done) throw new Error('project is already done');
      if (this.shops.has(sender)) throw new Error('merchants do not pledge to projects');
      const amt = (l: Array<{ token_id: string; amount: string }>, t: string) => Number(l.find((x) => x.token_id === t)?.amount ?? 0);
      const bump = (l: Array<{ token_id: string; amount: string }>, t: string, n: number) => { const e = l.find((x) => x.token_id === t); if (e) e.amount = String(Number(e.amount) + n); else l.push({ token_id: t, amount: String(n) }); };
      const taken: Array<{ token_id: string; amount: string }> = [];
      for (const l of a.contribution as Array<{ token_id: string; amount: string }>) {
        const take = Math.min(Number(l.amount), amt(p.need, l.token_id) - amt(p.pledged, l.token_id));
        if (take <= 0) continue;
        if (this.get(sender, l.token_id) < BigInt(take)) throw new Error(`not enough ${l.token_id} for ${sender}`);
        bump(taken, l.token_id, take);
      }
      if (!taken.length) throw new Error('the project does not need that any more');
      for (const l of taken) { this.add(sender, l.token_id, -BigInt(l.amount)); this.add(this.contractId, l.token_id, BigInt(l.amount)); bump(p.pledged, l.token_id, Number(l.amount)); }
      const mine = p.contributors.find((c) => c.account_id === sender);
      if (mine) for (const l of taken) bump(mine.lines, l.token_id, Number(l.amount)); else p.contributors.push({ account_id: sender, lines: taken });
      if (p.need.every((n) => amt(p.pledged, n.token_id) >= Number(n.amount))) {
        for (const l of p.pledged) this.add(this.contractId, l.token_id, -BigInt(l.amount)); // built: burned
        p.done = true; p.done_ns = Date.now() * 1e6;
      }
    } else if (method === 'project_withdraw') {
      const p = this.projects.get(String(a.id));
      const i = p ? p.contributors.findIndex((c) => c.account_id === sender) : -1;
      if (!p || p.done || i < 0) throw new Error('no pledge to withdraw');
      const [c] = p.contributors.splice(i, 1);
      for (const l of c.lines) {
        this.add(this.contractId, l.token_id, -BigInt(l.amount)); this.add(sender, l.token_id, BigInt(l.amount));
        const e = p.pledged.find((x) => x.token_id === l.token_id)!; e.amount = String(Number(e.amount) - Number(l.amount));
      }
    } else if (method === 'claim_dividends') {
      const s = this.shops.get(String(a.merchant));
      const c = s?.claimable.get(sender) ?? 0;
      if (s && c > 0) { this.add(sender, 'coin', BigInt(c)); s.claimable.set(sender, 0); }
    }
  }

  async relay(signedDelegate: unknown, senderId: string): Promise<TxResult> {
    const sd = signedDelegate as { delegateAction: { actions: Array<{ functionCall?: { methodName: string; args: ArrayLike<number> } }> } };
    const fc = sd.delegateAction.actions[0]?.functionCall;
    if (fc) {
      try {
        this.mockMethod(senderId, fc.methodName, JSON.parse(Buffer.from(Uint8Array.from(fc.args)).toString('utf8')));
      } catch (e) {
        return { txHash: this.hash(), ok: false, error: (e as Error).message };
      }
    }
    return { txHash: this.hash(), ok: true };
  }

  async balances(accountId: string, tokenIds: string[]) { return tokenIds.map((t) => String(this.get(accountId, t))); }
  async spendableNear(_accountId: string) { return 10n ** 26n; } // the mock chain never runs out of gas money
  async isRegistered(accountId: string) { return this.accounts.has(accountId); }
  async listShops(): Promise<ShopInfo[]> {
    return [...this.shops].map(([acct, s]) => ({
      account_id: acct, name: s.name, open: s.open, coin: String(this.get(acct, 'coin')), total_shares: String(s.total),
      need: [...s.need].map(([t, a]) => ({ token_id: t, amount: String(a) })),
      pledged: [...s.pledged].map(([t, a]) => ({ token_id: t, amount: String(a) })),
      contributors: s.contrib.size, times_closed: s.closes,
    }));
  }
  async holding(merchant: string, holder: string): Promise<HoldingInfo> {
    const s = this.shops.get(merchant);
    return { shares: String(s?.shares.get(holder) ?? 0), total_shares: String(s?.total ?? 0), claimable: String(s?.claimable.get(holder) ?? 0) };
  }
  async coinSupply() {
    let s = 0n;
    for (const [k, v] of this.bal) if (k.endsWith('|coin')) s += v;
    return String(s);
  }
  async listListings(limit = 50) { return [...this.listings.values()].sort((x, y) => y.id - x.id).slice(0, limit).map((l) => ({ ...l })); }
  async getListing(id: number) { const l = this.listings.get(id); return l ? { ...l } : null; }
  async listProjects() { return [...this.projects.values()].map((p) => structuredClone(p)); }
  townAccount = 'town.gt.test';
  async townPledge(merchant: string, contribution: Array<{ token_id: string; amount: string }>): Promise<TxResult> {
    try { this.mockMethod(this.townAccount, 'restore_contribute', { merchant, contribution }); } catch (e) { return { txHash: this.hash(), ok: false, error: (e as Error).message }; }
    return { txHash: this.hash(), ok: true };
  }
  async getProject(id: string) { const p = this.projects.get(id); return p ? structuredClone(p) : null; }
  /** Mirrors the owner's `create_project`. */
  addProject(id: string, name: string, chunk: string, need: Record<string, number>) {
    this.projects.set(id, { id, name, chunk, need: Object.entries(need).map(([token_id, n]) => ({ token_id, amount: String(n) })), pledged: [], contributors: [], done: false, done_ns: 0 });
  }
  /** Tests set this to stand in for the MPC: it signs the sign_payload with the player's owner key. */
  mpcSign: ((payload: Uint8Array) => Uint8Array) | null = null;
  async fastAuthSign(args: { guard_id: string; verify_payload: string; sign_payload: number[]; algorithm: string }) {
    if (!this.mpcSign) return { txHash: this.hash(), ok: false, error: 'no MPC in mock mode' };
    const signature = Array.from(this.mpcSign(Uint8Array.from(args.sign_payload)));
    return { txHash: this.hash(), ok: true, value: Buffer.from(JSON.stringify({ scheme: 'Ed25519', signature })).toString('base64') };
  }
  async derivedOwnerKey(sub: string): Promise<string> {
    const { createHash } = await import('node:crypto');
    const { baseEncode } = await import('near-api-js');
    return 'ed25519:' + baseEncode(createHash('sha256').update('mock-owner:' + sub).digest());
  }
}
