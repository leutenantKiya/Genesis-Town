# Party, Co-op and Trade Window: implementation plan

> Saved as `docs/coop-trade-plan.md`. Written 2026-11-11 for the NEAR hackathon deadline of 2026-11-14.
> The plan is carried out ONE STEP AT A TIME by workers who have no memory of earlier sessions. Read "How to resume" first.

## Ringkasan untuk pemain (Bahasa Indonesia)

- **Party (grup main bareng), di mana saja.** Ajak pemain lain lewat `nama#tag` atau dari kartu namanya (klik pemainnya, lalu "Ajak party"). Dia bisa terima atau tolak. Satu party berisi paling banyak 4 orang. Ketua bisa mengeluarkan anggota, dan siapa saja bisa keluar sendiri. Party tetap ada setelah halaman dimuat ulang.
- **Saling melihat.** Nama anggota party berwarna hijau. Ada titik di peta kecil, dan panah di tepi layar menunjuk anggota yang tidak kelihatan. Panel Party (tombol **G**) menunjukkan siapa berada di dunia mana. `/p pesan` mengirim pesan ke party saja, dari dunia mana pun.
- **Pergi bersama.** Kalau anggota ada di dunia lain yang boleh kamu masuki, tombol "Ikut" mengantarmu jalan ke portal lalu menyeberang. Kalau ketua pindah dunia, kamu ditanya "Ikut?". Tidak ada pemain yang dipindahkan paksa.
- **Desa publik tetap untuk jualan.** Di desa party hanya bisa mengobrol, saling menemukan, dan berdagang. Di sana tidak ada kegiatan mengumpulkan, bertani, atau membangun.
- **Main bareng di Homeland.** Anggota party si pemilik otomatis boleh masuk. Pemilik memilih izinnya (untuk party dan untuk tiap tamu undangan):
  - **Pengunjung**: jalan-jalan, mengobrol, makan, berdagang.
  - **Pembantu**: juga menebang, menambang, memancing, bertani, melawan monster malam, mengambil hasil bangunan untuk pemilik, dan membantu tukang supaya lebih cepat selesai.
  - **Tukang**: juga memulai bangunan dengan bahan dari tasnya sendiri.
- **Siapa dapat apa.** Hasil yang kamu kumpulkan masuk tasmu, dengan batas harian yang sama seperti biasa. Panen selalu masuk ke orang yang menanam benihnya, siapa pun yang memanennya. Hasil bangunan selalu masuk ke pemilik. Bahan bangunan dibayar oleh orang yang memulai. Bantuan tukang hanya memakai energi. Co-op tidak membuat koin baru.
- **Jendela dagang baru.** Dagang bisa dilakukan di desa dan di Homeland. Dua sisi meletakkan barang dan koin, lalu keduanya menekan "Siap". Kalau ada perubahan, tanda siap kembali kosong. Setelah keduanya siap, ada hitung mundur 3 detik sebelum barang bertukar. Anggota party boleh berdagang dari jarak berapa pun asal di dunia yang sama. Pemain lain harus berdiri dalam jarak 3 petak. Setiap dagang tercatat di Riwayat (filter "Dagang"). Pasar Pemain dan kiriman hadiah tetap on-chain seperti sekarang.

---

## STATUS (tick one row per step, in the same commit as the step)

- [x] Step 1: Party core: create, invite, accept or decline, leave, kick; panel and name-card button
- [x] Step 2: Party everywhere: green tags, minimap dots, off-screen arrows, party chat `/p`
- [ ] Step 3: Party in Homelands: owner's party may visit; portal entries, "Ikut" follow, safe leave and kick
- [ ] Step 4: Homeland roles (Pengunjung / Pembantu / Tukang) and gathering plus night fights for helpers
- [ ] Step 5: Farming together (planter gets the harvest, guest plot limit)
- [ ] Step 6: Building together (builder pays, `assist` speeds jobs, helpers collect for the owner)
- [ ] Step 7: Trade sessions on the server (two-sided, version-checked confirmations, countdown, any world)
- [ ] Step 8: Trade window on the client, started from a card, the party panel or `/dagang`; Riwayat "Dagang" filter
- [ ] Step 9: Fighting together (shared monster HP inside a party, a beaten monster is gone for the hour). Can be cut.
- [ ] Step 10: Docs and rules wrap-up (threat model, world, economy); optional party shopping list

## How to resume (for every worker, every session)

1. Read `CLAUDE.md`, then this file. Do not rely on any earlier conversation.
2. `git pull --rebase --autostash origin main`
3. Find the **first unticked** step in STATUS. Do **only that step**. If its code is partly in the tree already (an earlier session stopped mid-step), finish it. Do not start over.
4. Run `npm test` until it passes. Run the manual check on http://localhost:3000. Only ONE server may run, on port 3000, and it may be the user's own: never kill a process you did not start, and never start a server on another port. If :3000 is free, start `npm run dev:mock` there for the check and stop it when done; if :3000 is busy, skip the manual check, rely on the tests, and say so in the step's report. `npm run dev:mock` gives dev login `dev:<name>`, so two players means two browser profiles (or one normal and one private window) signed in as e.g. `dev:ani` and `dev:budi`.
5. Tick the step's row in STATUS (`- [x]`). Commit with explicit `git add <paths>` (never `git add -A`), using the step's exact commit message plus the trailer. Then `git push origin main`.
6. Stop. The next step is for the next session (or continue if told to).

If `git push` is rejected, run `git pull --rebase --autostash origin main`, run `npm test` again, then push.

## Conventions every step follows

- **Client text**: wrap new player-visible strings as `$t('Indonesian text')` and add the English line to `client/js/lang/en.js` (keys are the Indonesian originals, `{0}` placeholders).
- **Server text**: write it in English. Add the Indonesian to `server/src/i18n-id.ts`: `EXACT` for fixed sentences, `PATTERNS` for sentences with `{0}`. `server/test/lang.test.ts` shows the style.
- **Service worker**: any step that touches files under `client/` bumps `CACHE` in `client/sw.js` by one (`gt-shell-v23` becomes `v24`, and so on). A new client file is added to `SHELL` in `client/sw.js` and to `client/index.html`.
- **Numbers**: tuning numbers go in `economy/config.json` (`party`, `coop`, `trade`), typed in `server/src/game/econ.ts`. Never hard-code them.
- **Config keys from requests**: look them up with `Object.hasOwn` (never `in`), as the code already does for bots, cosmetics and furniture.
- **Every gain**: goes through `World.checkGain(receiver, token, n)` before any ledger row is written. Every multi-row change runs inside `gs.tx(...)`. Every token change is a `gs.add(...)` ledger row on a real player account, so settlement and the Merkle root need no change.
- **Server-side checks**: every action is checked where the player stands (`Game.worldFor`, `Positions.report`). Worlds change only through `travel` at a portal.
- **Docs**: when a step's feature lands, update the status block at the top of `README.md` (one short bullet, dated) and the matching `CLAUDE.md` lines. The Homeland rule sentence ("Guests are invited by `name#tag`, walk and chat, never build") is updated in Step 4 and Step 6. Run `node scripts/check-secrets.mjs` before committing a step that touches config.
- **Commits**: the message is one plain-English sentence of what the player gets, with no `feat:` prefix. End the message with a blank line and then:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- **Server code**: Node 24 runs `.ts` directly. Use erasable TS only (no enums, no namespaces). Storage is synchronous `node:sqlite`. New columns are added with the existing `PRAGMA table_info` + `ALTER TABLE` pattern in the `GameStore` constructor (`server/src/game/gamestore.ts`, see the `homeland_jobs` and `homeland_bots` migrations).
- **Client code**: client mods talk to the engine only through `window.GT`. Plain JS, no build step.
- **Shared test rig**: the base is `server/test/tradeworld.ts`, which gives three registered players P, Q, R named Ani, Budi and Citra, a shared map, and the helpers `stand`, `give` and `bal`. Step 3 adds `server/test/coopworld.ts` (see there). Files that do not end in `.test.ts` are not run as tests.

## Design decisions (fixed; workers do not re-decide these)

1. **The party lives on the server, in SQLite** (`GameStore`, so the Neon snapshot keeps it). A party has at most `party.max` = 4 members. Each account is in at most one party. Only the leader invites (a player with no party may invite, and becomes leader when the first invite is accepted). Invites expire after `party.inviteSecs` = 120 s.
2. **There is no forced pull.** A leader cannot move members between worlds, because worlds change only through `travel` at a portal (`Positions.report` refuses anything else). Members get a one-click "Ikut": the client walks them to the portal (`GT_MOUSE.goNear`) and calls `GT_HOME.travel(world)`, and the server checks access as for any travel.
3. **The public village stays trade-only.** `econ.homeland.publicTradeOnly` and the existing 409 "The public area is for trading only." stay. Party co-op in public means presence, chat, finding each other and trade. Nothing else.
4. **Homeland access** is the best of two grants:
   - an **invite role**: a new `homeland_invites.role` column, default `'visitor'`, so today's behaviour is kept;
   - a **party role**: a new `homelands.party_role` column, `NULL` = the config default `coop.partyRoleDefault` = `'helper'`, `'none'` = party mates get no access.
   The ranks are `visitor < helper < builder < owner`. Only the owner edits roles. Hire, dress, cook, stock, forage, invites and roles stay owner-only.
5. **Who receives what:**
   - Gather, fish and monster drops go to the actor, under the actor's own daily cap.
   - A harvest goes to the **planter** (a new `plots.planter` column), so harvesting someone else's crop only delivers it to them.
   - Building output (`collect`) always goes to the **owner**, under the owner's cap.
   - A build started by a builder is **paid by that builder** (items burned, coin to the town).
   - `assist` costs only the helper's energy.
   - The owner's bot bonuses (Penebang `woodBonus`) apply to the owner only.
   - Co-op never writes a positive `coin` row. The only coin that moves is in a trade, and a trade adds up to zero.
6. **Anti-grief for nodes and plots:**
   - A non-owner may not take a node's **last charge** (`coop.guestLeavesCharges` = 1), so guests never fell a tree to a stump.
   - Each non-owner may take at most `coop.guestGatherPerHostDay` = 40 units a day in one Homeland, counted from ledger rows whose `ref` starts with `HL-<n>:`.
   - Each non-owner may have at most `coop.guestPlotsPerHost` = 2 planted or ready plots in one Homeland.
7. **Kick or demotion mid-action:**
   - Every request is atomic (one sqlite transaction or nothing). `Game.fixWorld` runs first and sends a player who lost access back to the public area.
   - When the server resets a player's world, it also clears that player's pending monster encounter (`monsters.pending.delete`).
   - `fight` and `flee` only need the `visit` grant, so a demoted helper is never stuck in a fight.
   - A guest's items always stay in the guest's own bag. Nothing is held "in" the Homeland. Crops a guest planted still pay the guest when anyone harvests them.
8. **Trade distance rule:**
   - Both players must be in the **same world** (public or the same `HL-<n>`).
   - Strangers must also be within 3 tiles.
   - Party members may trade at **any distance in the same world**. Joining a party is a mutual opt-in, and the 3-tile rule exists to stop drive-by offers from strangers.
   - Cross-world trades stay refused, so every trade is still checked against where both players stand.
   - The old `/api/trade/offer|accept|cancel` endpoints stay unchanged (public, 3 tiles) for compatibility and their tests, marked deprecated. The client stops using them in Step 8.
9. **Faucet, caps, settlement**: nothing new mints coin. Item gains are the same kinds of ledger rows as today (`gather`, `harvest`, `collect`, `monster_drop`, `trade`), on registered player accounts, so `settlement.ts`, `merkle.ts` and the contract need no change. Add a regression test in Step 6 and Step 7 that `gs.newCoin(day)` is unchanged by co-op and trades.

## Config to add (`economy/config.json`; typed in `server/src/game/econ.ts`)

```json
"party": { "max": 4, "inviteSecs": 120, "maxPendingInvites": 5 },
"coop":  { "partyRoleDefault": "helper", "guestGatherPerHostDay": 40, "guestLeavesCharges": 1, "guestPlotsPerHost": 2,
           "assistEnergy": 10, "assistSecs": 15, "assistMaxShare": 0.5 },
"trade": { "expireSecs": 120, "maxLines": 4, "inviteSecs": 60, "sessionIdleSecs": 300, "countdownMs": 3000 }
```

Add `party` in Step 1, `coop` in Steps 3-6 (only the keys that step uses), and the new `trade` keys in Step 7.

---

## Step 1: Party core

**Goal:** players can form a party of up to 4: invite by `name#tag` or from a name card, accept or decline, leave, and the leader can kick. The party survives a reload and a server restart.

**Files:** `economy/config.json`, `server/src/game/econ.ts`, `server/src/game/gamestore.ts`, new `server/src/game/party.ts`, `server/src/game/game.ts`, `server/src/app.ts`, `server/src/i18n-id.ts`, new `client/js/mods/party.js`, `client/js/mods/players.js` (only to expose a presence hook), `client/js/mods/settings.js` (key bind and Lainnya entry), `client/index.html`, `client/sw.js`, `client/js/lang/en.js`, new `server/test/party.test.ts`, `README.md`, `CLAUDE.md`.

**Data (in the `GameStore` constructor's `db.exec`):**

```sql
CREATE TABLE IF NOT EXISTS parties (id INTEGER PRIMARY KEY AUTOINCREMENT, leader TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS party_members (account TEXT PRIMARY KEY, party INTEGER NOT NULL, joined_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS party_members_by_party ON party_members(party);
CREATE TABLE IF NOT EXISTS party_invites (from_acct TEXT NOT NULL, account TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (from_acct, account));
```

**`server/src/game/party.ts`:** `export class Parties` with deps `{ gs, econ, now, names: PlayerDir (same shape as in homeland.ts), assertActive }`. Methods:

- `idOf(a): number | null`
- `membersOf(id): string[]`, ordered by `joined_at`
- `mates(a): string[]` returns the other members
- `same(a, b): boolean`
- `invite(from, to: unknown)`:
  - Resolve `to` like `Trade.resolve` (`name#tag`, or an account id).
  - Refuse with 400: yourself; unknown player (404).
  - Refuse with 409: `to` is already in a party ("That player is already in a party."); `from` is in a party but is not its leader ("Only the party leader can invite."); the party is full counting members only; `from` has more than `party.maxPendingInvites` live invites.
  - Insert or replace the invite with `expires_at = now + inviteSecs*1000`.
- `accept(a, from)`:
  - In one `gs.tx`: the invite must exist and not be expired (404 or 409). `a` must not be in a party.
  - If `from` has no party, create one with `leader = from` and add `from`.
  - The party must have fewer than `max` members (409 "The party is full.").
  - Add `a` and delete the invite.
- `decline(a, from)`
- `leave(a)`:
  - Remove `a`. If `a` was leader, the earliest remaining member becomes leader.
  - A party left with one member is deleted (rows and invites from its leader).
- `kick(leader, target)`: leader only (403/409), `target` must be a member, then same as leave.
- `view(a)` returns `{ party: { id, leader, members: [{ account, name, tag, leader }] } | null, invites: [{ from, name, tag, expires_at }] }`. Expired invites are filtered on read.

`assertActive` is called on invite and accept (frozen accounts are refused, like trade).

**Game:** `game.party = new Parties(...)` in the `Game` constructor, next to `this.trade`.

**Routes (`app.ts`, a `partyApi()` block like `homelandApi()`):**

- `GET /api/party` returns `view`.
- `POST /api/party/invite {to}`, `/accept {from}`, `/decline {from}`, `/leave {}`, `/kick {account}`.
- All are signed (`accountOf`) and use `actLimiter`.
- Each POST answers with the new `view`.

**Presence:** add `party: game.party.view(acct)` to the `/api/presence` response, so the client needs no extra poll. In `players.js` add `GT_PLAYERS.onPresence(fn)`, which calls each `fn(r)` after a successful tick.

**Client `party.js`** (loads after `players.js`, before `trade.js`):

- Key **G** opens the Party panel. Add `{ id: 'party', canon: 'KeyG', label: $t('Party'), keys: ['KeyG'] }` to the bind list in `settings.js` and "Party" to `moreSheet()`.
- The panel lists members (leader marked, "Keluarkan" for the leader, "Keluar dari party" for self) and an invite field `nama#tag`.
- `GT_PLAYERS.addCardAction` adds "Ajak party" to other players' cards (not NPCs).
- An incoming invite pops a `GT.modal` "{0}#{1} mengajakmu ke party" with Terima / Tolak / Nanti, shown once per invite and only when no UI is open (same pattern as `incomingModal` in `trade.js`).
- Chat command `/party nama#tag` (or `/ajak`) invites. Handle it in `players.js` `send()` before the server call: call `GT_PARTY.invite`.

**Tests `server/test/party.test.ts`** (use `world()` from `tradeworld.ts`):

- `invite and accept forms a party with the inviter as leader`: P invites Q, Q accepts; `idOf` matches; the view shows 2 members and leader P.
- `max 4, one party per account, leader-only invites`: a 5th accept gives 409. A non-leader member inviting gives 409. Inviting someone already in a party gives 409.
- `invites expire and can be declined`: `adv(121_000)` then accept gives 409; decline removes the invite.
- `leave passes the lead and a party of one dissolves`.
- `kick is leader-only`.
- `party survives a new Game on the same Store`: build a second `Game` on the same `store`; `idOf` is unchanged.
- `frozen accounts cannot invite or accept`: `recordShortfall` then 403.

**Manual (localhost:3000):** `npm run dev:mock`. Ani and Budi sign in from two profiles and walk to the market. Ani clicks Budi and picks "Ajak party". Budi gets the pop-up and accepts. **G** on both shows the two members. Reload Budi's page: the party is still there. Ani kicks Budi; Budi's panel shows no party.

**Commit:** `Players can form a party of up to four with name#tag or a click on someone's name card, and it stays after a reload.`

**Done when:** `npm test` passes; the panel works in English and in Indonesian (`?lang=id`); `sw.js` is bumped; the README has a "Party" bullet and the CLAUDE.md layout table lists `party.ts` / `party.js` and the `/api/party/*` routes.

---

## Step 2: Party everywhere (see each other, party chat)

**Goal:** in every world, party mates have green name tags (even beyond the 30-tile presence radius), dots on the minimap, and an edge arrow when off-screen. `/p text` reaches the whole party in any world.

**Files:** `server/src/social.ts`, `server/src/app.ts`, `server/src/i18n-id.ts`, `client/js/mods/players.js`, `client/js/mods/party.js`, `client/js/theme.js` (new tone `party`), `client/js/engine.js` (one minimap hook), `client/sw.js`, `client/js/lang/en.js`, tests `server/test/social.test.ts` and `server/test/presence.test.ts`, `README.md`.

**Server, `social.ts`:**

- New hook `partyOf: (a: string) => number | null = () => null`. The app sets it to `(a) => game.party.idOf(a)`.
- New hook `mates: (a: string) => string[] = () => []`.
- `nearby(account, world, ...)`: same-world mates skip the radius filter (the age, `scene === 'out'` and `access` checks stay), and their entry gets `party: true`.
- `say()`: a `/p` or `/party` prefix followed by text (not a `name#tag`, which Step 1's client already turns into an invite) is a party line.
  - 409 "You are not in a party." when there is none.
  - `Stored` gets `party: number | null`.
  - Rate limits are unchanged.
- `since()`: a party line is visible when `m.party === this.partyOf(account)`. Strip it to `ChatMsg` with `party: true`.
- Member positions: the presence response's `party.members[]` gets `world`, plus `x, y, online` taken from `social.seen` when the mate reported in the last 15 s. `x` and `y` only when the mate is in the caller's world and outdoors. Compute it in `app.ts` from `social.seen`.

**Client:**

- `theme.js`: add a `party` tone (green chip).
- `players.js`:
  - Tags of `o.party` players use tone `party`. Chat lines with `m.party` are rendered as "[Party] name: text" in green (CSS class `party` in `css/mods.css`).
  - Off-screen arrows: in `onDraw`, for each party member in `others` whose `GT.at()` point is outside the canvas, draw a small arrow on the edge with the name. This works in 2D and 2.5D because `GT.at` already projects.
- `engine.js` `drawMinimap()`: after the player marker, add `callMods('onMinimap', [g, C])` and document `onMinimap(g, scale)` in the header comment.
- `party.js` `onMinimap`: green 2 x 2 dots at mates' `x * C`, `y * C`.
- Panel: each member's world shown as "Desa" / "Homeland {owner}" / "offline".

**Tests:**

- `social.test.ts` `party mates show beyond the radius and are flagged`: set `social.partyOf` and `social.mates` in the test. A mate 50 tiles away is in `nearby` with `party: true`; a non-mate is not.
- `social.test.ts` `party chat reaches mates in other worlds only`: R (not in the party) never sees the line; the line shows for Q while Q is in another world; `/p` with no party gives 409.
- `presence.test.ts` `presence carries the party roster with positions only in the same world`: over HTTP, after P and Q form a party via `/api/party/*`.

**Manual:** Ani and Budi form a party. Budi walks 40+ tiles away: his tag stays green, the arrow points to him, and the map (M) shows the dot. `/p halo` shows for Budi even after he travels to his Homeland. A third profile `dev:citra` does not see it.

**Commit:** `Party members now stand out in green, show on the map and with an arrow when off screen, and can talk on their own /p channel from any world.`

**Done when:** tests pass; the 2D and 2.5D views both draw arrows; the README bullet is extended; CLAUDE.md mentions the engine hook `onMinimap` in the `engine.js` row.

---

## Step 3: Party in Homelands (visit together, follow)

**Goal:** an owner's party mates may enter the owner's Homeland as visitors (walk, chat, eat, trade later) without being on the invite list. The portal lists party worlds, "Ikut" brings a member to a mate's world, and leaving or being kicked from the party sends a visitor home safely.

**Files:** `server/src/game/gamestore.ts`, `server/src/game/homeland.ts`, `server/src/game/game.ts`, `server/src/app.ts`, `economy/config.json` (`coop.partyRoleDefault`), `server/src/game/econ.ts`, `server/src/i18n-id.ts`, `client/js/mods/homeland.js`, `client/js/mods/party.js`, `client/sw.js`, `client/js/lang/en.js`, new `server/test/coopworld.ts`, new `server/test/coop-access.test.ts`, existing `server/test/homeland-game.test.ts`, `README.md`, `CLAUDE.md`.

**Data:**

- `ALTER TABLE homelands ADD COLUMN party_role TEXT` (nullable; `NULL` means `coop.partyRoleDefault`).
- `ALTER TABLE homeland_invites ADD COLUMN role TEXT NOT NULL DEFAULT 'visitor'`.
- Use the `PRAGMA table_info` check pattern for both.
- `setHomelandInvites(id, accounts)` must keep an existing role for accounts that stay on the list. Read the roles first, then re-insert.

**Roles in this step:** `role` and `party_role` are stored and read, but only `visitor` powers exist yet. Step 4 turns on helper actions. Until Step 4 the effective party role is capped at `visitor`: `Math.min(rank(role), rank('visitor'))` in `access()`, with a `// Step 4 lifts this cap` comment.

**`Homelands`:**

- Deps add `party?: { same(a: string, b: string): boolean }`.
- `access(account, id)` returns `{ row, owner, role: 'owner' | 'builder' | 'helper' | 'visitor' }`:
  - the owner is `'owner'`;
  - an invited account gets its invite role;
  - a party mate with `party_role !== 'none'` gets `party_role ?? coop.partyRoleDefault`;
  - the best of the two wins;
  - otherwise 409 'You are not invited to this world.'
- `invitedTo(account)` also returns the Homelands of party mates that grant access, with `role` and `via: 'invite' | 'party'`. Deduplicate by id.

**`Game`:**

- `worldFor(account, wid, need: 'visit' | 'help' | 'build' | 'owner')` replaces the `ownerOnly` boolean. Update every caller: `act`, `reportPosition`, `fixWorld`, the presence checks in `app.ts` (`social.access`), and `homeland/layout`.
- Messages:
  - `help`: "Ask the owner to make you a Helper."
  - `build`: "Only the owner or a Builder can build here."
  - `owner`: keep "This isn't your Homeland. Guests can only look around."
- `const NEED: Record<Action, Need>`:
  - `travel`, `eat`, `fight`, `flee`: `'visit'`. `sell` and `buy` also `'visit'` (they fail later because a Homeland has no stall).
  - Everything else, for now: `'owner'`.
- `fixWorld`: when it resets a player, also `this.monsters?.pending.delete(account)`.

**Client:**

- `homeland.js` `openPortal()` already lists `H.invited`. Label party entries `$t('Dunia {0} (party)')`.
- `party.js`:
  - Next to a member in another world that is public, my own Homeland or in my `invited` list, show "Ikut". It calls `GT_MOUSE.goNear(portal, () => GT_HOME.travel(world))`. `GT_HOME` must expose `travel`; check its export and add it if missing.
  - When the leader's world changes between two presence polls and I can go there, show `GT.menu($t('Ketua pindah ke {0}. Ikut?'), [...])`, but only if `!GT.isUiOpen()`.

**`server/test/coopworld.ts`:** `world()` from `tradeworld.ts` plus:

- `home(a)` returns `{ row, wid, map }`.
- `enter(a, owner)`: put `a` into the owner's Homeland at its spawn via `game.positions.setWorld`, then `game.reportPosition`.
- `party(...accounts)`: the first invites, the others accept.
- `standNear(map, target, d)`: copy it from `homeland-game.test.ts`.

**Tests `server/test/coop-access.test.ts`:**

- `a party mate may travel into the owner's Homeland and eat there`: P and Q in a party; Q travels from the public portal to P's world; `eat` passes the world check (it fails only on full energy, as in `homeland-game.test.ts`).
- `party_role none shuts party mates out; an invite still works`.
- `leaving the party sends a visitor back to public and clears a pending encounter`: set `monsters.pending` by hand, then `party.leave`; the next `game.state(Q).worldId` is `'public'` and `pending` has no Q.
- `a visitor still cannot gather, farm or build`: 409 with the "Helper" or "Builder" message.
- `invitedTo lists party Homelands with via party`.
- Update `homeland-game.test.ts` `stranger cannot enter HL-<other>`: an invited guest can now `eat`. Change the guest assertion to `gather` giving 409 `/Helper/`.

**Manual:** Ani and Budi are in a party; Ani goes to her Homeland. Budi presses **G** and picks "Ikut": he walks to the public portal and arrives in Ani's world. Budi tries to chop a tree: the toast asks him to become a Helper. Ani leaves the party: Budi lands in the public area on his next move.

**Commit:** `Party members can visit each other's Homelands without an invite, follow a friend through the portal with one click, and are sent home safely if they leave the party.`

**Done when:** tests pass; the CLAUDE.md Homeland sentence reads "Guests (invited by `name#tag`, or the owner's party) walk, chat and eat; what else they may do is the owner's choice (roles, see docs/coop-trade-plan.md)"; the `worldFor` doc comment and the CLAUDE.md "Adding an off-chain action" paragraph mention `need`.

---

## Step 4: Roles and gathering and fighting for helpers

**Goal:** the owner sets each guest's role and the party's role. Helpers gather (trees, rocks, fish) and fight night monsters in the owner's Homeland, protected by the guest share and the last-charge rule.

**Files:** `server/src/game/homeland.ts`, `server/src/game/game.ts`, `server/src/game/world.ts`, `server/src/game/monsters.ts`, `server/src/game/gamestore.ts` (one query helper), `server/src/app.ts`, `economy/config.json`, `server/src/game/econ.ts`, `server/src/i18n-id.ts`, `client/js/mods/homeland.js`, `client/sw.js`, `client/js/lang/en.js`, new `server/test/coop-gather.test.ts`, `README.md`, `CLAUDE.md`, `docs/threat-model.md` (the "Only the owner builds" bullet).

**Server:**

- Remove the Step 3 cap in `access()`.
- New route `POST /api/homeland/role {who, role}`:
  - `who` is an account or `name#tag` on the invite list, or the literal `'party'`.
  - `role` is in `['visitor', 'helper', 'builder']`, plus `'none'` for `'party'` only. Anything else is 400.
  - Owner only. Answers with `view`.
- `Homelands.view` `guests[]` gets `role`; the view gets `party_role`.
- `NEED`: `gather`, `engage`, `craft` become `'help'`. `craft` uses the Town Hall workbench with the actor's own bag; inputs and outputs are the actor's.
- `act()` `gather` in a Homeland the actor does not own:
  1. **Guest share**: `gs.guestTaken(day, account, wid)` = `SELECT COALESCE(SUM(delta),0) FROM ledger WHERE day = ? AND account = ? AND delta > 0 AND kind IN ('gather','monster_bonus','monster_drop') AND ref LIKE ?` with `wid + ':%'`. If it is at least `coop.guestGatherPerHostDay`, return 409 "You helped a lot here today ({0}). Come back tomorrow."
  2. **Last charge**: `World.gather(..., opts?: { minLeft?: number })`. When `charges - 1 < minLeft`, return 409 "Leave the last one for the owner." with no state change. The check runs before `spendEnergy`.
  3. **Bonus**: owner only (`w.row.account === account ? woodBonus : 0`).
- **Bug fix in `Monsters.fight`** (cite it in the commit body): after winning a gather encounter it calls `this.world.gather(account, e.tile, e.x, e.y)` with **no node prefix**, so a Homeland fight charges a *village* node. Store `prefix` (`'HL-<n>:'` or `''`) and `minLeft` on the `Encounter` in `maybeEncounter`, and pass them to `world.gather`. Monster rows' `ref` becomes `${wid}:${e.kind}` in a Homeland, so the guest share counts them.
- `engage` and roaming fights in a host's Homeland work for helpers unchanged (`this.need(this.monsters).engage(..., w.map, true)`). Drops go to the fighter.

**Client `homeland.js`:**

- Town Hall (owner): the "Undang teman" cell gets a role select per guest and a "Party" row with Tidak boleh / Pengunjung / Pembantu / Tukang. Each change calls `/homeland/role`.
- Non-owners see "Kamu: {role} di dunia ini" in the Town Hall.
- The client needs the role of the current world: add `here: { world, owner_name, role }` to `game.state()` (from `access`, when `worldId` is a Homeland) and read `S().st.here`.
- `chain.js` gather already sends `world`, so no change is needed. Fishing works the same way.

**Tests `server/test/coop-gather.test.ts`:**

- `a helper gathers in the host's Homeland and the wood is the helper's`: the ledger row is on Q with `ref` starting `HL-<id>:`; P's balance is unchanged.
- `a visitor is refused; the owner promotes them and they can gather`.
- `guests never take a node's last charge`: three takes pass, the fourth gives 409 with the node still at 1 charge; the owner can then take it.
- `guest share caps at 40 units per host per day, the owner is uncapped by it`: give rows by `gs.add` with the right ref to fake 40, then 409; the next settle day allows again.
- `no Penebang bonus for guests`.
- `winning a monster fight in a Homeland charges the Homeland node, not the village node` (regression for the bug).
- `daily gain cap still applies per account`.

**Manual:** Ani sets Party = Pembantu. Budi chops a tree in Ani's forest and gets wood. The fourth chop says to leave the last one. At night (Dev panel night jump) Budi meets a boar and wins a drop.

**Commit:** `Homeland owners choose what guests and party members may do, and helpers can now chop, mine, fish and fight night monsters together in a friend's Homeland while the owner's trees and daily share stay protected.`

**Done when:** tests pass; README has a "Co-op in the Homeland" bullet; CLAUDE.md core rule: "Homeland roles: visitor (walk, chat, eat, trade), helper (gather, farm, fight, collect for the owner, assist builds), builder (also start builds paid from own bag); owner-only: hire, dress, cook, stock, forage, invites, roles"; the `threat-model.md` bullet is rewritten to match.

---

## Step 5: Farming together

**Goal:** helpers till, plant, water and harvest the owner's Homeland field. Each crop belongs to whoever planted it.

**Files:** `server/src/game/gamestore.ts`, `server/src/game/world.ts`, `server/src/game/game.ts`, `server/src/i18n-id.ts`, `client/js/mods/chain.js`, `client/sw.js`, `client/js/lang/en.js`, new `server/test/coop-farm.test.ts`, `README.md`.

**Data:**

- `ALTER TABLE plots ADD COLUMN planter TEXT NOT NULL DEFAULT ''`. Empty means the owner of the plot row.
- `Plot` gets `planter`. Update `savePlot`.

**Server:**

- `NEED.farm = 'help'`.
- `World.farm(actor, op, idx, field?)`: `field` gains `owner: string` (the Homeland owner) and `guest: boolean`.
  - `plant`: seed from the actor's bag, using the actor's village-seed gift as today. Set `plot.planter = actor`. When `field.guest`, count the plots in this field with `planter === actor` and state `planted|ready`; if that reaches `coop.guestPlotsPerHost`, return 409 "You already have {0} crops growing here."
  - `harvest`: `receiver = plot.planter || field?.owner || actor`, then `checkGain(receiver, ...)` and `gs.add(day, receiver, seed, n, 'harvest', receiver === actor ? null : \`coop:${actor}\`)`. Return `credit: { account: receiver, token, n }` when the receiver is not the actor.
  - `till` and `water`: the actor's energy, as today.
- `Game.act` `farm` in a Homeland:
  - Pass `plotAccount: \`${w.row.account}@${wid}\``, `count: farmCount(w.row)`, and `growDays` from the **owner's** `effects` (Petani).
  - On `credit`, add a history row for the receiver: "{0} harvested {1} Wheat for you in {2}'s Homeland."
- `Game.state()`:
  - Visitors see plots read-only; helpers and up see the host's plots (`plots` from `${hrow.account}@${wid}`).
  - Each plot gets `mine: planter === account` and `planter_name` when the planter is not the viewer.
- `chain.js`: the plot tooltip ("Petak kebun") shows "milik {0}" when `planter_name` is set; `farm()` is otherwise unchanged.

**Tests `server/test/coop-farm.test.ts`:**

- `a helper plants in the owner's field and gets the harvest even when the owner harvests it`.
- `the owner's crop harvested by a helper goes to the owner, with a history row for the owner`.
- `guest plot limit is 2`.
- `a visitor cannot farm`.
- `harvest checks the receiver's daily cap, not the actor's`: fill the receiver's cap, then 409 with the plot unchanged.
- `owner farming is unchanged` (regression for the existing owner path).

**Manual:** Budi (Pembantu) plants on Ani's plot; the plot tooltip shows Budi. After watering through 3 days (Dev settle), Ani harvests and Budi's bag gets the wheat; Budi's Riwayat shows the line.

**Commit:** `Friends can farm a Homeland field together, and every crop goes to the player who planted it, whoever harvests.`

**Done when:** tests pass; README co-op bullet extended.

---

## Step 6: Building together

**Goal:** builders start Homeland builds paid from their own bag; helpers and the owner can "Bantu tukang" to shorten a running job with energy; helpers can collect a building's output, which goes to the owner. Guests see the Town Hall and lots with what their role allows.

**Files:** `server/src/game/gamestore.ts`, `server/src/game/homeland.ts`, `server/src/game/game.ts`, `server/src/app.ts`, `economy/config.json` (`assist*`), `server/src/game/econ.ts`, `server/src/i18n-id.ts`, `client/js/mods/homeland.js`, `client/sw.js`, `client/js/lang/en.js`, new `server/test/coop-build.test.ts`, `README.md`, `CLAUDE.md`, `docs/threat-model.md`.

**Data:** `ALTER TABLE homeland_jobs ADD COLUMN assisted INTEGER NOT NULL DEFAULT 0` (seconds removed by assists).

**Server:**

- `ACTIONS` adds `'assist'`.
- `NEED`: `build = 'build'`, `collect = 'help'`, `assist = 'help'`.
- `Homelands.plan(row, kind, target, payer = row.account)`: the balance checks use `payer`.
- `Homelands.start(owner, kind, target, day, payer = owner)`: cost rows on `payer`, coin to the town. `ref` stays `${HL}:${kind}:${target}`. The toast says "{label}: the builder starts working (paid by you)." when `payer !== owner`. `Game.act` passes `start(w.row.account, ..., account)`.
- `Homelands.collect(owner, lot, day, checkGain, actor)`: credits `owner` (`checkGain(owner)`). `Game` adds a history row for the owner: "{0} collected {1} for you."
- `Homelands.assist(owner, actor, target, day)`:
  - `this.settle(owner)` first.
  - The job must exist (409 "Nothing is being built there.").
  - `base = j.ends_at - j.started_at + j.assisted`; `cap = Math.floor(base * coop.assistMaxShare)`; `cut = Math.min(coop.assistSecs * 1000, cap - j.assisted)`. If `cut <= 0`, 409 "This job can't go any faster."
  - Spend `coop.assistEnergy` from `World.state(actor)` (409 when short, no change). Then `ends_at -= cut`, `assisted += cut`. Add a `GameStore.assistJob(account, target, cut)` UPDATE.
  - Return a toast and `ends_at`.
  - No ledger rows. Contractor fatigue still uses `base_secs`, so it is unchanged.
- Positioning for `assist`: the same rule as `build` (`nearLot` for build/furniture/upgrade targets, Town Hall for `th`/`chunk`).
- **View for guests:** `GET /api/homeland?world=HL-<n>` returns `Homelands.view(owner, viewer)` for a viewer with access, plus `role`.
  - When `viewer !== owner`: `guests` is replaced by `{ count }`; `hire` and `cosmetics` are omitted; `next.buildings[*].can/why` are computed with `payer = viewer`.
  - Without `world` (or with your own world) the behaviour is unchanged.

**Client `homeland.js`:**

- Keep `H` (own Homeland) and add `HV` (the current world's view when not your own, polled the same way).
- `hallBody` and `lotBody` replace `inOwnHome()` checks with `role()`:
  - visitor: read-only text (as today);
  - helper: collect buttons ("Ambil untuk pemilik") and "Bantu tukang (−10 energi)" on running jobs;
  - builder: also the build buttons with the line "Dibayar dari tasmu; bangunannya milik {0}.";
  - owner-only cells (Pekerja, Kosmetik, Restoran pantry, Undang teman) stay hidden for non-owners.
- `placeBuilder` and job countdowns should also draw for guests (they read `HV.jobs`).

**Tests `server/test/coop-build.test.ts`:**

- `a builder starts a Kolam in the owner's Homeland paid from their own bag`: Q's wood goes down, P's is unchanged; the job is on P's Homeland.
- `a helper cannot start builds; a visitor cannot collect`.
- `collect by a helper credits the owner, under the owner's cap`.
- `assist shortens a job by 15 s, costs 10 energy, stops at 50% of the job`.
- `assist with no job or no energy changes nothing`.
- `demoting a builder mid-job keeps the job and its cost`: the job finishes once for the owner.
- `co-op adds no new coin`: run gather, harvest, collect, build and assist for P and Q; `gs.newCoin(day)` is unchanged; the town's coin only goes up by the build coin.
- `a co-op day settles`: follow `settlement-bugs.test.ts` to run `devSettle()` on the mock chain; it succeeds with no shortfall rows, and the chain balances equal `gs.balance` for P and Q.

**Manual:** Ani sets Budi to Tukang. Budi builds the Tambang lot with his own ore and wood. Citra (Pembantu, a third profile in the party) presses "Bantu tukang" twice and the countdown drops by 30 s. Later Citra collects the ore and Ani's bag gets it.

**Commit:** `Friends can build in a Homeland together: builders pay for new buildings from their own bag, helpers speed the builder up with their energy, and output they collect goes to the owner.`

**Done when:** tests pass; the CLAUDE.md Homeland rule sentence is final (guests by role: visitor, helper, builder; owner-only list); the `threat-model.md` "Only the owner builds" bullet is replaced by the role rules; README updated.

---

## Step 7: Trade sessions (server)

**Goal:** a live two-sided trade between two players in the same world (public or a Homeland). Both put in items and coin; any change clears both confirmations; once both confirm, a countdown runs and then the swap is atomic.

**Files:** `server/src/game/gamestore.ts`, `server/src/game/trade.ts`, `server/src/game/game.ts`, `server/src/app.ts`, `economy/config.json`, `server/src/game/econ.ts`, `server/src/db.ts` (history `kind` filter), `server/src/i18n-id.ts`, new `server/test/trade-session.test.ts`, `README.md`, `CLAUDE.md`.

**Data:**

```sql
CREATE TABLE IF NOT EXISTS trade_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT NOT NULL, b TEXT NOT NULL, world TEXT NOT NULL,
  a_lines TEXT NOT NULL DEFAULT '{}', b_lines TEXT NOT NULL DEFAULT '{}',
  a_ok INTEGER NOT NULL DEFAULT 0, b_ok INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'invite', swap_at INTEGER NOT NULL DEFAULT 0, note TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS trade_sessions_a ON trade_sessions(a, status);
CREATE INDEX IF NOT EXISTS trade_sessions_b ON trade_sessions(b, status);
```

Status runs `invite → open ⇄ locked → done | cancelled | expired`. An account has at most one live session (`invite`, `open` or `locked`), on either side.

**`Trade` additions:**

- Deps add `party: { same(a, b): boolean }`.
- `near(a, b)`:
  - `where(a)` and `where(b)` must be in the same world;
  - and either `party.same(a, b)` or a Manhattan distance of 3 or less;
  - otherwise 409 "Stand close together in the same place (party members: anywhere in the same world)."
  - It is skipped when both `where` are null, as in `together()`.
  - Leave `together()` and the old offer flow unchanged.
- `open(a, {to})`: resolve; refuse self, frozen, either side already in a live session (409 "{0} is already trading."); `near`; insert with `world = where(a).world`.
- `join(b, id)`: only `b`, status `invite`, not older than `trade.inviteSecs`; `near`; set status `open`.
- `set(acct, id, {lines})`:
  - Lines are parsed by the existing `lines()` (max `maxLines` kinds, coin allowed as a token).
  - `need(acct, lines)` checks the balance now.
  - Write my side; `a_ok = b_ok = 0`; `version += 1`; `status = 'open'` (this also cancels a running countdown); `note = null`.
- `ready(acct, id, {version})`:
  - A version mismatch is 409 "The trade changed. Check it again."
  - Both sides empty is 400 "Empty trade."
  - Set my ok. When both are ok: `status = 'locked'`, `swap_at = now + trade.countdownMs`.
- `close(acct, id)`: either side sets `cancelled`.
- `finishDue()`, for each locked session with `swap_at <= now`, in `gs.tx`:
  1. Claim with `UPDATE ... SET status='done' WHERE id=? AND status='locked' AND version=?` (one winner).
  2. `assertActive` both, `near`, `need` both sides, and `checkGain` in both directions (the same netting as in `accept`).
  3. Write ledger rows `kind 'trade'`, `ref 'p2p:s<id>'`.
  4. Write history rows for both through `this.d.history`, with ref `p2p:s<id>` (extend the `history` dep signature with an optional ref).
  - If anything throws: rollback, then outside the tx set `status='open', a_ok=0, b_ok=0, note=<message>` so both windows show why.
- Expiry on read: an `invite` older than `inviteSecs`, or an `open` session idle longer than `sessionIdleSecs`, becomes `expired`.
- `session(acct)` returns `SessionView | null`: `{ id, status, me: 'a'|'b', other: {account, name, tag}, mine, theirs, my_ok, their_ok, version, swap_at, note, world }`.
- `invites(acct)` returns sessions in `invite` where `b = acct`.

**Game and app:**

- `Game.step()` calls `this.trade.finishDue()` once per tick (outside the hour loop).
- `GET /api/trade` calls `finishDue()` first and adds `session` and `invites` to the existing body.
- New POST routes `/api/trade/open|join|set|ready|close`: signed, `actLimiter`, `game.reportPosition(acct, b.pos, b.world ?? 'public')`. Validate `world` with `worldOf` first; this replaces the hard-coded `'public'` for these routes only.
- Each answers `{ session, state }`.
- `GET /api/history?kind=trade`: add an optional `kind` filter to `Store.history` (`kind` must match `/^[a-z_]{1,24}$/`).

**Tests `server/test/trade-session.test.ts`** (`tradeworld.ts`, plus `coopworld.ts` for Homelands):

- `open, join, both set, both ready, countdown, swap`: `adv(countdownMs)` then `finishDue()`; four or more rows with ref `p2p:s<id>`; balances moved; status done.
- `any change resets both confirmations and stops the countdown`: ready, ready (locked), `set` brings it back to open with both oks 0; a `ready` with the old version gives 409.
- `one live session per player`.
- `strangers need 3 tiles, party members only the same world, never across worlds`.
- `works inside a Homeland between owner and guest, and between two guests`.
- `a failed swap reopens with a note and changes nothing`: the payer spends the items during the countdown, so the swap fails with note "Not enough Fish." and the balances are unchanged.
- `two finishDue calls swap once`.
- `receiver's daily cap is enforced at swap time`.
- `frozen account cannot open, join or be swapped`.
- `invite and idle expiry`.
- `trades move coin but never create it`: `newCoin` is unchanged.
- `history kind=trade lists both sides`: over HTTP or `Store.history`.

**Manual:** no UI change yet. Check the endpoints with the existing trade tests green. Optional: call `GT_CHAIN.api('/trade/open', ...)` from the dev console in two profiles.

**Commit:** `The server can run a live two-sided trade in the village or a Homeland, where both players confirm, any change asks them again, and the goods swap after a short countdown.`

**Done when:** tests pass, old `trade.test.ts` included and unchanged; CLAUDE.md routes list adds `trade/open|join|set|ready|close` and notes the old `offer|accept|cancel` as deprecated; README trade bullet updated (server ready, window next).

---

## Step 8: Trade window (client) and Riwayat

**Goal:** a clear trade window anywhere. Start it from a name card ("Ajak dagang"), from the party panel ("Dagang"), or with `/dagang nama#tag`. Trades show in Riwayat with a "Dagang" filter.

**Files:** `client/js/mods/trade.js`, `client/js/mods/party.js`, `client/js/mods/players.js` (`/dagang` command), `client/js/mods/chain.js` (Riwayat), `css/mods.css` or `css/chain.css`, `client/sw.js`, `client/js/lang/en.js`, `server/src/i18n-id.ts` (any new server strings), `README.md`, `CLAUDE.md`.

**`trade.js`:**

- Replace `offerModal`, `incomingModal` and the old offer poll with a session flow:
  - `poll()` runs every 1 s while a session or invite exists, else every 3 s. It runs in **any** world (drop `inPublic()` from the trade part; Titip Jual and Papan Juara stay public-only).
  - An incoming invite opens a modal "{0}#{1} mengajak dagang" with Buka / Tolak.
  - The window (`GT.modal`, wide) has two columns:
    - **Kamu beri**: item cards from my bag (reuse `GT_ITEMS.icon`), a qty input per card, a coin input, at most `maxLines` kinds. Edits are debounced 400 ms and then sent with `POST /trade/set`.
    - **{nama} beri**: read-only cards.
  - Under each column a tick shows "Siap" / "Belum siap". The **Siap** button posts `ready` with the current `version`.
  - When the session is `locked`, a big "Bertukar dalam 3…2…1" counts down from `swap_at`.
  - Show `note` in red when set.
  - **Batal** posts `close`.
  - On `done`: toast "Dagang selesai", `refreshState`, close the window.
- `addCardAction` "Ajak dagang": in any world, for non-NPC players. Party members can be traded with from the party panel at any distance.

**`chain.js` Riwayat:**

- `friendly()`: `kind === 'trade'` uses the summary as the title (the server already translates it) with the coin icon fallback.
- `historyBody()` gets a filter row "Semua | Dagang". "Dagang" loads `/history?kind=trade` into `S.tradeHistory`, the same way `S.itemHistory` works.

**Manual:**

1. Ani and Budi (not a party) stand 2 tiles apart in the market. Ani clicks Budi and picks "Ajak dagang"; Budi opens the window.
2. Ani puts 3 Fish, Budi 20 coin; both press Siap; the countdown runs.
3. Budi changes to 15: both ticks clear.
4. Both press Siap again: the swap happens and Riwayat > Dagang shows it on both sides.
5. Repeat inside Ani's Homeland with Budi as a party visitor, from the party panel at a distance.
6. A stranger 10 tiles away is refused with the server's message.

**Commit:** `Trading now opens a two-sided window anywhere, started from a player's card, the party panel or /dagang: both sides add goods and coin, both confirm, any change asks again, and every trade is listed under Dagang in Riwayat.`

**Done when:** the old offer pop-ups are gone from the client (server endpoints stay); English and Indonesian both read well; phone layout checked (the window opens as a bottom sheet); README and CLAUDE.md (`trade.js` row) updated.

---

## Step 9: Fighting together (can be cut if time is short)

**Goal:** party members who engage the same roaming monster share its HP; everyone who landed a hit gets the drop; a beaten monster is gone for the rest of that game hour, for everyone in that world.

**Files:** `server/src/game/monsters.ts`, `server/src/game/game.ts`, `server/src/i18n-id.ts`, `client/js/mods/chain.js` (hide defeated monsters, close the fight bar when a mate finishes the monster), `client/sw.js`, `client/js/lang/en.js`, new `server/test/coop-fight.test.ts`, `README.md`.

**Server (`Monsters`):**

- `defeated = new Map<string, number>()` with key `${world}:${id}` and the game hour as value. `roaming(map, home, hour, world)` drops entries defeated in that hour (pass `world` from `Game`; key by world so Homelands do not collide).
- `shared = new Map<string, { hp, maxHp, hour, hitters: Set<string>, party: number | null }>()`, keyed `${world}:${id}:${hour}`.
- `engage`:
  - If `shared` has the key and the engager is in the same party, the encounter refers to it (`e.shared = key`).
  - If someone outside the party holds it: 409 "Someone else is fighting this one."
  - Otherwise create the entry.
- `fight`: for a shared encounter, decrement `shared.hp` on a hit and add the account to `hitters`. At 0:
  - mark it `defeated`;
  - for every hitter: `pending.delete`, `checkGain(hitter, drop, 1)`, `gs.add(day, hitter, drop, 1, 'monster_drop', \`${world}:${kind}\`)` (a full cap means no drop for that hitter, with a note);
  - store a per-account note `lastWin` that `state()` returns once.
  - A mate who never hit gets nothing.
- Each player still pays their own energy. Knock-out rules are unchanged.
- Gather encounters (`maybeEncounter`) stay solo.
- `state()` returns `defeated: string[]` (ids for this world and hour) and `note` (once). The client skips those ids in `roamers()` and closes the fight bar when `encounter` becomes null with a note.

**Tests `server/test/coop-fight.test.ts`:**

- `two party members share one boar's HP and both get the drop`.
- `a non-party player cannot join the fight`.
- `a defeated monster cannot be engaged again this hour`. This also fixes the old ability to beat the same roaming monster again and again.
- `a mate who did not hit gets nothing`.
- `the drop respects each hitter's cap`.

**Manual:** at night (Dev night) in Ani's opened forest chunk, Ani and Budi both walk into the same boar and press Lawan in turns. The boar's pips drop for both, both get the drop, and the boar is gone until the next hour.

**Commit:** `Party members can now fight the same night monster together, sharing its health and each taking a drop for the hits they landed.`

**Done when:** tests pass; README bullet updated. If this step is cut, tick it with "(skipped)" and list it under Out of scope.

---

## Step 10: Docs and rules wrap-up (+ optional party shopping list)

**Goal:** the design docs match the game, and the plan's open questions are recorded.

**Files:** `docs/world.md` (the Guests section becomes "Guests, party and roles"), `docs/threat-model.md` (new sections "Party" and "Trade sessions"; co-op anti-abuse list), `docs/economy.md` (co-op gives no new coin; who receives what; guest share), `docs/game-loop.md` (party and co-op loop), `README.md` (tidy the status bullets: one Party bullet, one Co-op bullet, one Trade bullet), `CLAUDE.md` (final check of the layout table, routes, core rules), this file (tick).

**Optional, only if time remains, and harmless to skip:** a **party shopping list** in the party panel, a shared list of up to 8 short lines.

- In memory on the server: `Parties.notes`, `POST /api/party/note {text}` with `cleanText` and 60 characters, returned in `party.view`.
- It is useful in the public market: "we need 20 wood for the bridge".
- It is purely social and touches no economy.
- Tests: `party note is shared, cleaned and capped`.

**Commit:** `The guides now explain parties, co-op roles and the trade window, and party members share a short shopping list.` If the optional list is skipped: `The guides now explain parties, co-op roles and the trade window.`

**Done when:** docs are consistent and `npm test` passes.

---

## Abuse cases and where they are handled

| Case | Handling (step) |
| --- | --- |
| Alt accounts farming a friend's Homeland | Each alt needs its own NEAR login; the per-account daily cap is unchanged; the per-host guest share is 40 a day (4); nodes have the same 4 charges however many players come, so a Homeland's total output is bounded; an alt already owns its own Homeland, so co-op adds no new source, it only concentrates. |
| Double gather caps | Every gain is credited to exactly one account and checked with `checkGain(receiver)`. Harvest and collect check the receiver, not the actor (5, 6). Trade checks the receiver at swap time (7). |
| Griefing: harvesting the owner's crops | The harvest goes to the planter (5). |
| Griefing: using up nodes | Guests cannot take the last charge, and the guest share applies (4). |
| Griefing: filling plots | At most 2 guest crops per Homeland (5). |
| Griefing: burning the owner's goods | Builders pay from their own bag (6); owner-only actions stay owner-only. |
| Owner kicks or demotes a guest mid-action | Requests are atomic; `fixWorld` runs first; pending encounters are cleared on reset; `fight` and `flee` only need `visit`; a started job keeps its paid cost and finishes for the owner (3, 6). |
| Guest's items when uninvited or disconnected | Always in the guest's own bag (ledger rows on the guest's account); guest crops still pay the guest; open trade sessions are only swapped after both confirm and both stand in the same world at swap time. A disconnect leaves the session to expire (7). |
| Trade scams | A version-checked confirmation, any change resets both ticks, a countdown before the swap, the window shows exactly what moves, atomic claim + checks + rows in one transaction, `assertActive`, rate limits (7, 8). |
| Spending unsettled or reserved items | `gs.balance` subtracts `reservedOf` (an on-chain relay in flight), and every spend uses it. Off-chain spending of today's pending items stays allowed, as for every off-chain action today. |
| Leaderboard wash trading inside a party | Open risk; see below. |

## Open questions and risks

1. **Papan Juara and party wash trades**: `leaderboard.ts` counts `p2p:` rows where items went out for coin. Two party alts can inflate it, as two strangers can today. Option (not planned): skip trades where `party.same(a, b)` at swap time, by giving them ref `p2pp:s<id>`. Decide after the hackathon.
2. **Party role default `helper`** trusts party mates with gathering and farming by default. If the user prefers safety, change `coop.partyRoleDefault` to `visitor` in config. No code change is needed.
3. **Guest share number** (40 a day per host) and **assist** numbers are guesses; tune them in config after play.
4. **Invite-list role vs party role**: the best grant wins. A player removed from the party but still invited keeps the invite role. This is intended.
5. **Memory-only parts** (presence, chat, shared fights, `defeated`) reset on a server restart. Parties and trade sessions are in SQLite and survive. A locked trade session that was due during downtime swaps on the first `finishDue()` after the restart (checks rerun).
6. **Deadline**: Steps 1-8 are the core. Step 9 and the Step 10 optional list can be cut. If time is short after Step 6, do Step 7 and Step 8 before anything else.

## Out of scope (deliberately)

- Any on-chain change: no new contract method; Pasar listings and gifts stay on chain as they are; Homelands stay off-chain and not NFTs.
- Co-op work in the public village (no gathering, farming, building or monsters there).
- Pooled on-chain contributions to town projects or shop-restore boards by a party (each member still contributes on chain themselves; only the optional shopping list helps coordinate).
- Forced teleport or "summon" of party members.
- Shared party inventory or shared bank; worker bots doing anything for guests (bots never hold items or trade).
- Cross-world trades.
- Moderation tools beyond the existing chat limits and `/block`.

---
--- END OF PLAN FILE (below is for the coordinator, not part of docs/coop-trade-plan.md) ---

### Critical Files for Implementation
- g:\Sand\Hackathon\GenesisTown\Genesis-Town\server\src\game\game.ts (worldFor/NEED refactor, act routing, fixWorld, state `here`/plots, wiring of party and trade)
- g:\Sand\Hackathon\GenesisTown\Genesis-Town\server\src\game\homeland.ts (access roles, invitedTo, start/plan payer, collect to owner, assist, view for guests)
- g:\Sand\Hackathon\GenesisTown\Genesis-Town\server\src\game\trade.ts (sessions, near rule, finishDue) and new server\src\game\party.ts
- g:\Sand\Hackathon\GenesisTown\Genesis-Town\server\src\game\gamestore.ts (party, trade_sessions tables; role, party_role, planter, assisted columns)
- g:\Sand\Hackathon\GenesisTown\Genesis-Town\server\src\app.ts plus client\js\mods\trade.js, homeland.js, players.js (routes, presence party block, client UI)

Notes for the coordinator:
- **Existing bug, planned as a fix in Step 4.** `Monsters.fight` calls `this.world.gather(account, e.tile, e.x, e.y)` after a won gather encounter without the `HL-<n>:` node prefix. So a fight won inside a Homeland charges a village node key, not the Homeland's.
- **Existing gap, planned as a fix in Step 9.** Roaming monsters have no "defeated" tracking today, so the same monster id can be engaged and beaten again within the same hour.
- **One existing test will change.** `server/test/homeland-game.test.ts` "stranger cannot enter HL-<other>" asserts that an invited guest's `eat` is refused. Step 3 changes that assertion to `gather`, because visitors may now eat.
- **The old trade API stays.** `/api/trade/offer|accept|cancel` and `trade.test.ts` are kept unchanged and marked deprecated, so `npm test` stays green while the new session flow is added.