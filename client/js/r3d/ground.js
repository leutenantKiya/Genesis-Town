/*
 * r3d/ground.js - the top face of each island: quads textured with the engine's flat bake of the world (GT.bakeFlat: terrain,
 * roads, water banks, shadows and fog; trunks, props and buildings are real 3D elsewhere). One mesh per region (regions.js),
 * so a locked chunk can float on its own. Water tiles are holes (water.js fills them, recessed). The texture is rebuilt
 * whenever the engine bakes a new cache (snow, chunks opening). Colour is tinted for night with the game's darkness value.
 */
(function () {
  'use strict';
  var R3D = window.R3D = window.R3D || {};
  var THREE = window.THREE;
  if (!THREE) return;

  var parts = null, meshes = [], mat = null, tex = null, lastCache = null, curMap = null, shadowMesh = null;
  function isWater(m, x, y) { return m.tiles[y * m.w + x] === 'water'; }
  var DAYC = new THREE.Color(1, 1, 1), NIGHTC = new THREE.Color(0.33, 0.38, 0.62);

  function makeTexture(cache) {
    var t = new THREE.CanvasTexture(cache);
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  function clear(C) {
    if (parts) R3D.regions.unmount(parts);
    parts = null; meshes = [];
    if (shadowMesh) { if (shadowMesh.parent) shadowMesh.parent.remove(shadowMesh); shadowMesh.geometry.dispose(); shadowMesh.material.dispose(); shadowMesh = null; }
  }

  R3D.ground = {
    init: function (C) { parts = null; meshes = []; tex = lastCache = curMap = null; mat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }); },
    onWorld: function (C, map) {
      clear(C);
      curMap = map;
      parts = R3D.regions.mount();
      var RG = R3D.regions, n = parts.length, arr = [], r, x, y, x0;
      for (r = 0; r < n; r++) arr.push({ pos: [], uv: [], idx: [], n: 0 });
      // one quad per horizontal run of land inside a region; water tiles are left as holes
      for (y = 0; y < map.h; y++) {
        x = 0;
        while (x < map.w) {
          if (isWater(map, x, y)) { x++; continue; }
          x0 = x; r = RG.of(x, y);
          while (x < map.w && !isWater(map, x, y) && RG.of(x, y) === r) x++;
          var a = arr[r];
          a.pos.push(x0, 0, y, x0, 0, y + 1, x, 0, y + 1, x, 0, y);
          a.uv.push(x0 / map.w, 1 - y / map.h, x0 / map.w, 1 - (y + 1) / map.h, x / map.w, 1 - (y + 1) / map.h, x / map.w, 1 - y / map.h);
          a.idx.push(a.n, a.n + 1, a.n + 2, a.n, a.n + 2, a.n + 3); a.n += 4;
        }
      }
      for (r = 0; r < n; r++) {
        if (!arr[r].n) continue;
        var geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(arr[r].pos, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(arr[r].uv, 2));
        geo.setIndex(arr[r].idx);
        var mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false;
        parts[r].add(mesh); meshes.push(mesh);
      }
      // real sun shadows fall on this clear plane over the open island (the ground texture itself is unlit)
      var sgeo = new THREE.PlaneGeometry(map.w, map.h); sgeo.rotateX(-Math.PI / 2);
      shadowMesh = new THREE.Mesh(sgeo, new THREE.ShadowMaterial({ color: 0x141a38, opacity: 0.34, depthWrite: false }));
      shadowMesh.position.set(map.w / 2, 0.012, map.h / 2); shadowMesh.receiveShadow = true; shadowMesh.renderOrder = 0.5; shadowMesh.frustumCulled = false;
      parts[0].add(shadowMesh);
      lastCache = null;
      this.sync();
    },
    // pick up a freshly baked cache canvas
    sync: function () {
      if (!curMap || !curMap.cache || curMap.cache === lastCache) return;
      lastCache = curMap.cache;
      if (tex) tex.dispose();
      tex = makeTexture((window.GT && GT.bakeFlat && GT.bakeFlat(curMap)) || lastCache);
      mat.map = tex; mat.needsUpdate = true;
    },
    update: function (C, info) {
      if (!parts) return;
      if (info.map !== curMap) return;
      this.sync();
      if (shadowMesh) shadowMesh.visible = !!info.shadowsOn;
      mat.color.copy(DAYC).lerp(NIGHTC, Math.min(1, info.dark));
    },
    dispose: function (C) {
      clear(C);
      if (mat) mat.dispose(); if (tex) tex.dispose();
      mat = tex = lastCache = curMap = null;
    }
  };
})();
