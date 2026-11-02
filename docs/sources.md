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
- Testnet RPC `https://test.rpc.fastnear.com` (FastNear, public, free tier), chosen from the providers table on
  2026-11-02 after `rpc.testnet.near.org` started answering HTTP 429 with a deprecation notice: https://docs.near.org/api/rpc/providers
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
| near-sdk (crate) | 5.30.0 | skill example 5.24. The `cargo near new` template pins `5.29` (resolves to 5.30.0) |
| cargo-near | 0.22.0 | official GitHub release binary, SHA-256 checked |
| near-sandbox (crate) | 0.4.0 | integration-test docs use 0.3. We use the `cargo near new` template's pin, `0.3.12` (resolves to 0.3.16, nearcore 2.13.4), together with `near-api 0.8` |
| near-api-js (npm) | 7.4.0 | relayer tutorial: 7.4 or later |
| @fast-auth-near/browser-sdk | 1.4.2 | NEAR Auth docs |
| @fast-auth-near/javascript-provider | 1.4.1 | NEAR Auth docs |

## Open checks from M0, resolved in M1 (2026-10-31)

1. **Server-side login verification: resolved.** OIDC discovery at
   `https://login.testnet.fast-auth.com/.well-known/openid-configuration` (HTTP 200) gives issuer
   `https://login.testnet.fast-auth.com/`, `jwks_uri` `https://login.testnet.fast-auth.com/.well-known/jwks.json`,
   and RS256 is supported. The server verifies the login id token against that JWKS (aud = client id) and reads `sub`.
   - The player's key is derived at path `jwt#https://<domain>/#<sub>` (guard id `jwt#https://<domain>/`), per
     https://docs.auth.near.org/protocol/concepts/auth0.md and
     https://docs.auth.near.org/protocol/contracts/fast-auth.md.
   - The server computes it with the view call `derived_public_key({path, predecessor: "fast-auth.testnet",
     domain_id: 1})` on `v1.signer-prod.testnet`. Domain id 1 is what `fast-auth.testnet.mpc_domain_id()` returns.
     Tested: it returns an `ed25519:` key.
   - Still to test end to end: that this matches the key the browser SDK's `getPublicKey()` returns.
2. **Function-call keys in delegate actions: resolved by the docs.** Meta Transactions, "Function Call Access Keys in
   Meta Transactions": the key is checked against the receiver and methods, and its allowance is not checked
   because the relayer pays. Since protocol 87 the inner delegate must be signed with a regular access key, not a
   gas key. Still to test end to end on testnet.
3. **`env::ed25519_verify`: resolved.** It exists in near-sdk 5.30.0:
   `ed25519_verify(&[u8;64], impl AsRef<[u8]>, &[u8;32]) -> bool`
   (https://docs.rs/near-sdk/5.30.0/near_sdk/env/fn.ed25519_verify.html).
4. **Explorer transaction URL: found in the docs.** `https://testnet.nearblocks.io/txns/<hash>` is used throughout
   https://docs.near.org/llms-full.txt. The site returns 403 to scripted requests, so it will be checked in a browser
   with our first transaction.
5. **near-sandbox 0.4.0 (2026-10-26): resolved.** The changelog lists nearcore 2.14.0 and a bin-path fix, with no API
   change listed. Pinned to 0.4.0, and compile-tested once Rust is installed.
6. **MPC key as full-access key on another account: resolved by the docs.**
   https://docs.near.org/chain-abstraction/chain-signatures/tutorials/controlling-near-accounts/1-setup.md shows
   deriving an MPC public key, adding it as a full-access key, then signing for that account.

Also found: the shared testnet Auth0 client accepts `http://localhost:3000` as a callback origin. Probed on
2026-10-31: `localhost:3000` redirects to the login page, while `localhost:8787`, `localhost:5173`, `127.0.0.1:8787`
and `example.com` return 403. So the local server runs on port 3000. A hosted demo would need its own Auth0
client, or an origin that the shared client allows.

Also found: the Auth0 testnet defaults (domain `login.testnet.fast-auth.com`, signing audience
`auth0.jwt.fast-auth.testnet`, client id) are on https://docs.auth.near.org/protocol/concepts/auth0.md.
