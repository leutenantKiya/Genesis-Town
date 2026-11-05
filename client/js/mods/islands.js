/* islands.js - Private Islands on the client (docs/superpowers/specs/2026-11-06-islands-design.md). Talks to the engine
 * only through window.GT, and to the server through GT_CHAIN (signed requests, signedCall -> relayer).
 *
 *   Kantor Makelar   the second table: offers as cards (spec + price), "Beli" -> voucher -> signed buy_island
 *   Dermaga          face the dock (or press B within 2 tiles): Pulau Utama, Pulau-ku #N, a friend's island
 *   Papan pulau      the shelf in your island house: Kesuburan upgrade, Save World, invite list
 *   Tas              the island NFT (IS-<id>-<version>) under the item grid (GT_ISLANDS.bagSection, called by chain.js)
 *
 * All user-provided text (account names) is set with textContent / input.value, never innerHTML.
 */
(function () {
  'use strict';
  var C = null;                 // GT_CHAIN
  var I = { offers: [], mine: [], at: 0, loading: null, sel: null };
  var sailing = false, nearHint = false, hintT = 0;
  var win = null;               // the open broker / board window: { kind, h, arg }

  function $(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function btn(label, onClick, cls, disabled) {
    var b = $('button', 'mbtn' + (cls ? ' ' + cls : ''), label); b.type = 'button'; b.disabled = !!disabled;
    b.addEventListener('click', function (e) { e.currentTarget.blur(); onClick(e); });
    return b;
  }
  function S() { return C && C.state; }
  function wid() { return (GT.worldId && GT.worldId()) || 'public'; }
  function isIsland(w) { return /^IS-\d+$/.test(w); }
  function idOf(w) { return +String(w).slice(3); }
  function itemName(t) {
    if (t === 'coin') return 'Koin';
    var c = S() && S().cfg && S().cfg.econ && S().cfg.econ.items[t];
    return c ? c.name : t;
  }
  function have(t) { var b = S() && S().st && S().st.bag && S().st.bag[t]; return b ? b.settled + b.today : 0; }
  function mineById(id) { for (var i = 0; i < I.mine.length; i++) if (I.mine[i].island_id === id) return I.mine[i]; return null; }
  function offerName(id) { var m = mineById(id); return m ? m.name : 'Pulau #' + id; }
  function specLine(sp) { var plots = { 1: 6, 2: 9, 3: 12 }[sp.size_level] || 6; return 'Luas ' + sp.size_level + ' (' + plots + ' petak) · Kesuburan ' + sp.fertility_level; }
  function same(a, b) { return a.size_level === b.size_level && a.fertility_level === b.fertility_level; }
  function loggedIn() {
    if (!C || !S() || S().mode === 'offline') { GT.toast('Pulau butuh server game.'); return false; }
    if (!S().account) { GT.toast('Masuk dulu (tombol Masuk).'); return false; }
    return true;
  }

  /* ------------------------------------------------------------ data */
  function load(force) {
    if (!C || !S() || !S().account || S().mode === 'offline') return Promise.resolve(I);
    if (I.loading) return I.loading;
    if (!force && Date.now() - I.at < 2500) return Promise.resolve(I);
    I.loading = C.api('/islands').then(function (r) { I.offers = r.offers || []; I.mine = r.mine || []; I.at = Date.now(); }, function () { /* keep the old numbers */ })
      .then(function () { I.loading = null; redrawWin(); return I; });
    return I.loading;
  }
  function afterChange() { return load(true).then(function () { return C.refresh(true); }); }

  /* A tiny picture of an island for the cards: sea, a green disc (bigger with Luas), flowers with Kesuburan. */
  function icon(size_level, fert, px) {
    var c = $('canvas'); c.width = 16; c.height = 16; c.style.width = c.style.height = px + 'px'; c.style.imageRendering = 'pixelated';
    var g = c.getContext('2d');
    g.fillStyle = '#3d7fc2'; g.fillRect(0, 0, 16, 16);
    g.fillStyle = '#58a0dc'; g.fillRect(1, 3, 3, 1); g.fillRect(11, 13, 3, 1);
    var r = 3 + (size_level || 1) * 1.6, x, y;
    for (y = 0; y < 16; y++) for (x = 0; x < 16; x++) {
      var d = Math.sqrt((x - 7.5) * (x - 7.5) + (y - 8) * (y - 8) * 1.2);
      if (d < r + 1) { g.fillStyle = '#e8d8a0'; g.fillRect(x, y, 1, 1); }
      if (d < r) { g.fillStyle = '#5fae36'; g.fillRect(x, y, 1, 1); }
    }
    g.fillStyle = '#2f7d3a'; g.fillRect(6, 6, 2, 3); g.fillStyle = '#8a5a2b'; g.fillRect(6, 9, 2, 1);
    g.fillStyle = '#ffe066'; for (var f = 0; f < Math.min(5, fert || 1); f++) g.fillRect(4 + f * 2, 11 + (f & 1), 1, 1);
    return c;
  }
  function card(o) {
    var b = $('button', 'gt-card' + (o.sel ? ' sel' : '') + (o.off ? ' off' : '')); b.type = 'button';
    b.appendChild(icon(o.spec.size_level, o.spec.fertility_level, 32));
    b.appendChild($('span', 'gt-card-name', o.name));
    if (o.l1) b.appendChild($('span', 'gt-card-l1', o.l1));
    if (o.l2) b.appendChild($('span', 'gt-card-l2', o.l2));
    b.addEventListener('click', function (e) { e.currentTarget.blur(); o.onClick(); });
    return b;
  }

  /* ------------------------------------------------------------ windows */
  function openWin(kind, title, arg) {
    if (win && win.h && win.h.isOpen()) win.h.close('switch');
    win = { kind: kind, arg: arg, h: null };
    win.h = GT.modal({ title: title, wide: true, body: bodyFor(win), onClose: function () { win = null; } });
    load(true);
  }
  function bodyFor(w) { return w.kind === 'broker' ? brokerBody() : boardBody(w.arg); }
  function redrawWin() { if (win && win.h && win.h.isOpen()) win.h.setBody(bodyFor(win)); }

  /* ---- Kantor Makelar ---- */
  function brokerBody() {
    var wrap = $('div', 'gt-isl');
    var coin = S() && S().st && S().st.bag && S().st.bag.coin;
    var head = $('div', 'gt-shop-head');
    head.appendChild($('span', null, 'Makelar Pulau · koin di rantai ' + (coin ? coin.settled : 0)));
    head.appendChild($('span', 'chain-dim', 'Membeli memakai koin yang sudah tersimpan'));
    wrap.appendChild(head);
    if (!I.at) { wrap.appendChild($('p', null, 'Memuat…')); return wrap; }
    if (!I.offers.length) { wrap.appendChild($('p', null, 'Semua pulau sudah terjual. Tunggu pemilik menjualnya di Pasar.')); return wrap; }
    var sel = null;
    I.offers.forEach(function (o) { if (o.island_id === I.sel) sel = o; });
    if (!sel) sel = I.offers[0];
    var grid = $('div', 'gt-grid');
    I.offers.forEach(function (o) {
      grid.appendChild(card({ name: o.name, spec: o.spec, sel: o === sel, l1: o.price + ' koin', l2: 'Luas ' + o.spec.size_level + ' · Subur ' + o.spec.fertility_level, onClick: function () { I.sel = o.island_id; redrawWin(); } }));
    });
    wrap.appendChild(grid);
    var box = $('div', 'gt-detail'), top = $('div', 'gt-detail-top');
    top.appendChild(icon(sel.spec.size_level, sel.spec.fertility_level, 40));
    var txt = $('div', 'grow');
    txt.appendChild($('div', 'gt-detail-name', sel.name + ' · Pulau #' + sel.island_id));
    txt.appendChild($('div', null, specLine(sel.spec) + '. Rumah, kebun berpagar, batu, pohon, kolam dan dermaga sendiri.'));
    txt.appendChild($('div', 'chain-dim', 'Harga ' + sel.price + ' koin. Setelah dibeli kamu menerima pulau sebagai NFT IS-' + sel.island_id + '-1; koinnya dibakar, bukan disimpan makelar.'));
    top.appendChild(txt); box.appendChild(top);
    var acts = $('div', 'gt-detail-acts');
    acts.appendChild(btn('Beli · ' + sel.price + ' koin', function () { buy(sel); }, 'primary', !!(win && win.busy)));
    box.appendChild(acts);
    wrap.appendChild(box);
    wrap.appendChild($('p', 'chain-dim', 'Hasil kerja hari ini baru bisa dipakai membeli setelah settlement pukul 06:00.'));
    return wrap;
  }
  function buy(o) {
    if (!loggedIn() || (win && win.busy)) return;
    if (win) win.busy = true; redrawWin();
    GT.toast('Menyiapkan surat jual-beli…');
    var done = function () { if (win) win.busy = false; redrawWin(); };
    C.api('/islands/voucher', { method: 'POST', body: { kind: 'buy', island_id: o.island_id } })
      .then(function (v) { GT.toast('Menandatangani pembelian…'); return C._signedCall(v.method, v.args); })
      .then(function () { return afterChange(); })
      .then(function () { GT.toast('Selamat! ' + o.name + ' sekarang milikmu (IS-' + o.island_id + '-1). Berlayarlah dari dermaga.'); }, function (e) { GT.toast('Gagal: ' + (e && e.message || e)); })
      .then(done, done);
  }

  /* ---- island board (shelf in your island house) ---- */
  function costLine(cost) {
    return Object.keys(cost).map(function (t) { return cost[t] + ' ' + itemName(t); }).join(' + ');
  }
  function boardBody(id) {
    var wrap = $('div', 'gt-isl'), m = mineById(id);
    if (!m) { wrap.appendChild($('p', null, I.at ? 'Pulau ini tidak ada di akunmu.' : 'Memuat…')); return wrap; }
    var head = $('div', 'gt-shop-head');
    head.appendChild($('span', null, m.name + ' · Pulau #' + m.island_id));
    head.appendChild($('span', 'chain-dim', 'NFT ' + m.token_id));
    wrap.appendChild(head);

    // Kesuburan
    var box = $('div', 'gt-detail'), top = $('div', 'gt-detail-top');
    top.appendChild(icon(m.live.size_level, m.live.fertility_level, 40));
    var txt = $('div', 'grow');
    txt.appendChild($('div', 'gt-detail-name', 'Kesuburan Tanah · tingkat ' + m.live.fertility_level));
    txt.appendChild($('div', null, 'Tanah subur membuat tanaman tumbuh lebih cepat dan hasil panen lebih banyak. ' + specLine(m.live) + '.'));
    var n = m.next;
    if (!n) txt.appendChild($('div', 'chain-dim', 'Sudah di tingkat tertinggi.'));
    else if (n.locked) txt.appendChild($('div', 'chain-dim', 'Tingkat ' + n.level + ' terkunci: butuh Permata dari tambang (' + costLine(n.cost) + ').'));
    else {
      var short = Object.keys(n.cost).filter(function (t) { return have(t) < n.cost[t]; });
      txt.appendChild($('div', 'chain-dim', 'Tingkat ' + n.level + ': ' + costLine(n.cost) + (short.length ? ' · kurang ' + short.map(itemName).join(', ') : '') + '. Berlaku langsung.'));
    }
    top.appendChild(txt); box.appendChild(top);
    var acts = $('div', 'gt-detail-acts');
    acts.appendChild(btn('Tingkatkan', function () { upgrade(m); }, 'primary', !n || !!n.locked || !!(win && win.busy)));
    box.appendChild(acts);
    wrap.appendChild(box);

    // Save World
    var sv = $('div', 'gt-detail'), sTop = $('div', 'gt-detail-top'), sTxt = $('div', 'grow');
    var canSave = !same(m.savable, m.saved);
    sTxt.appendChild($('div', 'gt-detail-name', 'Save World'));
    sTxt.appendChild($('div', null, 'Menyimpan pulau ke rantai: NFT ' + m.token_id + ' ditukar dengan IS-' + m.island_id + '-' + (m.version + 1) + '.'));
    if (canSave) sTxt.appendChild($('div', null, 'Akan disimpan: Kesuburan ' + m.saved.fertility_level + ' → ' + m.savable.fertility_level + (m.savable.size_level !== m.saved.size_level ? ', Luas ' + m.saved.size_level + ' → ' + m.savable.size_level : '') + '.'));
    m.pending.forEach(function (p) {
      sTxt.appendChild($('div', 'chain-dim', (p.attr === 'fertility' ? 'Kesuburan' : p.attr) + ' ' + p.level + ': ' + (p.waitingSettlement ? 'lunas setelah settlement 06:00' : 'sudah lunas, siap disimpan')));
    });
    if (!canSave && !m.pending.length) sTxt.appendChild($('div', 'chain-dim', 'Belum ada peningkatan yang perlu disimpan.'));
    else if (!canSave) sTxt.appendChild($('div', 'chain-dim', 'Belum ada yang bisa disimpan sekarang.'));
    sTop.appendChild(sTxt); sv.appendChild(sTop);
    var sActs = $('div', 'gt-detail-acts');
    sActs.appendChild(btn('Save World', function () { saveWorld(m); }, 'primary', !canSave || !!(win && win.busy)));
    sv.appendChild(sActs);
    wrap.appendChild(sv);

    // invites
    var iv = $('div', 'gt-detail');
    iv.appendChild($('div', 'gt-detail-name', 'Undangan'));
    iv.appendChild($('div', 'chain-dim', 'Hanya kamu dan tamu undangan yang boleh datang. Isi nama akun, pisahkan dengan koma. Teman mengetik nomor pulaumu (#' + m.island_id + ') di dermaga.'));
    var input = $('input'); input.type = 'text'; input.maxLength = 400; input.placeholder = 'akun1.players.testnet, akun2.players.testnet'; input.value = (m.invite || []).join(', ');
    input.style.width = '100%'; input.autocomplete = 'off';
    iv.appendChild(input);
    var iAct = $('div', 'gt-detail-acts');
    iAct.appendChild(btn('Simpan undangan', function () {
      var list = String(input.value || '').split(/[\s,;]+/).map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean);
      for (var i = 0; i < list.length; i++) if (!/^[a-z0-9._-]{2,64}$/.test(list[i])) { GT.toast('Nama akun tidak valid: ' + list[i].slice(0, 30)); return; }
      C.api('/islands/invite', { method: 'POST', body: { island_id: m.island_id, accounts: list } })
        .then(function (r) { GT.toast('Undangan tersimpan (' + (r.invite || []).length + ' tamu).'); return load(true); }, function (e) { GT.toast('Gagal: ' + e.message); });
    }));
    iv.appendChild(iAct);
    wrap.appendChild(iv);
    return wrap;
  }
  function upgrade(m) {
    if (!loggedIn() || (win && win.busy)) return;
    if (wid() !== 'IS-' + m.island_id) { GT.toast('Tingkatkan pulaumu dari papan di pulaumu sendiri.'); return; }
    if (win) win.busy = true; redrawWin();
    var done = function () { if (win) win.busy = false; redrawWin(); };
    C.act({ action: 'island_upgrade', island_id: m.island_id, attr: 'fertility', world: 'IS-' + m.island_id })
      .then(function () { return load(true); }, function () { /* act() already toasted the reason */ })
      .then(done, done);
  }
  function saveWorld(m) {
    if (!loggedIn() || (win && win.busy)) return;
    if (win) win.busy = true; redrawWin();
    var done = function () { if (win) win.busy = false; redrawWin(); };
    GT.toast('Menyiapkan surat simpan…');
    C.api('/islands/voucher', { method: 'POST', body: { kind: 'save', island_id: m.island_id } })
      .then(function (v) { GT.toast('Menandatangani…'); return C._signedCall(v.method, v.args); })
      .then(function () { return afterChange(); })
      .then(function () { var nm = mineById(m.island_id); GT.toast('Pulau tersimpan di rantai: ' + (nm ? nm.token_id : 'versi baru') + '.'); }, function (e) { GT.toast('Gagal: ' + (e && e.message || e)); })
      .then(done, done);
  }

  /* ------------------------------------------------------------ the dock: sailing */
  function dock() { var w = GT.world; return w && w.dock || null; }
  function nearDock() {
    var d = dock(), p = GT.player;
    return !!(d && GT.scene && GT.scene.kind === 'out' && Math.abs(p.x - d.x) + Math.abs(p.y - d.y) <= 2);
  }
  function openDock() {
    if (sailing || !loggedIn()) return;
    if (!nearDock()) { GT.toast('Pergi ke dermaga dulu.'); return; }
    load(true).then(function () {
      var cur = wid(), opts = [];
      if (cur !== 'public') opts.push({ label: 'Pulau Utama (desa)', onPick: function () { sail('public'); } });
      I.mine.forEach(function (m) {
        if (cur === 'IS-' + m.island_id) return;
        opts.push({ label: 'Pulau-ku #' + m.island_id + ' · ' + m.name, onPick: function () { sail('IS-' + m.island_id); } });
      });
      opts.push({ label: 'Pulau teman…', onPick: askFriendIsland });
      GT.menu('Dermaga · mau berlayar ke mana?', opts);
    });
  }
  function askFriendIsland() {
    var body = $('div');
    body.appendChild($('p', null, 'Ketik nomor pulau temanmu (contoh: 3). Kamu hanya bisa masuk kalau pemiliknya mengundangmu.'));
    var input = $('input'); input.type = 'text'; input.inputMode = 'numeric'; input.maxLength = 6; input.placeholder = 'Nomor pulau'; input.autocomplete = 'off';
    body.appendChild(input);
    GT.modal({ title: 'Pulau teman', body: body, actions: [{ label: 'Berlayar', primary: true, onClick: function (h) {
      var n = parseInt(String(input.value).replace(/^#/, ''), 10);
      if (!(n >= 1)) { GT.toast('Nomor pulau tidak valid.'); return false; }
      h.close('ok'); sail('IS-' + n); return true;
    } }] });
    setTimeout(function () { input.focus(); }, 50);
  }
  function sail(to) {
    if (sailing) return;
    sailing = true;
    var from = wid(), layoutP;
    if (to === 'public') layoutP = Promise.resolve(null);
    else layoutP = C.api('/islands/layout?island_id=' + idOf(to)).then(function (r) { return GTIsland.generate(r.seed, r.spec); });
    layoutP.then(function (L) {
      GT.toast('Berlayar…');
      return C.act({ action: 'travel', to: to, world: from }, true).catch(function (e) { e.shown = true; throw e; }).then(function (r) {
        if (!GT.switchWorld(r.world, L)) throw new Error('Peta pulau tidak bisa dibuat.');
        GT.teleportPlayer('out', r.arrive.x, r.arrive.y, 'down');
        nearHint = true; GT.toast(r.toast);
        if (window.GT_PRESENCE) GT_PRESENCE.refresh();
        return C.refresh(true);
      });
    }).catch(function (e) { if (!(e && e.shown)) GT.toast(e && e.message || 'Gagal berlayar.'); }).then(function () { sailing = false; });
  }

  /* ------------------------------------------------------------ Tas: the island NFT */
  function lastTx(id) {
    var rows = (S() && S().history) || [], best = null, re = new RegExp('Pulau Pribadi #' + id + '(\\D|$)');
    rows.forEach(function (h) {
      if (!h.tx_hash || !re.test(String(h.summary || ''))) return;
      if (!best || new Date(h.created_at) > new Date(best.created_at)) best = h;
    });
    return best;
  }
  function bagSection() {
    if (!S() || !S().account || S().mode === 'offline') return null;
    if (!I.loading && Date.now() - I.at > 4000) load(true).then(function () { if (S().modal && S().modal.kind === 'bag') C.refresh(false); });
    if (!I.mine.length) return null;
    var wrap = $('div', 'gt-isl-bag');
    wrap.appendChild($('h4', 'gt-hist-day', 'Pulau Pribadi'));
    I.mine.forEach(function (m) {
      var box = $('div', 'gt-detail'), top = $('div', 'gt-detail-top');
      top.appendChild(icon(m.saved.size_level, m.saved.fertility_level, 40));
      var txt = $('div', 'grow');
      txt.appendChild($('div', 'gt-detail-name', m.name + ' · ' + m.token_id));
      txt.appendChild($('div', null, specLine(m.saved) + ' (tersimpan di rantai).'));
      var waiting = m.pending.length;
      txt.appendChild($('div', 'chain-dim', waiting ? waiting + ' peningkatan belum disimpan: buka Papan pulau di rumah pulaumu, lalu Save World.' : 'Semua peningkatan sudah tersimpan.'));
      var tx = lastTx(m.island_id);
      if (tx && S().mode === 'testnet' && S().cfg.explorerTxUrl) {
        var a = $('a', 'chain-link', 'Detail ↗'); a.href = S().cfg.explorerTxUrl + encodeURIComponent(tx.tx_hash); a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.title = 'Transaksi terakhir pulau ini (NEAR explorer)';
        txt.appendChild(a);
      }
      top.appendChild(txt); box.appendChild(top);
      wrap.appendChild(box);
    });
    return wrap;
  }

  /* ------------------------------------------------------------ engine hooks */
  function onInteract(ctx) {
    if (ctx.mode !== 'talk' || ctx.npc || ctx.door) return false;
    var sc = ctx.scene, map = sc && sc.map, t = ctx.tile;
    if (sc.kind === 'out') {
      var d = dock();
      if (d && t.x === d.x && t.y === d.y) { openDock(); return true; }
      return false;
    }
    if (map && map.board2 && sc.house && sc.house.kind === 'broker' && t.x === map.board2.x && t.y === map.board2.y) {
      if (!loggedIn()) return true;
      openWin('broker', 'Makelar Pulau');
      return true;
    }
    if (map && map.islandBoard && t.x === map.islandBoard.x && t.y === map.islandBoard.y && isIsland(wid())) {
      if (!loggedIn()) return true;
      openWin('board', 'Papan Pulau', idOf(wid()));
      return true;
    }
    return false;
  }
  function onFrame(dt) {
    hintT -= dt; if (hintT > 0) return; hintT = 0.5;
    var n = nearDock();
    if (n && !nearHint && S() && S().account && !GT.isUiOpen()) GT.toast('Dermaga: hadap dermaga lalu tekan ' + (document.documentElement.classList.contains('gt-phone') ? 'A' : 'F') + ' (atau tombol B) untuk berlayar.');
    nearHint = n;
  }
  function onWorld() { nearHint = nearDock(); }

  function init() {
    C = window.GT_CHAIN || null;
    GT.hotkey('B', function () { openDock(); });
    window.GT_ISLANDS = { bagSection: bagSection, open: openDock, state: I, sail: sail, refresh: function () { return load(true); } };
  }
  GT.register({ id: 'islands', init: init, onInteract: onInteract, onFrame: onFrame, onWorld: onWorld });
})();
