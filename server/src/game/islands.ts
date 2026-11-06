// Private Islands: what the broker sells, the island state the server keeps, vouchers the contract checks, and the
// Kesuburan upgrade. The chain is the truth for ownership and the saved spec (`get_island`); SQLite only caches it and
// holds what is not on chain yet: upgrades bought since the last Save World, and the invite list.
//
// Flow: voucher (buy) -> player's session key signs `buy_island` -> relayer -> contract mints IS-<id>-1 -> `syncOne`.
//       upgrade (off-chain ledger rows, effect at once) -> after settlement the rows are final -> voucher (save) ->
//       `save_island` burns IS-<id>-<v> and mints IS-<id>-<v+1> -> `syncOne` drops the upgrades the chain now holds.
import type { Chain, IslandInfo, IslandSpec } from '../chain.ts';
import type { Econ, IslandOffer } from './econ.ts';
import type { GameStore, IslandRow } from './gamestore.ts';
import { HttpError } from '../auth.ts';
import { IslandMap } from './worldmap.ts';

/** Voucher messages, exactly as the contract rebuilds them (UTF-8 bytes, signed with plain ed25519, no hashing). */
export function buyMessage(contractId: string, id: number, buyer: string, price: bigint | number, s: IslandSpec, expiresNs: bigint | number): string {
  return `GT-ISLAND-BUY|${contractId}|${id}|${buyer}|${price}|${s.seed}|${s.size_level}|${s.fertility_level}|${expiresNs}`;
}
export function saveMessage(contractId: string, id: number, owner: string, fromVersion: number, s: IslandSpec, expiresNs: bigint | number): string {
  return `GT-ISLAND-SAVE|${contractId}|${id}|${owner}|${fromVersion}|${s.seed}|${s.size_level}|${s.fertility_level}|${expiresNs}`;
}

export interface VoucherSigner { sign(message: Uint8Array): { signature: Uint8Array } }
export interface OfferView { island_id: number; name: string; spec: IslandSpec; price: number }
export interface IslandState {
  island_id: number; token_id: string; version: number; name: string;
  saved: IslandSpec; live: IslandSpec; savable: IslandSpec;
  pending: Array<{ attr: string; level: number; waitingSettlement: boolean }>;
  invite: string[];
  /** The same list with display names, for the invite editor. */
  guests: Array<{ account: string; name: string }>;
  /** The next Kesuburan level: its cost, and `locked` while it needs an item that is not in the game yet (Permata). */
  next: { attr: 'fertility'; level: number; cost: Record<string, number>; locked: boolean } | null;
}

const VOUCHER_TTL_MS = 10 * 60_000;
const SYNC_TTL_MS = 15_000;
const OWNER_TTL_MS = 10_000;
export const worldId = (id: number) => `IS-${id}`;
export function parseWorld(w: string): number | null {
  const m = /^IS-(\d{1,9})$/.exec(w);
  return m ? Number(m[1]) : null;
}

/** Player directory the invite list needs: display names and who is a registered player. */
export interface PlayerDir { nameOf(account: string): string | null; accountByName(name: string): string | null; isPlayer(account: string): boolean }
export interface IslandsDeps { econ: Econ; gs: GameStore; chain: Chain; contractId: string; signer?: VoucherSigner; now?: () => number; players?: PlayerDir }

export class Islands {
  d: IslandsDeps;
  maps = new Map<string, IslandMap>();
  lastSync = 0;
  /** Last successful read per offered island (bounded to the offers), islands whose latest refresh failed, reads in flight. */
  private seen = new Map<number, number>();
  private failed = new Set<number>();
  private inflight = new Map<number, Promise<void>>();

  constructor(d: IslandsDeps) { this.d = d; }

  private get cfg() { return this.d.econ.islands; }
  private now() { return (this.d.now ?? Date.now)(); }
  offer(id: number): IslandOffer | undefined { return this.cfg?.offers.find((o) => o.island_id === id); }

  /* ------------------------------------------------------------ chain -> SQLite */

  /** Re-reads one island from the contract. A new owner starts from the saved spec: upgrades and invites are dropped. */
  async syncOne(id: number): Promise<IslandRow | undefined> {
    const info = await this.d.chain.getIsland(id);
    if (this.offer(id)) { this.seen.set(id, this.now()); this.failed.delete(id); }
    const gs = this.d.gs, had = gs.island(id);
    if (!info) { if (had) gs.deleteIsland(id); return undefined; }
    if (had && had.owner !== info.owner_id) { gs.dropIslandUpgrades(id, null, 0); gs.clearInvites(id); }
    gs.saveIsland({ island_id: id, owner: info.owner_id, version: info.version, seed: info.spec.seed, size_level: info.spec.size_level, fertility_level: info.spec.fertility_level });
    gs.dropIslandUpgrades(id, 'fertility', info.spec.fertility_level); // what the chain holds is no longer pending
    return gs.island(id);
  }

  /** Every offered island, from the chain (after a restart, and at most every 15 s otherwise). */
  async syncAll(force = false) {
    if (!force && this.now() - this.lastSync < SYNC_TTL_MS) return;
    let ok = true;
    for (const o of this.cfg?.offers ?? []) {
      try { await this.syncOne(o.island_id); } catch (e) { ok = false; console.error(`islands: sync of island ${o.island_id} failed, keeping the cached row:`, (e as Error).message); }
    }
    if (ok) this.lastSync = this.now(); // after a partial failure the next call tries again
  }

  /**
   * Ownership can change on chain at any time (`mt_transfer`). Before an owner-only or guest act we re-read that one
   * island when the cached row is older than 10 s. `access()` itself stays synchronous; the async entry points
   * (`Game.prepare`, called by the HTTP layer) do the refresh. A failing RPC keeps the cached row.
   */
  async touch(id: number) {
    if (!this.offer(id)) return; // ids from requests cost nothing unless the broker sells that island
    if (this.now() - (this.seen.get(id) ?? 0) < OWNER_TTL_MS) return;
    let p = this.inflight.get(id);
    if (!p) {
      p = this.syncOne(id).then(() => { this.failed.delete(id); }, (e) => { this.failed.add(id); console.error(`islands: refresh of island ${id} failed:`, (e as Error).message); })
        .finally(() => { this.inflight.delete(id); });
      this.inflight.set(id, p);
    }
    await p;
  }

  /** Owner-only changes must not use a stale owner: when the last refresh failed and the last good read is older than the TTL, refuse. */
  assertFresh(id: number) {
    if (this.failed.has(id) && this.now() - (this.seen.get(id) ?? 0) >= OWNER_TTL_MS) throw new HttpError(503, 'Data pulau sedang tidak bisa diperiksa. Coba lagi sebentar.');
  }

  /* ------------------------------------------------------------ specs, state */

  private specOf(r: IslandRow): IslandSpec { return { seed: r.seed, size_level: r.size_level, fertility_level: r.fertility_level }; }

  /** Upgrades above the saved level, lowest first. */
  private pendingRows(r: IslandRow) { return this.d.gs.islandUpgrades(r.island_id).filter((u) => u.attr === 'fertility' && u.level > r.fertility_level); }

  live(r: IslandRow): IslandSpec {
    const top = Math.max(r.fertility_level, ...this.pendingRows(r).map((u) => u.level));
    return { ...this.specOf(r), fertility_level: top };
  }

  /** The spec Save World may write: upgrades whose cost rows are all in a finished settlement, without gaps. */
  savable(r: IslandRow): IslandSpec {
    let lvl = r.fertility_level;
    for (const u of this.pendingRows(r)) {
      if (u.level !== lvl + 1 || !this.d.gs.rowsSettled(JSON.parse(u.seqs) as number[])) break;
      lvl = u.level;
    }
    return { ...this.specOf(r), fertility_level: lvl };
  }

  private nextUpgrade(r: IslandRow): IslandState['next'] {
    const level = this.live(r).fertility_level + 1;
    const def = this.cfg?.upgrades.fertility?.find((u) => u.level === level);
    if (!def) return null;
    return { attr: 'fertility', level, cost: def.cost, locked: Object.keys(def.cost).some((t) => !(t in this.d.econ.items)) };
  }

  state(r: IslandRow): IslandState {
    return {
      island_id: r.island_id, token_id: `IS-${r.island_id}-${r.version}`, version: r.version, name: this.offer(r.island_id)?.name ?? `Pulau #${r.island_id}`,
      saved: this.specOf(r), live: this.live(r), savable: this.savable(r),
      pending: this.pendingRows(r).map((u) => ({ attr: u.attr, level: u.level, waitingSettlement: !this.d.gs.rowsSettled(JSON.parse(u.seqs) as number[]) })),
      invite: this.d.gs.invites(r.island_id), guests: this.guests(r.island_id), next: this.nextUpgrade(r),
    };
  }

  /** The display name, or the full account id when none is set (never a short label that could pass for a display name). */
  nameOf(account: string): string { return this.d.players?.nameOf(account) ?? account; }
  private guests(id: number) { return this.d.gs.invites(id).map((account) => ({ account, name: this.nameOf(account) })); }

  /** GET /api/islands: what the broker still has, the islands this account owns, and islands it is invited to. */
  async view(account: string): Promise<{ offers: OfferView[]; mine: IslandState[]; invited: Array<{ island_id: number; name: string; owner_name: string }> }> {
    await this.syncAll();
    const offers = (this.cfg?.offers ?? []).filter((o) => !this.d.gs.island(o.island_id))
      .map((o) => ({ island_id: o.island_id, name: o.name, spec: { seed: o.seed, size_level: o.size_level, fertility_level: o.fertility_level }, price: o.price }));
    const invited = this.d.gs.invitedIslands(account).map((r) => ({ island_id: r.island_id, name: this.offer(r.island_id)?.name ?? `Pulau #${r.island_id}`, owner_name: this.nameOf(r.owner) }));
    return { offers, mine: this.d.gs.islandsOf(account).map((r) => this.state(r)), invited };
  }

  /* ------------------------------------------------------------ vouchers */

  private sign(message: string): string {
    if (!this.d.signer) throw new HttpError(503, 'Makelar belum bisa menerbitkan surat (kunci belum diatur).');
    return Buffer.from(this.d.signer.sign(new TextEncoder().encode(message)).signature).toString('base64');
  }

  /** The exact contract call for buying or saving; the client signs it with its session key and relays it. */
  async voucher(account: string, kind: string, id: number): Promise<{ method: 'buy_island' | 'save_island'; args: Record<string, unknown> }> {
    if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'island_id salah');
    const expires = (BigInt(this.now()) + BigInt(VOUCHER_TTL_MS)) * 1_000_000n;
    let info: IslandInfo | null; // the chain, not our cache, decides who owns what
    try { info = await this.d.chain.getIsland(id); } catch { throw new HttpError(503, 'Data pulau sedang tidak bisa diperiksa. Coba lagi sebentar.'); }
    if (kind === 'buy') {
      const o = this.offer(id);
      if (!o) throw new HttpError(404, 'Pulau itu tidak dijual.');
      if (info) { await this.syncOne(id); throw new HttpError(409, 'Pulau itu sudah ada pemiliknya.'); }
      const gs = this.d.gs;
      if (gs.settledBalance(account, 'coin') < o.price || gs.balance(account, 'coin') < o.price) {
        throw new HttpError(409, `Koin kurang: harga ${o.price}, koin di rantai ${gs.settledBalance(account, 'coin')}. Hasil hari ini masuk ke rantai saat penyelesaian 06:00.`);
      }
      const spec = { seed: o.seed, size_level: o.size_level, fertility_level: o.fertility_level };
      return {
        method: 'buy_island',
        args: { island_id: id, spec, price: String(o.price), expires_ns: String(expires), signature: this.sign(buyMessage(this.d.contractId, id, account, o.price, spec, expires)) },
      };
    }
    if (kind === 'save') {
      if (!info || info.owner_id !== account) throw new HttpError(403, 'Itu bukan pulaumu.');
      let row: IslandRow | undefined;
      try { row = await this.syncOne(id); } catch { throw new HttpError(503, 'Data pulau sedang tidak bisa diperiksa. Coba lagi sebentar.'); }
      if (!row) throw new HttpError(404, 'Pulau tidak ditemukan.');
      const spec = this.savable(row);
      if (spec.fertility_level <= row.fertility_level) {
        throw new HttpError(409, this.pendingRows(row).length ? 'Peningkatanmu lunas setelah settlement 06:00. Simpan setelah itu.' : 'Tidak ada peningkatan yang perlu disimpan.');
      }
      return {
        method: 'save_island',
        args: { island_id: id, from_version: info.version, spec, expires_ns: String(expires), signature: this.sign(saveMessage(this.d.contractId, id, account, info.version, spec, expires)) },
      };
    }
    throw new HttpError(400, 'kind harus buy atau save');
  }

  /* ------------------------------------------------------------ access, maps */

  /** Row of an island and whether this account may be there: the owner and invited guests. */
  access(account: string, id: number): { row: IslandRow; owner: boolean } {
    const row = this.d.gs.island(id);
    if (!row) throw new HttpError(409, 'Pulau itu belum dibeli.');
    const owner = row.owner === account;
    if (!owner && !this.d.gs.invites(id).includes(account)) throw new HttpError(409, 'Pulau itu pribadi. Kamu belum diundang.');
    return { row, owner };
  }

  /** The map of an island as it is now (size decides the farm; fertility only adds flowers). */
  map(row: IslandRow): IslandMap {
    const live = this.live(row);
    const key = `${row.island_id}:${live.seed}:${live.size_level}:${live.fertility_level}`;
    let m = this.maps.get(key);
    if (!m) {
      for (const k of this.maps.keys()) if (k.startsWith(`${row.island_id}:`)) this.maps.delete(k);
      m = new IslandMap(live.seed, live);
      this.maps.set(key, m);
    }
    return m;
  }

  /** GET /api/islands/layout: seed and live spec, for owner and invited guests (the client builds the map from them). */
  layout(account: string, id: number) {
    const { row } = this.access(account, id);
    const live = this.live(row);
    return { seed: live.seed, spec: live };
  }

  /** Only the owner edits the list; guests may travel there and walk around. */
  setInvites(account: string, id: number, accounts: string[]): string[] {
    const row = this.d.gs.island(id);
    if (!row || row.owner !== account) throw new HttpError(403, 'Itu bukan pulaumu.');
    this.assertFresh(id);
    // each entry is an account id of a registered player (checked first, so a display name can never take over an id) or a display name
    const list: string[] = [], unknown: string[] = [];
    for (const raw of accounts.map((a) => String(a).trim()).filter(Boolean)) {
      const acct = this.d.players ? ((this.d.players.isPlayer(raw) ? raw : null) ?? this.d.players.accountByName(raw)) : raw;
      if (!acct) unknown.push(raw.slice(0, 30)); else if (acct !== account && !list.includes(acct)) list.push(acct);
    }
    if (unknown.length) throw new HttpError(400, `Pemain tidak ditemukan: ${unknown.join(', ')}. Tulis nama pemain persis seperti di permainan.`);
    list.splice(20);
    this.d.gs.setInvites(id, list);
    return list;
  }

  /** Invite list with display names, as the invite editor shows it. */
  guestsOf(id: number) { return this.guests(id); }

  /** Farm numbers of an island's plots: how many, how long they grow, extra yield (from Luas and Kesuburan). */
  farmOf(row: IslandRow, baseGrowDays: number): { count: number; growDays: number; yieldBonus: number } {
    const live = this.live(row);
    const f = this.cfg.fertility.find((x) => x.level === live.fertility_level) ?? this.cfg.fertility[0];
    return {
      count: ({ 1: 6, 2: 9, 3: 12 } as Record<number, number>)[live.size_level] ?? 6,
      growDays: Math.max(1, Math.ceil(baseGrowDays / f.growFactor - 1e-9)),
      yieldBonus: f.yieldBonus,
    };
  }

  /* ------------------------------------------------------------ upgrade (off-chain, paid now, final after settlement) */

  /** Buys the next Kesuburan level for the owner: goods and coin leave now, the effect is immediate. */
  upgrade(account: string, id: number, attr: string, day: number): { toast: string; tags: string[] } {
    if (attr !== 'fertility') throw new HttpError(400, 'Peningkatan itu tidak ada.');
    const row = this.d.gs.island(id);
    if (!row || row.owner !== account) throw new HttpError(403, 'Itu bukan pulaumu.');
    this.assertFresh(id);
    const next = this.nextUpgrade(row);
    if (!next) throw new HttpError(409, 'Kesuburan sudah di tingkat tertinggi.');
    if (next.locked) throw new HttpError(409, `Kesuburan ${next.level} butuh ${Object.keys(next.cost).filter((t) => !(t in this.d.econ.items)).join(', ')} dari tambang, yang belum dibuka.`);
    const gs = this.d.gs;
    for (const [t, n] of Object.entries(next.cost)) {
      const have = gs.balance(account, t);
      if (have < n) throw new HttpError(409, `${this.d.econ.items[t].name} kurang (punya ${have}, perlu ${n}).`);
    }
    const seqs: number[] = [];
    for (const [t, n] of Object.entries(next.cost)) seqs.push(gs.add(day, account, t, -n, 'island_upgrade', `${worldId(id)}:fertility:${next.level}`));
    gs.addIslandUpgrade(id, 'fertility', next.level, seqs);
    return { toast: `Kesuburan Tanah naik ke tingkat ${next.level}. Lunas setelah settlement 06:00; baru lalu bisa disimpan (Simpan Dunia).`, tags: Object.keys(next.cost) };
  }
}

export type { IslandInfo };
