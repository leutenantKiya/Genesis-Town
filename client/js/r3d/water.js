/*
 * r3d/water.js - real water for the 3D view. Water tiles (map.tiles === 'water': river, ponds, lakes, the Homeland sea) are
 * holes in the ground (ground.js) with a recessed, animated water surface below, earthen banks around it, shore foam, and
 * waterfalls where water meets the edge of the island, falling into the clouds with mist at the bottom.
 * Colours are written straight to the screen (display values), then darkened by the night factor like the other modules.
 */
(function () {
  'use strict';
  var R3D = window.R3D = window.R3D || {};
  var THREE = window.THREE;
  if (!THREE) return;

  var WL = -0.15;      // water level (the ground is at 0)
  var FALL = 15;       // how far a waterfall drops
var FLARE = 3;       // how far the water arcs outward while falling (so it shows from the fixed camera on every side)
  var parts = null, group = null, surfMat = null, fallMat = null, bankMat = null, mist = [], mistMat = null, mistTex = null;
  var DAYC = new THREE.Color(1, 1, 1), NIGHTC = new THREE.Color(0.42, 0.46, 0.72);

  function isWater(m, x, y) { return x >= 0 && y >= 0 && x < m.w && y < m.h && m.tiles[y * m.w + x] === 'water'; }
  R3D.isWater = isWater;

  var COMMON = [
    'varying vec3 vPos;',
    'uniform float uTime;',
    'uniform float uDark;',
    'float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }'
  ].join('\n');

  var SURF_VS = COMMON + [
    'attribute float aEdge;',
    'attribute float aLock;',
    'varying float vEdge;',
    'varying float vLock;',
    'void main(){',
    '  vPos = position; vEdge = aEdge; vLock = aLock;',
    '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
    '}'
  ].join('\n');

  var SURF_FS = COMMON + [
    'varying float vEdge;',
    'varying float vLock;',
    'void main(){',
    '  vec2 p = vPos.xz;',
    '  vec2 q = floor(p * 12.0) / 12.0;', // the 2D art\'s pixel grid
    '  float wave = sin(q.x * 2.1 + uTime * 0.9) + sin(q.y * 2.7 - uTime * 0.7) + sin((q.x + q.y) * 1.3 + uTime * 0.5);',
    '  vec3 deep = vec3(0.17, 0.46, 0.73), shallow = vec3(0.27, 0.64, 0.87), hi = vec3(0.66, 0.88, 0.96), foam = vec3(0.94, 0.98, 0.99);',
    '  vec3 col = mix(deep, shallow, 0.5 + 0.2 * wave);',
    '  float band = step(0.8, fract(wave * 0.5 + q.x * 0.3 + q.y * 0.2));',
    '  col = mix(col, shallow * 1.12, band * 0.4);',
    '  float sp = step(0.986, hash(q + floor(uTime * 1.4)));',
    '  col = mix(col, hi, sp * 0.85);',
    '  vec2 f = fract(p);',
    '  float bits = floor(vEdge + 0.5);',
    '  float d = 1.0;',
    '  if (mod(bits, 2.0) >= 1.0) d = min(d, f.y);',
    '  if (mod(floor(bits / 2.0), 2.0) >= 1.0) d = min(d, 1.0 - f.x);',
    '  if (mod(floor(bits / 4.0), 2.0) >= 1.0) d = min(d, 1.0 - f.y);',
    '  if (mod(floor(bits / 8.0), 2.0) >= 1.0) d = min(d, f.x);',
    '  float fo = step(d, 0.1 + 0.05 * sin(uTime * 1.7 + (q.x + q.y) * 6.0));',
    '  col = mix(col, foam, fo * 0.9);',
    '  col *= mix(vec3(1.0), vec3(0.42, 0.46, 0.72), uDark);',
    '  col *= mix(vec3(1.0), vec3(0.58, 0.52, 0.78), vLock);',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  var FALL_VS = COMMON + [
    'void main(){',
    '  vPos = position;',
    '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
    '}'
  ].join('\n');

  var FALL_FS = COMMON + [
    'uniform float uFall;',
    'uniform float uLevel;',
    'void main(){',
    '  float along = vPos.x + vPos.z;',
    '  float down = uLevel - vPos.y;',            // 0 at the lip, uFall at the bottom
    '  float cell = floor(along * 12.0);',
    '  float streak = hash(vec2(cell, 3.0));',
    '  float y = floor(vPos.y * 12.0) / 12.0;',
    '  float flow = fract(y * 0.35 + uTime * (1.1 + streak * 0.9) + streak * 7.0);',
    '  float bright = step(0.5, flow);',
    '  vec3 base = mix(vec3(0.25, 0.6, 0.86), vec3(0.62, 0.85, 0.95), streak);',
    '  vec3 col = mix(base, vec3(0.95, 0.99, 1.0), bright * 0.7);',
    '  float a = (1.0 - smoothstep(uFall * 0.25, uFall, down)) * (0.9 - 0.25 * streak);',
    '  col *= mix(vec3(1.0), vec3(0.42, 0.46, 0.72), uDark);',
    '  gl_FragColor = vec4(col, a);',
    '}'
  ].join('\n');

  function makeMistTex() {
    var c = document.createElement('canvas'); c.width = c.height = 32;
    var g = c.getContext('2d'), gr = g.createRadialGradient(16, 16, 1, 16, 16, 15);
    gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(0.5, 'rgba(235,245,255,0.45)'); gr.addColorStop(1, 'rgba(235,245,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 32, 32);
    var t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  }

  function clear(C) {
    if (parts) R3D.regions.unmount(parts);
    parts = null; mist = [];
  }

  R3D.water = {
    init: function (C) {
      var u = function () { return { uTime: { value: 0 }, uDark: { value: 0 } }; };
      var su = u();
      surfMat = new THREE.ShaderMaterial({ uniforms: su, vertexShader: SURF_VS, fragmentShader: SURF_FS });
      var fu = u(); fu.uFall = { value: FALL }; fu.uLevel = { value: WL };
      fallMat = new THREE.ShaderMaterial({ uniforms: fu, vertexShader: FALL_VS, fragmentShader: FALL_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide });
      bankMat = new THREE.MeshBasicMaterial({ vertexColors: true });
      mistTex = makeMistTex();
      mistMat = new THREE.MeshBasicMaterial({ map: mistTex, transparent: true, depthWrite: false, opacity: 0.7 });
      group = null; mist = [];
    },
    onWorld: function (C, m) {
      clear(C);
      var RG = R3D.regions; parts = RG.mount();
      var B = parts.map(function () { return { sp: [], se: [], sl: [], si: [], bp: [], bc: [], bi: [], fp: [], fi: [], n: 0, bn: 0, fn: 0, mist: [] }; });
      var x, y;
      var earthA = new THREE.Color('#7d5937'), earthB = new THREE.Color('#5b4029');
      function quad(arr, idx, base, a, b, c, d) { arr.push.apply(arr, a.concat(b, c, d)); idx.push(base, base + 1, base + 2, base, base + 2, base + 3); }
      for (y = 0; y < m.h; y++) for (x = 0; x < m.w; x++) {
        if (!isWater(m, x, y)) continue;
        var rg = RG.of(x, y), R = B[rg];
        var nL = y > 0 && !isWater(m, x, y - 1), eL = x < m.w - 1 && !isWater(m, x + 1, y), sL = y < m.h - 1 && !isWater(m, x, y + 1), wL = x > 0 && !isWater(m, x - 1, y);
        var bits = (nL ? 1 : 0) + (eL ? 2 : 0) + (sL ? 4 : 0) + (wL ? 8 : 0), lock = (m.locked && m.locked[y * m.w + x]) ? 1 : 0;
        quad(R.sp, R.si, R.n, [x, WL, y], [x, WL, y + 1], [x + 1, WL, y + 1], [x + 1, WL, y]);
        for (var k = 0; k < 4; k++) { R.se.push(bits); R.sl.push(lock); }
        R.n += 4;
        // banks: a wall on each side that touches land of the same island, facing the water
        var sides = [[nL && RG.of(x, y - 1) === rg, [x, y], [x + 1, y]], [eL && RG.of(x + 1, y) === rg, [x + 1, y], [x + 1, y + 1]],
          [sL && RG.of(x, y + 1) === rg, [x + 1, y + 1], [x, y + 1]], [wL && RG.of(x - 1, y) === rg, [x, y + 1], [x, y]]];
        sides.forEach(function (s) {
          if (!s[0]) return;
          var a = s[1], b = s[2];
          R.bp.push(a[0], 0, a[1], b[0], 0, b[1], b[0], WL, b[1], a[0], WL, a[1]);
          R.bc.push(earthA.r, earthA.g, earthA.b, earthA.r, earthA.g, earthA.b, earthB.r, earthB.g, earthB.b, earthB.r, earthB.g, earthB.b);
          R.bi.push(R.bn, R.bn + 1, R.bn + 2, R.bn, R.bn + 2, R.bn + 3); R.bn += 4;
        });
        // waterfalls where the water meets the edge of the map
        var edges = [[y === 0, [x + 1, 0, y - 0.07], [x, 0, y - 0.07], 0, -1], [x === m.w - 1, [x + 1.07, 0, y + 1], [x + 1.07, 0, y], 1, 0],
          [y === m.h - 1, [x, 0, y + 1.07], [x + 1, 0, y + 1.07], 0, 1], [x === 0, [x - 0.07, 0, y], [x - 0.07, 0, y + 1], -1, 0]];
        edges.forEach(function (e) {
          if (!e[0]) return;
          var a = e[1], b = e[2], ox = e[3] * FLARE, oz = e[4] * FLARE;
          R.fp.push(a[0], WL, a[2], b[0], WL, b[2], b[0] + ox, WL - FALL, b[2] + oz, a[0] + ox, WL - FALL, a[2] + oz);
          R.fi.push(R.fn, R.fn + 1, R.fn + 2, R.fn, R.fn + 2, R.fn + 3); R.fn += 4;
          if (R.mist.length < 40) R.mist.push({ x: (a[0] + b[0]) / 2 + ox, z: (a[2] + b[2]) / 2 + oz });
        });
      }
      function mesh(r, pos, idx, mat, extra) {
        if (!pos.length) return null;
        var g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
        if (extra) Object.keys(extra).forEach(function (k) { g.setAttribute(k, new THREE.Float32BufferAttribute(extra[k][0], extra[k][1])); });
        var mm = new THREE.Mesh(g, mat); mm.frustumCulled = false; parts[r].add(mm); return mm;
      }
      var pg = new THREE.PlaneGeometry(2.4, 2.4), mi = 0;
      B.forEach(function (R, r) {
        mesh(r, R.sp, R.si, surfMat, { aEdge: [R.se, 1], aLock: [R.sl, 1] });
        mesh(r, R.bp, R.bi, bankMat, { color: [R.bc, 3] });
        var fm = mesh(r, R.fp, R.fi, fallMat); if (fm) fm.renderOrder = 2;
        // mist at the foot of every waterfall (a couple of soft puffs each, capped)
        R.mist.forEach(function (s) {
          var puff = new THREE.Mesh(pg, mistMat); puff.quaternion.copy(C.cam.quaternion);
          puff.position.set(s.x, WL - FALL, s.z); puff.renderOrder = 3; parts[r].add(puff);
          mist.push({ mesh: puff, x: s.x, z: s.z, ph: (mi++) * 1.7 });
        });
      });
    },
    update: function (C, info) {
      if (!surfMat) return;
      var t = info.timeAcc, d = Math.min(1, info.dark);
      surfMat.uniforms.uTime.value = t; surfMat.uniforms.uDark.value = d;
      fallMat.uniforms.uTime.value = t; fallMat.uniforms.uDark.value = d;
      mistMat.color.copy(DAYC).lerp(NIGHTC, d);
      bankMat.color.copy(DAYC).lerp(NIGHTC, d);
      for (var i = 0; i < mist.length; i++) {
        var m = mist[i], s = 1 + 0.25 * Math.sin(t * 1.3 + m.ph);
        m.mesh.quaternion.copy(C.cam.quaternion);
        m.mesh.scale.set(s, s * 0.8, 1);
        m.mesh.position.y = WL - FALL + 0.5 + Math.sin(t * 0.9 + m.ph) * 0.4;
      }
    },
    dispose: function (C) {
      clear(C);
      [surfMat, fallMat, bankMat, mistMat].forEach(function (m) { if (m) m.dispose(); });
      if (mistTex) mistTex.dispose();
      surfMat = fallMat = bankMat = mistMat = mistTex = null;
    }
  };
})();
