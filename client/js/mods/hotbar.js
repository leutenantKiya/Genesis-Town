/*
 * hotbar.js - item slots along the bottom of the game view, like a crafting game's hotbar.
 * Every item the player can hold has a slot with its icon and count (on chain plus today). Left-click (or tap) a
 * slot to use it: food is eaten. Right-click (a long press on phones) or 1-7 opens its menu: send it to a player,
 * list it on the Pasar Pemain, or open the whole bag. E (or I, or the round E button on phones) opens the bag. Reads and acts through window.GT_CHAIN.
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
    c.width = c.height = size; c.setAttribute('aria-hidden', 'true');
    var g = c.getContext('2d');
    if (d) for (var y = 0; y < 8; y++) for (var x = 0; x < 8; x++) {
      var ch = d.rows[y].charAt(x);
      if (ch === '.' || !d[ch]) continue;
      g.fillStyle = d[ch]; g.fillRect(x * px, y * px, px, px);
    }
    return c;
  }

  function $(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  var bar = null, pop = null, selected = -1;

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
      // left-click uses the item (food is eaten); right-click or a long press opens its menu
      b.addEventListener('click', function (e) { e.stopPropagation(); e.currentTarget.blur(); useSlot(i); });
      b.addEventListener('contextmenu', function (e) { e.preventDefault(); e.stopPropagation(); toggle(i); });
      bar.appendChild(b);
    });
    var open = $('button', 'gt-slot gt-slot-bag', 'Tas'); open.type = 'button';
    open.setAttribute('aria-label', 'Buka tas (E)');
    open.addEventListener('click', function (e) { e.stopPropagation(); e.currentTarget.blur(); closePop(); openBag(); });
    bar.appendChild(open);
    screen.appendChild(bar);
    document.documentElement.classList.add('gt-has-hotbar');
  }

  function render() {
    build();
    var c = chain(), b = bag();
    var on = c && c.state.mode !== 'offline' && c.state.mode !== 'loading' && !!c.state.account && !!b;
    bar.style.display = on ? '' : 'none';
    document.documentElement.classList.toggle('gt-has-hotbar', on);
    if (!on) { closePop(); return; }
    var names = (c.state.cfg && c.state.cfg.econ && c.state.cfg.econ.items) || {};
    SLOTS.forEach(function (id, i) {
      var el = bar.children[i], it = b[id] || { settled: 0, today: 0 }, n = it.settled + it.today;
      el.querySelector('.gt-slot-n').textContent = String(n);
      el.classList.toggle('empty', n <= 0);
      el.classList.toggle('today', it.today !== 0);
      el.classList.toggle('sel', i === selected);
      var nm = (names[id] && names[id].name) || id;
      el.setAttribute('aria-label', nm + ': ' + n + (it.today ? ' (' + (it.today > 0 ? '+' : '') + it.today + ' hari ini)' : ''));
      el.title = nm;
    });
    if (pop && selected >= 0) fillPop();
  }

  function openBag() { var c = chain(); if (c) c.open('bag'); }
  function useSlot(i) {
    var c = chain(), b = bag(), id = SLOTS[i];
    if (!c || !b) return;
    var econ = (c.state.cfg && c.state.cfg.econ && c.state.cfg.econ.items[id]) || {}, it = b[id] || { settled: 0, today: 0 };
    if (econ.energy && it.settled + it.today > 0) { closePop(); c.act({ action: 'eat', token: id }).catch(function () {}); return; }
    toggle(i); // nothing to use directly: show what can be done with it
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
    if (n && bar && bar.style.display !== 'none') { toggle(+n[1] - 1); return true; }
    if (e.code === 'Escape' && pop) { closePop(); return true; }
    return false;
  }

  function init() {
    build();
    // the round E button on phones opens the bag (the NPC message lives in Lainnya and on T)
    var pad = document.getElementById('pad'), be = document.getElementById('btnE');
    if (be) be.setAttribute('aria-label', 'Tombol E, buka tas');
    if (pad && be) pad.addEventListener('pointerdown', function (e) {
      if (e.target !== be && !be.contains(e.target)) return;
      e.preventDefault(); e.stopPropagation();
      if (!GT.isUiOpen()) openBag();
    }, true);
    document.addEventListener('click', function (e) { if (pop && !(bar && bar.contains(e.target))) closePop(); });
    setInterval(render, 500);
    render();
  }

  GT.register({ id: 'hotbar', init: init, onKey: onKey });
})();
