/* chain.js - NEAR layer for Genesis Town (M1). Talks to the engine only through window.GT.
 *
 * Modes (shown in a banner so nobody mistakes a mock for the chain):
 *   testnet - server at /api with a real NEAR testnet contract. Sign in with NEAR Auth (one Auth0 popup), then every
 *             player action is signed in the browser with a session key and relayed gas-free (NEP-366).
 *   mock    - same server, but its chain is in memory (CHAIN_MODE=mock). Labelled "mock" everywhere.
 *   offline - no server (?mode=offline, file://, or /api unreachable). Balances live in this browser only.
 *
 * Player actions in M1: gather (A facing water/rock/tree -> Ikan/Bijih/Kayu), send an item to another player,
 * Riwayat (history) with testnet explorer links. Keys: session private key in localStorage (M4 moves it to a
 * non-extractable WebCrypto key). The account's full-access key is the player's NEAR Auth key; we never see it.
 */
(function () {
  'use strict';
  var LS_ACC = 'gt.chain.account', LS_KEY = 'gt.chain.sessionKey', LS_OFF = 'gt.chain.offline';
  var ITEM = { fish: 'Ikan', ore: 'Bijih', wood: 'Kayu', wheat: 'Gandum' };
  var TILE_ITEM = { water: 'fish', rock: 'ore', tree: 'wood' };
  var GATHER_MS = 900;
  var S = { mode: 'loading', cfg: null, account: null, balances: {}, history: [], busy: false, poll: 0, modal: null };

  function $(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function itemName(t) { return ITEM[t] || t; }

  /* ------------------------------------------------------------ server API */
  function api(path, opts) {
    opts = opts || {};
    var headers = { 'content-type': 'application/json' };
    if (S.account) headers['x-account-id'] = S.account;
    return fetch('/api' + path, { method: opts.method || 'GET', headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) { var e = new Error(j.error || ('HTTP ' + r.status)); e.status = r.status; throw e; }
          return j;
        });
      });
  }

  /* ------------------------------------------------------------ offline mock (browser only) */
  var OFF = {
    load: function () { try { return JSON.parse(lsGet(LS_OFF) || 'null') || { bal: {}, hist: [], n: 0 }; } catch (e) { return { bal: {}, hist: [], n: 0 }; } },
    save: function (d) { lsSet(LS_OFF, JSON.stringify(d)); },
    gather: function (t) {
      var d = OFF.load(); d.bal[t] = (d.bal[t] || 0) + 1;
      d.hist.unshift({ id: ++d.n, kind: 'gather', summary: '+1 ' + itemName(t), status: 'mock', tx_hash: null, created_at: Date.now() });
      d.hist = d.hist.slice(0, 50); OFF.save(d); return d;
    },
    send: function (t, to, n) {
      var d = OFF.load();
      if ((d.bal[t] || 0) < n) throw new Error('Barang tidak cukup');
      d.bal[t] -= n;
      d.hist.unshift({ id: ++d.n, kind: 'send_item', summary: 'Kirim ' + n + ' ' + t + ' ke ' + to, status: 'mock', tx_hash: null, created_at: Date.now() });
      OFF.save(d); return d;
    }
  };

  /* ------------------------------------------------------------ banner + HUD */
  var banner = null, accBtn = null;
  function renderBanner() {
    if (!banner) {
      banner = $('div', 'chain-banner');
      banner.setAttribute('role', 'status');
      var shell = document.querySelector('.shell');
      if (shell) shell.insertBefore(banner, shell.firstChild);
    }
    var txt, cls = 'chain-banner ';
    if (S.mode === 'offline') { txt = 'OFFLINE DEMO · tidak ada transaksi on-chain'; cls += 'off'; }
    else if (S.mode === 'mock') { txt = 'SERVER MOCK CHAIN · transaksi tiruan, bukan testnet'; cls += 'mock'; }
    else if (S.mode === 'testnet') { txt = 'NEAR testnet' + (S.account ? ' · ' + S.account : ' · belum masuk'); cls += 'net'; }
    else { txt = 'Menghubungkan…'; cls += 'mock'; }
    banner.className = cls; banner.textContent = txt;
    if (accBtn) accBtn.textContent = S.account || S.mode === 'offline' ? 'Tas NEAR' : 'Masuk';
  }

  /* ------------------------------------------------------------ session key + login */
  function sessionKey() {
    var L = window.NearLib, s = lsGet(LS_KEY);
    if (s) { try { return L.KeyPair.fromString(s); } catch (e) { /* regenerate */ } }
    var kp = L.KeyPair.fromRandom('ed25519');
    lsSet(LS_KEY, kp.toString());
    return kp;
  }

  function finishLogin(idToken) {
    var kp = sessionKey();
    GT.toast('Membuat akunmu di NEAR testnet…');
    return api('/auth/register', { method: 'POST', body: { idToken: idToken, sessionPublicKey: kp.getPublicKey().toString() } })
      .then(function (r) {
        S.account = r.accountId; lsSet(LS_ACC, r.accountId); renderBanner();
        GT.toast(r.created ? 'Akun dibuat: ' + r.accountId : 'Selamat datang kembali!');
        return refresh();
      });
  }

  function login() {
    if (S.busy) return;
    if (S.cfg && S.cfg.devLogin) return devLogin();
    if (!window.NearLib) { GT.toast('Pustaka NEAR belum dimuat (jalankan build klien).'); return; }
    S.busy = true;
    var L = window.NearLib;
    var provider = new L.JavascriptProvider({ network: 'testnet', clientId: S.cfg.fastAuth.clientId });
    provider.login()
      .then(function () { return provider.client.getIdTokenClaims(); }) // the provider's Auth0 client (auth0-spa-js)
      .then(function (claims) {
        if (!claims || !claims.__raw) throw new Error('Login tidak memberi token');
        return finishLogin(claims.__raw);
      })
      .catch(function (e) { GT.toast('Gagal masuk: ' + (e && e.message || e)); })
      .then(function () { S.busy = false; });
  }

  function devLogin() {
    var input = $('input'); input.type = 'text'; input.maxLength = 32; input.placeholder = 'nama (huruf kecil)';
    var body = $('div');
    body.appendChild($('p', null, 'Server ini memakai rantai tiruan (mock) dengan login pengembang. Ketik nama pemain:'));
    body.appendChild(input);
    GT.modal({
      title: 'Masuk (dev, mock)', body: body,
      actions: [{ label: 'Masuk', primary: true, onClick: function (h) {
        var v = String(input.value || '').trim().toLowerCase();
        if (!/^[a-z0-9_-]{1,32}$/.test(v)) { GT.toast('Nama: huruf kecil, angka, - atau _'); return false; }
        h.close('ok');
        S.busy = true;
        finishLogin('dev:' + v).catch(function (e) { GT.toast('Gagal masuk: ' + e.message); }).then(function () { S.busy = false; });
        return true;
      } }]
    });
    setTimeout(function () { input.focus(); }, 50);
  }

  /* ------------------------------------------------------------ state refresh */
  function refresh() {
    if (S.mode === 'offline') {
      var d = OFF.load(); S.balances = d.bal; S.history = d.hist; redraw(); return Promise.resolve();
    }
    if (!S.account) return Promise.resolve();
    return Promise.all([api('/balances'), api('/history')]).then(function (r) {
      S.balances = r[0].balances || {}; S.history = r[1].history || []; redraw();
    }).catch(function (e) {
      if (e.status === 401) { S.account = null; lsSet(LS_ACC, null); renderBanner(); }
    });
  }
  function hasPending() { return S.history.some(function (h) { return h.status === 'pending'; }); }
  function schedulePoll() {
    clearTimeout(S.poll);
    S.poll = setTimeout(function () { (hasPending() || S.modal ? refresh() : Promise.resolve()).then(schedulePoll); }, 4000);
  }

  /* ------------------------------------------------------------ gather */
  function gather(token) {
    if (S.busy) return true;
    if (S.mode !== 'offline' && !S.account) { GT.toast('Masuk dulu (tombol Masuk) untuk mengumpulkan.'); return true; }
    S.busy = true;
    GT.toast('Mengumpulkan ' + itemName(token) + '…');
    setTimeout(function () {
      var p = S.mode === 'offline' ? Promise.resolve(OFF.gather(token)) : api('/gather', { method: 'POST', body: { item: token } });
      p.then(function () {
        GT.toast('+1 ' + itemName(token) + (S.mode === 'offline' ? '' : ' (menunggu on-chain)'));
        return refresh();
      }).catch(function (e) { GT.toast(e.message); }).then(function () { S.busy = false; });
    }, GATHER_MS);
    return true;
  }

  /* ------------------------------------------------------------ send item (signed delegate -> relayer) */
  function b64(bytes) { var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }

  function signedSend(token, receiver, amount) {
    var L = window.NearLib, kp = sessionKey();
    var ready;
    if (S.mode === 'mock') ready = Promise.resolve({ nonce: BigInt(Date.now()), height: 0n });
    else {
      var prov = new L.JsonRpcProvider({ url: S.cfg.rpcUrl });
      ready = Promise.all([
        prov.viewAccessKey({ accountId: S.account, publicKey: kp.getPublicKey() }),
        prov.viewBlock({ finality: 'final' })
      ]).then(function (r) { return { nonce: BigInt(r[0].nonce) + 1n, height: BigInt(r[1].header.height) }; });
    }
    return ready.then(function (x) {
      var da = L.buildDelegateAction({
        senderId: S.account, receiverId: S.cfg.gameContractId,
        actions: [L.actions.functionCall('send_item', { receiver_id: receiver, token_id: token, amount: String(amount) }, L.teraToGas('30'), 0n)],
        nonce: x.nonce, maxBlockHeight: x.height + 100n, publicKey: kp.getPublicKey()
      });
      return crypto.subtle.digest('SHA-256', L.encodeDelegateAction(da)).then(function (h) {
        var sig = kp.sign(new Uint8Array(h));
        var sd = { delegateAction: da, signature: new L.Signature({ keyType: 0, data: sig.signature }) };
        return api('/relay', { method: 'POST', body: { signedDelegate: b64(L.encodeSignedDelegate(sd)) } });
      });
    });
  }

  function askSend(token) {
    var body = $('div');
    body.appendChild($('p', null, 'Kirim 1 ' + itemName(token) + ' ke pemain lain. Tanpa dompet, tanpa gas.'));
    var input = $('input'); input.type = 'text'; input.placeholder = 'akun penerima (…players…testnet)'; input.maxLength = 64;
    body.appendChild(input);
    GT.modal({
      title: 'Kirim ' + itemName(token), body: body,
      actions: [{ label: 'Kirim', primary: true, onClick: function (h) {
        var to = String(input.value || '').trim().toLowerCase();
        if (!/^[a-z0-9._-]{2,64}$/.test(to)) { GT.toast('Nama akun tidak valid'); return false; }
        h.close('ok');
        var p = S.mode === 'offline' ? Promise.resolve(OFF.send(token, to, 1)) : signedSend(token, to, 1);
        GT.toast('Mengirim…');
        p.then(function (r) {
          GT.toast(r && r.status === 'failed' ? 'Ditolak kontrak: ' + (r.error || '') : 'Terkirim!');
          return refresh();
        }).catch(function (e) { GT.toast('Gagal: ' + e.message); });
        return true;
      } }]
    });
    setTimeout(function () { input.focus(); }, 50);
  }

  /* ------------------------------------------------------------ Tas NEAR + Riwayat modals */
  function txLink(h) {
    if (!h.tx_hash) return $('span', 'chain-dim', h.status === 'pending' ? 'menunggu…' : '—');
    if (S.mode !== 'testnet') return $('span', 'chain-dim', 'mock tx');
    var a = $('a', 'chain-link', 'lihat ↗');
    a.href = S.cfg.explorerTxUrl + encodeURIComponent(h.tx_hash); a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.title = h.tx_hash;
    return a;
  }

  function bagBody() {
    var wrap = $('div');
    if (S.account) wrap.appendChild($('p', 'chain-dim', 'Akun: ' + S.account));
    var pend = S.history.filter(function (h) { return h.status === 'pending' && h.kind === 'gather'; }).length;
    Object.keys(ITEM).forEach(function (t) {
      var row = $('div', 'mrow');
      row.appendChild($('span', 'grow', itemName(t)));
      row.appendChild($('span', 'num', String(S.balances[t] || 0)));
      var b = $('button', 'mbtn', 'Kirim'); b.type = 'button';
      b.disabled = !(+S.balances[t] > 0);
      b.addEventListener('click', function () { askSend(t); });
      row.appendChild(b);
      wrap.appendChild(row);
    });
    if (pend) wrap.appendChild($('p', 'chain-dim', pend + ' barang menunggu dicetak on-chain (maks. 30 detik).'));
    wrap.appendChild($('p', 'chain-dim', 'Tekan A menghadap air (Ikan), batu (Bijih) atau pohon (Kayu).'));
    return wrap;
  }

  function historyBody() {
    var wrap = $('div');
    if (!S.history.length) wrap.appendChild($('p', null, 'Belum ada transaksi.'));
    S.history.forEach(function (h) {
      var row = $('div', 'mrow');
      var t = new Date(h.created_at);
      row.appendChild($('span', 'num', ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2)));
      row.appendChild($('span', 'grow', h.summary));
      row.appendChild($('span', 'chain-st ' + h.status, { pending: '…', ok: '✓', failed: '✗', mock: 'mock' }[h.status] || h.status));
      row.appendChild(txLink(h));
      wrap.appendChild(row);
    });
    return wrap;
  }

  function open(kind) {
    if (S.mode !== 'offline' && !S.account) { login(); return; }
    var h = GT.modal({
      title: kind === 'bag' ? 'Tas NEAR' : 'Riwayat on-chain', wide: kind !== 'bag',
      body: kind === 'bag' ? bagBody() : historyBody(),
      onClose: function () { S.modal = null; }
    });
    S.modal = { kind: kind, h: h };
    refresh();
  }
  function redraw() {
    if (!S.modal || !S.modal.h || !S.modal.h.isOpen()) return;
    S.modal.h.setBody(S.modal.kind === 'bag' ? bagBody() : historyBody());
  }

  /* ------------------------------------------------------------ engine hooks */
  function onInteract(ctx) {
    if (ctx.mode !== 'talk' || ctx.npc || ctx.door) return false;
    var token = TILE_ITEM[ctx.tileType];
    if (!token || ctx.scene.kind !== 'out') return false;
    return gather(token);
  }

  function init() {
    accBtn = GT.addHudButton({ id: 'chainbtn', label: 'Masuk', key: 'N', secondary: false, onClick: function () { open('bag'); } });
    GT.addHudButton({ id: 'riwayatbtn', label: 'Riwayat', key: 'H', onClick: function () { open('history'); } });
    var forceOffline = /[?&]mode=offline\b/.test(location.search) || location.protocol === 'file:';
    var cfgP = forceOffline ? Promise.reject(new Error('offline')) :
      Promise.race([api('/config'), new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, 4000); })]);
    cfgP.then(function (cfg) {
      S.cfg = cfg; S.mode = cfg.chainMode === 'mock' ? 'mock' : 'testnet';
      S.account = lsGet(LS_ACC);
    }).catch(function () { S.mode = 'offline'; }).then(function () {
      renderBanner(); return refresh();
    }).then(schedulePoll);
    renderBanner();
  }

  window.GT_CHAIN = { state: S, refresh: refresh, gather: gather, login: login, open: open, _signedSend: signedSend };
  GT.register({ id: 'chain', init: init, onInteract: onInteract });
})();
