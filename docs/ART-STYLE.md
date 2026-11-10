# Art style of the 3D view (one source per kind of thing)

The 3D view has one look: **soft stylised realism**. Rounded, smooth-shaded forms, painterly textures that keep their
detail but not their photo colours, a warm natural palette, soft light. The rule that keeps it strong: **every kind of
thing comes from exactly one source**. Nothing is mixed, so nothing clashes. A new asset must fit its row, or the row
changes for everything of that kind at once.

| Kind | One source | How it is used |
| --- | --- | --- |
| Trees, bushes, grass, flowers | Quaternius nature pack (CC0), `client/assets/models/nature_pack/` | Every tree is `MapleTree_4` (broadleaf and fruit) or `BirchTree_4` (tall). Leaves recoloured to one olive green, per-tree tint within a narrow range. No hand-built trees unless the files fail to load. |
| Ground, paths, sand, cobbles, soil | Poly Haven photo textures, stylised to the palette (`terrain_*.png`) | One lit terrain shader (`r3d/ground.js`), soft blended edges. |
| Rocks, clouds, characters, icons | Our own soft shapes (`R3D.rig.acc`: spheres and capsules, smooth shading) | Same builder everywhere, so they share one language. |
| Houses and buildings | Our own forms, textured with Poly Haven detail maps (`wall_detail.png` stucco, `roof_detail.png` shingles, stone plinth, timber frame) | One building kit (`r3d/buildings.js`): plinth, plastered walls, timber posts and beam, deep shingle roof with ridge cap, framed windows with shutters and flower boxes, arched door. Colour per building from the village palette. |
| People | One procedural human (`r3d/rig.js`): six and a half heads tall, modelled face, hands, eight hairstyles | Same rig in the world, on the character screen and in portraits. |
| Water | One shader palette (`W_DEEP`, `W_SHALLOW` in `r3d/water.js`) | The pool and the waterfall share it. The fall starts as exactly the pool's colour and only gets paler as it falls. |
| Interface | Nunito and Fredoka, glass panels (`css/hud3d.css`), item icons rendered as small 3D models (`r3d/icons.js`) | Only in the 3D view. |

Credits for every file: `docs/ASSET-CREDITS.md`.
