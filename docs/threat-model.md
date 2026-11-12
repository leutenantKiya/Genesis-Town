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
| Settler function-call key (the M1 minter account) | server env | submits daily settlements | per-account per-item daily gain caps, `coin` only within the faucet and money cap, each `(day, chunk)` once. The published ledger makes a dishonest settlement detectable. The key may only call `settle_day`, `register_player`, `close_shop` and `pay_dividend` on the game contract; since 2026-11-11 its gas allowance is unlimited (a capped allowance is charged the gas *attached*, and ran out), so what a leaked key can burn is bounded by the minter account's own small balance (about 0.4 NEAR) |
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

Freezing: an account with a `shortfall` record is frozen. `Game.act`, `/api/relay`, the Homeland invite route and
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

## Merchant dialogue (Claude, NEAR AI Cloud)

The player's question and the shop's current prices go to the AI provider (Claude through the Anthropic Messages API by default, or NEAR AI Cloud with its TEE inference); the answer is
shown in the chat window and nothing else. It cannot trigger a trade, change a price or touch the chain, so a prompt
injection in the question can at most make the merchant say something wrong. The system prompt tells the model to
use only the listed prices, and the UI says the answer comes from the shop's real prices. Questions are capped at
200 characters and 6 per minute per account. The provider is chosen only by the developer through env (`DIALOGUE_PROVIDER`, `DIALOGUE_MODEL`); the client cannot pick one,
and `ANTHROPIC_API_KEY` and `NEARAI_API_KEY` live only in env and never reach the browser or logs. Without a key, or on
error or timeout (8 s), the server answers with a line built from the same facts. Merchants also answer `/msg` as NPC
players; only the model's text is shown, and it never starts a trade, price change or chain action.

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

## Homeland timers and production

Homelands are off-chain and not NFTs, so there are no vouchers and no settler-key island signatures. The threats are
about the server's own rules.
- **Builder timers are server-authoritative.** `build` stores `ends_at` from the server clock and the cost is taken
  when the job starts; the client only draws progress. A job needs the one builder to be free and the Town Hall level,
  items and coin to be there; a second `build` while busy is refused. Nothing a client sends can shorten a timer.
- **Lazy production is capped.** A building accrues goods per game hour up to its capacity; `collect` computes the
  amount on the server and counts it against `caps.dailyGainPerItem`, the same cap as gathering. Waiting never yields
  more than the capacity, and spamming `collect` yields nothing extra.
- **Roles decide what a guest may do.** Guests (invited, or the owner's party) are visitors by default (walk, chat, eat); the owner can make them helpers (gather, fight, farm, collect for the owner, `assist` a running build) or builders (also start builds). A builder's build is paid from the builder's own bag and the building and its output belong to the owner; `collect` credits the owner under the owner's cap; `assist` takes only the helper's energy and can cut a job by at most `coop.assistMaxShare` of its length; demoting a builder never refunds or cancels a running job. Hire, dress, cook, stock, forage, invites and roles stay owner-only. A helper's take is capped per host per day (`coop.guestGatherPerHostDay`, counted from ledger refs `HL-<n>:`), a guest never takes a node's last charge, and drops always go to the actor under the actor's own daily cap.
- **Settlement stays registry-only.** `settle_day`, `send_item` and the Pasar accept items and `coin` only, so no
  game action can mint another kind of token.
- The v5 island methods (`buy_island`, `save_island`) remain in the contract source but the game never calls them and
  the server issues no vouchers.

## Worker bots

Hiring is an owner-only `hire` in the owner's own Homeland. The job name must be one of the configured bots, looked up with
an own-property check, so names like `constructor` cannot reach prototype keys or write broken coin rows. The price is
charged once and credited to the town, and a per-job maximum and Town Hall level apply (409 otherwise). Bots hold no items
or coin and no API lets them act outside their owner's Homeland. Their effects change only timers and amounts, and gains
still pass `checkGain`.

## Fatigue, houses and cosmetics

- **Bounded replay.** Fatigue, recovery, Restoran serving, sickness and foraging are computed lazily from stored timestamps,
  replaying at most 72 game hours, so a long-idle Homeland cannot make a request expensive and a restart resumes exactly once.
- **Own-key lookups.** Furniture, cosmetic and job names from a request are checked with `Object.hasOwn` against config, so
  `constructor` or `__proto__` answer 400 and charge nothing.
- **Ownership checks.** `dress` only works on a bot of the caller's own Homeland; dressing another player's bot answers 409
  with no coin charged. Cosmetic boosts come from config, never from the request.
- **No duplicate job target.** A second job on the same lot or furniture while one is running answers 409.
- **No free healing or beds.** Hiring without a free bed answers 409 and charges nothing; sick contractors take no job; the
  pantry never goes negative and serving takes food only from the Restoran stock, never from the player's Tas.

## Direct trade and consignment

- **Trade atomicity.** `accept` runs in one SQLite transaction that re-checks both balances (409 `<Item> kurang.`), that both
  players are in `public` within 3 tiles, and that the offer has not expired (120 s) or already been used. Items are not
  reserved at offer time, so an offerer who spent them makes the accept fail cleanly; a second accept of the same offer
  answers 409. No balance can go negative, and each receiver is capped by `caps.dailyGainPerItem`. Offers allow 4 token
  lines per side and registry tokens only.
- **Consignment.** Deposited items leave the player at once; a lot sells only when the merchant's buy price is at least the
  owner's minimum, never more than was deposited (max 50 per item), and at most 3 units per lot per game hour. The coin is
  paid within the daily faucet and `checkGain`, so offline sales cannot exceed the cap; the 5% fee goes to the town.
  Withdraw returns what is unsold.
- **Leaderboard** is read-only from the ledger; direct trades count only when they paid coin, so swapping items back and
  forth for nothing does not climb the board.

## Presence and chat

One system (`server/src/social.ts`, client `players.js`), in memory only: players seen in the last 15 s and the last 300 chat
lines. The client polls `POST /api/presence` about every 0.7 s and gets the other players of its own world and the new lines.
- **Rate limits**: one chat line per 2 s and 8 per minute per account, an IP limiter on `/api/chat` (the client address
  from the TRUST_PROXY helper), a limiter on `/api/presence`. Lines are at most 80 characters, control characters are
  removed, and a short word list is masked. Frozen accounts (`assertActive`) cannot chat or rename.
- **Text only**: names and chat are drawn with `textContent` or canvas text, never as HTML. Names are 3-16 characters
  (letters, digits, space, `_`, `-`), kept in the one `names` table with a 5-digit tag, unique as `name#tag`; chat lines and player cards carry the tag, so equal names cannot impersonate each other, and invites name a player as `name#tag`; reserved words (merchants,
  staff) and `Warga_*` are refused. Chat needs a chosen name (409 before that).
- **Per world**: public lines and positions reach only players in the same world (`public` or `HL-<n>`). `/msg name text`
  is 1:1 and also reaches a player in another world; only the two players receive it. `/block` is local to the browser.
- **Homelands**: presence and chat in `HL-<n>` need `worldFor`, which admits the owner and the invite list only.
  Everyone else gets 409, and a guest taken off the list is refused on the next poll and stops being shown to others.
- **World must match**: a poll or chat line counts only if its world is the one the server tracks for that player (worlds
  change only through the `travel` action at a portal; otherwise 409) and an outdoor tile is walkable on that world's map.
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

- **New devices**: a key that signed in on a new device is stored off-chain (`onchain = 0`). It plays, but cannot move value to other players until NEAR Auth approves it: live trade, old offers and device-transfer codes answer 409 `approve_device`, like the relayer. Adding such a key to an existing account needs a login token issued in the last 10 minutes (`iat`; dev logins have none), so a stolen old token is not enough.
