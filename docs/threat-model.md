# Threat model

Status: design (M0). Each threat lists its mitigation and the test that will prove it (built in M1–M4). Testnet
assets have no value, but the design assumes they might, so nothing here depends on "it's only testnet".

## Assets

1. Player item and coin balances in the game contract.
2. The money-supply invariant (no unbounded minting).
3. NEAR held by the relayer and the account-creation account (pays gas and account storage).
4. Server keys: relayer, settler (the M1 minter account), town, merchant function-call keys, account creator.
5. Player identity (Auth0 login) and the browser session key.

## Keys

| Key | Where | If stolen | Mitigation |
| --- | --- | --- | --- |
| Owner (contract admin) | dev machine keychain only, never on the server | config change, role change | not on the server. Config changes emit events. `pause` exists |
| Relayer full-access keys | server env | thief spends the relayer's NEAR | keep a small balance and top up manually, daily spend alarm, rotate keys |
| Account-creator key | server env | creates junk accounts, spends the float | small float, account creation rate limited per Auth0 identity, per IP, and globally per day |
| Settler function-call key (the M1 minter account) | server env | submits daily settlements | per-account per-item daily gain caps, `coin` only within the faucet and money cap, each `(day, chunk)` once. The published ledger makes a dishonest settlement detectable |
| Town function-call key | server env | pays coins to merchants | coins limited by the daily faucet `W_day`, settlement once per day, starter grants from existing treasury coins only |
| Player session key | browser localStorage (M1). M4 moves it to a non-extractable WebCrypto Ed25519 key in IndexedDB | XSS or malware trades the player's items | function-call key limited to game methods on the game contract, so it can't move NEAR or call other contracts. Game methods have per-day limits. The player can revoke it with the full-access key |

Secrets live only in environment variables. `.env` is git-ignored, and `.env.example` holds names only. Before any
push we scan the whole history with `gitleaks` (or an equivalent; the tool is chosen in M4), and the scan result goes
in the M5 checklist.

## Session keys vs NEP-245's 1-yoctoNEAR rule

NEP-245 requires 1 yoctoNEAR on transfers so that a function-call key cannot move tokens without the user. We
deliberately allow the session key to move game items through **game methods only**, because that is what "no
popups" requires. The standard `mt_transfer` keeps the 1-yocto rule. Limits on game methods:
- `send_item` is capped per call and per day, and only reaches registered players;
- `buy_listing` spends at most the listing price;
- per account per day, a coin-out cap and a listings cap (5 open).

So a stolen session key can at worst send up to the daily `send_item` cap to other registered players, or make
bounded market moves. It cannot move NEAR, call other contracts, or use `mt_transfer` (no deposit possible).

From M2, session keys allow any method on the game contract (an empty method list), so each player method must be
safe for a session key on its own: caps, no deposits, and caller checks. A unit test asserts this for every player
method.

## Off-chain ledger (server trust)

Gathering, farming, crafting and merchant trades are off-chain until the 06:00 settlement
([onchain-offchain.md](onchain-offchain.md)). The server is trusted for those events, as in any online game. The
limits:
- the contract caps each account's net daily gain per item, and the total new `coin` per day;
- the day's full ledger is published with its Merkle root stored on chain, so a settlement that doesn't match its
  ledger is publicly detectable;
- unsettled items exist only on the server. If the server lost its database mid-day, those items would be lost;
  players can settle their own bag early ("Simpan sekarang", once per game day).

## Relayer abuse

- Only delegate actions whose receiver is the game contract, with one FunctionCall whose method is on the allowlist,
  zero deposit, and gas ≤ the per-method cap.
- Rate limits: per account (e.g. 30 actions/min, 2,000/day), per IP, and globally. Limits return HTTP 429 and the
  client shows "Pelan-pelan…" ("Slow down…").
- The delegate's `max_block_height` must be close (the docs' example uses 120 blocks), and a delegate is only
  submitted once (keyed by its hash).
- Load test in M4: send above-limit traffic and check that it is rejected and the relayer's spend stays within budget.

## Spending items that are still off-chain

On-chain actions (send, list, pledge, buy) spend the *settled* balance right away, while today's off-chain play is
only written at 06:00. Without a check, a player could sell 3 bread to a merchant off-chain and also list the same 3
bread on chain; the 06:00 settlement would then try to debit bread that is gone and the chunk would fail.
The relayer's spend guard (`server/src/spend.ts`) re-reads the player's on-chain balance before relaying and
requires, per item, both: on-chain balance ≥ amount, and on-chain balance + today's off-chain change ≥ amount.
Guarded relays of one account run one after another, and while one is in flight its amounts are reserved in memory
(`GameStore.reserve`): off-chain play (sell, buy, craft, eat, ship, upgrades) sees the balance minus the reservation, so
`Game.act` cannot spend the same fish in the gap before the relay lands. The reservation is released when the relay
finishes, success or not.

The guard only covers what goes through the relayer. The player owns a full-access key, so they can also call
`mt_transfer` or `storage_unregister` directly. See "Settlement shortfall" below.

## Settlement shortfall (chain balance below the day's debit)

What happens: a player moves settled tokens away on chain (or unregisters), after spending them off-chain. The day's
settlement then holds a debit the chain cannot cover (the contract panics the whole chunk, blocking the day for
everyone) or an entry for an unregistered account (skipped by the contract, so the counterpart's side would apply
alone). Before every chunk submit, `Settlement.preflight` reads each account's registration and chain balances,
and: drops all entries of an unregistered account, clamps a debit to what the account holds, and clamps a credit above
the daily gain cap (defensive). The change is written back to the persisted plan (only for the chunk not yet applied),
so retries use it, and the check runs again on every attempt (a race between pre-flight and submit fails the chunk,
backs off, and is clamped on the retry). Every change is a row in `shortfalls` (`day, chunk, account, token, wanted,
applied`, signed deltas) and one log line; ledger rows are still marked settled as the record of what happened.

What is bounded: the day always completes. The loss is bounded by what the player held: the counterpart (a merchant) keeps
what it bought. Coin is the soft spot: a clamped coin debit lets the counterpart receive coin nobody paid; that coin is
minted under the contract's daily faucet and money-supply throttle, and it is visible as a coin row in `shortfalls`.
The player side gets nothing for it: when an account has a clamped debit in a chunk, `preflight` also withholds all of
that account's credits in the chunk (each recorded as a `withheld` row, wanted = the credit, applied = 0, one log line),
so selling settled items off-chain and then moving them away on chain no longer pays. Merchants and the town are never
withheld.

Freezing: an account with a `shortfall` record is frozen. `Game.act`, `/api/relay`, the island voucher/invite routes and
chat answer 403 `Akun ini dibekukan karena saldo on-chain tidak cocok dengan permainan. Hubungi pengelola.` The operator
lifts it with `POST /api/dev/unfreeze {account}` (DEV_TOOLS, local only). `cap_clamp` records do not freeze.
Monster bonuses and drops check the daily gain cap before they are written, so they cannot cause a cap clamp.

## The shared map and town projects

- The map comes from a public generator and a public seed, so anyone can rebuild it and check where things are.
- Gathering is refused unless the tile really is water, rock or tree, lies in an open area, and the player stands on
  a walkable tile right next to it (`worldmap.ts`, `Positions`).
- Project pledges follow the restoration rules: no deposit, from settled balances only (spend guard), held by the
  contract, withdrawable until complete, then burned. Only the owner creates projects; the server only reads `done`
  to open an area, so it cannot fake a finished project without the chain.
- Opening an area does not move anything already built (the generator reuses the closed map's attempt), so the
  ledger's tile coordinates stay valid.

## Night monsters

Every roll (whether a monster appears, each hit) happens on the server, and a pending encounter blocks every other
action, so a modified client cannot skip a fight or gather past it. A knock-out only blocks actions until 06:00; it
never removes items or coins. Wins add one item through the normal ledger, so the contract's daily gain caps still
apply. Pos Ronda is read from the chain (`done`), like the bridge.

## Merchant dialogue (NEAR AI Cloud)

The player's question and the shop's current prices go to NEAR AI Cloud (private inference in a TEE); the answer is
shown in the chat window and nothing else. It cannot trigger a trade, change a price or touch the chain, so a prompt
injection in the question can at most make the merchant say something wrong. The system prompt tells the model to
use only the listed prices, and the UI says the answer comes from the shop's real prices. Questions are capped at
200 characters and 6 per minute per account. Without `NEARAI_API_KEY`, or on error or timeout (8 s), the server
answers with a line built from the same facts.

## New device (adding a session key)

A returning player on a browser without their session key adds a new one with their own NEAR Auth key
(`server/src/newdevice.ts`): the browser builds a delegate action AddKey(new key, function-call access to the game
contract only, no methods named) on the player's account; the player approves it in one NEAR Auth popup; the
relayer calls `sign` on `fast-auth.testnet` with that JWT and submits the signed delegate. The server refuses
anything else: another account, another receiver, named methods, more than one action, a key that is already in use,
a long expiry, or a delegate not signed by the owner key stored when the account was created. The MPC signature is
checked against that owner key before anything is submitted. Each attempt costs the relayer a `sign` call, so it is
limited per IP. The server can never add a key by itself: it holds no key of any player account.
Run live on testnet on 2026-11-03 (AddKey relayed: EQCu9GX2mNWT8YCJVehadGUGjYa1iBa1nY6hmdVdeMr6).

## Session keys and shared browsers

A session key belongs to exactly one account. If a second person signs in on the same browser, the server refuses
the first person's key for the new account and the client makes a fresh key. (Before this fix the new account was
created without a usable key.)

## Price manipulation

- Prices move at most ±10% per tick, inside [0.25, 4] × base, using decayed volumes. One big dump can't crash a price
  instantly, and a pump fades.
- A lot quote prices its own impact (fs at s ± q/2). Each quote covers at most 10 units. Merchants have a daily buy
  cap of 2 × target per item.
- A price shown to the player is valid for 60 s on the server, so you can't hold an old price and wait for the market
  to move.
- Player-market trades don't count toward merchant demand, so off-merchant deals can't move merchant prices.

## Bots and farming

- Gathering is server-authorised: node charges are shared and respawn, there's a per-account action rate, and the
  server checks the player's position against the shared map (M4): every action carries where the player stands; the
  spot must be walkable and in an open area, and the move since the last report must fit the walking speed (one tile
  per 0.15 s, checked at 8 tiles/s plus slack). Gathering needs the tile right next to the player, trading needs a
  market stall nearby, farming the plot, crafting and shipping the player's own house. A modified client can still
  walk anywhere a player could walk; it cannot act from across the map.

## Off-chain requests (who is acting)

Since M4 every off-chain request of a signed-in player is signed with that player's session key
(`server/src/reqauth.ts`): method, path with query, timestamp and body hash; ±2 minutes; each signature accepted
once. The key must be the session key the server registered for that account. Before M4 the server trusted an
`x-account-id` header, so anyone who knew an account name could gather, sell or ship as that player off-chain.
A stolen session key still allows play as that player, and on chain only what the relayer allowlist and the
contract permit; it can never move NEAR or add keys.
- Account creation is gated by Auth0 identity and rate limits. One identity maps to one account.
- Daily mint caps in the contract bound what any account can farm even if the server is fooled.

## Wash trading

- 5% fee burned on every player-market sale (`market_fee_bps` = 500, burned from the coin supply).
- Player-market volume never feeds merchant pricing.
- Self-trades (buyer == seller) are rejected by the contract. Trades between two accounts of the same Auth0 identity
  are impossible, because one identity has one account.

## Double settlement (retries)

- Each settlement chunk is keyed by `(day, chunk)` and stored as applied, so a retry is a no-op. (M1's `mint_id`
  did the same for gather batches.)
- Merchant trades are ledger entries with a sequence number; settlement nets them once.
- `settle_day(day)` succeeds once per day number.
- The relayer stores the delegate hash, so a duplicate post returns the first result.
- Server tests (M4): replay each call and check no balance changes twice.

## Storage cost attacks

Players can't attach deposits (function-call keys), so the contract pays for their storage. Growth is bounded by:
storage registered only by the server at account creation, max 5 listings per account, fixed-size per-account records,
and applied settlement keys kept only as a compact per-day bitmap. The `minter`/`town` accounts fund storage top-ups. This follows the NEAR docs'
guidance to bound state growth that users don't pay for.

## Island vouchers (buy and Save World)

Buying an island and Save World are player calls (`buy_island`, `save_island`, session key, no deposit) that the
contract accepts only with an ed25519 signature from the server's voucher key (`voucher_pk`, the settler's public key;
the owner can replace it with `set_voucher_key`). The signed message names the contract, island id, buyer or owner,
price or `from_version`, the spec and an expiry (10 minutes).
- **A leaked voucher** is useless to anyone else: the message binds the account that must call. The holder can submit
  it only before it expires.
- **Replay**: `buy_island` fails when the island id exists, so a voucher buys once; `save_island` requires
  `from_version` to equal the current version, and every save increments it.
- **Forged vouchers** need the settler key. If it leaks, an attacker can buy islands only with coin they burn, and can
  save only what the checks allow (same seed, levels never lower). `set_voucher_key` rotates it.
- **Cost is real**: the server issues a buy voucher only if the account's settled coin (and today's coin) covers the
  price, and the contract moves and burns that coin in the same call. A Save World voucher carries only upgrades whose
  ledger rows are in a finished settlement, so the NFT never shows an unpaid upgrade.
- The server never trusts its own copy of the owner: vouchers and syncs read `get_island` from the chain.

## Settlement cannot mint islands

`settle_day`, `send_item` and the Pasar (`list_item`) validate tokens with `require_token`, which knows only the
registry (items and `coin`). Island ids (`IS-...`) are rejected there, and `migrate` refuses new registry tokens whose
id starts with `IS-`. Island tokens are created only inside `buy_island` and `save_island`, and moved only by
`mt_transfer` (1 yocto, a real wallet). So islands cannot be listed in the Pasar yet *(planned)*. Whoever receives the
current version becomes the owner; `save_island` requires the caller to be the owner, and old versions have supply 0.

## Island scan in `storage_unregister`

`storage_unregister` refuses accounts that own an island by scanning `island_ids` (every island ever bought). The list
grows only through server-issued vouchers (8 offers in the config), never through player input, so the scan is bounded.
*(Planned, phase 2: a per-owner counter instead of a scan, if islands grow to hundreds.)*

## Presence and chat

Live players and chat are server memory only: positions seen in the last 10 s and the last 50 chat lines per world.
- **Rate limits**: one chat line per 2 s per account, an IP limiter on `/api/chat`, a limiter on `/api/pos`, at most
  4 open streams per account. Messages are at most 80 characters, control characters are removed, and a short word list
  is masked.
- **Text only**: names and chat are drawn with `textContent`, never as HTML. Names are 3-16 characters (letters, digits,
  space, `_`, `-`) and unique.
- **Private islands**: streaming, chatting and appearing in `IS-<id>` need `worldFor`, which admits the owner and the
  invite list only. Everyone else gets 409.
- **World must match**: a position report counts only if its world is the one the server tracks for that player
  (worlds change only through the `travel` action at a dock) and the tile is walkable on that world's map. Claiming
  another world, or a tile outside the map, is ignored.
- Requests are signed with the session key like other requests; chat needs a chosen display name.
- Not defended: many accounts spamming (each needs a login) and moderation beyond the word list. Players can mute
  others locally.

## Server compromise (worst case)

An attacker with every server key could: spend relayer NEAR; settle fake gains up to the daily caps (detectable from
the published ledger); and pay up to `W_day` new coins per day. They could **not**: mint `coin` directly;
exceed the money cap; move player items to arbitrary accounts; or change the config (owner key is not on the server).
Recovery: the owner calls `pause`, rotates the role keys, and unpauses.

## Out of scope / cut

- **Casino**: switched off. If it ever comes back, it uses an off-chain play currency that has no value and can't be
  transferred, never `coin`.
- **Theft, combat, police**: switched off. If they come back, they never touch on-chain balances.
- **NEAR Intents and mainnet**: not in the build. Any stretch use needs explicit approval, tiny amounts, separate dev
  accounts, and dry-run quotes (HACKATHON.md Q-007).
