/*
 * r3d/geo.js - a tiny low-poly geometry builder. R3D.geo.Builder collects flat-shaded triangles with per-face colours
 * (boxes, gable roofs, pyramids, cylinders, cones, blobs) and turns them into one BufferGeometry, so a whole village of
 * props or buildings costs a few draw calls. Colours are sRGB hex strings (converted by THREE.Color).
 * Materials use DoubleSide, so face winding never matters for lighting.
 */
(function () {
  'use strict';
  var R3D = window.R3D = window.R3D || {};
  var THREE = window.THREE;
  if (!THREE) return;

  var tmpC = new THREE.Color();

  function hash(a, b, c) { var h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 1274126177)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }

  function Builder() { this.p = []; this.c = []; }
  Builder.prototype.col = function (hex, k) {
    tmpC.set(hex);
    var s = k == null ? 1 : k;
    return [tmpC.r * s, tmpC.g * s, tmpC.b * s];
  };
  Builder.prototype.tri = function (a, b, c, color) {
    this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    for (var i = 0; i < 3; i++) this.c.push(color[0], color[1], color[2]);
  };
  Builder.prototype.quad = function (a, b, c, d, color) { this.tri(a, b, c, color); this.tri(a, c, d, color); };

  // axis-aligned box from (x0,y0,z0) to (x1,y1,z1); optional separate top colour; k darkens (e.g. fog)
  Builder.prototype.box = function (x0, y0, z0, x1, y1, z1, hex, topHex, k) {
    var c = this.col(hex, k), t = topHex ? this.col(topHex, k) : c;
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], c); // south
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], c); // north
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], c); // east
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], c); // west
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], t); // top
  };

  // gable roof over [x0,x1] x [z0,z1] with the ridge along x; eave height y0, ridge y1. Gable ends use endHex.
  Builder.prototype.gable = function (x0, z0, x1, z1, y0, y1, hex, endHex, k, hexLit) {
    var zm = (z0 + z1) / 2, c = this.col(hex, k), l = this.col(hexLit || hex, k), e = this.col(endHex || hex, k);
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, zm], [x0, y1, zm], l);   // south slope (the one the camera sees)
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, zm], [x1, y1, zm], c);   // north slope
    this.tri([x0, y0, z0], [x0, y0, z1], [x0, y1, zm], e);                  // west gable
    this.tri([x1, y0, z1], [x1, y0, z0], [x1, y1, zm], e);                  // east gable
  };

  // four-sided pyramid / hip roof (square-ish), apex above the centre
  Builder.prototype.pyramid = function (x0, z0, x1, z1, y0, y1, hex, k, hexLit) {
    var xm = (x0 + x1) / 2, zm = (z0 + z1) / 2, c = this.col(hex, k), l = this.col(hexLit || hex, k), ap = [xm, y1, zm];
    this.tri([x0, y0, z1], [x1, y0, z1], ap, l);
    this.tri([x1, y0, z1], [x1, y0, z0], ap, c);
    this.tri([x1, y0, z0], [x0, y0, z0], ap, c);
    this.tri([x0, y0, z0], [x0, y0, z1], ap, c);
  };

  Builder.prototype.cone = function (cx, y0, cz, r, h, seg, hex, k, hexLit) {
    var c = this.col(hex, k), l = this.col(hexLit || hex, k), ap = [cx, y0 + h, cz], i;
    for (i = 0; i < seg; i++) {
      var a0 = i / seg * 6.2832, a1 = (i + 1) / seg * 6.2832;
      this.tri([cx + Math.cos(a0) * r, y0, cz + Math.sin(a0) * r], [cx + Math.cos(a1) * r, y0, cz + Math.sin(a1) * r], ap, (Math.sin((a0 + a1) / 2) > 0.2) ? l : c);
    }
  };

  Builder.prototype.cyl = function (cx, y0, cz, r, h, seg, hex, k, topHex, r2) {
    var c = this.col(hex, k), t = topHex ? this.col(topHex, k) : c, i, rt = r2 == null ? r : r2;
    for (i = 0; i < seg; i++) {
      var a0 = i / seg * 6.2832, a1 = (i + 1) / seg * 6.2832;
      var p0 = [cx + Math.cos(a0) * r, y0, cz + Math.sin(a0) * r], p1 = [cx + Math.cos(a1) * r, y0, cz + Math.sin(a1) * r];
      var q0 = [cx + Math.cos(a0) * rt, y0 + h, cz + Math.sin(a0) * rt], q1 = [cx + Math.cos(a1) * rt, y0 + h, cz + Math.sin(a1) * rt];
      this.quad(p0, p1, q1, q0, c);
      this.tri([cx, y0 + h, cz], q0, q1, t);
    }
  };

  // squashed icosahedron blob (foliage, rocks, bushes). jitter makes each one different.
  var PHI = (1 + Math.sqrt(5)) / 2;
  var IV = [[-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0], [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI], [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1]];
  var IF = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  Builder.prototype.blob = function (cx, cy, cz, rx, ry, rz, hex, k, seed, hexLit) {
    var c = this.col(hex, k), l = this.col(hexLit || hex, k), n = 1 / Math.sqrt(1 + PHI * PHI), pts = [], i;
    for (i = 0; i < IV.length; i++) {
      var j = 0.88 + 0.24 * hash(seed || 1, i, 9);
      pts.push([cx + IV[i][0] * n * rx * j, cy + IV[i][1] * n * ry * j, cz + IV[i][2] * n * rz * j]);
    }
    for (i = 0; i < IF.length; i++) {
      var f = IF[i], a = pts[f[0]], b = pts[f[1]], d = pts[f[2]];
      this.tri(a, b, d, ((a[1] + b[1] + d[1]) / 3 > cy + ry * 0.15) ? l : c);
    }
  };

  // vertical quad on the south side facing the camera: x0..x1 at z, y0..y1 (windows, doors, signs)
  Builder.prototype.faceS = function (x0, x1, y0, y1, z, hex, k) { this.quad([x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], this.col(hex, k)); };
  Builder.prototype.flat = function (x0, z0, x1, z1, y, hex, k) { this.quad([x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0], this.col(hex, k)); };

  Builder.prototype.empty = function () { return this.p.length === 0; };
  Builder.prototype.geometry = function () {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.computeVertexNormals();
    return g;
  };
  Builder.prototype.mesh = function (material) {
    var m = new THREE.Mesh(this.geometry(), material);
    m.frustumCulled = false;
    return m;
  };

  R3D.geo = {
    Builder: Builder,
    hash: hash,
    lit: function () { return new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }); },
    basic: function () { return new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }); }
  };
})();
