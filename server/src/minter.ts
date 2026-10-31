// Gather minting. Gathering shows up in the player's bag immediately as "pending"; the minter batches pending items
// into one `mint_gathered` call every `maxWaitMs` or `maxItems`, whichever comes first.
// Idempotency: each batch gets a mint_id before it is sent. The contract stores used mint_ids, so if a send fails
// after reaching the chain, the retry is detected with `is_mint_id_used` and never mints twice.
import { randomUUID } from 'node:crypto';
import type { Chain, MintEntry } from './chain.ts';
import type { Store } from './db.ts';
import type { Config } from './config.ts';
import { HttpError } from './auth.ts';
import { RateLimiter } from './relayer.ts';

// M1 items; the full table lives in economy/config.json from M2.
export const GATHERABLE: Record<string, string> = { fish: 'Ikan', ore: 'Bijih', wood: 'Kayu', wheat: 'Gandum' };

export class Minter {
  deps: { cfg: Config; chain: Chain; store: Store };
  limiter: RateLimiter;
  timer: NodeJS.Timeout | null = null;
  flushing = false;

  constructor(deps: { cfg: Config; chain: Chain; store: Store }) {
    this.deps = deps;
    this.limiter = new RateLimiter(20, 1500); // gathering takes ~2 s per action in game; 20/min is generous
  }

  gather(accountId: string, tokenId: string) {
    if (!(tokenId in GATHERABLE)) throw new HttpError(400, 'unknown item');
    if (!this.limiter.take(accountId)) throw new HttpError(429, 'Pelan-pelan… terlalu cepat mengumpulkan');
    const hid = this.deps.store.addHistory(accountId, 'gather', `+1 ${GATHERABLE[tokenId]}`, 'pending');
    this.deps.store.queueMint(accountId, tokenId, 1, hid);
    if (this.deps.store.unassignedMints().length >= this.deps.cfg.mintBatch.maxItems) void this.flush();
    else this.schedule();
    return { historyId: hid, status: 'pending' };
  }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.deps.cfg.mintBatch.maxWaitMs);
    this.timer.unref?.();
  }

  // Sends every open batch: first retries batches that already have a mint_id, then forms a new one.
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const { store } = this.deps;
      for (const id of store.openMintIds()) await this.send(id);
      const rows = store.unassignedMints();
      if (rows.length) {
        const mintId = randomUUID();
        store.assignMintId(rows.map((r) => r.id), mintId);
        await this.send(mintId);
      }
    } finally {
      this.flushing = false;
    }
  }

  async send(mintId: string) {
    const { store, chain } = this.deps;
    const rows = store.mintsById(mintId);
    if (!rows.length) return;
    const sum = new Map<string, MintEntry>();
    for (const r of rows) {
      const k = r.account_id + '|' + r.token_id;
      const e = sum.get(k) ?? { account_id: r.account_id, token_id: r.token_id, amount: '0' };
      e.amount = String(BigInt(e.amount) + BigInt(r.amount));
      sum.set(k, e);
    }
    const status = chain.mode === 'mock' ? 'mock' : 'ok';
    try {
      if (await chain.isMintIdUsed(mintId)) {
        // An earlier attempt landed but we lost the response. Already minted: settle without minting again.
        for (const r of rows) store.settleHistory(r.history_id, status, null);
        store.clearMint(mintId);
        return;
      }
      const res = await chain.mintGathered([...sum.values()], mintId);
      for (const r of rows) store.settleHistory(r.history_id, res.ok ? status : 'failed', res.txHash);
      store.clearMint(mintId);
    } catch {
      // Network error: keep the batch (same mint_id) for the next flush.
      this.schedule();
    }
  }
}
