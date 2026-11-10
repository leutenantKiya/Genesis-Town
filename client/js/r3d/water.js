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
    'uniform vec3 uFogC; uniform float uFogN; uniform float uFogF; uniform float uFogOn;',
    '#define W_DEEP vec3(0.13, 0.42, 0.70)', // one water palette: the pool and the waterfall both use it
    '#define W_SHALLOW vec3(0.30, 0.68, 0.90)',
    'float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
    'float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }'
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
    '  vec2 p = vPos.xz; float t = uTime;',
    // a gentle moving swell: the slope of a few sine waves gives a normal, so light glints off the water smoothly
    '  vec2 g = vec2(cos(p.x * 2.1 + t * 0.9) * 2.1 * 0.5 + cos((p.x + p.y) * 1.3 + t * 0.5) * 1.3 * 0.5,',
    '                cos(p.y * 2.7 - t * 0.7) * 2.7 * 0.5 + cos((p.x + p.y) * 1.3 + t * 0.5) * 1.3 * 0.5);',
    '  float r = p.x * 5.3 + p.y * 1.7 - t * 1.6; g += vec2(5.3, 1.7) * cos(r) * 0.1; r = p.y * 6.1 - p.x * 2.2 + t * 1.3; g += vec2(-2.2, 6.1) * cos(r) * 0.08;',
    '  vec3 n = normalize(vec3(-g.x * 0.11, 1.0, -g.y * 0.11));',
    '  vec3 L = normalize(vec3(0.35, 0.8, 0.4)), V = normalize(cameraPosition - vPos);',
    '  float diff = dot(n, L) * 0.5 + 0.5;',
    '  float spec = pow(max(dot(reflect(-L, n), V), 0.0), 36.0);',
    '  float fres = pow(1.0 - max(dot(n, V), 0.0), 3.0);',
    '  vec3 deep = W_DEEP, shallow = W_SHALLOW;',
    '  vec3 col = mix(deep, shallow, clamp(diff * 0.9 + vn(p * 1.3 + t * 0.15) * 0.25 - 0.1, 0.0, 1.0));',
    '  float cs = sin(p.x * 3.0 + t * 0.8 + sin(p.y * 2.3 + t * 0.5) * 1.5) * sin(p.y * 3.2 - t * 0.6 + sin(p.x * 2.7) * 1.2);',
    '  col += vec3(0.5, 0.8, 0.9) * 0.1 * smoothstep(0.45, 1.0, cs);',
    '  col = mix(col, vec3(0.78, 0.92, 1.0), fres * 0.4);',
    '  col += vec3(1.0, 0.97, 0.9) * spec * 0.75;',
    '  vec2 f = fract(p);',
    '  float bits = floor(vEdge + 0.5);',
    '  float d = 1.0;',
    '  if (mod(bits, 2.0) >= 1.0) d = min(d, f.y);',
    '  if (mod(floor(bits / 2.0), 2.0) >= 1.0) d = min(d, 1.0 - f.x);',
    '  if (mod(floor(bits / 4.0), 2.0) >= 1.0) d = min(d, 1.0 - f.y);',
    '  if (mod(floor(bits / 8.0), 2.0) >= 1.0) d = min(d, f.x);',
    '  float fw = 0.13 + 0.05 * sin(t * 1.7 + (p.x + p.y) * 6.0) + 0.05 * (vn(p * 8.0 + t * 0.25) - 0.5);',
    '  float fo = 1.0 - smoothstep(fw * 0.35, fw, d);',
    '  col = mix(col, vec3(0.96, 0.99, 1.0), fo * 0.88);',
    '  col *= mix(vec3(1.0), vec3(0.42, 0.46, 0.72), uDark);',
    '  col *= mix(vec3(1.0), vec3(0.58, 0.52, 0.78), vLock);',
    '  float fd = length(cameraPosition - vPos); col = mix(col, uFogC, clamp((fd - uFogN) / max(1.0, uFogF - uFogN), 0.0, 1.0) * uFogOn);',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  var FALL_VS = COMMON + [
    'attribute float aS;',
    'varying float vS;',
    'void main(){',
    '  vPos = position; vS = aS;',
    '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
    '}'
  ].join('\n');

  var FALL_FS = COMMON + [
    'uniform float uFall;',
    'uniform float uLevel;',
    'varying float vS;',
    'void main(){',
    '  float along = vPos.x + vPos.z;',
    '  float cell = floor(along * 7.0), cf = fract(along * 7.0);',
    '  float sp = 0.8 + hash(vec2(cell, 3.0)) * 0.9;',
    // long soft streaks that slide down: noise stretched along the fall, a different speed per column
    '  float s1 = vn(vec2(along * 9.0, vS * 15.0 - uTime * 2.6 * sp));',
    '  float s2 = vn(vec2(along * 21.0 + 7.0, vS * 26.0 - uTime * 3.4));',
    '  float st = s1 * 0.65 + s2 * 0.35;',
    // the sheet starts as exactly the pool's colour and only gets paler (more air in it) as it falls
    '  vec3 base = mix(mix(W_DEEP, W_SHALLOW, 0.7), mix(W_SHALLOW, vec3(0.86, 0.95, 1.0), 0.55), smoothstep(0.0, 1.0, vS));',
    '  vec3 col = mix(base, vec3(0.9, 0.97, 1.0), smoothstep(0.5, 0.9, st) * (0.25 + 0.4 * vS));',
    '  vec3 n = normalize(cross(dFdx(vPos), dFdy(vPos))); vec3 V = normalize(cameraPosition - vPos);',
    '  float rim = pow(1.0 - abs(dot(n, V)), 2.0);',
    '  col = mix(col, vec3(0.9, 0.97, 1.0), rim * 0.28);',
    '  float a = (0.97 - 0.2 * (1.0 - st) * vS) * (1.0 - smoothstep(0.55, 1.0, vS));',
    '  a *= 0.88 + 0.12 * smoothstep(0.0, 0.35, cf) * smoothstep(1.0, 0.65, cf);',
    '  col *= mix(vec3(1.0), vec3(0.42, 0.46, 0.72), uDark);',
    '  float fd = length(cameraPosition - vPos); col = mix(col, uFogC, clamp((fd - uFogN) / max(1.0, uFogF - uFogN), 0.0, 1.0) * uFogOn);',
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
      var u = function () { return { uTime: { value: 0 }, uDark: { value: 0 }, uFogC: { value: new THREE.Color(0xbfe6f8) }, uFogN: { value: 50 }, uFogF: { value: 140 }, uFogOn: { value: 0 } }; };
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
      var B = parts.map(function () { return { sp: [], se: [], sl: [], si: [], bp: [], bc: [], bi: [], fp: [], fs: [], fi: [], n: 0, bn: 0, fn: 0, mist: [] }; });
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
        var edges = [[y === 0, [x + 1, 0, y], [x, 0, y], 0, -1], [x === m.w - 1, [x + 1, 0, y + 1], [x + 1, 0, y], 1, 0],
          [y === m.h - 1, [x, 0, y + 1], [x + 1, 0, y + 1], 0, 1], [x === 0, [x, 0, y], [x, 0, y + 1], -1, 0]];
        edges.forEach(function (e) {
          if (!e[0]) return;
          var a = e[1], b = e[2], ox = e[3] * FLARE, oz = e[4] * FLARE;
          var NX = 4, NS = 10, ix, js;
          for (js = 0; js <= NS; js++) {
            var sv = js / NS;
            for (ix = 0; ix <= NX; ix++) {
              var u = ix / NX;
              R.fp.push(a[0] + (b[0] - a[0]) * u + ox * sv, WL - FALL * sv * sv, a[2] + (b[2] - a[2]) * u + oz * sv); R.fs.push(sv);
            }
          }
          for (js = 0; js < NS; js++) for (ix = 0; ix < NX; ix++) {
            var i0 = R.fn + js * (NX + 1) + ix, i1 = i0 + 1, i2 = i0 + NX + 1, i3 = i2 + 1;
            R.fi.push(i0, i2, i1, i1, i2, i3);
          }
          R.fn += (NX + 1) * (NS + 1);
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
        var fm = mesh(r, R.fp, R.fi, fallMat, { aS: [R.fs, 1] }); if (fm) fm.renderOrder = 2;
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
      var fg = R3D.fog; if (fg) [surfMat, fallMat].forEach(function (mt) { mt.uniforms.uFogC.value.copy(fg.color); mt.uniforms.uFogN.value = fg.near; mt.uniforms.uFogF.value = fg.far; mt.uniforms.uFogOn.value = fg.on; });
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
