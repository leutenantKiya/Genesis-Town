/*
 * Public-area economy (client of server/src/game/trade.ts, consign.ts, leaderboard.ts):
 *  - "Ajak dagang" on another player's card: offer items/coin for items/coin (both stand within 3 tiles in the public area)
 *  - incoming offers pop up with Terima / Tolak
 *  - Titip Jual stall (Mbok Darmi): leave items with a minimum price, she sells hourly even while you are away
 *  - Papan Juara board: top sellers today / of all time
 * The stall and the board stand at fixed plaza tiles from GTVillage.landmarks (same on the server). Only in the public area.
 */
(function () {
  'use strict';
  var GT = window.GT, C = null;
  var offers = {}, pollT = 2, polling = false;
  var seen = {}, popup = null;

  function $(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function S() { return C && C.state; }
  function signedIn() { var s = S(); return !!(s && s.account && s.mode !== 'offline'); }
  function inPublic() { return (!GT.worldId || GT.worldId() === 'public') && GT.scene && GT.scene.kind === 'out'; }
  function items() { var s = S(); return (s && s.cfg && s.cfg.econ && s.cfg.econ.items) || {}; }
  function iname(t) { var i = items()[t]; return i ? i.name : t; }
  function have(t) { var s = S(), b = s && s.st && s.st.bag && s.st.bag[t]; return b ? b.settled + b.today : 0; }
  function fmt(lines) {
    var k = Object.keys(lines || {});
    return k.length ? k.map(function (t) { return lines[t] + ' ' + iname(t); }).join(', ') : 'tidak ada';
  }
  // a tray cell: title left, optional metadata right, then whatever the caller appends to .body
  function cell(title, meta) {
    var c = $('div', 'tr-cell'), h = $('div', 'tr-cell-h');
    h.appendChild($('span', 'tr-cell-t', title)); if (meta != null) h.appendChild($('span', 'tr-meta', meta));
    c.appendChild(h); return c;
  }
  function linesList(lines) {
    var box = $('div', 'tr-lines'), k = Object.keys(lines || {});
    if (!k.length) box.appendChild($('div', 'chain-dim', 'tidak ada'));
    k.forEach(function (t) { var r = $('div', 'tr-line-r'); r.appendChild($('span', 'tr-qty', String(lines[t]))); r.appendChild($('span', null, iname(t))); box.appendChild(r); });
    return box;
  }
  function standPos() { return C.standPos ? C.standPos() : { x: GT.player.x, y: GT.player.y }; }
  function post(path, body) { body = body || {}; body.pos = standPos(); return C.api(path, { method: 'POST', body: body }); }
  function fail(e) { GT.toast(e.message || 'Gagal.'); }
  function refreshState(r) { if (r && r.state) { S().st = r.state; if (C.refresh) C.refresh(true); } }

  /* ---------------------------------------------------------------- landmarks */
  function marks() {
    if (!window.GTVillage || !GTVillage.landmarks || !inPublic() || !GT.world || !GT.world.layout || !GT.world.layout.market) return null;
    return GTVillage.landmarks(GT.world.layout);
  }

  /* ---------------------------------------------------------------- line editor (pick a token and an amount, up to 4 lines) */
  function lineEditor(tokens, max, maxQty) {
    var box = $('div', 'tr-editor'), rows = [];
    var addBtn = $('button', 'mbtn tr-add', '+ barang'); addBtn.type = 'button';
    addBtn.addEventListener('click', add);
    function add() {
      if (rows.length >= max) return;
      var row = $('div', 'tr-line'), sel = $('select', 'tr-sel'), num = $('input', 'tr-num');
      tokens.forEach(function (t) { var o = $('option', null, iname(t)); o.value = t; sel.appendChild(o); });
      num.type = 'number'; num.min = '1'; num.step = '1'; num.value = '1'; num.setAttribute('aria-label', 'jumlah'); sel.setAttribute('aria-label', 'barang');
      var del = $('button', 'mbtn tr-del', 'x'); del.type = 'button'; del.setAttribute('aria-label', 'Hapus baris');
      del.addEventListener('click', function () { box.removeChild(row); rows.splice(rows.indexOf(r), 1); });
      var r = { sel: sel, num: num };
      row.appendChild(sel); row.appendChild(num); row.appendChild(del);
      rows.push(r); box.insertBefore(row, addBtn);
    }
    box.appendChild(addBtn);
    return {
      el: box, add: add,
      value: function () {
        var out = {};
        rows.forEach(function (r) { var q = Math.floor(Number(r.num.value)); if (q >= 1) out[r.sel.value] = Math.min(q, maxQty || 100000); });
        return out;
      }
    };
  }

  /* ---------------------------------------------------------------- direct trade */
  function offerModal(o) {
    if (!signedIn()) { GT.toast('Masuk dulu.'); return; }
    var mine = Object.keys(items()).filter(function (t) { return have(t) > 0; });
    var all = Object.keys(items());
    var body = $('div');
    body.appendChild($('p', 'chain-dim', 'Kalian harus berdiri berdekatan di area publik. Tawaran berlaku 2 menit.'));
    var gc = cell('Kamu beri'), wc = cell('Kamu minta');
    var give = lineEditor(mine, 4, 100000); gc.appendChild(give.el); if (mine.length) give.add();
    var want = lineEditor(all, 4, 100000); wc.appendChild(want.el); want.add();
    body.appendChild(gc); body.appendChild(wc);
    GT.modal({
      title: 'Ajak dagang: ' + o.nick + (o.tag ? '#' + o.tag : ''), body: body, actions: [
        { label: 'Kirim tawaran', primary: true, onClick: function (h) {
          post('/trade/offer', { to: o.nick + '#' + o.tag, give: give.value(), want: want.value() })
            .then(function () { GT.toast('Tawaran terkirim ke ' + o.nick + '.'); h.close('ok'); }, fail);
        } },
        { label: 'Batal', close: true }
      ]
    });
  }

  function incomingModal(of) {
    if (popup && popup.isOpen()) return;
    var body = $('div');
    body.appendChild($('p', null, of.from + '#' + of.from_tag + ' menawarkan:'));
    var rc = cell('Kamu terima'), gv = cell('Kamu beri');
    rc.appendChild(linesList(of.give)); gv.appendChild(linesList(of.want));
    body.appendChild(rc); body.appendChild(gv);
    body.appendChild($('p', 'chain-dim', 'Berdirilah berdekatan dengannya untuk menerima.'));
    popup = GT.modal({
      title: 'Tawaran dagang', body: body, actions: [
        { label: 'Terima', primary: true, onClick: function (h) {
          post('/trade/accept', { id: of.id }).then(function (r) { refreshState(r); GT.toast(r.toast); h.close('ok'); }, function (e) { fail(e); h.close('err'); });
        } },
        { label: 'Tolak', onClick: function (h) { post('/trade/cancel', { id: of.id }).then(function () { h.close('no'); }, function (e) { fail(e); h.close('err'); }); } },
        { label: 'Nanti', close: true }
      ]
    });
  }

  function poll() {
    if (polling || !signedIn() || !inPublic()) return;
    polling = true;
    C.api('/trade').then(function (r) {
      offers = {};
      r.incoming.forEach(function (o) {
        offers[o.id] = o;
        if (!seen[o.id]) { seen[o.id] = 1; GT.toast(o.from + ' mengajak dagang!'); }
      });
      polling = false;
      var next = r.incoming.filter(function (o) { return !(popup && popup.isOpen()); })[0];
      if (next && !GT.isUiOpen()) incomingModal(next);
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
    if (!signedIn()) { GT.toast('Masuk dulu.'); return; }
    C.api('/consign').then(function (r) {
      var body = $('div');
      body.appendChild($('p', 'tr-quote', r.merchant + ': "Titipkan barangmu, nanti kujualkan per jam. Upahku ' + (r.feeBps / 100) + '%."'));
      var lc = cell('Titipanmu', r.lots.length ? String(r.lots.length) : null);
      body.appendChild(lc);
      if (!r.lots.length) lc.appendChild($('p', 'chain-dim', 'Belum ada titipan.'));
      r.lots.forEach(function (l) {
        var row = $('div', 'tr-lot'), tx = $('div', 'tr-lot-t');
        tx.appendChild($('div', 'tr-lot-n', iname(l.token)));
        tx.appendChild($('div', 'tr-num-line', 'sisa ' + l.qty + ' (min ' + l.min_price + ') · terjual ' + l.sold + ' · dapat ' + l.earned + ' koin'));
        row.appendChild(tx);
        if (l.qty > 0) {
          var b = $('button', 'mbtn', 'Ambil'); b.type = 'button';
          b.addEventListener('click', function () { post('/consign/withdraw', { token: l.token }).then(function (x) { refreshState(x); GT.toast(x.toast); redo(); }, fail); });
          row.appendChild(b);
        }
        lc.appendChild(row);
      });
      var nc = cell('Titip barang baru');
      body.appendChild(nc);
      var tokens = Object.keys(items()).filter(function (t) { return t !== 'coin' && have(t) > 0; });
      var sel = $('select', 'tr-sel'), qty = $('input', 'tr-num'), min = $('input', 'tr-num'), hint = $('p', 'chain-dim');
      sel.setAttribute('aria-label', 'barang');
      tokens.forEach(function (t) { var o = $('option', null, iname(t) + ' (' + have(t) + ')'); o.value = t; sel.appendChild(o); });
      qty.type = 'number'; qty.min = '1'; qty.value = '1';
      min.type = 'number'; min.min = '1';
      function upd() { var b = tokens.length ? bestBid(sel.value) : 0; hint.textContent = b ? 'Harga beli pedagang terbaik sekarang: ' + b + ' koin.' : ''; if (b && !min.value) min.value = String(b); }
      sel.addEventListener('change', function () { min.value = ''; upd(); });
      upd();
      if (tokens.length) {
        var row = $('div', 'tr-form');
        function fld(label, input) { var l = $('label', 'tr-f'); l.appendChild($('span', null, label)); l.appendChild(input); return l; }
        row.appendChild(fld('barang', sel)); row.appendChild(fld('jumlah', qty)); row.appendChild(fld('harga min', min));
        nc.appendChild(row); nc.appendChild(hint);
      } else nc.appendChild($('p', 'chain-dim', 'Tasmu kosong.'));
      h = GT.modal({
        title: 'Titip Jual · ' + r.merchant, body: body, actions: (tokens.length ? [{ label: 'Titip', primary: true, onClick: function () {
          post('/consign', { token: sel.value, qty: Math.floor(Number(qty.value)), min_price: Math.floor(Number(min.value)) })
            .then(function (x) { refreshState(x); GT.toast(x.toast); redo(); }, fail);
        } }] : []).concat([{ label: 'Tutup', close: true }])
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
      var bc = cell(period === 'day' ? 'Penjual teratas hari ini' : 'Penjual teratas sepanjang masa');
      body.appendChild(bc);
      if (!r.rows.length) bc.appendChild($('p', 'chain-dim', 'Belum ada yang berjualan.'));
      r.rows.forEach(function (x) {
        var row = $('div', 'tr-rank' + (r.me && r.me.rank === x.rank ? ' me' : ''));
        row.appendChild($('span', 'tr-rk', '#' + x.rank));
        row.appendChild($('span', 'tr-nm', x.name + '#' + x.tag + (r.me && r.me.rank === x.rank ? ' (kamu)' : '')));
        row.appendChild($('span', 'tr-sc', x.sold_qty + ' barang · ' + x.coin + ' koin'));
        bc.appendChild(row);
      });
      if (r.me && r.me.rank > 10) body.appendChild($('p', 'tr-me', 'Kamu: peringkat ' + r.me.rank + ' · ' + r.me.sold_qty + ' barang · ' + r.me.coin + ' koin'));
      else if (!r.me && signedIn()) body.appendChild($('p', 'chain-dim', 'Kamu belum berjualan' + (period === 'day' ? ' hari ini.' : '.')));
      var h = GT.modal({
        title: 'Papan Juara · ' + (period === 'day' ? 'hari ini' : 'sepanjang masa'), body: body, wide: true, actions: [
          { label: period === 'day' ? 'Sepanjang masa' : 'Hari ini', onClick: function () { h.close('sw'); boardModal(period === 'day' ? 'all' : 'day'); } },
          { label: 'Tutup', close: true }
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
    return false;
  }
  function onFrame(dt) {
    pollT -= dt;
    if (pollT <= 0) { pollT = 3; poll(); }
  }
  function label(ctx, txt, x, y) { GT_THEME.label(ctx, txt, x, y + 4, { tone: 'paper', size: 6, bold: true }); }
  function onDraw(ctx, camX, camY, T) {
    var m = marks(); if (!m) return;
    ctx.save();
    if (GT.view3dOn && GT.view3dOn()) { // 2.5D: the stall and board stand in the 3D world; here only small name signs
      var c = GT.at(m.consign.x, m.consign.y), b = GT.at(m.board.x, m.board.y);
      label(ctx, 'Titip Jual', c.x + T / 2, c.y + T + 5); label(ctx, 'Papan Juara', b.x + T / 2, b.y + T + 5);
      ctx.restore(); return;
    }
    // Titip Jual: striped awning over a counter, a crate of goods on it
    var x = m.consign.x * T - camX, y = m.consign.y * T - camY;
    ctx.fillStyle = '#6a4020'; ctx.fillRect(x + 1, y + 5, T - 2, T - 5);
    ctx.fillStyle = '#b8864a'; ctx.fillRect(x + 1, y + 5, T - 2, 2);
    for (var i = 0; i < 4; i++) { ctx.fillStyle = i % 2 ? '#f6ead0' : '#c8503c'; ctx.fillRect(x + 1 + i * 3, y + 1, 3, 4); }
    ctx.fillStyle = '#e8c070'; ctx.fillRect(x + 4, y + 7, 4, 3);
    label(ctx, 'Titip Jual', x + T / 2, y + T + 5); // below the stall: the merchants' name tags sit on the row above
    // Papan Juara: a board on two posts with a gold star
    x = m.board.x * T - camX; y = m.board.y * T - camY;
    ctx.fillStyle = '#6a4020'; ctx.fillRect(x + 2, y + 6, 1, T - 6); ctx.fillRect(x + T - 3, y + 6, 1, T - 6);
    ctx.fillStyle = '#3a2a40'; ctx.fillRect(x, y + 1, T, 7);
    ctx.fillStyle = '#f6ead0'; ctx.fillRect(x + 1, y + 2, T - 2, 5);
    ctx.fillStyle = '#e8b030'; ctx.fillRect(x + 5, y + 3, 2, 3); ctx.fillRect(x + 4, y + 4, 4, 1);
    label(ctx, 'Papan Juara', x + T / 2, y + T + 5);
    ctx.restore();
  }

  function init() {
    C = window.GT_CHAIN || null;
    if (window.GT_PLAYERS && GT_PLAYERS.addCardAction) {
      GT_PLAYERS.addCardAction(function (o) {
        if (!signedIn() || !inPublic() || o.npc) return null;
        return { label: 'Ajak dagang', onClick: function (h) { h.close('ok'); offerModal(o); return true; } };
      });
    }
    window.GT_TRADE = { offer: offerModal, consign: consignModal, board: boardModal };
  }
  GT.register({ id: 'trade', init: init, onInteract: onInteract, onFrame: onFrame, onDraw: onDraw });
})();
