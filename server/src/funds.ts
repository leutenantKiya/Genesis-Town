// Watches the NEAR that the server's own accounts spend: the settler pays gas for settle_day (it reserves the ATTACHED gas
// while a transaction runs), the relayer pays gas for every player action, and the players' parent funds each new
// account. When one runs low the game does not stop at once, it just quietly fails its next transaction (that is how
// settlement once stood still for days), so this checks every few minutes, logs a warning, and /api/health shows it.
import type { Chain } from './chain.ts';

export interface FundsStatus { checkedAt: number | null; near: Record<string, string>; low: string[]; lowBelow: string }

export function watchFunds(chain: Chain, accounts: string[], o: { lowNear?: number; everyMs?: number; log?: (m: string) => void; now?: () => number } = {}) {
  const low = BigInt(Math.round((o.lowNear ?? 0.25) * 1e4)) * 10n ** 20n, log = o.log ?? ((m: string) => console.warn(m)), now = o.now ?? Date.now;
  const status: FundsStatus = { checkedAt: null, near: {}, low: [], lowBelow: (o.lowNear ?? 0.25).toFixed(2) };
  const fmt = (y: bigint) => (Number(y / 10n ** 20n) / 1e4).toFixed(4);
  async function check() {
    const lowNow: string[] = [];
    for (const a of [...new Set(accounts.filter(Boolean))]) {
      try {
        const y = await chain.spendableNear(a);
        status.near[a] = fmt(y);
        if (y < low) lowNow.push(a);
      } catch (e) { status.near[a] = `? (${(e as Error).message.slice(0, 80)})`; }
    }
    for (const a of lowNow) if (!status.low.includes(a)) log(`funds: ${a} has only ${status.near[a]} NEAR left for gas (below ${status.lowBelow}); top it up (testnet: the faucet at docs.near.org/getting-started/faucet)`);
    status.low = lowNow; status.checkedAt = now();
  }
  const first = check();
  const t = o.everyMs === 0 ? null : setInterval(() => { check().catch(() => {}); }, o.everyMs ?? 10 * 60_000);
  t?.unref();
  return { status: () => ({ ...status, near: { ...status.near }, low: [...status.low] }), check, ready: first, stop: () => { if (t) clearInterval(t); } };
}
