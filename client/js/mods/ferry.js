/*
 * ferry.js - the public boat between the public village's mainland shore and the island in its bottom-right corner (the 'danau'
 * chunk, which no path reaches). GTVillage.ferryOf(layout) gives the two docks: a boat floats on a water tile beside each landing.
 * Walk up to a landing (or face the boat), press Space / F / the action button, or click the boat: the server's 'boat' act checks you
 * stand there and moves you to the other landing. The ride itself is only the picture: the boat carries you across with the camera
 * following (GT.setSail) and you step out at the other dock.
 * Boats: 2D sprites drawn here under the characters; in 2.5D real 3D models (three/fun.js GT3.Boats), which read window.GT_FERRY.sail.
 */
(function () {
  'use strict';
  var GT = window.GT;
  if (!GT) return;
  var busy = false, sail = null;
  var FERRY = window.GT_FERRY = { sail: null };

  function sfx(n, o) { try { window.GT_SFX && GT_SFX.play(n, o); } catch (e) { /* sound must never break the game */ } }
  function world() { return (GT.worldId && GT.worldId()) || 'public'; }
  function ferry() {
    var L = GT.world && GT.world.layout, V = window.GTVillage;
    if (world() !== 'public' || !L || !V || !V.ferryOf) return null;
    try { return V.ferryOf(L); } catch (e) { return null; }
  }
  function near(p, q) { return Math.abs(Math.round(p.x) - q.x) + Math.abs(Math.round(p.y) - q.y) <= 1; }
  function landing() { var f = ferry(), p = GT.player; if (sail || !f || !p || !GT.scene || GT.scene.kind !== 'out') return null; return near(p, f.a) ? 'a' : near(p, f.b) ? 'b' : null; }

  function row() {
    var C = window.GT_CHAIN, f = ferry(), which = landing();
    if (busy || sail || !f || !which) return;
    if (!C || !C.state || !C.state.account) { GT.toast($t('Masuk dulu untuk naik perahu.')); return; }
    busy = true;
    C.act({ action: 'boat', world: 'public' }, true).then(function (r) {
      if (!r || !r.arrive) return;
      var from = which === 'a' ? f.wa : f.wb, to = which === 'a' ? f.wb : f.wa;
      startSail(from, to, r.arrive, which === 'a' ? 0 : 1, which === 'a' ? $t('pulau seberang') : $t('daratan'));
    }, function () { /* act() already said why */ }).then(function () { busy = false; });
  }

  // the trip: the boat leaves its dock, glides over the water (about 0.45 s per tile, 2.4 s at least) and the player steps out at the other landing
  function startSail(from, to, arrive, fromIdx, toName) {
    var dx = to.x - from.x, dy = to.y - from.y, dist = Math.abs(dx) + Math.abs(dy);
    sail = { t: 0, dur: Math.max(2.4, dist * 0.45), from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y }, arrive: arrive, fromIdx: fromIdx, yaw: Math.atan2(dx, dy) + Math.PI / 2 };
    FERRY.sail = { x: from.x, y: from.y, yaw: sail.yaw, fromIdx: fromIdx };
    GT.setSail(from.x, from.y);
    GT.toast('⛵ ' + $t('Perahu berangkat ke {0}…', [toName]));
    sfx('ui_open');
  }
  function endSail() {
    var a = sail.arrive;
    sail = null; FERRY.sail = null;
    GT.setSail(null);
    GT.teleportPlayer(null, a.x, a.y);
    sfx('ui_close');
    GT.toast('⛵ ' + $t('Kamu tiba di dermaga.'));
  }
  function onFrame(dt) {
    if (!sail) return;
    sail.t += Math.min(dt, 0.1);
    var k = Math.min(1, sail.t / sail.dur), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; // eases out of the dock and into the next
    var x = sail.from.x + (sail.to.x - sail.from.x) * e, y = sail.from.y + (sail.to.y - sail.from.y) * e;
    FERRY.sail.x = x; FERRY.sail.y = y;
    GT.setSail(x, y);
    if (k >= 1) endSail();
  }
  // while the boat sails, walking is not possible (the camera and the player's picture are on the boat)
  function onKey(e) { return !!sail && !/^F\d|Tab|Escape/.test(e.code || e.key || ''); }

  function onInteract(ctx) {
    if (ctx.scene.kind !== 'out' || ctx.npc || ctx.mode === 'message') return false;
    if (sail) return true;
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
      if (sail && sail.fromIdx === d[1]) return; // its boat is out on the water
      drawBoat(ctx, d[0].x * T - camX, d[0].y * T - camY + Math.round(Math.sin(t * 1.6 + d[1] * 2) * 0.6), T);
    });
    if (sail) drawBoat(ctx, FERRY.sail.x * T - camX, FERRY.sail.y * T - camY + Math.round(Math.sin(t * 3) * 0.8), T);
  }
  function onDraw(ctx, camX, camY, T) {
    var f = ferry();
    if (!f || sail) return;
    var v3 = GT.view3dOn && GT.view3dOn(), which = landing(), p = GT.player;
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

  GT.register({ id: 'ferry', onInteract: onInteract, onFrame: onFrame, onKey: onKey, onDraw: onDraw, onDrawGround: onDrawGround });
})();
