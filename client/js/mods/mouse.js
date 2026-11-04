/*
 * mouse.js - play with the mouse (or a tap): left-click a tile in the game view.
 * - Next to you: face it and act on it, as A does (fish, chop, mine, talk, open a stall, farm).
 * - Further away: walk there along a path first, then act if it is something to use.
 * - A building: walk to its door and go in.
 * The walk presses the same arrow keys a player would, one tile at a time, so the engine's own movement,
 * collisions and the server's walking-speed check all apply unchanged.
 */
(function () {
  'use strict';
  var GT = window.GT;
  if (!GT) return;

  var DIR = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
  var KEY = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
  var walk = null; // { path:[{x,y}], held:dir|null, then:fn|null, last:ms, lastPos:'x,y' }

  function key(type, dir) { window.dispatchEvent(new KeyboardEvent(type, { code: KEY[dir], key: KEY[dir], bubbles: true, cancelable: true })); }
  function release() { if (walk && walk.held) { key('keyup', walk.held); walk.held = null; } }
  function cancel() { release(); walk = null; }
  function dirOf(from, to) {
    var dx = to.x - from.x, dy = to.y - from.y;
    if (Math.abs(dx) + Math.abs(dy) !== 1) return null;
    return dx === 1 ? 'right' : dx === -1 ? 'left' : dy === 1 ? 'down' : 'up';
  }
  // turn toward an adjacent tile without moving (a short tap), then run `fn`
  function faceThen(target, fn) {
    var p = GT.player, d = dirOf(p, target);
    if (!d) return;
    if (p.dir === d) { fn(); return; }
    key('keydown', d);
    setTimeout(function () { key('keyup', d); setTimeout(fn, 60); }, 60);
  }

  function walkable(sc, x, y) { var m = sc.map; return x >= 0 && y >= 0 && x < m.w && y < m.h && m.walk[y * m.w + x] === 1; }
  function npcAt(sc, x, y) { return (sc.npcs || []).filter(function (n) { return !n.hidden && n.x === x && n.y === y; })[0]; }
  // the closest walkable tile next to a target, with the path to it
  function approach(sc, t) {
    var p = GT.player, best = null;
    [[0, 1], [0, -1], [1, 0], [-1, 0]].forEach(function (d) {
      var x = t.x + d[0], y = t.y + d[1];
      if (!(x === p.x && y === p.y) && !walkable(sc, x, y)) return;
      var path = x === p.x && y === p.y ? [] : GT.findPath(sc, { x: p.x, y: p.y }, { x: x, y: y });
      if (path && (!best || path.length < best.path.length)) best = { x: x, y: y, path: path };
    });
    return best;
  }

  function go(path, then) {
    cancel();
    walk = { path: (path || []).map(function (q) { return { x: q.x, y: q.y }; }), held: null, then: then || null, last: performance.now(), lastPos: '' };
  }

  function onClick(e) {
    if (e.button !== 0 || GT.isUiOpen() || (window.GT_FISH && GT_FISH.active())) return;
    var sc = GT.scene, t = GT.screenToTile && GT.screenToTile(e.clientX, e.clientY);
    if (!sc || !t) return;
    var p = GT.player, m = sc.map;
    if (t.x < 0 || t.y < 0 || t.x >= m.w || t.y >= m.h) return;
    var i = t.y * m.w + t.x;
    var b = sc.kind === 'out' && (m.door.get(i) || m.bld.get(i));
    if (b) {
      // a building: walk to the tile in front of its door and step in
      var front = { x: b.dx, y: b.dy + 1 };
      var path = front.x === p.x && front.y === p.y ? [] : GT.findPath(sc, p, front);
      if (!path) return GT.toast('Tidak ada jalan ke sana.');
      go(path, function () { key('keydown', 'up'); setTimeout(function () { key('keyup', 'up'); }, 160); });
      return;
    }
    var thing = !walkable(sc, t.x, t.y) || npcAt(sc, t.x, t.y);
    if (!thing) {
      if (t.x === p.x && t.y === p.y) return;
      var p2 = GT.findPath(sc, p, t);
      if (!p2) return GT.toast('Tidak ada jalan ke sana.');
      go(p2, null);
      return;
    }
    // something to use (a tree, water, rock, stall, plot, table, chest, person): stand next to it, face it, act
    if (Math.abs(t.x - p.x) + Math.abs(t.y - p.y) === 1) { cancel(); faceThen(t, function () { GT.interact('talk'); }); return; }
    var a = approach(sc, t);
    if (!a) return GT.toast('Tidak ada jalan ke sana.');
    go(a.path, function () { faceThen(t, function () { GT.interact('talk'); }); });
  }

  function onFrame() {
    if (!walk) return;
    if (GT.isUiOpen()) return cancel();
    var p = GT.player, now = performance.now(), pos = p.x + ',' + p.y + (p.moving ? 'm' : '');
    if (pos !== walk.lastPos) { walk.lastPos = pos; walk.last = now; }
    if (now - walk.last > 1500) { cancel(); return; } // blocked (someone in the way): give up quietly
    if (walk.held) {
      // the engine sets the player's tile to the destination as a step starts: let go so it stops there
      var next = walk.path[0];
      if (next && p.x === next.x && p.y === next.y) { release(); walk.path.shift(); }
      return;
    }
    if (p.moving) return;
    if (!walk.path.length) { var then = walk.then; walk = null; if (then) then(); return; }
    var d = dirOf(p, walk.path[0]);
    if (!d) { cancel(); return; }
    walk.held = d;
    key('keydown', d);
  }

  // a key the player presses themself takes over from the mouse
  function onKey(e) { if (walk && e.isTrusted && e.type === 'keydown') cancel(); return false; }

  function init() {
    var cv = document.getElementById('cv');
    if (cv) cv.addEventListener('click', onClick);
    window.addEventListener('keydown', function (e) { if (walk && e.isTrusted) cancel(); }, true);
  }

  GT.register({ id: 'mouse', init: init, onFrame: onFrame, onKey: onKey });
})();
