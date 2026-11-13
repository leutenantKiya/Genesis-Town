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
 *   Genesis Mall counter     GT_MALL.open()           (the client's shop mod; nothing happens until it exists)
 *   Genesis Casino tables    GT_CASINO.open(tile)     tile = slot | card_table | dice_table | roulette (the roulette is the Luck Table)
 *   News Hall wall / board   GT_BOARD.leaderboard()   the big leaderboard wall;  GT_BOARD.news()  the news boards
 * The furniture you face shows an icon and a verb above it (chairs too: the engine seats you), so the room says what
 * it can do. Every other tile keeps the engine's own line of text.
 */
(function () {
  'use strict';
  var GT = window.GT;
  if (!GT) return;
  var napping = false;
  function sfx(n, o) { try { window.GT_SFX && GT_SFX.play(n, o); } catch (e) { /* sound must never break the game */ } }
  var lastKind = null; // door sound when the scene switches between outside and a room
  function doorWatch() { var k = GT.scene && GT.scene.kind; if (lastKind !== null && k && k !== lastKind && (k === 'out' || lastKind === 'out')) sfx('door'); if (k) lastKind = k; }

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
    napping = true; sfx('notify');
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
    sfx('water'); if (n === 3) { float('🌸'); GT.toast($t('Tanamannya berbunga! Rumahmu jadi lebih segar.')); return; }
    float('💧'); GT.toast(n > 3 ? $t('Tanamannya sudah mekar dan segar.') : $t('Kamu menyiram tanamannya. Daunnya berkilau.'));
  }
  // the chest is the player's own storage: in your own house it opens the bag; in someone else's it stays shut
  function chest(ctx) {
    var h = ctx.scene.house, C = window.GT_CHAIN;
    if (h && h.own && C && C.state && C.state.account) { float('📦'); C.open('bag'); return; }
    GT.dialog([h && h.own ? $t('Peti penyimpananmu. Masuk dulu untuk melihat isi tasmu.') : $t('Peti milik pemilik rumah. Terkunci rapat.')], '📦 ' + $t('Peti'));
  }

  // Spots of the new public buildings. Each calls a hook another mod adds later; without it the engine shows the tile's own text.
  var CASINO_TILES = { slot: 1, card_table: 1, dice_table: 1, roulette: 1 };
  function hook(name, fn, arg) {
    var o = window[name];
    if (!o || typeof o[fn] !== 'function') return false;
    sfx('ui_click'); try { o[fn](arg); } catch (e) { /* a broken shop mod must not break the room */ }
    return true;
  }
  function spot(ctx, t) {
    var k = ctx.scene.house && ctx.scene.house.kind;
    if (k === 'mall' && t === 'counter') return hook('GT_MALL', 'open');
    if (k === 'casino' && ctx.scene.kind === 'kasino' && CASINO_TILES[t]) return hook('GT_CASINO', 'open', t);
    if (k === 'papan' && t === 'lb_wall') return hook('GT_BOARD', 'leaderboard');
    if (k === 'papan' && t === 'news_board') return hook('GT_BOARD', 'news');
    return false;
  }

  function onInteract(ctx) {
    if (ctx.scene.kind === 'out' || ctx.npc || ctx.mode !== 'talk' || ctx.door) return false;
    var t = ctx.tileType;
    if (spot(ctx, t)) return true;
    if (t === 'bed') { nap(); return true; }
    if (t === 'bookshelf') { sfx('ui_click'); GT.dialog([TIPS[Math.floor(Math.random() * TIPS.length)]], '📚 ' + $t('Rak Buku')); return true; }
    if (t === 'tv') { sfx('ui_click'); news(); return true; }
    if (t === 'fridge') { sfx('eat'); float('🧃'); GT.toast($t('Segelas jus jeruk dingin. Segar!')); return true; }
    if (t === 'plant') { water(ctx); return true; }
    if (t === 'table') { sfx('eat'); float('🍌'); GT.toast($t('Kamu makan sepotong pisang goreng. Enak!')); return true; }
    if (t === 'chest' && ctx.scene.house) { chest(ctx); return true; }
    return false;
  }

  // A small "icon + verb" label over the furniture you face, so you can see what it does before pressing Space / F.
  var VERB = {
    bed: ['😴', 'Tidur'], bookshelf: ['📚', 'Baca'], tv: ['📺', 'Nonton'], fridge: ['🧃', 'Minum'], plant: ['💧', 'Siram'],
    table: ['🍌', 'Makan'], chair: ['🪑', 'Duduk'], chest: ['📦', 'Buka']
  };
  // the icon + verb of the new spots, only while their hook exists
  function spotVerb(sc, t) {
    var k = sc.house && sc.house.kind;
    if (k === 'mall' && t === 'counter' && window.GT_MALL) return ['🛍️', 'Belanja'];
    if (k === 'casino' && sc.kind === 'kasino' && CASINO_TILES[t] && window.GT_CASINO) return ['🎲', 'Main'];
    if (k === 'papan' && t === 'lb_wall' && window.GT_BOARD) return ['🏆', 'Papan Juara'];
    if (k === 'papan' && t === 'news_board' && window.GT_BOARD) return ['📰', 'Berita'];
    return null;
  }
  function onDraw(ctx, camX, camY, T) {
    var sc = GT.scene, TH = window.GT_THEME;
    if (!TH || !sc || sc.kind === 'out' || !sc.map || napping || GT.isUiOpen() || GT.sitting || (GT.player && GT.player.moving)) return;
    var f = GT.facing(), m = sc.map;
    if (!f || f.x < 0 || f.y < 0 || f.x >= m.w || f.y >= m.h) return;
    var t = m.tiles[f.y * m.w + f.x], v = spotVerb(sc, t) || VERB[t];
    if (!v || (t === 'chest' && !sc.house)) return;
    var a = GT.at(f.x, f.y);
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    TH.label(ctx, v[0] + ' ' + $t(v[1]), GT.snap(a.x + T / 2), GT.snap(a.y - 2), { tone: 'dark', size: 6 });
    ctx.restore();
  }

  GT.register({ id: 'interior', onInteract: onInteract, onFrame: doorWatch, init: function (g) { g.register({ id: 'interior-hint', onDraw: onDraw }); } });
})();
