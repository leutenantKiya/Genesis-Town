/*
 * life.js - GT3.Life(L): small animals that make a layout feel alive. Purely for looks: nothing here is game state.
 *   - butterflies by day over flowers and tall grass: a pair of flapping wings in spring colours, drifting about
 *   - fireflies at night near water and trees: small warm lights that bob and pulse
 *   - frogs on the mud of a pond bank (and on lily pads): they sit, puff their throats, and now and then hop
 * Places come from the tiles (seeded, so everyone sees the same spots). update(t, night) shows the right ones.
 * Returns { group, update(t, night) }.
 */
(function () {
  'use strict';
  var GT3 = window.GT3;
  if (!GT3) return;
  var THREE = GT3.THREE;
  var WING = ['#f2a8c0', '#ffd84a', '#f6f0e0', '#8fc8f2', '#f0903a'];

  GT3.Life = function (L) {
    var W = L.w, H = L.h, group = new THREE.Group(), seed = (L.seed | 0) || 1, x, y;
    group.name = 'life';
    var flowers = [], wet = [], mud = [], open = {};
    (L.chunks || []).forEach(function (c) { open[c.cx + ',' + c.cy] = c.open !== false; });
    var CH = L.chunk || 32;
    function isOpen(xx, yy) { var k = Math.floor(xx / CH) + ',' + Math.floor(yy / CH); return k in open ? open[k] : true; }
    for (y = 1; y < H - 1; y++) for (x = 1; x < W - 1; x++) {
      if (!isOpen(x, y)) continue;
      var t = L.tiles[y * W + x], h = GT3.hash(x, y, seed + 71) % 100;
      if ((t === 'flower' && h < 30) || (t === 'tallgrass' && h < 6)) flowers.push([x, y]);
      if ((t === 'water' || t === 'lily' || t === 'tree') && h < 5) wet.push([x, y]);
      if (t === 'mud' && h < 45) mud.push([x, y]);
      if (t === 'lily' && h < 25) mud.push([x, y, 1]);
    }
    function pick(list, n, salt) { var out = [], used = {}; for (var i = 0; i < list.length && out.length < n; i++) { var j = GT3.hash(i, salt, seed) % list.length; if (used[j]) continue; used[j] = 1; out.push(list[j]); } return out; }

    /* --- butterflies */
    var bf = pick(flowers, Math.min(40, Math.ceil(flowers.length / 3)), 1).map(function (p, i) {
      var g = new THREE.Group(), col = WING[i % WING.length], m = new THREE.MeshLambertMaterial({ color: col, side: THREE.DoubleSide, emissive: col, emissiveIntensity: 0.15 });
      var wl = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.13), m), wr = wl.clone();
      wl.geometry.translate(-0.08, 0, 0); wr.geometry = wl.geometry.clone(); wr.geometry.translate(0.16, 0, 0);
      var body = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.12), new THREE.MeshLambertMaterial({ color: '#2a2430' }));
      g.add(wl, wr, body); group.add(g);
      return { g: g, wl: wl, wr: wr, x: p[0] + 0.5, z: p[1] + 0.5, ph: (GT3.hash(p[0], p[1], 5) % 628) / 100 };
    });
    /* --- fireflies */
    var ffMat = new THREE.MeshBasicMaterial({ color: '#d8ff7a', transparent: true, opacity: 0.9 });
    var ff = pick(wet, 60, 2).map(function (p) {
      var m = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.06), ffMat.clone()); group.add(m);
      return { m: m, x: p[0] + 0.5, z: p[1] + 0.5, ph: (GT3.hash(p[0], p[1], 9) % 628) / 100 };
    });
    /* --- frogs */
    var frogGeo = (function () {
      var parts = [], b = function (w, hh, d, px, py, pz, c) { parts.push({ geo: new THREE.BoxGeometry(w, hh, d), matrix: GT3.xform(px, py, pz), color: c }); };
      b(0.2, 0.1, 0.22, 0, 0.05, 0, '#4a9a3c'); b(0.16, 0.06, 0.12, 0, 0.11, 0.06, '#5eb84a');
      b(0.05, 0.05, 0.05, -0.06, 0.15, 0.08, '#f6f0e0'); b(0.05, 0.05, 0.05, 0.06, 0.15, 0.08, '#f6f0e0');
      b(0.02, 0.02, 0.02, -0.06, 0.16, 0.105, '#141218'); b(0.02, 0.02, 0.02, 0.06, 0.16, 0.105, '#141218');
      b(0.08, 0.04, 0.1, -0.12, 0.02, -0.06, '#3a7a30'); b(0.08, 0.04, 0.1, 0.12, 0.02, -0.06, '#3a7a30');
      return GT3.merge(parts);
    })();
    var frogMat = GT3.mat({ vertexColors: true });
    var frogs = pick(mud, 12, 3).map(function (p) {
      var m = new THREE.Mesh(frogGeo, frogMat); m.castShadow = true; group.add(m);
      var fy = p[2] ? -GT3.SINK + 0.04 : 0;
      return { m: m, x: p[0] + 0.5, z: p[1] + 0.5, y: fy, ph: (GT3.hash(p[0], p[1], 13) % 1000) / 100, ry: (GT3.hash(p[0], p[1], 17) % 628) / 100 };
    });

    return {
      group: group,
      update: function (t, night) {
        var day = night < 0.5;
        bf.forEach(function (b) {
          b.g.visible = day;
          if (!day) return;
          var a = t * 0.5 + b.ph, flap = Math.sin(t * 18 + b.ph) * 1.1;
          b.g.position.set(b.x + Math.sin(a) * 0.9 + Math.sin(a * 2.3) * 0.3, 0.55 + Math.sin(a * 1.7) * 0.25, b.z + Math.cos(a * 0.8) * 0.9);
          b.g.rotation.y = a + Math.PI / 2;
          b.wl.rotation.z = flap; b.wr.rotation.z = -flap;
        });
        ff.forEach(function (f) {
          f.m.visible = !day;
          if (day) return;
          var a = t * 0.4 + f.ph;
          f.m.position.set(f.x + Math.sin(a) * 1.2, 0.5 + Math.sin(a * 1.9) * 0.35 + Math.sin(t + f.ph) * 0.1, f.z + Math.cos(a * 0.7) * 1.2);
          f.m.material.opacity = 0.35 + 0.65 * Math.max(0, Math.sin(t * 2.4 + f.ph * 3));
        });
        frogs.forEach(function (f) {
          // every few seconds a frog hops a little and turns; in between it sits and breathes
          var cyc = (t + f.ph) % 6, hop = cyc < 0.45 ? Math.sin(cyc / 0.45 * Math.PI) : 0, n = Math.floor((t + f.ph) / 6);
          var off = ((GT3.hash(n, f.x * 10 | 0, 23) % 100) / 100 - 0.5) * 0.5;
          f.m.position.set(f.x + off * (hop ? cyc / 0.45 : 1), f.y + hop * 0.25, f.z + off * 0.6);
          f.m.rotation.y = f.ry + n * 0.9;
          f.m.scale.set(1, 1 + (hop ? 0 : Math.sin(t * 5 + f.ph) * 0.06), 1);
        });
      }
    };
  };
})();
