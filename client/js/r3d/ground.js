/*
 * r3d/ground.js - the top face of the island: one quad per map, textured with the engine's baked world canvas (map.cache,
 * the same picture the 2D view shows: terrain, roads, water, props, buildings). The texture is rebuilt whenever the engine
 * bakes a new cache (snow, chunks opening). Phase 3 will move buildings and props out of the bake into 3D meshes.
 * Colour is tinted for night with the game's darkness value (proper lighting arrives in phase 4).
 */
(function () {
  'use strict';
  var R3D = window.R3D = window.R3D || {};
  var THREE = window.THREE;
  if (!THREE) return;

  var mesh = null, tex = null, lastCache = null, curMap = null, shadowMesh = null;
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

  R3D.ground = {
    init: function (C) { mesh = tex = lastCache = curMap = null; },
    onWorld: function (C, map) {
      this.dispose(C);
      curMap = map;
      // one quad per horizontal run of land; water tiles are left as holes (water.js fills them, recessed)
      var pos = [], uv = [], idx = [], n = 0, x, y, x0;
      for (y = 0; y < map.h; y++) {
        x = 0;
        while (x < map.w) {
          if (isWater(map, x, y)) { x++; continue; }
          x0 = x;
          while (x < map.w && !isWater(map, x, y)) x++;
          pos.push(x0, 0, y, x0, 0, y + 1, x, 0, y + 1, x, 0, y);
          uv.push(x0 / map.w, 1 - y / map.h, x0 / map.w, 1 - (y + 1) / map.h, x / map.w, 1 - (y + 1) / map.h, x / map.w, 1 - y / map.h);
          idx.push(n, n + 1, n + 2, n, n + 2, n + 3); n += 4;
        }
      }
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx);
      mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
      mesh.frustumCulled = false;
      C.root.add(mesh);
      // real sun shadows fall on this clear plane (the ground texture itself is unlit)
      var sgeo = new THREE.PlaneGeometry(map.w, map.h); sgeo.rotateX(-Math.PI / 2);
      shadowMesh = new THREE.Mesh(sgeo, new THREE.ShadowMaterial({ color: 0x141a38, opacity: 0.34, depthWrite: false }));
      shadowMesh.position.set(map.w / 2, 0.012, map.h / 2); shadowMesh.receiveShadow = true; shadowMesh.renderOrder = 0.5; shadowMesh.frustumCulled = false;
      C.root.add(shadowMesh);
      this.sync();
    },
    // pick up a freshly baked cache canvas
    sync: function () {
      if (!mesh || !curMap || !curMap.cache || curMap.cache === lastCache) return;
      lastCache = curMap.cache;
      if (tex) tex.dispose();
      tex = makeTexture((window.GT && GT.bakeFlat && GT.bakeFlat(curMap)) || lastCache);
      mesh.material.map = tex;
      mesh.material.needsUpdate = true;
    },
    update: function (C, info) {
      if (!mesh) return;
      if (info.map !== curMap) return;
      this.sync();
      if (shadowMesh) shadowMesh.visible = !!info.shadowsOn;
      mesh.material.color.copy(DAYC).lerp(NIGHTC, Math.min(1, info.dark));
    },
    dispose: function (C) {
      if (mesh) { C.root.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); }
      if (shadowMesh) { C.root.remove(shadowMesh); shadowMesh.geometry.dispose(); shadowMesh.material.dispose(); shadowMesh = null; }
      if (tex) tex.dispose();
      mesh = tex = lastCache = curMap = null;
    }
  };
})();
