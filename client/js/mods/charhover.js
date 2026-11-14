/*
 * Character hover: rest the mouse ~0.3 s over another player, a merchant or a Homeland worker and a pulsing outline appears (dim when you
 * are too far). A click within 3 tiles interacts (player card, shop, worker info); farther away it only says to come closer.
 * Boxes are collected while the overlays draw (so 2D and 2.5D share the maths: GT.at gives each tile's point in overlay units) and
 * tested in those units; a click on a character is taken in the capture phase so it does not also walk (mods/mouse.js).
 */
(function () {
  'use strict';
  var GT = window.GT; if (!GT) return;
  var REACH = 3, HOLD = 300;
  var boxes = [], view = { w: 1, h: 1 }, mx = -1, my = -1, cand = null, since = 0, cursorOn = false, lit = false;
  var JOBS = { builder: $t('Tukang'), petani: $t('Petani'), nelayan: $t('Nelayan'), penebang: $t('Penebang'), hunter: $t('Pemburu'), chef: $t('Koki') };

  function dist(x, y) { var p = GT.player; return p ? Math.hypot(x - p.x, y - p.y) : 99; }
  function active() { return !GT.isUiOpen() && !(window.GT_FISH && GT_FISH.active()) && !document.documentElement.classList.contains('gt-fighting'); }

  function collect(ctx, T) {
    boxes = [];
    var sc = GT.scene; if (!sc) return;
    var v3 = GT.view3dOn && GT.view3dOn(), now = performance.now();
    view.w = ctx.canvas.width / (ctx.getTransform().a || 1); view.h = ctx.canvas.height / (ctx.getTransform().d || 1);
    function add(id, x, y, data) {
      var a = GT.at(x, y), b;
      if (v3) { var fx = a.x + 6, fy = a.y + 12; b = { x0: fx - T * 0.55, x1: fx + T * 0.55, y0: fy - T * 1.6, y1: fy + 2 }; }
      else b = { x0: a.x - 1, x1: a.x + T + 1, y0: a.y - 4, y1: a.y + T + 1 };
      b.id = id; b.d = dist(x, y); b.data = data; b.tx = x; b.ty = y; boxes.push(b);
    }
    (sc.npcs || []).forEach(function (n) {
      if (n.hidden || !n.key) return;
      var kind = n.key.indexOf('merchant:') === 0 ? 'merchant' : n.key.indexOf('homeland:') === 0 ? 'worker' : null; if (!kind) return;
      var t = n.moving ? Math.min(1, n.t || 0) : 1, x = n.moving ? n.fx + (n.x - n.fx) * t : n.x, y = n.moving ? n.fy + (n.y - n.fy) * t : n.y;
      add(n.key, x, y, { kind: kind, npc: n });
    });
    if (window.GT_PLAYERS) {
      var others = GT_PLAYERS._others();
      Object.keys(others).forEach(function (a) {
        var o = others[a]; if (!o || o.npc) return;
        var w = GT_PLAYERS.where(a); if (w) add('player:' + a, w.x, w.y, { kind: 'player', o: o });
      });
    }
  }

  function hit(cx, cy) {
    var cv = document.getElementById('cv'); if (!cv) return null;
    var r = cv.getBoundingClientRect(); if (!r.width) return null;
    var ux = (cx - r.left) / r.width * view.w, uy = (cy - r.top) / r.height * view.h, best = null;
    boxes.forEach(function (b) { if (ux >= b.x0 && ux <= b.x1 && uy >= b.y0 && uy <= b.y1 && (!best || b.y1 > best.y1)) best = b; });
    return best;
  }

  function onDraw(ctx, camX, camY, T) {
    collect(ctx, T);
    var cv = ctx.canvas, h = active() && mx >= 0 ? hit(mx, my) : null, now = performance.now();
    if (!h || h.id !== (cand && cand.id)) { cand = h; since = now; }
    else cand = h;
    var on = !!(cand && now - since >= HOLD);
    if (on !== cursorOn) { cursorOn = on; cv.style.cursor = on ? 'pointer' : ''; }
    var v3 = GT.view3dOn && GT.view3dOn(), V = window.GT_VIEW3D;
    if (!on) { if (lit && V && V.highlight) V.highlight(null, 0); lit = false; return; }
    var near = cand.d <= REACH, lv = near ? 2 : 1;
    // the outline follows the figure: in 2.5D the character card itself carries it (three/actor.js), in 2D a ring of
    // pixels round the sprite is drawn over it
    if (v3 && V && V.highlight) { V.highlight(cand.data.kind === 'player' ? cand.id : cand.data.npc, lv); lit = true; return; }
    if (lit && V && V.highlight) { V.highlight(null, 0); lit = false; }
    var ring = ring2d(cand.data, lv); if (!ring) return;
    var a = GT.at(cand.tx, cand.ty), pulse = 0.5 + 0.5 * Math.sin(Date.now() / 260);
    ctx.save(); ctx.globalAlpha = near ? 0.75 + 0.25 * pulse : 0.6; ctx.drawImage(ring, Math.round(a.x) - OX, Math.round(a.y) - OY); ctx.restore();
  }
  // 2D: the figure drawn off screen exactly as the game draws it, then the 1 px ring of empty pixels touching it
  var OX = 8, OY = 16, rings = {};
  function ring2d(d, lv) {
    var o = d.o, n = d.npc, W = window.GT_WORN;
    var look = n ? n.pal | 0 : (o.look | 0), dir = (n ? n.dir : o.dir) || 'down', worn = o && o.worn ? o.worn : null;
    var key = look + ':' + dir + ':' + lv + ':' + (worn ? JSON.stringify(worn) : '');
    if (rings[key]) return rings[key];
    var c = document.createElement('canvas'); c.width = 32; c.height = 40;
    var g = c.getContext('2d');
    try {
      if (W && worn) W.back(g, OX, OY, worn, dir, 0);
      GT.drawChar(g, OX, OY, look, dir, 0);
      if (W && worn) W.front(g, OX, OY, worn, dir, 0);
    } catch (e) { return null; }
    var src = g.getImageData(0, 0, 32, 40).data, out = g.createImageData(32, 40), px = out.data;
    function solid(x, y) { return x >= 0 && y >= 0 && x < 32 && y < 40 && src[(y * 32 + x) * 4 + 3] >= 128; }
    for (var y = 0; y < 40; y++) for (var x = 0; x < 32; x++) {
      if (solid(x, y) || !(solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1))) continue;
      var i = (y * 32 + x) * 4; px[i] = 255; px[i + 1] = lv > 1 ? 226 : 240; px[i + 2] = lv > 1 ? 110 : 190; px[i + 3] = 255;
    }
    g.clearRect(0, 0, 32, 40); g.putImageData(out, 0, 0);
    return (rings[key] = c);
  }

  function workerInfo(npc) {
    var H = window.GT_HOME && GT_HOME.state && GT_HOME.state(), name = npc.name, job = '', fat = null, m = /^homeland:bot:(\d+)$/.exec(npc.key);
    if (H) {
      if (m) {
        var id = +m[1];
        (H.bots || []).forEach(function (b) { if (b.id === id) { job = JOBS[b.job] || b.job; name = b.name || name; } });
        (H.workers || []).forEach(function (w) { if (w.slot === id) fat = Math.round(w.fatigue); });
      } else if (npc.key === 'homeland:builder') {
        job = JOBS.builder; var w0 = (H.workers || [])[0]; if (w0) fat = Math.round(w0.fatigue);
      }
    }
    return name + (job ? ' · ' + job : '') + (fat != null ? ' · ' + $t('Lelah {0}%', [fat]) : '');
  }

  function onClick(e) {
    if (e.button !== 0 || !e.target || e.target.id !== 'cv' || !active()) return;
    if (window.GT_VIEW3D && GT_VIEW3D.tookClick && GT_VIEW3D.tookClick()) return; // the end of a drag-to-walk, not a click
    var b = hit(e.clientX, e.clientY); if (!b) return;
    e.stopImmediatePropagation(); e.preventDefault();
    if (b.d > REACH) { GT.toast($t('Dekati dulu untuk berinteraksi.')); return; }
    var d = b.data;
    if (d.kind === 'player') { if (GT_PLAYERS.card) GT_PLAYERS.card(d.o); }
    else if (d.kind === 'merchant') { if (window.GT_CHAIN) GT_CHAIN.open('shop', d.npc.key.slice(9)); }
    else GT.toast(workerInfo(d.npc));
  }

  GT.register({ id: 'charhover', init: function () {
    window.addEventListener('mousemove', function (e) { mx = e.clientX; my = e.clientY; });
    window.addEventListener('click', onClick, true);
  }, onDraw: onDraw });
})();
