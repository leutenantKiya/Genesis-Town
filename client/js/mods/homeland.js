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
 * POST /api/act {action: build | collect | hire | travel}.
 * Worker bots (H.bots, H.hire): hired at the Town Hall ("Pekerja"), shown as NPCs at their workplace. All user-provided text (names) is set with textContent / value.
 */
(function () {
  'use strict';
  var C = null;                          // GT_CHAIN
  var H = null;                          // last GET /api/homeland: the view plus `invited`
  var HV = null;                         // the view of the Homeland we stand in when it is someone else's (GET /api/homeland?world=), with our `role`
  var layoutSig = '';                    // signature of the generator inputs the current map was built from
  var loading = null, lastLoad = 0, pollT = 0, jobPing = 0, lastSync = 0;
  var whereEl = null, whereTxt = null;     // the chip that says whose Homeland this is
  var travelling = false, hintShown = false, nearHint = false, hintT = 0;
  var win = null;                        // the open window: { kind: 'hall' | 'lot', arg, h, busy }
  var lastClose = 0, clockT = 0;
  var pops = [];                         // floating "+n" after a collect: { x, y, text, t }
  var builder = null, builderSig = '';
  var botNpcs = [], botSig = '';          // NPCs of the hired worker bots
  var NEIGH = {
    nw: ['n', 'w'], n: ['nw', 'c', 'ne'], ne: ['n', 'e'], w: ['nw', 'c', 'sw'], c: ['n', 'w', 'e', 's'],
    e: ['ne', 'c', 'se'], sw: ['w', 's'], s: ['sw', 'c', 'se'], se: ['s', 'e']
  };
  var HOME_KINDS = { townhall: 1, kolam: 1, tambang: 1, restoran: 1, rumah: 1, rumahsakit: 1 };
  var KIND_NAME = { kolam: $t('Kolam Ikan'), tambang: $t('Tambang'), restoran: $t('Restoran'), rumah: $t('Rumah Pekerja'), rumahsakit: $t('Rumah Sakit') };

  var ROLE_NAME = { visitor: $t('Pengunjung'), helper: $t('Pembantu'), builder: $t('Tukang'), none: $t('Tidak boleh') };
  function roleSelect(value, withNone, onPick) {
    var sel = $('select', 'hl-role'); (withNone ? ['none', 'visitor', 'helper', 'builder'] : ['visitor', 'helper', 'builder']).forEach(function (k) {
      var o = $('option', null, ROLE_NAME[k]); o.value = k; if (k === value) o.selected = true; sel.appendChild(o);
    });
    sel.addEventListener('change', function () { onPick(sel.value); });
    return sel;
  }
  function setRole(who, role) {
    return C.api('/homeland/role', { method: 'POST', body: { who: who, role: role } })
      .then(function (r) { GT.toast($t('Peran tersimpan.')); return load(true); }, function (e) { GT.toast($t('Gagal: {0}', [e.message])); });
  }

  function $(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function btn(label, onClick, cls, disabled) {
    var b = $('button', 'mbtn' + (cls ? ' ' + cls : ''), label); b.type = 'button'; b.disabled = !!disabled;
    b.addEventListener('click', function (e) { e.currentTarget.blur(); onClick(e); });
    return b;
  }
  function S() { return C && C.state; }
  function wid() { return (GT.worldId && GT.worldId()) || 'public'; }
  function isHL(w) { return /^HL-\d+$/.test(w); }
  /* The world the SERVER has us in (every state answer carries it). When it differs from the one drawn here (not while travelling), the
     screen is not trustworthy: it must not pass for our own Homeland. The state is refreshed until both agree. */
  function mismatch() { var st = S() && S().st, sw = st && st.worldId; return !!(sw && !travelling && sw !== wid()); }
  function inOwnHome() { return !!(H && wid() === H.world && !mismatch()); }
  /* the Homeland we are looking at: our own, or the host's when we are a guest (nothing while client and server disagree) */
  function V() { return mismatch() ? null : inOwnHome() ? H : (isHL(wid()) ? HV : null); }
  function role() { if (inOwnHome()) return 'owner'; if (mismatch()) return 'visitor'; var h = S() && S().st && S().st.here; return (HV && HV.role) || (h && h.role) || 'visitor'; }
  function hostName() { var h = S() && S().st && S().st.here; return (h && h.owner_name) || $t('pemilik'); }
  function assistCost() { var c = S() && S().cfg && S().cfg.econ && S().cfg.econ.coop; return (c && c.assistEnergy) || 10; }
  function itemName(t) {
    if (t === 'coin') return $t('Koin');
    var c = S() && S().cfg && S().cfg.econ && S().cfg.econ.items[t];
    return c ? c.name : t;
  }
  function have(t) { var b = S() && S().st && S().st.bag && S().st.bag[t]; return b ? b.settled + b.today : 0; }
  function costLine(cost) { return Object.keys(cost || {}).map(function (t) { return cost[t] + ' ' + itemName(t); }).join(' + ') || 'gratis'; }
  function shortOf(cost) { return Object.keys(cost || {}).filter(function (t) { return have(t) < cost[t]; }); }
  function secsLine(s) { s = Math.round(s || 0); return s >= 60 ? $t('{0} mnt{1}', [Math.floor(s / 60), s % 60 ? $t(' {0} dtk', [s % 60]) : '']) : $t('{0} dtk', [s]); }
  function clock(ms) { var s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60); }
  function endMs(j) { var v = j.ends_at; if (typeof v === 'string') return Date.parse(v); return v < 1e11 ? v * 1000 : v; }
  function loggedIn() {
    if (!C || !S() || S().mode === 'offline') { GT.toast($t('Homeland butuh server game.')); return false; }
    if (!S().account) { GT.toast($t('Masuk dulu (tombol Masuk).')); return false; }
    return true;
  }
  function layoutOf() { return GT.world && GT.world.layout; }
  function lotById(id) { var L = layoutOf(), r = null; if (L && L.lots) L.lots.forEach(function (l) { if (l.id === id) r = l; }); return r; }
  function builtOf(lot) { var r = null, v = V(); if (v) v.built.forEach(function (b) { if (b.lot === lot) r = b; }); return r; }
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
      builderSig = ''; placeBuilder(); placeBots();
    }, function () { /* keep the old numbers */ })
      .then(function () {
        if (!(H && isHL(wid()) && wid() !== H.world)) { HV = null; return; }
        return C.api('/homeland?world=' + encodeURIComponent(wid())).then(function (v) { HV = v; builderSig = ''; placeBuilder(); }, function () { /* keep the old numbers */ });
      })
      .then(function () { loading = null; redrawWin(); return H; });
    return loading;
  }
  function afterChange() { return load(true).then(function () { return C.refresh(true); }); }

  /* The map for the generator inputs of the view. Keeps the player where they stand. */
  function layoutFor(r) {
    return GTHomeland.generate(r.seed, { open: r.open || [], th: r.th, gen: r.gen, built: (r.built || []).map(function (b) { return { kind: b.kind, lot: b.lot }; }) });
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
      if (!ok) throw new Error($t('Peta Homeland gagal dibuat.'));
      layoutSig = signature(H);
      GT.teleportPlayer('out', L.spawn.x, L.spawn.y, 'down');
      builderSig = ''; placeBuilder();
      if (window.GT_PLAYERS && GT_PLAYERS.refresh) GT_PLAYERS.refresh();
      return C.refresh(true).then(function () { return true; });
    }).catch(function (e) { GT.toast((e && e.message) || $t('Gagal masuk Homeland.')); return false; });
  }
  function portalPos() { var w = GT.world; return w && w.portal || null; }
  function nearPortal() {
    var d = portalPos(), p = GT.player;
    return !!(d && GT.scene && GT.scene.kind === 'out' && Math.abs(p.x - d.x) + Math.abs(p.y - d.y) <= 2);
  }
  function openPortal() {
    if (travelling || !loggedIn()) return;
    if (!nearPortal()) { GT.toast($t('Pergi ke portal dulu.')); return; }
    load(true).then(function () {
      var cur = wid(), opts = [];
      if (cur !== 'public') opts.push({ label: $t('Area Publik (pasar)'), onPick: function () { travel('public'); } });
      if (H && cur !== H.world) opts.push({ label: $t('Rumahku'), onPick: function () { travel(H.world); } });
      ((H && H.invited) || []).forEach(function (v) {
        if (cur === v.world) return;
        opts.push({ label: v.via === 'party' ? $t('Dunia {0} (party)', [v.owner_name || v.world]) : $t('Dunia {0}', [v.owner_name || v.world]), onPick: function () { travel(v.world); } });
      });
      GT.menu($t('Portal · mau ke mana?'), opts);
    });
  }
  function travel(to) {
    if (travelling) return;
    travelling = true;
    var from = wid(), layoutP;
    if (to === 'public') layoutP = Promise.resolve(null);
    else layoutP = C.api('/homeland/layout?world=' + encodeURIComponent(to)).then(function (r) { return layoutFor(r); });
    layoutP.then(function (L) {
      GT.toast($t('Melangkah ke portal…'));
      return C.act({ action: 'travel', to: to, world: from }, true).catch(function (e) { e.shown = true; throw e; }).then(function (r) {
        var ok = false;
        try { ok = GT.switchWorld(r.world, L); } catch (err) { ok = false; }
        if (!ok) {
          // The server already moved us, so both sides disagree. A fresh page lands on the own Homeland spawn, which the
          // server always accepts (Positions.report), so reloading puts them in step again.
          GT.toast($t('Peta gagal dibuat. Memuat ulang agar posisimu kembali sama dengan server…'));
          setTimeout(function () { location.reload(); }, 1800);
          var e = new Error($t('Perjalanan gagal.')); e.shown = true; throw e;
        }
        if (H && r.world === H.world && L) layoutSig = signature(H);
        GT.teleportPlayer('out', r.arrive.x, r.arrive.y, 'down');
        nearHint = true; if (r.toast) GT.toast(r.toast);
        builderSig = ''; placeBuilder();
        if (window.GT_PLAYERS && GT_PLAYERS.refresh) GT_PLAYERS.refresh();
        return C.refresh(true);
      });
    }).catch(function (e) { if (!(e && e.shown)) GT.toast((e && e.message) || $t('Gagal bepergian.')); }).then(function () { travelling = false; });
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
  function busyJob() { var v = V(); return v && v.builders && v.builders.busy >= v.builders.total; }

  function run(body, after) {
    if (!loggedIn() || (win && win.busy)) return;
    if (win) win.busy = true; redrawWin();
    var done = function () { if (win) win.busy = false; redrawWin(); };
    C.act(body).then(function (r) { return Promise.resolve(after && after(r)).then(function () { return afterChange(); }); }, function () { /* act() already toasted the reason */ })
      .then(done, done);
  }

  function isBusy() { return !!(win && win.busy); }

  /* A tray cell: title left, metadata right (tabular figures), body below, actions right-aligned at the foot. */
  function cell(title, meta, cls) {
    var c = $('div', 'hl-cell' + (cls ? ' ' + cls : '')), h = $('div', 'hl-cell-h');
    h.appendChild($('span', 'hl-cell-t', title));
    if (meta != null && meta !== '') h.appendChild($('span', 'hl-meta', meta));
    c.appendChild(h); return c;
  }
  function acts(parent) { var a = $('div', 'hl-acts'); parent.appendChild(a); return a; }
  function bar(v, max, tone) {
    var p = $('progress', 'hl-bar' + (tone ? ' ' + tone : '')); p.max = Math.max(1, max); p.value = Math.max(0, Math.min(max, v)); return p;
  }
  /* cost line: item chips (the missing ones are marked and named), then the time */
  function costRow(cost, secs) {
    var r = $('div', 'hl-cost'), keys = Object.keys(cost || {}), short = shortOf(cost);
    r.appendChild($('span', 'hl-k', $t('Biaya')));
    if (!keys.length) r.appendChild($('span', 'hl-chip', 'gratis'));
    keys.forEach(function (t) {
      var c = $('span', 'hl-chip' + (have(t) < cost[t] ? ' short' : '')); c.appendChild($('b', 'hl-n', String(cost[t]))); c.appendChild(document.createTextNode(' ' + itemName(t))); r.appendChild(c);
    });
    if (secs != null) { r.appendChild($('span', 'hl-k', $t('Waktu'))); r.appendChild($('b', 'hl-n', secsLine(secs))); }
    if (short.length) r.appendChild($('span', 'hl-lack', $t('kurang {0}', [short.map(itemName).join(', ')])));
    return r;
  }

  function stepBlock(title, desc, step, canDo, why, label, onClick, primary, meta) {
    var box = cell(title, meta);
    if (desc) box.appendChild($('p', 'hl-p', desc));
    if (step) box.appendChild(costRow(step.cost, step.secs));
    if (why) box.appendChild($('p', 'hl-why', why));
    if (label) acts(box).appendChild(btn(label, onClick, primary === false ? '' : 'primary', !canDo || isBusy()));
    return box;
  }

  function jobWhat(j) {
    return j.kind === 'th' ? $t('Balai Kota naik level') : j.kind === 'chunk' ? $t('Membuka wilayah {0}', [chunkName(j.target)]) : j.kind === 'furniture' ? $t('Memasang {0}', [/:kasur$/.test(j.target) ? 'kasur' : 'hiburan']) : j.kind === 'upgrade' ? $t('Menaikkan Rumah Sakit') : $t('Membangun {0}', [(lotById(j.target) && KIND_NAME[lotById(j.target).kind]) || j.target]);
  }
  function jobLine(j) { return $t('{0} · sisa {1}', [jobWhat(j), clock(endMs(j) - Date.now())]); }

  /* the running jobs of the Homeland we look at; helpers and up get the "Bantu tukang" button on each */
  function jobRows(parent, v, rl) {
    v.jobs.forEach(function (j) {
      var r = $('div', 'hl-row'); r.appendChild($('span', 'hl-grow', jobWhat(j))); r.appendChild($('span', 'hl-k', 'sisa')); r.appendChild($('b', 'hl-n hl-time', clock(endMs(j) - Date.now()))); parent.appendChild(r);
      if (rl !== 'visitor') acts(parent).appendChild(btn($t('Bantu tukang (−{0} energi)', [assistCost()]), function () { run({ action: 'assist', target: j.target }); }, '', isBusy()));
    });
  }
  /* ---- Balai Kota of someone else's Homeland ---- */
  function guestHall(wrap) {
    var v = V(), rl = role();
    if (!v) { wrap.appendChild($('p', null, $t('Memuat…'))); return wrap; }
    var stats = $('div', 'hl-stats');
    [[$t('Balai Kota'), $t('level {0}', [v.th])], [$t('Wilayah terbuka'), $t('{0} dari 9', [v.open.length + 1])]].forEach(function (kv) { var s = $('div', 'hl-stat'); s.appendChild($('span', 'hl-k', kv[0])); s.appendChild($('b', 'hl-n', kv[1])); stats.appendChild(s); });
    wrap.appendChild(stats);
    wrap.appendChild($('p', 'hl-p', $t('Kamu: {0} di dunia ini', [ROLE_NAME[rl] || ROLE_NAME.visitor])));
    var bs = cell($t('Pembangun'), $t('{0} dari {1} sibuk', [v.builders.busy, v.builders.total]));
    if (v.jobs.length) jobRows(bs, v, rl); else bs.appendChild($('p', 'chain-dim', $t('Pembangun menganggur.')));
    wrap.appendChild(bs);
    // raising the Town Hall and opening land are the owner's alone; builders build on lots (lot windows)
    wrap.appendChild($('p', 'hl-p', rl === 'builder' ? $t('Balai Kota dan wilayah baru hanya bisa diurus pemilik. Tukang membangun di lahan.') : $t('Hanya pemilik dan Tukang yang bisa membangun di sini.')));
    return wrap;
  }
  /* ---- Balai Kota ---- */
  function hallBody() {
    var wrap = $('div', 'gt-isl hl');
    if (!H) { wrap.appendChild($('p', null, $t('Memuat…'))); return wrap; }
    var owner = inOwnHome();
    if (!owner) return guestHall(wrap);
    var stats = $('div', 'hl-stats');
    function stat(k, v) { var s = $('div', 'hl-stat'); s.appendChild($('span', 'hl-k', k)); s.appendChild($('b', 'hl-n', v)); stats.appendChild(s); }
    stat($t('Balai Kota'), $t('level {0}', [H.th]));
    stat($t('Wilayah terbuka'), $t('{0} dari 9', [H.open.length + 1]));
    wrap.appendChild(stats);

    var bs = cell($t('Pembangun'), $t('{0} dari {1} sibuk', [H.builders.busy, H.builders.total]));
    if (H.jobs.length) H.jobs.forEach(function (j) {
      var r = $('div', 'hl-row'); r.appendChild($('span', 'hl-grow', jobWhat(j))); r.appendChild($('span', 'hl-k', 'sisa')); r.appendChild($('b', 'hl-n hl-time', clock(endMs(j) - Date.now()))); bs.appendChild(r);
    });
    else bs.appendChild($('p', 'chain-dim', $t('Pembangun menganggur. Beri dia pekerjaan.')));
    (H.workers || []).forEach(function (w) {
      var sick = w.sick_until && endMs({ ends_at: w.sick_until }) > Date.now(), r = $('div', 'hl-row hl-worker');
      var who = $('span', 'hl-grow'); who.appendChild(document.createTextNode(w.name + ' '));
      who.appendChild($('span', 'hl-state' + (sick ? ' bad' : ''), sick ? $t('sakit') : w.busy ? $t('bekerja') : $t('menganggur')));
      r.appendChild(who);
      var f = Math.round(w.fatigue), pb = bar(f, 100, f >= 70 ? 'bad' : f >= 40 ? 'mid' : 'ok'); pb.setAttribute('aria-label', 'lelah');
      r.appendChild(pb);
      r.appendChild($('span', 'hl-n hl-sm', $t('lelah {0}% · semangat {1}%', [f, Math.round(w.motivation == null ? 60 : w.motivation)])));
      bs.appendChild(r);
    });
    if (H.workers && H.workers.some(function (w) { return w.fatigue >= 40; })) bs.appendChild($('p', 'chain-dim', $t('Tukang yang lelah bekerja lebih lambat. Restoran memberi mereka makan dari lemarinya.')));
    wrap.appendChild(bs);

    if (H.forage) {
      var fs = H.forage.stored || {}, tot = 0;
      var parts = Object.keys(fs).map(function (t) { tot += fs[t]; return fs[t] + ' ' + itemName(t); });
      var fb = cell($t('Pemburu membawa: {0} (maks {1})', [parts.join(', '), H.forage.capacity]));
      fb.appendChild($('p', 'chain-dim', $t('Mencari ikan dan kayu sendiri. Musim dingin hasilnya dua kali lipat.')));
      acts(fb).appendChild(btn($t('Ambil'), function () { run({ action: 'forage' }); }, '', tot <= 0 || isBusy()));
      wrap.appendChild(fb);
    }

    var busy = busyJob(), why = busy ? $t('Pembangun sedang bekerja.') : null;
    var th = H.next && H.next.th;
    if (!th) wrap.appendChild(stepBlock($t('Naikkan Balai Kota'), $t('Sudah di level tertinggi.'), null, false, null, null));
    else {
      var short = shortOf(th.cost), can = !busy && !short.length;
      wrap.appendChild(stepBlock($t('Naikkan ke level {0}', [th.level]), $t('Level lebih tinggi membuka bangunan baru, petak kebun, dan wilayah.'), th, can, why, $t('Naikkan ke level {0}', [th.level]), function () { run({ action: 'build', kind: 'th', target: 'th' }); }, true));
    }

    // neighbouring locked chunks
    var ch = H.next && H.next.chunk, mine = { c: 1 };
    H.open.forEach(function (c) { mine[c] = 1; });
    var adj = [];
    Object.keys(NEIGH).forEach(function (id) {
      if (mine[id]) return;
      if (NEIGH[id].some(function (n) { return mine[n]; })) adj.push(id);
    });
    var ob = cell($t('Buka wilayah'), ch ? 'ke-' + ch.n : null);
    if (!ch) ob.appendChild($('p', 'chain-dim', adj.length ? $t('Semua wilayah yang bisa dibuka sudah terbuka.') : $t('Semua wilayah sudah terbuka.')));
    else {
      ob.appendChild(costRow(ch.cost, ch.secs));
      if (H.th < ch.th) ob.appendChild($('p', 'hl-why', $t('Terkunci: perlu Balai Kota level {0}.', [ch.th])));
      var okChunk = !busy && H.th >= ch.th && !shortOf(ch.cost).length, ca = acts(ob);
      adj.forEach(function (id) { ca.appendChild(btn($t('Buka {0}', [chunkName(id)]), function () { run({ action: 'build', kind: 'chunk', target: id }); }, '', !okChunk || isBusy())); });
    }
    wrap.appendChild(ob);

    // Pekerja: worker bots
    var bd = H.beds || { total: 0, used: 0 }, full = bd.used >= bd.total;
    var pk = cell($t('Pekerja'), $t('Kasur {0} dari {1}', [bd.used, bd.total]));
    pk.appendChild($('p', 'chain-dim', $t('Bayar sekali, bekerja selamanya. Tukang menambah pembangun; Pemburu mencari ikan dan kayu; Koki mempercepat Restoran memberi makan Tukang; Petani mempercepat tanaman; Nelayan mempercepat Kolam Ikan; Penebang menambah kayu per pohon.')));
    pk.appendChild($('p', full ? 'hl-warn' : 'chain-dim', $t('Kasur terpakai {0} dari {1}{2}', [bd.used, bd.total, full ? $t('. Bangun Rumah Pekerja atau tambah kasur.') : '.'])));
    var hireMap = H.hire || {};
    Object.keys(hireMap).forEach(function (job) {
      var d = hireMap[job], row = $('div', 'hl-row hl-hire'), tx = $('div', 'hl-grow');
      var nm = $('div', 'hl-name'); nm.appendChild(document.createTextNode(d.name + ' '));
      if (d.rarity === 'rare') nm.appendChild($('span', 'hl-rare', $t('Langka')));
      tx.appendChild(nm);
      tx.appendChild($('div', 'hl-n hl-sm', d.have + '/' + d.max + ' · ' + d.price + ' ' + itemName('coin')));
      if (!d.can && d.why) tx.appendChild($('div', 'hl-why', d.why));
      row.appendChild(tx);
      row.appendChild(btn($t('Pekerjakan {0} ({1})', [d.name, d.price]), function () { run({ action: 'hire', job: job }); }, '', !d.can || isBusy()));
      pk.appendChild(row);
    });
    wrap.appendChild(pk);

    // cosmetics: a hat for the Tukang or a bot; better output, or less fatigue for a Tukang
    var cat = H.cosmetics || {}, crew = [{ id: 0, name: $t('Tukang Balai Kota'), cosmetic: (H.workers && H.workers[0] && H.workers[0].cosmetic) || null }];
    (H.bots || []).forEach(function (b) { crew.push({ id: b.id, name: b.name + ' ' + b.id, cosmetic: b.cosmetic || null }); });
    if (Object.keys(cat).length) {
      var pc = cell($t('Perlengkapan'));
      pc.appendChild($('p', 'chain-dim', $t('Topi dan syal: Tukang jadi kurang lelah, pekerja lain lebih rajin. Pakai yang baru menggantikan yang lama, tanpa uang kembali.')));
      crew.forEach(function (c) {
        var cr = $('div', 'hl-crew'), who = $('div', 'hl-name');
        who.appendChild(document.createTextNode(c.name + ' · '));
        who.appendChild($('span', 'hl-state', c.cosmetic && cat[c.cosmetic] ? cat[c.cosmetic].name : $t('polos')));
        cr.appendChild(who);
        var ca = acts(cr);
        Object.keys(cat).forEach(function (k) {
          var d = cat[k];
          ca.appendChild(btn(d.name + ' (' + d.price + ', +' + Math.round(d.boost * 100) + '%)', function () { run({ action: 'dress', bot: c.id, cosmetic: k }); }, '', c.cosmetic === k || have('coin') < d.price || isBusy()));
        });
        pc.appendChild(cr);
      });
      wrap.appendChild(pc);
    }

    // invites
    var iv = cell($t('Undang teman'));
    iv.appendChild($('p', 'chain-dim', $t('Hanya kamu dan tamu undangan yang boleh datang lewat portal. Tulis nama pemain (seperti di permainan), pisahkan dengan koma. Tamu melihat duniamu di menu portal.')));
    var input = $('input'); input.type = 'text'; input.maxLength = 400; input.placeholder = $t('Ayu, Budi'); var known = {};
    input.setAttribute('aria-label', $t('Nama tamu'));
    (H.guests || []).forEach(function (g) { var nm = typeof g === 'string' ? g : g.name; known[nm] = typeof g === 'string' ? g : g.account; });
    input.value = Object.keys(known).join(', ');
    input.autocomplete = 'off';
    iv.appendChild(input);
    acts(iv).appendChild(btn($t('Simpan undangan'), function () {
      var list = String(input.value || '').split(/[,;]+/).map(function (x) { return x.trim(); }).filter(Boolean)
        .map(function (x) { return Object.prototype.hasOwnProperty.call(known, x) ? known[x] : x; });
      C.api('/homeland/invite', { method: 'POST', body: { accounts: list } })
        .then(function (r) {
          var names = (r.invite || []).map(function (g) { if (typeof g === 'string') return g; known[g.name] = g.account; return g.name; });
          input.value = names.join(', '); GT.toast($t('Undangan tersimpan ({0} tamu).', [names.length])); return load(true);
        }, function (e) { GT.toast($t('Gagal: {0}', [e.message])); });
    }));
    wrap.appendChild(iv);

    // roles: what the party and each invited guest may do here
    var rl = cell($t('Peran tamu'));
    rl.appendChild($('p', 'chain-dim', $t('Pengunjung hanya jalan, mengobrol, makan, dan berdagang. Pembantu juga menebang, menambang, memancing, dan melawan monster. Tukang juga boleh membangun.')));
    var pr = $('div', 'hl-acts'); pr.appendChild($('span', 'hl-k', $t('Party'))); pr.appendChild(roleSelect(H.party_role || 'visitor', true, function (v) { setRole('party', v); })); rl.appendChild(pr);
    (H.guests || []).forEach(function (g) {
      var row = $('div', 'hl-acts'); row.appendChild($('span', 'hl-k', g.name + (g.tag ? '#' + g.tag : '')));
      row.appendChild(roleSelect(g.role || 'visitor', false, function (v) { setRole(g.account, v); })); rl.appendChild(row);
    });
    wrap.appendChild(rl);
    return wrap;
  }

  /* ---- a lot: build or collect ---- */
  function lotBody(lotId) {
    var wrap = $('div', 'gt-isl hl'), lot = lotById(lotId);
    if (!H || !lot) { wrap.appendChild($('p', null, H ? $t('Lahan ini tidak ada.') : $t('Memuat…'))); return wrap; }
    var owner = inOwnHome(), rl = role(), v = V() || H, b = builtOf(lotId), name = KIND_NAME[lot.kind] || lot.kind;
    var def = v.next && v.next.buildings && v.next.buildings[lot.kind];
    var stats = $('div', 'hl-stats'), st1 = $('div', 'hl-stat');
    st1.appendChild($('span', 'hl-k', name)); st1.appendChild($('b', 'hl-n', chunkName(lot.chunk))); stats.appendChild(st1);
    wrap.appendChild(stats);
    var job = null;
    v.jobs.forEach(function (j) { if (j.kind === 'build' && j.target === lotId) job = j; });
    if (!owner && b && def && (def.cooks || def.furniture || def.healGameHours)) { wrap.appendChild($('p', 'hl-p', $t('Bangunan milik pemilik dunia ini.'))); return wrap; }
    if (b && def && def.cooks) { wrap.appendChild(restoranBody(lotId)); return wrap; }
    if (b && def && def.furniture) { wrap.appendChild(houseBody(lotId)); return wrap; }
    if (b && def && def.healGameHours) { wrap.appendChild(hospitalBody(lotId)); return wrap; }
    if (b) {
      var prod = def && def.produces ? itemName(def.produces) : $t('hasil');
      var box = cell($t('{0} · menghasilkan {1}', [name, prod]), b.stored + ' / ' + b.capacity);
      box.appendChild(bar(b.stored, b.capacity, b.stored >= b.capacity ? 'full' : ''));
      box.appendChild($('p', 'hl-p', $t('Tersimpan {0} dari {1}. Kalau penuh, hasil berhenti bertambah.', [b.stored, b.capacity])));
      if (rl === 'visitor') box.appendChild($('p', 'chain-dim', $t('Bangunan milik pemilik dunia ini.')));
      else acts(box).appendChild(btn(owner ? $t('Ambil hasil ({0})', [b.stored]) : $t('Ambil untuk pemilik ({0})', [b.stored]), function () { collect(lotId); }, 'primary', b.stored <= 0 || isBusy()));
      wrap.appendChild(box);
      return wrap;
    }
    if (job) {
      var jc = cell(jobWhat(job)); var jr = $('div', 'hl-row'); jr.appendChild($('span', 'hl-grow hl-k', 'sisa')); jr.appendChild($('b', 'hl-n hl-time', clock(endMs(job) - Date.now()))); jc.appendChild(jr);
      if (rl !== 'visitor') acts(jc).appendChild(btn($t('Bantu tukang (−{0} energi)', [assistCost()]), function () { run({ action: 'assist', target: job.target }); }, '', isBusy()));
      wrap.appendChild(jc); return wrap;
    }
    if (!def) { wrap.appendChild($('p', null, $t('Memuat…'))); return wrap; }
    if (rl !== 'owner' && rl !== 'builder') { wrap.appendChild($('p', 'hl-p', $t('Lahan kosong milik pemilik dunia ini.'))); return wrap; }
    // `can`/`why` in the view describe the first lot of this kind; for another lot the server decides when we press the button.
    var sameLot = def.lot === lotId, short = shortOf(def.cost), why = sameLot ? def.why : null;
    if (!why && busyJob()) why = $t('Pembangun sedang bekerja.');
    if (!why && short.length) why = $t('Kurang {0}.', [short.map(itemName).join(', ')]);
    var can = !why && (!sameLot || def.can);
    var blurb = def.furniture ? $t('Satu kasur untuk satu pekerja. Tambah kasur supaya lebih banyak pekerja muat, tambah hiburan supaya mereka semangat. Perlu Balai Kota level {0}.', [def.th]) : def.healGameHours ? $t('Merawat Tukang yang tumbang karena kelelahan, makin tinggi levelnya makin cepat sembuh. Perlu Balai Kota level {0}.', [def.th]) : def.cooks ? $t('Memasak ikan bakar dan memberi makan Tukang yang lelah dari lemarinya. Perlu Balai Kota level {0}.', [def.th]) : $t('Menghasilkan {0} terus-menerus, simpan sampai {1}. Perlu Balai Kota level {2}.', [itemName(def.produces), def.capacity, def.th]);
    if (!owner) blurb = $t('Dibayar dari tasmu; bangunannya milik {0}.', [hostName()]) + ' ' + blurb;
    wrap.appendChild(stepBlock($t('Bangun {0}', [def.name || name]), blurb,
      def, can, why, $t('Bangun · {0}', [secsLine(def.secs)]), function () { run({ action: 'build', kind: 'build', target: lotId }); }, true));
    return wrap;
  }
  /* ---- Rumah Pekerja: beds and entertainment ---- */
  function houseView(lotId) { var r = null; (H.houses || []).forEach(function (h) { if (h.lot === lotId) r = h; }); return r; }
  function furnRow(title, text, step, label, target, primary) {
    var row = cell(title);
    row.appendChild($('p', 'chain-dim', text));
    if (step) {
      row.appendChild(costRow(step.cost, step.secs));
      var short = shortOf(step.cost), why = busyJob() ? $t('Pembangun sedang bekerja.') : short.length ? $t('Kurang {0}.', [short.map(itemName).join(', ')]) : null;
      if (why) row.appendChild($('p', 'hl-why', why));
      acts(row).appendChild(btn(label + ' · ' + secsLine(step.secs), function () { run({ action: 'build', kind: 'furniture', target: target }); }, primary ? 'primary' : '', !!why || isBusy()));
    } else row.appendChild($('p', 'chain-dim', $t('Sudah level tertinggi.')));
    return row;
  }
  function houseBody(lotId) {
    var box = $('div', 'hl'), h = houseView(lotId);
    if (!h) { box.appendChild($('p', null, $t('Memuat…'))); return box; }
    var live = cell($t('Rumah Pekerja'), $t('{0} dari {1} kasur terisi', [h.used, h.beds]));
    var mo = $('div', 'hl-row'); mo.appendChild($('span', 'hl-grow', $t('Semangat penghuni'))); mo.appendChild($('b', 'hl-n', h.motivation + '%')); live.appendChild(mo);
    live.appendChild(bar(h.motivation, 100, 'ok'));
    live.appendChild($('p', 'hl-p', (h.hiburanName ? h.hiburanName : $t('Belum ada hiburan'))));
    live.appendChild($('p', 'chain-dim', $t('Semangat tinggi membuat pekerja lebih cepat. Pekerja baru tinggal di rumah yang punya kasur kosong dan hiburan terbaik.')));
    box.appendChild(live);
    box.appendChild(furnRow($t('Kasur {0} dari {1}', [h.kasur, h.kasurMax]), $t('Tiap kasur menambah satu tempat tinggal pekerja.'), h.nextKasur, $t('Tambah Kasur'), lotId + ':kasur', true));
    box.appendChild(furnRow($t('Hiburan {0} dari {1}', [h.hiburan, h.hiburanMax]), $t('Radio, TV, Gamelan: tiap tingkat menambah semangat 20%.'), h.nextHiburan, $t('Pasang {0}', [h.nextHiburan && h.nextHiburan.name || $t('Hiburan')]), lotId + ':hiburan', false));
    return box;
  }
  /* ---- Rumah Sakit ---- */
  function hospitalBody(lotId) {
    var hp = H.hospital;
    if (!hp) { var l = cell($t('Rumah Sakit')); l.appendChild($('p', null, $t('Memuat…'))); return l; }
    var box = cell($t('Rumah Sakit'), $t('level {0} dari {1}', [hp.level, hp.maxLevel]));
    box.appendChild($('p', 'hl-p', $t('Tukang yang tumbang sembuh dalam {0} jam permainan (tanpa rumah sakit 24 jam).', [hp.healGameHours])));
    if (hp.next) {
      var cr = costRow(hp.next.cost, hp.next.secs); box.appendChild($('p', 'hl-k', $t('Naik level'))); box.appendChild(cr);
      var short = shortOf(hp.next.cost), why = busyJob() ? $t('Pembangun sedang bekerja.') : short.length ? $t('Kurang {0}.', [short.map(itemName).join(', ')]) : null;
      if (why) box.appendChild($('p', 'hl-why', why));
      acts(box).appendChild(btn($t('Naikkan Rumah Sakit · {0}', [secsLine(hp.next.secs)]), function () { run({ action: 'build', kind: 'upgrade', target: lotId }); }, 'primary', !!why || isBusy()));
    } else box.appendChild($('p', 'chain-dim', $t('Sudah level tertinggi.')));
    return box;
  }
  /* ---- Restoran: cook into the pantry, put food in, see the pantry ---- */
  function restoranBody(lotId) {
    var R = H.restoran || { pantry: 0, pantryMax: 0 }, ck = H.cook;
    var box = cell($t('Restoran'), $t('lemari {0} dari {1}', [R.pantry, R.pantryMax]));
    box.appendChild(bar(R.pantry, R.pantryMax, ''));
    box.appendChild($('p', 'chain-dim', $t('Makanan di lemari diberikan otomatis ke Tukang yang lelah{0}. Makanan di Tasmu tidak dipakai kecuali kamu menaruhnya.', [H.bots && H.bots.some(function (b) { return b.job === 'chef'; }) ? $t(' (Koki: dua kali lebih cepat)') : ''])));
    if (ck) box.appendChild($('p', 'hl-p', $t('Resep: {0} → 1 {1}{2}', [Object.keys(ck.recipe.inputs).map(function (t) { return ck.recipe.inputs[t] + ' ' + itemName(t); }).join(' + '), itemName(ck.recipe.output), ck.can ? '' : ' · ' + ck.why])));
    var busy = isBusy();
    var cookRow = $('div', 'hl-acts hl-lead');
    cookRow.appendChild($('span', 'hl-k', $t('Masak')));
    [1, 5, 10].forEach(function (q) { cookRow.appendChild(btn('x' + q, function () { run({ action: 'cook', qty: q }); }, q === 1 ? 'primary' : '', busy || !ck || R.pantry + q > R.pantryMax)); });
    box.appendChild(cookRow);
    var putRow = $('div', 'hl-acts hl-lead');
    putRow.appendChild($('span', 'hl-k', $t('Taruh makanan dari Tas')));
    ['bread', 'meal'].forEach(function (t) {
      var n = have(t), q = Math.min(n, Math.max(0, R.pantryMax - R.pantry));
      putRow.appendChild(btn(itemName(t) + ' (' + n + ')', function () { run({ action: 'stock', token: t, qty: q }); }, '', busy || q <= 0));
    });
    box.appendChild(putRow);
    return box;
  }
  function collect(lotId) {
    var lot = lotById(lotId), b = builtOf(lotId), n = b ? b.stored : 0;
    run({ action: 'collect', lot: lotId }, function () {
      if (lot) pops.push({ x: lot.x + lot.w / 2, y: lot.y, text: '+' + n, t: 0 });
    });
  }

  /* ------------------------------------------------------------ builder NPC */
  function jobFocus() {
    var v = V();
    if (!v || !v.jobs.length || !isHL(wid())) return null;
    var j = v.jobs[0], L = layoutOf(), m = GT.world;
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
    if (!isHL(wid()) || !V() || !L || !L.buildings || !L.buildings[0] || !GT.getScene) {
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
    else builder = GT.addNpc('out', { name: $t('Tukang'), pal: 3, x: x, y: y, key: 'homeland:builder', dir: dir, lines: [[$t('Pembangunnya lagi semangat!'), $t('Beri aku pekerjaan lewat Balai Kota.')], [$t('Palu, paku, dan kayu. Cukup.')]] });
    if (builder) { builder.dir = dir; builder.working = !!f; var tw = inOwnHome() && H && H.workers && H.workers[0]; builder.tired = tw ? tw.fatigue / 100 : 0; }
  }

  /* ---- cosmetics drawn on the Tukang and the bots, in the cosmetic's colour ---- */
  function isSick(slot) {
    var w = null; (H && H.workers || []).forEach(function (x) { if (x.slot === slot) w = x; });
    return !!(w && w.sick_until && endMs({ ends_at: w.sick_until }) > Date.now());
  }
  function drawHat(ctx, n, name, camX, camY, T, sick) {
    var d = name && H.cosmetics && H.cosmetics[name]; if (!d || !n) return;
    // where the sprite is now: a walking NPC's x, y is already the next tile, so the hat would run ahead of the head
    var k = n.moving ? Math.min(1, n.t || 0) : 1, nx = n.moving ? n.fx + (n.x - n.fx) * k : n.x, ny = n.moving ? n.fy + (n.y - n.fy) * k : n.y;
    var ha = GT.at(nx, ny), sx = GT.snap(ha.x), sy = GT.snap(ha.y);
    if (sick) { if (name === 'syal') return; sx -= 2; sy += 5; } // a collapsed worker lies down: the hat goes on the lying head
    ctx.fillStyle = '#2a2430';
    if (name === 'syal') { ctx.fillRect(sx + 3, sy + 7, 10, 3); ctx.fillStyle = d.color; ctx.fillRect(sx + 4, sy + 8, 8, 1); ctx.fillRect(sx + 9, sy + 8, 2, 4); return; }
    if (name === 'mahkota') { ctx.fillRect(sx + 4, sy - 1, 8, 4); ctx.fillStyle = d.color; ctx.fillRect(sx + 5, sy + 1, 6, 2); ctx.fillRect(sx + 5, sy - 1, 1, 2); ctx.fillRect(sx + 7, sy - 2, 2, 3); ctx.fillRect(sx + 10, sy - 1, 1, 2); return; }
    ctx.fillRect(sx + 1, sy + 1, 14, 3); ctx.fillRect(sx + 4, sy - 1, 8, 3); // caping: wide round hat
    ctx.fillStyle = d.color; ctx.fillRect(sx + 2, sy + 2, 12, 1); ctx.fillRect(sx + 5, sy, 6, 2);
  }

  /* ---- worker bots: stand at their workplace with the job name above their head ---- */
  function walkableAt(x, y) {
    var m = GT.world; if (!m || x < 1 || y < 1 || x >= m.w - 1 || y >= m.h - 1) return false;
    var i = y * m.w + x; return m.walk[i] === 1 && !(m.locked && m.locked[i]);
  }
  function spotNear(cx, cy, taken) {
    var best = null, bd = 1e9, x, y;
    for (y = Math.max(1, cy - 6); y < cy + 7; y++) for (x = Math.max(1, cx - 6); x < cx + 7; x++) {
      if (!walkableAt(x, y) || taken[x + ',' + y]) continue;
      var d = Math.abs(x - cx) + Math.abs(y - cy);
      if (d < bd) { bd = d; best = { x: x, y: y }; }
    }
    return best;
  }
  function workplace(job, L) {
    var th = L.buildings && L.buildings[0], i, k;
    if (job === 'petani' && L.farm && L.farm.plots && L.farm.plots[0]) return { x: L.farm.plots[0].x + 1, y: L.farm.plots[0].y + 1 };
    if (job === 'nelayan') { for (i = 0; i < (H.built || []).length; i++) if (H.built[i].kind === 'kolam') { var lot = lotById(H.built[i].lot); if (lot) return { x: lot.door.x + 1, y: lot.door.y + 1 }; } }
    if (job === 'penebang' && th && L.tiles) {
      var best = null, bd = 1e9, x, y;
      for (y = 1; y < L.h - 1; y++) for (x = 1; x < L.w - 1; x++) {
        var t = L.tiles[y * L.w + x]; if (t !== 'tree') continue;
        var d = Math.abs(x - th.dx) + Math.abs(y - th.dy); if (d < bd) { bd = d; best = { x: x, y: y }; }
      }
      if (best) return best;
    }
    return th ? { x: th.dx + 3, y: th.dy + 2 } : null;
  }
  function placeBots() {
    var L = layoutOf(), sig = !inOwnHome() || !L || !H ? '' : wid() + '|' + layoutSig + '|' + (H.bots || []).map(function (b) { return b.id + b.job + (b.house || ''); }).join('.');
    if (sig === botSig && botNpcs.every(function (n) { try { return GT.findNpc(n.key) === n.npc; } catch (e) { return false; } })) return;
    botSig = sig;
    botNpcs.forEach(function (n) { try { GT.removeNpc(n.npc); } catch (e) { /* gone with the world */ } });
    botNpcs = [];
    if (!sig || !GT.getScene) return;
    var taken = {};
    (H.bots || []).forEach(function (b) {
      var hl = b.house && lotById(b.house), w = hl ? { x: hl.door.x, y: hl.door.y + 1 } : workplace(b.job, L); if (!w) return; // bots live at their house
      var spot = spotNear(w.x, w.y, taken); if (!spot) return;
      taken[spot.x + ',' + spot.y] = 1;
      var key = 'homeland:bot:' + b.id, dx = w.x - spot.x, dy = w.y - spot.y;
      var dir = dx === 0 && dy === 0 ? 'down' : Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
      var npc = GT.addNpc('out', { name: b.name, pal: 2 + (b.id % 4), x: spot.x, y: spot.y, key: key, dir: dir, lines: [[$t('Siap bekerja, Juragan!')], [$t('Aku {0}. Gajiku sudah lunas.', [b.name])]] });
      if (npc) { npc.working = b.job !== 'builder' && !hl; botNpcs.push({ key: key, npc: npc }); }
    });
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
      if (d.kind === 'townhall') openWin('hall', inOwnHome() ? $t('Balai Kota') : $t('Balai Kota · {0}', [hostName()]));
      else openWin('lot', KIND_NAME[d.kind] || $t('Bangunan'), d.lot);
      return true;
    }
    if (ctx.mode === 'talk') {
      var l = withinLot(t);
      if (l) {
        if (!loggedIn()) return true;
        openWin('lot', $t('Lahan {0}', [KIND_NAME[l.kind] || '']), l.id);
        return true;
      }
    }
    return false;
  }
  /* A small chip in the corner of the screen while in a Homeland: "Rumahku" for your own, "Dunia {name}" for someone else's. */
  function where() {
    var txt = '', guest = false;
    if (isHL(wid())) {
      if (mismatch() || (!inOwnHome() && !H)) txt = $t('Memuat…');
      else if (inOwnHome()) txt = $t('Rumahku');
      else { txt = $t('Dunia {0}', [hostName()]); guest = true; }
    }
    if (txt === whereTxt) return;
    whereTxt = txt;
    if (!txt) { if (whereEl) whereEl.style.display = 'none'; return; }
    if (!whereEl) {
      var screen = document.getElementById('screen');
      if (!screen) return;
      whereEl = $('div', 'hl-where'); whereEl.setAttribute('aria-live', 'polite'); screen.appendChild(whereEl);
    }
    whereEl.textContent = txt; whereEl.classList.toggle('guest', guest); whereEl.style.display = '';
  }
  function onFrame(dt) {
    var now = Date.now();
    for (var i = pops.length - 1; i >= 0; i--) { pops[i].t += dt; if (pops[i].t > 1.4) pops.splice(i, 1); }
    clockT += dt;
    where();
    if (mismatch() && now - lastSync > 3000 && C && S() && S().account && S().mode !== 'offline') { lastSync = now; C.refresh(true).then(function () { return load(true); }); }
    if (win && win.kind === 'hall' && clockT >= 1) { clockT = 0; redrawWin(); }
    pollT -= dt;
    if (pollT <= 0) {
      pollT = 4;
      if (C && S() && S().account && S().mode !== 'offline' && !travelling) load(true);
    }
    // a job just ran out: ask the server right away so the new building or chunk shows up
    if (V() && V().jobs && V().jobs.length && now - jobPing > 2500) {
      var due = V().jobs.some(function (j) { return endMs(j) <= now; });
      if (due) { jobPing = now; load(true); }
    }
    hintT -= dt; if (hintT > 0) return; hintT = 0.5;
    var n = nearPortal();
    if (n && !nearHint && !hintShown && S() && S().account && !GT.isUiOpen()) { hintShown = true; GT.toast($t('Portal: hadap portal lalu tekan {0} (atau tombol B) untuk bepergian.', [document.documentElement.classList.contains('gt-phone') ? 'A' : 'F'])); }
    nearHint = n;
  }
  function onWorld() {
    nearHint = nearPortal(); pops.length = 0; builder = null; builderSig = ''; botNpcs = []; botSig = '';
    if (isHL(wid())) { placeBuilder(); placeBots(); }
  }

  /* ---- drawing over the world ---- */
  function onDraw(ctx, camX, camY, T) {
    if (!GT.scene || GT.scene.kind !== 'out') return;
    var now = Date.now(), tt = now / 1000, p = portalPos(), L = layoutOf();
    ctx.save();
    if (p) { // portal shimmer
      var pa = GT.at(p.x, p.y), px = pa.x, py = pa.y, big = GT.world.bigPortal; // the village's portal is drawn larger (engine drawPortal)
      for (var k = 0; k < (big ? 6 : 3); k++) {
        var a = tt * 2.2 + k * 2.1, yy = py - 4 + ((tt * 6 + k * 4) % 12) * 0.7;
        if (big) yy = py + 12 + (yy - py - 12) * 1.6;
        ctx.fillStyle = 'rgba(228,220,255,' + (0.55 - (k % 3) * 0.12).toFixed(2) + ')';
        ctx.fillRect(Math.round(px + 6 + Math.sin(a) * 2.5 * (big ? 2.4 : 1) + (big ? (k % 2 ? 3 : -3) : 0)), Math.round(yy), 1, 2);
      }
    }
    if (isHL(wid()) && V() && L) {
      // "+n" over finished production
      V().built.forEach(function (b) {
        if (!(b.stored > 0)) return;
        var lot = lotById(b.lot); if (!lot) return;
        var la = GT.at(lot.x + lot.w / 2, lot.y), x = la.x, y = la.y - 3 + Math.sin(tt * 3 + lot.x) * 1.5;
        GT_THEME.label(ctx, '+' + b.stored, x, y + 5, { tone: b.stored >= b.capacity ? 'accent' : 'paper', size: 7, bold: true });
      });
      // hats (a sick worker's hat is drawn on the lying figure below); the owner's crew only
      if (inOwnHome()) {
      if (builder && !isSick(0)) drawHat(ctx, builder, H.workers && H.workers[0] && H.workers[0].cosmetic, camX, camY, T);
      botNpcs.forEach(function (q) { (H.bots || []).forEach(function (b) { if (q.key === 'homeland:bot:' + b.id && !isSick(b.id)) drawHat(ctx, q.npc, b.cosmetic, camX, camY, T); }); });
      // a collapsed contractor lies down under a blanket with a red cross over the head
      (H.workers || []).forEach(function (wk) {
        var n = wk.slot === 0 ? builder : null;
        if (wk.slot !== 0) botNpcs.forEach(function (q) { if (q.key === 'homeland:bot:' + wk.slot) n = q.npc; });
        if (!n) return;
        var sickNow = !!(wk.sick_until && endMs({ ends_at: wk.sick_until }) > now);
        if (n.hidden !== sickNow) GT.npcHide(n, sickNow); // the standing figure makes room for the one lying down
        if (!sickNow) return;
        n.working = false;
        var na = GT.at(n.x, n.y), sx = na.x, sy = na.y;
        ctx.fillStyle = '#2a2430'; ctx.fillRect(Math.round(sx - 1), Math.round(sy + 4), T + 2, 8);
        ctx.fillStyle = '#e8e4d8'; ctx.fillRect(Math.round(sx), Math.round(sy + 5), T, 6);
        ctx.fillStyle = '#7aa0d8'; ctx.fillRect(Math.round(sx + 5), Math.round(sy + 5), T - 5, 6);
        ctx.fillStyle = '#e8c8a0'; ctx.fillRect(Math.round(sx + 1), Math.round(sy + 6), 4, 4);
        var cy2 = Math.round(sy - 6 + Math.sin(tt * 2 + n.x) * 1);
        ctx.fillStyle = '#ffffff'; ctx.fillRect(Math.round(sx + T / 2 - 4), cy2 - 1, 8, 8);
        ctx.fillStyle = '#d83c3c'; ctx.fillRect(Math.round(sx + T / 2 - 1), cy2, 2, 6); ctx.fillRect(Math.round(sx + T / 2 - 3), cy2 + 2, 6, 2);
        drawHat(ctx, n, wk.cosmetic, camX, camY, T, true);
      });
      }
      // builder at work: hammer swing, sparks and the countdown over the target
      var f = jobFocus();
      if (f && builder) {
        var ba = GT.at(builder.x, builder.y), bx = ba.x + T / 2, by = ba.y + T / 2;
        var side = builder.dir === 'left' ? -1 : 1, ang = Math.sin(tt * 9) * 0.9 - 0.5;
        if (builder.dir === 'up' || builder.dir === 'down') side = 1;
        ctx.save();
        ctx.translate(bx + side * 4, by - 1); ctx.scale(side, 1); ctx.rotate(ang);
        ctx.fillStyle = '#6a4020'; ctx.fillRect(0, -5, 1, 6);
        ctx.fillStyle = '#9a96ac'; ctx.fillRect(-2, -7, 5, 3);
        ctx.fillStyle = '#d8d4e4'; ctx.fillRect(-2, -7, 5, 1);
        ctx.restore();
        if (Math.sin(tt * 9) > 0.8) { ctx.fillStyle = '#ffe066'; ctx.fillRect(Math.round(bx + side * 7), Math.round(by - 4), 1, 1); ctx.fillRect(Math.round(bx + side * 8), Math.round(by - 6), 1, 1); }
        var fa = GT.at(f.fx, f.fy), left = endMs(f.job) - now, lx = fa.x, ly = fa.y - (f.job.kind === 'th' ? 28 : 20);
        GT_THEME.label(ctx, clock(left), lx, ly + 5, { tone: 'paper', size: 7, bold: true });
      }
      pops.forEach(function (q) {
        ctx.globalAlpha = Math.max(0, 1 - q.t / 1.4);
        var qa = GT.at(q.x, q.y);
        GT_THEME.text(ctx, q.text, qa.x, qa.y - 8 - q.t * 14, GT_THEME.get('gold'), 8);
        ctx.globalAlpha = 1;
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
