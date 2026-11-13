# Our own NEAR Auth (fast-auth fork) on testnet: plan

> Written 2026-11-13 (deadline 2026-11-14T23:59Z). Goal: NEAR Auth login and device approval on the deployed domain,
> which the shared testnet client refuses ("Callback URL mismatch"). Steps marked **OWNER** need the owner's accounts.
> Same commit rules as the other plans. Push only after the owner says "Push it". **Timebox:** if step F5 does not
> pass by 2026-11-13 23:00 WIB, stop, unset the env vars (the game falls back to the shared client) and spend the
> time on the README and submission.

## Ringkasan (Bahasa Indonesia)

- **Apa ini:** kita memasang salinan NEAR Auth sendiri di testnet: tiga kontrak dari repo resmi Peersyst/fast-auth,
  dihubungkan ke tenant Auth0 "genesis-town" milikmu. Kamu yang menentukan domain mana yang boleh, termasuk domain
  Railway.
- **Akibatnya:** kunci pemilik (owner key) setiap pemain berubah. Kuncinya diturunkan dari kontrak dan domain login,
  dan itu sudah dicek di testnet. Hanya akun yang dibuat setelah pergantian yang bisa disetujui lewat NEAR Auth kita.
  Pemain lama tetap main seperti biasa; perangkat kedua mereka hanya bisa disetujui di localhost lewat NEAR Auth
  bersama.
- **Butuh darimu:**
  - sekitar 20 NEAR testnet;
  - pengaturan di dashboard Auth0 (nilainya kuberikan persis);
  - izin untuk meng-clone dan membangun repo fast-auth.
- **Batas waktu:** kalau sampai 13 Nov jam 23:00 WIB belum jalan, kita hentikan dan kembali ke pengaturan lama
  (cukup hapus variabel env).

## STATUS

- [ ] F0 (OWNER): testnet NEAR, Auth0 tenant domain, OK to clone and build the fork
- [ ] F1: clone at a pinned commit, build the three contracts, run their tests, measure storage
- [ ] F2 (OWNER, with exact values from F1): Auth0 tenant: APIs, Action, consent forms, connections, app URLs
- [ ] F3: deploy and configure the three contracts on testnet; verify with view calls
- [ ] F4: game reads the fork's settings from env; shared client stays the default; tests
- [ ] F5: end-to-end on localhost testnet (Railway paused): new account, second device approval, on-chain action
- [ ] F6: Railway env + redeploy; repeat F5 on the deployed domain; README and docs

## Facts (checked 2026-11-13)

| Fact | Source |
| --- | --- |
| A fork changes every owner key: the same Google `sub` gives `3hxg67…` with `fast-auth.testnet` + shared domain, `BauQFb…` with another contract, `Bf8iDS…` with another domain, `7gwrns…` with both | read-only `derived_public_key` on `v1.signer-prod.testnet`, 2026-11-13 |
| The SDK sends the payload as an authorize parameter `delegateAction` / `transaction` (byte list), scope `transaction:sign`, audience `signingAudience`; it then reads `fatxn` from the access token and uses guard id `jwt#https://<domain>/` | `client/build/node_modules/@fast-auth-near/javascript-provider/dist/index.mjs:170-280` |
| The SDK's login audience for `testnet` is fixed to `https://api.testnet.fast-auth.com` (no option to change it); `domain` and `signingAudience` can be overridden | same file, lines 5-16, 52-62 |
| NEAR Auth's own Auth0 Action: denies signing without the on-chain audience, checks canonical borsh, shows a consent form, sets `fatxn` to the byte list | Peersyst/fast-auth `packages/auth0/src/actions/authorize-app.action.js` (commit `31f80825`) |
| Action needs npm deps `@near-js/transactions` ^2.0.2, `borsh` ^2.0.0 (not 1.x), and secrets `ONCHAIN_AUDIENCE`, `DELEGATE_ACTION_FORM` (and `TRANSACTION_FORM`, `NEP413_FORM`); forms are built by `node src/forms/build.js` | `packages/auth0/package.json`, the action |
| Guard checks `aud` contains its own account id and `fatxn == sign_payload` (`Vec<u8>`) | `contracts/jwt-guards/auth0-guard/src/lib.rs:11-12, 216-223` |
| `fa` init leaves `mpc_address` = its own account: must call `set_mpc_address(v1.signer-prod.testnet)`; default `mpc_domain_id` = 1 (matches ours) | `contracts/fa/src/lib.rs:10, 56, 175` |
| Router `add_guard` needs `storage_byte_cost × (2048 + max account bytes) + 1 NEAR` deposit (~1.02 NEAR; the repo's deploy script attaches 0.1 and would fail); guard name may not contain `#` | `contracts/jwt-guard-router/src/lib.rs:8-11, 131-140` |
| Deploy order and init args: `auth0.jwt.<FA>` init `{owner, public_keys:[{n,e}]}`; `jwt.<FA>` init `{owner}`; `<FA>` init `{owner, pauser, init_guards:{"jwt":"jwt.<FA>"}}`; then router `add_guard {guard_name: "https://<tenant>/", guard_account: "auth0.jwt.<FA>"}` | `scripts/deploy.sh` (commit `31f80825`); trailing slash per javascript-provider docs |
| Rust toolchain 1.86.0, target wasm32 | `contracts/rust-toolchain.toml` |
| Our relayer calls `sign` on `cfg.fastAuth.contractId` with 300 Tgas, 1 yocto | `server/src/chain.ts:158-161` |

## F0 (OWNER)

- **Funds:** about 20 NEAR testnet on `genesistown.testnet`, from a faucet: ~15.5 for the three accounts per the
  deploy script, ~1.02 for the guard deposit, gas, margin. F1 replaces the 15.5 with the measured storage cost.
  Separately, the game contract's storage top-up (see `docs/bots-login-plan.md` step 0).
- **Domain:** the Auth0 tenant domain, e.g. `genesis-town.us.auth0.com`. Shown in Auth0 → Settings.
- **Permission** to clone https://github.com/Peersyst/fast-auth (the source NEAR Auth's own docs point to) into
  `~/Documents/fast-auth-fork`, outside this repo, and to build it.

## F1: build

```
git clone https://github.com/Peersyst/fast-auth ~/Documents/fast-auth-fork && cd ~/Documents/fast-auth-fork && git checkout 31f80825587ae2e5f43c21c2f23f29fc05ec7cc1
```

- Build `contracts/fa`, `contracts/jwt-guard-router` and `contracts/jwt-guards/auth0-guard` with `cargo near build`
  (toolchain 1.86.0), then run `cargo test` in each.
- Write down the wasm sizes. Storage per account ≈ wasm bytes × 1e19 yocto + state, which gives the real funding
  amounts.
- Read `contracts/fa/src/lib.rs` `sign`: deposit, gas, what it returns. Compare with `server/src/newdevice.ts`, which
  must accept the fork's result the same way.

## F2 (OWNER): Auth0 tenant "genesis-town"

Exact values (`<FA>` = `fa.genesistown.testnet`):

1. **Application (Single-Page App):**
   - Allowed Callback URLs, Logout URLs and Web Origins: `http://localhost:3000` and the deployed origin.
   - Note the Client ID; it is public.
2. **API "login":** identifier `https://api.testnet.fast-auth.com`, signing RS256. It must be exactly this: the SDK
   asks for it on `testnet` and cannot be told otherwise.
3. **API "signing":** identifier `auth0.jwt.<FA>`, signing RS256, permission `transaction:sign`, token lifetime 60 s.
4. **Connections:** Google (social) and Username-Password (email), both enabled for the app.
5. **Action (Login / Post Login):**
   - Code = `authorize-app.action.js` at the pinned commit.
   - Dependencies: `@near-js/transactions` and `borsh` at the exact versions in the fork's lockfile (F1 reads them).
   - Secret `ONCHAIN_AUDIENCE` = `auth0.jwt.<FA>`.
   - Forms: build them (`node packages/auth0/src/forms/build.js`), import into Auth0 Forms, and put each form id into
     `DELEGATE_ACTION_FORM`, `TRANSACTION_FORM` and `NEP413_FORM`.
   - Deploy the Action and add it to the Login flow.
   - **If the plan has no Forms:** use the same Action without `api.prompt.render`. The login popup is then the only
     confirmation, with no screen showing what is signed. That is the owner's decision; we only sign delegate actions
     that add a game-only key, but the screen is a real safety feature.
6. **Signing keys:** `n` and `e` from `https://<tenant>/.well-known/jwks.json`. Public; give them to F3.

## F3: deploy (testnet transactions, standing OK; owner key of `genesistown.testnet` from the local keychain)

1. Create `fa.genesistown.testnet`, then `jwt.fa.genesistown.testnet` and `auth0.jwt.fa.genesistown.testnet`, funded
   with the amounts from F1.
2. Deploy `auth0_guard.wasm` → init `{owner: genesistown.testnet, public_keys: [{n, e}]}`.
3. Deploy `jwt_guard_router.wasm` → init `{owner}`.
4. Deploy `fa.wasm` → init `{owner, pauser: owner, init_guards: {"jwt": "jwt.fa.genesistown.testnet"}}`.
5. `fa.set_mpc_address {mpc_address: "v1.signer-prod.testnet"}`. The script forgets this; without it signing fails.
6. `jwt.fa….add_guard {guard_name: "https://<tenant>/", guard_account: "auth0.jwt.fa.genesistown.testnet"}` with
   ~1.02 NEAR.
7. **Verify with views:** `fa.mpc_address`, `fa.mpc_domain_id` (= 1), `fa.get_guard("jwt")`, router guard lookup,
   and `v1.signer-prod.testnet.derived_public_key` for a test path with predecessor `fa.genesistown.testnet`.

## F4: game settings (code, tests)

- **New env:**
  - `FASTAUTH_CONTRACT_ID` (today hard-coded `fast-auth.testnet` in `server/src/config.ts`);
  - `FASTAUTH_SIGNING_AUDIENCE`;
  - the existing `FASTAUTH_DOMAIN` and `FASTAUTH_CLIENT_ID`.
  - All unset means the shared client, unchanged.
- **Where they go:**
  - `/api/config` `fastAuth` sends `domain` and `signingAudience`; `chain.js` passes them to every
    `new JavascriptProvider({network:'testnet', clientId, domain, signingAudience})` (login, newDevice,
    approveDevice, signOut).
  - `auth0Verifier` already derives the issuer from `domain`; `derivedOwnerKey` already uses `contractId` and
    `domain`. New accounts therefore get fork owner keys with no other change.
- **Existing players:**
  - their stored `owner_pk` is from the shared client, so the fork's MPC signature would not match in
    `newdevice.ts`;
  - `/api/auth/register` returns `ownerAuth: 'shared' | 'fork'` (compare `owner_pk` with the fork-derived key), and
    the client hides fork approval for `shared` players with a clear line ("approve on the first device or on
    localhost");
  - supporting both providers per player is possible later, but not before the deadline.
- **Tests:** config parsing, `/api/config`, `ownerAuth` for a shared and a fork player.

## F5: end-to-end on localhost (pause Railway first: one testnet server per contract)

1. Set the env locally (`NEAR_AUTH_ORIGINS=http://localhost:3000`) and run `npm run dev`.
2. Sign in with NEAR Auth (fork) as a **new** Google user. Check that the account's full-access key equals the
   fork-derived key (view `view_access_key_list`).
3. Second browser, same user: on-chain action → "Approve this device" → popup on our tenant → consent form → back.
   The relayer calls `fa.sign`, the MPC signs, `/api/auth/add-key` adds the key, and the on-chain action goes
   through.
4. Check costs: settler and relayer balances before and after.

## F6: deployed

- Railway env: the four `FASTAUTH_*` values and `NEAR_AUTH_ORIGINS=<deployed origin>,http://localhost:3000`. Redeploy
  and repeat F5 there.
- README: NEAR Auth now works on the deployed demo for accounts created after the switch. Older accounts approve
  second devices on localhost.
- CLAUDE.md, `docs/deploy.md`, `.env.example`, threat model (we now run our own guard; its owner key is
  `genesistown.testnet`).

## Rollback

Unset `FASTAUTH_CONTRACT_ID`, `FASTAUTH_SIGNING_AUDIENCE`, `FASTAUTH_DOMAIN` and `FASTAUTH_CLIENT_ID` and remove the
deployed origin from `NEAR_AUTH_ORIGINS`: everything returns to the shared client.

Accounts created while the fork was active keep fork owner keys. They play normally, but second-device approval would
again need the fork. Keep the fork contracts deployed (they cost nothing to keep).
