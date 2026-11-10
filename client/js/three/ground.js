/*
 * ground.js - GT3.Ground(L): the ground of one layout (GTVillage / GTHomeland output).
 *   - one textured plane painted with the 2D ground art (variants, the soft noise tint, grass lips), in season colours
 *   - water sits below the ground: water tiles are cut out of the plane, a water sheet lies 3 px lower, and short
 *     bank walls close the step, so rivers and ponds have a real edge that catches shadow
 *   - the world's rim is a cut block of soil (grass lip, earth, stone), so the map reads as a model you look down on
 *   - chunks that are not open yet are dimmed (the mist of the 2D map)
 * Returns { group, redraw() (after a season change), update(t), isWater(x, y), locked(x, y) }.
 */
(function () {
  'use strict';
  var GT3 = window.GT3, S = window.SPRITES;
  if (!GT3) return;
  var THREE = GT3.THREE, TILE = GT3.TILE, PX = GT3.PX, R = GT3.R;
  var SINK = 3 * PX, DEPTH = 2;      // how far the water lies below the ground; height of the world's cut edge
  // per-season noise tint on the grass: [dark rgb, light rgb, dark strength, light strength] (as the 2D world cache)
  var NOISE_TINT = { semi: ['20,60,30', '220,240,120', 0.45, 0.28], panas: ['16,64,24', '244,240,96', 0.45, 0.30],
    gugur: ['64,40,12', '240,196,104', 0.45, 0.30], snow: ['120,140,180', '255,255,255', 0.35, 0.4] };
  var FOG = 'rgba(30,26,58,0.5)', FOG_EDGE = 'rgba(30,26,58,0.34)';

  GT3.Ground = function (L) {
    var W = L.w, H = L.h, seed = (L.seed | 0) || 1, group = new THREE.Group();
    var ground = new Array(W * H), cv = GT3.canvas(W * TILE, H * TILE), g = cv.getContext('2d');
    var CH = L.chunk || 16, NC = Math.round(W / CH), openChunk = {};
    (L.chunks || []).forEach(function (c) { openChunk[c.cx + ',' + c.cy] = c.open !== false; });
    function locked(x, y) { var k = Math.floor(x / CH) + ',' + Math.floor(y / CH); return k in openChunk ? !openChunk[k] : false; }
    function gAt(x, y) { return (x < 0 || y < 0 || x >= W || y >= H) ? 'grass' : ground[y * W + x]; }
    function isWater(x, y) { return x >= 0 && y >= 0 && x < W && y < H && ground[y * W + x] === 'water'; }

    function paint() {
      var x, y, i, gt, P = GT3.pal();
      g.clearRect(0, 0, cv.width, cv.height);
      for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
        i = y * W + x; gt = S.groundOf(L.tiles[i]) || 'grass'; ground[i] = gt;
        if (gt === 'water') continue; // cut out: the water sheet shows through
        var hv = GT3.hash(x, y, seed) % 10;
        S.drawGround(g, gt, x * TILE, y * TILE, gt === 'grass' ? (hv < 6 ? 0 : hv < 8 ? 1 : hv < 9 ? 2 : 3) : hv & 3);
        if (gt === 'grass') {
          var n = GT3.noise(seed, x / 5, y / 5) - 0.5, nt = GT3.snowy() ? NOISE_TINT.snow : NOISE_TINT[GT3.season()] || NOISE_TINT.semi;
          g.fillStyle = n < 0 ? 'rgba(' + nt[0] + ',' + (-n * nt[2]).toFixed(3) + ')' : 'rgba(' + nt[1] + ',' + (n * nt[3]).toFixed(3) + ')';
          g.fillRect(x * TILE, y * TILE, TILE, TILE);
        }
      }
      for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
        gt = ground[y * W + x];
        if (gt === 'water' || gt === 'grass') continue;
        S.drawEdges(g, gt, x * TILE, y * TILE, { n: gAt(x, y - 1) === 'grass', s: gAt(x, y + 1) === 'grass', w: gAt(x - 1, y) === 'grass', e: gAt(x + 1, y) === 'grass' });
      }
      // a dark wet line where ground meets water, so the bank reads from above too
      for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
        if (ground[y * W + x] === 'water') continue;
        g.fillStyle = 'rgba(40,24,12,0.38)';
        if (isWater(x, y + 1)) g.fillRect(x * TILE, y * TILE + TILE - 1, TILE, 1);
        if (isWater(x, y - 1)) g.fillRect(x * TILE, y * TILE, TILE, 1);
        if (isWater(x + 1, y)) g.fillRect(x * TILE + TILE - 1, y * TILE, 1, TILE);
        if (isWater(x - 1, y)) g.fillRect(x * TILE, y * TILE, 1, TILE);
      }
      // Homeland lots with nothing built yet: a patch of bare earth
      if (L.lots) {
        var taken = {};
        (L.buildings || []).forEach(function (b) { if (b.lot) taken[b.lot] = 1; });
        L.lots.forEach(function (l) {
          if (taken[l.id] || locked(l.x, l.y)) return;
          R(g, l.x * TILE + 2, l.y * TILE + 2, l.w * TILE - 4, l.h * TILE - 4, P.path[0]);
          R(g, l.x * TILE + 3, l.y * TILE + 3, l.w * TILE - 6, l.h * TILE - 6, P.path[1]);
          var r = GT3.rng(GT3.hash(l.x, l.y, 5));
          for (var k = 0; k < 26; k++) R(g, l.x * TILE + 4 + Math.floor(r() * (l.w * TILE - 9)), l.y * TILE + 4 + Math.floor(r() * (l.h * TILE - 9)), 1, 1, r() < 0.5 ? P.path[0] : P.path[2]);
        });
      }
      for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
        if (!locked(x, y) || ground[y * W + x] === 'water') continue;
        var edge = !locked(x - 1, y) || !locked(x + 1, y) || !locked(x, y - 1) || !locked(x, y + 1);
        g.fillStyle = edge ? FOG_EDGE : FOG;
        g.fillRect(x * TILE, y * TILE, TILE, TILE);
      }
    }

    /* --- the ground plane */
    paint();
    var gtex = GT3.tex(cv);
    var plane = new THREE.Mesh(new THREE.PlaneGeometry(W, H), GT3.mat({ map: gtex, alphaTest: 0.5 }));
    plane.rotation.x = -Math.PI / 2; plane.position.set(W / 2, 0, H / 2); plane.receiveShadow = true;
    plane.name = 'ground';
    group.add(plane);

    /* --- water: one sheet a few pixels below, its ripple pattern drifting slowly */
    var wcv = GT3.canvas(24, 24), wg = wcv.getContext('2d'), wtex = GT3.tex(wcv, true);
    function paintWater() {
      var P = GT3.pal().water, r = GT3.rng(77);
      R(wg, 0, 0, 24, 24, P[1]);
      for (var i = 0; i < 12; i++) R(wg, Math.floor(r() * 23), Math.floor(r() * 24), 2 + Math.floor(r() * 2), 1, P[0]);
      for (i = 0; i < 9; i++) R(wg, Math.floor(r() * 22), Math.floor(r() * 24), 3, 1, P[2]);
      R(wg, 5, 4, 1, 1, P[3]); R(wg, 17, 15, 1, 1, P[3]);
      wtex.needsUpdate = true;
    }
    paintWater();
    wtex.repeat.set(W / 2, H / 2);
    var hasWater = ground.indexOf('water') >= 0, water = null;
    if (hasWater) {
      water = new THREE.Mesh(new THREE.PlaneGeometry(W, H), GT3.mat({ map: wtex }));
      water.rotation.x = -Math.PI / 2; water.position.set(W / 2, -SINK, H / 2); water.receiveShadow = true; water.name = 'water';
      group.add(water);
    }

    /* --- banks: a short wall wherever ground meets water */
    var bcv = GT3.canvas(TILE, 4), bg = bcv.getContext('2d'), btex = GT3.tex(bcv, true);
    function paintBank() {
      var P = GT3.pal(), r = GT3.rng(31);
      R(bg, 0, 0, TILE, 1, P.soil[2]); R(bg, 0, 1, TILE, 2, P.soil[1]); R(bg, 0, 3, TILE, 1, P.soil[0]);
      for (var i = 0; i < 5; i++) R(bg, Math.floor(r() * TILE), 1 + Math.floor(r() * 2), 1, 1, P.soil[0]);
      btex.needsUpdate = true;
    }
    paintBank();
    var parts = [], x, y;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      if (ground[y * W + x] === 'water') continue;
      if (isWater(x, y + 1)) parts.push({ geo: GT3.quad([x, -SINK, y + 1], [x + 1, -SINK, y + 1], [x + 1, 0, y + 1], [x, 0, y + 1]) });
      if (isWater(x, y - 1)) parts.push({ geo: GT3.quad([x + 1, -SINK, y], [x, -SINK, y], [x, 0, y], [x + 1, 0, y]) });
      if (isWater(x + 1, y)) parts.push({ geo: GT3.quad([x + 1, -SINK, y + 1], [x + 1, -SINK, y], [x + 1, 0, y], [x + 1, 0, y + 1]) });
      if (isWater(x - 1, y)) parts.push({ geo: GT3.quad([x, -SINK, y], [x, -SINK, y + 1], [x, 0, y + 1], [x, 0, y]) });
    }
    if (parts.length) {
      var banks = new THREE.Mesh(GT3.merge(parts), GT3.mat({ map: btex, vertexColors: true }));
      banks.receiveShadow = true; banks.name = 'banks';
      group.add(banks);
    }

    /* --- the cut edge of the world */
    var scv = GT3.canvas(48, 24), sg = scv.getContext('2d'), stex = GT3.tex(scv, true);
    function paintSkirt() {
      var P = GT3.pal(), r = GT3.rng(1234), i;
      R(sg, 0, 0, 48, 24, '#2c1a10');
      R(sg, 0, 0, 48, 2, P.grass[0]); R(sg, 0, 0, 48, 1, P.grass[1]);
      for (i = 0; i < 48; i += 3) R(sg, i + (r() < 0.5 ? 1 : 0), 2, 1, 1, P.grass[0]);
      R(sg, 0, 3, 48, 7, P.soil[1]); R(sg, 0, 3, 48, 1, P.soil[2]);
      for (i = 0; i < 20; i++) R(sg, Math.floor(r() * 47), 4 + Math.floor(r() * 5), 2, 1, r() < 0.5 ? P.soil[0] : P.soil[2]);
      R(sg, 0, 10, 48, 1, P.soil[0]);
      R(sg, 0, 11, 48, 8, '#4a2e1c');
      for (i = 0; i < 9; i++) { var sx = Math.floor(r() * 44), sy = 12 + Math.floor(r() * 5); R(sg, sx, sy, 3, 2, '#7a746c'); R(sg, sx, sy, 3, 1, '#a09a90'); }
      R(sg, 0, 19, 48, 1, '#3a2416');
      for (i = 0; i < 14; i++) R(sg, Math.floor(r() * 47), 20 + Math.floor(r() * 4), 2, 1, '#3a2416');
      stex.needsUpdate = true;
    }
    paintSkirt();
    var sk = [];
    function v(yTop) { return 1 + yTop / DEPTH; } // texture row at a given height (y <= 0)
    function seg(p0, p1, u0, u1, top) {
      sk.push({ geo: GT3.quad([p0[0], -DEPTH, p0[1]], [p1[0], -DEPTH, p1[1]], [p1[0], top, p1[1]], [p0[0], top, p0[1]], [u0, 0, u1, v(top)]) });
    }
    for (x = 0; x < W; x++) {
      seg([x, H], [x + 1, H], x / 4, (x + 1) / 4, isWater(x, H - 1) ? -SINK : 0);          // south face
      seg([x + 1, 0], [x, 0], x / 4, (x + 1) / 4, isWater(x, 0) ? -SINK : 0);                // north
    }
    for (y = 0; y < H; y++) {
      seg([W, y + 1], [W, y], y / 4, (y + 1) / 4, isWater(W - 1, y) ? -SINK : 0);            // east
      seg([0, y], [0, y + 1], y / 4, (y + 1) / 4, isWater(0, y) ? -SINK : 0);                // west
    }
    var skirt = new THREE.Mesh(GT3.merge(sk), GT3.mat({ map: stex, vertexColors: true }));
    skirt.name = 'skirt';
    group.add(skirt);

    return {
      group: group, canvas: cv, isWater: isWater, locked: locked, groundAt: gAt,
      redraw: function () { paint(); gtex.needsUpdate = true; paintWater(); paintBank(); paintSkirt(); },
      update: function (t) { if (water) wtex.offset.set((t * 0.035) % 1, (t * 0.02) % 1); }
    };
  };
  GT3.SINK = SINK;
})();
