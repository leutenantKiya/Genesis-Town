/*
 * r3d/props.js - things that stand up from the ground, as camera-facing billboards built from the existing 2D art:
 * tree canopies (instanced, one InstancedMesh per tree kind) and market stall awnings. Trunks, shadows and everything else
 * stay in the baked ground texture until phase 3 replaces them with real meshes. Depth sorting works because a billboard
 * facing the camera has one depth, its foot's.
 */
(function () {
  'use strict';
  var R3D = window.R3D = window.R3D || {};
  var THREE = window.THREE;
  if (!THREE) return;

  var T = 12, group = null, items = [], fogCol = new THREE.Color(0.45, 0.4, 0.62);
  var DAYC = new THREE.Color(1, 1, 1), NIGHTC = new THREE.Color(0.42, 0.46, 0.72);

  // canopy sprite: 36 x 36 canvas, the tile's top-left at (10, 22), feet (trunk base) at (16, 33)
  var CAN = { w: 36, h: 36, ox: 10, oy: 22, fx: 16, fy: 33 };
  // awning sprite: 16 x 20 canvas, the stall tile's top-left at (2, 12), feet at the tile's top edge (8, 12)
  var AWN = { w: 16, h: 20, ox: 2, oy: 12, fx: 8, fy: 12 };

  function planeGeo(s) {
    var gm = new THREE.PlaneGeometry(s.w / T, s.h / T);
    gm.translate(-(s.fx - s.w / 2) / T, -(s.h / 2 - s.fy) / T, 0);
    return gm;
  }
  function texFrom(c) {
    var t = new THREE.CanvasTexture(c);
    t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  function spriteMat(tex) {
    return new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.04, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  }

  function clear(C) {
    if (group) {
      C.root.remove(group);
      group.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
    }
    group = null; items = [];
  }

  R3D.props = {
    init: function (C) { T = (window.SPRITES && SPRITES.TILE) || 12; group = null; items = []; },
    onWorld: function (C, map) {
      clear(C);
      group = new THREE.Group(); C.root.add(group);
      var Sp = window.SPRITES, q = C.cam.quaternion, i;
      if (map.canopies && Sp && Sp.drawCanopy) {
        var byKind = {};
        map.canopies.forEach(function (cn) { (byKind[cn.kind] = byKind[cn.kind] || []).push(cn); });
        Object.keys(byKind).forEach(function (kind) {
          var c = document.createElement('canvas'); c.width = CAN.w; c.height = CAN.h;
          var g = c.getContext('2d'); g.imageSmoothingEnabled = false; Sp.drawCanopy(g, kind, CAN.ox, CAN.oy);
          var list = byKind[kind], mat = spriteMat(texFrom(c));
          var im = new THREE.InstancedMesh(planeGeo(CAN), mat, list.length);
          var m4 = new THREE.Matrix4(), pos = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
          for (i = 0; i < list.length; i++) {
            pos.set((list[i].x * T + 6) / T, 0, (list[i].y * T + 11) / T);
            m4.compose(pos, q, one); im.setMatrixAt(i, m4);
            im.setColorAt(i, list[i].fog ? fogCol : DAYC);
          }
          im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true;
          im.frustumCulled = false;
          group.add(im); items.push({ mat: mat });
        });
      }
      if (map.market && map.market.stalls && Sp && Sp.drawAwning) {
        var cache = {};
        var ag = planeGeo(AWN);
        map.market.stalls.forEach(function (st) {
          var m = cache[st.color];
          if (!m) {
            var c = document.createElement('canvas'); c.width = AWN.w; c.height = AWN.h;
            var g = c.getContext('2d'); g.imageSmoothingEnabled = false; Sp.drawAwning(g, AWN.ox, AWN.oy, st.color);
            m = cache[st.color] = spriteMat(texFrom(c)); items.push({ mat: m });
          }
          var mesh = new THREE.Mesh(ag, m);
          mesh.position.set((st.x * T + 6) / T, 0, (st.y * T) / T);
          mesh.quaternion.copy(q);
          group.add(mesh);
        });
      }
    },
    update: function (C, info) {
      var col = DAYC.clone().lerp(NIGHTC, Math.min(1, info.dark));
      for (var i = 0; i < items.length; i++) items[i].mat.color.copy(col);
    },
    dispose: function (C) { clear(C); }
  };
})();
