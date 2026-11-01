// Merkle root and inclusion proofs over the day's ledger rows (sha256). Leaves are the canonical JSON of each row
// in sequence order; an odd node is paired with itself. Anyone can recompute the root from GET /api/ledger/:day.
import { createHash } from 'node:crypto';

export interface LedgerLeaf { seq: number; day: number; account: string; token: string; delta: number; kind: string; ref: string | null }

const h = (b: Buffer | string) => createHash('sha256').update(b).digest();

export function leafHash(r: LedgerLeaf): Buffer {
  return h(JSON.stringify([r.seq, r.day, r.account, r.token, r.delta, r.kind, r.ref]));
}

export function merkleRoot(leaves: Buffer[]): string {
  if (leaves.length === 0) return h('genesis-town:empty-day').toString('hex');
  let level = leaves;
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(h(Buffer.concat([level[i], level[i + 1] ?? level[i]])));
    level = next;
  }
  return level[0].toString('hex');
}

export function merkleProof(leaves: Buffer[], index: number): string[] {
  const proof: string[] = [];
  let level = leaves;
  let i = index;
  while (level.length > 1) {
    const sib = i % 2 === 0 ? (level[i + 1] ?? level[i]) : level[i - 1];
    proof.push(sib.toString('hex'));
    const next: Buffer[] = [];
    for (let k = 0; k < level.length; k += 2) next.push(h(Buffer.concat([level[k], level[k + 1] ?? level[k]])));
    level = next;
    i = Math.floor(i / 2);
  }
  return proof;
}

export function verifyProof(leaf: Buffer, index: number, proof: string[], root: string): boolean {
  let acc = leaf;
  let i = index;
  for (const p of proof) {
    const sib = Buffer.from(p, 'hex');
    acc = i % 2 === 0 ? h(Buffer.concat([acc, sib])) : h(Buffer.concat([sib, acc]));
    i = Math.floor(i / 2);
  }
  return acc.toString('hex') === root;
}
