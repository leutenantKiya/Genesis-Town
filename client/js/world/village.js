/*
 * village.js - the seeded world generator, shared by the browser and the server (same seed = same map everywhere).
 *
 * The world is 3 x 3 chunks of 32 x 32 tiles. Chunk roles are fixed; the seed decides everything inside them:
 *   (1,1) Desa Genesis   - the village core: plaza with the four market stalls, Balai Desa, gereja, puskesmas,
 *                          kantor pos, kantor makelar, warung, houses along winding lanes. Open.
 *   (1,0) Hutan Utara    - forest and the mine clearing (wood, ore). Open.
 *   (0,1) Ladang Barat   - fields, the player's house and fenced farm, a pond. Open.
 *   (2,1) Dusun Seberang - a hamlet across the river. Locked until the town finishes the bridge project.
 *   the other five       - generated (forest, meadow, lake) but locked; future expansion.
 * A river runs north to south between the core and Dusun Seberang; the main road crosses it on the bridge.
 *
 * Steps: terrain noise -> river -> roads (Manhattan polylines between jittered waypoints, plus side lanes) ->
 * landmarks and houses on lots facing a road -> farm -> nature and decor -> validation (every open door, stall,
 * the farm gate and the gathering spots must be reachable from the spawn; otherwise the next attempt is tried).
 *
 * Output is plain data (no canvas, no DOM): tiles, buildings, market stalls, farm plots, signs, chunks. The engine
 * turns it into its map structure; the server uses it to check where things can be gathered.
 * Works as a classic browser script (window.GTVillage) and as an ES module side effect in Node (globalThis.GTVillage).
 */
(function (root) {
  'use strict';

  var CH = 32, NC = 3, W = CH * NC, H = CH * NC, VERSION = 1;

  /* ---------------------------------------------------------------- PRNG and noise (deterministic everywhere) */
  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function makeR(seed) {
    var f = mulberry32(seed >>> 0), r = { f: f };
    r.int = function (a, b) { return a + Math.floor(f() * (b - a + 1)); };
    r.pick = function (arr) { return arr[Math.floor(f() * arr.length)]; };
    r.chance = function (p) { return f() < p; };
    r.shuffle = function (arr) { for (var i = arr.length - 1; i > 0; i--) { var j = Math.floor(f() * (i + 1)); var t = arr[i]; arr[i] = arr[j]; arr[j] = t; } return arr; };
    return r;
  }
  function hash3(a, b, c) { var h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 1274126177)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
  function noise(seed, x, y) {
    var x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    var a = hash3(x0, y0, seed), b = hash3(x0 + 1, y0, seed), c = hash3(x0, y0 + 1, seed), d = hash3(x0 + 1, y0 + 1, seed);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }

  /* ---------------------------------------------------------------- chunks */
  var CHUNKS = [
    { cx: 0, cy: 0, id: 'bukit', name: 'Bukit Barat Laut', biome: 'forest', open: false },
    { cx: 1, cy: 0, id: 'hutan', name: 'Hutan Utara', biome: 'forest', open: true },
    { cx: 2, cy: 0, id: 'hutan-timur', name: 'Hutan Timur', biome: 'forest', open: false },
    { cx: 0, cy: 1, id: 'ladang', name: 'Ladang Barat', biome: 'fields', open: true },
    { cx: 1, cy: 1, id: 'desa', name: 'Desa Genesis', biome: 'village', open: true },
    { cx: 2, cy: 1, id: 'seberang', name: 'Dusun Seberang', biome: 'hamlet', open: false, project: 'jembatan-timur' },
    { cx: 0, cy: 2, id: 'rawa', name: 'Rawa Selatan', biome: 'meadow', open: false },
    { cx: 1, cy: 2, id: 'padang', name: 'Padang Selatan', biome: 'meadow', open: false },
    { cx: 2, cy: 2, id: 'danau', name: 'Danau Tenggara', biome: 'lake', open: false }
  ];
  // Town projects that open a chunk when completed. What they need lives in economy/config.json and on chain
  // (create_project); here only the name, for the map's signs.
  var PROJECTS = {
    'jembatan-timur': { chunk: 'seberang', name: 'Jembatan ke Dusun Seberang' }
  };

  // Tiles that block walking (must match the engine's SOLID set for the tiles this generator uses).
  var SOLID = { tree: 1, fence: 1, sign: 1, mailbox: 1, rock: 1, water: 1, bush: 1, barrel: 1, crate: 1, stall: 1, lamp: 1 };
  var SOFT = { grass: 1, flower: 1, tallgrass: 1 }; // free ground that can be built on

  function chunkAt(x, y, rx1) {
    var cx = Math.min(NC - 1, Math.max(0, Math.floor(x / CH))), cy = Math.min(NC - 1, Math.max(0, Math.floor(y / CH)));
    // the river is the border between the middle and east columns: water and its west bank belong to the middle
    if (rx1) { var e = rx1[Math.max(0, Math.min(H - 1, y))]; if (cx === 2 && x <= e) cx = 1; else if (cx === 1 && x > e) cx = 2; }
    return CHUNKS[cy * NC + cx];
  }

  /* ---------------------------------------------------------------- generator */
  function tryGen(seed, att, unlocked) {
    var R = makeR((seed + att * 7919) >>> 0), ns = (seed ^ 0x51f15e) >>> 0;
    var tiles = new Array(W * H).fill('grass');
    var res = new Uint8Array(W * H); // 1 = reserved (roads, buildings, plaza, farm)
    var info = {}; // tile index -> text
    var buildings = [];
    function I(x, y) { return y * W + x; }
    function inb(x, y) { return x >= 1 && y >= 1 && x < W - 1 && y < H - 1; }
    function get(x, y) { return inb(x, y) ? tiles[I(x, y)] : 'tree'; }
    function set(x, y, t) { if (inb(x, y)) tiles[I(x, y)] = t; }
    function free(x, y) { return inb(x, y) && !res[I(x, y)] && SOFT[tiles[I(x, y)]]; }
    var rx1 = null;
    function isOpen(x, y) { var c = chunkAt(x, y, rx1); return c.open || unlocked.indexOf(c.id) >= 0; }

    /* --- river: meanders north to south; its middle stays near the core's east edge */
    var rx0 = 62 + R.int(-1, 1), p1 = R.f() * 6.28, p2 = R.f() * 6.28;
    var river = [];
    for (var y = 0; y < H; y++) {
      var cx = Math.round(rx0 + 3 * Math.sin(y * 0.085 + p1) + 1.5 * Math.sin(y * 0.21 + p2));
      var wdt = 3 + (Math.sin(y * 0.13 + p2) > 0.6 ? 1 : 0);
      river.push({ x0: cx - 1, x1: cx - 2 + wdt });
      for (var x = cx - 1; x <= cx - 2 + wdt; x++) if (x >= 0 && x < W) tiles[I(x, y)] = 'water';
    }
    function riverWest(y) { return river[y].x0; }
    rx1 = river.map(function (r) { return r.x1; });
    function chunkAtR(x, y) { return chunkAt(x, y, rx1); }

    /* --- roads */
    function road(x, y) { if (!inb(x, y)) return; if (tiles[I(x, y)] === 'water') { tiles[I(x, y)] = 'bridgeway'; res[I(x, y)] = 1; return; } tiles[I(x, y)] = 'path'; res[I(x, y)] = 1; }
    function line(ax, ay, bx, by, hFirst) {
      var x, y;
      if (hFirst) { for (x = ax; x !== bx; x += bx > ax ? 1 : -1) road(x, ay); for (y = ay; y !== by; y += by > ay ? 1 : -1) road(bx, y); }
      else { for (y = ay; y !== by; y += by > ay ? 1 : -1) road(ax, y); for (x = ax; x !== bx; x += bx > ax ? 1 : -1) road(x, by); }
      road(bx, by);
    }
    function poly(pts) { for (var k = 1; k < pts.length; k++) line(pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1], R.chance(0.5)); }

    // plaza (7 x 6) in the core, west of the river
    var px = R.int(41, 46), py = R.int(42, 47);
    var plaza = { x0: px - 3, y0: py - 2, x1: px + 3, y1: py + 3 };
    for (y = plaza.y0; y <= plaza.y1; y++) for (x = plaza.x0; x <= plaza.x1; x++) { tiles[I(x, y)] = 'plaza'; res[I(x, y)] = 1; }
    var ry = plaza.y1 + 1; // the main east-west road runs along the plaza's south side
    var bridgeY = ry;
    // main east-west road: west edge -> plaza -> river (bridge) -> Dusun Seberang
    poly([[2, ry + R.int(-3, 3)], [R.int(12, 18), ry + R.int(-2, 2)], [R.int(26, 30), ry + R.int(-1, 1)], [plaza.x0 - 1, ry], [riverWest(ry) - 2, ry]]);
    for (x = riverWest(ry) - 2; x <= river[ry].x1 + 2; x++) road(x, ry);
    poly([[river[ry].x1 + 2, ry], [R.int(74, 80), ry + R.int(-2, 2)], [W - 3, ry + R.int(-3, 3)]]);
    // north-south road: from the plaza's north side into the forest, and south out of the village
    poly([[px, plaza.y0 - 1], [px + R.int(-2, 2), R.int(30, 34)], [px + R.int(-4, 4), R.int(14, 20)], [px + R.int(-3, 3), 4]]);
    poly([[px + R.int(-1, 1), ry], [px + R.int(-3, 3), R.int(64, 70)], [px + R.int(-5, 5), H - 3]]);
    // a loop of lanes around the plaza gives the core its street frontage (buildings sit north of a lane)
    var east = Math.min(px + R.int(9, 12), riverWest(py) - 4), west = px - R.int(10, 13);
    var top = plaza.y0 - R.int(6, 8), bot = ry + R.int(6, 8);
    poly([[px, top], [west, top + R.int(-1, 1)], [west + R.int(-1, 1), ry]]);
    poly([[px, top], [east, top + R.int(-1, 1)], [east, ry]]);
    poly([[west + R.int(-1, 1), ry], [west, bot], [px + R.int(-2, 2), bot + R.int(-1, 1)], [east, bot], [east, ry]]);
    // side lanes: short branches off the main roads, ending in a turning spot
    function lane(sx, sy, dx, dy, len) {
      var x = sx, y = sy, k;
      for (k = 0; k < len; k++) {
        x += dx; y += dy;
        if (!inb(x, y) || tiles[I(x, y)] === 'water' || (res[I(x, y)] && tiles[I(x, y)] !== 'path')) break;
        road(x, y);
        if (k > 3 && R.chance(0.12)) { var t = dx; dx = dy; dy = t; } // occasional bend
      }
    }
    for (var li = 0; li < 5; li++) { var lx = R.int(8, plaza.x0 - 3); lane(lx, ry, 0, R.chance(0.5) ? -1 : 1, R.int(6, 10)); }
    lane(plaza.x1 + R.int(2, 4), ry, 0, 1, R.int(6, 9));
    lane(px, R.int(34, 38), -1, 0, R.int(6, 9));
    lane(px, R.int(30, 36), 1, 0, R.int(5, 8));
    lane(R.int(70, 84), ry, 0, R.chance(0.5) ? -1 : 1, R.int(5, 8));

    /* --- buildings on lots that face a road */
    // A lot fits when its footprint plus a 1-tile margin is free, inside the wanted chunks, and a straight path of at
    // most 4 tiles runs from the door down to a road.
    function fits(x0, y0, w, h, chunks) {
      if (x0 < 2 || y0 < 2 || x0 + w > W - 2 || y0 + h > H - 3) return false;
      for (var y = y0 - 1; y <= y0 + h; y++) for (var x = x0 - 1; x <= x0 + w; x++) {
        if (!free(x, y) && !(y === y0 + h && tiles[I(x, y)] === 'path')) return false;
        if (chunks.indexOf(chunkAtR(x, y).id) < 0) return false;
      }
      return true;
    }
    function stubLen(dx, y) { for (var k = 1; k <= 5; k++) { var t = get(dx, y + k); if (t === 'path' || t === 'plaza') return k; if (!free(dx, y + k)) return -1; } return -1; }
    function lots(w, h, chunks, scoreFn) {
      var out = [], bx0 = W, by0 = H, bx1 = 0, by1 = 0;
      CHUNKS.forEach(function (c) { if (chunks.indexOf(c.id) < 0) return; bx0 = Math.min(bx0, c.cx * CH); by0 = Math.min(by0, c.cy * CH); bx1 = Math.max(bx1, c.cx * CH + CH); by1 = Math.max(by1, c.cy * CH + CH); });
      for (var y0 = Math.max(2, by0); y0 < Math.min(H - h - 3, by1); y0++) for (var x0 = Math.max(2, bx0); x0 < Math.min(W - w - 2, bx1); x0++) {
        if (!fits(x0, y0, w, h, chunks)) continue;
        var dx = x0 + (w >> 1), dy = y0 + h - 1, s = stubLen(dx, dy);
        if (s < 1) continue;
        out.push({ x: x0, y: y0, dx: dx, dy: dy, stub: s, score: scoreFn(x0 + w / 2, y0 + h / 2) - s * 0.6 + R.f() * 2 });
      }
      out.sort(function (a, b) { return b.score - a.score; });
      return out;
    }
    function place(kind, name, w, h, chunks, scoreFn, extra) {
      var c = lots(w, h, chunks, scoreFn)[0];
      if (!c) return null;
      var b = { kind: kind, name: name, x: c.x, y: c.y, w: w, h: h, dx: c.dx, dy: c.dy, chunk: chunkAtR(c.dx, c.dy).id };
      for (var k in extra || {}) b[k] = extra[k];
      for (var y = c.y; y < c.y + h; y++) for (var x = c.x; x < c.x + w; x++) { res[I(x, y)] = 1; tiles[I(x, y)] = 'grass'; }
      for (var s = 1; s < c.stub; s++) road(c.dx, c.dy + s);
      // keep the tile in front of the door clear
      res[I(c.dx, c.dy + 1)] = 1;
      buildings.push(b);
      return b;
    }
    function near(tx, ty, ideal) { return function (x, y) { var d = Math.abs(x - tx) + Math.abs(y - ty); return -Math.abs(d - ideal) * 1.2; }; }

    // landmarks, most important first
    var core = ['desa'];
    if (!place('hall', 'Balai Desa', 5, 4, core, near(px, py, 8))) return null;
    if (!place('church', 'Gereja Desa', 5, 5, core.concat(['hutan']), function (x, y) { return near(px, py, 12)(x, y) - (y > py ? 6 : 0); })) return null;
    if (!place('broker', 'Kantor Makelar', 4, 3, core, near(px, py, 7))) return null;
    if (!place('post', 'Kantor Pos', 4, 3, core, near(px, py, 9))) return null;
    if (!place('clinic', 'Puskesmas', 4, 3, core, near(px, py, 11))) return null;
    if (!place('warung', 'Warung Kopi', 4, 3, core, near(px, ry, 6))) return null;

    // the player's house with the farm next to it, in Ladang Barat near the main road
    var own = place('house', null, 3, 3, ['ladang'], function (x, y) { return -Math.abs(x - 24) * 0.8 - Math.abs(y - ry) * 1.5; }, { own: true, style: R.int(0, 3) });
    if (!own) return null;
    // farm: 7 x 6 fenced field west or east of the house (fence ring, 5 x 3 soil plots, a walking row, gate south)
    var farm = null;
    var spotsF = [];
    [-9, 5, -10, 6, -11, 7].forEach(function (ox) { [-1, -2, 0, -3].forEach(function (oy) { spotsF.push([own.x + ox, own.y + oy]); }); });
    spotsF.some(function (p) {
      var fx = p[0], fy = p[1];
      for (var y = fy - 1; y <= fy + 6; y++) for (var x = fx - 1; x <= fx + 7; x++) if (!free(x, y) && !(y >= fy + 5 && tiles[I(x, y)] === 'path')) return false;
      farm = { x0: fx, y0: fy, x1: fx + 6, y1: fy + 5, plots: [], gate: { x: fx + 3, y: fy + 5 } };
      return true;
    });
    if (!farm) return null;
    for (x = farm.x0; x <= farm.x1; x++) { set(x, farm.y0, 'fence'); set(x, farm.y1, x === farm.gate.x ? 'path' : 'fence'); }
    for (y = farm.y0; y <= farm.y1; y++) { set(farm.x0, y, 'fence'); set(farm.x1, y, 'fence'); }
    for (y = farm.y0; y <= farm.y1; y++) for (x = farm.x0; x <= farm.x1; x++) res[I(x, y)] = 1;
    for (y = farm.y0 + 1; y <= farm.y0 + 3; y++) for (x = farm.x0 + 1; x <= farm.x1 - 1; x++) { set(x, y, 'soil'); farm.plots.push({ x: x, y: y }); }
    // path from the gate to the nearest road (straight down, then sideways)
    (function () { var y = farm.gate.y + 1; while (inb(farm.gate.x, y) && get(farm.gate.x, y) !== 'path' && y < farm.gate.y + 8) { if (!free(farm.gate.x, y)) break; road(farm.gate.x, y); y++; } })();

    // houses: the core and the fields first, then the hamlet across the river and a hut in the forest
    var housePlan = [['desa', 7], ['ladang', 4], ['seberang', 5], ['hutan', 1], ['padang', 2]];
    housePlan.forEach(function (hp) {
      for (var n = 0; n < hp[1]; n++) {
        var anchor = hp[0] === 'desa' ? [px, py] : hp[0] === 'seberang' ? [78, ry] : hp[0] === 'ladang' ? [18, ry] : hp[0] === 'padang' ? [px, 72] : [px, 18];
        place('house', null, 3, 3, [hp[0]], near(anchor[0], anchor[1], R.int(3, 10)), { style: R.int(0, 3) });
      }
    });

    // market stalls in the plaza: one row, merchants stand behind (north), customers in front
    var stallColors = ['#e8503c', '#4a8ad8', '#e8a13c', '#58a858'], market = { stalls: [] };
    [plaza.x0 + 1, plaza.x0 + 2, plaza.x0 + 4, plaza.x0 + 5].forEach(function (sx, k) {
      tiles[I(sx, plaza.y0 + 1)] = 'stall';
      market.stalls.push({ x: sx, y: plaza.y0 + 1, seat: { x: sx, y: plaza.y0 }, color: stallColors[k] });
    });
    tiles[I(plaza.x0, plaza.y1)] = 'crate'; tiles[I(plaza.x1, plaza.y1)] = 'barrel';
    info[I(plaza.x0 + 3, plaza.y0)] = 'Pasar Genesis. Pedagang berjualan di sini setiap hari.';

    /* --- nature */
    var mine = null;
    for (y = 1; y < H - 1; y++) for (x = 1; x < W - 1; x++) {
      if (res[I(x, y)] || tiles[I(x, y)] !== 'grass') continue;
      var c = chunkAtR(x, y), n1 = noise(ns, x / 7, y / 7), n2 = noise(ns + 7, x / 3, y / 3), roll = hash3(x, y, ns + 3);
      var nearRoad = get(x - 1, y) === 'path' || get(x + 1, y) === 'path' || get(x, y - 1) === 'path' || get(x, y + 1) === 'path';
      if (c.biome === 'forest') { if (n1 > 0.36 && !nearRoad && roll < 0.7) set(x, y, 'tree'); else if (roll < 0.12) set(x, y, 'tallgrass'); else if (roll < 0.15) set(x, y, 'bush'); }
      else if (c.biome === 'village') { if (n1 > 0.72 && !nearRoad && roll < 0.55) set(x, y, 'tree'); else if (n2 > 0.75 && roll < 0.3) set(x, y, 'flower'); else if (roll < 0.04) set(x, y, 'tallgrass'); else if (n1 > 0.62 && roll < 0.08 && !nearRoad) set(x, y, 'bush'); }
      else if (c.biome === 'fields') { if (n1 > 0.7 && !nearRoad && roll < 0.5) set(x, y, 'tree'); else if (n2 > 0.55 && roll < 0.35) set(x, y, 'tallgrass'); else if (roll < 0.05) set(x, y, 'flower'); }
      else if (c.biome === 'meadow' || c.biome === 'hamlet') { if (n1 > 0.66 && !nearRoad && roll < 0.55) set(x, y, 'tree'); else if (n2 > 0.5 && roll < 0.25) set(x, y, roll < 0.1 ? 'flower' : 'tallgrass'); }
      else if (c.biome === 'lake') { if (n1 > 0.42) set(x, y, 'water'); else if (roll < 0.2) set(x, y, 'tallgrass'); }
    }
    // the mine: a rocky clearing at the end of the north road, with a sign
    (function () {
      var mx = px + R.int(-6, 6), my = R.int(7, 12), k;
      mine = { x: mx, y: my };
      for (var y = my - 3; y <= my + 3; y++) for (var x = mx - 4; x <= mx + 4; x++) if (inb(x, y) && !res[I(x, y)] && tiles[I(x, y)] !== 'water') set(x, y, 'sand');
      for (k = 0; k < 40; k++) {
        var x = mx + R.int(-4, 4), y = my + R.int(-3, 3);
        if (inb(x, y) && !res[I(x, y)] && tiles[I(x, y)] === 'sand' && hash3(x, y, ns + 11) < 0.55) set(x, y, 'rock');
      }
      // connect the clearing to the nearest road tile below it
      var best = null;
      for (var yy = my + 4; yy < CH + 4; yy++) for (var xx = mx - 14; xx <= mx + 14; xx++) {
        if (get(xx, yy) !== 'path') continue;
        var dd = Math.abs(xx - mx) + Math.abs(yy - my - 3);
        if (!best || dd < best.d) best = { x: xx, y: yy, d: dd };
      }
      if (best) line(mx, my + 3, best.x, best.y, false);
      var sx = mx + 1, sy = my + 4;
      if (free(sx, sy)) { set(sx, sy, 'sign'); info[I(sx, sy)] = 'Tambang Utara. Bijih di bebatuan; bawa Alat.'; res[I(sx, sy)] = 1; }
    })();
    // the pond in Ladang Barat with a sandy shore
    (function () {
      for (var tries = 0; tries < 40; tries++) {
        var cx = R.int(5, 26), cy = R.int(36, 58), rw = R.int(2, 3), rh = R.int(2, 3), ok = true, x, y;
        for (y = cy - rh - 1; y <= cy + rh + 1 && ok; y++) for (x = cx - rw - 1; x <= cx + rw + 1 && ok; x++) if (!inb(x, y) || res[I(x, y)] || chunkAtR(x, y).id !== 'ladang') ok = false;
        if (!ok) continue;
        for (y = cy - rh - 1; y <= cy + rh + 1; y++) for (x = cx - rw - 1; x <= cx + rw + 1; x++) {
          var dd = ((x - cx) * (x - cx)) / ((rw + 0.5) * (rw + 0.5)) + ((y - cy) * (y - cy)) / ((rh + 0.5) * (rh + 0.5));
          if (dd <= 1) set(x, y, 'water'); else if (dd <= 1.9) set(x, y, 'sand');
        }
        return;
      }
    })();
    // sandy spots along the river banks (fishing places)
    for (y = 2; y < H - 2; y++) {
      [river[y].x0 - 1, river[y].x1 + 1].forEach(function (bx) { if (!res[I(bx, y)] && SOFT[tiles[I(bx, y)]] && hash3(bx, y, ns + 5) < 0.45) tiles[I(bx, y)] = 'sand'; });
    }
    // decor around houses: a mailbox, flowers beside the door, a barrel or crate by the wall
    buildings.forEach(function (b) {
      if (b.kind !== 'house') return;
      [b.x + b.w, b.x - 1].some(function (mx) { var my = b.y + b.h - 1; if (free(mx, my) && get(mx, my + 1) !== 'path') { set(mx, my, 'mailbox'); res[I(mx, my)] = 1; b.mail = I(mx, my); return true; } return false; });
      [b.dx - 1, b.dx + 1].forEach(function (fx) { if (free(fx, b.dy + 1)) set(fx, b.dy + 1, 'flower'); });
      var side = R.chance(0.5) ? b.x - 1 : b.x + b.w;
      if (free(side, b.y + 1)) { set(side, b.y + 1, R.chance(0.5) ? 'barrel' : 'crate'); res[I(side, b.y + 1)] = 1; }
    });
    // signs at chunk borders that are still locked, where a road enters them
    var signs = [];
    for (y = 1; y < H - 1; y++) for (x = 1; x < W - 1; x++) {
      if (tiles[I(x, y)] !== 'path' && tiles[I(x, y)] !== 'bridgeway') continue;
      if (!isOpen(x, y)) continue;
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) {
        var nx = x + d[0], ny = y + d[1];
        if (!inb(nx, ny) || isOpen(nx, ny)) return;
        var lc = chunkAtR(nx, ny);
        if (tiles[I(nx, ny)] !== 'path' && tiles[I(nx, ny)] !== 'bridgeway') return;
        signs.push({ x: nx, y: ny, chunk: lc.id });
      });
    }
    // the bridge: planks if Dusun Seberang is open, otherwise the river stays open water
    var seberangOpen = isOpen(river[bridgeY].x1 + 1, bridgeY);
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) if (tiles[I(x, y)] === 'bridgeway') {
      tiles[I(x, y)] = seberangOpen ? 'bridge' : 'water';
      if (!seberangOpen) signs.push({ x: x, y: y, chunk: 'seberang' });
    }
    // border ring of trees
    for (x = 0; x < W; x++) { tiles[I(x, 0)] = 'tree'; tiles[I(x, H - 1)] = 'tree'; }
    for (y = 0; y < H; y++) { tiles[I(0, y)] = 'tree'; tiles[I(W - 1, y)] = 'tree'; }

    /* --- spawn and validation */
    var spawn = { x: own.dx, y: own.dy + 1 };
    var walk = new Uint8Array(W * H);
    for (var i = 0; i < W * H; i++) walk[i] = SOLID[tiles[i]] || res[i] && tiles[i] === 'grass' && isBuildingTile(i) ? 0 : 1;
    function isBuildingTile(i) { var x = i % W, y = (i / W) | 0; for (var k = 0; k < buildings.length; k++) { var b = buildings[k]; if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) return true; } return false; }
    for (i = 0; i < W * H; i++) if (!isOpen(i % W, (i / W) | 0)) walk[i] = 0;
    var reach = bfs(walk, spawn.x, spawn.y);
    function ok(x, y) { return reach[I(x, y)] === 1; }
    if (!ok(spawn.x, spawn.y)) return null;
    for (var k = 0; k < buildings.length; k++) { var b = buildings[k]; if (isOpen(b.dx, b.dy) && !ok(b.dx, b.dy + 1)) return null; }
    for (k = 0; k < market.stalls.length; k++) if (!ok(market.stalls[k].x, market.stalls[k].y + 1) || !ok(market.stalls[k].seat.x, market.stalls[k].seat.y)) return null;
    if (!ok(farm.gate.x, farm.gate.y)) return null;
    // enough reachable gathering spots of each kind
    var spots = { water: 0, rock: 0, tree: 0 };
    for (y = 1; y < H - 1; y++) for (x = 1; x < W - 1; x++) {
      var t = tiles[I(x, y)];
      if (!spots.hasOwnProperty(t) || !isOpen(x, y)) continue;
      if (ok(x - 1, y) || ok(x + 1, y) || ok(x, y - 1) || ok(x, y + 1)) spots[t]++;
    }
    if (spots.water < 12 || spots.rock < 8 || spots.tree < 30) return null;

    signs.forEach(function (s) {
      var lc = CHUNKS.filter(function (c) { return c.id === s.chunk; })[0], pj = lc.project && PROJECTS[lc.project];
      info[I(s.x, s.y)] = lc.name + (pj ? ' belum bisa dicapai: jembatannya belum ada. Bahan untuk ' + pj.name + ' dikumpulkan di Balai Desa.' : ' belum dibuka.');
    });

    var houseN = 0;
    buildings.forEach(function (b, k) { b.id = k; b.open = isOpen(b.dx, b.dy); if (b.kind === 'house') b.houseNo = houseN++; });
    return {
      version: VERSION, seed: seed, attempt: att, w: W, h: H, chunk: CH, riverX1: rx1,
      tiles: tiles, info: info, buildings: buildings, market: market,
      farm: { plots: farm.plots, gate: farm.gate, x0: farm.x0, y0: farm.y0, x1: farm.x1, y1: farm.y1 },
      plaza: plaza, mine: mine, spawn: spawn, river: { y: bridgeY, x0: river[bridgeY].x0, x1: river[bridgeY].x1 },
      chunks: CHUNKS.map(function (c) { return { id: c.id, name: c.name, cx: c.cx, cy: c.cy, biome: c.biome, open: c.open || unlocked.indexOf(c.id) >= 0, project: c.project || null }; }),
      projects: PROJECTS, spots: spots
    };
  }

  function bfs(walk, sx, sy) {
    var seen = new Uint8Array(W * H), q = [sx, sy], head = 0;
    if (!walk[sy * W + sx]) return seen;
    seen[sy * W + sx] = 1;
    while (head < q.length) {
      var x = q[head++], y = q[head++];
      for (var d = 0; d < 4; d++) {
        var nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0), ny = y + (d === 2 ? 1 : d === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        var ni = ny * W + nx;
        if (seen[ni] || !walk[ni]) continue;
        seen[ni] = 1; q.push(nx, ny);
      }
    }
    return seen;
  }

  /** Generates the world for a seed. `unlocked` lists chunk ids opened by finished town projects. */
  function generate(seed, unlocked) {
    seed = seed >>> 0; unlocked = (unlocked || []).slice().sort();
    // The attempt is always chosen with every project area closed, then reused with the opened areas, so opening an
    // area only adds the bridge and lifts the fog: nothing already built moves.
    for (var att = 0; att < 60; att++) {
      var base = tryGen(seed, att, []);
      if (!base) continue;
      var L = unlocked.length ? tryGen(seed, att, unlocked) : base;
      if (L) { L.unlocked = unlocked; return L; }
    }
    throw new Error('village: no valid layout for seed ' + seed);
  }

  /** The chunk a tile is in, and whether it's open. */
  function chunkOf(L, x, y) { var c = chunkAt(x, y, L.riverX1); return L.chunks.filter(function (q) { return q.id === c.id; })[0]; }

  /* ---------------------------------------------------------------- weather (same for every player on a day) */
  // Semi: showers; Panas: mostly bright sun; Gugur: rain; Dingin: snow. `wet` days water the farm by themselves.
  var WEATHER = {
    semi:   [['cerah', 0.45], ['berawan', 0.25], ['hujan', 0.30]],
    panas:  [['terik', 0.65], ['cerah', 0.25], ['hujan', 0.10]],
    gugur:  [['berawan', 0.35], ['hujan', 0.40], ['cerah', 0.25]],
    dingin: [['salju', 0.55], ['berawan', 0.25], ['cerah', 0.20]]
  };
  var WEATHER_LABEL = { cerah: 'Cerah', berawan: 'Berawan', hujan: 'Hujan', terik: 'Terik', salju: 'Salju' };
  function weather(seed, day, season) {
    var table = WEATHER[season] || WEATHER.semi, r = hash3(seed | 0, day | 0, 0x3ea7), acc = 0;
    for (var i = 0; i < table.length; i++) { acc += table[i][1]; if (r < acc) break; }
    var kind = table[Math.min(i, table.length - 1)][0];
    return { kind: kind, label: WEATHER_LABEL[kind], wet: kind === 'hujan' };
  }

  /* ---------------------------------------------------------------- forest monsters (where they roam each hour) */
  // Boars roam the forest of Hutan Utara, bats hang around the mine. Each game hour every monster stands somewhere
  // new near its home; the browser animates it wandering around that spot, the server checks fights against it.
  function monsterCandidates(L) {
    if (L._mc) return L._mc;
    var boar = [], bat = [], free = { grass: 1, tallgrass: 1, flower: 1, sand: 1 };
    var inB = function (x, y) { for (var k = 0; k < L.buildings.length; k++) { var b = L.buildings[k]; if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) return true; } return false; };
    for (var y = 1; y < L.h - 1; y++) for (var x = 1; x < L.w - 1; x++) {
      if (!free[L.tiles[y * L.w + x]] || inB(x, y) || chunkOf(L, x, y).id !== 'hutan') continue;
      var dm = L.mine ? Math.abs(x - L.mine.x) + Math.abs(y - L.mine.y) : 99;
      if (dm <= 6) bat.push([x, y]); else if (y < 28) boar.push([x, y]);
    }
    L._mc = { boar: boar, bat: bat };
    return L._mc;
  }
  function monstersAt(L, hour, counts) {
    counts = counts || { boar: 5, bat: 3 };
    var c = monsterCandidates(L), out = [];
    Object.keys(counts).forEach(function (kind) {
      var pool = c[kind] || [];
      if (!pool.length) return;
      for (var i = 0; i < counts[kind]; i++) {
        var p = pool[Math.floor(hash3(L.seed | 0, (hour | 0) * 31 + i, kind === 'bat' ? 0xba7 : 0xb0a2) * pool.length)];
        out.push({ id: kind + '-' + i, kind: kind, x: p[0], y: p[1] });
      }
    });
    return out;
  }

  /* ---------------------------------------------------------------- dock (travel to islands) */
  // The walkable shore tile (next to water) closest to the plaza that the spawn can reach. Computed after generation
  // from the finished layout: no RNG, no tile is changed, so existing maps stay exactly as they were.
  function dockOf(L) {
    if (L._dock) return L._dock;
    var w = L.w, h = L.h, walk = new Uint8Array(w * h), i, x, y;
    for (i = 0; i < w * h; i++) walk[i] = SOLID[L.tiles[i]] ? 0 : 1;
    L.buildings.forEach(function (b) { for (var yy = b.y; yy < b.y + b.h; yy++) for (var xx = b.x; xx < b.x + b.w; xx++) walk[yy * w + xx] = 0; });
    for (i = 0; i < w * h; i++) if (walk[i] && !chunkOf(L, i % w, (i / w) | 0).open) walk[i] = 0;
    var seen = new Uint8Array(w * h), q = [L.spawn.x, L.spawn.y], head = 0;
    seen[L.spawn.y * w + L.spawn.x] = 1;
    while (head < q.length) {
      x = q[head++]; y = q[head++];
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) {
        var nx = x + d[0], ny = y + d[1], ni = ny * w + nx;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || seen[ni] || !walk[ni]) return;
        seen[ni] = 1; q.push(nx, ny);
      });
    }
    var px = (L.plaza.x0 + L.plaza.x1) / 2, py = (L.plaza.y0 + L.plaza.y1) / 2, best = null, bd = Infinity;
    for (y = 1; y < h - 1; y++) for (x = 1; x < w - 1; x++) {
      i = y * w + x;
      var t = L.tiles[i];
      if (!seen[i] || t === 'bridge' || t === 'bridgeway') continue;
      if (L.tiles[i + 1] !== 'water' && L.tiles[i - 1] !== 'water' && L.tiles[i + w] !== 'water' && L.tiles[i - w] !== 'water') continue;
      var d = Math.abs(x - px) + Math.abs(y - py);
      if (d < bd) { bd = d; best = { x: x, y: y }; }
    }
    L._dock = best;
    return best;
  }

  var api = { VERSION: VERSION, W: W, H: H, CHUNK: CH, CHUNKS: CHUNKS, PROJECTS: PROJECTS, generate: generate, chunkOf: chunkOf, makeR: makeR, weather: weather, monstersAt: monstersAt, dockOf: dockOf };
  root.GTVillage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
