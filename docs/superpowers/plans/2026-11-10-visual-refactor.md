# Visual refactor: seasonal UI and world, see-through buildings

Status: plan, 2026-11-10. Direction: [DESIGN.md](../../../DESIGN.md). Tokens: `client/css/theme.css` (CSS) and
`client/js/theme.js` (`GT_THEME`, for canvas code). No game rule, server code or contract changes.

## Team

| Role | Model | Does |
| --- | --- | --- |
| Orchestrator | the session's main model | Art direction (DESIGN.md, tokens), the split below, scaffolding, review of every hand-back, final gate and commit |
| Researchers (done) | Opus | Reference study (genoblox.com, the Threads post, galleries); game-art study (seasonal palettes with contrast numbers, occlusion techniques); code map (render pipeline, palettes, CSS inventory) |
| Baseline recorder (done) | Sonnet | A reusable capture script and the "before" screenshots of 19 screens on desktop and phone |
| Executors | **Sonnet 5.5, medium effort** | One work package each, in parallel, with no shared files |
| Auditor | a strong model, read-only | "After" screenshots with the same script, the taste inspector, the antislop Delivery Gate; a ranked findings list. Does not fix |

Order: A1, B, C and D run in parallel. A2 starts when A1 is done (both need `engine.js`). Then the auditor; then one
fix round by the executor that owns each finding.

## Rules for every executor

1. Read `DESIGN.md`, `client/css/theme.css`, `client/js/theme.js` and `CLAUDE.md` first. DESIGN.md decides; if it and
   this plan disagree, say so in your report and follow DESIGN.md.
2. Touch only the files of your package. If you need a change in someone else's file (a token, an engine hook), do not
   make it: describe it under "Requests" in your report.
3. No new dependencies, fonts, images or icon sets. No gameplay or server changes. Indonesian UI text stays as it is
   unless your package says otherwise; no em dash in any UI text.
4. Colours come from tokens: `var(--token)` in CSS, `GT_THEME.get('token')` on canvas. No new hard-coded hex in UI
   code (world art palettes in package A are the exception).
5. Every control keeps a visible focus state, `cursor: pointer` (or `not-allowed` when disabled), hover, pressed and
   disabled states, and a 44px touch target on phones. Motion respects `html.gt-reduced-motion` and
   `prefers-reduced-motion`.
6. Do not run `git commit`, `git checkout`, `git stash` or `git reset`. Do not touch ports 3000, 3001 or 9336 unless
   your package gives them to you.
7. Before reporting: every JS file you edited parses (`node -e "new Function(require('fs').readFileSync(f,'utf8'))"`),
   and `npm test` passes from the repo root.
8. Look at your work. Start your own mock server and headless Chrome on the ports your package names, model your
   script on `<VR>/capture.mjs` (login, character screen, opening each window), take screenshots at 1440x900 and
   390x844 and open them with the Read tool. Fix what looks wrong before you report.
   `<VR>` = `/tmp/claude-1000/-home-kiya-Documents-genesis-town/1e9d711b-8d2c-4f9b-8730-907c3205cc29/scratchpad/vr`.
   Mock server: `PORT=<port> CHAIN_MODE=mock DEV_LOGIN=1 DEV_TOOLS=1 DB_PATH=<VR>/mock-<port>.db
   GAME_CONTRACT_ID=game.genesistown.mock PLAYERS_PARENT_ACCOUNT_ID=players.genesistown.mock node server/src/main.ts`.
   Chrome: `google-chrome --headless=new --remote-debugging-port=<port> --user-data-dir=<VR>/chrome-<port>
   --no-first-run --hide-scrollbars about:blank`. Stop both when you finish.
9. Report: files changed; what you did per item; one line of reason for each visual decision that DESIGN.md did not
   already make; screenshots you looked at (paths); test results; "Requests" for other packages; anything not done.

## Package A1: the world follows the season (ports: mock 3002, Chrome 9342)

Files: `client/js/art.js`, `client/js/sprites.js` (tile palettes and caches only), `client/js/buildings.js` (the
cached bridge tile only), `client/js/engine.js` (`GT.setSnow` → `GT.setSeason`, `buildWorldCache` tint, minimap
colours; do NOT touch `render()` or how buildings are drawn: that is A2), `client/js/mods/chain.js` (only
`applyWeatherClass`, `snowOn`, the `?musim=` preview and `drawWeather`).

1. `SPRITES.setSeason(season, snowy)` in `art.js`, replacing `setSnow` (keep `setSnow` as a thin wrapper): swap the
   ramps of DESIGN.md "World" in place for grass, path, plaza (keep today's plaza for the three warm seasons and the
   snow plaza in winter), water, and the three leaf ramps (oak, pine, fruit), plus tall grass and flowers as today.
   Clear every cache that holds those colours: `groundCache`, the tile cache, **the canopy cache** (leaves stay green
   today), the cached bridge tile in `buildings.js`. Snow on the ground still follows today's rule (season Dingin or
   snowy weather); the leaf ramps follow the season alone. Return whether anything changed.
2. `GT.setSeason(season, snowy)` in `engine.js`: calls the above; when it changed, rebuilds the world cache and the
   minimap cache; always sets exactly one class `gt-s-<season>` on `<html>` (indoors too); emits `'season'`. Keep
   `GT.setSnow` working for old callers. The minimap (`MM_COL`) takes grass, path, water and tree colours from the
   current ramps. The noise tint in `buildWorldCache` gets a per-season pair (today it has green/yellow and a snow
   branch).
3. `chain.js`: `applyWeatherClass` calls `GT.setSeason(seasonNow(), snowOn())`. `?musim=semi|panas|gugur|dingin`
   previews a season on the client (world and UI class) without the server; `?musim=dingin` keeps working.
4. Ambient light and shadows: draw the season's ambient light (DESIGN.md table) as one flat fill over the visible
   world, scaled by daylight, before the night overlay; if that needs a hook inside `render()`, put the fill at the
   start of `chain.js` `drawWeather` instead and say so. Building and tree shadows use the season's shadow colour.
5. Check with screenshots of the Homeland by day in all four seasons (`?musim=`) and of the minimap in Gugur; the
   path must read against grass in each; leaves must change; winter must still look like winter.

## Package A2: buildings and trees go see-through (after A1; ports: mock 3002, Chrome 9342)

Files: `client/js/engine.js` (`buildWorldCache`, `render()`, door entry), `client/js/sprites.js` (house, mart, casino
art), `client/js/buildings.js` (public and Homeland building art), `client/js/art.js` (canopies).

Follow DESIGN.md "See-through buildings" exactly (numbers there).
1. Every outdoor building's art becomes one tile (12px) taller than its footprint: the extra is roof, drawn in the
   building's own roof style (extend the roof upward: more rows of the same tiles or planks, the ridge on top); walls,
   doors, signs and the footprint stay where they are. Each draw function keeps producing one cached canvas; add the
   rise there. Homeland lots, the portal and locked-chunk fog stay baked.
2. Buildings leave the world cache and join the y-sorted list in `render()` with the baseline at the bottom of their
   footprint, drawn at `y - 12`; their drop shadow stays baked. Cull buildings outside the view.
3. Fade state per building (`alpha`, `target`), advanced by real time in the frame loop: behind rule, door-entry rule
   and return, as specified. The existing black transition on entering a building stays, after the 180ms fade.
   Tree canopies fade to 45% when the player's tile is under one.
4. Labels that other mods draw over buildings in `onDraw` (Homeland "+n" tags, countdowns) stay as they are.
5. Reduced motion: no tween. Performance: no per-frame canvas allocation; `globalAlpha` is reset after each draw.
6. Check: stand north of the Town Hall (Homeland) and of a house in the public area: the building is translucent and
   the player visible; step away: it returns; walk into a public building's door: it fades as the player enters.
   Night must still look right (the overlay covers buildings too). Screenshots of each.

## Package B: UI tokens and core components (ports: mock 3001, Chrome 9336, and `<VR>/capture.mjs` as is)

Files: `client/css/game.css`, `client/css/chain.css`, `client/css/phone.css`, `client/css/settings.css`,
`client/css/sim.css`, `client/index.html`. You may append tokens to the end of `client/css/theme.css` under a comment
`/* added by package B */` when a component needs one; do not change existing values.

1. Delete the colour and font tokens from `game.css :root` (they now live in `theme.css`, which is linked first) and
   replace every hard-coded colour in the five stylesheets with tokens. Target: no hex or rgba left in component rules
   except pure black/white overlays you can justify in one line.
2. Rebuild each component to DESIGN.md "Components", "Shape", "Type" and "Motion": window tray with the 44px season
   header (`.mbox .mhead .mtitle .mx .mbody .mfoot`), buttons (`.btn`, `.mbtn`, primary/secondary/danger, all states),
   HUD strip and stat cells (`.hud .cell`, the season band), hotbar slots, item cards and grids, detail panels, history
   rows, status chips (`.chain-st`), the key hint, toasts, chat, fight bar, fishing bar and button, title card,
   character screen, goals box, tab bar, map overlay and legend, settings, the dialog box (`#dlg`), the Simulasi panel.
   Markup you need changed inside `index.html` is yours; markup built by JS mods is not (ask under "Requests").
3. The accent rule: an accent fill always carries an ink label (never white), and the accent is never text on paper.
   Find every place the old crimson `--btn` or lime `--accent` was used and decide per DESIGN.md.
4. Glass (backdrop blur) stays only on the phone D-pad, A/E and the tab bar; remove it from chat and fishing.
5. Window open motion (`--t-open`), button press (`--t-press`), the season cross-fade on the HUD band; all off under
   reduced motion.
6. Check: run `node <VR>/capture.mjs <VR>/after-B` and read the sheets; then all four seasons on the Tas window and
   the HUD with `?musim=`. Run the inspector:
   `node /home/kiya/.claude/plugins/cache/taste-skill/taste-skill/2.1.5/skills/taste-skill/scripts/inspect.mjs --app "http://localhost:3001/?nosw" --out .taste-skill/after-B`
   and fix its FAILs, except glass on the phone controls and the chunky outlines it reads as shadows (owner
   overrides, DESIGN.md).

## Package C: the mods' own UI (ports: mock 3003, Chrome 9343)

Files: `client/js/mods/homeland.js`, `client/js/mods/trade.js`, `client/js/mods/hotbar.js`, `client/js/mods/sim.js`,
`client/js/mods/soul.js`, `client/js/mods/charscreen.js`, and the new stylesheet `client/css/mods.css` (already
linked, empty).

1. Move every inline style and injected `<style>` that sets colour, font, border or radius into classes in
   `mods.css` built from tokens: the Town Hall menu, lots and builder dialogs, fatigue and motivation bars, the rare
   badge, the trade / Titip Jual / Papan Juara windows, the Jiwa (`.sl-*`) panel, the Simulasi charts' colours
   (`sim.js` constants read tokens through `GT_THEME.get`), the hotbar's icon palettes stay (they are item art).
   Use the shared classes that package B restyles (`.mbtn`, `.gt-card`, `.gt-detail`, `.mrow`, `.chain-dim`) wherever
   they fit, so these windows look like the rest; add a class only for what is truly specific.
2. Canvas labels in `homeland.js` and `trade.js` ("+n", countdowns, pops, stall labels) use `GT_THEME.label` /
   `GT_THEME.text` instead of their own fonts and colours.
3. Homeland progress reads at a glance: bars are flat fills with the value in words next to them ("Lelah 62%"), a
   timer shows the time left in tabular figures, a locked item says what unlocks it.
4. Check: Town Hall menu, a lot's build dialog, the bots list with a fatigue bar, Titip Jual, Papan Juara and the
   Jiwa panel, desktop and phone, in two seasons.

## Package D: text drawn on the canvas (ports: mock 3004, Chrome 9344)

Files: `client/js/mods/players.js`, `client/js/mods/actfx.js`, `client/js/mods/fishing.js`.

1. Name tags, chat bubbles, floating numbers, the fishing line/bobber colours and any other canvas text use
   `GT_THEME` (`label` for chips, `text` for outlined numbers, `get` for raw colours), so they follow the tokens and
   the season. Merchants (tag `NPC`) get the `accent` tone on their name chip; players the `dark` tone; your own
   bubble and others' bubbles the `paper` tone.
2. Floating numbers: damage and "KO!" in `--gold`, energy lost in the warning colour, misses in `--hud-dim`.
3. The fishing reel UI keeps its mechanics; its DOM is styled by package B, you own only what `fishing.js` draws on
   the canvas and any inline style it sets.
4. Check: two browsers in the public area (name tags, a bubble), a fight (numbers), fishing (line and float), in two
   seasons.

## Auditor (after all packages)

Read-only. Inputs: `<VR>/before/` and a fresh `<VR>/after/` made with `<VR>/capture.mjs`; DESIGN.md.
1. Read both contact sheets side by side, then each "after" screen at full size.
2. Run the taste inspector (`--app`) at the three widths; list FAIL and WARN.
3. Run the antislop Delivery Gate, all four blocks, with evidence per item (file and line, or the screenshot).
4. Check the four seasons (`?musim=`) on the HUD, one window and the world; check reduced motion; keyboard-only
   passage through one window (Tab, Enter, Escape); contrast of every text/background pair that DESIGN.md names.
5. Output: a numbered findings list, most severe first, each with the screen, what is wrong, the rule or DESIGN.md
   line it breaks, the owning package, and the smallest fix. Then a verdict: ship, or fix these numbers first.
