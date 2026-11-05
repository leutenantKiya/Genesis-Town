/*
 * presence.js - other players, chat bubbles and display names (server: server/src/presence.ts).
 *
 * - Position: every ~0.5 s (when it changed, or every 4 s) POST /api/pos {world, x, y, dir, scene}.
 * - Stream: GET /api/stream?world=<id> read with fetch (signed headers, like /api/state; EventSource cannot set headers).
 *   Events: `presence` {players:[{account,name,x,y,dir,scene}]} about twice a second, `chat` {account,name,text,t}.
 *   The stream is for ONE world. When the world changes (GT.worldId()), the stream is reopened and remote players are cleared.
 * - Remote players are NPCs: GT.addNpc('out', {remote:true, label:name, key:'peer:<account>'}); a chat line becomes
 *   their npc.bubble (GT.npcSay) and, for yourself, GT.playerSay. All text is shown with textContent, never innerHTML.
 * - Chat: key C (rebindable in settings.js) or Lainnya > Chat. Max 80 characters, one message per 2 s (server enforced).
 * - Names: after login, when /api/state says name is null, a prompt asks for one (3-16 characters, unique).
 * Uses window.GT_CHAIN (signed API helper) and window.GT only.
 */
(function () {
  'use strict';
  var LS_MUTE = 'gt.chat.muted';
  var CHAT_MAX = 80, LOG_MAX = 8, LOG_FADE_MS = 14000;
  var C = null;            // window.GT_CHAIN
  var remotes = new Map(); // account -> {npc, name}
  var gen = 0;             // bumped to cancel the running stream
  var ctl = null;          // AbortController of the running stream
  var streamWorld = null, streamAccount = null, retryAt = 0;
  var lastPosKey = '', lastPosAt = 0, tickAcc = 0, uiAcc = 0, posBusy = false;
  var seen = new Set(), muted = {}, promptedFor = null, nameModal = null;
  var box = null, logEl = null, form = null, input = null, chatOpen = false;
  var lines = [];          // {account, name, text, at}

  function $(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function worldNow() { return (GT.worldId && GT.worldId()) || 'public'; }
  function account() { return C && C.state && C.state.mode !== 'offline' ? C.state.account : null; }
  function myName() { var st = C && C.state && C.state.st; return st && st.name || null; }
  function hash(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
  try { muted = JSON.parse(lsGet(LS_MUTE) || '{}') || {}; } catch (e) { muted = {}; }

  /* ------------------------------------------------------------ position report */
  function myPos() {
    var sc = GT.scene, p = GT.player;
    if (sc && sc.kind !== 'out' && sc.house) return { x: sc.house.dx, y: sc.house.dy + 1, dir: p.dir, scene: 'in' };
    return { x: p.x, y: p.y, dir: p.dir, scene: sc && sc.kind !== 'out' ? 'in' : 'out' };
  }
  function reportPos(force) {
    if (!account() || posBusy) return;
    var p = myPos(), w = worldNow(), key = w + '|' + p.x + '|' + p.y + '|' + p.dir + '|' + p.scene, now = Date.now();
    if (!force && key === lastPosKey && now - lastPosAt < 4000) return;
    lastPosKey = key; lastPosAt = now; posBusy = true;
    C.api('/pos', { method: 'POST', body: { world: w, x: p.x, y: p.y, dir: p.dir, scene: p.scene } })
      .catch(function () { /* presence is cosmetic */ }).then(function () { posBusy = false; });
  }

  /* ------------------------------------------------------------ stream */
  function stopStream() {
    gen++;
    if (ctl) { try { ctl.abort(); } catch (e) { /* already closed */ } ctl = null; }
    streamWorld = null; streamAccount = null;
  }
  function clearRemotes() {
    remotes.forEach(function (r) { try { GT.removeNpc(r.npc); } catch (e) { /* gone with the old world */ } });
    remotes.clear();
  }
  function startStream() {
    var acct = account(), w = worldNow();
    stopStream();
    if (!acct || !C.signHeaders) return;
    streamWorld = w; streamAccount = acct;
    var my = ++gen, path = '/stream?world=' + encodeURIComponent(w);
    ctl = new AbortController();
    var signal = ctl.signal;
    C.signHeaders('GET', '/api' + path, '').then(function (h) {
      return fetch('/api' + path, { headers: h, signal: signal });
    }).then(function (r) {
      if (!r.ok || !r.body) throw new Error('stream ' + r.status);
      var reader = r.body.getReader(), dec = new TextDecoder(), buf = '';
      function pump() {
        return reader.read().then(function (res) {
          if (my !== gen) { try { reader.cancel(); } catch (e) { /* closed */ } return; }
          if (res.done) throw new Error('stream closed');
          buf += dec.decode(res.value, { stream: true });
          var i;
          while ((i = buf.indexOf('\n\n')) >= 0) { handleBlock(buf.slice(0, i)); buf = buf.slice(i + 2); }
          return pump();
        });
      }
      return pump();
    }).catch(function () {
      if (my !== gen) return;
      retryAt = Date.now() + 3000; streamWorld = null; // the ticker reconnects (fresh signature)
    });
  }
  function handleBlock(block) {
    var ev = 'message', data = '';
    block.split('\n').forEach(function (l) {
      if (l.indexOf('event: ') === 0) ev = l.slice(7);
      else if (l.indexOf('data: ') === 0) data += l.slice(6);
    });
    if (!data) return;
    var d; try { d = JSON.parse(data); } catch (e) { return; }
    if (ev === 'presence') syncPlayers(d && d.players || []);
    else if (ev === 'chat') onChat(d);
  }

  /* ------------------------------------------------------------ remote players */
  function syncPlayers(players) {
    players.forEach(function (p) {
      if (!p || typeof p.account !== 'string') return;
      var x = Math.round(Number(p.x)), y = Math.round(Number(p.y));
      if (!isFinite(x) || !isFinite(y)) return;
      var dir = ['up', 'down', 'left', 'right'].indexOf(p.dir) >= 0 ? p.dir : 'down';
      var name = String(p.name || '').slice(0, 16);
      var r = remotes.get(p.account);
      if (p.scene !== 'out') { if (r) GT.npcHide(r.npc, true); return; }
      if (!r) {
        var n = GT.addNpc('out', { x: x, y: y, name: name, pal: 6 + (hash(p.account) % 2), wander: false, key: 'peer:' + p.account, label: name, noAffinity: true, remote: true, dir: dir, lines: [['...']] });
        if (n) remotes.set(p.account, { npc: n, name: name });
        return;
      }
      var npc = r.npc;
      if (r.name !== name) { npc.label = name; npc.name = name; r.name = name; }
      if (npc.hidden) { GT.npcHide(npc, false); GT.npcTeleport(npc, x, y, dir); return; }
      if (npc.x === x && npc.y === y) { npc.dir = dir; return; }
      r.target = { x: x, y: y, dir: dir };
      var path = GT.findPath('out', { x: npc.x, y: npc.y }, { x: x, y: y });
      if (path && path.length && path.length <= 8) {
        GT.npcGo(npc, path, function (done) {
          if (!r.target) return;
          if (!done) GT.npcTeleport(npc, r.target.x, r.target.y, r.target.dir); else if (npc.x === r.target.x && npc.y === r.target.y) npc.dir = r.target.dir;
        });
      } else GT.npcTeleport(npc, x, y, dir);
    });
    remotes.forEach(function (r, acct) {
      if (!players.some(function (p) { return p && p.account === acct; })) { try { GT.removeNpc(r.npc); } catch (e) { /* ignore */ } remotes.delete(acct); }
    });
  }

  /* ------------------------------------------------------------ chat */
  function onChat(m) {
    if (!m || typeof m.account !== 'string' || typeof m.text !== 'string') return;
    var key = m.account + '|' + m.t;
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 300) seen.delete(seen.values().next().value);
    if (muted[m.account]) return;
    var text = m.text.slice(0, CHAT_MAX), name = String(m.name || '').slice(0, 16);
    lines.push({ account: m.account, name: name, text: text, at: m.backlog ? 0 : Date.now() });
    if (lines.length > LOG_MAX) lines.shift();
    renderLog();
    if (m.backlog) return;
    if (m.account === account()) GT.playerSay(text, 5);
    else { var r = remotes.get(m.account); if (r) GT.npcSay(r.npc, text); }
  }
  function renderLog() {
    if (!logEl) return;
    var now = Date.now();
    while (logEl.firstChild) logEl.removeChild(logEl.firstChild);
    lines.forEach(function (l) {
      if (!chatOpen && (!l.at || now - l.at > LOG_FADE_MS)) return;
      var row = $('div', 'gt-chatline');
      var who = $('button', 'gt-chatwho', l.name + ':'); who.type = 'button';
      who.addEventListener('click', function () { if (l.account !== account()) askMute(l); });
      row.appendChild(who);
      row.appendChild($('span', null, ' ' + l.text));
      logEl.appendChild(row);
    });
    logEl.parentNode.classList.toggle('empty', !logEl.firstChild && !chatOpen);
  }
  function askMute(l) {
    var isMuted = !!muted[l.account];
    GT.menu(l.name, [{ label: isMuted ? 'Bunyikan lagi' : 'Bisukan pemain ini (hanya di layarmu)', onPick: function () {
      if (isMuted) delete muted[l.account]; else muted[l.account] = 1;
      lsSet(LS_MUTE, JSON.stringify(muted));
      GT.toast(isMuted ? l.name + ' dibunyikan lagi.' : l.name + ' dibisukan.');
    } }]);
  }
  function buildBox() {
    var shell = document.querySelector('.shell');
    if (!shell || box) return;
    box = $('div', 'gt-chat empty'); box.setAttribute('aria-live', 'polite');
    logEl = $('div', 'gt-chatlog');
    form = $('form', 'gt-chatform'); form.style.display = 'none';
    input = $('input'); input.type = 'text'; input.maxLength = CHAT_MAX; input.autocomplete = 'off'; input.placeholder = 'Ketik pesan, Enter kirim, Esc batal';
    input.setAttribute('aria-label', 'Pesan chat');
    var send = $('button', 'mbtn', 'Kirim'); send.type = 'submit';
    form.appendChild(input); form.appendChild(send);
    box.appendChild(logEl); box.appendChild(form); shell.appendChild(box);
    // typing must not move the character or trigger game keys
    input.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); closeChat(); } });
    input.addEventListener('keyup', function (e) { e.stopPropagation(); });
    form.addEventListener('submit', function (e) { e.preventDefault(); submit(); });
  }
  function openChat() {
    if (!account()) { GT.toast('Masuk dulu untuk ngobrol.'); return; }
    if (!myName()) { promptName(true); return; }
    buildBox();
    if (!box) return;
    chatOpen = true; form.style.display = 'flex'; renderLog();
    setTimeout(function () { input.focus(); }, 0);
  }
  function closeChat() {
    chatOpen = false; if (form) form.style.display = 'none';
    if (input) { input.value = ''; input.blur(); }
    renderLog();
  }
  function submit() {
    var text = String(input.value || '').trim();
    if (!text) { closeChat(); return; }
    if (Array.from(text).length > CHAT_MAX) { GT.toast('Maksimal ' + CHAT_MAX + ' karakter.'); return; }
    input.disabled = true;
    C.api('/chat', { method: 'POST', body: { world: worldNow(), text: text } }).then(function (r) {
      if (r && r.message) onChat(r.message);
      closeChat();
    }, function (e) { GT.toast(e && e.message || 'Pesan gagal dikirim.'); }).then(function () { input.disabled = false; if (chatOpen) input.focus(); });
  }

  /* ------------------------------------------------------------ display name */
  function promptName(force) {
    var acct = account();
    if (!acct || nameModal || (!force && promptedFor === acct)) return;
    promptedFor = acct;
    var body = $('div');
    body.appendChild($('p', null, 'Pilih nama yang dilihat pemain lain di atas karaktermu. 3-16 karakter: huruf, angka, spasi, _ atau -. Nama tidak boleh sama dengan pemain lain.'));
    var inp = $('input'); inp.type = 'text'; inp.maxLength = 16; inp.autocomplete = 'off'; inp.placeholder = 'Namamu'; inp.setAttribute('data-autofocus', '');
    body.appendChild(inp);
    var h = GT.modal({ title: 'Pilih nama', body: body, actions: [
      { label: 'Nanti saja' },
      { label: 'Simpan', primary: true, onClick: function (mh) {
        var v = String(inp.value || '').trim();
        if (!/^[A-Za-z0-9 _-]{3,16}$/.test(v)) { GT.toast('Nama harus 3-16 karakter: huruf, angka, spasi, _ atau -.'); return false; }
        C.api('/name', { method: 'POST', body: { name: v } }).then(function (r) {
          if (C.state.st) C.state.st.name = r.name;
          GT.setPlayerName(r.name);
          GT.toast('Halo, ' + r.name + '!');
          mh.close('ok');
        }, function (e) { GT.toast(e && e.message || 'Nama gagal disimpan.'); });
        return false;
      } }
    ], onClose: function () { nameModal = null; } });
    nameModal = h;
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); var p = h.el && h.el.querySelector('.primary'); if (p) p.click(); } });
  }

  /* ------------------------------------------------------------ main loop */
  function onFrame(dt) {
    tickAcc += dt; uiAcc += dt;
    if (tickAcc >= 0.5) { tickAcc = 0; reportPos(false); }
    if (uiAcc < 1) return;
    uiAcc = 0;
    var acct = account(), w = worldNow();
    if (!acct) { if (streamAccount) { stopStream(); clearRemotes(); lines = []; renderLog(); } promptedFor = null; return; }
    if (streamAccount && (streamAccount !== acct || streamWorld !== w)) { stopStream(); clearRemotes(); }
    if (!streamAccount && Date.now() >= retryAt) startStream();
    var nm = myName();
    if (nm) GT.setPlayerName(nm);
    else if (C.state.st && !GT.isUiOpen()) promptName(false);
    if (lines.length) renderLog();
  }
  function onWorld() { remotes.clear(); if (streamAccount) { streamWorld = null; stopStream(); } } // npcs vanish with the old scenes

  function init() {
    C = window.GT_CHAIN || null;
    GT.hotkey('C', openChat);
    window.GT_PRESENCE = { openChat: openChat, promptName: function () { promptName(true); }, refresh: function () { stopStream(); clearRemotes(); retryAt = 0; reportPos(true); } };
  }
  GT.register({ id: 'presence', init: init, onFrame: onFrame, onWorld: onWorld });
})();
