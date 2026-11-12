/*
 * interior.js - things to do with the furniture inside houses (all client-side and visual; nothing changes on the
 * server). Face a piece and press Space / F, or click it:
 *   bed        a short nap: the room dims, "Zzz" rises, you wake up refreshed
 *   bookshelf  a book with a useful tip about the game
 *   tv         the town news: today's live prices from the merchants
 *   fridge     a glass of orange juice
 *   plant      you water it
 *   table      a snack at the table
 * Every other tile keeps the engine's own line of text.
 */
(function () {
  'use strict';
  var GT = window.GT;
  if (!GT) return;
  var napping = false;

  var TIPS = [
    $t('Buku "Pedagang Pintar": harga naik kalau stok pedagang sedikit. Jual saat stoknya kosong, beli saat penuh.'),
    $t('Buku "Kebun Untuk Pemula": cangkul petak, tanam Gandum, siram tiap hari. Panen setelah 3 hari permainan.'),
    $t('Buku "Tukang Hebat": tukang yang lelah bekerja lambat. Isi lemari Restoran supaya mereka makan.'),
    $t('Buku "Peta Desa": perahu di pantai timur menuju pulau di pojok kanan bawah.'),
    $t('Buku "Hemat Energi": makan Roti atau Ikan Bakar untuk mengisi energi sebelum menebang.'),
    $t('Buku "Gudang Ajaib": Gudang di Homeland membuat semua bangunan menyimpan lebih banyak hasil.')
  ];

  function float(text) { if (window.GT_FX && GT_FX.float) GT_FX.float({ x: GT.player.x, y: GT.player.y - 1 }, text, '#ffffff'); }
  function nap() {
    if (napping) return;
    napping = true;
    var dim = document.createElement('div'); dim.className = 'gt-nap'; document.body.appendChild(dim);
    float('Zzz');
    setTimeout(function () { float('Zzz'); }, 600);
    setTimeout(function () { dim.classList.add('wake'); GT.toast('😴 ' + $t('Kamu tidur siang sebentar. Segar lagi!')); }, 1500);
    setTimeout(function () { if (dim.parentNode) dim.parentNode.removeChild(dim); napping = false; }, 2300);
  }
  function news() {
    var C = window.GT_CHAIN, m = C && C.state && C.state.market, lines = [];
    var items = (C && C.state && C.state.cfg && C.state.cfg.econ && C.state.cfg.econ.items) || {};
    (Array.isArray(m) ? m : (m && m.merchants) || []).forEach(function (sh) {
      if (sh.open === false) { lines.push($t('Berita: toko {0} sedang tutup.', [sh.shop || sh.id])); return; }
      var it = (sh.items || []).filter(function (i) { return i.ask != null; })[0];
      if (it) lines.push($t('Berita: {0} menjual {1} seharga {2} koin hari ini.', [sh.shop || sh.id, (items[it.token] && items[it.token].name) || it.token, it.ask]));
    });
    if (!lines.length) lines.push($t('Berita: cuaca cerah, pasar ramai. Datang ke Pasar untuk harga terbaru.'));
    GT.dialog([lines.slice(0, 3).join('\n')], '📺 ' + $t('TV Desa'));
  }

  function onInteract(ctx) {
    if (ctx.scene.kind === 'out' || ctx.npc || ctx.mode !== 'talk' || ctx.door) return false;
    var t = ctx.tileType;
    if (t === 'bed') { nap(); return true; }
    if (t === 'bookshelf') { GT.dialog([TIPS[Math.floor(Math.random() * TIPS.length)]], '📚 ' + $t('Rak Buku')); return true; }
    if (t === 'tv') { news(); return true; }
    if (t === 'fridge') { float('🧃'); GT.toast($t('Segelas jus jeruk dingin. Segar!')); return true; }
    if (t === 'plant') { float('💧'); GT.toast($t('Kamu menyiram tanamannya. Daunnya berkilau.')); return true; }
    if (t === 'table') { float('🍌'); GT.toast($t('Kamu makan sepotong pisang goreng. Enak!')); return true; }
    return false;
  }

  GT.register({ id: 'interior', onInteract: onInteract });
})();
