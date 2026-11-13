/*
 * buildings.js - pixel art for the village's public buildings and the river bridge (all original, drawn in code).
 * Extends window.SPRITES (after sprites.js and art.js):
 *   SPRITES.drawPublic(g, kind, x, y, wTiles, hTiles)   kinds: hall, church, clinic, post, broker, warung, and the Homeland
 *   buildings townhall (Balai Kota, 4x4), kolam (Kolam Ikan), tambang, restoran, and the land's work buildings
 *   penggergajian (sawmill: plank walls, a log pile and a saw blade), kincir (windmill: four sails over the roof) and
 *   gudang (storehouse: a red barn with wide braced doors and crates) (3x3)
 *   Public buildings added in village version 3: mall (Mall, 5x4: two display windows, hanging banners), casino (Kasino, 4x4:
 *   dark walls, string lights, gold sign and pillars), papan (Balai Berita, 4x3: timber posts, two notice boards) and
 *   tambangpub (Tambang Umum, 3x3: stone, a timbered mine mouth and an ore cart).
 *   The older public buildings got a medieval touch: a fieldstone base, a gold pennant on the roof, lanterns by the sign.
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
    rumahsakit: { roof: '#c84a4a', roofD: '#8a2c2c', roofL: '#e88080', wall: '#f8f6f2', wallD: '#dcd8d4', sign: '#ffffff' },
    penggergajian: { roof: '#4f7a3a', roofD: '#2f4f22', roofL: '#78a858', wall: '#c89a62', wallD: '#a07040', sign: '#fff0d8' },
    kincir:     { roof: '#b8743a', roofD: '#7a4a22', roofL: '#e0a060', wall: '#f2ead8', wallD: '#d4c8ac', sign: '#fffaf0' },
    gudang:     { roof: '#56606c', roofD: '#38404a', roofL: '#7c8894', wall: '#b4523c', wallD: '#8e3c2c', sign: '#fff4dc' },
    mall:       { roof: '#8a3a52', roofD: '#5a2234', roofL: '#b8607a', wall: '#e8dcc4', wallD: '#c8b894', sign: '#fff4dc' },
    casino:     { roof: '#4a2a6a', roofD: '#2c1840', roofL: '#7a56a0', wall: '#3e3250', wallD: '#2c2238', sign: '#f2c850' },
    papan:      { roof: '#7a5232', roofD: '#4e3220', roofL: '#a87a4c', wall: '#e2d2ac', wallD: '#c4ae84', sign: '#fff2d4' },
    tambangpub: { roof: '#586070', roofD: '#363c4a', roofL: '#808a9c', wall: '#9c9692', wallD: '#7a7470', sign: '#ece8e0' }
  };
  S.PUBLIC_STYLE = STYLE; // the 3D kit (js/three/building.js) builds its roofs and side walls from the same colours

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
    penggergajian: function (g, cx, y) { R(g, cx - 5, y + 3, 7, 3, '#8a5a30'); R(g, cx - 5, y + 3, 1, 3, '#d8b070'); R(g, cx + 2, y + 1, 4, 4, '#a8b0b8'); R(g, cx + 3, y + 2, 2, 2, '#ffffff'); R(g, cx + 1, y + 2, 1, 2, '#a8b0b8'); },
    kincir: function (g, cx, y) { R(g, cx - 1, y + 2, 2, 4, '#b8743a'); R(g, cx - 4, y, 2, 2, '#6a4020'); R(g, cx + 2, y, 2, 2, '#6a4020'); R(g, cx - 3, y + 1, 6, 1, '#6a4020'); R(g, cx - 4, y + 3, 2, 2, '#6a4020'); R(g, cx + 2, y + 3, 2, 2, '#6a4020'); },
    gudang: function (g, cx, y) { R(g, cx - 4, y + 1, 8, 5, '#c8904c'); R(g, cx - 4, y + 1, 8, 1, '#8a5a30'); R(g, cx - 4, y + 5, 8, 1, '#8a5a30'); R(g, cx - 1, y + 1, 1, 5, '#8a5a30'); R(g, cx - 4, y + 3, 8, 1, '#8a5a30'); },
    mall: function (g, cx, y) { R(g, cx - 3, y + 1, 6, 5, '#a83050'); R(g, cx - 3, y + 1, 6, 1, '#6a1c30'); R(g, cx - 2, y, 1, 2, OL); R(g, cx + 1, y, 1, 2, OL); R(g, cx - 1, y + 3, 2, 2, '#f0d048'); },
    casino: function (g, cx, y) { R(g, cx - 3, y, 6, 6, OL); R(g, cx - 2, y + 1, 4, 4, '#ffffff'); R(g, cx - 2, y + 1, 1, 1, OL); R(g, cx + 1, y + 1, 1, 1, OL); R(g, cx - 1, y + 2, 2, 2, '#d83c3c'); R(g, cx - 2, y + 4, 1, 1, OL); R(g, cx + 1, y + 4, 1, 1, OL); },
    papan: function (g, cx, y) { R(g, cx - 4, y + 1, 8, 5, '#d8b878'); R(g, cx - 4, y + 1, 8, 1, '#8a5a30'); R(g, cx - 3, y + 3, 6, 1, '#6a4020'); R(g, cx - 3, y + 5, 4, 1, '#6a4020'); R(g, cx + 2, y + 2, 1, 1, '#d83c3c'); },
    tambangpub: function (g, cx, y) { R(g, cx - 4, y + 1, 8, 1, '#8a8698'); R(g, cx - 4, y + 1, 1, 2, '#8a8698'); R(g, cx + 3, y + 1, 1, 2, '#8a8698'); R(g, cx - 1, y + 2, 2, 4, '#8a5a30'); R(g, cx - 4, y + 4, 1, 1, '#58c8e8'); },
    warung: function (g, cx, y) { R(g, cx - 3, y + 2, 5, 4, '#f8f8f8'); R(g, cx - 3, y + 2, 5, 1, '#6a4020'); R(g, cx + 2, y + 3, 2, 2, '#f8f8f8'); R(g, cx - 2, y + 1, 1, 1, '#c8c8c8'); R(g, cx, y, 1, 1, '#c8c8c8'); }
  };

  /* the medieval touches shared by the public buildings (not the Homeland ones, which have homeTrim): a fieldstone base
     course, a gold pennant on the roof, and a lantern each side of the sign */
  function stoneBase(g, w, h) {
    R(g, 2, h - 7, w - 4, 5, '#9a948a'); R(g, 2, h - 7, w - 4, 1, '#c4bcb0'); R(g, 2, h - 5, w - 4, 1, '#76706a'); R(g, 2, h - 3, w - 4, 1, '#807a72');
    for (var x = 2, k = 0; x < w - 2; x += 5, k++) { R(g, x + (k % 2) * 2, h - 6, 1, 1, '#6e685e'); R(g, x + 2 - (k % 2) * 2, h - 4, 1, 1, '#6e685e'); R(g, x + 1, h - 6, 2, 1, '#b4ac9c'); }
  }
  function pennant(g, x) {
    R(g, x, 1, 1, 9, '#4a4a52'); R(g, x + 1, 1, 6, 3, OL); R(g, x + 1, 2, 5, 1, '#f0d068'); R(g, x + 1, 3, 3, 1, '#d8a838'); R(g, x + 2, 4, 1, 1, OL);
  }
  function lantern(g, x, y) {
    R(g, x - 1, y - 1, 4, 1, '#3a3a3a'); R(g, x, y, 2, 1, '#3a3a3a'); R(g, x, y + 1, 2, 3, '#f8d048'); R(g, x, y + 1, 1, 1, '#fff2a0'); R(g, x, y + 4, 2, 1, '#3a3a3a');
  }

  function build(kind, wt, ht, bare) {
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
    var medieval = !HOME[kind];
    if (medieval) stoneBase(g, w, h);
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
    } else if (kind === 'mall') {
      // gold trim under the eave, two display windows full of goods, a burgundy banner each side of the sign
      R(g, 2, wallTop, w - 4, 1, '#d8b040');
      [4, w - 17].forEach(function (x) {
        R(g, x, wallTop + 5, 13, 13, OL); R(g, x + 1, wallTop + 6, 11, 11, '#c4e4f8'); R(g, x + 1, wallTop + 6, 3, 1, '#eaf8ff'); R(g, x + 6, wallTop + 6, 1, 11, OL);
        R(g, x + 1, wallTop + 13, 11, 1, '#8a5a30'); R(g, x + 2, wallTop + 9, 3, 4, '#d83c3c'); R(g, x + 2, wallTop + 9, 3, 1, '#f08070'); R(g, x + 8, wallTop + 10, 3, 3, '#e8b830'); R(g, x + 2, wallTop + 15, 3, 2, '#58a858'); R(g, x + 8, wallTop + 15, 3, 2, '#4a8ad8');
      });
      [18, w - 22].forEach(function (x) {
        R(g, x, wallTop + 1, 4, 11, OL); R(g, x + 1, wallTop + 1, 2, 9, '#a83050'); R(g, x + 1, wallTop + 2, 2, 1, '#e8c050'); R(g, x + 1, wallTop + 4, 2, 2, '#e8c050'); R(g, x + 1, wallTop + 10, 1, 1, OL);
      });
    } else if (kind === 'casino') {
      // string lights along the eave, gold pillars, warm windows, gold cresting on the roof
      for (var lx = 4; lx < w - 4; lx += 4) R(g, lx, wallTop + 2, 2, 2, Math.floor(lx / 4) % 2 ? '#ffe070' : '#ff6a6a');
      for (var crx = 4; crx < w - 4; crx += 6) { R(g, crx, 0, 3, 2, '#e8c050'); R(g, crx, 0, 3, 1, '#fff0a0'); }
      windowAt(g, 5, wallTop + 8, '#ffe08a'); windowAt(g, w - 10, wallTop + 8, '#ffe08a');
      R(g, cx - 9, h - 20, 2, 15, '#e8c050'); R(g, cx + 5, h - 20, 2, 15, '#e8c050'); R(g, cx - 9, h - 20, 1, 15, '#fff0a0'); R(g, cx + 5, h - 20, 1, 15, '#fff0a0');
    } else if (kind === 'papan') {
      // timber posts and two notice boards: pinned notes on the left, the ranking list on the right
      R(g, 2, wallTop, 2, h - wallTop - 7, '#5a3a22'); R(g, w - 4, wallTop, 2, h - wallTop - 7, '#5a3a22'); R(g, 2, wallTop, w - 4, 1, '#5a3a22');
      R(g, 6, 19, 12, 11, OL); R(g, 7, 20, 10, 9, '#e8d4a0'); R(g, 7, 20, 10, 1, '#f6e8c0');
      R(g, 8, 21, 3, 3, '#ffffff'); R(g, 12, 21, 4, 2, '#f8e8a8'); R(g, 8, 25, 4, 3, '#f8f0d8'); R(g, 13, 24, 3, 4, '#cfe8d8'); R(g, 9, 21, 1, 1, '#d83c3c'); R(g, 13, 21, 1, 1, '#d83c3c'); R(g, 9, 25, 1, 1, '#d83c3c');
      R(g, w - 12, 19, 9, 11, OL); R(g, w - 11, 20, 7, 9, '#e8d4a0'); R(g, w - 10, 21, 1, 1, '#e8b830'); R(g, w - 8, 21, 3, 1, '#6a4020'); R(g, w - 10, 23, 1, 1, '#c0c0c8'); R(g, w - 8, 23, 3, 1, '#6a4020'); R(g, w - 10, 25, 1, 1, '#b87040'); R(g, w - 8, 25, 2, 1, '#6a4020'); R(g, w - 10, 27, 5, 1, '#c8b078');
    } else if (kind === 'tambangpub') {
      // fieldstone, a timbered mine mouth beside the door and an ore cart on the other side
      for (var sy = wallTop + 3; sy < h - 7; sy += 5) for (var sx = 2 + ((sy / 5) % 2 ? 3 : 0); sx < w - 6; sx += 7) R(g, sx, sy, 6, 1, st.wallD);
      R(g, 3, wallTop + 6, 9, 13, OL); R(g, 4, wallTop + 7, 7, 12, '#14101c'); R(g, 3, wallTop + 5, 10, 2, '#6a4020'); R(g, 3, wallTop + 6, 1, 13, '#6a4020'); R(g, 11, wallTop + 6, 1, 13, '#6a4020'); R(g, 7, wallTop + 12, 1, 2, '#58c8e8');
      R(g, w - 12, wallTop + 11, 9, 5, OL); R(g, w - 11, wallTop + 8, 7, 4, '#b07840'); R(g, w - 10, wallTop + 7, 2, 2, '#58c8e8'); R(g, w - 7, wallTop + 7, 2, 2, '#e8c050'); R(g, w - 11, wallTop + 12, 7, 2, '#5a3a1e'); R(g, w - 11, wallTop + 16, 2, 2, '#d0d0d0'); R(g, w - 6, wallTop + 16, 2, 2, '#d0d0d0');
    } else if (kind === 'penggergajian') {
      // plank walls, a stack of log ends on the left, a round saw blade on the right
      for (var px = 4; px < w - 3; px += 3) R(g, px, wallTop + 1, 1, h - wallTop - 5, st.wallD);
      [[3, wallTop + 11], [8, wallTop + 11], [5, wallTop + 6]].forEach(function (p) {
        R(g, p[0], p[1], 6, 6, OL); R(g, p[0] + 1, p[1] + 1, 4, 4, '#b07840'); R(g, p[0] + 2, p[1] + 2, 2, 2, '#e0bc80'); R(g, p[0] + 1, p[1] + 1, 1, 1, '#d49c5c');
      });
      var bx0 = w - 12, by0 = wallTop + 5;
      R(g, bx0 + 2, by0, 6, 10, OL); R(g, bx0, by0 + 2, 10, 6, OL); R(g, bx0 + 1, by0 + 1, 8, 8, OL);
      R(g, bx0 + 3, by0 + 1, 4, 8, '#c8d0d8'); R(g, bx0 + 1, by0 + 3, 8, 4, '#c8d0d8'); R(g, bx0 + 2, by0 + 2, 6, 6, '#c8d0d8');
      R(g, bx0 + 2, by0 + 2, 2, 1, '#f4f8fc'); R(g, bx0 + 4, by0 + 4, 2, 2, '#6a6678');
      R(g, bx0 - 1, by0 + 11, 12, 2, OL); R(g, bx0, by0 + 11, 10, 1, '#8a5a30');
    } else if (kind === 'gudang') {
      // a red barn: white corner boards, crates at both corners
      R(g, 2, wallTop, 2, h - wallTop - 3, '#f2ead8'); R(g, w - 4, wallTop, 2, h - wallTop - 3, '#f2ead8');
      [[4, h - 10], [w - 12, h - 10], [w - 10, h - 16]].forEach(function (p) {
        R(g, p[0], p[1], 8, 7, OL); R(g, p[0] + 1, p[1] + 1, 6, 5, '#c8904c'); R(g, p[0] + 1, p[1] + 1, 6, 1, '#e0b070'); R(g, p[0] + 1, p[1] + 3, 6, 1, '#8a5a30'); R(g, p[0] + 3, p[1] + 1, 1, 5, '#8a5a30');
      });
    } else {
      var glass = kind === 'clinic' ? '#c8f0ec' : kind === 'rumahsakit' ? '#c8e8f8' : kind === 'kolam' || kind === 'rumah' ? '#7cc8f0' : null;
      windowAt(g, 5, wallTop + 6, glass);
      windowAt(g, w - 13, wallTop + 6, glass);
      if (wt >= 5) { windowAt(g, cx - 18, wallTop + 6); windowAt(g, cx + 10, wallTop + 6); }
    }
    if (kind === 'hall' || kind === 'townhall') {
      // two columns beside the door and a flag pole on the roof
      R(g, cx - 9, h - 16, 3, 13, '#fafaf0'); R(g, cx + 6, h - 16, 3, 13, '#fafaf0');
      R(g, w - 8, 0, 1, roofRows - 2, '#6a6a6a'); R(g, w - 7, 1, 7, 5, '#00ec97'); R(g, w - 6, 2, 1, 3, '#000'); R(g, w - 2, 2, 1, 3, '#000'); R(g, w - 5, 2, 1, 1, '#000'); R(g, w - 4, 3, 1, 1, '#000'); R(g, w - 3, 4, 1, 1, '#000');
    }
    if (kind === 'kolam') { R(g, 2, h - 6, w - 4, 2, '#3d7fc2'); R(g, 2, h - 6, w - 4, 1, '#9ad8ff'); }
    if (HOME[kind]) homeTrim(g, w, h, wallTop, kind);
    if (medieval) { pennant(g, 5); lantern(g, cx - 10, h - 22); lantern(g, cx + 8, h - 22); }
    sign(g, cx, h - 24, st, ICON[kind]);
    door(g, cx, h - 1, kind === 'clinic' || kind === 'rumahsakit' ? '#5cb8b0' : kind === 'rumah' ? '#6a4020' : kind === 'post' ? '#c86028' : kind === 'gudang' ? '#f2ead8' : kind === 'casino' ? '#8a2a3a' : kind === 'papan' ? '#6a4020' : null);
    if (kind === 'gudang') { R(g, cx - 4, h - 13, 8, 12, '#8e3c2c'); for (var k = 0; k < 12; k++) { R(g, cx - 4 + Math.floor(k * 8 / 12), h - 13 + k, 1, 1, '#f2ead8'); R(g, cx + 3 - Math.floor(k * 8 / 12), h - 13 + k, 1, 1, '#f2ead8'); } }
    if (kind === 'kincir' && !bare) sails(g, cx, 7, 14);
    return cv;
  }

  /* Homeland buildings look lived-in, unlike the public village's: a fieldstone base instead of the plain grey plinth,
     and flower boxes under the front windows (the 2.5D view uses this facade, so it shows there too) */
  var HOME = { townhall: 1, kolam: 1, tambang: 1, restoran: 1, rumah: 1, rumahsakit: 1, penggergajian: 1, kincir: 1, gudang: 1 };
  function homeTrim(g, w, h, wallTop, kind) {
    R(g, 2, h - 4, w - 4, 3, '#8a8478');
    for (var x = 2, k = 0; x < w - 2; x += 4, k++) { R(g, x, h - 4 + (k % 2), 3, 1, '#b4ac9c'); R(g, x + 3, h - 4, 1, 3, '#5e5850'); }
    if (kind === 'tambang' || kind === 'penggergajian' || kind === 'gudang') return; // work fronts have no windows to dress
    [5, w - 13].forEach(function (bx) {
      var by = wallTop + 13;
      R(g, bx - 1, by, 10, 3, OL); R(g, bx, by, 8, 2, '#8a5a30');
      for (var f = 0; f < 4; f++) R(g, bx + 1 + f * 2, by - 1, 1, 1, f % 2 ? '#f0d048' : '#e85a6a');
      R(g, bx, by - 1, 8, 0, '#4a9a40');
    });
  }

  /* the windmill's four sails over the roof, as an X: a wooden spar and lattice cloth on each, a hub in the middle;
     the 2.5D view turns real sails instead (js/three/building.js) and draws the facade below the roof only */
  function sails(g, cx, cy, len) {
    for (var d = 0; d < 4; d++) {
      var sx = d === 0 || d === 3 ? 1 : -1, sy = d < 2 ? -1 : 1;
      for (var i = 2; i < len; i++) {
        var x = cx + sx * i, y = cy + sy * i;
        R(g, x, y, 1, 1, '#5a3a1e');
        if (i > 3) { R(g, x + sx, y, 1, 1, i % 2 ? '#f2ead8' : '#d8ccb0'); R(g, x + 2 * sx, y, 1, 1, '#f2ead8'); R(g, x + 2 * sx, y - sy, 1, 1, '#d8ccb0'); }
      }
    }
    R(g, cx - 2, cy - 2, 4, 4, OL); R(g, cx - 1, cy - 1, 2, 2, '#c8a030');
  }
  S.windmillSails = sails;

  var cache = {};
  // bare: without what the 2.5D view models for itself (the windmill's sails)
  S.drawPublic = function (g, kind, x, y, wt, ht, bare) {
    if (!STYLE[kind]) return S.drawHouse(g, x, y, 0, false);
    var key = kind + ':' + wt + 'x' + ht + (bare ? ':bare' : '');
    var c = cache[key] || (cache[key] = build(kind, wt, ht, !!bare));
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
  var clearTiles = S._clearTiles;
  S._clearTiles = function () { bridgeTile = null; if (clearTiles) clearTiles(); }; // the plank tile bakes the water colour
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
