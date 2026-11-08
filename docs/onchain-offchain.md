# What goes on chain, and what doesn't

Status: design change from 2026-11-01. It replaces "every gather and every merchant trade is a transaction".

**Rule:** a NEAR transaction happens only when ownership changes in a way someone else should be able to verify.
Everything a player does alone, many times a minute, stays off chain until the daily settlement.

## Why

- **Speed.** A game action should feel instant. A testnet transaction takes about 1–2 s, and gathering happens every
  few seconds.
- **Cost.** The relayer pays gas for every player transaction. With 50 players gathering, M1's design meant
  thousands of transactions a day.
- **No added trust.** A fish you just caught, or bread you sold to an NPC merchant, involves only you and the game.
  Recording each one on chain proves nothing that the daily settlement doesn't.
- **What judges score.** "Bonus if players never notice the chain." Fewer, more meaningful transactions serve that
  better.

## The split

| Action | Where | When it is final |
| --- | --- | --- |
| Gather (fish, ore, wood), farm (till, plant, water, harvest), craft, eat, tool wear, energy | **off-chain**, server-authoritative, instant | at the next daily settlement |
| Buy from or sell to a merchant (NPC) | **off-chain** during the day, at `pricing.ts` prices | at the next daily settlement |
| Shipping box (sold to the town overnight) | **off-chain** | at the next daily settlement |
| **Daily settlement**: the net change of every item and `coin` per player and per merchant, plus a hash of the day's ledger | **on-chain**, one batch at 06:00 game time (split into chunks of up to 50 accounts per transaction) | immediately |
| Player-to-player: buy a market listing, list or cancel, send a gift | **on-chain, immediately**, from the player's settled balance | immediately |
| Shop restoration pledge, shares, dividend claim | **on-chain, immediately** | immediately |
| "Simpan sekarang" (settle my bag now) | **on-chain** on demand, limited to once per game day | immediately |
| Account creation | **on-chain**, once | immediately |
| Homeland: Town Hall upgrade, open a chunk, build, builder timers, building production, collecting | **off-chain**, server-authoritative: costs leave as ledger rows, `ends_at` timers are kept by the server, collected goods enter as ledger rows under the daily gain cap | at the next daily settlement |
| Homeland invites (by name#tag), portal travel, live positions, chat, look | **off-chain**, SQLite or server memory, never on chain. Homelands are not NFTs and cannot be sold | n/a |

One game day lasts 24 real minutes, so a player sees a settlement about every 24 minutes. Judges get a
**"Settle sekarang"** button in the Dev panel to trigger it at any time.

## How a player sees it

- **Bag (Tas)** shows two numbers per item: **settled** (on chain) and **today** (off-chain changes since the last
  settlement, marked with a small clock icon).
- **Riwayat** lists off-chain actions as "menunggu settlement" (waiting for settlement). After 06:00 they collapse
  into one entry, "Settlement hari 3", linking to the transaction, with the day's details underneath.
- **Player-to-player actions** (market, gifts, shares) appear with their own explorer link as soon as they land.

## Keeping off-chain actions verifiable

1. Every off-chain event (gather, craft, merchant trade, eat, …) is appended to that game day's **ledger** on the
   server: `{seq, account, kind, token, delta, price?, reason?, time}`.
2. At settlement the server computes each account's **net delta per token** and the **Merkle root** of the day's
   ledger.
3. `settle_day(day, chunk, entries, ledger_root)` applies the net deltas on chain:
   - mints for gains, burns for consumption, and coin moving between players and merchants;
   - the ledger root is stored and emitted in an event.
4. The full ledger for day N is published at `GET /api/ledger/{day}`. Anyone can recompute the root and check that
   the on-chain net deltas match it. Each player can fetch a Merkle proof that their own events are included.

## Limits the contract still enforces

The contract does not need to replay every event. It enforces the economy's invariants on the net result:
- the per-account, per-item daily gain cap (the M1 gather cap becomes a settlement cap);
- the daily `coin` faucet `W_day` and the money-supply throttle (economy.md §3);
- `coin` can only move between registered accounts and merchants, or be burned. Settlement can only mint `coin`
  inside the faucet cap;
- each `(day, chunk)` is applied exactly once, so a retried settlement never double-applies;
- negative deltas (spending, burning) need the settled balance to cover them. Off-chain spending is limited to
  settled balance plus today's gains.

## What changes in the M1 code

| M1 | New |
| --- | --- |
| `mint_gathered(batch, mint_id)` every 30 s or 10 items | `settle_day(day, chunk, entries, ledger_root)` once per game day, by the `town`/settlement role. `mint_gathered` is removed. |
| Riwayat: one row per gather, with a link | off-chain rows say "menunggu settlement"; one settlement row with a link |
| Gas paid per gather batch | gas paid once per day per 50 accounts, plus player-to-player actions |
| `send_item` (player to player) | unchanged: on-chain immediately, gas-free via the relayer |

## What players give up, and why it's fine

- Items gathered today are not owned on chain until 06:00. If the server crashed mid-day, unsettled items would be
  lost. A player who cares can press **Simpan sekarang**. This is stated in the README "Known limits".
- The server could cheat on an off-chain event (for example, give itself fish). The contract's daily caps and faucet
  bound the damage, and the published ledger makes it detectable. This is in the threat model.
