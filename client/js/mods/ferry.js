/*
 * ferry.js - the public village's ONE boat, between the mainland shore and the island in the bottom-right corner (the 'danau' chunk,
 * which no path reaches). The boat floats wherever it was last left (the server keeps its tile and presence tells every client:
 * `boat` {x, y, by, name, mine}); it starts at the mainland dock (GTVillage.ferryOf(layout).wa) and an unused boat sails home by itself.
 * Stand on land next to the boat (or face it), press Space / F / the action button, or click the boat: the server's 'boat' act
 * (op 'board') puts you in it, unless someone else steers it ("Perahu sedang dipakai X"). Then YOU steer it with the normal movement
 * keys / joystick over water only (GT.setBoatWalk, GTVillage.boatWater: the same tiles the server accepts; land is closed) and the
 * camera follows. Press the action key next to a shore to step off onto that land (act 'boat' op 'land', the tile must touch the boat).
 * While somebody steers, everyone else sees the boat follow that player (GT_PLAYERS.where).
 * Boat: a 2D sprite drawn here under the characters; in 2.5D a real 3D model (three/fun.js GT3.Boats) reading window.GT_FERRY.pos.
 */
(function () {
  'use strict';
  var GT = window.GT;
  if (!GT) return;
  var busy = false, aboard = false, yaw = 0, lastX = 0, lastY = 0, hooked = false, boardedAt = 0;
  var boat = null; // the shared boat as the server last said: { x, y, by, name, mine }
  var FERRY = window.GT_FERRY = { pos: null };
  var DV = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

  function sfx(n, o) { try { window.GT_SFX && GT_SFX.play(n, o); } catch (e) { /* sound must never break the game */ } }
  function world() { return (GT.worldId && GT.worldId()) || 'public'; }
  function layout() { return GT.world && GT.world.layout; }
  function ferry() {
    var L = layout(), V = window.GTVillage;
    if (world() !== 'public' || !L || !V || !V.ferryOf) return null;
    try { return V.ferryOf(L); } catch (e) { return null; }
  }
  var REACH = 2; // boarding works up to 2 tiles from the boat, like the server (game.ts BOARD_REACH)
  function near(p, q) { return Math.max(Math.abs(Math.round(p.x) - Math.round(q.x)), Math.abs(Math.round(p.y) - Math.round(q.y))) <= REACH; }
  // the tile the boat floats on (where the server has it)
  function tile() { var f = ferry(); return boat ? { x: boat.x, y: boat.y } : f ? { x: f.wa.x, y: f.wa.y } : null; }
  function landing() { var t = tile(), p = GT.player; if (aboard || !t || !p || !GT.scene || GT.scene.kind !== 'out') return false; return near(p, t); }
  function otherSteers() { return !!(boat && boat.by && !boat.mine); }

  // the land tiles that touch the boat, the one it faces first
  // land tiles to step onto: the faced one first, then the other sides, then the corners (the server takes any of the 8)
  function shores() {
    var p = GT.player, px = Math.round(p.x), py = Math.round(p.y), out = [], seen = {};
    var order = [p.dir || 'down', 'up', 'down', 'left', 'right'].map(function (d) { return DV[d]; }).filter(Boolean).concat([[1, 1], [1, -1], [-1, 1], [-1, -1]]);
    order.forEach(function (v) {
      var t = { x: px + v[0], y: py + v[1] }, k = t.x + ',' + t.y;
      if (seen[k]) return; seen[k] = 1;
      if (GT.landAt && GT.landAt(t.x, t.y)) out.push(t);
    });
    return out;
  }

  function row() {
    var C = window.GT_CHAIN, f = ferry(), p = GT.player;
    if (busy || aboard || !f || !landing()) return;
    if (!C || !C.state || !C.state.account) { GT.toast($t('Masuk dulu untuk naik perahu.')); return; }
    if (otherSteers()) { GT.toast($t('Perahu sedang dipakai {0}.', [boat.name || '?'])); return; }
    busy = true;
    var fromX = p.x, fromY = p.y;
    C.act({ action: 'boat', op: 'board', world: 'public' }, true).then(function (r) {
      if (!r || !r.arrive || !r.aboard) return;
      aboard = true; boardedAt = performance.now();
      yaw = Math.atan2(r.arrive.x - fromX, r.arrive.y - fromY) + Math.PI / 2;
      boat = { x: r.arrive.x, y: r.arrive.y, by: 'me', mine: true, name: '' };
      FERRY.pos = { x: r.arrive.x, y: r.arrive.y, yaw: yaw };
      lastX = r.arrive.x; lastY = r.arrive.y;
      GT.setBoatWalk(function (x, y) { return window.GTVillage.boatWater(layout(), x, y); }, r.arrive.x, r.arrive.y);
      GT.toast('⛵ ' + $t('Kamu naik perahu. Kemudikan dengan tombol gerak; Spasi di dekat pantai untuk turun.'));
      sfx('ui_open');
    }, function () { /* act() already said why */ }).then(function () { busy = false; });
  }

  function land() {
    var C = window.GT_CHAIN, c = shores();
    if (busy || !aboard) return;
    if (!c.length) { GT.toast($t('Dekati pantai dulu, lalu Spasi untuk turun.')); return; }
    busy = true;
    var tile0 = c[0], at = { x: Math.round(GT.player.x), y: Math.round(GT.player.y) };
    C.act({ action: 'boat', op: 'land', world: 'public', x: tile0.x, y: tile0.y }, true).then(function (r) {
      if (!r || !r.arrive || r.aboard) return;
      aboard = false;
      boat = { x: at.x, y: at.y, by: null, mine: false, name: '' }; // it stays where you left it
      GT.setBoatWalk(null, r.arrive.x, r.arrive.y);
      sfx('ui_close');
      GT.toast('⛵ ' + $t('Kamu turun dari perahu.'));
    }, function () { /* act() already said why */ }).then(function () { busy = false; });
  }

  // where the boat is drawn now: under me while I steer, under the steerer while another does, else on its tile
  function place() {
    var t = tile();
    if (aboard) { var p = GT.player; return { x: p.sx != null ? p.sx : p.x, y: p.sy != null ? p.sy : p.y }; }
    if (boat && boat.by && window.GT_PLAYERS && GT_PLAYERS.where) {
      var q = null; try { q = GT_PLAYERS.where(boat.by); } catch (e) { q = null; }
      if (q) return q;
    }
    return t;
  }

  function hook() {
    if (hooked || !window.GT_PLAYERS || !GT_PLAYERS.onPresence) return;
    hooked = true;
    GT_PLAYERS.onPresence(function (r) {
      if (!r || r.world !== 'public' || r.boat === undefined) return;
      if (aboard && performance.now() - boardedAt < 3000) return; // my own boarding is newer than this answer
      boat = r.boat ? { x: r.boat.x, y: r.boat.y, by: r.boat.by || null, mine: !!r.boat.mine, name: r.boat.name || '' } : null;
      FERRY.by = boat && boat.by && !boat.mine ? boat.by : null; // whoever rows it sits still in it (players.js: no walking legs)
    });
  }

  function onFrame() {
    hook();
    var f = ferry();
    if (!f) { FERRY.pos = null; return; }
    if (aboard) {
      if (world() !== 'public' || !GT.scene || GT.scene.kind !== 'out') { aboard = false; GT.setBoatWalk(null, GT.player.x, GT.player.y); return; }
      if (boat && !boat.mine && performance.now() - boardedAt > 3000) { // the server let go of me (I went silent): back on the mainland dock
        aboard = false; GT.setBoatWalk(null, f.a.x, f.a.y); GT.toast('⛵ ' + $t('Perahu kembali ke dermaga.'));
      }
    }
    var pl = place(), x = pl.x, y = pl.y, dx = x - lastX, dy = y - lastY;
    if (!FERRY.pos) { yaw = Math.atan2(f.a.x - f.wa.x, f.a.y - f.wa.y) + Math.PI / 2; lastX = x; lastY = y; dx = dy = 0; }
    if (Math.abs(dx) + Math.abs(dy) > 0.002) {
      var ty = Math.atan2(dx, dy) + Math.PI / 2, d = ty - yaw;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      yaw += d * 0.25;
    }
    lastX = x; lastY = y;
    FERRY.pos = { x: x, y: y, yaw: yaw };
  }

  function onInteract(ctx) {
    if (ctx.scene.kind !== 'out' || ctx.npc || ctx.mode === 'message') return false;
    if (aboard) { if (ctx.mode === 'talk') land(); return true; }
    var t0 = tile(), t = ctx.tile;
    if (!ferry() || !t0 || !t) return false;
    var onBoat = t.x === t0.x && t.y === t0.y;
    if (!onBoat && !(ctx.mode === 'talk' && landing())) return false;
    if (ctx.mode === 'bump') return true; // walking into the boat does not row it
    if (!landing()) { GT.toast($t('Dekati perahu dulu, lalu naik.')); return true; }
    row();
    return true;
  }

  /* a small rowing boat on the water tile: hull, a plank seat, an oar (2D only; the 2.5D view has a real model) */
  function drawBoat(g, x, y, T) {
    var u = T / 12;
    g.fillStyle = '#2a2430'; g.fillRect(x + 1 * u, y + 5 * u, 10 * u, 5 * u);
    g.fillStyle = '#9a6234'; g.fillRect(x + 2 * u, y + 5 * u, 8 * u, 3 * u);
    g.fillStyle = '#c8894a'; g.fillRect(x + 2 * u, y + 5 * u, 8 * u, 1 * u);
    g.fillStyle = '#6a4020'; g.fillRect(x + 3 * u, y + 8 * u, 6 * u, 1 * u);
    g.fillStyle = '#e0bc80'; g.fillRect(x + 5 * u, y + 6 * u, 2 * u, 1 * u);
    g.fillStyle = '#6a4020'; g.fillRect(x + 9 * u, y + 2 * u, 1 * u, 7 * u);
  }
  // the boat on the ground layer, so the player (drawn after) sits in the boat they ride
  function onDrawGround(ctx, camX, camY, T) {
    if (GT.view3dOn && GT.view3dOn()) return;
    var P = FERRY.pos; if (!P || !ferry()) return;
    var t = performance.now() / 1000, moving = aboard || (boat && boat.by);
    drawBoat(ctx, P.x * T - camX, P.y * T - camY + Math.round(Math.sin(t * (moving ? 3 : 1.6)) * (moving ? 0.8 : 0.6)), T);
  }
  /* ---- the boat's outline: it glows while the pointer is on it or you stand where you can board, and a click boards ---- */
  var box = null, mouse = { x: -1, y: -1 }, hover = false, cursorMine = false, view = { w: 1, h: 1 };
  function boatBox(ctx, T, v3) {
    var P = FERRY.pos; if (!P) return null;
    var a = GT.at(P.x, P.y), V = window.GT_VIEW3D;
    if (v3 && V && V.toScreen) { // the hull's footprint and gunwale projected by the camera, in overlay units (the factor GT.at uses)
      var p0 = V.toScreen(P.x + 0.5, P.y + 0.5, 0), k = p0.x ? (a.x + 6) / p0.x : 1, ky = p0.y ? (a.y + 12) / p0.y : k, xs = [], ys = [];
      [[-0.15, -0.05], [1.15, -0.05], [-0.15, 1.05], [1.15, 1.05]].forEach(function (q) { [0, 0.45].forEach(function (lift) { var p = V.toScreen(P.x + q[0], P.y + q[1], lift); xs.push(p.x * k); ys.push(p.y * ky); }); });
      return { x0: Math.min.apply(null, xs), y0: Math.min.apply(null, ys), x1: Math.max.apply(null, xs), y1: Math.max.apply(null, ys) };
    }
    return { x0: a.x, y0: a.y + 1, x1: a.x + T, y1: a.y + 11 * T / 12 };
  }
  function overBoat(cx, cy) {
    var cv = document.getElementById('cv'); if (!cv || !box) return false;
    var rc = cv.getBoundingClientRect(); if (!rc.width) return false;
    var ux = (cx - rc.left) / rc.width * view.w, uy = (cy - rc.top) / rc.height * view.h;
    return ux >= box.x0 && ux <= box.x1 && uy >= box.y0 && uy <= box.y1;
  }
  function drawOutline(ctx, T) {
    var pulse = 0.5 + 0.5 * Math.sin(Date.now() / 260), near = landing() && !otherSteers();
    ctx.save();
    ctx.shadowColor = 'rgba(255,224,120,' + (near ? 0.9 : 0.5) + ')'; ctx.shadowBlur = 4 + 6 * pulse;
    ctx.strokeStyle = 'rgba(255,240,170,' + ((near ? 0.75 : 0.45) + 0.25 * pulse).toFixed(2) + ')'; ctx.lineWidth = Math.max(1, T / 10); ctx.lineJoin = 'round';
    ctx.strokeRect(box.x0 - 1, box.y0 - 1, box.x1 - box.x0 + 2, box.y1 - box.y0 + 2);
    ctx.restore();
  }
  function onBoatClick(e) {
    if (e.button !== 0 || !e.target || e.target.id !== 'cv' || aboard || GT.isUiOpen() || !ferry()) return;
    if (window.GT_VIEW3D && GT_VIEW3D.tookClick && GT_VIEW3D.tookClick()) return;
    if (!overBoat(e.clientX, e.clientY)) return;
    e.stopImmediatePropagation(); e.preventDefault();
    if (otherSteers()) { GT.toast($t('Perahu sedang dipakai {0}.', [boat.name || '?'])); return; }
    if (!landing()) { GT.toast($t('Dekati perahu dulu, lalu naik.')); return; }
    row();
  }
  window.addEventListener('mousemove', function (e) { mouse.x = e.clientX; mouse.y = e.clientY; });
  window.addEventListener('click', onBoatClick, true);

  function onDraw(ctx, camX, camY, T) {
    var P = FERRY.pos;
    if (!P || !ferry()) { box = null; return; }
    var v3 = GT.view3dOn && GT.view3dOn(), p = GT.player;
    view.w = ctx.canvas.width / (ctx.getTransform().a || 1); view.h = ctx.canvas.height / (ctx.getTransform().d || 1);
    box = aboard ? null : boatBox(ctx, T, v3);
    var on = !!box && !GT.isUiOpen() && (overBoat(mouse.x, mouse.y) || (landing() && !otherSteers()));
    hover = on;
    var over = !!box && !GT.isUiOpen() && overBoat(mouse.x, mouse.y), cv = document.getElementById('cv');
    if (over !== cursorMine && cv) { cursorMine = over; cv.style.cursor = over ? 'pointer' : ''; } // only the cursor this mod set is put back
    if (on) drawOutline(ctx, T);
    if (aboard) { // the hint over the boat: where you can step off
      if (!window.GT_THEME || !GT_THEME.label || !shores().length) return;
      var pb = GT.at(p.x, p.y);
      GT_THEME.label(ctx, '⛵ ' + $t('Spasi: turun ke darat'), pb.x + T / 2, v3 ? pb.y - 4 : pb.y - T * 0.9, { tone: 'dark', size: 6, bold: true });
      return;
    }
    // one small sign over the boat
    if (window.GT_THEME && GT_THEME.label) {
      var a = GT.at(P.x, P.y);
      GT_THEME.label(ctx, '⛵ ' + $t('Perahu'), a.x + T / 2, v3 ? a.y + T - 8 : a.y - 1, { tone: 'paper', size: 6, bold: true });
    }
    if (!landing() || otherSteers()) return;
    // the hint floats over the player, in world coordinates like the boat
    var pa = GT.at(p.x, p.y);
    GT_THEME.label(ctx, '⛵ ' + $t('Spasi: naik perahu'), pa.x + T / 2, v3 ? pa.y - 4 : pa.y - T * 0.9, { tone: 'dark', size: 6, bold: true });
  }

  GT.register({ id: 'ferry', onInteract: onInteract, onFrame: onFrame, onDraw: onDraw, onDrawGround: onDrawGround });
})();
