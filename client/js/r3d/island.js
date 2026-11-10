/*
 * r3d/island.js - the floating island under the map: a tapering rock underside with earth and stone bands, hanging roots,
 * glowing crystals and a few drifting rocks. Pure decoration drawn OUTSIDE the walkable map (the top face is the map
 * itself, see ground.js); nothing here touches tile coordinates. R3D.island.build(w, h, seed, opts) is also used for the
 * small far-away islets in sky.js.
 */
(function () {
  'use strict';
  var R3D = window.R3D = window.R3D || {};
  var THREE = window.THREE;
  if (!THREE) return;

  function rng(seed) {
    var a = seed >>> 0;
    return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }

  // depth profile of the underside: ring heights (fraction of depth), how far each ring is pulled toward the centre, colours
  var RING_Y = [0, -0.05, -0.12, -0.25, -0.45, -0.7, -1];
  var RING_IN = [0, 0.004, 0.02, 0.05, 0.12, 0.28, 0.9];
  var RING_COL = ['#6b4a2b', '#7d5937', '#6e4f35', '#5f5870', '#4f4a62', '#3f3b52', '#2e2b3d'];

  function perim(W, H, t) {
    var P = 2 * (W + H), s = t * P;
    if (s < W) return [s, 0];
    s -= W; if (s < H) return [W, s];
    s -= H; if (s < W) return [W - s, H];
    s -= W; return [0, H - s];
  }

  /** Returns {group, rocks:[{mesh, base, ph}], crystals:[mesh]}; the group's origin is the map's top-left corner at y = 0. */
  function build(W, H, seed, o) {
    o = o || {};
    var r = rng(seed || 1), group = new THREE.Group();
    var depth = o.depth || Math.max(6, Math.min(W, H) * 0.34 + 4);
    var N = Math.max(24, Math.min(160, Math.ceil(2 * (W + H) / (o.step || 1.5))));
    var K = RING_Y.length, cx = W / 2, cz = H / 2, i, k;
    var pos = [], col = [], idx = [], c = new THREE.Color();
    for (k = 0; k < K; k++) {
      var amp = k === 0 ? 0 : 0.4 + k * 0.5;
      for (i = 0; i < N; i++) {
        var p = perim(W, H, i / N), a = RING_IN[k];
        var x = p[0] + (cx - p[0]) * a, z = p[1] + (cz - p[1]) * a;
        var dx = x - cx, dz = z - cz, dl = Math.hypot(dx, dz) || 1, j = (r() - 0.5) * amp;
        x += dx / dl * j; z += dz / dl * j;
        var y = RING_Y[k] * depth + (k === 0 ? 0 : (r() - 0.5) * 0.9);
        pos.push(x, y, z);
        c.set(RING_COL[k]); var v = 0.88 + r() * 0.2; col.push(c.r * v, c.g * v, c.b * v);
      }
    }
    pos.push(cx + (r() - 0.5) * 2, -depth * 1.18, cz + (r() - 0.5) * 2); c.set('#241f30'); col.push(c.r, c.g, c.b);
    var tip = K * N;
    for (k = 0; k < K - 1; k++) for (i = 0; i < N; i++) {
      var a0 = k * N + i, a1 = k * N + (i + 1) % N, b0 = (k + 1) * N + i, b1 = (k + 1) * N + (i + 1) % N;
      idx.push(a0, b0, a1, a1, b0, b1);
    }
    for (i = 0; i < N; i++) idx.push((K - 1) * N + i, tip, (K - 1) * N + (i + 1) % N);
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    var body = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide }));
    group.add(body);

    // hanging roots from the upper cliff
    var rootMat = new THREE.MeshLambertMaterial({ color: 0x4a3220 });
    var nRoots = Math.round((o.roots == null ? (W + H) / 5 : o.roots));
    for (i = 0; i < nRoots; i++) {
      var q = perim(W, H, r()), len = 1.2 + r() * 3.2;
      var root = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.1, len, 4), rootMat);
      root.position.set(q[0] + (cx - q[0]) * 0.04, -0.8 - len / 2 - r() * 1.5, q[1] + (cz - q[1]) * 0.04);
      root.rotation.z = (r() - 0.5) * 0.4; root.rotation.x = (r() - 0.5) * 0.4;
      group.add(root);
    }

    // crystals on the belly
    var crystals = [], crystalGeo = new THREE.OctahedronGeometry(0.5, 0);
    var nCr = Math.round(o.crystals == null ? 7 + (W + H) / 22 : o.crystals);
    for (i = 0; i < nCr; i++) {
      var ring = 3 + Math.floor(r() * 3), ii = Math.floor(r() * N), vi = (ring * N + ii) * 3;
      var hue = r() < 0.5 ? 0x6fe3ff : 0xc08cff;
      var cm = new THREE.Mesh(crystalGeo, new THREE.MeshBasicMaterial({ color: hue }));
      var s = 0.5 + r() * 0.9;
      cm.scale.set(s * 0.6, s * 1.5, s * 0.6);
      cm.position.set(pos[vi], pos[vi + 1], pos[vi + 2]);
      cm.rotation.set((r() - 0.5) * 0.8, r() * 3, (r() - 0.5) * 0.8);
      group.add(cm); crystals.push(cm);
    }

    // drifting rocks around the island
    var rocks = [], rockMat = new THREE.MeshLambertMaterial({ color: 0x6a6478, flatShading: true });
    var nRocks = Math.round(o.rocks == null ? 4 + (W + H) / 30 : o.rocks);
    for (i = 0; i < nRocks; i++) {
      var ang = r() * Math.PI * 2, dist = Math.max(W, H) * 0.5 + 3 + r() * 9;
      var rs = 0.5 + r() * 1.6;
      var rm = new THREE.Mesh(new THREE.DodecahedronGeometry(rs, 0), rockMat);
      var by = -2 - r() * depth * 0.8;
      rm.position.set(cx + Math.cos(ang) * dist, by, cz + Math.sin(ang) * dist);
      rm.rotation.set(r() * 3, r() * 3, r() * 3);
      group.add(rm); rocks.push({ mesh: rm, base: by, ph: r() * 6.28 });
    }
    return { group: group, rocks: rocks, crystals: crystals, geo: geo };
  }

  // The map's own island (decoration around the playable rectangle)
  var cur = null;
  R3D.island = {
    build: build,
    init: function (C) { cur = null; },
    onWorld: function (C, map) {
      this.dispose(C);
      cur = build(map.w, map.h, (map.seed | 0) ^ 0x51ed, {});
      C.root.add(cur.group);
    },
    update: function (C, info) {
      if (!cur) return;
      var t = info.timeAcc, i;
      for (i = 0; i < cur.rocks.length; i++) { var r = cur.rocks[i]; r.mesh.position.y = r.base + Math.sin(t * 0.6 + r.ph) * 0.35; r.mesh.rotation.y += 0.002; }
      for (i = 0; i < cur.crystals.length; i++) cur.crystals[i].rotation.y += 0.004;
    },
    dispose: function (C) {
      if (!cur) return;
      C.root.remove(cur.group);
      cur.group.traverse(function (o) { if (o.geometry && o.geometry !== cur.geo) o.geometry.dispose(); });
      cur.geo.dispose();
      cur = null;
    }
  };
})();
