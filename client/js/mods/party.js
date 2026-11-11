/*
 * party.js - parties (client of server/src/game/party.ts): up to 4 players who play together.
 *  - Press G for the Party panel: members, invite by name#tag, leave, and (leader) remove.
 *  - "Ajak party" on another player's card; "/party nama#tag" in chat (handled by players.js through GT_PARTY.invite).
 *  - An incoming invite pops up once with Terima / Tolak / Nanti.
 * The party state rides on the presence poll (GT_PLAYERS.onPresence), so there is no extra polling.
 */
(function () {
  'use strict';
  var GT = window.GT, C = null;
  var view = { party: null, invites: [] };
  var shown = {};   // invites already popped up: from|expires_at
  var panel = null, invitePop = null;

  function $(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function S() { return C && C.state; }
  function signedIn() { var s = S(); return !!(s && s.account && s.mode !== 'offline' && s.mode !== 'loading'); }
  function me() { var s = S(); return s && s.account; }
  function fail(e) { GT.toast((e && e.message) || $t('Gagal.')); }
  function post(path, body) { return C.api(path, { method: 'POST', body: body || {} }); }

  function set(v) {
    if (!v) return;
    view = { party: v.party || null, invites: v.invites || [] };
    if (panel && panel.isOpen()) renderPanel();
    maybePopInvite();
  }
  function isLeader() { return !!(view.party && view.party.leader === me()); }
  function isMate(account) { return !!(view.party && view.party.members.some(function (m) { return m.account === account; })); }
  function full() { var s = S(), max = s && s.cfg && s.cfg.econ && s.cfg.econ.party && s.cfg.econ.party.max; return !!(view.party && max && view.party.members.length >= max); }

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
    var body = $('div'), p = view.party;
    if (!p) {
      body.appendChild($('p', 'chain-dim', $t('Kamu belum punya party. Ajak pemain lain lewat nama#tag atau lewat kartu namanya (klik pemainnya).')));
    } else {
      var list = $('div', 'tr-lines');
      p.members.forEach(function (m) {
        var row = $('div', 'tr-lot'), tx = $('div', 'tr-lot-t');
        tx.appendChild($('div', 'tr-lot-n', m.name + '#' + m.tag + (m.leader ? ' · ' + $t('Ketua') : '') + (m.account === me() ? ' · ' + $t('kamu') : '')));
        row.appendChild(tx);
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
        var row = $('div', 'tr-lot'); row.appendChild($('div', 'tr-lot-n', i.name + '#' + i.tag));
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
  GT.register({ id: 'party', init: init, onKey: onKey });
})();
