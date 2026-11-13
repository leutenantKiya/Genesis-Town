# Playtest fixes, round 3 (plan)

Status: **built** (owner said "Kerjakan Planning nya", 2026-11-13); items 11 and 12 were added while it was being built. New playtest findings are added
below as numbered items; each says what the player sees, why, and the planned fix.

## 1. The farm field shows three different soil textures

**What the player sees** (owner's screenshot, 2026-11-13, Homeland farm in the 2.5D view): inside one fence the
brown earth does not match. The generator's field tiles, the tiles the player tilled with the Hoe, and an empty crop
plot each look different, and the Hoe's green squares sit flat on top of the grass.

**Why** (three painters, three palettes):

| Tile | Drawn by | Look |
| --- | --- | --- |
| Field tile from the generator (`soil`) | `client/js/art.js` `drawGround` type `soil`, baked into the ground texture (`three/ground.js`) | base `#6a4024`, full-width furrows every 3 px in two tones (`#4a2c18` dark, `#86562e` light), a few light specks |
| Tile tilled with the Hoe (`homeland_tilled`) | `client/js/mods/homeland.js` `onDrawGround` | flat `#6e4a2c`, one dark furrow tone `#4e321c` every 3 px starting at row 2, inset 1 px at both sides, no light line: furrows sit on a different row and the tile edge shows |
| Empty crop plot (`state: 'empty'`) | `client/js/mods/chain.js` `onDrawGround` | translucent tan `rgba(214,170,110,.55)` square inset 1 px over whatever is under it |

In the 2.5D view the second and third sit on the mods' overlay sheet (`view3d.js` `gctx`), a separate plane from the
baked ground, so even matching colours can shade a little differently.

**Planned fix**

1. Tilled tiles: paint them with the same art as the field, `SPRITES.drawGround(ctx, 'soil', x, y, variant)` (same
   seeded variant per tile as the ground uses), instead of the hand-drawn colours. Then a tilled tile is the field's
   own texture.
2. Empty crop plot: keep the plot readable without changing the soil, e.g. a thin light outline or corner marks on
   the soil art instead of a tan wash over it.
3. Hoe squares: check after 1 that they still read well on grass (they are on the unlit marks sheet); if the flat fill
   looks pasted on, switch to an outline plus a light fill.
4. Check in 2D and 2.5D, day and night, rain, and each season (`?musim=`), with a screenshot of the same field before
   and after.

Files: `client/js/mods/homeland.js`, `client/js/mods/chain.js`, maybe `client/js/art.js` (only if the soil art needs
an export for overlay use). Bump `CACHE` in `client/sw.js`. README status line.

## 2. The Town Hall window is one long list: split it into tabs with icons

**What the player sees** (owner's screenshot, 2026-11-13): the owner's Town Hall window stacks everything in one
scroll: level and regions, the builder, the Hunter's pickup, Upgrade, Street lights, Open a region, Workers,
Gear, Invite friends and Guest roles. Goals to work toward and settings sit mixed together, with words only.

**Why**: `hallBody()` in `client/js/mods/homeland.js` appends every section to one `wrap`, top to bottom.

**Planned fix**

1. A tab row at the top of the owner's Town Hall window (the guest view `guestHall` stays as it is). Each tab has an icon
   and a short word, and a dot or count when something there needs the player:
   - 🏛️ **Town** (Kota): level, regions open, the builder and the Town Hall workers with tiredness and morale, the
     Hunter's pickup (Ambil).
   - 🔨 **Build** (Bangun), the goals to work toward: Upgrade the Town Hall, Street lights, Open a region. Dot when one can
     be started now (enough goods, builder free).
   - 👷 **Workers** (Pekerja): hire workers (beds used), Gear (hats and scarves).
   - 👥 **Guests** (Tamu): invite friends, guest and party roles.
2. Icons inside the tabs too: each section title gets one (⬆️ Upgrade, 💡 Street lights, 🗺️ Open a region, 🛏️ beds,
   🎩 Gear, ✉️ Invite, 🔑 Roles), each worker job its own (🔨 Tukang, 🌾 Petani, 🎣 Nelayan, 🪓 Penebang, 🏹 Pemburu,
   🍳 Koki), cost chips keep their item icons. Words stay beside every icon, and buttons keep their full label for
   screen readers.
3. The chosen tab survives the window's once-a-second redraw (`redrawWin` while a job runs) and reopening the window in
   the same session; keyboard: arrow keys move between tabs (`role="tablist"`, `aria-selected`).
4. On a phone the tab row fits 360 px wide (icon over a short word), the window keeps its bottom-sheet layout.
5. Small fixes seen in the same screenshot:
   - Two buttons both say "Open Beach": regions with the same name get their side added ("Beach (west)", "Beach
     (east)") from the chunk's position.
   - "ke-1" next to "Open a region" is untranslated Indonesian built by hand (`'ke-' + ch.n`): make it a `$t()` string
     ("region {0}" / "wilayah ke-{0}").
6. New player-visible words go through `$t()` with English lines in `client/js/lang/en.js`; check in English and
   Bahasa Indonesia, desktop and phone; bump `CACHE` in `client/sw.js`; README status line.

## 3. A new player starts with a Hoe, a Pickaxe, a Fishing Rod and 5 Wheat to plant

**What the owner wants**: at the start of the game the player already holds the three tools and 5 Wheat seeds.

**Now**: `economy/config.json` `starter` gives `coin 100, tool 1 (Pickaxe), bread 3, wheat 3` once, when the account is
created (`world.ts` `starter`, called from `Game.onNewPlayer`). The Hoe is a free hotbar slot for everyone
(`hotbar.js` `FREE = { hoe: 1 }`, not a token). There is no Fishing Rod item: fishing needs nothing in hand.

**Planned fix**

1. `starter.wheat` 3 → 5 in `economy/config.json` (tuning goes in config, not code). The Pickaxe (`tool: 1`) is already
   there.
2. Fishing Rod as a free hotbar slot like the Hoe (`FREE.rod`, its own pixel icon, `$t('Pancing')`), not a new token:
   a new NEP-245 token would need a contract registry change and storage that is short right now. Picking it and
   facing water starts fishing, as A / F does today.
3. Hotbar order puts the three tools first so a new player sees them at once: Hoe, Pickaxe, Rod, then the goods.
4. First-mission text (chain.js `GOALS`) mentions planting the 5 Wheat with the Hoe.
5. Test: a new account's starter rows (server test), the hotbar shows the three tools on a fresh mock login.

**Open question for the owner**: the starter only runs when an account is created. Should existing players (yours
included) get the 2 extra Wheat once? That is a small grant outside the coin faucet; default: no, new players only.

## 4. Click-to-walk gets disturbed by W / A / S / D

**What the player sees**: walking by clicking (or tapping) a tile, then touching W A S D, makes the walk stutter,
stop, carry on in a wrong direction, or keep going after the key is let go.

**Why** (found in the code):
- `mods/settings.js` turns W A S D into arrow keys: it stops the real key event (`stopImmediatePropagation`, capture,
  loaded before `mouse.js`) and dispatches a new `ArrowUp`/... event, which is not trusted.
- `mods/mouse.js` walks by dispatching the same `ArrowUp`/... events, and gives control back to the player only on a
  *trusted* keydown. It never sees the real W (stopped by settings.js) and ignores the re-sent ArrowUp (untrusted), so
  the click-walk is not cancelled.
- Both use the same held-key id in the engine (`pressDir(d, e.code)` with `e.code = 'ArrowUp'`), so the player's
  keyup releases the mouse walk's held direction or the other way round.

**Planned fix**

1. The engine gets a direction hold for mods with its own id, like the joystick's `GT.padDir` (`GT.walkDir(dir, world)`
   with id `mouse`), and `mouse.js` walks with it instead of fake key events: no shared ids.
2. Any direction the player gives (keyboard, re-sent or not, joystick, D-pad) cancels the click-walk at once:
   the engine tells mods when a player direction is pressed (a hook or event), instead of `mouse.js` guessing from
   `isTrusted`.
3. Check: click far, press D halfway: the click-walk stops and D walks; let go: the player stops. 2D and 2.5D, and the
   phone's joystick with tap-to-walk.

## 5. Getting off the carousel leaves the player floating

**What the player sees**: after riding the carousel horse (2.5D) and getting off, the player's figure hangs in the
air above the ground.

**Why**: `view3d.js` `rideShot` lifts the player's figure onto the horse every frame (`actor.pose(0.62 + bob, ...)`).
When the ride stops nothing puts it back: the per-frame pose reset only runs for a bench sit (`a.sat`), and the ride
never sets it.

Seen again by the owner (second screenshot, 2026-11-13): after the ride the figure stands well above the ground, its
shadow left on the ground below.

**Planned fix**: `view3d.js` remembers it was riding; on the first frame after the ride ends it resets the pose
(`pose(0, 0, 1)`), puts the figure on the player's tile and lets the camera glide back (no jump). Same when the ride
ends by walking, Esc, a door or a world change.

## 6. While riding: hide the markers, missions and public chat, and a brighter picture

**What the owner wants**: on the carousel the picture is clean (no mission card, no markers, no public chat) and
brighter.

**Now**: `html.gt-riding` adds letterbox bars and `filter: contrast(1.1) saturate(1.3) sepia(.14) brightness(1.04)`
on the canvas (`css/game.css`); every overlay stays.

**Planned fix**

1. Hidden while `html.gt-riding`: the mission card (`.gt-goals`), public chat log and its input, toasts except the
   "get off" hint, the hotbar and in-hand line, the 2.5D camera buttons, the phone joystick and action button, and the
   canvas overlays drawn by mods (name tags, chat bubbles, markers): those mods skip drawing while `GT_RIDE.on`.
   Party chat messages still arrive and show after the ride.
2. Brighter: raise the grade's brightness (about 1.15) and, in the 2.5D view, a warm fill light on the rider while
   riding so the ride reads at night too; tune by screenshot (day and night).
3. Everything comes back the moment the player gets off.

## 7. The fishing rod looks flat in the 2.5D view

**What the player sees** (owner's screenshot, 2026-11-13): in the 2.5D view the rod, reel and line are a flat
pixel drawing laid over the picture, so they do not turn with the camera, do not sit in the character's hand in depth,
and keep the same size at every zoom.

**Why**: `mods/fishing.js` draws the rod in `onDraw` (`drawRod`: butt, cork grip, reel, tip, line, float) on the
2D overlay canvas, in both views. The 3D kit has no rod.

**Planned fix**

1. A small rod model in the 3D kit (`client/js/three/`, built like the other props from the same palette): a tapered
   two-colour pole with a cork grip and a reel, held in the character's hand on the facing side, raised over the
   water, with a line (a thin curve) down to a red-and-white float that bobs on the water surface.
2. It follows the fishing phases fishing.js already has: cast (the tip swings out), wait (float bobs), bite (float
   dips, splash rings), reel (tip bends toward the float, crank turns, faster while held), catch or miss (rod comes up).
3. In the 2.5D view fishing.js stops drawing its flat rod and the 3D one shows; the 2D view keeps the pixel rod.
4. Check every camera turn (Q / E) and zoom, day and night, facing each of the four sides of water.

## 8. Other players see you fishing

**What the owner wants**: when I fish, other players see the fishing animation on my character.

**Now**: `/api/presence` carries only where a player is and where they face (`x, y, fx, fy, vx, vy, dir, scene`), so
others see someone standing still by the water.

**Planned fix**

1. The presence report gains an activity: `act: 'fish'` with the phase (`cast | wait | bite | reel`) and the float's
   tile, sent only while fishing (players.js asks fishing.js through a small `GT_FISH.state()`).
2. Server (`social.ts` `Seen`): accepts `act` from a fixed list and the float tile only within a few tiles of the player
   and on water; passes it on to the others in the same world; cleared when the next report has none. In memory only,
   like the rest of presence; no ledger rows, nothing on chain.
3. Others draw it: in 2.5D the same 3D rod on that player's figure (item 7), in 2D the pixel rod; the catch shows as a
   small splash. A fish caught is not announced (no spam).
4. Built so other activities can use it later (chopping, mining swings), but only fishing now.
5. Tests: `server/test/presence.test.ts` (act passed on, unknown act refused, float too far refused, cleared after).

## 9. The top bar covers the mission card when it slides down

**What the player sees** (owner's screenshot, 2026-11-13, desktop full window): the floating top bar comes down over
the mission card, which stays where it is. **Fix**: while the bar is out (`html.gt-full:not(.gt-top-hide)`), the
mission card and the Homeland chip move down under it (`--gt-top-h`), with the same slide as the 2.5D buttons.

## 10. Too much text: the mission card and a closed shop's window

**What the player sees** (owner's screenshots): the mission card is a long sentence; a closed shop's window is a wall
of text (why it closed, how to reopen, each good with a long "look for" hint, a long note at the bottom).
**Fix**: each mission is an icon, a few words and one short hint (the full how-to stays as the card's tooltip); the
closed shop shows one line why, one line what to do with the donor count, and per good a row with its icon, a
progress bar, ✓ or "N short · you have M" with a short where-to-get-it; one short line at the bottom.

## 11. Players inside the same building cannot meet

**What the owner saw** (screenshot, 2026-11-13, a house in the public village): inside a building nobody else shows.
**Why**: presence only passed on players outdoors (`social.ts` `nearby` skipped `scene: 'in'`). **Fix**: indoors the
client reports the room (its scene key) and where it stands in it (`room`, `rx`, `ry`); the server shows the others in
the same room of the same world (no merchants, no village guests); players.js draws, tags and clicks only the players
where you are. Test: `presence.test.ts`.

## 12. Reconnect by itself after losing the server

**Fix**: a request with no answer (or 502/503/504 while the host restarts) shows a badge and tries `/api/health` every
3 s; the first answer reloads state and bag (presence keeps polling); a game that started offline because the server
was down reloads the page to come up online. Also found while testing: arriving through a portal could bounce you
straight back (you land beside the ring facing it); the portal now waits until you have stepped off it once.
