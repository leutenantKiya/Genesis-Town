/*
 * players.js - seeing each other: other players walk around the village, with their name and market title over
 * their heads, and a global chat (press C, or "/" for a command). "/msg name text" is private; "/block name" hides
 * someone's lines in this browser; "/nama NamaBaru" changes your name. Click another player for their card
 * (message them, look at their stall). Indoors you are hidden; your house stays yours.
 * Everything is per world: you see and talk to players on the same island only ("public" or "IS-<id>"); "/msg" is
 * 1:1 and also reaches players in another world. The first time you sign in you pick a name (3-16 characters).
 * The server keeps presence and chat in memory (server/src/social.ts); the economy is unchanged.
 */
(function () {
  'use strict';
  var GT = window.GT;
  if (!GT) return;

  var others = {};        // account -> { nick, title, x, y, fx, fy, dir, t0, moving, seen }
  var me = null, online = 0, last = 0, timer = 0, busy = false, backoff = 0, curWorld = null, promptedFor = null, nameModal = null;
  var lines = [];         // chat lines shown in the box
  var bubbles = {};       // nick (lower) -> { text, t }
  var box = null, list = null, input = null, head = null;
  var LS_BLOCK = 'gt.chat.blocked';
  var STEP_MS = 700;

  function C() { return window.GT_CHAIN; }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function blocked() { try { return JSON.parse(localStorage.getItem(LS_BLOCK) || '[]') || []; } catch (e) { return []; } }
  function setBlocked(a) { try { localStorage.setItem(LS_BLOCK, JSON.stringify(a)); } catch (e) { /* storage blocked */ } }
  function isBlocked(nick) { return blocked().indexOf(String(nick).toLowerCase()) >= 0; }
  function pal(nick) { var h = 0; for (var i = 0; i < nick.length; i++) h = (h * 31 + nick.charCodeAt(i)) | 0; return Math.abs(h) % 9; }
  function active() { var c = C(); return !!(c && c.state.account && c.state.mode !== 'offline' && c.state.mode !== 'loading'); }

  /* ---------------------------------------------------------------- presence loop */
  function tick() {
    if (busy || !active() || document.hidden) return;
    var c = C(), sc = GT.scene, p = GT.player, pos = c.standPos(), w = (GT.worldId && GT.worldId()) || 'public';
    if (curWorld !== w) { curWorld = w; others = {}; } // other players belong to the world they are in
    busy = true;
    c.api('/presence', { method: 'POST', body: { world: w, x: pos.x, y: pos.y, dir: p.dir, scene: sc && sc.kind === 'out' ? 'out' : 'in', since: last } }).then(function (r) {
      if (r.world !== curWorld) return;
      backoff = 0;
      me = r.me; online = r.online;
      if (c.state.st && c.state.st.name && GT.setPlayerName) GT.setPlayerName(c.state.st.name);
      var now = performance.now(), keep = {};
      (r.players || []).forEach(function (q) {
        keep[q.account] = 1;
        var o = others[q.account];
        if (!o) o = others[q.account] = { fx: q.x, fy: q.y, x: q.x, y: q.y, t0: now };
        if (o.x !== q.x || o.y !== q.y) { o.fx = curX(o, now); o.fy = curY(o, now); o.x = q.x; o.y = q.y; o.t0 = now; }
        o.nick = q.nick; o.title = q.title; o.dir = q.dir; o.account = q.account; o.seen = now;
      });
      Object.keys(others).forEach(function (a) { if (!keep[a]) delete others[a]; });
      (r.chat || []).forEach(addLine);
      last = r.last || last;
      renderHead();
      if (c.state.st && !c.state.st.name && !GT.isUiOpen()) promptName(false);
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
      var o = others[a], x = curX(o, now), y = curY(o, now), px = x * T, py = y * T;
      var moving = ease(o, now) < 1, step = moving ? (Math.floor(now / 160) % 2 ? 1 : 2) : 0;
      ents.push({ py: py, draw: function () { GT.drawChar(ctx, px - camX, py - camY, pal(o.nick || a), o.dir, step); } });
    });
  }
  function onDraw(ctx, camX, camY, T) {
    if (!GT.scene || GT.scene.kind !== 'out') return;
    var now = performance.now();
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    // my own last line first, so other players' names stay on top of it
    if (me) { var p = GT.player; bubble(ctx, me, Math.round(p.x * T - camX + T / 2), Math.round(p.y * T - camY - 4), now); }
    Object.keys(others).forEach(function (a) {
      var o = others[a], x = Math.round(curX(o, now) * T - camX + T / 2), y = Math.round(curY(o, now) * T - camY - 3);
      ctx.font = '6px "Pixelify Sans", sans-serif';
      var tag = o.nick + (o.title && o.title !== 'Pedagang baru' ? ' · ' + o.title : '');
      var w = ctx.measureText(tag).width;
      ctx.fillStyle = 'rgba(10,12,24,0.7)'; ctx.fillRect(Math.round(x - w / 2 - 2), y - 7, Math.ceil(w + 4), 8);
      ctx.fillStyle = '#e8f0ff'; ctx.fillText(tag, x, y);
      bubble(ctx, o.nick, x, y - 9, now);
    });
    ctx.restore();
  }
  function bubble(ctx, nick, x, y, now) {
    var b = bubbles[String(nick).toLowerCase()];
    if (!b || now - b.t > 6000) return;
    var text = b.text.length > 34 ? b.text.slice(0, 33) + '…' : b.text;
    ctx.font = '7px "Pixelify Sans", sans-serif';
    var w = ctx.measureText(text).width;
    var bx = Math.round(x - w / 2 - 3), by = y - 10;
    ctx.fillStyle = '#f4f1dc'; ctx.fillRect(bx, by, Math.ceil(w + 6), 10);
    ctx.fillRect(x - 1, by + 10, 2, 2);
    ctx.fillStyle = '#1c1c2c'; ctx.fillText(text, x, by + 9);
  }

  /* ---------------------------------------------------------------- chat box */
  function build() {
    var screen = document.getElementById('screen');
    if (!screen || box) return;
    box = el('section', 'gt-chat'); box.setAttribute('aria-label', 'Obrolan');
    head = el('div', 'gt-chat-head');
    list = el('div', 'gt-chat-list'); list.setAttribute('role', 'log'); list.setAttribute('aria-live', 'polite');
    var form = el('form', 'gt-chat-form');
    input = el('input', 'gt-chat-input'); input.type = 'text'; input.maxLength = 120; input.placeholder = 'Ketik pesan · /msg nama pesan · /help'; input.setAttribute('aria-label', 'Pesan');
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
    head.textContent = (me ? 'Kamu: ' + me : 'Obrolan') + (online ? ' · ' + online + ' online' : '');
  }
  function addLine(m) {
    if (isBlocked(m.from)) return;
    lines.push(m);
    if (lines.length > 60) lines.shift();
    if (!m.to) bubbles[String(m.from).toLowerCase()] = { text: m.text, t: performance.now() };
    renderList();
  }
  function note(text) { lines.push({ id: 0, t: Date.now(), from: '', to: null, text: text, note: true }); renderList(); }
  function renderList() {
    if (!list) return;
    list.textContent = '';
    var mine = String(me || '').toLowerCase();
    lines.slice(-30).forEach(function (m) {
      var row = el('div', 'gt-chat-line' + (m.to ? ' private' : '') + (m.note ? ' note' : ''));
      row.dataset.t = String(m.t || Date.now());
      if (m.note) row.textContent = m.text;
      else {
        var who = m.to ? (String(m.from).toLowerCase() === mine ? 'kamu → ' + m.to : m.from + ' → kamu') : m.from;
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
    if (!active()) { if (C()) GT.toast('Masuk dulu untuk mengobrol.'); return; }
    build();
    box.classList.add('open');
    document.documentElement.classList.add('gt-chatting');
    if (prefill != null) input.value = prefill;
    fade();
    setTimeout(function () { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 0);
    if (C().state.st && !C().state.st.name) promptName(true);
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
    if (/^\/help$/i.test(text)) { note('Obrolan hanya dengan pemain di pulau yang sama (maks 80 huruf, 1 pesan / 2 detik). /msg nama pesan · pesan pribadi (lintas pulau) | /block nama · sembunyikan pesannya | /unblock nama | /nama NamaBaru · ganti nama'); input.value = ''; return; }
    if ((m = /^\/(block|unblock)\s+(.+)$/i.exec(text))) {
      m[2] = m[2].trim();
      var b = blocked().filter(function (n) { return n !== m[2].toLowerCase(); });
      if (m[1].toLowerCase() === 'block') b.push(m[2].toLowerCase());
      setBlocked(b); note(m[1].toLowerCase() === 'block' ? m[2] + ' disembunyikan di browser ini.' : m[2] + ' terlihat lagi.');
      input.value = ''; return;
    }
    if ((m = /^\/(nama|nick)\s+(.+)$/i.exec(text))) {
      C().api('/name', { method: 'POST', body: { name: m[2].trim() } }).then(function (r) { me = r.name; if (C().state.st) C().state.st.name = r.name; if (GT.setPlayerName) GT.setPlayerName(r.name); renderHead(); note('Namamu sekarang ' + r.name + '.'); }, function (e) { note(e.message); });
      input.value = ''; return;
    }
    input.value = '';
    C().api('/chat', { method: 'POST', body: { world: (GT.worldId && GT.worldId()) || 'public', text: text } }).then(function () { tick(); }, function (e) { note(e.message); input.value = text; });
  }

  /* ---------------------------------------------------------------- display name (first login) */
  function promptName(force) {
    var c = C(), acct = c && c.state.account;
    if (!acct || nameModal || (!force && promptedFor === acct)) return;
    promptedFor = acct;
    var body = el('div');
    body.appendChild(el('p', null, 'Pilih nama yang dilihat pemain lain di atas karaktermu. 3-16 karakter: huruf, angka, spasi, _ atau -. Nama tidak boleh sama dengan pemain lain.'));
    var inp = el('input'); inp.type = 'text'; inp.maxLength = 16; inp.autocomplete = 'off'; inp.placeholder = 'Namamu'; inp.setAttribute('data-autofocus', '');
    body.appendChild(inp);
    var h = GT.modal({ title: 'Pilih nama', body: body, actions: [
      { label: 'Nanti saja' },
      { label: 'Simpan', primary: true, onClick: function (mh) {
        var v = String(inp.value || '').trim();
        if (!/^[A-Za-z0-9 _-]{3,16}$/.test(v)) { GT.toast('Nama harus 3-16 karakter: huruf, angka, spasi, _ atau -.'); return false; }
        c.api('/name', { method: 'POST', body: { name: v } }).then(function (r) {
          if (c.state.st) c.state.st.name = r.name;
          me = r.name; renderHead();
          if (GT.setPlayerName) GT.setPlayerName(r.name);
          GT.toast('Halo, ' + r.name + '!');
          mh.close('ok');
        }, function (e) { GT.toast(e && e.message || 'Nama gagal disimpan.'); });
        return false;
      } }
    ], onClose: function () { nameModal = null; } });
    nameModal = h;
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); var pb = h.el && h.el.querySelector('.primary'); if (pb) pb.click(); } });
  }

  /* ---------------------------------------------------------------- player card */
  function playerAt(t) {
    var now = performance.now(), hit = null;
    Object.keys(others).forEach(function (a) { var o = others[a]; if (Math.round(curX(o, now)) === t.x && Math.round(curY(o, now)) === t.y) hit = o; });
    return hit;
  }
  function card(o) {
    var body = el('div', 'gt-pcard');
    body.appendChild(el('p', 'gt-pcard-title', o.title || 'Pedagang baru'));
    body.appendChild(el('p', 'chain-dim', 'Warga desa yang sedang jalan-jalan.'));
    GT.modal({ title: o.nick, body: body, actions: [
      { label: 'Kirim pesan', primary: true, onClick: function (h) { h.close('ok'); openChat('/msg ' + o.nick + ' '); return true; } },
      { label: 'Lihat lapaknya', onClick: function (h) { h.close('ok'); var c = C(); c.state.marketSeller = { account: o.account, nick: o.nick }; c.state.marketTab = 'lapak'; c.open('market'); return true; } }
    ] });
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
  window.GT_PLAYERS = { refresh: refresh, promptName: function () { promptName(true); }, openChat: openChat, closeChat: closeChat, _others: function () { return others; }, _lines: function () { return lines; } };
  GT.register({ id: 'players', init: init, onEntities: onEntities, onDraw: onDraw, onKey: onKey });
})();
