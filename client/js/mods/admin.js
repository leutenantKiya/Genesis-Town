/*
 * admin.js - the Admin panel (server: /api/admin/*, accounts listed in ADMIN_ACCOUNTS). Only shown in "Lainnya" when
 * /api/state says admin: true. Guests online (nick, address, since) with Kick and Ban IP; banned addresses with Unban.
 * The server checks the account on every call, so this panel is only a convenience.
 */
(function () {
  'use strict';
  var GT = window.GT, C = null;
  var panel = null, guests = [], bans = [], frozen = [], status = null, timer = 0;

  function $(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function st() { return C && C.state && C.state.st; }
  function isAdmin() { var s = st(); return !!(s && s.admin); }
  function fail(e) { GT.toast((e && e.message) || $t('Gagal.')); }
  function post(path, body) { return C.api(path, { method: 'POST', body: body || {} }); }
  function ago(ms) { var s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 90 ? s + 's' : Math.round(s / 60) + 'm'; }

  function row(text, sub, buttons) {
    var r = $('div', 'tr-lot'), tx = $('div', 'tr-lot-t');
    tx.appendChild($('div', 'tr-lot-n gt-data', text)); if (sub) tx.appendChild($('div', 'chain-dim', sub));
    r.appendChild(tx);
    buttons.forEach(function (b) { var x = $('button', 'mbtn', b.label); x.type = 'button'; x.addEventListener('click', b.fn); r.appendChild(x); });
    return r;
  }
  function render() {
    if (!panel || !panel.isOpen()) return;
    var body = $('div');
    body.appendChild($('div', 'chain-dim', $t('Guest online: {0}', [guests.length])));
    if (!guests.length) body.appendChild($('div', 'chain-dim', $t('Tidak ada guest.')));
    guests.forEach(function (g) {
      body.appendChild(row(g.nick + ' · ' + g.ip, $t('masuk {0} lalu', [ago(g.since)]), [
        { label: $t('Kick'), fn: function () { post('/admin/kick', { guest: g.guest }).then(function (r) { guests = r.guests || []; GT.toast($t('Guest dikeluarkan.')); render(); }, fail); } },
        { label: $t('Ban IP'), fn: function () { post('/admin/ban', { ip: g.ip }).then(function (r) { bans = r.bans || []; guests = r.guests || []; GT.toast($t('IP diblokir.')); render(); }, fail); } }
      ]));
    });
    body.appendChild($('div', 'chain-dim', $t('IP yang diblokir: {0}', [bans.length])));
    bans.forEach(function (b) {
      body.appendChild(row(b.ip, b.note || '', [
        { label: $t('Buka blokir'), fn: function () { post('/admin/unban', { ip: b.ip }).then(function (r) { bans = r.bans || []; render(); }, fail); } }
      ]));
    });
    body.appendChild($('div', 'chain-dim', $t('Akun beku: {0}', [frozen.length])));
    frozen.forEach(function (f) {
      var what = f.items.map(function (i) { return i.token + ' ' + i.applied + '/' + i.wanted + ' (d' + i.day + ')'; }).join(', ');
      body.appendChild(row(f.account, what, [
        { label: $t('Lepas beku'), fn: function () { post('/admin/unfreeze', { account: f.account }).then(function () { GT.toast($t('Akun dilepas dari beku.')); load(); }, fail); } }
      ]));
    });
    if (status) {
      body.appendChild($('div', 'chain-dim', $t('Settlement: hari {0} jam {1}, selesai sampai hari {2}', [status.day, status.hour, status.settledThrough])));
      status.retry.forEach(function (r) { body.appendChild($('div', 'chain-dim', $t('Hari {0} gagal, coba lagi {1}s lagi', [r.day, r.inSeconds]))); });
      status.settlements.forEach(function (s) { body.appendChild($('div', 'chain-dim', 'd' + s.day + '/' + s.chunk + ' ' + s.status + (s.tx_hash ? ' ' + String(s.tx_hash).slice(0, 8) : ''))); });
    }
    body.appendChild($('div', 'chain-dim', $t('Jadi admin: isi ADMIN_ACCOUNTS=akun1,akun2 (id akun NEAR kamu) di .env dan di Railway Variables, lalu restart server.')));
    panel.setBody(body);
  }
  function load() {
    C.api('/admin/guests').then(function (r) { guests = r.guests || []; render(); }, fail);
    C.api('/admin/frozen').then(function (r) { frozen = r.frozen || []; render(); }, function () {});
    C.api('/admin/status').then(function (r) { status = r; render(); }, function () {});
    C.api('/admin/bans').then(function (r) { bans = r.bans || []; render(); }, function () {});
  }
  function open() {
    if (!isAdmin()) return;
    if (panel && panel.isOpen()) return;
    if (GT.isUiOpen()) return;
    panel = GT.modal({ title: $t('Admin'), body: $('div'), actions: [{ label: $t('Muat ulang'), onClick: function () { load(); return false; } }, { label: $t('Tutup'), close: true }] });
    render(); load();
    clearInterval(timer);
    timer = setInterval(function () { if (panel && panel.isOpen()) load(); else clearInterval(timer); }, 5000);
  }

  function init() { C = window.GT_CHAIN || null; window.GT_ADMIN = { open: open, isAdmin: isAdmin }; }
  GT.register({ id: 'admin', init: init });
})();
