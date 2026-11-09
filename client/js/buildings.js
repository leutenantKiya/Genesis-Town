/*
 * buildings.js - pixel art for the village's public buildings and the river bridge (all original, drawn in code).
 * Extends window.SPRITES (after sprites.js and art.js):
 *   SPRITES.drawPublic(g, kind, x, y, wTiles, hTiles)   kinds: hall, church, clinic, post, broker, warung, and the Homeland
 *   buildings townhall (Balai Kota, 4x4), kolam (Kolam Ikan), tambang, restoran (3x3)
 *   'bridge' ground tile (planks over water), used by the layered world cache.
 * Each building: a roof band, a wall with windows, a sign with a small icon over the door, the door at the bottom of
 * the middle column (where village.js puts it). Light comes from the top-left like the houses.
 */
(function () {
  'use strict';
  var S = window.SPRITES;
  if (!S) return;
  var TILE = S.TILE || 12, OL = '#2a2430';
  function mk(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function R(g, x, y, w, h, col) { g.fillStyle = col; g.fillRect(x, y, w, h); }

  var STYLE = {
    hall:   { roof: '#a8442e', roofD: '#6e2a20', roofL: '#d8704a', wall: '#f2e2c4', wallD: '#d8bc94', sign: '#f6ead0' },
    church: { roof: '#4a5878', roofD: '#2c3650', roofL: '#7488b0', wall: '#ece6da', wallD: '#cfc6b4', sign: '#ffffff' },
    clinic: { roof: '#2e8a86', roofD: '#1c5c5a', roofL: '#5cb8b0', wall: '#f6f6f2', wallD: '#d8dcd8', sign: '#ffffff' },
    post:   { roof: '#d0702c', roofD: '#8e4a1c', roofL: '#f0a050', wall: '#f4e6c8', wallD: '#d8c49c', sign: '#fff4dc' },
    broker: { roof: '#3c7a48', roofD: '#24502e', roofL: '#68a870', wall: '#efe4cc', wallD: '#d0c0a0', sign: '#fff8e4' },
    warung: { roof: '#8a5a30', roofD: '#5a3a1e', roofL: '#b07a44', wall: '#c89a62', wallD: '#a87a48', sign: '#fff0d8' },
    townhall: { roof: '#2f5fa8', roofD: '#1c3c70', roofL: '#5c8ed8', wall: '#f2e8cc', wallD: '#d8c89c', sign: '#fff6d8' },
    kolam:    { roof: '#2a7ab0', roofD: '#1a4e78', roofL: '#5cb0e0', wall: '#e4f0ec', wallD: '#bcd4cc', sign: '#f2fbff' },
    tambang:  { roof: '#5c5868', roofD: '#3a3644', roofL: '#8a8698', wall: '#a8a2a0', wallD: '#847e80', sign: '#ece8e0' },
    restoran: { roof: '#b8422e', roofD: '#7a2a1e', roofL: '#e0705a', wall: '#f6e4c8', wallD: '#dcc09a', sign: '#fff4dc' },
    rumah:      { roof: '#8a4a2c', roofD: '#5a2e1a', roofL: '#b87048', wall: '#e8d4a8', wallD: '#c8b080', sign: '#fff2d4' },
    rumahsakit: { roof: '#c84a4a', roofD: '#8a2c2c', roofL: '#e88080', wall: '#f8f6f2', wallD: '#dcd8d4', sign: '#ffffff' }
  };

  function roof(g, w, top, rows, st) {
    // a pitched roof seen from the front: rows step in by one pixel every two rows, shingle lines every 3 rows
    R(g, 2, top, w - 4, 1, OL);
    for (var y = 1; y <= rows; y++) {
      var n = Math.max(0, 3 - Math.floor(y / 2));
      R(g, n, top + y, w - 2 * n, 1, y === 1 ? st.roofL : (y % 3 === 0 ? st.roofD : st.roof));
      R(g, n, top + y, 1, 1, OL); R(g, w - 1 - n, top + y, 1, 1, OL);
      if (y > 1 && y % 3 !== 0) for (var x = n + 2 + (y % 2 ? 2 : 0); x < w - n - 2; x += 5) R(g, x, top + y, 2, 1, st.roofL);
    }
    R(g, 0, top + rows + 1, w, 1, OL);
  }
  function wall(g, w, top, bottom, st) {
    R(g, 1, top, w - 2, bottom - top, OL);
    R(g, 2, top, w - 4, bottom - top - 1, st.wall);
    for (var y = top + 4; y < bottom - 3; y += 4) R(g, 2, y, w - 4, 1, st.wallD);
    R(g, 2, bottom - 3, w - 4, 2, '#a8a098'); R(g, 2, bottom - 3, w - 4, 1, '#c4bcb4');
  }
  function windowAt(g, x, y, glass) {
    R(g, x, y, 8, 7, OL); R(g, x + 1, y + 1, 6, 5, glass || '#a8d8f0');
    R(g, x + 1, y + 1, 2, 1, '#e8f8ff'); R(g, x + 4, y + 1, 1, 5, OL); R(g, x + 1, y + 3, 6, 1, OL);
  }
  function door(g, cx, bottom, col) {
    R(g, cx - 5, bottom - 14, 10, 14, OL); R(g, cx - 4, bottom - 13, 8, 13, col || '#8a5a30');
    R(g, cx - 4, bottom - 13, 8, 1, '#b07840'); R(g, cx - 1, bottom - 12, 1, 12, '#6a4020'); R(g, cx + 2, bottom - 7, 1, 1, '#f0d048');
    R(g, cx - 6, bottom - 1, 12, 1, '#807880');
  }
  function sign(g, cx, y, st, icon) {
    R(g, cx - 8, y, 16, 8, OL); R(g, cx - 7, y + 1, 14, 6, st.sign);
    icon(g, cx, y + 1);
  }
  var ICON = {
    hall: function (g, cx, y) { R(g, cx - 3, y + 1, 1, 5, '#6a4020'); R(g, cx - 2, y + 1, 5, 2, '#d83c3c'); R(g, cx - 2, y + 3, 5, 2, '#f8f8f8'); },
    church: function (g, cx, y) { R(g, cx - 1, y, 2, 6, '#c8a030'); R(g, cx - 3, y + 2, 6, 2, '#c8a030'); },
    clinic: function (g, cx, y) { R(g, cx - 1, y, 2, 6, '#d83c3c'); R(g, cx - 3, y + 2, 6, 2, '#d83c3c'); },
    post: function (g, cx, y) { R(g, cx - 4, y + 1, 8, 5, '#f0c050'); R(g, cx - 4, y + 1, 8, 1, '#8e4a1c'); R(g, cx - 3, y + 2, 2, 1, '#8e4a1c'); R(g, cx + 1, y + 2, 2, 1, '#8e4a1c'); R(g, cx - 1, y + 3, 2, 1, '#8e4a1c'); },
    broker: function (g, cx, y) { R(g, cx - 2, y, 5, 6, '#e8b830'); R(g, cx - 3, y + 1, 7, 4, '#e8b830'); R(g, cx - 1, y + 1, 3, 4, '#f8e078'); R(g, cx, y + 2, 1, 2, '#a07018'); },
    townhall: function (g, cx, y) { R(g, cx - 5, y + 1, 10, 5, '#f8f4e4'); R(g, cx - 5, y + 1, 10, 1, '#c8a030'); R(g, cx - 1, y + 2, 2, 4, '#2f5fa8'); R(g, cx - 3, y + 2, 1, 4, '#c8a030'); R(g, cx + 2, y + 2, 1, 4, '#c8a030'); },
    kolam: function (g, cx, y) { R(g, cx - 4, y + 2, 7, 3, '#3d7fc2'); R(g, cx + 3, y + 1, 2, 5, '#3d7fc2'); R(g, cx - 3, y + 3, 1, 1, '#ffffff'); R(g, cx - 1, y + 2, 1, 1, '#9ad8ff'); },
    tambang: function (g, cx, y) { R(g, cx - 4, y + 1, 8, 1, '#6a6678'); R(g, cx - 4, y + 1, 2, 2, '#6a6678'); R(g, cx + 2, y + 1, 2, 2, '#6a6678'); R(g, cx - 1, y + 2, 2, 4, '#8a5a30'); },
    rumah: function (g, cx, y) { R(g, cx - 4, y + 3, 8, 3, '#f8f0d8'); R(g, cx - 5, y + 2, 10, 1, '#8a4a2c'); R(g, cx - 3, y + 1, 6, 1, '#8a4a2c'); R(g, cx - 1, y + 4, 2, 2, '#6a4020'); R(g, cx + 2, y + 4, 1, 1, '#7cc8f0'); },
    rumahsakit: function (g, cx, y) { R(g, cx - 1, y, 2, 6, '#d83c3c'); R(g, cx - 3, y + 2, 6, 2, '#d83c3c'); },
    restoran: function (g, cx, y) { R(g, cx - 4, y + 3, 8, 2, '#f8f8f8'); R(g, cx - 3, y + 2, 6, 1, '#d0d0d0'); R(g, cx + 3, y + 1, 1, 5, '#c8c8c8'); R(g, cx - 4, y + 1, 1, 3, '#c8c8c8'); },
    warung: function (g, cx, y) { R(g, cx - 3, y + 2, 5, 4, '#f8f8f8'); R(g, cx - 3, y + 2, 5, 1, '#6a4020'); R(g, cx + 2, y + 3, 2, 2, '#f8f8f8'); R(g, cx - 2, y + 1, 1, 1, '#c8c8c8'); R(g, cx, y, 1, 1, '#c8c8c8'); }
  };

  function build(kind, wt, ht) {
    var st = STYLE[kind], w = wt * TILE, h = ht * TILE, cv = mk(w, h), g = cv.getContext('2d');
    var cx = Math.floor(wt / 2) * TILE + TILE / 2; // middle of the door column
    var roofRows = Math.round(h * 0.38), wallTop = roofRows + 2;
    if (kind === 'church') {
      // bell tower over the door column, rising from the roof
      roof(g, w, 10, roofRows - 8, st);
      wall(g, w, roofRows + 4 - 2, h, st);
      R(g, cx - 7, 4, 14, roofRows + 2, OL); R(g, cx - 6, 5, 12, roofRows, st.wall);
      R(g, cx - 8, 2, 16, 3, st.roofD); R(g, cx - 6, 0, 12, 2, st.roof); R(g, cx - 8, 4, 16, 1, OL);
      R(g, cx - 1, 0, 2, 1, '#c8a030');
      R(g, cx - 3, 8, 6, 7, OL); R(g, cx - 2, 9, 4, 6, '#3a3048'); R(g, cx - 1, 10, 2, 3, '#c8a030'); // bell
      // tall coloured windows
      [[TILE * 0 + 6], [w - 14]].forEach(function (p) {
        var x = p[0], y = wallTop + 6;
        R(g, x, y, 8, 14, OL); R(g, x + 1, y + 1, 6, 12, '#7aa0d8'); R(g, x + 1, y + 1, 6, 4, '#e8a840'); R(g, x + 1, y + 6, 3, 3, '#d86060'); R(g, x + 3, y + 1, 1, 12, OL);
      });
      sign(g, cx, h - 26, st, ICON.church);
      door(g, cx, h - 1, '#6a4020');
      return cv;
    }
    roof(g, w, 0, roofRows, st);
    wall(g, w, wallTop, h, st);
    if (kind === 'warung' || kind === 'restoran') {
      // striped awning across the front and an open counter
      R(g, 1, wallTop + 2, w - 2, 5, OL);
      for (var x = 2; x < w - 2; x++) R(g, x, wallTop + 3, 1, 3, Math.floor((x - 2) / 3) % 2 ? '#f8f8f8' : '#d83c3c');
      R(g, 4, wallTop + 11, 10, 6, OL); R(g, 5, wallTop + 12, 8, 4, '#3a2a1e'); R(g, 6, wallTop + 13, 2, 2, '#f0d048');
    } else if (kind === 'tambang') {
      // stone blocks and a dark mine mouth beside the door with a cart rail
      for (var by = wallTop + 3; by < h - 4; by += 5) for (var bx = 2 + ((by / 5) % 2 ? 3 : 0); bx < w - 6; bx += 7) R(g, bx, by, 6, 1, st.wallD);
      R(g, 4, wallTop + 7, 9, 12, OL); R(g, 5, wallTop + 8, 7, 11, '#14101c'); R(g, 4, wallTop + 6, 9, 1, '#6a4020'); R(g, 3, wallTop + 7, 1, 12, '#6a4020'); R(g, 13, wallTop + 7, 1, 12, '#6a4020');
      R(g, w - 12, wallTop + 14, 8, 4, OL); R(g, w - 11, wallTop + 11, 6, 4, '#b07840'); R(g, w - 11, wallTop + 11, 6, 1, '#d49c5c'); R(g, w - 11, wallTop + 17, 2, 2, '#d0d0d0'); R(g, w - 7, wallTop + 17, 2, 2, '#d0d0d0');
    } else {
      var glass = kind === 'clinic' ? '#c8f0ec' : kind === 'rumahsakit' ? '#c8e8f8' : kind === 'kolam' || kind === 'rumah' ? '#7cc8f0' : null;
      windowAt(g, 5, wallTop + 6, glass);
      windowAt(g, w - 13, wallTop + 6, glass);
      if (wt >= 5) { windowAt(g, cx - 18, wallTop + 6); windowAt(g, cx + 10, wallTop + 6); }
    }
    if (kind === 'hall' || kind === 'townhall') {
      // two columns beside the door and a flag pole on the roof
      R(g, cx - 9, h - 16, 3, 13, '#fafaf0'); R(g, cx + 6, h - 16, 3, 13, '#fafaf0');
      R(g, w - 8, 0, 1, roofRows - 2, '#6a6a6a'); R(g, w - 7, 1, 5, 2, '#d83c3c'); R(g, w - 7, 3, 5, 2, '#f8f8f8');
    }
    if (kind === 'kolam') { R(g, 2, h - 6, w - 4, 2, '#3d7fc2'); R(g, 2, h - 6, w - 4, 1, '#9ad8ff'); }
    sign(g, cx, h - 24, st, ICON[kind]);
    door(g, cx, h - 1, kind === 'clinic' || kind === 'rumahsakit' ? '#5cb8b0' : kind === 'rumah' ? '#6a4020' : kind === 'post' ? '#c86028' : null);
    return cv;
  }

  var cache = {};
  S.drawPublic = function (g, kind, x, y, wt, ht) {
    if (!STYLE[kind]) return S.drawHouse(g, x, y, 0, false);
    var key = kind + ':' + wt + 'x' + ht;
    var c = cache[key] || (cache[key] = build(kind, wt, ht));
    g.drawImage(c, Math.round(x), Math.round(y));
  };

  /* ---------------------------------------------------------------- bridge: planks over the river */
  var bridgeTile = null;
  function buildBridge() {
    var c = mk(TILE, TILE), g = c.getContext('2d'), P = (S.PAL && S.PAL.water) || ['#17507e', '#2a8cc0'];
    R(g, 0, 0, TILE, TILE, P[1]);
    for (var y = 1; y < TILE; y += 3) { R(g, 1, y, TILE - 2, 2, '#b07840'); R(g, 1, y, TILE - 2, 1, '#d49c5c'); R(g, 1, y + 2, TILE - 2, 1, '#6a4020'); }
    R(g, 0, 0, 1, TILE, '#5a3a1e'); R(g, TILE - 1, 0, 1, TILE, '#5a3a1e');
    return c;
  }
  var drawGround = S.drawGround, groundOf = S.groundOf;
  if (drawGround && S.GROUND_TYPES) {
    S.GROUND_TYPES.bridge = 1;
    S.drawGround = function (g, type, x, y, v) {
      if (type === 'bridge') { g.drawImage(bridgeTile || (bridgeTile = buildBridge()), x, y); return; }
      drawGround(g, type, x, y, v);
    };
    S.groundOf = function (t) { return t === 'bridge' ? 'bridge' : groundOf(t); };
    var drawEdges = S.drawEdges;
    S.drawEdges = function (g, type, x, y, nb, v) { if (type === 'bridge') return; drawEdges(g, type, x, y, nb, v); };
  }
})();
