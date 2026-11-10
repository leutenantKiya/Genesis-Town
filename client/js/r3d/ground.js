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

  var mesh = null, tex = null, lastCache = null, curMap = null;
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
      var geo = new THREE.PlaneGeometry(map.w, map.h);
      geo.rotateX(-Math.PI / 2);
      mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff }));
      mesh.position.set(map.w / 2, 0, map.h / 2);
      C.root.add(mesh);
      this.sync();
    },
    // pick up a freshly baked cache canvas
    sync: function () {
      if (!mesh || !curMap || !curMap.cache || curMap.cache === lastCache) return;
      lastCache = curMap.cache;
      if (tex) tex.dispose();
      tex = makeTexture(lastCache);
      mesh.material.map = tex;
      mesh.material.needsUpdate = true;
    },
    update: function (C, info) {
      if (!mesh) return;
      if (info.map !== curMap) return;
      this.sync();
      mesh.material.color.copy(DAYC).lerp(NIGHTC, Math.min(1, info.dark));
    },
    dispose: function (C) {
      if (mesh) { C.root.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); }
      if (tex) tex.dispose();
      mesh = tex = lastCache = curMap = null;
    }
  };
})();
