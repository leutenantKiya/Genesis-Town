/*
 * hotbar.js - item slots along the bottom of the game view, like a crafting game's hotbar.
 * Every item the player can hold has a slot with its icon and count (on chain plus today). Like a crafting game, one
 * slot is in your hand: pick it with a click, 1-7 or the mouse wheel. Right-click in the world, R, or clicking the
 * held slot again uses it (food is eaten, Gandum is planted on a tilled plot). Left-click and F act on the world
 * (mouse.js). Right-click on a slot (a long press on phones) opens its menu: send, sell, or the whole bag. E (or I, or the round E button on phones) opens the bag. Reads and acts through window.GT_CHAIN.
 */
(function () {
  'use strict';
  var GT = window.GT;
  if (!GT) return;

  var SLOTS = ['fish', 'wood', 'ore', 'wheat', 'bread', 'meal', 'tool'];
  var OL = '#2a2430';
  // 8x8 icons in the prototype's style (one character per pixel, '.' is empty)
  var ICONS = {
    fish:  { k: OL, b: '#4a8ad8', B: '#2f5fa8', w: '#e8f4ff', rows: ['........', '........', '.kkkk.k.', 'kbbwbkbk', 'kbbbbbbk', 'kBbbbkBk', '.kkkk.k.', '........'] },
    wood:  { k: OL, b: '#b07840', B: '#7a4a28', r: '#e0b070', rows: ['........', '.kkkkkk.', 'krbbbbrk', 'kBBBBBBk', 'krbbbbrk', 'kBBBBBBk', '.kkkkkk.', '........'] },
    ore:   { k: OL, g: '#8a90a4', G: '#5a5e70', s: '#c8e0f0', rows: ['........', '..kkkk..', '.kggsgk.', 'kgGgggGk', 'kggsgGgk', 'kGgggGgk', '.kkkkkk.', '........'] },
    wheat: { k: OL, y: '#f0c848', Y: '#b88a28', g: '#58a040', rows: ['..k.k.k.', '.kykykyk', '.kykykyk', '..kykyk.', '...kgk..', '...kgk..', '..kgk...', '..kk....'] },
    bread: { k: OL, b: '#e0a050', L: '#f8d890', B: '#b87430', rows: ['........', '..kkkk..', '.kbbbbk.', 'kbLbbbbk', 'kbbbLbbk', 'kBbbbbBk', '.kBBBBk.', '..kkkk..'] },
    meal:  { k: OL, b: '#c86a30', B: '#8a4020', p: '#f0f0f0', y: '#f8d838', rows: ['........', '.kkkk.k.', 'kbbybkbk', 'kbBbbbbk', 'kbbbbkBk', '.kkkk.k.', 'kppppppk', '.kkkkkk.'] },
    tool:  { k: OL, g: '#c8ccd8', G: '#8a90a4', w: '#8a5a30', rows: ['..kkk...', '.kgggk..', '.kgGgk..', '..kgkk..', '...kwk..', '...kwk..', '...kwk..', '....k...'] }
  };
  function icon(id, size) {
    var c = document.createElement('canvas'), d = ICONS[id], px = size / 8;
    c.setAttribute('aria-hidden', 'true');
    if (GT.view === '3d' && window.R3D && R3D.icons && R3D.icons.has(id)) { // the 3D view shows soft 3D icons instead of pixel art
      c.width = c.height = Math.round(size * 2); c.style.width = c.style.height = size + 'px';
      if (R3D.icons.draw(c, id)) return c;
    }
    c.style.width = c.style.height = ''; c.width = c.height = size;
    var g = c.getContext('2d');
    if (d) for (var y = 0; y < 8; y++) for (var x = 0; x < 8; x++) {
      var ch = d.rows[y].charAt(x);
      if (ch === '.' || !d[ch]) continue;
      g.fillStyle = d[ch]; g.fillRect(x * px, y * px, px, px);
    }
    return c;
  }

  function $(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  var bar = null, pop = null, selected = -1, label = null;
  // the item in your hand (like a crafting game's selected slot): right-click or R uses it
  var held = 4;
  try { var hv = +localStorage.getItem('gt.hotbar.held'); if (hv >= 0 && hv < SLOTS.length) held = hv; } catch (e) { /* storage blocked */ }
  function setHeld(i) { held = (i + SLOTS.length) % SLOTS.length; try { localStorage.setItem('gt.hotbar.held', String(held)); } catch (e) { /* storage blocked */ } render(); }

  function chain() { return window.GT_CHAIN; }
  function bag() { var c = chain(); return c && c.state.st ? c.state.st.bag : null; }

  function build() {
    var screen = document.getElementById('screen');
    if (!screen || bar) return;
    bar = $('div', 'gt-hotbar'); bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Barang di tas');
    SLOTS.forEach(function (id, i) {
      var b = $('button', 'gt-slot'); b.type = 'button'; b.dataset.item = id;
      b.appendChild(icon(id, 24));
      b.appendChild($('span', 'gt-slot-n', '0'));
      b.appendChild($('span', 'gt-slot-k', String(i + 1)));
      // click: hold this item (click it again to use it); right-click or a long press: its menu
      b.addEventListener('click', function (e) { e.stopPropagation(); e.currentTarget.blur(); closePop(); if (held === i) useHeld(); else setHeld(i); });
      b.addEventListener('contextmenu', function (e) { e.preventDefault(); e.stopPropagation(); toggle(i); });
      bar.appendChild(b);
    });
    var open = $('button', 'gt-slot gt-slot-bag', 'Tas'); open.type = 'button';
    open.setAttribute('aria-label', 'Buka tas (E)');
    open.addEventListener('click', function (e) { e.stopPropagation(); e.currentTarget.blur(); closePop(); openBag(); });
    bar.appendChild(open);
    label = $('div', 'gt-held');
    screen.appendChild(label);
    screen.appendChild(bar);
    document.documentElement.classList.add('gt-has-hotbar');
  }

  function render() {
    build();
    var c = chain(), b = bag();
    var on = c && c.state.mode !== 'offline' && c.state.mode !== 'loading' && !!c.state.account && !!b;
    bar.style.display = on ? '' : 'none';
    if (label) label.style.display = on ? '' : 'none';
    document.documentElement.classList.toggle('gt-has-hotbar', on);
    if (!on) { closePop(); return; }
    var names = (c.state.cfg && c.state.cfg.econ && c.state.cfg.econ.items) || {};
    SLOTS.forEach(function (id, i) {
      var el = bar.children[i], it = b[id] || { settled: 0, today: 0 }, n = it.settled + it.today;
      el.querySelector('.gt-slot-n').textContent = String(n);
      el.classList.toggle('empty', n <= 0);
      el.classList.toggle('today', it.today !== 0);
      el.classList.toggle('sel', i === held);
      el.classList.toggle('menu', i === selected);
      var nm = (names[id] && names[id].name) || id;
      el.setAttribute('aria-label', nm + ': ' + n + (it.today ? ' (' + (it.today > 0 ? '+' : '') + it.today + ' hari ini)' : ''));
      el.title = nm;
    });
    if (label && on) {
      var hid = SLOTS[held], hn = (names[hid] && names[hid].name) || hid, hit = b[hid] || { settled: 0, today: 0 };
      var how = document.documentElement.classList.contains('gt-phone') ? 'ketuk lagi' : 'klik kanan / R';
      label.textContent = 'Di tangan: ' + hn + ' (' + (hit.settled + hit.today) + ') · ' + how + ': ' + useVerb(hid);
    }
    if (pop && selected >= 0) fillPop();
  }

  function openBag() { var c = chain(); if (c) c.open('bag'); }
  function useVerb(id) { return id === 'bread' || id === 'meal' ? 'makan' : id === 'wheat' ? 'tanam di petak' : id === 'tool' ? 'dipakai saat menambang' : 'kirim atau jual'; }
  /** Use the item in your hand. `tile` is where the player right-clicked (optional). */
  function useHeld(tile) {
    var c = chain(), b = bag(), id = SLOTS[held];
    if (!c || !b || GT.isUiOpen() || (window.GT_FISH && GT_FISH.active()) || document.documentElement.classList.contains('gt-fighting')) return;
    var econ = (c.state.cfg && c.state.cfg.econ && c.state.cfg.econ.items[id]) || {}, it = b[id] || { settled: 0, today: 0 }, n = it.settled + it.today;
    closePop();
    if (econ.energy) {
      if (n <= 0) return GT.toast('Tidak ada ' + (econ.name || id) + ' di tas.');
      c.act({ action: 'eat', token: id }).catch(function () {});
      return;
    }
    if (id === 'wheat') {
      // plant on the plot you right-clicked, or the one you face
      var p = GT.player, d = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[p.dir] || [0, 1];
      var t = tile && Math.abs(tile.x - p.x) + Math.abs(tile.y - p.y) === 1 ? tile : { x: p.x + d[0], y: p.y + d[1] };
      var pi = GT.scene && GT.scene.kind === 'out' ? c.plotAt(t.x, t.y) : -1, plot = pi >= 0 && c.state.st.plots[pi];
      if (!plot) return GT.toast('Pegang Gandum, berdiri di sebelah petak kebun yang sudah dicangkul, lalu klik kanan petaknya.');
      if (plot.state !== 'tilled') return GT.toast(plot.state === 'empty' ? 'Cangkul dulu petaknya (klik atau F).' : 'Petak ini sudah ditanami.');
      c.act({ action: 'farm', op: 'plant', plot: pi }).catch(function () {});
      return;
    }
    if (id === 'tool') return GT.toast('Alat dipakai otomatis saat menambang batu.');
    toggle(held); // raw goods: what you can do with them (send, sell)
  }

  function closePop() { if (pop) { pop.remove(); pop = null; } selected = -1; if (bar) [].forEach.call(bar.children, function (x) { x.classList.remove('sel'); }); }
  function toggle(i) {
    if (selected === i) { closePop(); return; }
    selected = i;
    if (!pop) { pop = $('div', 'gt-slotpop'); pop.addEventListener('click', function (e) { e.stopPropagation(); }); document.getElementById('screen').appendChild(pop); }
    render();
  }
  function fillPop() {
    var c = chain(), b = bag(), id = SLOTS[selected];
    if (!c || !b || !id) return closePop();
    var it = b[id] || { settled: 0, today: 0, name: id }, econ = c.state.cfg.econ.items[id] || {};
    var can = c.spendable(id);
    pop.textContent = '';
    pop.appendChild($('b', null, (it.name || econ.name || id) + ' · ' + (it.settled + it.today)));
    pop.appendChild($('p', null, it.today ? it.settled + ' tercatat di NEAR, ' + (it.today > 0 ? '+' : '') + it.today + ' hari ini (masuk pukul 06:00).' : it.settled > 0 ? 'Semua sudah tercatat di NEAR.' : 'Belum punya. ' + hintFor(id)));
    var row = $('div', 'gt-slotpop-acts');
    function act(label, fn, primary) { var x = $('button', 'mbtn' + (primary ? ' primary' : ''), label); x.type = 'button'; x.addEventListener('click', function () { closePop(); fn(); }); row.appendChild(x); }
    if (econ.energy && it.settled + it.today > 0) act('Makan (+' + econ.energy + ' energi)', function () { c.act({ action: 'eat', token: id }).catch(function () {}); }, true);
    if (can > 0) act('Kirim', function () { c.askSend(id); });
    if (can > 0) act('Jual ke pemain', function () { c.askList(id, can); });
    act('Buka tas', openBag);
    pop.appendChild(row);
    // sit above the chosen slot
    var slot = bar.children[selected], sr = document.getElementById('screen').getBoundingClientRect(), r = slot.getBoundingClientRect();
    pop.style.left = Math.max(6, Math.min(sr.width - 230, r.left - sr.left - 90)) + 'px';
  }
  function hintFor(id) {
    return { fish: 'Mancing di kolam atau sungai.', wood: 'Tebang pohon.', ore: 'Nambang di batu Tambang Utara (butuh Alat).', wheat: 'Tanam dan panen di kebunmu.', bread: 'Buat di Meja Kerja (2 Gandum) atau beli di Wati.', meal: 'Buat di Meja Kerja (Ikan + Kayu) atau beli di Sari.', tool: 'Buat di Meja Kerja (2 Bijih + Kayu) atau beli di Budi.' }[id] || '';
  }

  function onKey(e) {
    if (e.type !== 'keydown' || e.repeat || GT.isUiOpen()) return false;
    var n = /^Digit([1-7])$/.exec(e.code);
    if (n && bar && bar.style.display !== 'none') { closePop(); setHeld(+n[1] - 1); return true; }
    if (e.code === 'KeyR' && bar && bar.style.display !== 'none') { useHeld(); return true; }
    if (e.code === 'Escape' && pop) { closePop(); return true; }
    return false;
  }

  // switching between the 2D and the 3D view swaps the pixel icons and the soft 3D icons
  function refreshIcons() {
    if (!bar) return;
    [].forEach.call(bar.querySelectorAll('.gt-slot'), function (b) {
      var old = b.querySelector('canvas'), id = b.dataset.item; if (!old || !id) return;
      var nu = icon(id, 24); old.parentNode.replaceChild(nu, old);
    });
  }

  function init() {
    build();
    if (GT.on) GT.on('view', function () { setTimeout(refreshIcons, 0); });
    // the round E button on phones opens the bag (the NPC message lives in Lainnya and on T)
    var pad = document.getElementById('pad'), be = document.getElementById('btnE');
    if (be) be.setAttribute('aria-label', 'Tombol E, buka tas');
    if (pad && be) pad.addEventListener('pointerdown', function (e) {
      if (e.target !== be && !be.contains(e.target)) return;
      e.preventDefault(); e.stopPropagation();
      if (!GT.isUiOpen()) openBag();
    }, true);
    document.addEventListener('click', function (e) { if (pop && !(bar && bar.contains(e.target))) closePop(); });
    // right-click in the world uses the item in your hand; the mouse wheel changes it
    var cv = document.getElementById('cv'), screen = document.getElementById('screen');
    if (cv) cv.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      if (!bar || bar.style.display === 'none') return;
      useHeld(GT.screenToTile ? GT.screenToTile(e.clientX, e.clientY) : null);
    });
    if (screen) screen.addEventListener('wheel', function (e) {
      if (!bar || bar.style.display === 'none' || GT.isUiOpen() || GT.view === '3d') return; // in 3D the wheel zooms
      e.preventDefault();
      setHeld(held + (e.deltaY > 0 ? 1 : -1));
    }, { passive: false });
    setInterval(render, 500);
    render();
  }

  // shared with the shop, bag and market windows (js/mods/chain.js), so every item looks the same everywhere
  window.GT_ITEMS = { icon: icon, SLOTS: SLOTS, hold: function (id) { var i = SLOTS.indexOf(id); if (i >= 0) setHeld(i); }, held: function () { return SLOTS[held]; } };
  GT.register({ id: 'hotbar', init: init, onKey: onKey });
})();
