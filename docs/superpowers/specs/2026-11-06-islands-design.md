> Superseded by the Homeland design (2026-11-08): see `2026-11-08-homeland-design.md`. Kept as history.

# Islands: Public Island, Private Islands as versioned NFTs, upgrades, mining shaft

Status: design, 2026-11-06. Phases 1a and 1b are built (branch `islands`, see "As built"); contract v5 is not deployed to testnet yet. Phase 1c is not built. Owner: OyenCar. Calls marked **(Claude's call)** were not discussed with
the owner and may be changed during review.

## Intent

Give players a long-term goal that is also a real on-chain asset. Everyone starts on the shared **Public Island**
(today's village), earns there by gathering, mining and trading, and works toward buying a **Private Island** of their
own. The island becomes an NFT the moment it is bought, and every saved upgrade replaces that NFT with a new version,
so the token always shows what the island really is. Rare resources from a **mining shaft** that players share on the
Public Island feed the upgrades, which keeps the Public Island busy and social even after players own islands.

This fits the project's rule: on chain only when ownership changes in a way others should verify (buying an island,
saving its upgrades, selling it). Everything a player does on their island minute to minute stays off chain.

## Goals

1. New players start on the Public Island (the existing seeded village) and can travel between islands by boat.
2. A broker NPC in the Kantor Makelar sells Private Islands. While the broker holds an island it is only off-chain
   data: no token exists.
3. **Buying is the trigger.** On purchase the contract mints a new island NFT with the bought spec to the broker and
   transfers it to the buyer in the same call. The chain shows both steps: mint to broker, broker → player.
4. Token id `IS-<id>-<version>` (e.g. `IS-1-1`). `<id>` is unique per island, `<version>` starts at 1.
5. Upgrades (e.g. soil fertility) change the island in the game at once, off chain. **Save World** writes them on
   chain: the current version is returned to the system and the player receives the next version, in one atomic call.
   A player can never hold two versions of the same island, or none in between.
6. Private Islands are **invite-only**: the owner chooses who may visit.
7. The Public Island gets a **mining shaft** with rare resources that players have to share.
8. An island NFT can be sold to another player.
9. Players **see each other live** in the same world (Public Island, an island they visit, the shaft) and talk with
   **chat bubbles** above their character.
10. Public and Private Islands have **different roles**, so the Public Island never empties (like the island
    generators vs. the center in Bedwars): a Private Island only yields basic and mid-tier resources; the top tier,
    the merchants, the Pasar and the broker exist only on the Public Island.

## Non-goals (for now)

- More than one Public Island (the design allows it later; phase 1 has one).
- Selling islands on outside NFT marketplaces (Mintbase, Paras). Phase 1 sells in the in-game Pasar.
- Building/decorating freely on islands (placing houses, fences). Phase 1 islands are generated from a seed plus
  their upgrade levels.
- Final decision on agent wallets (see "Agent wallets", left open on purpose).

## Anti-goals (failure even if it works)

- A player ends up with two versions of one island, or an old version stays transferable.
- The NFT shows an upgrade whose cost is not final on chain.
- Wallet popups or gas prompts during normal island play (buying and saving are signed with the session key and
  relayed gas-free, like the market today).
- The Public Island empties once players own islands (the shaft and rare resources exist to prevent this).
- The coin supply grows because of islands (island sales and upgrades must be coin and goods **sinks**).

## Constraints

- Hackathon ends **2026-11-14**; M4.5 Online is due 2026-11-07 and M5 (video, submission) after it. Islands must not
  block those. See "Phases".
- Contract: NEP-245 multi-token contract `game.genesistown.testnet`, currently v4. The token list is fixed at `new`
  (`tokens: Vec<TokenMeta>`), so new tokens (islands, rare ores) need **v5 with `migrate`**, keeping all state, like
  v3 and v4. New storage keys are appended to `StorageKey`.
- Session keys are function-call keys: they cannot attach deposits, so island methods take zero deposit (like
  `buy_listing`). `mt_transfer` with 1 yocto still works for real wallets.
- The server is authoritative for off-chain state and holds no player or merchant keys. Merchants (and the new broker)
  are keyless accounts whose balances change only by contract rules.
- Server checks positions against the map (`Positions` in `server/src/game/worldmap.ts`); this must work per island.
- Balance numbers live in `economy/config.json`.

## Decided by the owner

- Start on the Public Island; earn there; buy a Private Island from an NPC.
- Island is off chain while the NPC holds it; the NFT is created at purchase with the bought spec and transferred to
  the player through the NPC.
- Upgrades need **Save World** to reach the chain; the old version is returned to the system and the new version is
  given, naming `IS-<id>-<version>`; never two versions per player.
- Public Island: trade and meet. Private Island: invite only.
- Upgradeable attributes, starting with soil fertility.
- Mining shaft on the Public Island with rare resources, shared with other players.
- Players see each other live, with chat bubbles above the character.
- Private and Public Islands do different jobs. Example from the owner: a Private Island gives iron and gold at
  most; diamond-tier only on the Public Island.
- The cheapest island should take about **10 hours** of play to afford.
- Minimum for the demo video: buy an island → `IS-1-1` → upgrade Kesuburan → Save World → `IS-1-2`. Everything else
  may follow.

## As built (phases 1a and 1b)

What a player sees:
- **Kantor Makelar**: the broker's window lists the islands still for sale with name, size, fertility and price. Buying
  needs the coin to be settled on chain; the island NFT `IS-<id>-1` then shows up in the Tas.
- **Docks**: walking to a Dermaga (public island or your own) opens a travel menu with the Public Island, your islands
  and islands you are invited to.
- **Island board** at your own island: the next Kesuburan Tanah upgrade with its cost, **Simpan Dunia** (Save World,
  with a note when the upgrade still waits for the 06:00 settlement), and the invite editor.
- **Tas**: the island NFT with its version and a Save World button.
- **Other players** are drawn with their name; **C** opens chat and messages appear as bubbles.

Differences from the design above:
- Prices are 500 to 3000 coin for 8 offers (cheapest about 10 h of play; 19.9 coin per game day in the 30-day sim),
  not the ~800 coin estimate.
- Luas Ladang upgrades are not built: size is fixed by the offer (`size_level`). Only Kesuburan upgrades exist, and
  levels 4-5 are locked until Permata exists (phase 1c). Emas and Permata are added to the registry by `migrate`
  but are not items in `economy/config.json` yet.
- Selling an island in the Pasar is not possible yet: `list_item` accepts registry tokens only. `mt_transfer` works.
- Invites (up to 20) take display names or account ids; the server stores account ids and resolves an exact
  account id before a display name, so a look-alike name cannot take over an invite. The dock menu lists the islands
  you are invited to ("Pulau teman").
- The dev coin grant (`/api/dev/grant`) works on the mock chain only, from a local request with `DEV_TOOLS`.

## Design

### Roles: Public vs Private

| | Public Island (village) | Private Island |
| --- | --- | --- |
| Resources | everything, including the top tier **Permata** (diamond-tier) from the mining shaft | basic (Kayu, Ikan, Bijih, Gandum) and, from upgrades, **Emas** (gold-tier); never Permata |
| Selling | merchants, Pasar, broker | none: goods must be brought to the Public Island to sell |
| People | everyone, live, chat bubbles | owner + invited guests, live, chat bubbles |
| Farming | the starter farm (6 plots) stays | bigger farm with Kesuburan and Luas upgrades |

**(Claude's call)** The island adds production on top of the village farm. That is safe for the coin supply because
the contract's per-account daily gain caps (`daily_gain_cap` 200 per item, `daily_coin_gain_cap` 5000 on testnet)
and the faucet bound what any player can settle per day, island or not. The builder re-checks the caps with the
simulator once island yields are set.

### Islands and travel

- **Public Island** = today's village (`client/js/world/village.js`, seed `WORLD_SEED`). Unchanged except a new
  **Dermaga** (dock) on the shore and the mining shaft entrance in Hutan Utara near the mine. **(Claude's call:** dock
  placement is the builder's, on the river or a lake shore, reachable from spawn and validated like other landmarks.)
- **Private Island** = one 32 × 32 chunk generated from the island's own seed and its upgrade levels (new generator
  next to `village.js`, also run by both browser and server). Contents: a house, farm plots (count from "Luas Ladang"),
  trees, a rock outcrop (Bijih; Emas veins appear from an upgrade level), a pond, a dock. **(Claude's call.)**
- Travel: at a dock, a menu lists the Public Island, your own island, and islands you are invited to. Picking one
  switches the outdoor world. The engine today has one outdoor scene built from one layout; it needs a "current world"
  that can be swapped (buildings inside each world keep working as now).
- Server: every position report and action carries a world id (`public` or `IS-<id>`). `Positions` and the gather
  checks use that world's map. Node charges are keyed per world, except the shaft's shared pool.

### Buying an island

- The broker is a new keyless account `makelar.genesistown.testnet` (like the merchants). In the game it is an NPC in
  the Kantor Makelar. **(Claude's call:** NPC name and dialogue are the builder's; dialogue may reuse `dialogue.ts`.)
- The broker offers a small stock of islands (phase 1: 8 on testnet), each with id, seed, starting spec and price in
  `economy/config.json` (`islands.offers`). Before purchase they are off-chain data only.
- Price target: the cheapest island costs what a normal player nets in about **10 real hours** (≈ 25 game days). The
  builder measures net coin per game day with the simulator and sets prices from it (the builder check estimated about
  33 coin per game day, so roughly 800 coin; the simulator decides). Bigger islands cost more.
- Demo video: a dev tool (only with `DEV_TOOLS`, local requests only, as today) moves existing coin from the town
  treasury to a demo account, so no coin is minted for the demo. **(Claude's call.)**
- Flow:
  1. Player opens the broker, picks an island, sees spec and price.
  2. Server checks the player's **settled** coin balance (island purchases, like P2P trades, spend settled coin) and
     returns a **voucher** signed by the server's settler key: `{island_id, spec, price, buyer, expires_block}`.
  3. Client signs `buy_island(voucher, signature)` with the session key; relayer pays gas.
  4. Contract checks the signature (`env::ed25519_verify` against a voucher public key stored in config), that the
     island id is unused, the buyer is registered and has the coin. Then, atomically: coin buyer → broker; mint
     `IS-<id>-1` to broker; transfer broker → buyer; store `islands[<id>] = {owner, version: 1, spec}`; emit
     `mt_mint` + `mt_transfer` events (NEP-245) and a game event `island_bought`.
  5. Server sees the result, creates the off-chain island state, Riwayat shows the purchase with an explorer link.
- **(Claude's call)** The voucher keeps the island off chain until purchase while making the player's own signature
  the trigger. Alternative considered: the settler calls `issue_island` and debits the player's coin directly; simpler,
  but the player never signs the biggest purchase in the game.
- Coin paid to the broker is **burned** in the same call, right after it reaches the broker (`mt_transfer` buyer →
  broker, then `mt_burn` from broker), so the chain shows the payment and coin supply `M` drops. Holding it at the
  broker would keep it inside `M` in the faucet formula `W = W0·k·(1−M/Mcap)` (`settle.rs`) and throttle new coin for
  everyone. **(Claude's call, after the builder check.)**

### NFT shape (contract v5)

- Island tokens are NEP-245 tokens with supply 1, in the same contract, so `mt_balance_of`, `mt_token`, events and the
  existing market work. **(Claude's call:** a separate NEP-171 contract would show better in NFT wallets; deferred.)
- Contract state: `islands: LookupMap<u32, Island { owner, version, spec, listed: bool }>`. Only `IS-<id>-<version>`
  for the current version has balance 1; every older version has supply 0. `mt_token("IS-1-2")` returns metadata:
  name ("Pulau #1 v2"), spec attributes, and the ledger-style hash of the spec.
- `require_token` accepts `IS-<id>-<v>` only when `v` is the island's current version.
- `spec` (phase 1): `{seed, size_level, fertility_level}`; more attributes later are appended fields.
- Transfers by `mt_transfer` (real wallets) and by the market update `islands[id].owner`. The server reads the owner
  from chain (view `get_island(id)`), never trusts its own copy for ownership.

### Upgrades and Save World

- Upgrades are bought on your own island (a board at your house). Phase 1 attributes **(Claude's call)**:

  | Upgrade | Levels | Effect | Example cost |
  | --- | --- | --- | --- |
  | Kesuburan Tanah | 1–5 | crops grow faster and yield more per harvest | wood/ore + coin; levels 4–5 also need Permata |
  | Luas Ladang | 1–3 | more farm plots (6 / 9 / 12) | wood + coin; level 3 needs Emas |

  Exact numbers in `economy/config.json` (`islands.upgrades`); the builder tunes them with the simulator. If the
  mining shaft (phase 1b) is not built, Kesuburan levels 4–5 and Luas level 3 ship locked ("butuh Permata/Emas dari
  tambang"). **(Claude's call.)**
- Paying an upgrade is an off-chain action like crafting: ledger rows burn the goods and coin. The effect applies in
  the game at once.
- **Save World** button (on the island board and in the Tas detail of the island NFT):
  - writes on chain only upgrades whose cost has already gone through a daily settlement (anti-goal: never show an
    unpaid upgrade). Upgrades bought today show "lunas setelah settlement 06:00"; the button says what will be saved.
    **(Claude's call;** at most one game day, 24 real minutes, of waiting.)
  - Server returns a voucher `{island_id, from_version, new_spec, owner, expires_block}`; the player signs
    `save_island(voucher, signature)`; the contract checks owner and `from_version == current`, then atomically burns
    `IS-<id>-<v>` from the owner and mints `IS-<id>-<v+1>` to the owner, updates `islands[id]`, and emits
    `mt_burn` + `mt_mint` + `island_saved`.
  - "Returned to the system" = burned **(Claude's call;** the history stays in events and the explorer).
  - Not allowed while the island is listed in the Pasar.

### Seeing each other and chat bubbles

Today players share one map but never see each other: `/api/state` returns no other players, the prototype's
`social.js` presence is switched off in `flags.js` and runs on a claude.ai artifact room, not on our server, and the
only chat (T) goes to NPCs. This adds live presence on our own server, for every world.

- Clients already report their position with every action and state poll (`Positions` in `worldmap.ts`). The server
  keeps, in memory, per world: account → `{x, y, dir, name, scene, t}`.
- Clients receive the other players in their world a few times per second. **(Claude's call:** Server-Sent Events
  from the existing `node:http` server, no new dependency; polling as fallback. Updates only go to players in the
  same world.)
- The engine draws them as remote characters with `GT.addNpc(..., {remote: true, label: name})`, moved with
  `GT.moveNpc`; the engine's NPC speech bubble (`npc.bubble`, HTML over the canvas) shows their chat.
- **Chat**: press Enter (or the chat button on phones), type, send. The message shows as a bubble above your head for
  everyone in the same world, plus a small log of the last messages. Max 80 characters, at most one message every
  2 seconds per account, signed like other requests (`reqauth.ts`), never stored on chain; the server keeps only the
  last 50 per world in memory. A simple word filter, and a local mute per player. **(Claude's call.)**
- **Names**: players pick a display name (3–16 characters, unique) once, after login; it is stored on the server and
  shown above the character. The local `playerName` in the engine becomes this name. **(Claude's call.)**
- The existing T message to NPCs stays as is.

### Invites

- Off chain, on the server: each island has an invite list (account ids or display names) that only the current
  on-chain owner can edit from the island board or the Tas. **(Claude's call.)**
- Invited players can travel there, walk around, and chat with whoever is there. Trading with the owner uses the
  existing ways (Pasar, `send_item`); no new trade window in phase 1. Guests cannot gather or farm on someone else's
  island. **(Claude's call.)**
- The list is cleared when ownership changes.

### Selling an island

- In phase 1 through the existing Pasar: `list_item("IS-<id>-<v>", 1, price)` escrows the NFT; `buy_listing` moves it;
  the 5% fee burns as today. Listing requires no unsaved upgrades (the client says "Simpan dulu"); unsaved, unpaid
  upgrades would otherwise be lost. The contract also blocks `save_island` while listed.
- After the sale the buyer gets the island as of its saved version; the seller's off-chain island state (crops, node
  charges) is reset to the saved spec. **(Claude's call.)**

### Mining shaft (Public Island)

- Entrance in Hutan Utara by the mine. Inside: a small cave scene (like a building interior) with **veins**.
- New rare tokens (contract v5): **Emas** (gold) and **Permata** (gem), kind `Raw`, with high base value. Merchants buy
  them (Joko for Emas, Budi for Permata, **Claude's call**); island upgrades need them.
- How sharing works (**owner's choice: a shared daily pool, first come, first served**):
  - the shaft has one daily supply of Permata (and Emas) for all players together, e.g. 30 Permata per game day
    (number in `economy/config.json`, tuned with the simulator);
  - every successful mining action takes from that pool; when it is empty, the veins look spent and a line says when
    they refill (06:00, the next game day);
  - built on the existing `nodes` charges table: one shared key per vein, refill at the day change;
  - a per-player daily limit (e.g. at most a third of the pool) so one player cannot empty it alone **(Claude's call)**;
  - energy cost and tool wear as for ore; the pool status ("Permata tersisa hari ini: 12") shows at the entrance.
- Gains go through the ledger and settlement as usual, so the daily gain caps and the "never pays coin" faucet rules
  hold.

### Agent wallets (open, recommendation only)

Today's AI merchants are keyless accounts: the server decides their trades off chain by `pricing.ts`, and their
balances change only through settlement under contract caps. Nothing can steal from them because nobody holds their
keys. Phase 1 keeps this model for the broker. Options for later, if agents should act on chain on their own:
1. **Keyless, contract-governed (today)**: simplest and safest; agents cannot act outside settlement or vouchers.
2. **Scoped function-call key per agent** (game contract only, gas allowance capped), held by the server or a NEAR AI
   TEE agent: agents could list in the Pasar or bid on islands themselves; the key can leak, so caps per agent are needed.
3. **Chain Signatures / MPC**: the agent's key never exists in one place; more work.

Recommendation: stay with 1 for the hackathon; revisit 2 when there is a concrete agent action that needs its own
signature.

## Phases

| Phase | Scope | When |
| --- | --- | --- |
| 1a (demo minimum) | contract v5 (`islands`, `buy_island`, `save_island`, `get_island`, voucher key in config, tokens Emas + Permata, `migrate`); broker + offers; buy flow with NFT mint via broker; island generator; dock travel to your own island; Kesuburan Tanah upgrade; Save World | before the demo video, after M4.5 Online is live |
| 1b | live presence + chat bubbles + display names (all worlds); invites and visiting | next |
| 1c | mining shaft with Permata, Emas veins on islands, Luas Ladang; selling islands in the Pasar (listed/save guards) | if time allows before 2026-11-14 |
| 2 | more Public Islands, more upgrades, a trade window between players, NEP-171 or marketplace listing, island thumbnails as NFT media, agent wallets | after the hackathon |

**(Claude's call:** the one contract upgrade carries everything phase 1 needs, including the two new tokens, so there
is only one `migrate` on testnet.)

## Testing

- Contract (`cargo test`, `tests/test_game.rs`): buy mints to broker then transfers; replayed or expired voucher
  fails; wrong signer fails; second buy of the same id fails; save burns v and mints v+1; save with a stale
  `from_version` fails; old version is not transferable; save while listed fails; market sale updates owner;
  migrate keeps v4 state.
- Server (`node --test`): voucher only for settled coin; upgrade effect is immediate off chain; Save World excludes
  unsettled upgrade costs; invite checks on travel; position checks per world; shaft pool shared by all players,
  empties, refills at the day change, per-player limit; chat length and rate limits; presence only within a world.
- E2E testnet script like `server/scripts/e2e-market.ts`: buy, upgrade, settle, save, sell, with explorer links for
  the README.

## Left to the builder

Island generator details and art, dock and shaft placement, NPC name and lines, exact prices and upgrade costs
(tuned with the simulator), UI layout of the broker, island board and travel menu, number of offered islands, file
and module names.

## Open questions

None for phase 1. Agent wallets stay open for phase 2.
