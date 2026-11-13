/*
 * room.js - GT3.Room(m, b): a building's room as a cut-away 3D model, built from the engine's own interior map (the
 * same tiles the 2D view draws, so walls, furniture and the doormat are where the game rules have them).
 *   m: { w, h, tiles[], mat: {x, y} }   (engine.js genHouseInterior / genPublicInterior / genMartInterior / ...)
 *   b: the building outside ({ kind, style }), for the wall colours
 *
 * Local units: tile (x, y) of the room covers x..x+1 on X and y..y+1 on Z, as the outdoor world does.
 *   - floor: one plane painted per tile (wood planks, ceramic tiles or the casino's dark floor), with the 2D rug,
 *     doormat and carpet on it
 *   - walls: the wall ring as 1.6-high blocks with wallpaper and a wainscot inside, an ink cap on top (the cut of a
 *     dollhouse); the front row stays low so the camera sees in, with a gap at the doormat; windows in the back wall
 *     light up at night
 *   - furniture: each piece is its 2D sprite extruded into a box: tall pieces (fridge, shelves, TV, slot machine) show
 *     the sprite on their front, low ones (bed, table, counter, chest, chair) on their top; plants are crossed cards
 * Returns { group, mats (every material, for fading), glow(k) (night window light), w, h }. The room's lamp is the
 * viewer's: one point light that stays in the scene, so walking in never makes every material recompile.
 */
(function () {
  'use strict';
  var GT3 = window.GT3, S = window.SPRITES;
  if (!GT3) return;
  var THREE = GT3.THREE, R = GT3.R, TILE = GT3.TILE, WALL_H = 1.6, FRONT_H = 0.28, INK = '#2a2430';
  // the engine draws these from flat colours too (engine.js FB_COL): no sprite exists for them
  var FB = { card_table: ['#2d7a3e', '#1b5128'], dice_table: ['#2d7a3e', '#f4f1dc'], slot: ['#8a8fa8', '#c0392b'], chest: ['#8a5a2b', '#f2c94c'],
    carpet_red: ['#9c2f40', '#7d2433'], floor_dark: ['#3a3550', '#2d2940'] };
  var TALL = { fridge: 1.3, bookshelf: 1.3, shelf: 1.1, tv: 0.8, slot: 1.2, ore_rock: 1.0, lb_wall: 1.25, news_board: 1.1, rack: 1.15, stove: 0.95 }; // the last five: engine.js room furniture
  var LOW = { bed: 0.45, table: 0.55, counter: 0.75, chest: 0.45, chair: 0.35, dice_table: 0.6, card_table: 0.6,
    roulette: 0.6, pew: 0.45, sack: 0.4, crate_i: 0.6, barrel_i: 0.7, tank: 0.8, display: 0.8, log: 0.45 };
  var FLAT = { rug: 1, doormat: 1, carpet_red: 1 };
  var FLOORS = { floor_wood: 1, floor_tile: 1, floor_dark: 1 };

  function styleOf(b) {
    var st = b && S.PUBLIC_STYLE && S.PUBLIC_STYLE[b.kind];
    if (st) return st;
    var hs = S.HOUSE_STYLES || [];
    if (b && (b.kind === 'house' || b.kind == null) && hs.length) return hs[(((b.style | 0) % hs.length) + hs.length) % hs.length];
    return { wall: '#e8e2d4', wallD: '#c8bea8', roofD: '#5a4a3a' };
  }
  function paintFloor(g, kind, x, y) {
    var px = x * TILE, py = y * TILE, i;
    if (kind === 'floor_tile') {
      for (i = 0; i < 4; i++) R(g, px + (i % 2) * 6, py + (i >> 1) * 6, 6, 6, (i === 0 || i === 3) ? '#e8e4dc' : '#dcd6ca');
      R(g, px, py + 5, TILE, 1, '#c4bcb0'); R(g, px, py + 11, TILE, 1, '#c4bcb0'); R(g, px + 5, py, 1, TILE, '#c4bcb0'); R(g, px + 11, py, 1, TILE, '#c4bcb0');
    } else if (kind === 'floor_dark') {
      R(g, px, py, TILE, TILE, FB.floor_dark[(x + y) % 2]);
    } else {
      for (i = 0; i < 4; i++) {
        var ry = py + i * 3, off = ((x * 7 + y * 3 + i * 5) % 12);
        R(g, px, ry, TILE, 3, i % 2 ? '#b07840' : '#a87038'); R(g, px, ry, TILE, 1, '#c8925a'); R(g, px, ry + 2, TILE, 1, '#8e5a30');
        R(g, px + off, ry, 1, 3, '#7a4a28');
      }
    }
  }
  function wallpaper(st) {
    var c = GT3.canvas(TILE, 20), g = c.getContext('2d');
    R(g, 0, 0, TILE, 20, st.wall);
    for (var x = 2; x < TILE; x += 6) R(g, x, 1, 1, 11, st.wallD);
    R(g, 0, 0, TILE, 1, INK);
    R(g, 0, 12, TILE, 1, INK); R(g, 0, 13, TILE, 7, st.wallD); R(g, 0, 13, TILE, 1, 'rgba(255,255,255,0.25)'); R(g, 0, 19, TILE, 1, '#807870');
    return c;
  }
  function windowPaper(st) {
    var c = wallpaper(st), g = c.getContext('2d');
    R(g, 2, 3, 8, 7, INK); R(g, 3, 4, 6, 5, '#a8d8f0'); R(g, 3, 4, 2, 1, '#e8f8ff'); R(g, 5, 4, 1, 5, INK); R(g, 3, 6, 6, 1, INK);
    return c;
  }
  function glowOf(st) { // the window's glass only, warm, for the emissive map
    var c = GT3.canvas(TILE, 20), g = c.getContext('2d');
    R(g, 0, 0, TILE, 20, '#000'); R(g, 3, 4, 2, 2, '#ffce78'); R(g, 6, 4, 3, 2, '#ffce78'); R(g, 3, 7, 2, 2, '#ffce78'); R(g, 6, 7, 3, 2, '#ffce78');
    return c;
  }
  function average(cv, dark) {
    var d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data, r = 0, gg = 0, bb = 0, n = 0;
    for (var i = 0; i < d.length; i += 4) if (d[i + 3] > 128) { r += d[i]; gg += d[i + 1]; bb += d[i + 2]; n++; }
    if (!n) return new THREE.Color('#8c8c99');
    return new THREE.Color(r / n / 255, gg / n / 255, bb / n / 255).multiplyScalar(dark || 1);
  }

  GT3.Room = function (m, b) {
    var group = new THREE.Group(), st = styleOf(b), mats = [], items = {};
    function M(o) { var x = GT3.mat(o); mats.push(x); return x; }
    var W = m.w, H = m.h, x, y, t;
    function at(xx, yy) { return xx < 0 || yy < 0 || xx >= W || yy >= H ? 'wall' : m.tiles[yy * W + xx]; }

    /* --- floor */
    var count = {}, floorKind = 'floor_wood';
    m.tiles.forEach(function (tt) { if (FLOORS[tt]) count[tt] = (count[tt] || 0) + 1; });
    Object.keys(count).forEach(function (k) { if (count[k] > (count[floorKind] || 0)) floorKind = k; });
    var fc = GT3.canvas(W * TILE, H * TILE), fg = fc.getContext('2d');
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      t = at(x, y);
      paintFloor(fg, FLOORS[t] ? t : floorKind, x, y);
      if (t === 'carpet_red') { R(fg, x * TILE, y * TILE, TILE, TILE, FB.carpet_red[0]); R(fg, x * TILE + 2, y * TILE, 1, TILE, FB.carpet_red[1]); R(fg, x * TILE + 9, y * TILE, 1, TILE, FB.carpet_red[1]); }
      else if (FLAT[t] && S.drawOverlay) S.drawOverlay(fg, t, x * TILE, y * TILE, 0);
    }
    var floor = new THREE.Mesh(new THREE.PlaneGeometry(W, H), M({ map: GT3.tex(fc) }));
    floor.rotation.x = -Math.PI / 2; floor.position.set(W / 2, 0.005, H / 2); floor.receiveShadow = true; floor.name = 'room-floor';
    group.add(floor);

    /* --- walls */
    var paper = GT3.tex(wallpaper(st), true), cap = M({ color: INK }), side = M({ map: paper }), outside = M({ color: st.wallD });
    var winMat = M({ map: GT3.tex(windowPaper(st)), emissive: 0xffffff, emissiveMap: GT3.tex(glowOf(st)), emissiveIntensity: 0 });
    var wallGeo = new THREE.BoxGeometry(1, WALL_H, 1), lowGeo = new THREE.BoxGeometry(1, FRONT_H, 1);
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      if (at(x, y) !== 'wall') continue;
      var front = y === H - 1, h = front ? FRONT_H : WALL_H;
      // faces: +x, -x, +y (cap), -y, +z (toward the room from the back wall), -z; wallpaper only where it faces inside
      var inE = x < W - 1 && at(x + 1, y) !== 'wall', inW = x > 0 && at(x - 1, y) !== 'wall', inS = y < H - 1 && at(x, y + 1) !== 'wall', inN = y > 0 && at(x, y - 1) !== 'wall';
      var win = y === 0 && x > 1 && x < W - 2 && x % 4 === 2;
      var face = function (inside) { return inside ? (win ? winMat : side) : outside; };
      var mesh = new THREE.Mesh(front ? lowGeo : wallGeo, [face(inE), face(inW), cap, outside, face(inS), face(inN)]);
      mesh.position.set(x + 0.5, h / 2, y + 0.5); mesh.castShadow = true; mesh.receiveShadow = true;
      group.add(mesh);
    }

    /* --- furniture */
    var plantCard = null;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      t = at(x, y);
      if (t === 'wall' || FLOORS[t] || FLAT[t]) continue;
      if (t === 'plant') {
        var pc = GT3.tileCanvas('plant', 0);
        if (!plantCard) plantCard = M({ map: GT3.tex(pc), alphaTest: 0.5, side: THREE.DoubleSide });
        [0, Math.PI / 2].forEach(function (r) {
          var q = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.95), plantCard);
          q.position.set(x + 0.5, 0.47, y + 0.5); q.rotation.y = r + Math.PI / 4; q.castShadow = true; group.add(q);
        });
        continue;
      }
      var set = items[t];
      if (!set) {
        var cv = GT3.tileCanvas(t, 0), has = !!(S._T && S._T[t] && S._T[t].rows), fb = FB[t];
        var sideCol = has ? average(cv, 0.72) : new THREE.Color(fb ? fb[0] : '#8c8c99').multiplyScalar(0.8);
        var sMat = M({ color: sideCol }), art = has ? M({ map: GT3.tex(cv), alphaTest: 0.01 }) : M({ color: fb ? fb[1] : '#a8a8b4' });
        var topCol = has ? average(cv, 1) : new THREE.Color(fb ? fb[1] : '#a8a8b4');
        set = items[t] = TALL[t] ? { h: TALL[t], mats: [sMat, sMat, M({ color: topCol }), sMat, art, sMat] }
          : { h: LOW[t] || 0.5, mats: [sMat, sMat, art, sMat, sMat, sMat] };
      }
      var tall = !!TALL[t], against = at(x, y - 1) === 'wall';
      var d = tall ? 0.55 : 0.86, zc = tall && against ? y + d / 2 + 0.02 : y + 0.5;
      var bx = new THREE.Mesh(new THREE.BoxGeometry(0.88, set.h, d), set.mats);
      bx.position.set(x + 0.5, set.h / 2, zc); bx.castShadow = true; bx.receiveShadow = true; bx.name = 'item:' + t;
      group.add(bx);
    }

    return {
      group: group, mats: mats, w: W, h: H,
      glow: function (night) { winMat.emissiveIntensity = 1.2 * night; },
      dispose: function () { GT3.dispose(group); }
    };
  };
})();
