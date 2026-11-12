/*
 * ferry.js - the boat to the island in the public village's bottom-right corner (the 'danau' chunk, which no path
 * reaches). GTVillage.ferryOf(layout) gives the two boats: one on the mainland shore and one on the island, each
 * floating on a water tile beside its landing. Face a boat (or stand beside it) and press Space / F, or click it:
 * the server's 'boat' act checks you stand there and moves you to the other landing.
 * Draws the boats in the 2D view, and a small hint over the player near a boat in both views.
 */
(function () {
  'use strict';
  var GT = window.GT;
  if (!GT) return;
  var busy = false;

  function world() { return (GT.worldId && GT.worldId()) || 'public'; }
  function ferry() {
    var L = GT.world, V = window.GTVillage;
    if (world() !== 'public' || !L || !V || !V.ferryOf) return null;
    try { return V.ferryOf(L); } catch (e) { return null; }
  }
  function near(p, q) { return Math.abs(Math.round(p.x) - q.x) + Math.abs(Math.round(p.y) - q.y) <= 1; }
  function landing() { var f = ferry(), p = GT.player; if (!f || !p || !GT.scene || GT.scene.kind !== 'out') return null; return near(p, f.a) ? 'a' : near(p, f.b) ? 'b' : null; }

  function row() {
    var C = window.GT_CHAIN;
    if (busy || !C || !C.state || !C.state.account) { if (!busy) GT.toast($t('Masuk dulu untuk naik perahu.')); return; }
    busy = true;
    C.act({ action: 'boat', world: 'public' }, true).then(function (r) {
      if (r && r.arrive) GT.teleportPlayer(null, r.arrive.x, r.arrive.y);
    }, function () { /* act() already said why */ }).then(function () { busy = false; });
  }

  function onInteract(ctx) {
    if (ctx.scene.kind !== 'out' || ctx.npc || ctx.mode === 'message') return false;
    var f = ferry(), t = ctx.tile;
    if (!f || !t) return false;
    var onBoat = (t.x === f.wa.x && t.y === f.wa.y) || (t.x === f.wb.x && t.y === f.wb.y);
    if (!onBoat && !(ctx.mode === 'talk' && landing())) return false;
    if (ctx.mode === 'bump') return true; // walking into the boat does not row it
    row();
    return true;
  }

  /* a small rowing boat on the water tile: hull, a plank seat, an oar */
  function drawBoat(g, x, y, T) {
    var u = T / 12;
    g.fillStyle = '#2a2430'; g.fillRect(x + 1 * u, y + 5 * u, 10 * u, 5 * u);
    g.fillStyle = '#9a6234'; g.fillRect(x + 2 * u, y + 5 * u, 8 * u, 3 * u);
    g.fillStyle = '#c8894a'; g.fillRect(x + 2 * u, y + 5 * u, 8 * u, 1 * u);
    g.fillStyle = '#6a4020'; g.fillRect(x + 3 * u, y + 8 * u, 6 * u, 1 * u);
    g.fillStyle = '#e0bc80'; g.fillRect(x + 5 * u, y + 6 * u, 2 * u, 1 * u);
    g.fillStyle = '#6a4020'; g.fillRect(x + 9 * u, y + 2 * u, 1 * u, 7 * u);
  }
  function onDraw(ctx, camX, camY, T) {
    var f = ferry();
    if (!f) return;
    if (!(GT.view3dOn && GT.view3dOn())) { drawBoat(ctx, f.wa.x * T - camX, f.wa.y * T - camY, T); drawBoat(ctx, f.wb.x * T - camX, f.wb.y * T - camY, T); }
    var which = landing(), p = GT.player;
    if (!which) return;
    // the hint floats over the player, in world coordinates like the boats
    var txt = '⛵ ' + (which === 'a' ? $t('Spasi: naik perahu ke pulau') : $t('Spasi: naik perahu ke daratan'));
    var fs = Math.max(6, Math.round(T * 0.42));
    ctx.save(); ctx.font = '600 ' + fs + 'px sans-serif';
    var w = ctx.measureText(txt).width + fs, x = (p.x + 0.5) * T - camX - w / 2, y = p.y * T - camY - T * 1.6;
    ctx.fillStyle = 'rgba(20,21,42,.85)'; ctx.fillRect(x, y, w, fs * 1.7);
    ctx.fillStyle = '#fff'; ctx.fillText(txt, x + fs / 2, y + fs * 1.2);
    ctx.restore();
  }

  GT.register({ id: 'ferry', onInteract: onInteract, onDraw: onDraw });
})();
