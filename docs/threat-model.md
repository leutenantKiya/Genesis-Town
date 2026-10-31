# Threat model

Status: design (M0). Each threat lists its mitigation and the test that will prove it (built in M1–M4). Testnet
assets have no value, but the design assumes they might, so nothing here depends on "it's only testnet".

## Assets

1. Player item and coin balances in the game contract.
2. The money-supply invariant (no unbounded minting).
3. NEAR held by the relayer and the account-creation account (pays gas and account storage).
4. Server keys: relayer, minter, town, merchant function-call keys, merchant quote keys, account creator.
5. Player identity (Auth0 login) and the browser session key.

## Keys

| Key | Where | If stolen | Mitigation |
| --- | --- | --- | --- |
| Owner (contract admin) | dev machine keychain only, never on the server | config change, role change | not on the server. Config changes emit events. `pause` exists |
| Relayer full-access keys | server env | thief spends the relayer's NEAR | keep a small balance and top up manually, daily spend alarm, rotate keys |
| Account-creator key | server env | creates junk accounts, spends the float | small float, account creation rate limited per Auth0 identity, per IP, and globally per day |
| Minter function-call key | server env | mints gathered items | per-account and per-item daily mint caps in the contract. Single-use `mint_id`. Cannot mint `coin` |
| Town function-call key | server env | pays coins to merchants | coins limited by the daily faucet `W_day`, settlement once per day, starter grants from existing treasury coins only |
| Merchant quote keys | server env | signs bad quotes | quotes bound to one player, 60 s expiry, single-use nonce. Per-merchant daily coin-out cap. Rotation is owner-only |
| Player session key | browser localStorage (M1). M4 moves it to a non-extractable WebCrypto Ed25519 key in IndexedDB | XSS or malware trades the player's items | function-call key limited to game methods on the game contract, so it can't move NEAR or call other contracts. Game methods have per-day limits. The player can revoke it with the full-access key |

Secrets live only in environment variables. `.env` is git-ignored, and `.env.example` holds names only. Before any
push we scan the whole history with `gitleaks` (or an equivalent; the tool is chosen in M4), and the scan result goes
in the M5 checklist.

## Session keys vs NEP-245's 1-yoctoNEAR rule

NEP-245 requires 1 yoctoNEAR on transfers so that a function-call key cannot move tokens without the user. We
deliberately allow the session key to move game items through **game methods only**, because that is what "no
popups" requires. The standard `mt_transfer` keeps the 1-yocto rule. Limits on game methods:
- `sell_to_merchant` needs a merchant-signed quote naming this player;
- `buy_listing` spends at most the listing price;
- per account per day, a coin-out cap and a listings cap (5 open).

So a stolen session key can at worst sell the player's goods at fair quotes or make bounded market moves. It can
never send items to an arbitrary account. There is no free-form `gift` method; gifts go through a listing priced at 0
coins and are capped.

## Relayer abuse

- Only delegate actions whose receiver is the game contract, with one FunctionCall whose method is on the allowlist,
  zero deposit, and gas ≤ the per-method cap.
- Rate limits: per account (e.g. 30 actions/min, 2,000/day), per IP, and globally. Limits return HTTP 429 and the
  client shows "Pelan-pelan…" ("Slow down…").
- The delegate's `max_block_height` must be close (the docs' example uses 120 blocks), and a delegate is only
  submitted once (keyed by its hash).
- Load test in M4: send above-limit traffic and check that it is rejected and the relayer's spend stays within budget.

## Price manipulation

- Prices move at most ±10% per tick, inside [0.25, 4] × base, using decayed volumes. One big dump can't crash a price
  instantly, and a pump fades.
- A lot quote prices its own impact (fs at s ± q/2). Each quote covers at most 10 units. Merchants have a daily buy
  cap of 2 × target per item.
- Quotes expire after 60 s and are single use, so you can't hold a quote and wait for the price to move.
- Player-market trades don't count toward merchant demand, so off-merchant deals can't move merchant prices.

## Bots and farming

- Gathering is server-authorised: node charges are shared and respawn, there's a per-account action rate, and the
  server checks the player's position and timing against the map (the same BFS reachability the prototype uses).
- Account creation is gated by Auth0 identity and rate limits. One identity maps to one account.
- Daily mint caps in the contract bound what any account can farm even if the server is fooled.

## Wash trading

- 5% fee burned on every player-market sale.
- Player-market volume never feeds merchant pricing.
- Self-trades (buyer == seller) are rejected by the contract. Trades between two accounts of the same Auth0 identity
  are impossible, because one identity has one account.

## Double settlement (retries)

- Mints carry a `mint_id` that the contract stores as used, so a retry is a no-op.
- Trades carry a quote nonce, stored as used.
- `settle_day(day)` succeeds once per day number.
- The relayer stores the delegate hash, so a duplicate post returns the first result.
- Server tests (M4): replay each call and check no balance changes twice.

## Storage cost attacks

Players can't attach deposits (function-call keys), so the contract pays for their storage. Growth is bounded by:
storage registered only by the server at account creation, max 5 listings per account, fixed-size per-account records,
and quote nonces pruned after expiry. The `minter`/`town` accounts fund storage top-ups. This follows the NEAR docs'
guidance to bound state growth that users don't pay for.

## Server compromise (worst case)

An attacker with every server key could: spend relayer NEAR; mint gathered items up to the daily caps; pay up to
`W_day` new coins per day; and sign quotes up to the merchants' daily caps. They could **not**: mint `coin` directly;
exceed the money cap; move player items to arbitrary accounts; or change the config (owner key is not on the server).
Recovery: the owner calls `pause`, rotates the role keys, and unpauses.

## Out of scope / cut

- **Casino**: switched off. If it ever comes back, it uses an off-chain play currency that has no value and can't be
  transferred, never `coin`.
- **Theft, combat, police**: switched off. If they come back, they never touch on-chain balances.
- **NEAR Intents and mainnet**: not in the build. Any stretch use needs explicit approval, tiny amounts, separate dev
  accounts, and dry-run quotes (HACKATHON.md Q-007).
