/*
 * r3d/props.js - everything that stands on the ground except buildings, as real low-poly 3D: trees (oak, fruit, pine),
 * rocks, bushes, barrels, crates, fences, signs, mailboxes, street lamps, market stall counters and awnings, the portal
 * arch and the empty building lots of a Homeland. Flowers and tall grass are blades of grass scattered by ground.js.
 * Built once per map into a few merged meshes (see geo.js); tiles in areas that are not open yet are darkened.
 */
(function () {
  'use strict';
  var R3D = window.R3D = window.R3D || {};
  var THREE = window.THREE;
  if (!THREE || !R3D.geo) return;
  var Builder = R3D.geo.Builder, hash = R3D.geo.hash;

  var group = null, litMat = null, glowMat = null, portalMat = null, lampList = [], curSnow = null, curMapRef = null, curC = null;
  var DAYC = new THREE.Color(1, 1, 1), NIGHTC = new THREE.Color(0.55, 0.6, 0.85);
  var GREENS = ['#3f8a3a', '#47983f', '#368038', '#4aa046'], DEEP = ['#2a6a48', '#2d7350'];

  var PORTAL_VS = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
  var PORTAL_FS = [
    'varying vec2 vUv; uniform float uTime;',
    'void main(){',
    '  vec2 p = vUv * 2.0 - 1.0; p.y *= 0.75;',
    '  float r = length(p);',
    '  float a = atan(p.y, p.x) + uTime * 1.6 + r * 5.0;',
    '  float v = 0.5 + 0.5 * sin(a * 3.0);',
    '  vec3 col = mix(vec3(0.23, 0.16, 0.47), vec3(0.68, 0.58, 1.0), v * (1.0 - r * 0.6));',
    '  col += vec3(0.4) * step(0.93, v) * (1.0 - r);',
    '  gl_FragColor = vec4(col, smoothstep(1.0, 0.82, r));',
    '}'
  ].join('\n');

  function clear(C) {
    if (group) R3D.regions.unmount(group); // group = one Group per island (regions.js)
    group = null; lampList = [];
  }

  function isT(m, x, y, t) { return x >= 0 && y >= 0 && x < m.w && y < m.h && m.tiles[y * m.w + x] === t; }

  R3D.props = {
    init: function (C) {
      litMat = R3D.geo.lit();
      glowMat = R3D.geo.basic();
      portalMat = new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 } }, vertexShader: PORTAL_VS, fragmentShader: PORTAL_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide });
      group = null; lampList = [];
    },
    onWorld: function (C, m) {
      clear(C);
      curMapRef = m; curC = C; curSnow = !!(window.SPRITES && SPRITES.snow);
      group = R3D.regions.mount();
      var RG = R3D.regions;
      var BS = group.map(function () { var b = new Builder(); b.snow = curSnow ? 0.85 : 0; return b; }), GS = group.map(function () { return new Builder(); });
      var B = BS[0], G = GS[0], x, y, i, t, k, h, cx, cz;
      var locked = m.locked;
      function kk(x, y) { return (locked && locked[y * m.w + x]) ? 0.5 : 1; }

      // trees: positions and kinds come from the 2D bake's canopy list so both views agree
      var trees = m.canopies || [];
      var MD = R3D.models, budget = (R3D.Q && R3D.Q.trees) || 0, birchLeft = 70, mt = [], inst = group.map(function () { return {}; });
      if (MD) MD.setSnow(curSnow);
      // the trees nearest the middle of the map are the ones in play: they are real models, the far forest stays cheap low-poly
      var order = trees.map(function (tt, ii) { return ii; });
      if (MD && budget) order.sort(function (a, b) { var A = trees[a], Bq = trees[b]; return Math.hypot(A.x - m.w / 2, A.y - m.h / 2) - Math.hypot(Bq.x - m.w / 2, Bq.y - m.h / 2); });
      var useModel = {};
      if (MD && budget) order.forEach(function (ii) {
        var t0 = trees[ii];
        if (budget <= 0 || t0.fog || t0.kind === 'pine' || t0.x === 0 || t0.y === 0 || t0.x === m.w - 1 || t0.y === m.h - 1) return;
        var nm = (t0.kind === 'fruit' && birchLeft > 0) ? 'BirchTree_4' : (t0.kind === 'fruit' ? null : 'MapleTree_4');
        if (!nm || !MD.has(nm)) return;
        if (nm === 'BirchTree_4') birchLeft--;
        useModel[ii] = nm; budget--;
      });
      for (i = 0; i < trees.length; i++) {
        var tr = trees[i]; x = tr.x; y = tr.y; k = tr.fog ? 0.5 : 1; B = BS[RG.of(x, y)];
        if (useModel[i]) {
          var nmz = useModel[i], sz = MD.size(nmz), hh0 = hash(x, y, 31), rr = RG.of(x, y), tl = inst[rr][nmz] || (inst[rr][nmz] = []);
          var tgt = (nmz === 'BirchTree_4' ? 2.3 : 2.5) * (0.88 + hh0 * 0.3);
          tl.push({ x: x + 0.5, y: 0, z: y + 0.55, s: tgt / sz.h, ry: hh0 * 6.283 });
          continue;
        }
        h = hash(x, y, 31); cx = x + 0.5; cz = y + 0.58;
        var sc = 0.88 + h * 0.3;
        B.cyl(cx, 0, cz, 0.11 * sc, 0.85 * sc, 5, '#6a4a2a', k);
        if (tr.kind === 'pine') {
          var dg = DEEP[(h * 7 | 0) % 2];
          B.cone(cx, 0.45 * sc, cz, 0.86 * sc, 1.05 * sc, 7, dg, k, '#3a8a5a');
          B.cone(cx, 1.0 * sc, cz, 0.68 * sc, 0.98 * sc, 7, dg, k, '#3a8a5a');
          B.cone(cx, 1.55 * sc, cz, 0.5 * sc, 0.92 * sc, 7, dg, k, '#3a8a5a');
        } else {
          var g1 = GREENS[(h * 11 | 0) % 4];
          B.blob(cx, 1.45 * sc, cz, 0.82 * sc, 0.7 * sc, 0.8 * sc, g1, k, x * 7 + y, '#66b85a');
          B.blob(cx - 0.42 * sc, 1.1 * sc, cz + 0.08, 0.5 * sc, 0.45 * sc, 0.5 * sc, g1, k, x * 3 + y * 5, '#58a850');
          B.blob(cx + 0.44 * sc, 1.15 * sc, cz - 0.05, 0.5 * sc, 0.45 * sc, 0.5 * sc, g1, k, x * 5 + y * 3, '#58a850');
          if (tr.kind === 'fruit') for (var f = 0; f < 5; f++) {
            var fa = f * 1.9 + h * 6, fr = 0.5 + 0.2 * hash(x, y, f);
            B.blob(cx + Math.cos(fa) * fr, 1.3 * sc + Math.sin(fa * 2) * 0.25, cz + Math.sin(fa) * fr * 0.9 + 0.3, 0.1, 0.1, 0.1, f % 2 ? '#e8503c' : '#f29a3a', k, f + 1);
          }
        }
      }

      for (y = 0; y < m.h; y++) for (x = 0; x < m.w; x++) {
        t = m.tiles[y * m.w + x];
        if (t === 'grass' || t === 'path' || t === 'water' || t === 'tree') continue;
        B = BS[RG.of(x, y)]; G = GS[RG.of(x, y)];
        k = kk(x, y); h = hash(x, y, 5); cx = x + 0.5; cz = y + 0.5;
        if (t === 'bridge') { // planks come from the ground texture; rails and posts are real
          var rw = '#6a4020', rl = '#b07840';
          B.box(x, 0.1, y, x + 1, 0.16, y + 0.07, rw, rl, k); B.box(x, 0.46, y, x + 1, 0.52, y + 0.07, rw, rl, k);
          B.box(x, 0.1, y + 0.93, x + 1, 0.16, y + 1, rw, rl, k); B.box(x, 0.46, y + 0.93, x + 1, 0.52, y + 1, rw, rl, k);
          B.box(x, 0, y, x + 0.09, 0.62, y + 0.09, rw, rl, k); B.box(x, 0, y + 0.91, x + 0.09, 0.62, y + 1, rw, rl, k);
        } else if (t === 'rock') {
          B.blob(cx, 0.24, cz, 0.44 + h * 0.08, 0.3, 0.38, '#8c8c99', k, x + y * 9, '#adadbb');
        } else if (t === 'bush' && R3D.models && R3D.models.has('Bush') && (R3D.Q && R3D.Q.trees)) {
          var bn = ['Bush', 'Bush_Large', 'Bush_Small', 'Bush_Flowers', 'Bush_Large_Flowers', 'Bush_Small_Flowers'][(h * 6) | 0], bsz = R3D.models.size(bn), brr = RG.of(x, y);
          if (bsz) (inst[brr][bn] || (inst[brr][bn] = [])).push({ x: cx, y: 0, z: cz, s: (0.78 + 0.3 * hash(x, y, 8)) / bsz.w, ry: h * 6.283 });
          else B.blob(cx, 0.3, cz, 0.42, 0.32, 0.4, '#3f9a4a', k, x * 3 + y, '#62bd5c');
        } else if (t === 'bush') {
          B.blob(cx, 0.3, cz, 0.42, 0.32, 0.4, '#3f9a4a', k, x * 3 + y, '#62bd5c');
          B.blob(cx + 0.14, 0.38, cz + 0.2, 0.06, 0.06, 0.06, '#d84a5a', k, 3);
          B.blob(cx - 0.18, 0.3, cz + 0.22, 0.06, 0.06, 0.06, '#d84a5a', k, 4);
        } else if (t === 'barrel') {
          B.cyl(cx, 0, cz, 0.27, 0.58, 8, '#8e5a30', k, '#b07840');
          B.cyl(cx, 0.14, cz, 0.285, 0.06, 8, '#5a5a6e', k); B.cyl(cx, 0.4, cz, 0.285, 0.06, 8, '#5a5a6e', k);
        } else if (t === 'crate') {
          B.box(cx - 0.3, 0, cz - 0.3, cx + 0.3, 0.55, cz + 0.3, '#c08848', '#dcaa64', k);
          B.box(cx - 0.31, 0, cz - 0.31, cx - 0.25, 0.55, cz + 0.31, '#8e5a2c', null, k);
          B.box(cx + 0.25, 0, cz - 0.31, cx + 0.31, 0.55, cz + 0.31, '#8e5a2c', null, k);
        } else if (t === 'fence') {
          var wood = '#b07840', dark = '#7a4e28';
          B.box(cx - 0.07, 0, cz - 0.07, cx + 0.07, 0.72, cz + 0.07, wood, '#d49c5c', k);
          if (isT(m, x + 1, y, 'fence')) { B.box(cx, 0.2, cz - 0.035, cx + 1, 0.3, cz + 0.035, dark, wood, k); B.box(cx, 0.46, cz - 0.035, cx + 1, 0.56, cz + 0.035, dark, wood, k); }
          if (isT(m, x, y + 1, 'fence')) { B.box(cx - 0.035, 0.2, cz, cx + 0.035, 0.3, cz + 1, dark, wood, k); B.box(cx - 0.035, 0.46, cz, cx + 0.035, 0.56, cz + 1, dark, wood, k); }
        } else if (t === 'sign') {
          B.box(cx - 0.04, 0, cz - 0.04, cx + 0.04, 0.7, cz + 0.04, '#6a4020', null, k);
          B.box(cx - 0.34, 0.5, cz - 0.05, cx + 0.34, 0.88, cz + 0.05, '#2a2430', '#6a4a3a', k);
          B.faceS(cx - 0.3, cx + 0.3, 0.54, 0.84, cz + 0.055, '#f2e2c4', k);
        } else if (t === 'mailbox') {
          B.box(cx - 0.04, 0, cz - 0.04, cx + 0.04, 0.5, cz + 0.04, '#5a3a1e', null, k);
          B.box(cx - 0.2, 0.5, cz - 0.14, cx + 0.2, 0.78, cz + 0.14, '#c8403a', '#e86a5a', k);
          B.box(cx + 0.2, 0.55, cz - 0.02, cx + 0.24, 0.8, cz + 0.02, '#f2c94c', null, k);
        } else if (t === 'lamp') {
          B.cyl(cx, 0, cz, 0.1, 0.12, 6, '#3a3a48', k);
          B.box(cx - 0.035, 0.1, cz - 0.035, cx + 0.035, 1.5, cz + 0.035, '#3a3a48', null, k);
          B.box(cx - 0.2, 1.46, cz - 0.2, cx + 0.2, 1.52, cz + 0.2, '#2a2430', null, k);
          G.box(cx - 0.14, 1.52, cz - 0.14, cx + 0.14, 1.74, cz + 0.14, '#ffe08a', '#fff2c0', k);
          B.box(cx - 0.18, 1.74, cz - 0.18, cx + 0.18, 1.8, cz + 0.18, '#2a2430', null, k);
          lampList.push({ x: cx, y: 1.62, z: cz });
        } else if (t === 'stall') {
          B.box(cx - 0.46, 0, cz - 0.3, cx + 0.46, 0.62, cz + 0.4, '#a0703c', '#d8a868', k);
          B.box(cx - 0.46, 0.0, cz + 0.4, cx + 0.46, 0.08, cz + 0.42, '#6a4020', null, k);
        }
      }

      // stall awnings (striped, sloping up toward the back so the merchant standing behind the counter is covered)
      if (m.market && m.market.stalls) m.market.stalls.forEach(function (st) {
        B = BS[RG.of(st.x, st.y)];
        var k2 = kk(st.x, st.y), fz = st.y + 0.1, bz = st.y - 0.95, fy = 1.25, by = 1.72, n = 6, col = st.color || '#e8503c';
        for (var s = 0; s < n; s++) {
          var xa = st.x + 0.02 + s * 0.96 / n, xb = st.x + 0.02 + (s + 1) * 0.96 / n, c = B.col(s % 2 ? '#f6f0e0' : col, k2);
          B.quad([xa, fy, fz], [xb, fy, fz], [xb, by, bz], [xa, by, bz], c);
          B.quad([xa, fy - 0.12, fz], [xb, fy - 0.12, fz], [xb, fy, fz], [xa, fy, fz], c); // valance
        }
        B.box(st.x + 0.02, 0, fz - 0.03, st.x + 0.07, fy, fz + 0.02, '#6a3f22', null, k2);
        B.box(st.x + 0.93, 0, fz - 0.03, st.x + 0.98, fy, fz + 0.02, '#6a3f22', null, k2);
        B.box(st.x + 0.02, 0, bz - 0.03, st.x + 0.07, by, bz + 0.02, '#6a3f22', null, k2);
        B.box(st.x + 0.93, 0, bz - 0.03, st.x + 0.98, by, bz + 0.02, '#6a3f22', null, k2);
      });

      // empty Homeland building lots: bare earth, four stakes, a small sign at the door
      if (m.layout && m.layout.lots) {
        var taken = {}; m.buildings.forEach(function (b) { if (b.lot) taken[b.lot] = 1; });
        m.layout.lots.forEach(function (l) {
          if (taken[l.id]) return;
          B = BS[RG.of(l.x, l.y)];
          B.flat(l.x + 0.08, l.y + 0.08, l.x + l.w - 0.08, l.y + l.h - 0.08, 0.025, '#8a6038', 1);
          [[0.12, 0.12], [l.w - 0.12, 0.12], [0.12, l.h - 0.12], [l.w - 0.12, l.h - 0.12]].forEach(function (p) { B.box(l.x + p[0] - 0.05, 0, l.y + p[1] - 0.05, l.x + p[0] + 0.05, 0.4, l.y + p[1] + 0.05, '#3d2610', '#b07840', 1); });
          var sx = l.door.x + 0.5, sz = l.door.y + 0.55, tab = l.kind === 'kolam' ? '#3d7fc2' : l.kind === 'tambang' ? '#6a6678' : '#c8502e';
          B.box(sx - 0.03, 0, sz - 0.03, sx + 0.03, 0.55, sz + 0.03, '#3d2610', null, 1);
          B.box(sx - 0.28, 0.45, sz - 0.04, sx + 0.28, 0.85, sz + 0.04, '#2a2430', '#f2e2c4', 1);
          B.faceS(sx - 0.24, sx + 0.24, 0.5, 0.8, sz + 0.045, '#f2e2c4', 1);
          B.faceS(sx - 0.15, sx + 0.15, 0.58, 0.72, sz + 0.05, tab, 1);
        });
      }

      // the portal: a stone arch with a swirling oval
      if (m.portal) {
        B = BS[RG.of(m.portal.x, m.portal.y)];
        var px = m.portal.x, pz = m.portal.y, stone = '#6a6678', stoneL = '#8a869a';
        B.box(px + 0.02, 0, pz + 0.3, px + 0.98, 0.1, pz + 0.72, '#5a5668', stoneL, 1);
        B.box(px + 0.04, 0.1, pz + 0.32, px + 0.24, 1.55, pz + 0.68, stone, stoneL, 1);
        B.box(px + 0.76, 0.1, pz + 0.32, px + 0.96, 1.55, pz + 0.68, stone, stoneL, 1);
        B.box(px + 0.0, 1.55, pz + 0.28, px + 1.0, 1.85, pz + 0.72, stone, stoneL, 1);
        var pm = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 1.4), portalMat);
        pm.position.set(px + 0.5, 0.82, pz + 0.5); pm.renderOrder = 2; pm.userData.pick = true; group[RG.of(m.portal.x, m.portal.y)].add(pm);
      }

      BS.forEach(function (b, r) { if (!b.empty()) group[r].add(b.mesh(litMat, true)); });
      if (MD) inst.forEach(function (byName, r) { Object.keys(byName).forEach(function (nm) { MD.instance(nm, byName[nm], group[r], { cast: true, pick: true }); }); });
      GS.forEach(function (g, r) { if (!g.empty()) group[r].add(g.mesh(glowMat)); });
    },
    update: function (C, info) {
      if (curMapRef && !!(window.SPRITES && SPRITES.snow) !== curSnow) this.onWorld(curC, curMapRef); // winter came or went: rebuild with or without snow
      var d = Math.min(1, info.dark);
      portalMat.uniforms.uTime.value = info.timeAcc;
      glowMat.color.setRGB(0.78 + 0.22 * d, 0.76 + 0.2 * d, 0.62 + 0.08 * d);
    },
    dispose: function (C) {
      clear(C);
      [litMat, glowMat, portalMat].forEach(function (m) { if (m) m.dispose(); });
      litMat = glowMat = portalMat = null;
    }
  };
})();
