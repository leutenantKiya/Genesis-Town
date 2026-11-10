/*
 * r3d/compat.js - keeps the existing 2D mods working in the 3D view until phase 6 moves their effects to real 3D.
 *  - onDrawGround hooks (crops, fishing ripples) draw into a transparent canvas laid flat on the ground around the player.
 *  - onDraw hooks (monsters, axe swing, timers, bubbles) draw on the 2D canvas above the WebGL canvas, through an affine
 *    transform that maps map pixels onto the ground plane's projection. Flat things are exact; upright things lean a bit.
 * Mods are called exactly as in 2D (ctx, camX, camY, T); only the coordinate frame changes.
 */
(function () {
  'use strict';
  var R3D = window.R3D = window.R3D || {};
  var THREE = window.THREE;
  if (!THREE) return;

  var WT = 48, HT = 36;           // decal window in tiles
  var T = 12, cv = null, g = null, tex = null, mesh = null, mat = null, lastOx = 1e9, lastOy = 1e9;
  var v = new THREE.Vector3();

  function proj(C, X, Y, w, h) { // map px -> canvas px
    v.set(X / T, 0, Y / T).project(C.cam);
    return [(v.x + 1) / 2 * w, (1 - v.y) / 2 * h];
  }

  R3D.compat = {
    init: function (C) {
      T = (window.SPRITES && SPRITES.TILE) || 12;
      cv = document.createElement('canvas'); cv.width = WT * T; cv.height = HT * T;
      g = cv.getContext('2d'); g.imageSmoothingEnabled = false;
      tex = new THREE.CanvasTexture(cv);
      tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false; tex.colorSpace = THREE.SRGBColorSpace;
      mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
      var geo = new THREE.PlaneGeometry(WT, HT); geo.rotateX(-Math.PI / 2);
      mesh = new THREE.Mesh(geo, mat); mesh.position.y = 0.02; mesh.renderOrder = 1; mesh.frustumCulled = false;
      C.scene.add(mesh);
    },
    onWorld: function () {},
    update: function (C, info) {
      // 1) ground decals around the player
      var ptx = info.player.pos.px / T, pty = info.player.pos.py / T;
      var ox = Math.floor(ptx - WT / 2), oy = Math.floor(pty - HT / 2);
      mesh.position.set(ox + WT / 2, 0.02, oy + HT / 2);
      g.clearRect(0, 0, cv.width, cv.height);
      info.call('onDrawGround', [g, ox * T, oy * T, T]);
      tex.needsUpdate = true;
    },
    // 2) overlay on the 2D canvas, drawn after the WebGL frame
    overlay: function (C, info) {
      var ctx = info.ctx, w = ctx.canvas.width, h = ctx.canvas.height;
      var O = proj(C, 0, 0, w, h), PX = proj(C, T, 0, w, h), PY = proj(C, 0, T, w, h);
      ctx.save();
      ctx.setTransform((PX[0] - O[0]) / T, (PX[1] - O[1]) / T, (PY[0] - O[0]) / T, (PY[1] - O[1]) / T, O[0], O[1]);
      ctx.imageSmoothingEnabled = false;
      try { info.call('onDraw', [ctx, 0, 0, T]); } finally { ctx.restore(); }
    },
    dispose: function (C) {
      if (mesh) { C.scene.remove(mesh); mesh.geometry.dispose(); }
      if (mat) mat.dispose(); if (tex) tex.dispose();
      cv = g = tex = mesh = mat = null;
    }
  };
})();
