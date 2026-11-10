# Asset credits

Third-party art used by Genesis Town. Everything listed here is **CC0 (public domain)**; credit is not required but given.
The game's own pixel art, sprites, procedural 3D buildings, characters and effects are original and drawn in code.

## In use

| File | Source | Licence | What it is |
| --- | --- | --- | --- |
| `client/assets/textures/cliff_detail.png`, `cliff_normal.png` | [Poly Haven, "Cliff Side"](https://polyhaven.com/a/cliff_side) | CC0 | Layered sandstone. The colour map is reduced to a grey detail map (our own cliff colours stay in charge) and the normal map gives the strata relief on the floating islands' undersides (3D view). 1K, resized to 512. |
| `client/assets/textures/wood_floor.png` | [ambientCG, "Wood 095"](https://ambientcg.com/view?id=Wood095) | CC0 | Warm wood grain for the floors of rooms (3D view). 1K, resized to 512 x 256, slightly desaturated. |

## Looked at and not used

- **Poly Haven "Aerial Mud 1"**: dark tyre tracks, wrong mood. **Poly Haven models and HDRIs**: photoreal scans and skies; they clash with the low-poly pastel look.
- **Kenney** (kenney.nl), **Quaternius** (quaternius.com), **itch.io** packs: no direct download (Kenney blocks scripted downloads;
  Quaternius and itch.io hand out packs through Google Drive and download pages). They are CC0 and a good match for the
  style. To use them, download a pack and put the `.glb` files in `client/assets/models/`.

## Where textures are loaded

`client/js/r3d/assets.js` (lazy: nothing is fetched in the 2D view). Used by `r3d/island.js` (cliffs) and `r3d/interior.js` (floors).
