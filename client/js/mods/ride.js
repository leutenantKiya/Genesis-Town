/*
 * ride.js - ride the carousel on the public square. Face it (or stand by it) and press Space / F, or click it: the
 * player climbs on a horse. In the 2.5D view the player sits on the first horse, rising and falling as it turns, and
 * the camera goes low and circles the ride for a cinematic shot (view3d.js reads window.GT_RIDE); both views get
 * letterbox bars, a vignette and a warm colour grade (css/game.css, html.gt-riding). Walking or Esc gets off.
 * Purely visual: the server still has the player standing where they climbed on.
 */
(function () {
  'use strict';
  var GT = window.GT;
  if (!GT) return;
  var R = window.GT_RIDE = { on: false, at: null, hidden: false };
  var bars = null, MOVE = { ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, KeyW: 1, KeyA: 1, KeyS: 1, KeyD: 1 };

  function carousel() {
    var L = GT.world, w = (GT.worldId && GT.worldId()) || 'public';
    var fun = L && (L.fun || (L.layout && L.layout.fun)); // the engine's world keeps the generator's spots under layout
    return w === 'public' && fun && fun.carousel ? fun.carousel : null;
  }
  function near(c, t) { return Math.max(Math.abs(t.x - (c.x + 0.5)), Math.abs(t.y - (c.y + 0.5))) <= 3; }

  function start() {
    if (R.on) return;
    var p = GT.player;
    R.on = true; R.at = { x: Math.round(p.x), y: Math.round(p.y) };
    document.documentElement.classList.add('gt-riding');
    if (!bars) { bars = document.createElement('div'); bars.className = 'gt-ride-bars'; bars.setAttribute('aria-hidden', 'true'); bars.innerHTML = '<i></i><i></i>'; }
    document.body.appendChild(bars);
    // in 2D there is no horse to sit on: the player rides out of sight; the 2.5D view seats them on a horse
    R.hidden = !(GT.view3dOn && GT.view3dOn());
    if (R.hidden && GT.setPlayerHidden) GT.setPlayerHidden(true);
    GT.toast('🎠 ' + $t('Naik kuda putar · jalan atau Esc untuk turun'));
  }
  function stop() {
    if (!R.on) return;
    R.on = false; R.at = null;
    document.documentElement.classList.remove('gt-riding');
    if (bars && bars.parentNode) bars.parentNode.removeChild(bars);
    if (R.hidden && GT.setPlayerHidden) GT.setPlayerHidden(false);
    R.hidden = false;
  }

  function onInteract(ctx) {
    if (ctx.scene.kind !== 'out' || ctx.npc || ctx.mode !== 'talk') return false;
    var c = carousel();
    if (!c || !near(c, ctx.tile) || !near(c, GT.player)) return false;
    if (R.on) stop(); else start();
    return true;
  }
  function onKey(e) {
    if (!R.on || e.type !== 'keydown') return false;
    if (e.code === 'Escape') { stop(); return true; }
    if (MOVE[e.code]) stop(); // and the step goes on as usual
    return false;
  }
  function onFrame() {
    if (!R.on) return;
    var p = GT.player;
    if (!carousel() || GT.scene.kind !== 'out' || Math.round(p.x) !== R.at.x || Math.round(p.y) !== R.at.y) stop();
  }

  GT.register({ id: 'ride', onInteract: onInteract, onKey: onKey, onFrame: onFrame });
})();
