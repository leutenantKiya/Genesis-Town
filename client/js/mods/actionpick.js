/*
 * actionpick.js - the interaction picker: a small pop-up of buttons BESIDE the player (never above, so left and right stay
 * visible) listing what F / Space / the phone's action button can do at this spot.
 *
 * The list comes from settings.js (GT_ACTBTN.list): what the key did before, plus extra options that mods add with
 * GT_ACTBTN.addExtra (ferry.js: "Perahu" next to fishing at the lake). Each option has its own run function.
 *
 * Key rule (one place, so it stays clean):
 *  - ONE option: the panel is a single compact "F" button (desktop; a phone shows only the round #btnAct). F / Space /
 *    Enter / Z are NOT touched: the engine does what it always did.
 *  - TWO or more: ArrowUp / ArrowDown change the selection (wrapping) and F / Space run the selected option. W, S, A, D
 *    and Left / Right keep walking. Only a real arrow press counts: settings.js re-sends rebound keys (W -> ArrowUp) as
 *    synthetic events (isTrusted false), and those keep walking.
 *  - A click or tap on a row runs that row. On a phone #btnAct runs the selected option (settings.js asks GT_ACTPICK).
 * The panel shows only while the player stands still, no window or dialog is open and he is not fishing or fighting.
 * A single option that is only a "quiet" chance (searching grass) is not shown on desktop.
 */
(function () {
  'use strict';
  var GT = window.GT;
  if (!GT) return;

  var opts = [], sig = '', sel = 0, seen = '', shown = false, el = null, lastPoll = 0;
  var screen = null, cv = null, unit = { k: 1, T: 12 };

  function phone() { return document.documentElement.classList.contains('gt-phone'); }
  function blocked() {
    var pl = GT.player, h = document.documentElement.classList;
    return !pl || pl.moving || GT.isUiOpen() || h.contains('gt-fishing') || h.contains('gt-fighting') ||
      (window.GT_FISH && GT_FISH.active && GT_FISH.active());
  }
  function list() {
    if (blocked() || !window.GT_ACTBTN || !GT_ACTBTN.list) return [];
    try { return GT_ACTBTN.list(); } catch (e) { return []; }
  }
  function wantsPanel(l) {
    if (!l.length) return false;
    if (l.length === 1) return !phone() && !l[0].quiet; // a phone's one option is the round button's job
    return true;
  }

  function build() {
    el = document.createElement('div');
    el.className = 'gt-pick'; el.hidden = true; el.setAttribute('role', 'listbox');
    el.setAttribute('aria-label', $t('Aksi'));
    // keep the game's keys and the canvas out of it: a press on the panel never moves focus or the player
    el.addEventListener('pointerdown', function (e) { e.preventDefault(); e.stopPropagation(); });
    el.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('.gt-pick-row'); if (!b) return;
      e.stopPropagation(); e.preventDefault();
      var i = +b.getAttribute('data-i'); if (isNaN(i)) return;
      sel = i; runSel();
    });
    screen.appendChild(el);
  }
  function paint() {
    el.textContent = '';
    el.classList.toggle('one', opts.length === 1);
    opts.forEach(function (o, i) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'gt-pick-row' + (i === sel ? ' on' : ''); b.setAttribute('data-i', i);
      b.setAttribute('role', 'option'); b.setAttribute('aria-selected', i === sel ? 'true' : 'false');
      var ic = document.createElement('span'); ic.className = 'gt-pick-ico'; ic.setAttribute('aria-hidden', 'true'); ic.textContent = o.icon || '';
      var lb = document.createElement('span'); lb.className = 'gt-pick-lbl'; lb.textContent = o.label;
      b.appendChild(ic); b.appendChild(lb);
      if (i === sel && !phone()) { var k = document.createElement('kbd'); k.className = 'gt-pick-key'; k.textContent = 'F'; b.appendChild(k); }
      el.appendChild(b);
    });
  }

  function runSel() {
    var o = opts[sel]; if (!o || GT.isUiOpen()) return false;
    try { o.run(); } catch (e) { console.error('[actionpick] run failed', e); }
    return true;
  }

  // poll about every 100 ms; a new set of options must hold for one poll before it shows (no flicker when walking past)
  function refresh(now) {
    if (now - lastPoll < 100) return;
    lastPoll = now;
    var l = list();
    if (!wantsPanel(l)) { opts = l; if (shown) { el.hidden = true; shown = false; } sig = ''; seen = ''; return; }
    var s = l.map(function (o) { return o.id + '|' + o.label; }).join('\n');
    if (s !== sig) {
      if (seen !== s) { seen = s; if (shown) { el.hidden = true; shown = false; } opts = l; return; }
      sig = s; sel = 0; opts = l; paint();
    } else opts = l.map(function (o, i) { return o; });
    if (!shown) { el.hidden = false; shown = true; }
  }

  function place(ctx, T) {
    if (!shown || !el || !cv || !screen) return;
    var p = GT.player, a = GT.at(p.x, p.y), tr = ctx.getTransform(), vw = ctx.canvas.width / (tr.a || 1);
    var rc = cv.getBoundingClientRect(), rs = screen.getBoundingClientRect();
    if (!rc.width || !vw) return;
    var k = rc.width / vw, w = el.offsetWidth, h = el.offsetHeight;
    var cx = rc.left - rs.left + (a.x + T / 2) * k, cy = rc.top - rs.top + (a.y + T / 2) * k;
    var gap = Math.max(10, T * 0.7 * k), roomR = rs.width - cx - gap, roomL = cx - gap;
    var right = roomR >= roomL;
    // do not sit on the tile being faced: if the roomier side is where the player looks, take the other when it fits
    if (right && p.dir === 'right' && roomL >= w) right = false;
    else if (!right && p.dir === 'left' && roomR >= w) right = true;
    var left = right ? cx + gap : cx - gap - w;
    left = Math.max(4, Math.min(rs.width - w - 4, left));
    var top = Math.max(4, Math.min(rs.height - h - 4, cy - h / 2));
    el.style.left = Math.round(left) + 'px'; el.style.top = Math.round(top) + 'px';
    el.classList.toggle('flip', !right);
  }

  function onKey(e) {
    if (e.type !== 'keydown' || !shown || opts.length < 2 || !el || el.hidden) return false;
    if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
      if (e.isTrusted === false) return false; // a re-sent W / S keeps walking
      if (!e.repeat) { sel = (sel + (e.code === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length; paint(); }
      return true;
    }
    if (e.code === 'Space' || e.code === 'Enter' || e.code === 'KeyZ') {
      if (e.target && e.target.closest && e.target.closest('button')) return false;
      if (!e.repeat) runSel();
      return true;
    }
    return false;
  }

  window.GT_ACTPICK = {
    selected: function () { return opts.length > 1 && shown ? opts[sel] : (opts.length === 1 ? opts[0] : null); },
    run: function () { return opts.length > 1 && shown ? runSel() : false; },
    options: function () { return opts.slice(); },
    index: function () { return sel; }
  };
  GT.register({
    id: 'actionpick',
    init: function () { screen = document.getElementById('screen'); cv = document.getElementById('cv'); if (screen) build(); },
    onFrame: function () { if (el) refresh(performance.now()); },
    onDraw: function (ctx, camX, camY, T) { place(ctx, T); },
    onKey: onKey
  });
})();
