/* sim.js - "Simulasi 1 minggu": fast-forward view of the economy (M3). Uses only window.GT and the server's /api/sim.
 * The server runs the SAME game code (economy/pricing.ts, merchants, town demand, settlement) on a mock chain with
 * simulated players; this panel plays the hourly frames back over ~60 s with charts. Off-chain, and labelled as such.
 * Charts: prices as small multiples (one line each, dashed base price), merchant cash (4 series, legend + direct labels,
 * closed periods shaded), money supply vs. its cap. Hover shows exact values; a table gives the final numbers.
 */
(function () {
  'use strict';
  var NAMES = { fish: $t('Ikan'), ore: $t('Bijih'), wood: $t('Kayu'), wheat: $t('Gandum'), bread: $t('Roti'), meal: $t('Ikan Bakar'), tool: $t('Beliung') };
  // series colours are theme tokens (resolved at draw time, so they follow the season); the swatch class in mods.css uses the same token
  var MER = [{ id: 'sari', name: $t('Sari'), c: 'link' }, { id: 'budi', name: $t('Budi'), c: 'warn-ink' }, { id: 'wati', name: $t('Wati'), c: 'good' }, { id: 'joko', name: $t('Joko'), c: 'paper-dim' }];
  function T(n) { return window.GT_THEME ? GT_THEME.get(n) : ''; }
  var FONT = '12px "Pixelify Sans", sans-serif';
  var st = { res: null, upto: 0, playing: false, speed: 1, timer: 0, modal: null, players: 25, hover: {} };

  function $(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function btn(label, fn, cls) { var b = $('button', 'mbtn' + (cls ? ' ' + cls : ''), label); b.type = 'button'; b.addEventListener('click', fn); return b; }

  /* ------------------------------------------------------------ chart primitive */
  function setup(cv, w, h) {
    var r = window.devicePixelRatio || 1;
    cv.width = Math.round(w * r); cv.height = Math.round(h * r); cv.style.width = w + 'px'; cv.style.height = h + 'px';
    var g = cv.getContext('2d'); g.setTransform(r, 0, 0, r, 0, 0); return g;
  }
  // series: [{name,color,values:number[]}]; opts: {w,h,yMin,yMax,ref:{y,label},shade:[{from,to}],labels:bool,unit}
  function lineChart(cv, series, opts) {
    var W = opts.w, H = opts.h, g = setup(cv, W, H);
    var L = 34, Rr = opts.labels ? 52 : 8, Tp = 8, B = 16, pw = W - L - Rr, ph = H - Tp - B;
    var n = st.res.frames.length, upto = Math.max(1, st.upto);
    var ymin = opts.yMin, ymax = opts.yMax;
    function X(i) { return L + (i / Math.max(1, n - 1)) * pw; }
    function Y(v) { return Tp + ph - ((v - ymin) / Math.max(1e-9, ymax - ymin)) * ph; }
    g.fillStyle = T('paper-2'); g.fillRect(0, 0, W, H);
    // shaded periods (shop closed)
    (opts.shade || []).forEach(function (s) { if (s.from >= upto) return; g.globalAlpha = 0.16; g.fillStyle = T('bad'); g.fillRect(X(s.from), Tp, X(Math.min(s.to, upto - 1)) - X(s.from) + 1, ph); g.globalAlpha = 1; });
    // recessive grid: 3 horizontal lines, day ticks
    g.font = FONT; g.textBaseline = 'middle';
    for (var k = 0; k <= 2; k++) {
      var v = ymin + (ymax - ymin) * k / 2, y = Y(v);
      g.fillStyle = T('paper-3'); g.fillRect(L, Math.round(y), pw, 1);
      g.fillStyle = T('paper-dim'); g.textAlign = 'right'; g.fillText(fmt(v), L - 4, y);
    }
    g.textAlign = 'center'; g.textBaseline = 'top';
    var days = Math.ceil(n / 24);
    for (var d = 0; d <= days; d++) { var xi = Math.min(n - 1, d * 24); g.fillStyle = T('paper-dim'); if (days <= 10 || d % 5 === 0) g.fillText('h' + d, X(xi), Tp + ph + 3); }
    if (opts.ref) { g.strokeStyle = T('paper-dim'); g.setLineDash([3, 3]); g.lineWidth = 1; g.beginPath(); g.moveTo(L, Y(opts.ref.y)); g.lineTo(L + pw, Y(opts.ref.y)); g.stroke(); g.setLineDash([]);
      if (opts.ref.label) { g.fillStyle = T('paper-dim'); g.textAlign = 'left'; g.textBaseline = 'bottom'; g.fillText(opts.ref.label, L + 3, Y(opts.ref.y) - 1); } }
    // lines: 2px, round joins
    series.forEach(function (s) {
      g.strokeStyle = T(s.color); g.lineWidth = 2; g.lineJoin = 'round'; g.lineCap = 'round'; g.beginPath();
      for (var i = 0; i < upto; i++) { var vv = s.values[i]; if (vv == null) continue; if (i === 0) g.moveTo(X(i), Y(vv)); else g.lineTo(X(i), Y(vv)); }
      g.stroke();
    });
    // direct labels at the current end (text in ink; a colored dot carries identity)
    if (opts.labels) {
      var ends = series.map(function (s) { return { s: s, y: Y(s.values[upto - 1]) }; }).sort(function (a, b) { return a.y - b.y; });
      for (var j = 1; j < ends.length; j++) if (ends[j].y - ends[j - 1].y < 11) ends[j].y = ends[j - 1].y + 11;
      ends.forEach(function (e) {
        var x = X(upto - 1);
        g.fillStyle = T(e.s.color); g.beginPath(); g.arc(x, Y(e.s.values[upto - 1]), 3, 0, 7); g.fill();
        g.strokeStyle = T('paper-2'); g.lineWidth = 2; g.stroke();
        g.fillStyle = T('paper-ink'); g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText(e.s.name, L + pw + 6, e.y);
      });
    }
    cv._geom = { L: L, pw: pw, n: n, X: X, Y: Y, series: series, unit: opts.unit || '' };
  }
  function fmt(v) { return Math.abs(v) >= 1000 ? (Math.round(v / 100) / 10) + 'k' : (Math.round(v * 10) / 10).toString(); }

  // hover: crosshair + tooltip with every series at that hour
  function attachHover(cv, wrap) {
    var tip = $('div', 'sim-tip'); wrap.appendChild(tip);
    cv.addEventListener('pointermove', function (ev) {
      var g = cv._geom; if (!g) return;
      var rect = cv.getBoundingClientRect(), x = ev.clientX - rect.left;
      var i = Math.round(((x - g.L) / g.pw) * (g.n - 1)); i = Math.max(0, Math.min(Math.min(g.n, st.upto) - 1, i));
      var f = st.res.frames[i];
      tip.textContent = '';
      tip.appendChild($('div', 'sim-tip-h', $t('Hari {0}, {1}:00 · {2}', [f.day, ('0' + f.hourOfDay).slice(-2), f.season])));
      g.series.forEach(function (s) {
        var r = $('div'); r.appendChild($('i', 'sw-' + s.color));
        r.appendChild(document.createTextNode(s.name + ': ' + fmt(s.values[i]) + g.unit)); tip.appendChild(r);
      });
      tip.style.left = Math.min(rect.width - 150, Math.max(0, x + 10)) + 'px'; tip.style.top = '4px'; tip.classList.add('on');
      cv._cross = i; drawCross(cv);
    });
    cv.addEventListener('pointerleave', function () { tip.classList.remove('on'); cv._cross = null; render(); });
  }
  function drawCross(cv) {
    var g = cv._geom, ctx = cv.getContext('2d'); if (cv._cross == null || !g) return;
    var x = Math.round(g.X(cv._cross)) + 0.5;
    ctx.strokeStyle = T('paper-dim'); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, 8); ctx.lineTo(x, cv.clientHeight - 16); ctx.stroke();
    g.series.forEach(function (s) { var v = s.values[cv._cross]; if (v == null) return; ctx.fillStyle = T(s.color); ctx.beginPath(); ctx.arc(x, g.Y(v), 4, 0, 7); ctx.fill(); ctx.strokeStyle = T('paper-2'); ctx.lineWidth = 2; ctx.stroke(); });
  }

  /* ------------------------------------------------------------ panel */
  var els = {};
  function build() {
    var root = $('div', 'sim-panel');
    root.appendChild($('p', 'sim-label', $t('Memuat simulasi…')));
    els.label = root.lastChild;
    var ctrl = $('div', 'sim-ctrl');
    els.play = btn($t('Jeda'), function () { st.playing = !st.playing; els.play.textContent = st.playing ? $t('Jeda') : $t('Putar'); if (st.playing) tick(); }, 'primary');
    els.speed = btn($t('Kecepatan 1×'), function () { st.speed = st.speed === 1 ? 4 : 1; els.speed.textContent = $t('Kecepatan {0}×', [st.speed]); });
    var end = btn($t('Lompat ke akhir'), function () { st.upto = st.res ? st.res.frames.length : 0; render(); });
    var pl = $('label', 'sim-players'); pl.appendChild(document.createTextNode($t('Pemain ')));
    var sel = $('select'); [10, 25, 40, 60].forEach(function (n) { var o = $('option', null, String(n)); o.value = n; if (n === st.players) o.selected = true; sel.appendChild(o); });
    sel.addEventListener('change', function () { st.players = +sel.value; load(); }); pl.appendChild(sel);
    ctrl.appendChild(els.play); ctrl.appendChild(els.speed); ctrl.appendChild(end); ctrl.appendChild(pl);
    els.clock = $('span', 'sim-clock', ''); ctrl.appendChild(els.clock);
    root.appendChild(ctrl);

    root.appendChild($('h3', null, $t('Harga rata-rata per barang (garis putus = harga dasar)')));
    els.minis = $('div', 'sim-minis'); root.appendChild(els.minis);
    root.appendChild($('h3', null, $t('Kas pedagang (area merah = toko TUTUP)')));
    var cw = $('div', 'sim-chart'); els.cash = $('canvas'); cw.appendChild(els.cash); root.appendChild(cw); attachHover(els.cash, cw);
    var legend = $('div', 'sim-legend');
    MER.forEach(function (m) { var s = $('span'); s.appendChild($('i', 'sw-' + m.c)); s.appendChild(document.createTextNode(m.name)); legend.appendChild(s); });
    root.appendChild(legend);
    root.appendChild($('h3', null, $t('Jumlah uang beredar (garis putus = batas)')));
    var mw = $('div', 'sim-chart'); els.money = $('canvas'); mw.appendChild(els.money); root.appendChild(mw); attachHover(els.money, mw);
    root.appendChild($('h3', null, $t('Kejadian')));
    els.events = $('div', 'sim-events'); root.appendChild(els.events);
    var det = $('details'); det.appendChild($('summary', null, $t('Tabel (akhir simulasi)'))); els.table = $('div'); det.appendChild(els.table); root.appendChild(det);
    return root;
  }

  function width() { var b = st.modal && st.modal.body; return Math.max(280, Math.min(900, (b ? b.clientWidth : 600) - 24)); }

  function render() {
    var r = st.res; if (!r || !st.modal || !st.modal.isOpen()) return;
    var F = r.frames, upto = Math.max(1, Math.min(st.upto, F.length)), W = width();
    var last = F[upto - 1];
    els.clock.textContent = $t('Hari {0} · {1}:00 · {2}', [last.day, ('0' + last.hourOfDay).slice(-2), last.season]);
    // price small multiples
    if (!els.minis.children.length) Object.keys(NAMES).forEach(function (t) {
      var box = $('div', 'sim-mini'); box.appendChild($('div', 'sim-mini-t', NAMES[t])); var c = $('canvas'); box.appendChild(c); els.minis.appendChild(box); attachHover(c, box); box._t = t; box._c = c;
    });
    var mw = Math.floor((W - 8 * 3) / (W < 520 ? 2 : 4));
    [].forEach.call(els.minis.children, function (box) {
      var t = box._t, vals = F.map(function (f) { return f.prices[t]; }), base = r.summary.priceRange[t].base;
      var lo = Math.min(base, r.summary.priceRange[t].min), hi = Math.max(base, r.summary.priceRange[t].max);
      lineChart(box._c, [{ name: NAMES[t], color: 'link', values: vals }], { w: mw, h: 92, yMin: Math.floor(lo * 0.9), yMax: Math.ceil(hi * 1.05), ref: { y: base }, unit: $t(' koin') });
    });
    // merchant cash with closed periods shaded (per merchant, merged)
    var shade = [];
    MER.forEach(function (m) { var from = -1; F.forEach(function (f, i) { var c = !f.merchants[m.id].open; if (c && from < 0) from = i; if ((!c || i === F.length - 1) && from >= 0) { shade.push({ from: from, to: i }); from = -1; } }); });
    var cashS = MER.map(function (m) { return { name: m.name, color: m.c, values: F.map(function (f) { return f.merchants[m.id].cash; }) }; });
    var cmax = Math.max.apply(null, cashS.map(function (s) { return Math.max.apply(null, s.values); }));
    lineChart(els.cash, cashS, { w: W, h: 190, yMin: 0, yMax: Math.ceil(cmax * 1.05), labels: true, shade: shade, unit: $t(' koin') });
    var cap = r.summary.moneyCap, mmax = Math.max(r.summary.moneyMax, cap * 0.3);
    lineChart(els.money, [{ name: $t('Uang beredar'), color: 'link', values: F.map(function (f) { return f.moneySupply; }) }], { w: W, h: 130, yMin: 0, yMax: Math.ceil(Math.min(cap * 1.05, mmax * 1.15)), ref: cap <= mmax * 1.15 ? { y: cap, label: $t('batas {0}', [fmt(cap)]) } : null, unit: $t(' koin') });
    // events so far
    els.events.textContent = '';
    var ev = r.events.filter(function (e) { return e.kind !== 'settled' && e.hour < upto; });
    if (!ev.length) els.events.appendChild($('p', 'chain-dim', $t('Belum ada toko yang bangkrut.')));
    ev.forEach(function (e) { els.events.appendChild($('div', 'sim-ev ' + e.kind, $t('Hari {0}: {1}', [e.day, e.text]))); });
    // table
    var tb = $t('<table class="sim-table"><tr><th>Pedagang</th><th>Kas akhir</th><th>Status</th></tr>');
    MER.forEach(function (m) { var x = last.merchants[m.id]; tb += '<tr><td>' + m.name + '</td><td>' + x.cash + '</td><td>' + (x.open ? $t('buka') : $t('TUTUP')) + '</td></tr>'; });
    tb += $t('</table><table class="sim-table"><tr><th>Barang</th><th>Harga akhir</th><th>Min</th><th>Maks</th><th>Dasar</th></tr>');
    Object.keys(NAMES).forEach(function (t) { var pr = r.summary.priceRange[t]; tb += '<tr><td>' + NAMES[t] + '</td><td>' + last.prices[t] + '</td><td>' + pr.min + '</td><td>' + pr.max + '</td><td>' + pr.base + '</td></tr>'; });
    els.table.innerHTML = $t('{0}</table><p class="chain-dim">Uang beredar akhir {1} (batas {2}).</p>', [tb, last.moneySupply, cap]);
  }

  function tick() {
    clearTimeout(st.timer);
    if (!st.playing || !st.res || !st.modal || !st.modal.isOpen()) return;
    var n = st.res.frames.length;
    st.upto = Math.min(n, st.upto + st.speed);
    render();
    if (st.upto >= n) { st.playing = false; els.play.textContent = $t('Putar ulang'); els.play.onclick = null; return; }
    st.timer = setTimeout(tick, Math.max(40, Math.round(60000 / n)));
  }

  function load() {
    st.res = null; st.upto = 0; els.minis && (els.minis.textContent = '');
    els.label.textContent = $t('Menjalankan simulasi {0} pemain selama 7 hari…', [st.players]);
    fetch((window.GT_API || '') + '/api/sim', { method: 'POST', headers: window.GT_LANG === 'id' ? { 'content-type': 'application/json', 'x-gt-lang': 'id' } : { 'content-type': 'application/json' }, body: JSON.stringify({ days: 7, players: st.players, seed: 42 }) })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (res) {
        st.res = res; st.upto = 1; st.playing = true; els.play.textContent = $t('Jeda');
        els.label.textContent = $t('{0} · {1} pemain simulasi · 7 hari dalam ~60 detik.', [res.label, st.players]);
        render(); tick();
      })
      .catch(function (e) { els.label.textContent = $t('Simulasi butuh server (npm run dev atau dev:mock). {0}', [e.message]); });
  }

  function open() {
    if (st.modal && st.modal.isOpen()) return;
    st.modal = GT.modal({ title: $t('Simulasi 1 minggu'), wide: true, body: build(), onClose: function () { st.playing = false; clearTimeout(st.timer); } });
    if (st.modal.box) st.modal.box.classList.add('sim-box');
    els.play.onclick = function () {
      if (st.res && st.upto >= st.res.frames.length) { st.upto = 1; }
      st.playing = !st.playing || st.upto <= 1; els.play.textContent = st.playing ? $t('Jeda') : $t('Putar'); if (st.playing) tick();
    };
    load();
  }

  window.GT_SIM = { open: open, _state: st };
  GT.register({
    id: 'sim',
    init: function () {
      GT.addHudButton({ id: 'simbtn', label: $t('Simulasi'), onClick: open, secondary: false });
      GT.addDevSection($t('Simulasi ekonomi'), function (sec) { sec.appendChild(btn($t('Simulasi 1 minggu'), open, 'primary')); });
    }
  });
})();
