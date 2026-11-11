// Moves the four testnet merchants to their new ids (sari -> sarah, budi -> ben, wati -> wendy, joko -> jack).
// Read docs/merchant-rename.md first. NOTHING here runs by itself: every step that writes asks for --execute, and the
// steps that need the contract OWNER's key (creating accounts, register_merchant) are only printed as near-cli commands,
// because that key never lives on the server.
//
//   node server/scripts/migrate-merchants.ts plan                 read-only: old and new accounts, balances, what is missing
//   node server/scripts/migrate-merchants.ts commands             prints the near-cli commands for the owner (accounts + register_merchant)
//   node server/scripts/migrate-merchants.ts move [--execute]     settler: moves every balance old -> new through settle_day (net zero coin)
//   node server/scripts/migrate-merchants.ts db [--execute]       renames the merchants in the server's SQLite file (server STOPPED)
//
// Run `move` and `db` with the server stopped, after the last settlement of the old build has finished.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { TestnetChain } from '../src/chain.ts';
import type { DeltaEntry } from '../src/chain.ts';
import { loadEcon } from '../src/game/econ.ts';

const OLD_TO_NEW: Record<string, string> = { sari: 'sarah', budi: 'ben', wati: 'wendy', joko: 'jack' };
const MOVE_CHUNK_BASE = 9000; // chunk numbers the daily settlement never reaches (it uses 0..n for a few hundred accounts)

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const cmd = process.argv[2];
const execute = process.argv.includes('--execute');
if (!['plan', 'commands', 'move', 'db'].includes(cmd ?? '')) {
  console.log('usage: node server/scripts/migrate-merchants.ts plan | commands | move [--execute] | db [--execute]');
  process.exit(1);
}

process.loadEnvFile(join(root, '.env'));
const cfg = loadConfig();
const econ = loadEcon();
const parent = cfg.merchantParentId;
const tokens = Object.keys(econ.items);
const pairs = Object.entries(OLD_TO_NEW).map(([o, n]) => ({ oldId: o, newId: n, oldAcct: `${o}.${parent}`, newAcct: `${n}.${parent}` }));
for (const p of pairs) if (!econ.merchants[p.newId]) throw new Error(`economy/config.json has no merchant "${p.newId}": run this from the merchant-rename build`);
const chain = new TestnetChain(cfg);

async function view<T>(method: string, args: Record<string, unknown>): Promise<T> {
  return chain.provider.callFunction({ contractId: cfg.gameContractId, method, args }) as Promise<T>;
}
async function accountExists(id: string) {
  try { await chain.provider.viewAccount({ accountId: id }); return true; } catch { return false; }
}

if (cmd === 'plan' || cmd === 'commands') {
  const shops = await chain.listShops();
  for (const p of pairs) {
    const oldBal = await chain.balances(p.oldAcct, tokens);
    const held = tokens.map((t, i) => `${t}=${oldBal[i]}`).join(' ');
    const exists = await accountExists(p.newAcct);
    const reg = shops.some((s) => s.account_id === p.newAcct);
    console.log(`${p.oldAcct} -> ${p.newAcct}\n  old holds: ${held}\n  new account exists: ${exists}, registered as merchant: ${reg}`);
  }
}

if (cmd === 'commands') {
  console.log('\n# Run as the contract OWNER (near-cli-rs keychain on your machine). Check the syntax with `near account create-account --help`.');
  for (const p of pairs) {
    const m = econ.merchants[p.newId];
    const restore = [{ token_id: 'coin', amount: String(m.restore.coin) }, ...Object.entries(m.restore.items).map(([t, a]) => ({ token_id: t, amount: String(a) }))];
    // no opening stock: the balances arrive from the old merchant with `move`, so nothing new is minted
    const args = { account_id: p.newAcct, name: m.shop, restore, start: [] };
    console.log(`\nnear account create-account fund-myself ${p.newAcct} '1 NEAR' autogenerate-new-keypair save-to-keychain sign-as ${parent} network-config testnet sign-with-keychain send`);
    console.log(`near contract call-function as-transaction ${cfg.gameContractId} register_merchant json-args '${JSON.stringify(args)}' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' sign-as ${parent} network-config testnet sign-with-keychain send`);
  }
}

if (cmd === 'move') {
  const day = Number((await view<{ last_settled_day: number }>('get_config', {})).last_settled_day);
  const dayRoot = await view<string | null>('get_day_root', { day });
  if (!dayRoot) throw new Error(`day ${day} has no stored root on chain: settle at least one day with the old build first`);
  console.log(`using day ${day} (already settled, root ${dayRoot.slice(0, 12)}…), chunks from ${MOVE_CHUNK_BASE}`);
  let chunk = MOVE_CHUNK_BASE;
  for (const p of pairs) {
    if (!(await chain.isRegistered(p.newAcct)) && !(await chain.listShops()).some((s) => s.account_id === p.newAcct)) {
      console.log(`${p.newAcct} is not registered as a merchant yet: run the owner commands first. Skipping.`);
      continue;
    }
    const bal = await chain.balances(p.oldAcct, tokens);
    const entries: DeltaEntry[] = [];
    tokens.forEach((t, i) => {
      if (BigInt(bal[i]) > 0n) {
        entries.push({ account_id: p.oldAcct, token_id: t, delta: `-${bal[i]}` });
        entries.push({ account_id: p.newAcct, token_id: t, delta: bal[i] });
      }
    });
    if (!entries.length) { console.log(`${p.oldAcct} holds nothing: skipped`); continue; }
    if (await chain.isChunkApplied(day, chunk)) { console.log(`chunk ${chunk} already applied: skipped (already moved?)`); chunk++; continue; }
    console.log(`${p.oldAcct} -> ${p.newAcct}: ${entries.length / 2} tokens, chunk ${chunk}${execute ? '' : ' (dry run, add --execute)'}`);
    if (execute) {
      // active_players 0: the chunk's net coin is zero, so the faucet check never applies
      const r = await chain.settleDay(day, chunk, entries, dayRoot, 0);
      console.log(r.ok ? `  ok ${cfg.explorerTxUrl}${r.txHash}` : `  FAILED ${r.error}`);
      if (!r.ok) process.exit(1);
    }
    chunk++;
  }
}

if (cmd === 'db') {
  const store = new Store(join(root, cfg.dbPath));
  const db = store.db;
  // Only what is still open or only a cache is renamed. Settled ledger rows stay on the OLD accounts: the day's Merkle
  // root on chain was computed over them, so rewriting them would break verification of past days.
  const steps: Array<[string, string, unknown[]]> = [];
  for (const p of pairs) {
    steps.push([`ledger (unsettled) ${p.oldAcct}`, 'UPDATE ledger SET account = ? WHERE account = ? AND settled = 0', [p.newAcct, p.oldAcct]]);
    steps.push([`settled balances ${p.oldAcct}`, 'UPDATE settled SET account = ? WHERE account = ?', [p.newAcct, p.oldAcct]]);
    steps.push([`market rows ${p.oldId}`, 'UPDATE market SET merchant = ? WHERE merchant = ?', [p.newId, p.oldId]]);
    steps.push([`shortfalls ${p.oldAcct}`, 'UPDATE shortfalls SET account = ? WHERE account = ? AND resolved = 0', [p.newAcct, p.oldAcct]]);
  }
  db.exec('BEGIN');
  try {
    for (const [label, sql, args] of steps) {
      // UPDATE settled would collide with an existing new row (primary key): drop the empty new one first
      if (sql.startsWith('UPDATE settled')) db.prepare('DELETE FROM settled WHERE account = ?').run(args[0] as string);
      const r = db.prepare(sql).run(...(args as string[]));
      console.log(`${label}: ${r.changes} rows`);
    }
    if (execute) { db.exec('COMMIT'); console.log('committed'); } else { db.exec('ROLLBACK'); console.log('dry run (rolled back), add --execute'); }
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
