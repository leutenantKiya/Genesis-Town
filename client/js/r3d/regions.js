/*
 * r3d/regions.js - splits the map into floating islands. Everything the player can walk on is the OPEN island (region 0).
 * Every chunk that is not open yet (map.locked) is its own small island that hovers a little lower, drifts out from the
 * centre and sits in a bank of cloud. The other modules ask for one Group per region (mount) and add their meshes to it, so a
 * region moves as one piece. When the town opens a chunk (a project, or a Homeland chunk job) the new map arrives with that
 * chunk open: its island is kept apart for a moment and slides back into place ("berlabuh"), then the world is rebuilt as one.
 * Tile -> region: R3D.regions.of(x, y). Region 0 is always the open island.
 */
(function () {
  'use strict';
  var R3D = window.R3D = window.R3D || {};
  var THREE = window.THREE;
  if (!THREE) return;

  var GAP = 3.2, SINK = 2.4, DOCK_SECS = 2.6;
  var list = [], idOf = null, mw = 0, mh = 0, mounts = [], prev = null, puffTex = null, puffMat = null, puffGeo = null, curMap = null;
  var DAYC = new THREE.Color(1, 1, 1), NIGHTC = new THREE.Color(0.5, 0.55, 0.8);

  function puffTexture() {
    var c = document.createElement('canvas'); c.width = c.height = 64;
    var g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 2, 32, 32, 30);
    gr.addColorStop(0, 'rgba(255,255,255,0.95)'); gr.addColorStop(0.55, 'rgba(240,246,255,0.6)'); gr.addColorStop(1, 'rgba(235,242,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    var t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  }

  function clear(C) {
    mounts.forEach(function (arr) { arr.forEach(function (g) { if (g.parent) g.parent.remove(g); g.traverse(function (o) { if (o.geometry) o.geometry.dispose(); }); }); });
    mounts = [];
    list.forEach(function (r) { if (r.group.parent) r.group.parent.remove(r.group); });
    list = []; idOf = null;
  }

  R3D.rebuild = function () { /* set by core */ };

  R3D.regions = {
    list: function () { return list; },
    of: function (x, y) {
      if (!idOf || x < 0 || y < 0 || x >= mw || y >= mh) return 0;
      return idOf[y * mw + x];
    },
    // one Group per region, attached to that region's group; remove with unmount()
    mount: function () {
      var arr = list.map(function (r) { var g = new THREE.Group(); r.group.add(g); return g; });
      mounts.push(arr); return arr;
    },
    unmount: function (arr) {
      if (!arr) return;
      arr.forEach(function (g) { if (g.parent) g.parent.remove(g); g.traverse(function (o) { if (o.geometry) o.geometry.dispose(); }); });
      var i = mounts.indexOf(arr); if (i >= 0) mounts.splice(i, 1);
    },
    init: function (C) { puffTex = puffTexture(); puffMat = new THREE.MeshBasicMaterial({ map: puffTex, transparent: true, depthWrite: false, opacity: 0.85 }); puffGeo = new THREE.PlaneGeometry(1, 1); list = []; mounts = []; prev = null; },
    onWorld: function (C, map) {
      clear(C);
      curMap = map; mw = map.w; mh = map.h;
      idOf = new Uint8Array(mw * mh);
      var N = 3, CH = mw / N, locked = map.locked, key = map.seed + ':' + mw + 'x' + mh, i;
      // which of the 3 x 3 chunks are open (map.locked has soft fog edges, so the chunk flag is the truth)
      var openArr = [], chunks = map.chunks;
      for (var ci0 = 0; ci0 < N * N; ci0++) {
        if (chunks && chunks[ci0]) openArr.push(chunks[ci0].open !== false);
        else { var lc = 0, cx0 = (ci0 % N) * CH, cy0 = Math.floor(ci0 / N) * CH; for (var qy = 0; qy < CH; qy++) for (var qx = 0; qx < CH; qx++) if (locked && locked[(cy0 + qy) * mw + cx0 + qx]) lc++; openArr.push(lc < CH * CH / 2); }
      }
      // chunks that were locked before and are open now (same world): they dock
      var docking = {}, any = false;
      if (prev && prev.key === key && prev.open) for (i = 0; i < N * N; i++) if (prev.open[i] === false && openArr[i]) { docking[i] = 1; any = true; }
      var open = { idx: 0, kind: 'open', group: new THREE.Group(), base: new THREE.Vector3(), mask: null, chunk: -1 };
      C.root.add(open.group); list.push(open);
      var byChunk = {};
      for (var y = 0; y < mh; y++) for (var x = 0; x < mw; x++) {
        var ci = Math.floor(y / CH) * N + Math.floor(x / CH), isLocked = !openArr[ci];
        if (!isLocked && !docking[ci]) continue;
        var r = byChunk[ci];
        if (!r) {
          var cx = (Math.floor(x / CH) + 0.5) * CH, cz = (Math.floor(y / CH) + 0.5) * CH;
          var dx = cx - mw / 2, dz = cz - mh / 2, dl = Math.hypot(dx, dz) || 1;
          r = byChunk[ci] = { idx: list.length, kind: isLocked ? 'locked' : 'dock', group: new THREE.Group(), chunk: ci, phase: ci * 1.9,
            base: new THREE.Vector3(dx / dl * GAP, -SINK, dz / dl * GAP), cx: cx, cz: cz, t0: null, done: false, puffs: [] };
          r.group.position.copy(r.base);
          C.root.add(r.group); list.push(r);
        }
        idOf[y * mw + x] = r.idx;
      }
      // masks (tiles of each region) for the island undersides
      list.forEach(function (r) { r.mask = new Uint8Array(mw * mh); });
      for (var j = 0; j < idOf.length; j++) list[idOf[j]].mask[j] = 1;
      // cloud puffs around every locked island
      list.forEach(function (r) {
        if (r.kind !== 'locked') return;
        var x0 = r.cx - CH / 2, z0 = r.cz - CH / 2, n = 9;
        for (var p = 0; p < n; p++) {
          var a = p / n * 6.283 + r.phase, rad = CH * (0.5 + 0.18 * Math.sin(p * 2.3));
          var m = new THREE.Mesh(puffGeo, puffMat), s = 5 + 4 * Math.abs(Math.sin(p * 1.7 + r.phase));
          m.scale.set(s, s * 0.62, 1); m.quaternion.copy(C.cam.quaternion);
          m.position.set(r.cx + Math.cos(a) * rad - r.base.x * 0, 0.4 + (p % 3) * 0.5, r.cz + Math.sin(a) * rad);
          m.renderOrder = 7; r.group.add(m); r.puffs.push({ mesh: m, a: a, rad: rad, s: s, ph: p });
        }
        r.puffBase = { x0: x0, z0: z0 };
      });
      prev = { key: key, open: openArr };
      // a docking chunk starts where it was floating, then slides home
      list.forEach(function (r) { if (r.kind === 'dock') r.group.position.copy(r.base); });
      this.hasDocking = any;
    },
    update: function (C, info) {
      var t = info.timeAcc, tint = DAYC.clone().lerp(NIGHTC, Math.min(1, info.dark));
      puffMat.color.copy(tint);
      var dockPending = false;
      for (var i = 1; i < list.length; i++) {
        var r = list[i], bob = Math.sin(t * 0.6 + r.phase) * 0.22;
        if (r.kind === 'locked') {
          r.group.position.set(r.base.x, r.base.y + bob, r.base.z);
          r.puffs.forEach(function (p) { p.mesh.quaternion.copy(C.cam.quaternion); var a = p.a + t * 0.04; p.mesh.position.set(r.cx + Math.cos(a) * p.rad, 0.4 + (p.ph % 3) * 0.5 + Math.sin(t * 0.5 + p.ph) * 0.2, r.cz + Math.sin(a) * p.rad); });
        } else if (r.kind === 'dock') {
          if (r.t0 == null) r.t0 = t;
          var p = Math.min(1, (t - r.t0) / DOCK_SECS), e = 1 - Math.pow(1 - p, 3);
          r.group.position.set(r.base.x * (1 - e), r.base.y * (1 - e) + (1 - e) * bob, r.base.z * (1 - e));
          if (p >= 1) dockPending = true; else if (info.dock !== false) dockPending = dockPending || false;
        }
      }
      if (dockPending && !this.docked) { this.docked = true; R3D.rebuild(); }
      if (!this.hasDocking) this.docked = false;
    },
    dispose: function (C) {
      clear(C);
      if (puffMat) puffMat.dispose(); if (puffTex) puffTex.dispose(); if (puffGeo) puffGeo.dispose();
      puffMat = puffTex = puffGeo = null; prev = null;
    }
  };
})();
