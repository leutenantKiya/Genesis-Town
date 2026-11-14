/*
 * interior.js - things to do with the furniture inside houses (all client-side and visual; nothing changes on the
 * server). Face a piece and press Space / F, or click it:
 *   bed        a nap: you lie in the bed, cinematic camera + lullaby + a "your energy is charging" banner; move to get up
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
  /* Napping: face a bed and press the action key. The character lies on the bed (engine.js sleepIn; the player's tile for
     the server does not change), the screen gets letterbox bars, the camera eases in (2.5D: GT_VIEW3D.cine; 2D: a slow
     zoom of the canvas), a lullaby plays (GT_MUSIC.sleep) and an iPhone-style banner says the energy is charging. Any
     movement (keys, joystick, click-to-walk, the action key, a scene change) clears GT.sitting and wakes the player,
     who stands next to the bed again. The energy itself is the server's (food or the next day); the banner shows its real value. */
  var sleepUi = null, sleepClock = 0, pingAt = 0, zzAt = 0;
  function reduced() { return document.documentElement.classList.contains('gt-reduced-motion'); }
  function energyPct() {
    var C = window.GT_CHAIN, st = C && C.state && C.state.st;
    return st && st.energyMax > 0 ? Math.max(0, Math.min(100, Math.round(100 * st.energy / st.energyMax))) : null;
  }
  function bannerText() { var n = energyPct(); return n == null ? $t('Energimu sedang diisi ⚡') : $t('Energimu sedang diisi ⚡ {0}%', [n]); }
  function el(cls, html) { var d = document.createElement('div'); d.className = cls; if (html) d.innerHTML = html; return d; }
  function nap() {
    if (napping || GT.sitting) return;
    var f = GT.facing && GT.facing();
    if (!f || !GT.sleepIn) return;
    GT.sleepIn(f.x, f.y);
    napping = true; sfx('notify');
    var top = el('gt-cine gt-cine-top'), bot = el('gt-cine gt-cine-bot');
    var ban = el('gt-ios', '<div class="gt-ios-ic">⚡</div><div class="gt-ios-tx"><div class="gt-ios-top"><b>Genesis Town</b><span></span></div><div class="gt-ios-msg"></div></div>');
    ban.querySelector('.gt-ios-top span').textContent = $t('sekarang');
    ban.querySelector('.gt-ios-msg').textContent = bannerText();
    document.body.appendChild(top); document.body.appendChild(bot); document.body.appendChild(ban);
    var v3 = GT.view3dOn && GT.view3dOn(), cv = document.getElementById('cv');
    sleepUi = { top: top, bot: bot, ban: ban, v3: !!v3, cv: cv };
    void top.offsetWidth; // bars and banner slide in from the next frame
    top.classList.add('on'); bot.classList.add('on'); ban.classList.add('on');
    if (v3 && window.GT_VIEW3D && GT_VIEW3D.cine) GT_VIEW3D.cine(true);
    else if (cv) { cv.style.transition = reduced() ? 'none' : 'scale 4s ease-in-out'; cv.style.scale = '1.28'; }
    try { window.GT_MUSIC && GT_MUSIC.sleep(true); } catch (e) { /* music must never break the game */ }
    var now = performance.now(); pingAt = now + 20000; zzAt = now + 1200; sleepClock = 0;
    float('Zzz');
  }
  function wake() {
    var u = sleepUi; sleepUi = null; napping = false;
    if (!u) return;
    if (u.v3 && window.GT_VIEW3D && GT_VIEW3D.cine) GT_VIEW3D.cine(false);
    if (u.cv) { u.cv.style.scale = ''; setTimeout(function () { if (!sleepUi) u.cv.style.transition = ''; }, 1200); if (reduced()) u.cv.style.transition = 'none'; else u.cv.style.transition = 'scale .9s ease-out'; }
    try { window.GT_MUSIC && GT_MUSIC.sleep(false); } catch (e) { /* ignore */ }
    [u.top, u.bot, u.ban].forEach(function (d) { d.classList.remove('on'); });
    setTimeout(function () { [u.top, u.bot, u.ban].forEach(function (d) { if (d.parentNode) d.parentNode.removeChild(d); }); }, 1300);
    sfx('ui_click');
  }
  function sleepTick(dt) {
    if (!napping) return;
    var sit = GT.sitting;
    if (!sit || !sit.sleep) { wake(); return; }
    var now = performance.now();
    sleepClock += dt;
    var msg = sleepUi && sleepUi.ban.querySelector('.gt-ios-msg'), txt = bannerText();
    if (msg && msg.textContent !== txt) msg.textContent = txt;
    if (now > zzAt) { zzAt = now + 2600; float('Zzz'); }
    if (now > pingAt && sleepUi) { // the gentle re-ping: the banner nudges and a soft chime
      pingAt = now + 20000; sfx('notify', { vol: 0.5 });
      var b = sleepUi.ban; b.classList.remove('ping'); void b.offsetWidth; b.classList.add('ping');
    }
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

  GT.register({ id: 'interior', onInteract: onInteract, onFrame: function (dt) { doorWatch(); sleepTick(dt); }, init: function (g) { g.register({ id: 'interior-hint', onDraw: onDraw }); } });
})();
