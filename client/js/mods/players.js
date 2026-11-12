/*
 * players.js - seeing each other: other players walk around the village, with their name and market title over
 * their heads, and a global chat (press C, or "/" for a command). "/msg name text" is private; "/block name" hides
 * someone's lines in this browser; "/nama NamaBaru" changes your name. Click another player for their card
 * (message them, look at their stall). Indoors you are hidden; your house stays yours.
 * Everything is per world: you see and talk to players on the same island only ("public" or "IS-<id>"); "/msg" is
 * 1:1 and also reaches players in another world. Name, #tag and look are picked on the character screen after login (mods/charscreen.js).
 * The server keeps presence and chat in memory (server/src/social.ts); the economy is unchanged.
 */
(function () {
  'use strict';
  var GT = window.GT;
  if (!GT) return;

  var others = {};        // account -> { nick, title, x, y, fx, fy, dir, t0, moving, seen }
  var meTag = '', me = null, online = 0, last = 0, timer = 0, busy = false, backoff = 0, curWorld = null, named = true; // named: has the server a chosen display name for me
  var lines = [];         // chat lines shown in the box
  var bubbles = {};       // nick (lower) -> { text, t }
  var box = null, list = null, input = null, head = null;
  var LS_BLOCK = 'gt.chat.blocked';
  var STEP_MS = 700;

  function C() { return window.GT_CHAIN; }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function blocked() { try { return JSON.parse(localStorage.getItem(LS_BLOCK) || '[]') || []; } catch (e) { return []; } }
  function setBlocked(a) { try { localStorage.setItem(LS_BLOCK, JSON.stringify(a)); } catch (e) { /* storage blocked */ } }
  // chat identity is always name#tag (names repeat, tags do not), never the plain name
  function key(nick, tag) { return String(nick).toLowerCase() + '#' + (tag || ''); }
  function isBlocked(nick, tag) { return blocked().indexOf(key(nick, tag)) >= 0; }
  function tagsOfName(name) { var n = String(name).toLowerCase(), t = {}; Object.keys(others).forEach(function (a) { var o = others[a]; if (String(o.nick).toLowerCase() === n && o.tag) t[o.tag] = 1; }); lines.forEach(function (m) { if (m.fromTag && String(m.from).toLowerCase() === n && m.from !== me) t[m.fromTag] = 1; }); return Object.keys(t); }
  function pal(nick) { var h = 0; for (var i = 0; i < nick.length; i++) h = (h * 31 + nick.charCodeAt(i)) | 0; return Math.abs(h) % 9; }
  // Guests: with no account (and a reachable server) the visitor walks the public village as "Tamu": no keys, no chat.
  var guestId = '', guestNick = '', guestBusy = false, guestRetryAt = 0, guestToldFull = false;
  function guestMode() { var c = C(); return !!(c && !c.state.account && c.state.mode !== 'loading' && !/[?&]mode=offline/.test(location.search) && location.protocol !== 'file:'); }
  function leaveGuest() { if (guestId) { guestId = ''; guestNick = ''; me = null; others = {}; curWorld = null; guestToldFull = false; } }
  function guestTick() {
    var c = C(), now = Date.now();
    if (guestBusy || document.hidden || now < guestRetryAt) return;
    guestBusy = true;
    var p = GT.player, pos = c.standPos();
    var go = guestId ? Promise.resolve() : c.api('/guest/hello', { method: 'POST', body: {} }).then(function (h) { guestId = h.guest; guestNick = h.nick; guestToldFull = false; });
    go.then(function () {
      return c.api('/guest/presence', { method: 'POST', body: { guest: guestId, x: pos.x, y: pos.y, dir: p.dir } });
    }).then(function (r) {
      if (c.state.account) return; // signed in meanwhile: the account loop takes over
      curWorld = 'public'; me = r.me; online = r.online; meTag = '';
      // the server picks a guest's look: draw it on our side too, so the guest sees what everyone else sees
      if (window.GT_CHARSCREEN && r.look != null) window.GT_CHARSCREEN.setMine(r.me, '', r.look, false);
      applyPlayers(r.players || []);
      renderHead();
    }, function (e) {
      if (e && e.status === 404) guestId = ''; // expired: say hello again
      else if (e && e.status === 403) { // kicked or address banned by an admin: say so once and stop knocking until the page is reloaded
        GT.toast((e.message || $t('Kamu dikeluarkan dari desa.'))); guestRetryAt = Date.now() + 365 * 86400000; me = null; others = {}; renderHead();
      }
      else if (e && e.status === 429 && !guestId) { if (!guestToldFull) { guestToldFull = true; GT.toast($t('Desa sedang penuh tamu, coba lagi nanti.')); } guestRetryAt = Date.now() + 20000; }
      else guestRetryAt = Date.now() + 5000;
    }).then(function () { guestBusy = false; });
  }
  function applyPlayers(list) {
    var now = performance.now(), keep = {};
    list.forEach(function (q) {
      keep[q.account] = 1;
      var o = others[q.account];
      if (!o) o = others[q.account] = { fx: q.x, fy: q.y, x: q.x, y: q.y, t0: now };
      if (o.x !== q.x || o.y !== q.y) { o.fx = curX(o, now); o.fy = curY(o, now); o.x = q.x; o.y = q.y; o.t0 = now; }
      o.nick = q.nick; o.tag = q.tag; o.look = q.look; o.title = q.title; o.npc = !!q.npc; o.guest = !!q.guest; o.merchant = q.merchant; o.dir = q.dir; o.account = q.account; o.party = !!q.party; o.seen = now;
    });
    Object.keys(others).forEach(function (a) { if (!keep[a]) delete others[a]; });
  }
  function active() { var c = C(); return !!(c && c.state.account && c.state.mode !== 'offline' && c.state.mode !== 'loading' && !c.state.superseded); }

  /* ---------------------------------------------------------------- presence loop */
  function tick() {
    if (guestMode()) { guestTick(); return; }
    if (guestId) leaveGuest();
    if (busy || !active() || document.hidden) return;
    var c = C(), sc = GT.scene, p = GT.player, pos = c.standPos(), w = (GT.worldId && GT.worldId()) || 'public';
    if (curWorld !== w) { curWorld = w; others = {}; } // other players belong to the world they are in
    busy = true;
    c.api('/presence', { method: 'POST', body: { world: w, x: pos.x, y: pos.y, dir: p.dir, scene: sc && sc.kind === 'out' ? 'out' : 'in', since: last } }).then(function (r) {
      if (r.world !== curWorld) return;
      backoff = 0;
      me = r.me; meTag = r.tag || meTag; online = r.online;
      named = r.named !== false; if (named && GT.setPlayerName) GT.setPlayerName(me);
      if (window.GT_CHARSCREEN) window.GT_CHARSCREEN.setMine(r.me, r.tag, r.look, named);
      applyPlayers(r.players || []);
      (r.chat || []).forEach(addLine);
      last = r.last || last;
      presenceFns.forEach(function (f) { try { f(r); } catch (e) { /* a listener must not break the loop */ } });
      renderHead();
    }, function () { backoff = Math.min(8, backoff + 1); }).then(function () { busy = false; });
  }
  function ease(o, now) { return Math.min(1, (now - o.t0) / STEP_MS); }
  function curX(o, now) { return o.fx + (o.x - o.fx) * ease(o, now); }
  function curY(o, now) { return o.fy + (o.y - o.fy) * ease(o, now); }

  /* ---------------------------------------------------------------- drawing */
  function onEntities(ents, ctx, camX, camY, T) {
    if (!GT.scene || GT.scene.kind !== 'out') return;
    var now = performance.now();
    Object.keys(others).forEach(function (a) {
      var o = others[a];
      if (o.npc) return; // merchants are already drawn (and clickable) as stall NPCs by chain.js; here they only get a name tag
      var x = curX(o, now), y = curY(o, now), px = x * T, py = y * T;
      var moving = ease(o, now) < 1, step = moving ? (Math.floor(now / 160) % 2 ? 1 : 2) : 0;
      var look = o.look != null ? o.look : pal(o.nick || a);
      // px/py/pal/dir/step/id: the 2.5D view (mods/view3d.js) draws the same player as a 3D card
      ents.push({ py: py, px: px, pal: look, dir: o.dir, step: step, id: 'player:' + a, draw: function () { GT.drawChar(ctx, px - camX, py - camY, look, o.dir, step); } });
    });
  }
  // Name tags and bubbles are collected first, then placed so none sits on another: tags that share a row within a
  // few pixels step up, and every bubble goes above its tag, the player's own on top.
  function tone() { return window.GT_THEME ? GT_THEME : null; }
  function fitBubble(ctx, k, now) {
    var b = bubbles[k];
    if (!b || now - b.t > 6000) return null;
    ctx.font = '7px "Pixelify Sans", sans-serif';
    var text = b.text;
    if (ctx.measureText(text).width > 96) { while (text.length > 1 && ctx.measureText(text + '…').width > 96) text = text.slice(0, -1); text += '…'; }
    return text;
  }
  function overlaps(a, b) { return Math.abs(a.x - b.x) < (a.w + b.w) / 2 + 1 && Math.abs(a.y - b.y) < 9; }
  function onDraw(ctx, camX, camY, T) {
    var TH = tone();
    if (!TH || !GT.scene || GT.scene.kind !== 'out') return;
    var now = performance.now(), W = ctx.canvas.width / (ctx.getTransform().a || 1);
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    var tags = [], bubs = [], placed = [];
    Object.keys(others).forEach(function (a) {
      var o = others[a], cx = curX(o, now);
      var at = GT.at(cx, curY(o, now)); // in 2.5D this follows the head at any camera turn
      var x = GT.snap(at.x + T / 2), y = GT.snap(at.y - 3 - (o.npc && Math.round(cx) % 2 ? 9 : 0)); // neighbouring merchant tags alternate in height
      var small = o.guest || !!guestId, sz = small ? 5 : 7; // a guest's own tag is small and dim; a guest sees everyone's tags small
      ctx.font = sz + 'px "Pixelify Sans", sans-serif';
      var text = o.guest ? $t('Tamu') : o.nick + (!o.npc && o.title && o.title !== $t('Pedagang baru') ? ' · ' + o.title : ''); // merchants stand a tile apart: name only, the stall sign has the shop name
      tags.push({ x: x, y: y, w: Math.ceil(ctx.measureText(text).width) + 4, text: text, tone: o.guest ? 'dim' : o.npc ? 'accent' : o.party ? 'party' : 'dark', size: sz, k: key(o.nick, o.tag) });
    });
    tags.sort(function (p, q) { return q.y - p.y || p.x - q.x; }); // lowest first: the ones behind step up
    tags.forEach(function (t) {
      for (var n = 0; n < 4; n++) { var hit = placed.some(function (p) { return overlaps(p, t); }); if (!hit) break; t.y -= 9; }
      placed.push(t);
      TH.label(ctx, t.text, t.x, t.y, { tone: t.tone, size: t.size });
      var bt = fitBubble(ctx, t.k, now);
      if (bt) bubs.push({ x: t.x, y: t.y - 10, text: bt, tag: t });
    });
    if (me && !guestId) {
      var p = GT.player, mt = fitBubble(ctx, key(me, meTag), now), ma = GT.at(p.x, p.y);
      if (mt) bubs.push({ x: GT.snap(ma.x + T / 2), y: GT.snap(ma.y - 4), text: mt, mine: true });
    }
    bubs.sort(function (p, q) { return (p.mine ? 1 : 0) - (q.mine ? 1 : 0) || q.y - p.y; }); // my own bubble is drawn last, on top
    var bp = placed.slice(); // bubbles also keep clear of every name tag
    bubs.forEach(function (b) {
      ctx.font = '7px "Pixelify Sans", sans-serif';
      var w = Math.ceil(ctx.measureText(b.text).width) + 6;
      b.w = w;
      for (var n = 0; n < 6; n++) { if (!bp.some(function (q) { return q !== b.tag && Math.abs(q.x - b.x) < (q.w + w) / 2 + 1 && Math.abs(q.y - b.y) < 12; })) break; b.y -= 11; }
      bp.push(b);
      bubble(ctx, TH, b, W);
    });
    arrows(ctx, TH, W, T, now);
    ctx.restore();
  }
  // a small arrow on the screen edge towards each party mate who is off screen (GT.at projects in 2D and 2.5D alike)
  function arrows(ctx, TH, W, T, now) {
    var H = ctx.canvas.height / (ctx.getTransform().d || 1), m = 10;
    Object.keys(others).forEach(function (a) {
      var o = others[a]; if (!o.party) return;
      var at = GT.at(curX(o, now), curY(o, now)), x = at.x + T / 2, y = at.y + T / 2;
      if (x >= 0 && x <= W && y >= 0 && y <= H) return;
      var cx = W / 2, cy = H / 2, dx = x - cx, dy = y - cy, k = Math.min((W / 2 - m) / (Math.abs(dx) || 1e-6), (H / 2 - m) / (Math.abs(dy) || 1e-6));
      var ex = GT.snap(cx + dx * k), ey = GT.snap(cy + dy * k), ang = Math.atan2(dy, dx);
      ctx.save(); ctx.translate(ex, ey); ctx.rotate(ang);
      ctx.fillStyle = '#000'; ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(-4, -5); ctx.lineTo(-4, 5); ctx.closePath(); ctx.fill();
      ctx.fillStyle = TH.get('good') || '#2f7d4a'; ctx.beginPath(); ctx.moveTo(4.5, 0); ctx.lineTo(-3, -3.5); ctx.lineTo(-3, 3.5); ctx.closePath(); ctx.fill();
      ctx.restore();
      ctx.textAlign = ex > W / 2 ? 'right' : 'left'; ctx.textBaseline = 'bottom'; ctx.font = '7px "Pixelify Sans", sans-serif';
      TH.label(ctx, o.nick, Math.max(24, Math.min(W - 24, ex)), Math.max(18, Math.min(H - 4, ey - 8)), { tone: 'party' });
      ctx.textAlign = 'center';
    });
  }
  function bubble(ctx, TH, b, W) {
    var x = Math.max(Math.ceil(b.w / 2) + 1, Math.min(W - Math.ceil(b.w / 2) - 1, b.x)); // keep it on screen
    TH.label(ctx, b.text, x, b.y, { tone: 'paper', size: 7 });
    ctx.fillStyle = TH.get('paper-ink'); ctx.fillRect(GT.snap(Math.max(x - 1, Math.min(b.x, x + 1))), b.y + 1, 2, 2); // the tail points at the speaker
  }

  /* ---------------------------------------------------------------- chat box */
  function build() {
    var screen = document.getElementById('screen');
    if (!screen || box) return;
    box = el('section', 'gt-chat'); box.setAttribute('aria-label', $t('Obrolan'));
    head = el('div', 'gt-chat-head');
    list = el('div', 'gt-chat-list'); list.setAttribute('role', 'log'); list.setAttribute('aria-live', 'polite');
    var form = el('form', 'gt-chat-form');
    input = el('input', 'gt-chat-input'); input.type = 'text'; input.maxLength = 120; input.placeholder = $t('Ketik pesan · /msg nama pesan · /help'); input.setAttribute('aria-label', $t('Pesan'));
    input.autocomplete = 'off'; input.spellcheck = false;
    form.appendChild(input);
    box.appendChild(head); box.appendChild(list); box.appendChild(form);
    screen.appendChild(box);
    // typing never reaches the game's keys
    input.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); closeChat(); }
    });
    input.addEventListener('keyup', function (e) { e.stopPropagation(); });
    form.addEventListener('submit', function (e) { e.preventDefault(); send(input.value); });
    renderHead();
  }
  function renderHead() {
    if (!head) return;
    head.textContent = (me ? $t('Kamu: {0}', [me]) : $t('Obrolan')) + (online ? $t(' · {0} online', [online]) : '');
  }
  function addLine(m) {
    if (!m.note && isBlocked(m.from, m.fromTag)) return;
    lines.push(m);
    if (lines.length > 60) lines.shift();
    if (!m.to && !m.party) bubbles[key(m.from, m.fromTag)] = { text: m.text, t: performance.now() };
    renderList();
  }
  function note(text) { lines.push({ id: 0, t: Date.now(), from: '', to: null, text: text, note: true }); renderList(); }
  function renderList() {
    if (!list) return;
    list.textContent = '';
    var mine = key(me || '', meTag);
    lines.slice(-30).forEach(function (m) {
      var row = el('div', 'gt-chat-line' + (m.to ? ' private' : '') + (m.party ? ' party' : '') + (m.note ? ' note' : ''));
      row.dataset.t = String(m.t || Date.now());
      if (m.note) row.textContent = m.text;
      else {
        var from = m.from + (m.fromTag ? '#' + m.fromTag : ''), to = m.to ? m.to + (m.toTag ? '#' + m.toTag : '') : '';
        var who = m.party ? $t('[Party] {0}', [from]) : m.to ? (key(m.from, m.fromTag) === mine ? $t('kamu → {0}', [to]) : $t('{0} → kamu', [from])) : from;
        row.appendChild(el('b', null, who + ': '));
        row.appendChild(document.createTextNode(m.text));
      }
      list.appendChild(row);
    });
    list.scrollTop = list.scrollHeight;
    fade();
  }
  function fade() {
    if (!list) return;
    var open = box.classList.contains('open'), now = Date.now();
    [].forEach.call(list.children, function (r) { r.classList.toggle('old', !open && now - (+r.dataset.t || 0) > 12000); });
  }
  function openChat(prefill) {
    if (!active()) { if (C()) GT.toast($t('Masuk dulu untuk mengobrol.')); return; }
    build();
    box.classList.add('open');
    document.documentElement.classList.add('gt-chatting');
    if (prefill != null) input.value = prefill;
    fade();
    setTimeout(function () { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 0);
    if (!named && window.GT_CHARSCREEN) { GT.toast($t('Pilih namamu dulu di layar karakter.')); window.GT_CHARSCREEN.open(); }
  }
  function closeChat() {
    if (!box) return;
    box.classList.remove('open');
    document.documentElement.classList.remove('gt-chatting');
    input.blur();
    fade();
  }
  function send(raw) {
    var text = String(raw || '').trim();
    if (!text) { closeChat(); return; }
    var m;
    if (/^\/help$/i.test(text)) { note($t('Obrolan hanya dengan pemain di pulau yang sama (maks 80 huruf, 1 pesan / 2 detik). /msg nama pesan · pesan pribadi (lintas pulau) | /p pesan · pesan ke party (dari dunia mana pun) | /block nama · sembunyikan pesannya | /unblock nama | /nama NamaBaru · ganti nama | /party nama#tag · ajak ke party')); input.value = ''; return; }
    if ((m = /^\/(block|unblock)\s+(.+)$/i.exec(text))) {
      var target = m[2].trim(), tm = /^(.+)#(\d{5})$/.exec(target), tk;
      if (tm) tk = key(tm[1], tm[2]);
      else {
        var ts = tagsOfName(target);
        if (ts.length !== 1) { note(ts.length ? $t('Ada beberapa pemain bernama {0}. Pakai nama#tag.', [target]) : $t('Pemain {0} belum terlihat. Pakai nama#tag.', [target])); input.value = ''; return; }
        tk = key(target, ts[0]);
      }
      var b = blocked().filter(function (n) { return n !== tk; });
      if (m[1].toLowerCase() === 'block') b.push(tk);
      setBlocked(b); note(m[1].toLowerCase() === 'block' ? $t('{0} disembunyikan di browser ini.', [target]) : $t('{0} terlihat lagi.', [target]));
      input.value = ''; return;
    }
    if ((m = /^\/(party|ajak)\s+(.+)$/i.exec(text))) {
      input.value = '';
      if (window.GT_PARTY) GT_PARTY.invite(m[2].trim()).then(function () { closeChat(); });
      return;
    }
    if ((m = /^\/(dagang|trade)\s+(.+)$/i.exec(text))) {
      input.value = '';
      if (window.GT_TRADE) GT_TRADE.start(m[2].trim()).then(function () { closeChat(); });
      return;
    }
    if ((m = /^\/(nama|name|nick)\s+(.+)$/i.exec(text))) {
      C().api('/name', { method: 'POST', body: { name: m[2].trim() } }).then(function (r) { me = r.name; meTag = r.tag || meTag; named = r.named !== false; if (GT.setPlayerName) GT.setPlayerName(r.name); renderHead(); note($t('Namamu sekarang {0}#{1}.', [r.name, r.tag])); }, function (e) { note(e.message); });
      input.value = ''; return;
    }
    input.value = '';
    C().api('/chat', { method: 'POST', body: { world: (GT.worldId && GT.worldId()) || 'public', text: text } }).then(function () { tick(); }, function (e) { note(e.message); input.value = text; });
  }

  /* ---------------------------------------------------------------- player card */
  function playerAt(t) {
    var now = performance.now(), hit = null;
    Object.keys(others).forEach(function (a) { var o = others[a]; if (Math.round(curX(o, now)) === t.x && Math.round(curY(o, now)) === t.y) hit = o; });
    return hit;
  }
  var presenceFns = []; // other mods listen to each successful presence answer
  var cardActions = []; // other mods add buttons: fn(player) -> {label, onClick(handle)} | null
  function card(o) {
    var body = el('div', 'gt-pcard');
    if (o.npc) {
      body.appendChild(el('p', 'gt-pcard-title', o.title || $t('Pedagang')));
      body.appendChild(el('p', 'chain-dim', $t('Pedagang desa. Tanyakan harga lewat obrolan, atau lihat dagangannya.')));
      GT.modal({ title: o.nick + '#' + (o.tag || 'NPC'), body: body, actions: [
        { label: $t('Lihat dagangan'), primary: true, onClick: function (h) { h.close('ok'); var c = C(); if (c && o.merchant) c.open('shop', o.merchant); return true; } },
        { label: $t('Tanya'), onClick: function (h) { h.close('ok'); openChat('/msg ' + o.nick + ' '); return true; } }
      ] });
      return;
    }
    body.appendChild(el('p', 'gt-pcard-title', o.title || $t('Pedagang baru')));
    if (o.tag) body.appendChild(el('p', 'gt-data', o.nick + '#' + o.tag));
    body.appendChild(el('p', 'chain-dim', $t('Warga desa yang sedang jalan-jalan.')));
    var extra = cardActions.map(function (f) { try { return f(o); } catch (e) { return null; } }).filter(Boolean);
    GT.modal({ title: o.nick + (o.tag ? '#' + o.tag : ''), body: body, actions: [
      { label: $t('Kirim pesan'), primary: true, onClick: function (h) { h.close('ok'); openChat('/msg ' + o.nick + (o.tag ? '#' + o.tag : '') + ' '); return true; } },
      { label: $t('Lihat lapaknya'), onClick: function (h) { h.close('ok'); var c = C(); c.state.marketSeller = { account: o.account, nick: o.nick }; c.state.marketTab = 'lapak'; c.open('market'); return true; } }
    ].concat(extra) });
  }

  function onKey(e) {
    if (e.type !== 'keydown' || e.repeat || GT.isUiOpen()) return false;
    if (document.documentElement.classList.contains('gt-fishing') || document.documentElement.classList.contains('gt-fighting')) return false;
    if (e.code === 'KeyC') { openChat(''); return true; }
    if (e.code === 'Slash') { openChat('/'); return true; }
    return false;
  }

  function init() {
    timer = setInterval(function () { if (backoff) { backoff--; return; } tick(); }, STEP_MS);
    setInterval(fade, 2000);
    var cv = document.getElementById('cv');
    if (cv) cv.addEventListener('click', function (e) {
      if (e.button !== 0 || GT.isUiOpen() || !GT.screenToTile || !GT.scene || GT.scene.kind !== 'out') return;
      var t = GT.screenToTile(e.clientX, e.clientY), o = t && playerAt(t);
      if (!o) return;
      e.stopImmediatePropagation(); e.preventDefault();
      card(o);
    }, true);
    // build the box once signed in, so recent lines show even before the first message
    var wait = setInterval(function () { if (active()) { build(); clearInterval(wait); } }, 1000);
  }

  function refresh() { others = {}; curWorld = null; backoff = 0; tick(); } // after sailing: forget the old world's players at once
  window.GT_PLAYERS = { onPresence: function (f) { presenceFns.push(f); }, addCardAction: function (f) { cardActions.push(f); }, refresh: refresh, promptName: function () { if (window.GT_CHARSCREEN) window.GT_CHARSCREEN.open(); }, openChat: openChat, closeChat: closeChat, _others: function () { return others; }, _lines: function () { return lines; } };
  GT.register({ id: 'players', init: function (g) { init(g); g.register({ id: 'players-labels', onDraw: onDraw }); }, onEntities: onEntities, onKey: onKey }); // tags and bubbles register last from init, so they draw over every other mod's signs
})();
