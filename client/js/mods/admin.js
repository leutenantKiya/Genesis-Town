/*
 * admin.js - the Admin window (server: /api/admin/*, accounts listed in ADMIN_ACCOUNTS). Reached from "Lainnya" when
 * /api/state says admin: true, or by opening the page /admin (the normal game page: this mod opens the window after login;
 * a signed-in non-admin only gets a short "admins only" note). The server checks the account on every call, so the window
 * is only a convenience.
 * Tab "Kas kota": the town treasury (books and chain), "send coin to a player" in one flow (search -> confirmation card ->
 * amount with the limits shown -> note -> Send -> result inline), and the recent grants.
 * Tab "Akun": every account with a wallet (GET /api/admin/accounts), grouped Admin / Pemain / NPC, filtered by part of a
 * name as you type; a row opens its wallet (GET /api/admin/wallet): each token in the game books and on chain.
 * Tab "Bot warga": the townsfolk's shared wallet (adminbots.ts): balance, coin in (treasury, faucet) and out (per merchant,
 * per resident), pause the shopping, the merchants each resident may buy from, and "Lacak uang": any account's coin by
 * counterpart, a click following it one hop further.
 * Tab "Keamanan": guests online (Kick / Ban IP), banned addresses, frozen accounts, settlement status, and the purge of old
 * NEAR Auth accounts (POST /api/admin/purge-legacy: Dry run -> list with checkboxes -> Delete selected after typing the
 * confirmation word; the server only deletes accounts that are on a fresh dry-run list).
 */
(function () {
  'use strict';
  var GT = window.GT, C = null;
  var panel = null, timer = 0, tab = 'coin', wantPage = location.pathname === '/admin';
  var guests = [], bans = [], frozen = [], status = null;
  var F = { input: '', who: null, err: '', amount: '', note: '', busy: false, result: null };
  var PG = { rows: null, info: null, sel: {}, word: '', busy: false, msg: '' }; // the purge of old NEAR Auth accounts
  var ui = {};
  var AC = { q: '', rows: null, total: 0, wallet: null, t: 0 }; // the Akun tab
  var SG = { rows: [], t: 0 }; // name suggestions under the "Kirim koin" search
  var BT = { days: 1, data: null, seq: 0 }, TR = { account: '', days: 1, data: null, path: [] }; // the Bot warga tab
  function whoName(w) { return (w.nick || w.name || w.account) + (w.tag ? '#' + w.tag : ''); }

  function $(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function st() { return C && C.state && C.state.st; }
  function isAdmin() { var s = st(); return !!(s && s.admin); }
  function fail(e) { GT.toast((e && e.message) || $t('Gagal.')); }
  function post(path, body) { return C.api(path, { method: 'POST', body: body || {} }); }
  function ago(ms) { var s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 90 ? s + 's' : Math.round(s / 60) + 'm'; }
  function num(n) { return Number(n || 0).toLocaleString(); }
  function btn(label, fn, cls) { var b = $('button', 'mbtn' + (cls ? ' ' + cls : ''), label); b.type = 'button'; b.addEventListener('click', fn); return b; }
  function when(ms) { try { return new Date(ms).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }

  /* ---------------------------------------------------------------- the limits that apply to one send */
  function limits() { return (status && status.grantLimits) || (st() && st().grantLimits) || {}; }
  function treasury() { return status ? status.treasury : (st() && st().treasury) || 0; }
  // the most this admin can send right now: per grant, left today, what the town holds, what the receiver can still gain today
  function maxNow() {
    var l = limits(), m = Infinity;
    if (l.maxPerGrant) m = Math.min(m, l.maxPerGrant);
    if (l.maxPerDay) m = Math.min(m, Math.max(0, l.maxPerDay - (l.sentToday || 0)));
    m = Math.min(m, treasury());
    if (F.who && F.who.gainLeft != null) m = Math.min(m, F.who.gainLeft);
    return isFinite(m) ? Math.max(0, m) : 0;
  }
  function amountOk() { var n = Number(F.amount); return F.amount !== '' && n >= 1 && n === Math.floor(n) && n <= maxNow(); }

  /* ---------------------------------------------------------------- "send coin" flow */
  function lookCanvas(look) {
    var cv = $('canvas', 'adm-look'); cv.width = 16; cv.height = 20;
    try { var g = cv.getContext('2d'); GT.drawChar(g, 0, 2, look | 0, 'down', 0); } catch (e) { /* the avatar is only decoration */ }
    return cv;
  }
  function find() {
    var v = F.input.trim();
    if (!v || F.busy) return;
    F.result = null;
    C.api('/admin/resolve?name=' + encodeURIComponent(v)).then(function (r) { F.who = r; F.err = ''; syncForm(); ui.amount && ui.amount.focus(); },
      function (e) { F.who = null; F.err = e.status === 404 ? $t('Pemain tidak ditemukan.') : (e.message || $t('Gagal.')); syncForm(); });
  }
  // part of a name is enough: matching players and merchants show under the field; a pick fills the confirmation card
  function suggestSoon() {
    clearTimeout(SG.t);
    var q = F.input.trim();
    if (!q || F.who) { SG.rows = []; renderSugg(); return; }
    SG.t = setTimeout(function () {
      C.api('/admin/accounts?q=' + encodeURIComponent(q)).then(function (r) {
        if (F.input.trim() !== q || F.who) return;
        SG.rows = (r.rows || []).filter(function (x) { return x.name !== 'Town treasury'; }).slice(0, 8); renderSugg();
      }, function () { SG.rows = []; renderSugg(); });
    }, 250);
  }
  function renderSugg() {
    if (!ui.sugg) return;
    ui.sugg.textContent = '';
    if (F.who) return;
    SG.rows.forEach(function (x) {
      var b = $('button', 'adm-sugg-row'); b.type = 'button'; b.setAttribute('role', 'option');
      b.appendChild($('span', 'adm-sugg-n', whoName(x)));
      b.appendChild($('span', 'adm-role ' + x.role, roleWord(x.role)));
      b.appendChild($('span', 'chain-dim adm-sugg-a', x.account));
      b.addEventListener('click', function () { F.input = x.account; ui.search.value = whoName(x); SG.rows = []; renderSugg(); find(); });
      ui.sugg.appendChild(b);
    });
  }
  function roleWord(r) { return r === 'admin' ? $t('Admin') : r === 'npc' ? 'NPC' : $t('Pemain'); }

  /* ---------------------------------------------------------------- Akun: every wallet, by role */
  function loadAccounts() {
    var q = AC.q.trim();
    C.api('/admin/accounts' + (q ? '?q=' + encodeURIComponent(q) : '')).then(function (r) {
      if (AC.q.trim() !== q) return;
      AC.rows = r.rows || []; AC.total = r.total || 0; renderAccounts();
    }, fail);
  }
  function openWallet(account) {
    AC.wallet = { account: account, loading: true }; renderAccounts();
    C.api('/admin/wallet?account=' + encodeURIComponent(account)).then(function (w) { AC.wallet = w; renderAccounts(); },
      function (e) { AC.wallet = null; fail(e); renderAccounts(); });
  }
  function buildAccounts() {
    var box = $('div', 'adm-card');
    box.appendChild($('div', 'chain-h', $t('Semua akun')));
    box.appendChild($('p', 'chain-dim', $t('Setiap akun yang punya dompet di game: admin, pemain, dan NPC (pedagang dan kas kota). Ketik sebagian nama untuk menyaring, lalu klik akun untuk melihat isi dompetnya.')));
    var f = $('div', 'chain-field'), inp = $('input');
    inp.type = 'text'; inp.maxLength = 60; inp.placeholder = $t('Saring nama…'); inp.setAttribute('aria-label', $t('Saring nama'));
    inp.value = AC.q;
    inp.addEventListener('input', function () { AC.q = inp.value; clearTimeout(AC.t); AC.t = setTimeout(loadAccounts, 250); });
    f.appendChild(inp); box.appendChild(f);
    ui.acctWallet = $('div'); box.appendChild(ui.acctWallet);
    ui.acctList = $('div', 'adm-accts'); box.appendChild(ui.acctList);
    return box;
  }
  function renderAccounts() {
    if (!ui.acctList) return;
    // the open wallet, on top
    ui.acctWallet.textContent = '';
    var w = AC.wallet;
    if (w) {
      var wc = $('div', 'adm-wallet');
      var hd = $('div', 'adm-wallet-h');
      hd.appendChild($('b', 'gt-data', w.loading ? w.account : whoName(w)));
      if (w.role) hd.appendChild($('span', 'adm-role ' + w.role, roleWord(w.role)));
      if (!w.loading) hd.appendChild(btn($t('Lacak uang'), function () { tab = 'bots'; TR.path = []; showTab(); trace(w.account, false); if (ui.trace && ui.trace.scrollIntoView) ui.trace.scrollIntoView({ block: 'start' }); }));
      hd.appendChild(btn($t('Tutup'), function () { AC.wallet = null; renderAccounts(); }));
      wc.appendChild(hd);
      wc.appendChild($('div', 'chain-dim adm-sugg-a', w.account));
      if (w.loading) wc.appendChild($('p', 'chain-dim', $t('Memuat…')));
      else if (!w.items.length) wc.appendChild($('p', 'chain-dim', $t('Dompet kosong.')));
      else {
        var tb = $('div', 'adm-wtable');
        [$t('Barang'), $t('Di buku game'), $t('Di blockchain')].forEach(function (h) { tb.appendChild($('b', 'chain-dim', h)); });
        w.items.forEach(function (it) {
          tb.appendChild($('span', null, it.name));
          tb.appendChild($('span', 'gt-data', num(it.books)));
          tb.appendChild($('span', 'gt-data' + (it.books !== it.chain ? ' adm-diff' : ''), num(it.chain)));
        });
        wc.appendChild(tb);
        wc.appendChild($('p', 'chain-dim', $t('Buku game = tersimpan + gerakan hari ini. Blockchain = per settlement terakhir (06:00).')));
      }
      ui.acctWallet.appendChild(wc);
    }
    // the list in three sections
    ui.acctList.textContent = '';
    if (!AC.rows) { ui.acctList.appendChild($('p', 'chain-dim', $t('Memuat…'))); return; }
    if (!AC.rows.length) { ui.acctList.appendChild($('p', 'chain-dim', $t('Tidak ada akun dengan nama itu.'))); return; }
    [['admin', $t('Admin')], ['player', $t('Pemain')], ['npc', 'NPC']].forEach(function (sec) {
      var rows = AC.rows.filter(function (x) { return x.role === sec[0]; });
      if (!rows.length) return;
      ui.acctList.appendChild($('div', 'adm-step', sec[1] + ' (' + rows.length + ')'));
      rows.forEach(function (x) {
        var b = $('button', 'adm-acct' + (AC.wallet && AC.wallet.account === x.account ? ' on' : '')); b.type = 'button';
        b.appendChild($('span', 'adm-sugg-n', whoName(x) || x.account));
        b.appendChild($('span', 'gt-data', num(x.coin) + ' ' + $t('koin')));
        b.appendChild($('span', 'chain-dim adm-sugg-a', x.account));
        b.addEventListener('click', function () { openWallet(x.account); });
        ui.acctList.appendChild(b);
      });
    });
    if (AC.total > AC.rows.length) ui.acctList.appendChild($('p', 'chain-dim', $t('Menampilkan {0} dari {1}. Saring nama untuk mempersempit.', [AC.rows.length, AC.total])));
  }

  function send() {
    if (F.busy || !F.who || !amountOk()) return;
    var n = Number(F.amount), nick = whoName(F.who);
    F.busy = true; F.result = null; syncForm();
    C.api('/admin/grant', { method: 'POST', body: { to: F.who.account, coin: n, note: F.note.trim() || undefined } }).then(function (r) {
      F.busy = false;
      F.result = { ok: true, text: $t('{0} koin terkirim ke {1}. Kas kota sekarang {2} koin.', [num(r.coin), nick, num(r.treasury)]) };
      F.amount = ''; F.note = ''; ui.amount.value = ''; ui.note.value = '';
      if (status) { status.treasury = r.treasury; status.grantLimits = Object.assign({}, status.grantLimits, { sentToday: r.sentToday }); }
      F.who.gainLeft = Math.max(0, (F.who.gainLeft || 0) - r.coin);
      syncForm(); load(); if (C.refresh) C.refresh(true).then(function () {}, function () {});
    }, function (e) { F.busy = false; F.result = { ok: false, text: (e && e.message) || $t('Gagal.') }; syncForm(); });
  }
  function buildForm() {
    var box = $('div', 'adm-card');
    box.appendChild($('div', 'chain-h', $t('Kirim koin ke pemain')));
    box.appendChild($('p', 'chain-dim', $t('Koin pindah dari kas kota ke pemain dan tersimpan permanen pukul 06:00. Tidak ada koin baru dicetak.')));
    // 1 search
    box.appendChild($('div', 'adm-step', $t('1. Cari pemain')));
    var f = $('div', 'chain-field adm-find'), inp = $('input');
    inp.type = 'text'; inp.placeholder = $t('nama atau nama#tag'); inp.maxLength = 80; inp.setAttribute('aria-label', $t('Nama pemain'));
    inp.addEventListener('input', function () { F.input = inp.value; if (F.who || F.err) { F.who = null; F.err = ''; F.result = null; syncForm(); } suggestSoon(); });
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); find(); } });
    ui.search = inp; ui.find = btn($t('Cari'), find);
    f.appendChild(inp); f.appendChild(ui.find); box.appendChild(f);
    ui.sugg = $('div', 'adm-sugg'); ui.sugg.setAttribute('role', 'listbox'); box.appendChild(ui.sugg);
    ui.err = $('p', 'chain-closed'); box.appendChild(ui.err);
    // 2 confirmation card
    ui.who = $('div', 'adm-who'); box.appendChild(ui.who);
    // 3 amount
    ui.step3 = $('div'); box.appendChild(ui.step3);
    ui.step3.appendChild($('div', 'adm-step', $t('2. Jumlah koin')));
    var f2 = $('div', 'chain-field'), amt = $('input');
    amt.type = 'number'; amt.min = '1'; amt.step = '1'; amt.placeholder = $t('Jumlah koin'); amt.setAttribute('aria-label', $t('Jumlah koin'));
    amt.addEventListener('input', function () { F.amount = amt.value; F.result = null; syncForm(); });
    amt.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); send(); } });
    ui.amount = amt; f2.appendChild(amt);
    ui.quick = $('span', 'adm-quick'); f2.appendChild(ui.quick);
    ui.step3.appendChild(f2);
    ui.limits = $('p', 'chain-dim adm-limits'); ui.step3.appendChild(ui.limits);
    ui.step3.appendChild($('div', 'adm-step', $t('3. Catatan (boleh kosong)')));
    var f3 = $('div', 'chain-field'), note = $('input');
    note.type = 'text'; note.maxLength = 120; note.placeholder = $t('Catatan (boleh kosong)'); note.setAttribute('aria-label', $t('Catatan'));
    note.addEventListener('input', function () { F.note = note.value; });
    note.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); send(); } });
    ui.note = note; f3.appendChild(note); ui.step3.appendChild(f3);
    ui.go = btn($t('Kirim'), send, 'primary'); ui.step3.appendChild(ui.go);
    ui.result = $('p', 'adm-result'); box.appendChild(ui.result);
    return box;
  }
  function syncForm() {
    if (!ui.who) return;
    ui.search.disabled = F.busy; ui.find.disabled = F.busy;
    ui.err.textContent = F.err || '';
    ui.who.textContent = '';
    ui.step3.style.display = F.who ? '' : 'none';
    if (F.who) {
      ui.who.appendChild(lookCanvas(F.who.look));
      var tx = $('div', 'adm-who-t');
      tx.appendChild($('div', 'adm-who-n gt-data', whoName(F.who)));
      if (F.who.gainLeft != null) tx.appendChild($('div', 'chain-dim', $t('Bisa menerima {0} koin lagi hari ini (batas harian {1}).', [num(F.who.gainLeft), num(F.who.gainCap)])));
      ui.who.appendChild(tx);
      ui.who.appendChild(btn($t('Ganti'), function () { if (F.busy) return; F.who = null; F.err = ''; F.input = ''; ui.search.value = ''; F.result = null; syncForm(); ui.search.focus(); }));
    }
    var l = limits(), max = maxNow();
    ui.amount.disabled = F.busy; ui.note.disabled = F.busy;
    ui.amount.max = String(max || '');
    ui.quick.textContent = '';
    [100, 500, 1000].forEach(function (q) { if (q <= max) { var b = btn(String(q), function () { F.amount = String(q); ui.amount.value = F.amount; F.result = null; syncForm(); }); b.disabled = F.busy; ui.quick.appendChild(b); } });
    if (max > 0) { var mb = btn($t('Maks'), function () { F.amount = String(max); ui.amount.value = F.amount; F.result = null; syncForm(); }); mb.disabled = F.busy; ui.quick.appendChild(mb); }
    ui.limits.textContent = l.maxPerGrant
      ? $t('Maks {0} koin per kirim · sisa hari ini {1} dari {2} · kas kota {3}', [num(l.maxPerGrant), num(Math.max(0, (l.maxPerDay || 0) - (l.sentToday || 0))), num(l.maxPerDay), num(treasury())])
      : '';
    var n = Number(F.amount), name = F.who ? whoName(F.who) : '';
    ui.go.textContent = amountOk() ? $t('Kirim {0} koin ke {1}', [num(n), name]) : $t('Kirim');
    ui.go.disabled = !!(F.busy || !F.who || !amountOk());
    var over = F.who && F.amount !== '' && Number(F.amount) >= 1 && !amountOk();
    if (!F.result && over) ui.result.textContent = $t('Jumlah itu melewati batas yang berlaku sekarang (maks {0}).', [num(max)]);
    else ui.result.textContent = F.busy ? $t('Mengirim…') : F.result ? F.result.text : '';
    ui.result.className = 'adm-result' + (F.result ? (F.result.ok ? ' ok' : ' bad') : over ? ' bad' : '');
  }

  /* ---------------------------------------------------------------- treasury and recent grants */
  function renderTreasury() {
    if (!ui.treasury) return;
    var b = ui.treasury; b.textContent = '';
    b.appendChild($('div', 'chain-h', $t('Kas kota')));
    var rows = $('div', 'adm-grid');
    function cell(label, value, hint) { var c = $('div', 'adm-stat'); c.appendChild($('div', 'chain-dim', label)); c.appendChild($('div', 'adm-num gt-data', value)); if (hint) c.appendChild($('div', 'chain-dim', hint)); rows.appendChild(c); }
    var books = treasury(), chain = status ? status.treasuryChain : null;
    cell($t('Menurut buku game'), num(books) + ' ' + $t('koin'), $t('termasuk transaksi hari ini'));
    cell($t('Di blockchain'), chain == null ? '-' : num(chain) + ' ' + $t('koin'), chain == null ? $t('belum terbaca') : $t('sampai settlement terakhir'));
    b.appendChild(rows);
    if (chain != null && chain !== books) {
      var d = books - chain;
      b.appendChild($('p', 'chain-dim', $t('Selisih {0} koin: transaksi hari ini menunggu settlement pukul 06:00.', [(d > 0 ? '+' : '') + num(d)])));
    }
    if (status) b.appendChild($('p', 'chain-dim', $t('Settlement: hari {0} jam {1}, selesai sampai hari {2}', [status.day, status.hour, status.settledThrough])));
  }
  function renderGrants() {
    if (!ui.grants) return;
    var b = ui.grants; b.textContent = '';
    b.appendChild($('div', 'chain-h', $t('Kiriman terakhir')));
    var list = (status && status.grants) || [];
    if (!list.length) { b.appendChild($('p', 'chain-dim', $t('Belum ada kiriman.'))); return; }
    list.forEach(function (g) {
      var r = $('div', 'tr-lot'), tx = $('div', 'tr-lot-t');
      tx.appendChild($('div', 'tr-lot-n gt-data', '+' + num(g.coin) + ' → ' + g.toName));
      tx.appendChild($('div', 'chain-dim', when(g.at) + (g.note ? ' · ' + g.note : '')));
      r.appendChild(tx); b.appendChild(r);
    });
  }

  /* ---------------------------------------------------------------- security tab */
  function row(text, sub, buttons) {
    var r = $('div', 'tr-lot'), tx = $('div', 'tr-lot-t');
    tx.appendChild($('div', 'tr-lot-n gt-data', text)); if (sub) tx.appendChild($('div', 'chain-dim', sub));
    r.appendChild(tx);
    buttons.forEach(function (b) { r.appendChild(btn(b.label, b.fn)); });
    return r;
  }
  function renderSafety() {
    if (!ui.safety) return;
    var body = ui.safety; body.textContent = '';
    body.appendChild($('div', 'chain-dim', $t('Guest online: {0}', [guests.length])));
    if (!guests.length) body.appendChild($('div', 'chain-dim', $t('Tidak ada guest.')));
    guests.forEach(function (g) {
      body.appendChild(row(g.nick + ' · ' + g.ip, $t('masuk {0} lalu', [ago(g.since)]), [
        { label: $t('Kick'), fn: function () { post('/admin/kick', { guest: g.guest }).then(function (r) { guests = r.guests || []; GT.toast($t('Guest dikeluarkan.')); renderSafety(); }, fail); } },
        { label: $t('Ban IP'), fn: function () { post('/admin/ban', { ip: g.ip }).then(function (r) { bans = r.bans || []; guests = r.guests || []; GT.toast($t('IP diblokir.')); renderSafety(); }, fail); } }
      ]));
    });
    body.appendChild($('div', 'chain-dim', $t('IP yang diblokir: {0}', [bans.length])));
    bans.forEach(function (b) {
      body.appendChild(row(b.ip, b.note || '', [
        { label: $t('Buka blokir'), fn: function () { post('/admin/unban', { ip: b.ip }).then(function (r) { bans = r.bans || []; renderSafety(); }, fail); } }
      ]));
    });
    body.appendChild($('div', 'chain-dim', $t('Akun beku: {0}', [frozen.length])));
    frozen.forEach(function (f) {
      var what = f.items.map(function (i) { return i.token + ' ' + i.applied + '/' + i.wanted + ' (d' + i.day + ')'; }).join(', ');
      body.appendChild(row(f.account, what, [
        { label: $t('Lepas beku'), fn: function () { post('/admin/unfreeze', { account: f.account }).then(function () { GT.toast($t('Akun dilepas dari beku.')); load(); }, fail); } }
      ]));
    });
    if (status) {
      status.retry.forEach(function (r) { body.appendChild($('div', 'chain-dim', $t('Hari {0} gagal, coba lagi {1}s lagi', [r.day, r.inSeconds]))); });
      status.settlements.forEach(function (s) { body.appendChild($('div', 'chain-dim', 'd' + s.day + '/' + s.chunk + ' ' + s.status + (s.tx_hash ? ' ' + String(s.tx_hash).slice(0, 8) : ''))); });
    }
    body.appendChild($('div', 'chain-dim', $t('Jadi admin: isi ADMIN_ACCOUNTS=akun1,akun2 (id akun NEAR kamu) di .env dan di Railway Variables, lalu restart server.')));
  }

  /* ---------------------------------------------------------------- purge of old NEAR Auth accounts */
  function confirmWord() { return $t('HAPUS'); }
  function picked() { return (PG.rows || []).filter(function (r) { return PG.sel[r.account]; }); }
  function itemsText(items) { var k = Object.keys(items || {}); return k.length ? k.map(function (t) { return t + ' ' + items[t]; }).join(', ') : $t('tidak ada barang'); }
  function dryRun() {
    if (PG.busy) return;
    PG.busy = true; PG.msg = $t('Memeriksa semua akun…'); renderPurge();
    post('/admin/purge-legacy', { dryRun: true }).then(function (r) {
      PG.busy = false; PG.rows = r.accounts || []; PG.info = r; PG.sel = {}; PG.word = '';
      PG.msg = $t('{0} akun lama dari {1} diperiksa.', [PG.rows.length, r.checked]) + (r.unknown ? ' ' + $t('{0} tidak bisa diperiksa (jaringan).', [r.unknown]) : '');
      renderPurge();
    }, function (e) { PG.busy = false; PG.msg = (e && e.message) || $t('Gagal.'); renderPurge(); });
  }
  function doPurge() {
    var sel = picked();
    if (PG.busy || !sel.length || PG.word.trim() !== confirmWord()) return;
    PG.busy = true; PG.msg = $t('Menghapus…'); renderPurge();
    post('/admin/purge-legacy', { dryRun: false, accounts: sel.map(function (r) { return r.account; }) }).then(function (r) {
      PG.busy = false; PG.rows = null; PG.sel = {}; PG.word = '';
      PG.msg = $t('{0} akun dihapus. Jalankan dry run lagi untuk daftar terbaru.', [(r.purged || []).length]);
      renderPurge();
    }, function (e) { PG.busy = false; PG.msg = (e && e.message) || $t('Gagal.'); renderPurge(); });
  }
  function renderPurge() {
    if (!ui.purge) return;
    var b = ui.purge; b.textContent = '';
    b.appendChild($('div', 'chain-h', $t('Akun NEAR Auth lama')));
    b.appendChild($('p', 'chain-dim', $t('Akun yang kunci pemiliknya dibuat NEAR Auth publik, bukan NEAR Auth kita. Data game-nya dihapus; token di blockchain tetap. Mulai dengan dry run: tidak ada yang dihapus sebelum kamu memilih dan mengetik konfirmasi.')));
    var go = btn($t('Dry run'), dryRun); go.disabled = PG.busy; b.appendChild(go);
    if (PG.msg) b.appendChild($('p', 'chain-dim', PG.msg));
    if (PG.info && PG.info.settling) b.appendChild($('p', 'chain-closed', $t('Settlement sedang berjalan: penghapusan ditolak sampai selesai.')));
    if (!PG.rows) return;
    if (!PG.rows.length) { b.appendChild($('p', 'chain-dim', $t('Tidak ada akun lama.'))); return; }
    var all = btn($t('Pilih semua'), function () { PG.rows.forEach(function (r) { PG.sel[r.account] = true; }); renderPurge(); }); all.disabled = PG.busy;
    var none = btn($t('Kosongkan'), function () { PG.sel = {}; renderPurge(); }); none.disabled = PG.busy;
    b.appendChild(all); b.appendChild(none);
    PG.rows.forEach(function (r) {
      var line = $('label', 'tr-lot'), cb = $('input'), tx = $('div', 'tr-lot-t');
      cb.type = 'checkbox'; cb.checked = !!PG.sel[r.account]; cb.disabled = PG.busy;
      cb.addEventListener('change', function () { PG.sel[r.account] = cb.checked; renderPurge(); });
      tx.appendChild($('div', 'tr-lot-n gt-data', r.nameTag));
      tx.appendChild($('div', 'chain-dim', $t('terakhir masuk {0}', [when(r.lastSeen)]) + ' · ' + num(r.coin) + ' ' + $t('koin') + ' · ' + itemsText(r.items)));
      var extra = [];
      if (r.chips && (r.chips.bought || r.chips.won)) extra.push($t('chip {0} dibeli, {1} menang', [r.chips.bought, r.chips.won]));
      if (r.homeland) extra.push($t('Homeland TH{0}: {1} bangunan, {2} pekerja', [r.homeland.th, r.homeland.buildings, r.homeland.bots]));
      if (extra.length) tx.appendChild($('div', 'chain-dim', extra.join(' · ')));
      line.appendChild(cb); line.appendChild(tx); b.appendChild(line);
    });
    var n = picked().length;
    b.appendChild($('p', 'chain-dim', $t('Ketik {0} untuk mengonfirmasi penghapusan {1} akun terpilih.', [confirmWord(), n])));
    var f = $('div', 'chain-field'), inp = $('input');
    inp.type = 'text'; inp.value = PG.word; inp.maxLength = 12; inp.disabled = PG.busy; inp.setAttribute('aria-label', $t('Kata konfirmasi'));
    var del = btn($t('Hapus yang dipilih'), doPurge, 'primary');
    function sync() { del.disabled = !!(PG.busy || !n || PG.word.trim() !== confirmWord() || (PG.info && PG.info.settling)); }
    inp.addEventListener('input', function () { PG.word = inp.value; sync(); });
    sync(); f.appendChild(inp); f.appendChild(del); b.appendChild(f);
  }

  /* ---------------------------------------------------------------- Bot warga: the townsfolk's wallet (GET/POST /api/admin/bots)
     and "Lacak uang" (GET /api/admin/trace): where any account's coin came from and went, one hop at a time */
  var KINDS = { trade: $t('Jual-beli dengan pedagang'), resident_buy: $t('Belanja warga'), resident_sale: $t('Dibeli warga'), handout: $t('Uang saku warga'),
    handout_mint: $t('Koin baru (faucet)'), town_buy: $t('Permintaan kota (koin baru)'), starter: $t('Paket awal'), admin_grant: $t('Kiriman admin'),
    fee: $t('Biaya kerajinan'), mission: $t('Hadiah misi'), hire: $t('Sewa pekerja'), build: $t('Bangunan'), cosmetic: $t('Kosmetik') };
  function kindWord(k) { return KINDS[k] || (/^p2p/.test(k) ? $t('Tukar antar pemain') : k); }
  // every load is numbered: a save right after a 5 s refresh still reloads, and only the newest answer is drawn
  function botsLoad() {
    var n = ++BT.seq;
    C.api('/admin/bots?days=' + BT.days).then(function (r) { if (n === BT.seq) { BT.data = r; renderBots(); } }, function (e) { if (n === BT.seq) fail(e); });
  }
  function botsSet(body) { post('/admin/bots', body).then(function () { botsLoad(); }, fail); }
  function trace(account, push) {
    if (!account) return;
    if (push !== false && TR.account && TR.account !== account) TR.path.push(TR.account);
    TR.account = account; TR.data = { loading: true }; renderTrace(true);
    C.api('/admin/trace?account=' + encodeURIComponent(account) + '&days=' + TR.days).then(function (r) { if (TR.account === account) { TR.data = r; renderTrace(true); } },
      function (e) { TR.data = null; fail(e); renderTrace(true); });
  }
  function daysPick(cur, fn) {
    var row = $('div', 'adm-chips');
    [[1, $t('Hari ini')], [7, $t('7 hari')], [0, $t('Semua')]].forEach(function (d) {
      var b = btn(d[1], function () { fn(d[0]); }, 'adm-chip' + (cur === d[0] ? ' on' : '')); b.setAttribute('aria-pressed', cur === d[0] ? 'true' : 'false'); row.appendChild(b);
    });
    return row;
  }
  function stat(label, value, note) {
    var c = $('div', 'adm-stat'); c.appendChild($('div', 'chain-dim', label)); c.appendChild($('div', 'adm-num gt-data', value));
    if (note) c.appendChild($('div', 'chain-dim', note));
    return c;
  }
  function bar(part, top) { var b = $('span', 'adm-bar'), f = $('i'); f.style.width = Math.round(100 * part / Math.max(1, top)) + '%'; b.appendChild(f); return b; }
  function buildBots() {
    var v = $('div');
    ui.botsTop = $('div', 'adm-card'); v.appendChild(ui.botsTop);
    ui.botsPrice = $('div', 'adm-card'); v.appendChild(ui.botsPrice);
    ui.botsPeople = $('div', 'adm-card'); v.appendChild(ui.botsPeople);
    ui.botsShops = $('div', 'adm-card'); v.appendChild(ui.botsShops);
    ui.botsRecent = $('div', 'adm-card'); v.appendChild(ui.botsRecent);
    ui.trace = $('div', 'adm-card'); v.appendChild(ui.trace);
    return v;
  }
  // the town's price ceiling: a multiple of each good's base value; under it the townsfolk buy, above it they wait
  var WHY = { closed: $t('tutup'), withdrawn: $t('ditarik dari pasar'), empty: $t('stok habis'), expensive: $t('terlalu mahal'), blocked: $t('diblokir admin') };
  // the 5 s refresh must not rebuild a field the admin is typing in
  function typingIn(el) { var a = document.activeElement; return !!(el && a && a.tagName === 'INPUT' && el.contains(a)); }
  function renderPrice(d) {
    var el = ui.botsPrice; if (typingIn(el)) return;
    el.textContent = '';
    var p = d.price; if (!p) return;
    el.appendChild($('div', 'chain-h', $t('Batas harga kota')));
    el.appendChild($('p', 'chain-dim', $t('Warga hanya membeli kalau harga pedagang paling tinggi {0} x harga dasar barang. Naikkan kalau warga tidak belanja karena harga pasar naik; turunkan untuk menahan uang kas kota.', [p.mult])));
    var f = $('div', 'chain-field adm-find'), inp = $('input');
    inp.type = 'number'; inp.min = String(p.min); inp.max = String(p.max); inp.step = '0.1'; inp.value = String(p.mult); inp.setAttribute('aria-label', $t('Batas harga kota'));
    var save = function () {
      var n = Number(inp.value);
      if (!(n >= p.min && n <= p.max)) { GT.toast($t('Isi angka {0} sampai {1}.', [p.min, p.max])); return; }
      inp.blur(); botsSet({ maxPriceMult: n }); // blurred: the reload may redraw the card
    };
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') save(); });
    f.appendChild(inp); f.appendChild($('span', 'chain-dim', '× ' + $t('harga dasar')));
    f.appendChild(btn($t('Simpan'), save, 'primary'));
    if (p.mult !== p.default) f.appendChild(btn($t('Default ({0})', [p.default]), function () { botsSet({ maxPriceMult: null }); }));
    el.appendChild(f);
    var tb = $('div', 'adm-ptable');
    [$t('Barang'), $t('Dasar'), $t('Batas'), $t('Pedagang (harga, stok)')].forEach(function (h) { tb.appendChild($('b', 'chain-dim', h)); });
    p.goods.forEach(function (g) {
      tb.appendChild($('span', g.buys ? 'adm-in' : 'adm-out', (g.buys ? '✓ ' : '✕ ') + g.name));
      tb.appendChild($('span', 'gt-data', num(g.base)));
      tb.appendChild($('span', 'gt-data', num(g.ceiling)));
      var cell = $('span');
      g.offers.forEach(function (o, i) {
        if (i) cell.appendChild(document.createTextNode(' · '));
        cell.appendChild($('span', o.why ? 'chain-dim' : 'adm-in', o.name + ' ' + num(o.ask) + ' (' + num(o.stock) + ')' + (o.why ? ' ' + WHY[o.why] : '')));
      });
      tb.appendChild(cell);
    });
    el.appendChild(tb);
  }
  function renderBots() {
    if (!ui.botsTop) return;
    var d = BT.data;
    [ui.botsTop, ui.botsPeople, ui.botsShops, ui.botsRecent].forEach(function (el) { el.textContent = ''; });
    ui.botsTop.appendChild($('div', 'chain-h', $t('Dompet warga')));
    ui.botsTop.appendChild($('p', 'chain-dim', $t('Lima warga kota berbelanja dari satu dompet bersama. Dompet itu diisi dari kas kota (di atas cadangannya), lalu dari faucet koin baru kalau kas tidak cukup.')));
    if (!d) { ui.botsTop.appendChild($('p', 'chain-dim', $t('Memuat…'))); renderTrace(); return; }
    ui.botsTop.appendChild(daysPick(BT.days, function (n) { BT.days = n; botsLoad(); }));
    var g = $('div', 'adm-grid');
    g.appendChild(stat($t('Saldo dompet'), num(d.wallet.coin) + ' ' + $t('koin'), $t('Di blockchain: {0}', [num(d.wallet.chain)])));
    g.appendChild(stat($t('Dibelanjakan'), num(d.spent) + ' ' + $t('koin')));
    g.appendChild(stat($t('Dari kas kota'), num(d.inflow.treasury) + ' ' + $t('koin')));
    g.appendChild(stat($t('Koin baru (faucet)'), num(d.inflow.faucet) + ' ' + $t('koin')));
    ui.botsTop.appendChild(g);
    if (!d.wallet.ready) ui.botsTop.appendChild($('p', 'adm-result bad', $t('Dompet warga belum terdaftar di chain: kota masih membeli dengan koin baru langsung ke pedagang.')));
    var row = $('div', 'adm-wallet-h');
    row.appendChild($('b', d.paused ? 'adm-result bad' : 'adm-result ok', d.paused ? $t('Belanja warga dijeda') : $t('Warga berbelanja seperti biasa')));
    row.appendChild(btn(d.paused ? $t('Lanjutkan belanja') : $t('Jeda belanja'), function () { botsSet({ paused: !d.paused }); }, d.paused ? 'primary' : ''));
    row.appendChild(btn($t('Lacak dompet'), function () { TR.path = []; trace(d.wallet.account, false); }));
    ui.botsTop.appendChild(row);
    if (d.truncated) ui.botsTop.appendChild($('p', 'chain-dim', $t('Hanya {0} baris terbaru yang dihitung.', [num(d.scanned)])));
    renderPrice(d);

    // each resident: what they spent, the last buy, and the merchants they may buy from (a chip toggles one)
    ui.botsPeople.appendChild($('div', 'chain-h', $t('Warga dan lawan transaksinya')));
    ui.botsPeople.appendChild($('p', 'chain-dim', $t('Klik nama pedagang untuk mengizinkan atau melarang warga itu berbelanja di sana. Kota hanya membeli dari pedagang yang diizinkan untuk minimal satu warga.')));
    var mname = {}; d.merchants.forEach(function (m) { mname[m.id] = m.name; });
    d.residents.forEach(function (r) {
      var box = $('div', 'adm-bot'), hd = $('div', 'adm-who'), t = $('div', 'adm-who-t');
      hd.appendChild(lookCanvas(r.look));
      t.appendChild($('div', 'adm-who-n', r.name));
      t.appendChild($('div', 'chain-dim', $t('{0} koin untuk {1} barang', [num(r.spent), num(r.units)])));
      if (r.last) t.appendChild($('div', 'chain-dim', $t('Terakhir: {0} dari {1}, {2} koin ({3} lalu)', [r.last.token, mname[r.last.merchant] || r.last.merchant, num(r.last.coin), ago(r.last.at)])));
      hd.appendChild(t); box.appendChild(hd);
      var chips = $('div', 'adm-chips'), allow = r.allow;
      d.merchants.forEach(function (m) {
        var on = !allow || allow.indexOf(m.id) >= 0, spent = r.byMerchant[m.id] || 0;
        var b = btn(m.name + (spent ? ' · ' + num(spent) : ''), function () {
          var cur = allow ? allow.slice() : d.merchants.map(function (x) { return x.id; });
          var next = on ? cur.filter(function (x) { return x !== m.id; }) : cur.concat([m.id]);
          if (!next.length) { GT.toast($t('Sisakan minimal satu pedagang, atau pakai Jeda belanja.')); return; }
          botsSet({ resident: r.id, merchants: next });
        }, 'adm-chip' + (on ? ' on' : ''));
        b.setAttribute('aria-pressed', on ? 'true' : 'false'); b.title = on ? $t('Diizinkan: klik untuk melarang') : $t('Dilarang: klik untuk mengizinkan');
        chips.appendChild(b);
      });
      if (allow) chips.appendChild(btn($t('Semua'), function () { botsSet({ resident: r.id, merchants: null }); }));
      box.appendChild(chips);
      ui.botsPeople.appendChild(box);
    });

    // where the wallet's coin went: one bar per merchant (a click traces that merchant)
    ui.botsShops.appendChild($('div', 'chain-h', $t('Uang warga ke pedagang')));
    var top = Math.max.apply(null, d.merchants.map(function (m) { return m.coin; }).concat([1]));
    d.merchants.forEach(function (m) {
      var b = $('button', 'adm-flow'); b.type = 'button';
      b.appendChild($('span', 'adm-sugg-n', m.name + ' · ' + m.shop + (m.open ? '' : ' (' + $t('tutup') + ')')));
      b.appendChild($('span', 'gt-data', num(m.coin) + ' ' + $t('koin') + ' · ' + num(m.units) + 'x'));
      b.appendChild(bar(m.coin, top));
      b.addEventListener('click', function () { TR.path = []; trace(m.account, false); });
      ui.botsShops.appendChild(b);
    });

    ui.botsRecent.appendChild($('div', 'chain-h', $t('Gerakan terakhir')));
    if (!d.recent.length) ui.botsRecent.appendChild($('p', 'chain-dim', $t('Belum ada gerakan di periode ini.')));
    d.recent.forEach(function (x) {
      var line = $('div', 'adm-mv');
      line.appendChild($('span', 'chain-dim', ago(x.at)));
      line.appendChild($('span', null, x.kind === 'resident_buy' ? $t('{0} beli {1} dari {2}', [x.who, x.token, x.to]) : kindWord(x.kind) + (x.to ? ' · ' + x.to : '')));
      line.appendChild($('span', 'gt-data ' + (x.coin < 0 ? 'adm-out' : 'adm-in'), (x.coin > 0 ? '+' : '') + num(x.coin)));
      ui.botsRecent.appendChild(line);
    });
    renderTrace();
  }
  function flowList(title, rows, sign) {
    var box = $('div');
    box.appendChild($('div', 'adm-step', title));
    if (!rows.length) { box.appendChild($('p', 'chain-dim', $t('Tidak ada.'))); return box; }
    var top = rows[0].amount;
    rows.forEach(function (f) {
      var b = $('button', 'adm-flow'); b.type = 'button';
      b.appendChild($('span', 'adm-sugg-n', f.name));
      b.appendChild($('span', 'gt-data ' + (sign < 0 ? 'adm-out' : 'adm-in'), (sign < 0 ? '-' : '+') + num(f.amount)));
      b.appendChild($('span', 'chain-dim adm-sugg-a', kindWord(f.kind) + ' · ' + num(f.count) + 'x' + (f.account ? ' · ' + f.account : '')));
      b.appendChild(bar(f.amount, top));
      if (f.account) b.addEventListener('click', function () { trace(f.account); }); else b.disabled = true;
      box.appendChild(b);
    });
    return box;
  }
  function renderTrace(force) {
    if (!ui.trace || (!force && typingIn(ui.trace))) return;
    ui.trace.textContent = '';
    ui.trace.appendChild($('div', 'chain-h', $t('Lacak uang')));
    ui.trace.appendChild($('p', 'chain-dim', $t('Ke mana uang sebuah akun pergi dan dari mana datangnya, dikelompokkan per lawan transaksi. Klik baris untuk melacak akun itu. Hanya buku game: Pasar, hadiah, dan saham on-chain tidak termasuk.')));
    var f = $('div', 'chain-field adm-find'), inp = $('input');
    inp.type = 'text'; inp.maxLength = 100; inp.placeholder = $t('ID akun, mis. warga.…'); inp.setAttribute('aria-label', $t('ID akun'));
    inp.value = TR.account;
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { TR.path = []; trace(inp.value.trim(), false); } });
    f.appendChild(inp); f.appendChild(btn($t('Lacak'), function () { TR.path = []; trace(inp.value.trim(), false); }, 'primary'));
    ui.trace.appendChild(f);
    ui.trace.appendChild(daysPick(TR.days, function (n) { TR.days = n; if (TR.account) trace(TR.account, false); else renderTrace(); }));
    var t = TR.data;
    if (!t) return;
    if (t.loading) { ui.trace.appendChild($('p', 'chain-dim', $t('Memuat…'))); return; }
    var hd = $('div', 'adm-wallet-h');
    if (TR.path.length) hd.appendChild(btn('← ' + $t('Kembali'), function () { trace(TR.path.pop(), false); }));
    hd.appendChild($('b', 'gt-data', t.name));
    hd.appendChild($('span', 'gt-data', num(t.coin) + ' ' + $t('koin')));
    ui.trace.appendChild(hd);
    ui.trace.appendChild($('div', 'chain-dim adm-sugg-a', t.account));
    if (TR.path.length) ui.trace.appendChild($('div', 'chain-dim', $t('Jejak: {0}', [TR.path.concat([t.account]).map(function (a) { return a.split('.')[0]; }).join(' → ')])));
    var g = $('div', 'adm-grid');
    g.appendChild(stat($t('Uang masuk'), '+' + num(t.totalIn)));
    g.appendChild(stat($t('Uang keluar'), '-' + num(t.totalOut)));
    ui.trace.appendChild(g);
    ui.trace.appendChild(flowList($t('Masuk dari'), t.inflow, 1));
    ui.trace.appendChild(flowList($t('Keluar ke'), t.outflow, -1));
    if (t.truncated) ui.trace.appendChild($('p', 'chain-dim', $t('Hanya {0} baris terbaru yang dihitung.', [num(t.rows)])));
  }

  /* ---------------------------------------------------------------- the window */
  function showTab() {
    if (!ui.coinView) return;
    ui.coinView.style.display = tab === 'coin' ? '' : 'none';
    ui.safetyView.style.display = tab === 'safety' ? '' : 'none';
    ui.acctView.style.display = tab === 'acct' ? '' : 'none';
    ui.botsView.style.display = tab === 'bots' ? '' : 'none';
    if (tab === 'acct' && !AC.rows) loadAccounts();
    if (tab === 'bots' && !BT.data) botsLoad();
    [].forEach.call(ui.tabs.children, function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === tab); b.setAttribute('aria-selected', b.getAttribute('data-tab') === tab ? 'true' : 'false'); });
  }
  function build() {
    var root = $('div', 'adm');
    ui.tabs = $('div', 'gt-mall-tabs'); ui.tabs.setAttribute('role', 'tablist');
    [['coin', $t('Kas kota')], ['acct', $t('Akun')], ['bots', $t('Bot warga')], ['safety', $t('Keamanan')]].forEach(function (t) {
      var b = $('button', 'gt-mall-tab', t[1]); b.type = 'button'; b.setAttribute('role', 'tab'); b.setAttribute('data-tab', t[0]);
      b.addEventListener('click', function () { tab = t[0]; showTab(); });
      ui.tabs.appendChild(b);
    });
    root.appendChild(ui.tabs);
    ui.coinView = $('div');
    ui.treasury = $('div', 'adm-card'); ui.coinView.appendChild(ui.treasury);
    ui.coinView.appendChild(buildForm());
    ui.grants = $('div', 'adm-card'); ui.coinView.appendChild(ui.grants);
    root.appendChild(ui.coinView);
    ui.acctView = $('div'); ui.acctView.appendChild(buildAccounts()); root.appendChild(ui.acctView);
    ui.botsView = buildBots(); root.appendChild(ui.botsView);
    ui.safetyView = $('div'); root.appendChild(ui.safetyView);
    ui.safety = $('div', 'adm-card'); ui.safetyView.appendChild(ui.safety);
    ui.purge = $('div', 'adm-card'); ui.safetyView.appendChild(ui.purge);
    return root;
  }
  function renderAll() { renderTreasury(); renderGrants(); renderSafety(); renderPurge(); renderBots(); syncForm(); showTab(); }
  function load() {
    C.api('/admin/guests').then(function (r) { guests = r.guests || []; renderSafety(); }, fail);
    C.api('/admin/frozen').then(function (r) { frozen = r.frozen || []; renderSafety(); }, function () {});
    C.api('/admin/status').then(function (r) { status = r; renderTreasury(); renderGrants(); renderSafety(); syncForm(); }, function () {});
    C.api('/admin/bans').then(function (r) { bans = r.bans || []; renderSafety(); }, function () {});
    if (tab === 'bots') botsLoad(); // the trace reloads only on demand
  }
  function open() {
    if (!isAdmin()) return;
    if (panel && panel.isOpen()) return;
    if (GT.isUiOpen()) return;
    F = { input: '', who: null, err: '', amount: '', note: '', busy: false, result: null };
    PG = { rows: null, info: null, sel: {}, word: '', busy: false, msg: '' };
    ui = {}; AC.rows = null; AC.wallet = null; SG.rows = []; BT.data = null; TR.data = null; TR.path = [];
    panel = GT.modal({ title: $t('Admin'), wide: true, sticky: true, body: build(), onClose: function () { clearInterval(timer); }, actions: [{ label: $t('Muat ulang'), onClick: function () { load(); return false; } }, { label: $t('Tutup'), close: true }] });
    renderAll(); load();
    clearInterval(timer);
    timer = setInterval(function () { if (panel && panel.isOpen()) load(); else clearInterval(timer); }, 5000);
  }

  // The same panel inside another window (the Admin tab of Settings); it reloads every 5 s while that tab is on screen.
  function embed(host) {
    if (!isAdmin()) return;
    F = { input: '', who: null, err: '', amount: '', note: '', busy: false, result: null };
    PG = { rows: null, info: null, sel: {}, word: '', busy: false, msg: '' };
    ui = {}; AC.rows = null; AC.wallet = null; SG.rows = []; BT.data = null; TR.data = null; TR.path = [];
    host.appendChild(build()); renderAll(); load();
    clearInterval(timer);
    timer = setInterval(function () { if (!host.isConnected) clearInterval(timer); else if (!host.closest('[hidden]')) load(); }, 5000);
  }

  // The page /admin is the game page: once signed in, an admin gets the window and anyone else a short note.
  function watchPage() {
    var tries = 0, t = setInterval(function () {
      tries++;
      if (tries > 400) { clearInterval(t); return; }
      var s = st();
      if (!s || GT.isUiOpen()) return;
      clearInterval(t);
      if (s.admin) open(); else GT.toast($t('Halaman ini khusus admin.'));
    }, 700);
  }

  function init() {
    C = window.GT_CHAIN || null;
    window.GT_ADMIN = { open: open, embed: embed, isAdmin: isAdmin };
    if (wantPage) watchPage();
  }
  GT.register({ id: 'admin', init: init });
})();
