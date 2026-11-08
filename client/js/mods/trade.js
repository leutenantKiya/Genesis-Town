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
    var box = $('div'), rows = [];
    function add() {
      if (rows.length >= max) return;
      var row = $('div', 'chain-item'), sel = $('select'), num = $('input');
      tokens.forEach(function (t) { var o = $('option', null, iname(t)); o.value = t; sel.appendChild(o); });
      num.type = 'number'; num.min = '1'; num.step = '1'; num.value = '1'; num.style.width = '72px';
      var del = $('button', 'mbtn', 'x'); del.type = 'button';
      del.addEventListener('click', function () { box.removeChild(row); rows.splice(rows.indexOf(r), 1); });
      var r = { sel: sel, num: num };
      row.appendChild(sel); row.appendChild(num); row.appendChild(del);
      rows.push(r); box.appendChild(row);
    }
    var addBtn = $('button', 'mbtn', '+ barang'); addBtn.type = 'button';
    addBtn.addEventListener('click', add);
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
    body.appendChild($('p', null, 'Kamu beri:'));
    var give = lineEditor(mine, 4, 100000); body.appendChild(give.el); if (mine.length) give.add();
    body.appendChild($('p', null, 'Kamu minta:'));
    var want = lineEditor(all, 4, 100000); body.appendChild(want.el); want.add();
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
    body.appendChild($('p', 'gt-pcard-title', 'Kamu terima: ' + fmt(of.give)));
    body.appendChild($('p', 'gt-pcard-title', 'Kamu beri: ' + fmt(of.want)));
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
      body.appendChild($('p', null, r.merchant + ': "Titipkan barangmu, nanti kujualkan per jam. Upahku ' + (r.feeBps / 100) + '%."'));
      if (!r.lots.length) body.appendChild($('p', 'chain-dim', 'Belum ada titipan.'));
      r.lots.forEach(function (l) {
        var row = $('div', 'chain-item');
        row.appendChild($('span', 'grow', iname(l.token) + ': sisa ' + l.qty + ' (min ' + l.min_price + ') · terjual ' + l.sold + ' · dapat ' + l.earned + ' koin'));
        if (l.qty > 0) {
          var b = $('button', 'mbtn', 'Ambil'); b.type = 'button';
          b.addEventListener('click', function () { post('/consign/withdraw', { token: l.token }).then(function (x) { refreshState(x); GT.toast(x.toast); redo(); }, fail); });
          row.appendChild(b);
        }
        body.appendChild(row);
      });
      body.appendChild($('p', null, 'Titip barang baru:'));
      var tokens = Object.keys(items()).filter(function (t) { return t !== 'coin' && have(t) > 0; });
      var sel = $('select'), qty = $('input'), min = $('input'), hint = $('p', 'chain-dim');
      tokens.forEach(function (t) { var o = $('option', null, iname(t) + ' (' + have(t) + ')'); o.value = t; sel.appendChild(o); });
      qty.type = 'number'; qty.min = '1'; qty.value = '1'; qty.style.width = '72px';
      min.type = 'number'; min.min = '1'; min.style.width = '72px';
      function upd() { var b = tokens.length ? bestBid(sel.value) : 0; hint.textContent = b ? 'Harga beli pedagang terbaik sekarang: ' + b + ' koin.' : ''; if (b && !min.value) min.value = String(b); }
      sel.addEventListener('change', function () { min.value = ''; upd(); });
      upd();
      if (tokens.length) {
        var row = $('div', 'chain-item');
        row.appendChild(sel); row.appendChild($('span', null, 'jumlah')); row.appendChild(qty); row.appendChild($('span', null, 'harga min')); row.appendChild(min);
        body.appendChild(row); body.appendChild(hint);
      } else body.appendChild($('p', 'chain-dim', 'Tasmu kosong.'));
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
      if (!r.rows.length) body.appendChild($('p', 'chain-dim', 'Belum ada yang berjualan.'));
      r.rows.forEach(function (x) {
        var row = $('div', 'chain-item');
        row.appendChild($('span', 'grow', '#' + x.rank + '  ' + x.name + '#' + x.tag));
        row.appendChild($('span', null, x.sold_qty + ' barang · ' + x.coin + ' koin'));
        body.appendChild(row);
      });
      if (r.me && r.me.rank > 10) body.appendChild($('p', null, 'Kamu: peringkat ' + r.me.rank + ' · ' + r.me.sold_qty + ' barang · ' + r.me.coin + ' koin'));
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
  function label(ctx, txt, x, y) {
    ctx.font = 'bold 6px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    var w = ctx.measureText(txt).width + 4;
    ctx.fillStyle = '#2a2430'; ctx.fillRect(Math.round(x - w / 2), Math.round(y - 4), Math.round(w), 8);
    ctx.fillStyle = '#f6ead0'; ctx.fillText(txt, Math.round(x), Math.round(y + 0.5));
  }
  function onDraw(ctx, camX, camY, T) {
    var m = marks(); if (!m) return;
    ctx.save();
    // Titip Jual: striped awning over a counter, a crate of goods on it
    var x = m.consign.x * T - camX, y = m.consign.y * T - camY;
    ctx.fillStyle = '#6a4020'; ctx.fillRect(x + 1, y + 5, T - 2, T - 5);
    ctx.fillStyle = '#b8864a'; ctx.fillRect(x + 1, y + 5, T - 2, 2);
    for (var i = 0; i < 4; i++) { ctx.fillStyle = i % 2 ? '#f6ead0' : '#c8503c'; ctx.fillRect(x + 1 + i * 3, y + 1, 3, 4); }
    ctx.fillStyle = '#e8c070'; ctx.fillRect(x + 4, y + 7, 4, 3);
    label(ctx, 'Titip Jual', x + T / 2, y - 4);
    // Papan Juara: a board on two posts with a gold star
    x = m.board.x * T - camX; y = m.board.y * T - camY;
    ctx.fillStyle = '#6a4020'; ctx.fillRect(x + 2, y + 6, 1, T - 6); ctx.fillRect(x + T - 3, y + 6, 1, T - 6);
    ctx.fillStyle = '#3a2a40'; ctx.fillRect(x, y + 1, T, 7);
    ctx.fillStyle = '#f6ead0'; ctx.fillRect(x + 1, y + 2, T - 2, 5);
    ctx.fillStyle = '#e8b030'; ctx.fillRect(x + 5, y + 3, 2, 3); ctx.fillRect(x + 4, y + 4, 4, 1);
    label(ctx, 'Papan Juara', x + T / 2, y - 4);
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
