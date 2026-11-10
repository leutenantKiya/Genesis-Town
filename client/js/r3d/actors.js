/*
 * r3d/actors.js - characters as camera-facing billboards. Each actor (the player, NPCs and bots, other players) has a small
 * canvas that the existing 2D character art (GT.charDraw / GT.drawChar, so looks, combat flashes and KO poses keep working)
 * is drawn into, uploaded as a texture on a plane. One sprite pixel = 1/12 world unit, so it matches the pixel scale of the
 * ground. The feet sit on the map pixel the 2D view would draw them at.
 */
(function () {
  'use strict';
  var R3D = window.R3D = window.R3D || {};
  var THREE = window.THREE, GT = window.GT;
  if (!THREE) return;

  var CW = 20, CH = 24, OX = 4, OY = 8, FX = 10, FY = 20; // canvas size, where the 2D tile origin goes, where the feet are
  var geo = null, pool = null, T = 12;
  var DAYC = new THREE.Color(1, 1, 1), NIGHTC = new THREE.Color(0.42, 0.46, 0.72);

  function makeGeo() {
    var gm = new THREE.PlaneGeometry(CW / T, CH / T);
    gm.translate(-(FX - CW / 2) / T, -(CH / 2 - FY) / T, 0);
    return gm;
  }

  function create() {
    var c = document.createElement('canvas'); c.width = CW; c.height = CH;
    var tex = new THREE.CanvasTexture(c);
    tex.magFilter = tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false; tex.colorSpace = THREE.SRGBColorSpace;
    var mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.04, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    var mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    return { mesh: mesh, canvas: c, g: c.getContext('2d'), tex: tex, mat: mat, sig: null, seen: 0 };
  }

  function drawInto(a, en) {
    var g = a.g; g.clearRect(0, 0, CW, CH); g.imageSmoothingEnabled = false;
    var done = false;
    if (en.char) { GT.drawChar(g, OX, OY, en.char.look, en.char.dir, en.char.step); return; }
    var n = en.n, pal = n ? n.pal : 0, dir = n ? n.dir : (en.dir || 'down'), step = en.step || 0;
    if (typeof GT.charDraw === 'function') {
      try { done = GT.charDraw(g, n, OX, OY, pal, dir, step) === true; } catch (e) { done = false; }
    }
    if (!done) GT.drawChar(g, OX, OY, pal, dir, step);
  }

  R3D.actors = {
    init: function (C) { geo = makeGeo(); pool = new Map(); T = (window.SPRITES && SPRITES.TILE) || 12; this.group = new THREE.Group(); C.scene.add(this.group); },
    onWorld: function () {},
    update: function (C, info) {
      var frame = (this.frame = (this.frame || 0) + 1), fighting = document.documentElement.classList.contains('gt-fighting');
      var night = DAYC.clone().lerp(NIGHTC, Math.min(1, info.dark));
      var ents = info.ents, i;
      for (i = 0; i < ents.length; i++) {
        var en = ents[i], key, px, py;
        if (en.char) { key = 'c:' + (en.char.id != null ? en.char.id : i); px = en.char.x; py = en.char.y; }
        else if (en.n) { key = en.n; px = en.px; py = en.py; }
        else if (en.n === null) { key = 'P'; px = en.px; py = en.py; }
        else continue;
        if (px == null) continue;
        var a = pool.get(key);
        if (!a) { a = create(); pool.set(key, a); this.group.add(a.mesh); }
        a.seen = frame;
        var sig = en.char ? ('c' + en.char.look + en.char.dir + en.char.step) : ((en.n ? en.n.pal : 0) + '|' + (en.n ? en.n.dir : '') + '|' + (en.step || 0));
        var always = key === 'P' || fighting;
        if (always || sig !== a.sig) { a.sig = sig; drawInto(a, en); a.tex.needsUpdate = true; }
        a.mesh.position.set((px + 6) / T, 0, (py + 12) / T);
        a.mesh.quaternion.copy(C.cam.quaternion);
        a.mat.color.copy(night);
      }
      pool.forEach(function (a, key) {
        if (a.seen !== frame) { this.group.remove(a.mesh); a.tex.dispose(); a.mat.dispose(); pool.delete(key); }
      }, this);
    },
    dispose: function (C) {
      if (pool) pool.forEach(function (a) { a.tex.dispose(); a.mat.dispose(); });
      if (this.group) C.scene.remove(this.group);
      if (geo) geo.dispose();
      pool = null; geo = null; this.group = null;
    }
  };
})();
