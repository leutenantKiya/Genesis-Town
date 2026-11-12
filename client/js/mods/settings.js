/* settings.js - Pengaturan: rebindable keys, full-window layout, fullscreen, reduced motion. Uses only window.GT.
 *
 * Keybinds: the engine reads fixed keys (arrows/WASD, Space/Enter/Z, E, M, I, P, N, H). This mod listens first (window,
 * capture phase) and translates the player's chosen key into the engine's canonical key, so the engine needs no change.
 * Keys that the player moved away from an action are swallowed. Text fields and open dialogs are left alone.
 * Saved in localStorage 'gt.settings' (per browser).
 */
(function () {
  'use strict';
  var LS = 'gt.settings';
  // action -> canonical engine key (what we translate to), label, default keys (max 2)
  var ACTIONS = [
    { id: 'up', canon: 'ArrowUp', label: $t('Jalan ke atas'), keys: ['KeyW', 'ArrowUp'] },
    { id: 'down', canon: 'ArrowDown', label: $t('Jalan ke bawah'), keys: ['KeyS', 'ArrowDown'] },
    { id: 'left', canon: 'ArrowLeft', label: $t('Jalan ke kiri'), keys: ['KeyA', 'ArrowLeft'] },
    { id: 'right', canon: 'ArrowRight', label: $t('Jalan ke kanan'), keys: ['KeyD', 'ArrowRight'] },
    { id: 'talk', canon: 'Space', label: $t('Interaksi (bicara, kumpulkan, kebun)'), keys: ['KeyF', 'Space'] },
    { id: 'message', canon: 'KeyE', label: $t('Pesan ke NPC'), keys: ['KeyT'] },
    { id: 'bag', canon: 'KeyI', label: $t('Buka tas'), keys: ['KeyE', 'KeyI'] },
    { id: 'history', canon: 'KeyH', label: $t('Riwayat'), keys: ['KeyH'] },
    { id: 'market', canon: 'KeyK', label: $t('Pasar Pemain'), keys: ['KeyK'] },
    { id: 'chat', canon: 'KeyC', label: $t('Chat dengan pemain lain'), keys: ['KeyC'] },
    { id: 'map', canon: 'KeyM', label: $t('Peta'), keys: ['KeyM'] },
    { id: 'party', canon: 'KeyG', label: $t('Party'), keys: ['KeyG'] },
    { id: 'profile', canon: 'KeyP', label: $t('Profil'), keys: ['KeyP'] },
    { id: 'fullscreen', canon: 'KeyF', label: $t('Layar penuh'), keys: ['KeyL'] },
    { id: 'settings', canon: 'KeyO', label: $t('Pengaturan'), keys: ['KeyO'] }
  ];
  // Engine keys that must not fire on their own once rebound (the engine also listens to KeyZ for interact).
  var ENGINE_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'Enter', 'KeyZ', 'KeyE', 'KeyM', 'KeyI', 'KeyP', 'KeyN', 'KeyH', 'KeyK', 'KeyF', 'KeyO', 'KeyC'];

  var st = load();
  var translate = {};  // pressed code -> canonical code
  var blocked = {};    // engine codes not bound to anything
  var capturing = null; // {action, slot, el}
  var reentry = false;

  function load() {
    var d = { binds: {}, layout: 'auto', reducedMotion: null, textSize: 1 };
    try { var s = JSON.parse(localStorage.getItem(LS) || 'null'); if (s && typeof s === 'object') Object.assign(d, s); } catch (e) { /* storage blocked */ }
    ACTIONS.forEach(function (a) { if (!Array.isArray(d.binds[a.id])) d.binds[a.id] = a.keys.slice(); });
    // v2 (2026-11-03): E opens the bag, T sends a message to an NPC. Move a saved E from message to bag once.
    if (!d.v2) {
      if (d.binds.message.indexOf('KeyE') >= 0) d.binds.message = d.binds.message.filter(function (k) { return k !== 'KeyE'; }).concat(d.binds.message.indexOf('KeyT') < 0 ? ['KeyT'] : []);
      if (d.binds.bag.indexOf('KeyE') < 0) d.binds.bag = ['KeyE'].concat(d.binds.bag.filter(function (k) { return k !== 'KeyN'; })).slice(0, 2);
      d.v2 = true;
    }
    // v3 (2026-11-03): F interacts (with Space); fullscreen moved to L
    if (!d.v3) {
      d.binds.fullscreen = d.binds.fullscreen.map(function (k) { return k === 'KeyF' ? 'KeyL' : k; });
      if (d.binds.talk.indexOf('KeyF') < 0) d.binds.talk = ['KeyF'].concat(d.binds.talk.filter(function (k) { return k !== 'Enter'; })).slice(0, 2);
      d.v3 = true;
    }
    return d;
  }
  function save() { try { localStorage.setItem(LS, JSON.stringify(st)); } catch (e) { /* storage blocked */ } }

  function renderHelp() {
    var help = document.querySelector('.help');
    if (help) help.textContent = $t('{0} jalan · {1} interaksi · {2} tas · {3} riwayat · {4} peta · {5} layar penuh · {6} pengaturan', [first('up') + first('left') + first('down') + first('right'), first('talk'), first('bag'), first('history'), first('map'), first('fullscreen'), first('settings')]);
  }

  function rebuild() {
    translate = {}; blocked = {};
    ACTIONS.forEach(function (a) { st.binds[a.id].forEach(function (c) { if (c) translate[c] = a.canon; }); });
    ENGINE_KEYS.forEach(function (c) { if (!translate[c]) blocked[c] = true; });
    if (document.querySelector('.help')) renderHelp();
  }

  function keyName(code) {
    if (!code) return '—';
    var names = { Space: $t('Spasi'), Enter: 'Enter', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc', ShiftLeft: 'Shift', ShiftRight: $t('Shift kanan'), Tab: 'Tab', Backspace: 'Backspace' };
    if (names[code]) return names[code];
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    if (/^Numpad/.test(code)) return $t('Num {0}', [code.slice(6)]);
    return code;
  }
  function label(actionId) {
    var b = st.binds[actionId] || [];
    return b.filter(Boolean).map(keyName).join(' / ') || '—';
  }

  function first(actionId) { return keyName((st.binds[actionId] || []).filter(Boolean)[0]); }

  function isTyping(e) {
    var t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }

  function onKey(e) {
    if (reentry) return;
    if (capturing && e.type === 'keydown') {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.code === 'Escape') { finishCapture(null); return; }
      finishCapture(e.code);
      return;
    }
    if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('.mover:not(.under)')) return; // inside menus the engine's own keys apply (Esc, digits, buttons)
    // 2.5D view: Q / E turn the camera and + / - zoom (the bag stays on I and the Tas button)
    if (window.GT_VIEW3D && GT_VIEW3D.onKey && GT_VIEW3D.onKey(e)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    var canon = translate[e.code];
    if (canon === 'KeyF' || canon === 'KeyO') {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.type === 'keydown' && !e.repeat) { if (canon === 'KeyF') toggleFullscreen(); else openSettings(); }
      return;
    }
    if (canon && canon !== e.code) {
      e.preventDefault(); e.stopImmediatePropagation();
      reentry = true;
      try { window.dispatchEvent(new KeyboardEvent(e.type, { code: canon, key: canon, repeat: e.repeat, bubbles: true, cancelable: true })); }
      finally { reentry = false; }
      return;
    }
    if (!canon && blocked[e.code]) { e.preventDefault(); e.stopImmediatePropagation(); }
  }

  /* ------------------------------------------------------------ layout + fullscreen */
  function wantsFull() {
    if (fsElement()) return true;
    if (st.layout === 'full') return true;
    if (st.layout === 'boxed') return false;
    return window.matchMedia('(pointer: fine)').matches && window.innerWidth >= 900;
  }
  // Phone (portrait, narrow): the game view fills the screen between a one-line status bar and the thumb zone
  // (D-pad, A/E, and a bottom bar with the four places players go). css/phone.css lays it out.
  function wantsPhone() {
    if (wantsFull() || st.layout === 'boxed') return false;
    return window.innerWidth <= 900 && window.innerHeight > window.innerWidth; // phones and portrait tablets
  }
  function applyText() { document.documentElement.style.setProperty('--ts', String(st.textSize || 1)); }
  function applyLayout() {
    var on = wantsFull(), phone = !on && wantsPhone();
    var root = document.documentElement;
    var changed = root.classList.contains('gt-full') !== on || root.classList.contains('gt-phone') !== phone;
    root.classList.toggle('gt-full', on);
    root.classList.toggle('gt-phone', phone);
    if (phone) buildTabbar();
    if (changed) window.dispatchEvent(new Event('resize'));
    var rm = st.reducedMotion == null ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : st.reducedMotion;
    root.classList.toggle('gt-reduced-motion', !!rm);
    applyText();
  }
  // Standard API first, then the WebKit-prefixed one (iPad Safari). iPhone Safari has neither.
  function fsElement() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
  function fsSupported() { var el = document.documentElement; return !!(el.requestFullscreen || el.webkitRequestFullscreen); }
  function toggleFullscreen() {
    if (fsElement()) {
      if (document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      return;
    }
    var el = document.documentElement;
    if (el.requestFullscreen) el.requestFullscreen().catch(function () { GT.toast($t('Browser menolak layar penuh. Coba tekan F11.')); });
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    else if (window.GT_PWA && GT_PWA.iphone()) GT.toast($t('Di iPhone: ketuk Bagikan lalu "Tambah ke Layar Utama" untuk layar penuh.'));
    else GT.toast($t('Browser ini tidak mendukung layar penuh. Coba tekan F11.'));
  }
  function onFsChange() { applyLayout(); redraw(); setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 60); }
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);
  window.addEventListener('resize', function () { if (!fsElement()) applyLayout(); });

  /* ------------------------------------------------------------ phone bottom bar */
  // Each tab presses the existing HUD button, so the bar adds no game logic of its own.
  var tabbar = null;
  function press(id) { var b = document.getElementById(id); if (b) b.click(); }
  function moreSheet() {
    var opts = [];
    if (document.getElementById('simbtn')) opts.push({ label: $t('Simulasi 1 minggu'), onPick: function () { press('simbtn'); } });
    opts.push({ label: $t('Tampilan, suara & tombol'), onPick: openSettings });
    if (window.GT_ADMIN && GT_ADMIN.isAdmin()) opts.push({ label: $t('Admin'), onPick: function () { GT_ADMIN.open(); } });
    opts.push({ label: $t('Party'), onPick: function () { if (window.GT_PARTY) GT_PARTY.open(); } });
    if (window.GT_CHARSCREEN) opts.push({ label: $t('Ubah karakter'), onPick: function () { GT_CHARSCREEN.open(true); } });
    if (GT.openProfile) opts.push({ label: $t('Profil'), onPick: function () { GT.openProfile(); } });
    if (GT.interact) opts.push({ label: $t('Pesan ke NPC di depanmu'), onPick: function () { GT.interact('message'); } });
    if (document.getElementById('devbtn')) opts.push({ label: 'Dev', onPick: function () { press('devbtn'); } });
    // signing out lives here, with the other account settings (it used to sit at the foot of the Bag)
    if (window.GT_CHAIN && GT_CHAIN.state && GT_CHAIN.state.account) opts.push({ label: $t('Keluar (ganti akun)'), onPick: function () { GT_CHAIN.signOut(); } });
    GT.menu($t('Pengaturan'), opts);
  }
  function buildTabbar() {
    if (tabbar) return;
    var shell = document.querySelector('.shell');
    if (!shell) return;
    tabbar = $('nav', 'gt-tabbar'); tabbar.setAttribute('aria-label', $t('Menu utama'));
    [['tab-bag', $t('Tas'), function () { press('chainbtn'); }],
     ['tab-market', $t('Pasar'), function () { press('pasarbtn'); }],
     ['tab-map', $t('Peta'), function () { press('mapbtn'); }],
     ['tab-chat', $t('Chat'), function () { if (window.GT_PLAYERS) GT_PLAYERS.openChat(''); }],
     ['tab-more', $t('Pengaturan'), moreSheet]].forEach(function (t) {
      var b = $('button', 'gt-tab', t[1]); b.type = 'button'; b.id = t[0];
      b.addEventListener('click', function (e) { e.currentTarget.blur(); if (!GT.isUiOpen()) t[2](); });
      tabbar.appendChild(b);
    });
    shell.appendChild(tabbar);
    // the first tab says Masuk until the player is signed in, like the HUD button it presses
    var first = tabbar.firstChild;
    function sync() { var acc = document.getElementById('chainbtn'); var t = acc && acc.textContent === $t('Masuk') ? $t('Masuk') : $t('Tas'); if (first.textContent !== t) first.textContent = t; }
    setInterval(sync, 700); // the account button is created later by chain.js and changes on sign-in
    sync();
  }

  /* ------------------------------------------------------------ settings modal */
  var modal = null;
  function $(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function body() {
    var wrap = $('div', 'gt-settings');
    // language first: shown in both languages so it can always be found (switching reloads the page)
    wrap.appendChild($('h3', null, 'Language / Bahasa'));
    var lg = $('div', 'mseg');
    [['en', 'English'], ['id', 'Bahasa Indonesia']].forEach(function (o) {
      var lab = $('label'); var inp = $('input'); inp.type = 'radio'; inp.name = 'gt-lang'; inp.value = o[0]; inp.checked = window.GT_LANG === o[0];
      inp.addEventListener('change', function () { if (window.GT_I18N && window.GT_LANG !== o[0]) GT_I18N.setLang(o[0]); }); // live: no reload, the game stays where it is
      lab.appendChild(inp); lab.appendChild($('span', null, o[1])); lg.appendChild(lab);
    });
    wrap.appendChild(lg);

    // text size first: the setting most players look for
    wrap.appendChild($('h3', null, $t('Ukuran teks')));
    var ts = $('div', 'mseg');
    [[1, $t('Normal')], [1.15, $t('Besar')], [1.3, $t('Lebih besar')]].forEach(function (o) {
      var lab = $('label'); var inp = $('input'); inp.type = 'radio'; inp.name = 'gt-ts'; inp.value = String(o[0]); inp.checked = (st.textSize || 1) === o[0];
      inp.addEventListener('change', function () { st.textSize = o[0]; save(); applyText(); });
      lab.appendChild(inp); lab.appendChild($('span', null, o[1])); ts.appendChild(lab);
    });
    wrap.appendChild(ts);


    wrap.appendChild($('h3', null, $t('Layar')));
    var seg = $('div', 'mseg');
    [['auto', $t('Otomatis')], ['full', $t('Penuh jendela')], ['boxed', $t('Kotak (klasik)')]].forEach(function (o) {
      var lab = $('label'); var inp = $('input'); inp.type = 'radio'; inp.name = 'gt-layout'; inp.value = o[0]; inp.checked = st.layout === o[0];
      inp.addEventListener('change', function () { st.layout = o[0]; save(); applyLayout(); window.dispatchEvent(new Event('resize')); });
      lab.appendChild(inp); lab.appendChild($('span', null, o[1])); seg.appendChild(lab);
    });
    wrap.appendChild(seg);
    var v3 = window.GT_VIEW3D;
    if (v3) {
      wrap.appendChild($('h3', null, $t('Tampilan')));
      var vs = $('div', 'mseg');
      [['3d', '2.5D'], ['2d', $t('2D (ringan)')]].forEach(function (o) {
        var lab = $('label'); var inp = $('input'); inp.type = 'radio'; inp.name = 'gt-view'; inp.value = o[0]; inp.checked = v3.get() === o[0];
        inp.addEventListener('change', function () { v3.set(o[0]); });
        lab.appendChild(inp); lab.appendChild($('span', null, o[1])); vs.appendChild(lab);
      });
      wrap.appendChild(vs);
    }
    var pwa = window.GT_PWA;
    var fs = $('div', 'dbtns');
    if (fsSupported()) {
      var fsb = $('button', 'mbtn primary', fsElement() ? $t('Keluar layar penuh') : $t('Layar penuh ({0})', [label('fullscreen')])); fsb.type = 'button';
      fsb.addEventListener('click', function () { toggleFullscreen(); });
      fs.appendChild(fsb);
    }
    if (pwa && pwa.canInstall()) {
      var inst = $('button', 'mbtn', $t('Pasang aplikasi')); inst.type = 'button';
      inst.addEventListener('click', function () { pwa.install().then(function () { redraw(); }); });
      fs.appendChild(inst);
    }
    if (fs.firstChild) wrap.appendChild(fs);
    if (pwa && pwa.standalone()) wrap.appendChild($('p', 'mnote', $t('Sudah terpasang sebagai aplikasi.')));
    else if (pwa && pwa.iphone()) wrap.appendChild($('p', 'mnote', $t('Di iPhone: ketuk Bagikan lalu "Tambah ke Layar Utama" untuk layar penuh.')));

    wrap.appendChild($('h3', null, $t('Kota')));
    var shared = window.GT_CHAIN && GT_CHAIN.state.mode !== 'offline' && GT_CHAIN.state.cfg && GT_CHAIN.state.cfg.world;
    if (shared) {
      // with a server, every player shares one world made from the server's seed
      wrap.appendChild($('p', 'mnote', $t('Peta kota dibuat dari seed dunia {0} milik server, sama untuk semua pemain.', [GT_CHAIN.state.cfg.world.seed])));
    } else {
      var regen = $('button', 'mbtn', $t('Buat kota baru (peta acak)')); regen.type = 'button';
      regen.addEventListener('click', function () { if (modal) modal.close('regen'); var r = document.getElementById('regen'); if (r) setTimeout(function () { r.click(); }, 50); });
      var rr = $('div', 'dbtns'); rr.appendChild(regen); wrap.appendChild(rr);
    }

    var rm = $('label', 'dchk'); var cb = $('input'); cb.type = 'checkbox';
    cb.checked = document.documentElement.classList.contains('gt-reduced-motion');
    cb.addEventListener('change', function () { st.reducedMotion = cb.checked; save(); applyLayout(); });
    rm.appendChild(cb); rm.appendChild($('span', null, $t('Kurangi animasi')));
    wrap.appendChild(rm);
    if (window.GT_CONCERT) { // the night concert on the square's stage (mods/concert.js)
      var mu = $('label', 'dchk'), mc = $('input'); mc.type = 'checkbox'; mc.checked = GT_CONCERT.on();
      mc.addEventListener('change', function () { GT_CONCERT.setOn(mc.checked); });
      mu.appendChild(mc); mu.appendChild($('span', null, $t('Musik konser (malam, di panggung alun-alun)')));
      wrap.appendChild(mu);
    }
    var keys = $('div');
    var h = $('h3', null, $t('Tombol')); keys.appendChild(h);
    keys.appendChild($('p', 'mnote', $t('Klik sebuah kotak lalu tekan tombol baru. Esc membatalkan. Tombol yang sudah dipakai aksi lain akan dipindahkan.')));
    ACTIONS.forEach(function (a) {
      var row = $('div', 'mrow');
      row.appendChild($('span', 'grow', a.label));
      for (var slot = 0; slot < 2; slot++) {
        (function (slot) {
          var b = $('button', 'mbtn gt-key', keyName(st.binds[a.id][slot]));
          b.type = 'button';
          b.setAttribute('aria-label', $t('{0}, tombol {1}: {2}', [a.label, slot + 1, keyName(st.binds[a.id][slot])]));
          b.addEventListener('click', function () { startCapture(a.id, slot, b); });
          row.appendChild(b);
        })(slot);
      }
      keys.appendChild(row);
    });
    var r = $('div', 'dbtns');
    var reset = $('button', 'mbtn', $t('Reset ke bawaan')); reset.type = 'button';
    reset.addEventListener('click', function () { ACTIONS.forEach(function (a) { st.binds[a.id] = a.keys.slice(); }); save(); rebuild(); redraw(); GT.toast($t('Tombol dikembalikan ke bawaan.')); });
    r.appendChild(reset); keys.appendChild(r);
    if (!document.documentElement.classList.contains('gt-phone') && !window.matchMedia('(pointer: coarse)').matches) wrap.appendChild(keys);
    return wrap;
  }

  function startCapture(action, slot, el) {
    capturing = { action: action, slot: slot, el: el };
    el.textContent = $t('tekan…'); el.classList.add('gt-capturing');
  }
  function finishCapture(code) {
    var c = capturing; capturing = null;
    if (code && c) {
      ACTIONS.forEach(function (a) {
        st.binds[a.id] = st.binds[a.id].map(function (k) { if (k === code && !(a.id === c.action)) { GT.toast($t('{0} dipindah dari "{1}".', [keyName(code), a.label])); return null; } return k; });
      });
      st.binds[c.action][c.slot] = code;
      save(); rebuild();
    }
    redraw();
  }
  function redraw() { if (modal && modal.isOpen()) modal.setBody(body()); }

  function openSettings() {
    if (modal && modal.isOpen()) return;
    modal = GT.modal({ title: $t('Pengaturan'), wide: true, body: body(), onClose: function () { capturing = null; } });
  }

  rebuild();
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
  applyLayout();

  // a language switch: rebuild this window and the key hint line in the new language
  if (window.GT_I18N) GT_I18N.onChange(function () { redraw(); rebuild(); });

  window.GT_SETTINGS = { label: label, keyName: keyName, open: openSettings, toggleFullscreen: toggleFullscreen, _state: st };
  GT.register({
    id: 'settings',
    init: function () {
      GT.addHudButton({ id: 'setbtn', label: $t('Atur'), onClick: openSettings, secondary: false });
      // A calmer HUD: Tas, Pasar, Peta and Simulasi stay in view; everything else lives in Lainnya
      // (css/phone.css hides the rest). Their keyboard shortcuts still work.
      GT.addHudButton({ id: 'gt-morebtn', label: $t('Pengaturan'), onClick: moreSheet, secondary: false });
      renderHelp();
      applyLayout();
    }
  });
})();
