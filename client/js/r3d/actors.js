/*
 * r3d/actors.js - every person in the 3D view (the player, NPCs and bots, merchants, other players) as a 3D rig (rig.js).
 * Position, facing and walking come from the engine's entity list; poses come from the mods through small hooks:
 * GT.charState (combat flash/knock-back/KO), GT_FX.swinging (axe), GT_FISH.active (fishing), npc.cosmetic (Homeland hats).
 * GT.charDraw is still called on a scratch canvas so mods that remember where each character is (combat bars, KO stars)
 * keep working with the same coordinates the compat overlay uses.
 */
(function () {
  'use strict';
  var R3D = window.R3D = window.R3D || {};
  var THREE = window.THREE, GT = window.GT;
  if (!THREE || !R3D.rig) return;

  var pool = null, T = 12, scratch = null, sg = null;

  function ownLook() {
    var c = window.GT_CHARSCREEN; try { return c && c._mine ? (c._mine().look | 0) : 0; } catch (e) { return 0; }
  }

  R3D.actors = {
    init: function (C) {
      pool = new Map(); T = (window.SPRITES && SPRITES.TILE) || 12; this.frame = 0;
      this.group = new THREE.Group(); C.scene.add(this.group);
      scratch = document.createElement('canvas'); scratch.width = scratch.height = 64; sg = scratch.getContext('2d');
    },
    onWorld: function () {},
    playerRig: function () { var e = pool && pool.get('P'); return e ? e.rig : null; },
    update: function (C, info) {
      var frame = ++this.frame, ents = info.ents, i, t = info.timeAcc;
      var fx = window.GT_FX, fish = window.GT_FISH;
      for (i = 0; i < ents.length; i++) {
        var en = ents[i], key, px, py, look, dir, moving, n = null, isP = false, st;
        if (en.char) { key = 'c:' + (en.char.id != null ? en.char.id : i); px = en.char.x; py = en.char.y; look = en.char.look; dir = en.char.dir; moving = en.char.step > 0; }
        else if (en.n) { n = en.n; key = n; px = en.px; py = en.py; look = n.pal | 0; dir = n.dir; moving = en.step > 0; }
        else if (en.n === null) { isP = true; key = 'P'; px = en.px; py = en.py; look = ownLook(); dir = en.dir; moving = en.step > 0; }
        else continue;
        if (px == null) continue;
        if (n || isP) { try { if (typeof GT.charDraw === 'function') GT.charDraw(sg, n, px, py, look, dir, en.step || 0); } catch (e) { /* ignore */ } }
        var entry = pool.get(key);
        if (!entry || entry.rig.look !== look) {
          if (entry) { R3D.rig.destroy(entry.rig); }
          entry = { rig: R3D.rig.create(look, { ghost: isP }), seen: 0 };
          pool.set(key, entry); this.group.add(entry.rig.root);
        }
        entry.seen = frame;
        var cs = null;
        if ((n || isP) && typeof GT.charState === 'function') { try { cs = GT.charState(n); } catch (e) { cs = null; } }
        st = { moving: moving, t: t + (typeof key === 'string' ? 0 : (n && n.x || 0) * 0.37), dir: dir, swing: null, fish: false, ko: !!(cs && cs.ko), side: cs ? cs.side : 1, tint: cs ? cs.tint : null };
        if (isP) {
          st.swing = fx && fx.swinging ? fx.swinging() : null;
          st.fish = !!(fish && fish.active && fish.active());
        }
        if (n) R3D.rig.setHat(entry.rig, n.cosmetic || null, n.cosmeticColor);
        R3D.rig.pose(entry.rig, st);
        var ox = cs ? cs.ox : 0, oz = cs ? cs.oy : 0;
        entry.rig.root.position.set((px + 6 + ox) / T, 0, (py + 6 + oz) / T);
      }
      pool.forEach(function (e, key) {
        if (e.seen !== frame) { R3D.rig.destroy(e.rig); pool.delete(key); }
      });
    },
    dispose: function (C) {
      if (pool) pool.forEach(function (e) { R3D.rig.destroy(e.rig); });
      if (this.group) C.scene.remove(this.group);
      R3D.rig.disposeAll();
      pool = null; this.group = null; scratch = sg = null;
    }
  };
})();
