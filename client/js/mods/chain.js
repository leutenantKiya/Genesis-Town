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
    if (accBtn) accBtn.textContent = S.account || S.mode === 'offline' ? 'Tas NEAR' : 'Masuk';
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
    v.appendChild(document.createTextNode(' ' + st.energy + ' · ' + SEASON[st.time.season] + ' H' + st.time.dayOfSeason));
    hudCell.appendChild(v);
    // The engine's coin counter mirrors your NEAR coin (settled + today).
    var coin = st.bag.coin.settled + st.bag.coin.today;
    var delta = coin - GT.state.coins;
    if (delta !== 0) GT.addCoins(delta);
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
        GT.toast(r.created ? 'Akun dibuat! Paket awal: 100 koin, 1 Alat, 3 Roti, 3 Gandum.' : 'Selamat datang kembali!');
        return refresh(true);
      });
  }

  function login() {
    if (S.busy) return;
    if (S.cfg && S.cfg.devLogin) return devLogin();
    if (!window.NearLib) { GT.toast('Pustaka NEAR belum dimuat (jalankan build klien).'); return; }
    S.busy = true;
    var provider = new window.NearLib.JavascriptProvider({ network: 'testnet', clientId: S.cfg.fastAuth.clientId });
    provider.login()
      .then(function () { return provider.client.getIdTokenClaims(); })
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
      jobs.push(api('/state').then(function (st) { S.st = st; syncClock(st.time); }));
      if (full || S.modal) jobs.push(api('/history').then(function (h) { S.history = h.history || []; }));
      if (full || (S.modal && S.modal.kind === 'shop')) jobs.push(api('/shops').then(function (s) { S.shops = s.shops; }));
    } else {
      jobs.push(api('/time').then(function (t) { syncClock(t); }));
    }
    return Promise.all(jobs).then(function () { renderHud(); redraw(); }).catch(function (e) {
      if (e.status === 401) { S.account = null; lsSet(LS_ACC, null); renderBanner(); }
    });
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

  function act(body, quiet) {
    if (S.mode === 'offline') {
      if (body.action === 'gather') { OFF.gather(TILE_ITEM[body.tile]); GT.toast('+1 ' + item(TILE_ITEM[body.tile]) + ' (offline)'); return Promise.resolve(); }
      GT.toast('Mode offline hanya mendukung mengumpulkan.'); return Promise.resolve();
    }
    if (!S.account) { GT.toast('Masuk dulu (tombol Masuk).'); return Promise.resolve(); }
    return api('/act', { method: 'POST', body: body }).then(function (r) {
      S.st = r.state; renderHud(); redraw();
      if (!quiet) GT.toast(r.toast);
      return r;
    }).catch(function (e) { GT.toast(e.message); throw e; });
  }

  /* ------------------------------------------------------------ on-chain player actions (signed delegate -> relayer) */
  function b64(bytes) { var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }

  function signedCall(method, args) {
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
        return api('/relay', { method: 'POST', body: { signedDelegate: b64(L.encodeSignedDelegate(sd)) } });
      });
    }).then(function (r) {
      if (r && r.status === 'failed') throw new Error('Ditolak kontrak: ' + (r.error || ''));
      return refresh(true).then(function () { return r; });
    });
  }

  /* ------------------------------------------------------------ world: merchants, farm plot */
  function placeMerchants() {
    var sp = GT.world && GT.world.spawn; if (!sp) return;
    MERCHANTS.forEach(function (m) {
      if (S.npcs[m.id]) return;
      S.npcs[m.id] = GT.addNpc('out', { x: sp.x + m.dx, y: sp.y + m.dy, name: m.id.charAt(0).toUpperCase() + m.id.slice(1), pal: m.pal,
        key: 'merchant:' + m.id, label: m.tag, turns: true, noAffinity: true, lines: [['Mampir ke tokoku!']] });
    });
  }

  function findPlots() {
    var own = GT.world && GT.world.own, sc = GT.getScene('out');
    if (!own || !sc) return;
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
  function keyLabel() { return window.GT_SETTINGS ? GT_SETTINGS.label('talk').split(' / ')[0] : 'Spasi'; }
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
    if (sc.house && sc.house.own && tt === 'table') return 'Meja Kerja (crafting)';
    if (sc.house && sc.house.own && tt === 'chest') return 'Kotak Kirim';
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
      var needTool = tok !== 'fish' && S.st && (S.st.bag.tool.settled + S.st.bag.tool.today) < 1;
      return verb + ' (−4 energi)' + (needTool ? ' · butuh Alat' : '');
    }
    return null;
  }
  function onFrame() {
    var now = Date.now(); if (now - hintT < 150) return; hintT = now;
    if (!hintEl) { var scr = document.getElementById('screen'); if (!scr) return; hintEl = $('div'); hintEl.id = 'gt-hint'; hintEl.setAttribute('aria-live', 'polite'); scr.appendChild(hintEl); }
    var h = (GT.isUiOpen && GT.isUiOpen()) ? null : hintFor();
    if (!h) { hintEl.className = ''; return; }
    var txt = keyLabel() + '|' + h;
    if (hintEl._t !== txt) { hintEl._t = txt; hintEl.textContent = ''; var b = $('b', null, keyLabel()); hintEl.appendChild(b); hintEl.appendChild(document.createTextNode(' ' + h)); }
    hintEl.className = 'on';
  }

  var PLOT_COL = { empty: null, tilled: '#7a5230', planted: '#7a5230', ready: '#7a5230' };
  function onDraw(ctx, camX, camY, T) {
    if (!GT.scene || GT.scene.kind !== 'out' || !S.plots.length || !S.st) return;
    S.plots.forEach(function (pp, i) {
      var p = S.st.plots[i]; if (!p) return;
      var x = pp.x * T - camX, y = pp.y * T - camY;
      if (x < -T || y < -T || x > 400 || y > 400) return;
      if (PLOT_COL[p.state]) { ctx.fillStyle = PLOT_COL[p.state]; ctx.fillRect(x + 1, y + 1, T - 2, T - 2); ctx.fillStyle = '#5e3c20'; for (var k = 3; k < T - 1; k += 3) ctx.fillRect(x + 1, y + k, T - 2, 1); }
      else { ctx.strokeStyle = 'rgba(122,82,48,.55)'; ctx.strokeRect(x + 1.5, y + 1.5, T - 3, T - 3); }
      if (p.state === 'planted') {
        var h = 2 + p.grown * 2;
        ctx.fillStyle = p.wateredToday ? '#3c8a3c' : '#6aa04a';
        ctx.fillRect(x + 3, y + T - 2 - h, 2, h); ctx.fillRect(x + 7, y + T - 2 - h, 2, h);
      } else if (p.state === 'ready') {
        ctx.fillStyle = '#e8c048'; ctx.fillRect(x + 2, y + 2, 3, 7); ctx.fillRect(x + 7, y + 3, 3, 6);
      }
      if (p.state === 'planted' && p.wateredToday) { ctx.fillStyle = 'rgba(72,144,216,.35)'; ctx.fillRect(x + 1, y + 1, T - 2, T - 2); }
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
    return wrap;
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

  function restoreBody(id, m, wrap) {
    var s = (S.shops || []).filter(function (x) { return x.id === id; })[0];
    wrap.appendChild($('p', 'chain-closed', 'TUTUP. ' + m.name + ' tidak sanggup membayar sewa.'));
    if (!s) { wrap.appendChild($('p', null, 'Memuat papan pemulihan…')); return wrap; }
    wrap.appendChild($('p', null, 'Papan pemulihan: lengkapi semua baris dan toko buka lagi. Penyumbang mendapat saham dan dividen.'));
    var lines = [];
    s.need.forEach(function (n) {
      var got = 0; (s.pledged || []).forEach(function (p) { if (p.token_id === n.token_id) got = +p.amount; });
      var missing = Math.max(0, +n.amount - got);
      var have = S.st ? S.st.bag[n.token_id].settled : 0;
      var row = $('div', 'mrow');
      row.appendChild($('span', 'grow', item(n.token_id) + ': ' + got + '/' + n.amount));
      row.appendChild($('span', 'num', 'punyamu (settled) ' + have));
      wrap.appendChild(row);
      if (missing > 0 && have > 0) lines.push({ token_id: n.token_id, amount: String(Math.min(missing, have)) });
    });
    if (s.contributors) wrap.appendChild($('p', 'chain-dim', s.contributors + ' penyumbang sejauh ini.'));
    if (lines.length) {
      wrap.appendChild(button('Sumbang semua yang bisa (on-chain)', function () {
        GT.toast('Mengirim sumbangan…');
        signedCall('restore_contribute', { merchant: s.account_id, contribution: lines })
          .then(function () { GT.toast('Terima kasih! Sumbanganmu tercatat on-chain.'); refreshModal(); }, function (e) { GT.toast(e.message); });
      }, 'primary'));
    } else {
      wrap.appendChild($('p', 'chain-dim', 'Sumbangan memakai saldo yang sudah settled. Barang hari ini bisa disumbang setelah pukul 06:00.'));
    }
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
    wrap.appendChild($('p', 'chain-dim', '"hari ini" = perubahan off-chain yang ditulis ke chain pada settlement pukul 06:00. Kirim ke pemain lain memakai saldo settled dan langsung on-chain.'));
    wrap.appendChild($('p', 'chain-dim', 'Alat: ' + S.st.tool.uses + '/' + S.st.tool.durability + ' pemakaian.'));
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

  var BODIES = { bag: bagBody, history: historyBody, craft: craftBody, ship: shipBody };
  function open(kind, arg) {
    if (S.mode !== 'offline' && !S.account && kind !== 'shop') { login(); return; }
    var title = kind === 'bag' ? 'Tas NEAR' : kind === 'history' ? 'Riwayat' : kind === 'craft' ? 'Meja Kerja' : kind === 'ship' ? 'Kotak Kirim' : (MERCHANTS.filter(function (m) { return m.id === arg; })[0] || {}).tag;
    var body = kind === 'shop' ? shopBody(arg) : BODIES[kind]();
    var h = GT.modal({ title: title, wide: kind === 'history' || kind === 'shop', body: body, onClose: function () { S.modal = null; } });
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
    var own = ctx.scene.house && ctx.scene.house.own;
    if (own && ctx.tileType === 'table') { open('craft'); return true; }
    if (own && ctx.tileType === 'chest') { open('ship'); return true; }
    if (ctx.scene.kind !== 'out') return false;
    var pi = plotAt(ctx.tile.x, ctx.tile.y);
    if (pi >= 0) { farm(pi); return true; }
    var token = TILE_ITEM[ctx.tileType];
    if (!token) return false;
    if (S.busy) return true;
    S.busy = true;
    act({ action: 'gather', tile: ctx.tileType, x: ctx.tile.x, y: ctx.tile.y }).catch(noop).then(function () { S.busy = false; });
    return true;
  }

  function onWorld() { S.npcs = {}; placeMerchants(); findPlots(); }

  function init() {
    accBtn = GT.addHudButton({ id: 'chainbtn', label: 'Masuk', key: 'N', secondary: false, onClick: function () { open('bag'); } });
    GT.addHudButton({ id: 'riwayatbtn', label: 'Riwayat', key: 'H', onClick: function () { open('history'); } });
    // The old local bag (play items) is replaced by the NEAR bag: hide its button and point the I key here.
    var oldBag = document.getElementById('bagbtn'); if (oldBag) oldBag.style.display = 'none';
    GT.hotkey('I', function () { open('bag'); });
    var forceOffline = /[?&]mode=offline\b/.test(location.search) || location.protocol === 'file:';
    var cfgP = forceOffline ? Promise.reject(new Error('offline')) :
      Promise.race([api('/config'), new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, 4000); })]);
    cfgP.then(function (cfg) {
      S.cfg = cfg; S.mode = cfg.chainMode === 'mock' ? 'mock' : 'testnet';
      S.account = lsGet(LS_ACC);
      if (cfg.devTools) GT.addDevSection('NEAR settlement', function (sec) {
        sec.appendChild($('p', 'mnote', 'Lompat ke pukul 06:00 berikutnya dan tulis hari ini ke chain sekarang.'));
        sec.appendChild(button('Settle sekarang', function () {
          GT.toast('Settlement berjalan…');
          api('/dev/settle', { method: 'POST' }).then(function (r) { GT.toast('Settled sampai hari ' + r.settledThrough); refresh(true); }, function (e) { GT.toast(e.message); });
        }, 'primary'));
      });
    }).catch(function () { S.mode = 'offline'; }).then(function () {
      renderBanner(); return refresh(true);
    }).then(schedulePoll);
    renderBanner();
  }

  window.GT_CHAIN = { state: S, refresh: refresh, login: login, open: open, act: act, _signedCall: signedCall };
  GT.register({ id: 'chain', init: init, onWorld: onWorld, onInteract: onInteract, onDraw: onDraw, onFrame: onFrame });
})();
