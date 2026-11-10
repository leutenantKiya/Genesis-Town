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

  /* ---- the underside of any island shape (the open island is L-shaped, locked chunks are squares) ----
   A height field under the island: every grid vertex gets a depth from its distance to the island's edge, so the rim drops
   as a steep earth cliff and then tapers to a point, whatever the outline. mask = Uint8Array of tiles (w x h). */
  var BAND = [[0, '#7d5937'], [0.16, '#6e4f35'], [0.34, '#5f5870'], [0.62, '#4a4560'], [1, '#2e2b3d']];
  function bandColor(f, c) {
    for (var i = 1; i < BAND.length; i++) if (f <= BAND[i][0]) { var a = BAND[i - 1], b = BAND[i]; var t = (f - a[0]) / (b[0] - a[0]); c.set(a[1]).lerp(new THREE.Color(b[1]), t); return c; }
    return c.set(BAND[BAND.length - 1][1]);
  }
  function belly(mask, w, h, seed, opts) {
    opts = opts || {};
    var r = rng(seed || 1), W1 = w + 1, H1 = h + 1, group = new THREE.Group(), x, z, i;
    function tileIn(tx, tz) { return tx >= 0 && tz >= 0 && tx < w && tz < h && mask[tz * w + tx] === 1; }
    var vin = new Uint8Array(W1 * H1), inner = new Uint8Array(W1 * H1), dist = new Int16Array(W1 * H1).fill(-1), q = [], area = 0, sx = 0, sz = 0;
    for (z = 0; z < H1; z++) for (x = 0; x < W1; x++) {
      var c = tileIn(x - 1, z - 1) + tileIn(x, z - 1) + tileIn(x - 1, z) + tileIn(x, z), v = z * W1 + x;
      vin[v] = c > 0 ? 1 : 0; inner[v] = c === 4 ? 1 : 0;
      if (c > 0 && c < 4) { dist[v] = 0; q.push(v); }
    }
    for (i = 0; i < w * h; i++) if (mask[i]) { area++; sx += i % w; sz += Math.floor(i / w); }
    if (!area) return null;
    var maxd = 0, head = 0;
    while (head < q.length) {
      var cv = q[head++], cx = cv % W1, cz = Math.floor(cv / W1), nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (var k = 0; k < 4; k++) {
        var nx = cx + nb[k][0], nz = cz + nb[k][1]; if (nx < 0 || nz < 0 || nx >= W1 || nz >= H1) continue;
        var nv = nz * W1 + nx; if (!inner[nv] || dist[nv] >= 0) continue;
        dist[nv] = dist[cv] + 1; if (dist[nv] > maxd) maxd = dist[nv]; q.push(nv);
      }
    }
    var D = opts.depth || Math.max(7, Math.min(28, maxd * 1.25 + 6)), CLIFF = Math.min(3.8, D * 0.38);
    var pos = new Float32Array(W1 * H1 * 3), col = new Float32Array(W1 * H1 * 3), tmp = new THREE.Color(), bnd = [], inn = [];
    for (z = 0; z < H1; z++) for (x = 0; x < W1; x++) {
      var vi = z * W1 + x, d = dist[vi];
      if (!vin[vi]) continue;
      var px = x, pz = z, py = 0;
      if (d > 0) {
        var f = Math.min(1, d / Math.max(1, maxd));
        py = -(CLIFF + (D - CLIFF) * Math.pow(f, 0.8)) + (r() - 0.5) * 0.9; px += (r() - 0.5) * 0.55; pz += (r() - 0.5) * 0.55;
        if (d <= 3) inn.push(vi);
      } else bnd.push(vi);
      pos[vi * 3] = px; pos[vi * 3 + 1] = py; pos[vi * 3 + 2] = pz;
      bandColor(Math.min(1, -py / D), tmp); var sh = 0.88 + r() * 0.2;
      col[vi * 3] = tmp.r * sh; col[vi * 3 + 1] = tmp.g * sh; col[vi * 3 + 2] = tmp.b * sh;
    }
    var idx = [];
    for (z = 0; z < h; z++) for (x = 0; x < w; x++) {
      if (mask[z * w + x] !== 1) continue;
      var a = z * W1 + x, b = a + 1, c2 = a + W1 + 1, d2 = a + W1;
      idx.push(a, d2, b, b, d2, c2);
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    // texture coordinates: world-aligned, stretched along the cliff so the strata run level
    var uvs = new Float32Array(W1 * H1 * 2);
    for (var q2 = 0; q2 < W1 * H1; q2++) { var qx = pos[q2 * 3], qy = pos[q2 * 3 + 1], qz = pos[q2 * 3 + 2]; uvs[q2 * 2] = (qx + qz) * 0.12; uvs[q2 * 2 + 1] = qy * 0.16 + (qx - qz) * 0.02; }
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(idx); geo.computeVertexNormals();
    var A = R3D.assets, bmat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });
    if (A) { bmat.map = A.tex('cliff_detail'); bmat.normalMap = A.tex('cliff_normal', { linear: true }); bmat.normalScale = new THREE.Vector2(0.9, 0.9); }
    var bm = new THREE.Mesh(geo, bmat); bm.userData.nopick = true; group.add(bm);
    var mx = sx / area + 0.5, mz = sz / area + 0.5, i2;
    // hanging roots along the rim
    var rootMat = new THREE.MeshLambertMaterial({ color: 0x4a3220 }), nRoots = Math.min(40, Math.round(bnd.length / (opts.rootEvery || 6)));
    for (i2 = 0; i2 < nRoots; i2++) {
      var bv = bnd[Math.floor(r() * bnd.length)], bx = pos[bv * 3], bz = pos[bv * 3 + 2], len = 1.2 + r() * 3.2;
      var tx = mx - bx, tz = mz - bz, tl = Math.hypot(tx, tz) || 1;
      var root = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.1, len, 4), rootMat);
      root.position.set(bx + tx / tl * 0.25, -0.8 - len / 2 - r() * 1.5, bz + tz / tl * 0.25);
      root.rotation.z = (r() - 0.5) * 0.4; root.rotation.x = (r() - 0.5) * 0.4; group.add(root);
    }
    // crystals on the lower cliff
    var crystals = [], cgeo = new THREE.OctahedronGeometry(0.5, 0), nCr = Math.min(16, Math.round(3 + area / 160));
    for (i2 = 0; i2 < nCr && inn.length; i2++) {
      var cvx = inn[Math.floor(r() * inn.length)], cm = new THREE.Mesh(cgeo, new THREE.MeshBasicMaterial({ color: r() < 0.5 ? 0x6fe3ff : 0xc08cff })), s2 = 0.5 + r() * 0.9;
      cm.scale.set(s2 * 0.6, s2 * 1.5, s2 * 0.6);
      var ox = pos[cvx * 3] - mx, oz = pos[cvx * 3 + 2] - mz, ol = Math.hypot(ox, oz) || 1;
      cm.position.set(pos[cvx * 3] + ox / ol * 0.15, pos[cvx * 3 + 1] - 0.1, pos[cvx * 3 + 2] + oz / ol * 0.15);
      cm.rotation.set((r() - 0.5) * 0.8, r() * 3, (r() - 0.5) * 0.8); group.add(cm); crystals.push(cm);
    }
    return { group: group, crystals: crystals, geo: geo, cx: mx, cz: mz, depth: D, maxd: maxd, area: area };
  }

  var parts = null, items = [], rocks = [];
  R3D.island = {
    build: build,
    belly: belly,
    init: function (C) { parts = null; items = []; rocks = []; },
    onWorld: function (C, map) {
      this.dispose(C);
      parts = R3D.regions.mount();
      var list = R3D.regions.list(), rockMat = new THREE.MeshLambertMaterial({ color: 0x6a6478, flatShading: true });
      list.forEach(function (rg, ri) {
        var b = belly(rg.mask, map.w, map.h, ((map.seed | 0) ^ 0x51ed) + ri * 977, { rootEvery: ri ? 9 : 6 });
        if (!b) return;
        parts[ri].add(b.group); items.push(b);
        // drifting rocks around the island (more around the big open one)
        var rr = rng(ri * 31 + 5), nRocks = ri ? 2 : Math.round(4 + (map.w + map.h) / 30), rad = Math.sqrt(b.area) * 0.6 + 3;
        for (var k = 0; k < nRocks; k++) {
          var ang = rr() * 6.28, dist = rad + 3 + rr() * 9, rs = 0.5 + rr() * 1.4, by = -2 - rr() * b.depth * 0.7;
          var rm = new THREE.Mesh(new THREE.DodecahedronGeometry(rs, 0), rockMat);
          rm.position.set(b.cx + Math.cos(ang) * dist, by, b.cz + Math.sin(ang) * dist); rm.rotation.set(rr() * 3, rr() * 3, rr() * 3);
          parts[ri].add(rm); rocks.push({ mesh: rm, base: by, ph: rr() * 6.28 });
        }
      });
      this.rockMat = rockMat;
    },
    update: function (C, info) {
      var t = info.timeAcc, i;
      for (i = 0; i < rocks.length; i++) { var r = rocks[i]; r.mesh.position.y = r.base + Math.sin(t * 0.6 + r.ph) * 0.35; r.mesh.rotation.y += 0.002; }
      for (i = 0; i < items.length; i++) for (var j = 0; j < items[i].crystals.length; j++) items[i].crystals[j].rotation.y += 0.004;
    },
    dispose: function (C) {
      if (parts) R3D.regions.unmount(parts);
      parts = null; items = []; rocks = [];
      if (this.rockMat) { this.rockMat.dispose(); this.rockMat = null; }
    }
  };
})();
