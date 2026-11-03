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
  var LS_KEYS = 'gt.chain.keys', LS_FORCE = 'gt.chain.chooseAccount';
  var TILE_ITEM = { water: 'fish', rock: 'ore', tree: 'wood' };
  var MERCHANTS = [
    { id: 'sari', pal: 3, dx: 3, dy: 2, tag: 'Sari · Ikan' },
    { id: 'budi', pal: 2, dx: 5, dy: 2, tag: 'Budi · Bengkel' },
    { id: 'wati', pal: 5, dx: -3, dy: 2, tag: 'Wati · Roti' },
    { id: 'joko', pal: 4, dx: -5, dy: 2, tag: 'Joko · Serba Ada' }
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
  function api(path, opts) {
    opts = opts || {};
    var method = opts.method || 'GET', body = opts.body ? JSON.stringify(opts.body) : '';
    var headers = { 'content-type': 'application/json' };
    var signing = S.account && window.NearLib ? signHeaders(method, '/api' + path, body) : Promise.resolve({});
    return signing.then(function (sh) {
      for (var k in sh) headers[k] = sh[k];
      return fetch('/api' + path, { method: method, headers: headers, body: body || undefined });
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) { var e = new Error(j.error || ('HTTP ' + r.status)); e.status = r.status; throw e; }
          return j;
        });
      });
  }

  /* ------------------------------------------------------------ offline (browser only, gathering) */
  var OFF = {
    load: function () { try { return JSON.parse(lsGet(LS_OFF) || 'null') || { bal: {}, hist: [], n: 0 }; } catch (e) { return { bal: {}, hist: [], n: 0 }; } },
    gather: function (t) {
      var d = OFF.load(); d.bal[t] = (d.bal[t] || 0) + 1;
      d.hist.unshift({ id: ++d.n, kind: 'gather', summary: '+1 ' + item(t), status: 'mock', tx_hash: null, created_at: Date.now() });
      d.hist = d.hist.slice(0, 50); lsSet(LS_OFF, JSON.stringify(d)); return d;
    }
  };

  /* ------------------------------------------------------------ banner + HUD */
  var banner = null, accBtn = null, hudCell = null;
  function renderBanner() {
    if (!banner) {
      banner = $('div', 'chain-banner'); banner.setAttribute('role', 'status');
      var shell = document.querySelector('.shell');
      if (shell) shell.insertBefore(banner, shell.firstChild);
    }
    var txt, cls = 'chain-banner ';
    if (S.mode === 'offline') { txt = 'OFFLINE DEMO · hanya mengumpulkan, tidak ada transaksi on-chain'; cls += 'off'; }
    else if (S.mode === 'mock') { txt = 'SERVER MOCK CHAIN · transaksi tiruan, bukan testnet'; cls += 'mock'; }
    else if (S.mode === 'testnet') { txt = 'NEAR testnet' + (S.account ? ' · ' + S.account : ' · belum masuk'); cls += 'net'; }
    else { txt = 'Menghubungkan…'; cls += 'mock'; }
    banner.className = cls; banner.textContent = txt;
    if (accBtn) accBtn.textContent = S.account || S.mode === 'offline' ? 'Tas' : 'Masuk';
  }

  var SEASON = { semi: 'Semi', panas: 'Panas', gugur: 'Gugur', dingin: 'Dingin' };
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
    var l = $('span', 'lbl', 'ENERGI · MUSIM'); hudCell.appendChild(l);
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
    body.appendChild($('p', null, 'Akunmu (' + r.accountId.split('.')[0] + ') belum punya kunci game di perangkat ini.'));
    body.appendChild($('p', null, 'Setujui satu kali di jendela NEAR Auth, lalu kunci baru ditambahkan ke akunmu di testnet. Kunci ini hanya bisa memanggil kontrak game, tidak bisa memindahkan NEAR. Gas dibayar game.'));
    return new Promise(function (resolve, reject) {
      GT.modal({ title: 'Perangkat baru', body: body, onClose: function (why) { if (why !== 'action') reject(new Error('Dibatalkan')); }, actions: [{ label: 'Setujui di NEAR Auth', primary: true, onClick: function (h) {
        var prov = new L.JsonRpcProvider({ url: S.cfg.rpcUrl }), da;
        GT.toast('Membuka NEAR Auth…');
        Promise.all([prov.viewAccessKey({ accountId: r.accountId, publicKey: L.PublicKey.from(r.ownerPublicKey) }), prov.viewBlock({ finality: 'final' })])
          .catch(function () { throw new Error('Kunci NEAR Auth-mu tidak ditemukan di akun ini.'); })
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
            GT.toast('Menambahkan kunci ke akunmu…');
            var sr = res.signatureRequest;
            return api('/auth/add-key', { method: 'POST', body: {
              idToken: idToken,
              delegateAction: b64(L.encodeDelegateAction(da).slice(4)), // plain borsh DelegateAction (without the NEP-461 prefix)
              signatureRequest: { guardId: sr.guardId, verifyPayload: sr.verifyPayload, signPayload: Array.from(sr.signPayload), algorithm: sr.algorithm || 'eddsa' }
            } });
          })
          .then(function (out) { h.close('action'); resolve(out); }, function (e) { GT.toast('Gagal: ' + (e && e.message || e)); });
        return false;
      } }] });
    });
  }

  function finishLogin(idToken, retried, provider) {
    var kp = sessionKey();
    GT.toast('Membuat akunmu di NEAR testnet…');
    return api('/auth/register', { method: 'POST', body: { idToken: idToken, sessionPublicKey: kp.getPublicKey().toString() } })
      .catch(function (e) {
        // This browser's key belongs to another login: make a fresh key for this one and try once more.
        if (!retried && /already belongs to another account/.test(e.message)) { lsSet(LS_KEY, null); return finishLogin(idToken, true, provider).then(function () { return null; }); }
        throw e;
      })
      .then(function (r) {
        if (r === null) return;
        if (r.needsKey) {
          var needProvider = function () { if (!provider) throw new Error('Akun ini perlu kunci baru; masuk dengan NEAR Auth.'); };
          // a key for this account from an earlier sign-in in this browser: use it instead of adding a new one
          var known = keyOf(r.accountId);
          if (known && known.getPublicKey().toString() !== kp.getPublicKey().toString()) {
            return api('/auth/register', { method: 'POST', body: { idToken: idToken, sessionPublicKey: known.getPublicKey().toString() } }).then(function (r2) {
              if (r2.needsKey) { needProvider(); return newDevice(provider, r, idToken).then(function () { signedIn(r.accountId, sessionKey(), 'Kunci baru ditambahkan. Selamat datang kembali!'); }); }
              return signedIn(r2.accountId, known, 'Selamat datang kembali!');
            });
          }
          needProvider();
          return newDevice(provider, r, idToken).then(function () { return signedIn(r.accountId, sessionKey(), 'Kunci baru ditambahkan. Selamat datang kembali!'); });
        }
        keepKey(r.accountId, kp);
        S.account = r.accountId; lsSet(LS_ACC, r.accountId); renderBanner();
        GT.toast(r.created ? 'Akun dibuat! Paket awal: 100 koin, 1 Alat, 3 Roti, 3 Gandum.' : 'Selamat datang kembali!');
        return refresh(true);
      });
  }

  function signedIn(account, kp, msg) {
    keepKey(account, kp);
    S.account = account; lsSet(LS_ACC, account); renderBanner();
    GT.toast(msg);
    return refresh(true);
  }

  // Sign out: forget the account in this browser and clear the NEAR Auth login cache (no redirect). The game key stays
  // in the key ring, so signing back in as the same account needs no new-device step. The next sign-in asks for the
  // account again instead of reusing the last one.
  function signOut() {
    if (S.modal && S.modal.h) S.modal.h.close('signout');
    S.account = null; S.st = null; S.history = []; S.shops = null; S.listings = null; S.projects = null;
    lsSet(LS_ACC, null); lsSet(LS_FORCE, '1');
    if (window.NearLib && S.cfg && S.cfg.fastAuth && !S.cfg.devLogin) {
      try { new window.NearLib.JavascriptProvider({ network: 'testnet', clientId: S.cfg.fastAuth.clientId }).logout({ openUrl: false }).catch(noop); } catch (e) { /* cache only */ }
    }
    renderBanner(); renderHud();
    GT.toast('Kamu sudah keluar. Tekan Masuk untuk masuk lagi.');
    return refresh(true);
  }

  function login() {
    if (S.busy) return;
    if (S.cfg && S.cfg.devLogin) return devLogin();
    if (!window.NearLib) { GT.toast('Pustaka NEAR belum dimuat (jalankan build klien).'); return; }
    S.busy = true;
    var provider = new window.NearLib.JavascriptProvider({ network: 'testnet', clientId: S.cfg.fastAuth.clientId });
    var choose = lsGet(LS_FORCE) === '1';
    provider.login(undefined, choose)
      .then(function () { lsSet(LS_FORCE, null); return provider.client.getIdTokenClaims(); })
      .then(function (claims) {
        if (!claims || !claims.__raw) throw new Error('Login tidak memberi token');
        return finishLogin(claims.__raw, false, provider);
      })
      .catch(function (e) { GT.toast('Gagal masuk: ' + (e && e.message || e)); })
      .then(function () { S.busy = false; });
  }

  function devLogin() {
    var input = $('input'); input.type = 'text'; input.maxLength = 32; input.placeholder = 'nama (huruf kecil)';
    var body = $('div');
    body.appendChild($('p', null, 'Server ini memakai rantai tiruan (mock) dengan login pengembang. Ketik nama pemain:'));
    body.appendChild(input);
    GT.modal({ title: 'Masuk (dev, mock)', body: body, actions: [{ label: 'Masuk', primary: true, onClick: function (h) {
      var v = String(input.value || '').trim().toLowerCase();
      if (!/^[a-z0-9_-]{1,32}$/.test(v)) { GT.toast('Nama: huruf kecil, angka, - atau _'); return false; }
      h.close('ok'); S.busy = true;
      finishLogin('dev:' + v).catch(function (e) { GT.toast('Gagal masuk: ' + e.message); }).then(function () { S.busy = false; });
      return true;
    } }] });
    setTimeout(function () { input.focus(); }, 50);
  }

  /* ------------------------------------------------------------ state refresh + clock sync */
  function refresh(full) {
    if (S.mode === 'offline') { var d = OFF.load(); S.history = d.hist; redraw(); return Promise.resolve(); }
    var jobs = [api('/market').then(function (m) { S.market = m.merchants; })];
    if (S.account) {
      var sp = standPos();
      jobs.push(api('/state?x=' + sp.x + '&y=' + sp.y).then(function (st) { S.st = st; syncClock(st.time); followWorld(st.world); }));
      if (full || S.modal) jobs.push(api('/history').then(function (h) { S.history = h.history || []; }));
      if (full || (S.modal && S.modal.kind === 'shop')) jobs.push(api('/shops').then(function (s) { S.shops = s.shops; }));
      if (S.modal && S.modal.kind === 'project') jobs.push(api('/projects').then(function (r) { S.projects = r.projects || []; }));
      if (S.modal && S.modal.kind === 'market') jobs.push(api('/listings').then(function (l) { S.listings = l.listings || []; S.feeBps = l.feeBps; S.popular = l.popular || []; }), myTag());
    } else {
      jobs.push(api('/time').then(function (t) { syncClock(t); followWorld(t.world); S.weather = t.weather; }));
    }
    return Promise.all(jobs).then(function () { renderHud(); redraw(); renderGoals(); applyWeatherClass(); if (S.st && S.st.encounter && !(fightH && fightH.isOpen()) && !GT.isUiOpen()) openFight(); }).catch(function (e) {
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
    if (names.length) GT.toast('Proyek desa selesai! ' + names.join(', ') + ' sekarang terbuka.');
  }

  function syncClock(t) {
    // The server owns game time: 1 game day = 24 real minutes; keep the engine clock in step.
    if (GT.dayLength !== 24) GT.setDayLength(24);
    var m = Math.floor((t.fraction || 0) * 60);
    var cur = GT.time;
    var curMin = cur && cur.hour != null ? cur.hour * 60 + (cur.minute || 0) : -999;
    if (Math.abs(curMin - (t.hour * 60 + m)) > 3) GT.setTime(t.hour, m);
  }

  function schedulePoll() {
    clearTimeout(S.poll);
    S.poll = setTimeout(function () { refresh(false).then(schedulePoll); }, 5000);
  }

  // Where the player stands for the server's checks: the tile outdoors, or the door front of the building they are in.
  function standPos() {
    var sc = GT.scene, p = GT.player;
    if (sc && sc.kind !== 'out' && sc.house) return { x: sc.house.dx, y: sc.house.dy + 1 };
    return { x: p.x, y: p.y };
  }
  /* ---- Langkah pertama: a newcomer's next step, one at a time, ticked off by what they actually do ---- */
  var GOALS = [
    { id: 'signin', text: 'Tekan Masuk untuk membuat akunmu (Google atau email). Tanpa dompet, tanpa gas.' },
    { id: 'gather', text: 'Klik kolam, pohon atau batu (atau hadap lalu tekan F). Hasilnya masuk ke Tas.' },
    { id: 'sell', text: 'Jalan ke Pasar di timur rumahmu dan jual hasilmu ke Sari, Budi, Wati atau Joko.' },
    { id: 'board', text: 'Masuk ke Balai Desa di samping pasar dan lihat papan proyek di rak belakang.' }
  ];
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
    var next = GOALS.filter(function (g) { return !d[g.id]; })[0];
    var hidden = lsGet('gt.chain.goalsHidden') === '1';
    goalBox.style.display = !next || hidden || S.mode === 'offline' ? 'none' : '';
    if (!next) return;
    goalBox.textContent = '';
    var head = $('div', 'gt-goals-head');
    head.appendChild($('b', null, 'Langkah pertama · ' + (GOALS.indexOf(next) + 1) + '/' + GOALS.length));
    var x = $('button', 'gt-goals-x', 'Tutup'); x.type = 'button'; x.setAttribute('aria-label', 'Sembunyikan langkah pertama');
    x.addEventListener('click', function (e) { e.stopPropagation(); lsSet('gt.chain.goalsHidden', '1'); renderGoals(); });
    head.appendChild(x);
    goalBox.appendChild(head);
    goalBox.appendChild($('p', null, next.text));
  }

  /* ---- Night monsters (the server decides; this draws them and runs the fight window) ---- */
  var fightH = null;
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
  function roamers() {
    var st = S.st, L = GT.world && GT.world.layout;
    if (!st || !st.night || !st.night.now || st.night.guarded || !L || !window.GTVillage || !S.cfg || !S.cfg.monsters) return [];
    return GTVillage.monstersAt(L, st.time.totalHours, S.cfg.monsters.roaming);
  }
  function wander(m, t) { var h = 0; for (var i = 0; i < m.id.length; i++) h = (h * 31 + m.id.charCodeAt(i)) | 0; return { dx: Math.sin(t * 0.7 + h) * 0.45, dy: Math.cos(t * 0.5 + h * 1.3) * 0.35 }; }
  function onDraw(ctx, camX, camY, T) {
    var sc = GT.scene;
    if (!sc || sc.kind !== 'out') return;
    var t = performance.now() / 1000, e = S.st && S.st.encounter;
    roamers().forEach(function (m) {
      if (e && e.id === m.id) return;
      var w = wander(m, t);
      drawMonster(ctx, m.kind, Math.round((m.x + w.dx) * T - camX), Math.round((m.y + w.dy) * T - camY), t + m.x);
    });
    if (e) drawMonster(ctx, e.kind, e.x * T - camX, e.y * T - camY, t);
    drawWeather(ctx, T, t);
  }

  /* ---- Weather: the same day's weather for everyone (server state, from the shared village file) ---- */
  var flakes = null;
  // ?cuaca=hujan|salju|terik|berawan|cerah previews a look on this screen only (the server's weather is unchanged)
  var previewWeather = (/[?&]cuaca=(cerah|berawan|hujan|terik|salju)\b/.exec(location.search) || [])[1] || null;
  function weatherKind() { if (previewWeather) return previewWeather; var w = (S.st && S.st.weather) || S.weather; return w ? w.kind : null; }
  function applyWeatherClass() {
    var k = weatherKind(), root = document.documentElement;
    ['cerah', 'berawan', 'hujan', 'terik', 'salju'].forEach(function (x) { root.classList.toggle('gt-w-' + x, k === x && (!GT.scene || GT.scene.kind === 'out')); });
  }
  function drawWeather(ctx, T, t) {
    var k = weatherKind();
    if (k !== 'hujan' && k !== 'salju') return;
    var sx = ctx.getTransform().a || 1, W = ctx.canvas.width / sx, H = ctx.canvas.height / sx;
    var calm = document.documentElement.classList.contains('gt-reduced-motion');
    ctx.save();
    ctx.fillStyle = k === 'hujan' ? 'rgba(40,60,90,0.14)' : 'rgba(236,242,255,0.34)'; // grey rain light; snow-covered ground
    ctx.fillRect(0, 0, W, H);
    if (!flakes || flakes.k !== k) { flakes = { k: k, p: [] }; for (var i = 0; i < (k === 'hujan' ? 90 : 70); i++) flakes.p.push([Math.random(), Math.random(), 0.6 + Math.random() * 0.8]); }
    flakes.p.forEach(function (f) {
      var speed = calm ? 0 : (k === 'hujan' ? 1.6 : 0.18) * f[2];
      var y = ((f[1] + t * speed) % 1) * H, x = ((f[0] + (k === 'hujan' ? t * speed * 0.25 : Math.sin(t + f[0] * 9) * 0.01)) % 1) * W;
      if (k === 'hujan') { ctx.fillStyle = 'rgba(190,215,255,0.55)'; ctx.fillRect(Math.round(x), Math.round(y), 1, 4); }
      else { ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fillRect(Math.round(x), Math.round(y), f[2] > 1.1 ? 2 : 1, f[2] > 1.1 ? 2 : 1); }
    });
    ctx.restore();
  }
  function fightBody(e) {
    var wrap = $('div');
    var hp = ''; for (var i = 0; i < e.maxHp; i++) hp += i < e.hp ? '■ ' : '□ ';
    wrap.appendChild($('p', null, e.tile ? e.name + ' keluar dari ' + (e.tile === 'rock' ? 'celah batu' : 'balik pohon') + ' dan menghadang.' : e.name + ' menyerang di gelap hutan.'));
    wrap.appendChild($('p', 'num', 'Tenaganya: ' + hp.trim()));
    wrap.appendChild($('p', 'num', 'Energimu: ' + (S.st ? S.st.energy : '?') + '/' + (S.st ? S.st.energyMax : 100)));
    wrap.appendChild($('p', 'chain-dim', (e.tile ? 'Menang: kamu dapat hasilnya +1 bonus.' : 'Menang: ' + (e.kind === 'bat' ? 'kelelawar menjatuhkan 1 Bijih.' : 'babi hutan menjatuhkan 1 Kayu.')) + ' Energi habis: pingsan sampai pukul 06:00 (tidak ada barang yang hilang). Pos Ronda di Balai Desa membuat hutan aman.'));
    return wrap;
  }
  function openFight() {
    var e = S.st && S.st.encounter;
    if (!e) return;
    if (fightH && fightH.isOpen()) { fightH.setBody(fightBody(e)); return; }
    var cfg = S.cfg && S.cfg.monsters || {};
    fightH = GT.modal({ title: e.name + '!', body: fightBody(e), closable: false, actions: [
      { label: 'Lawan (−' + (cfg.fightEnergy || 6) + ' energi)', primary: true, onClick: function () { fightStep('fight'); return false; } },
      { label: 'Lari (−' + (cfg.fleeEnergy || 4) + ' energi)', onClick: function () { fightStep('flee'); return false; } }
    ] });
  }
  function fightStep(action) {
    if (S.busy) return;
    S.busy = true;
    act({ action: action }).then(function (r) {
      if (r && r.state && r.state.encounter) openFight();
      else if (fightH) { fightH.close('done'); fightH = null; }
      if (r && r.ko) knockedOut();
    }, noop).then(function () { S.busy = false; });
  }
  function knockedOut() {
    var sp = GT.world && GT.world.spawn;
    if (sp && GT.teleportPlayer) GT.teleportPlayer('out', sp.x, sp.y, 'down');
    GT.toast('Kamu pingsan. Warga membawamu pulang. Istirahat sampai pukul 06:00.');
  }

  function act(body, quiet) {
    if (S.mode === 'offline') {
      if (body.action === 'gather') { OFF.gather(TILE_ITEM[body.tile]); GT.toast('+1 ' + item(TILE_ITEM[body.tile]) + ' (offline)'); return Promise.resolve(); }
      GT.toast('Mode offline hanya mendukung mengumpulkan.'); return Promise.resolve();
    }
    if (!S.account) { GT.toast('Masuk dulu (tombol Masuk).'); return Promise.resolve(); }
    body.pos = standPos();
    return api('/act', { method: 'POST', body: body }).then(function (r) {
      S.st = r.state; renderHud(); redraw();
      if (body.action === 'gather' || body.action === 'sell') markGoal(body.action);
      if (!quiet) GT.toast(r.toast);
      return r;
    }).catch(function (e) { GT.toast(e.message); throw e; });
  }

  /* ------------------------------------------------------------ on-chain player actions (signed delegate -> relayer) */
  function b64(bytes) { var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }

  function signedCall(method, args, extra) {
    var L = window.NearLib, kp = sessionKey(), ready;
    if (S.mode === 'mock') ready = Promise.resolve({ nonce: BigInt(Date.now()), height: 0n });
    else {
      var prov = new L.JsonRpcProvider({ url: S.cfg.rpcUrl });
      ready = Promise.all([prov.viewAccessKey({ accountId: S.account, publicKey: kp.getPublicKey() }), prov.viewBlock({ finality: 'final' })])
        .then(function (r) { return { nonce: BigInt(r[0].nonce) + 1n, height: BigInt(r[1].header.height) }; });
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
      if (r && r.status === 'failed') throw new Error('Ditolak kontrak: ' + (r.error || ''));
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
        key: 'merchant:' + m.id, label: st ? null : m.tag, turns: false, noAffinity: true, lines: [['Mampir ke tokoku!']] });
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
      var n = GT.addNpc('out', { x: p[0], y: p[1], name: VNAMES[i % VNAMES.length], pal: 1 + (i % 6), wander: true, leash: 6, key: 'villager:' + i, lines: [['Pasar ramai hari ini!'], ['Harga ikan turun lagi, lho.'], ['Kebunmu tumbuh bagus!']] });
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
    if (GT.world.farm && GT.world.farm.plots.length) { S.plots = GT.world.farm.plots.slice(0, 6); return; }
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

  var pendingPlant = null;
  function farm(idx) {
    var p = S.st && S.st.plots[idx];
    if (!p) { GT.toast('Masuk dulu untuk bertani.'); return; }
    var op = p.state === 'empty' ? 'till' : p.state === 'tilled' ? 'plant' : p.state === 'ready' ? 'harvest' : 'water';
    // Planting spends 1 Gandum, so it needs a second press within 2 seconds.
    if (op === 'plant' && !(pendingPlant && pendingPlant.idx === idx && Date.now() - pendingPlant.t < 2000)) {
      pendingPlant = { idx: idx, t: Date.now() };
      GT.toast('Tekan ' + keyLabel() + ' sekali lagi untuk menanam (pakai 1 Gandum).');
      return;
    }
    pendingPlant = null;
    act({ action: 'farm', op: op, plot: idx });
  }

  /* ------------------------------------------------------------ context hint: which key does what here */
  function keyLabel() {
    // on a phone (or any touch screen) the interact control is the A button
    if (document.documentElement.classList.contains('gt-phone') || window.matchMedia('(pointer: coarse)').matches) return 'A';
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
    if (npc && npc.key && npc.key.indexOf('merchant:') === 0) return 'Buka toko ' + npc.name;
    if (npc) return 'Bicara dengan ' + npc.name;
    var tt = m.tiles[y * m.w + x];
    if (tt === 'stall') { var st1 = stallAt(x, y); if (st1 && st1.merchant) return 'Belanja di lapak ' + st1.merchant.charAt(0).toUpperCase() + st1.merchant.slice(1); }
    if (sc.house && sc.house.own && tt === 'table') return 'Meja Kerja (crafting)';
    if (sc.house && sc.house.own && tt === 'chest') return 'Kotak Kirim';
    if (sc.house && !sc.house.own && tt === 'chest') return 'Peti tetangga (terkunci)';
    if (sc.kind !== 'out') return null;
    var pi = plotAt(x, y);
    if (pi >= 0) {
      var p = S.st && S.st.plots[pi]; if (!p) return 'Petak kebun (masuk dulu)';
      if (p.state === 'empty') return 'Cangkul (−2 energi)';
      if (p.state === 'tilled') return 'Tanam gandum (1 Gandum, tekan 2x)';
      if (p.state === 'ready') return 'Panen gandum';
      return p.wateredToday ? 'Sudah disiram hari ini' : 'Siram (−2 energi)';
    }
    var tok = TILE_ITEM[tt];
    if (tok) {
      var verb = { fish: 'Mancing', ore: 'Nambang', wood: 'Tebang' }[tok];
      var needTool = tok === 'ore' && S.st && (S.st.bag.tool.settled + S.st.bag.tool.today) < 1;
      var L = GT.world && GT.world.layout, night = S.st && S.st.night;
      var danger = tok !== 'fish' && night && night.now && !night.guarded && L && window.GTVillage && GTVillage.chunkOf(L, x, y).id === 'hutan';
      return verb + ' (−4 energi)' + (needTool ? ' · butuh Alat' : '') + (danger ? ' · malam: awas monster' : '');
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
      if (p.state === 'empty') { ctx.fillStyle = 'rgba(214,170,110,.55)'; ctx.fillRect(x + 1, y + 1, T - 2, T - 2); return; }
      if (p.state === 'planted' && p.wateredToday) { ctx.fillStyle = 'rgba(30,20,40,.28)'; ctx.fillRect(x, y, T, T); }
      if (p.state === 'planted') {
        var h = 2 + p.grown * 2;
        ctx.fillStyle = '#2f7d3a'; ctx.fillRect(x + 2, y + T - 2 - h, 2, h); ctx.fillRect(x + 6, y + T - 3 - h, 2, h + 1); ctx.fillRect(x + 9, y + T - 2 - h, 1, h);
        ctx.fillStyle = '#7cc23e'; ctx.fillRect(x + 2, y + T - 2 - h, 1, 1); ctx.fillRect(x + 6, y + T - 3 - h, 1, 1);
      } else if (p.state === 'ready') {
        ctx.fillStyle = '#c99a2e'; ctx.fillRect(x + 2, y + 3, 2, 8); ctx.fillRect(x + 6, y + 2, 2, 9); ctx.fillRect(x + 9, y + 4, 2, 7);
        ctx.fillStyle = '#f2d24a'; ctx.fillRect(x + 2, y + 2, 2, 3); ctx.fillRect(x + 6, y + 1, 2, 3); ctx.fillRect(x + 9, y + 3, 2, 3);
      }
    });
  }

  /* ------------------------------------------------------------ modals */
  function reasonLine(it) {
    var arrow = it.changePct > 0 ? '▲' : it.changePct < 0 ? '▼' : '•';
    var r = $('div', 'chain-reason', arrow + ' ' + it.reason);
    return r;
  }

  function shopBody(id) {
    var wrap = $('div');
    var m = (S.market || []).filter(function (x) { return x.id === id; })[0];
    if (!m) { wrap.appendChild($('p', null, 'Memuat…')); return wrap; }
    var cash = $('p', 'chain-dim', 'Kas ' + m.name + ': ' + m.cash + ' koin · sewa ' + m.rent + '/hari · cukup untuk ' + Math.floor(m.cash / m.rent) + ' hari');
    wrap.appendChild(cash);
    if (!m.open) return restoreBody(id, m, wrap);
    m.items.forEach(function (it) {
      var row = $('div', 'mrow chain-item');
      var info = $('div', 'grow');
      info.appendChild($('div', null, it.name + '  (stok ' + it.stock + '/' + it.target + ')'));
      var prices = [];
      if (it.bid != null) prices.push('beli darimu ' + it.bid);
      if (it.ask != null) prices.push('jual ' + it.ask);
      info.appendChild($('div', 'num', prices.join(' · ') + ' koin'));
      var rl = reasonLine(it); info.appendChild(rl); info.title = it.reason;
      row.appendChild(info);
      var mine = S.st ? S.st.bag[it.token].settled + S.st.bag[it.token].today : 0;
      if (it.bid != null) {
        row.appendChild(button('Jual 1', function () { act({ action: 'sell', merchant: id, token: it.token, qty: 1 }).then(refreshModal, noop); }));
        if (mine >= 5) row.appendChild(button('Jual 5', function () { act({ action: 'sell', merchant: id, token: it.token, qty: 5 }).then(refreshModal, noop); }));
      }
      if (it.ask != null) row.appendChild(button('Beli 1', function () { act({ action: 'buy', merchant: id, token: it.token, qty: 1 }).then(refreshModal, noop); }, 'primary'));
      wrap.appendChild(row);
    });
    wrap.appendChild($('p', 'chain-dim', 'Jual-beli langsung (off-chain) dan masuk settlement pukul 06:00. Harga diperbarui tiap jam game.'));
    holdingLine(id, wrap);
    if (S.account) wrap.appendChild(button('Ngobrol dengan ' + m.name, function () { talkTo(id, m.name); }));
    return wrap;
  }

  // Ask a merchant something. The answer uses the shop's real prices (NEAR AI Cloud when the server has a key,
  // otherwise a line built from the same facts). Chat never moves items or coins.
  function talkTo(id, name) {
    var body = $('div'), log = $('div', 'chain-talk');
    function add(who, text, cls) { var p = $('p', cls || null); p.appendChild($('b', null, who + ': ')); p.appendChild(document.createTextNode(text)); log.appendChild(p); log.scrollTop = log.scrollHeight; }
    add(name, 'Halo! Mau tanya apa? Harga, stok, atau kenapa harga berubah?');
    var input = $('input'); input.type = 'text'; input.maxLength = 200; input.placeholder = 'mis. "kenapa harga ikan turun?"';
    body.appendChild(log); body.appendChild(input);
    body.appendChild($('p', 'chain-dim', S.cfg && S.cfg.dialogue === 'nearai'
      ? 'Jawaban dari NEAR AI Cloud (inferensi privat) berdasarkan harga asli toko. Obrolan tidak bisa memindahkan barang atau koin.'
      : 'Jawaban disusun dari harga asli toko. (NEAR AI Cloud belum aktif di server ini.)'));
    var waiting = false;
    function ask() {
      var t = String(input.value || '').trim();
      if (!t || waiting) return;
      input.value = ''; add('Kamu', t, 'me'); waiting = true;
      var dots = $('p', 'chain-dim', name + ' sedang berpikir…'); log.appendChild(dots);
      api('/talk', { method: 'POST', body: { merchant: id, text: t } }).then(function (r) {
        add(name, r.line, r.source === 'nearai' ? 'ai' : null);
      }, function (e) { add(name, e.message); }).then(function () { waiting = false; if (dots.parentNode) dots.parentNode.removeChild(dots); input.focus(); });
    }
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); ask(); } });
    GT.modal({ title: 'Ngobrol: ' + name, body: body, actions: [{ label: 'Tanya', primary: true, onClick: function () { ask(); return false; } }] });
    setTimeout(function () { input.focus(); }, 50);
  }

  function holdingLine(id, wrap) {
    var s = (S.shops || []).filter(function (x) { return x.id === id; })[0];
    if (!s || !s.holding || s.holding.shares === '0') return;
    var p = $('p', 'chain-dim', 'Sahammu: ' + s.holding.shares + ' dari ' + s.holding.total_shares + ' · dividen siap diambil: ' + s.holding.claimable + ' koin');
    wrap.appendChild(p);
    if (s.holding.claimable !== '0') wrap.appendChild(button('Ambil dividen (on-chain)', function () {
      GT.toast('Mengambil dividen…');
      signedCall('claim_dividends', { merchant: s.account_id }).then(function () { GT.toast('Dividen masuk!'); refreshModal(); }, function (e) { GT.toast(e.message); });
    }, 'primary'));
  }

  var WHERE = { fish: 'mancing di kolam atau sungai', wood: 'tebang pohon', ore: 'nambang di Tambang Utara (butuh Alat)', wheat: 'tanam di kebunmu', bread: 'Meja Kerja: 2 Gandum', meal: 'Meja Kerja: Ikan + Kayu', tool: 'Meja Kerja: 2 Bijih + Kayu', coin: 'jual ke pedagang yang buka, atau Kotak Kirim di rumahmu' };
  function restoreBody(id, m, wrap) {
    var s = (S.shops || []).filter(function (x) { return x.id === id; })[0];
    wrap.appendChild($('p', 'chain-closed', 'TUTUP. ' + m.name + ' tidak sanggup membayar sewa.'));
    if (!s) { wrap.appendChild($('p', null, 'Memuat papan pemulihan…')); return wrap; }
    wrap.appendChild($('p', null, 'Bantu buka lagi: lengkapi semua baris di bawah. Penyumbang mendapat saham dan bagian keuntungan toko.'));
    var lines = [], allDone = true;
    s.need.forEach(function (n) {
      var got = 0; (s.pledged || []).forEach(function (p) { if (p.token_id === n.token_id) got = +p.amount; });
      var missing = Math.max(0, +n.amount - got), have = spendable(n.token_id);
      var row = $('div', 'mrow chain-item');
      var info = $('div', 'grow');
      info.appendChild($('div', null, item(n.token_id) + ': ' + got + '/' + n.amount));
      if (missing === 0) info.appendChild($('div', 'chain-done', 'Lengkap'));
      else {
        allDone = false;
        info.appendChild($('div', 'num', 'Kurang ' + missing + ' · kamu punya ' + have + (have < missing ? ' · cari: ' + (WHERE[n.token_id] || '') : '')));
      }
      row.appendChild(info);
      wrap.appendChild(row);
      if (missing > 0 && have > 0) lines.push({ token_id: n.token_id, amount: String(Math.min(missing, have)) });
    });
    if (s.contributors) wrap.appendChild($('p', 'chain-dim', s.contributors + ' penyumbang sejauh ini.'));
    if (lines.length) {
      var label = 'Sumbang ' + lines.map(function (l) { return l.amount + ' ' + item(l.token_id); }).join(' + ') + ' (on-chain)';
      wrap.appendChild(button(label, function () {
        GT.toast('Mengirim sumbangan…');
        signedCall('restore_contribute', { merchant: s.account_id, contribution: lines })
          .then(function () { GT.toast('Terima kasih! Sumbanganmu tercatat on-chain.'); refreshModal(); }, function (e) { GT.toast(e.message); });
      }, 'primary'));
    } else if (!allDone) {
      wrap.appendChild($('p', 'chain-dim', 'Kamu belum punya barang yang masih kurang (barang hari ini bisa disumbang setelah pukul 06:00). Kalau semua toko tutup, dana desa ikut menyumbang koinnya pada penyelesaian pukul 06:00.'));
    }
    return wrap;
  }

  /* ---- Papan Proyek Desa (Balai Desa): pooled goods and coin build things that open new areas (on-chain) ---- */
  function spendable(t) { var b = S.st && S.st.bag[t]; return b ? Math.max(0, Math.min(b.settled, b.settled + b.today)) : 0; }
  function projectBody() {
    var wrap = $('div');
    wrap.appendChild($('p', null, 'Warga mengumpulkan bahan bersama. Saat semua baris terpenuhi, bahan dipakai (dibakar on-chain) dan bagian peta baru terbuka untuk semua pemain.'));
    if (!S.projects) { wrap.appendChild($('p', null, 'Memuat…')); return wrap; }
    if (!S.projects.length) wrap.appendChild($('p', 'chain-dim', 'Belum ada proyek.'));
    S.projects.forEach(function (pj) {
      wrap.appendChild($('h4', 'chain-h', pj.name + (pj.done ? ' (selesai)' : '')));
      var lines = [];
      pj.need.forEach(function (n) {
        var got = 0; pj.pledged.forEach(function (p) { if (p.token_id === n.token_id) got = +p.amount; });
        var missing = Math.max(0, +n.amount - got), have = spendable(n.token_id);
        var row = $('div', 'mrow');
        row.appendChild($('span', 'grow', item(n.token_id) + ': ' + got + '/' + n.amount));
        if (!pj.done) row.appendChild($('span', 'num', 'bisa kamu sumbang ' + Math.min(missing, have)));
        wrap.appendChild(row);
        if (!pj.done && missing > 0 && have > 0) lines.push({ token_id: n.token_id, amount: String(Math.min(missing, have)) });
      });
      var names = pj.contributors.map(function (c) { return c.account_id === S.account ? 'kamu' : String(c.account_id).split('.')[0]; });
      wrap.appendChild($('p', 'chain-dim', pj.done ? 'Dibangun oleh ' + names.join(', ') + '.' : (names.length ? 'Penyumbang: ' + names.join(', ') + '.' : 'Belum ada penyumbang. Jadilah yang pertama!')));
      if (pj.done) return;
      var mine = pj.contributors.filter(function (c) { return c.account_id === S.account; })[0];
      if (lines.length) wrap.appendChild(button('Sumbang semua yang bisa (on-chain)', function () {
        GT.toast('Mengirim sumbangan…');
        signedCall('project_contribute', { id: pj.id, contribution: lines }).then(function () { GT.toast('Terima kasih! Sumbanganmu tercatat on-chain.'); refreshModal(); }, function (e) { GT.toast(e.message); });
      }, 'primary'));
      if (mine) wrap.appendChild(button('Tarik sumbanganku', function () {
        signedCall('project_withdraw', { id: pj.id }).then(function () { GT.toast('Sumbangan dikembalikan ke tasmu.'); refreshModal(); }, function (e) { GT.toast(e.message); });
      }));
    });
    wrap.appendChild($('p', 'chain-dim', 'Sumbangan memakai barang yang sudah di rantai (settled) dan belum terpakai hari ini. Bisa ditarik lagi selama proyek belum selesai.'));
    return wrap;
  }

  function bagBody() {
    var wrap = $('div');
    if (S.account) wrap.appendChild($('p', 'chain-dim', 'Akun: ' + S.account));
    if (S.mode === 'offline') {
      var d = OFF.load();
      Object.keys(d.bal).forEach(function (t) { var r = $('div', 'mrow'); r.appendChild($('span', 'grow', item(t))); r.appendChild($('span', 'num', String(d.bal[t]))); wrap.appendChild(r); });
      return wrap;
    }
    if (!S.st) { wrap.appendChild($('p', null, 'Memuat…')); return wrap; }
    Object.keys(S.st.bag).forEach(function (t) {
      var b = S.st.bag[t];
      if (!b.settled && !b.today) return;
      var row = $('div', 'mrow');
      row.appendChild($('span', 'grow', b.name));
      var n = $('span', 'num', String(b.settled + b.today));
      if (b.today) n.appendChild($('span', 'chain-today', ' (' + (b.today > 0 ? '+' : '') + b.today + ' hari ini)'));
      row.appendChild(n);
      var e = S.cfg.econ.items[t];
      if (e && e.energy) row.appendChild(button('Makan', function () { act({ action: 'eat', token: t }).then(refreshModal, noop); }));
      if (t !== 'coin' && b.settled > 0) row.appendChild(button('Kirim', function () { askSend(t); }));
      wrap.appendChild(row);
    });
    wrap.appendChild($('p', 'chain-dim', 'Satu tas untuk semua barangmu. Angka besar = semua yang kamu punya. "+n hari ini" = didapat atau dipakai hari ini; tercatat di NEAR saat penyelesaian pukul 06:00. Kirim dan Pasar Pemain memakai barang yang sudah tercatat.'));
    wrap.appendChild($('p', 'chain-dim', 'Alat: ' + S.st.tool.uses + '/' + S.st.tool.durability + ' pemakaian.'));
    wrap.appendChild(button('Keluar (ganti akun)', function () { signOut(); }));
    return wrap;
  }

  function askSend(token) {
    var body = $('div');
    body.appendChild($('p', null, 'Kirim 1 ' + item(token) + ' ke pemain lain. Langsung on-chain, tanpa dompet, tanpa gas.'));
    var input = $('input'); input.type = 'text'; input.placeholder = 'akun penerima (…players…testnet)'; input.maxLength = 64;
    body.appendChild(input);
    GT.modal({ title: 'Kirim ' + item(token), body: body, actions: [{ label: 'Kirim', primary: true, onClick: function (h) {
      var to = String(input.value || '').trim().toLowerCase();
      if (!/^[a-z0-9._-]{2,64}$/.test(to)) { GT.toast('Nama akun tidak valid'); return false; }
      h.close('ok'); GT.toast('Mengirim…');
      signedCall('send_item', { receiver_id: to, token_id: token, amount: '1' }).then(function () { GT.toast('Terkirim!'); }, function (e) { GT.toast('Gagal: ' + e.message); });
      return true;
    } }] });
    setTimeout(function () { input.focus(); }, 50);
  }

  function craftBody() {
    var wrap = $('div');
    wrap.appendChild($('p', null, 'Meja kerja. Setiap resep memakai bahan dari tasmu dan biaya 2 koin.'));
    Object.keys(S.cfg.econ.recipes).forEach(function (id) {
      var r = S.cfg.econ.recipes[id];
      var row = $('div', 'mrow');
      row.appendChild($('span', 'grow', item(r.output) + ' ← ' + Object.keys(r.inputs).map(function (t) { return r.inputs[t] + ' ' + item(t); }).join(' + ')));
      row.appendChild(button('Buat', function () { act({ action: 'craft', recipe: id }).then(refreshModal, noop); }, 'primary'));
      wrap.appendChild(row);
    });
    return wrap;
  }

  function shipBody() {
    var wrap = $('div');
    wrap.appendChild($('p', null, 'Kotak Kirim: barang dijual ke kota pukul 06:00 seharga 70% harga dasar. Praktis, tapi pedagang biasanya membayar lebih.'));
    if (!S.st) return wrap;
    Object.keys(S.st.bag).forEach(function (t) {
      if (t === 'coin') return;
      var b = S.st.bag[t], n = b.settled + b.today;
      if (n <= 0) return;
      var row = $('div', 'mrow');
      row.appendChild($('span', 'grow', b.name + ' (' + n + ')'));
      row.appendChild(button('Kirim 1', function () { act({ action: 'ship', token: t, qty: 1 }).then(refreshModal, noop); }));
      if (n >= 5) row.appendChild(button('Kirim 5', function () { act({ action: 'ship', token: t, qty: 5 }).then(refreshModal, noop); }));
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
    GT.toast('Mengirim ke chain…');
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
    info.appendChild($('div', null, l.amount + ' ' + item(l.token_id) + ' · ' + l.price_each + ' koin/buah'));
    var ba = bestAsk(l.token_id);
    var who = l.anonymous ? (isMine(l) ? 'Penjual: kamu (anonim)' : 'Penjual: tidak diketahui') : 'Dari ' + (isMine(l) ? 'kamu' : shortAcc(l.seller)) + ' · ' + (l.title || 'Pedagang baru') + ' (' + (l.popularity || 0) + ' poin)';
    info.appendChild($('div', 'chain-dim', who + (ba ? ' · pedagang termurah ' + ba.ask : '')));
    row.appendChild(info);
    if (isMine(l)) {
      row.appendChild(button('Tarik', function () { marketCall('cancel_listing', { listing_id: l.id }, 'Barangmu ditarik dan kembali ke tas.').then(refreshModal); }));
    } else {
      row.appendChild(button('Beli 1', function () { marketCall('buy_listing', { listing_id: l.id, amount: '1', max_price_each: String(l.price_each) }, 'Terbeli!').then(refreshModal); }, 'primary'));
      if (+l.amount > 1) row.appendChild(button('Beli ' + l.amount, function () { marketCall('buy_listing', { listing_id: l.id, amount: String(l.amount), max_price_each: String(l.price_each) }, 'Terbeli!').then(refreshModal); }));
    }
    return row;
  }
  function marketBody() {
    var wrap = $('div');
    var tab = S.marketTab || 'lapak';
    var tabs = $('div', 'gt-tabs'); tabs.setAttribute('role', 'tablist');
    [['lapak', 'Lapak'], ['gelap', 'Pasar Gelap'], ['populer', 'Populer']].forEach(function (t) {
      var b = button(t[1], function () { S.marketTab = t[0]; redraw(); }, tab === t[0] ? 'primary' : '');
      b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', tab === t[0] ? 'true' : 'false');
      tabs.appendChild(b);
    });
    wrap.appendChild(tabs);
    if (!S.listings) { wrap.appendChild($('p', null, 'Memuat…')); return wrap; }
    if (tab === 'lapak') {
      wrap.appendChild($('p', null, 'Lapak pemain: namamu tampil, dan setiap barang yang terjual menambah popularitasmu. Tidak perlu punya toko.'));
      var named = S.listings.filter(function (l) { return !l.anonymous; });
      if (!named.length) wrap.appendChild($('p', 'chain-dim', 'Belum ada lapak. Jadilah yang pertama!'));
      named.forEach(function (l) { wrap.appendChild(listingRow(l)); });
    } else if (tab === 'gelap') {
      wrap.appendChild($('p', null, 'Pasar Gelap: jual tanpa nama. Pembeli tidak tahu siapa penjualnya, tapi kamu juga tidak dapat popularitas. Anonim di dalam game saja: transaksi di rantai tetap publik.'));
      var anon = S.listings.filter(function (l) { return l.anonymous; });
      if (!anon.length) wrap.appendChild($('p', 'chain-dim', 'Pasar Gelap sedang sepi.'));
      anon.forEach(function (l) { wrap.appendChild(listingRow(l)); });
    } else {
      wrap.appendChild($('p', null, 'Pedagang terpopuler: satu poin untuk setiap barang yang terjual dari Lapak.'));
      if (!(S.popular || []).length) wrap.appendChild($('p', 'chain-dim', 'Belum ada penjualan di Lapak.'));
      (S.popular || []).forEach(function (p, i) {
        var row = $('div', 'mrow');
        row.appendChild($('span', 'num', (i + 1) + '.'));
        row.appendChild($('span', 'grow', (p.account === S.account ? 'Kamu' : shortAcc(p.account)) + ' · ' + p.title));
        row.appendChild($('span', 'num', p.points + ' poin · ' + p.sales + ' penjualan'));
        wrap.appendChild(row);
      });
      return wrap;
    }
    wrap.appendChild($('h4', 'chain-h', tab === 'gelap' ? 'Jual tanpa nama' : 'Jual di Lapak'));
    var mine = S.listings.filter(isMine).length;
    var any = false;
    if (S.st) Object.keys(S.st.bag).forEach(function (t) {
      if (t === 'coin') return;
      var can = spendable(t);
      if (can <= 0) return;
      any = true;
      var row = $('div', 'mrow');
      row.appendChild($('span', 'grow', item(t) + ' (bisa dijual ' + can + ')'));
      if (mine < 5) row.appendChild(button('Pasang', function () { askList(t, can, tab === 'gelap'); }));
      wrap.appendChild(row);
    });
    if (!any) wrap.appendChild($('p', 'chain-dim', 'Belum ada barang yang bisa dijual di sini.'));
    wrap.appendChild($('p', 'chain-dim', 'Barang hari ini bisa dijual setelah pukul 06:00. Maks 5 barang dipasang per pemain. Setiap penjualan membakar ' + feePct() + '% dari harga. Langsung on-chain, tanpa dompet dan tanpa gas.'));
    return wrap;
  }

  function askList(token, max, anonymous) {
    var body = $('div');
    var bb = bestBid(token), ba = bestAsk(token);
    var base = (S.cfg.econ.items[token] || {}).base || 1;
    body.appendChild($('p', null, 'Jual ' + item(token) + ' ke pemain lain.'));
    body.appendChild($('p', 'chain-dim', (bb ? 'Pedagang membeli paling mahal ' + bb.bid + ' (' + bb.name + '). ' : '') + (ba ? 'Pedagang menjual paling murah ' + ba.ask + ' (' + ba.name + ').' : '')));
    var qty = $('input'); qty.type = 'number'; qty.min = '1'; qty.max = String(Math.min(50, max)); qty.value = String(Math.min(max, 5));
    var price = $('input'); price.type = 'number'; price.min = '1'; price.max = '100000';
    price.value = String(ba ? Math.max(1, ba.ask - 1) : Math.max(1, Math.round(base)));
    var l1 = $('label', 'chain-field', 'Jumlah '); l1.appendChild(qty);
    var l2 = $('label', 'chain-field', 'Harga/buah '); l2.appendChild(price);
    var side = $('div', 'mseg'); side.setAttribute('role', 'radiogroup');
    [['lapak', 'Lapak (namamu tampil, dapat popularitas)'], ['gelap', 'Pasar Gelap (tanpa nama, tanpa popularitas)']].forEach(function (o) {
      var lab = $('label'), rb = $('input'); rb.type = 'radio'; rb.name = 'gt-side'; rb.value = o[0]; rb.checked = (o[0] === 'gelap') === !!anonymous;
      lab.appendChild(rb); lab.appendChild($('span', null, o[1])); side.appendChild(lab);
    });
    var net = $('p', 'chain-dim');
    function upd() { var t = (+qty.value || 0) * (+price.value || 0); net.textContent = 'Kalau semua terjual kamu terima ' + (t - Math.floor(t * (S.feeBps != null ? S.feeBps : 500) / 10000)) + ' koin.'; }
    qty.addEventListener('input', upd); price.addEventListener('input', upd); upd();
    body.appendChild(l1); body.appendChild(l2); body.appendChild(side); body.appendChild(net);
    GT.modal({ title: 'Jual ' + item(token), body: body, actions: [{ label: 'Pasang', primary: true, onClick: function (h) {
      var q = Math.floor(+qty.value), pr = Math.floor(+price.value);
      var anon = !!(side.querySelector('input:checked') || {}).value && side.querySelector('input:checked').value === 'gelap';
      if (!(q >= 1 && q <= Math.min(50, max))) { GT.toast('Jumlah 1–' + Math.min(50, max)); return false; }
      if (!(pr >= 1 && pr <= 100000)) { GT.toast('Harga 1–100000'); return false; }
      h.close('ok');
      S.marketTab = anon ? 'gelap' : 'lapak';
      GT.toast('Mengirim ke chain…');
      signedCall('list_item', { token_id: token, amount: String(q), price_each: String(pr) }, { anonymous: anon })
        .then(function () { GT.toast(anon ? 'Dipasang di Pasar Gelap.' : 'Dipasang di Lapak.'); open('market'); }, function (e) { GT.toast(e.message); });
      return true;
    } }] });
    setTimeout(function () { price.focus(); price.select(); }, 50);
  }

  var ST_LABEL = { pending: '…', ok: '✓', failed: '✗', mock: 'mock', offchain: 'menunggu settlement' };
  function historyBody() {
    var wrap = $('div');
    if (!S.history.length) wrap.appendChild($('p', null, 'Belum ada transaksi.'));
    S.history.forEach(function (h) {
      var row = $('div', 'mrow');
      var t = new Date(h.created_at);
      row.appendChild($('span', 'num', ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2)));
      row.appendChild($('span', 'grow', h.summary));
      row.appendChild($('span', 'chain-st ' + h.status, ST_LABEL[h.status] || h.status));
      if (h.tx_hash && S.mode === 'testnet') {
        var a = $('a', 'chain-link', 'lihat ↗'); a.href = S.cfg.explorerTxUrl + encodeURIComponent(h.tx_hash); a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = h.tx_hash;
        row.appendChild(a);
      }
      wrap.appendChild(row);
    });
    if (S.st) wrap.appendChild($('p', 'chain-dim', 'Settlement terakhir: hari ' + S.st.time.settledThrough + '. Berikutnya pukul 06:00 (hari ' + (S.st.time.day + (S.st.time.hour >= 6 ? 1 : 0)) + ').'));
    return wrap;
  }

  var BODIES = { bag: bagBody, history: historyBody, craft: craftBody, ship: shipBody, market: marketBody, project: projectBody };
  function open(kind, arg) {
    if (S.mode !== 'offline' && !S.account && kind !== 'shop') { login(); return; }
    if (kind === 'project') markGoal('board');
    var title = kind === 'bag' ? 'Tas' : kind === 'market' ? 'Pasar Pemain' : kind === 'project' ? 'Papan Proyek Desa' : kind === 'history' ? 'Riwayat' : kind === 'craft' ? 'Meja Kerja' : kind === 'ship' ? 'Kotak Kirim' : (MERCHANTS.filter(function (m) { return m.id === arg; })[0] || {}).tag;
    var body = kind === 'shop' ? shopBody(arg) : BODIES[kind]();
    var h = GT.modal({ title: title, wide: kind === 'history' || kind === 'shop' || kind === 'market' || kind === 'project', body: body, onClose: function () { S.modal = null; } });
    S.modal = { kind: kind, arg: arg, h: h };
    refresh(true);
  }
  function redraw() {
    if (!S.modal || !S.modal.h || !S.modal.h.isOpen()) return;
    S.modal.h.setBody(S.modal.kind === 'shop' ? shopBody(S.modal.arg) : BODIES[S.modal.kind]());
  }
  function refreshModal() { return refresh(true); }
  function noop() {}

  /* ------------------------------------------------------------ engine hooks */
  function onInteract(ctx) {
    if (ctx.mode !== 'talk') return false;
    if (ctx.npc && ctx.npc.key && ctx.npc.key.indexOf('merchant:') === 0) { open('shop', ctx.npc.key.slice(9)); return true; }
    // The prototype's mart keepers sold for local play coins; the town's shops are now the four merchants.
    if (ctx.npc && ctx.npc.key && /:keeper$/.test(ctx.npc.key)) { GT.toast('Mart sudah pindah: belanja di pasar dekat rumahmu (Sari, Budi, Wati, Joko).'); return true; }
    if (ctx.npc || ctx.door) return false;
    if (ctx.tileType === 'stall') { var st0 = stallAt(ctx.tile.x, ctx.tile.y); if (st0 && st0.merchant) { open('shop', st0.merchant); return true; } }
    var house = ctx.scene.house, own = house && house.own, board = ctx.scene.map && ctx.scene.map.board;
    if (house && board && ctx.tile.x === board.x && ctx.tile.y === board.y && S.mode !== 'offline') {
      if (house.kind === 'hall') { open('project'); return true; }
      if (house.kind === 'broker') { open('market'); return true; }
    }
    if (own && (ctx.tileType === 'table' || ctx.tileType === 'chest')) {
      if (S.mode !== 'offline' && !S.account) { GT.toast('Masuk dulu (tombol Masuk) untuk memakai ' + (ctx.tileType === 'table' ? 'Meja Kerja.' : 'Kotak Kirim.')); return true; }
      open(ctx.tileType === 'table' ? 'craft' : 'ship'); return true;
    }
    if (house && !own && ctx.tileType === 'chest') {
      GT.toast('Peti milik ' + (house.owner || 'tetangga') + ', terkunci. Kotak Kirim-mu ada di peti rumahmu sendiri.');
      return true;
    }
    if (ctx.scene.kind !== 'out') return false;
    var pi = plotAt(ctx.tile.x, ctx.tile.y);
    if (pi >= 0) { farm(pi); return true; }
    var token = TILE_ITEM[ctx.tileType];
    if (!token) return false;
    if (S.busy) return true;
    S.busy = true;
    act({ action: 'gather', tile: ctx.tileType, x: ctx.tile.x, y: ctx.tile.y }).then(function () { if (S.st && S.st.encounter) openFight(); }, noop).then(function () { S.busy = false; });
    return true;
  }

  function onWorld() { S.npcs = {}; placeMerchants(); findPlots(); spawnVillagers(); }

  function init() {
    accBtn = GT.addHudButton({ id: 'chainbtn', label: 'Masuk', key: 'N', secondary: false, onClick: function () { open('bag'); } });
    GT.addHudButton({ id: 'riwayatbtn', label: 'Riwayat', key: 'H', onClick: function () { open('history'); } });
    GT.addHudButton({ id: 'pasarbtn', label: 'Pasar', key: 'K', onClick: function () { if (S.mode === 'offline') GT.toast('Pasar Pemain butuh server game.'); else open('market'); } });
    // The old local bag (play items) is replaced by the NEAR bag: hide its button and point the I key here.
    var oldBag = document.getElementById('bagbtn'); if (oldBag) oldBag.style.display = 'none';
    GT.hotkey('I', function () { open('bag'); });
    var forceOffline = /[?&]mode=offline\b/.test(location.search) || location.protocol === 'file:';
    var cfgP = forceOffline ? Promise.reject(new Error('offline')) :
      Promise.race([api('/config'), new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, 4000); })]);
    cfgP.then(function (cfg) {
      S.cfg = cfg; S.mode = cfg.chainMode === 'mock' ? 'mock' : 'testnet';
      // One shared world: the server's seed and the chunks opened by town projects.
      if (cfg.world && GT.setWorld) GT.setWorld(cfg.world.seed, cfg.world.unlocked);
      S.account = lsGet(LS_ACC);
      if (S.account && lsGet(LS_KEY) && !keyRing()[S.account] && window.NearLib) { try { keepKey(S.account, window.NearLib.KeyPair.fromString(lsGet(LS_KEY))); } catch (e) { /* bad key */ } }
      if (cfg.devTools) GT.addDevSection('NEAR settlement', function (sec) {
        sec.appendChild($('p', 'mnote', 'Lompat ke pukul 06:00 berikutnya dan tulis hari ini ke chain sekarang.'));
        sec.appendChild(button('Settle sekarang', function () {
          GT.toast('Settlement berjalan…');
          api('/dev/settle', { method: 'POST' }).then(function (r) { GT.toast('Settled sampai hari ' + r.settledThrough); refresh(true); }, function (e) { GT.toast(e.message); });
        }, 'primary'));
        sec.appendChild($('p', 'mnote', 'Lompat ke pukul 20:00 berikutnya: monster muncul di Hutan Utara pada malam hari.'));
        sec.appendChild(button('Lompat ke malam', function () {
          api('/dev/night', { method: 'POST' }).then(function () { GT.toast('Sekarang malam.'); refresh(true); }, function (e) { GT.toast(e.message); });
        }));
      });
    }).catch(function () { S.mode = 'offline'; }).then(function () {
      renderBanner(); return refresh(true);
    }).then(schedulePoll);
    renderBanner();
  }

  window.GT_CHAIN = { state: S, refresh: refresh, login: login, signOut: signOut, open: open, act: act, askSend: askSend, askList: askList, spendable: spendable, plotAt: plotAt, _signedCall: signedCall };
  GT.register({ id: 'chain', init: init, onWorld: onWorld, onInteract: onInteract, onDrawGround: onDrawGround, onDraw: onDraw, onFrame: onFrame });
})();
