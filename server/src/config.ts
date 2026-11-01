// Server configuration. Every secret comes from environment variables; nothing here has a default key.

export interface Config {
  port: number;
  network: 'testnet';
  rpcUrl: string;
  gameContractId: string;
  relayerAccountId: string;
  relayerPrivateKeys: string[];
  settlerAccountId: string;
  settlerPrivateKey: string;
  townAccountId: string;
  merchantParentId: string;
  devTools: boolean;
  playersParentId: string;
  playersParentPrivateKey: string;
  playerInitialNear: bigint; // yoctoNEAR sent to each new player account
  fastAuth: { domain: string; clientId: string; contractId: string; mpcContractId: string; mpcDomainId: number };
  explorerTxUrl: string; // prefix, hash is appended
  relay: { perMinute: number; perDay: number; maxGasTera: number; maxBlocksAhead: number };
  settleChunk: number;
  dbPath: string;
  chainMode: 'testnet' | 'mock';
  devLogin: boolean; // mock chain only: accept idToken "dev:<name>" so tests run without a Google account
}

function need(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Missing environment variable ${name} (see .env.example)`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const chainMode = env.CHAIN_MODE === 'mock' ? 'mock' : 'testnet';
  const get = chainMode === 'mock' ? (n: string) => env[n] ?? `mock-${n.toLowerCase()}` : (n: string) => need(env, n);
  return {
    port: Number(env.PORT ?? 3000), // the shared NEAR Auth testnet Auth0 client accepts http://localhost:3000 as a callback (probed 2026-10-31)
    network: 'testnet',
    // Public RPC for testnet as listed on the NEAR Auth testnet page and docs.near.org/api/rpc/providers.
    rpcUrl: env.NEAR_RPC_URL || 'https://rpc.testnet.near.org',
    gameContractId: get('GAME_CONTRACT_ID'),
    relayerAccountId: get('RELAYER_ACCOUNT_ID'),
    relayerPrivateKeys: get('RELAYER_PRIVATE_KEYS').split(',').map((s) => s.trim()).filter(Boolean),
    settlerAccountId: get('SETTLER_ACCOUNT_ID'),
    settlerPrivateKey: get('SETTLER_PRIVATE_KEY'),
    townAccountId: get('TOWN_ACCOUNT_ID'),
    merchantParentId: get('MERCHANT_PARENT_ACCOUNT_ID'),
    devTools: env.DEV_TOOLS === '1',
    playersParentId: get('PLAYERS_PARENT_ACCOUNT_ID'),
    playersParentPrivateKey: get('PLAYERS_PARENT_PRIVATE_KEY'),
    playerInitialNear: BigInt(env.PLAYER_INITIAL_YOCTO ?? '10000000000000000000000'), // 0.01 NEAR
    // Values from https://docs.auth.near.org/resources/testnet.md and protocol/concepts/auth0.md
    fastAuth: {
      domain: env.FASTAUTH_DOMAIN || 'login.testnet.fast-auth.com',
      clientId: env.FASTAUTH_CLIENT_ID || 'np8paqIpMWmNbzT4xAvOOapZBjsOpptl',
      contractId: 'fast-auth.testnet',
      mpcContractId: 'v1.signer-prod.testnet',
      mpcDomainId: 1,
    },
    explorerTxUrl: 'https://testnet.nearblocks.io/txns/',
    relay: {
      perMinute: Number(env.RELAY_MAX_PER_MINUTE ?? 30),
      perDay: Number(env.RELAY_MAX_PER_DAY ?? 2000),
      maxGasTera: 50,
      maxBlocksAhead: 200,
    },
    settleChunk: Number(env.SETTLE_CHUNK ?? 25),
    dbPath: env.DB_PATH ?? 'data/genesis-town.db',
    chainMode,
    devLogin: chainMode === 'mock' && env.DEV_LOGIN === '1',
  };
}

// Contract methods the relayer will submit for players (on-chain, player-to-player and shop ownership actions).
// Session keys themselves may call any game-contract method; the contract checks callers and deposits.
export const RELAY_METHODS = ['send_item', 'restore_contribute', 'restore_withdraw', 'claim_dividends'] as const;
