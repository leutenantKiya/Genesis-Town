/*
 * fishing.js - fishing as a small skill game.
 * - Ripples mark the water where fish are gathering (they move every two game hours). Casting there gets a bite
 *   sooner and an easier fish; plain water still works, just slower and harder.
 * - Act on water (click, F, A): the line is cast, the float bobs while you wait, and "!" shows when a fish bites.
 *   Press in time and the reel starts: hold the button to lift the green zone, let go to drop it, and keep the fish
 *   inside until the catch bar is full. Let it escape and the bar empties.
 * - While fishing the screen is clean: only the reel bar and one button. Esc stops.
 * The catch itself is the normal gather action on the server (chain.js passes onCatch), so energy, node charges and
 * seasons work exactly as before; a fish that gets away costs nothing.
 */
(function () {
  'use strict';
  var GT = window.GT;
  if (!GT) return;

  var F = null;        // the current attempt: { phase, t, tile, spot, bite, zone, zv, fish, ft, ftT, prog, hold, opts }
  var ui = null;       // overlay elements
  var HOLD_KEYS = { Space: 1, KeyF: 1, Enter: 1, KeyZ: 1 };

  function hash(a, b, c) { var h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 2147483647)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
  function chain() { return window.GT_CHAIN; }
  function bucket() { var c = chain(), st = c && c.state.st; return st && st.time ? Math.floor(st.time.totalHours / 2) : Math.floor(Date.now() / 120000); }
  function empty(x, y) { var c = chain(), e = c && c.state.emptyWater; return !!(e && e[x + ',' + y] && e[x + ',' + y] > Date.now()); }

  /** Fish gather at about one in six shore tiles (water next to land), different every two game hours. */
  function isSpot(x, y) {
    var sc = GT.scene, m = sc && sc.map;
    if (!m || sc.kind !== 'out' || m.tiles[y * m.w + x] !== 'water' || empty(x, y)) return false;
    var shore = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(function (d) { var nx = x + d[0], ny = y + d[1]; return nx >= 0 && ny >= 0 && nx < m.w && ny < m.h && m.walk[ny * m.w + nx] === 1; });
    return shore && hash(x, y, bucket()) < 0.17;
  }

  /* ---------------------------------------------------------------- drawing */
  function onDrawGround(ctx, camX, camY, T) {
    var sc = GT.scene, m = sc && sc.map;
    if (!m || sc.kind !== 'out') return;
    var vw = ctx.canvas.width, vh = ctx.canvas.height, t = performance.now() / 1000;
    var x0 = Math.max(0, Math.floor(camX / T)), y0 = Math.max(0, Math.floor(camY / T));
    var x1 = Math.min(m.w - 1, Math.ceil((camX + vw) / T)), y1 = Math.min(m.h - 1, Math.ceil((camY + vh) / T));
    ctx.save();
    ctx.lineWidth = 1;
    for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) {
      if (!isSpot(x, y)) continue;
      var cx = x * T - camX + T / 2, cy = y * T - camY + T / 2, h = hash(x, y, 7);
      for (var k = 0; k < 3; k++) {
        var ph = (t * 0.5 + k / 3 + h) % 1, r = 1.5 + ph * (T * 0.55);
        ctx.strokeStyle = 'rgba(240,252,250,' + (1 - ph).toFixed(3) + ')';
        ctx.beginPath(); ctx.ellipse(Math.round(cx) + 0.5, Math.round(cy) + 0.5, r, r * 0.5, 0, 0, Math.PI * 2); ctx.stroke();
      }
      // bubbles rising at the centre
      if ((t * 1.3 + h * 5) % 2 < 0.6) { ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fillRect(Math.round(cx) - 1, Math.round(cy) - 1, 1, 1); ctx.fillRect(Math.round(cx) + 1, Math.round(cy) - 2, 1, 1); }
      // a fish shadow slipping by now and then
      var sw = (t * 0.35 + h * 3) % 3;
      if (sw < 1) { ctx.fillStyle = 'rgba(16,40,70,0.45)'; ctx.fillRect(Math.round(cx - 3 + sw * 6), Math.round(cy + 2), 3, 1); }
    }
    ctx.restore();
  }

  function rodTip(T, camX, camY) {
    var p = GT.player, off = { up: [8, 0], down: [9, 6], left: [1, 3], right: [11, 3] }[p.dir] || [9, 4], a = GT.at(p.x, p.y);
    return { x: a.x + off[0], y: a.y + off[1] };
  }

  function onDraw(ctx, camX, camY, T) {
    if (!F) return;
    var tip = rodTip(T, camX, camY), t = performance.now() / 1000;
    var fa = GT.at(F.tile.x, F.tile.y), bx = fa.x + T / 2, by = fa.y + T / 2;
    if (F.phase === 'cast') { // the float flies in an arc
      var k = Math.min(1, F.t / 0.45);
      bx = tip.x + (bx - tip.x) * k; by = tip.y + (by - tip.y) * k - Math.sin(k * Math.PI) * 10;
    } else if (F.phase === 'wait') by += Math.round(Math.sin(t * 4) * 0.8);
    else if (F.phase === 'bite') by += 2;
    else if (F.phase === 'reel') { bx += Math.round(Math.sin(t * 9) * 1.5); by += 1; }
    ctx.save();
    // rod and line
    ctx.strokeStyle = '#6a3f22'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(tip.x - 3, tip.y + 4); ctx.lineTo(tip.x + 0.5, tip.y + 0.5); ctx.stroke();
    ctx.strokeStyle = 'rgba(245,245,235,0.85)';
    ctx.beginPath(); ctx.moveTo(tip.x + 0.5, tip.y + 0.5);
    ctx.quadraticCurveTo((tip.x + bx) / 2, Math.max(tip.y, by) + (F.phase === 'reel' ? -2 : 4), bx, by); ctx.stroke();
    // float: red top, white bottom
    ctx.fillStyle = '#e8503c'; ctx.fillRect(Math.round(bx) - 1, Math.round(by) - 2, 2, 2);
    ctx.fillStyle = '#f4f4ec'; ctx.fillRect(Math.round(bx) - 1, Math.round(by), 2, 1);
    if (F.phase === 'bite' || F.phase === 'reel') { // splash rings
      var ph = (t * 1.6) % 1;
      ctx.strokeStyle = 'rgba(232,248,246,' + (1 - ph).toFixed(3) + ')';
      ctx.beginPath(); ctx.ellipse(Math.round(bx) + 0.5, Math.round(by) + 1.5, 2 + ph * 5, (2 + ph * 5) * 0.45, 0, 0, Math.PI * 2); ctx.stroke();
    }
    if (F.phase === 'bite') { // "!" over the player
      var pa = GT.at(GT.player.x, GT.player.y), px = pa.x + T / 2, py = pa.y - 7 + Math.round(Math.sin(t * 20));
      var TH = window.GT_THEME;
      ctx.fillStyle = (TH && TH.get('outline')) || '#0b0c16'; ctx.fillRect(px - 2, py - 1, 4, 9);
      ctx.fillStyle = (TH && TH.get('gold')) || '#f2c94c'; ctx.fillRect(px - 1, py, 2, 5); ctx.fillRect(px - 1, py + 6, 2, 1);
    }
    ctx.restore();
  }

  /* ---------------------------------------------------------------- overlay (bar + one button) */
  function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }
  function buildUi() {
    var screen = document.getElementById('screen');
    if (!screen) return null;
    var root = el('div', 'gt-fish'), meter = el('div', 'gt-fish-meter');
    var track = el('div', 'gt-fish-track'), zone = el('div', 'gt-fish-zone'), fish = el('div', 'gt-fish-fish');
    var prog = el('div', 'gt-fish-prog'), fill = el('div', 'gt-fish-fill');
    track.appendChild(zone); track.appendChild(fish); prog.appendChild(fill);
    meter.appendChild(track); meter.appendChild(prog);
    var btn = el('button', 'gt-fish-btn'); btn.type = 'button';
    root.appendChild(meter); root.appendChild(btn);
    function down(e) { e.preventDefault(); e.stopPropagation(); try { btn.setPointerCapture(e.pointerId); } catch (_) { /* old browsers */ } press(); }
    function up(e) { e.preventDefault(); if (F) F.hold = false; }
    btn.addEventListener('pointerdown', down);
    btn.addEventListener('pointerup', up); btn.addEventListener('pointercancel', up); btn.addEventListener('lostpointercapture', up);
    btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); });
    btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    screen.appendChild(root);
    return { root: root, meter: meter, zone: zone, fish: fish, fill: fill, btn: btn };
  }
  function phoneish() { return document.documentElement.classList.contains('gt-phone') || matchMedia('(pointer: coarse)').matches; }
  function render() {
    if (!ui || !F) return;
    var reel = F.phase === 'reel';
    ui.meter.hidden = !reel;
    var key = phoneish() ? '' : ' (Spasi)';
    ui.btn.textContent = F.phase === 'bite' ? 'Tarik!' + key : reel ? 'Tahan' + key : 'Menunggu…';
    ui.btn.classList.toggle('hot', F.phase === 'bite');
    ui.btn.classList.toggle('down', reel && F.hold);
    if (reel) {
      ui.zone.style.height = (F.zone * 100) + '%';
      ui.zone.style.bottom = (F.zy * 100) + '%';
      ui.fish.style.bottom = 'calc(' + (F.fy * 100) + '% - 6px)';
      var inside = F.fy >= F.zy && F.fy <= F.zy + F.zone;
      ui.zone.classList.toggle('on', inside);
      ui.fill.style.height = (F.prog * 100) + '%';
    }
  }

  /* ---------------------------------------------------------------- the attempt */
  function start(opts) {
    if (F) return false;
    var spot = isSpot(opts.tile.x, opts.tile.y);
    F = {
      phase: 'cast', t: 0, tile: { x: opts.tile.x, y: opts.tile.y }, spot: spot, opts: opts,
      bite: spot ? 1.2 + Math.random() * 1.3 : 3.5 + Math.random() * 3.5,
      zone: spot ? 0.34 : 0.27, zy: 0, zv: 0, fy: 0.3, ft: 0.5, ftT: 0, speed: spot ? 0.55 : 0.8, prog: 0.3, hold: false
    };
    if (!ui) ui = buildUi();
    if (ui) ui.root.hidden = false;
    document.documentElement.classList.add('gt-fishing');
    render();
    return true;
  }
  function end(msg, caught) {
    if (!F) return;
    var opts = F.opts;
    F = null;
    document.documentElement.classList.remove('gt-fishing');
    if (ui) ui.root.hidden = true;
    if (caught && opts.onCatch) opts.onCatch();
    else if (msg) GT.toast(msg);
  }
  function press() {
    if (!F) return;
    if (F.phase === 'cast' || F.phase === 'wait') return end('Umpan ditarik. Belum ada ikan yang makan.');
    if (F.phase === 'bite') { F.phase = 'reel'; F.t = 0; F.hold = true; F.zy = Math.max(0, Math.min(1 - F.zone, F.fy - F.zone / 2)); render(); return; }
    if (F.phase === 'reel') F.hold = true;
  }

  function onFrame(dt) {
    if (!F) return;
    if (GT.isUiOpen()) return end(null); // a window (a monster, a dialog) took over
    dt = Math.min(dt, 0.05);
    F.t += dt;
    if (F.phase === 'cast' && F.t >= 0.45) { F.phase = 'wait'; F.t = 0; }
    else if (F.phase === 'wait' && F.t >= F.bite) { F.phase = 'bite'; F.t = 0; }
    else if (F.phase === 'bite' && F.t >= 1.1) return end('Ikannya lepas. Tekan begitu tanda "!" muncul.');
    else if (F.phase === 'reel') {
      // the green zone: holding lifts it, letting go drops it; it bounces softly off the ends
      F.zv += (F.hold ? 2.4 : -2.1) * dt;
      F.zv = Math.max(-1.4, Math.min(1.4, F.zv));
      F.zy += F.zv * dt;
      if (F.zy < 0) { F.zy = 0; F.zv = -F.zv * 0.3; }
      if (F.zy > 1 - F.zone) { F.zy = 1 - F.zone; F.zv = -F.zv * 0.3; }
      // the fish darts between random heights
      F.ftT -= dt;
      if (F.ftT <= 0) { F.ft = 0.05 + Math.random() * 0.9; F.ftT = 0.5 + Math.random() * (F.spot ? 1.1 : 0.8); }
      var d = F.ft - F.fy;
      F.fy += Math.sign(d) * Math.min(Math.abs(d), F.speed * dt * (0.6 + Math.random() * 0.8));
      var inside = F.fy >= F.zy && F.fy <= F.zy + F.zone;
      F.prog += (inside ? 0.3 : -0.2) * dt;
      if (F.prog >= 1) return end(null, true);
      if (F.prog <= 0) return end('Ikannya lepas! Jaga ikan tetap di area hijau.');
    }
    render();
  }

  function onKey(e) {
    if (!F) return false;
    if (e.type !== 'keydown') return true;
    if (e.code === 'Escape') { end('Berhenti memancing.'); return true; }
    if (HOLD_KEYS[e.code] && !e.repeat) press();
    return true; // nothing else moves while the line is out
  }

  function init() {
    window.addEventListener('keyup', function (e) { if (F && HOLD_KEYS[e.code]) F.hold = false; });
    // mouse: holding the button anywhere on the game view also reels
    var cv = document.getElementById('cv');
    if (cv) {
      cv.addEventListener('pointerdown', function (e) { if (F && e.button === 0) { e.preventDefault(); press(); } });
      window.addEventListener('pointerup', function () { if (F) F.hold = false; });
    }
  }

  window.GT_FISH = { start: start, active: function () { return !!F; }, isSpot: isSpot, _state: function () { return F; } };
  GT.register({ id: 'fishing', init: init, onFrame: onFrame, onKey: onKey, onDraw: onDraw, onDrawGround: onDrawGround });
})();
