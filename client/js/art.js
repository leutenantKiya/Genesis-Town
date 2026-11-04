/* art.js - art pass 1 for Genesis Town (2026-11-01). Extends window.SPRITES; loaded after sprites.js, before engine.js.
 * All art is procedural and original. Adds:
 *   - a warm palette and 4 hashed variants for ground tiles (grass, path, sand, plaza, soil), drawn by the engine's
 *     layered cache (ground -> soft noise tint -> edges -> shadows -> props without their grass base -> buildings)
 *   - ragged grass lips where grass meets path/sand/plaza/soil, banks and foam on water edges
 *   - tall trees: a trunk tile (cached) plus a canopy drawn in the y-sorted pass (oak, pine, fruit)
 *   - new tiles: bush, barrel, crate (solid props), plaza (cobble), soil (field), stall (market counter) + awnings
 *   - animated overlays that only draw the moving pixels (water glints, flowers), so the cache stays visible
 */
(function () {
  'use strict';
  var S = window.SPRITES;
  if (!S || !S._T || !S._paint) return;
  var T = S._T, paint = S._paint, TILE = S.TILE;

  function mk(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function R(g, x, y, w, h, col) { g.fillStyle = col; g.fillRect(x, y, w, h); }
  function hash(a, b, c) { var h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 2147483647)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return (h ^ (h >>> 16)) >>> 0; }
  function rng(seed) { var s = seed >>> 0 || 1; return function () { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }

  var PAL = {
    grass: ['#3f8a2e', '#5fae36', '#7cc23e', '#a8d84a'],      // dark, base, light, highlight
    path: ['#a8642c', '#d0903c', '#e2a854', '#f0c46c'],
    sand: ['#c99a52', '#e8bf72', '#f4d696'],
    water: ['#17507e', '#2a8cc0', '#64c4e2', '#e4f6f2'],
    plaza: ['#6e6658', '#a69c88', '#c6bba4', '#ddd3bd'],
    soil: ['#4a2c18', '#6a4024', '#86562e'],
    shadow: 'rgba(46,26,72,0.30)',
    leaf: { oak: ['#1d4a2a', '#2e7a3a', '#48a046', '#86c85a'], pine: ['#123a30', '#1f5c44', '#2f7d52', '#5aa860'], fruit: ['#1d4a2a', '#2f7d3a', '#4fa646', '#8cd062'] },
    bark: ['#3e2414', '#6a3f22', '#8e5a30']
  };
  S.PAL = PAL;

  /* Snow: swap the ground palettes in place (originals kept) and drop the baked ground tiles. */
  var SNOW_PAL = {
    grass: ['#b8c6d8', '#e8eef5', '#f4f7fb', '#ffffff'],
    path: ['#8a7f78', '#c8c3c0', '#d9d6d4', '#ecebea'],
    plaza: ['#7d8290', '#b9bfcc', '#d7dce6', '#f1f4f8']
  };
  var NORMAL_PAL = { grass: PAL.grass.slice(), path: PAL.path.slice(), plaza: PAL.plaza.slice() };
  S.snow = false;
  S.setSnow = function (on) {
    on = !!on;
    if (on === S.snow) return false;
    var src = on ? SNOW_PAL : NORMAL_PAL;
    ['grass', 'path', 'plaza'].forEach(function (k) { for (var i = 0; i < src[k].length; i++) PAL[k][i] = src[k][i]; });
    // tall grass pokes through the snow as dry stalks; flowers are buried (pale frosted tips)
    var T = S._T;
    if (T && T.tallgrass) { if (!NORMAL_PAL.tall) NORMAL_PAL.tall = T.tallgrass.pal; T.tallgrass.pal = on ? { d: '#7f8f86', l: '#c9d4cf' } : NORMAL_PAL.tall; }
    if (T && T.flower) {
      if (!NORMAL_PAL.flower) NORMAL_PAL.flower = T.flower.pal;
      T.flower.pal = on ? function () { return { r: '#cfd8e2', p: '#e2e8ef', w: '#ffffff', s: '#8a9aa0', y: '#eef2f6' }; } : NORMAL_PAL.flower;
    }
    if (S._clearTiles) S._clearTiles();
    groundCache = {};
    S.snow = on;
    return true;
  };

  /* ------------------------------------------------------------------ ground variants */
  var groundCache = {};
  function buildGround(type, v) {
    var c = mk(TILE, TILE), g = c.getContext('2d'), r = rng(hash(v + 1, type.length * 31, 77));
    var p, x, y, i;
    if (type === 'grass') {
      p = PAL.grass; R(g, 0, 0, TILE, TILE, p[1]);
      for (i = 0; i < 10; i++) { R(g, Math.floor(r() * 12), Math.floor(r() * 12), 1, 1, r() < 0.5 ? p[0] : p[2]); }
      if (v === 1) { x = 2 + Math.floor(r() * 6); y = 4 + Math.floor(r() * 5); R(g, x, y, 1, 3, p[0]); R(g, x + 2, y - 1, 1, 4, p[0]); R(g, x + 1, y, 1, 3, p[2]); R(g, x + 4, y + 1, 1, 2, p[0]); }
      if (v === 2) { x = 2 + Math.floor(r() * 7); y = 3 + Math.floor(r() * 6); R(g, x, y, 2, 1, '#b8b0a0'); R(g, x + 1, y + 1, 1, 1, '#8a8478'); R(g, x + 5, y + 3, 1, 1, '#b8b0a0'); }
      if (v === 3 && S.snow) { x = 2 + Math.floor(r() * 7); y = 2 + Math.floor(r() * 7); R(g, x, y, 3, 1, '#9fb0c6'); R(g, x + 1, y + 1, 2, 1, '#b8c6d8'); R(g, x + 5, y + 4, 1, 1, '#9fb0c6'); }
      else if (v === 3) { x = 2 + Math.floor(r() * 7); y = 2 + Math.floor(r() * 7); R(g, x, y, 1, 1, r() < 0.5 ? '#f6f0e0' : '#ffd84a'); R(g, x + 4, y + 3, 1, 1, '#f6f0e0'); R(g, x + 1, y + 1, 1, 1, p[3]); }
    } else if (type === 'path') {
      p = PAL.path; R(g, 0, 0, TILE, TILE, p[1]);
      for (i = 0; i < 14; i++) R(g, Math.floor(r() * 12), Math.floor(r() * 12), 1, 1, r() < 0.55 ? p[0] : p[2]);
      if (v >= 2) { x = 1 + Math.floor(r() * 8); y = 1 + Math.floor(r() * 8); R(g, x, y, 2, 1, p[3]); R(g, x, y + 1, 2, 1, p[0]); }
    } else if (type === 'sand') {
      p = PAL.sand; R(g, 0, 0, TILE, TILE, p[1]);
      for (i = 0; i < 10; i++) R(g, Math.floor(r() * 12), Math.floor(r() * 12), 1, 1, r() < 0.5 ? p[0] : p[2]);
    } else if (type === 'plaza') {
      p = PAL.plaza; R(g, 0, 0, TILE, TILE, p[0]);
      for (y = 0; y < 4; y++) for (x = 0; x < 3; x++) {
        var ox = x * 4 + ((y % 2) ? 2 : 0) - 1, oy = y * 3;
        R(g, ox + 1, oy, 3, 2, r() < 0.3 ? p[2] : p[1]); R(g, ox + 1, oy, 3, 1, p[3]);
      }
    } else if (type === 'soil') {
      p = PAL.soil; R(g, 0, 0, TILE, TILE, p[1]);
      for (y = 1; y < TILE; y += 3) { R(g, 0, y, TILE, 1, p[0]); R(g, 0, y + 1, TILE, 1, p[2]); }
      for (i = 0; i < 6; i++) R(g, Math.floor(r() * 12), Math.floor(r() * 12), 1, 1, p[2]);
    } else if (type === 'water') {
      p = PAL.water; R(g, 0, 0, TILE, TILE, p[1]);
      for (i = 0; i < 5; i++) R(g, Math.floor(r() * 12), Math.floor(r() * 12), 2, 1, '#2580b4');
    }
    return c;
  }
  /** Ground for a tile type at a variant 0..3 (hash of position). */
  S.drawGround = function (g, type, x, y, v) {
    var key = type + ':' + (v & 3);
    var c = groundCache[key] || (groundCache[key] = buildGround(type, v & 3));
    g.drawImage(c, x, y);
  };
  S.GROUND_TYPES = { grass: 1, path: 1, sand: 1, plaza: 1, soil: 1, water: 1 };

  /** Which ground a tile sits on (props drawn over grass, counters over plaza...). */
  S.groundOf = function (t) {
    if (S.GROUND_TYPES[t]) return t;
    if (t === 'stall') return 'plaza';
    var d = T[t];
    if (d && d.under && S.GROUND_TYPES[d.under]) return d.under;
    return d && d.under ? 'grass' : null;
  };

  /* ------------------------------------------------------------------ edges */
  // nb = {n,e,s,w}: true where that neighbour is grass (for lips) / not water (for banks).
  S.drawEdges = function (g, type, x, y, nb, v) {
    var r = rng(hash(x, y, 913)), p = PAL.grass, i, k;
    if (type === 'water') {
      var w = PAL.water;
      if (nb.n) { R(g, x, y, TILE, 2, w[0]); R(g, x, y + 2, TILE, 1, '#1f6fa0'); }
      if (nb.s) for (k = 0; k < TILE; k += 2) R(g, x + k + (r() < 0.5 ? 1 : 0), y + TILE - 1, 1, 1, w[3]);
      if (nb.w) for (k = 2; k < TILE; k += 3) R(g, x, y + k, 1, 1, w[3]);
      if (nb.e) for (k = 1; k < TILE; k += 3) R(g, x + TILE - 1, y + k, 1, 1, w[3]);
      return;
    }
    // grass lips on lower ground: 1-2 px ragged tufts along each side that touches grass
    function lip(side) {
      for (i = 0; i < TILE; i++) {
        var d = r() < 0.35 ? 2 : 1;
        var c = r() < 0.25 ? p[0] : p[1];
        if (side === 'n') R(g, x + i, y, 1, d, c);
        if (side === 's') R(g, x + i, y + TILE - d, 1, d, c);
        if (side === 'w') R(g, x, y + i, d, 1, c);
        if (side === 'e') R(g, x + TILE - d, y + i, d, 1, c);
      }
      if (side === 's' || side === 'e') return;
      // a darker dirt line under the lip reads as a slight step down
      if (side === 'n') R(g, x, y + 2, TILE, 1, type === 'path' ? PAL.path[0] : 'rgba(0,0,0,0.12)');
    }
    if (nb.n) lip('n'); if (nb.s) lip('s'); if (nb.w) lip('w'); if (nb.e) lip('e');
  };

  /* ------------------------------------------------------------------ shadows */
  S.shadowEllipse = function (g, cx, cy, rx, ry) {
    g.fillStyle = PAL.shadow;
    for (var yy = -ry; yy <= ry; yy++) {
      var span = Math.round(rx * Math.sqrt(Math.max(0, 1 - (yy * yy) / (ry * ry + 0.01))));
      g.fillRect(Math.round(cx - span), Math.round(cy + yy), span * 2, 1);
    }
  };
  /** Building drop shadow: light from the top-left, so the shadow falls right and down. */
  S.buildingShadow = function (g, x, y, w, h) {
    g.fillStyle = PAL.shadow;
    g.fillRect(x + w, y + 6, 3, h - 4);
    g.fillRect(x + 3, y + h, w, 2);
  };

  /* ------------------------------------------------------------------ props without their grass base */
  S.drawOverlay = function (g, type, x, y, f) {
    var d = T[type];
    if (!d || !d.rows || S.GROUND_TYPES[type]) return;
    var pal = typeof d.pal === 'function' ? d.pal(Math.floor(f || 0) % (d.frames || 1)) : d.pal;
    paint(g, d.rows, pal, TILE, TILE, x, y, type);
  };

  /* ------------------------------------------------------------------ animated overlays */
  S.drawWaterAnim = function (g, x, y, f, tx, ty) {
    var rowsY = [2, 6, 9];
    for (var i = 0; i < rowsY.length; i++) {
      var sx = (i * 5 + f * 3 + tx * 7) % 12;
      for (var k = 0; k < 3; k++) R(g, x + (sx + k) % 12, y + rowsY[i], 1, 1, PAL.water[2]);
    }
    if (((tx * 31 + ty * 17 + f) % 23) === 0) R(g, x + 5, y + 4, 1, 1, '#ffffff');
  };

  /* ------------------------------------------------------------------ trees */
  var canopyCache = {};
  function buildCanopy(kind) {
    var W = 22, H = 24, c = mk(W, H), g = c.getContext('2d');
    var pal = PAL.leaf[kind] || PAL.leaf.oak, r = rng(hash(kind.length, 5, 9));
    var x, y;
    if (kind === 'pine') {
      for (y = 0; y < H - 2; y++) {
        var tier = y % 7, half = Math.min(10, 2 + Math.floor(y / 7) * 2 + tier);
        for (x = 11 - half; x <= 10 + half; x++) {
          var edge = x === 11 - half || x === 10 + half || tier === 6;
          var lit = x < 11 - half / 3;
          R(g, x, y, 1, 1, edge ? pal[0] : lit ? pal[2] : pal[1]);
        }
      }
      R(g, 10, 1, 1, 2, pal[3]);
      return c;
    }
    var cx = 11, cy = 11, rx = 10.5, ry = 10.5;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      var dx = (x - cx) / rx, dy = (y - cy) / ry, d = dx * dx + dy * dy;
      // lumpy outline: a few bumps make it read as foliage, not a circle
      var bump = 0.08 * Math.sin(Math.atan2(dy, dx) * 5);
      if (d > 1 + bump) continue;
      var col;
      if (d > 0.86 + bump) col = pal[0];
      else if (dx + dy < -0.55) col = pal[3];
      else if (dx + dy < 0.1) col = pal[2];
      else col = pal[1];
      if (col !== pal[0] && r() < 0.12) col = r() < 0.5 ? pal[1] : pal[2];
      R(g, x, y, 1, 1, col);
    }
    if (kind === 'fruit') {
      var spots = [[6, 7], [13, 5], [9, 13], [15, 11], [5, 12], [12, 16]];
      spots.forEach(function (s, i) { R(g, s[0], s[1], 2, 2, i % 2 ? '#e8503c' : '#f29a3a'); R(g, s[0], s[1], 1, 1, '#ffd0a0'); });
    }
    return c;
  }
  S.treeKind = function (tx, ty, border) {
    var h = hash(tx, ty, 4242) % 10;
    if (border) return h < 7 ? 'pine' : 'oak';
    return h < 5 ? 'oak' : h < 8 ? 'pine' : 'fruit';
  };
  /** Trunk and ground shadow (static, in the cache). x,y = tile top-left. */
  S.drawTrunk = function (g, x, y) {
    S.shadowEllipse(g, x + 7, y + 10, 7, 2);
    R(g, x + 4, y + 3, 4, 8, PAL.bark[1]); R(g, x + 4, y + 3, 1, 8, PAL.bark[2]); R(g, x + 7, y + 3, 1, 8, PAL.bark[0]);
    R(g, x + 3, y + 10, 6, 1, PAL.bark[0]);
  };
  /** Canopy (y-sorted pass): drawn above the trunk, overhanging the tile above. x,y = tile top-left. */
  S.drawCanopy = function (g, kind, x, y) {
    var c = canopyCache[kind] || (canopyCache[kind] = buildCanopy(kind));
    g.drawImage(c, x - 5, y - 15);
  };

  /* ------------------------------------------------------------------ new tiles */
  T.bush = { under: 'grass', pal: { k: '#1d4a2a', d: '#2e7a3a', m: '#48a046', l: '#86c85a', b: '#d84a5a' }, rows: [
    '............',
    '............',
    '....kkkk....',
    '..kkllmmkk..',
    '.kllmmmmmdk.',
    '.klmmbmmmdk.',
    'kmmmmmmmddk.',
    'kmmbmmmdddkk',
    'kdmmmmddddk.',
    '.kddddddkk..',
    '..kkkkkk....',
    '............'] };
  T.barrel = { under: 'grass', pal: { k: '#2a1a12', b: '#8e5a30', B: '#6a3f22', l: '#b07840', r: '#5a5a6e' }, rows: [
    '............',
    '....kkkk....',
    '...kllbbk...',
    '..krrrrrrk..',
    '..klbbbbBk..',
    '..klbbbbBk..',
    '..krrrrrrk..',
    '..klbbbbBk..',
    '..klbbbbBk..',
    '..krrrrrrk..',
    '...kkkkkk...',
    '............'] };
  T.crate = { under: 'grass', pal: { k: '#2a1a12', w: '#c08848', W: '#8e5a2c', l: '#dcaa64' }, rows: [
    '............',
    '............',
    '.kkkkkkkkkk.',
    '.kllllllllk.',
    '.kwWwwwwWwk.',
    '.kwwWwwWwwk.',
    '.kwwwWWwwwk.',
    '.kwwWwwWwwk.',
    '.kwWwwwwWwk.',
    '.kWWWWWWWWk.',
    '.kkkkkkkkkk.',
    '............'] };
  // stall counter (solid); the awning is drawn above it in the y-sorted pass (drawAwning)
  T.stall = { under: 'plaza', pal: { k: '#2a1a12', w: '#c08848', W: '#8e5a2c', l: '#e2b06a', a: '#e8503c', y: '#ffd84a', g: '#86c85a', f: '#6cc8e4' }, rows: [
    '............',
    '............',
    '............',
    'kkkkkkkkkkkk',
    'kayygyfaygak',
    'kllllllllllk',
    'kwwwwwwwwwwk',
    'kwWwwwwwwWwk',
    'kwWwwwwwwWwk',
    'kwwwwwwwwwwk',
    'kWWWWWWWWWWk',
    '.k........k.'] };
  T.plaza = { pal: { p: PAL.plaza[1] }, rows: ['pppppppppppp', 'pppppppppppp', 'pppppppppppp', 'pppppppppppp', 'pppppppppppp', 'pppppppppppp', 'pppppppppppp', 'pppppppppppp', 'pppppppppppp', 'pppppppppppp', 'pppppppppppp', 'pppppppppppp'] };
  T.soil = { pal: { p: PAL.soil[1] }, rows: ['pppppppppppp', 'pppppppppppp', 'pppppppppppp', 'pppppppppppp', 'pppppppppppp', 'pppppppppppp', 'pppppppppppp', 'pppppppppppp', 'pppppppppppp', 'pppppppppppp', 'pppppppppppp', 'pppppppppppp'] };
  S._tileTypes.push('bush', 'barrel', 'crate', 'stall', 'plaza', 'soil');

  /** Striped awning over a stall: covers the top of the merchant standing behind. x,y = stall tile top-left. */
  S.drawAwning = function (g, x, y, color) {
    var c2 = '#f6f0e0';
    R(g, x - 1, y - 10, TILE + 2, 7, '#2a1a12');
    for (var i = 0; i < TILE; i++) R(g, x + i, y - 9, 1, 5, Math.floor(i / 3) % 2 ? c2 : color);
    for (i = 0; i < TILE; i += 3) R(g, x + i, y - 4, 2, 1, Math.floor(i / 3) % 2 ? c2 : color);
    R(g, x, y - 3, 1, 6, '#6a3f22'); R(g, x + TILE - 1, y - 3, 1, 6, '#6a3f22');
  };

  /** Character ground shadow. x,y = where the engine draws the character (tile top-left). */
  S.charShadow = function (g, x, y) { S.shadowEllipse(g, x + 6, y + 12, 5, 1); };
})();
