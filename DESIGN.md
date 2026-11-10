# Genesis Town: design direction

Agreed with the owner 2026-11-10. This file is the art direction for the game's look: the UI (HUD, windows, controls)
and the world (seasonal colour, light, buildings that go see-through). Tokens live in `client/css/theme.css`; this file
says what they are for and why.

**Design read:** in-game HUD and windows of a cosy pixel-art market-town sim, for hackathon judges and casual players,
in a chunky-outline storybook-pixel language. Dial **ENERGY 2 / RHYTHM 2 / MOTION 2**.

References the owner chose, and what we take from each (craft, not identity):
- genoblox.com (an HD-2D engine): windows built as trays (a frame holding cells one tone step apart), a header strip
  with the title left and metadata right, bevelled buttons, short motion, wall occlusion (buildings cut away when the
  hero is behind them), warm light and depth in the world.
- A Threads post of a cartoon ranch HUD: cream cards with a thick dark outline and a darker bottom edge, stat pills, a
  key-hint bar with key caps, a coloured strip per character card.
- Owner's choice between them: **hybrid**. The HUD is a dark tray; windows stay cream paper with a thick outline; the
  window header and the HUD strip take the colour of the season.
Not taken: genoblox's glass, blur, soft drop shadows, pills everywhere, its green button and its typeface.

## Identity

The thing only this game has: a town whose prices, weather and seasons move for everyone. So **the season is the
motif**. One accent and one header tone per season, on every window header, on the HUD strip, on the primary button,
and in the world's grass, leaves and light. Open the game in Gugur and it is unmistakably autumn; nothing else changes
place.

## Colour

Constant base (never changes with season): dark HUD `--hud`, paper windows `--paper`, ink `--paper-ink`, and the status
colours `--good`, `--bad`, `--gold` (coin), `--energy`. Reason: players must find coin, energy and danger by the same
colour all year.

| Season | Accent `--accent` | Header `--season` | Why |
| --- | --- | --- | --- |
| Semi (spring) | `#f28fb0` blossom | `#24382a` moss | fruit trees flower in spring |
| Panas (summer) | `#34c3c9` sea teal | `#163a44` deep teal | bright water, the fishing season |
| Gugur (autumn) | `#f0903a` pumpkin | `#3a2616` bark | turned leaves, harvest |
| Dingin (winter) | `#8fc8f2` ice | `#1e3046` slate | snow light |

Rules (contrast computed, numbers in `theme.css`):
- The accent is a **fill with an ink label** (primary button, selected tab, active slot) or **text on the dark HUD or
  the season header**. It is never text on paper (1.6-2.1:1). On paper an accent fill always carries the ink outline.
- One accent per screen, on the one thing to do next. Everything else is ink on paper or paper on dark.
- Surfaces separate by one tone step (`--paper` → `--paper-2` → `--paper-3`, `--hud` → `--hud-2` → `--hud-3`), not by
  hairlines.
- No violet or indigo, no gradients on surfaces (the energy bar's fill is flat `--energy`).

## Shape

Chunky and hard-edged, because the world is 12px pixel art and soft shadows fight it.
- Outline: `--line` (2px) ink on paper things, `--outline` on HUD things.
- Depth: a hard darker bottom edge `--edge` (3px), as `box-shadow: inset 0 calc(-1 * var(--edge)) 0 var(--shade)`.
  No blur, no drop shadows. A window floats over the game with a flat scrim behind it, not a soft shadow.
- Radius: `--r-win` (6px) for windows, cards and the HUD strip; `--r-ctl` (4px) for buttons, chips, slots and inputs.
  Nothing is a pill.
- Inside a cell, a 1px top highlight (`--paper-hi` / `--hud-hi`) is allowed; it is the bevel, not decoration.

## Type

- `--font` (Pixelify Sans) for everything people read, 14px and up (12px minimum for metadata), times `--ts`.
- `--font-display` (Press Start 2P) only at 16px or 24px: window titles, the title card, big counters. It blurs at
  other sizes.
- Numbers use tabular figures (`font-variant-numeric: tabular-nums`) and align right in columns.
- Sentence case. No tracked uppercase labels.

## Components

**Window (`.mbox`) = a tray.** Paper frame with the ink outline and bottom edge. Header band 44px in `--season` with
the title in `--season-ink` (display font, 16px) on the left, optional metadata on the right, and a 32px square close
button. Body on `--paper`; rows, cards and detail panels are cells on `--paper-2` with the top highlight, 6px apart.
Footer buttons right-aligned. Phone: the same tray as a bottom sheet with a 44px header.

**Buttons.** Height 40px (44px on phones), radius `--r-ctl`, outline, bottom edge.
- Primary (one per window): `--accent` fill, `--accent-ink` label.
- Secondary: `--paper-ink` fill, `--paper` label (on paper); `--hud-2` fill, `--hud-ink` label (on the HUD).
- Danger: `--bad` fill, paper label.
- Hover: one tone step lighter. Pressed: the button moves down 2px and loses its bottom edge (`--t-press`).
  Focus: a 3px outline in `--paper-ink` on paper, `--accent` on dark, offset 2px. Disabled: 45% opacity,
  `cursor: not-allowed`.

**HUD strip.** `--hud` ground; a 4px band of `--season` along its lower edge is the season's mark. Each value (place,
coin, clock, energy, day/season/weather) sits in a pill-less stat cell: `--hud-2` fill, radius `--r-ctl`, the top
highlight, icon dot + value in `--hud-ink`. The place name is in `--accent`. HUD buttons are secondary buttons; the
account button (Tas / Masuk) is the primary.

**Hotbar slots.** `--hud-2` cells with the outline; the held slot gets an `--accent` outline (3px) and lifts 2px; the
count sits bottom-right in tabular figures on a dark chip.

**Item cards (`.gt-card`).** Cells on `--paper-2`, outline, bottom edge. Selected: `--paper-3` and a 3px ink outline.
Unavailable: 45% opacity and the words say why ("tidak dibeli"), never colour alone.

**Status chip.** Radius `--r-ctl`, 12px text, a 6px square dot plus words: `tersimpan` (good), `disimpan 06:00`
(neutral), `gagal` (bad), `Tutup` (bad), `Buka` (good). The dot is redundant with the word on purpose.

**Key hint (`#gt-hint`).** A dark chip with a key cap (a `--hud-3` square with the outline and the key letter) and a
short verb: "F Tebang". Hidden on phones, where the A button does it.

**Chat, fight bar, fishing, toasts, title card, character screen.** Same tray language: fight bar and title card are
paper trays with a season header; chat lines and toasts are dark chips (`--hud` at 85% opacity, no blur); private chat
lines carry a 3px left strip in `--accent` (their one coloured strip, with the words "kamu → nama").

**Phone controls.** The D-pad, A/E buttons and the tab bar stay translucent glass with blur and an opaque fallback: the
owner asked for this on 2026-11-04. It is the only glass in the game (two clusters); the chat box and the fishing
button are opaque.

## Motion

- Windows open in `--t-open` (180ms): from 96% scale and 8px lower, `--ease`. They close without animation.
- Buttons press in `--t-press`.
- The HUD's season band and accent cross-fade over 600ms when the season changes.
- Under `prefers-reduced-motion` or the game's "Kurangi animasi": no travel, no scale; state changes are instant.
- Nothing bounces, floats or pulses on its own.

## World

Seasonal ramps (dark / base / light / highlight), swapped in place like the existing snow swap, re-baked once when the
season changes. Tile shapes, buildings, characters and the night overlay do not change.

Path in Semi, Panas and Gugur: `#a8642c #d89c48 #e8b45c #f4cc78` (lighter than today so the path reads against grass
by brightness, not only hue).

| | Semi | Panas | Gugur | Dingin |
| --- | --- | --- | --- | --- |
| grass | `#3f8a2e #5fae36 #7cc23e #a8d84a` | `#3a7c26 #58a830 #84c43a #c6e05a` | `#4e5a24 #7c8a34 #a0a444 #c8c06a` | `#b8c6d8 #e8eef5 #f4f7fb #ffffff` (snow) |
| path | as above | as above | as above | `#6e645e #a89c92 #c4bab2 #dcd6d0` |
| oak leaf | `#1d4a2a #2e7a3a #48a046 #86c85a` | `#1a4626 #2b7234 #4a9c3c #96cc4e` | `#4a1e14 #a3441e #d07028 #f0b048` | bare `#3e2a20 #5e4434 #7e6450 #e8eef5` |
| pine | `#123a30 #1f5c44 #2f7d52 #5aa860` | `#113a2c #1d5e40 #2e8050 #62ac5c` | `#13362c #1e543e #2c724a #4f9654` | `#10302a #1a4e3c #2a6a4a #f4f7fb` (snow-capped) |
| fruit tree | `#1d4a2a #2f7d3a #4fa646 #f2a8c0` (blossom) | `#1a4626 #2c7a34 #58a840 #f09a3a` (fruit) | `#4a3a14 #9a7422 #c8a034 #ecd068` | bare, as oak |
| water | `#17507e #2a8cc0 #64c4e2 #e4f6f2` | `#145a7e #1f96b8 #5cd0dc #eafcf6` | `#1a4a6a #2e7aa0 #6aaec6 #dceee6` | `#1e4a6a #3a7ea6 #8cc4dc #f0f8fa` |
| ambient light | `rgba(255,236,214,.05)` | `rgba(255,214,150,.08)` | `rgba(255,168,96,.10)` | `rgba(196,216,255,.10)` |
| shadow | `rgba(30,38,64,.30)` | `rgba(28,34,62,.34)` | `rgba(34,34,52,.32)` | `rgba(70,96,150,.28)` |

The ambient light is one flat fill over the world by day, scaled by daylight, drawn before the night overlay; capped at
0.12 alpha so item and status colours in the world stay true. The minimap uses the same ramps.

### See-through buildings

Buildings stand one tile taller than their footprint (the roof rises 12px above it), are drawn in the y-sorted pass
instead of being baked into the ground, and fade when the player would be hidden.
- Behind: when the player's feet are in the row just north of a building's footprint (within its width), that building
  fades to **40%** opacity over **250ms** (ease-out) and returns over **200ms**. Only the local player triggers it.
- Entering: when the player steps into a door, the building fades to **25%** over **180ms** as they walk in, then the
  scene changes; coming out, it starts at 25% and returns over **300ms**.
- Tree canopies fade the same way (to 45%) when the player stands under one.
- Other characters hidden behind an opaque building are not revealed (no flicker from NPCs).
- Reduced motion: jump straight to the target opacity; the transparency stays because it is functional.
- The drop shadow stays baked in the ground and never fades. Footprints, doors and collision do not change.

## Reasons, in one line each

- Season as the motif: it is the one thing only this game's world does for every player at once.
- Dark HUD, paper windows: the HUD must recede over a bright world; windows are where people read, and ink on paper
  reads best.
- Thick outline and hard bottom edge: the same line weight as the pixel art, so UI and world look like one drawing.
- One accent: it marks the next action; a second would compete with coin gold and energy lime.
- Two radii, no pills: hierarchy by size and tone, not by shape variety.
- Display font at 16/24px only: it is a bitmap face and blurs elsewhere.
- Alpha fade for buildings: it keeps the building's silhouette, and it is what players of farming sims already know.

## Owner overrides on record

- Glass on the phone controls (D-pad, A/E, tab bar): kept at the owner's request (2026-11-04), with an opaque fallback.
- Cream paper windows next to warm accents: kept as the game's RPG dialog identity; the header tones are dark and the
  accents saturated, so it is not a cream-and-terracotta scheme.
