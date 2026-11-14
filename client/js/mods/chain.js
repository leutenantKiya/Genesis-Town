/* chain.js - NEAR layer and economy client for Genesis Town (M2). Talks to the engine only through window.GT.
 *
 * Modes (always shown in a banner):
 *   testnet - server with the real NEAR testnet contract. Sign in with NEAR Auth (one Auth0 popup).
 *   mock    - same server, in-memory chain (CHAIN_MODE=mock). Labelled "mock".
 *   offline - no server (?mode=offline or unreachable). Only gathering works, stored in this browser.
 *
 * What is on chain and what is not (docs/onchain-offchain.md):
 *   off-chain, instant: gather (A at water/rock/tree), farm (A at your plot), craft (A at your table), eat, ship
 *                       (A at your chest), trade with merchants (talk to Sari/Budi/Wati/Joko at the market)
 *   daily settlement at 06:00: everything above is written on chain in one batch, with the ledger's Merkle root
 *   on-chain right away (signed in the browser with the session key, relayed gas-free): send items to a player,
 *                       restoration pledges, dividend claims
 */
(function () {
  'use strict';
  var LS_ACC = 'gt.chain.account', LS_KEY = 'gt.chain.sessionKey', LS_OFF = 'gt.chain.offline';
  // Game keys of every account that played in this browser ({account: secret key}), so signing out and back in (or
  // switching accounts) never loses a key. LS_KEY holds the key for the next sign-in until the server confirms it.
  var LS_KEYS = 'gt.chain.keys', LS_FORCE = 'gt.chain.chooseAccount', LS_OWNER = 'gt.chain.ownerKey';
  var TILE_ITEM = { water: 'fish', rock: 'ore', tree: 'wood' };
  var MERCHANTS = [
    { id: 'sari', pal: 3, dx: 3, dy: 2, tag: $t('Sari · Ikan') },
    { id: 'budi', pal: 2, dx: 5, dy: 2, tag: $t('Budi · Bengkel') },
    { id: 'wati', pal: 5, dx: -3, dy: 2, tag: $t('Wati · Roti') },
    { id: 'joko', pal: 4, dx: -5, dy: 2, tag: $t('Joko · Serba Ada') }
  ];
  var S = { mode: 'loading', cfg: null, account: null, st: null, market: null, shops: null, history: [], busy: false, poll: 0, modal: null, plots: [], npcs: {} };

  function $(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function item(t) { var e = S.cfg && S.cfg.econ && S.cfg.econ.items[t]; return e ? e.name : t; }
  function button(label, onClick, cls) { var b = $('button', 'mbtn' + (cls ? ' ' + cls : ''), label); b.type = 'button'; b.addEventListener('click', onClick); return b; }

  /* ------------------------------------------------------------ server API */
  // Every request of a signed-in player is signed with the session key (server/src/reqauth.ts has the format).
  function signHeaders(method, pathQuery, body) {
    var kp = sessionKey(), ts = String(Date.now()), enc = new TextEncoder();
    return crypto.subtle.digest('SHA-256', enc.encode(body)).then(function (h) {
      var hex = Array.prototype.map.call(new Uint8Array(h), function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
      var sig = kp.sign(enc.encode('GT1\n' + method + '\n' + pathQuery + '\n' + ts + '\n' + hex)).signature;
      return { 'x-account-id': S.account, 'x-gt-key': kp.getPublicKey().toString(), 'x-gt-ts': ts, 'x-gt-sig': b64(sig) };
    });
  }
  var API_BASE = window.GT_API || ''; // vendor/env.js: the server's origin when this page is hosted apart from it
  function api(path, opts) {
    opts = opts || {};
    var method = opts.method || 'GET', body = opts.body ? JSON.stringify(opts.body) : '';
    var headers = { 'content-type': 'application/json' };
    if (window.GT_LANG === 'id') headers['x-gt-lang'] = 'id'; // the server answers in English unless told otherwise
    var signing = S.account && window.NearLib ? signHeaders(method, '/api' + path, body) : Promise.resolve({});
    return signing.then(function (sh) {
      for (var k in sh) headers[k] = sh[k];
      return fetch(API_BASE + '/api' + path, { method: method, headers: headers, body: body || undefined })
        .catch(function (e) { netDown(); throw e; }); // no answer at all: the connection is gone
    })
      .then(function (r) {
        if (r.status === 502 || r.status === 503 || r.status === 504) netDown(); else netUp(); // a proxy with no server behind it (a deploy)
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) { var e = new Error(j.error || ('HTTP ' + r.status)); e.status = r.status; if (j.code) e.code = j.code; if (e.code === 'superseded') onSuperseded(); if (e.code === 'legacy_account') onLegacy(); throw e; }
          return j;
        });
      });
  }

  // An account made with the old (public) NEAR Auth is retired by an admin; the server answers its login, or its old session,
  // with 'legacy_account'. Say so once, forget the account here, and point the player to a new account.
  function onLegacy() {
    if (S.legacyShown) return;
    S.legacyShown = true;
    S.account = null; S.st = null; lsSet(LS_ACC, null);
    var body = $('div');
    body.appendChild($('p', null, $t('Akun ini dibuat dengan NEAR Auth versi lama dan sudah dihentikan. Buat akun baru dengan login yang berbeda (misalnya akun Google lain).')));
    GT.modal({ title: $t('Akun lama'), body: body, actions: [{ label: $t('Oke'), primary: true, onClick: function (h) { S.legacyShown = false; h.close('action'); renderBanner(); renderHud(); return true; } }] });
  }

  // One live session per account: a newer login elsewhere makes the server answer 409 'superseded'. Stop polling and
  // block the screen until the player signs in again here ("Main di sini"), which makes this device's key active again.
  function onSuperseded() {
    if (S.superseded) return;
    S.superseded = true;
    var body = $('div');
    body.appendChild($('p', null, $t('Akunmu sedang dimainkan di perangkat lain. Satu akun hanya bisa aktif di satu perangkat. Tekan "Main di sini" untuk masuk lagi dan mengambil alih.')));
    GT.modal({ title: $t('Akunmu dibuka di perangkat lain'), body: body, closable: false, actions: [{ label: $t('Main di sini'), primary: true, onClick: function (h) { h.close('action'); login(); return true; } }] });
  }

  /* ------------------------------------------------------------ offline (browser only, gathering) */
  var OFF = {
    load: function () { try { return JSON.parse(lsGet(LS_OFF) || 'null') || { bal: {}, hist: [], n: 0 }; } catch (e) { return { bal: {}, hist: [], n: 0 }; } },
    gather: function (t) {
      var d = OFF.load(); d.bal[t] = (d.bal[t] || 0) + 1;
      d.hist.unshift({ id: ++d.n, kind: 'gather', summary: '+1 ' + item(t), tokens: ',' + t + ',', status: 'mock', tx_hash: null, created_at: Date.now() });
      d.hist = d.hist.slice(0, 50); lsSet(LS_OFF, JSON.stringify(d)); return d;
    }
  };

  /* ------------------------------------------------------------ banner + HUD */
  var banner = null, accBtn = null, hudCell = null;
  // Chain details (account name, "on-chain" labels, explorer links) stay out of the way unless the player turns them
  // on in Riwayat. Everything is still recorded on NEAR either way; this only changes what the screens mention.
  var LS_DETAILS = 'gt.chain.details';
  function chainUI() { try { return localStorage.getItem(LS_DETAILS) === '1'; } catch (e) { return false; } }
  function setChainUI(on) { try { localStorage.setItem(LS_DETAILS, on ? '1' : '0'); } catch (e) { /* storage blocked */ } renderBanner(); }
  function oc() { return chainUI() ? ' (on-chain)' : ''; }
  function renderBanner() {
    if (!banner) {
      banner = $('div', 'chain-banner'); banner.setAttribute('role', 'status');
      var shell = document.querySelector('.shell');
      if (shell) shell.insertBefore(banner, shell.firstChild);
    }
    var txt, cls = 'chain-banner ';
    if (S.mode === 'offline') { txt = $t('OFFLINE DEMO · hanya mengumpulkan, tidak ada transaksi on-chain'); cls += 'off'; }
    else if (S.mode === 'mock') { txt = $t('SERVER MOCK CHAIN · transaksi tiruan, bukan testnet'); cls += 'mock'; }
    else if (S.mode === 'testnet') { txt = $t('NEAR testnet{0}', [S.account ? ' · ' + S.account : $t(' · belum masuk')]); cls += 'net'; }
    else { txt = $t('Menghubungkan…'); cls += 'mock'; }
    banner.className = cls; banner.textContent = txt;
    banner.hidden = S.mode === 'testnet' && !chainUI(); // mock and offline banners are warnings and always show
    // before signing in, the prototype's local coin counter would show a balance that isn't yours: hide it
    document.documentElement.classList.toggle('gt-guest', (S.mode === 'testnet' || S.mode === 'mock') && !S.account);
    renderTitle();
    if (accBtn) accBtn.textContent = S.account || S.mode === 'offline' ? $t('Tas') : $t('Masuk');
  }

  /* ---- Title card: what this is and one button to start, for anyone not signed in yet ---- */
  var titleEl = null;
  function liveLine() {
    var open = (S.market || []).filter(function (m) { return m.open; }), closed = (S.market || []).length - open.length, best = null;
    open.forEach(function (m) { m.items.forEach(function (it) { if (it.ask != null && (!best || Math.abs(it.changePct) > Math.abs(best.it.changePct))) best = { m: m, it: it }; }); });
    var parts = [];
    if (best) parts.push($t('{0} di {1} {2} koin{3}', [item(best.it.token), best.m.name, best.it.ask, best.it.changePct ? ' (' + (best.it.changePct > 0 ? $t('naik ') : $t('turun ')) + Math.abs(best.it.changePct) + '%)' : '']));
    if (closed) parts.push($t('{0} toko tutup, butuh bantuan warga', [closed]));
    return parts.length ? $t('Di pasar sekarang: {0}', [parts.join(' · ')]) : null;
  }
  function renderTitle() {
    var show = (S.mode === 'testnet' || S.mode === 'mock') && !S.account;
    try { if (sessionStorage.getItem('gt.title.skip') === '1') show = false; } catch (e) { /* storage blocked */ }
    document.documentElement.classList.toggle('gt-titlecard', show);
    if (!show) { if (titleEl) titleEl.hidden = true; return; }
    var screen = document.getElementById('screen');
    if (!screen) return;
    if (!titleEl) {
      titleEl = $('section', 'gt-title'); titleEl.setAttribute('aria-labelledby', 'gt-title-h');
      screen.appendChild(titleEl);
    }
    titleEl.hidden = false;
    titleEl.textContent = '';
    var card = $('div', 'gt-title-card');
    var h = $('h1', null, 'Genesis Town'); h.id = 'gt-title-h'; card.appendChild(h);
    card.appendChild($('p', 'gt-title-lead', $t('Kota pasar piksel. Kumpulkan, olah, dan jual ke pedagang yang harganya bergerak karena pemain.')));
    var live = liveLine();
    if (live) card.appendChild($('p', 'gt-title-live', live));
    var acts = $('div', 'gt-title-acts');
    acts.appendChild(button($t('Main sekarang'), function () { login(); }, 'primary'));
    acts.appendChild(button($t('Lihat-lihat dulu'), function () { try { sessionStorage.setItem('gt.title.skip', '1'); } catch (e) { /* storage blocked */ } renderTitle(); }));
    card.appendChild(acts);
    card.appendChild($('p', 'gt-title-note', S.cfg && S.cfg.google && !nearAuthHere() ? $t('Masuk pakai Google. Tanpa dompet, tanpa biaya, langsung di browser.') : $t('Masuk pakai Google atau email. Tanpa dompet, tanpa biaya, langsung di browser.')));
    titleEl.appendChild(card);
  }

  var SEASON = { semi: $t('Semi'), panas: $t('Panas'), gugur: $t('Gugur'), dingin: $t('Dingin') };
  function renderHud() {
    if (!hudCell) {
      var hud = document.getElementById('hud');
      if (!hud) return;
      hudCell = $('div', 'cell chain-hud');
      hud.insertBefore(hudCell, hud.querySelector('.acts'));
    }
    var st = S.st;
    hudCell.textContent = '';
    if (!st) return;
    var l = $('span', 'lbl', $t('ENERGI · MUSIM')); hudCell.appendChild(l);
    var v = $('span', 'val');
    var bar = $('span', 'chain-energy'); var fill = $('i'); fill.style.width = Math.round(100 * st.energy / st.energyMax) + '%'; bar.appendChild(fill);
    v.appendChild(bar);
    v.appendChild(document.createTextNode(' ' + st.energy + ' · ' + SEASON[st.time.season] + ' H' + st.time.dayOfSeason + (st.weather ? ' · ' + st.weather.label : '')));
    hudCell.appendChild(v);
    // The engine's coin counter mirrors your NEAR coin (settled + today).
    var coin = st.bag.coin.settled + st.bag.coin.today;
    var delta = coin - GT.state.coins;
    if (delta !== 0) GT.addCoins(delta);
  }
  /* ------------------------------------------------------------ session key + login */
  function keyRing() { try { return JSON.parse(lsGet(LS_KEYS) || '{}') || {}; } catch (e) { return {}; } }
  function keepKey(account, kp) { var k = keyRing(); k[account] = kp.toString(); lsSet(LS_KEYS, JSON.stringify(k)); lsSet(LS_KEY, null); }
  function keyOf(account) { var s = keyRing()[account]; if (!s) return null; try { return window.NearLib.KeyPair.fromString(s); } catch (e) { return null; } }
  function sessionKey() {
    var mine = S.account && keyOf(S.account);
    if (mine) return mine;
    var L = window.NearLib, s = lsGet(LS_KEY);
    if (s) { try { return L.KeyPair.fromString(s); } catch (e) { /* regenerate */ } }
    var kp = L.KeyPair.fromRandom('ed25519');
    lsSet(LS_KEY, kp.toString());
    return kp;
  }

  // New device (M4): this login has an account, but this browser has no session key for it. The player's own NEAR
  // Auth key signs a delegate action that adds a fresh game-only key; the server has it signed by the MPC and relays
  // it (server/src/newdevice.ts). The approval popup must come from a click, so it sits behind a button.
  function newDevice(provider, r, idToken) {
    var L = window.NearLib;
    lsSet(LS_KEY, null);
    var kp = sessionKey();
    var body = $('div');
    body.appendChild($('p', null, $t('Akunmu ({0}) belum punya kunci game di perangkat ini.', [r.accountId.split('.')[0]])));
    body.appendChild($('p', null, $t('Setujui satu kali di jendela NEAR Auth, lalu kunci baru ditambahkan ke akunmu di testnet. Kunci ini hanya bisa memanggil kontrak game, tidak bisa memindahkan NEAR. Gas dibayar game.')));
    return new Promise(function (resolve, reject) {
      GT.modal({ title: $t('Perangkat baru'), sticky: true, body: body, onClose: function (why) { if (why !== 'action') reject(new Error($t('Dibatalkan'))); }, actions: [{ label: $t('Setujui di NEAR Auth'), primary: true, onClick: function (h) {
        var prov = new L.JsonRpcProvider({ url: S.cfg.rpcUrl }), da;
        GT.toast($t('Membuka NEAR Auth…'));
        Promise.all([prov.viewAccessKey({ accountId: r.accountId, publicKey: L.PublicKey.from(r.ownerPublicKey) }), prov.viewBlock({ finality: 'final' })])
          .catch(function () { throw new Error($t('Kunci NEAR Auth-mu tidak ditemukan di akun ini.')); })
          .then(function (x) {
            da = L.buildDelegateAction({
              senderId: r.accountId, receiverId: r.accountId,
              actions: [L.actions.addFunctionCallAccessKey(kp.getPublicKey(), S.cfg.gameContractId, [], 0n)],
              nonce: BigInt(x[0].nonce) + 1n, maxBlockHeight: BigInt(x[1].header.height) + 1500n, publicKey: L.PublicKey.from(r.ownerPublicKey)
            });
            return provider.requestDelegateActionSignature({ delegateAction: da });
          })
          .then(function () { return provider.getSignatureRequest(); })
          .then(function (res) {
            GT.toast($t('Menambahkan kunci ke akunmu…'));
            var sr = res.signatureRequest;
            return api('/auth/add-key', { method: 'POST', body: {
              idToken: idToken,
              delegateAction: b64(L.encodeDelegateAction(da).slice(4)), // plain borsh DelegateAction (without the NEP-461 prefix)
              signatureRequest: { guardId: sr.guardId, verifyPayload: sr.verifyPayload, signPayload: Array.from(sr.signPayload), algorithm: sr.algorithm || 'eddsa' }
            } });
          })
          .then(function (out) { h.close('action'); resolve(out); }, function (e) { GT.toast($t('Gagal: {0}', [e && e.message || e])); });
        return false;
      } }] });
    });
  }

  // `via` is 'google' for "Masuk dengan Google" (the token is Google's own); otherwise the token is NEAR Auth's.
  function finishLogin(idToken, retried, provider, via) {
    var kp = sessionKey();
    GT.toast(chainUI() ? $t('Membuat akunmu di NEAR testnet…') : $t('Menyiapkan akunmu…'));
    var reg = function (pk) { var b = { idToken: idToken, sessionPublicKey: pk }; if (via) b.provider = via; return api('/auth/register', { method: 'POST', body: b }); };
    return reg(kp.getPublicKey().toString())
      .catch(function (e) {
        // This browser's key belongs to another login: make a fresh key for this one and try once more.
        if (!retried && /already belongs to another account/.test(e.message)) { lsSet(LS_KEY, null); return finishLogin(idToken, true, provider, via).then(function () { return null; }); }
        throw e;
      })
      .then(function (r) {
        if (r === null) return;
        // A new device is in at once: the server keeps its key off-chain until the first on-chain action (approveDevice).
        var enter = function (res, key) {
          lsSet(LS_OWNER, res.needsChainApproval && res.ownerPublicKey ? res.ownerPublicKey : null);
          keepKey(res.accountId, key);
          S.account = res.accountId; S.superseded = false; lsSet(LS_ACC, res.accountId); renderBanner();
          GT.toast(res.created ? $t('Akun dibuat! Paket awal: 100 koin, 1 Beliung, 3 Roti, 3 Gandum.') : $t('Selamat datang kembali!'));
          return refresh(true);
        };
        // a key for this account from an earlier sign-in in this browser: use it instead of the fresh one
        var known = r.needsChainApproval && keyOf(r.accountId);
        if (known && known.getPublicKey().toString() !== kp.getPublicKey().toString()) {
          return reg(known.getPublicKey().toString()).then(function (r2) { return enter(r2, known); });
        }
        return enter(r, kp);
      });
  }

  // First on-chain action on a device that signed in off-chain: the player's NEAR Auth key adds this device's game key
  // to the account (newDevice). Resolves once the key is on the account; rejects when the player cancels or NEAR Auth is
  // unusable here (then nothing else can approve it).
  // NEAR Auth's login only returns to page addresses it has allowed (the server lists them in fastAuth.origins). Anywhere
  // else its popup can only fail with "Callback URL mismatch", so the game does not offer it there.
  // NEAR Auth's browser provider: our own NEAR Auth deployment (docs/fastauth-fork-plan.md) sends its client id, Auth0
  // domain and signing audience in /api/config (`fastAuth` is null when the server has none: then only Google login).
  function nearProvider() {
    var fa = S.cfg.fastAuth;
    return new window.NearLib.JavascriptProvider({ network: 'testnet', clientId: fa.clientId, domain: fa.domain, signingAudience: fa.signingAudience });
  }
  function nearAuthHere() {
    var fa = S.cfg && S.cfg.fastAuth;
    if (!window.NearLib || !fa || S.cfg.devLogin) return false;
    return !fa.origins || fa.origins.indexOf(location.origin) >= 0;
  }
  function msgNoNearAuth() { return $t('Pasar, hadiah, saham, dan proyek kota di perangkat ini perlu persetujuan NEAR Auth, yang belum aktif di alamat ini. Kamu tetap bisa bermain; untuk hal on-chain, pakai perangkat pertamamu.'); }
  function approveDevice() {
    var usable = nearAuthHere(), ownerPk = lsGet(LS_OWNER);
    var body = $('div');
    if (!usable || !ownerPk) {
      body.appendChild($('p', null, msgNoNearAuth()));
      GT.modal({ title: $t('Setujui perangkat ini'), body: body });
      return Promise.reject(new Error($t('Perangkat ini belum disetujui.')));
    }
    body.appendChild($('p', null, $t('Untuk memakai Pasar, hadiah, saham, atau proyek kota, setujui perangkat ini satu kali dengan NEAR Auth. Bermain biasa tidak perlu persetujuan.')));
    return new Promise(function (resolve, reject) {
      GT.modal({ title: $t('Setujui perangkat ini'), sticky: true, body: body, onClose: function (why) { if (why !== 'action') reject(new Error($t('Dibatalkan'))); }, actions: [{ label: $t('Setujui dengan NEAR Auth'), primary: true, onClick: function (h) {
        var provider = nearProvider();
        GT.toast($t('Membuka NEAR Auth…'));
        provider.login(undefined, true)
          .then(function () { return provider.client.getIdTokenClaims(); })
          .then(function (claims) {
            if (!claims || !claims.__raw) throw new Error($t('Login tidak memberi token'));
            h.close('action');
            return newDevice(provider, { accountId: S.account, ownerPublicKey: ownerPk }, claims.__raw);
          })
          .then(function () { lsSet(LS_OWNER, null); resolve(); }, function (e) { GT.toast($t('Gagal: {0}', [e && e.message || e])); reject(e); });
        return false;
      } }] });
    });
  }


  // Sign out: forget the account in this browser and clear the NEAR Auth login cache (no redirect). The game key stays
  // in the key ring, so signing back in as the same account needs no new-device step. The next sign-in asks for the
  // account again instead of reusing the last one.
  function signOut() {
    if (S.modal && S.modal.h) S.modal.h.close('signout');
    S.account = null; S.st = null; S.history = []; S.shops = null; S.listings = null; S.projects = null;
    lsSet(LS_ACC, null); lsSet(LS_FORCE, '1');
    if (window.NearLib && S.cfg && S.cfg.fastAuth && !S.cfg.devLogin) {
      try { nearProvider().logout({ openUrl: false }).catch(noop); } catch (e) { /* cache only */ }
    }
    try { if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect(); } catch (e) { /* not loaded */ }
    renderBanner(); renderHud();
    GT.toast($t('Kamu sudah keluar. Tekan Masuk untuk masuk lagi.'));
    return refresh(true);
  }

  function login() {
    if (S.busy) return;
    if (S.cfg && S.cfg.devLogin) return devLogin();
    if (S.cfg && S.cfg.google) return chooseLogin();
    if (!nearAuthHere()) {
      GT.modal({ title: $t('Masuk'), body: $t('Login belum aktif di alamat ini: NEAR Auth hanya menerima alamat yang sudah didaftarkan, dan login Google belum dipasang di server ini. Kamu tetap bisa melihat-lihat desa sebagai tamu.'), actions: [{ label: $t('Oke'), primary: true }] });
      return;
    }
    return nearLogin();
  }

  /* ---- "Masuk dengan Google": Google Identity Services, no NEAR Auth needed (it only accepts allow-listed domains).
     The server checks Google's token and files the player under the id NEAR Auth gives the same Google account, so
     both buttons open one account. Library, calls and options: https://developers.google.com/identity/gsi/web */
  var gsi = null, onGoogle = null;
  function loadGsi() {
    if (gsi) return gsi;
    gsi = new Promise(function (resolve, reject) {
      // Google's docs: on plain-http localhost the button needs this referrer policy
      if (location.protocol === 'http:') { var m = document.createElement('meta'); m.name = 'referrer'; m.content = 'no-referrer-when-downgrade'; document.head.appendChild(m); }
      var sc = document.createElement('script');
      sc.src = 'https://accounts.google.com/gsi/client'; sc.async = true;
      sc.onload = function () {
        if (!window.google || !google.accounts || !google.accounts.id) { reject(new Error($t('Google tidak termuat'))); return; }
        google.accounts.id.initialize({ client_id: S.cfg.google.clientId, callback: function (res) { if (onGoogle) onGoogle(res); }, ux_mode: 'popup', auto_select: false, use_fedcm_for_button: true });
        resolve(google.accounts.id);
      };
      sc.onerror = function () { gsi = null; reject(new Error($t('Tidak bisa memuat tombol Google (cek koneksi atau pemblokir iklan).'))); };
      document.head.appendChild(sc);
    });
    return gsi;
  }
  function chooseLogin() {
    var body = $('div', 'gt-login');
    body.appendChild($('p', null, $t('Pilih cara masuk. Akunmu tetap akun NEAR testnet; tanpa dompet, tanpa biaya gas.')));
    var slot = $('div', 'gt-login-google'); slot.appendChild($('p', 'mnote', $t('Memuat tombol Google…')));
    body.appendChild(slot);
    var h;
    if (nearAuthHere()) {
      body.appendChild($('p', 'gt-login-or', $t('atau')));
      var nb = $('button', 'gt-login-near', $t('Masuk dengan NEAR Auth (Google/email)')); nb.type = 'button';
      nb.addEventListener('click', function () { h.close('near'); nearLogin(); });
      body.appendChild(nb);
    }
    h = GT.modal({ title: $t('Masuk'), body: body, actions: [], onClose: function () { onGoogle = null; } });
    onGoogle = function (res) {
      if (!res || !res.credential) { GT.toast($t('Google tidak memberi token')); return; }
      h.close('google'); onGoogle = null; S.busy = true;
      var ring = busyRing();
      finishLogin(res.credential, false, null, 'google')
        .catch(function (e) { GT.toast($t('Gagal masuk: {0}', [e && e.message || e])); })
        .then(function () { S.busy = false; ring(); });
    };
    loadGsi().then(function (id) {
      if (h.closed) return;
      slot.textContent = '';
      var btn = $('div'); slot.appendChild(btn);
      id.renderButton(btn, { type: 'standard', theme: 'outline', size: 'large', text: 'signin_with', shape: 'rectangular', width: 280, locale: (window.GT_LANG || 'en') });
    }, function (e) { slot.textContent = ''; slot.appendChild($('p', 'mnote', e.message)); });
  }

  function nearLogin() {
    if (S.busy) return;
    if (!window.NearLib) { GT.toast($t('Pustaka NEAR belum dimuat (jalankan build klien).')); return; }
    S.busy = true;
    var ring = busyRing();
    var provider = nearProvider();
    var choose = lsGet(LS_FORCE) === '1';
    provider.login(undefined, choose)
      .then(function () { lsSet(LS_FORCE, null); return provider.client.getIdTokenClaims(); })
      .then(function (claims) {
        if (!claims || !claims.__raw) throw new Error($t('Login tidak memberi token'));
        return finishLogin(claims.__raw, false, provider);
      })
      .catch(function (e) { GT.toast($t('Gagal masuk: {0}', [e && e.message || e])); })
      .then(function () { S.busy = false; ring(); });
  }

  /* a loading ring over the game while a sign-in runs; returns the function that takes it away */
  function busyRing() {
    var el = $('div', 'gt-busy'); el.setAttribute('role', 'status');
    el.appendChild($('span', 'gt-busy-ring')); el.appendChild($('span', 'gt-busy-text', $t('Sedang masuk…')));
    document.body.appendChild(el);
    return function () { if (el.parentNode) el.parentNode.removeChild(el); };
  }

  function devLogin() {
    var input = $('input'); input.type = 'text'; input.maxLength = 32; input.placeholder = $t('nama (huruf kecil)');
    var body = $('div');
    body.appendChild($('p', null, $t('Server ini memakai rantai tiruan (mock) dengan login pengembang. Ketik nama pemain:')));
    body.appendChild(input);
    GT.modal({ title: $t('Masuk (dev, mock)'), sticky: true, body: body, actions: [{ label: $t('Masuk'), primary: true, onClick: function (h) {
      var v = String(input.value || '').trim().toLowerCase();
      if (!/^[a-z0-9_-]{1,32}$/.test(v)) { GT.toast($t('Nama: huruf kecil, angka, - atau _')); return false; }
      h.close('ok'); S.busy = true;
      var ring = busyRing();
      finishLogin('dev:' + v).catch(function (e) { GT.toast($t('Gagal masuk: {0}', [e.message])); }).then(function () { S.busy = false; ring(); });
      return true;
    } }] });
    setTimeout(function () { input.focus(); }, 50);
  }

  /* ------------------------------------------------------------ connection health: notice, retry, reconnect
     A request that gets no answer (or a 502/503/504 from the host while the server restarts) marks the connection down:
     a small badge says so and /api/health is tried every few seconds. The first answer brings the game back: state,
     bag and presence reload (players.js keeps polling on its own). A game that had to start offline because the
     server could not be reached reloads the page once the server answers, to come up online. */
  var net = { down: false, bootFailed: false, timer: 0, badge: null };
  function netBadge(on) {
    if (on && !net.badge) {
      net.badge = $('div', 'gt-net', '📡 ' + $t('Koneksi ke server terputus · menyambung ulang…'));
      net.badge.setAttribute('role', 'status'); document.body.appendChild(net.badge);
    } else if (!on && net.badge) { net.badge.remove(); net.badge = null; }
  }
  function netCheckSoon(ms) { clearTimeout(net.timer); net.timer = setTimeout(netCheck, ms || 3000); }
  function netCheck() {
    if (!net.down) return;
    fetch(API_BASE + '/api/health', { cache: 'no-store' }).then(function (r) {
      if (r.status === 502 || r.status === 503 || r.status === 504) netCheckSoon(); else netUp();
    }, function () { netCheckSoon(); });
  }
  function netDown() { if (net.down) return; net.down = true; netBadge(true); netCheckSoon(); }
  function netUp() {
    if (!net.down) return;
    net.down = false; clearTimeout(net.timer); netBadge(false);
    if (net.bootFailed) { location.reload(); return; }
    GT.toast('📡 ' + $t('Tersambung lagi ke server.'));
    refresh(true);
  }
  window.addEventListener('online', function () { if (net.down) netCheckSoon(200); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden && net.down) netCheckSoon(200); });

  /* ------------------------------------------------------------ state refresh + clock sync */
  function refresh(full) {
    if (S.superseded) return Promise.resolve();
    if (S.mode === 'offline') { var d = OFF.load(); S.history = d.hist; redraw(); return Promise.resolve(); }
    var jobs = [api('/market').then(function (m) { S.market = m.merchants; })];
    if (S.account) {
      var sp = standPos();
      jobs.push(api('/state?x=' + sp.x + '&y=' + sp.y + '&world=' + encodeURIComponent(worldNow())).then(function (st) { S.st = st; S.stAt = Date.now(); syncClock(st.time); followWorld(st.world); }));
      if (full || S.modal) jobs.push(api('/history').then(function (h) { S.history = h.history || []; }));
      if (S.modal && S.modal.kind === 'history' && !S.modal.arg && S.histFilter === 'trade') jobs.push(api('/history?kind=trade').then(function (h) { S.tradeHistory = h.history || []; }));
      if (S.modal && S.modal.kind === 'history' && S.modal.arg) {
        var ht = S.modal.arg;
        jobs.push(api('/history?token=' + encodeURIComponent(ht)).then(function (h) { S.itemHistory = { token: ht, rows: h.history || [] }; }));
      }
      if (full || (S.modal && S.modal.kind === 'shop')) jobs.push(api('/shops').then(function (s) { S.shops = s.shops; }));
      if (S.modal && S.modal.kind === 'project') jobs.push(api('/projects').then(function (r) { S.projects = r.projects || []; }));
      if (S.modal && S.modal.kind === 'market') jobs.push(api('/listings').then(function (l) { S.listings = l.listings || []; S.feeBps = l.feeBps; S.popular = l.popular || []; }), myTag());
    } else {
      jobs.push(api('/time').then(function (t) { syncClock(t); followWorld(t.world); S.weather = t.weather; S.season = t.season; }));
    }
    return Promise.all(jobs).then(function () { renderHud(); redraw(); renderGoals(); if (!S.account) renderTitle(); applyWeatherClass(); if (S.st && S.st.encounter && !fightOpen() && !GT.isUiOpen()) openFight(); else if (S.st && !S.st.encounter && fightOpen()) closeFight(); }).catch(function (e) {
      if (e.status === 401) { S.account = null; lsSet(LS_ACC, null); renderBanner(); }
    });
  }

  // When a town project opens a new area, every player's map follows within one poll.
  function followWorld(w) {
    if (!w || !GT.setWorld) return;
    var prevSeed = GT.world && GT.world.seed, before = (GT.world && GT.world.layout && GT.world.layout.unlocked) || [];
    if (!GT.setWorld(w.seed, w.unlocked) || prevSeed !== w.seed) return; // first load or a new world: no news
    var fresh = (w.unlocked || []).filter(function (c) { return before.indexOf(c) < 0; });
    var names = fresh.map(function (id) { var c = (GT.world.chunks || []).filter(function (q) { return q.id === id; })[0]; return c ? c.name : id; });
    if (names.length) GT.toast($t('Proyek desa selesai! {0} sekarang terbuka.', [names.join(', ')]));
  }

  function syncClock(t) {
    // The server owns game time: 1 game day = 24 real minutes; keep the engine clock in step.
    if (GT.dayLength !== 24) GT.setDayLength(24);
    if (GT.setHudDay) GT.setHudDay(t.dayOfSeason != null ? t.dayOfSeason : null); // same day number as the season badge
    var m = Math.floor((t.fraction || 0) * 60);
    var cur = GT.time;
    var curMin = cur && cur.hour != null ? cur.hour * 60 + (cur.minute || 0) : -999;
    if (Math.abs(curMin - (t.hour * 60 + m)) > 3) GT.setTime(t.hour, m);
  }

  function schedulePoll() {
    clearTimeout(S.poll);
    S.poll = setTimeout(function () { refresh(false).then(schedulePoll); }, 5000);
  }

  // 'public' or 'HL-<id>': which outdoor world the player is in (homeland.js switches it).
  function worldNow() { return (GT.worldId && GT.worldId()) || 'public'; }
  // Where the player stands for the server's checks: the tile outdoors, or the door front of the building they are in.
  function standPos() {
    var sc = GT.scene, p = GT.player;
    if (sc && sc.kind !== 'out' && sc.house) return { x: sc.house.dx, y: sc.house.dy + 1 };
    return { x: p.x, y: p.y };
  }
  /* ---- Misi: a newcomer's next step through the whole first loop (village, then Homeland), one at a time, ticked off
     by what they actually do (history rows, the Homeland's state, the farm plots) ---- */
  // each step: an icon and a few words on the card, one short hint under them; the full how-to is the card's tooltip
  var GOALS = [
    { id: 'signin', icon: '🔑', title: $t('Masuk'), hint: $t('Google atau email. Tanpa dompet, tanpa gas.'), text: $t('Tekan Masuk untuk membuat akunmu (Google atau email). Tanpa dompet, tanpa gas.') },
    { id: 'gather', icon: '🧺', title: $t('Kumpulkan bahan'), hint: $t('Klik kolam, pohon atau batu.'), text: $t('Klik kolam, pohon atau batu (atau hadap lalu tekan F). Hasilnya masuk ke Tas.') },
    { id: 'craft', icon: '🔨', title: $t('Buat sesuatu'), hint: $t('Meja Kerja: 2 Gandum jadi Roti.'), text: $t('Buat sesuatu di Meja Kerja: 2 Gandum jadi Roti, atau Ikan + Kayu jadi Ikan Bakar.') },
    { id: 'sell', icon: '🪙', title: $t('Jual hasilmu'), hint: $t('Ke pedagang di Pasar.'), text: $t('Jalan ke Pasar di timur rumahmu dan jual hasilmu ke Sari, Budi, Wati atau Joko.') },
    { id: 'home', icon: '🌀', title: $t('Pergi ke Homeland'), hint: $t('Berdiri di portal batu.'), text: $t('Berdiri di portal batu dekat alun-alun dan tunggu sebentar: kamu pindah ke Homeland-mu sendiri.') },
    { id: 'build', icon: '🏗️', title: $t('Bangun Kolam Ikan'), hint: $t('Klik lahan kosong di Homeland.'), text: $t('Di Homeland, buka lahan kosong (klik pintunya) dan bangun Kolam Ikan.') },
    { id: 'th', icon: '🏛️', title: $t('Naikkan Balai Kota'), hint: $t('Ke level 2 lewat Tingkatkan.'), text: $t('Tekan Tingkatkan di atas dan naikkan Balai Kota ke level 2: bangunan baru terbuka.') },
    { id: 'plant', icon: '🌱', title: $t('Tanam Gandum'), hint: $t('Cangkul petak, lalu tanam 5 Gandummu.'), text: $t('Kamu mulai dengan 5 Gandum. Cangkul petak kebun dengan Cangkul, lalu pegang Gandum dan klik kanan petaknya untuk menanam.') },
    { id: 'board', icon: '📋', title: $t('Lihat papan proyek'), hint: $t('Di Balai Desa, samping pasar.'), text: $t('Masuk ke Balai Desa di samping pasar dan lihat papan proyek di rak belakang.') }
  ];
  var lastGoal = null, goalsSince = 0; // no 'done' toast while the first loads catch up (history arrives late)
  var goalBox = null;
  function goalKey() { return 'gt.chain.goals.' + (S.account || 'guest'); }
  function goalsDone() { try { return JSON.parse(lsGet(goalKey()) || '{}') || {}; } catch (e) { return {}; } }
  function markGoal(id) { var d = goalsDone(); if (d[id]) return; d[id] = 1; lsSet(goalKey(), JSON.stringify(d)); renderGoals(); }
  function renderGoals() {
    var screen = document.getElementById('screen');
    if (!screen || S.mode === 'loading') return;
    if (!goalBox) { goalBox = $('div', 'gt-goals'); goalBox.setAttribute('role', 'status'); screen.appendChild(goalBox); }
    var d = goalsDone();
    if (S.account) d.signin = 1;
    if (S.history && S.history.some(function (h) { return h.kind === 'gather'; })) d.gather = 1;
    if (S.history && S.history.some(function (h) { return h.kind === 'sell'; })) d.sell = 1;
    if (S.history && S.history.some(function (h) { return h.kind === 'craft'; })) d.craft = 1;
    var HM = window.GT_HOME && GT_HOME.state && GT_HOME.state();
    if (/^HL-/.test(worldNow()) || (HM && HM.world && d.home)) d.home = 1;
    if (HM && HM.built && HM.built.length) d.build = 1;
    if (HM && HM.th >= 2) d.th = 1;
    if (S.st && S.st.plots && S.st.plots.some(function (p) { return p && p.state && p.state !== 'empty' && p.state !== 'tilled'; })) d.plant = 1;
    ['home', 'build', 'th', 'plant', 'craft'].forEach(function (k) { if (d[k] && !goalsDone()[k]) { var dd = goalsDone(); dd[k] = 1; lsSet(goalKey(), JSON.stringify(dd)); } });
    var next = GOALS.filter(function (g) { return !d[g.id]; })[0];
    var ms = S.st && S.st.missions, claimable = ms && ms.claimable && ms.claimable.length ? missionOf(ms.claimable[0]) : null;
    syncMissionBtn(ms, claimable);
    if (!goalsSince) goalsSince = Date.now() + 8000;
    if (lastGoal && next !== lastGoal && S.account && Date.now() > goalsSince) GT.toast('🎯 ' + $t('Misi selesai! Lanjut ke misi berikutnya.'));
    lastGoal = next || null;
    var hidden = lsGet('gt.chain.goalsHidden') === '1';
    if (claimable) { next = missionCard(claimable, true); hidden = false; } // a finished mission waits for its reward first
    else if (ms && (!next || hidden) && ms.current) { // the first steps are done (or put away): the server's missions go on
      var cur = missionOf(ms.current);
      if (cur && lsGet('gt.chain.msHidden') !== cur.id) { next = missionCard(cur, false); hidden = false; } else if (!next || hidden) next = null;
    }
    goalBox.style.display = !next || hidden || S.mode === 'offline' ? 'none' : ''; // the missions follow the player into the Homeland too
    if (!next) return;
    goalBox.textContent = '';
    var head = $('div', 'gt-goals-head');
    head.appendChild($('b', null, next.mission ? next.icon + ' ' + next.title : next.icon + ' ' + next.title + ' · ' + (GOALS.indexOf(next) + 1) + '/' + GOALS.length));
    goalBox.title = next.text;
    var x = $('button', 'gt-goals-x', $t('Tutup')); x.type = 'button'; x.setAttribute('aria-label', $t('Sembunyikan langkah pertama'));
    x.addEventListener('click', function (e) {
      e.stopPropagation();
      if (next.mission) lsSet('gt.chain.msHidden', next.mission.id); else lsSet('gt.chain.goalsHidden', '1');
      renderGoals();
    });
    head.appendChild(x);
    goalBox.appendChild(head);
    goalBox.appendChild($('p', null, next.hint || next.text));
    if (next.mission) {
      var mm = next.mission;
      var pr = $('div', 'gt-mission-bar'); pr.appendChild($('i')); pr.firstChild.style.width = Math.round(100 * Math.min(mm.have, mm.need) / Math.max(1, mm.need)) + '%'; goalBox.appendChild(pr);
      var row = $('div', 'gt-mission-acts');
      if (mm.done && !mm.claimed) row.appendChild(button($t('Ambil hadiah: {0}', [rewardText(mm.reward)]), function () { claimMission(mm.id); }, 'primary'));
      else row.appendChild($('span', 'chain-dim', mm.have + '/' + mm.need + ' · ' + $t('Hadiah: {0}', [rewardText(mm.reward)])));
      row.appendChild(button($t('Semua misi'), function () { open('missions'); }));
      goalBox.appendChild(row);
    }
  }
  /* ---- missions from the server (state.missions): counted there, claimed once ---- */
  // The Mission button at the top right: always one tap to the list; a "!" when a reward waits or the current mission is
  // new to this player (opening the list marks it seen)
  var missionBtn = null, missionBadge = null, missionHud = null, missionHudBadge = null;
  function msSeenKey() { return 'gt.chain.msSeen.' + (S.account || 'guest'); }
  function topRight() {
    var tr = document.getElementById('gt-tr'), screen = document.getElementById('screen');
    if (!tr && screen) { tr = $('div', 'gt-tr'); tr.id = 'gt-tr'; screen.appendChild(tr); }
    return tr;
  }
  function syncMissionBtn(ms, claimable) {
    var tr = topRight();
    if (!tr) return;
    if (!missionBtn) {
      missionBtn = $('button', 'gt-trbtn gt-trbtn-mission'); missionBtn.type = 'button';
      missionBtn.appendChild($('span', null, '🎯 ' + $t('Misi'))); missionBadge = $('i', 'gt-trbadge', '!'); missionBadge.hidden = true; missionBtn.appendChild(missionBadge);
      missionBtn.addEventListener('click', function (e) { e.currentTarget.blur(); if (!GT.isUiOpen()) open('missions'); });
      tr.insertBefore(missionBtn, tr.firstChild);
      // the same button in the top bar, where Simulasi used to be (css/phone.css shows it on a computer)
      missionHud = GT.addHudButton({ id: 'gt-misbtn', label: $t('Misi'), secondary: false, onClick: function () { open('missions'); } });
      if (missionHud) { missionHudBadge = $('i', 'gt-trbadge', '!'); missionHudBadge.hidden = true; missionHud.appendChild(missionHudBadge); }
    }
    var show = !!(S.account && ms && ms.list && S.mode !== 'offline' && S.mode !== 'loading');
    missionBtn.hidden = !show; if (missionHud) missionHud.hidden = !show;
    if (!show) return;
    var fresh = !!claimable || !!(ms.current && lsGet(msSeenKey()) !== ms.current);
    missionBadge.hidden = !fresh; if (missionHudBadge) missionHudBadge.hidden = !fresh;
    missionBtn.setAttribute('aria-label', fresh ? $t('Misi, ada yang baru') : $t('Misi'));
  }
  function missionOf(id) { var l = S.st && S.st.missions && S.st.missions.list; if (!l) return null; for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i]; return null; }
  function rewardText(r) {
    var parts = [];
    Object.keys(r || {}).forEach(function (t) { parts.push(r[t] + ' ' + (t === 'coin' ? $t('koin') : item(t))); });
    return parts.join(' + ') || '-';
  }
  function missionCard(m, claim) {
    return { id: 'mission:' + m.id, mission: m, icon: claim ? '🎁' : '🎯', title: claim ? $t('Misi selesai: {0}', [m.name]) : m.name, hint: m.hint, text: m.hint };
  }
  function claimMission(id) {
    return act({ action: 'mission', op: 'claim', id: id }).then(function () { renderGoals(); if (S.modal && S.modal.kind === 'missions') redraw(); }, noop);
  }
  function missionsBody() {
    var wrap = $('div', 'gt-missions'), ms = S.st && S.st.missions;
    wrap.appendChild($('p', null, $t('Misi kecil untuk belajar bermain. Selesaikan, lalu ambil hadiahnya sekali.')));
    if (!ms || !ms.list) { wrap.appendChild($('p', 'chain-dim', $t('Memuat…'))); return wrap; }
    ms.list.forEach(function (m) {
      var row = $('div', 'gt-mission' + (m.claimed ? ' claimed' : m.done ? ' done' : ''));
      var txt = $('div', 'grow');
      txt.appendChild($('b', null, (m.claimed ? '✓ ' : m.done ? '🎁 ' : '') + m.name));
      txt.appendChild($('div', 'chain-dim', m.hint));
      var pr = $('div', 'gt-mission-bar'); pr.appendChild($('i')); pr.firstChild.style.width = Math.round(100 * Math.min(m.have, m.need) / Math.max(1, m.need)) + '%'; txt.appendChild(pr);
      txt.appendChild($('div', 'chain-dim', m.have + '/' + m.need + ' · ' + $t('Hadiah: {0}', [rewardText(m.reward)])));
      row.appendChild(txt);
      if (m.claimed) row.appendChild($('span', 'chain-dim', $t('Sudah diambil')));
      else { var b = button(m.done ? $t('Ambil hadiah') : $t('Belum selesai'), function () { claimMission(m.id); }, m.done ? 'primary' : ''); b.disabled = !m.done; row.appendChild(b); }
      wrap.appendChild(row);
    });
    return wrap;
  }

  /* ---- Alat: the four tools wear out; repair one (cheap) or make a new one from materials ---- */
  var TOOL_ORDER = ['hoe', 'pickaxe', 'axe', 'rod'];
  var TOOL_ICON = { hoe: 'hoe', pickaxe: 'pickaxe', axe: 'axe', rod: 'rod' };
  function toolName(k) { return { hoe: $t('Cangkul'), pickaxe: $t('Beliung'), axe: $t('Kapak'), rod: $t('Pancing') }[k] || k; }
  // the same costs as economy/config.json `tools` (the server charges them; /api/config sends them when it can)
  var TOOL_COST = { pickaxe: { make: { wood: 2, ore: 2 }, repair: { wood: 1, coin: 5 }, alt: { tool: 1 } }, axe: { make: { wood: 3, ore: 1 }, repair: { wood: 1, coin: 3 } }, rod: { make: { wood: 3 }, repair: { wood: 1 } }, hoe: { make: { wood: 2, ore: 1 }, repair: { wood: 1 } } };
  function toolCost(k) {
    var d = S.cfg && S.cfg.econ && S.cfg.econ.tools && S.cfg.econ.tools[k], f = TOOL_COST[k] || {};
    return d ? { make: d.make, repair: d.repair, alt: d.makeAlt } : f;
  }
  function costText(c) { return Object.keys(c || {}).map(function (t) { return c[t] + ' ' + (t === 'coin' ? $t('koin') : item(t)); }).join(' + '); }
  function canPay(c) { return Object.keys(c || {}).every(function (t) { return have(t) >= c[t]; }); }
  var toolNagAt = 0;
  var TILE_TOOL = { tree: 'axe', rock: 'pickaxe', water: 'rod' };
  // true (and a hint, plus the Tools window now and then) when the tool this tile needs is broken
  function toolBroken(tt) {
    var k = TILE_TOOL[tt], t = k && S.st && S.st.tools && S.st.tools[k];
    if (!t || !t.broken) return false;
    GT.toast($t('{0} rusak. Perbaiki atau buat baru.', [toolName(k)]));
    if (Date.now() - toolNagAt > 15000) { toolNagAt = Date.now(); open('tools'); }
    return true;
  }
  function toolsBody() {
    var wrap = $('div', 'gt-tools');
    wrap.appendChild($('p', null, $t('Setiap alat aus saat dipakai. Perbaiki alat (murah), atau buat yang baru dari bahan.')));
    if (!S.st || !S.st.tools) { wrap.appendChild($('p', 'chain-dim', $t('Memuat…'))); return wrap; }
    TOOL_ORDER.forEach(function (k) {
      var t = S.st.tools[k]; if (!t) return;
      var cost = toolCost(k), row = $('div', 'gt-tool' + (t.broken ? ' broken' : ''));
      if (window.GT_ITEMS) row.appendChild(GT_ITEMS.icon(TOOL_ICON[k], 40));
      var txt = $('div', 'grow');
      txt.appendChild($('b', null, toolName(k) + ' · ' + t.uses + '/' + t.max + (t.broken ? ' · ' + $t('rusak') : '')));
      var pct = Math.max(0, Math.min(1, t.uses / Math.max(1, t.max))), bar = $('div', 'gt-dur'); bar.appendChild($('i'));
      bar.firstChild.style.width = Math.round(pct * 100) + '%'; bar.firstChild.style.background = 'hsl(' + Math.round(pct * 120) + ',72%,46%)'; txt.appendChild(bar);
      txt.appendChild($('div', 'chain-dim', $t('Perbaiki: {0}', [costText(cost.repair)]) + ' · ' + $t('Buat baru: {0}', [costText(cost.make)]) + (cost.alt ? ' ' + $t('(atau {0})', [costText(cost.alt)]) : '')));
      row.appendChild(txt);
      var acts = $('div', 'gt-tool-acts');
      var rb = button($t('Perbaiki'), function () { act({ action: 'repair', tool: k }).then(refreshModal, noop); }, t.uses < t.max && !t.broken ? '' : t.broken ? 'primary' : '');
      rb.disabled = t.uses >= t.max || !canPay(cost.repair);
      var nb = button($t('Buat baru'), function () { act({ action: 'maketool', tool: k }).then(refreshModal, noop); });
      nb.disabled = !(canPay(cost.make) || (cost.alt && canPay(cost.alt)));
      acts.appendChild(rb); acts.appendChild(nb); row.appendChild(acts);
      grid.appendChild(row);
    });
    return wrap;
  }

  /* ---- Night monsters (the server decides; this draws them and runs the fight window) ---- */
  function drawMonster(ctx, kind, px, py, t) {
    var bob = Math.round(Math.sin(t * 6) * 1);
    function R(x, y, w, h, c) { ctx.fillStyle = c; ctx.fillRect(px + x, py + y + bob, w, h); }
    if (kind === 'bat') {
      var flap = Math.sin(t * 14) > 0;
      R(4, 4, 4, 4, '#3a2f4a'); R(5, 5, 1, 1, '#ff5a5a'); R(7, 5, 1, 1, '#ff5a5a');
      if (flap) { R(0, 2, 4, 3, '#2a2236'); R(8, 2, 4, 3, '#2a2236'); } else { R(0, 5, 4, 3, '#2a2236'); R(8, 5, 4, 3, '#2a2236'); }
      return;
    }
    // wild boar
    R(1, 4, 9, 5, '#5a3a24'); R(2, 3, 6, 1, '#6e4a2e'); R(8, 5, 3, 3, '#6e4a2e'); R(11, 6, 1, 2, '#c9a27a');
    R(9, 5, 1, 1, '#ff5a5a'); R(10, 8, 1, 1, '#f0f0e0'); R(2, 9, 1, 2, '#3a2414'); R(7, 9, 1, 2, '#3a2414'); R(0, 5, 1, 1, '#3a2414');
  }
  // Roaming monsters this game hour (same list the server checks), each wandering a little around its spot.
  // Night monsters roam the wild part of the Homeland (open forest and rock chunks); the same shared generator tells
  // the server where they stand, so the fight is checked there. The trade-only public area has none.
  function roamers() {
    var st = S.st, L = GT.world && GT.world.layout, mc = S.cfg && S.cfg.monsters;
    if (!st || !st.night || !st.night.now || st.night.guarded || !L || !mc) return [];
    if (worldNow() === 'public') return mc.publicMonsters && window.GTVillage ? GTVillage.monstersAt(L, st.time.totalHours, mc.roaming) : [];
    return window.GTHomeland && L.lots ? GTHomeland.monstersAt(L, st.time.totalHours, mc.homelandRoaming || mc.roaming) : [];
  }
  function wildAt(L, x, y) {
    var mc = S.cfg && S.cfg.monsters;
    if (!mc || !L) return false;
    if (worldNow() === 'public') return !!mc.publicMonsters && !!window.GTVillage && GTVillage.chunkOf(L, x, y).id === 'hutan';
    return !!(window.GTHomeland && L.lots && GTHomeland.wild(L, x, y));
  }
  function wander(m, t) { var h = 0; for (var i = 0; i < m.id.length; i++) h = (h * 31 + m.id.charCodeAt(i)) | 0; return { dx: Math.sin(t * 0.7 + h) * 0.45, dy: Math.cos(t * 0.5 + h * 1.3) * 0.35 }; }
  /** Where each monster stands this frame (wandering, the one in a fight lunging at the player): the 2.5D view draws
      these as models (GT_CHAIN.monsters, three/monsters.js) and this file then draws nothing for them. */
  function monstersNow() {
    var sc = GT.scene, out = [];
    if (!sc || sc.kind !== 'out') return out;
    var t = performance.now() / 1000, e = S.st && S.st.encounter;
    roamers().forEach(function (m) {
      if (e && e.id === m.id) return;
      var w = wander(m, t);
      out.push({ id: m.id, kind: m.kind, x: m.x + w.dx, y: m.y + w.dy, fx: GT.player.x - m.x, fy: GT.player.y - m.y });
    });
    if (e) {
      var lx = 0, ly = 0, lk = (performance.now() - fightLunge) / 260;
      if (lk >= 0 && lk < 1) { var reach = Math.sin(lk * Math.PI) * 0.5, dxp = GT.player.x - e.x, dyp = GT.player.y - e.y, dl = Math.max(1, Math.abs(dxp) + Math.abs(dyp)); lx = dxp / dl * reach; ly = dyp / dl * reach; }
      out.push({ id: e.id || 'fight', kind: e.kind, x: e.x + lx, y: e.y + ly, fx: GT.player.x - e.x, fy: GT.player.y - e.y, fight: true });
    }
    return out;
  }
  function onDraw(ctx, camX, camY, T) {
    var sc = GT.scene;
    if (!sc || sc.kind !== 'out') return;
    var t = performance.now() / 1000, e = S.st && S.st.encounter;
    if (GT.view3dOn && GT.view3dOn()) { drawWeather(ctx, T, t); return; } // the 2.5D view draws the monsters in 3D
    roamers().forEach(function (m) {
      if (e && e.id === m.id) return;
      var w = wander(m, t);
      var ma = GT.at(m.x + w.dx, m.y + w.dy);
      drawMonster(ctx, m.kind, GT.snap(ma.x), GT.snap(ma.y), t + m.x);
    });
    if (e) {
      var lx = 0, ly = 0, lk = (performance.now() - fightLunge) / 260;
      if (lk >= 0 && lk < 1) { var reach = Math.sin(lk * Math.PI) * 6, dxp = GT.player.x - e.x, dyp = GT.player.y - e.y, dl = Math.max(1, Math.abs(dxp) + Math.abs(dyp)); lx = dxp / dl * reach; ly = dyp / dl * reach; }
      var ea = GT.at(e.x, e.y);
      drawMonster(ctx, e.kind, GT.snap(ea.x + lx), GT.snap(ea.y + ly), t);
    }
    drawWeather(ctx, T, t);
  }

  /* ---- Weather: the same day's weather for everyone (server state, from the shared village file) ---- */
  var flakes = null;
  // ?cuaca=hujan|salju|terik|berawan|cerah previews a look on this screen only (the server's weather is unchanged); localhost only
  var previewWeather = window.GT_DEV_HOST && (/[?&]cuaca=(cerah|berawan|hujan|terik|salju)\b/.exec(location.search) || [])[1] || null;
  function weatherKind() { if (previewWeather) return previewWeather; var w = (S.st && S.st.weather) || S.weather; return w ? w.kind : null; }
  // Winter, snowy weather or the ?musim=dingin preview turns the baked ground white (art.js palette swap)
  // ?musim=semi|panas|gugur|dingin previews a season on this screen only (world and UI class); the server's season is unchanged; localhost only
  var previewSeason = window.GT_DEV_HOST && (/[?&]musim=(semi|panas|gugur|dingin)\b/.exec(location.search) || [])[1] || null;
  function seasonNow() {
    return previewSeason || (S.st && S.st.time && S.st.time.season) || S.season || null;
  }
  function snowOn() {
    return seasonNow() === 'dingin' || weatherKind() === 'salju';
  }
  function applyWeatherClass() {
    var k = weatherKind(), root = document.documentElement;
    var season = seasonNow();
    if (season && GT.setSeason) GT.setSeason(season, snowOn());
    else if (GT.setSnow) GT.setSnow(snowOn());
    ['cerah', 'berawan', 'hujan', 'terik', 'salju'].forEach(function (x) { root.classList.toggle('gt-w-' + x, k === x && (!GT.scene || GT.scene.kind === 'out')); });
  }
  function drawWeather(ctx, T, t) {
    var k = weatherKind();
    // the season's ambient light: one flat fill over the visible world, scaled by daylight (gone at night)
    var amb = GT.ambientLight && GT.ambientLight(), day = GT.daylight ? GT.daylight() : 1, m = amb && /rgba\((\d+),(\d+),(\d+),([\d.]+)\)/.exec(amb);
    if (m && day > 0.01) {
      var sc0 = ctx.getTransform().a || 1;
      ctx.save(); ctx.fillStyle = 'rgba(' + m[1] + ',' + m[2] + ',' + m[3] + ',' + (Math.min(0.12, +m[4]) * day).toFixed(3) + ')';
      ctx.fillRect(0, 0, ctx.canvas.width / sc0, ctx.canvas.height / sc0); ctx.restore();
    }
    if (k !== 'hujan' && k !== 'salju') return;
    var sx = ctx.getTransform().a || 1, W = ctx.canvas.width / sx, H = ctx.canvas.height / sx;
    var calm = document.documentElement.classList.contains('gt-reduced-motion');
    ctx.save();
    if (k === 'hujan') { ctx.fillStyle = 'rgba(40,60,90,0.14)'; ctx.fillRect(0, 0, W, H); } // grey rain light; snow has no tint
    if (!flakes || flakes.k !== k) { flakes = { k: k, p: [] }; for (var i = 0; i < (k === 'hujan' ? 90 : 70); i++) flakes.p.push([Math.random(), Math.random(), 0.6 + Math.random() * 0.8]); }
    flakes.p.forEach(function (f) {
      var speed = calm ? 0 : (k === 'hujan' ? 1.6 : 0.18) * f[2];
      var y = ((f[1] + t * speed) % 1) * H, x = ((f[0] + (k === 'hujan' ? t * speed * 0.25 : Math.sin(t + f[0] * 9) * 0.01)) % 1) * W;
      if (k === 'hujan') { ctx.fillStyle = 'rgba(190,215,255,0.55)'; ctx.fillRect(Math.round(x), Math.round(y), 1, 4); }
      else { ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fillRect(Math.round(x), Math.round(y), f[2] > 1.1 ? 2 : 1, f[2] > 1.1 ? 2 : 1); }
    });
    ctx.restore();
  }
  /* ---- Fighting a night monster: a slim battle bar at the bottom, the fight itself plays out in the world.
   * Lawan: the axe swings at the monster (sparks on a hit, a cut through air on a miss), the monster flashes and the
   * damage rises over it; then the monster lunges back and the energy it costs rises over the player. The server
   * still decides every round; the animation shows what it decided. ---- */
  var fightEl = null, fightLunge = 0;
  function fightOpen() { return !!(fightEl && !fightEl.hidden); }
  function pips(n, max) { var s = ''; for (var i = 0; i < max; i++) s += i < n ? '■' : '□'; return s; }
  function renderFight(e, note) {
    var screen = document.getElementById('screen');
    if (!screen) return;
    if (!fightEl) { fightEl = $('section', 'gt-fight'); fightEl.setAttribute('aria-live', 'polite'); screen.appendChild(fightEl); }
    fightEl.hidden = false;
    document.documentElement.classList.add('gt-fighting');
    fightEl.textContent = '';
    var cfg = S.cfg && S.cfg.monsters || {};
    var top = $('div', 'gt-fight-top');
    var foe = $('div', 'gt-fight-foe');
    foe.appendChild($('b', null, e.name));
    foe.appendChild($('span', 'gt-fight-hp', pips(e.hp, e.maxHp)));
    top.appendChild(foe);
    var me = $('div', 'gt-fight-me');
    var bar = $('span', 'chain-energy'); var fill = $('i'); fill.style.width = Math.round(100 * (S.st ? S.st.energy / S.st.energyMax : 1)) + '%'; bar.appendChild(fill);
    me.appendChild($('span', null, $t('Energimu {0}', [S.st ? S.st.energy : '?'])));
    me.appendChild(bar);
    top.appendChild(me);
    fightEl.appendChild(top);
    fightEl.appendChild($('p', 'gt-fight-note', note || (e.tile ? $t('{0} menghadang dari {1}!', [e.name, e.tile === 'rock' ? $t('celah batu') : $t('balik pohon')]) : $t('{0} menyerang di gelap hutan!', [e.name]))));
    var acts = $('div', 'gt-fight-acts');
    var touch = document.documentElement.classList.contains('gt-phone');
    acts.appendChild(button($t('Lawan{0} · −{1} energi', [touch ? '' : ' (F)', cfg.fightEnergy || 5]), function () { fightStep('fight'); }, 'primary'));
    acts.appendChild(button($t('Lari{0} · −{1}', [touch ? '' : ' (Esc)', cfg.fleeEnergy || 4]), function () { fightStep('flee'); }));
    fightEl.appendChild(acts);
  }
  function closeFight() {
    if (fightEl) fightEl.hidden = true;
    document.documentElement.classList.remove('gt-fighting');
  }
  function openFight() {
    var e = S.st && S.st.encounter;
    if (!e) return;
    if (!fightOpen() && window.GT_FX) { GT_FX.float({ x: e.x, y: e.y }, '!', '#ffd84a'); GT_FX.shake(1); }
    renderFight(e);
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function fightStep(action) {
    if (S.busy) return;
    var e = S.st && S.st.encounter;
    if (!e) return closeFight();
    S.busy = true;
    var FX = window.GT_FX, tile = { x: e.x, y: e.y }, me = { x: GT.player.x, y: GT.player.y };
    var hpBefore = e.hp, energyBefore = S.st.energy;
    if (action === 'fight' && FX) FX.strike(tile, true);
    act({ action: action }, true).then(function (r) {
      var next = r && r.state && r.state.encounter;
      if (action === 'flee') {
        if (FX) FX.float(me, $t('Kabur!'), '#cfd8ff');
        closeFight(); GT.toast(r.toast);
        if (r.ko) knockedOut();
        return;
      }
      var hit = r.won || (next && next.hp < hpBefore);
      return wait(190).then(function () {
        if (FX) {
          if (hit) { FX.flash(tile, 'rgba(255,255,255,0.9)'); FX.float(tile, r.won ? 'KO!' : '-1', '#ffd84a'); FX.shake(2); }
          else FX.float(tile, $t('Meleset!'), '#cfd8ff');
        }
        if (r.won) {
          if (FX) FX.poof(tile);
          closeFight();
          GT.toast(r.toast);
          return;
        }
        if (next) renderFight(next, hit ? $t('Kena! {0} masih melawan.', [next.name]) : $t('Meleset! {0} bersiap menyerang…', [next.name]));
        // the monster's turn
        return wait(380).then(function () {
          fightLunge = performance.now();
          return wait(160);
        }).then(function () {
          var lost = energyBefore - (S.st ? S.st.energy : energyBefore) - ((S.cfg && S.cfg.monsters && S.cfg.monsters.fightEnergy) || 0);
          if (FX) { FX.flash(me, 'rgba(232,80,60,0.6)'); if (lost > 0) FX.float(me, '-' + lost, '#ff8a7a'); FX.shake(3); }
          if (r.ko) { closeFight(); knockedOut(); return; }
          if (next) renderFight(next, $t('{0} menyerang balik{1}. Lawan atau lari?', [next.name, lost > 0 ? $t(' (−{0} energi)', [lost]) : '']));
        });
      });
    }, function () { /* the toast already says why */ }).then(function () { S.busy = false; });
  }
  function knockedOut() {
    var sp = GT.world && GT.world.spawn;
    if (sp && GT.teleportPlayer) GT.teleportPlayer('out', sp.x, sp.y, 'down');
    GT.toast($t('Kamu pingsan. Warga membawamu pulang. Istirahat sampai pukul 06:00.'));
  }

  // which sound an /api/act makes (body.action, plus the answer r); see GT_SFX in mods/sfx.js
  function actSound(body, r) {
    var a = body.action, tile = body.tile;
    if (a === 'gather') return tile === 'tree' ? 'chop' : tile === 'rock' ? 'mine' : tile === 'water' ? 'catch' : 'pickup';
    if (a === 'farm') return body.op === 'plant' ? 'plant' : body.op === 'harvest' ? 'harvest' : 'dig';
    if (a === 'hoe') return 'dig';
    if (a === 'grass') return r && r.gained && Object.keys(r.gained).length ? 'pickup' : 'ui_click'; // a seed found: the pickup chime; an empty search: a soft tap
    if (a === 'craft') return 'craft';
    if (a === 'cook') return 'cook';
    if (a === 'eat') return 'eat';
    if (a === 'sell' || a === 'ship' || a === 'stock') return 'sell';
    if (a === 'mall' || a === 'hire' || a === 'dress' || a === 'casino' || a === 'ride') return 'buy'; // coin spent (the carousel's own music starts with the ride)
    if (a === 'repair' || a === 'maketool') return 'craft';
    if (a === 'toolshop') return 'buy';
    if (a === 'mission') return 'quest_done';
    if (a === 'build' || a === 'assist') return 'build';
    if (a === 'collect') return 'coin';
    if (a === 'fight') return 'hit';
    if (a === 'chips') return body.op === 'buy' ? 'buy' : body.op === 'sell' ? 'sell' : 'ui_click'; // the table plays its own win / lose sound
    if (a === 'gamble') return r && r.win ? 'win' : 'lose';
    if (a === 'travel' || a === 'boat') return 'portal';
    return 'pickup';
  }
  function sfx(n) { try { window.GT_SFX && GT_SFX.play(n); } catch (e) { /* no sound */ } }

  function act(body, quiet) {
    if (S.mode === 'offline') {
      if (body.action === 'gather') { OFF.gather(TILE_ITEM[body.tile]); GT.toast($t('+1 {0} (offline)', [item(TILE_ITEM[body.tile])])); return Promise.resolve(); }
      GT.toast($t('Mode offline hanya mendukung mengumpulkan.')); return Promise.resolve();
    }
    if (!S.account) { GT.toast($t('Masuk dulu (tombol Masuk).')); return Promise.resolve(); }
    body.pos = standPos();
    if (!body.world) body.world = worldNow();
    return api('/act', { method: 'POST', body: body }).then(function (r) {
      S.st = r.state; S.stAt = Date.now(); renderHud(); redraw();
      if (body.action === 'gather' || body.action === 'sell') markGoal(body.action);
      sfx(actSound(body, r));
      if (!quiet) GT.toast(r.toast);
      return r;
    }).catch(function (e) { if (!quiet) sfx('error'); GT.toast(e.message); throw e; });
  }

  /* ------------------------------------------------------------ on-chain player actions (signed delegate -> relayer) */
  function b64(bytes) { var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }

  function signedCall(method, args, extra) {
    return signedCallOnce(method, args, extra).catch(function (e) {
      if (!e || e.code !== 'approve_device') throw e;
      return approveDevice().then(function () { return signedCallOnce(method, args, extra); });
    }).then(function (r) { sfx(/^(buy|purchase)/.test(method) ? 'trade_done' : /^(list_item|send_item)/.test(method) ? 'sell' : 'coin'); return r; }, function (e) { sfx('error'); throw e; });
  }
  function signedCallOnce(method, args, extra) {
    var L = window.NearLib, kp = sessionKey(), ready;
    if (S.mode === 'mock') ready = Promise.resolve({ nonce: BigInt(Date.now()), height: 0n });
    else {
      var prov = new L.JsonRpcProvider({ url: S.cfg.rpcUrl });
      ready = Promise.all([prov.viewAccessKey({ accountId: S.account, publicKey: kp.getPublicKey() }), prov.viewBlock({ finality: 'final' })])
        .then(function (r) { return { nonce: BigInt(r[0].nonce) + 1n, height: BigInt(r[1].header.height) }; }, function (e) {
          // this device's game key is not on the NEAR account yet (a new device, or an account adopted by a fresh
          // database): the same answer the relayer would give, so signedCall runs the device approval
          if (/does not exist|UNKNOWN_ACCESS_KEY/i.test(String(e && (e.type || '') + ' ' + (e.message || e)))) {
            var a = new Error($t('Perangkat ini perlu disetujui dengan NEAR Auth dulu.')); a.code = 'approve_device'; throw a;
          }
          throw e;
        });
    }
    return ready.then(function (x) {
      var da = L.buildDelegateAction({
        senderId: S.account, receiverId: S.cfg.gameContractId,
        actions: [L.actions.functionCall(method, args, L.teraToGas('40'), 0n)],
        nonce: x.nonce, maxBlockHeight: x.height + 100n, publicKey: kp.getPublicKey()
      });
      return crypto.subtle.digest('SHA-256', L.encodeDelegateAction(da)).then(function (h) {
        var sig = kp.sign(new Uint8Array(h));
        var sd = { delegateAction: da, signature: new L.Signature({ keyType: 0, data: sig.signature }) };
        var body = { signedDelegate: b64(L.encodeSignedDelegate(sd)) };
        for (var k in extra || {}) body[k] = extra[k];
        return api('/relay', { method: 'POST', body: body });
      });
    }).then(function (r) {
      if (r && r.status === 'failed') throw new Error($t('Ditolak kontrak: {0}', [r.error || '']));
      return refresh(true).then(function () { return r; });
    });
  }

  /* ------------------------------------------------------------ world: merchants, farm plot */
  function placeMerchants() {
    var w = GT.world, sp = w && w.spawn; if (!sp) return;
    var stalls = (w.market && w.market.stalls) || [];
    MERCHANTS.forEach(function (m, k) {
      if (S.npcs[m.id]) return;
      var st = stalls[k], pos = st ? st.seat : { x: sp.x + m.dx, y: sp.y + m.dy };
      if (st) st.merchant = m.id;
      S.npcs[m.id] = GT.addNpc('out', { x: pos.x, y: pos.y, name: m.id.charAt(0).toUpperCase() + m.id.slice(1), pal: m.pal, dir: 'down',
        key: 'merchant:' + m.id, label: st ? null : m.tag, turns: false, noAffinity: true, lines: [[$t('Mampir ke tokoku!')]] });
    });
  }
  function stallAt(x, y) {
    var w = GT.world, st = w && w.market && w.market.stalls;
    if (!st) return null;
    for (var i = 0; i < st.length; i++) if (st[i].x === x && st[i].y === y) return st[i];
    return null;
  }

  /* ------------------------------------------------------------ villagers who walk somewhere (ambient life) */
  var villagers = [], lifeT = 0;
  var VNAMES = ['Ayu', 'Bayu', 'Citra', 'Dimas', 'Eko', 'Gita'];
  function spawnVillagers() {
    var w = GT.world; if (!w || !w.npcSpawns) return;
    villagers = [];
    var sp = w.spawn, near = w.npcSpawns.filter(function (p) { return Math.abs(p[0] - sp.x) + Math.abs(p[1] - sp.y) < 16; });
    for (var i = 0; i < Math.min(5, near.length); i++) {
      var p = near[(i * 7) % near.length];
      var n = GT.addNpc('out', { x: p[0], y: p[1], name: VNAMES[i % VNAMES.length], pal: 1 + (i % 6), wander: true, leash: 6, key: 'villager:' + i, lines: [[$t('Pasar ramai hari ini!')], [$t('Harga ikan turun lagi, lho.')], [$t('Kebunmu tumbuh bagus!')]] });
      if (n) villagers.push(n);
    }
  }
  function poi() {
    var w = GT.world, pts = [];
    if (w.market) w.market.stalls.forEach(function (st) { pts.push({ x: st.x, y: st.y + 1 }); });
    if (w.farm) pts.push({ x: w.farm.gate.x, y: w.farm.gate.y + 1 });
    pts.push({ x: w.spawn.x + 2, y: w.spawn.y + 1 });
    for (var i = 0; i < 4 && w.npcSpawns && w.npcSpawns.length; i++) { var q = w.npcSpawns[Math.floor(Math.random() * w.npcSpawns.length)]; pts.push({ x: q[0], y: q[1] }); }
    return pts;
  }
  function stepLife(dt) {
    lifeT -= dt; if (lifeT > 0) return; lifeT = 1.5;
    if (!GT.scene || GT.scene.kind !== 'out' || !villagers.length) return;
    var pts = poi();
    villagers.forEach(function (n) {
      if (n.script || n.talking || n.hidden || Math.random() < 0.2) return;
      var dest = pts[Math.floor(Math.random() * pts.length)];
      var path = GT.findPath('out', { x: n.x, y: n.y }, dest);
      if (path && path.length > 1) GT.npcGo(n, path.slice(0, 40), function () { n.home = { x: n.x, y: n.y }; });
    });
    // merchants look around behind their counters
    MERCHANTS.forEach(function (m) { var n = S.npcs[m.id]; if (n && !n.talking && Math.random() < 0.3) n.dir = ['down', 'left', 'right', 'down'][Math.floor(Math.random() * 4)]; });
  }

  function findPlots() {
    var own = GT.world && GT.world.own, sc = GT.getScene('out');
    if (!own || !sc) return;
    if (GT.world.farm && GT.world.farm.plots.length) { S.plots = GT.world.farm.plots.slice(0, (S.cfg && S.cfg.econ.farm && S.cfg.econ.farm.plots) || 15); return; }
    var m = sc.map, out = [], sp = GT.world.spawn;
    for (var r = 1; r <= 5 && out.length < 6; r++) {
      for (var y = own.y - r; y <= own.y + 2 + r && out.length < 6; y++) {
        for (var x = own.x - r; x <= own.x + 2 + r && out.length < 6; x++) {
          if (x < 1 || y < 1 || x >= m.w - 1 || y >= m.h - 1) continue;
          var i = y * m.w + x;
          if (m.tiles[i] !== 'grass' || m.walk[i] !== 1 || m.door.get(i) || m.bld.get(i)) continue;
          if (sp && Math.abs(x - sp.x) <= 1 && Math.abs(y - sp.y) <= 1) continue;
          if (out.some(function (p) { return p.x === x && p.y === y; })) continue;
          out.push({ x: x, y: y });
        }
      }
    }
    S.plots = out;
  }

  function plotAt(x, y) { for (var i = 0; i < S.plots.length; i++) if (S.plots[i].x === x && S.plots[i].y === y) return i; return -1; }

  /* Wheat grows in real time: the server sends how old the crop was (ageMs) and how long it takes (growMs) when it
     answered; we add the time since then, so the stages move smoothly between polls. 7 growing stages, then ripe (gold). */
  var WHEAT_STAGES = 7;
  function plotLook(p) {
    if (p.state !== 'planted' && p.state !== 'ready') return null;
    var el = (p.ageMs || 0) + (Date.now() - (S.stAt || Date.now())), ripe = p.state === 'ready' || el >= p.growMs + 400;
    return { ripe: ripe, prog: ripe ? 1 : Math.min(0.999, el / p.growMs), stage: ripe ? WHEAT_STAGES : Math.min(WHEAT_STAGES - 1, Math.floor(el / p.growMs * WHEAT_STAGES)) };
  }

  var pendingPlant = null;
  function farm(idx) {
    var p = S.st && S.st.plots[idx];
    if (!p) { GT.toast($t('Masuk dulu untuk bertani.')); return; }
    var look = plotLook(p);
    if (look && !look.ripe) { GT.toast($t('Gandumnya masih tumbuh ({0}%). Tunggu sampai kuning.', [Math.floor(look.prog * 100)])); return; }
    var op = p.state === 'empty' ? 'till' : p.state === 'tilled' ? 'plant' : 'harvest';
    // Planting spends 1 Gandum, so it needs a second press within 2 seconds.
    if (op === 'plant' && !(pendingPlant && pendingPlant.idx === idx && Date.now() - pendingPlant.t < 2000)) {
      pendingPlant = { idx: idx, t: Date.now() };
      GT.toast($t('Tekan {0} sekali lagi untuk menanam {1}', [keyLabel(), have('wheat') > 0 ? $t('(pakai 1 Gandum).') : $t('(Gandummu habis: desa memberi benih gratis, 3 per hari).')]));
      return;
    }
    pendingPlant = null;
    act({ action: 'farm', op: op, plot: idx });
  }

  /* ------------------------------------------------------------ context hint: which key does what here */
  function keyLabel() {
    // on a phone (or any touch screen) the interact control is the A button
    if (document.documentElement.classList.contains('gt-phone')) return $t('tombol aksi'); // the round action button: phones have no A key any more
    if (window.matchMedia('(pointer: coarse)').matches) return 'A';
    return window.GT_SETTINGS ? GT_SETTINGS.label('talk').split(' / ')[0] : 'F';
  }
  var DIRV = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
  var hintEl = null, hintT = 0;
  function hintFor() {
    var sc = GT.scene, pl = GT.player; if (!sc || !pl) return null;
    var d = DIRV[pl.dir]; if (!d) return null;
    var x = pl.x + d[0], y = pl.y + d[1], m = sc.map;
    if (x < 0 || y < 0 || x >= m.w || y >= m.h) return null;
    var npc = (sc.npcs || []).filter(function (n) { return !n.hidden && n.x === x && n.y === y; })[0];
    if (npc && npc.key && npc.key.indexOf('merchant:') === 0) return $t('Buka toko {0}', [npc.name]);
    if (npc) return $t('Bicara dengan {0}', [npc.name]);
    var tt = m.tiles[y * m.w + x];
    if (tt === 'stall') { var st1 = stallAt(x, y); if (st1 && st1.merchant) return $t('Belanja di lapak {0}{1}', [st1.merchant.charAt(0).toUpperCase(), st1.merchant.slice(1)]); }
    if (sc.house && sc.house.own && tt === 'table') return $t('Meja Kerja (crafting)');
    if (sc.house && sc.house.own && tt === 'chest') return $t('Kotak Kirim');
    if (sc.house && !sc.house.own && tt === 'chest') return $t('Peti tetangga (terkunci)');
    if (sc.kind !== 'out') return null;
    var pi = plotAt(x, y);
    if (pi >= 0) {
      var p = S.st && S.st.plots[pi]; if (!p) return $t('Petak kebun (masuk dulu)');
      var own = p.planter_name ? ' · ' + $t('milik {0}', p.planter_name) : '';
      if (p.state === 'empty') return $t('Cangkul (−2 energi)');
      if (p.state === 'tilled') return have('wheat') > 0 ? $t('Tanam gandum (1 Gandum, tekan 2x)') : $t('Tanam (benih gratis dari desa, tekan 2x)');
      var lk = plotLook(p);
      if (lk && lk.ripe) return $t('Panen gandum') + own;
      return $t('Gandum tumbuh ({0}%)', [Math.floor(lk.prog * 100)]) + own;
    }
    var tok = TILE_ITEM[tt];
    if (tok) {
      var verb = { fish: $t('Mancing'), ore: $t('Nambang'), wood: $t('Tebang') }[tok];
      var needTool = tok === 'ore' && S.st && (S.st.bag.tool.settled + S.st.bag.tool.today) < 1;
      var L = GT.world && GT.world.layout, night = S.st && S.st.night;
      var danger = tok !== 'fish' && night && night.now && !night.guarded && wildAt(L, x, y);
      var spot = tok === 'fish' && window.GT_FISH && GT_FISH.isSpot(x, y);
      if (tok === 'fish') return spot ? $t('Mancing di riak air: ikan berkumpul di sini') : $t('Tidak ada ikan di sini: cari air yang beriak');
      return $t('{0} (−4 energi){1}{2}', [verb, needTool ? $t(' · butuh Beliung') : '', danger ? $t(' · malam: awas monster') : '']);
    }
    return null;
  }
  var lastAggro = '';
  function aggro() {
    if (S.busy || !S.st || S.st.encounter || GT.isUiOpen() || !GT.scene || GT.scene.kind !== 'out') return;
    var p = GT.player, hour = S.st.time.totalHours;
    var m = roamers().filter(function (q) { return Math.abs(q.x - p.x) + Math.abs(q.y - p.y) <= 1; })[0];
    if (!m || lastAggro === m.id + '@' + hour) return;
    lastAggro = m.id + '@' + hour;
    S.busy = true;
    act({ action: 'engage', monster: m.id }).then(function () { if (S.st && S.st.encounter) openFight(); }, noop).then(function () { S.busy = false; });
  }
  function onFrame(dt) {
    aggro();
    applyWeatherClass();
    stepLife(dt || 0);
    var now = Date.now(); if (now - hintT < 150) return; hintT = now;
    if (!hintEl) { var scr = document.getElementById('screen'); if (!scr) return; hintEl = $('div'); hintEl.id = 'gt-hint'; hintEl.setAttribute('aria-live', 'polite'); scr.appendChild(hintEl); }
    var h = (GT.isUiOpen && GT.isUiOpen()) ? null : hintFor();
    if (!h) { hintEl.className = ''; return; }
    var txt = keyLabel() + '|' + h;
    if (hintEl._t !== txt) { hintEl._t = txt; hintEl.textContent = ''; var b = $('b', null, keyLabel()); hintEl.appendChild(b); hintEl.appendChild(document.createTextNode(' ' + h)); }
    hintEl.className = 'on';
  }

  // Crops are drawn in the ground pass (onDrawGround), so characters walk in front of them.
  function onDrawGround(ctx, camX, camY, T) {
    if (!GT.scene || GT.scene.kind !== 'out' || !S.plots.length || !S.st) return;
    var vw = ctx.canvas.width, vh = ctx.canvas.height;
    S.plots.forEach(function (pp, i) {
      var p = S.st.plots[i]; if (!p) return;
      var x = pp.x * T - camX, y = pp.y * T - camY;
      if (x < -T || y < -T || x > vw || y > vh) return;
      // an empty plot: the soil stays as it is, four light corner marks say "a plot, till me"
      if (p.state === 'empty') { ctx.fillStyle = 'rgba(240,214,160,.85)'; [[1, 1], [T - 4, 1], [1, T - 2], [T - 4, T - 2]].forEach(function (c) { ctx.fillRect(x + c[0], y + c[1], 3, 1); }); [[1, 2], [T - 2, 2], [1, T - 4], [T - 2, T - 4]].forEach(function (c) { ctx.fillRect(x + c[0], y + c[1], 1, 2); }); return; }
      var lk = plotLook(p); if (!lk) return;
      var u = T / 12, st = lk.stage, now = performance.now();
      // the same stalks in both views (the 2.5D ground sheet redraws this ~8 times a second): green sprouts, taller
      // and yellower each stage, ripe = tall and golden with a grain head. The tops sway in the wind.
      var h = lk.ripe ? 10 * u : (1.5 + st * 1.2) * u;
      var body = lk.ripe ? '#c99a2e' : st < 4 ? '#3f9a3c' : st < 6 ? '#7aae35' : '#b2b432';
      var tip = lk.ripe ? '#f2d24a' : st < 4 ? '#7cc23e' : st < 6 ? '#a8d44a' : '#d6c940';
      var cols = [2, 5, 8, 10.5];
      for (var k = 0; k < cols.length; k++) {
        if (st === 0 && k % 2) continue; // the youngest stage: just two sprouts
        var hk = Math.max(1, Math.round(h - (k % 2 ? 1 : 0) * u)), bx = Math.round(x + cols[k] * u), by = y + T - Math.round(1.5 * u);
        var sw = Math.round(Math.sin(now / 420 + (pp.x * 7 + pp.y * 13 + k * 2.1)) * (st === 0 ? 0 : st < 4 ? 0.6 : 1.1) * u);
        var low = Math.max(1, Math.floor(hk / 2)), top = hk - low, w = Math.max(1, Math.round(u));
        ctx.fillStyle = body; ctx.fillRect(bx, by - low, w, low);
        ctx.fillRect(bx + Math.round(sw / 2), by - low - Math.floor(top / 2), w, Math.floor(top / 2));
        ctx.fillStyle = tip; ctx.fillRect(bx + sw, by - hk, w, Math.max(1, top - Math.floor(top / 2)));
        if (lk.ripe) { ctx.fillStyle = '#f7e27a'; ctx.fillRect(bx + sw - (w > 1 ? 1 : 0), by - hk - Math.round(u), w + (w > 1 ? 2 : 1), Math.max(1, Math.round(1.5 * u))); }
        else if (st >= 2) { ctx.fillStyle = tip; ctx.fillRect(bx + sw - 1, by - hk + 1, 1, 1); ctx.fillRect(bx + sw + w, by - hk + 1, 1, 1); } // leaves
      }
    });
  }

  /* ------------------------------------------------------------ modals */
  function reasonLine(it) {
    var arrow = it.changePct > 0 ? '▲' : it.changePct < 0 ? '▼' : '•';
    var r = $('div', 'chain-reason', arrow + ' ' + it.reason);
    return r;
  }

  /* ---- item cards (icon, name, price): one look for the shop, the bag and the market ---- */
  function itemCard(token, line1, line2, opts) {
    opts = opts || {};
    var b = $('button', 'gt-card' + (opts.off ? ' off' : '') + (opts.sel ? ' sel' : '') + (opts.accent ? ' accent' : '')); b.type = 'button';
    if (window.GT_ITEMS && token !== 'coin') b.appendChild(GT_ITEMS.icon(token, 32)); else b.appendChild($('span', 'gt-card-coin'));
    if (opts.count != null) b.appendChild($('span', 'gt-card-n', String(opts.count)));
    b.appendChild($('span', 'gt-card-name', item(token)));
    if (line1) b.appendChild($('span', 'gt-card-l1', line1));
    if (line2) b.appendChild($('span', 'gt-card-l2', line2));
    if (opts.title) b.title = opts.title;
    if (opts.onClick) b.addEventListener('click', function (e) { e.currentTarget.blur(); opts.onClick(e); });
    if (opts.onRight) b.addEventListener('contextmenu', function (e) { e.preventDefault(); opts.onRight(e); });
    return b;
  }
  function have(token) { var b = S.st && S.st.bag[token]; return b ? b.settled + b.today : 0; }
  function arrow(it) { return it.changePct > 0 ? ' ▲' : it.changePct < 0 ? ' ▼' : ''; }

  // A merchant's window, the way a farming game's shop works: what they sell on top, your own bag below with what
  // they pay for each item (greyed when they don't buy it). Click = 1, Shift-click = 5, right-click = all you have.
  function shopBody(id) {
    var wrap = $('div', 'gt-shop');
    var m = (S.market || []).filter(function (x) { return x.id === id; })[0];
    if (!m) { wrap.appendChild($('p', null, $t('Memuat…'))); return wrap; }
    var head = $('div', 'gt-shop-head');
    head.appendChild($('span', null, $t('Koinmu {0}', [have('coin')])));
    head.appendChild($('span', 'chain-dim', m.rent ? $t('Kas {0} {1} · sewa {2}/hari', [m.name, m.cash, m.rent]) : $t('Kas {0} {1}', [m.name, m.cash])));
    wrap.appendChild(head);
    if (!m.open) return restoreBody(id, m, wrap);
    // the tool merchant has two tabs: buying and selling goods, and the tool repairs / new tools
    if (hasToolStall(id)) {
      var tabOf = S.shopTab || (S.shopTab = {}), cur = tabOf[id] || 'trade';
      var tabs = $('div', 'gt-mall-tabs'); tabs.setAttribute('role', 'tablist');
      [['trade', '🛒 ' + $t('Jual-beli')], ['tools', '🔧 ' + $t('Perbaikan')]].forEach(function (t) {
        var b = $('button', 'gt-mall-tab' + (cur === t[0] ? ' on' : ''), t[1]); b.type = 'button'; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(cur === t[0]));
        b.addEventListener('click', function () { if (tabOf[id] === t[0]) return; tabOf[id] = t[0]; redraw(); });
        tabs.appendChild(b);
      });
      wrap.appendChild(tabs);
      if (cur === 'tools') { toolStallRows(id, m, wrap); return wrap; }
    }
    var sel = S.shopSel && S.shopSel.id === id ? S.shopSel.token : null;
    function pick(token) { S.shopSel = { id: id, token: token }; }
    function trade(kind, token, qty) { pick(token); if (qty > 0) act({ action: kind, merchant: id, token: token, qty: qty }).then(refreshModal, refreshModal); }
    var sells = m.items.filter(function (it) { return it.ask != null; });
    if (sells.length) {
      wrap.appendChild($('h4', 'chain-h', $t('Dijual {0}', [m.name])));
      var g1 = $('div', 'gt-grid');
      sells.forEach(function (it) {
        g1.appendChild(itemCard(it.token, $t('{0} koin{1}', [it.ask, arrow(it)]), $t('stok {0}', [it.stock]), {
          sel: sel === it.token, off: have('coin') < it.ask, title: it.reason,
          onClick: function (e) { trade('buy', it.token, e.shiftKey ? 5 : 1); }
        }));
      });
      wrap.appendChild(g1);
    }
    wrap.appendChild($('h4', 'chain-h', $t('Barangmu · jual ke {0}', [m.name])));
    var g2 = $('div', 'gt-grid'), byToken = {};
    m.items.forEach(function (it) { byToken[it.token] = it; });
    (window.GT_ITEMS ? GT_ITEMS.SLOTS : Object.keys(S.cfg.econ.items).filter(function (t) { return t !== 'coin'; })).forEach(function (t) {
      var it = byToken[t], n = have(t), buys = it && it.bid != null;
      g2.appendChild(itemCard(t, buys ? $t('dapat {0}{1}', [it.bid, arrow(it)]) : $t('tidak dibeli'), null, {
        count: n, off: !buys || n <= 0, sel: sel === t, accent: buys && n > 0, title: buys ? it.reason : $t('{0} tidak membeli {1}', [m.name, item(t)]),
        onClick: function (e) { if (buys) trade('sell', t, Math.min(n, e.shiftKey ? 5 : 1)); else { pick(t); redraw(); } },
        onRight: function () { if (buys) trade('sell', t, Math.min(n, 10)); }
      }));
    });
    wrap.appendChild(g2);
    // the merchant's reason for the item you last touched (prices move every game hour)
    var focus = sel && byToken[sel], touch = document.documentElement.classList.contains('gt-phone');
    var why = $('div', 'gt-shop-why');
    why.appendChild($('p', null, focus ? item(sel) + ': ' + focus.reason : touch ? $t('Ketuk barang untuk jual atau beli 1. Harga berubah tiap jam game.') : $t('Klik untuk 1, Shift+klik untuk 5, klik kanan untuk jual semua. Harga berubah tiap jam game.')));
    var left = focus && focus.bid != null ? Math.min(have(sel), 10) : 0; // the server takes at most 10 per trade
    if (left > 1) why.appendChild(button($t('Jual {0} {1} (sekitar {2} koin)', [left, item(sel), left * focus.bid]), function () { trade('sell', sel, left); }, 'gt-data'));
    wrap.appendChild(why);
    holdingLine(id, wrap);
    if (S.account) wrap.appendChild(button($t('Ngobrol dengan {0}', [m.name]), function () { talkTo(id, m.name); }));
    return wrap;
  }

  // The tool stall inside one merchant's shop (economy/config.json `toolShop`): a new tool or a repair for coin, paid to that merchant.
  // A repair costs less the less worn the tool is (the same arithmetic as the server's Extras.toolStall).
  function hasToolStall(id) { var ts = S.cfg && S.cfg.econ && S.cfg.econ.toolShop; return !!(ts && ts.merchant === id && S.cfg.econ.tools && S.st && S.st.tools); }
  function toolStallRows(id, m, wrap) {
    var ts = S.cfg && S.cfg.econ && S.cfg.econ.toolShop;
    if (!hasToolStall(id)) return;
    wrap.appendChild($('p', 'chain-dim', $t('Perbaiki alatmu atau beli yang baru di {0}. Makin aus alatnya, makin mahal perbaikannya.', [m.name])));
    var grid = $('div', 'gt-tool-grid'); wrap.appendChild(grid);
    TOOL_ORDER.forEach(function (k) {
      var t = S.st.tools[k]; if (!t || !ts.price[k]) return;
      var row = $('div', 'gt-tool gt-tool-card' + (t.broken ? ' broken' : ''));
      if (window.GT_ITEMS) row.appendChild(GT_ITEMS.icon(TOOL_ICON[k], 40));
      var txt = $('div', 'grow'), full = t.uses >= t.max;
      var fix = Math.max(1, Math.ceil(ts.repair[k] * (t.max - t.uses) / t.max)), coins = have('coin');
      txt.appendChild($('b', null, toolName(k) + ' · ' + t.uses + '/' + t.max + (t.broken ? ' · ' + $t('rusak') : '')));
      var pct = Math.max(0, Math.min(1, t.uses / Math.max(1, t.max))), bar = $('div', 'gt-dur'); bar.appendChild($('i'));
      bar.firstChild.style.width = Math.round(pct * 100) + '%'; bar.firstChild.style.background = 'hsl(' + Math.round(pct * 120) + ',72%,46%)'; txt.appendChild(bar);
      txt.appendChild($('div', 'chain-dim', full ? $t('Seperti baru.') : $t('Biaya perbaikan: {0} koin', [fix])));
      txt.appendChild($('div', 'chain-dim', $t('Harga alat baru: {0} koin', [ts.price[k]])));
      row.appendChild(txt);
      var acts = $('div', 'gt-tool-acts');
      var rb = button($t('Perbaiki'), function () { act({ action: 'toolshop', op: 'repair', tool: k }).then(refreshModal, refreshModal); }, t.broken ? 'primary' : '');
      rb.disabled = full || coins < fix;
      var nb = button($t('Beli baru'), function () { act({ action: 'toolshop', op: 'buy', tool: k }).then(refreshModal, refreshModal); });
      nb.disabled = full || coins < ts.price[k];
      acts.appendChild(rb); acts.appendChild(nb); row.appendChild(acts);
      wrap.appendChild(row);
    });
  }

  // Ask a merchant something. The answer uses the shop's real prices (NEAR AI Cloud when the server has a key,
  // otherwise a line built from the same facts). Chat never moves items or coins.
  function talkTo(id, name) {
    var body = $('div'), log = $('div', 'chain-talk');
    function add(who, text, cls) { var p = $('p', cls || null); p.appendChild($('b', null, who + ': ')); p.appendChild(document.createTextNode(text)); log.appendChild(p); log.scrollTop = log.scrollHeight; }
    add(name, $t('Halo! Mau tanya apa? Harga, stok, atau kenapa harga berubah?'));
    var input = $('input'); input.type = 'text'; input.maxLength = 200; input.placeholder = $t('mis. "kenapa harga ikan turun?"');
    body.appendChild(log); body.appendChild(input);
    var prov = S.cfg && S.cfg.dialogue;
    body.appendChild($('p', 'chain-dim', prov === 'nearai' ? $t('Jawaban dari NEAR AI Cloud (inferensi privat) berdasarkan harga asli toko. Obrolan tidak bisa memindahkan barang atau koin.')
      : prov === 'anthropic' ? $t('Jawaban dari Claude berdasarkan harga asli toko. Obrolan tidak bisa memindahkan barang atau koin.')
      : $t('Jawaban disusun dari harga asli toko. (AI belum aktif di server ini.)')));
    var waiting = false;
    function ask() {
      var t = String(input.value || '').trim();
      if (!t || waiting) return;
      input.value = ''; add($t('Kamu'), t, 'me'); waiting = true;
      var dots = $('p', 'chain-dim', $t('{0} sedang berpikir…', [name])); log.appendChild(dots);
      api('/talk', { method: 'POST', body: { merchant: id, text: t } }).then(function (r) {
        add(name, r.line, r.source === 'nearai' ? 'ai' : null);
      }, function (e) { add(name, e.message); }).then(function () { waiting = false; if (dots.parentNode) dots.parentNode.removeChild(dots); input.focus(); });
    }
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); ask(); } });
    GT.modal({ title: $t('Ngobrol: {0}', [name]), body: body, actions: [{ label: $t('Tanya'), primary: true, onClick: function () { ask(); return false; } }] });
    setTimeout(function () { input.focus(); }, 50);
  }

  function holdingLine(id, wrap) {
    var s = (S.shops || []).filter(function (x) { return x.id === id; })[0];
    if (!s || !s.holding || s.holding.shares === '0') return;
    var p = $('p', 'chain-dim', $t('Sahammu: {0} dari {1} · dividen siap diambil: {2} koin', [s.holding.shares, s.holding.total_shares, s.holding.claimable]));
    wrap.appendChild(p);
    if (s.holding.claimable !== '0') wrap.appendChild(button($t('Ambil dividen{0}', [oc()]), function () {
      GT.toast($t('Mengambil dividen…'));
      signedCall('claim_dividends', { merchant: s.account_id }).then(function () { GT.toast($t('Dividen masuk!')); refreshModal(); }, function (e) { GT.toast(e.message); });
    }, 'primary'));
  }

  var WHERE = { fish: $t('🎣 mancing'), wood: $t('🪓 tebang pohon'), ore: $t('⛏️ nambang (butuh Beliung)'), wheat: $t('🌱 tanam di kebun'), bread: $t('🔨 2 Gandum di Meja Kerja'), meal: $t('🔨 Ikan + Kayu di Meja Kerja'), tool: $t('🔨 2 Bijih + Kayu di Meja Kerja'), coin: $t('🪙 jual ke pedagang') };
  function restoreBody(id, m, wrap) {
    var s = (S.shops || []).filter(function (x) { return x.id === id; })[0];
    // short: one line why, one line what to do, then one compact row per good (icon, progress bar, what is missing)
    wrap.appendChild($('p', 'chain-closed', '🔒 ' + $t('Tutup: {0} tak sanggup bayar sewa.', [m.name])));
    if (!s) { wrap.appendChild($('p', null, $t('Memuat papan pemulihan…'))); return wrap; }
    wrap.appendChild($('p', 'chain-dim', $t('Lengkapi semuanya untuk membuka toko lagi. Penyumbang dapat saham.') + (s.contributors ? ' · ' + $t('{0} penyumbang', [s.contributors]) : '')));
    var lines = [], allDone = true;
    s.need.forEach(function (n) {
      var got = 0; (s.pledged || []).forEach(function (p) { if (p.token_id === n.token_id) got = +p.amount; });
      var missing = Math.max(0, +n.amount - got), have = spendable(n.token_id);
      var row = $('div', 'mrow chain-item chain-need' + (missing === 0 ? ' done' : ''));
      var ic = n.token_id === 'coin' || !window.GT_ITEMS ? $('span', 'chain-need-ic', '🪙') : GT_ITEMS.icon(n.token_id, 20);
      ic.setAttribute('aria-hidden', 'true'); row.appendChild(ic);
      var info = $('div', 'grow');
      info.appendChild($('b', null, item(n.token_id) + ' ' + got + '/' + n.amount));
      var bar = $('div', 'chain-need-bar'), fill = $('i'); fill.style.width = Math.round(100 * Math.min(1, got / Math.max(1, +n.amount))) + '%'; bar.appendChild(fill); info.appendChild(bar);
      if (missing > 0) {
        allDone = false;
        info.appendChild($('div', 'num', $t('kurang {0} · punya {1}', [missing, have]) + (have < missing && WHERE[n.token_id] ? ' · ' + WHERE[n.token_id] : '')));
      }
      row.appendChild(info);
      if (missing === 0) row.appendChild($('span', 'chain-done', '✓'));
      wrap.appendChild(row);
      if (missing > 0 && have > 0) lines.push({ token_id: n.token_id, amount: String(Math.min(missing, have)) });
    });
    if (lines.length) {
      var label = $t('Sumbang {0}{1}', [lines.map(function (l) { return l.amount + ' ' + item(l.token_id); }).join(' + '), oc()]);
      wrap.appendChild(button(label, function () {
        GT.toast($t('Mengirim sumbangan…'));
        signedCall('restore_contribute', { merchant: s.account_id, contribution: lines })
          .then(function () { GT.toast(chainUI() ? $t('Terima kasih! Sumbanganmu tercatat on-chain.') : $t('Terima kasih! Sumbanganmu tercatat.')); refreshModal(); }, function (e) { GT.toast(e.message); });
      }, 'primary'));
    } else if (!allDone) {
      wrap.appendChild($('p', 'chain-dim', $t('Belum punya barangnya. Barang hari ini bisa disumbang setelah 06:00.')));
    }
    return wrap;
  }

  /* ---- Papan Proyek Desa (Balai Desa): pooled goods and coin build things that open new areas (on-chain) ---- */
  function spendable(t) { var b = S.st && S.st.bag[t]; return b ? Math.max(0, Math.min(b.settled, b.settled + b.today)) : 0; }
  function projectBody() {
    var wrap = $('div');
    wrap.appendChild($('p', null, $t('Patungan bahan dengan warga lain. Kalau semua baris terpenuhi, bagian peta baru terbuka untuk semua{0}', [chainUI() ? $t(' (bahannya dibakar on-chain).') : '.'])));
    if (!S.projects) { wrap.appendChild($('p', null, $t('Memuat…'))); return wrap; }
    if (!S.projects.length) wrap.appendChild($('p', 'chain-dim', $t('Belum ada proyek.')));
    S.projects.forEach(function (pj) {
      wrap.appendChild($('h4', 'chain-h', pj.name + (pj.done ? $t(' (selesai)') : pj.retired ? $t(' (dihentikan)') : '')));
      if (pj.retired && !pj.done) {
        // stopped: no new pledges; whoever pledged can take it back
        wrap.appendChild($('p', 'chain-dim', pj.retired));
        var pledged = pj.contributors.filter(function (c) { return c.account_id === S.account; })[0];
        if (pledged) wrap.appendChild(button($t('Tarik sumbanganku'), function () {
          signedCall('project_withdraw', { id: pj.id }).then(function () { GT.toast($t('Sumbangan dikembalikan ke tasmu.')); refreshModal(); }, function (e) { GT.toast(e.message); });
        }));
        return;
      }
      var lines = [];
      pj.need.forEach(function (n) {
        var got = 0; pj.pledged.forEach(function (p) { if (p.token_id === n.token_id) got = +p.amount; });
        var missing = Math.max(0, +n.amount - got), have = spendable(n.token_id);
        var row = $('div', 'mrow');
        row.appendChild($('span', 'grow', item(n.token_id) + ': ' + got + '/' + n.amount));
        if (!pj.done) row.appendChild($('span', 'num', $t('bisa kamu sumbang {0}', [Math.min(missing, have)])));
        wrap.appendChild(row);
        if (!pj.done && missing > 0 && have > 0) lines.push({ token_id: n.token_id, amount: String(Math.min(missing, have)) });
      });
      var names = pj.contributors.map(function (c) { return c.account_id === S.account ? $t('kamu') : String(c.account_id).split('.')[0]; });
      wrap.appendChild($('p', 'chain-dim', pj.done ? $t('Dibangun oleh {0}.', [names.join(', ')]) : (names.length ? $t('Penyumbang: {0}.', [names.join(', ')]) : $t('Belum ada penyumbang. Jadilah yang pertama!'))));
      if (pj.done) return;
      var mine = pj.contributors.filter(function (c) { return c.account_id === S.account; })[0];
      if (lines.length) wrap.appendChild(button($t('Sumbang semua yang bisa{0}', [oc()]), function () {
        GT.toast($t('Mengirim sumbangan…'));
        signedCall('project_contribute', { id: pj.id, contribution: lines }).then(function () { GT.toast(chainUI() ? $t('Terima kasih! Sumbanganmu tercatat on-chain.') : $t('Terima kasih! Sumbanganmu tercatat.')); refreshModal(); }, function (e) { GT.toast(e.message); });
      }, 'primary'));
      if (mine) wrap.appendChild(button($t('Tarik sumbanganku'), function () {
        signedCall('project_withdraw', { id: pj.id }).then(function () { GT.toast($t('Sumbangan dikembalikan ke tasmu.')); refreshModal(); }, function (e) { GT.toast(e.message); });
      }));
    });
    wrap.appendChild($('p', 'chain-dim', $t('Pakai barang yang sudah tersimpan (lewat 06:00). Bisa ditarik lagi selama proyek belum selesai.')));
    return wrap;
  }

  // Tas: every item as a card (the same icons as the hotbar). Click one to see what it is for and what you can do
  // with it; the panel under the grid holds the actions, so the grid itself stays calm.
  function bagBody() {
    var wrap = $('div', 'gt-bag');
    if (S.mode === 'offline') {
      var d = OFF.load();
      Object.keys(d.bal).forEach(function (t) { var r = $('div', 'mrow'); r.appendChild($('span', 'grow', item(t))); r.appendChild($('span', 'num', String(d.bal[t]))); wrap.appendChild(r); });
      return wrap;
    }
    if (!S.st) { wrap.appendChild($('p', null, $t('Memuat…'))); return wrap; }
    var coin = S.st.bag.coin || { settled: 0, today: 0 };
    var head = $('div', 'gt-shop-head');
    head.appendChild($('span', null, $t('Koin {0}{1}', [coin.settled + coin.today, coin.today ? $t(' ({0}{1} hari ini)', [coin.today > 0 ? '+' : '', coin.today]) : ''])));
    if (S.st.tools) {
      var wornOut = TOOL_ORDER.filter(function (k) { return S.st.tools[k] && S.st.tools[k].broken; }).length;
      var tb = button(wornOut ? $t('Alat · {0} rusak', [wornOut]) : $t('Alat'), function () { open('tools'); }, wornOut ? 'primary' : '');
      head.appendChild(tb);
    } else head.appendChild($('span', 'chain-dim', $t('Beliung {0}/{1} pemakaian', [S.st.tool.uses, S.st.tool.durability])));
    wrap.appendChild(head);
    var slots = window.GT_ITEMS ? GT_ITEMS.SLOTS : Object.keys(S.st.bag).filter(function (t) { return t !== 'coin'; });
    var inHand = window.GT_ITEMS && GT_ITEMS.held();
    // the hoe and the rod are in the hand but not in the bag: then the first item is shown, not an empty "hoe · 0"
    var sel = S.bagSel && slots.indexOf(S.bagSel) >= 0 ? S.bagSel : inHand && slots.indexOf(inHand) >= 0 ? inHand : slots[0];
    var grid = $('div', 'gt-grid');
    slots.forEach(function (t) {
      var b = S.st.bag[t] || { settled: 0, today: 0 }, n = b.settled + b.today;
      grid.appendChild(itemCard(t, b.today ? $t('{0} hari ini', [(b.today > 0 ? '+' : '') + b.today]) : null, t === inHand ? $t('di tangan') : null, {
        count: n, off: n <= 0, sel: t === sel,
        onClick: function () { S.bagSel = t; redraw(); },
        onRight: function () { if (window.GT_ITEMS) { GT_ITEMS.hold(t); S.bagSel = t; redraw(); } }
      }));
    });
    wrap.appendChild(grid);
    wrap.appendChild(bagDetail(sel));
    wrap.appendChild($('p', 'chain-dim', $t('{0}Barang "hari ini" tersimpan permanen pukul 06:00{1}', [document.documentElement.classList.contains('gt-phone') ? $t('Ketuk barang untuk melihat, lalu Pegang. ') : $t('Klik untuk melihat, klik kanan untuk memegang. '), chainUI() ? $t(' (di NEAR).') : '.'])));
    if (S.account) wrap.appendChild($('p', 'chain-dim', $t('Akun: {0}', [S.account])));
    var more = $t('Semua riwayat');
    wrap.appendChild(button(more, function () { open('history'); }));
    if (S.st.missions) wrap.appendChild(button($t('Misi'), function () { open('missions'); }));
    return wrap;
  }
  var USE = {
    fish: $t('Mentah, tidak bisa dimakan. Masak jadi Ikan Bakar di Meja Kerja (Ikan + Kayu), atau jual.'),
    wood: $t('Bahan Ikan Bakar dan Beliung, dan dibutuhkan proyek desa.'), ore: $t('Bahan Beliung, dan dibutuhkan proyek desa.'),
    wheat: $t('Pegang lalu klik kanan petak kebun untuk menanam, atau buat Roti (2 Gandum).'),
    tool: $t('Dipakai otomatis saat menambang batu.')
  };
  function bagDetail(t) {
    var box = $('div', 'gt-detail'), b = S.st.bag[t] || { settled: 0, today: 0 }, n = b.settled + b.today;
    var e = S.cfg.econ.items[t] || {}, can = spendable(t), bb = bestBid(t);
    var top = $('div', 'gt-detail-top');
    if (window.GT_ITEMS) top.appendChild(GT_ITEMS.icon(t, 40));
    var txt = $('div', 'grow');
    txt.appendChild($('div', 'gt-detail-name', item(t) + ' · ' + n));
    txt.appendChild($('div', null, e.energy ? $t('Makanan: +{0} energi.', [e.energy]) : (USE[t] || '')));
    txt.appendChild($('div', 'chain-dim', n > 0 ? $t('Tercatat {0}{1} · bisa dikirim/dijual ke pemain {2}', [b.settled, b.today ? $t(' · hari ini {0}{1}', [b.today > 0 ? '+' : '', b.today]) : '', can]) : $t('Cara dapat: {0}', [WHERE[t] || ''])));
    if (bb) txt.appendChild($('div', 'chain-dim', $t('Pedagang yang paling mahal membeli: {0}, {1} koin.', [bb.name, bb.bid])));
    top.appendChild(txt);
    box.appendChild(top);
    var row = $('div', 'gt-detail-acts');
    if (e.energy && n > 0) row.appendChild(button($t('Makan'), function () { act({ action: 'eat', token: t }).then(refreshModal, noop); }, 'primary'));
    if (window.GT_ITEMS && GT_ITEMS.held() !== t) row.appendChild(button($t('Pegang'), function () { GT_ITEMS.hold(t); redraw(); }));
    if (can > 0) row.appendChild(button($t('Jual ke pemain'), function () { askList(t, can); }));
    if (can > 0) row.appendChild(button($t('Kirim'), function () { askSend(t); }));
    row.appendChild(button($t('Riwayat'), function () { open('history', t); }));
    if (row.children.length) box.appendChild(row);
    return box;
  }

  function askSend(token) {
    var body = $('div');
    body.appendChild($('p', null, $t('Kirim 1 {0} ke pemain lain.{1}', [item(token), chainUI() ? $t(' Langsung on-chain, tanpa dompet, tanpa gas.') : $t(' Langsung sampai.')])));
    var input = $('input'); input.type = 'text'; input.placeholder = $t('akun penerima (…players…testnet)'); input.maxLength = 64;
    body.appendChild(input);
    GT.modal({ title: $t('Kirim {0}', [item(token)]), sticky: true, body: body, actions: [{ label: $t('Kirim'), primary: true, onClick: function (h) {
      var to = String(input.value || '').trim().toLowerCase();
      if (!/^[a-z0-9._-]{2,64}$/.test(to)) { GT.toast($t('Nama akun tidak valid')); return false; }
      h.close('ok'); GT.toast($t('Mengirim…'));
      signedCall('send_item', { receiver_id: to, token_id: token, amount: '1' }).then(function () { GT.toast($t('Terkirim!')); }, function (e) { GT.toast($t('Gagal: {0}', [e.message])); });
      return true;
    } }] });
    setTimeout(function () { input.focus(); }, 50);
  }

  function craftBody() {
    var wrap = $('div');
    wrap.appendChild($('p', null, $t('Meja kerja. Resep sederhana memakai energi, resep rumit memakai koin.')));
    Object.keys(S.cfg.econ.recipes).forEach(function (id) {
      var r = S.cfg.econ.recipes[id];
      var row = $('div', 'mrow');
      row.appendChild($('span', 'grow', item(r.output) + ' ← ' + Object.keys(r.inputs).map(function (t) { return r.inputs[t] + ' ' + item(t); }).join(' + ')));
      row.appendChild($('span', 'chain-dim', r.energy ? $t('{0} energi', [r.energy]) : $t('{0} koin', [r.fee])));
      row.appendChild(button($t('Buat'), function () { act({ action: 'craft', recipe: id }).then(refreshModal, noop); }, 'primary'));
      wrap.appendChild(row);
    });
    return wrap;
  }

  function shipBody() {
    var wrap = $('div');
    wrap.appendChild($('p', null, $t('Kotak Kirim: barang dijual ke kota pukul 06:00 seharga 70% harga dasar. Praktis, tapi pedagang biasanya membayar lebih.')));
    if (!S.st) return wrap;
    Object.keys(S.st.bag).forEach(function (t) {
      if (t === 'coin') return;
      var b = S.st.bag[t], n = b.settled + b.today;
      if (n <= 0) return;
      var row = $('div', 'mrow');
      row.appendChild($('span', 'grow', b.name + ' (' + n + ')'));
      row.appendChild(button($t('Kirim 1'), function () { act({ action: 'ship', token: t, qty: 1 }).then(refreshModal, noop); }));
      if (n >= 5) row.appendChild(button($t('Kirim 5'), function () { act({ action: 'ship', token: t, qty: 5 }).then(refreshModal, noop); }));
      wrap.appendChild(row);
    });
    return wrap;
  }

  /* ---- Pasar Pemain: player-to-player listings, escrowed in the game contract (on-chain right away) ---- */
  function bestAsk(token) {
    var best = null;
    (S.market || []).forEach(function (m) { if (!m.open) return; m.items.forEach(function (it) { if (it.token === token && it.ask != null && (best == null || it.ask < best.ask)) best = { ask: it.ask, name: m.name }; }); });
    return best;
  }
  function bestBid(token) {
    var best = null;
    (S.market || []).forEach(function (m) { if (!m.open) return; m.items.forEach(function (it) { if (it.token === token && it.bid != null && (best == null || it.bid > best.bid)) best = { bid: it.bid, name: m.name }; }); });
    return best;
  }
  function shortAcc(a) { return String(a).split('.')[0]; }
  function feePct() { return (S.feeBps != null ? S.feeBps : 500) / 100; }
  function marketCall(method, args, okMsg) {
    GT.toast($t('Mengirim ke chain…'));
    return signedCall(method, args).then(function () { GT.toast(okMsg); }, function (e) { GT.toast(e.message); });
  }

  // My seller tag (matches server/src/game/bazaar.ts sellerTag) so I can find my own anonymous listings
  function myTag() {
    if (!S.account || S.myTagFor === S.account) return Promise.resolve();
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode('gt-seller:' + S.account)).then(function (h) {
      S.myTag = Array.prototype.map.call(new Uint8Array(h), function (x) { return ('0' + x.toString(16)).slice(-2); }).join('').slice(0, 16);
      S.myTagFor = S.account;
    });
  }
  function isMine(l) { return l.anonymous ? l.sellerTag === S.myTag : l.seller === S.account; }
  function listingRow(l) {
    var row = $('div', 'mrow chain-item' + (l.anonymous ? ' gt-black-row' : ''));
    var info = $('div', 'grow');
    info.appendChild($('div', 'gt-data', $t('{0} {1} · {2} koin/buah', [l.amount, item(l.token_id), l.price_each])));
    var ba = bestAsk(l.token_id);
    var who = l.anonymous ? (isMine(l) ? $t('Penjual: kamu (anonim)') : $t('Penjual: tidak diketahui')) : $t('Dari {0} · {1} ({2} poin)', [isMine(l) ? $t('kamu') : shortAcc(l.seller), l.title || $t('Pedagang baru'), l.popularity || 0]);
    info.appendChild($('div', 'chain-dim', who + (ba && +l.price_each < ba.ask ? $t(' · lebih murah dari pedagang') : '')));
    row.appendChild(info);
    if (isMine(l)) {
      row.appendChild(button($t('Tarik'), function () { marketCall('cancel_listing', { listing_id: l.id }, $t('Barangmu ditarik dan kembali ke tas.')).then(refreshModal); }));
    } else {
      row.appendChild(button($t('Beli 1'), function () { marketCall('buy_listing', { listing_id: l.id, amount: '1', max_price_each: String(l.price_each) }, $t('Terbeli!')).then(refreshModal); }, 'primary gt-data'));
      if (+l.amount > 1) row.appendChild(button($t('Beli {0}', [l.amount]), function () { marketCall('buy_listing', { listing_id: l.id, amount: String(l.amount), max_price_each: String(l.price_each) }, $t('Terbeli!')).then(refreshModal); }, 'gt-data'));
    }
    return row;
  }
  // Listings grouped by item, cheapest first, with the merchants' prices next to them as a guide (like an exchange)
  function byItem(list, wrap) {
    var groups = {};
    list.forEach(function (l) { (groups[l.token_id] = groups[l.token_id] || []).push(l); });
    Object.keys(groups).sort(function (a, b) { return item(a).localeCompare(item(b)); }).forEach(function (t) {
      var ls = groups[t].sort(function (a, b) { return +a.price_each - +b.price_each || a.id - b.id; });
      var total = ls.reduce(function (n, l) { return n + +l.amount; }, 0), ba = bestAsk(t), bb = bestBid(t);
      var head = $('div', 'gt-group');
      if (window.GT_ITEMS) head.appendChild(GT_ITEMS.icon(t, 24));
      var txt = $('div', 'grow');
      txt.appendChild($('div', 'gt-detail-name', $t('{0} · termurah {1} koin', [item(t), ls[0].price_each])));
      txt.appendChild($('div', 'chain-dim', $t('{0} tersedia dari {1} lapak{2}{3}', [total, ls.length, ba ? $t(' · pedagang menjual {0}', [ba.ask]) : '', bb ? $t(' · membeli {0}', [bb.bid]) : ''])));
      head.appendChild(txt);
      wrap.appendChild(head);
      ls.forEach(function (l) { wrap.appendChild(listingRow(l)); });
    });
  }
  function marketBody() {
    var wrap = $('div');
    var tab = S.marketTab || 'lapak';
    var tabs = $('div', 'gt-tabs'); tabs.setAttribute('role', 'tablist');
    [['lapak', $t('Lapak')], ['gelap', $t('Pasar Gelap')], ['populer', $t('Populer')]].forEach(function (t) {
      var b = button(t[1], function () { S.marketTab = t[0]; redraw(); }, tab === t[0] ? 'primary' : '');
      b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', tab === t[0] ? 'true' : 'false');
      tabs.appendChild(b);
    });
    wrap.appendChild(tabs);
    if (!S.listings) { wrap.appendChild($('p', null, $t('Memuat…'))); return wrap; }
    if (tab === 'lapak') {
      wrap.appendChild($('p', null, $t('Jual pakai namamu: setiap barang yang laku menambah popularitasmu.')));
      var named = S.listings.filter(function (l) { return !l.anonymous && (!S.marketSeller || l.seller === S.marketSeller.account); });
      if (S.marketSeller) {
        // opened from another player's card: only their stall, with a way back to everyone's
        wrap.appendChild($('h4', 'chain-h', $t('Lapak {0}', [S.marketSeller.nick])));
        wrap.appendChild(button($t('Lihat semua lapak'), function () { S.marketSeller = null; redraw(); }));
      }
      if (!named.length) wrap.appendChild($('p', 'chain-dim', $t('Belum ada lapak. Jadilah yang pertama!')));
      byItem(named, wrap);
    } else if (tab === 'gelap') {
      wrap.appendChild($('p', null, $t('Jual tanpa nama dan tanpa popularitas. Anonim di dalam game saja; catatan transaksinya tetap publik.')));
      var anon = S.listings.filter(function (l) { return l.anonymous; });
      if (!anon.length) wrap.appendChild($('p', 'chain-dim', $t('Pasar Gelap sedang sepi.')));
      byItem(anon, wrap);
    } else {
      wrap.appendChild($('p', null, $t('Satu poin untuk setiap barang yang laku di Lapak.')));
      if (!(S.popular || []).length) wrap.appendChild($('p', 'chain-dim', $t('Belum ada penjualan di Lapak.')));
      (S.popular || []).forEach(function (p, i) {
        var row = $('div', 'mrow');
        row.appendChild($('span', 'num', (i + 1) + '.'));
        row.appendChild($('span', 'grow', (p.account === S.account ? $t('Kamu') : p.nick ? p.nick + (p.tag ? '#' + p.tag : '') : shortAcc(p.account)) + ' · ' + p.title));
        row.appendChild($('span', 'num', $t('{0} poin · {1} penjualan', [p.points, p.sales])));
        wrap.appendChild(row);
      });
      return wrap;
    }
    var mine = S.listings.filter(isMine).length;
    var h = $('h4', 'chain-h', $t('{0} · lapakmu {1}/5', [tab === 'gelap' ? $t('Jual tanpa nama') : $t('Jual di Lapak'), mine]));
    wrap.appendChild(h);
    var grid = $('div', 'gt-grid'), any = false;
    if (S.st) (window.GT_ITEMS ? GT_ITEMS.SLOTS : Object.keys(S.st.bag).filter(function (t) { return t !== 'coin'; })).forEach(function (t) {
      var can = spendable(t), bb = bestBid(t);
      if (can > 0) any = true;
      grid.appendChild(itemCard(t, can > 0 ? $t('bisa jual {0}', [can]) : $t('belum ada'), bb ? $t('pedagang {0}', [bb.bid]) : null, {
        off: can <= 0 || mine >= 5, accent: can > 0 && mine < 5,
        title: mine >= 5 ? $t('Lapakmu penuh (5). Tarik satu dulu.') : can > 0 ? $t('Pasang {0}', [item(t)]) : $t('Hanya barang yang sudah tersimpan (lewat pukul 06:00) yang bisa dijual ke pemain.'),
        onClick: function () { if (can > 0 && mine < 5) askList(t, can, tab === 'gelap'); }
      }));
    });
    wrap.appendChild(grid);
    if (!any) wrap.appendChild($('p', 'chain-dim', $t('Belum ada barang yang bisa dijual di sini.')));
    wrap.appendChild($('p', 'chain-dim', $t('Barang hari ini bisa dijual setelah 06:00 · maks 5 lapak · biaya {0}% per penjualan.{1}', [feePct(), chainUI() ? $t(' Langsung on-chain, tanpa dompet dan tanpa gas.') : ''])));
    return wrap;
  }

  function askList(token, max, anonymous) {
    var body = $('div');
    var bb = bestBid(token), ba = bestAsk(token);
    var base = (S.cfg.econ.items[token] || {}).base || 1;
    body.appendChild($('p', null, $t('Jual {0} ke pemain lain.', [item(token)])));
    body.appendChild($('p', 'chain-dim', (bb ? $t('Pedagang membeli paling mahal {0} ({1}). ', [bb.bid, bb.name]) : '') + (ba ? $t('Pedagang menjual paling murah {0} ({1}).', [ba.ask, ba.name]) : '')));
    var qty = $('input'); qty.type = 'number'; qty.min = '1'; qty.max = String(Math.min(50, max)); qty.value = String(Math.min(max, 5));
    var price = $('input'); price.type = 'number'; price.min = '1'; price.max = '100000';
    price.value = String(ba ? Math.max(1, ba.ask - 1) : Math.max(1, Math.round(base)));
    var l1 = $('label', 'chain-field', $t('Jumlah ')); l1.appendChild(qty);
    var l2 = $('label', 'chain-field', $t('Harga/buah ')); l2.appendChild(price);
    var side = $('div', 'mseg'); side.setAttribute('role', 'radiogroup');
    [['lapak', $t('Lapak (namamu tampil, dapat popularitas)')], ['gelap', $t('Pasar Gelap (tanpa nama, tanpa popularitas)')]].forEach(function (o) {
      var lab = $('label'), rb = $('input'); rb.type = 'radio'; rb.name = 'gt-side'; rb.value = o[0]; rb.checked = (o[0] === 'gelap') === !!anonymous;
      lab.appendChild(rb); lab.appendChild($('span', null, o[1])); side.appendChild(lab);
    });
    var net = $('p', 'chain-dim');
    var warn = $('p', 'gt-warn');
    function upd() {
      var t = (+qty.value || 0) * (+price.value || 0), fee = Math.floor(t * (S.feeBps != null ? S.feeBps : 500) / 10000);
      net.textContent = $t('Total {0} koin, biaya {1} dibakar: kamu terima {2} koin kalau semua terjual.', [t, fee, t - fee]);
      var each = (+price.value || 0) * (1 - feePct() / 100);
      warn.textContent = bb && each < bb.bid ? $t('Awas: setelah biaya kamu dapat kurang dari {0} koin/buah, harga {1} kalau kamu jual langsung ke pedagang.', [bb.bid, bb.name]) : '';
      warn.hidden = !warn.textContent;
    }
    qty.addEventListener('input', upd); price.addEventListener('input', upd); upd();
    body.appendChild(l1); body.appendChild(l2); body.appendChild(side); body.appendChild(net); body.appendChild(warn);
    GT.modal({ title: $t('Jual {0}', [item(token)]), sticky: true, body: body, actions: [{ label: $t('Pasang'), primary: true, onClick: function (h) {
      var q = Math.floor(+qty.value), pr = Math.floor(+price.value);
      var anon = !!(side.querySelector('input:checked') || {}).value && side.querySelector('input:checked').value === 'gelap';
      if (!(q >= 1 && q <= Math.min(50, max))) { GT.toast($t('Jumlah 1–{0}', [Math.min(50, max)])); return false; }
      if (!(pr >= 1 && pr <= 100000)) { GT.toast($t('Harga 1–100000')); return false; }
      h.close('ok');
      S.marketTab = anon ? 'gelap' : 'lapak';
      GT.toast($t('Mengirim ke chain…'));
      signedCall('list_item', { token_id: token, amount: String(q), price_each: String(pr) }, { anonymous: anon })
        .then(function () { GT.toast(anon ? $t('Dipasang di Pasar Gelap.') : $t('Dipasang di Lapak.')); open('market'); }, function (e) { GT.toast(e.message); });
      return true;
    } }] });
    setTimeout(function () { price.focus(); price.select(); }, 50);
  }

  // Riwayat in plain words: what happened, with the item's icon, grouped by day; repeats are folded ("+1 Ikan ×5").
  // Anyone who wants the technical record follows "Detail ↗" to the block explorer.
  var ST_LABEL = { pending: $t('diproses…'), ok: $t('tersimpan'), failed: $t('gagal'), mock: $t('tiruan'), offchain: $t('disimpan 06:00') };
  var KIND_ICON = { account: 'coin', storage: 'coin', device: 'coin', trade: 'coin', settle: 'coin', buy: 'coin', sell: 'coin', ship: 'coin', fight: 'tool', engage: 'tool' };
  function shortName(a) { a = String(a || ''); var p = a.split('.')[0]; return p.length > 12 ? p.slice(0, 10) + '…' : p; }
  function projName(id) { var pj = (S.projects || []).filter(function (x) { return x.id === id; })[0]; return pj ? pj.name : id; }
  function merchName(id) { return id ? id.charAt(0).toUpperCase() + id.slice(1) : ''; }
  function friendly(h) {
    var t = String(h.summary || ''), m, sub = null;
    var tok = (h.tokens || '').split(',').filter(function (x) { return x && x !== 'coin'; })[0] || KIND_ICON[h.kind] || null;
    if (h.kind === 'settle' && (m = /^Settlement hari (\d+):?\s*(.*)$/.exec(t))) { t = $t('Hasil hari {0} disimpan permanen', [m[1]]); sub = m[2] || null; }
    else if (h.kind === 'account') t = $t('Akunmu dibuat');
    else if (h.kind === 'storage') t = $t('Akunmu siap dipakai di game');
    else if (h.kind === 'device') t = $t('Perangkat baru bisa main dengan akunmu');
    else if (h.kind === 'send_item' && (m = /^Kirim (\d+) (\w+) ke (.+)$/.exec(t))) t = $t('Kirim {0} {1} ke {2}', [m[1], item(m[2]), shortName(m[3])]);
    else if (h.kind === 'restore_contribute' && (m = /^Sumbang ke papan pemulihan (\w+): (.*)$/.exec(t))) { t = $t('Sumbang untuk buka lagi toko {0}', [merchName(m[1])]); sub = m[2]; }
    else if ((h.kind === 'project_contribute') && (m = /^Sumbang ke proyek desa ([\w-]+): (.*)$/.exec(t))) { t = $t('Sumbang ke {0}', [projName(m[1])]); sub = m[2]; }
    else if (h.kind === 'project_withdraw' && (m = /proyek desa ([\w-]+)/.exec(t))) t = $t('Tarik sumbangan dari {0}', [projName(m[1])]);
    else if (h.kind === 'buy_listing' && (m = /^Beli (\d+) dari lapak/.exec(t))) t = $t('Beli {0} barang dari lapak pemain', [m[1]]);
    else if (h.kind === 'cancel_listing') t = $t('Barangmu ditarik dari Pasar Pemain');
    else if (h.kind === 'list_item') t = t.replace(/ di Pasar Pemain, /, $t(' di Pasar: '));
    return { icon: tok, title: t, sub: sub };
  }
  function dayLabel(d) {
    var now = new Date(), y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === now.toDateString()) return $t('Hari ini');
    if (d.toDateString() === y.toDateString()) return $t('Kemarin');
    return d.getDate() + ' ' + [$t('Jan'), $t('Feb'), $t('Mar'), $t('Apr'), $t('Mei'), $t('Jun'), $t('Jul'), $t('Agu'), $t('Sep'), $t('Okt'), $t('Nov'), $t('Des')][d.getMonth()];
  }
  function clock(d) { return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
  function historyBody(token) {
    var wrap = $('div', 'gt-hist'), details = chainUI();
    var rows = S.histFilter === 'trade' && !token ? S.tradeHistory : S.history;
    if (!token && S.mode !== 'offline') {
      var fl = $('div', 'gt-detail-acts');
      [['all', $t('Semua')], ['trade', $t('Dagang')]].forEach(function (p) {
        fl.appendChild(button(p[1], function () { S.histFilter = p[0]; if (p[0] === 'trade') S.tradeHistory = null; redraw(); refresh(true); }, (S.histFilter || 'all') === p[0] ? 'primary' : ''));
      });
      wrap.appendChild(fl);
    }
    if (token) {
      if (S.mode === 'offline') rows = S.history.filter(function (h) { return (h.tokens || '').indexOf(',' + token + ',') >= 0; });
      else rows = S.itemHistory && S.itemHistory.token === token ? S.itemHistory.rows : null;
      var nav = $('div', 'gt-detail-acts');
      nav.appendChild(button($t('Semua riwayat'), function () { open('history'); }));
      nav.appendChild(button($t('Kembali ke Tas'), function () { var h = S.modal && S.modal.h; if (h) h.close(); open('bag'); }));
      wrap.appendChild(nav);
    }
    if (!rows) wrap.appendChild($('p', null, $t('Memuat…')));
    else if (!rows.length) wrap.appendChild($('p', null, token ? $t('Belum ada riwayat untuk barang ini.') : S.histFilter === 'trade' ? $t('Belum ada dagang.') : $t('Belum ada kegiatan. Coba mancing di kolam!')));
    // fold consecutive identical off-chain rows (same text, same day, no transaction to link)
    var items = [];
    (rows || []).forEach(function (h) {
      var last = items[items.length - 1], d = new Date(h.created_at);
      if (last && !h.tx_hash && !last.h.tx_hash && last.h.summary === h.summary && last.h.status === h.status && dayLabel(last.d) === dayLabel(d)) { last.n++; last.first = d; return; }
      items.push({ h: h, d: d, first: d, n: 1 });
    });
    var day = null;
    items.forEach(function (it) {
      var h = it.h, f = friendly(h), lbl = dayLabel(it.d);
      if (lbl !== day) { day = lbl; wrap.appendChild($('h4', 'gt-hist-day', lbl)); }
      var row = $('div', 'gt-hist-row' + (h.status === 'failed' ? ' bad' : ''));
      var ic = $('span', 'gt-hist-ic');
      if (f.icon && f.icon !== 'coin' && window.GT_ITEMS) ic.appendChild(GT_ITEMS.icon(f.icon, 20)); else ic.appendChild($('span', 'gt-card-coin'));
      row.appendChild(ic);
      var txt = $('div', 'grow');
      txt.appendChild($('div', 'gt-hist-t', f.title + (it.n > 1 ? ' ×' + it.n : '')));
      var meta = (it.n > 1 && clock(it.first) !== clock(it.d) ? clock(it.first) + '–' + clock(it.d) : clock(it.d)) + (ST_LABEL[h.status] && h.status !== 'mock' ? ' · ' + ST_LABEL[h.status] : '');
      txt.appendChild($('div', 'gt-hist-s', (f.sub ? f.sub + ' · ' : '') + meta));
      row.appendChild(txt);
      if (h.tx_hash && S.mode === 'testnet') {
        var a = $('a', 'chain-link', $t('Detail ↗')); a.href = S.cfg.explorerTxUrl + encodeURIComponent(h.tx_hash); a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.title = $t('Buka catatan lengkap transaksi ini di browser (NEAR explorer)');
        row.appendChild(a);
      }
      wrap.appendChild(row);
    });
    if (S.st) wrap.appendChild($('p', 'chain-dim', $t('Kegiatan hari ini disimpan pukul 06:00. Detail ↗ membuka catatan lengkapnya.')));
    // technical mode (account name, on-chain labels elsewhere in the game) stays available, out of the way
    var tog = $('label', 'chain-field gt-details');
    var cb = $('input'); cb.type = 'checkbox'; cb.checked = details;
    cb.addEventListener('change', function () { setChainUI(cb.checked); redraw(); });
    tog.appendChild(cb); tog.appendChild($('span', null, $t(' Mode teknis (nama akun dan label on-chain di seluruh game)')));
    wrap.appendChild(tog);
    if (details && S.account) wrap.appendChild($('p', 'chain-dim', $t('Akun: {0}', [S.account])));
    return wrap;
  }

  var BODIES = { bag: bagBody, history: historyBody, craft: craftBody, ship: shipBody, market: marketBody, project: projectBody, tools: toolsBody, missions: missionsBody };
  function open(kind, arg) {
    if (S.mode !== 'offline' && !S.account && kind !== 'shop') { login(); return; }
    if (S.modal && S.modal.h && S.modal.h.isOpen()) S.modal.h.close('switch'); // one window at a time (Tas → Riwayat)
    if (kind === 'project') markGoal('board');
    if (kind === 'missions') { var cm = S.st && S.st.missions && S.st.missions.current; if (cm) { lsSet(msSeenKey(), cm); renderGoals(); } }
    var title = kind === 'bag' ? $t('Tas') : kind === 'market' ? $t('Pasar Pemain') : kind === 'project' ? $t('Papan Proyek Desa') : kind === 'history' ? (arg ? $t('Riwayat · {0}', [item(arg)]) : $t('Riwayat')) : kind === 'craft' ? $t('Meja Kerja') : kind === 'ship' ? $t('Kotak Kirim') : kind === 'tools' ? $t('Alat') : kind === 'missions' ? $t('Misi') : (MERCHANTS.filter(function (m) { return m.id === arg; })[0] || {}).tag;
    var body = kind === 'shop' ? shopBody(arg) : BODIES[kind](arg);
    var h = GT.modal({ title: title, wide: kind === 'history' || kind === 'shop' || kind === 'market' || kind === 'project', body: body, onClose: function () { S.modal = null; if (kind === 'market') S.marketSeller = null; } });
    S.modal = { kind: kind, arg: arg, h: h };
    refresh(true);
  }
  function redraw() {
    if (!S.modal || !S.modal.h || !S.modal.h.isOpen()) return;
    S.modal.h.setBody(S.modal.kind === 'shop' ? shopBody(S.modal.arg) : BODIES[S.modal.kind](S.modal.arg));
  }
  function refreshModal() { return refresh(true); }
  function noop() {}

  /* ------------------------------------------------------------ engine hooks */
  function onInteract(ctx) {
    if (ctx.mode !== 'talk') return false;
    if (ctx.npc && ctx.npc.key && ctx.npc.key.indexOf('merchant:') === 0) { open('shop', ctx.npc.key.slice(9)); return true; }
    // The prototype's mart keepers sold for local play coins; the town's shops are now the four merchants.
    if (ctx.npc && ctx.npc.key && /:keeper$/.test(ctx.npc.key)) { GT.toast($t('Mart sudah pindah: belanja di pasar dekat rumahmu (Sari, Budi, Wati, Joko).')); return true; }
    if (ctx.npc || ctx.door) return false;
    if (ctx.tileType === 'stall') { var st0 = stallAt(ctx.tile.x, ctx.tile.y); if (st0 && st0.merchant) { open('shop', st0.merchant); return true; } }
    var house = ctx.scene.house, own = house && house.own, board = ctx.scene.map && ctx.scene.map.board;
    if (house && board && ctx.tile.x === board.x && ctx.tile.y === board.y && S.mode !== 'offline') {
      if (house.kind === 'hall') { open('project'); return true; }
      if (house.kind === 'broker') { open('market'); return true; }
    }
    if (own && (ctx.tileType === 'table' || ctx.tileType === 'chest')) {
      if (S.mode !== 'offline' && !S.account) { GT.toast($t('Masuk dulu (tombol Masuk) untuk memakai {0}', [ctx.tileType === 'table' ? $t('Meja Kerja.') : $t('Kotak Kirim.')])); return true; }
      open(ctx.tileType === 'table' ? 'craft' : 'ship'); return true;
    }
    if (house && !own && ctx.tileType === 'chest') {
      GT.toast($t('Peti milik {0}, terkunci. Kotak Kirim-mu ada di peti rumahmu sendiri.', [house.owner || 'tetangga']));
      return true;
    }
    if (ctx.scene.kind !== 'out') return false;
    var pi = plotAt(ctx.tile.x, ctx.tile.y);
    if (pi >= 0) { farm(pi); return true; }
    var token = TILE_ITEM[ctx.tileType];
    if (!token) return false;
    if (S.busy) return true;
    var tx = ctx.tile.x, ty = ctx.tile.y, tt = ctx.tileType;
    function gather() {
      if (toolBroken(tt)) return Promise.resolve();
      S.busy = true;
      // the axe swing starts right away, the server answer follows (only when there is energy to swing)
      var ecost = (S.cfg && S.cfg.econ.gather && S.cfg.econ.gather.energyCost) || 0;
      if (window.GT_FX && S.mode !== 'offline' && S.account && (!S.st || S.st.energy >= ecost)) {
        if (tt === 'tree') GT_FX.chop({ x: tx, y: ty });
        else if (TILE_ITEM[tt] === 'ore' && GT_FX.mine) GT_FX.mine({ x: tx, y: ty }); // the pickaxe swing on a rock
      }
      return act({ action: 'gather', tile: tt, x: tx, y: ty }).then(function () { if (S.st && S.st.encounter) openFight(); }, function (e) {
        // an emptied pond tile: remember it so its ripples go away until it refills
        var m = /Kembali sekitar (\d+) jam/.exec(e && e.message || '');
        if (m && tt === 'water') { S.emptyWater = S.emptyWater || {}; S.emptyWater[tx + ',' + ty] = Date.now() + (+m[1] || 1) * S.cfg.econ.time.realMsPerGameHour; }
      }).then(function () { S.busy = false; });
    }
    // Fishing is a small skill game (js/mods/fishing.js); the catch is the same gather action.
    if (tt === 'water' && window.GT_FISH && S.mode !== 'offline') {
      if (!S.account) { GT.toast($t('Masuk dulu (tombol Masuk) untuk memancing.')); return true; }
      if (toolBroken('water')) return true;
      var cost = (S.cfg.econ.gather && S.cfg.econ.gather.energyCost) || 0;
      if (S.st && S.st.energy < cost) { GT.toast($t('Energimu habis. Makan dulu atau tunggu besok.')); return true; }
      var em = S.emptyWater && S.emptyWater[tx + ',' + ty];
      if (em && em > Date.now()) { GT.toast($t('Ikan di sini sudah habis. Cari riak air di tempat lain.')); return true; }
      if (!GT_FISH.isSpot(tx, ty)) { GT.toast($t('Tidak ada ikan di sini. Pancing di air yang beriak.')); return true; }
      GT_FISH.start({ tile: { x: tx, y: ty }, onCatch: gather });
      return true;
    }
    gather();
    return true;
  }

  // Facing grass and pressing the action key: a small chance of a wheat seed (the server checks the tile, the distance, the energy,
  // the cooldown and the daily cap; economy.grass in /api/config). Holding the hoe leaves grass to the Homeland's hoe squares.
  // It registers from init (after every mod): a Homeland lot, the portal and the hoe squares on grass keep their own interaction.
  var grassAt = 0;
  function searchGrass(ctx) {
    var g = S.cfg && S.cfg.econ && S.cfg.econ.grass;
    if (!g || ctx.scene.kind !== 'out' || g.tiles.indexOf(ctx.tileType) < 0 || S.mode === 'offline' || !S.account) return false;
    if (window.GT_ITEMS && GT_ITEMS.holding && GT_ITEMS.holding('hoe')) return false;
    if (S.busy) return true;
    var now = Date.now();
    if (now - grassAt < g.cooldownSecs * 1000) return true; // the server has the same cooldown; do not ask before it is over
    if (S.st && S.st.energy < g.energyCost) { GT.toast($t('Energimu habis. Makan dulu atau tunggu besok.')); return true; }
    grassAt = now; S.busy = true;
    var gt = { x: ctx.tile.x, y: ctx.tile.y };
    if (window.GT_FX && GT_FX.rustle) GT_FX.rustle(gt, false); // the tuft shakes while the answer travels
    act({ action: 'grass', x: gt.x, y: gt.y }).then(function (r) {
      if (r && r.gained && Object.keys(r.gained).length && window.GT_FX && GT_FX.rustle) GT_FX.rustle(gt, true); // a seed: it pops out of the grass
    }, noop).then(function () { S.busy = false; });
    return true;
  }

  function onWorld() {
    S.npcs = {}; villagers = []; S.plots = [];
    if (worldNow() === 'public') { placeMerchants(); spawnVillagers(); } // Homelands have no merchants or townsfolk
    findPlots();
    renderGoals();
  }

  function init() {
    GT.register({ id: 'chain-grass', onInteract: function (ctx) { return ctx.mode === 'talk' && !ctx.npc && !ctx.door && searchGrass(ctx); } });
    accBtn = GT.addHudButton({ id: 'chainbtn', label: $t('Masuk'), key: 'N', secondary: false, onClick: function () { open('bag'); } });
    GT.hotkey('H', function () { open('history'); });
    GT.addHudButton({ id: 'pasarbtn', label: $t('Pasar'), key: 'K', onClick: function () { if (S.mode === 'offline') GT.toast($t('Pasar Pemain butuh server game.')); else open('market'); } });
    // The old local bag (play items) is replaced by the NEAR bag: hide its button and point the I key here.
    var oldBag = document.getElementById('bagbtn'); if (oldBag) oldBag.style.display = 'none';
    GT.hotkey('I', function () { if (S.mode === 'offline') GT.openBag(); else open('bag'); }); // offline demo keeps the local bag
    var forceOffline = /[?&]mode=offline\b/.test(location.search) || location.protocol === 'file:';
    var cfgP = forceOffline ? Promise.reject(new Error('offline')) :
      Promise.race([api('/config'), new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, 4000); })]);
    cfgP.then(function (cfg) {
      S.cfg = cfg; S.mode = cfg.chainMode === 'mock' ? 'mock' : 'testnet';
      // One shared world: the server's seed and the chunks opened by town projects.
      if (cfg.world && GT.setWorld) GT.setWorld(cfg.world.seed, cfg.world.unlocked);
      S.account = lsGet(LS_ACC);
      if (S.account && lsGet(LS_KEY) && !keyRing()[S.account] && window.NearLib) { try { keepKey(S.account, window.NearLib.KeyPair.fromString(lsGet(LS_KEY))); } catch (e) { /* bad key */ } }
      if (cfg.devTools) GT.addDevSection($t('NEAR settlement'), function (sec) {
        sec.appendChild($('p', 'mnote', $t('Lompat ke pukul 06:00 berikutnya dan tulis hari ini ke chain sekarang.')));
        sec.appendChild(button($t('Settle sekarang'), function () {
          GT.toast($t('Settlement berjalan…'));
          api('/dev/settle', { method: 'POST' }).then(function (r) { GT.toast($t('Settled sampai hari {0}', [r.settledThrough])); refresh(true); }, function (e) { GT.toast(e.message); });
        }, 'primary'));
        if (cfg.chainMode === 'mock') {
          sec.appendChild($('p', 'mnote', $t('Rantai tiruan saja: isi tas dengan bahan proyek desa dan toko (langsung tersimpan) untuk mencoba alurnya.')));
          sec.appendChild(button($t('Beri bahan (mock)'), function () {
            api('/dev/grant', { method: 'POST', body: { items: { wood: 120, ore: 40, coin: 600, fish: 10, wheat: 20 } } })
              .then(function (r) { S.st = r.state; renderHud(); redraw(); GT.toast($t('Tas diisi: 120 Kayu, 40 Bijih, 600 Koin, 10 Ikan, 20 Gandum.')); }, function (e) { GT.toast(e.message); });
          }));
        }
        sec.appendChild($('p', 'mnote', $t('Lompat ke pukul 20:00 berikutnya: monster muncul di Hutan Utara pada malam hari.')));
        sec.appendChild(button($t('Lompat ke malam'), function () {
          api('/dev/night', { method: 'POST' }).then(function () { GT.toast($t('Sekarang malam.')); refresh(true); }, function (e) { GT.toast(e.message); });
        }));
      });
    }).catch(function () { S.mode = 'offline'; if (!forceOffline) { net.bootFailed = true; netDown(); } }).then(function () {
      renderBanner(); return refresh(true);
    }).then(schedulePoll);
    renderBanner();
    // a live language switch: the server translates names and messages, so fetch them again, then redraw what is open
    if (window.GT_I18N) GT_I18N.onChange(function () {
      renderBanner(); renderGoals();
      if (S.mode === 'offline') { renderHud(); redraw(); return; }
      api('/config').then(function (cfg) { S.cfg = cfg; renderHud(); redraw(); }, function () { /* keep the old names */ }).then(function () { return refresh(true); });
    });
  }

  // keys while fighting: F / Space / Enter attack, Esc runs; nothing else moves the player
  function onKey(e) {
    if (!fightOpen()) return false;
    if (e.repeat) return true;
    if (e.code === 'KeyF' || e.code === 'Space' || e.code === 'Enter') fightStep('fight');
    else if (e.code === 'Escape') fightStep('flee');
    return true;
  }

  window.GT_CHAIN = { weather: weatherKind, approveDevice: approveDevice, monsters: monstersNow, state: S, refresh: refresh, login: login, signOut: signOut, open: open, act: act, askSend: askSend, askList: askList, spendable: spendable, plotAt: plotAt, api: api, signHeaders: signHeaders, standPos: standPos, toolBroken: toolBroken, _signedCall: signedCall };
  GT.register({ id: 'chain', init: init, onWorld: onWorld, onInteract: onInteract, onDrawGround: onDrawGround, onDraw: onDraw, onFrame: onFrame, onKey: onKey });
})();
