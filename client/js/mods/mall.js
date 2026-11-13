/*
 * mall.js - the Genesis Mall: cosmetics for your character, bought with coin. Tabs per slot (hat, outfit, cape, pet,
 * emote, name colour, decoration), every piece drawn in code, a live preview of your character wearing it, Buy and Wear.
 *   window.GT_MALL = { open(slot?) }     opened by the Mall counter inside the building (interior.js), by the Mall stand
 *   window.GT_WORN = {...}               what a player wears, for every mod that draws a character:
 *     defs(worn)                          worn {slot: id} -> pieces for SPRITES.drawWorn (hat, outfit, cape, pet, decor)
 *     pal(look, worn)                     look + the worn pieces in one number, for the 2.5D actor (SPRITES.wornCombo)
 *     back / front(ctx, x, y, worn, dir, step)   the layers under and over the character (2D)
 *     draw(ctx, x, y, look, worn, dir, step)     back + character + front (a preview on its own canvas; the world goes through GT.drawChar)
 *     nameColor(worn), emote(worn)        the name tag colour and the emote glyph (or null)
 *     item(id), items(), name(id)         the catalogue (the server's when /api/config sends it, else the table below)
 * The server (act mall: buy | wear, state.cosmetics {owned, worn}) is the memory; this file only shows it.
 */
(function () {
  'use strict';
  var GT = window.GT;
  if (!GT) return;

  var SLOTS = ['hat', 'outfit', 'cape', 'pet', 'emote', 'namecolor', 'decor'];
  var SLOT_ICON = { hat: '🎩', outfit: '👕', cape: '🧣', pet: '🐾', emote: '🎉', namecolor: '🏷️', decor: '🏮' };
  function slotName(s) {
    return { hat: $t('Topi'), outfit: $t('Baju'), cape: $t('Jubah'), pet: $t('Hewan'), emote: $t('Emote'), namecolor: $t('Warna nama'), decor: $t('Hiasan') }[s] || s;
  }
  // The catalogue as economy/config.json `mall.items` has it (the server is the price list: the same ids, a buy at another price is refused).
  var T = [
    ['hat_straw', 'hat', 20, 'brim', '#d8b04a', '#a07a2c', 'Straw Hat', 'Topi Jerami'],
    ['hat_cap', 'hat', 30, 'cap', '#4a7ac8', '#2c4a86', "Farmer's Cap", 'Topi Petani'],
    ['hat_beret', 'hat', 45, 'beret', '#b83a5a', '#7c2038', "Painter's Beret", 'Baret Pelukis'],
    ['hat_wizard', 'hat', 120, 'wizard', '#4a3a9a', '#f2d030', 'Starry Wizard Hat', 'Topi Penyihir Bintang'],
    ['hat_knight', 'hat', 200, 'helm', '#a8b0b8', '#d84a4a', "Knight's Helm", 'Helm Kesatria'],
    ['hat_crown', 'hat', 400, 'crown', '#f2d030', '#d84a4a', 'Golden Crown', 'Mahkota Emas'],
    ['outfit_tunic', 'outfit', 40, 'tunic', '#5a8a4a', '#3a5a2c', 'Village Tunic', 'Tunik Desa'],
    ['outfit_vest', 'outfit', 70, 'vest', '#8a4a2c', '#d8b04a', 'Merchant Vest', 'Rompi Saudagar'],
    ['outfit_overalls', 'outfit', 90, 'overalls', '#3a5a9a', '#d8b04a', 'Carpenter Overalls', 'Overall Tukang Kayu'],
    ['outfit_robe', 'outfit', 150, 'robe', '#7a3a9a', '#f2e0a0', 'Scholar Robe', 'Jubah Cendekia'],
    ['outfit_dress', 'outfit', 180, 'dress', '#d84a7a', '#f2e0a0', 'Festival Dress', 'Gaun Pesta'],
    ['outfit_armor', 'outfit', 300, 'armor', '#8a929a', '#3a4a6a', 'Steel Armor', 'Zirah Baja'],
    ['cape_short', 'cape', 60, 'short', '#c8442c', '#8a2c1c', 'Short Cape', 'Jubah Pendek'],
    ['cape_long', 'cape', 250, 'long', '#7a1c3a', '#f2d030', 'Royal Cape', 'Jubah Kerajaan'],
    ['pet_cat', 'pet', 80, 'cat', '#d89a4a', '#8a5a2c', 'Cat', 'Kucing'],
    ['pet_dog', 'pet', 100, 'dog', '#b88a5a', '#6a4a2c', 'Dog', 'Anjing'],
    ['pet_bird', 'pet', 60, 'bird', '#4ab8d8', '#2c7a9a', 'Bird', 'Burung'],
    ['pet_fox', 'pet', 220, 'fox', '#e0642c', '#f2e0c0', 'Fox', 'Rubah'],
    ['emote_wave', 'emote', 20, 'wave', '#f2c230', '#a07a2c', 'Wave', 'Lambaian'],
    ['emote_dance', 'emote', 50, 'dance', '#d84a7a', '#7c2038', 'Dance', 'Menari'],
    ['emote_cheer', 'emote', 35, 'cheer', '#5ac85a', '#2c7a2c', 'Cheer', 'Sorak'],
    ['name_gold', 'namecolor', 100, 'plain', '#f2c230', '#a07a2c', 'Gold Name', 'Nama Emas'],
    ['name_sky', 'namecolor', 60, 'plain', '#5ab8f2', '#2c7ab8', 'Sky Name', 'Nama Langit'],
    ['name_rose', 'namecolor', 60, 'plain', '#f27aa8', '#b83a6a', 'Rose Name', 'Nama Mawar'],
    ['decor_banner', 'decor', 50, 'banner', '#c8442c', '#f2d030', 'Banner', 'Panji'],
    ['decor_lantern', 'decor', 70, 'lantern', '#f2a230', '#5a3a1c', 'Lantern', 'Lentera'],
    ['decor_flowers', 'decor', 40, 'flowerbox', '#e04a8a', '#3a7a3a', 'Flower Box', 'Kotak Bunga'],
    ['decor_statue', 'decor', 350, 'statue', '#b8b8b0', '#6a6a64', 'Little Statue', 'Patung Mungil']
  ];
  var FALLBACK = T.map(function (r) { return { id: r[0], slot: r[1], price: r[2], shape: r[3], color: r[4], color2: r[5], name: r[6], nameId: r[7] }; });
  var ID_NAME = {}; FALLBACK.forEach(function (it) { ID_NAME[it.id] = it.nameId; });
  var EMOTE = { wave: '👋', dance: '💃', cheer: '🎉' };

  function C() { return window.GT_CHAIN; }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function lang() { return window.GT_LANG === 'id' ? 'id' : 'en'; }

  /* ---------------------------------------------------------------- the catalogue */
  function items() {
    var c = C(), m = c && c.state && c.state.cfg && c.state.cfg.econ && c.state.cfg.econ.mall;
    return m && m.items && m.items.length ? m.items : FALLBACK;
  }
  function item(id) { var a = items(); for (var i = 0; i < a.length; i++) if (a[i].id === id) return a[i]; return null; }
  function name(id) {
    var it = item(id);
    if (!it) return String(id);
    return lang() === 'id' && ID_NAME[id] ? ID_NAME[id] : it.name;
  }

  /* ---------------------------------------------------------------- what a player wears */
  var DRAWN = { hat: 1, outfit: 1, cape: 1, pet: 1, decor: 1 };
  function defs(worn) {
    var out = [];
    if (!worn) return out;
    SLOTS.forEach(function (s) {
      var it = DRAWN[s] && worn[s] ? item(worn[s]) : null;
      if (it) out.push({ slot: it.slot, shape: it.shape, color: it.color, color2: it.color2 });
    });
    return out;
  }
  function pal(look, worn) {
    var S = window.SPRITES, id = S && S.wornCombo ? S.wornCombo(defs(worn)) : 0;
    return (look & 15) | (id << 4);
  }
  function back(ctx, x, y, worn, dir, step) { var d = defs(worn); if (d.length && window.SPRITES && SPRITES.drawWorn) SPRITES.drawWorn(ctx, x, y, d, dir, step, 'back'); }
  function front(ctx, x, y, worn, dir, step) { var d = defs(worn); if (d.length && window.SPRITES && SPRITES.drawWorn) SPRITES.drawWorn(ctx, x, y, d, dir, step, 'front'); }
  function draw(ctx, x, y, look, worn, dir, step) {
    back(ctx, x, y, worn, dir, step);
    SPRITES.drawCharacter(ctx, x, y, look, dir, step); // not GT.drawChar: no ground shadow and no bench seat in a preview
    front(ctx, x, y, worn, dir, step);
  }
  function nameColor(worn) { var it = worn && worn.namecolor ? item(worn.namecolor) : null; return it ? it.color : null; }
  function emote(worn) { var it = worn && worn.emote ? item(worn.emote) : null; return it ? (EMOTE[it.shape] || '✨') : null; }
  window.GT_WORN = { defs: defs, pal: pal, back: back, front: front, draw: draw, nameColor: nameColor, emote: emote, item: item, items: items, name: name, slots: SLOTS };

  /* ---------------------------------------------------------------- the window */
  function mineLook() { var m = window.GT_CHARSCREEN && GT_CHARSCREEN._mine && GT_CHARSCREEN._mine(); return m ? m.look | 0 : 0; }
  function cos() { var c = C(), st = c && c.state.st; return (st && st.cosmetics) || { owned: [], worn: {} }; }
  function coins() { var c = C(), st = c && c.state.st, b = st && st.bag && st.bag.coin; return b ? b.settled + b.today : 0; }

  // a small character wearing some pieces (the preview), or one piece on its own (a card): painted on a 20x24 canvas, scaled by CSS
  function figure(look, wornMap, scale, dir) {
    var cv = document.createElement('canvas'); cv.width = 20; cv.height = 24; cv.className = 'gt-mall-fig'; cv.setAttribute('aria-hidden', 'true');
    cv.style.width = 20 * scale + 'px'; cv.style.height = 24 * scale + 'px';
    var g = cv.getContext('2d');
    draw(g, 4, 10, look, wornMap, dir || 'down', 0);
    return cv;
  }
  function sample(it) {
    var wrap = el('div', 'gt-mall-sample');
    if (it.slot === 'namecolor') { var t = el('span', 'gt-mall-name', $t('Namamu')); t.style.color = it.color; wrap.appendChild(t); return wrap; }
    if (it.slot === 'emote') { wrap.appendChild(el('span', 'gt-mall-emote', EMOTE[it.shape] || '✨')); return wrap; }
    var w = {}; w[it.slot] = it.id;
    wrap.appendChild(figure(0, w, 2));
    return wrap;
  }

  var win = null;
  function open(slot) {
    var c = C();
    if (!c || !c.state.account) { GT.toast($t('Masuk dulu.')); if (c && c.login) c.login(); return; }
    if (win && win.h.isOpen()) win.h.close('again');
    var tab = SLOTS.indexOf(slot) >= 0 ? slot : 'hat', tryOn = {}, busy = false, body = el('div', 'gt-mall');
    var h = GT.modal({ title: '🛍️ ' + $t('Genesis Mall'), wide: true, body: body, onClose: function () { win = null; }, actions: [{ label: $t('Tutup'), close: true }] });
    win = { h: h };

    function act(payload) {
      if (busy) return;
      busy = true;
      c.act(payload).then(function () { busy = false; paint(); }, function () { busy = false; paint(); });
    }
    function paint() {
      body.textContent = '';
      var owned = {}, k = cos();
      (k.owned || []).forEach(function (id) { owned[id] = 1; });
      var worn = k.worn || {};
      var top = el('div', 'gt-mall-top');
      // left: you, as you will look
      var pv = el('div', 'gt-mall-pv'), wornNow = {};
      Object.keys(worn).forEach(function (s) { wornNow[s] = worn[s]; });
      Object.keys(tryOn).forEach(function (s) { wornNow[s] = tryOn[s]; });
      pv.appendChild(figure(mineLook(), wornNow, 5));
      var nm = (window.GT_CHARSCREEN && GT_CHARSCREEN._mine && GT_CHARSCREEN._mine().name) || '';
      var tag = el('div', 'gt-mall-pvname', nm || $t('Kamu')); var nc = nameColor(wornNow); if (nc) tag.style.color = nc;
      pv.appendChild(tag);
      top.appendChild(pv);
      var info = el('div', 'gt-mall-info');
      info.appendChild(el('p', 'gt-mall-coins', $t('Koinmu: {0}', [coins()])));
      info.appendChild(el('p', 'chain-dim', $t('Pilih barang untuk mencoba. Beli sekali, pakai kapan saja. Pakaian dilihat pemain lain di sekitarmu.')));
      info.appendChild(el('p', 'chain-dim', $t('Belanja hanya di dalam gedung Mall (atau dekat pintunya); memakai dan melepas bisa di mana saja.')));
      if (window.GT_HLGEAR) { // gear for your own workers (the old plaza stand's shop), same counter
        var gb = el('button', 'mbtn', '👷 ' + $t('Perlengkapan pekerja')); gb.type = 'button';
        gb.addEventListener('click', function () { h.close('gear'); window.GT_HLGEAR.open(); });
        info.appendChild(gb);
      }
      top.appendChild(info);
      body.appendChild(top);
      // tabs
      var tabs = el('div', 'gt-mall-tabs'); tabs.setAttribute('role', 'tablist');
      SLOTS.forEach(function (s) {
        var b = el('button', 'gt-mall-tab' + (s === tab ? ' on' : ''), SLOT_ICON[s] + ' ' + slotName(s)); b.type = 'button'; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', s === tab ? 'true' : 'false');
        b.addEventListener('click', function () { tab = s; tryOn = {}; paint(); });
        tabs.appendChild(b);
      });
      body.appendChild(tabs);
      // cards
      var grid = el('div', 'gt-mall-grid');
      items().filter(function (it) { return it.slot === tab; }).forEach(function (it) {
        var has = !!owned[it.id], on = worn[it.slot] === it.id, trying = tryOn[it.slot] === it.id;
        var card = el('div', 'gt-mall-card' + (on ? ' worn' : '') + (trying ? ' try' : ''));
        var pick = el('button', 'gt-mall-pick'); pick.type = 'button'; pick.setAttribute('aria-label', $t('Coba {0}', [name(it.id)]));
        pick.appendChild(sample(it));
        pick.appendChild(el('span', 'gt-mall-nm', name(it.id)));
        pick.addEventListener('click', function () { if (tryOn[it.slot] === it.id) delete tryOn[it.slot]; else tryOn[it.slot] = it.id; paint(); });
        card.appendChild(pick);
        var row = el('div', 'gt-mall-acts');
        if (!has) {
          var buy = el('button', 'mbtn primary', $t('Beli · {0} koin', [it.price])); buy.type = 'button'; buy.disabled = busy || coins() < it.price;
          buy.addEventListener('click', function () { act({ action: 'mall', op: 'buy', id: it.id }); });
          row.appendChild(buy);
        } else if (on) {
          var off = el('button', 'mbtn', $t('Lepas')); off.type = 'button'; off.disabled = busy;
          off.addEventListener('click', function () { act({ action: 'mall', op: 'wear', slot: it.slot, id: null }); });
          row.appendChild(el('span', 'gt-mall-state', '✓ ' + $t('Dipakai')));
          row.appendChild(off);
        } else {
          var wear = el('button', 'mbtn primary', $t('Pakai')); wear.type = 'button'; wear.disabled = busy;
          wear.addEventListener('click', function () { delete tryOn[it.slot]; act({ action: 'mall', op: 'wear', slot: it.slot, id: it.id }); });
          row.appendChild(el('span', 'gt-mall-state', $t('Sudah punya')));
          row.appendChild(wear);
        }
        card.appendChild(row);
        grid.appendChild(card);
      });
      body.appendChild(grid);
    }
    paint();
    // the newest state (coins, what you own), then redraw
    c.refresh(true).then(function () { if (h.isOpen()) paint(); }, function () { /* keep what is shown */ });
  }

  window.GT_MALL = { open: open };
})();
