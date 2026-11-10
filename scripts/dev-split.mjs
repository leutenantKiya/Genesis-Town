// Try the split deploy (client on Vercel, server on Railway) on this machine: the mock server on one port and the
// static client on another, so the browser calls the API cross-origin exactly as it will from Vercel to Railway.
// The client's vendor/env.js is answered here (pointing at the API port); the file on disk is never changed.
// Ctrl+C stops both.
//
//   npm run dev:split            client http://localhost:5173, API http://localhost:3100
//   API_PORT=3200 WEB_PORT=8080 npm run dev:split
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const clientRoot = join(root, 'client');
const API_PORT = Number(process.env.API_PORT ?? 3100);
const WEB_PORT = Number(process.env.WEB_PORT ?? 5173);
const api = `http://localhost:${API_PORT}`, web = `http://localhost:${WEB_PORT}`;

// the "Railway" side: same as dev:mock, plus the client's origin in CORS_ORIGINS
const server = spawn(process.execPath, ['server/src/main.ts'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    CHAIN_MODE: 'mock', DEV_LOGIN: '1', PORT: String(API_PORT), DB_PATH: 'data/split.db',
    GAME_CONTRACT_ID: 'game.genesistown.mock', PLAYERS_PARENT_ACCOUNT_ID: 'players.genesistown.mock',
    CORS_ORIGINS: web,
  },
});
server.on('exit', (code) => { console.log(`API server stopped (${code ?? 'signal'})`); process.exit(code ?? 0); });

// the "Vercel" side: plain static files, like the vercel.json output (client/ without client/build)
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
};
const web$ = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url ?? '/', web).pathname);
  if (p === '/vendor/env.js') {
    res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-cache' });
    return res.end(`window.GT_API=${JSON.stringify(api)};\n`);
  }
  const file = normalize(join(clientRoot, p === '/' ? 'index.html' : p));
  if (!file.startsWith(clientRoot) || file.startsWith(join(clientRoot, 'build'))) { res.writeHead(404); return res.end(); }
  try {
    if (!(await stat(file)).isFile()) throw new Error();
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
web$.listen(WEB_PORT, () => console.log(`\nSplit test: open ${web} (client) -> API ${api}\nCtrl+C stops both.\n`));
web$.on('error', (e) => { console.error(`client port ${WEB_PORT}: ${e.message}`); server.kill(); process.exit(1); });

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { web$.close(); server.kill(); });
