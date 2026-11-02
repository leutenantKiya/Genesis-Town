// Compares the server's cached on-chain balances with the chain, and lists accounts whose unsettled ledger rows would
// take a balance below zero at the next settlement. Read-only unless --fix is given; --fix sets the cache to the
// chain's values. Only use --fix when no settlement is half-applied (every day up to settle.through finished, and the
// next day's chunks not yet applied). Run it while the server is stopped.
//
//   node server/scripts/reconcile.ts [--fix]
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { TestnetChain } from '../src/chain.ts';
import { GameStore } from '../src/game/gamestore.ts';
import { loadEcon } from '../src/game/econ.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
process.loadEnvFile(join(root, '.env'));
const cfg = loadConfig();
const chain = new TestnetChain(cfg);
const store = new Store(join(root, cfg.dbPath));
const gs = new GameStore(store.db);
const tokens = Object.keys(loadEcon().items);
const fix = process.argv.includes('--fix');

const through = Number(gs.meta('settle.through') ?? -1);
for (let c = 0; c < 50; c++) {
  if (!(await chain.isChunkApplied(through + 1, c))) break;
  console.log(`day ${through + 1} chunk ${c} is already applied on chain: settlement half done, not safe to --fix`);
  process.exit(1);
}
const accounts = (store.db.prepare('SELECT DISTINCT account FROM settled UNION SELECT DISTINCT account FROM ledger').all() as Array<{ account: string }>).map((r) => r.account);
let drift = 0, negative = 0;
for (const a of accounts) {
  const onChain = (await chain.balances(a, tokens)).map(Number);
  tokens.forEach((t, i) => {
    const cached = gs.settledBalance(a, t);
    const pending = gs.pending(a, t);
    if (cached !== onChain[i]) { drift++; console.log(`drift    ${a} ${t}: cached ${cached}, chain ${onChain[i]}${fix ? ' (fixed)' : ''}`); if (fix) gs.setSettled(a, t, onChain[i]); }
    if (onChain[i] + pending < 0) { negative++; console.log(`negative ${a} ${t}: chain ${onChain[i]} + unsettled ${pending} = ${onChain[i] + pending}`); }
  });
}
console.log(`\n${accounts.length} accounts, ${drift} drifted balances, ${negative} that would go negative at the next settlement`);
