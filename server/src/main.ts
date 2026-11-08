import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig } from './config.ts';
import { Store } from './db.ts';
import { MockChain, TestnetChain } from './chain.ts';
import { auth0Verifier, withDevLogin } from './auth.ts';
import { blockHeightSource } from './relayer.ts';
import { createApp } from './app.ts';
import { Game } from './game/game.ts';
import { loadEcon } from './game/econ.ts';

try { process.loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), '../../.env')); } catch { /* no .env: use the real environment */ }
const cfg = loadConfig();
// The mock chain lives in memory, so its off-chain database must start fresh too or the two disagree after a restart.
if (cfg.chainMode === 'mock' && cfg.dbPath !== ':memory:') {
  for (const f of [cfg.dbPath, cfg.dbPath + '-wal', cfg.dbPath + '-shm']) rmSync(f, { force: true });
}
const store = new Store(cfg.dbPath);
const econ = loadEcon();

let chain;
if (cfg.chainMode === 'mock') {
  // The mock chain mirrors the deployed setup: town treasury and the four registered shops.
  const m = new MockChain();
  const base = Object.fromEntries(Object.entries(econ.items).map(([t, i]) => [t, i.base]));
  m.accounts.add(cfg.townAccountId);
  m.townAccount = cfg.townAccountId;
  m.contractId = cfg.gameContractId;
  m.add(cfg.townAccountId, 'coin', 5000n);
  for (const [id, d] of Object.entries(econ.merchants)) {
    m.addMerchant(`${id}.${cfg.merchantParentId}`, d.shop, { coin: d.restore.coin, ...d.restore.items }, { coin: d.startCash, ...d.startStock }, base);
  }
  for (const p of econ.projects ?? []) m.addProject(p.id, p.name, p.chunk, p.need);
  chain = m;
} else {
  chain = new TestnetChain(cfg);
}

const game = new Game(store, chain, { merchantParent: cfg.merchantParentId, town: cfg.townAccountId, chunkSize: cfg.settleChunk, econ, worldSeed: cfg.worldSeed });
await game.init();
game.start();

const here = dirname(fileURLToPath(import.meta.url));
const { server } = createApp({
  cfg,
  chain,
  store,
  game,
  verify: withDevLogin(cfg, auth0Verifier(cfg)),
  currentBlockHeight: cfg.chainMode === 'mock' ? async () => 0n : blockHeightSource(cfg),
  clientDir: join(here, '../../client'),
});
server.listen(cfg.port, () => {
  if (cfg.devLogin) console.log('DEV_LOGIN is on (mock chain only): tokens "dev:<name>" are accepted.');
  if (cfg.devTools) console.log('DEV_TOOLS is on: POST /api/dev/settle is enabled.');
  const t = game.clock.time();
  console.log(`Genesis Town server on http://localhost:${cfg.port} (chain: ${chain.mode}, contract: ${cfg.gameContractId}, day ${t.day} ${t.hour}:00 ${t.season})`);
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { game.stop(); server.close(); process.exit(0); });
}
