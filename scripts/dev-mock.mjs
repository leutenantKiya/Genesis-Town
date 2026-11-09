// Starts the server on the mock chain with dev login. Same on Windows, macOS and Linux (no `VAR=x cmd` shell syntax).
// Usage: npm run dev:mock   (builds client/vendor/near.js first), or node scripts/dev-mock.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const env = {
  ...process.env,
  CHAIN_MODE: 'mock',
  DEV_LOGIN: '1',
  DB_PATH: 'data/mock.db',
  GAME_CONTRACT_ID: 'game.genesistown.mock',
  PLAYERS_PARENT_ACCOUNT_ID: 'players.genesistown.mock',
};
const child = spawn(process.execPath, ['server/src/main.ts'], { cwd: root, env, stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, sig) => process.exit(sig ? 1 : code ?? 0));
