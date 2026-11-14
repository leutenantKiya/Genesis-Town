/*
 * ferry.js - the public boat between the public village's mainland shore and the island in its bottom-right corner (the 'danau'
 * chunk, which no path reaches). GTVillage.ferryOf(layout) gives the two docks: a boat floats on a water tile beside each landing.
 * Walk up to a landing (or face the boat), press Space / F / the action button, or click the boat: the server's 'boat' act (op 'board')
 * puts you in the boat. Then YOU steer it with the normal movement keys / joystick over water only (GT.setBoatWalk, GTVillage.boatWater: the
 * same tiles the server accepts; land is closed) and the camera follows. Press the action key next to a shore to step off onto that land
 * (act 'boat' op 'land', the tile must touch the boat). The boats at the docks always wait there for the next passenger.
 * Boats: 2D sprites drawn here under the characters; in 2.5D real 3D models (three/fun.js GT3.Boats), which read window.GT_FERRY.sail.
 */
(function () {
  'use strict';
  var GT = window.GT;
  if (!GT) return;
  var busy = false, aboard = false, yaw = 0, lastX = 0, lastY = 0;
  var FERRY = window.GT_FERRY = { sail: null };
  var DV = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

  function sfx(n, o) { try { window.GT_SFX && GT_SFX.play(n, o); } catch (e) { /* sound must never break the game */ } }
  function world() { return (GT.worldId && GT.worldId()) || 'public'; }
  function layout() { return GT.world && GT.world.layout; }
  function ferry() {
    var L = layout(), V = window.GTVillage;
    if (world() !== 'public' || !L || !V || !V.ferryOf) return null;
    try { return V.ferryOf(L); } catch (e) { return null; }
  }
  function near(p, q) { return Math.abs(Math.round(p.x) - q.x) + Math.abs(Math.round(p.y) - q.y) <= 1; }
  function landing() { var f = ferry(), p = GT.player; if (aboard || !f || !p || !GT.scene || GT.scene.kind !== 'out') return null; return near(p, f.a) ? 'a' : near(p, f.b) ? 'b' : null; }

  // the land tiles that touch the boat, the one it faces first
  function shores() {
    var p = GT.player, out = [], order = [p.dir || 'down', 'up', 'down', 'left', 'right'], seen = {};
    order.forEach(function (d) {
      if (seen[d] || !DV[d]) return;
      seen[d] = 1;
      var t = { x: p.x + DV[d][0], y: p.y + DV[d][1] };
      if (GT.landAt && GT.landAt(t.x, t.y)) out.push(t);
    });
    return out;
  }

  function row() {
    var C = window.GT_CHAIN, f = ferry(), which = landing();
    if (busy || aboard || !f || !which) return;
    if (!C || !C.state || !C.state.account) { GT.toast($t('Masuk dulu untuk naik perahu.')); return; }
    busy = true;
    C.act({ action: 'boat', op: 'board', world: 'public' }, true).then(function (r) {
      if (!r || !r.arrive || !r.aboard) return;
      var land = which === 'a' ? f.a : f.b;
      aboard = true;
      yaw = Math.atan2(r.arrive.x - land.x, r.arrive.y - land.y) + Math.PI / 2;
      FERRY.sail = { x: r.arrive.x, y: r.arrive.y, yaw: yaw, fromIdx: which === 'a' ? 0 : 1 };
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
    var tile = c[0];
    C.act({ action: 'boat', op: 'land', world: 'public', x: tile.x, y: tile.y }, true).then(function (r) {
      if (!r || !r.arrive || r.aboard) return;
      aboard = false; FERRY.sail = null;
      GT.setBoatWalk(null, r.arrive.x, r.arrive.y);
      sfx('ui_close');
      GT.toast('⛵ ' + $t('Kamu turun dari perahu.'));
    }, function () { /* act() already said why */ }).then(function () { busy = false; });
  }

  function onFrame() {
    if (!aboard) return;
    if (world() !== 'public' || !GT.scene || GT.scene.kind !== 'out') { aboard = false; FERRY.sail = null; GT.setBoatWalk(null, GT.player.x, GT.player.y); return; }
    var p = GT.player, x = p.sx != null ? p.sx : p.x, y = p.sy != null ? p.sy : p.y, dx = x - lastX, dy = y - lastY;
    if (Math.abs(dx) + Math.abs(dy) > 0.002) {
      var ty = Math.atan2(dx, dy) + Math.PI / 2, d = ty - yaw;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      yaw += d * 0.25;
    }
    lastX = x; lastY = y;
    FERRY.sail.x = x; FERRY.sail.y = y; FERRY.sail.yaw = yaw;
  }

  function onInteract(ctx) {
    if (ctx.scene.kind !== 'out' || ctx.npc || ctx.mode === 'message') return false;
    if (aboard) { if (ctx.mode === 'talk') land(); return true; }
    var f = ferry(), t = ctx.tile;
    if (!f || !t) return false;
    var onBoat = (t.x === f.wa.x && t.y === f.wa.y) || (t.x === f.wb.x && t.y === f.wb.y);
    if (!onBoat && !(ctx.mode === 'talk' && landing())) return false;
    if (ctx.mode === 'bump') return true; // walking into the boat does not row it
    if (!landing()) { GT.toast($t('Dekati dermaga dulu, lalu naik perahu.')); return true; }
    row();
    return true;
  }

  /* a small rowing boat on the water tile: hull, a plank seat, an oar (2D only; the 2.5D view has real models) */
  function drawBoat(g, x, y, T) {
    var u = T / 12;
    g.fillStyle = '#2a2430'; g.fillRect(x + 1 * u, y + 5 * u, 10 * u, 5 * u);
    g.fillStyle = '#9a6234'; g.fillRect(x + 2 * u, y + 5 * u, 8 * u, 3 * u);
    g.fillStyle = '#c8894a'; g.fillRect(x + 2 * u, y + 5 * u, 8 * u, 1 * u);
    g.fillStyle = '#6a4020'; g.fillRect(x + 3 * u, y + 8 * u, 6 * u, 1 * u);
    g.fillStyle = '#e0bc80'; g.fillRect(x + 5 * u, y + 6 * u, 2 * u, 1 * u);
    g.fillStyle = '#6a4020'; g.fillRect(x + 9 * u, y + 2 * u, 1 * u, 7 * u);
  }
  // 2D boats on the ground layer, so the player (drawn after) sits in the boat they ride
  function onDrawGround(ctx, camX, camY, T) {
    if (GT.view3dOn && GT.view3dOn()) return;
    var f = ferry(); if (!f) return;
    var t = performance.now() / 1000;
    [[f.wa, 0], [f.wb, 1]].forEach(function (d) {
      if (aboard && FERRY.sail && FERRY.sail.fromIdx === d[1]) return; // its boat is out on the water
      drawBoat(ctx, d[0].x * T - camX, d[0].y * T - camY + Math.round(Math.sin(t * 1.6 + d[1] * 2) * 0.6), T);
    });
    if (aboard && FERRY.sail) drawBoat(ctx, FERRY.sail.x * T - camX, FERRY.sail.y * T - camY + Math.round(Math.sin(t * 3) * 0.8), T);
  }
  function onDraw(ctx, camX, camY, T) {
    var f = ferry();
    if (!f) return;
    var v3 = GT.view3dOn && GT.view3dOn(), p = GT.player;
    if (aboard) { // the hint over the boat: where you can step off
      if (!window.GT_THEME || !GT_THEME.label || !shores().length) return;
      var pb = GT.at(p.x, p.y);
      GT_THEME.label(ctx, '⛵ ' + $t('Spasi: turun ke darat'), pb.x + T / 2, v3 ? pb.y - 4 : pb.y - T * 0.9, { tone: 'dark', size: 6, bold: true });
      return;
    }
    var which = landing();
    // a small sign over each boat: Perahu, and where it goes
    if (window.GT_THEME && GT_THEME.label) [[f.wa, $t('Ke pulau seberang')], [f.wb, $t('Ke daratan')]].forEach(function (d) {
      var a = GT.at(d[0].x, d[0].y);
      GT_THEME.label(ctx, '⛵ ' + $t('Perahu') + ' · ' + d[1], a.x + T / 2, v3 ? a.y + T - 8 : a.y - 1, { tone: 'paper', size: 6, bold: true });
    });
    if (!which) return;
    // the hint floats over the player, in world coordinates like the boats
    var txt = '⛵ ' + (which === 'a' ? $t('Spasi: naik perahu ke pulau seberang') : $t('Spasi: naik perahu ke daratan'));
    var pa = GT.at(p.x, p.y);
    GT_THEME.label(ctx, txt, pa.x + T / 2, v3 ? pa.y - 4 : pa.y - T * 0.9, { tone: 'dark', size: 6, bold: true });
  }

  GT.register({ id: 'ferry', onInteract: onInteract, onFrame: onFrame, onDraw: onDraw, onDrawGround: onDrawGround });
})();
