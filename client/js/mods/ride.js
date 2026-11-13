/*
 * ride.js - ride the carousel on the public square. Face it (or stand by it) and press Space / F, or click it: a small
 * window names the price in coin; "Naik" asks the server (act ride, which charges the coin) and the player climbs on a
 * horse only when it says yes. The ride lasts the seconds the server names (fun.rideSecs), then the player gets off. In the 2.5D view the player sits on the first horse, rising and falling as it turns, and
 * the camera goes low and circles the ride for a cinematic shot (view3d.js reads window.GT_RIDE); both views get
 * letterbox bars, a vignette and a warm colour grade (css/game.css, html.gt-riding). Walking or Esc gets off.
 * Only the picture is visual: the server still has the player standing where they climbed on.
 */
(function () {
  'use strict';
  var GT = window.GT;
  if (!GT) return;
  var R = window.GT_RIDE = { on: false, at: null, hidden: false, until: 0 };
  var asking = false;
  var bars = null, MOVE = { ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, KeyW: 1, KeyA: 1, KeyS: 1, KeyD: 1 };

  function sfx(n, o) { try { window.GT_SFX && GT_SFX.play(n, o); } catch (e) { /* sound must never break the game */ } }
  function music(on) { try { window.GT_MUSIC && GT_MUSIC.ride(on); } catch (e) { /* sound must never break the game */ } }
  function carousel() {
    var L = GT.world, w = (GT.worldId && GT.worldId()) || 'public';
    var fun = L && (L.fun || (L.layout && L.layout.fun)); // the engine's world keeps the generator's spots under layout
    return w === 'public' && fun && fun.carousel ? fun.carousel : null;
  }
  function near(c, t) { return Math.max(Math.abs(t.x - (c.x + 0.5)), Math.abs(t.y - (c.y + 0.5))) <= 3; }

  function start(secs) {
    if (R.on) return;
    var p = GT.player;
    R.until = secs > 0 ? Date.now() + secs * 1000 : 0;
    sfx('ride'); music(true); R.on = true; R.at = { x: Math.round(p.x), y: Math.round(p.y) };
    document.documentElement.classList.add('gt-riding');
    if (GT.setCleanView) GT.setCleanView(true); // no tags, bubbles or markers over the ride
    if (!bars) { bars = document.createElement('div'); bars.className = 'gt-ride-bars'; bars.setAttribute('aria-hidden', 'true'); bars.innerHTML = '<i></i><i></i>'; }
    document.body.appendChild(bars);
    // in 2D there is no horse to sit on: the player rides out of sight; the 2.5D view seats them on a horse
    R.hidden = !(GT.view3dOn && GT.view3dOn());
    if (R.hidden && GT.setPlayerHidden) GT.setPlayerHidden(true);
    GT.toast('🎠 ' + $t('Naik kuda putar · jalan atau Esc untuk turun'));
  }
  function stop() {
    if (!R.on) return;
    sfx('ui_close'); music(false); R.on = false; R.at = null; R.until = 0;
    document.documentElement.classList.remove('gt-riding');
    if (GT.setCleanView) GT.setCleanView(false);
    if (bars && bars.parentNode) bars.parentNode.removeChild(bars);
    if (R.hidden && GT.setPlayerHidden) GT.setPlayerHidden(false);
    R.hidden = false;
  }

  function onInteract(ctx) {
    if (ctx.scene.kind !== 'out' || ctx.npc || ctx.mode !== 'talk') return false;
    var c = carousel();
    if (!c || !near(c, ctx.tile) || !near(c, GT.player)) return false;
    if (R.on) stop(); else ask();
    return true;
  }
  // the price comes from the server's state (fun.ride); the coin is taken by act ride, so a failed answer means no ride
  function ask() {
    var C = window.GT_CHAIN, st = C && C.state && C.state.st, price = st && st.fun && st.fun.ride != null ? st.fun.ride : 10, secs = st && st.fun && st.fun.rideSecs ? st.fun.rideSecs : 90;
    if (!C || !C.state.account) { GT.toast($t('Masuk dulu.')); return; }
    if (asking) return;
    asking = true;
    var coins = st && st.bag && st.bag.coin ? st.bag.coin.settled + st.bag.coin.today : null;
    var body = document.createElement('div');
    var p1 = document.createElement('p'); p1.textContent = $t('Naik kuda putar selama {0} detik? Tarifnya {1} koin.', [secs, price]); body.appendChild(p1);
    if (coins != null) { var p2 = document.createElement('p'); p2.className = 'chain-dim'; p2.textContent = $t('Koinmu: {0}', [coins]); body.appendChild(p2); }
    GT.modal({ title: '🎠 ' + $t('Kuda Putar'), body: body, onClose: function () { asking = false; }, actions: [
      { label: $t('Naik · {0} koin', [price]), primary: true, disabled: coins != null && coins < price, onClick: function (h) {
        h.close('ok');
        C.act({ action: 'ride' }).then(function (r) { if (r && r.ride && !R.on) start(r.ride.secs); }, function () { /* the server said no (no coin, too far): its message is the toast */ });
        return true;
      } },
      { label: $t('Batal'), close: true }
    ] });
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
    if (R.until && Date.now() > R.until) { stop(); GT.toast('🎠 ' + $t('Putarannya selesai.')); return; }
    if (!carousel() || GT.scene.kind !== 'out' || Math.round(p.x) !== R.at.x || Math.round(p.y) !== R.at.y) stop();
  }

  GT.register({ id: 'ride', onInteract: onInteract, onKey: onKey, onFrame: onFrame });
})();
