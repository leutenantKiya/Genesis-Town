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
  var SINK = 3 * PX;                 // how far the water lies below the ground
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
        i = y * W + x; gt = L.tiles[i] === 'void' ? 'void' : S.groundOf(L.tiles[i]) || 'grass'; ground[i] = gt;
        if (gt === 'water' || gt === 'void') continue; // cut out: the water below, or the sky between islands, shows through
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
        if (gt === 'water' || gt === 'grass' || gt === 'void') continue;
        S.drawEdges(g, gt, x * TILE, y * TILE, { n: gAt(x, y - 1) === 'grass', s: gAt(x, y + 1) === 'grass', w: gAt(x - 1, y) === 'grass', e: gAt(x + 1, y) === 'grass' });
      }
      // a dark wet line where ground meets water, so the bank reads from above too
      for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
        if (ground[y * W + x] === 'water' || ground[y * W + x] === 'void') continue;
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
        if (!locked(x, y) || ground[y * W + x] === 'water' || ground[y * W + x] === 'void') continue;
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

    /* --- water: a sheet a few pixels below the ground under the water tiles only (the sky shows between islands) */
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
    var x, y, wq = [];
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) if (ground[y * W + x] === 'water') // uv in world tiles / 2: the ripples run on across tiles
      wq.push({ geo: GT3.quad([x, -SINK, y + 1], [x + 1, -SINK, y + 1], [x + 1, -SINK, y], [x, -SINK, y], [x / 2, -(y + 1) / 2, (x + 1) / 2, -y / 2]) });
    var water = null;
    if (wq.length) {
      water = new THREE.Mesh(GT3.merge(wq), GT3.mat({ map: wtex, vertexColors: true }));
      water.receiveShadow = true; water.name = 'water';
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
    var parts = [];
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      if (ground[y * W + x] === 'water' || ground[y * W + x] === 'void') continue;
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

    /* --- the island underneath: every bit of land hangs over the sky on a stepped block of earth and stone, deepest
       where it is furthest from an edge, so each island ends in a rough rocky point like a floating island. The faces are
       flat-coloured in bands (a grass lip, then earth, then two tones of stone), voxel-like, and recoloured by season. */
    function solidAt(xx, yy) { return xx >= 0 && yy >= 0 && xx < W && yy < H && ground[yy * W + xx] !== 'void'; }
    var dist = new Float32Array(W * H).fill(-1), q = [];
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      if (!solidAt(x, y)) continue;
      if (!solidAt(x + 1, y) || !solidAt(x - 1, y) || !solidAt(x, y + 1) || !solidAt(x, y - 1)) { dist[y * W + x] = 0; q.push(x, y); }
    }
    for (var qi = 0; qi < q.length; qi += 2) {
      var qx = q[qi], qy = q[qi + 1], dd = dist[qy * W + qx];
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) { var nx = qx + d[0], ny = qy + d[1]; if (solidAt(nx, ny) && dist[ny * W + nx] < 0) { dist[ny * W + nx] = dd + 1; q.push(nx, ny); } });
    }
    function bottom(xx, yy) {
      var d = Math.min(7, Math.max(0, dist[yy * W + xx]));
      return -(0.9 + d * 0.8 + ((GT3.hash(xx, yy, seed + 7) % 100) / 100) * 0.6);
    }
    function topAt(xx, yy) { return ground[yy * W + xx] === 'water' ? -SINK : 0; }
    var under = null;
    function buildUnder() {
      var P = GT3.pal(), up = [];
      var bands = [[0, -0.2, P.grass[0]], [-0.2, -1.1, P.soil[1]], [-1.1, -2.6, '#7a7c8c'], [-2.6, -99, '#5e6072']];
      function side(p0, p1, top, bot, flip) { // a vertical face from p0 to p1 (x, z), between heights top and bot, in bands
        bands.forEach(function (b, bi) {
          var t = Math.min(top, b[0]), u = Math.max(bot, b[1]);
          if (t - u < 0.01) return;
          var col = b[2];
          if (bi >= 2 && GT3.hash(Math.round(p0[0] * 3), Math.round(p0[1] * 3), bi) % 3 === 0) col = bi === 2 ? '#8a8c9c' : '#6c6e80';
          up.push({ geo: GT3.quad([p0[0], u, p0[1]], [p1[0], u, p1[1]], [p1[0], t, p1[1]], [p0[0], t, p0[1]]), color: col });
        });
      }
      for (var yy = 0; yy < H; yy++) for (var xx = 0; xx < W; xx++) {
        if (!solidAt(xx, yy)) continue;
        var b0 = bottom(xx, yy), t0 = topAt(xx, yy);
        up.push({ geo: GT3.quad([xx, b0, yy], [xx + 1, b0, yy], [xx + 1, b0, yy + 1], [xx, b0, yy + 1]), color: '#4e5062' });
        [[1, 0, [xx + 1, yy + 1], [xx + 1, yy]], [-1, 0, [xx, yy], [xx, yy + 1]], [0, 1, [xx, yy + 1], [xx + 1, yy + 1]], [0, -1, [xx + 1, yy], [xx, yy]]].forEach(function (d) {
          var nx = xx + d[0], ny = yy + d[1];
          if (!solidAt(nx, ny)) side(d[2], d[3], t0, b0);                       // the cliff over the sky
          else { var bn = bottom(nx, ny); if (bn > b0) side(d[2], d[3], bn, b0); } // a step in the rock underneath
        });
      }
      var m = new THREE.Mesh(GT3.merge(up), GT3.mat({ vertexColors: true, side: THREE.DoubleSide }));
      m.name = 'island-under'; m.castShadow = true; m.receiveShadow = true;
      if (under) { group.remove(under); under.geometry.dispose(); under.material.dispose(); }
      under = m; group.add(m);
    }
    buildUnder();

    /* --- waterfalls: wherever water reaches an island's edge it pours over into the sky */
    var fcv = GT3.canvas(8, 24), fg = fcv.getContext('2d'), ftex = GT3.tex(fcv, true);
    function paintFall() { // the pool's own colours, as vertical streaks; 8 px per tile both ways, so the pixels stay square
      var P = GT3.pal().water, r = GT3.rng(5);
      R(fg, 0, 0, 8, 24, P[1]);
      for (var xx = 0; xx < 8; xx++) {
        if (r() < 0.5) R(fg, xx, 0, 1, 24, P[2]);
        for (var k = 0; k < 3; k++) R(fg, xx, Math.floor(r() * 22), 1, 1 + Math.floor(r() * 3), r() < 0.5 ? P[0] : P[3]);
        if (r() < 0.45) R(fg, xx, Math.floor(r() * 20), 1, 2 + Math.floor(r() * 3), 'rgba(235,248,255,0.75)'); // white water
      }
      ftex.needsUpdate = true;
    }
    paintFall();
    var falls = [], FO = 0.02;     // FO: just in front of the island's side wall, which has the same depth
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      if (ground[y * W + x] !== 'water') continue;
      var fb = bottom(x, y), hv = (-SINK - fb) / 3;
      if (!solidAt(x, y + 1)) falls.push({ geo: GT3.quad([x, fb, y + 1 + FO], [x + 1, fb, y + 1 + FO], [x + 1, -SINK, y + 1 + FO], [x, -SINK, y + 1 + FO], [0, hv, 1, 0]) });
      if (!solidAt(x, y - 1)) falls.push({ geo: GT3.quad([x + 1, fb, y - FO], [x, fb, y - FO], [x, -SINK, y - FO], [x + 1, -SINK, y - FO], [0, hv, 1, 0]) });
      if (!solidAt(x + 1, y)) falls.push({ geo: GT3.quad([x + 1 + FO, fb, y + 1], [x + 1 + FO, fb, y], [x + 1 + FO, -SINK, y], [x + 1 + FO, -SINK, y + 1], [0, hv, 1, 0]) });
      if (!solidAt(x - 1, y)) falls.push({ geo: GT3.quad([x - FO, fb, y], [x - FO, fb, y + 1], [x - FO, -SINK, y + 1], [x - FO, -SINK, y], [0, hv, 1, 0]) });
    }
    var fall = null;
    if (falls.length) {
      fall = new THREE.Mesh(GT3.merge(falls), new THREE.MeshBasicMaterial({ map: ftex, vertexColors: true, transparent: true, opacity: 0.92, side: THREE.DoubleSide }));
      fall.name = 'waterfalls'; group.add(fall);
    }

    /* --- clouds drifting below the islands */
    var clouds = new THREE.Group(), cr = GT3.rng(seed + 3), cloudMat = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
    for (var c = 0; c < Math.round(W * H / 260); c++) {
      var puff = new THREE.Group(), n = 3 + Math.floor(cr() * 4);
      for (var pi = 0; pi < n; pi++) {
        var bx = new THREE.Mesh(new THREE.BoxGeometry(1.6 + cr() * 2.4, 0.7 + cr() * 0.6, 1.4 + cr() * 2), cloudMat);
        bx.position.set(pi * 1.3 + cr() * 0.6, cr() * 0.4, cr() * 1.2); puff.add(bx);
      }
      puff.position.set(cr() * (W + 20) - 10, -7 - cr() * 6, cr() * (H + 20) - 10);
      puff.userData.v = 0.15 + cr() * 0.25; clouds.add(puff);
    }
    clouds.name = 'clouds'; group.add(clouds);

    return {
      group: group, canvas: cv, isWater: isWater, locked: locked, groundAt: gAt,
      redraw: function () { paint(); gtex.needsUpdate = true; paintWater(); paintBank(); paintFall(); buildUnder(); },
      update: function (t) {
        wtex.offset.set((t * 0.035) % 1, (t * 0.02) % 1);
        ftex.offset.y = 1 - (t * 1.6) % 1; // v grows downward on the falls (their quads start at the island's underside): run it down
        clouds.children.forEach(function (p) { p.position.x += p.userData.v * 0.016; if (p.position.x > W + 14) p.position.x = -14; });
      }
    };
  };
  GT3.SINK = SINK;
})();
