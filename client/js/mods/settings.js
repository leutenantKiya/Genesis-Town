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
    { id: 'up', canon: 'ArrowUp', label: 'Jalan ke atas', keys: ['KeyW', 'ArrowUp'] },
    { id: 'down', canon: 'ArrowDown', label: 'Jalan ke bawah', keys: ['KeyS', 'ArrowDown'] },
    { id: 'left', canon: 'ArrowLeft', label: 'Jalan ke kiri', keys: ['KeyA', 'ArrowLeft'] },
    { id: 'right', canon: 'ArrowRight', label: 'Jalan ke kanan', keys: ['KeyD', 'ArrowRight'] },
    { id: 'talk', canon: 'Space', label: 'Interaksi (bicara, kumpulkan, kebun)', keys: ['Space', 'Enter'] },
    { id: 'message', canon: 'KeyE', label: 'Pesan ke NPC', keys: ['KeyE'] },
    { id: 'bag', canon: 'KeyI', label: 'Tas NEAR', keys: ['KeyI', 'KeyN'] },
    { id: 'history', canon: 'KeyH', label: 'Riwayat', keys: ['KeyH'] },
    { id: 'map', canon: 'KeyM', label: 'Peta', keys: ['KeyM'] },
    { id: 'profile', canon: 'KeyP', label: 'Profil', keys: ['KeyP'] },
    { id: 'fullscreen', canon: 'KeyF', label: 'Layar penuh', keys: ['KeyF'] },
    { id: 'settings', canon: 'KeyO', label: 'Pengaturan', keys: ['KeyO'] }
  ];
  // Engine keys that must not fire on their own once rebound (the engine also listens to KeyZ for interact).
  var ENGINE_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'Enter', 'KeyZ', 'KeyE', 'KeyM', 'KeyI', 'KeyP', 'KeyN', 'KeyH', 'KeyF', 'KeyO'];

  var st = load();
  var translate = {};  // pressed code -> canonical code
  var blocked = {};    // engine codes not bound to anything
  var capturing = null; // {action, slot, el}
  var reentry = false;

  function load() {
    var d = { binds: {}, layout: 'auto', reducedMotion: null };
    try { var s = JSON.parse(localStorage.getItem(LS) || 'null'); if (s && typeof s === 'object') Object.assign(d, s); } catch (e) { /* storage blocked */ }
    ACTIONS.forEach(function (a) { if (!Array.isArray(d.binds[a.id])) d.binds[a.id] = a.keys.slice(); });
    return d;
  }
  function save() { try { localStorage.setItem(LS, JSON.stringify(st)); } catch (e) { /* storage blocked */ } }

  function renderHelp() {
    var help = document.querySelector('.help');
    if (help) help.textContent = first('up') + first('left') + first('down') + first('right') + ' jalan · ' + first('talk') + ' interaksi · ' + first('bag') + ' tas · ' + first('history') + ' riwayat · ' + first('map') + ' peta · ' + first('fullscreen') + ' layar penuh · ' + first('settings') + ' pengaturan';
  }

  function rebuild() {
    translate = {}; blocked = {};
    ACTIONS.forEach(function (a) { st.binds[a.id].forEach(function (c) { if (c) translate[c] = a.canon; }); });
    ENGINE_KEYS.forEach(function (c) { if (!translate[c]) blocked[c] = true; });
    if (document.querySelector('.help')) renderHelp();
  }

  function keyName(code) {
    if (!code) return '—';
    var names = { Space: 'Spasi', Enter: 'Enter', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc', ShiftLeft: 'Shift', ShiftRight: 'Shift kanan', Tab: 'Tab', Backspace: 'Backspace' };
    if (names[code]) return names[code];
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    if (/^Numpad/.test(code)) return 'Num ' + code.slice(6);
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
    if (document.fullscreenElement) return true;
    if (st.layout === 'full') return true;
    if (st.layout === 'boxed') return false;
    return window.matchMedia('(pointer: fine)').matches && window.innerWidth >= 900;
  }
  function applyLayout() {
    var on = wantsFull();
    var root = document.documentElement;
    if (root.classList.contains('gt-full') !== on) {
      root.classList.toggle('gt-full', on);
      window.dispatchEvent(new Event('resize'));
    }
    var rm = st.reducedMotion == null ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : st.reducedMotion;
    root.classList.toggle('gt-reduced-motion', !!rm);
  }
  function toggleFullscreen() {
    if (document.fullscreenElement) { document.exitFullscreen && document.exitFullscreen(); return; }
    var el = document.documentElement;
    if (el.requestFullscreen) el.requestFullscreen().catch(function () { GT.toast('Browser menolak layar penuh. Coba tekan F11.'); });
    else GT.toast('Browser ini tidak mendukung layar penuh. Coba tekan F11.');
  }
  document.addEventListener('fullscreenchange', function () { applyLayout(); setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 60); });
  window.addEventListener('resize', function () { if (!document.fullscreenElement) applyLayout(); });

  /* ------------------------------------------------------------ settings modal */
  var modal = null;
  function $(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function body() {
    var wrap = $('div', 'gt-settings');
    var h = $('h3', null, 'Tombol'); wrap.appendChild(h);
    wrap.appendChild($('p', 'mnote', 'Klik sebuah kotak lalu tekan tombol baru. Esc membatalkan. Tombol yang sudah dipakai aksi lain akan dipindahkan.'));
    ACTIONS.forEach(function (a) {
      var row = $('div', 'mrow');
      row.appendChild($('span', 'grow', a.label));
      for (var slot = 0; slot < 2; slot++) {
        (function (slot) {
          var b = $('button', 'mbtn gt-key', keyName(st.binds[a.id][slot]));
          b.type = 'button';
          b.setAttribute('aria-label', a.label + ', tombol ' + (slot + 1) + ': ' + keyName(st.binds[a.id][slot]));
          b.addEventListener('click', function () { startCapture(a.id, slot, b); });
          row.appendChild(b);
        })(slot);
      }
      wrap.appendChild(row);
    });
    var r = $('div', 'dbtns');
    var reset = $('button', 'mbtn', 'Reset ke bawaan'); reset.type = 'button';
    reset.addEventListener('click', function () { ACTIONS.forEach(function (a) { st.binds[a.id] = a.keys.slice(); }); save(); rebuild(); redraw(); GT.toast('Tombol dikembalikan ke bawaan.'); });
    r.appendChild(reset); wrap.appendChild(r);

    wrap.appendChild($('h3', null, 'Layar'));
    var seg = $('div', 'mseg');
    [['auto', 'Otomatis'], ['full', 'Penuh jendela'], ['boxed', 'Kotak (klasik)']].forEach(function (o) {
      var lab = $('label'); var inp = $('input'); inp.type = 'radio'; inp.name = 'gt-layout'; inp.value = o[0]; inp.checked = st.layout === o[0];
      inp.addEventListener('change', function () { st.layout = o[0]; save(); applyLayout(); window.dispatchEvent(new Event('resize')); });
      lab.appendChild(inp); lab.appendChild($('span', null, o[1])); seg.appendChild(lab);
    });
    wrap.appendChild(seg);
    var fs = $('div', 'dbtns');
    var fsb = $('button', 'mbtn primary', document.fullscreenElement ? 'Keluar layar penuh' : 'Layar penuh (' + label('fullscreen') + ')'); fsb.type = 'button';
    fsb.addEventListener('click', function () { toggleFullscreen(); });
    fs.appendChild(fsb); wrap.appendChild(fs);

    var rm = $('label', 'dchk'); var cb = $('input'); cb.type = 'checkbox';
    cb.checked = document.documentElement.classList.contains('gt-reduced-motion');
    cb.addEventListener('change', function () { st.reducedMotion = cb.checked; save(); applyLayout(); });
    rm.appendChild(cb); rm.appendChild($('span', null, 'Kurangi animasi'));
    wrap.appendChild(rm);
    return wrap;
  }

  function startCapture(action, slot, el) {
    capturing = { action: action, slot: slot, el: el };
    el.textContent = 'tekan…'; el.classList.add('gt-capturing');
  }
  function finishCapture(code) {
    var c = capturing; capturing = null;
    if (code && c) {
      ACTIONS.forEach(function (a) {
        st.binds[a.id] = st.binds[a.id].map(function (k) { if (k === code && !(a.id === c.action)) { GT.toast(keyName(code) + ' dipindah dari "' + a.label + '".'); return null; } return k; });
      });
      st.binds[c.action][c.slot] = code;
      save(); rebuild();
    }
    redraw();
  }
  function redraw() { if (modal && modal.isOpen()) modal.setBody(body()); }

  function openSettings() {
    if (modal && modal.isOpen()) return;
    modal = GT.modal({ title: 'Pengaturan', wide: true, body: body(), onClose: function () { capturing = null; } });
  }

  rebuild();
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
  applyLayout();

  window.GT_SETTINGS = { label: label, keyName: keyName, open: openSettings, toggleFullscreen: toggleFullscreen, _state: st };
  GT.register({
    id: 'settings',
    init: function () {
      GT.addHudButton({ id: 'setbtn', label: '⚙', onClick: openSettings, secondary: false });
      GT.addHudButton({ id: 'fsbtn', label: '⛶', onClick: toggleFullscreen, secondary: false });
      renderHelp();
      applyLayout();
    }
  });
})();
