/*
 * homeland.js - the Homeland generator, shared by the browser and the server (same seed + progress = same world).
 *
 * Every player owns one Homeland: 3 x 3 chunks of 16 x 16 tiles (48 x 48 when fully open). The Town Hall stands in the
 * middle chunk 'c'; the eight outer chunks get a biome from the seed (forest, rock, pond, sea, meadow). Locked chunks are
 * fully generated too (the engine draws them under fog); progress only decides which chunks are open and which lots carry
 * a building. Progress never moves anything: biomes, trees, rocks, lots and the farm fence depend on the seed alone.
 *
 * Output has the same shape as GTVillage.generate (w, h, chunk, tiles, info, chunks, unlocked, buildings, market.stalls
 * (empty), farm {plots, gate, x0..y1}, plaza, spawn, attempt) plus `portal: {x, y}` (also exposed as `dock` for the
 * engine), `lots` and `spots`.
 *
 * Chunk ids, row-major: nw n ne / w c e / sw s se. Lot ids are `<kind>-<chunk>`, e.g. 'kolam-c', 'tambang-ne'.
 * Outer chunks also carry the work buildings of their land: a Penggergajian (sawmill) in the first forest, a Kincir Angin
 * (windmill) in the first meadow (else the first other dry chunk), both north-east of the chunk's cross, and a Gudang
 * (storehouse) south-west of the cross in the first dry chunk next to the centre.
 * A lot is a 3 x 3 ground area; its door is the bottom-middle tile, and the tile below the door is the way in.
 *
 * Works as a classic browser script (window.GTHomeland) and as an ES module side effect in Node (globalThis.GTHomeland).
 */
(function (root) {
  'use strict';
  // Text: in the browser $t is the i18n layer (js/i18n.js); on the server (no window) these keys fall back to English.
  var EN_TEXT = {
    "Hutan": "Forest",
    "Bukit Batu": "Rocky Hills",
    "Kolam": "Pond",
    "Pantai": "Beach",
    "Padang": "Meadow",
    "Kolam Ikan": "Fish Pond",
    "Tambang": "Mine",
    "Restoran": "Restaurant",
    "Rumah Pekerja": "Workers' House",
    "Rumah Sakit": "Hospital",
    "Penggergajian": "Sawmill",
    "Kincir Angin": "Windmill",
    "Gudang": "Storehouse",
    "Balai Kota": "Town Hall",
    "Rumahmu": "Your House",
    "Pusat Desa": "Village Center"
  };
  var $t = root.$t || function (k, v) { var s = EN_TEXT[k] || k; return v ? s.replace(/\{(\d+)\}/g, function (m, i) { return v[i]; }) : s; };

  var VERSION = 3, CH = 16, N = 3, W = CH * N, H = CH * N;
  var CHUNKS = ['nw', 'n', 'ne', 'w', 'c', 'e', 'sw', 's', 'se'];
  var ORTHO = ['n', 'w', 'e', 's'];
  var SOLID = { tree: 1, fence: 1, sign: 1, mailbox: 1, rock: 1, water: 1, bush: 1, barrel: 1, crate: 1, stall: 1, lamp: 1, void: 1 };
  var NAMES = { forest: $t('Hutan'), rock: $t('Bukit Batu'), pond: $t('Kolam'), sea: $t('Pantai'), meadow: $t('Padang') };
  var KIND_NAMES = { kolam: $t('Kolam Ikan'), tambang: $t('Tambang'), restoran: $t('Restoran'), rumah: $t('Rumah Pekerja'), rumahsakit: $t('Rumah Sakit'),
    penggergajian: $t('Penggergajian'), kincir: $t('Kincir Angin'), gudang: $t('Gudang') };
  var MAX_PLOTS = 6;
  var FIELD = [3, 2]; // plots across x down: the fence always encloses the biggest field (6 plots)

  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function makeR(seed) {
    var f = mulberry32(seed), r = { f: f };
    r.int = function (a, b) { return a + Math.floor(f() * (b - a + 1)); };
    return r;
  }
  function hash3(a, b, c) { var h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 1274126177)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }

  function I(x, y) { return y * W + x; }
  var DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  /** Breadth-first search over walkable tiles. Returns the seen map. */
  function bfs(walk, sx, sy) {
    var seen = new Uint8Array(W * H), q = [sx, sy], head = 0;
    if (!walk[I(sx, sy)]) return seen;
    seen[I(sx, sy)] = 1;
    while (head < q.length) {
      var x = q[head++], y = q[head++];
      for (var d = 0; d < 4; d++) {
        var nx = x + DIRS[d][0], ny = y + DIRS[d][1];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        var ni = I(nx, ny);
        if (seen[ni] || !walk[ni]) continue;
        seen[ni] = 1; q.push(nx, ny);
      }
    }
    return seen;
  }

  /** The chunk id at a tile. */
  function chunkId(x, y) { return CHUNKS[Math.floor(y / CH) * N + Math.floor(x / CH)]; }

  function pickBiomes(R) {
    var table = ['forest', 'forest', 'forest', 'rock', 'rock', 'pond', 'pond', 'sea', 'sea', 'meadow', 'meadow'];
    var b = {}, i;
    CHUNKS.forEach(function (id) { if (id !== 'c') b[id] = table[R.int(0, table.length - 1)]; });
    function isWater(id) { return b[id] === 'pond' || b[id] === 'sea'; }
    var cand;
    // a forest next to the centre (prefer a chunk that is not the only water one)
    if (!ORTHO.some(function (id) { return b[id] === 'forest'; })) {
      cand = ORTHO.filter(function (id) { return !isWater(id); });
      if (!cand.length) cand = ORTHO;
      b[cand[R.int(0, cand.length - 1)]] = 'forest';
    }
    // a pond or sea next to the centre, never the forest one
    if (!ORTHO.some(isWater)) {
      cand = ORTHO.filter(function (id) { return b[id] !== 'forest'; });
      if (!cand.length) cand = ORTHO.filter(function (id) { return id !== ORTHO.filter(function (o) { return b[o] === 'forest'; })[0]; }); // all four forest: keep one
      b[cand[R.int(0, cand.length - 1)]] = R.int(0, 1) ? 'pond' : 'sea';
    }
    // a rock chunk somewhere: a corner if none exists
    if (!CHUNKS.some(function (id) { return b[id] === 'rock'; })) {
      var corners = ['nw', 'ne', 'sw', 'se'];
      b[corners[R.int(0, 3)]] = 'rock';
    }
    return b;
  }

  function tryGen(seed, att, th, prog) {
    var R = makeR((seed + att * 7919) >>> 0), ns = ((seed ^ 0x6b0f1d) + Math.imul(att, 101)) >>> 0;
    var biomes = pickBiomes(R);
    var tiles = new Array(W * H).fill('grass');
    var res = new Uint8Array(W * H);
    var x, y, i;
    function rect(x0, y0, x1, y1, fn) { for (var yy = y0; yy <= y1; yy++) for (var xx = x0; xx <= x1; xx++) fn(xx, yy); }
    function reserve(x0, y0, x1, y1) { rect(x0, y0, x1, y1, function (xx, yy) { res[I(xx, yy)] = 1; }); }
    function onCross(lx, ly) { return lx === 7 || lx === 8 || ly === 7 || ly === 8; }

    // the first rock chunk (row-major) carries the tambang lot
    var rockId = null;
    CHUNKS.forEach(function (id) { if (!rockId && biomes[id] === 'rock') rockId = id; });
    var lots = [];
    function addLot(kind, cid, lx, ly) {
      var ci = CHUNKS.indexOf(cid), ox = (ci % N) * CH, oy = Math.floor(ci / N) * CH;
      var gx = ox + lx, gy = oy + ly;
      lots.push({ id: kind + '-' + cid, kind: kind, chunk: cid, x: gx, y: gy, w: 3, h: 3, door: { x: gx + 1, y: gy + 2 } });
      reserve(gx - 1, gy - 1, gx + 3, gy + 3);
    }
    var cOx = CH, cOy = CH; // centre chunk origin
    addLot('kolam', 'c', 11, 2);
    addLot('restoran', 'c', 11, 6);
    addLot('rumahsakit', 'c', 11, 10);
    // the player's own house stands where the centre's Rumah Pekerja lot was, and that lot moves down between the house
    // and the farm, its door opening onto the field. Every world has it (generator 3; older worlds were upgraded too,
    // and a built centre Rumah Pekerja moves with its lot).
    var hasHouse = true;
    addLot('rumah', 'c', 1, hasHouse ? 6 : 2);
    if (rockId) addLot('tambang', rockId, 2, 2);
    // one Rumah Pekerja per outer chunk, beside the chunk's cross path (lot x 10..12, door row 12)
    CHUNKS.forEach(function (cid) { if (cid !== 'c') addLot('rumah', cid, rockId === cid ? 10 : 10, 9); });
    // work buildings by the land they stand on (lot x 10..12, y 2..4 north-east of the cross, or x 2..4, y 10..12
    // south-west of it): the sawmill in a forest, the windmill on a meadow (else a pond, rock or other forest chunk,
    // never the sea), the storehouse next to the centre on dry land (never the pond's corner, never the sea)
    function firstOf(list, kinds, not) {
      for (var k = 0; k < kinds.length; k++) for (var q = 0; q < list.length; q++) if (list[q] !== not && biomes[list[q]] === kinds[k]) return list[q];
      return null;
    }
    var outer = CHUNKS.filter(function (cid) { return cid !== 'c'; });
    var sawId = firstOf(outer, ['forest']);
    if (sawId) addLot('penggergajian', sawId, 10, 2);
    var millId = firstOf(outer, ['meadow', 'pond', 'rock', 'forest'], sawId);
    if (millId) addLot('kincir', millId, 10, 2);
    var storeId = firstOf(ORTHO, ['forest', 'meadow', 'rock']);
    if (storeId) addLot('gudang', storeId, 2, 10);

    // the Town Hall: 4 x 4, door on the bottom row (third tile), spawn one tile below the door
    var tx = cOx + 6, ty = cOy + 1, tdx = cOx + 8, tdy = cOy + 4;
    reserve(tx - 1, ty - 1, tx + 4, ty + 4);
    var spawn = { x: tdx, y: tdy + 1 };
    // the player's own house, built from the start, west of the Town Hall: 3 x 3, door on the path that runs past both
    var hx = cOx + 1, hy = cOy + 2, hdx = hx + 1, hdy = hy + 2;
    if (hasHouse) reserve(hx - 1, hy - 1, hx + 3, hy + 3);

    // the farm: fence ring with a one-tile margin around the biggest field, gate in the middle of the south fence
    var fw = FIELD[0] + 4, fh = FIELD[1] + 4;
    var fx0 = cOx, fy0 = cOy + 9, fx1 = fx0 + fw - 1, fy1 = fy0 + fh - 1;
    reserve(fx0, fy0 - 1, fx1 + 1, fy1 + 1);
    var gate = { x: fx0 + (fw >> 1), y: fy1 };

    // terrain per chunk
    CHUNKS.forEach(function (cid, ci) {
      if (cid === 'c') return;
      var cx = ci % N, cy = Math.floor(ci / N), ox = cx * CH, oy = cy * CH, biome = biomes[cid];
      var faceX = cx < 1 ? 1 : cx > 1 ? -1 : 0, faceY = cy < 1 ? 1 : cy > 1 ? -1 : 0; // direction towards the centre
      for (var ly = 0; ly < CH; ly++) for (var lx = 0; lx < CH; lx++) {
        var gx = ox + lx, gy = oy + ly, k = I(gx, gy), cross = onCross(lx, ly), free = !cross && !res[k];
        var h = hash3(gx, gy, ns);
        if (biome === 'forest') { if (free && h < 0.34) tiles[k] = 'tree'; else if (free && h < 0.4) tiles[k] = 'bush'; else if (!cross && h > 0.93) tiles[k] = 'tallgrass'; }
        else if (biome === 'rock') { if (free && h < 0.16) tiles[k] = 'rock'; else if (free && h < 0.2) tiles[k] = 'tree'; }
        else if (biome === 'meadow') { if (free && h < 0.04) tiles[k] = 'tree'; else if (!res[k] && h < 0.2) tiles[k] = 'flower'; else if (!res[k] && h < 0.36) tiles[k] = 'tallgrass'; }
        else if (biome === 'pond') {
          if (lx >= 1 && lx <= 6 && ly >= 9 && ly <= 14) tiles[k] = (lx >= 2 && lx <= 5 && ly >= 10 && ly <= 13) ? 'water' : 'sand';
          else if (free && h < 0.08) tiles[k] = 'tree'; else if (!res[k] && h < 0.2) tiles[k] = 'flower';
        } else if (biome === 'sea') {
          var beach = (faceX !== 0 && (faceX > 0 ? lx >= CH - 4 : lx < 4)) || (faceY !== 0 && (faceY > 0 ? ly >= CH - 4 : ly < 4));
          tiles[k] = (cross || beach) ? 'sand' : 'water';
          if (tiles[k] === 'sand' && !cross && h < 0.06) tiles[k] = 'rock';
        }
      }
    });

    // outer-chunk lots: dry ground under the lot, and a path from the way in west to the chunk's cross path
    lots.forEach(function (l) {
      if (l.chunk === 'c') return;
      for (var yy = l.y; yy <= l.y + 3; yy++) for (var xx = l.x; xx < l.x + 3; xx++) {
        if (yy === l.y + 3 && xx !== l.door.x) continue;
        var kk = I(xx, yy); if (SOLID[tiles[kk]] || tiles[kk] === 'water') tiles[kk] = biomes[l.chunk] === 'sea' ? 'sand' : 'grass';
      }
      var cOx2 = (CHUNKS.indexOf(l.chunk) % N) * CH;
      for (var xx2 = cOx2 + 8; xx2 <= l.door.x; xx2++) { var k3 = I(xx2, l.door.y + 1); if (SOLID[tiles[k3]] || tiles[k3] === 'water') tiles[k3] = 'path'; }
      // a lot west of the cross (the storehouse) gets its path east to the cross; the older Tambang lot keeps its ground
      if (l.kind !== 'tambang') for (var xx4 = l.door.x; xx4 <= cOx2 + 7; xx4++) { var k4 = I(xx4, l.door.y + 1); if (SOLID[tiles[k4]] || tiles[k4] === 'water') tiles[k4] = 'path'; }
    });

    // centre chunk: Town Hall ground, paths, farm, then trees and rocks to gather by hand
    function path(px, py) { if (tiles[I(px, py)] !== 'water') tiles[I(px, py)] = 'path'; }
    for (y = tdy + 1; y <= cOy + 15; y++) path(tdx, y);
    var portal = { x: tdx, y: cOy + 12 };
    lots.forEach(function (l) {
      if (l.chunk !== 'c') return;
      var fy = l.door.y + 1;
      path(l.door.x, fy);
      for (x = Math.min(l.door.x, tdx); x <= Math.max(l.door.x, tdx); x++) path(x, fy);
    });
    for (x = gate.x; x <= tdx; x++) path(x, gate.y + 1);
    if (hasHouse) for (x = hdx; x <= tdx; x++) path(x, hdy + 1); // the house's door to the Town Hall's
    // farm ring and plots
    for (x = fx0; x <= fx1; x++) { tiles[I(x, fy0)] = 'fence'; tiles[I(x, fy1)] = x === gate.x ? 'path' : 'fence'; }
    for (y = fy0; y <= fy1; y++) { tiles[I(fx0, y)] = 'fence'; tiles[I(fx1, y)] = 'fence'; }
    // the centre Rumah Pekerja's way in is a gap in the farm's top fence
    lots.forEach(function (l) { if (l.chunk === 'c' && l.door.y + 1 === fy0) tiles[I(l.door.x, fy0)] = 'path'; });
    var nPlots = Math.max(1, Math.min(MAX_PLOTS, th | 0));
    var plots = [];
    for (var pi = 0; pi < FIELD[0] * FIELD[1]; pi++) {
      var px = fx0 + 2 + (pi % FIELD[0]), py = fy0 + 2 + Math.floor(pi / FIELD[0]);
      if (pi < nPlots) { tiles[I(px, py)] = 'soil'; plots.push({ x: px, y: py }); }
    }
    for (y = cOy; y < cOy + CH; y++) for (x = cOx; x < cOx + CH; x++) {
      var lx2 = x - cOx, ly2 = y - cOy, k2 = I(x, y);
      if (tiles[k2] !== 'grass' || res[k2] || onCross(lx2, ly2)) continue;
      var hh = hash3(x, y, ns + 17);
      if (hh < 0.12) tiles[k2] = 'tree'; else if (hh < 0.16) tiles[k2] = 'rock'; else if (hh < 0.23) tiles[k2] = 'flower'; else if (hh < 0.3) tiles[k2] = 'tallgrass';
    }
    // Islands: every chunk floats on its own. The eight outer ones keep a two-tile gap of open sky ('void') all round, with
    // rounded, ragged corners; the centre keeps its whole square but loses its free corners. Plank bridges cross a gap
    // on the cross path (rows or columns 7 and 8) once the chunks on both sides are open, so opening a chunk is what
    // lays its bridge. Lots, buildings, paths and fences are never carved away.
    var isOpen = {}; ['c'].concat(prog.open || []).forEach(function (id) { isOpen[id] = 1; });
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      var lx3 = x % CH, ly3 = y % CH, cid3 = chunkId(x, y), k3 = I(x, y), t3 = tiles[k3];
      var ex = Math.min(lx3, CH - 1 - lx3), ey = Math.min(ly3, CH - 1 - ly3), keep = res[k3] || t3 === 'path' || t3 === 'fence' || t3 === 'soil';
      var vd;
      // (the centre's trees and rocks stay: they are what a new player gathers first)
      if (cid3 === 'c') vd = !keep && t3 !== 'tree' && t3 !== 'rock' && ex < 3 && ey < 3 && (3 - ex) * (3 - ex) + (3 - ey) * (3 - ey) > 5;
      else vd = ex < 2 || ey < 2 || (!keep && ((ex < 5 && ey < 5 && (5 - ex) * (5 - ex) + (5 - ey) * (5 - ey) > 10) || (Math.min(ex, ey) === 2 && hash3(x, y, ns + 41) < 0.3)));
      if (vd) tiles[k3] = 'void';
    }
    var bridgeAt = new Uint8Array(W * H); // every place a bridge can be, open or not (for the reachability check)
    function bridgeBetween(a, b) {
      var ia = CHUNKS.indexOf(a), ib = CHUNKS.indexOf(b), ax = (ia % N) * CH, ay = Math.floor(ia / N) * CH, bx = (ib % N) * CH, by = Math.floor(ib / N) * CH;
      var horiz = ay === by, x0 = Math.min(ax, bx), y0 = Math.min(ay, by);
      for (var j = CH - 4; j < CH + 4; j++) for (var q = 7; q <= 8; q++) { // only across the gap at the shared edge
        var gx = horiz ? x0 + j : x0 + q, gy = horiz ? y0 + q : y0 + j;
        if (tiles[I(gx, gy)] !== 'void') continue;
        bridgeAt[I(gx, gy)] = 1;
        if (isOpen[a] && isOpen[b]) tiles[I(gx, gy)] = 'bridge';
      }
    }
    for (var cy3 = 0; cy3 < N; cy3++) for (var cx3 = 0; cx3 < N; cx3++) {
      if (cx3 < N - 1) bridgeBetween(CHUNKS[cy3 * N + cx3], CHUNKS[cy3 * N + cx3 + 1]);
      if (cy3 < N - 1) bridgeBetween(CHUNKS[cy3 * N + cx3], CHUNKS[(cy3 + 1) * N + cx3]);
    }

    // keep the spawn and portal tiles clear and mark them
    tiles[I(spawn.x, spawn.y)] = 'path';
    tiles[I(portal.x, portal.y)] = 'path';
    for (i = 0; i < W * H; i++) if (tiles[i] === 'path') res[i] = 1;

    // buildings
    function bld(kind, x0, y0, w, h, dx, dy, extra) {
      var b = { kind: kind, name: KIND_NAMES[kind] || (kind === 'townhall' ? $t('Balai Kota') : kind), x: x0, y: y0, w: w, h: h, dx: dx, dy: dy, chunk: chunkId(dx, dy), open: true };
      for (var key in extra) b[key] = extra[key];
      return b;
    }
    var buildings = [bld('townhall', tx, ty, 4, 4, tdx, tdy, { name: $t('Balai Kota'), own: true, style: 0, id: 0 })];
    if (hasHouse) buildings.push(bld('house', hx, hy, 3, 3, hdx, hdy, { name: $t('Rumahmu'), own: true, style: R.int(0, 3) }));
    var byId = {};
    lots.forEach(function (l) { byId[l.id] = l; });
    (prog.built || []).forEach(function (b) {
      var l = byId[b.lot];
      if (l && l.kind === b.kind) buildings.push(bld(l.kind, l.x, l.y, l.w, l.h, l.door.x, l.door.y, { lot: l.id }));
    });

    // validation (nothing built, only the centre open, the biggest field): everything that matters is reachable
    var walk = new Uint8Array(W * H);
    for (i = 0; i < W * H; i++) walk[i] = (SOLID[tiles[i]] || chunkId(i % W, Math.floor(i / W)) !== 'c') ? 0 : 1;
    for (y = ty; y < ty + 4; y++) for (x = tx; x < tx + 4; x++) walk[I(x, y)] = 0;
    var seen = bfs(walk, spawn.x, spawn.y);
    function ok(px2, py2) { return seen[I(px2, py2)] === 1; }
    if (!ok(portal.x, portal.y) || !ok(gate.x, gate.y)) return null;
    for (i = 0; i < FIELD[0] * FIELD[1]; i++) { // all potential plots reachable, even those not yet soil
      if (!ok(fx0 + 2 + (i % FIELD[0]), fy0 + 2 + Math.floor(i / FIELD[0]))) return null;
    }
    for (i = 0; i < lots.length; i++) if (lots[i].chunk === 'c' && !ok(lots[i].door.x, lots[i].door.y)) return null;
    // with every chunk open, every lot door is reachable from the spawn (outer lots through the cross paths)
    var walkAll = new Uint8Array(W * H);
    for (i = 0; i < W * H; i++) walkAll[i] = SOLID[tiles[i]] && !bridgeAt[i] ? 0 : 1;
    for (y = ty; y < ty + 4; y++) for (x = tx; x < tx + 4; x++) walkAll[I(x, y)] = 0;
    lots.forEach(function (l) { for (var yy = l.y; yy < l.y + 3; yy++) for (var xx = l.x; xx < l.x + 3; xx++) walkAll[I(xx, yy)] = 0; });
    var seenAll = bfs(walkAll, spawn.x, spawn.y);
    for (i = 0; i < lots.length; i++) if (!seenAll[I(lots[i].door.x, lots[i].door.y + 1)]) return null;
    var spots = { tree: 0, rock: 0 };
    for (y = cOy; y < cOy + CH; y++) for (x = cOx; x < cOx + CH; x++) {
      var t = tiles[I(x, y)];
      if (!spots.hasOwnProperty(t)) continue;
      if (ok(x - 1, y) || ok(x + 1, y) || ok(x, y - 1) || ok(x, y + 1)) spots[t]++;
    }
    if (spots.tree < 5 || spots.rock < 3) return null;

    var open = ['c'];
    (prog.open || []).forEach(function (id) { if (CHUNKS.indexOf(id) >= 0 && open.indexOf(id) < 0) open.push(id); });

    // Street lights (the Town Hall's Lighting project, `prog.light` = its level). Level 1 lights the centre island,
    // level 2 every open island. A lamp stands on grass beside a path (on an outer island, beside its grass cross), never on a lot, the field, a bridge or in front of
    // a door, at least three tiles from the next lamp, and only where everything stays reachable from the spawn.
    // Picked in a fixed order from the seed, so the same progress always gives the same lamps on server and client.
    var lamps = [], info = {}, light = Math.max(0, Math.min(2, prog.light | 0));
    if (light > 0) {
      var lampOk = {}; (light >= 2 ? open : ['c']).forEach(function (id) { lampOk[id] = 1; });
      var keepOut = new Uint8Array(W * H);
      function out(x0, y0, x1, y1) { rect(Math.max(0, x0), Math.max(0, y0), Math.min(W - 1, x1), Math.min(H - 1, y1), function (xx, yy) { keepOut[I(xx, yy)] = 1; }); }
      // a lot or building's own ground, and the three tiles in front of its door
      lots.forEach(function (l) { out(l.x, l.y, l.x + l.w - 1, l.y + l.h - 1); out(l.door.x - 1, l.door.y + 1, l.door.x + 1, l.door.y + 1); });
      buildings.forEach(function (b) { out(b.x, b.y, b.x + b.w - 1, b.y + b.h - 1); out(b.dx - 1, b.dy + 1, b.dx + 1, b.dy + 1); });
      out(fx0, fy0, fx1, fy1); out(gate.x - 1, gate.y - 1, gate.x + 1, gate.y + 1);
      out(spawn.x - 1, spawn.y - 1, spawn.x + 1, spawn.y + 1); out(portal.x - 1, portal.y - 1, portal.x + 1, portal.y + 1);
      var lampWalk = new Uint8Array(W * H);
      for (i = 0; i < W * H; i++) lampWalk[i] = SOLID[tiles[i]] || !isOpen[chunkId(i % W, Math.floor(i / W))] ? 0 : 1;
      buildings.forEach(function (b) { rect(b.x, b.y, b.x + b.w - 1, b.y + b.h - 1, function (xx, yy) { lampWalk[I(xx, yy)] = 0; }); });
      function reachCount(seen0) { var n = 0; for (var k = 0; k < seen0.length; k++) n += seen0[k]; return n; }
      var musts = [portal, gate].concat(buildings.map(function (b) { return { x: b.dx, y: b.dy + 1 }; }));
      lots.forEach(function (l) { if (isOpen[l.chunk]) musts.push({ x: l.door.x, y: l.door.y + 1 }); });
      var base = reachCount(bfs(lampWalk, spawn.x, spawn.y));
      var cands = [];
      for (y = 1; y < H - 1; y++) for (x = 1; x < W - 1; x++) {
        var kk = I(x, y), tt = tiles[kk];
        if ((tt !== 'grass' && tt !== 'flower' && tt !== 'tallgrass' && tt !== 'sand') || keepOut[kk] || bridgeAt[kk] || !lampOk[chunkId(x, y)] || !lampWalk[kk]) continue;
        // beside a path or bridge; on an outer island (no paths) along the edges of its grass cross (rows/columns 7-8)
        var road = function (q) { return tiles[q] === 'path' || tiles[q] === 'bridge'; };
        var lx4 = x % CH, ly4 = y % CH, crossEdge = chunkId(x, y) !== 'c' && (lx4 === 6 || lx4 === 9 || ly4 === 6 || ly4 === 9) && !onCross(lx4, ly4);
        if (!crossEdge && !road(kk - 1) && !road(kk + 1) && !road(kk - W) && !road(kk + W)) continue;
        cands.push({ x: x, y: y, k: kk, h: hash3(x, y, ns + 59) });
      }
      cands.sort(function (a, b) { return a.h - b.h; });
      var perChunk = {}, cap = { c: 8 };
      for (i = 0; i < cands.length; i++) {
        var cd = cands[i], cid4 = chunkId(cd.x, cd.y);
        if ((perChunk[cid4] || 0) >= (cap[cid4] || 4)) continue;
        if (lamps.some(function (l) { return Math.max(Math.abs(l.x - cd.x), Math.abs(l.y - cd.y)) < 3; })) continue;
        lampWalk[cd.k] = 0;
        var seenL = bfs(lampWalk, spawn.x, spawn.y);
        if (reachCount(seenL) !== base - lamps.length - 1 || musts.some(function (q) { return !seenL[I(q.x, q.y)]; })) { lampWalk[cd.k] = 1; continue; }
        tiles[cd.k] = 'lamp'; info[cd.k] = $t('Tiang listrik. Lampunya menyala saat malam.');
        lamps.push({ x: cd.x, y: cd.y }); perChunk[cid4] = (perChunk[cid4] || 0) + 1;
      }
    }
    var chunks = CHUNKS.map(function (cid, ci) {
      return { id: cid, name: cid === 'c' ? $t('Pusat Desa') : NAMES[biomes[cid]], cx: ci % N, cy: Math.floor(ci / N), biome: cid === 'c' ? 'center' : biomes[cid], open: open.indexOf(cid) >= 0, project: null };
    });
    return {
      version: VERSION, seed: seed, attempt: att, w: W, h: H, chunk: CH, riverX1: null,
      tiles: tiles, info: info, lamps: lamps, light: light, buildings: buildings, market: { stalls: [] },
      farm: { plots: plots, gate: gate, x0: fx0, y0: fy0, x1: fx1, y1: fy1 },
      plaza: { x0: spawn.x, y0: spawn.y, x1: spawn.x, y1: spawn.y },
      mine: null, spawn: spawn, portal: portal, dock: portal,
      chunks: chunks, unlocked: open.slice(), projects: {}, lots: lots, spots: spots
    };
  }

  /**
   * Generates a Homeland. `prog` = {open: chunk ids opened so far, th: Town Hall level, built: [{kind, lot}]}.
   * The attempt that fixes the biomes is chosen from the seed alone, so progress never changes existing ground.
   */
  function generate(seed, prog) {
    seed = seed >>> 0;
    prog = prog || {};
    var th = Math.max(1, (prog.th | 0) || 1);
    for (var att = 0; att < 400; att++) {
      if (!tryGen(seed, att, MAX_PLOTS, { open: [], built: [], gen: prog.gen })) continue;
      return tryGen(seed, att, th, prog);
    }
    throw new Error('homeland: no valid layout for seed ' + seed);
  }

  /** The chunk covering tile (x, y). Same call shape as GTVillage.chunkOf. */
  function chunkOf(L, x, y) { return L.chunks[Math.floor(y / CH) * N + Math.floor(x / CH)]; }

  /* ---------------------------------------------------------------- night monsters */
  // Monsters live in the wild: open forest and rock chunks, never the centre around the Town Hall. Opening a wild chunk
  // brings its resources and its night danger. Pure functions of a finished layout: no RNG state, no tile changes.
  var WILD = { forest: 'boar', rock: 'bat' };
  /** The kind of monster that lives at (x, y) at night, or null outside the open wild chunks. */
  function wild(L, x, y) {
    if (x < 0 || y < 0 || x >= L.w || y >= L.h) return null;
    var c = chunkOf(L, x, y);
    return c && c.open && c.id !== 'c' ? (WILD[c.biome] || null) : null;
  }
  function monsterCandidates(L) {
    if (L._monsters) return L._monsters;
    var taken = new Uint8Array(L.w * L.h), out = { boar: [], bat: [] }, x, y;
    // keep lots, buildings, the farm and the portal clear
    L.lots.forEach(function (l) { for (var yy = l.y - 1; yy <= l.y + l.h; yy++) for (var xx = l.x - 1; xx <= l.x + l.w; xx++) if (xx >= 0 && yy >= 0 && xx < L.w && yy < L.h) taken[I(xx, yy)] = 1; });
    L.buildings.forEach(function (b) { for (var yy = b.y; yy < b.y + b.h; yy++) for (var xx = b.x; xx < b.x + b.w; xx++) taken[I(xx, yy)] = 1; });
    for (y = L.farm.y0; y <= L.farm.y1; y++) for (x = L.farm.x0; x <= L.farm.x1; x++) taken[I(x, y)] = 1;
    for (y = 1; y < L.h - 1; y++) for (x = 1; x < L.w - 1; x++) {
      var k = I(x, y), t = L.tiles[k], kind = wild(L, x, y);
      if (!kind || taken[k] || SOLID[t] || t === 'water') continue;
      if (Math.abs(x - L.portal.x) + Math.abs(y - L.portal.y) <= 2) continue;
      if (kind === 'bat') {
        // bats hang about the rocks
        var near = false;
        for (var dy = -2; dy <= 2 && !near; dy++) for (var dx = -2; dx <= 2 && !near; dx++) { var xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < L.w && yy < L.h && L.tiles[I(xx, yy)] === 'rock') near = true; }
        if (!near) continue;
      }
      out[kind].push([x, y]);
    }
    L._monsters = out;
    return out;
  }
  /** Where the roaming monsters stand in game hour `hour`. Same shape as GTVillage.monstersAt: [{id, kind, x, y}]. */
  function monstersAt(L, hour, counts) {
    counts = counts || { boar: 3, bat: 2 };
    var c = monsterCandidates(L), out = [];
    Object.keys(counts).forEach(function (kind) {
      var pool = c[kind] || [];
      if (!pool.length) return;
      for (var i = 0; i < counts[kind]; i++) {
        var q = pool[Math.floor(hash3(L.seed | 0, (hour | 0) * 31 + i, kind === 'bat' ? 0xba7 : 0xb0a2) * pool.length)];
        out.push({ id: kind + '-' + i, kind: kind, x: q[0], y: q[1] });
      }
    });
    return out;
  }

  root.GTHomeland = { VERSION: VERSION, W: W, H: H, CHUNK: CH, CHUNKS: CHUNKS, generate: generate, chunkOf: chunkOf, wild: wild, monstersAt: monstersAt };
})(typeof globalThis !== 'undefined' ? globalThis : this);
