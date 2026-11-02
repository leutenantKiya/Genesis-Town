// Secret check before pushing or submitting: scans every commit (all branches) for key-shaped strings, and checks that
// none of the real keys on this machine (.env and ~/.near-credentials/testnet) appear anywhere in the history.
// Prints only key prefixes, never full values. Exit code 1 when something is found.
//
//   node scripts/check-secrets.mjs
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const history = execSync('git log --all -p --no-color', { maxBuffer: 1 << 30 }).toString('utf8');
let bad = 0;

// 1. key-shaped strings anywhere in history
const patterns = [
  [/ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/g, 'ed25519 secret key'],
  [/BEGIN (RSA|EC|OPENSSH) PRIVATE KEY/g, 'PEM private key'],
  [/\bsk-[A-Za-z0-9]{24,}/g, 'API key (sk-)'],
  [/(PRIVATE_KEYS?|NEARAI_API_KEY)=(?!\s|$|0x\.\.\.)[^\s'"]{8,}/g, 'filled-in secret variable'],
];
for (const [re, what] of patterns) {
  const hits = history.match(re) ?? [];
  if (hits.length) { bad++; console.log(`FOUND ${what}: ${hits.length} (first starts ${hits[0].slice(0, 14)}…)`); }
}

// 2. the real keys on this machine
const real = [];
if (existsSync('.env')) for (const m of readFileSync('.env', 'utf8').matchAll(/ed25519:[1-9A-HJ-NP-Za-km-z]{60,}/g)) real.push(['.env', m[0]]);
const credDir = join(homedir(), '.near-credentials', 'testnet');
if (existsSync(credDir)) for (const f of readdirSync(credDir).filter((x) => x.endsWith('.json'))) {
  try { const k = JSON.parse(readFileSync(join(credDir, f), 'utf8')).private_key; if (k) real.push([f, k]); } catch { /* not a key file */ }
}
for (const [src, k] of real) if (history.includes(k)) { bad++; console.log(`FOUND the key from ${src} (${k.slice(0, 12)}…) in git history`); }

// 3. files that must never be tracked
const tracked = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter((f) => /(^|\/)\.env$|\.pem$|near-credentials/.test(f));
if (tracked.length) { bad++; console.log('FOUND tracked secret files:', tracked.join(', ')); }

console.log(bad ? `\n${bad} problem(s) found.` : `OK: ${real.length} local keys checked against ${history.split('\ncommit ').length} commits; nothing found.`);
process.exitCode = bad ? 1 : 0;
