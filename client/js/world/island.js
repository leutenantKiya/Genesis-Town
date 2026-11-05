/*
 * island.js - the Private Island generator, shared by the browser and the server (same seed + spec = same island).
 *
 * One 32 x 32 map, one open chunk {id: 'island', name: 'Pulau Pribadi'}: a landmass in the sea with the owner's house,
 * a fenced farm (size_level 1 -> 6 plots, 2 -> 9, 3 -> 12), a rock outcrop, trees, a pond and a dock on the shore.
 * No merchants, no market stalls. Output has the same shape as GTVillage.generate (w, h, chunk, tiles, chunks, unlocked,
 * buildings with own:true on the house, market.stalls (empty), farm.plots, spawn) plus `dock: {x, y}`.
 * The spawn is the tile in front of the house door; the dock is a walkable shore tile reachable from it.
 * fertility_level only adds flowers around the field (walkable decoration); it never moves anything else.
 *
 * Works as a classic browser script (window.GTIsland) and as an ES module side effect in Node (globalThis.GTIsland).
 */
(function (root) {
  'use strict';

  var W = 32, H = 32, VERSION = 1;
  var PLOTS = { 1: 6, 2: 9, 3: 12 };
  var FIELD = { 6: [3, 2], 9: [3, 3], 12: [4, 3] }; // plots across x down
  var SOLID = { tree: 1, fence: 1, sign: 1, mailbox: 1, rock: 1, water: 1, bush: 1, barrel: 1, crate: 1, stall: 1, lamp: 1 };
  var CHUNK = { id: 'island', name: 'Pulau Pribadi', cx: 0, cy: 0, biome: 'island', open: true, project: null };

  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function makeR(seed) {
    var f = mulberry32(seed), r = { f: f };
    r.int = function (a, b) { return a + Math.floor(f() * (b - a + 1)); };
    r.chance = function (p) { return f() < p; };
    return r;
  }
  function hash3(a, b, c) { var h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 1274126177)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
  function noise(seed, x, y) {
    var x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    var a = hash3(x0, y0, seed), b = hash3(x0 + 1, y0, seed), c = hash3(x0, y0 + 1, seed), d = hash3(x0 + 1, y0 + 1, seed);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }

  function I(x, y) { return y * W + x; }
  var DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  /** Breadth-first search over walkable tiles. Returns {seen, prev} (prev = index we came from, -1 at the start). */
  function bfs(walk, sx, sy) {
    var seen = new Uint8Array(W * H), prev = new Int32Array(W * H).fill(-1), q = [sx, sy], head = 0;
    if (!walk[I(sx, sy)]) return { seen: seen, prev: prev };
    seen[I(sx, sy)] = 1;
    while (head < q.length) {
      var x = q[head++], y = q[head++];
      for (var d = 0; d < 4; d++) {
        var nx = x + DIRS[d][0], ny = y + DIRS[d][1];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        var ni = I(nx, ny);
        if (seen[ni] || !walk[ni]) continue;
        seen[ni] = 1; prev[ni] = I(x, y); q.push(nx, ny);
      }
    }
    return { seen: seen, prev: prev };
  }

  function tryGen(seed, att, size, fert) {
    var R = makeR((seed + att * 7919) >>> 0), ns = ((seed ^ 0x15a2d) + Math.imul(att, 101)) >>> 0;
    var tiles = new Array(W * H).fill('water');
    var res = new Uint8Array(W * H); // 1 = reserved (house, farm, paths)
    var x, y, i;

    // landmass: a noisy disc around the middle, never closer than 3 tiles to the map edge
    var rad = 11 + size, land = new Uint8Array(W * H);
    for (y = 3; y < H - 3; y++) for (x = 3; x < W - 3; x++) {
      var d = Math.sqrt((x - 15.5) * (x - 15.5) + (y - 15.5) * (y - 15.5));
      if (d < rad * (0.72 + 0.4 * noise(ns, x * 0.17, y * 0.17))) land[I(x, y)] = 1;
    }
    // keep only the part connected to the middle
    if (!land[I(16, 16)]) return null;
    var comp = bfs(land, 16, 16);
    for (i = 0; i < W * H; i++) tiles[i] = comp.seen[i] ? 'grass' : 'water';
    // sand rim
    for (y = 1; y < H - 1; y++) for (x = 1; x < W - 1; x++) {
      if (tiles[I(x, y)] !== 'grass') continue;
      if (DIRS.some(function (dd) { return tiles[I(x + dd[0], y + dd[1])] === 'water'; })) tiles[I(x, y)] = 'sand';
    }
    function grass(x, y) { return x >= 1 && y >= 1 && x < W - 1 && y < H - 1 && tiles[I(x, y)] === 'grass' && !res[I(x, y)]; }
    function rectFree(x0, y0, x1, y1) { for (var yy = y0; yy <= y1; yy++) for (var xx = x0; xx <= x1; xx++) if (!grass(xx, yy)) return false; return true; }
    function rectMark(x0, y0, x1, y1) { for (var yy = y0; yy <= y1; yy++) for (var xx = x0; xx <= x1; xx++) res[I(xx, yy)] = 1; }

    // the house: 3 x 3, door in the middle of the south side, as far north as the land allows
    var house = null, best = -1e9;
    for (y = 3; y < H - 8; y++) for (x = 3; x < W - 6; x++) {
      if (!rectFree(x - 1, y - 1, x + 3, y + 4)) continue;
      var sc = -Math.abs(x + 1 - 16) * 1.2 - Math.abs(y + 1 - 11) * 1.5 + R.f() * 2;
      if (sc > best) { best = sc; house = { x: x, y: y }; }
    }
    if (!house) return null;
    var hx = house.x, hy = house.y, dx = hx + 1, dy = hy + 2;
    rectMark(hx - 1, hy - 1, hx + 3, hy + 3);
    res[I(dx, dy + 1)] = 1;
    var buildings = [{ kind: 'house', name: null, x: hx, y: hy, w: 3, h: 3, dx: dx, dy: dy, chunk: 'island', open: true, own: true, style: R.int(0, 3), id: 0, houseNo: 0 }];

    // the farm: fence ring around a field with a one-tile walking margin, gate in the middle of the south fence
    var plotsN = PLOTS[size] || 6, fld = FIELD[plotsN], cw = fld[0], ch = fld[1];
    var fw = cw + 4, fh = ch + 4, farm = null; best = -1e9;
    for (y = 3; y < H - fh - 2; y++) for (x = 3; x < W - fw - 2; x++) {
      if (!rectFree(x - 1, y - 1, x + fw, y + fh)) continue;
      var s2 = -Math.abs(x + fw / 2 - (dx + (x + fw / 2 < dx ? -6 : 6))) * 0.5 - Math.abs(y + fh - (dy + 1)) * 0.9 + R.f() * 2;
      if (s2 > best) { best = s2; farm = { x0: x, y0: y, x1: x + fw - 1, y1: y + fh - 1 }; }
    }
    if (!farm) return null;
    rectMark(farm.x0 - 1, farm.y0 - 1, farm.x1 + 1, farm.y1 + 1);
    var gate = { x: farm.x0 + (fw >> 1), y: farm.y1 };
    for (x = farm.x0; x <= farm.x1; x++) { tiles[I(x, farm.y0)] = 'fence'; tiles[I(x, farm.y1)] = x === gate.x ? 'path' : 'fence'; }
    for (y = farm.y0; y <= farm.y1; y++) { tiles[I(farm.x0, y)] = 'fence'; tiles[I(farm.x1, y)] = 'fence'; }
    var plots = [];
    for (y = farm.y0 + 2; y < farm.y0 + 2 + ch; y++) for (x = farm.x0 + 2; x < farm.x0 + 2 + cw; x++) { tiles[I(x, y)] = 'soil'; plots.push({ x: x, y: y }); }
    // fertile soil grows flowers along the margin (walkable decoration only)
    var flowers = Math.max(0, fert - 1) * 2;
    for (x = farm.x0 + 1; x <= farm.x1 - 1 && flowers > 0; x++) if (tiles[I(x, farm.y0 + 1)] === 'grass' && hash3(x, farm.y0, ns) < 0.5) { tiles[I(x, farm.y0 + 1)] = 'flower'; flowers--; }

    // the dock: the shore tile (sand next to the open sea) nearest to the middle of the south coast
    var sea = bfs(tiles.map(function (t) { return t === 'water' ? 1 : 0; }), 0, 0);
    var dock = null; best = 1e9;
    for (y = 2; y < H - 2; y++) for (x = 2; x < W - 2; x++) {
      if (tiles[I(x, y)] !== 'sand' || res[I(x, y)]) continue;
      if (!DIRS.some(function (dd) { return sea.seen[I(x + dd[0], y + dd[1])]; })) continue;
      var sd = Math.abs(x - 16) * 1.0 + Math.abs(y - 27) * 1.6 + R.f() * 0.5;
      if (sd < best) { best = sd; dock = { x: x, y: y }; }
    }
    if (!dock) return null;

    // paths: house front -> dock, farm gate -> that path (shortest way over free ground)
    function carve(fromX, fromY, goal) {
      var ok = new Uint8Array(W * H);
      for (var k = 0; k < W * H; k++) { var t = tiles[k]; ok[k] = (t === 'grass' || t === 'sand' || t === 'path' || t === 'flower') && (!res[k] || t === 'path') ? 1 : 0; }
      ok[I(fromX, fromY)] = 1;
      for (k = 0; k < W * H; k++) if (goal(k)) ok[k] = 1;
      var r = bfs(ok, fromX, fromY), target = -1;
      for (k = 0; k < W * H; k++) if (r.seen[k] && goal(k)) { target = k; break; }
      if (target < 0) return false;
      for (k = target; k >= 0; k = r.prev[k]) { if (tiles[k] === 'grass' || tiles[k] === 'sand' || tiles[k] === 'flower') tiles[k] = 'path'; res[k] = 1; }
      return true;
    }
    tiles[I(dock.x, dock.y)] = 'path'; res[I(dock.x, dock.y)] = 1;
    if (!carve(dx, dy + 1, function (k) { return k === I(dock.x, dock.y); })) return null;
    if (!carve(gate.x, gate.y + 1, function (k) { return tiles[k] === 'path' && k !== I(gate.x, gate.y); })) return null;
    tiles[I(gate.x, gate.y)] = 'path';
    for (i = 0; i < W * H; i++) if (tiles[i] === 'path') res[i] = 1;
    // a keep-clear ring around every path tile next to the house keeps the door open; flowers by the door
    [dx - 1, dx + 1].forEach(function (fx) { if (grass(fx, dy + 1)) tiles[I(fx, dy + 1)] = 'flower'; });

    // rock outcrop: a blob far from the house, with walking room all around
    var rockSpot = null; best = -1e9;
    for (y = 4; y < H - 6; y++) for (x = 4; x < W - 6; x++) {
      if (!rectFree(x - 1, y - 1, x + 3, y + 2)) continue;
      var rs = Math.abs(x - dx) + Math.abs(y - dy) + R.f() * 6;
      if (rs > best) { best = rs; rockSpot = { x: x, y: y }; }
    }
    if (!rockSpot) return null;
    [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [1, -1]].forEach(function (o, k) {
      if (k > 3 && !R.chance(0.6)) return;
      var rx = rockSpot.x + o[0], ry = rockSpot.y + o[1];
      if (grass(rx, ry)) { tiles[I(rx, ry)] = 'rock'; res[I(rx, ry)] = 1; }
    });
    // pond: 2 x 2 inland water with a sand ring
    var pond = null; best = -1e9;
    for (y = 4; y < H - 6; y++) for (x = 4; x < W - 6; x++) {
      if (!rectFree(x - 1, y - 1, x + 2, y + 2)) continue;
      var ps = -Math.abs(x - 22) - Math.abs(y - 20) + R.f() * 4 + (Math.abs(x - rockSpot.x) + Math.abs(y - rockSpot.y)) * 0.2;
      if (ps > best) { best = ps; pond = { x: x, y: y }; }
    }
    if (pond) {
      for (y = pond.y - 1; y <= pond.y + 2; y++) for (x = pond.x - 1; x <= pond.x + 2; x++) { tiles[I(x, y)] = 'sand'; res[I(x, y)] = 1; }
      for (y = pond.y; y <= pond.y + 1; y++) for (x = pond.x; x <= pond.x + 1; x++) tiles[I(x, y)] = 'water';
    }
    // trees on free grass, flowers and tall grass for the look
    for (y = 2; y < H - 2; y++) for (x = 2; x < W - 2; x++) {
      if (!grass(x, y)) continue;
      var h = hash3(x, y, ns + att);
      if (h < 0.13) tiles[I(x, y)] = 'tree';
      else if (h < 0.19) tiles[I(x, y)] = 'flower';
      else if (h < 0.28) tiles[I(x, y)] = 'tallgrass';
    }

    // validation: from the spawn everything that matters is reachable, and there is enough to gather
    var spawn = { x: dx, y: dy + 1 };
    var walk = new Uint8Array(W * H);
    for (i = 0; i < W * H; i++) walk[i] = SOLID[tiles[i]] ? 0 : 1;
    for (y = hy; y < hy + 3; y++) for (x = hx; x < hx + 3; x++) walk[I(x, y)] = 0;
    var r = bfs(walk, spawn.x, spawn.y);
    function ok(x, y) { return r.seen[I(x, y)] === 1; }
    if (!ok(spawn.x, spawn.y) || !ok(dock.x, dock.y) || !ok(gate.x, gate.y)) return null;
    for (i = 0; i < plots.length; i++) if (!ok(plots[i].x, plots[i].y)) return null;
    var spots = { water: 0, rock: 0, tree: 0 };
    for (y = 1; y < H - 1; y++) for (x = 1; x < W - 1; x++) {
      var t = tiles[I(x, y)];
      if (!spots.hasOwnProperty(t)) continue;
      if (ok(x - 1, y) || ok(x + 1, y) || ok(x, y - 1) || ok(x, y + 1)) spots[t]++;
    }
    if (spots.water < 6 || spots.rock < 2 || spots.tree < 8) return null;

    return {
      version: VERSION, seed: seed, attempt: att, w: W, h: H, chunk: W, riverX1: null,
      tiles: tiles, info: {}, buildings: buildings, market: { stalls: [] },
      farm: { plots: plots, gate: gate, x0: farm.x0, y0: farm.y0, x1: farm.x1, y1: farm.y1 },
      plaza: { x0: spawn.x, y0: spawn.y, x1: spawn.x, y1: spawn.y },
      mine: null, spawn: spawn, dock: dock,
      chunks: [{ id: CHUNK.id, name: CHUNK.name, cx: 0, cy: 0, biome: 'island', open: true, project: null }],
      unlocked: ['island'], projects: {}, spots: spots
    };
  }

  /** Generates a Private Island. `spec` = {size_level, fertility_level}; same seed and spec always give the same map. */
  function generate(seed, spec) {
    seed = seed >>> 0;
    var size = Math.max(1, Math.min(3, (spec && spec.size_level) | 0 || 1)), fert = Math.max(1, Math.min(5, (spec && spec.fertility_level) | 0 || 1));
    for (var att = 0; att < 80; att++) {
      var L = tryGen(seed, att, size, fert);
      if (L) return L;
    }
    throw new Error('island: no valid layout for seed ' + seed);
  }

  /** The (only) area of an island. Same call shape as GTVillage.chunkOf. */
  function chunkOf(L) { return L.chunks[0]; }

  root.GTIsland = { VERSION: VERSION, W: W, H: H, PLOTS: PLOTS, generate: generate, chunkOf: chunkOf };
})(typeof globalThis !== 'undefined' ? globalThis : this);
