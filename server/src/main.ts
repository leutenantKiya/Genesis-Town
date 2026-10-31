import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from './config.ts';
import { Store } from './db.ts';
import { MockChain, TestnetChain } from './chain.ts';
import { auth0Verifier, withDevLogin } from './auth.ts';
import { blockHeightSource } from './relayer.ts';
import { createApp } from './app.ts';

try { process.loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), '../../.env')); } catch { /* no .env: use the real environment */ }
const cfg = loadConfig();
const store = new Store(cfg.dbPath);
const chain = cfg.chainMode === 'mock' ? new MockChain() : new TestnetChain(cfg);
const here = dirname(fileURLToPath(import.meta.url));
const { server, minter } = createApp({
  cfg,
  chain,
  store,
  verify: withDevLogin(cfg, auth0Verifier(cfg)),
  currentBlockHeight: cfg.chainMode === 'mock' ? async () => 0n : blockHeightSource(cfg),
  clientDir: join(here, '../../client'),
});
server.listen(cfg.port, () => {
  if (cfg.devLogin) console.log('DEV_LOGIN is on (mock chain only): tokens "dev:<name>" are accepted.');
  console.log(`Genesis Town server on http://localhost:${cfg.port} (chain: ${chain.mode}, contract: ${cfg.gameContractId})`);
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => { await minter.flush(); server.close(); process.exit(0); });
}
