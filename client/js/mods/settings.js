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
  // Phone layout (css/phone.css), held either way up: a phone or a portrait tablet, or any short landscape screen
  // played by touch. Portrait: the game between a status bar and a bottom bar. Landscape (html.gt-land): the game takes
  // the whole height beside a rail of the same five places, under a one-line status bar. Both walk with the joystick
  // and act with one round button; neither has the D-pad. It wins over the full window, a phone in fullscreen included
  // (the full window has no thumb controls), unless the player chose a layout in Settings.
  function phoneLike() {
    var w = window.innerWidth, h = window.innerHeight, touch = window.matchMedia('(pointer: coarse)').matches;
    if (h >= w) return w <= 900;
    return h <= 560 && (touch || w <= 1000);
  }
  function wantsPhone() {
    if (st.layout === 'boxed' || st.layout === 'full') return false;
    return phoneLike();
  }
  function wantsFull() {
    if (st.layout === 'boxed') return false;
    if (st.layout === 'full' || fsElement()) return !wantsPhone();
    return window.matchMedia('(pointer: fine)').matches && window.innerWidth >= 900 && !wantsPhone();
  }
  function applyText() { document.documentElement.style.setProperty('--ts', String(st.textSize || 1)); }
  function applyLayout() {
    var phone = wantsPhone(), on = !phone && wantsFull(), land = phone && window.innerWidth > window.innerHeight;
    var root = document.documentElement;
    var changed = root.classList.contains('gt-full') !== on || root.classList.contains('gt-phone') !== phone || root.classList.contains('gt-land') !== land;
    root.classList.toggle('gt-full', on);
    root.classList.toggle('gt-phone', phone);
    root.classList.toggle('gt-land', land);
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
  // turning the phone (in fullscreen too) swaps portrait and landscape at once
  window.addEventListener('resize', applyLayout);
  window.addEventListener('orientationchange', function () { setTimeout(function () { applyLayout(); window.dispatchEvent(new Event('resize')); }, 120); });

  /* ------------------------------------------------------------ phone bottom bar */
  // Each tab presses the existing HUD button, so the bar adds no game logic of its own.
  var tabbar = null;
  function press(id) { var b = document.getElementById(id); if (b) b.click(); }
  // Account shortcuts at the foot of the Settings panel's left column (the old Settings list is gone: the panel is the
  // settings). Each one closes the panel first, then opens its own window.
  function shortcuts() {
    var row = $('div', 'gt-set-links'), opts = [];
    if (GT.openProfile) opts.push(['🪪', $t('Profil'), function () { GT.openProfile(); }]);
    if (window.GT_SIM) opts.push(['📊', $t('Simulasi 1 minggu'), function () { GT_SIM.open(); }]);
    if (window.GT_ADMIN && GT_ADMIN.isAdmin()) opts.push(['🛡️', $t('Admin'), function () { GT_ADMIN.open(); }]);
    if (document.getElementById('devbtn')) opts.push(['🛠️', 'Dev', function () { press('devbtn'); }]);
    if (window.GT_CHAIN && GT_CHAIN.state && GT_CHAIN.state.account) opts.push(['🚪', $t('Keluar (ganti akun)'), function () { GT_CHAIN.signOut(); }]);
    opts.forEach(function (o) {
      var b = $('button', 'mbtn gt-set-link', o[0] + ' ' + o[1]); b.type = 'button';
      b.addEventListener('click', function () { if (modal && modal.isOpen()) modal.close('go'); o[2](); });
      row.appendChild(b);
    });
    return row;
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
     ['tab-more', $t('Menu'), openSettings, $t('Pengaturan')]].forEach(function (t) {
      var b = $('button', 'gt-tab', t[1]); b.type = 'button'; b.id = t[0];
      if (t[3]) b.setAttribute('aria-label', t[3]); // a short word on the tab, the full name for screen readers
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

  /* ------------------------------------------------------------ phone action button */
  // On a phone there is no D-pad and no A / E button (css/phone.css hides #pad): you walk by tapping the map (mouse.js) and
  // ONE round button (#btnAct, index.html) appears over the game view only while the tile you face can be used.
  // Tapping it does what A / F does: GT.interact('talk'). It stays hidden while a window or dialog is open, while you
  // walk, fish or fight. The probes below read the same data the engine and the mods act on; a mod whose interaction
  // is not covered adds its own with GT_ACTBTN.add(fn): fn(ctx) returns {icon, label} or null, where ctx is
  // {scene, map, tile:{x,y}, idx, tileType, npc, door, player, world}. Probes added this way run first.
  var actBtn = null, actIco = null, actLbl = null, actProbes = [], actSeen = '', actOn = '', actAt = 0;

  function npcOn(sc, x, y) {
    var a = sc.npcs || [];
    for (var i = 0; i < a.length; i++) if (!a[i].hidden && a[i].x === x && a[i].y === y) return a[i];
    return null;
  }
  function tileAct(c) {
    var sc = c.scene, out = sc.kind === 'out';
    switch (c.tileType) {
      case 'stall': return out ? { icon: '🛒', label: $t('Belanja') } : null;
      case 'counter': return sc.kind === 'mart' ? { icon: '🛒', label: $t('Belanja') } : sc.house && sc.house.kind === 'mall' ? { icon: '🛍️', label: $t('Mall') } : null; // the Genesis Mall's counter
      case 'water': return out ? { icon: '🎣', label: $t('Mancing') } : null;
      case 'tree': return out ? { icon: '🪓', label: $t('Tebang') } : null;
      case 'rock': return out ? { icon: '⛏️', label: $t('Tambang') } : null;
      case 'grass': case 'tallgrass': { var gc = window.GT_CHAIN && GT_CHAIN.state && GT_CHAIN.state.account && GT_CHAIN.state.cfg && GT_CHAIN.state.cfg.econ && GT_CHAIN.state.cfg.econ.grass; return out && gc && gc.tiles.indexOf(c.tileType) >= 0 ? { icon: '🌾', label: $t('Cari benih') } : null; } // grass: a small chance of a wheat seed (mods/chain.js searchGrass)
      case 'table': return out ? null : (sc.house && sc.house.own ? { icon: '🔨', label: $t('Meja') } : { icon: '🍌', label: $t('Makan') });
      case 'chest': return out ? null : { icon: '📦', label: $t('Buka') };
      case 'bed': return out ? null : { icon: '😴', label: $t('Tidur') };
      case 'bookshelf': return out ? null : { icon: '📚', label: $t('Baca') };
      case 'tv': return out ? null : { icon: '📺', label: $t('Nonton') };
      case 'fridge': return out ? null : { icon: '🧃', label: $t('Minum') };
      case 'plant': return out ? null : { icon: '💧', label: $t('Siram') };
      case 'chair': return out ? null : { icon: '🪑', label: $t('Duduk') };
      case 'dice_table': case 'card_table': case 'slot': return sc.kind === 'casino' || sc.kind === 'kasino' ? { icon: '🎲', label: $t('Main') } : null;
      case 'roulette': return sc.kind === 'kasino' ? { icon: '🎲', label: $t('Main') } : null; // the Luck Table in the Genesis Casino
      case 'lb_wall': return sc.house && sc.house.kind === 'papan' ? { icon: '🏆', label: $t('Papan Juara') } : null;
      case 'news_board': return sc.house && sc.house.kind === 'papan' ? { icon: '📰', label: $t('Berita') } : null;
    }
    return null;
  }
  // the village's one-off spots: portal, Mall, boats, carousel (their mods decide on the same data)
  function spotAct(c) {
    var L = c.world, V = window.GTVillage, t = c.tile, p = c.player, pub = GT.worldId && GT.worldId() === 'public';
    if (c.scene.kind !== 'out' || !L) return null;
    if (window.GT_RIDE && GT_RIDE.on) return { icon: '🎠', label: $t('Turun') };
    if (L.portal && L.portal.x === t.x && L.portal.y === t.y) return { icon: '🌀', label: $t('Portal') };
    if (pub && V) {
      try {
        // someone standing on a spot is talked to first (trade.js skips the spot when ctx.npc is set)
        var lm = V.landmarks && L.market ? V.landmarks(L) : null, at = function (q) { return !c.npc && q && q.x === t.x && q.y === t.y; };
        if (lm && at(lm.mall)) return { icon: '🛍️', label: $t('Mall') };
        // trade.js opens these on interact while you face them (walkable plaza tiles with no NPC, so nothing else shows the button)
        if (lm && at(lm.board)) return { icon: '🏆', label: $t('Papan Juara') };
        if (lm && at(lm.gamble)) return { icon: '🎲', label: $t('Main') };
        var fe = V.ferryOf && V.ferryOf(L);
        if (fe) {
          var near = function (q) { return Math.abs(p.x - q.x) + Math.abs(p.y - q.y) <= 1; };
          if ((t.x === fe.wa.x && t.y === fe.wa.y) || (t.x === fe.wb.x && t.y === fe.wb.y) || near(fe.a) || near(fe.b)) return { icon: '⛵', label: $t('Perahu') };
        }
      } catch (e) { /* a village without these spots */ }
      var fun = L.fun || (L.layout && L.layout.fun), car = fun && fun.carousel; // the carousel lives under GT.world.layout.fun
      if (car && Math.max(Math.abs(t.x - (car.x + 0.5)), Math.abs(t.y - (car.y + 0.5))) <= 3 && Math.max(Math.abs(p.x - (car.x + 0.5)), Math.abs(p.y - (car.y + 0.5))) <= 3) return { icon: '🎠', label: $t('Naik') };
    }
    return null;
  }
  // farm plots (the village's and the Homeland's) and the Homeland's hoe grid
  function farmAct(c) {
    var L = c.world, C = window.GT_CHAIN, cs = C && C.state, t = c.tile;
    if (c.scene.kind !== 'out' || !L) return null;
    var plots = (cs && cs.plots && cs.plots.length) ? cs.plots : (L.farm && L.farm.plots) || [];
    for (var i = 0; i < plots.length; i++) {
      if (plots[i].x !== t.x || plots[i].y !== t.y) continue;
      var pl = cs && cs.st && cs.st.plots && cs.st.plots[i], s = pl && pl.state;
      return { icon: '🌱', label: s === 'empty' ? $t('Cangkul') : s === 'tilled' ? $t('Tanam') : s === 'ready' ? $t('Panen') : s ? $t('Siram') : $t('Kebun') };
    }
    // the Homeland's hoe grid and empty lots are not decided here: mods/homeland.js registers its own probe (GT_ACTBTN.add)
    return null;
  }
  function actionAhead() {
    var sc = GT.scene, pl = GT.player, f = GT.facing && GT.facing();
    if (!sc || !sc.map || !pl || !f) return null;
    if (GT.sitting) return { id: 'sit', icon: '🧍', label: $t('Berdiri') };
    var m = sc.map;
    if (f.x < 0 || f.y < 0 || f.x >= m.w || f.y >= m.h) return null;
    var idx = f.y * m.w + f.x, tt = m.tiles[idx];
    var npc = npcOn(sc, f.x, f.y);
    if (!npc && tt === 'counter' && sc.kind === 'mart') npc = { name: '', key: 'x:keeper' };
    var door = m.door && m.door.get(idx) || null;
    var c = { scene: sc, map: m, tile: { x: f.x, y: f.y }, idx: idx, tileType: door ? 'door' : tt, npc: npc, door: door, player: pl, world: GT.world };
    var r = null, i;
    for (i = 0; i < actProbes.length && !r; i++) { try { r = actProbes[i](c) || null; } catch (e) { r = null; } }
    if (!r) r = spotAct(c);
    if (!r && npc) r = npc.key && (npc.key.indexOf('merchant:') === 0 || /:keeper$/.test(npc.key)) ? { icon: '🛒', label: $t('Belanja') } : { icon: '💬', label: $t('Bicara') };
    if (!r && door) r = { icon: '🚪', label: $t('Pintu') };
    if (!r) r = farmAct(c);
    if (!r && m.info && m.info.has(idx)) r = { icon: 'ℹ️', label: $t('Lihat') };
    if (!r) r = tileAct(c);
    return r;
  }
  function actHide() { if (actBtn && !actBtn.hidden) actBtn.hidden = true; actOn = ''; actSeen = ''; }
  function actTick() {
    if (!actBtn) return;
    var now = performance.now();
    if (now - actAt < 100) return;
    actAt = now;
    var pl = GT.player;
    if (!document.documentElement.classList.contains('gt-phone') || !pl || pl.moving || GT.isUiOpen() ||
        (window.GT_FISH && GT_FISH.active()) || document.documentElement.classList.contains('gt-fighting')) return actHide();
    var a = actionAhead();
    if (!a) return actHide();
    var key = a.icon + '|' + a.label;
    if (actOn === key) return; // already showing it
    // it has to hold for a poll before it appears, so tiles you walk past do not make the button flicker
    if (actSeen !== key) { actSeen = key; return; }
    actOn = key;
    actIco.textContent = a.icon; actLbl.textContent = a.label;
    actBtn.setAttribute('aria-label', a.label); actBtn.title = a.label;
    actBtn.hidden = false;
  }
  function buildActBtn() {
    actBtn = document.getElementById('btnAct');
    if (!actBtn) return;
    actIco = actBtn.querySelector('.ico'); actLbl = actBtn.querySelector('.lbl');
    function press() { if (!GT.isUiOpen()) GT.interact('talk'); }
    actBtn.addEventListener('pointerdown', function (e) { e.preventDefault(); actBtn.classList.add('down'); press(); });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (t) { actBtn.addEventListener(t, function () { actBtn.classList.remove('down'); }); });
    actBtn.addEventListener('click', function (e) { if (e.detail === 0) press(); e.currentTarget.blur(); }); // the keyboard's Enter / Space
    actBtn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }
  window.GT_ACTBTN = { add: function (fn) { if (typeof fn === 'function') actProbes.push(fn); }, ahead: actionAhead };

  // The phone's joystick (#joy, bottom left of the game view): push the knob to walk. In the 2.5D view outdoors it is
  // analog (any direction, GT.setStick); in 2D and indoors it holds the nearest of the four directions (GT.padDir).
  // Tapping the map to walk (mods/mouse.js) still works beside it.
  var JOY_R = 32, JOY_DEAD = 0.28, joyTick = function () {};
  function buildJoy() {
    var joy = document.getElementById('joy');
    if (!joy || !GT.padDir) return;
    var knob = joy.firstElementChild, held = null, lastPt = null;
    function steer(e) {
      lastPt = { clientX: e.clientX, clientY: e.clientY };
      var r = joy.getBoundingClientRect(), dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
      var d = Math.hypot(dx, dy), k = d > JOY_R ? JOY_R / d : 1;
      knob.style.transform = 'translate(' + dx * k + 'px,' + dy * k + 'px)';
      if (d < JOY_R * JOY_DEAD || GT.isUiOpen()) { GT.setStick(null); GT.padDir(null); return; }
      if (GT.freeWalk && GT.freeWalk()) { GT.padDir(null); GT.setStick(dx / d, dy / d); }
      else { GT.setStick(null); GT.padDir(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up')); }
    }
    // each frame again: a door or the view switching (2.5D outdoors <-> tiles) while the thumb stays put keeps walking
    joyTick = function () { if (held != null && lastPt) steer(lastPt); };
    function end(e) {
      if (held == null || (e && e.pointerId !== held)) return;
      held = null; lastPt = null; joy.classList.remove('down'); knob.style.transform = '';
      GT.setStick(null); GT.padDir(null);
    }
    joy.addEventListener('pointerdown', function (e) {
      if (held != null) return;
      e.preventDefault(); held = e.pointerId; joy.classList.add('down');
      try { joy.setPointerCapture(e.pointerId); } catch (_) { /* old browsers */ }
      steer(e);
    });
    joy.addEventListener('pointermove', function (e) { if (e.pointerId === held) steer(e); });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) { joy.addEventListener(t, end); });
    joy.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    // a window opening or the page losing focus lets go, so the player never walks on by themselves
    window.addEventListener('blur', function () { end({ pointerId: held }); });
  }

  /* ------------------------------------------------------------ settings modal */
  var modal = null;
  function $(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  // The window is one panel (like the character screen): left the name and a preview of you in your Mall outfit, right
  // "Kustomisasi" (the wardrobe), below it "Party" and "Tampilan & suara" (every setting) side by side, and Simpan.
  // Settings apply the moment they are changed; Simpan saves a new name, then confirms and closes.
  var NAME_RE = /^[A-Za-z0-9 _-]{3,16}$/;
  var dispHost = null, partyHost = null, idleT = 0, draftName = null, nameMsg = null, setTab = 'cust';

  function signedIn() { var c = window.GT_CHAIN, s = c && c.state; return !!(s && s.account && s.mode !== 'offline' && s.mode !== 'loading'); }
  function openMall() { if (modal) modal.close('mall'); if (window.GT_MALL) setTimeout(function () { GT_MALL.open(); }, 0); }

  function body() {
    clearInterval(idleT);
    var CS = window.GT_CHARSCREEN, mine = CS && CS._mine ? CS._mine() : { name: null, tag: '', look: 0 };
    var wrap = $('div', 'gt-set');

    // left: name + fixed tag, and the big stage with you in what you wear
    var left = $('div', 'gt-set-left gt-set-card');
    var nameRow = $('div', 'gt-cs-namerow');
    var input = $('input', 'gt-cs-name'); input.type = 'text'; input.maxLength = 16; input.autocomplete = 'off'; input.spellcheck = false;
    input.placeholder = $t('Namamu'); input.setAttribute('aria-label', $t('Nama'));
    input.value = draftName != null ? draftName : (mine.name || '');
    input.disabled = !signedIn();
    input.addEventListener('input', function () { draftName = input.value; if (nameMsg) nameMsg.textContent = ''; });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); saveAll(); } });
    var tag = $('span', 'gt-cs-tag', mine.tag ? '#' + mine.tag : ''); tag.title = $t('Tag tetapmu: membedakanmu dari pemain bernama sama');
    nameRow.appendChild(input); nameRow.appendChild(tag);
    nameMsg = $('p', 'gt-cs-msg'); nameMsg.setAttribute('role', 'status');
    var stage = $('div', 'gt-cs-stage');
    if (CS && CS.stage) {
      var cv = CS.stage(); cv.className = 'gt-cs-prev gt-set-prev'; cv.style.width = '180px'; cv.style.height = '216px'; cv.setAttribute('aria-hidden', 'true');
      stage.appendChild(cv);
      var dirs = ['down', 'left', 'down', 'right'], tick = 0;
      CS.paintStage(cv, null, 'down', 0);
      idleT = setInterval(function () {
        if (!cv.isConnected) { clearInterval(idleT); return; }
        tick++; CS.paintStage(cv, null, dirs[Math.floor(tick / 4) % dirs.length], tick % 2 ? 1 : 0);
      }, 300);
      stage.addEventListener('click', function () { tick += 4; }); // a tap makes the character look around
    }
    left.appendChild(nameRow); left.appendChild(nameMsg); left.appendChild(stage); left.appendChild(shortcuts());
    wrap.appendChild(left);

    // right: one tab at a time (Kustomisasi, Party, Tampilan & suara) in a card of fixed height, then Simpan
    var right = $('div', 'gt-set-right');
    var cust = $('div', 'gt-set-card gt-set-pane');
    cust.appendChild($('p', 'gt-cs-note', $t('Tampilan tubuh dipilih sekali saat karakter dibuat. Ganti gayamu dengan pakaian dari Genesis Mall.')));
    var ward = $('div', 'gt-cs-wardrobe');
    function wardPaint() {
      if (!CS || !CS.wardrobe) return;
      CS.wardrobe(ward, function () { wardPaint(); if (CS.paintStage) { var c0 = stage.firstChild; if (c0) CS.paintStage(c0, null, 'down', 0); } }, { noHead: true, mall: window.GT_MALL ? openMall : null });
      if (!ward.firstChild) ward.appendChild($('p', 'gt-cs-note', $t('Masuk dulu.')));
    }
    wardPaint();
    cust.appendChild(ward);

    var pc = $('div', 'gt-set-card gt-set-pane');
    partyHost = $('div', 'gt-set-scroll gt-set-party'); pc.appendChild(partyHost);
    if (window.GT_PARTY && GT_PARTY.embed) GT_PARTY.embed(partyHost, function () { if (modal && modal.isOpen()) modal.close('go'); });
    else partyHost.appendChild($('p', 'chain-dim', $t('Masuk dulu.')));
    var dc = $('div', 'gt-set-card gt-set-pane');
    dispHost = $('div', 'gt-set-scroll'); dispHost.appendChild(displayBody()); dc.appendChild(dispHost);
    var panes = { cust: cust, party: pc, disp: dc };
    var tabs = $('div', 'gt-set-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', $t('Pengaturan'));
    [['cust', '👕 ' + $t('Kustomisasi')], ['party', '👥 ' + $t('Party')], ['disp', '🎛️ ' + $t('Tampilan & suara')]].forEach(function (t) {
      var b = $('button', 'gt-set-tab', t[1]); b.type = 'button'; b.setAttribute('role', 'tab'); b.dataset.tab = t[0];
      b.addEventListener('click', function () { setTab = t[0]; pick(); });
      tabs.appendChild(b);
    });
    function pick() {
      Array.prototype.forEach.call(tabs.children, function (b) { var on = b.dataset.tab === setTab; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
      Object.keys(panes).forEach(function (k) { panes[k].hidden = k !== setTab; });
    }
    right.appendChild(tabs);
    right.appendChild(cust); right.appendChild(pc); right.appendChild(dc);
    pick();

    var sv = $('button', 'mbtn primary gt-set-save', $t('Simpan')); sv.type = 'button';
    sv.addEventListener('click', saveAll);
    right.appendChild(sv);
    wrap.appendChild(right);
    return wrap;
  }

  // Simpan: a changed name goes to the server (a taken name is shown under the name field); everything else is already
  // saved the moment it was changed, so this then confirms and closes.
  var saving = false;
  function saveAll() {
    if (saving) return;
    var CS = window.GT_CHARSCREEN, mine = CS && CS._mine ? CS._mine() : {};
    var inp = modal && modal.box && modal.box.querySelector('.gt-cs-name');
    var v = inp ? String(inp.value || '').trim().replace(/ {2,}/g, ' ') : '';
    function done(msg) { save(); if (modal && modal.isOpen()) modal.close('save'); GT.toast(msg || $t('Pengaturan disimpan.')); }
    if (!inp || inp.disabled || !v || v === (mine.name || '')) { done(); return; }
    if (!NAME_RE.test(v)) { if (nameMsg) nameMsg.textContent = $t('Nama 3-16 karakter: huruf, angka, spasi, _ atau -.'); inp.focus(); return; }
    saving = true;
    window.GT_CHAIN.api('/name', { method: 'POST', body: { name: v } }).then(function (r) {
      saving = false;
      if (CS && CS.setName) CS.setName(r); else if (GT.setPlayerName && r.named) GT.setPlayerName(r.name);
      draftName = null;
      done($t('Namamu sekarang {0}#{1}.', [r.name, r.tag]));
    }, function (e) {
      saving = false;
      if (nameMsg) nameMsg.textContent = (e && e.message) || $t('Gagal menyimpan.');
      if (inp && inp.isConnected) inp.focus();
    });
  }

  // every display, sound and key setting (the right-hand box of the window)
  function displayBody() {
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
    if (window.GT_MUSIC) { // background and carousel music (mods/music.js)
      var bl = $('label', 'dchk'), bc = $('input'); bc.type = 'checkbox'; bc.checked = GT_MUSIC.on();
      bc.addEventListener('change', function () { GT_MUSIC.setOn(bc.checked); });
      bl.appendChild(bc); bl.appendChild($('span', null, $t('Musik latar')));
      wrap.appendChild(bl);
      var ml = $('label', 'dchk'), mr = $('input'); mr.type = 'range'; mr.min = '0'; mr.max = '100'; mr.value = String(Math.round(GT_MUSIC.vol() * 100));
      mr.setAttribute('aria-label', $t('Volume musik'));
      mr.addEventListener('input', function () { GT_MUSIC.setVol(mr.value / 100); });
      ml.appendChild($('span', null, $t('Volume musik'))); ml.appendChild(mr);
      wrap.appendChild(ml);
    }
    if (window.GT_SFX) { // sound effects (mods/sfx.js)
      var sl = $('label', 'dchk'), sc = $('input'); sc.type = 'checkbox'; sc.checked = GT_SFX.on();
      sc.addEventListener('change', function () { GT_SFX.setOn(sc.checked); GT_SFX.play('ui_click'); });
      sl.appendChild(sc); sl.appendChild($('span', null, $t('Efek suara')));
      wrap.appendChild(sl);
      var vl = $('label', 'dchk'), vr = $('input'); vr.type = 'range'; vr.min = '0'; vr.max = '100'; vr.value = String(Math.round(GT_SFX.vol() * 100));
      vr.setAttribute('aria-label', $t('Volume efek suara'));
      vr.addEventListener('change', function () { GT_SFX.setVol(vr.value / 100); GT_SFX.play('ui_click'); });
      vr.addEventListener('input', function () { GT_SFX.setVol(vr.value / 100); });
      vl.appendChild($('span', null, $t('Volume efek suara'))); vl.appendChild(vr);
      wrap.appendChild(vl);
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
  // a setting changed its own controls (a key capture, the fullscreen button): rebuild only the settings box and keep its scroll;
  // full = everything (a language switch)
  function redraw(full) {
    if (!modal || !modal.isOpen()) return;
    if (full === true || !dispHost || !dispHost.isConnected) { modal.setTitle($t('Pengaturan')); modal.setBody(body()); return; }
    var top = dispHost.scrollTop;
    dispHost.textContent = ''; dispHost.appendChild(displayBody()); dispHost.scrollTop = top;
  }

  function openSettings() {
    if (modal && modal.isOpen()) return;
    draftName = null;
    modal = GT.modal({ title: $t('Pengaturan'), sticky: true, wide: true, body: body(), onClose: function () { capturing = null; draftName = null; clearInterval(idleT); } });
    modal.box.classList.add('gt-set-box');
    var xb = modal.box.querySelector('.mx'); if (xb) xb.setAttribute('data-autofocus', ''); // not the name field: a phone would raise its keyboard
  }

  rebuild();
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
  applyLayout();

  // a language switch: rebuild this window and the key hint line in the new language
  if (window.GT_I18N) GT_I18N.onChange(function () { redraw(true); rebuild(); });

  /* ------------------------------------------------------------ the top bar (full window)
     The banner and the HUD float over the game as one bar. It shows for a moment at the start, then slides up; the
     pointer at the top edge brings it back for as long as it is near, and the tab (or U) brings it back pinned; its
     own button unpins and hides it. A window or a focused button in it keeps it shown. */
  var LS_TOP = 'gt.topbar', topBar = null, topTab = null, topPinned = false, topHideT = 0, topNear = false;
  try { topPinned = localStorage.getItem(LS_TOP) === 'pinned'; } catch (e) { /* storage blocked */ }
  function topFull() { return document.documentElement.classList.contains('gt-full'); }
  function topShown() { return !document.documentElement.classList.contains('gt-top-hide'); }
  function topShow(on) { document.documentElement.classList.toggle('gt-top-hide', !on); }
  function topPin(on) {
    topPinned = on; try { localStorage.setItem(LS_TOP, on ? 'pinned' : 'auto'); } catch (e) { /* storage blocked */ }
    clearTimeout(topHideT); topShow(on);
  }
  function topHideSoon(ms) {
    clearTimeout(topHideT);
    topHideT = setTimeout(function () {
      if (topPinned || topNear || !topFull()) return;
      if (GT.isUiOpen() || (topBar && topBar.contains(document.activeElement))) return topHideSoon(1200);
      topShow(false);
    }, ms);
  }
  function buildTop() {
    if (topBar) return;
    var shell = document.querySelector('.shell'), hud = document.getElementById('hud');
    if (!shell || !hud) return;
    topBar = $('div', 'gt-top'); shell.insertBefore(topBar, hud); topBar.appendChild(hud);
    var hb = $('button', 'gt-top-hidebtn'); hb.type = 'button'; hb.innerHTML = '▴ <kbd>U</kbd>';
    hb.setAttribute('aria-label', $t('Sembunyikan bilah atas (U)')); hb.title = $t('Sembunyikan bilah atas (U)');
    hb.addEventListener('click', function (e) { e.currentTarget.blur(); topPin(false); });
    topBar.appendChild(hb);
    topTab = $('button', 'gt-top-tab'); topTab.type = 'button'; topTab.innerHTML = '▾ ' + $t('Menu') + ' <kbd>U</kbd>';
    topTab.setAttribute('aria-label', $t('Tampilkan bilah atas (U)'));
    topTab.addEventListener('click', function (e) { e.currentTarget.blur(); topPin(true); });
    shell.appendChild(topTab);
    window.addEventListener('mousemove', function (e) {
      if (!topFull() || topPinned) return;
      var h = topBar.offsetHeight || 60;
      topNear = e.clientY < (topShown() ? h + 24 : 36);
      if (topNear) { clearTimeout(topHideT); topShow(true); } else if (topShown()) topHideSoon(700);
    });
    topBar.addEventListener('focusin', function () { clearTimeout(topHideT); topShow(true); });
    topShow(true);
    if (!topPinned) topHideSoon(3500); // a moment to see what is there, then the game has the screen
    window.dispatchEvent(new Event('resize')); // the HUD left the flow: the game view takes the whole height
  }
  function topFrame() {
    if (!topBar) return;
    var banner = document.querySelector('.shell > .chain-banner'); // made by chain.js after this bar: it joins the bar
    if (banner) { topBar.insertBefore(banner, topBar.firstChild); window.dispatchEvent(new Event('resize')); } // it took room in the flow: measure again
    var h = topBar.offsetHeight; if (h !== topH) { topH = h; document.documentElement.style.setProperty('--gt-top-h', h + 'px'); }
  }
  var topH = 0;

  window.GT_SETTINGS = { label: label, keyName: keyName, open: openSettings, toggleFullscreen: toggleFullscreen, _state: st, topBar: function (on) { topPin(on == null ? !topShown() : !!on); } };
  GT.register({
    id: 'settings',
    onFrame: function () { actTick(); joyTick(); },
    init: function () {
      buildActBtn(); buildJoy();
      // A calmer HUD: Tas, Pasar, Peta and Simulasi stay in view; the gear opens the Settings panel straight away
      // (css/phone.css hides the rest). Their keyboard shortcuts still work.
      GT.addHudButton({ id: 'gt-morebtn', label: $t('Pengaturan'), onClick: openSettings, secondary: false });
      renderHelp();
      applyLayout();
      buildTop();
      GT.hotkey('U', function () { if (topFull()) topPin(!topShown()); });
    },
    onFrame: topFrame
  });
})();
