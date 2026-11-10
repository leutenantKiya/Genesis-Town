/*
 * r3d/models.js - the 3D view's model library: glTF props from a CC0 nature pack (Quaternius "Stylized Nature", credited in
 * docs/ASSET-CREDITS.md) in client/assets/models/nature_pack/. preload() fetches the few models the world uses before the first
 * frame (never fails: if a file is missing the matching procedural prop stays, see props.js and ground.js). instance() puts many
 * copies of one model into a region with InstancedMesh, one draw call per material. Leaf and flower cards use alpha-test, with a
 * matching depth material so their shadows have the same cut-out shape; grass, flowers and bushes sway a little in the wind.
 */
(function () {
  'use strict';
  var R3D = window.R3D = window.R3D || {};
  var THREE = window.THREE, GLTFLoader = window.THREE_GLTFLoader;
  if (!THREE || !GLTFLoader) return;

  var BASE = 'assets/models/nature_pack/';
  var NAMES = ['MapleTree_4', 'MapleTree_1', 'BirchTree_4', 'Bush', 'Bush_Large', 'Bush_Small', 'Bush_Flowers', 'Bush_Large_Flowers', 'Bush_Small_Flowers',
    'Grass_Small', 'Grass_Large', 'Flower_1_Clump', 'Flower_2_Clump', 'Flower_3_Clump', 'Flower_4_Clump', 'Flower_5_Clump', 'DeadTree_5', 'DeadTree_9'];
  var NOMAP = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  var lib = {}, matCache = {}, time = { value: 0 }, snow = 0, loading = null;

  function swayable(name) { return /^(Grass|Flower|Bush)/.test(name); }

  function makeMaterial(src, name) {
    var key = name.split('_')[0] + '|' + (src.map && src.map.name || src.name || '') + '|' + (swayable(name) ? 's' : 'r');
    if (matCache[key]) return matCache[key];
    var cut = !!(src.transparent || src.alphaTest > 0);
    var m = new THREE.MeshLambertMaterial({ map: src.map || null, side: THREE.DoubleSide, alphaTest: cut ? 0.5 : 0 });
    if (src.map) src.map.anisotropy = 4;
    if (/^Grass/.test(name)) m.color.setRGB(1.4, 1.5, 1.1); // the grass texture is dark: lift it to the ground's greens
    if (cut && src.map) m.userData.depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: src.map, alphaTest: 0.5, side: THREE.DoubleSide });
    if (swayable(name)) {
      m.onBeforeCompile = function (sh) {
        sh.uniforms.uTime = time;
        sh.vertexShader = sh.vertexShader.replace('#include <common>', 'uniform float uTime;\n#include <common>')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\n  float gsw = clamp(position.y * 2.2, 0.0, 1.0);\n  transformed.x += sin(uTime * 1.7 + position.x * 3.1 + position.z * 2.3) * 0.05 * gsw;\n  transformed.z += cos(uTime * 1.3 + position.z * 2.7 + position.x * 1.9) * 0.03 * gsw;');
      };
      m.customProgramCacheKey = function () { return 'gt-model-sway'; };
    }
    matCache[key] = m; return m;
  }

  function ingest(name, gltf) {
    gltf.scene.updateMatrixWorld(true);
    var parts = [], box = new THREE.Box3();
    gltf.scene.traverse(function (o) {
      if (!o.isMesh) return;
      var g = o.geometry.clone(); g.applyMatrix4(o.matrixWorld);
      g.computeBoundingBox(); box.union(g.boundingBox);
      parts.push({ geo: g, src: o.material });
    });
    var y0 = box.min.y;
    parts.forEach(function (p) { p.geo.translate(0, -y0, 0); p.geo.computeBoundingBox(); p.geo.computeBoundingSphere(); p.mat = makeMaterial(p.src, name); delete p.src; });
    lib[name] = { parts: parts, h: box.max.y - y0, w: Math.max(box.max.x - box.min.x, box.max.z - box.min.z) };
  }

  R3D.models = {
    // resolves when every model has loaded or failed; never rejects
    preload: function () {
      if (loading) return loading;
      var mgr = new THREE.LoadingManager();
      mgr.setURLModifier(function (u) { return /_Normal\.png/i.test(u) ? NOMAP : u; });
      var loader = new GLTFLoader(mgr);
      loading = Promise.all(NAMES.map(function (n) {
        return new Promise(function (res) {
          loader.load(BASE + n + '.gltf', function (g) { try { ingest(n, g); } catch (e) { try { console.warn('[3d] model', n, e); } catch (x) { /* ignore */ } } res(); }, undefined, function () { res(); });
        });
      }));
      return loading;
    },
    has: function (n) { return !!lib[n]; },
    size: function (n) { return lib[n] ? { h: lib[n].h, w: lib[n].w } : null; },
    setSnow: function (on) { snow = on ? 1 : 0; Object.keys(matCache).forEach(function (k) { var m = matCache[k]; if (/^(Maple|Birch|Bush|Dead)/.test(k)) { m.emissive.setRGB(0.3 * snow, 0.33 * snow, 0.38 * snow); m.color.setRGB(1 - 0.12 * snow, 1 - 0.1 * snow, 1); } }); },
    tick: function (t) { time.value = t || 0; },
    // list: [{x, y, z, s, ry}] in the parent's space; opts: {cast, receive, pick}. Returns the meshes (add nothing else to the parent).
    instance: function (name, list, parent, opts) {
      var M = lib[name], out = [];
      if (!M || !list.length) return out;
      opts = opts || {};
      var m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), i;
      M.parts.forEach(function (part) {
        var im = new THREE.InstancedMesh(part.geo, part.mat, list.length);
        for (i = 0; i < list.length; i++) {
          var it = list[i];
          q.setFromAxisAngle(up, it.ry || 0); p.set(it.x, it.y || 0, it.z); s.set(it.s, it.s, it.s);
          m4.compose(p, q, s); im.setMatrixAt(i, m4);
        }
        im.instanceMatrix.needsUpdate = true; im.frustumCulled = false;
        im.castShadow = !!opts.cast; im.receiveShadow = opts.receive !== false;
        if (part.mat.userData.depth) im.customDepthMaterial = part.mat.userData.depth;
        if (!opts.pick) im.userData.nopick = true;
        parent.add(im); out.push(im);
      });
      return out;
    },
    dispose: function () {
      Object.keys(lib).forEach(function (k) { lib[k].parts.forEach(function (p) { p.geo.dispose(); }); });
      Object.keys(matCache).forEach(function (k) { var m = matCache[k]; if (m.map) m.map.dispose(); if (m.userData.depth) m.userData.depth.dispose(); m.dispose(); });
      lib = {}; matCache = {}; loading = null;
    }
  };
})();
