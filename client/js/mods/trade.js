/*
 * Public-area economy (client of server/src/game/trade.ts, leaderboard.ts):
 *  - "Trade" on a player card (mods/players.js), "Dagang" in the party panel and /dagang nama#tag open a live trade window (client of the
 *    /api/trade/open|join|set|ready|close sessions): both put in items and coin, both press Siap, any change clears both, then a 3 s countdown
 *    works in the village and in a Homeland; an invitation pops up with Buka / Tolak
 *  - when a trade completes, the goods each side gave fly across to the other player (arcing icons, a sparkle where they
 *    land, a short sound); both windows read the swapped lines from the finished session (`result`) and play it.
 *    Every purchase plays the same (GT_TRADE.deal): buying from or selling to a merchant, a Player Market buy, and a
 *    merchant buying a player's listing; the seller and players nearby see it through the presence answer (`deals`)
 *  - Papan Juara board: top sellers today / of all time
 * The board and the luck table stand at fixed plaza tiles from GTVillage.landmarks (same on the server). Only in the public area.
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
  function sfx(n, o) { try { window.GT_SFX && GT_SFX.play(n, o); } catch (e) { /* sound never breaks play */ } }
  function fail(e) { sfx('error'); GT.toast(e.message || $t('Gagal.')); }
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
    if (s.status === 'done') { sfx('trade_done'); flyStart(s); } else sfx('ui_close', { vol: 0.6 });
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
    sfx('ui_click', { vol: 0.5 });
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
        sfx('ui_click');
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
      title: $t('Dagang dengan {0}', [otherName(s)]), sticky: true, body: body, wide: true, actions: [],
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
    sfx('notify');
    GT.toast($t('{0} mengajak dagang!', [i.other.name]));
    invPop = GT.modal({
      title: $t('Ajakan dagang'), sticky: true, body: $t('{0} mengajak dagang', [otherName(i)]), actions: [
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

  /* ---------------------------------------------------------------- the trade animation
     What I gave flies from me to the other player, what I got flies from them to me: one small icon per kind of item
     (a gold coin for coin), on an arc, staggered a little, with the amount beside it; where each lands there is a
     sparkle. Original art, drawn on the overlay canvas: positions are tiles and go through GT.at every frame, so the
     camera (2D or 2.5D) can move meanwhile. The other player is placed by players.js (GT_PLAYERS.where); when they are
     not on screen the goods leave and arrive above my head.
     Every purchase plays the same: a merchant trade, a Player Market buy, a merchant buying a listing (`deal`). Mine
     play at once from chain.js; the rest come with the presence answer (`deals`, server social.ts), so the seller and
     anyone nearby see them too. An anonymous seller has no place: their side is the spot above the buyer. */
  var flies = [], sparks = [], iconCache = {}, FLY_MS = 950, STAGGER_MS = 130, SPARK_MS = 520;
  function flyIcon(token) {
    if (token === 'coin' || !window.GT_ITEMS) return null;
    return iconCache[token] || (iconCache[token] = GT_ITEMS.icon(token, 16));
  }
  function myAccount() { var s = S(); return s && s.account; }
  /** Goods moving between two sides: `aGot` flies from b to a, `bGot` from a to b. A side is an account (null: unknown).
   *  While a window covers the town (a shop, the Pasar) the deal waits, summed with others between the same two sides,
   *  and flies when the window closes, like a trade does. */
  var held = [];
  function deal(a, b, aGot, bGot) {
    if (GT.isUiOpen && GT.isUiOpen()) {
      var h = held.filter(function (x) { return x.a === a && x.b === b; })[0];
      if (!h) { if (held.length >= 8) held.shift(); held.push(h = { a: a, b: b, aGot: {}, bGot: {} }); }
      [['aGot', aGot], ['bGot', bGot]].forEach(function (p) { Object.keys(p[1] || {}).forEach(function (t) { h[p[0]][t] = (h[p[0]][t] || 0) + p[1][t]; }); });
      return;
    }
    launch(a, b, aGot, bGot);
  }
  function launch(a, b, aGot, bGot) {
    var t0 = performance.now(), n = 0;
    function add(lines, from, to) {
      Object.keys(lines || {}).forEach(function (tok) { if (lines[tok] > 0) flies.push({ token: tok, qty: lines[tok], from: from, to: to, t0: t0 + n * STAGGER_MS, done: false }); n++; });
      n = 0; // the two directions leave together
    }
    add(bGot, a, b); add(aGot, b, a);
    if (flies.length > 24) flies.splice(0, flies.length - 24);
  }
  function flyStart(s) {
    var r = s && s.result; if (!r) return;
    launch(myAccount(), s.other && s.other.account, r.got, r.gave);
  }
  /** A deal from the presence answer: mine already played when I made it (shop and Pasar buys). */
  function onDeals(r) {
    var me = myAccount();
    (r.deals || []).forEach(function (d) {
      if (d.a === me && d.kind !== 'npc') return;
      if (d.a === me || d.b === me) sfx('trade_done', { vol: 0.5 });
      deal(d.a, d.b, d.aGot, d.bGot);
    });
  }
  function spot(o, T) { // the screen point of a player's chest, in drawing units: o = {x, y} in tiles, or null
    if (!o) return null;
    var a = GT.at(o.x, o.y); return { x: a.x + T / 2, y: a.y + T / 2 - 2 };
  }
  function spark(x, y, now) { sparks.push({ x: x, y: y, t0: now }); }
  function star(ctx, x, y, r, col) { // a four-point star, pixel-sized
    ctx.fillStyle = col;
    ctx.fillRect(Math.round(x - 0.5), Math.round(y - r), 1, Math.round(r * 2) + 1);
    ctx.fillRect(Math.round(x - r), Math.round(y - 0.5), Math.round(r * 2) + 1, 1);
  }
  function drawCoin(ctx, x, y) {
    ctx.fillStyle = '#7a4a10'; ctx.fillRect(x - 4, y - 3, 8, 6); ctx.fillRect(x - 3, y - 4, 6, 8);
    ctx.fillStyle = '#f2c230'; ctx.fillRect(x - 3, y - 3, 6, 6); ctx.fillRect(x - 2, y - 4, 4, 8);
    ctx.fillStyle = '#fff2a8'; ctx.fillRect(x - 2, y - 3, 2, 2);
    ctx.fillStyle = '#b8801a'; ctx.fillRect(x, y - 1, 1, 3);
  }
  function drawFly(ctx, camX, camY, T) {
    if (held.length && !(GT.isUiOpen && GT.isUiOpen())) { var hs = held; held = []; hs.forEach(function (h) { launch(h.a, h.b, h.aGot, h.bGot); }); }
    if (!flies.length && !sparks.length) return;
    var now = performance.now(), p = GT.player, me = spot({ x: p.x, y: p.y }, T), mine = myAccount();
    if (!me) return;
    function at(acct) { return acct && acct === mine ? me : spot(acct && window.GT_PLAYERS && GT_PLAYERS.where ? GT_PLAYERS.where(acct) : null, T); }
    ctx.save();
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.font = '7px "Rubik", "Pixelify Sans", sans-serif';
    flies = flies.filter(function (f) {
      var u = (now - f.t0) / FLY_MS;
      if (u < 0) return true;
      // a side that is not on screen (or unknown) is the spot up and to the right of the other side
      var from = at(f.from), to = at(f.to);
      if (!from && !to) return false;
      if (!from) from = { x: to.x + T * 2, y: to.y - T * 2 };
      if (!to) to = { x: from.x + T * 2, y: from.y - T * 2 };
      if (u >= 1) {
        if (!f.done) { f.done = true; spark(to.x, to.y, now); if (f.to && f.to === mine) sfx('pickup', { vol: 0.6 }); }
        return false;
      }
      var e = u * u * (3 - 2 * u), arc = Math.sin(Math.PI * e) * (T * 1.6);
      var x = Math.round(from.x + (to.x - from.x) * e), y = Math.round(from.y + (to.y - from.y) * e - arc);
      ctx.globalAlpha = Math.min(1, u * 6);
      var ic = flyIcon(f.token);
      // a little shadow on the way, then the goods
      ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(Math.round(from.x + (to.x - from.x) * e) - 4, Math.round(from.y + (to.y - from.y) * e) + 4, 8, 2);
      if (ic) ctx.drawImage(ic, x - 6, y - 6, 12, 12); else drawCoin(ctx, x, y);
      if (f.qty > 1) { var q = '×' + f.qty; ctx.fillStyle = '#000'; ctx.fillText(q, x + 7, y + 1); ctx.fillStyle = '#fff'; ctx.fillText(q, x + 6, y); }
      ctx.globalAlpha = 1;
      return true;
    });
    sparks = sparks.filter(function (k) {
      var u = (now - k.t0) / SPARK_MS;
      if (u >= 1) return false;
      var r = 3 + u * 7;
      ctx.globalAlpha = 1 - u;
      for (var i = 0; i < 6; i++) { var a = i * Math.PI / 3 + u; star(ctx, k.x + Math.cos(a) * r, k.y + Math.sin(a) * r * 0.8, 1, i % 2 ? '#fff6c0' : '#f2c230'); }
      star(ctx, k.x, k.y, 2 + (1 - u) * 2, '#fffbe0');
      ctx.globalAlpha = 1;
      return true;
    });
    ctx.restore();
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

  /* ---- the Papan Juara under the pointer: a glowing outline on hover; a click opens it when you stand near (3 tiles) ---- */
  var boardHover = false, hoverT = 0, BOARD_NEAR = 3;
  function boardAt(cx, cy) {
    var m = marks(); if (!m || !GT.scene || GT.scene.kind !== 'out' || !GT.screenToTile) return false;
    var t = GT.screenToTile(cx, cy); if (!t) return false;
    var v3 = GT.view3dOn && GT.view3dOn();
    // the board stands up from its tile: in 2.5D the pointer on its face reads as the tile or the one or two behind it
    return t.x === m.board.x && t.y <= m.board.y && t.y >= m.board.y - (v3 ? 2 : 0);
  }
  function onBoardMove(e) {
    var now = performance.now(); if (now - hoverT < 50) return; hoverT = now;
    var cv = document.getElementById('cv');
    var on = !GT.isUiOpen() && e.target === cv && boardAt(e.clientX, e.clientY);
    if (on !== boardHover) { boardHover = on; if (cv) cv.style.cursor = on ? 'pointer' : ''; }
  }
  function onBoardClick(e) {
    if (e.button !== 0 || GT.isUiOpen() || !e.target || e.target.id !== 'cv') return;
    if (window.GT_VIEW3D && GT_VIEW3D.tookClick && GT_VIEW3D.tookClick()) return; // the end of a drag, not a click
    if (!boardAt(e.clientX, e.clientY)) return;
    e.stopImmediatePropagation(); e.preventDefault();
    var m = marks(), p = GT.player;
    if (Math.abs(p.x - m.board.x) + Math.abs(p.y - m.board.y) > BOARD_NEAR) { GT.toast($t('Dekati Papan Juara untuk membacanya.')); return; }
    boardModal('day');
  }
  function drawBoardHover(ctx, T, v3) {
    if (!boardHover || GT.isUiOpen()) { boardHover = boardHover && !GT.isUiOpen(); return; }
    var m = marks(); if (!m) return;
    var a = GT.at(m.board.x, m.board.y), pulse = 0.5 + 0.5 * Math.sin(Date.now() / 260);
    var x = a.x - 2, y = a.y - 1, w = T + 4, h = T + 2;
    var V = window.GT_VIEW3D;
    if (v3 && V && V.toScreen) {
      // 2.5D: the board's own box (a tile wide, about 1.4 tiles tall) projected by the camera, in overlay units
      // camera px -> overlay units: the same factor GT.at uses (its tile point is toScreen(tile centre) scaled, minus 6, 12)
      var cx = m.board.x + 0.5, cz = m.board.y + 0.5, p0 = V.toScreen(cx, cz, 0), xs = [], ys = [];
      var k = p0.x ? (a.x + 6) / p0.x : 1, ky = p0.y ? (a.y + 12) / p0.y : k;
      [[-0.5, 0], [0.5, 0], [-0.5, 1.4], [0.5, 1.4]].forEach(function (q) { var p = V.toScreen(cx + q[0], cz, q[1]); xs.push(p.x * k); ys.push(p.y * ky); });
      x = Math.min.apply(null, xs) - 2; y = Math.min.apply(null, ys) - 2; w = Math.max.apply(null, xs) - x + 2; h = Math.max.apply(null, ys) - y + 2;
    }
    ctx.save();
    ctx.shadowColor = 'rgba(255,224,120,.9)'; ctx.shadowBlur = 4 + 6 * pulse;
    ctx.strokeStyle = 'rgba(255,240,170,' + (0.75 + 0.25 * pulse).toFixed(2) + ')'; ctx.lineWidth = Math.max(1, T / 10); ctx.lineJoin = 'round';
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  /* ---------------------------------------------------------------- engine hooks */
  function onInteract(ctx) {
    if (ctx.scene.kind !== 'out' || ctx.mode !== 'talk' || ctx.npc) return false;
    var m = marks(); if (!m) return false;
    var t = ctx.tile;
    if (t.x === m.board.x && t.y === m.board.y) { boardModal('day'); return true; }
    if (m.gamble && t.x === m.gamble.x && t.y === m.gamble.y) { luckModal(); return true; }
    return false;
  }

  /* ---------------------------------------------------------------- Meja Untung: the free chip game (casino.js), no goods, no coin */
  function luckModal() {
    if (!signedIn()) { GT.toast($t('Masuk dulu.')); return; }
    if (window.GT_CASINO && GT_CASINO.openFree) GT_CASINO.openFree(); else GT.toast($t('Meja Untung belum buka.'));
  }
  function onFrame(dt) {
    pollT -= dt;
    if (pollT <= 0) { pollT = (sess || ui) ? 1 : 3; poll(); }
  }
  // A name sign over a spot, its bottom edge at `bottom` (the shared label style). `placed` collects the signs drawn this frame: a sign that would
  // cover an earlier one (neighbouring doors) is lifted a row, so no two signs overlap.
  function sign(ctx, txt, cx, bottom, placed) {
    var k = (window.GT_THEME && GT_THEME.scale) || 1, w = 0;
    ctx.save(); ctx.font = '600 6px "Rubik", "Pixelify Sans", sans-serif'; w = (Math.ceil(ctx.measureText(txt).width) + 4) * k; ctx.restore();
    var h = 9 * k, y = bottom;
    for (var n = 0; n < 4; n++) {
      var hit = placed.some(function (r) { return Math.abs(r.x - cx) < (r.w + w) / 2 && Math.abs(r.y - y) < h; });
      if (!hit) break;
      y -= h;
    }
    placed.push({ x: cx, y: y, w: w });
    GT_THEME.label(ctx, txt, cx, y, { tone: 'paper', size: 6, bold: true });
  }
  // the public buildings' signs: kind -> icon + name (the Mall, the casino and the news hall read from afar; the rest are the village's services)
  var BUILD_SIGNS = {
    hall: ['🏰', 'Guild'], broker: ['📜', 'Kantor Makelar'], post: ['✉️', 'Kantor Pos'], warung: ['☕', 'Warung Kopi'],
    mall: ['🛍️', 'Mall'], casino: ['🎰', 'Kasino'], papan: ['📰', 'Balai Berita'], tambangpub: ['⛏️', 'Tambang Umum']
  };
  var UP3 = 15; // 2.5D: a sign's bottom edge over a prop, art px above the tile's ground point (the props stand about 1.5 tall)
  var DOOR3 = 12; // 2.5D: over a building's door
  function onDraw(ctx, camX, camY, T) {
    var m = marks(); if (!m || !GT.scene || GT.scene.kind !== 'out') return;
    ctx.save();
    var v3 = GT.view3dOn && GT.view3dOn(), placed = [], L = GT.world.layout;
    // Papan Juara: in 2.5D a 3D prop (three/props.js); in 2D a board on two posts with a gold star
    var a = GT.at(m.board.x, m.board.y);
    if (!v3) {
      var x = a.x, y = a.y;
      ctx.fillStyle = '#6a4020'; ctx.fillRect(x + 2, y + 6, 1, T - 6); ctx.fillRect(x + T - 3, y + 6, 1, T - 6);
      ctx.fillStyle = '#3a2a40'; ctx.fillRect(x, y + 1, T, 7);
      ctx.fillStyle = '#f6ead0'; ctx.fillRect(x + 1, y + 2, T - 2, 5);
      ctx.fillStyle = '#e8b030'; ctx.fillRect(x + 5, y + 3, 2, 3); ctx.fillRect(x + 4, y + 4, 4, 1);
      if (m.gamble) { // the Luck Table (no sign): a green felt table with two dice
        var g = GT.at(m.gamble.x, m.gamble.y); x = g.x; y = g.y;
        ctx.fillStyle = '#5a3a1e'; ctx.fillRect(x + 2, y + 8, 1, T - 8); ctx.fillRect(x + T - 3, y + 8, 1, T - 8);
        ctx.fillStyle = '#2a2430'; ctx.fillRect(x, y + 3, T, 6);
        ctx.fillStyle = '#2f8a4a'; ctx.fillRect(x + 1, y + 4, T - 2, 4);
        ctx.fillStyle = '#f8f4ec'; ctx.fillRect(x + 3, y + 4, 2, 2); ctx.fillRect(x + 7, y + 5, 2, 2);
        ctx.fillStyle = '#c83c3c'; ctx.fillRect(x + 3, y + 4, 1, 1); ctx.fillRect(x + 8, y + 6, 1, 1);
      }
    }
    drawBoardHover(ctx, T, v3);
    sign(ctx, '🏆 ' + $t('Papan Juara'), a.x + T / 2, v3 ? a.y + T - UP3 : a.y - 1, placed);
    (L && L.buildings || []).forEach(function (b) {
      var s = BUILD_SIGNS[b.kind]; if (!s) return;
      var d = GT.at(b.dx, b.dy);
      sign(ctx, s[0] + ' ' + $t(s[1]), d.x + T / 2, v3 ? d.y + T - DOOR3 : d.y - 1, placed);
    });
    ctx.restore();
  }

  function init() {
    C = window.GT_CHAIN || null;
    // the player card (mods/players.js) has its own Trade button and calls GT_TRADE.start
    window.GT_TRADE = { start: startWith, board: boardModal, fly: flyStart, deal: deal };
    if (window.GT_PLAYERS) GT_PLAYERS.onPresence(onDeals);
    window.addEventListener('mousemove', onBoardMove);
    window.addEventListener('click', onBoardClick, true);
  }
  GT.register({ id: 'trade', init: function (g) { init(g); g.register({ id: 'trade-fx', onDraw: drawFly }); }, onInteract: onInteract, onFrame: onFrame, onDraw: onDraw });
})();
