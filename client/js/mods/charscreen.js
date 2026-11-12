/*
 * charscreen.js - the character screen for accounts without a name yet (a named account goes straight in, the name is asked once; Lainnya > Ubah karakter reopens it):
 * a big preview of your character, your name with its fixed #tag above it, 8 look swatches and a big "Mulai" button.
 * "Mulai" saves name + look (POST /api/name {name?, look?} -> {name, tag, look, named}), plays a ~1.6 s animation
 * (the character is thrown up from the bottom of the screen, spins, falls with a dust puff; reduced motion = a fade)
 * and then calls window.GT_HOME.enter() when a Homeland mod provides it; otherwise the player stays where they are.
 * Look = palette index 0-7 of sprites.js (8 is the police uniform, not offered). Own look is drawn in the world through
 * GT.charDraw (chained, so combat.js keeps working); other players' looks come from presence (players.js).
 * Exposed: window.GT_CHARSCREEN = { open, setMine(name, tag, look, named) }.
 */
(function () {
  'use strict';
  var GT = window.GT;
  if (!GT) return;

  var LOOKS = 8, ANIM_MS = 1600;
  var NAME_RE = /^[A-Za-z0-9 _-]{3,16}$/;
  var mine = { name: null, tag: null, look: 0, named: false };
  var shownFor = null;            // account the screen was already shown for (once per login / page load)
  var root = null, busy = false;
  var wrapped = null;             // our GT.charDraw wrapper

  function C() { return window.GT_CHAIN; }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function active() { var c = C(); return !!(c && c.state.account && c.state.mode !== 'offline' && c.state.mode !== 'loading'); }
  function reduced() { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }

  /* ---------------------------------------------------------------- own look in the world */
  function wrapCharDraw() {
    if (GT.charDraw === wrapped) return;
    var prev = GT.charDraw;
    wrapped = function (g, n, x, y, pal, dir, step) {
      if (n) return prev ? prev(g, n, x, y, pal, dir, step) : false;   // NPCs are untouched
      var look = mine.look | 0;
      if (prev && prev(g, n, x, y, look, dir, step) === true) return true;
      GT.drawChar(g, x, y, look, dir, step);
      return true;
    };
    GT.charDraw = wrapped;
  }

  /* ---------------------------------------------------------------- drawing helpers */
  // A character is 12x14 pixels drawn at a 16x16 tile; paint it on a tiny canvas and let CSS scale it up crisply.
  function paint(cv, look, dir, step) {
    var g = cv.getContext('2d');
    g.clearRect(0, 0, cv.width, cv.height);
    GT.drawChar(g, 0, 2, look, dir || 'down', step || 0);
  }
  function pixelCanvas() { var cv = document.createElement('canvas'); cv.width = 16; cv.height = 20; return cv; }

  /* ---------------------------------------------------------------- the screen */
  // force: the player asked for it (Lainnya > Ubah karakter). Otherwise a named account skips the screen and goes
  // straight to the Homeland, so the name is asked only once; the server (/api/name named:true) is the memory.
  var skipping = false;
  function open(force) {
    if (root || !active()) return;
    if (force !== true) {
      if (skipping) return;
      skipping = true;
      C().api('/name', { method: 'POST', body: {} }).then(function (r) {
        skipping = false;
        if (r && r.named) {
          mine = { name: r.name, tag: r.tag, look: r.look | 0, named: true };
          if (GT.setPlayerName) GT.setPlayerName(r.name);
          if (window.GT_HOME && GT_HOME.enter) { try { GT_HOME.enter(); } catch (e) { console.error(e); } }
        } else openScreen();
      }, function () { skipping = false; openScreen(); });
      return;
    }
    openScreen();
  }
  function openScreen() {
    if (root || !active()) return;
    var c = C(), look = 0;
    root = el('div', 'gt-cs'); root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', $t('Karakter'));
    // the game must not see these keys or clicks while the screen is up
    ['keydown', 'keyup', 'keypress'].forEach(function (t) { root.addEventListener(t, function (e) { e.stopPropagation(); }); });
    var screen = document.getElementById('screen') || document.body;
    screen.appendChild(root);
    root.appendChild(el('p', 'gt-cs-load', $t('Memuat karakter…')));
    c.api('/name', { method: 'POST', body: {} }).then(function (r) {
      mine = { name: r.named ? r.name : null, tag: r.tag, look: r.look | 0, named: !!r.named };
      look = mine.look;
      if (root) build(look);
    }, function (e) { if (root) { root.textContent = ''; var p = el('p', 'gt-cs-load', (e && e.message) || $t('Gagal memuat karakter.')); var b = el('button', 'gt-cs-go', $t('Coba lagi')); b.type = 'button'; b.onclick = function () { close(); open(); }; root.appendChild(p); root.appendChild(b); } });
  }
  function close() { if (root && root.parentNode) root.parentNode.removeChild(root); root = null; busy = false; }

  function build(look) {
    var c = C();
    root.textContent = '';
    var card = el('div', 'gt-cs-card');
    root.appendChild(card);

    // left: name + tag above the big preview
    var left = el('div', 'gt-cs-left');
    var nameRow = el('div', 'gt-cs-namerow');
    var input = el('input', 'gt-cs-name'); input.type = 'text'; input.maxLength = 16; input.autocomplete = 'off'; input.spellcheck = false;
    input.placeholder = $t('Namamu'); input.value = mine.name || ''; input.setAttribute('aria-label', $t('Nama')); input.setAttribute('data-autofocus', '');
    var tag = el('span', 'gt-cs-tag', '#' + mine.tag); tag.title = $t('Tag tetapmu: membedakanmu dari pemain bernama sama');
    nameRow.appendChild(input); nameRow.appendChild(tag);
    var stage = el('div', 'gt-cs-stage');
    var prev = pixelCanvas(); prev.className = 'gt-cs-prev'; prev.setAttribute('aria-hidden', 'true');
    stage.appendChild(prev);
    left.appendChild(nameRow); left.appendChild(stage);

    // right: look swatches + Mulai
    var right = el('div', 'gt-cs-right');
    right.appendChild(el('h2', 'gt-cs-h', $t('Pilih penampilan')));
    var grid = el('div', 'gt-cs-grid'); grid.setAttribute('role', 'radiogroup'); grid.setAttribute('aria-label', $t('Penampilan'));
    var sw = [];
    for (var i = 0; i < LOOKS; i++) (function (i) {
      var b = el('button', 'gt-cs-sw'); b.type = 'button'; b.setAttribute('role', 'radio'); b.setAttribute('aria-label', $t('Penampilan {0}', [i + 1]));
      var cv = pixelCanvas(); paint(cv, i, 'down', 0); b.appendChild(cv);
      b.addEventListener('click', function () { pick(i); });
      grid.appendChild(b); sw.push(b);
    })(i);
    function pick(i) { look = i; sw.forEach(function (b, k) { b.setAttribute('aria-checked', k === i ? 'true' : 'false'); b.classList.toggle('on', k === i); }); }
    pick(look);
    var msg = el('p', 'gt-cs-msg'); msg.setAttribute('role', 'status');
    var go = el('button', 'gt-cs-go', $t('Mulai')); go.type = 'button';
    right.appendChild(grid); right.appendChild(msg); right.appendChild(go);
    card.appendChild(left); card.appendChild(right);

    // the preview breathes: a slow two-frame idle, and turns to look around
    var dirs = ['down', 'left', 'down', 'right'], tick = 0;
    var idle = setInterval(function () {
      if (!root) { clearInterval(idle); return; }
      tick++; paint(prev, look, dirs[Math.floor(tick / 4) % dirs.length], tick % 2 ? 1 : 0);
    }, 300);
    paint(prev, look, 'down', 0);
    // the look only changes on click/tap or Enter/Space on a swatch (pick above); hovering just outlines it (CSS)
    grid.addEventListener('click', function () { paint(prev, look, 'down', 0); });

    function fail(text) { msg.textContent = text; busy = false; go.disabled = false; }
    function start() {
      if (busy) return;
      var v = String(input.value || '').trim().replace(/ {2,}/g, ' ');
      if (!NAME_RE.test(v)) { msg.textContent = $t('Nama 3-16 karakter: huruf, angka, spasi, _ atau -.'); input.focus(); return; }
      busy = true; go.disabled = true; msg.textContent = '';
      var body = { look: look };
      if (v !== mine.name) body.name = v;
      c.api('/name', { method: 'POST', body: body }).then(function (r) {
        mine = { name: r.named ? r.name : v, tag: r.tag, look: r.look | 0, named: !!r.named };
        if (GT.setPlayerName && r.named) GT.setPlayerName(r.name);
        clearInterval(idle);
        // Seamless: move to the Homeland while this screen still covers the view, then throw the player in there,
        // landing on the real sprite (which stays hidden until the landing). No village first, no jump after.
        msg.style.color = 'inherit'; msg.textContent = $t('Menuju Homeland…');
        var going = window.GT_HOME && GT_HOME.enter ? GT_HOME.enter() : Promise.resolve(false);
        going.then(null, function () { return false; }).then(function () {
          if (!root) return;
          if (GT.setPlayerHidden) GT.setPlayerHidden(true);
          requestAnimationFrame(function () { play(look, root, finish); }); // one frame so the new world and camera are drawn
        });
      }, function (e) { fail((e && e.message) || $t('Gagal menyimpan.')); });
    }
    go.addEventListener('click', start);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); start(); } });
    setTimeout(function () { try { input.focus(); } catch (e) { /* detached */ } }, 0);
  }

  function finish() {
    close();
    if (GT.setPlayerHidden) GT.setPlayerHidden(false);
  }

  /* ---------------------------------------------------------------- thrown up, spin, fall, dust */
  function play(look, host, done) {
    if (reduced()) {
      host.classList.add('gt-cs-fade');
      setTimeout(done, 350);
      return;
    }
    // 2.5D: the player's own 3D sprite drops into the world (lit like the world at that hour, landing on their tile);
    // this screen only fades away above it
    if (GT.setPlayerHidden) GT.setPlayerHidden(false);
    if (window.GT_VIEW3D && GT_VIEW3D.dropIn && GT_VIEW3D.dropIn(ANIM_MS, done)) { host.classList.add('gt-cs-fade'); return; }
    if (GT.setPlayerHidden) GT.setPlayerHidden(true);
    host.classList.add('gt-cs-throw');
    host.textContent = '';
    var cv = document.createElement('canvas'); cv.className = 'gt-cs-anim';
    host.appendChild(cv);
    var W = host.clientWidth || 640, H = host.clientHeight || 480, dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    var g = cv.getContext('2d'); g.imageSmoothingEnabled = false;
    var spr = pixelCanvas(); paint(spr, look, 'down', 1);
    var S = Math.max(4, Math.round(Math.min(W, H) / 70)) * dpr;   // pixels per sprite pixel
    var cx = cv.width / 2, landY = cv.height / 2, startY = cv.height + 16 * S, topY = cv.height * 0.12;
    // land where the real sprite stands, at its size (2D or 2.5D), so the hand-over at the end is invisible
    function aim() {
      var ps = GT.playerScreen && GT.playerScreen(), gc = document.getElementById('cv');
      if (!ps || !gc) return;
      var hr = host.getBoundingClientRect(), cr = gc.getBoundingClientRect();
      cx = (ps.x + cr.left - hr.left) * dpr; landY = (ps.y + cr.top - hr.top) * dpr; S = ps.scale * dpr;
      startY = cv.height + 16 * S;
    }
    aim();
    var t0 = performance.now();
    function frame(now) {
      var t = Math.min(1, (now - t0) / ANIM_MS), y, rot;
      aim();
      g.clearRect(0, 0, cv.width, cv.height);
      if (t >= 0.85) { // landed and settled: the real sprite takes over, only the dust is left here
        if (GT.setPlayerHidden) GT.setPlayerHidden(false);
        dust(g, cx, landY, (t - 0.75) / 0.25, S);
        if (t < 1) requestAnimationFrame(frame); else done();
        return;
      }
      if (t < 0.4) { var u = t / 0.4; y = startY + (topY - startY) * (1 - (1 - u) * (1 - u)); }       // thrown up, slowing at the top
      else if (t < 0.75) { var d = (t - 0.4) / 0.35; y = topY + (landY - topY) * d * d; }              // falls, speeding up
      else y = landY;
      rot = t < 0.75 ? (t / 0.75) * Math.PI * 4 : 0;                                                  // two full spins, then upright
      var squash = t >= 0.75 && t < 0.85 ? 1 - Math.sin((t - 0.75) / 0.1 * Math.PI) * 0.18 : 1;
      g.save(); g.translate(cx, y); g.rotate(rot); g.scale(1, squash);
      g.drawImage(spr, -8 * S, -14 * S, 16 * S, 20 * S);
      g.restore();
      // 2D: the flying sprite takes the hour's darkness, as the night layer darkens the world under it
      var dark = GT.daylight ? 1 - GT.daylight() : 0;
      if (dark > 0.01) { g.save(); g.globalCompositeOperation = 'source-atop'; g.fillStyle = 'rgba(14,18,56,' + (0.72 * dark).toFixed(3) + ')'; g.fillRect(0, 0, cv.width, cv.height); g.restore(); }
      if (t >= 0.75) dust(g, cx, landY, (t - 0.75) / 0.25, S);
      if (t < 1) requestAnimationFrame(frame); else done();
    }
    requestAnimationFrame(frame);
  }
  function dust(g, x, y, p, S) {
    g.save(); g.globalAlpha = 1 - p;
    for (var i = 0; i < 7; i++) {
      var a = (i / 7) * Math.PI * 2 + 0.3, r = S * (2 + p * 9), dx = Math.cos(a) * r * 1.6, dy = Math.sin(a) * r * 0.45;
      g.fillStyle = GT_THEME.get(i % 2 ? 'paper-2' : 'paper-3');
      var s = S * (3 - p * 1.6); g.fillRect(Math.round(x + dx - s / 2), Math.round(y + dy - s / 2), s, s);
    }
    g.restore();
  }

  /* ---------------------------------------------------------------- hooks */
  function setMine(name, tag, look, named) {
    if (root) return;                     // the screen is editing; do not overwrite what the player is picking
    mine = { name: named ? name : null, tag: tag, look: look | 0, named: !!named };
  }
  function onFrame() {
    wrapCharDraw();
    // once per login / page load: show the screen as soon as the game knows the account
    if (!root && active()) {
      var acct = C().state.account;
      if (shownFor !== acct) { shownFor = acct; open(); }
    } else if (!active() && shownFor) { shownFor = null; if (root) close(); } // signed out: next login shows it again
  }
  function onKey() { return !!root; }
  // the 2.5D view draws the player from the engine's `me` entity (pal 0 by default), not through GT.charDraw:
  // give it the chosen look so you see yourself as the other players see you
  function onEntities(ents) { for (var i = 0; i < ents.length; i++) if (ents[i].me) ents[i].pal = mine.look | 0; }

  window.GT_CHARSCREEN = { open: function (force) { return open(force === true); }, setMine: setMine, _mine: function () { return mine; } };
  GT.register({ id: 'charscreen', init: wrapCharDraw, onFrame: onFrame, onKey: onKey, onEntities: onEntities });
})();
