/*
 * kit.js - the base of the 3D world kit (window.GT3). The world is drawn with three.js in an HD-2D style: real 3D
 * geometry, lit and shadowed, carrying the game's own pixel art (js/sprites.js, art.js, buildings.js) as textures and
 * the same seasonal colour ramps. Loaded after vendor/three.js and the sprite scripts, before the other js/three files.
 *
 * Units and axes: 1 unit = 1 tile (12 art pixels, GT3.PX = 1/12). Tile (x, y) covers x..x+1 on X (east) and y..y+1 on
 * Z (south); Y is up. The camera looks north from the south side, so "front" faces point to +Z.
 *
 * Every component is a factory that returns a THREE.Object3D (or an object holding one in `.group`):
 *   GT3.Ground(L)            ground.js     the tile ground, sunken water, banks and the cut soil edge of the world
 *   GT3.Building(b)          building.js   walls with the 2D facade, a gabled roof, tower/awning/flag by kind
 *   GT3.Nature(L)            nature.js     trees (oak, pine, fruit; bare in winter), rocks, bushes, tall grass, flowers
 *   GT3.Props(L)             props.js      fences, barrels, crates, mailboxes, signs, lamps, stalls, the portal
 *   GT3.Actor(palette)       actor.js      a character: the 2D sprite as an upright card with a ground shadow
 *   GT3.Sky(scene, renderer) sky.js        sun, ambient light and background by hour and season
 *   GT3.Rig(camera)          rig.js        the follow camera
 *   GT3.SeeThrough(world)    seethrough.js buildings and canopies fade when they hide the player
 *   GT3.World(L, opts)       world.js      all of the above for one layout (GTVillage / GTHomeland output)
 * This file: textures, the banded toon material, colour and geometry helpers shared by all of them.
 */
(function () {
  'use strict';
  var THREE = window.THREE, S = window.SPRITES;
  if (!THREE || !S) return;
  var TILE = S.TILE || 12, PX = 1 / TILE;
  var GT3 = window.GT3 = { THREE: THREE, TILE: TILE, PX: PX };

  /* ---------------------------------------------------------------- small helpers */
  GT3.canvas = function (w, h) { var c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
  GT3.hash = function (a, b, c) { var h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 2147483647)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return (h ^ (h >>> 16)) >>> 0; };
  GT3.rng = function (seed) { var s = seed >>> 0 || 1; return function () { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; };
  GT3.noise = function (seed, x, y) {
    function h(ix, iy) { return (GT3.hash(ix, iy, seed) % 1000) / 1000; }
    var x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    var a = h(x0, y0), b = h(x0 + 1, y0), c = h(x0, y0 + 1), d = h(x0 + 1, y0 + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
  GT3.R = function (g, x, y, w, h, col) { g.fillStyle = col; g.fillRect(x, y, w, h); };

  /* ---------------------------------------------------------------- textures */
  /** A pixel-art texture from a canvas: hard texels up close, mipmaps when far. repeat: tile it (true) */
  GT3.tex = function (canvas, repeat) {
    var t = new THREE.CanvasTexture(canvas);
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  };
  /** One tile of the 2D art (without its grass base) as a 12 x 12 canvas. */
  GT3.tileCanvas = function (type, frame) {
    var c = GT3.canvas(TILE, TILE), g = c.getContext('2d');
    if (S.drawOverlay) S.drawOverlay(g, type, 0, 0, frame || 0);
    return c;
  };
  GT3.crop = function (src, x, y, w, h) { var c = GT3.canvas(w, h); c.getContext('2d').drawImage(src, x, y, w, h, 0, 0, w, h); return c; };

  /* ---------------------------------------------------------------- materials */
  // light arrives in four bands instead of a smooth falloff, so shaded faces read like the steps of a pixel-art ramp
  var grad = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0, 96, 160, 218, 255]), 8, 1, THREE.RedFormat);
  grad.minFilter = grad.magFilter = THREE.NearestFilter; grad.generateMipmaps = false; grad.needsUpdate = true;
  /** The kit's one lit material: banded light, receives the sun and shadows. Pass map / color / alphaTest / side ... */
  GT3.mat = function (o) {
    var p = { gradientMap: grad };
    for (var k in o) p[k] = o[k];
    return new THREE.MeshToonMaterial(p);
  };
  GT3.color = function (hex) { return new THREE.Color(hex); };

  /* ---------------------------------------------------------------- geometry */
  /** Merge geometries into one flat-shaded, vertex-coloured geometry.
   *  parts: [{ geo, matrix?, color?: hex | function(normal, centre, faceIndex) -> hex }] */
  GT3.merge = function (parts) {
    var pos = [], col = [], uv = [], hasUv = true, n = new THREE.Vector3(), ctr = new THREE.Vector3();
    var a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), tmp = new THREE.Color();
    parts.forEach(function (p) {
      var g = p.geo.index ? p.geo.toNonIndexed() : p.geo.clone();
      if (p.matrix) g.applyMatrix4(p.matrix);
      var P = g.attributes.position, U = g.attributes.uv;
      if (!U) hasUv = false;
      for (var i = 0; i < P.count; i += 3) {
        a.fromBufferAttribute(P, i); b.fromBufferAttribute(P, i + 1); c.fromBufferAttribute(P, i + 2);
        n.copy(c).sub(b).cross(ctr.copy(a).sub(b)).normalize();
        ctr.copy(a).add(b).add(c).multiplyScalar(1 / 3);
        var hex = typeof p.color === 'function' ? p.color(n, ctr, i / 3) : (p.color || '#ffffff');
        tmp.set(hex);
        for (var k = 0; k < 3; k++) {
          pos.push(P.getX(i + k), P.getY(i + k), P.getZ(i + k));
          col.push(tmp.r, tmp.g, tmp.b);
          if (U) uv.push(U.getX(i + k), U.getY(i + k));
        }
      }
      g.dispose();
    });
    var out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    if (hasUv && uv.length) out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    out.computeVertexNormals(); // non-indexed: one normal per face, so faces stay flat
    return out;
  };
  GT3.xform = function (x, y, z, sx, sy, sz, ry, rx, rz) {
    var m = new THREE.Matrix4(), q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx || 0, ry || 0, rz || 0, 'YXZ'));
    return m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(sx == null ? 1 : sx, sy == null ? (sx == null ? 1 : sx) : sy, sz == null ? (sx == null ? 1 : sx) : sz));
  };
  /** A quad given four corners (counter-clockwise seen from its front) with uv 0..1 (or uv rect [u0, v0, u1, v1]). */
  GT3.quad = function (p0, p1, p2, p3, uvr) {
    var u = uvr || [0, 0, 1, 1], g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([].concat(p0, p1, p2, p0, p2, p3), 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([u[0], u[1], u[2], u[1], u[2], u[3], u[0], u[1], u[2], u[3], u[0], u[3]], 2));
    g.computeVertexNormals();
    return g;
  };
  /** Free everything under an object (geometries, materials, their textures). */
  GT3.dispose = function (obj) {
    obj.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      var ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      ms.forEach(function (m) { ['map', 'emissiveMap', 'alphaMap'].forEach(function (k) { if (m[k] && !m[k].userData.shared) m[k].dispose(); }); m.dispose(); });
    });
    if (obj.parent) obj.parent.remove(obj);
  };

  /* ---------------------------------------------------------------- season */
  GT3.SEASONS = ['semi', 'panas', 'gugur', 'dingin'];
  /** The season's colour ramps: the same live tables the 2D art uses (art.js swaps them in place). */
  GT3.pal = function () { return S.PAL; };
  GT3.season = function () { return S.season || 'semi'; };
  GT3.snowy = function () { return !!S.snow; };
})();
