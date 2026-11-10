/*
 * r3d/ground.js - the top face of each island as real, lit 3D terrain. The ground is one quad mesh per region (regions.js, so a
 * locked chunk can float on its own; water tiles are holes that water.js fills). Its surface is not a baked picture any more:
 * a shader blends five painterly CC0 textures (grass, dirt path, sand, cobbles, soil) plus bridge planks with soft, noise-warped
 * edges, from a small "splat" map built out of the tile types. It takes the sun's real shadows and the lamps' light, goes
 * white under snow, darkens where a chunk is still locked, and darkens damp earth at the water's edge. On top of it sit
 * instanced blades of grass, tall grass and flowers (the flat bake used to paint these), swaying a little in the wind.
 * Textures: Poly Haven (CC0), stylised to the game's palette, see docs/ASSET-CREDITS.md.
 */
(function () {
  'use strict';
  var R3D = window.R3D = window.R3D || {};
  var THREE = window.THREE;
  if (!THREE || !R3D.geo) return;
  var hash = R3D.geo.hash, Builder = R3D.geo.Builder;

  var parts = null, meshes = [], mat = null, curMap = null, lastCache = null, lastSnow = null, curC = null;
  var splatA = null, splatB = null, scatterMat = null, scatterU = null, U = null, wind = [];
  var TYPES = { grass: 0, path: 1, sand: 2, plaza: 3, soil: 4, bridge: 5, water: 6 };
  var SPLAT = 4; // splat texels per tile

  function isWater(m, x, y) { return m.tiles[y * m.w + x] === 'water'; }
  function vnoise(x, y, s) {
    var xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    var a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }
  function groundType(Sp, t) {
    if (t === 'water') return 'water';
    var g = (Sp && Sp.groundOf && Sp.groundOf(t)) || 'grass';
    return TYPES[g] != null ? g : 'grass';
  }

  // one-hot ground types at SPLAT x resolution, edges warped by noise, then blurred: soft organic borders between materials
  function buildSplat(map) {
    var Sp = window.SPRITES, W = map.w * SPLAT, H = map.h * SPLAT, N = W * H, CH = 8, i, c, x, y;
    var gt = new Uint8Array(map.w * map.h);
    for (i = 0; i < gt.length; i++) gt[i] = TYPES[groundType(Sp, map.tiles[i])];
    var ch = new Float32Array(N * CH), lk = map.locked;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      var px = (x + 0.5) / SPLAT, py = (y + 0.5) / SPLAT;
      var wx = px + (vnoise(px * 1.9, py * 1.9, 1) - 0.5) * 0.6, wy = py + (vnoise(px * 1.9, py * 1.9, 2) - 0.5) * 0.6;
      var tx = Math.max(0, Math.min(map.w - 1, Math.floor(wx))), ty = Math.max(0, Math.min(map.h - 1, Math.floor(wy)));
      var ti = ty * map.w + tx, o = (y * W + x) * CH;
      ch[o + gt[ti]] = 1;
      if (lk && lk[Math.max(0, Math.min(map.h - 1, Math.floor(py))) * map.w + Math.max(0, Math.min(map.w - 1, Math.floor(px)))]) ch[o + 7] = 1;
    }
    // separable box blur, two passes, radius 2 texels (half a tile)
    var tmp = new Float32Array(N), R = 2, pass, k, s, cnt;
    for (c = 0; c < CH; c++) for (pass = 0; pass < 2; pass++) {
      for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
        s = 0; cnt = 0;
        for (k = -R; k <= R; k++) { var xx = x + k; if (xx < 0 || xx >= W) continue; s += ch[(y * W + xx) * CH + c]; cnt++; }
        tmp[y * W + x] = s / cnt;
      }
      for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
        s = 0; cnt = 0;
        for (k = -R; k <= R; k++) { var yy = y + k; if (yy < 0 || yy >= H) continue; s += tmp[yy * W + x]; cnt++; }
        ch[(y * W + x) * CH + c] = s / cnt;
      }
    }
    var A = new Uint8Array(N * 4), B = new Uint8Array(N * 4);
    for (i = 0; i < N; i++) {
      var o2 = i * CH, sum = ch[o2] + ch[o2 + 1] + ch[o2 + 2] + ch[o2 + 3] + ch[o2 + 4] + ch[o2 + 5];
      if (sum < 1e-4) { A[i * 4] = 255; continue; }
      var inv = 255 / sum;
      A[i * 4] = ch[o2] * inv; A[i * 4 + 1] = ch[o2 + 1] * inv; A[i * 4 + 2] = ch[o2 + 2] * inv; A[i * 4 + 3] = ch[o2 + 3] * inv;
      B[i * 4] = ch[o2 + 4] * inv; B[i * 4 + 1] = ch[o2 + 5] * inv;
      B[i * 4 + 2] = Math.min(255, ch[o2 + 7] * 255); B[i * 4 + 3] = Math.min(255, ch[o2 + 6] * 255 * 1.6);
    }
    function tex(data) {
      var t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter; t.generateMipmaps = false;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true; return t;
    }
    return { a: tex(A), b: tex(B) };
  }

  var VS_PARS = 'varying vec2 vTP;\n#include <common>';
  var FS_PARS = [
    'varying vec2 vTP;', 'uniform sampler2D uSA, uSB, tG, tP, tS, tZ, tO, tW;', 'uniform vec2 uSize; uniform float uSnow;',
    'float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
    'float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y); }',
    // two samples at different scale and rotation, mixed by a slow noise: the texture never visibly repeats
    'vec3 tile(sampler2D t, vec2 p, float sc){ float n = smoothstep(0.3, 0.7, vn(p * 0.23 + 7.0));',
    '  return mix(texture2D(t, p * sc).rgb, texture2D(t, vec2(p.y, -p.x) * sc * 0.77 + 0.31).rgb, n); }',
    '#include <common>'
  ].join('\n');
  var FS_MAIN = [
    'vec2 suv = vTP / uSize;',
    'vec4 sA = texture2D(uSA, suv), sB = texture2D(uSB, suv);',
    'float wg = sA.r, wp = sA.g, ws = sA.b, wz = sA.a, wo = sB.r, wb = sB.g;',
    'vec3 gcol = vec3(0.0);',
    'if (wg > 0.01) gcol += wg * tile(tG, vTP, 0.21);',
    'if (wp > 0.01) gcol += wp * tile(tP, vTP, 0.25);',
    'if (ws > 0.01) gcol += ws * tile(tS, vTP, 0.2);',
    'if (wz > 0.01) gcol += wz * tile(tZ, vTP, 0.3);',
    'if (wo > 0.01) gcol += wo * tile(tO, vTP, 0.26);',
    'if (wb > 0.01) gcol += wb * texture2D(tW, vTP * vec2(0.9, 0.3)).rgb;',
    'float mac = vn(vTP * 0.17 + 3.0) * 0.6 + vn(vTP * 0.55) * 0.4;',
    'gcol *= mix(vec3(0.9, 0.94, 0.88), vec3(1.07, 1.05, 0.96), mac);',
    'gcol = mix(gcol, gcol * vec3(1.12, 1.05, 0.8), wg * smoothstep(0.55, 0.85, mac) * 0.8);',   // sunlit, yellower patches of grass
    'gcol *= 1.0 - 0.32 * smoothstep(0.08, 0.6, sB.a);',                                            // damp earth by the water
    'float sn = uSnow * (wg * 0.96 + wp * 0.62 + wz * 0.5 + ws * 0.35 + wo * 0.35);',
    'gcol = mix(gcol, vec3(0.8, 0.86, 0.97) * (0.93 + 0.07 * mac), sn);',
    'gcol = mix(gcol, vec3(0.012, 0.01, 0.04), 0.6 * sB.b);',                                       // a chunk that is not open yet
    'diffuseColor.rgb = gcol;'
  ].join('\n');

  function makeMaterial() {
    var A = R3D.assets;
    U = {
      uSA: { value: null }, uSB: { value: null }, uSize: { value: new THREE.Vector2(1, 1) }, uSnow: { value: 0 },
      tG: { value: A.tex('terrain_grass') }, tP: { value: A.tex('terrain_path') }, tS: { value: A.tex('terrain_sand') },
      tZ: { value: A.tex('terrain_plaza') }, tO: { value: A.tex('terrain_soil') }, tW: { value: A.tex('wood_floor') }
    };
    var m = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    m.onBeforeCompile = function (sh) {
      Object.keys(U).forEach(function (k) { sh.uniforms[k] = U[k]; });
      sh.vertexShader = sh.vertexShader.replace('#include <common>', VS_PARS).replace('#include <begin_vertex>', '#include <begin_vertex>\n  vTP = position.xz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', FS_PARS).replace('#include <map_fragment>', FS_MAIN);
    };
    m.customProgramCacheKey = function () { return 'gt-ground-terrain'; };
    return m;
  }

  // ------------------------------------------------------------------ blades of grass, tall grass and flowers
  var GRASS = ['#5aa83c', '#6cbc46', '#4c9a38', '#86cc54', '#76c04a'], TALL = ['#3c7a38', '#4f9448', '#68b050', '#7fc25c'];
  var FLOWER = ['#f4d03c', '#f06a8a', '#ffffff', '#b58cf0', '#ff8a3c', '#ff5a5a'];
  function blade(B, cx, cz, h, w, ang, lean, hex) {
    var ca = Math.cos(ang), sa = Math.sin(ang), c = B.col(hex, 1, 1);
    B.tri([cx - ca * w, 0, cz - sa * w], [cx + ca * w, 0, cz + sa * w], [cx - sa * lean, h, cz + ca * lean], c);
  }
  function buildScatter(map, sn) {
    var RG = R3D.regions, n = parts.length, BS = [], r, x, y, i;
    for (r = 0; r < n; r++) { BS.push(new Builder()); BS[r].snow = sn ? 0.9 : 0; }
    var covered = new Uint8Array(map.w * map.h);
    (map.buildings || []).forEach(function (b) {
      for (var yy = b.y - 1; yy < b.y + (b.h || 3) + 1; yy++) for (var xx = b.x - 1; xx < b.x + (b.w || 3) + 1; xx++) if (xx >= 0 && yy >= 0 && xx < map.w && yy < map.h) covered[yy * map.w + xx] = 1;
    });
    for (y = 0; y < map.h; y++) for (x = 0; x < map.w; x++) {
      i = y * map.w + x; var t = map.tiles[i];
      if (t !== 'grass' && t !== 'tallgrass' && t !== 'flower') continue;
      if (covered[i] || (map.locked && map.locked[i])) continue;
      var B = BS[RG.of(x, y)], h0 = hash(x, y, 77), k, tu, nTu;
      if (t === 'tallgrass') nTu = 6; else if (t === 'flower') nTu = 2; else nTu = h0 < 0.3 ? 1 : h0 < 0.75 ? 2 : 3;
      for (tu = 0; tu < nTu; tu++) {
        var cx = x + 0.1 + 0.8 * hash(x, y, 100 + tu), cz = y + 0.1 + 0.8 * hash(x, y, 200 + tu);
        var nb = t === 'tallgrass' ? 5 : 4, pal = t === 'tallgrass' ? TALL : GRASS;
        for (k = 0; k < nb; k++) {
          var hh = hash(x * 7 + tu, y * 3 + k, 31), a = hh * 6.283 + k * 1.2;
          var ht = (t === 'tallgrass' ? 0.3 + 0.22 * hh : 0.12 + 0.12 * hh);
          blade(B, cx + (hash(x, y, 300 + tu * 5 + k) - 0.5) * 0.12, cz + (hash(x, y, 400 + tu * 5 + k) - 0.5) * 0.12, ht, 0.028, a, 0.05 + 0.08 * hh, pal[(hh * 17 | 0) % pal.length]);
        }
      }
      if (t === 'flower' && !sn) {
        var nf = 3 + (h0 * 3 | 0);
        for (k = 0; k < nf; k++) {
          var fx = x + 0.12 + 0.76 * hash(x, y, 500 + k), fz = y + 0.12 + 0.76 * hash(x, y, 600 + k), fh = 0.2 + 0.1 * hash(x, y, 700 + k);
          blade(B, fx, fz, fh, 0.012, k * 2.1, 0.02, '#4c9a38');
          B.blob(fx, fh + 0.02, fz, 0.06, 0.045, 0.06, FLOWER[(hash(x, y, 800 + k) * FLOWER.length) | 0], 1, x * 5 + y + k, '#ffffff');
        }
      }
    }
    for (r = 0; r < n; r++) {
      if (BS[r].empty()) continue;
      var mesh = BS[r].mesh(scatterMat, false); mesh.receiveShadow = true; mesh.userData.nopick = true;
      parts[r].add(mesh); meshes.push(mesh);
    }
  }
  function makeScatterMaterial() {
    scatterU = { uTime: { value: 0 } };
    var m = R3D.geo.lit();
    m.onBeforeCompile = function (sh) {
      sh.uniforms.uTime = scatterU.uTime;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', 'uniform float uTime;\n#include <common>')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n  float gsw = clamp(position.y * 3.5, 0.0, 1.0);\n  transformed.x += sin(uTime * 1.7 + position.x * 2.3 + position.z * 1.7) * 0.035 * gsw;\n  transformed.z += cos(uTime * 1.3 + position.z * 2.1 + position.x * 1.5) * 0.02 * gsw;');
    };
    m.customProgramCacheKey = function () { return 'gt-ground-scatter'; };
    return m;
  }

  function clear() {
    if (parts) R3D.regions.unmount(parts);
    parts = null; meshes = [];
    if (splatA) { splatA.dispose(); splatA = null; } if (splatB) { splatB.dispose(); splatB = null; }
  }

  function refreshSplat(map) {
    if (splatA) splatA.dispose(); if (splatB) splatB.dispose();
    var s = buildSplat(map); splatA = s.a; splatB = s.b;
    U.uSA.value = splatA; U.uSB.value = splatB; U.uSize.value.set(map.w, map.h);
  }

  R3D.ground = {
    init: function (C) {
      curC = C; parts = null; meshes = []; curMap = lastCache = null; lastSnow = null;
      mat = makeMaterial(); scatterMat = makeScatterMaterial();
    },
    onWorld: function (C, map) {
      clear();
      curMap = map;
      parts = R3D.regions.mount();
      var RG = R3D.regions, n = parts.length, arr = [], r, x, y, x0;
      for (r = 0; r < n; r++) arr.push({ pos: [], nor: [], idx: [], n: 0 });
      // one quad per horizontal run of land inside a region; water tiles are left as holes
      for (y = 0; y < map.h; y++) {
        x = 0;
        while (x < map.w) {
          if (isWater(map, x, y)) { x++; continue; }
          x0 = x; r = RG.of(x, y);
          while (x < map.w && !isWater(map, x, y) && RG.of(x, y) === r) x++;
          var a = arr[r];
          a.pos.push(x0, 0, y, x0, 0, y + 1, x, 0, y + 1, x, 0, y);
          a.nor.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
          a.idx.push(a.n, a.n + 1, a.n + 2, a.n, a.n + 2, a.n + 3); a.n += 4;
        }
      }
      for (r = 0; r < n; r++) {
        if (!arr[r].n) continue;
        var geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(arr[r].pos, 3));
        geo.setAttribute('normal', new THREE.Float32BufferAttribute(arr[r].nor, 3));
        geo.setIndex(arr[r].idx);
        var mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; mesh.receiveShadow = true; mesh.userData.nopick = true;
        parts[r].add(mesh); meshes.push(mesh);
      }
      lastCache = curMap.cache || null;
      refreshSplat(map);
      lastSnow = !!(window.SPRITES && window.SPRITES.snow);
      buildScatter(map, lastSnow);
    },
    // chunks opening or the weather changing the engine's cache: rebuild what depends on it
    sync: function () {
      if (!curMap) return;
      var sn = !!(window.SPRITES && window.SPRITES.snow);
      if (curMap.cache !== lastCache || sn !== lastSnow) {
        lastCache = curMap.cache || null; lastSnow = sn;
        refreshSplat(curMap);
        meshes.forEach(function (m) { if (m.material === scatterMat) { if (m.parent) m.parent.remove(m); m.geometry.dispose(); } });
        meshes = meshes.filter(function (m) { return m.material !== scatterMat; });
        buildScatter(curMap, sn);
      }
    },
    update: function (C, info) {
      if (!parts || info.map !== curMap) return;
      this.sync();
      U.uSnow.value += ((lastSnow ? 1 : 0) - U.uSnow.value) * 0.5;
      if (scatterU) scatterU.uTime.value = info.timeAcc || 0;
    },
    dispose: function (C) {
      clear();
      if (mat) mat.dispose(); if (scatterMat) scatterMat.dispose();
      mat = scatterMat = U = scatterU = curMap = null; lastCache = lastSnow = null;
    }
  };
})();
