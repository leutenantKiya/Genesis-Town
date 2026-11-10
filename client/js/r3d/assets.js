/*
 * r3d/assets.js - shared loader for the 3D view's texture files (client/assets/textures/*.png). Textures are CC0 (Poly Haven,
 * ambientCG) and credited in docs/ASSET-CREDITS.md. R3D.assets.tex(name) returns a texture at once; its picture arrives a moment
 * later and the material updates by itself. Everything is lazy: nothing here is fetched in the 2D view.
 */
(function () {
  'use strict';
  var R3D = window.R3D = window.R3D || {};
  var THREE = window.THREE;
  if (!THREE) return;
  var cache = {}, loader = null;

  R3D.assets = {
    base: 'assets/textures/',
    // opts: {linear: true for normal maps, repeat: true (default)}
    tex: function (name, opts) {
      opts = opts || {};
      if (cache[name]) return cache[name];
      if (!loader) loader = new THREE.TextureLoader();
      var t = loader.load(this.base + name + '.png');
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = opts.linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
      t.anisotropy = 4;
      cache[name] = t;
      return t;
    },
    disposeAll: function () { Object.keys(cache).forEach(function (k) { cache[k].dispose(); }); cache = {}; loader = null; }
  };
})();
