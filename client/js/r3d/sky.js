/*
 * r3d/sky.js - the sky behind the island: a pixel gradient that follows the game clock (day, dusk, night with stars),
 * layered drifting clouds below the island, and a few small floating islets in the distance.
 */
(function () {
  'use strict';
  var R3D = window.R3D = window.R3D || {};
  var THREE = window.THREE;
  if (!THREE) return;

  var cv = null, g = null, tex = null, lastQ = -1, group = null, clouds = [], islets = [], cloudTex = null, cloudMat = null;
  var cx = 0, cz = 0, span = 100;
  // [top, bottom] sky colours
  var DAY = ['#4f9be0', '#bfe6f8'], DUSK = ['#4b3f86', '#f2a46a'], NIGHT = ['#050818', '#1a2150'];

  function rng(seed) {
    var a = seed >>> 0;
    return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }
  function mix(a, b, t) { var A = new THREE.Color(a), B = new THREE.Color(b); return A.lerp(B, t); }
  function pair(d) {
    // dark 0 = day, 0.5 = dusk, 1 = night
    var t = Math.max(0, Math.min(1, d));
    if (t < 0.5) { var u = t / 0.5; return [mix(DAY[0], DUSK[0], u), mix(DAY[1], DUSK[1], u)]; }
    var v = (t - 0.5) / 0.5; return [mix(DUSK[0], NIGHT[0], v), mix(DUSK[1], NIGHT[1], v)];
  }

  function paintSky(d, h, oc) {
    var p = pair(d), H = cv.height, W = cv.width, y, x;
    if (oc > 0) { // overcast: the sky turns grey (darker at night)
      var g0 = new THREE.Color('#7f8b99').lerp(new THREE.Color('#12162a'), d), g1 = new THREE.Color('#bcc6d0').lerp(new THREE.Color('#222840'), d);
      p[0].lerp(g0, oc * 0.85); p[1].lerp(g1, oc * 0.85);
    }
    for (y = 0; y < H; y += 2) {
      var c = p[0].clone().lerp(p[1], y / H);
      g.fillStyle = '#' + c.getHexString();
      g.fillRect(0, y, W, 2);
    }
    // sun and moon cross the sky with the clock
    var clear = 1 - oc, t, sx, sy;
    if (h >= 5.5 && h <= 18.5 && clear > 0.05) {
      t = Math.min(1, Math.max(0, (h - 6) / 12)); sx = Math.round(W * (0.08 + 0.84 * t)); sy = Math.round(H * (0.62 - 0.5 * Math.sin(Math.PI * t)));
      g.fillStyle = 'rgba(255,236,160,' + (0.22 * clear).toFixed(2) + ')'; g.beginPath(); g.arc(sx, sy, 10, 0, 6.3); g.fill();
      g.fillStyle = 'rgba(255,226,120,' + clear.toFixed(2) + ')'; g.beginPath(); g.arc(sx, sy, 5, 0, 6.3); g.fill();
    }
    if ((h >= 18.5 || h <= 6.5) && clear > 0.05) {
      t = Math.min(1, Math.max(0, (((h - 19) % 24 + 24) % 24) / 10)); sx = Math.round(W * (0.08 + 0.84 * t)); sy = Math.round(H * (0.62 - 0.5 * Math.sin(Math.PI * t)));
      g.fillStyle = 'rgba(200,215,255,' + (0.18 * clear).toFixed(2) + ')'; g.beginPath(); g.arc(sx, sy, 9, 0, 6.3); g.fill();
      g.fillStyle = 'rgba(236,242,255,' + clear.toFixed(2) + ')'; g.beginPath(); g.arc(sx, sy, 4, 0, 6.3); g.fill();
      g.fillStyle = 'rgba(170,185,220,' + clear.toFixed(2) + ')'; g.fillRect(sx - 1, sy - 1, 1, 1); g.fillRect(sx + 1, sy + 1, 1, 1);
    }
    if (d > 0.55) {
      var a = Math.min(1, (d - 0.55) / 0.35) * (1 - oc), r = rng(77);
      for (var i = 0; i < 70; i++) {
        x = Math.floor(r() * W); y = Math.floor(r() * H * 0.75);
        g.fillStyle = 'rgba(255,255,255,' + (a * (0.35 + r() * 0.65)).toFixed(2) + ')';
        g.fillRect(x, y, 1, 1);
      }
    }
    tex.needsUpdate = true;
  }

  function makeCloudTexture() {
    var c = document.createElement('canvas'); c.width = 48; c.height = 24;
    var q = c.getContext('2d'), r = rng(5), i;
    q.fillStyle = '#c9d9ee';
    for (i = 0; i < 9; i++) { var bx = 8 + r() * 30, by = 11 + r() * 5, br = 4 + r() * 5; q.beginPath(); q.arc(bx, by + 2, br, 0, 6.3); q.fill(); }
    q.fillStyle = '#ffffff';
    for (i = 0; i < 9; i++) { var bx2 = 8 + r() * 30, by2 = 9 + r() * 5, br2 = 3.5 + r() * 5; q.beginPath(); q.arc(bx2, by2, br2, 0, 6.3); q.fill(); }
    var d = q.getImageData(0, 0, 48, 24), p = d.data;
    for (i = 0; i < p.length; i += 4) p[i + 3] = p[i + 3] > 100 ? 255 : 0; // crisp pixel edges
    q.putImageData(d, 0, 0);
    var t = new THREE.CanvasTexture(c);
    t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  R3D.sky = {
    init: function (C) {
      cv = document.createElement('canvas'); cv.width = 192; cv.height = 108;
      g = cv.getContext('2d');
      tex = new THREE.CanvasTexture(cv);
      tex.magFilter = tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false; tex.colorSpace = THREE.SRGBColorSpace;
      C.scene.background = tex;
      lastQ = -1;
      group = new THREE.Group(); C.scene.add(group);
      cloudTex = makeCloudTexture();
      cloudMat = new THREE.MeshBasicMaterial({ map: cloudTex, transparent: true, depthWrite: false, opacity: 0.92 });
      clouds = []; islets = [];
    },
    onWorld: function (C, map) {
      var i, r = rng((map.seed | 0) ^ 0xc10d);
      cx = map.w / 2; cz = map.h / 2; span = Math.max(map.w, map.h) * 1.1 + 70;
      clouds.forEach(function (c) { group.remove(c.mesh); c.mesh.geometry.dispose(); });
      islets.forEach(function (s) { group.remove(s.group); s.built.group.traverse(function (o) { if (o.geometry) o.geometry.dispose(); }); });
      clouds = []; islets = [];
      for (i = 0; i < 26; i++) {
        var w = 10 + r() * 16, mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 0.5), cloudMat);
        mesh.rotation.x = -Math.PI / 2;
        var y = -5 - r() * 16; mesh.position.y = y;
        group.add(mesh);
        clouds.push({ mesh: mesh, ox: r() * span * 2, z: cz + (r() - 0.5) * span * 1.6, speed: 0.25 + r() * 0.5 });
      }
      if (R3D.island) for (i = 0; i < 7; i++) {
        var ang = (i / 7) * 6.283 + r() * 0.6, dist = Math.max(map.w, map.h) * 0.5 + 22 + r() * 36;
        var iw = 6 + Math.floor(r() * 9), ih = 5 + Math.floor(r() * 8);
        var built = R3D.island.build(iw, ih, 1000 + i * 31, { depth: 5 + r() * 5, roots: 2, crystals: 2, rocks: 0, step: 1 });
        // grass cap and a couple of little trees
        var cap = new THREE.Mesh(new THREE.BoxGeometry(iw, 0.3, ih), new THREE.MeshLambertMaterial({ color: 0x5f9a46 }));
        cap.position.set(iw / 2, 0.1, ih / 2); built.group.add(cap);
        var trunkMat = new THREE.MeshLambertMaterial({ color: 0x5a3b22 }), leafMat = new THREE.MeshLambertMaterial({ color: 0x2f7a3a, flatShading: true });
        for (var t = 0; t < 2 + Math.floor(r() * 3); t++) {
          var tx = 1 + r() * (iw - 2), tz = 1 + r() * (ih - 2);
          var trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 0.9, 5), trunkMat); trunk.position.set(tx, 0.7, tz);
          var top = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.8, 6), leafMat); top.position.set(tx, 1.8, tz);
          built.group.add(trunk); built.group.add(top);
        }
        var holder = new THREE.Group(); holder.add(built.group);
        built.group.position.set(-iw / 2, 0, -ih / 2);
        holder.position.set(cx + Math.cos(ang) * dist, -4 - r() * 8, cz + Math.sin(ang) * dist);
        group.add(holder);
        islets.push({ group: holder, built: built, base: holder.position.y, ph: r() * 6.28 });
      }
      lastQ = -1;
    },
    update: function (C, info) {
      var oc = (info.weather && info.weather.overcast) || 0, h = (info.gameMin % 1440) / 60;
      var q = Math.round(Math.max(0, Math.min(1, info.dark)) * 40) + ':' + Math.floor(h * 6) + ':' + Math.round(oc * 10);
      if (q !== lastQ) {
        lastQ = q; var dd = Math.round(Math.max(0, Math.min(1, info.dark)) * 40) / 40; paintSky(dd, h, oc);
        var tint = new THREE.Color(1, 1, 1).lerp(new THREE.Color(0.28, 0.32, 0.55), dd).multiplyScalar(1 - 0.38 * oc);
        cloudMat.color.copy(tint); cloudMat.opacity = 0.92 + 0.08 * oc;
      }
      var t = info.timeAcc, i;
      for (i = 0; i < clouds.length; i++) {
        var c = clouds[i], x = ((c.ox + t * c.speed) % (span * 2)) - span + cx;
        c.mesh.position.x = x; c.mesh.position.z = c.z;
      }
      for (i = 0; i < islets.length; i++) { var s = islets[i]; s.group.position.y = s.base + Math.sin(t * 0.5 + s.ph) * 0.4; }
    },
    dispose: function (C) {
      if (group) { C.scene.remove(group); group.traverse(function (o) { if (o.geometry) o.geometry.dispose(); }); }
      if (tex) tex.dispose(); if (cloudTex) cloudTex.dispose(); if (cloudMat) cloudMat.dispose();
      C.scene.background = null;
      cv = g = tex = group = cloudTex = cloudMat = null; clouds = []; islets = [];
    }
  };
})();
