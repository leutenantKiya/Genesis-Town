/*
 * Public-area economy (client of server/src/game/trade.ts, consign.ts, leaderboard.ts):
 *  - "Ajak dagang" on a player card, "Dagang" in the party panel and /dagang nama#tag open a live trade window (client of the
 *    /api/trade/open|join|set|ready|close sessions): both put in items and coin, both press Siap, any change clears both, then a 3 s countdown
 *    works in the village and in a Homeland; an invitation pops up with Buka / Tolak
 *  - Titip Jual stall (Mbok Darmi): leave items with a minimum price, she sells hourly even while you are away
 *  - Papan Juara board: top sellers today / of all time
 * The stall and the board stand at fixed plaza tiles from GTVillage.landmarks (same on the server). Only in the public area.
 */
(function () {
  'use strict';
  var GT = window.GT, C = null;
  var pollT = 2;

  function $(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function S() { return C && C.state; }
  function signedIn() { var s = S(); return !!(s && s.account && s.mode !== 'offline'); }
  function inPublic() { return (!GT.worldId || GT.worldId() === 'public') && GT.scene && GT.scene.kind === 'out'; }
  function items() { var s = S(); return (s && s.cfg && s.cfg.econ && s.cfg.econ.items) || {}; }
  function iname(t) { var i = items()[t]; return i ? i.name : t; }
  function have(t) { var s = S(), b = s && s.st && s.st.bag && s.st.bag[t]; return b ? b.settled + b.today : 0; }
  function fmt(lines) {
    var k = Object.keys(lines || {});
    return k.length ? k.map(function (t) { return lines[t] + ' ' + iname(t); }).join(', ') : $t('tidak ada');
  }
  // a tray cell: title left, optional metadata right, then whatever the caller appends to .body
  function cell(title, meta) {
    var c = $('div', 'tr-cell'), h = $('div', 'tr-cell-h');
    h.appendChild($('span', 'tr-cell-t', title)); if (meta != null) h.appendChild($('span', 'tr-meta', meta));
    c.appendChild(h); return c;
  }
  function linesList(lines) {
    var box = $('div', 'tr-lines'), k = Object.keys(lines || {});
    if (!k.length) box.appendChild($('div', 'chain-dim', $t('tidak ada')));
    k.forEach(function (t) { var r = $('div', 'tr-line-r'); r.appendChild($('span', 'tr-qty', String(lines[t]))); r.appendChild($('span', null, iname(t))); box.appendChild(r); });
    return box;
  }
  function standPos() { return C.standPos ? C.standPos() : { x: GT.player.x, y: GT.player.y }; }
  function post(path, body) {
    body = body || {}; body.pos = standPos();
    var once = function () { return C.api(path, { method: 'POST', body: body }); };
    // a device not yet approved with NEAR Auth may play but not trade: approve it once, then retry
    return once().catch(function (e) {
      if (!e || e.code !== 'approve_device' || !C.approveDevice) throw e;
      return C.approveDevice().then(once);
    });
  }
  function fail(e) { GT.toast(e.message || $t('Gagal.')); }
  function refreshState(r) { if (r && r.state) { S().st = r.state; if (C.refresh) C.refresh(true); } }

  /* ---------------------------------------------------------------- landmarks */
  function marks() {
    if (!window.GTVillage || !GTVillage.landmarks || !inPublic() || !GT.world || !GT.world.layout || !GT.world.layout.market) return null;
    return GTVillage.landmarks(GT.world.layout);
  }

  /* ---------------------------------------------------------------- live trade window (sessions: /api/trade/open|join|set|ready|close) */
  var sess = null;          // my live (or just ended) session view
  var win = null;           // the open window handle
  var winKey = '';          // id + phase the window was built for
  var ui = null;            // refs into the built window
  var dismissed = {};       // id:status of ended sessions already shown
  var seenInv = {};         // invites already popped up
  var invPop = null;
  var draft = {};           // my side as typed: token -> qty
  var setT = null, dirty = false, sending = null, countT = null, deadline = 0;

  function worldNow() { return (GT.worldId && GT.worldId()) || 'public'; }
  function maxKinds() { var s = S(), t = s && s.cfg && s.cfg.econ && s.cfg.econ.trade; return (t && t.maxLines) || 4; }
  function live(s) { return !!s && (s.status === 'invite' || s.status === 'open' || s.status === 'locked'); }
  function otherName(s) { return s.other.name + (s.other.tag ? '#' + s.other.tag : ''); }
  function tpost(path, body) { body = body || {}; body.world = worldNow(); return post(path, body); }

  function stopWin(reason) {
    if (setT) { clearTimeout(setT); setT = null; }
    if (countT) { clearInterval(countT); countT = null; }
    dirty = false; ui = null; winKey = '';
    var w = win; win = null;
    if (w && w.isOpen()) w.close(reason || 'end');
  }
  function finish(s, text, refresh) {
    dismissed[s.id + ':' + s.status] = 1;
    sess = null; stopWin('end');
    if (text) GT.toast(text);
    if (refresh && C.refresh) C.refresh(true);
  }

  /* my side: a coin box and up to maxKinds-1 item rows, every edit is sent after 400 ms */
  function currentLines() {
    var out = {};
    if (!ui) return out;
    var c = Math.floor(Number(ui.coin.value));
    if (c >= 1) out.coin = Math.min(c, have('coin'));
    ui.rows.forEach(function (r) {
      var q = Math.floor(Number(r.num.value));
      if (q >= 1) out[r.sel.value] = Math.min(q, have(r.sel.value));
    });
    return out;
  }
  function changed() {
    dirty = true;
    if (setT) clearTimeout(setT);
    setT = setTimeout(flush, 400);
  }
  // send the edited side now (if it changed); resolves when the server has it
  function flush() {
    if (setT) { clearTimeout(setT); setT = null; }
    if (!dirty || !sess || !live(sess)) return sending || Promise.resolve();
    dirty = false;
    var id = sess.id, lines = currentLines();
    sending = tpost('/trade/set', { id: id, lines: lines }).then(function (r) { if (sess && sess.id === id) take(r.session); }, fail)
      .then(function () { sending = null; });
    return sending;
  }
  function addRow(token, qty) {
    if (ui.rows.length >= maxKinds() - 1) return;
    var tokens = Object.keys(items()).filter(function (t) { return t !== 'coin' && (have(t) > 0 || t === token); });
    if (!tokens.length) { GT.toast($t('Tasmu kosong.')); return; }
    var row = $('div', 'tr-line'), sel = $('select', 'tr-sel'), num = $('input', 'tr-num');
    tokens.forEach(function (t) { var o = $('option', null, iname(t) + ' (' + have(t) + ')'); o.value = t; sel.appendChild(o); });
    if (token) sel.value = token;
    num.type = 'number'; num.min = '1'; num.step = '1'; num.value = String(qty || 1);
    sel.setAttribute('aria-label', $t('barang')); num.setAttribute('aria-label', $t('jumlah'));
    var del = $('button', 'mbtn tr-del', 'x'); del.type = 'button'; del.setAttribute('aria-label', $t('Hapus baris'));
    var r = { sel: sel, num: num, row: row };
    del.addEventListener('click', function () { ui.list.removeChild(row); ui.rows.splice(ui.rows.indexOf(r), 1); ui.add.style.display = ""; changed(); });
    [sel, num].forEach(function (e) { e.addEventListener('input', changed); e.addEventListener('change', changed); });
    num.addEventListener('keydown', function (e) { e.stopPropagation(); });
    num.addEventListener('keyup', function (e) { e.stopPropagation(); });
    row.appendChild(sel); row.appendChild(num); row.appendChild(del);
    ui.rows.push(r); ui.list.appendChild(row);
    if (ui.rows.length >= maxKinds() - 1) ui.add.style.display = "none";
    if (!token) changed();
  }

  function tick(el, ok) { el.textContent = ok ? '✓ ' + $t('Siap') : $t('Belum siap'); el.className = 'tr-tick' + (ok ? ' ok' : ''); }

  function buildWin(s) {
    var body = $('div', 'tr-win');
    ui = { rows: [] };
    if (s.status === 'invite') {
      body.appendChild($('p', null, $t('Menunggu {0} membuka jendela dagang…', [otherName(s)])));
      body.appendChild($('p', 'chain-dim', $t('Ajakan berlaku 1 menit.')));
    } else {
      var cols = $('div', 'tr-cols');
      var mine = cell($t('Kamu beri')), theirs = cell($t('{0} beri', [s.other.name]));
      var cf = $('label', 'tr-f'); cf.appendChild($('span', null, $t('Koin') + ' (' + have('coin') + ')'));
      ui.coin = $('input', 'tr-num'); ui.coin.type = 'number'; ui.coin.min = '0'; ui.coin.step = '1'; ui.coin.value = s.mine.coin ? String(s.mine.coin) : '';
      ui.coin.setAttribute('aria-label', $t('Koin'));
      ui.coin.addEventListener('input', changed); ui.coin.addEventListener('change', changed);
      ui.coin.addEventListener('keydown', function (e) { e.stopPropagation(); }); ui.coin.addEventListener('keyup', function (e) { e.stopPropagation(); });
      cf.appendChild(ui.coin); mine.appendChild(cf);
      ui.list = $('div', 'tr-editor'); mine.appendChild(ui.list);
      ui.add = $('button', 'mbtn tr-add', $t('+ barang')); ui.add.type = 'button';
      ui.add.addEventListener('click', function () { addRow(); });
      mine.appendChild(ui.add);
      ui.myTick = $('div'); mine.appendChild(ui.myTick);
      ui.theirs = $('div'); theirs.appendChild(ui.theirs);
      ui.theirTick = $('div'); theirs.appendChild(ui.theirTick);
      cols.appendChild(mine); cols.appendChild(theirs); body.appendChild(cols);
      Object.keys(s.mine).forEach(function (t) { if (t !== 'coin') addRow(t, s.mine[t]); });
    }
    ui.note = $('div', 'tr-note'); ui.count = $('div', 'tr-count');
    body.appendChild(ui.note); body.appendChild(ui.count);
    var acts = $('div', 'tr-acts');
    if (s.status !== 'invite') {
      ui.ready = $('button', 'mbtn primary', $t('Siap')); ui.ready.type = 'button';
      ui.ready.addEventListener('click', function () {
        var id = sess && sess.id; if (!id) return;
        ui.ready.disabled = true;
        Promise.resolve(flush()).then(function () {
          if (!sess || sess.id !== id) return;
          return tpost('/trade/ready', { id: id, version: sess.version }).then(function (r) { take(r.session); }, function (e) { fail(e); poll(true); });
        }).then(function () { if (ui && ui.ready) ui.ready.disabled = false; });
      });
      acts.appendChild(ui.ready);
    }
    var cancel = $('button', 'mbtn', s.status === 'invite' ? $t('Batalkan ajakan') : $t('Batal')); cancel.type = 'button';
    cancel.addEventListener('click', function () { cancelTrade(); });
    acts.appendChild(cancel); body.appendChild(acts);
    return body;
  }

  function cancelTrade() {
    var s = sess;
    if (s && live(s)) { dismissed[s.id + ':cancelled'] = 1; tpost('/trade/close', { id: s.id }).then(function () {}, function () {}); }
    sess = null; stopWin('end');
  }

  function showWin(s) {
    var key = s.id + ':' + (s.status === 'invite' ? 'invite' : 'live');
    if (win && win.isOpen() && winKey === key) return;
    if (!win || !win.isOpen()) {
      if (GT.isUiOpen()) return; // another window is up: try again at the next poll
    }
    var wasOpen = win && win.isOpen();
    if (wasOpen) { var old = win; win = null; old.close('end'); }
    draft = {};
    var body = buildWin(s);
    winKey = key;
    var mineId = s.id;
    win = GT.modal({
      title: $t('Dagang dengan {0}', [otherName(s)]), body: body, wide: true, actions: [],
      onClose: function (reason) {
        if (reason === 'end') return;           // closed by us after the outcome
        if (setT) { clearTimeout(setT); setT = null; }
        if (countT) { clearInterval(countT); countT = null; }
        win = null; ui = null; winKey = '';
        if (sess && sess.id === mineId && live(sess)) cancelTrade(); // closing the window cancels the trade
      }
    });
  }

  // apply a fresh session view
  function take(s) {
    if (!s) { if (sess && live(sess)) { sess = null; stopWin('end'); } sess = null; return; }
    if (!live(s)) {
      if (dismissed[s.id + ':' + s.status]) { sess = null; return; }
      sess = s;
      if (s.status === 'done') finish(s, $t('Dagang selesai.'), true);
      else if (s.status === 'expired') finish(s, $t('Dagang kedaluwarsa.'));
      else finish(s, $t('{0} membatalkan dagang.', [s.other.name]));
      return;
    }
    if (dismissed[s.id + ':cancelled']) return;
    if (s.status === 'invite' && s.me === 'b') { sess = null; return; } // an invitation for me: the pop-up handles it
    sess = s;
    showWin(s);
    if (!ui) return;
    if (ui.theirs) {
      ui.theirs.textContent = ''; ui.theirs.appendChild(linesList(s.theirs));
      tick(ui.myTick, s.my_ok); tick(ui.theirTick, s.their_ok);
      if (ui.ready) ui.ready.textContent = s.my_ok ? $t('Siap ✓') : $t('Siap');
    }
    ui.note.textContent = s.note || '';
    if (s.status === 'locked') {
      var left = s.swap_at - Date.now();
      deadline = Date.now() + (left > 0 && left <= 3500 ? left : 3000); // clocks may differ a little: never wait more than the countdown
      if (!countT) countT = setInterval(function () {
        if (!ui) return;
        var n = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
        ui.count.textContent = $t('Bertukar dalam {0}…', [n]);
      }, 200);
      ui.count.textContent = $t('Bertukar dalam {0}…', [Math.max(0, Math.ceil((deadline - Date.now()) / 1000))]);
    } else {
      if (countT) { clearInterval(countT); countT = null; }
      ui.count.textContent = '';
    }
  }

  function startWith(to) {
    if (!signedIn()) { GT.toast($t('Masuk dulu.')); return Promise.resolve(); }
    to = String(to || '').trim();
    if (!to) { GT.toast($t('Tulis nama#tag pemain yang mau diajak.')); return Promise.resolve(); }
    return tpost('/trade/open', { to: to }).then(function (r) { refreshState(r); take(r.session); }, fail);
  }

  function inviteModal(i) {
    if (invPop && invPop.isOpen()) return;
    seenInv[i.id] = 1;
    GT.toast($t('{0} mengajak dagang!', [i.other.name]));
    invPop = GT.modal({
      title: $t('Ajakan dagang'), body: $t('{0} mengajak dagang', [otherName(i)]), actions: [
        { label: $t('Buka'), primary: true, onClick: function (h) {
          tpost('/trade/join', { id: i.id }).then(function (r) { refreshState(r); h.close('ok'); take(r.session); }, function (e) { fail(e); h.close('err'); });
        } },
        { label: $t('Tolak'), onClick: function (h) { tpost('/trade/close', { id: i.id }).then(function () { h.close('no'); }, function (e) { fail(e); h.close('err'); }); } },
        { label: $t('Nanti'), close: true }
      ]
    });
  }

  var polling = false;
  function poll(force) {
    if (polling || !signedIn() || (sending && !force)) return;
    polling = true;
    C.api('/trade').then(function (r) {
      polling = false;
      if (!dirty) take(r.session);
      else if (r.session && !live(r.session)) take(r.session); // an outcome always shows
      var inv = (r.invites || []).filter(function (i) { return !seenInv[i.id]; })[0];
      if (inv && !sess && !GT.isUiOpen()) inviteModal(inv);
    }, function () { polling = false; });
  }

  /* ---------------------------------------------------------------- Titip Jual */
  function bestBid(t) {
    var s = S(), best = 0;
    ((s && s.market) || []).forEach(function (m) {
      if (!m.open) return;
      m.items.forEach(function (it) { if (it.token === t && it.bid != null && it.bid > best) best = it.bid; });
    });
    return best;
  }
  function consignModal() {
    if (!signedIn()) { GT.toast($t('Masuk dulu.')); return; }
    C.api('/consign').then(function (r) {
      var body = $('div');
      body.appendChild($('p', 'tr-quote', $t('{0}: "Titipkan barangmu, nanti kujualkan per jam. Upahku {1}%."', [r.merchant, r.feeBps / 100])));
      var lc = cell($t('Titipanmu'), r.lots.length ? String(r.lots.length) : null);
      body.appendChild(lc);
      if (!r.lots.length) lc.appendChild($('p', 'chain-dim', $t('Belum ada titipan.')));
      r.lots.forEach(function (l) {
        var row = $('div', 'tr-lot'), tx = $('div', 'tr-lot-t');
        tx.appendChild($('div', 'tr-lot-n', iname(l.token)));
        tx.appendChild($('div', 'tr-num-line', $t('sisa {0} (min {1}) · terjual {2} · dapat {3} koin', [l.qty, l.min_price, l.sold, l.earned])));
        row.appendChild(tx);
        if (l.qty > 0) {
          var b = $('button', 'mbtn', $t('Ambil')); b.type = 'button';
          b.addEventListener('click', function () { post('/consign/withdraw', { token: l.token }).then(function (x) { refreshState(x); GT.toast(x.toast); redo(); }, fail); });
          row.appendChild(b);
        }
        lc.appendChild(row);
      });
      var nc = cell($t('Titip barang baru'));
      body.appendChild(nc);
      var tokens = Object.keys(items()).filter(function (t) { return t !== 'coin' && have(t) > 0; });
      var sel = $('select', 'tr-sel'), qty = $('input', 'tr-num'), min = $('input', 'tr-num'), hint = $('p', 'chain-dim');
      sel.setAttribute('aria-label', 'barang');
      tokens.forEach(function (t) { var o = $('option', null, iname(t) + ' (' + have(t) + ')'); o.value = t; sel.appendChild(o); });
      qty.type = 'number'; qty.min = '1'; qty.value = '1';
      min.type = 'number'; min.min = '1';
      function upd() { var b = tokens.length ? bestBid(sel.value) : 0; hint.textContent = b ? $t('Harga beli pedagang terbaik sekarang: {0} koin.', [b]) : ''; if (b && !min.value) min.value = String(b); }
      sel.addEventListener('change', function () { min.value = ''; upd(); });
      upd();
      if (tokens.length) {
        var row = $('div', 'tr-form');
        function fld(label, input) { var l = $('label', 'tr-f'); l.appendChild($('span', null, label)); l.appendChild(input); return l; }
        row.appendChild(fld('barang', sel)); row.appendChild(fld('jumlah', qty)); row.appendChild(fld($t('harga min'), min));
        nc.appendChild(row); nc.appendChild(hint);
      } else nc.appendChild($('p', 'chain-dim', $t('Tasmu kosong.')));
      h = GT.modal({
        title: $t('Titip Jual · {0}', [r.merchant]), body: body, actions: (tokens.length ? [{ label: $t('Titip'), primary: true, onClick: function () {
          post('/consign', { token: sel.value, qty: Math.floor(Number(qty.value)), min_price: Math.floor(Number(min.value)) })
            .then(function (x) { refreshState(x); GT.toast(x.toast); redo(); }, fail);
        } }] : []).concat([{ label: $t('Tutup'), close: true }])
      });
    }, fail);
    var h;
    function redo() { if (h) h.close('redo'); consignModal(); }
  }

  /* ---------------------------------------------------------------- Papan Juara */
  function boardModal(period) {
    period = period || 'day';
    C.api('/leaderboard?period=' + period).then(function (r) {
      var body = $('div');
      var bc = cell(period === 'day' ? $t('Penjual teratas hari ini') : $t('Penjual teratas sepanjang masa'));
      body.appendChild(bc);
      if (!r.rows.length) bc.appendChild($('p', 'chain-dim', $t('Belum ada yang berjualan.')));
      r.rows.forEach(function (x) {
        var row = $('div', 'tr-rank' + (r.me && r.me.rank === x.rank ? ' me' : ''));
        row.appendChild($('span', 'tr-rk', '#' + x.rank));
        row.appendChild($('span', 'tr-nm', x.name + '#' + x.tag + (r.me && r.me.rank === x.rank ? $t(' (kamu)') : '')));
        row.appendChild($('span', 'tr-sc', $t('{0} barang · {1} koin', [x.sold_qty, x.coin])));
        bc.appendChild(row);
      });
      if (r.me && r.me.rank > 10) body.appendChild($('p', 'tr-me', $t('Kamu: peringkat {0} · {1} barang · {2} koin', [r.me.rank, r.me.sold_qty, r.me.coin])));
      else if (!r.me && signedIn()) body.appendChild($('p', 'chain-dim', $t('Kamu belum berjualan{0}', [period === 'day' ? $t(' hari ini.') : '.'])));
      var h = GT.modal({
        title: $t('Papan Juara · {0}', [period === 'day' ? $t('hari ini') : $t('sepanjang masa')]), body: body, wide: true, actions: [
          { label: period === 'day' ? $t('Sepanjang masa') : $t('Hari ini'), onClick: function () { h.close('sw'); boardModal(period === 'day' ? 'all' : 'day'); } },
          { label: $t('Tutup'), close: true }
        ]
      });
    }, fail);
  }

  /* ---------------------------------------------------------------- engine hooks */
  function onInteract(ctx) {
    if (ctx.scene.kind !== 'out' || ctx.mode !== 'talk' || ctx.npc) return false;
    var m = marks(); if (!m) return false;
    var t = ctx.tile;
    if (t.x === m.consign.x && t.y === m.consign.y) { consignModal(); return true; }
    if (t.x === m.board.x && t.y === m.board.y) { boardModal('day'); return true; }
    if (m.gamble && t.x === m.gamble.x && t.y === m.gamble.y) { luckModal(); return true; }
    return false;
  }

  /* ---------------------------------------------------------------- Meja Untung: stake goods on a dice roll */
  function luckModal() {
    if (!signedIn()) { GT.toast($t('Masuk dulu.')); return; }
    var st = C.state, g = st.cfg && st.cfg.econ && st.cfg.econ.gamble, bag = (st.st && st.st.bag) || {};
    if (!g) { GT.toast($t('Meja Untung belum buka.')); return; }
    var pick = g.goods.filter(function (t) { var b = bag[t]; return b && b.settled + b.today > 0; })[0] || g.goods[0], qty = 1, busy = false;
    var body = document.createElement('div'); body.className = 'gt-luck';
    var h = GT.modal({ title: '🎲 ' + $t('Meja Untung'), body: body });
    function paint(result) {
      body.textContent = '';
      var p = document.createElement('p');
      p.textContent = $t('Taruh barang, lempar dadu. Menang: dapat sejumlah taruhanmu lagi. Kalah: taruhannya hilang. Peluang menang {0}%, maksimal {1} per taruhan, {2} taruhan sehari. Tidak pernah memakai koin.', [Math.round(g.winChance * 100), g.maxBet, g.dailyBets]);
      body.appendChild(p);
      var goods = document.createElement('div'); goods.className = 'gt-luck-row';
      g.goods.forEach(function (t) {
        var b = bag[t] || { settled: 0, today: 0 }, n = b.settled + b.today, x = document.createElement('button');
        x.type = 'button'; x.className = 'mbtn' + (t === pick ? ' primary' : ''); x.disabled = n <= 0;
        if (window.GT_ITEMS) x.appendChild(GT_ITEMS.icon(t, 16));
        x.appendChild(document.createTextNode(' ' + ((st.cfg.econ.items[t] && st.cfg.econ.items[t].name) || t) + ' · ' + n));
        x.addEventListener('click', function () { pick = t; paint(); });
        goods.appendChild(x);
      });
      body.appendChild(goods);
      var qrow = document.createElement('div'); qrow.className = 'gt-luck-row';
      for (var q = 1; q <= g.maxBet; q++) (function (q) {
        var x = document.createElement('button'); x.type = 'button'; x.className = 'mbtn' + (q === qty ? ' primary' : ''); x.textContent = 'x' + q;
        x.addEventListener('click', function () { qty = q; paint(); }); qrow.appendChild(x);
      })(q);
      body.appendChild(qrow);
      var dice = document.createElement('div'); dice.className = 'gt-luck-dice' + (result ? (result.win ? ' win' : ' lose') : '');
      dice.textContent = result ? (result.win ? '🎉 ' + $t('Menang! +{0}', [result.qty]) : '💨 ' + $t('Kalah −{0}', [result.qty])) : '🎲 🎲';
      body.appendChild(dice);
      var roll = document.createElement('button'); roll.type = 'button'; roll.className = 'mbtn primary'; roll.textContent = '🎲 ' + $t('Lempar dadu');
      roll.disabled = busy;
      roll.addEventListener('click', function () {
        if (busy) return; busy = true; dice.className = 'gt-luck-dice rolling'; dice.textContent = '🎲 🎲';
        C.act({ action: 'gamble', token: pick, qty: qty, world: 'public' }, true).then(function (r) {
          bag = (C.state.st && C.state.st.bag) || bag; busy = false; if (h.isOpen()) paint(r || null);
        }, function () { busy = false; if (h.isOpen()) paint(); });
      });
      body.appendChild(roll);
    }
    paint();
  }
  function onFrame(dt) {
    pollT -= dt;
    if (pollT <= 0) { pollT = (sess || ui) ? 1 : 3; poll(); }
  }
  function label(ctx, txt, x, y) { GT_THEME.label(ctx, txt, x, y + 4, { tone: 'paper', size: 6, bold: true }); }
  function onDraw(ctx, camX, camY, T) {
    var m = marks(); if (!m) return;
    ctx.save();
    if (GT.view3dOn && GT.view3dOn()) { // 2.5D: the stall and board stand in the 3D world; here only small name signs
      var c = GT.at(m.consign.x, m.consign.y), b = GT.at(m.board.x, m.board.y);
      label(ctx, $t('Titip Jual'), c.x + T / 2, c.y + T + 5); label(ctx, $t('Papan Juara'), b.x + T / 2, b.y + T + 5);
      if (m.gamble) { var gm = GT.at(m.gamble.x, m.gamble.y); label(ctx, '🎲 ' + $t('Meja Untung'), gm.x + T / 2, gm.y + T + 5); }
      ctx.restore(); return;
    }
    // Titip Jual: striped awning over a counter, a crate of goods on it
    var x = m.consign.x * T - camX, y = m.consign.y * T - camY;
    ctx.fillStyle = '#6a4020'; ctx.fillRect(x + 1, y + 5, T - 2, T - 5);
    ctx.fillStyle = '#b8864a'; ctx.fillRect(x + 1, y + 5, T - 2, 2);
    for (var i = 0; i < 4; i++) { ctx.fillStyle = i % 2 ? '#f6ead0' : '#c8503c'; ctx.fillRect(x + 1 + i * 3, y + 1, 3, 4); }
    ctx.fillStyle = '#e8c070'; ctx.fillRect(x + 4, y + 7, 4, 3);
    label(ctx, $t('Titip Jual'), x + T / 2, y + T + 5); // below the stall: the merchants' name tags sit on the row above
    // Papan Juara: a board on two posts with a gold star
    x = m.board.x * T - camX; y = m.board.y * T - camY;
    ctx.fillStyle = '#6a4020'; ctx.fillRect(x + 2, y + 6, 1, T - 6); ctx.fillRect(x + T - 3, y + 6, 1, T - 6);
    ctx.fillStyle = '#3a2a40'; ctx.fillRect(x, y + 1, T, 7);
    ctx.fillStyle = '#f6ead0'; ctx.fillRect(x + 1, y + 2, T - 2, 5);
    ctx.fillStyle = '#e8b030'; ctx.fillRect(x + 5, y + 3, 2, 3); ctx.fillRect(x + 4, y + 4, 4, 1);
    label(ctx, $t('Papan Juara'), x + T / 2, y + T + 5);
    if (m.gamble) { // Meja Untung: a green felt table with two dice
      x = m.gamble.x * T - camX; y = m.gamble.y * T - camY;
      ctx.fillStyle = '#5a3a1e'; ctx.fillRect(x + 2, y + 8, 1, T - 8); ctx.fillRect(x + T - 3, y + 8, 1, T - 8);
      ctx.fillStyle = '#2a2430'; ctx.fillRect(x, y + 3, T, 6);
      ctx.fillStyle = '#2f8a4a'; ctx.fillRect(x + 1, y + 4, T - 2, 4);
      ctx.fillStyle = '#f8f4ec'; ctx.fillRect(x + 3, y + 4, 2, 2); ctx.fillRect(x + 7, y + 5, 2, 2);
      ctx.fillStyle = '#c83c3c'; ctx.fillRect(x + 3, y + 4, 1, 1); ctx.fillRect(x + 8, y + 6, 1, 1);
      label(ctx, '🎲 ' + $t('Meja Untung'), x + T / 2, y + T + 5);
    }
    ctx.restore();
  }

  function init() {
    C = window.GT_CHAIN || null;
    if (window.GT_PLAYERS && GT_PLAYERS.addCardAction) {
      GT_PLAYERS.addCardAction(function (o) {
        if (!signedIn() || o.npc || !o.tag) return null;
        return { label: $t('Ajak dagang'), onClick: function (h) { h.close('ok'); startWith(o.nick + '#' + o.tag); return true; } };
      });
    }
    window.GT_TRADE = { start: startWith, consign: consignModal, board: boardModal };
  }
  GT.register({ id: 'trade', init: init, onInteract: onInteract, onFrame: onFrame, onDraw: onDraw });
})();
