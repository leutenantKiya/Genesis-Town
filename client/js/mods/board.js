/*
 * board.js - the News Hall's two boards (interior.js calls these when you use the furniture):
 *   GT_BOARD.leaderboard(period?)   the big leaderboard wall: the top sellers (Papan Juara data, GET /api/leaderboard)
 *   GT_BOARD.news()                 the news board: what happened in town lately (GET /api/news, public)
 */
(function () {
  'use strict';
  var GT = window.GT;
  if (!GT) return;

  function C() { return window.GT_CHAIN; }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  var cur = null; // the window that is open (one board at a time)
  function show(opts) { if (cur && cur.isOpen()) cur.close('switch'); cur = GT.modal(opts); return cur; }

  /* ---------------------------------------------------------------- leaderboard */
  function leaderboard(period) {
    var c = C();
    period = period === 'all' ? 'all' : 'day';
    if (!c || !c.state.account) { GT.toast($t('Masuk dulu.')); return; }
    c.api('/leaderboard?period=' + period).then(function (r) {
      var body = el('div', 'gt-board');
      body.appendChild(el('p', 'chain-dim', period === 'day' ? $t('Penjual teratas hari ini') : $t('Penjual teratas sepanjang masa')));
      var rows = r.rows || [];
      if (!rows.length) body.appendChild(el('p', 'chain-dim', $t('Belum ada yang berjualan.')));
      rows.forEach(function (x) {
        var mine = r.me && r.me.rank === x.rank;
        var row = el('div', 'tr-rank' + (mine ? ' me' : ''));
        row.appendChild(el('span', 'tr-rk', x.rank <= 3 ? ['🥇', '🥈', '🥉'][x.rank - 1] : '#' + x.rank));
        row.appendChild(el('span', 'tr-nm', x.name + '#' + x.tag + (mine ? $t(' (kamu)') : '')));
        row.appendChild(el('span', 'tr-sc', $t('{0} barang · {1} koin', [x.sold_qty, x.coin])));
        body.appendChild(row);
      });
      if (r.me && r.me.rank > 10) body.appendChild(el('p', 'tr-me', $t('Kamu: peringkat {0} · {1} barang · {2} koin', [r.me.rank, r.me.sold_qty, r.me.coin])));
      else if (!r.me) body.appendChild(el('p', 'chain-dim', $t('Kamu belum berjualan{0}', [period === 'day' ? $t(' hari ini.') : '.'])));
      show({
        title: '🏆 ' + $t('Papan Juara · {0}', [period === 'day' ? $t('hari ini') : $t('sepanjang masa')]), body: body, wide: true,
        actions: [{ label: period === 'day' ? $t('Sepanjang masa') : $t('Hari ini'), onClick: function () { leaderboard(period === 'day' ? 'all' : 'day'); return true; } }, { label: $t('Tutup'), close: true }]
      });
    }, function (e) { GT.toast((e && e.message) || $t('Gagal memuat.')); });
  }

  /* ---------------------------------------------------------------- news */
  var KIND_ICON = { building: '🏗️', settlement: '📒', top_seller: '🏆', price: '📈' };
  function ago(t) {
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 90) return $t('baru saja');
    var m = Math.round(s / 60);
    if (m < 90) return $t('{0} menit lalu', [m]);
    var h = Math.round(m / 60);
    if (h < 36) return $t('{0} jam lalu', [h]);
    return $t('{0} hari lalu', [Math.round(h / 24)]);
  }
  function news() {
    var c = C();
    if (!c) return;
    c.api('/news').then(function (r) {
      var body = el('div', 'gt-board gt-news'), list = (r && r.news) || [];
      body.appendChild(el('p', 'chain-dim', $t('Kabar terbaru dari desa: bangunan jadi, hari yang tercatat, penjual teratas dan harga yang bergerak.')));
      if (!list.length) body.appendChild(el('p', null, $t('Belum ada kabar hari ini.')));
      list.forEach(function (n) {
        var row = el('div', 'gt-news-row');
        row.appendChild(el('span', 'gt-news-ic', KIND_ICON[n.kind] || '📰'));
        var tx = el('div', 'grow');
        tx.appendChild(el('div', null, n.text));
        tx.appendChild(el('div', 'chain-dim', ago(n.t)));
        row.appendChild(tx);
        body.appendChild(row);
      });
      show({ title: '📰 ' + $t('Berita Desa'), body: body, wide: true, actions: [{ label: $t('Tutup'), close: true }] });
    }, function (e) { GT.toast((e && e.message) || $t('Gagal memuat.')); });
  }

  window.GT_BOARD = { leaderboard: leaderboard, news: news };
})();
