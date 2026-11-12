/*
 * interior.js - things to do with the furniture inside houses (all client-side and visual; nothing changes on the
 * server). Face a piece and press Space / F, or click it:
 *   bed        a short nap: the room dims, "Zzz" rises, you wake up refreshed
 *   bookshelf  a book with a useful tip about the game
 *   tv         the town news: today's live prices from the merchants
 *   fridge     a glass of orange juice
 *   plant      you water it; the third time it blooms
 *   table      a snack at the table
 *   chest      in your own house it opens your bag (your storage); in someone else's it stays locked
 * The furniture you face shows an icon and a verb above it (chairs too: the engine seats you), so the room says what
 * it can do. Every other tile keeps the engine's own line of text.
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

  // watering a plant three times makes it bloom (per plant, until the page is reloaded)
  var watered = {};
  function water(ctx) {
    var k = (ctx.scene.key || '') + ':' + ctx.tile.x + ',' + ctx.tile.y, n = watered[k] = (watered[k] || 0) + 1;
    if (n === 3) { float('🌸'); GT.toast($t('Tanamannya berbunga! Rumahmu jadi lebih segar.')); return; }
    float('💧'); GT.toast(n > 3 ? $t('Tanamannya sudah mekar dan segar.') : $t('Kamu menyiram tanamannya. Daunnya berkilau.'));
  }
  // the chest is the player's own storage: in your own house it opens the bag; in someone else's it stays shut
  function chest(ctx) {
    var h = ctx.scene.house, C = window.GT_CHAIN;
    if (h && h.own && C && C.state && C.state.account) { float('📦'); C.open('bag'); return; }
    GT.dialog([h && h.own ? $t('Peti penyimpananmu. Masuk dulu untuk melihat isi tasmu.') : $t('Peti milik pemilik rumah. Terkunci rapat.')], '📦 ' + $t('Peti'));
  }

  function onInteract(ctx) {
    if (ctx.scene.kind === 'out' || ctx.npc || ctx.mode !== 'talk' || ctx.door) return false;
    var t = ctx.tileType;
    if (t === 'bed') { nap(); return true; }
    if (t === 'bookshelf') { GT.dialog([TIPS[Math.floor(Math.random() * TIPS.length)]], '📚 ' + $t('Rak Buku')); return true; }
    if (t === 'tv') { news(); return true; }
    if (t === 'fridge') { float('🧃'); GT.toast($t('Segelas jus jeruk dingin. Segar!')); return true; }
    if (t === 'plant') { water(ctx); return true; }
    if (t === 'table') { float('🍌'); GT.toast($t('Kamu makan sepotong pisang goreng. Enak!')); return true; }
    if (t === 'chest' && ctx.scene.house) { chest(ctx); return true; }
    return false;
  }

  // A small "icon + verb" label over the furniture you face, so you can see what it does before pressing Space / F.
  var VERB = {
    bed: ['😴', 'Tidur'], bookshelf: ['📚', 'Baca'], tv: ['📺', 'Nonton'], fridge: ['🧃', 'Minum'], plant: ['💧', 'Siram'],
    table: ['🍌', 'Makan'], chair: ['🪑', 'Duduk'], chest: ['📦', 'Buka']
  };
  function onDraw(ctx, camX, camY, T) {
    var sc = GT.scene, TH = window.GT_THEME;
    if (!TH || !sc || sc.kind === 'out' || !sc.map || napping || GT.isUiOpen() || GT.sitting || (GT.player && GT.player.moving)) return;
    var f = GT.facing(), m = sc.map;
    if (!f || f.x < 0 || f.y < 0 || f.x >= m.w || f.y >= m.h) return;
    var t = m.tiles[f.y * m.w + f.x], v = VERB[t];
    if (!v || (t === 'chest' && !sc.house)) return;
    var a = GT.at(f.x, f.y);
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    TH.label(ctx, v[0] + ' ' + $t(v[1]), GT.snap(a.x + T / 2), GT.snap(a.y - 2), { tone: 'dark', size: 6 });
    ctx.restore();
  }

  GT.register({ id: 'interior', onInteract: onInteract, init: function (g) { g.register({ id: 'interior-hint', onDraw: onDraw }); } });
})();
