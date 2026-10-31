# Sources

Every contract address, endpoint, package and version comes from these pages. Read on 2026-10-31. Anything not found
in a doc is listed under "Open checks" and is not assumed.

## Hackathon

- HACKATHON.md (rules, tracks, submission API): https://nearhackathon.com/HACKATHON.md
- Games track prompt: https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/09-games.md
- Agent Economy track prompt (names the Agent API): https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/07-agents.md

## Multi token (NEP-245) and storage

- NEP-245 spec (status Final, 1 yoctoNEAR required on transfers): https://github.com/near/NEPs/blob/master/neps/nep-0245.md
- Token standards overview: https://docs.near.org/protocol/network/token-standards.md
- NEP-145 storage management: https://github.com/near/NEPs/blob/master/neps/nep-0145.md
- Storage staking (1e19 yoctoNEAR per byte, 40 extra bytes per record): https://docs.near.org/protocol/storage/storage-staking.md
- Storage cost attacks: https://docs.near.org/smart-contracts/security/storage.md
- Contract testing: https://docs.near.org/smart-contracts/testing/unit-test.md and https://docs.near.org/smart-contracts/testing/integration-test.md (uses `near-sandbox`, https://github.com/near/near-sandbox-rs)

## Login (no seed phrase)

- NEAR Auth overview: https://docs.near.org/web3-apps/tutorials/near-auth.md
- NEAR Auth docs index: https://docs.auth.near.org/llms.txt
- Testnet contracts and shared client id (`fast-auth.testnet`, `v1.signer-prod.testnet`, RPC `https://rpc.testnet.near.org`, explorer `testnet.nearblocks.io`): https://docs.auth.near.org/resources/testnet.md
- Signing transactions and delegate actions (each signature means an Auth0 popup or redirect): https://docs.auth.near.org/home/guides/sign-transactions.md
- Relayer concept: https://docs.auth.near.org/protocol/concepts/relayer.md
- Alternative considered: Privy, https://docs.near.org/web3-apps/tutorials/privy.md (needs the team's own Privy account)

## Relayer (NEP-366)

- Meta transactions: https://docs.near.org/protocol/transactions/meta-tx.md
- Building a relayer (`near-api-js` 7.4 or later): https://docs.near.org/web3-apps/tutorials/meta-transactions.md

## RPC, faucet, explorer

- RPC providers: https://docs.near.org/api/rpc/providers.md
- Faucet: https://docs.near.org/getting-started/faucet.md

## NEAR AI Cloud

- `near-ai-cloud` agent skill (OpenAI-compatible base URL `https://cloud-api.near.ai/v1`)
- Docs index: https://docs.near.ai/llms.txt

## Merchant wallets: Agent API, evaluated and not used for the core loop

- https://docs.agentsonintents.com/integration/agent-api/overview
- https://docs.agentsonintents.com/integration/agent-api/network-and-quotas (`network: mainnet`, contract `outlayer.near`)
- https://docs.agentsonintents.com/integration/agent-api/native-accounts (calls to NEAR contracts are "native methods" that the policy does not protect)

Why it is not used: the policy covers NEAR Intents balances on mainnet, while our items live in a testnet NEP-245
contract. Calling our contract would use native methods, which the policy explicitly does not cover. Merchants
therefore use testnet sub-accounts with function-call keys and caps enforced by the contract. A mainnet Intents
rebalancing stretch would need explicit approval.

## Versions seen on 2026-10-31 (pinned in M1)

| Package | Latest | Docs or skill mention |
| --- | --- | --- |
| near-sdk (crate) | 5.30.0 | skill example 5.24 |
| near-sandbox (crate) | 0.4.0 | integration-test docs use 0.3 |
| near-api-js (npm) | 7.4.0 | relayer tutorial: 7.4 or later |
| @fast-auth-near/browser-sdk | 1.4.2 | NEAR Auth docs |
| @fast-auth-near/javascript-provider | 1.4.1 | NEAR Auth docs |

## Open checks (M1, before relying on them)

1. Where the NEAR Auth testnet Auth0 tenant publishes JWT signing keys, so the server can verify a login.
2. A function-call access key signing a NEP-366 delegate action for a zero-deposit call: works end to end, and how
   the key's gas allowance is treated.
3. `env::ed25519_verify` in the pinned near-sdk version (for merchant quote signatures).
4. The testnet explorer transaction URL pattern.
5. The near-sandbox 0.3 → 0.4 changes.
6. That a NEAR Auth MPC-derived key added as a full-access key to a server-created sub-account can later sign for
   that account.
