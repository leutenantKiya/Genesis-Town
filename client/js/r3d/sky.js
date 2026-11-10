/*
 * r3d/sky.js - the sky behind the island: a smooth gradient that follows the game clock (day, dusk, night with stars),
 * layered drifting clouds below the island, and a few small floating islets in the distance.
 */
(function () {
  'use strict';
  var R3D = window.R3D = window.R3D || {};
  var THREE = window.THREE;
  if (!THREE) return;

  var cv = null, g = null, tex = null, lastQ = -1, group = null, clouds = [], islets = [], cloudTex = null, cloudMat = null, lowMat = null;
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
    R3D.sky.horizon = null; // set below, once overcast is applied
    if (oc > 0) { // overcast: the sky turns grey (darker at night)
      var g0 = new THREE.Color('#7f8b99').lerp(new THREE.Color('#12162a'), d), g1 = new THREE.Color('#bcc6d0').lerp(new THREE.Color('#222840'), d);
      p[0].lerp(g0, oc * 0.85); p[1].lerp(g1, oc * 0.85);
    }
    R3D.sky.horizon = p[1].clone();
    var grd = g.createLinearGradient(0, 0, 0, H);
    for (y = 0; y <= 8; y++) grd.addColorStop(y / 8, '#' + p[0].clone().lerp(p[1], Math.pow(y / 8, 0.9)).getHexString());
    g.fillStyle = grd; g.fillRect(0, 0, W, H);
    function glow(x0, y0, r, col, a) { var rg = g.createRadialGradient(x0, y0, 0, x0, y0, r); rg.addColorStop(0, 'rgba(' + col + ',' + a.toFixed(3) + ')'); rg.addColorStop(1, 'rgba(' + col + ',0)'); g.fillStyle = rg; g.beginPath(); g.arc(x0, y0, r, 0, 6.3); g.fill(); }
    // sun and moon cross the sky with the clock
    var clear = 1 - oc, t, sx, sy, U = W / 192;
    if (h >= 5.5 && h <= 18.5 && clear > 0.05) {
      t = Math.min(1, Math.max(0, (h - 6) / 12)); sx = W * (0.08 + 0.84 * t); sy = H * (0.62 - 0.5 * Math.sin(Math.PI * t));
      glow(sx, sy, 34 * U, '255,236,170', 0.45 * clear); glow(sx, sy, 15 * U, '255,240,190', 0.8 * clear);
      g.fillStyle = 'rgba(255,248,214,' + clear.toFixed(2) + ')'; g.beginPath(); g.arc(sx, sy, 5.2 * U, 0, 6.3); g.fill();
    }
    if ((h >= 18.5 || h <= 6.5) && clear > 0.05) {
      t = Math.min(1, Math.max(0, (((h - 19) % 24 + 24) % 24) / 10)); sx = W * (0.08 + 0.84 * t); sy = H * (0.62 - 0.5 * Math.sin(Math.PI * t));
      glow(sx, sy, 30 * U, '200,215,255', 0.4 * clear);
      g.fillStyle = 'rgba(238,243,255,' + clear.toFixed(2) + ')'; g.beginPath(); g.arc(sx, sy, 4.4 * U, 0, 6.3); g.fill();
      g.fillStyle = 'rgba(176,190,222,' + (0.7 * clear).toFixed(2) + ')'; g.beginPath(); g.arc(sx - 1.4 * U, sy - 0.8 * U, 1.1 * U, 0, 6.3); g.arc(sx + 1.2 * U, sy + 1.2 * U, 0.8 * U, 0, 6.3); g.fill();
    }
    if (d > 0.55) {
      var a = Math.min(1, (d - 0.55) / 0.35) * (1 - oc), r = rng(77);
      for (var i = 0; i < 150; i++) {
        x = r() * W; y = r() * H * 0.75;
        glow(x, y, (0.7 + r() * 1.1) * U, '255,255,255', a * (0.3 + r() * 0.7));
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
      cv = document.createElement('canvas'); cv.width = 768; cv.height = 432;
      g = cv.getContext('2d');
      tex = new THREE.CanvasTexture(cv);
      tex.magFilter = tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false; tex.colorSpace = THREE.SRGBColorSpace;
      C.scene.background = tex;
      lastQ = -1;
      group = new THREE.Group(); C.scene.add(group);
      cloudTex = makeCloudTexture();
      lowMat = new THREE.MeshLambertMaterial({ vertexColors: true });
      cloudMat = new THREE.MeshBasicMaterial({ map: cloudTex, transparent: true, depthWrite: false, opacity: 0.92 });
      clouds = []; islets = [];
    },
    setInterior: function (C, on) { if (group) group.visible = !on; C.scene.background = on ? new THREE.Color('#0b0c14') : tex; },
    onWorld: function (C, map) {
      var i, r = rng((map.seed | 0) ^ 0xc10d);
      cx = map.w / 2; cz = map.h / 2; span = Math.max(map.w, map.h) * 1.1 + 70;
      clouds.forEach(function (c) { group.remove(c.mesh); c.mesh.geometry.dispose(); });
      islets.forEach(function (s) { group.remove(s.group); s.built.group.traverse(function (o) { if (o.geometry) o.geometry.dispose(); }); });
      clouds = []; islets = [];
      // big soft low-poly clouds drifting around and below the island
      for (i = 0; i < 18 && R3D.geo; i++) {
        var CB = R3D.rig && R3D.rig.acc ? R3D.rig.acc() : new R3D.geo.Builder(), sz = 2 + r() * 3.2, nb = 4 + Math.floor(r() * 3), k2;
        for (k2 = 0; k2 < nb; k2++) { // soft puffs
          var bs = sz * (0.5 + r() * 0.55), px = (k2 - nb / 2) * sz * 0.7 + (r() - 0.5) * sz * 0.3, py = (r() - 0.3) * sz * 0.3, pz = (r() - 0.5) * sz * 0.7;
          if (CB.sph) CB.sph(px, py, pz, bs * 1.2, bs * 0.7, bs * 0.9, k2 % 2 ? '#f4f8fc' : '#e6edf6'); else CB.blob(px, py, pz, bs * 1.25, bs * 0.7, bs * 0.9, '#e4ebf3', 1, i * 11 + k2, '#ffffff');
        }
        var mesh = CB.mesh(lowMat);
        mesh.position.y = -12 + r() * 11;
        group.add(mesh);
        clouds.push({ mesh: mesh, ox: r() * span * 2, z: cz + (r() < 0.5 ? -1 : 1) * (map.h / 2 + 14 + r() * 32), speed: 0.12 + r() * 0.3 });
      }
      if (R3D.island) for (i = 0; i < 7; i++) {
        var ang = (i / 7) * 6.283 + r() * 0.6, dist = Math.max(map.w, map.h) * 0.5 + 22 + r() * 36;
        var iw = 6 + Math.floor(r() * 9), ih = 5 + Math.floor(r() * 8);
        var built = R3D.island.build(iw, ih, 1000 + i * 31, { depth: 5 + r() * 5, roots: 2, crystals: 2, rocks: 0, step: 1 });
        // grass cap and a couple of little trees
        var cap = new THREE.Mesh(new THREE.BoxGeometry(iw, 0.3, ih), new THREE.MeshLambertMaterial({ color: 0x5f9a46 }));
        cap.position.set(iw / 2, 0.1, ih / 2); built.group.add(cap);
        var MD = R3D.models, tl = [];
        for (var t = 0; t < 2 + Math.floor(r() * 3); t++) tl.push({ x: 1 + r() * (iw - 2), y: 0.25, z: 1 + r() * (ih - 2), s: (1.4 + r() * 0.8) / ((MD && MD.size('MapleTree_4') || { h: 3.5 }).h), ry: r() * 6.28, c: [0.74, 0.84, 0.66] });
        if (MD && MD.has('MapleTree_4')) MD.instance('MapleTree_4', tl, built.group, { cast: false });
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
        cloudMat.color.copy(tint); cloudMat.opacity = 0.92 + 0.08 * oc; lowMat.color.copy(tint);
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
      if (tex) tex.dispose(); if (cloudTex) cloudTex.dispose(); if (cloudMat) cloudMat.dispose(); if (lowMat) lowMat.dispose();
      C.scene.background = null;
      cv = g = tex = group = cloudTex = cloudMat = null; clouds = []; islets = [];
    }
  };
})();
