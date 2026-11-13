/*
 * props.js - GT3.Props(L): the small solid things of a layout, as low-poly models in the 2D sprites' own colours:
 * fences (rails join the fence tiles next to them), signs, mailboxes, street lamps, barrels, crates, the market stall
 * counters with their striped awnings (L.market.stalls), and the Homeland portal (L.portal).
 *
 * Everything static is merged into one mesh; lamp heads, awnings and the portal are separate so they can glow or move.
 * Returns { group, glow(k) (0 day .. 1 night), update(t), lights(px, pz) }.
 *
 * Night light of the street lamps (all fade in with glow(k), nothing by day):
 *   - a fixed pool of warm PointLights (no shadows) handed each frame to the lamps nearest (px, pz): the ground, walls, trees and
 *     the sprite cards near a lamp really brighten. The pool size never changes, so shaders are never recompiled;
 *   - for EVERY lamp one soft pool of light on the ground and a halo round the head, each merged into one mesh (two draw calls).
 */
(function () {
  'use strict';
  var GT3 = window.GT3;
  if (!GT3) return;
  var THREE = GT3.THREE, R = GT3.R;
  var C = {
    fence: '#d0a060', fenceD: '#8a6038', sign: '#d0a060', signFace: '#f2e2c4', ink: '#5a3c28',
    mail: '#d84848', mailD: '#9c2c30', post: '#8a6038', flag: '#00ec97',
    lamp: '#6a6c7c', lampD: '#4a4c5c', bulb: '#fff4a8',
    barrel: '#8e5a30', barrelL: '#b07840', ring: '#5a5a6e', crate: '#c08848', crateD: '#8e5a2c', crateL: '#dcaa64',
    stall: '#c08848', stallD: '#8e5a2c', stallL: '#e2b06a'
  };
  function shaded(top, side, dark) { return function (n) { return n.y > 0.5 ? top : n.y < -0.5 || n.z < -0.5 ? (dark || side) : side; }; }
  function box(parts, w, h, d, x, y, z, color, ry) { parts.push({ geo: new THREE.BoxGeometry(w, h, d), matrix: GT3.xform(x, y + h / 2, z, 1, 1, 1, ry || 0), color: color }); }
  function cyl(parts, r, h, x, y, z, color, seg) { parts.push({ geo: new THREE.CylinderGeometry(r, r, h, seg || 8), matrix: GT3.xform(x, y + h / 2, z), color: color }); }

  GT3.Props = function (L) {
    var W = L.w, H = L.h, group = new THREE.Group(), parts = [], heads = [], x, y, lamps = [];
    function at(xx, yy) { return xx < 0 || yy < 0 || xx >= W || yy >= H ? null : L.tiles[yy * W + xx]; }
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      var t = at(x, y), cx = x + 0.5, cz = y + 0.5;
      if (t === 'bridge' && (at(x - 1, y) === 'void' || at(x + 1, y) === 'void' || at(x, y - 1) === 'void' || at(x, y + 1) === 'void' || at(x - 1, y) === 'water' || at(x + 1, y) === 'water')) {
        // a plank bridge between islands (or over the river): a beam underneath, posts and a rope rail on its open sides
        box(parts, 1.0, 0.16, 1.0, cx, -0.17, cz, shaded(C.fenceD, '#6a4020', '#4a2c18'));
        var ns = at(x, y - 1) === 'bridge' || at(x, y + 1) === 'bridge'; // runs north-south
        [-1, 1].forEach(function (sd) {
          var ox = ns ? sd * 0.46 : 0, oz = ns ? 0 : sd * 0.46, side = ns ? at(x + sd, y) : at(x, y + sd);
          if (side === 'bridge') return;
          box(parts, 0.09, 0.5, 0.09, cx + ox + (ns ? 0 : -0.4), 0, cz + oz + (ns ? -0.4 : 0), C.fenceD);
          box(parts, ns ? 0.05 : 1.0, 0.05, ns ? 1.0 : 0.05, cx + ox, 0.4, cz + oz, '#c8a878');
        });
      } else if (t === 'bench') {
        // a park bench facing south: seat, backrest, four legs (sit on it: walk onto it and stand still)
        box(parts, 0.86, 0.07, 0.38, cx, 0.34, cz + 0.04, shaded('#d49c5c', '#b07840', '#7a4a28'));
        box(parts, 0.86, 0.26, 0.06, cx, 0.46, cz - 0.16, shaded('#d49c5c', '#b07840', '#7a4a28'));
        [[-0.38, 0.16], [0.38, 0.16], [-0.38, -0.14], [0.38, -0.14]].forEach(function (q) { box(parts, 0.06, 0.34, 0.06, cx + q[0], 0, cz + q[1], '#3a2418'); });
      } else if (t === 'table' && at(x, y + 1) === 'bench') {
        // a terrace table with a striped parasol
        box(parts, 0.08, 0.6, 0.08, cx, 0, cz, '#3a2418');
        parts.push({ geo: new THREE.CylinderGeometry(0.4, 0.4, 0.06, 10), matrix: GT3.xform(cx, 0.62, cz), color: shaded('#e2b06a', '#b07840', '#7a4a28') });
        box(parts, 0.04, 1.0, 0.04, cx, 0.65, cz, '#e8e4dc');
        parts.push({ geo: new THREE.ConeGeometry(0.72, 0.32, 8), matrix: GT3.xform(cx, 1.78, cz), color: function (n, c) { return Math.floor((Math.atan2(c.z - cz, c.x - cx) + Math.PI) / (Math.PI / 4)) % 2 ? '#f6f0e0' : '#e8503c'; } });
      } else if (t === 'lily') {
        // a lily pad floating on the pond, now and then with a pink flower
        parts.push({ geo: new THREE.CylinderGeometry(0.3, 0.3, 0.03, 9, 1, false, 0.4, Math.PI * 1.8), matrix: GT3.xform(cx, -GT3.SINK + 0.03, cz), color: '#48a046' });
        if ((x + y) % 2) box(parts, 0.12, 0.1, 0.12, cx + 0.06, -GT3.SINK + 0.05, cz - 0.04, '#f2a8c0');
      } else if (t === 'fence') {
        box(parts, 0.12, 0.62, 0.12, cx, 0, cz, shaded(C.fence, C.fence, C.fenceD));
        var e = at(x + 1, y) === 'fence', s = at(x, y + 1) === 'fence';
        [0.22, 0.44].forEach(function (ry) {
          if (e) box(parts, 1.0, 0.07, 0.05, cx + 0.5, ry, cz, shaded(C.fence, C.fenceD));
          if (s) box(parts, 0.05, 0.07, 1.0, cx, ry, cz + 0.5, shaded(C.fence, C.fenceD));
          if (!e && !s && at(x - 1, y) !== 'fence' && at(x, y - 1) !== 'fence') box(parts, 0.5, 0.07, 0.05, cx, ry, cz, shaded(C.fence, C.fenceD));
        });
      } else if (t === 'sign') {
        box(parts, 0.08, 0.7, 0.08, cx, 0, cz, C.post);
        box(parts, 0.7, 0.36, 0.08, cx, 0.46, cz, shaded(C.sign, C.signFace, C.fenceD));
        box(parts, 0.44, 0.04, 0.01, cx, 0.62, cz + 0.045, C.ink);
        box(parts, 0.32, 0.04, 0.01, cx, 0.54, cz + 0.045, C.ink);
      } else if (t === 'mailbox') {
        box(parts, 0.07, 0.5, 0.07, cx, 0, cz, C.post);
        box(parts, 0.36, 0.26, 0.26, cx, 0.5, cz, shaded(C.mail, C.mail, C.mailD));
        box(parts, 0.03, 0.22, 0.03, cx + 0.2, 0.62, cz, C.flag);
        box(parts, 0.1, 0.07, 0.03, cx + 0.24, 0.8, cz, C.flag);
      } else if (t === 'lamp') {
        cyl(parts, 0.11, 0.1, cx, 0, cz, C.lampD, 6);
        box(parts, 0.07, 1.42, 0.07, cx, 0.1, cz, shaded(C.lamp, C.lamp, C.lampD));
        box(parts, 0.36, 0.05, 0.36, cx, 1.52, cz, C.lampD);
        box(parts, 0.3, 0.06, 0.3, cx, 1.79, cz, C.lampD);
        heads.push([cx, cz]); lamps.push([cx, cz]);
      } else if (t === 'barrel') {
        cyl(parts, 0.27, 0.58, cx, 0, cz, function (n) { return n.y > 0.5 ? C.barrelL : C.barrel; }, 9);
        cyl(parts, 0.285, 0.05, cx, 0.12, cz, C.ring, 9); cyl(parts, 0.285, 0.05, cx, 0.42, cz, C.ring, 9);
      } else if (t === 'crate') {
        box(parts, 0.62, 0.56, 0.62, cx, 0, cz, shaded(C.crateL, C.crate, C.crateD));
        box(parts, 0.64, 0.06, 0.64, cx, 0.5, cz, C.crateD);
        box(parts, 0.08, 0.5, 0.64, cx - 0.27, 0.03, cz, C.crateD); box(parts, 0.08, 0.5, 0.64, cx + 0.27, 0.03, cz, C.crateD);
      } else if (t === 'stall') {
        box(parts, 0.98, 0.62, 0.72, cx, 0, cz + 0.06, shaded(C.stallL, C.stall, C.stallD));
        box(parts, 1.0, 0.06, 0.76, cx, 0.62, cz + 0.06, C.stallD);
        box(parts, 0.06, 1.5, 0.06, cx - 0.46, 0, cz - 0.28, C.stallD); box(parts, 0.06, 1.5, 0.06, cx + 0.46, 0, cz - 0.28, C.stallD);
        box(parts, 0.06, 1.24, 0.06, cx - 0.46, 0, cz + 0.4, C.stallD); box(parts, 0.06, 1.24, 0.06, cx + 0.46, 0, cz + 0.4, C.stallD);
        // goods on the counter: small coloured blocks, the same four colours as the 2D counter
        ['#ffd84a', '#86c85a', '#6cc8e4', '#e8503c'].forEach(function (c, i) { box(parts, 0.14, 0.1, 0.14, cx - 0.33 + i * 0.22, 0.68, cz + 0.12, c); });
      }
    }
    /* --- the public square's landmarks (the same tiles GTVillage.landmarks gives the server and mods/trade.js): the Papan Juara
       board and the Meja Untung table, so the 2.5D view has something under their name signs */
    var lm = null;
    try {
      var VL = L.layout || L;
      if (window.GTVillage && GTVillage.landmarks && VL.buildings && VL.market && VL.market.stalls && VL.market.stalls.length > 2) lm = GTVillage.landmarks(VL);
    } catch (e) { lm = null; }
    if (lm) {
      var bx = lm.board.x + 0.5, bz = lm.board.y + 0.5; // Papan Juara: a dark board with a cream face and a gold star on two posts
      box(parts, 0.08, 1.45, 0.08, bx - 0.42, 0, bz, '#6a4020'); box(parts, 0.08, 1.45, 0.08, bx + 0.42, 0, bz, '#6a4020');
      box(parts, 1.0, 0.8, 0.1, bx, 0.7, bz, '#3a2a40');
      box(parts, 0.86, 0.64, 0.04, bx, 0.78, bz + 0.065, '#f6ead0');
      box(parts, 0.2, 0.07, 0.02, bx, 1.07, bz + 0.095, '#e8b030'); box(parts, 0.07, 0.22, 0.02, bx, 1.0, bz + 0.095, '#e8b030');
      box(parts, 0.62, 0.04, 0.02, bx, 0.9, bz + 0.095, '#5a3c28'); box(parts, 0.5, 0.04, 0.02, bx, 0.82, bz + 0.095, '#5a3c28');
      if (lm.gamble) { // Meja Untung: a green felt table with two dice
        var gx = lm.gamble.x + 0.5, gz = lm.gamble.y + 0.5;
        [[-0.4, -0.28], [0.4, -0.28], [-0.4, 0.28], [0.4, 0.28]].forEach(function (q) { box(parts, 0.07, 0.5, 0.07, gx + q[0], 0, gz + q[1], '#5a3a1e'); });
        box(parts, 1.02, 0.1, 0.8, gx, 0.5, gz, shaded('#2a2430', '#2a2430', '#1a1620'));
        box(parts, 0.9, 0.03, 0.68, gx, 0.6, gz, '#2f8a4a');
        box(parts, 0.15, 0.15, 0.15, gx - 0.2, 0.63, gz - 0.04, '#f8f4ec', 0.3); box(parts, 0.15, 0.15, 0.15, gx + 0.16, 0.63, gz + 0.08, '#f8f4ec', -0.5);
        box(parts, 0.04, 0.01, 0.04, gx - 0.2, 0.785, gz - 0.04, '#c83c3c'); box(parts, 0.04, 0.01, 0.04, gx + 0.16, 0.785, gz + 0.08, '#c83c3c');
      }
    }

    var mat = GT3.mat({ vertexColors: true });
    if (parts.length) {
      var mesh = new THREE.Mesh(GT3.merge(parts), mat);
      mesh.castShadow = true; mesh.receiveShadow = true; mesh.name = 'props';
      group.add(mesh);
    }

    /* --- lamp heads: their own material so they light up at night */
    var headMat = GT3.mat({ color: C.bulb, emissive: 0xffd88a, emissiveIntensity: 0 });
    if (heads.length) {
      var hp = []; heads.forEach(function (h) { box(hp, 0.24, 0.22, 0.24, h[0], 1.57, h[1], '#ffffff'); });
      var hm = new THREE.Mesh(GT3.merge(hp), headMat); hm.castShadow = true; hm.name = 'lamp-heads';
      group.add(hm);
    }

    /* --- the light of the lamps at night */
    var night = 0, POOL = 5, TARGETS = 4, RAD = 2.7;
    var glowC = GT3.canvas(64, 64), gg = glowC.getContext('2d'), gr = gg.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,214,130,0.85)'); gr.addColorStop(0.35, 'rgba(255,190,100,0.38)'); gr.addColorStop(0.7, 'rgba(255,170,80,0.1)'); gr.addColorStop(1, 'rgba(255,160,70,0)');
    gg.fillStyle = gr; gg.fillRect(0, 0, 64, 64);
    var glowTex = new THREE.CanvasTexture(glowC); glowTex.userData.shared = true;
    var poolMat = null, haloMat = null, slots = [];
    if (lamps.length) {
      // pools on the ground: one quad per lamp, additive, no depth write, a hair above the ground
      var pg = [], pu = [], pi = [];
      lamps.forEach(function (l, i) {
        var y0 = 0.045, a = l[0] - RAD, b = l[0] + RAD, c = l[1] - RAD, d = l[1] + RAD;
        pg.push(a, y0, c, b, y0, c, b, y0, d, a, y0, d); pu.push(0, 0, 1, 0, 1, 1, 0, 1);
        pi.push(i * 4, i * 4 + 2, i * 4 + 1, i * 4, i * 4 + 3, i * 4 + 2);
      });
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pg, 3)); geo.setAttribute('uv', new THREE.Float32BufferAttribute(pu, 2)); geo.setIndex(pi);
      poolMat = new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
      var pool = new THREE.Mesh(geo, poolMat); pool.name = 'lamp-pools'; pool.renderOrder = 2; pool.frustumCulled = false; pool.visible = false;
      group.add(pool); poolMat.userData.mesh = pool;
      // a halo round each head: a round sprite that always faces the camera (Points), hidden behind walls
      var hg = new THREE.BufferGeometry(); hg.setAttribute('position', new THREE.Float32BufferAttribute(lamps.reduce(function (a, l) { a.push(l[0], 1.57, l[1]); return a; }, []), 3));
      haloMat = new THREE.PointsMaterial({ map: glowTex, size: 1.5, sizeAttenuation: true, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
      var halo = new THREE.Points(hg, haloMat); halo.name = 'lamp-halos'; halo.renderOrder = 3; halo.frustumCulled = false; halo.visible = false;
      group.add(halo); haloMat.userData.mesh = halo;
      // the PointLight pool: always the same number of lights, so no material is ever recompiled
      for (var si = 0; si < POOL; si++) {
        var pl = new THREE.PointLight(0xffd28a, 0, 5.2, 2); pl.castShadow = false; pl.position.set(0, 1.6, 0); pl.name = 'lamp-light';
        group.add(pl); slots.push({ light: pl, lamp: -1 });
      }
    }
    var lastAt = 0, scratch = [];
    function lights(px, pz) {
      if (!lamps.length) return;
      var now = performance.now(), dt = Math.min(0.1, (now - (lastAt || now)) / 1000); lastAt = now;
      if (poolMat) { poolMat.opacity = Math.min(1, night * 0.6); haloMat.opacity = Math.min(1, night * 0.8); poolMat.userData.mesh.visible = haloMat.userData.mesh.visible = night > 0.01; }
      // the TARGETS lamps nearest the focus (within the light's reach plus a little), the rest of the pool fades out
      scratch.length = 0;
      for (var i = 0; i < lamps.length; i++) {
        var dx = lamps[i][0] - px, dz = lamps[i][1] - pz, d2 = dx * dx + dz * dz;
        if (d2 < 15 * 15) scratch.push(i, d2);
      }
      var want = [];
      for (var n = 0; n < TARGETS; n++) {
        var bi = -1, bd = 1e9;
        for (var j = 0; j < scratch.length; j += 2) if (scratch[j + 1] < bd && want.indexOf(scratch[j]) < 0) { bd = scratch[j + 1]; bi = scratch[j]; }
        if (bi < 0) break; want.push(bi);
      }
      slots.forEach(function (s) { if (s.lamp >= 0 && want.indexOf(s.lamp) >= 0) s.keep = true; else s.keep = false; });
      want.forEach(function (li) {
        if (slots.some(function (s) { return s.lamp === li; })) return;
        // hand the lamp to a slot that has faded out (or is unused); if none is free yet, it gets one a few frames later
        var free = null;
        slots.forEach(function (s) { if (!s.keep && s.light.intensity < 0.05 && (!free || s.lamp < 0)) free = s; });
        if (free) { free.lamp = li; free.keep = true; free.light.position.set(lamps[li][0], 1.6, lamps[li][1]); }
      });
      var k = Math.min(1, dt * 5);
      slots.forEach(function (s) {
        var goal = s.keep ? 10 * night : 0;
        s.light.intensity += (goal - s.light.intensity) * k;
        if (s.light.intensity < 0.02 && !s.keep) { s.light.intensity = 0; s.lamp = -1; }
      });
    }

    /* --- awnings over the market stalls, in each stall's colour */
    ((L.market && L.market.stalls) || []).concat((L.market && L.market.lapak) || []).forEach(function (st) {
      var c = GT3.canvas(12, 8), g = c.getContext('2d');
      for (var i = 0; i < 12; i++) R(g, i, 0, 1, 8, Math.floor(i / 3) % 2 ? '#f6f0e0' : st.color);
      R(g, 0, 7, 12, 1, 'rgba(0,0,0,0.25)');
      var a = new THREE.Mesh(GT3.quad([st.x - 0.04, 1.2, st.y + 0.9], [st.x + 1.04, 1.2, st.y + 0.9], [st.x + 1.04, 1.52, st.y + 0.18], [st.x - 0.04, 1.52, st.y + 0.18]), GT3.mat({ map: GT3.tex(c), side: THREE.DoubleSide }));
      a.castShadow = true; a.receiveShadow = true; a.name = 'awning';
      group.add(a);
    });

    /* --- the Homeland portal: a ring of standing stones round a slowly turning disc */
    var disc = null;
    if (L.portal) {
      // the village portal (everyone on the server comes through it) is L.bigPortal: about 1.8 times a Homeland's, with more stones
      var pp = [], px = L.portal.x + 0.5, pz = L.portal.y + 0.5, big = L.bigPortal ? 1.8 : 1, ns = L.bigPortal ? 14 : 8;
      for (var k = 0; k < ns; k++) { var an = k / ns * Math.PI * 2; box(pp, 0.16 * big, (0.34 + (k % 2) * 0.14) * (L.bigPortal ? 1.5 : 1), 0.16 * big, px + Math.cos(an) * 0.62 * big, 0, pz + Math.sin(an) * 0.62 * big, shaded('#c4bcb4', '#a8a098', '#807870'), an); }
      if (L.bigPortal) for (var k2 = 0; k2 < 14; k2++) { var an2 = (k2 + 0.5) / 14 * Math.PI * 2; box(pp, 0.3, 0.07, 0.3, px + Math.cos(an2) * 0.62 * big, 0, pz + Math.sin(an2) * 0.62 * big, shaded('#a8a098', '#8a827a', '#6a645c'), an2); } // flat base stones between the standing ones
      var pm = new THREE.Mesh(GT3.merge(pp), mat); pm.castShadow = true; pm.receiveShadow = true; group.add(pm);
      var dc = GT3.canvas(24, 24), dg = dc.getContext('2d');
      for (var yy = 0; yy < 24; yy++) for (var xx = 0; xx < 24; xx++) {
        var dx = xx - 11.5, dy = yy - 11.5, d = Math.sqrt(dx * dx + dy * dy); if (d > 11.5) continue;
        var sw = (Math.atan2(dy, dx) + d * 0.35) % (Math.PI / 2);
        R(dg, xx, yy, 1, 1, d > 10.5 ? '#2a2a6a' : sw < 0.5 ? '#c4b4ff' : sw < 1.1 ? '#8a7ae8' : '#5a4ab8');
      }
      var dt = GT3.tex(dc);
      disc = new THREE.Mesh(new THREE.CircleGeometry(0.5 * big, 28), new THREE.MeshBasicMaterial({ map: dt, transparent: true, alphaTest: 0.5 }));
      disc.rotation.x = -Math.PI / 2; disc.position.set(px, 0.03, pz); disc.name = 'portal';
      group.add(disc);
    }

    return {
      group: group,
      glow: function (k) { night = k; headMat.emissiveIntensity = 1.6 * k; },
      lights: lights,
      lampCount: lamps.length,
      update: function (t) { if (disc) disc.rotation.z = t * 0.6; }
    };
  };
})();
