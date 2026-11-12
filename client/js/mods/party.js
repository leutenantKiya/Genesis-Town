/*
 * party.js - parties (client of server/src/game/party.ts): up to 4 players who play together.
 *  - Press G for the Party panel: members, invite by name#tag, leave, and (leader) remove.
 *  - "Ajak party" on another player's card; "/party nama#tag" in chat (handled by players.js through GT_PARTY.invite).
 *  - Mates show as green tags, minimap dots (onMinimap) and edge arrows (players.js); /p text is the party chat (server social.ts).
 *  - An incoming invite pops up once with Terima / Tolak / Nanti.
 * The party state rides on the presence poll (GT_PLAYERS.onPresence), so there is no extra polling.
 */
(function () {
  'use strict';
  var GT = window.GT, C = null;
  var view = { party: null, invites: [] };
  var shown = {};   // invites already popped up: from|expires_at
  var panel = null, invitePop = null, dirty = false;

  function $(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function S() { return C && C.state; }
  function signedIn() { var s = S(); return !!(s && s.account && s.mode !== 'offline' && s.mode !== 'loading'); }
  function me() { var s = S(); return s && s.account; }
  function fail(e) { GT.toast((e && e.message) || $t('Gagal.')); }
  function post(path, body) { return C.api(path, { method: 'POST', body: body || {} }); }

  function set(v) {
    if (!v) return;
    var nv = { party: v.party || null, invites: v.invites || [] };
    var changed = JSON.stringify(nv) !== JSON.stringify(view);
    view = nv;
    if (panel && panel.isOpen() && changed) renderPanel();
    watchLeader();
    maybePopInvite();
  }
  function isLeader() { return !!(view.party && view.party.leader === me()); }
  function isMate(account) { return !!(view.party && view.party.members.some(function (m) { return m.account === account; })); }
  function full() { var s = S(), max = s && s.cfg && s.cfg.econ && s.cfg.econ.party && s.cfg.econ.party.max; return !!(view.party && max && view.party.members.length >= max); }

  // where a mate is: "Desa", a Homeland (mine, an invited one, or just "Homeland"), or offline
  function placeOf(m) {
    if (!m.online || !m.world) return $t('offline');
    if (m.world === 'public') return $t('Desa');
    var H = window.GT_HOME && GT_HOME.state && GT_HOME.state();
    if (H && H.world === m.world) return $t('Homelandmu');
    var v = H && (H.invited || []).filter(function (i) { return i.world === m.world; })[0];
    return v && v.owner_name ? $t('Homeland {0}', [v.owner_name]) : $t('Homeland');
  }
  // can I travel to this world? the village, my Homeland, or one I may visit (invited or a mate's)
  function canGo(world) {
    if (!world) return false;
    if (world === 'public') return true;
    var H = window.GT_HOME && GT_HOME.state && GT_HOME.state();
    return !!(H && (H.world === world || (H.invited || []).some(function (i) { return i.world === world; })));
  }
  var following = false;
  // "Ikut": walk to the portal of the world I am in, then cross to the mate's world. The server checks access as for any travel.
  function follow(world) {
    if (following || !window.GT_HOME || !canGo(world) || GT.worldId() === world) return;
    if (GT.isUiOpen()) return;
    var p = GT.world && GT.world.portal, pl = GT.player;
    if (!p || !pl) { GT.toast($t('Tidak ada jalan ke portal.')); return; }
    var cross = function () { GT_HOME.travel(world); };
    if (Math.abs(pl.x - p.x) + Math.abs(pl.y - p.y) <= 2) { cross(); return; }
    if (!(window.GT_MOUSE && GT_MOUSE.goNear(p, cross))) { GT.toast($t('Tidak ada jalan ke portal.')); return; }
    GT.toast($t('Berjalan ke portal…'));
  }
  // the leader changed world between two polls: offer to follow
  var leaderWorld = null;
  function watchLeader() {
    var p = view.party;
    if (!p) { leaderWorld = null; return; }
    var l = p.members.filter(function (m) { return m.leader; })[0];
    if (!l || l.account === me() || !l.online || !l.world) return;
    var was = leaderWorld; leaderWorld = l.world;
    if (was && was !== l.world && l.world !== GT.worldId() && canGo(l.world) && !GT.isUiOpen()) {
      var w = l.world;
      GT.menu($t('Ketua pindah ke {0}. Ikut?', [placeOf(l)]), [{ label: $t('Ikut'), onPick: function () { follow(w); } }, { label: $t('Nanti'), onPick: function () {} }]);
    }
  }
  // green dots on the map sheet (M) for mates in my world: the server sends x, y only for them
  function onMinimap(g, C) {
    if (!view.party) return;
    g.fillStyle = '#000';
    view.party.members.forEach(function (m) { if (m.x != null && m.account !== me()) g.fillRect(Math.round(m.x * C) - 1, Math.round(m.y * C) - 1, 4, 4); });
    g.fillStyle = '#4fd36b';
    view.party.members.forEach(function (m) { if (m.x != null && m.account !== me()) g.fillRect(Math.round(m.x * C), Math.round(m.y * C), 2, 2); });
  }

  /* ---------------------------------------------------------------- actions */
  function invite(to) {
    if (!signedIn()) { GT.toast($t('Masuk dulu.')); return Promise.resolve(); }
    to = String(to || '').trim();
    if (!to) { GT.toast($t('Tulis nama#tag pemain yang mau diajak.')); return Promise.resolve(); }
    return post('/party/invite', { to: to }).then(function (r) { set(r); GT.toast($t('Ajakan party terkirim ke {0}.', [to])); }, fail);
  }
  function answer(path, body, toast) { return post(path, body).then(function (r) { set(r); if (toast) GT.toast(toast); }, fail); }

  /* ---------------------------------------------------------------- panel (G) */
  function renderPanel() {
    // never rebuild the form while the player is typing in it (the presence poll calls this)
    var ae = document.activeElement;
    if (panel && panel.el && ae && ae.tagName === 'INPUT' && panel.el.contains(ae)) { dirty = true; return; }
    dirty = false;
    var body = $('div'), p = view.party;
    if (!p) {
      body.appendChild($('p', 'chain-dim', $t('Kamu belum punya party. Ajak pemain lain lewat nama#tag atau lewat kartu namanya (klik pemainnya).')));
    } else {
      var list = $('div', 'tr-lines');
      p.members.forEach(function (m) {
        var row = $('div', 'tr-lot'), tx = $('div', 'tr-lot-t');
        tx.appendChild($('div', 'tr-lot-n gt-data', m.name + '#' + m.tag + (m.leader ? ' · ' + $t('Ketua') : '') + (m.account === me() ? ' · ' + $t('kamu') : '')));
        tx.appendChild($('div', 'chain-dim', m.account === me() ? placeOf({ online: true, world: (GT.worldId && GT.worldId()) || 'public' }) : placeOf(m)));
        row.appendChild(tx);
        if (m.account !== me() && m.online && m.world && m.world !== ((GT.worldId && GT.worldId()) || 'public') && canGo(m.world)) {
          var jn = $('button', 'mbtn primary', $t('Ikut')); jn.type = 'button';
          jn.addEventListener('click', function () { if (panel && panel.isOpen()) panel.close(); follow(m.world); });
          row.appendChild(jn);
        }
        if (m.account !== me() && m.online && m.world && m.world === ((GT.worldId && GT.worldId()) || 'public') && window.GT_TRADE) {
          var tb = $('button', 'mbtn', $t('Dagang')); tb.type = 'button';
          tb.addEventListener('click', function () { if (panel && panel.isOpen()) panel.close(); GT_TRADE.start(m.account); });
          row.appendChild(tb);
        }
        if (isLeader() && m.account !== me()) {
          var kick = $('button', 'mbtn', $t('Keluarkan')); kick.type = 'button';
          kick.addEventListener('click', function () { answer('/party/kick', { account: m.account }, $t('{0} dikeluarkan dari party.', [m.name])); });
          row.appendChild(kick);
        }
        list.appendChild(row);
      });
      body.appendChild(list);
    }
    if (!p || (isLeader() && !full())) {
      var form = $('form', 'tr-form'), f = $('label', 'tr-f'), inp = $('input', 'tr-num');
      f.appendChild($('span', null, $t('Ajak (nama#tag)')));
      inp.type = 'text'; inp.maxLength = 40; inp.autocomplete = 'off'; inp.spellcheck = false; inp.placeholder = 'nama#12345';
      inp.addEventListener('keydown', function (e) { e.stopPropagation(); });
      inp.addEventListener('keyup', function (e) { e.stopPropagation(); });
      f.appendChild(inp);
      var go = $('button', 'mbtn primary', $t('Ajak')); go.type = 'submit';
      form.appendChild(f); form.appendChild(go);
      form.addEventListener('submit', function (e) { e.preventDefault(); invite(inp.value).then(function () { inp.value = ''; }); });
      body.appendChild(form);
    } else if (p && !isLeader()) body.appendChild($('p', 'chain-dim', $t('Hanya ketua yang bisa mengajak dan mengeluarkan anggota.')));
    if (view.invites.length) {
      var ic = $('div', 'tr-cell'), ih = $('div', 'tr-cell-h');
      ih.appendChild($('span', 'tr-cell-t', $t('Ajakan masuk'))); ic.appendChild(ih);
      view.invites.forEach(function (i) {
        var row = $('div', 'tr-lot'); row.appendChild($('div', 'tr-lot-n gt-data', i.name + '#' + i.tag));
        var ok = $('button', 'mbtn primary', $t('Terima')); ok.type = 'button';
        ok.addEventListener('click', function () { answer('/party/accept', { from: i.from }, $t('Kamu masuk party.')); });
        var no = $('button', 'mbtn', $t('Tolak')); no.type = 'button';
        no.addEventListener('click', function () { answer('/party/decline', { from: i.from }); });
        row.appendChild(ok); row.appendChild(no); ic.appendChild(row);
      });
      body.appendChild(ic);
    }
    var actions = [];
    if (p) actions.push({ label: $t('Keluar dari party'), onClick: function () { answer('/party/leave', {}, $t('Kamu keluar dari party.')); } });
    actions.push({ label: $t('Tutup'), close: true });
    panel.setBody(body); panel.setActions(actions);
  }
  function openPanel() {
    if (!signedIn()) { GT.toast($t('Masuk dulu.')); return; }
    if (panel && panel.isOpen()) return;
    if (GT.isUiOpen()) return;
    panel = GT.modal({ title: $t('Party'), body: $('div'), actions: [] });
    panel.el.addEventListener('focusout', function () { setTimeout(function () { if (dirty && panel && panel.isOpen()) renderPanel(); }, 0); });
    renderPanel();
    C.api('/party').then(set, function () {});
  }

  /* ---------------------------------------------------------------- incoming invite */
  function maybePopInvite() {
    if (!signedIn() || (invitePop && invitePop.isOpen()) || GT.isUiOpen()) return;
    var i = view.invites.filter(function (x) { return !shown[x.from + '|' + x.expires_at]; })[0];
    if (!i) return;
    shown[i.from + '|' + i.expires_at] = 1;
    invitePop = GT.modal({
      title: $t('Ajakan party'), body: $t('{0}#{1} mengajakmu ke party', [i.name, i.tag]), actions: [
        { label: $t('Terima'), primary: true, onClick: function (h) { answer('/party/accept', { from: i.from }, $t('Kamu masuk party.')); h.close('ok'); } },
        { label: $t('Tolak'), onClick: function (h) { answer('/party/decline', { from: i.from }); h.close('no'); } },
        { label: $t('Nanti'), close: true }
      ]
    });
  }

  function onKey(e) {
    if (e.type !== 'keydown' || e.repeat || GT.isUiOpen()) return false;
    if (document.documentElement.classList.contains('gt-fishing') || document.documentElement.classList.contains('gt-fighting')) return false;
    if (e.code === 'KeyG') { openPanel(); return true; }
    return false;
  }

  function init() {
    C = window.GT_CHAIN || null;
    if (window.GT_PLAYERS) {
      if (GT_PLAYERS.onPresence) GT_PLAYERS.onPresence(function (r) { if (r && r.party) set(r.party); });
      if (GT_PLAYERS.addCardAction) GT_PLAYERS.addCardAction(function (o) {
        if (!signedIn() || o.npc || !o.tag || o.account === me() || isMate(o.account)) return null;
        if (view.party && (!isLeader() || full())) return null;
        return { label: $t('Ajak party'), onClick: function (h) { h.close('ok'); invite(o.nick + '#' + o.tag); return true; } };
      });
    }
    window.GT_PARTY = { invite: invite, open: openPanel, view: function () { return view; }, isMate: isMate };
  }
  GT.register({ id: 'party', init: init, onKey: onKey, onMinimap: onMinimap });
})();
