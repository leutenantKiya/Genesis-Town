# One session per account, easy new-device login, online guests, admin panel: plan

> Written 2026-11-12 (deadline 2026-11-14). Carried out ONE STEP AT A TIME by workers with no memory of earlier
> sessions. Same rules as `docs/coop-trade-plan.md` ("How to resume", "Conventions every step follows"): read CLAUDE.md,
> pull, do only the first unticked step, `npm test` green, tick the row, commit with explicit paths + trailer
> `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, push. Only one server, on :3000; never kill a process you
> did not start, never use another port.

## Ringkasan (Bahasa Indonesia)

- **Perangkat baru langsung main.** Login Google atau NEAR Auth di perangkat baru langsung masuk ke akun yang sama, tanpa
  layar "New device" dan tanpa kode. Hanya saat pertama kali memakai sesuatu yang on-chain (Pasar, kirim hadiah, saham,
  proyek kota) muncul "Setujui perangkat ini" lewat NEAR Auth. Kotak "I have a code from another device" hilang dari layar login.
- **Satu sesi per akun.** Login terbaru menang. Sesi lama berhenti dan menampilkan "Akunmu dibuka di perangkat lain"
  dengan tombol "Main di sini" (login lagi untuk mengambil alih).
- **Guest online.** Tanpa login, pengunjung masuk ke desa publik sebagai Tamu: bisa berjalan dan melihat pemain lain
  (name tag kecil di atas kepala). Tidak bisa chat, trade, atau ekonomi. Paling banyak 5 guest sekaligus; yang ke-6 tetap
  di mode offline demo dengan pesan "Desa sedang penuh tamu".
- **Panel admin.** Akun di `ADMIN_ACCOUNTS` (env) melihat tombol Admin: daftar guest online (dengan IP), kick guest,
  ban/unban IP.

## STATUS

- [x] Step 1: New device signs in at once (off-chain), on-chain actions ask for approval when first needed; code box removed from login
- [ ] Step 2: One live session per account (newest login wins), "opened on another device" screen with "Main di sini"
- [ ] Step 3: Online guests (max 5): guest presence in the public village, small name tags, offline-demo fallback
- [ ] Step 4: Admin panel: ADMIN_ACCOUNTS, list guests, kick guest, ban/unban IP

## Design decisions (fixed)

1. **Two kinds of session key.** Today a key is in `store.session_keys` only after it is on chain (created with the
   account, or added by NEAR Auth in `newdevice.ts`). Add a column `onchain INTEGER NOT NULL DEFAULT 1` (PRAGMA
   table_info + ALTER pattern in `db.ts`). `register()` in `auth.ts`, for a known player (`playerBySub`) whose browser key
   is not yet theirs, now stores the key with `onchain = 0` and returns normally (no `needsKey`), with
   `needsChainApproval: true`. The login token (NEAR Auth or Google, already verified) is the proof of identity, the same
   proof that creates accounts. Off-chain requests (`reqauth.ts`) accept both kinds. The relayer (`relayer.ts`) accepts
   only `onchain = 1` keys and otherwise answers 409 `{error, code: 'approve_device'}`; the client then runs the existing
   NEAR Auth new-device flow (`newDevice` in `client/js/mods/chain.js`, `/api/auth/add-key`), which on success flips the
   key to `onchain = 1` (`addDeviceKey` stores it; if the row exists, update it). Where NEAR Auth is unusable (domain not
   allowed), the approve modal says on-chain actions on this device need NEAR Auth and offers nothing else.
2. **Remove the transfer code from the UI** (the "I have a code from another device" box and the Bag button "Move to
   another device"). Keep `/api/transfer*` and `transfer.ts` on the server (harmless, tested); mark them unused in CLAUDE.md.
3. **One live session per account.** Add `players.active_key TEXT` (or a small `active_keys(account PRIMARY KEY, key,
   at)` table). Every successful `register()` and `addDeviceKey()` sets the active key to that browser's key.
   `verifyRequest` (off-chain) and the relayer reject a request signed by a key that is the account's but not active with
   409 `{error: 'Your account was opened on another device.', code: 'superseded'}`. Presence of the old key drops (the
   social presence entry is keyed by account, so the new device simply takes over). Client: on `code: 'superseded'` from
   any call, stop polling and show a blocking modal "Akunmu dibuka di perangkat lain" with "Main di sini", which runs the
   normal login (NEAR Auth / Google / dev login), making this key active again. No silent take-over without a login.
4. **Guests.** `POST /api/guest/hello` (public, rate-limited per IP) returns `{guest: 'g-<random>', nick: 'Tamu-1234'}`
   or 429 "The village is full of guests." when 5 guests (`econ.guest.max` in `economy/config.json`) have been seen in the
   last 15 s; banned IPs get 403. Guest presence: `POST /api/guest/presence {guest, x, y, dir}` (public, per-IP rate
   limit like presence, guest id must belong to the caller's IP) → same-world players (public only) and no chat. Guests
   are kept in memory in `social.ts` with `guest: true`, are listed to players too, never in Homelands, cannot call
   `/api/chat`, `/api/act`, trade, relay. A guest idle 30 s is dropped. Client: when not signed in and the server is
   reachable, the offline demo calls `/guest/hello` and then polls `/guest/presence` instead of staying alone; on 429 it
   stays in the offline demo and toasts "Desa sedang penuh tamu, coba lagi nanti.".
5. **Small name tags.** Guests see players' name tags; guests' own tags render small and dim ("Tamu"), players' tags as
   today but at the small size when the viewer is a guest. Keep it in `client/js/mods/players.js`.
6. **Admin.** `ADMIN_ACCOUNTS` env (comma list, in `config.ts` and `.env.example`). `GET /api/admin/guests` (signed,
   admin only, 403 otherwise) → `[{guest, nick, ip, since}]`; `POST /api/admin/kick {guest}` drops the guest and blocks
   that guest id; `POST /api/admin/ban {ip, note?}` and `/api/admin/unban {ip}` write a `bans(ip PRIMARY KEY, at, note)`
   table (`db.ts`); `GET /api/admin/bans`. A banned IP is refused by `/api/guest/*`, `/api/auth/register` and
   `/api/transfer/redeem`. `GET /api/state` returns `admin: true` for admins; the client shows an "Admin" entry in
   "Lainnya" with a panel (guests table with Kick / Ban IP buttons, bans list with Unban). IPs come from `clientIp(req)`
   (respects `TRUST_PROXY`).
7. i18n, sw.js cache bump, README/CLAUDE.md updates and tests in `server/test/` as in the co-op plan conventions.

## Step 1: New device signs in at once

Files: `server/src/db.ts`, `server/src/auth.ts`, `server/src/relayer.ts`, `server/src/newdevice.ts`, `server/src/app.ts`,
`client/js/mods/chain.js`, `client/js/lang/en.js`, `client/sw.js`, tests `server/test/auth.test.ts`, `relayer*.test.ts`.
Tests: known player + new key → registered off-chain (`onchain = 0`), no needsKey; that key passes `verifyRequest`;
relay with it → 409 code approve_device; after `addDeviceKey` the same key relays. Commit message: "A player signing in
on a new device now goes straight into the game, and is asked to approve the device with NEAR Auth only the first time
they use the market, gifts or shares."

## Step 2: One live session per account

Files: `server/src/db.ts`, `auth.ts`, `newdevice.ts`, `reqauth.ts`, `relayer.ts`, `app.ts`, `client/js/mods/chain.js`
(+ `players.js` polling stop), en.js, sw.js. Tests: login on B makes A's signed request 409 superseded and A's relay 409;
logging in again on A makes B superseded. Commit message: "Signing in on another device now ends the older session,
which shows a message with a button to play there again."

## Step 3: Online guests

Files: `economy/config.json` + `econ.ts` (`guest: {max: 5, idleSecs: 30}`), `server/src/social.ts`, `app.ts`,
`client/js/mods/players.js`, `chain.js` (offline demo path), en.js, sw.js. Tests: 5 guests ok, 6th 429; guest sees
players; players see the guest flagged; guest cannot chat/act; idle guest dropped. Commit message: "Visitors who have not
signed in now walk the village as guests and see the players there, up to five guests at a time."

## Step 4: Admin panel

Files: `server/src/config.ts`, `.env.example`, `db.ts`, `app.ts`, `client/js/mods/admin.js` (new, in index.html and sw.js
SHELL), `settings.js` ("Lainnya" entry), en.js, sw.js, CLAUDE.md route list. Tests: non-admin 403; admin lists guests,
kicks one (gone, its id refused), bans an IP (guest hello and register refused), unbans. Commit message: "Admins can see
the guests online, kick a guest and ban or unban an address from an in-game panel."
