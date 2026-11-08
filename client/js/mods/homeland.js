/* homeland.js - every player's Homeland on the client (docs/superpowers/specs/2026-11-08-homeland-design.md).
 * Talks to the engine only through window.GT, and to the server through GT_CHAIN (signed requests).
 *
 *   Balai Kota   door of the Town Hall: level, builder countdown, upgrade, open a neighbouring chunk, invite friends
 *   Lahan        door of an empty lot: build a Kolam Ikan / Tambang / Restoran; a built lot: collect what it made
 *   Portal       face the portal (or press B within 2 tiles): Area Publik, Rumahku, Dunia <owner>
 *   Tukang       the builder NPC: hammers next to the job target while a job runs, idles by the Town Hall otherwise
 *   GT_HOME      { enter, travel, state } - enter() is called by the character screen when "Mulai" ends
 *
 * Server API used: GET /api/homeland, GET /api/homeland/layout?world=HL-n, POST /api/homeland/invite,
 * POST /api/act {action: build | collect | travel}. All user-provided text (names) is set with textContent / value.
 */
(function () {
  'use strict';
  var C = null;                          // GT_CHAIN
  var H = null;                          // last GET /api/homeland: the view plus `invited`
  var layoutSig = '';                    // signature of the generator inputs the current map was built from
  var loading = null, lastLoad = 0, pollT = 0, jobPing = 0;
  var travelling = false, hintShown = false, nearHint = false, hintT = 0;
  var win = null;                        // the open window: { kind: 'hall' | 'lot', arg, h, busy }
  var lastClose = 0, clockT = 0;
  var pops = [];                         // floating "+n" after a collect: { x, y, text, t }
  var builder = null, builderSig = '';
  var NEIGH = {
    nw: ['n', 'w'], n: ['nw', 'c', 'ne'], ne: ['n', 'e'], w: ['nw', 'c', 'sw'], c: ['n', 'w', 'e', 's'],
    e: ['ne', 'c', 'se'], sw: ['w', 's'], s: ['sw', 'c', 'se'], se: ['s', 'e']
  };
  var HOME_KINDS = { townhall: 1, kolam: 1, tambang: 1, restoran: 1 };
  var KIND_NAME = { kolam: 'Kolam Ikan', tambang: 'Tambang', restoran: 'Restoran' };

  function $(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function btn(label, onClick, cls, disabled) {
    var b = $('button', 'mbtn' + (cls ? ' ' + cls : ''), label); b.type = 'button'; b.disabled = !!disabled;
    b.addEventListener('click', function (e) { e.currentTarget.blur(); onClick(e); });
    return b;
  }
  function S() { return C && C.state; }
  function wid() { return (GT.worldId && GT.worldId()) || 'public'; }
  function isHL(w) { return /^HL-\d+$/.test(w); }
  function inOwnHome() { return !!(H && wid() === H.world); }
  function itemName(t) {
    if (t === 'coin') return 'Koin';
    var c = S() && S().cfg && S().cfg.econ && S().cfg.econ.items[t];
    return c ? c.name : t;
  }
  function have(t) { var b = S() && S().st && S().st.bag && S().st.bag[t]; return b ? b.settled + b.today : 0; }
  function costLine(cost) { return Object.keys(cost || {}).map(function (t) { return cost[t] + ' ' + itemName(t); }).join(' + ') || 'gratis'; }
  function shortOf(cost) { return Object.keys(cost || {}).filter(function (t) { return have(t) < cost[t]; }); }
  function secsLine(s) { s = Math.round(s || 0); return s >= 60 ? Math.floor(s / 60) + ' mnt' + (s % 60 ? ' ' + (s % 60) + ' dtk' : '') : s + ' dtk'; }
  function clock(ms) { var s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60); }
  function endMs(j) { var v = j.ends_at; if (typeof v === 'string') return Date.parse(v); return v < 1e11 ? v * 1000 : v; }
  function loggedIn() {
    if (!C || !S() || S().mode === 'offline') { GT.toast('Homeland butuh server game.'); return false; }
    if (!S().account) { GT.toast('Masuk dulu (tombol Masuk).'); return false; }
    return true;
  }
  function layoutOf() { return GT.world && GT.world.layout; }
  function lotById(id) { var L = layoutOf(), r = null; if (L && L.lots) L.lots.forEach(function (l) { if (l.id === id) r = l; }); return r; }
  function builtOf(lot) { var r = null; if (H) H.built.forEach(function (b) { if (b.lot === lot) r = b; }); return r; }
  function chunkName(id) {
    var r = id, L = layoutOf();
    if (L && L.chunks) L.chunks.forEach(function (c) { if (c.id === id) r = c.name; });
    return r;
  }

  /* ------------------------------------------------------------ data */
  function signature(h) {
    return [h.world, h.seed, h.th, (h.open || []).slice().sort().join('.'), (h.built || []).map(function (b) { return b.lot + ':' + b.kind; }).sort().join('.')].join('|');
  }
  function load(force) {
    if (!C || !S() || !S().account || S().mode === 'offline') return Promise.resolve(H);
    if (loading) return loading;
    if (!force && Date.now() - lastLoad < 1500) return Promise.resolve(H);
    loading = C.api('/homeland').then(function (r) {
      H = r; lastLoad = Date.now();
      if (inOwnHome() && signature(H) !== layoutSig) rebuild();
      builderSig = ''; placeBuilder();
    }, function () { /* keep the old numbers */ })
      .then(function () { loading = null; redrawWin(); return H; });
    return loading;
  }
  function afterChange() { return load(true).then(function () { return C.refresh(true); }); }

  /* The map for the generator inputs of the view. Keeps the player where they stand. */
  function layoutFor(r) {
    return GTHomeland.generate(r.seed, { open: r.open || [], th: r.th, built: (r.built || []).map(function (b) { return { kind: b.kind, lot: b.lot }; }) });
  }
  function rebuild() {
    if (!H || !window.GTHomeland) return false;
    var p = GT.player, keep = GT.scene && GT.scene.kind === 'out' ? { x: p.x, y: p.y, dir: p.dir } : null;
    var ok = false;
    try { ok = GT.switchWorld(H.world, layoutFor(H)); } catch (e) { console.error(e); }
    if (!ok) return false;
    layoutSig = signature(H);
    if (keep) GT.teleportPlayer('out', keep.x, keep.y, keep.dir);
    return true;
  }

  /* ------------------------------------------------------------ entering and travelling */
  function enter() {
    if (!C) C = window.GT_CHAIN || null;
    if (!C || !S() || !S().account || S().mode === 'offline') return Promise.resolve(false);
    return C.api('/homeland').then(function (r) {
      H = r; lastLoad = Date.now();
      return C.api('/homeland/layout?world=' + encodeURIComponent(r.world));
    }).then(function (lr) {
      var L = layoutFor(lr), ok = false;
      try { ok = GT.switchWorld(lr.world, L); } catch (e) { console.error(e); }
      if (!ok) throw new Error('Peta Homeland gagal dibuat.');
      layoutSig = signature(H);
      GT.teleportPlayer('out', L.spawn.x, L.spawn.y, 'down');
      builderSig = ''; placeBuilder();
      if (window.GT_PLAYERS && GT_PLAYERS.refresh) GT_PLAYERS.refresh();
      return C.refresh(true).then(function () { return true; });
    }).catch(function (e) { GT.toast((e && e.message) || 'Gagal masuk Homeland.'); return false; });
  }
  function portalPos() { var w = GT.world; return w && w.portal || null; }
  function nearPortal() {
    var d = portalPos(), p = GT.player;
    return !!(d && GT.scene && GT.scene.kind === 'out' && Math.abs(p.x - d.x) + Math.abs(p.y - d.y) <= 2);
  }
  function openPortal() {
    if (travelling || !loggedIn()) return;
    if (!nearPortal()) { GT.toast('Pergi ke portal dulu.'); return; }
    load(true).then(function () {
      var cur = wid(), opts = [];
      if (cur !== 'public') opts.push({ label: 'Area Publik (pasar)', onPick: function () { travel('public'); } });
      if (H && cur !== H.world) opts.push({ label: 'Rumahku', onPick: function () { travel(H.world); } });
      ((H && H.invited) || []).forEach(function (v) {
        if (cur === v.world) return;
        opts.push({ label: 'Dunia ' + (v.owner_name || v.world), onPick: function () { travel(v.world); } });
      });
      GT.menu('Portal · mau ke mana?', opts);
    });
  }
  function travel(to) {
    if (travelling) return;
    travelling = true;
    var from = wid(), layoutP;
    if (to === 'public') layoutP = Promise.resolve(null);
    else layoutP = C.api('/homeland/layout?world=' + encodeURIComponent(to)).then(function (r) { return layoutFor(r); });
    layoutP.then(function (L) {
      GT.toast('Melangkah ke portal…');
      return C.act({ action: 'travel', to: to, world: from }, true).catch(function (e) { e.shown = true; throw e; }).then(function (r) {
        var ok = false;
        try { ok = GT.switchWorld(r.world, L); } catch (err) { ok = false; }
        if (!ok) {
          // The server already moved us, so both sides disagree. A fresh page lands on the own Homeland spawn, which the
          // server always accepts (Positions.report), so reloading puts them in step again.
          GT.toast('Peta gagal dibuat. Memuat ulang agar posisimu kembali sama dengan server…');
          setTimeout(function () { location.reload(); }, 1800);
          var e = new Error('Perjalanan gagal.'); e.shown = true; throw e;
        }
        if (H && r.world === H.world && L) layoutSig = signature(H);
        GT.teleportPlayer('out', r.arrive.x, r.arrive.y, 'down');
        nearHint = true; if (r.toast) GT.toast(r.toast);
        builderSig = ''; placeBuilder();
        if (window.GT_PLAYERS && GT_PLAYERS.refresh) GT_PLAYERS.refresh();
        return C.refresh(true);
      });
    }).catch(function (e) { if (!(e && e.shown)) GT.toast((e && e.message) || 'Gagal bepergian.'); }).then(function () { travelling = false; });
  }

  /* ------------------------------------------------------------ windows */
  function openWin(kind, title, arg) {
    if (win && win.h && win.h.isOpen()) win.h.close('switch');
    win = { kind: kind, arg: arg, h: null, busy: false };
    win.h = GT.modal({ title: title, wide: true, body: bodyFor(win), onClose: function () { win = null; lastClose = Date.now(); } });
    load(true);
  }
  function bodyFor(w) { return w.kind === 'hall' ? hallBody() : lotBody(w.arg); }
  function redrawWin() {
    if (!win || !win.h || !win.h.isOpen()) return;
    var ae = document.activeElement; // do not wipe a name being typed into the invite field
    if (ae && ae.tagName === 'INPUT' && win.h.el && win.h.el.contains(ae)) return;
    win.h.setBody(bodyFor(win));
  }
  function busyJob() { return H && H.builders && H.builders.busy >= H.builders.total; }

  function run(body, after) {
    if (!loggedIn() || (win && win.busy)) return;
    if (win) win.busy = true; redrawWin();
    var done = function () { if (win) win.busy = false; redrawWin(); };
    C.act(body).then(function (r) { return Promise.resolve(after && after(r)).then(function () { return afterChange(); }); }, function () { /* act() already toasted the reason */ })
      .then(done, done);
  }

  function stepBlock(title, desc, step, canDo, why, label, onClick) {
    var box = $('div', 'gt-detail'), txt = $('div', 'grow');
    txt.appendChild($('div', 'gt-detail-name', title));
    if (desc) txt.appendChild($('div', null, desc));
    if (step) {
      var short = shortOf(step.cost);
      txt.appendChild($('div', 'chain-dim', 'Biaya: ' + costLine(step.cost) + ' · waktu ' + secsLine(step.secs) + (short.length ? ' · kurang ' + short.map(itemName).join(', ') : '')));
    }
    if (why) txt.appendChild($('div', 'chain-dim', why));
    box.appendChild(txt);
    if (label) {
      var acts = $('div', 'gt-detail-acts');
      acts.appendChild(btn(label, onClick, 'primary', !canDo || !!(win && win.busy)));
      box.appendChild(acts);
    }
    return box;
  }

  function jobLine(j) {
    var left = endMs(j) - Date.now();
    var what = j.kind === 'th' ? 'Balai Kota naik level' : j.kind === 'chunk' ? 'Membuka wilayah ' + chunkName(j.target) : 'Membangun ' + ((lotById(j.target) && KIND_NAME[lotById(j.target).kind]) || j.target);
    return what + ' · sisa ' + clock(left);
  }

  /* ---- Balai Kota ---- */
  function hallBody() {
    var wrap = $('div', 'gt-isl');
    if (!H) { wrap.appendChild($('p', null, 'Memuat…')); return wrap; }
    var owner = inOwnHome();
    var head = $('div', 'gt-shop-head');
    head.appendChild($('span', null, 'Balai Kota · level ' + H.th));
    head.appendChild($('span', 'chain-dim', 'Wilayah terbuka: ' + (H.open.length + 1) + ' dari 9'));
    wrap.appendChild(head);
    if (!owner) { wrap.appendChild($('p', null, 'Ini Balai Kota milik pemilik dunia ini. Hanya pemiliknya yang bisa membangun.')); return wrap; }

    var bs = $('div', 'gt-detail'), bt = $('div', 'grow');
    bt.appendChild($('div', 'gt-detail-name', 'Pembangun · ' + H.builders.busy + ' dari ' + H.builders.total + ' sibuk'));
    if (H.jobs.length) H.jobs.forEach(function (j) { bt.appendChild($('div', null, jobLine(j))); });
    else bt.appendChild($('div', 'chain-dim', 'Pembangun menganggur. Beri dia pekerjaan.'));
    bs.appendChild(bt); wrap.appendChild(bs);

    var busy = busyJob(), why = busy ? 'Pembangun sedang bekerja.' : null;
    var th = H.next && H.next.th;
    if (!th) wrap.appendChild(stepBlock('Naikkan Balai Kota', 'Sudah di level tertinggi.', null, false, null, null));
    else {
      var short = shortOf(th.cost), can = !busy && !short.length;
      wrap.appendChild(stepBlock('Naikkan ke level ' + th.level, 'Level lebih tinggi membuka bangunan baru, petak kebun, dan wilayah.', th, can, why, 'Naikkan ke level ' + th.level, function () { run({ action: 'build', kind: 'th', target: 'th' }); }));
    }

    // neighbouring locked chunks
    var ch = H.next && H.next.chunk, mine = { c: 1 };
    H.open.forEach(function (c) { mine[c] = 1; });
    var adj = [];
    Object.keys(NEIGH).forEach(function (id) {
      if (mine[id]) return;
      if (NEIGH[id].some(function (n) { return mine[n]; })) adj.push(id);
    });
    var ob = $('div', 'gt-detail'), ot = $('div', 'grow');
    ot.appendChild($('div', 'gt-detail-name', 'Buka wilayah'));
    if (!ch) ot.appendChild($('div', 'chain-dim', adj.length ? 'Semua wilayah yang bisa dibuka sudah terbuka.' : 'Semua wilayah sudah terbuka.'));
    else {
      var sh2 = shortOf(ch.cost);
      ot.appendChild($('div', 'chain-dim', 'Wilayah ke-' + ch.n + ': ' + costLine(ch.cost) + ' · waktu ' + secsLine(ch.secs) + (H.th < ch.th ? ' · perlu Balai Kota level ' + ch.th : '') + (sh2.length ? ' · kurang ' + sh2.map(itemName).join(', ') : '')));
    }
    ob.appendChild(ot);
    if (ch) {
      var okChunk = !busy && H.th >= ch.th && !shortOf(ch.cost).length;
      var acts = $('div', 'gt-detail-acts');
      adj.forEach(function (id) { acts.appendChild(btn('Buka ' + chunkName(id), function () { run({ action: 'build', kind: 'chunk', target: id }); }, 'primary', !okChunk || !!(win && win.busy))); });
      ob.appendChild(acts);
    }
    wrap.appendChild(ob);

    // invites
    var iv = $('div', 'gt-detail');
    iv.appendChild($('div', 'gt-detail-name', 'Undang teman'));
    iv.appendChild($('div', 'chain-dim', 'Hanya kamu dan tamu undangan yang boleh datang lewat portal. Tulis nama pemain (seperti di permainan), pisahkan dengan koma. Tamu melihat duniamu di menu portal.'));
    var input = $('input'); input.type = 'text'; input.maxLength = 400; input.placeholder = 'Ayu, Budi'; var known = {};
    (H.guests || []).forEach(function (g) { var nm = typeof g === 'string' ? g : g.name; known[nm] = typeof g === 'string' ? g : g.account; });
    input.value = Object.keys(known).join(', ');
    input.style.width = '100%'; input.autocomplete = 'off';
    iv.appendChild(input);
    var iAct = $('div', 'gt-detail-acts');
    iAct.appendChild(btn('Simpan undangan', function () {
      var list = String(input.value || '').split(/[,;]+/).map(function (x) { return x.trim(); }).filter(Boolean)
        .map(function (x) { return Object.prototype.hasOwnProperty.call(known, x) ? known[x] : x; });
      C.api('/homeland/invite', { method: 'POST', body: { accounts: list } })
        .then(function (r) {
          var names = (r.invite || []).map(function (g) { if (typeof g === 'string') return g; known[g.name] = g.account; return g.name; });
          input.value = names.join(', '); GT.toast('Undangan tersimpan (' + names.length + ' tamu).'); return load(true);
        }, function (e) { GT.toast('Gagal: ' + e.message); });
    }));
    iv.appendChild(iAct);
    wrap.appendChild(iv);
    return wrap;
  }

  /* ---- a lot: build or collect ---- */
  function lotBody(lotId) {
    var wrap = $('div', 'gt-isl'), lot = lotById(lotId);
    if (!H || !lot) { wrap.appendChild($('p', null, H ? 'Lahan ini tidak ada.' : 'Memuat…')); return wrap; }
    var owner = inOwnHome(), b = builtOf(lotId), name = KIND_NAME[lot.kind] || lot.kind;
    var def = H.next && H.next.buildings && H.next.buildings[lot.kind];
    var head = $('div', 'gt-shop-head');
    head.appendChild($('span', null, name + ' · ' + chunkName(lot.chunk)));
    wrap.appendChild(head);
    if (!owner) { wrap.appendChild($('p', null, b ? 'Bangunan milik pemilik dunia ini.' : 'Lahan kosong milik pemilik dunia ini.')); return wrap; }
    var job = null;
    H.jobs.forEach(function (j) { if (j.kind === 'build' && j.target === lotId) job = j; });
    if (b) {
      var box = $('div', 'gt-detail'), txt = $('div', 'grow'), prod = def && def.produces ? itemName(def.produces) : 'hasil';
      txt.appendChild($('div', 'gt-detail-name', name + ' · menghasilkan ' + prod));
      txt.appendChild($('div', null, 'Tersimpan ' + b.stored + ' dari ' + b.capacity + '. Kalau penuh, hasil berhenti bertambah.'));
      box.appendChild(txt);
      var acts = $('div', 'gt-detail-acts');
      acts.appendChild(btn('Ambil hasil (' + b.stored + ')', function () { collect(lotId); }, 'primary', b.stored <= 0 || !!win.busy));
      box.appendChild(acts);
      wrap.appendChild(box);
      return wrap;
    }
    if (job) { wrap.appendChild($('p', null, jobLine(job))); return wrap; }
    if (!def) { wrap.appendChild($('p', null, 'Memuat…')); return wrap; }
    // `can`/`why` in the view describe the first lot of this kind; for another lot the server decides when we press the button.
    var sameLot = def.lot === lotId, short = shortOf(def.cost), why = sameLot ? def.why : null;
    if (!why && busyJob()) why = 'Pembangun sedang bekerja.';
    if (!why && short.length) why = 'Kurang ' + short.map(itemName).join(', ') + '.';
    var can = !why && (!sameLot || def.can);
    wrap.appendChild(stepBlock('Bangun ' + (def.name || name), 'Menghasilkan ' + itemName(def.produces) + ' terus-menerus, simpan sampai ' + def.capacity + '. Perlu Balai Kota level ' + def.th + '.',
      def, can, why, 'Bangun · ' + secsLine(def.secs), function () { run({ action: 'build', kind: 'build', target: lotId }); }));
    return wrap;
  }
  function collect(lotId) {
    var lot = lotById(lotId), b = builtOf(lotId), n = b ? b.stored : 0;
    run({ action: 'collect', lot: lotId }, function () {
      if (lot) pops.push({ x: lot.x + lot.w / 2, y: lot.y, text: '+' + n, t: 0 });
    });
  }

  /* ------------------------------------------------------------ builder NPC */
  function jobFocus() {
    if (!H || !H.jobs.length || !inOwnHome()) return null;
    var j = H.jobs[0], L = layoutOf(), m = GT.world;
    if (!L || !m) return null;
    if (j.kind === 'th') { var t = L.buildings[0]; return { tx: t.dx + 2, ty: t.dy + 1, fx: t.x + t.w / 2, fy: t.y + t.h / 2, job: j }; }
    if (j.kind === 'build') {
      var lot = lotById(j.target);
      if (lot) return { tx: lot.door.x + 1, ty: lot.door.y + 1, fx: lot.x + lot.w / 2, fy: lot.y + lot.h / 2, job: j };
    }
    if (j.kind === 'chunk') {
      var c = null; (L.chunks || []).forEach(function (q) { if (q.id === j.target) c = q; });
      if (c) {
        var cx = c.cx * 16 + 8, cy = c.cy * 16 + 8, best = null, bd = 1e9, x, y;
        for (y = 1; y < m.h - 1; y++) for (x = 1; x < m.w - 1; x++) {
          var i = y * m.w + x;
          if (m.locked && m.locked[i]) continue;
          if (m.walk[i] !== 1) continue;
          var d = Math.abs(x - cx) + Math.abs(y - cy);
          if (d < bd) { bd = d; best = { x: x, y: y }; }
        }
        if (best) return { tx: best.x, ty: best.y, fx: cx, fy: cy, job: j };
      }
    }
    return null;
  }
  function placeBuilder() {
    var L = layoutOf();
    if (!inOwnHome() || !L || !L.buildings || !L.buildings[0] || !GT.getScene) {
      if (builder) { GT.removeNpc(builder); builder = null; }
      return;
    }
    var f = jobFocus(), th = L.buildings[0];
    var sig = wid() + '|' + (f ? f.job.kind + f.job.target : 'idle') + '|' + layoutSig;
    var alive = false;
    try { alive = !!(builder && GT.findNpc('homeland:builder') === builder); } catch (e) { alive = false; }
    if (alive && sig === builderSig) return;
    builderSig = sig;
    var x = f ? f.tx : th.dx + 2, y = f ? f.ty : th.dy + 1;
    var dir = 'down';
    if (f) { var dx = f.fx - x, dy = f.fy - y; dir = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down'); }
    if (alive) GT.moveNpc(builder, 'out', x, y);
    else builder = GT.addNpc('out', { name: 'Tukang', pal: 3, x: x, y: y, key: 'homeland:builder', dir: dir, lines: [['Pembangunnya lagi semangat!', 'Beri aku pekerjaan lewat Balai Kota.'], ['Palu, paku, dan kayu. Cukup.']] });
    if (builder) { builder.dir = dir; builder.working = !!f; }
  }

  /* ------------------------------------------------------------ engine hooks */
  function withinLot(t) {
    var L = layoutOf();
    if (!L || !L.lots) return null;
    for (var i = 0; i < L.lots.length; i++) {
      var l = L.lots[i];
      if (!builtOf(l.id) && t.x >= l.x && t.x < l.x + l.w && t.y >= l.y && t.y < l.y + l.h) return l;
    }
    return null;
  }
  function onInteract(ctx) {
    if (ctx.scene.kind !== 'out' || ctx.npc) return false;
    var t = ctx.tile, p = portalPos();
    if (ctx.mode === 'talk' && p && t.x === p.x && t.y === p.y) { openPortal(); return true; }
    if (!isHL(wid())) return false;
    var d = ctx.door;
    if (d && HOME_KINDS[d.kind]) {
      if (ctx.mode === 'bump' && Date.now() - lastClose < 700) return true; // key still held after closing the window
      if (ctx.mode === 'message') return false;
      if (!loggedIn()) return true;
      if (d.kind === 'townhall') openWin('hall', 'Balai Kota');
      else openWin('lot', KIND_NAME[d.kind] || 'Bangunan', d.lot);
      return true;
    }
    if (ctx.mode === 'talk') {
      var l = withinLot(t);
      if (l) {
        if (!loggedIn()) return true;
        openWin('lot', 'Lahan ' + (KIND_NAME[l.kind] || ''), l.id);
        return true;
      }
    }
    return false;
  }
  function onFrame(dt) {
    var now = Date.now();
    for (var i = pops.length - 1; i >= 0; i--) { pops[i].t += dt; if (pops[i].t > 1.4) pops.splice(i, 1); }
    clockT += dt;
    if (win && win.kind === 'hall' && clockT >= 1) { clockT = 0; redrawWin(); }
    pollT -= dt;
    if (pollT <= 0) {
      pollT = 4;
      if (C && S() && S().account && S().mode !== 'offline' && !travelling) load(true);
    }
    // a job just ran out: ask the server right away so the new building or chunk shows up
    if (H && H.jobs && H.jobs.length && now - jobPing > 2500) {
      var due = H.jobs.some(function (j) { return endMs(j) <= now; });
      if (due) { jobPing = now; load(true); }
    }
    hintT -= dt; if (hintT > 0) return; hintT = 0.5;
    var n = nearPortal();
    if (n && !nearHint && !hintShown && S() && S().account && !GT.isUiOpen()) { hintShown = true; GT.toast('Portal: hadap portal lalu tekan ' + (document.documentElement.classList.contains('gt-phone') ? 'A' : 'F') + ' (atau tombol B) untuk bepergian.'); }
    nearHint = n;
  }
  function onWorld() {
    nearHint = nearPortal(); pops.length = 0; builder = null; builderSig = '';
    if (isHL(wid())) placeBuilder();
  }

  /* ---- drawing over the world ---- */
  function onDraw(ctx, camX, camY, T) {
    if (!GT.scene || GT.scene.kind !== 'out') return;
    var now = Date.now(), tt = now / 1000, p = portalPos(), L = layoutOf();
    ctx.save();
    if (p) { // portal shimmer
      var px = p.x * T - camX, py = p.y * T - camY;
      for (var k = 0; k < 3; k++) {
        var a = tt * 2.2 + k * 2.1, yy = py - 4 + ((tt * 6 + k * 4) % 12) * 0.7;
        ctx.fillStyle = 'rgba(228,220,255,' + (0.55 - k * 0.12).toFixed(2) + ')';
        ctx.fillRect(Math.round(px + 6 + Math.sin(a) * 2.5), Math.round(yy), 1, 2);
      }
    }
    if (inOwnHome() && H && L) {
      // "+n" over finished production
      H.built.forEach(function (b) {
        if (!(b.stored > 0)) return;
        var lot = lotById(b.lot); if (!lot) return;
        var x = (lot.x + lot.w / 2) * T - camX, y = lot.y * T - camY - 3 + Math.sin(tt * 3 + lot.x) * 1.5;
        var txt = '+' + b.stored;
        ctx.font = 'bold 7px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        var w = ctx.measureText(txt).width + 6;
        ctx.fillStyle = '#2a2430'; ctx.fillRect(Math.round(x - w / 2 - 1), Math.round(y - 5), Math.round(w + 2), 11);
        ctx.fillStyle = b.stored >= b.capacity ? '#ffcf5a' : '#f6ead0'; ctx.fillRect(Math.round(x - w / 2), Math.round(y - 4), Math.round(w), 9);
        ctx.fillStyle = '#2a2430'; ctx.fillText(txt, Math.round(x), Math.round(y + 0.5));
      });
      // builder at work: hammer swing, sparks and the countdown over the target
      var f = jobFocus();
      if (f && builder) {
        var bx = builder.x * T - camX + T / 2, by = builder.y * T - camY + T / 2;
        var side = builder.dir === 'left' ? -1 : 1, ang = Math.sin(tt * 9) * 0.9 - 0.5;
        if (builder.dir === 'up' || builder.dir === 'down') side = 1;
        ctx.save();
        ctx.translate(bx + side * 4, by - 1); ctx.scale(side, 1); ctx.rotate(ang);
        ctx.fillStyle = '#6a4020'; ctx.fillRect(0, -5, 1, 6);
        ctx.fillStyle = '#9a96ac'; ctx.fillRect(-2, -7, 5, 3);
        ctx.fillStyle = '#d8d4e4'; ctx.fillRect(-2, -7, 5, 1);
        ctx.restore();
        if (Math.sin(tt * 9) > 0.8) { ctx.fillStyle = '#ffe066'; ctx.fillRect(Math.round(bx + side * 7), Math.round(by - 4), 1, 1); ctx.fillRect(Math.round(bx + side * 8), Math.round(by - 6), 1, 1); }
        var left = endMs(f.job) - now, lx = f.fx * T - camX, ly = f.fy * T - camY - (f.job.kind === 'th' ? 28 : 20);
        var label = clock(left);
        ctx.font = 'bold 7px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        var lw = ctx.measureText(label).width + 8;
        ctx.fillStyle = '#2a2430'; ctx.fillRect(Math.round(lx - lw / 2 - 1), Math.round(ly - 5), Math.round(lw + 2), 11);
        ctx.fillStyle = '#f6ead0'; ctx.fillRect(Math.round(lx - lw / 2), Math.round(ly - 4), Math.round(lw), 9);
        ctx.fillStyle = '#2a2430'; ctx.fillText(label, Math.round(lx + 0.5), Math.round(ly + 0.5));
      }
      pops.forEach(function (q) {
        ctx.globalAlpha = Math.max(0, 1 - q.t / 1.4);
        ctx.font = 'bold 9px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        var x = q.x * T - camX, y = q.y * T - camY - 8 - q.t * 14;
        ctx.fillStyle = '#2a2430'; ctx.fillText(q.text, Math.round(x + 1), Math.round(y + 1));
        ctx.fillStyle = '#ffe066'; ctx.fillText(q.text, Math.round(x), Math.round(y));
      });
    }
    ctx.restore();
  }

  function init() {
    C = window.GT_CHAIN || null;
    GT.hotkey('B', function () { openPortal(); });
    window.GT_HOME = { enter: enter, travel: travel, openPortal: openPortal, refresh: function () { return load(true); }, state: function () { return H; } };
  }
  GT.register({ id: 'homeland', init: init, onInteract: onInteract, onFrame: onFrame, onDraw: onDraw, onWorld: onWorld });
})();
