// Generates the contract's init arguments and merchant registrations from economy/config.json (single source).
// Usage: node scripts/make-init.mjs <parent-account>   -> writes contracts/game/init-testnet.json and merchants-testnet.json
import { readFileSync, writeFileSync } from 'node:fs';

const parent = process.argv[2] || 'genesistown.testnet';
const cfg = JSON.parse(readFileSync(new URL('../economy/config.json', import.meta.url), 'utf8'));
const kind = { currency: 'Currency', raw: 'Raw', crafted: 'Crafted' };

const init = {
  owner_id: parent,
  settler_id: `minter.${parent}`,
  town_id: `town.${parent}`,
  tokens: Object.entries(cfg.items).map(([id, it]) => ({ token_id: id, name: it.name, kind: kind[it.kind], base: String(it.base) })),
  limits: {
    daily_gain_cap: String(cfg.caps.dailyGainPerItem),
    daily_coin_gain_cap: '5000',
    daily_sends: cfg.caps.dailySends,
    max_send_amount: String(cfg.caps.maxSendAmount),
    max_chunk: 50,
    max_players: 150,
    faucet_w0: String(cfg.town.faucetW0),
    money_cap0: String(cfg.town.moneyCap0),
    active_divisor: cfg.town.activePlayerDivisor,
    max_k: cfg.town.maxK,
    rent: String(cfg.shops.rent),
    initial_shares: String(cfg.shops.initialShares),
    max_contributors: 20,
  },
  treasury_coin: '5000',
};

const merchants = Object.entries(cfg.merchants).map(([id, m]) => ({
  account_id: `${id}.${parent}`,
  name: m.shop,
  restore: [{ token_id: 'coin', amount: String(m.restore.coin) }, ...Object.entries(m.restore.items).map(([t, a]) => ({ token_id: t, amount: String(a) }))],
  start: [{ token_id: 'coin', amount: String(m.startCash) }, ...Object.entries(m.startStock).map(([t, a]) => ({ token_id: t, amount: String(a) }))],
}));

writeFileSync(new URL('../contracts/game/init-testnet.json', import.meta.url), JSON.stringify(init, null, 2) + '\n');
writeFileSync(new URL('../contracts/game/merchants-testnet.json', import.meta.url), JSON.stringify(merchants, null, 2) + '\n');
console.log(`wrote init (${init.tokens.length} tokens) and ${merchants.length} merchants for ${parent}`);

// v4 -> v5 migration arguments (islands): the broker, the voucher signer's public key (the server's settler key,
// replace the placeholder), and the new registry tokens.
const migrate = {
  broker_id: `makelar.${parent}`,
  voucher_key: 'ed25519:REPLACE_WITH_SETTLER_PUBLIC_KEY',
  new_tokens: [
    { token_id: 'emas', name: 'Emas', kind: 'Raw', base: '40' },
    { token_id: 'permata', name: 'Permata', kind: 'Raw', base: '120' },
  ],
};
writeFileSync(new URL('../contracts/game/migrate-v5-testnet.json', import.meta.url), JSON.stringify(migrate, null, 2) + '\n');
console.log(`wrote migrate-v5-testnet.json (broker ${migrate.broker_id})`);
