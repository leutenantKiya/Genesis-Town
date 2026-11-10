/*
 * r3d/interior.js - the rooms inside buildings as 3D: houses, Balai Desa, church, clinic, post office, broker, warung, mart and
 * casino. A room is the interior map (10 x 8 .. 12 x 9 tiles) turned into a floor, walls and furniture: the back and side walls
 * stand full height, the front wall is cut down to a low sill so the camera can look in, and the door is a gap in it.
 * Furniture comes from the tile types the generators place (bed, bookshelf, tv, fridge, plant, table, chair, chest, counter,
 * shelf, slot, dice_table, card_table); rugs, carpets and the door mat are part of the floor. Characters are the same
 * rigs as outdoors (actors.js). While a room is shown the outdoor world is hidden (core.js).
 */
(function () {
  'use strict';
  var R3D = window.R3D = window.R3D || {};
  var THREE = window.THREE;
  if (!THREE || !R3D.geo) return;
  var Builder = R3D.geo.Builder, hash = R3D.geo.hash;

  var group = null, litMat = null, glowMat = null, curMap = null;
  var WALLS = {
    house:   ['#ebe0c8', '#b28a5c'], mart: ['#e8eef6', '#8aa0c8'], casino: ['#4a3a62', '#2a2038'], hall: ['#f0e6d0', '#a8442e'],
    church:  ['#ece6da', '#6a7898'], clinic: ['#f4f6f6', '#58a8a4'], post: ['#f4e6c8', '#d0702c'], broker: ['#efe4cc', '#4c8a58'], warung: ['#d6aa72', '#8a5a30']
  };

  function floorBase(m) {
    var c = { floor_wood: 0, floor_tile: 0, floor_dark: 0 };
    for (var i = 0; i < m.tiles.length; i++) if (c[m.tiles[i]] != null) c[m.tiles[i]]++;
    var best = 'floor_wood', n = -1; Object.keys(c).forEach(function (k) { if (c[k] > n) { n = c[k]; best = k; } });
    return best;
  }
  function T(m, x, y) { return x >= 0 && y >= 0 && x < m.w && y < m.h ? m.tiles[y * m.w + x] : 'wall'; }

  function floorTile(B, type, x, y) {
    var h = hash(x, y, 3);
    if (type === 'floor_wood') {
      var cols = ['#c48a50', '#b9804a', '#cc9258'];
      for (var s = 0; s < 3; s++) B.flat(x + s / 3, y, x + (s + 1) / 3 - 0.012, y + 1, 0, cols[(s + x + y + Math.floor(h * 3)) % 3], 1);
    } else if (type === 'floor_tile') B.flat(x, y, x + 1, y + 1, 0, (x + y) % 2 ? '#c6ccda' : '#dde1ea', 1);
    else if (type === 'floor_dark') B.flat(x, y, x + 1, y + 1, 0, (x + y) % 2 ? '#2f2b44' : '#3a3550', 1);
    else if (type === 'carpet_red') { B.flat(x, y, x + 1, y + 1, 0.005, '#8d2a3b', 1); B.flat(x + 0.08, y + 0.08, x + 0.92, y + 0.92, 0.012, '#a83a4c', 1); }
    else if (type === 'rug') { B.flat(x, y, x + 1, y + 1, 0.006, '#7a4a6a', 1); B.flat(x + 0.1, y + 0.1, x + 0.9, y + 0.9, 0.013, '#9a6a8a', 1); }
    else if (type === 'doormat') { B.flat(x, y, x + 1, y + 1, 0.004, '#7a5a38', 1); for (var k = 0; k < 4; k++) B.flat(x + 0.1, y + 0.12 + k * 0.2, x + 0.9, y + 0.2 + k * 0.2, 0.012, '#5a3a22', 1); }
    else B.flat(x, y, x + 1, y + 1, 0, '#c48a50', 1);
  }

  function furniture(B, G, m, t, x, y, kind) {
    var cx = x + 0.5, cz = y + 0.5, h = hash(x, y, 7), i;
    if (t === 'bed') {
      B.box(x + 0.08, 0, y + 0.04, x + 0.92, 0.28, y + 0.96, '#8a5a30', '#b07840');
      B.box(x + 0.12, 0.28, y + 0.08, x + 0.88, 0.42, y + 0.92, '#f4f1ea', '#ffffff');
      B.box(x + 0.16, 0.42, y + 0.1, x + 0.84, 0.5, y + 0.34, '#ffffff', '#ffffff');
      B.box(x + 0.12, 0.34, y + 0.45, x + 0.88, 0.46, y + 0.94, '#7aa0d8', '#9ac0f0');
      B.box(x + 0.08, 0.28, y + 0.0, x + 0.92, 0.85, y + 0.08, '#8a5a30', '#b07840');
    } else if (t === 'bookshelf') {
      B.box(x + 0.06, 0, y + 0.1, x + 0.94, 1.7, y + 0.95, '#6a4020', '#8a5a30');
      for (var r = 0; r < 4; r++) {
        B.box(x + 0.1, 0.12 + r * 0.4, y + 0.16, x + 0.9, 0.16 + r * 0.4, y + 0.95, '#8a5a30', '#8a5a30');
        var bx = x + 0.12;
        while (bx < x + 0.84) { var bw = 0.07 + hash(x + r, y, Math.floor(bx * 9)) * 0.06, bh = 0.2 + hash(r, y, Math.floor(bx * 13)) * 0.12; B.box(bx, 0.16 + r * 0.4, y + 0.6, bx + bw, 0.16 + r * 0.4 + bh, y + 0.93, ['#c8503c', '#3d7fc2', '#4a8a48', '#e8c048', '#8a5ab0', '#e0e0d0'][Math.floor(hash(bx * 31, y, r) * 6)], null); bx += bw + 0.012; }
      }
    } else if (t === 'tv') {
      B.box(x + 0.1, 0, y + 0.2, x + 0.9, 0.45, y + 0.85, '#6a4a30', '#8a6a48');
      B.box(x + 0.12, 0.45, y + 0.38, x + 0.88, 1.0, y + 0.66, '#1c1c28', '#2a2a3a');
      G.faceS(x + 0.17, x + 0.83, 0.5, 0.95, y + 0.665, '#ffffff', 1);
    } else if (t === 'fridge') {
      B.box(x + 0.12, 0, y + 0.15, x + 0.88, 1.5, y + 0.9, '#f2f4f8', '#ffffff'); B.box(x + 0.12, 0.88, y + 0.9, x + 0.88, 0.92, y + 0.93, '#c0c4cc', null);
      B.box(x + 0.74, 1.05, y + 0.9, x + 0.78, 1.35, y + 0.95, '#8a90a0', null); B.box(x + 0.74, 0.3, y + 0.9, x + 0.78, 0.7, y + 0.95, '#8a90a0', null);
    } else if (t === 'plant') {
      B.cyl(cx, 0, cz, 0.2, 0.3, 8, '#b8643c', 1, '#8a4a2c');
      B.blob(cx, 0.62, cz, 0.3, 0.3, 0.3, '#3f8a3a', 1, x * 7 + y, '#5cb85a'); B.blob(cx - 0.16, 0.5, cz + 0.05, 0.18, 0.2, 0.18, '#4aa046', 1, x + y * 3, '#66c060'); B.blob(cx + 0.16, 0.74, cz - 0.04, 0.17, 0.2, 0.17, '#4aa046', 1, x * 3 + y, '#66c060');
    } else if (t === 'table') {
      B.box(x + 0.04, 0.5, y + 0.06, x + 0.96, 0.58, y + 0.94, '#9a6a3a', '#c28e52');
      [[0.1, 0.12], [0.84, 0.12], [0.1, 0.82], [0.84, 0.82]].forEach(function (p) { B.box(x + p[0], 0, y + p[1], x + p[0] + 0.06, 0.5, y + p[1] + 0.06, '#6a4020', null); });
      if (h < 0.5) B.cyl(cx + 0.12, 0.58, cz, 0.11, 0.05, 8, '#f4f1ea', 1, '#ffffff');
    } else if (t === 'chair') {
      var north = T(m, x, y - 1) === 'table', back = north ? y + 0.78 : y + 0.1; // the back is on the side away from the table
      B.box(x + 0.18, 0.28, y + 0.18, x + 0.82, 0.38, y + 0.82, '#b8844a', '#d4a064');
      [[0.2, 0.2], [0.72, 0.2], [0.2, 0.72], [0.72, 0.72]].forEach(function (p) { B.box(x + p[0], 0, y + p[1], x + p[0] + 0.07, 0.28, y + p[1] + 0.07, '#6a4020', null); });
      B.box(x + 0.18, 0.38, back, x + 0.82, 0.85, back + 0.1, '#a07040', '#c08850');
    } else if (t === 'chest') {
      B.box(x + 0.1, 0, y + 0.2, x + 0.9, 0.42, y + 0.85, '#8a5a30', '#b07840'); B.box(x + 0.08, 0.42, y + 0.18, x + 0.92, 0.55, y + 0.87, '#a06a38', '#c88a48');
      B.box(x + 0.44, 0.34, y + 0.85, x + 0.56, 0.5, y + 0.9, '#f0d048', '#fce47c'); B.box(x + 0.08, 0.1, y + 0.18, x + 0.14, 0.5, y + 0.88, '#5a5a6e', null); B.box(x + 0.86, 0.1, y + 0.18, x + 0.92, 0.5, y + 0.88, '#5a5a6e', null);
    } else if (t === 'counter') {
      B.box(x + 0.0, 0, y + 0.1, x + 1, 0.82, y + 0.92, '#8a5a30', '#d8b078');
      B.box(x + 0.0, 0.82, y + 0.1, x + 1, 0.88, y + 0.92, '#d8b078', '#e8c890');
      if (kind === 'mart' && (x === 4)) { B.box(x + 0.5, 0.88, y + 0.35, x + 0.95, 1.1, y + 0.7, '#3a3a48', '#5a5a6a'); G.faceS(x + 0.6, x + 0.85, 0.93, 1.05, y + 0.705, '#ffffff', 1); }
    } else if (t === 'shelf') {
      B.box(x + 0.05, 0, y + 0.12, x + 0.95, 1.5, y + 0.9, '#8a8e9c', '#a0a4b4');
      for (var s = 0; s < 4; s++) {
        B.box(x + 0.08, 0.1 + s * 0.36, y + 0.16, x + 0.92, 0.14 + s * 0.36, y + 0.9, '#6a6e7c', null);
        for (i = 0; i < 4; i++) B.box(x + 0.12 + i * 0.2, 0.14 + s * 0.36, y + 0.55, x + 0.26 + i * 0.2, 0.14 + s * 0.36 + 0.14 + hash(x + i, y + s, 5) * 0.1, y + 0.88, ['#e8503c', '#f2c94c', '#4a8ad8', '#58b058', '#e8e0d0', '#f088b8'][Math.floor(hash(i + x * 3, s, y) * 6)], null);
      }
    } else if (t === 'slot') {
      B.box(x + 0.12, 0, y + 0.2, x + 0.88, 1.5, y + 0.92, '#5a2a82', '#7a4aa2'); B.box(x + 0.16, 0.9, y + 0.88, x + 0.84, 1.3, y + 0.95, '#14101c', null);
      G.faceS(x + 0.22, x + 0.78, 0.95, 1.25, y + 0.955, '#ffffff', 1); B.box(x + 0.88, 0.7, y + 0.5, x + 0.96, 1.2, y + 0.58, '#c8ccd8', null); B.cyl(x + 0.92, 1.2, y + 0.54, 0.07, 0.1, 6, '#e8302a', 1);
    } else if (t === 'dice_table' || t === 'card_table') {
      B.box(x + 0.02, 0.5, y + 0.06, x + 0.98, 0.6, y + 0.94, '#6a4020', '#8a5a30');
      B.box(x + 0.08, 0.6, y + 0.12, x + 0.92, 0.64, y + 0.88, '#2d7a3e', '#3a9a50');
      [[0.12, 0.12], [0.84, 0.12], [0.12, 0.82], [0.84, 0.82]].forEach(function (p) { B.box(x + p[0], 0, y + p[1], x + p[0] + 0.06, 0.5, y + p[1] + 0.06, '#4a2a18', null); });
      if (t === 'dice_table') { B.box(x + 0.3, 0.64, y + 0.4, x + 0.4, 0.74, y + 0.5, '#fafafe', null); B.box(x + 0.55, 0.64, y + 0.5, x + 0.65, 0.74, y + 0.6, '#fafafe', null); }
      else { B.box(x + 0.3, 0.64, y + 0.35, x + 0.5, 0.645, y + 0.6, '#fafafe', null); B.box(x + 0.5, 0.64, y + 0.4, x + 0.7, 0.645, y + 0.65, '#d83838', null); }
    } else if (t !== 'wall' && t !== 'doormat' && t !== 'rug' && t !== 'carpet_red' && t.indexOf('floor') !== 0) {
      B.box(x + 0.25, 0, y + 0.25, x + 0.75, 0.5, y + 0.75, '#c06060', '#e08080'); // unknown prop: a plain crate
    }
  }

  function build(m, kind) {
    var B = new Builder(), G = new Builder(), w = m.w, h = m.h, base = floorBase(m), pal = WALLS[kind] || WALLS.house, x, y;
    var windowsOn = kind === 'house' || kind === 'hall' || kind === 'church' || kind === 'clinic' || kind === 'post' || kind === 'broker' || kind === 'warung';
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      var t = m.tiles[y * w + x];
      if (t === 'wall') {
        var tall = (y === 0 || x === 0 || x === w - 1), H = tall ? 1.9 : 0.3;
        B.box(x, 0, y, x + 1, Math.min(H, 0.7), y + 1, pal[1], pal[1]);
        if (H > 0.7) B.box(x, 0.7, y, x + 1, H, y + 1, pal[0], '#cdbf9e'); else B.box(x, 0.0, y, x + 1, H, y + 1, pal[1], '#d8c8a8');
        if (y === 0 && windowsOn && x > 1 && x < w - 2 && x % 3 === 1) { // a window on the back wall
          B.box(x + 0.12, 0.95, y + 1.0, x + 0.88, 1.65, y + 1.04, '#4a3020', null); G.faceS(x + 0.18, x + 0.82, 1.0, 1.6, y + 1.045, '#ffffff', 1);
          B.box(x + 0.48, 1.0, y + 1.045, x + 0.52, 1.6, y + 1.06, '#4a3020', null); B.box(x + 0.18, 1.28, y + 1.045, x + 0.82, 1.32, y + 1.06, '#4a3020', null);
        }
        continue;
      }
      floorTile(B, (t === 'rug' || t === 'carpet_red' || t === 'doormat') ? t : base, x, y);
      if (t !== 'rug' && t !== 'carpet_red' && t !== 'doormat' && t.indexOf('floor') !== 0) furniture(B, G, m, t, x, y, kind);
    }
    var g = new THREE.Group();
    g.add(B.mesh(litMat, true));
    if (!G.empty()) g.add(G.mesh(glowMat));
    return g;
  }

  R3D.interior = {
    init: function (C) { litMat = R3D.geo.lit(); glowMat = R3D.geo.basic(); group = null; curMap = null; },
    show: function (C, m, kind) {
      this.hide(C);
      curMap = m; group = build(m, kind || 'house'); C.scene.add(group);
    },
    hide: function (C) {
      if (group) { C.scene.remove(group); group.traverse(function (o) { if (o.geometry) o.geometry.dispose(); }); }
      group = null; curMap = null;
    },
    update: function (C, info) {
      // window glass and screens: a warm daylight glow, whatever the hour outside
      glowMat.color.setRGB(0.85, 0.95, 1.0);
    },
    onWorld: function () {},
    dispose: function (C) { this.hide(C); if (litMat) litMat.dispose(); if (glowMat) glowMat.dispose(); litMat = glowMat = null; }
  };
})();
