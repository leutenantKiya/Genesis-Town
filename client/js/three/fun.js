/*
 * fun.js - GT3.Fun(L): the public square's fun side as 3D models (village generator v2, L.fun):
 *   - the fountain in the middle of the market: an octagonal stone basin, a two-tier pillar, water spouting from the
 *     top bowl and falling back as drops, the basin's water rippling
 *   - the stage: a wooden platform with a backdrop in the four merchants' colours, speakers, a canopy on posts and a
 *     string of bulbs; at concert time (every night) a band of three plays on it, coloured spotlights sweep the crowd
 *     and the bulbs light up
 *   - the carousel: a striped canopy over six horses that rise and fall as it turns, day and night, its bulbs lit
 *     after dark
 * Returns { group, update(t, night, concert) } (t seconds, night 0..1, concert true while the band plays).
 */
(function () {
  'use strict';
  var GT3 = window.GT3;
  if (!GT3) return;
  var THREE = GT3.THREE;
  var COLS = ['#e8503c', '#4a8ad8', '#e8a13c', '#58a858'];
  function box(parts, w, h, d, x, y, z, color, ry) { parts.push({ geo: new THREE.BoxGeometry(w, h, d), matrix: GT3.xform(x, y + h / 2, z, 1, 1, 1, ry || 0), color: color }); }
  function shaded(top, side, dark) { return function (n) { return n.y > 0.5 ? top : n.y < -0.5 || n.z < -0.5 ? (dark || side) : side; }; }

  GT3.Fun = function (L) {
    var group = new THREE.Group(), F = L.fun || {}, solid = GT3.mat({ vertexColors: true }), anim = [];
    group.name = 'fun';
    function add(parts, m) { var mesh = new THREE.Mesh(GT3.merge(parts), m || solid); mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh); return mesh; }

    /* --- fountain */
    if (F.fountain) {
      var fx = F.fountain.x + 0.5, fz = F.fountain.y + 0.5, fp = [];
      for (var k = 0; k < 8; k++) { // the basin wall: eight stone blocks round a circle
        var a = k / 8 * Math.PI * 2;
        fp.push({ geo: new THREE.BoxGeometry(1.2, 0.46, 0.3), matrix: GT3.xform(fx + Math.cos(a) * 1.3, 0.23, fz + Math.sin(a) * 1.3, 1, 1, 1, -a + Math.PI / 2), color: shaded('#d4d6e0', '#a8aab8', '#7a7c8c') });
      }
      fp.push({ geo: new THREE.CylinderGeometry(0.28, 0.36, 1.0, 8), matrix: GT3.xform(fx, 0.5, fz), color: shaded('#d4d6e0', '#a8aab8', '#7a7c8c') });
      fp.push({ geo: new THREE.CylinderGeometry(0.62, 0.42, 0.16, 10), matrix: GT3.xform(fx, 1.02, fz), color: shaded('#d4d6e0', '#a8aab8', '#7a7c8c') });
      fp.push({ geo: new THREE.CylinderGeometry(0.12, 0.16, 0.5, 8), matrix: GT3.xform(fx, 1.3, fz), color: '#a8aab8' });
      fp.push({ geo: new THREE.CylinderGeometry(0.32, 0.2, 0.1, 10), matrix: GT3.xform(fx, 1.58, fz), color: shaded('#d4d6e0', '#a8aab8', '#7a7c8c') });
      add(fp);
      var wc = GT3.canvas(24, 24), wg = wc.getContext('2d'), P = GT3.pal().water;
      for (var i = 0; i < 24 * 24; i++) { var r = GT3.hash(i, 3, 9) % 100; GT3.R(wg, i % 24, (i / 24) | 0, 1, 1, r < 12 ? P[3] : r < 40 ? P[2] : P[1]); }
      var wtex = GT3.tex(wc, true); wtex.repeat.set(2, 2);
      var pool = new THREE.Mesh(new THREE.CircleGeometry(1.3, 16), GT3.mat({ map: wtex, emissive: 0x2a6080, emissiveIntensity: 0.25 }));
      pool.rotation.x = -Math.PI / 2; pool.position.set(fx, 0.32, fz); pool.receiveShadow = true; group.add(pool);
      // drops: spout out of the top bowl, arc over and fall into the basin
      var N = 40, drops = new THREE.InstancedMesh(new THREE.BoxGeometry(0.07, 0.07, 0.07), new THREE.MeshLambertMaterial({ color: '#e4f6f2', emissive: '#64c4e2', emissiveIntensity: 0.3 }), N);
      group.add(drops);
      var seeds = []; for (i = 0; i < N; i++) seeds.push([GT3.hash(i, 1, 2) % 1000 / 1000, GT3.hash(i, 2, 3) % 1000 / 1000 * Math.PI * 2]);
      var m4 = new THREE.Matrix4();
      anim.push(function (t) {
        wtex.offset.set((t * 0.05) % 1, (t * 0.03) % 1);
        for (var j = 0; j < N; j++) {
          var s = seeds[j], ph = (t * 0.7 + s[0]) % 1, rr = ph * 0.95, y = 1.62 + ph * 1.4 - ph * ph * 2.6;
          m4.makeTranslation(fx + Math.cos(s[1]) * rr, Math.max(0.34, y), fz + Math.sin(s[1]) * rr); drops.setMatrixAt(j, m4);
        }
        drops.instanceMatrix.needsUpdate = true;
      });
    }

    /* --- stage */
    var bulbsMat = GT3.mat({ color: '#fff4a8', emissive: 0xffd88a, emissiveIntensity: 0 }), spots = [], band = [];
    if (F.stage) {
      var S = F.stage, x0 = S.x0, x1 = S.x1 + 1, z0 = S.y0, z1 = S.y0 + 2, sw = x1 - x0, sx = (x0 + x1) / 2, sp = [];
      box(sp, sw, 0.5, 2, sx, 0, z0 + 1, shaded('#d49c5c', '#8e5a30', '#5a3a1e'));
      box(sp, sw + 0.2, 0.06, 2.1, sx, 0.5, z0 + 1, '#b07840');
      box(sp, sw, 2.2, 0.16, sx, 0.5, z0 + 0.08, '#2a2430'); // the backdrop
      COLS.forEach(function (c, k) { box(sp, sw / 4 - 0.1, 1.6, 0.04, x0 + sw / 8 + k * sw / 4, 0.9, z0 + 0.18, c); });
      [[x0 + 0.25, z1 - 0.25], [x1 - 0.25, z1 - 0.25], [x0 + 0.25, z0 + 0.25], [x1 - 0.25, z0 + 0.25]].forEach(function (q) { box(sp, 0.12, 2.9, 0.12, q[0], 0.5, q[1], '#3a2418'); });
      box(sp, sw + 0.4, 0.14, 2.3, sx, 3.4, z0 + 1, shaded('#e8503c', '#b8422e', '#7a2a1e')); // canopy
      [x0 + 0.5, x1 - 0.5].forEach(function (qx) { box(sp, 0.55, 0.85, 0.45, qx, 0.5, z0 + 0.5, shaded('#3a3a48', '#2a2430', '#141218')); });
      add(sp);
      var bp = [];
      for (var bx = x0 + 0.3; bx < x1; bx += 0.55) bp.push({ geo: new THREE.BoxGeometry(0.1, 0.1, 0.1), matrix: GT3.xform(bx, 3.24 - Math.sin((bx - x0) / sw * Math.PI) * 0.2, z1 - 0.1), color: '#ffffff' });
      var bulbs = new THREE.Mesh(GT3.merge(bp), bulbsMat); group.add(bulbs);
      // spotlights: three coloured cones from the canopy down onto the crowd, only during the concert
      ['#f28fb0', '#34c3c9', '#f2c94c'].forEach(function (c, k) {
        var cone = new THREE.Mesh(new THREE.ConeGeometry(1.1, 3.2, 12, 1, true), new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
        cone.position.set(x0 + sw * (k + 1) / 4, 1.8, z1 + 0.9); cone.visible = false; group.add(cone); spots.push({ m: cone, k: k });
      });
      // the band: three players standing on the platform (2D sprites, as every character)
      if (GT3.Actor) [2, 5, 7].forEach(function (pal, k) {
        var a = GT3.Actor(pal); a.set(x0 + sw * (k + 1) / 4, z0 + 1.3, 'down', 0); a.group.position.y = 0.56; a.group.visible = false; group.add(a.group); band.push(a);
      });
    }

    /* --- carousel */
    var spin = null, horses = [], cbMat = GT3.mat({ color: '#fff4a8', emissive: 0xffd88a, emissiveIntensity: 0 });
    if (F.carousel) {
      var cx = F.carousel.x + 0.5, cz = F.carousel.y + 0.5, base = [];
      base.push({ geo: new THREE.CylinderGeometry(1.45, 1.55, 0.26, 16), matrix: GT3.xform(cx, 0.13, cz), color: function (n, c) { return n.y > 0.5 ? '#f6f0e0' : Math.floor((Math.atan2(c.z - cz, c.x - cx) + Math.PI) / (Math.PI / 8)) % 2 ? '#e8503c' : '#f6f0e0'; } });
      add(base);
      spin = new THREE.Group(); spin.position.set(cx, 0, cz); group.add(spin);
      var top = [];
      top.push({ geo: new THREE.CylinderGeometry(0.12, 0.12, 2.3, 8), matrix: GT3.xform(0, 1.4, 0), color: '#c8a030' });
      top.push({ geo: new THREE.ConeGeometry(1.7, 0.9, 16), matrix: GT3.xform(0, 2.95, 0), color: function (n, c) { return Math.floor((Math.atan2(c.z, c.x) + Math.PI) / (Math.PI / 8)) % 2 ? '#e8503c' : '#f6f0e0'; } });
      top.push({ geo: new THREE.CylinderGeometry(1.62, 1.62, 0.22, 16, 1, true), matrix: GT3.xform(0, 2.42, 0), color: '#e8503c' });
      top.push({ geo: new THREE.SphereGeometry(0.14, 8, 6), matrix: GT3.xform(0, 3.48, 0), color: '#ffd84a' });
      var tm = new THREE.Mesh(GT3.merge(top), solid); tm.castShadow = true; spin.add(tm);
      var hc = ['#f6f0e0', '#c87a4a', '#8a6ad8', '#f6f0e0', '#c87a4a', '#3aa6a0'];
      for (k = 0; k < 6; k++) {
        var ha = k / 6 * Math.PI * 2, hp = [], hx = Math.cos(ha) * 1.05, hz = Math.sin(ha) * 1.05;
        hp.push({ geo: new THREE.CylinderGeometry(0.03, 0.03, 2.1, 6), matrix: GT3.xform(0, 1.35, 0), color: '#c8a030' });
        hp.push({ geo: new THREE.BoxGeometry(0.16, 0.2, 0.5), matrix: GT3.xform(0, 0.8, 0), color: hc[k] });             // body
        hp.push({ geo: new THREE.BoxGeometry(0.12, 0.26, 0.14), matrix: GT3.xform(0, 0.98, 0.26, 1, 1, 1, 0, -0.5), color: hc[k] }); // neck and head
        hp.push({ geo: new THREE.BoxGeometry(0.17, 0.05, 0.2), matrix: GT3.xform(0, 0.93, -0.02), color: '#e8503c' });  // saddle
        [[-0.05, 0.16], [0.05, -0.16]].forEach(function (q) { hp.push({ geo: new THREE.BoxGeometry(0.05, 0.24, 0.05), matrix: GT3.xform(q[0], 0.6, q[1]), color: '#3a2418' }); });
        var h = new THREE.Mesh(GT3.merge(hp), solid); h.position.set(hx, 0, hz); h.rotation.y = -ha; h.castShadow = true; spin.add(h); horses.push({ m: h, ph: k * 1.3 });
      }
      var cbp = [];
      for (k = 0; k < 16; k++) { var ba = k / 16 * Math.PI * 2; cbp.push({ geo: new THREE.BoxGeometry(0.09, 0.09, 0.09), matrix: GT3.xform(Math.cos(ba) * 1.66, 2.3, Math.sin(ba) * 1.66), color: '#ffffff' }); }
      spin.add(new THREE.Mesh(GT3.merge(cbp), cbMat));
      anim.push(function (t) {
        spin.rotation.y = t * 0.55;
        horses.forEach(function (h) { h.m.position.y = Math.sin(t * 2.2 + h.ph) * 0.14; });
      });
    }

    return {
      group: group, stage: F.stage || null,
      update: function (t, night, concert) {
        anim.forEach(function (f) { f(t); });
        cbMat.emissiveIntensity = 1.4 * night;
        bulbsMat.emissiveIntensity = concert ? 1.2 + Math.sin(t * 6) * 0.3 : 0.6 * night;
        spots.forEach(function (s) {
          s.m.visible = !!concert;
          if (!concert) return;
          s.m.material.opacity = 0.14 + Math.sin(t * 2 + s.k) * 0.05;
          s.m.rotation.z = Math.sin(t * 0.9 + s.k * 2) * 0.35; s.m.rotation.x = 0.3 + Math.cos(t * 0.7 + s.k) * 0.15;
        });
        band.forEach(function (a, k) {
          a.group.visible = !!concert;
          if (concert) { var beat = Math.abs(Math.sin(t * 4.2 + k)); a.pose(beat * 0.06, 0, 1 - beat * 0.06); a.set(a.group.position.x, a.group.position.z, 'down', Math.floor(t * 4 + k) % 2 ? 1 : 2); a.group.position.y = 0.56; }
        });
      },
      face: function (camera) { band.forEach(function (a) { a.face(camera); }); }
    };
  };
})();
