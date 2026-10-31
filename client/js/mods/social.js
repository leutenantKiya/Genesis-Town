/*
 * social.js - "Sosial": pemain lain, hadiah (gift), tukar (trade), klan.  Talks to the engine only through window.GT.
 *
 * ============================ PUBLISHER NOTES (online mode) ============================
 * Capability declaration this page needs when published as a claude.ai artifact:
 *
 *   capabilities: {
 *     db: { rules: [
 *       { path: "players",        read: "view",     write: "owner"    },  // public profiles, only the owner of the artifact may touch others'
 *       { path: "players/{self}",                    write: "interact" },  // every viewer writes ONLY players/<own id>
 *       { path: "clans",          read: "view",     write: "interact" },  // anyone may create / edit a clan card
 *       { path: "offers",         read: "view",     write: "interact" },  // gift / trade offers (escrow lives in the offer, never in a player doc)
 *       { path: "data/users/{self}",                 write: "interact" }   // private escrow receipts: data/users/<own id>/ledger/sent/<offerId>
 *     ] },
 *     user: { scopes: ["profile"] },   // ids + display names (names resolved at render with user.profiles(); never stored)
 *     room: {}                         // presence only (x,y,dir,scene); no topics are used
 *   }
 *   Viewers need the Contributor ("interact") level to play online; view-only viewers see players but all send/respond
 *   buttons are disabled (user.can('data.write') === false or a rejected write switches the UI to read-only).
 *
 * Collections / documents (all values untrusted on read: validated, clamped, escaped):
 *   players/{uid}   {nick<=16, role:'warga'|'maling', clanId|null, updatedAt}          written by the owner only
 *   clans/{c_TAG}   {name<=16, tag[A-Z0-9]{2,4}, ownerUid, createdAt}                   members = players whose clanId == id
 *   offers/{id}     {from, to, kind:'gift'|'trade', give:{item:n,koin:n}, want:{...}, status, createdAt}
 *                   status: open -> (to) claimed [gift] | accepted [trade] | declined ; open -> (from) cancelled ; accepted -> (from) claimed
 *   data/users/{uid}/ledger/sent/{offerId}  private escrow receipt {to, kind, give, want, phase:'pending'|'live', createdAt}
 *
 * Escrow design:  the sender removes `give` from its own state first, writes a private receipt, then the public offer.  The
 * receipt (not the forgeable public offer) says what is owed back.  Receiver of a gift sets status 'claimed' (then adds the
 * goods to itself).  Receiver of a trade removes `want` from itself, sets 'accepted', adds `give`; the sender later sees
 * 'accepted', sets 'claimed', deletes the receipt and then adds `want`.  declined/cancelled -> the sender deletes its receipt
 * and gets `give` back.  The receipt delete always happens BEFORE crediting so nothing is ever credited twice.  Nobody
 * writes another player's state; respond/cancel run under db .acquire() leases so cancel-vs-accept cannot both win.
 * Known limit (platform has no transactions): a malicious Contributor can forge/flip statuses of offers; amounts are clamped.
 *
 * Bots (both modes; local-only, never written to the db): 3 simulated players ("bot", palette 6/7) wander OUTDOORS only, accept gifts,
 * judge trades by item value (>= 90%), and send you a gift/trade offer about every 3 game hours (inbox capped at 5).
 * Bot NPCs carry npc.isBot = true and npc.isPlayer = true; online peers carry npc.isRemote = true and npc.isPlayer = true.
 * ======================================================================================
 */
(function () {
if (!window.GT_FLAGS || !window.GT_FLAGS.social) return; // feature flag: off in the submission build (js/flags.js)
'use strict';
var GT = window.GT;
if (!GT) return;

/* ------------------------------------------------------------------ util */
var LS_KEY = 'gt.social.v1';
var MAX_INBOX = 5, MAX_KOIN = 100000, MAX_QTY = 999, NAME_MAX = 16;
var STATUS_ID = { open:'Menunggu', accepted:'Diterima (menunggu klaim)', claimed:'Selesai', declined:'Ditolak', cancelled:'Dibatalkan', sending:'Mengirim...', missing:'Hilang' };

function h(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function cleanText(s, max) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function validId(s) { return typeof s === 'string' && /^[A-Za-z0-9_.:@+~-]{1,120}$/.test(s); }
function validTag(t) { return typeof t === 'string' && /^[A-Z0-9]{2,4}$/.test(t); }
function now() { return Date.now(); }
function rnd(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
function ok(x) { x = x || {}; x.ok = true; return x; }
function fail(msg, code) { return { ok: false, error: msg, code: code || 'error' }; }
function lsGet() { try { var s = window.localStorage.getItem(LS_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
function lsSet(o) { try { window.localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch (e) {} }
function itemOk(id) { return typeof id === 'string' && own(GT.ITEMS, id); }
function itemVal(id) { if (id === 'koin') return 1; var d = GT.ITEMS[id]; return d && d.price > 0 ? d.price : 5; }
function itemLabel(id) { return id === 'koin' ? 'Koin' : GT.itemName(id); }
function itemIcon(id) { return id === 'koin' ? 'koin' : ((GT.ITEMS[id] && GT.ITEMS[id].icon) || id); }
function bundleVal(b) { var v = 0; Object.keys(b || {}).forEach(function (k) { v += itemVal(k) * b[k]; }); return v; }
function bundleKeys(b) { return Object.keys(b || {}); }
function bundleText(b) { return bundleKeys(b).map(function (k) { return b[k] + ' ' + itemLabel(k); }).join(', '); }

/* parse + clamp a bundle {itemId:n, koin:n}.  strict: any invalid entry => null (used for what the local player submits). */
function parseBundle(raw, strict) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  var out = {}, n = 0, keys = Object.keys(raw);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i], v = raw[k];
    var good = /^[a-z][a-z0-9_]{0,23}$/.test(k) && (k === 'koin' || itemOk(k));
    var c = Math.floor(Number(v));
    var cap = k === 'koin' ? MAX_KOIN : MAX_QTY;
    if (strict) {
      if (!good || typeof v !== 'number' || !isFinite(v) || v !== Math.floor(v) || v < 1 || v > cap) return null;
    } else if (!good || !isFinite(c) || c < 1) continue;
    else c = Math.min(c, cap);
    if (++n > 8) { if (strict) return null; break; }
    out[k] = strict ? v : c;
  }
  return n ? out : null;
}
function hasBundle(b) {
  var s = GT.state;
  return bundleKeys(b).every(function (k) { return k === 'koin' ? s.coins >= b[k] : (s.inventory[k] || 0) >= b[k]; });
}
function takeBundle(b) {
  if (!hasBundle(b)) return false;
  bundleKeys(b).forEach(function (k) { if (k === 'koin') GT.spendCoins(b[k]); else GT.removeItem(k, b[k]); });
  return true;
}
function giveBundle(b) {
  bundleKeys(b).forEach(function (k) { if (k === 'koin') GT.addCoins(b[k]); else if (itemOk(k)) GT.addItem(k, b[k]); });
}
function addTo(inv, b, sign) { // bot inventory ops (inv = {items..., } ; koin lives in bot.coins)
  bundleKeys(b).forEach(function (k) {
    if (k === 'koin') inv.coins = Math.max(0, (inv.coins || 0) + sign * b[k]);
    else { inv.inv[k] = (inv.inv[k] || 0) + sign * b[k]; if (inv.inv[k] <= 0) delete inv.inv[k]; }
  });
}
function botHas(bot, b) { return bundleKeys(b).every(function (k) { return k === 'koin' ? bot.coins >= b[k] : (bot.inv[k] || 0) >= b[k]; }); }
var persistBusy = false;
function persist() { // GT has no public save(); a net-zero coin move makes the core write localStorage
  if (persistBusy) return; persistBusy = true;
  try { if (GT.state.coins > 0) { GT.spendCoins(1); GT.addCoins(1); } else { GT.addCoins(1); GT.spendCoins(1); } } catch (e) {}
  persistBusy = false;
}

/* ------------------------------------------------------------------ state */
var S = {
  transport: 'offline',   // 'online' | 'offline'
  ready: false,           // capability probing finished
  readOnly: false,        // online but this viewer cannot write
  hist: [],               // [{t,text}] last results
  onlineErr: ''
};
var worldNow = null;
var L = null;             // offline store
var ON = null;            // online store
var panel = null, curTab = 'pemain', formName = '', formTag = '', formErr = '';
var hudBtn = null;

function myId() { return S.transport === 'online' && ON ? ON.uid : 'me'; }
function hist(text) {
  S.hist.unshift({ t: now(), text: String(text).slice(0, 140) }); S.hist.length = Math.min(S.hist.length, 12);
  saveLocal();
}
function toast(t) { try { GT.toast(t); } catch (e) {} }
function saveLocal() {
  var o = lsGet() || {};
  o.v = 1; o.hist = S.hist;
  if (L) { o.L = L; }
  lsSet(o);
}

/* ------------------------------------------------------------------ offline: bots */
var BOT_CLANS = [{ id: 'bot:GRD', name: 'Garuda Kota', tag: 'GRD', owner: 'bot:rizky' }];
var BOTS = {
  'bot:rizky': { id: 'bot:rizky', name: 'Rizky', pal: 6, role: 'warga', clan: 'bot:GRD', inv0: { roti: 3, apel: 2, kue: 1 }, coins0: 180,
    lines: ['Halo! Ada yang mau ditukar?', 'Kota ini makin ramai ya.', 'Klan Garuda Kota lagi cari anggota!', 'Aku lagi hunting roti enak.'] },
  'bot:putri': { id: 'bot:putri', name: 'Putri', pal: 7, role: 'warga', clan: 'bot:GRD', inv0: { bunga: 3, susu: 2, permen: 4 }, coins0: 240,
    lines: ['Hai, salam kenal!', 'Bunga di taman cantik banget hari ini.', 'Mau tukar permen? Aku punya banyak.', 'Hati-hati sama maling ya.'] },
  'bot:bayu': { id: 'bot:bayu', name: 'Bayu', pal: 6, role: 'maling', clan: null, inv0: { obeng: 1, permen: 5, apel: 3 }, coins0: 120,
    lines: ['Psst... jangan bilang siapa-siapa.', 'Aku cuma lewat, kok.', 'Kunci rumah itu gampang... eh, maksudku, aman.', 'Punya obeng lebih? Aku beli.'] }
};
var BOT_IDS = Object.keys(BOTS);
var botNpc = {};   // id -> npc

function freshL() {
  var l = { bots: {}, offers: [], clans: [], nextBotAt: 0, seq: 1 };
  BOT_IDS.forEach(function (id) { l.bots[id] = { inv: JSON.parse(JSON.stringify(BOTS[id].inv0)), coins: BOTS[id].coins0 }; });
  return l;
}
function loadL() {
  var saved = lsGet();
  if (saved && Array.isArray(saved.hist)) S.hist = saved.hist.filter(function (x) { return x && typeof x.text === 'string'; }).slice(0, 12).map(function (x) { return { t: +x.t || 0, text: cleanText(x.text, 140) }; });
  L = freshL();
  var s = saved && saved.L;
  if (s && typeof s === 'object') {
    BOT_IDS.forEach(function (id) {
      var b = s.bots && s.bots[id]; if (!b || typeof b !== 'object') return;
      var inv = {}; Object.keys(b.inv || {}).slice(0, 20).forEach(function (k) { if (itemOk(k)) { var c = Math.floor(+b.inv[k]); if (c > 0) inv[k] = Math.min(c, 9999); } });
      L.bots[id] = { inv: inv, coins: Math.max(0, Math.min(1e6, Math.floor(+b.coins) || 0)) };
    });
    if (Array.isArray(s.offers)) s.offers.slice(0, 40).forEach(function (o) { var c = cleanOffer(String(o && o.id), o, true); if (c) { c.due = +o.due || 0; L.offers.push(c); } });
    if (Array.isArray(s.clans)) s.clans.slice(0, 10).forEach(function (c) {
      if (c && typeof c.id === 'string' && /^local:/.test(c.id) && validTag(c.tag)) L.clans.push({ id: c.id, name: cleanText(c.name, NAME_MAX), tag: c.tag, owner: 'me' });
    });
    L.nextBotAt = +s.nextBotAt || 0; L.seq = Math.max(1, +s.seq || 1);
  }
}

function offlineClans() {
  return BOT_CLANS.concat(L ? L.clans : []);
}

/* ------------------------------------------------------------------ offers: sanitising (used for both transports) */
function cleanOffer(id, d, offline) {
  if (!d || typeof d !== 'object') return null;
  if (!offline && !validId(id)) return null;
  var kind = d.kind === 'trade' ? 'trade' : d.kind === 'gift' ? 'gift' : null;
  if (!kind) return null;
  var from = d.from, to = d.to;
  if (!validId(from) || !validId(to) || from === to) return null;
  var give = parseBundle(d.give, false); if (!give) return null;
  var want = kind === 'trade' ? parseBundle(d.want, false) : {};
  if (kind === 'trade' && !want) return null;
  var status = ['open', 'accepted', 'declined', 'cancelled', 'claimed'].indexOf(d.status) >= 0 ? d.status : null;
  if (!status) return null;
  var ca = Number(d.createdAt);
  return { id: String(id), from: from, to: to, kind: kind, give: give, want: want || {}, status: status, createdAt: isFinite(ca) ? ca : 0 };
}

/* ------------------------------------------------------------------ names / lookups */
function botTag(id) {
  var b = BOTS[id]; if (!b || !b.clan) return '';
  var c = offlineClans().filter(function (x) { return x.id === b.clan; })[0]; return c ? c.tag : '';
}
function nameOf(id) {
  if (id === myId() || id === 'me') return GT.state.playerName || 'Kamu';
  if (BOTS[id]) return BOTS[id].name;
  if (ON) {
    var nm = ON.names[id]; if (nm) return cleanText(nm, 24) || 'Pemain';
    var p = ON.players.get(id); if (p && p.nick) return p.nick;
  }
  return 'Pemain';
}
function clanById(id) {
  if (!id) return null;
  if (S.transport === 'online' && !/^bot:/.test(id)) return ON && ON.clans.get(id) || null;
  return offlineClans().filter(function (c) { return c.id === id; })[0] || null;
}
function tagOf(id) {
  if (id === myId() || id === 'me') return GT.state.clan ? GT.state.clan.tag : '';
  if (BOTS[id]) return botTag(id);
  if (S.transport === 'online') { var p = ON && ON.players.get(id); var c = p && clanById(p.clanId); return c ? c.tag : ''; }
  return botTag(id);
}
function roleOf(id) {
  if (BOTS[id]) return BOTS[id].role;
  var p = ON && ON.players.get(id); return p ? p.role : 'warga';
}
function labelFor(id) { var t = tagOf(id); return (BOTS[id] ? '[P] ' : '') + nameOf(id) + (t ? ' [' + t + ']' : ''); }

function playerList() {
  var out = [];
  BOT_IDS.forEach(function (id) { out.push({ id: id, name: BOTS[id].name, tag: botTag(id), role: BOTS[id].role, online: true, bot: true }); });
  if (S.transport === 'online' && ON) {
    var live = {}; ON.peerUids.forEach(function (u) { live[u] = true; });
    ON.players.forEach(function (p, id) {
      if (id === ON.uid) return;
      out.push({ id: id, name: nameOf(id), tag: tagOf(id), role: p.role, online: !!live[id], bot: false });
    });
    ON.peerUids.forEach(function (u) { if (!ON.players.has(u)) out.push({ id: u, name: nameOf(u), tag: '', role: 'warga', online: true, bot: false }); });
    var real = out.filter(function (p) { return !p.bot; }).sort(function (a, b) { return (b.online - a.online) || a.name.localeCompare(b.name); });
    out = real.concat(out.filter(function (p) { return p.bot; }));
  }
  return out.slice(0, 63);
}
function playerRec(id) { return playerList().filter(function (p) { return p.id === id; })[0] || null; }

/* ------------------------------------------------------------------ UI refresh plumbing */
var uiTimer = 0;
function changed() {
  if (uiTimer) return;
  uiTimer = setTimeout(function () {
    uiTimer = 0;
    updateBadge();
    if (panel && panel.isOpen()) renderPanel();
    try { GT.emit('social', { transport: S.transport }); } catch (e) {}
  }, 0);
}
function inboxList() {
  var loc = L ? L.offers.filter(function (o) { return o.to === 'me' && o.status === 'open'; }) : [];
  return (S.transport === 'online' && ON ? ON.inbox.slice() : []).concat(loc);
}
function sentList() {
  var loc = L ? L.offers.filter(function (o) { return o.from === 'me'; }) : [];
  return (S.transport === 'online' && ON ? ON.sent.slice() : []).concat(loc);
}
function isLocalOffer(id) { return !!(L && L.offers.some(function (o) { return o.id === id; })); }
function updateBadge() {
  if (!hudBtn) return;
  var n = inboxList().length, t = 'Sosial' + (n ? ' (' + n + ')' : '');
  if (hudBtn.textContent !== t) hudBtn.textContent = t;
}

/* ------------------------------------------------------------------ OFFLINE transport */
function offNpcFor(id) { return botNpc[id] || { key: id, name: BOTS[id] ? BOTS[id].name : id, aff0: 40 }; }
function offAffinity(id, d) { try { GT.addAffinity(offNpcFor(id), d); } catch (e) {} }
function botSay(id, text) { if (botNpc[id]) GT.npcSay(botNpc[id], text); }
function offRemove(o) { var i = L.offers.indexOf(o); if (i >= 0) L.offers.splice(i, 1); }

function offSettle() { // my side of finished offers: refunds / deliveries.  Receipt == removal from L.offers (done before crediting)
  L.offers.slice().forEach(function (o) {
    if (o.from !== 'me') return;
    var who = nameOf(o.to);
    if (o.status === 'declined' || o.status === 'cancelled') {
      offRemove(o); giveBundle(o.give);
      hist((o.kind === 'gift' ? 'Hadiah ke ' : 'Tukar dengan ') + who + (o.status === 'declined' ? ' ditolak' : ' dibatalkan') + ': barangmu kembali.');
    } else if (o.status === 'accepted') {
      offRemove(o); giveBundle(o.want);
      hist('Tukar dengan ' + who + ' berhasil: kamu menerima ' + bundleText(o.want) + '.');
    } else if (o.status === 'claimed') {
      offRemove(o);
      hist('Hadiah ke ' + who + ' diterima.');
    }
  });
  saveLocal(); changed();
}
function botDecide(o) {
  var id = o.to, bot = L.bots[id]; if (!bot) { o.status = 'declined'; return; }
  if (o.kind === 'gift') {
    addTo(bot, o.give, +1); o.status = 'claimed';
    var v = bundleVal(o.give);
    offAffinity(id, Math.max(1, Math.min(6, Math.round(v / 12))));
    botSay(id, pick(['Wah, makasih banyak!', 'Baik hati sekali kamu!', 'Terima kasih ya, ' + nameOf('me') + '!']));
    toast(nameOf(id) + ' menerima hadiahmu.');
  } else {
    var recv = bundleVal(o.give), out = bundleVal(o.want);
    if (botHas(bot, o.want) && recv >= out * 0.9) {
      addTo(bot, o.want, -1); addTo(bot, o.give, +1); o.status = 'accepted';
      offAffinity(id, 1); botSay(id, pick(['Deal!', 'Sepakat, senang berdagang denganmu.']));
      toast(nameOf(id) + ' setuju tukar!');
    } else {
      o.status = 'declined';
      botSay(id, botHas(bot, o.want) ? pick(['Kurang sepadan, nih.', 'Tawarannya kurang, tambah dikit dong.']) : 'Aku nggak punya barang itu.');
      toast(nameOf(id) + ' menolak tukar.');
    }
  }
  offSettle();
}
function offSend(kind, to, give, want) {
  if (!BOTS[to]) return fail('Pemain tidak ditemukan.', 'notfound');
  if (!takeBundle(give)) return fail('Barang atau koinmu tidak cukup.', 'insufficient');
  var o = { id: 'o' + (L.seq++), from: 'me', to: to, kind: kind, give: give, want: want || {}, status: 'open', createdAt: GT.time.total, due: now() + rnd(1200, 2600) };
  L.offers.push(o); saveLocal(); changed();
  return ok({ id: o.id });
}
function offRespond(id, accept) {
  var o = L.offers.filter(function (x) { return x.id === id && x.to === 'me' && x.status === 'open'; })[0];
  if (!o) return fail('Tawaran tidak ditemukan.', 'notfound');
  var bot = L.bots[o.from], who = nameOf(o.from);
  if (!accept) {
    if (bot) addTo(bot, o.give, +1);
    offRemove(o); hist('Kamu menolak tawaran ' + who + '.'); botSay(o.from, 'Oke, tidak apa-apa.');
  } else if (o.kind === 'gift') {
    giveBundle(o.give); offRemove(o); offAffinity(o.from, 1);
    hist('Kamu menerima hadiah dari ' + who + ': ' + bundleText(o.give) + '.');
  } else {
    if (!hasBundle(o.want)) return fail('Kamu tidak punya yang diminta: ' + bundleText(o.want) + '.', 'insufficient');
    takeBundle(o.want); giveBundle(o.give); if (bot) addTo(bot, o.want, +1);
    offRemove(o); offAffinity(o.from, 1);
    hist('Tukar dengan ' + who + ' berhasil: kamu dapat ' + bundleText(o.give) + '.');
  }
  saveLocal(); changed();
  return ok({ id: id, status: accept ? (o.kind === 'gift' ? 'claimed' : 'accepted') : 'declined' });
}
function offCancel(id) {
  var o = L.offers.filter(function (x) { return x.id === id && x.from === 'me'; })[0];
  if (!o) return fail('Tawaran tidak ditemukan.', 'notfound');
  if (o.status !== 'open') return fail('Tawaran sudah dijawab.', 'closed');
  o.status = 'cancelled'; offSettle();
  return ok({ id: id });
}
function botMakeOffer(forceId, forceKind) {
  if (!L) return null;
  var open = L.offers.filter(function (o) { return o.to === 'me' && o.status === 'open'; });
  if (open.length >= MAX_INBOX) return null;
  var ids = BOT_IDS.filter(function (id) { return !open.some(function (o) { return o.from === id; }); });
  if (forceId) ids = ids.filter(function (id) { return id === forceId; });
  if (!ids.length) return null;
  var id = pick(ids), bot = L.bots[id];
  var items = Object.keys(bot.inv).filter(function (k) { return bot.inv[k] > 0; });
  var kind = forceKind || (Math.random() < 0.6 ? 'gift' : 'trade');
  var give = null, want = null;
  if (items.length && Math.random() < 0.85) { var k = pick(items); give = {}; give[k] = Math.min(bot.inv[k], rnd(1, 2)); }
  else if (bot.coins >= 20) { give = { koin: rnd(10, Math.min(40, bot.coins)) }; }
  if (!give) return null;
  if (kind === 'trade') {
    var val = bundleVal(give), mine = Object.keys(GT.state.inventory).filter(function (k) { return GT.state.inventory[k] > 0 && itemOk(k) && !own(give, k); });
    if (mine.length) { var m = pick(mine); var n = Math.min(GT.state.inventory[m], Math.max(1, Math.ceil(val * 1.05 / itemVal(m)))); want = {}; want[m] = n; }
    else if (GT.state.coins >= Math.ceil(val * 1.1)) want = { koin: Math.ceil(val * 1.1) };
    if (!want) kind = 'gift';
  }
  addTo(bot, give, -1);
  var o = { id: 'o' + (L.seq++), from: id, to: 'me', kind: kind, give: give, want: kind === 'trade' ? want : {}, status: 'open', createdAt: GT.time.total };
  L.offers.push(o); saveLocal();
  botSay(id, kind === 'gift' ? 'Aku kirim sesuatu buatmu!' : 'Aku ada tawaran tukar nih.');
  toast(nameOf(id) + (kind === 'gift' ? ' mengirim hadiah!' : ' mengajak tukar!') + ' Buka Sosial (O).');
  changed();
  return o;
}
function botTick() {
  var t = GT.time.total;
  // restock + expire
  L.offers.slice().forEach(function (o) {
    if (o.from !== 'me' && o.status === 'open' && t - o.createdAt > 720) { // 12 game hours
      var bot = L.bots[o.from]; if (bot) addTo(bot, o.give, +1); offRemove(o); hist('Tawaran ' + nameOf(o.from) + ' kedaluwarsa.');
    }
  });
  if (!L.nextBotAt) L.nextBotAt = t + rnd(60, 120);
  if (t >= L.nextBotAt) {
    BOT_IDS.forEach(function (id) { var b = L.bots[id]; var k = pick(Object.keys(BOTS[id].inv0)); b.inv[k] = (b.inv[k] || 0) + 1; b.coins += rnd(5, 20); });
    L.nextBotAt = t + rnd(150, 210);   // about every 3 game hours
    botMakeOffer();
    saveLocal();
  }
}
function populateBots() {
  botNpc = {};
  if (!worldNow || !GT.getScene('out')) return;
  var rng = GT.rng('social-bots'), sp = (worldNow.npcSpawns || []).slice(), used = [];
  GT.getScene('out').npcs.forEach(function (n) { used.push([n.x, n.y]); });
  used.push([worldNow.spawn.x, worldNow.spawn.y]);
  BOT_IDS.forEach(function (id) {
    var spot = null;
    for (var i = 0; i < sp.length; i++) {
      var s = sp[(i + Math.floor(rng() * sp.length)) % sp.length];
      if (used.every(function (u) { return Math.abs(u[0] - s[0]) + Math.abs(u[1] - s[1]) >= 7; })) { spot = s; break; }
    }
    if (!spot) spot = sp.length ? sp[Math.floor(rng() * sp.length)] : [worldNow.spawn.x + 3, worldNow.spawn.y + 3];
    var d = BOTS[id];
    var n = GT.addNpc('out', { x: spot[0], y: spot[1], name: d.name, pal: d.pal, wander: true, leash: 8, key: id, label: labelFor(id), lines: d.lines.map(function (l) { return [l]; }) });
    if (!n) return;
    n.isBot = true; n.isPlayer = true; n.playerId = id;
    botNpc[id] = n; used.push([n.x, n.y]);
  });
}
function clearBots() { Object.keys(botNpc).forEach(function (id) { try { GT.removeNpc(botNpc[id]); } catch (e) {} }); botNpc = {}; }
function refreshLabels() {
  Object.keys(botNpc).forEach(function (id) { botNpc[id].label = labelFor(id); });
  if (ON) ON.remote.forEach(function (r, uid) { r.npc.label = labelFor(uid); r.npc.name = nameOf(uid); });
}

/* ------------------------------------------------------------------ ONLINE transport */
function dbMsg(e) {
  var c = e && e.code;
  if (c === 'invalid_argument') return 'Server menolak (akses tidak cukup atau data tidak valid).';
  if (c === 'quota_exceeded') return 'Penyimpanan penuh.';
  if (c === 'resource_exhausted') return 'Terlalu cepat, coba lagi sebentar.';
  if (c === 'revoked') return 'Akses dicabut.';
  return 'Koneksi bermasalah, coba lagi.';
}
function noteWriteFail(e) { if (e && e.code === 'invalid_argument') { S.readOnly = true; changed(); } }
var wq = {};
function serial(path, fn) {
  var prev = wq[path] || Promise.resolve();
  var run = prev.catch(function () {}).then(fn);
  wq[path] = run.catch(function () {});
  return run;
}
function ref(path) { return ON.db.doc(path); }
function offerRef(id) { return ON.db.collection('offers').doc(id); }
function recRef(id) { return ON.db.doc('data/users/' + ON.uid + '/ledger').collection('sent').doc(id); }
function w(r, op, data) { return serial(r.path, function () { return op === 'delete' ? r.delete() : r[op](data); }); }

function startOnline(db, user, room, uid) {
  S.transport = 'online';
  ON = {
    db: db, user: user, room: room, uid: uid,
    got: { players: false, clans: false, to: false, from: false, rec: false },
    players: new Map(), clans: new Map(), toMe: new Map(), fromMe: new Map(), rec: new Map(),
    inbox: [], sent: [], names: {}, peerUids: [], remote: new Map(), unsub: [],
    lastSelf: '', lastPresence: '', lastPresAt: 0, selfAt: 0, recon: false, reconAgain: false, settled: new Set()
  };
  try { user.can('data.write').then(function (v) { if (v === false) { S.readOnly = true; changed(); } }, function () {}); } catch (e) {}
  function sub(q, fn) {
    try { ON.unsub.push(q.onSnapshot(fn, function (e) { S.onlineErr = dbMsg(e); changed(); })); } catch (e) { S.onlineErr = 'Gagal berlangganan.'; }
  }
  sub(db.collection('players').limit(300), function (snap) {
    var m = new Map();
    snap.docs.forEach(function (d) {
      if (!validId(d.id)) return; var x = d.data(); if (!x || typeof x !== 'object') return;
      m.set(d.id, { id: d.id, nick: cleanText(x.nick, NAME_MAX), role: x.role === 'maling' ? 'maling' : 'warga', clanId: validId(x.clanId) ? x.clanId : null });
    });
    ON.players = m; ON.got.players = true;
    resolveNames(Array.from(m.keys())); syncSelf(); syncMyClan(); refreshLabels(); changed();
  });
  sub(db.collection('clans').limit(200), function (snap) {
    var m = new Map();
    snap.docs.forEach(function (d) {
      if (!validId(d.id)) return; var x = d.data(); if (!x || typeof x !== 'object') return;
      var tag = typeof x.tag === 'string' ? x.tag.toUpperCase() : ''; if (!validTag(tag)) return;
      var name = cleanText(x.name, NAME_MAX); if (!name) return;
      m.set(d.id, { id: d.id, name: name, tag: tag, owner: validId(x.ownerUid) ? x.ownerUid : '' });
    });
    ON.clans = m; ON.got.clans = true; syncMyClan(); refreshLabels(); changed();
  });
  sub(db.collection('offers').where('to', '==', uid), function (snap) {
    var m = new Map();
    snap.docs.forEach(function (d) { var o = cleanOffer(d.id, d.data(), false); if (o && o.to === uid && o.from !== uid) m.set(d.id, o); });
    ON.toMe = m; ON.got.to = true;
    ON.inbox = Array.from(m.values()).filter(function (o) { return o.status === 'open'; }).sort(function (a, b) { return b.createdAt - a.createdAt; }).slice(0, 20);
    resolveNames(ON.inbox.map(function (o) { return o.from; }));
    var fresh = ON.inbox.filter(function (o) { return !ON.seenIn || !ON.seenIn[o.id]; });
    ON.seenIn = ON.seenIn || {}; ON.inbox.forEach(function (o) { ON.seenIn[o.id] = 1; });
    if (ON.firstTo && fresh.length) toast(nameOf(fresh[0].from) + (fresh[0].kind === 'gift' ? ' mengirim hadiah!' : ' mengajak tukar!') + ' Buka Sosial (O).');
    ON.firstTo = true; changed();
  });
  sub(db.collection('offers').where('from', '==', uid), function (snap) {
    var m = new Map();
    snap.docs.forEach(function (d) { var o = cleanOffer(d.id, d.data(), false); if (o && o.from === uid) m.set(d.id, o); });
    ON.fromMe = m; ON.got.from = true; buildSent(); reconcile(); changed();
  });
  sub(db.doc('data/users/' + uid + '/ledger').collection('sent'), function (snap) {
    var m = new Map();
    snap.docs.forEach(function (d) {
      var x = d.data(); if (!x || typeof x !== 'object' || !validId(d.id)) return;
      var give = parseBundle(x.give, false), want = parseBundle(x.want, false);
      if (!give || !validId(x.to)) return;
      m.set(d.id, { id: d.id, to: x.to, kind: x.kind === 'trade' ? 'trade' : 'gift', give: give, want: want || {}, phase: x.phase === 'live' ? 'live' : 'pending', createdAt: +x.createdAt || 0 });
    });
    ON.rec = m; ON.got.rec = true; buildSent(); reconcile(); changed();
  });
  if (room) {
    try {
      ON.unsub.push(room.onPeers(function (ch) { syncPeers(ch.peers); }, function () {}));
    } catch (e) {}
  }
  // first presence
  ON.tick = 0;
  // mirror my clan from local save while remote docs load
}
function resolveNames(ids) {
  if (!ON || !ids.length) return;
  var need = ids.filter(function (i) { return validId(i); });
  if (!need.length) return;
  var on = ON;
  try {
    on.user.profiles(need.slice(0, 200)).then(function (ps) {
      if (ON !== on || !ps) return;
      var ch = false;
      need.forEach(function (i) { var p = ps[i]; var nm = p && typeof p.name === 'string' ? p.name : ''; if ((on.names[i] || '') !== nm) { on.names[i] = nm; ch = true; } });
      if (ch) { refreshLabels(); changed(); }
    }, function () {});
  } catch (e) {}
}
function buildSent() {
  var out = [];
  ON.rec.forEach(function (r, id) {
    var o = ON.fromMe.get(id);
    out.push({ id: id, from: ON.uid, to: r.to, kind: r.kind, give: r.give, want: r.want, createdAt: r.createdAt,
      status: o ? o.status : (r.phase === 'pending' && now() - r.createdAt < 30000 ? 'sending' : 'missing') });
  });
  out.sort(function (a, b) { return b.createdAt - a.createdAt; });
  ON.sent = out; resolveNames(out.map(function (o) { return o.to; }));
}
function syncSelf() { // keep players/<me> current (only when something really changed)
  if (!ON || !ON.got.players || S.readOnly) return;
  var doc = { nick: cleanText(GT.state.playerName, NAME_MAX), role: GT.state.role === 'maling' ? 'maling' : 'warga' };
  var key = JSON.stringify(doc);
  if (key === ON.lastSelf) return;
  var mine = ON.players.get(ON.uid);
  if (mine && mine.nick === doc.nick && mine.role === doc.role) { ON.lastSelf = key; return; }
  ON.lastSelf = key;
  var r = ref('players/' + ON.uid);
  var body = mine ? { nick: doc.nick, role: doc.role, updatedAt: now() } : { nick: doc.nick, role: doc.role, clanId: null, updatedAt: now() };
  w(r, mine ? 'update' : 'set', body).catch(function (e) { ON.lastSelf = ''; noteWriteFail(e); });
}
function syncMyClan() {
  if (!ON || !ON.got.players || !ON.got.clans) return;
  var mine = ON.players.get(ON.uid), c = mine && mine.clanId ? ON.clans.get(mine.clanId) : null;
  if (!mine && GT.state.clan) { return; }
  setMyClan(c);
  if (mine && mine.clanId && !c && !ON.clanFix) { // dangling clan id: clear it
    ON.clanFix = true; w(ref('players/' + ON.uid), 'update', { clanId: null }).catch(function () {}).then(function () { ON.clanFix = false; });
  }
}
function setMyClan(c) {
  var cur = GT.state.clan, next = c ? { id: c.id, name: c.name, tag: c.tag } : null;
  if (JSON.stringify(cur || null) === JSON.stringify(next)) return;
  GT.state.clan = next; persist(); refreshLabels();
}

/* ---- online: send / respond / cancel / reconcile */
async function onSend(kind, to, give, want) {
  if (S.readOnly) return fail('Akunmu hanya bisa melihat (tidak bisa mengirim).', 'readonly');
  if (!ON.players.has(to) || to === ON.uid) return fail('Pemain belum terdaftar. Minta dia membuka game dulu.', 'notfound');
  if (!takeBundle(give)) return fail('Barang atau koinmu tidak cukup.', 'insufficient');
  var id = ON.uid + '_' + now().toString(36) + Math.random().toString(36).slice(2, 6);
  var t = now();
  var rec = { to: to, kind: kind, give: give, want: want || {}, createdAt: t, phase: 'pending' };
  try { await w(recRef(id), 'set', rec); }
  catch (e) { giveBundle(give); noteWriteFail(e); return fail(dbMsg(e), 'db'); }
  try { await w(offerRef(id), 'set', { from: ON.uid, to: to, kind: kind, give: give, want: want || {}, status: 'open', createdAt: t }); }
  catch (e) {
    noteWriteFail(e);
    try { await w(recRef(id), 'delete'); giveBundle(give); } catch (e2) { /* receipt stays; reconcile refunds it after 30s */ }
    return fail(dbMsg(e), 'db');
  }
  w(recRef(id), 'update', { phase: 'live' }).catch(function () {});
  return ok({ id: id });
}
async function lease(r) {
  if (typeof r.acquire !== 'function') return true;
  try { var res = await r.acquire({ holder: ON.uid, ttlMs: 8000 }); return !res || res.acquired !== false; }
  catch (e) { return true; }
}
async function freshOffer(id) {
  var snap = await offerRef(id).get();
  return snap && snap.exists ? cleanOffer(id, snap.data(), false) : null;
}
async function onRespond(id, accept) {
  if (S.readOnly) return fail('Akunmu hanya bisa melihat.', 'readonly');
  var r = offerRef(id);
  if (!(await lease(r))) return fail('Sedang diproses, coba lagi.', 'busy');
  var o;
  try { o = await freshOffer(id); } catch (e) { return fail(dbMsg(e), 'db'); }
  if (!o || o.to !== ON.uid || o.status !== 'open') return fail('Tawaran sudah tidak tersedia.', 'closed');
  try {
    if (!accept) {
      await w(r, 'update', { status: 'declined', respondedAt: now() });
      hist('Kamu menolak tawaran ' + nameOf(o.from) + '.');
      return ok({ id: id, status: 'declined' });
    }
    if (o.kind === 'gift') {
      await w(r, 'update', { status: 'claimed', respondedAt: now() });
      giveBundle(o.give);
      hist('Kamu menerima hadiah dari ' + nameOf(o.from) + ': ' + bundleText(o.give) + '.');
      return ok({ id: id, status: 'claimed' });
    }
    if (!hasBundle(o.want)) return fail('Kamu tidak punya yang diminta: ' + bundleText(o.want) + '.', 'insufficient');
    takeBundle(o.want);
    try { await w(r, 'update', { status: 'accepted', respondedAt: now() }); }
    catch (e) { giveBundle(o.want); throw e; }
    giveBundle(o.give);
    hist('Tukar dengan ' + nameOf(o.from) + ' berhasil: kamu dapat ' + bundleText(o.give) + '.');
    return ok({ id: id, status: 'accepted' });
  } catch (e) { noteWriteFail(e); return fail(dbMsg(e), 'db'); }
}
async function onCancel(id) {
  var rec = ON.rec.get(id);
  if (!rec) return fail('Tawaran tidak ditemukan.', 'notfound');
  var r = offerRef(id);
  if (!(await lease(r))) return fail('Sedang diproses, coba lagi.', 'busy');
  var o;
  try { o = await freshOffer(id); } catch (e) { return fail(dbMsg(e), 'db'); }
  try {
    if (!o) { // offer vanished: explicit user action refunds the receipt
      if (ON.settled.has(id)) return fail('Sudah diselesaikan.', 'closed');
      await w(recRef(id), 'delete'); ON.settled.add(id); giveBundle(rec.give); hist('Tawaran ke ' + nameOf(rec.to) + ' dibatalkan: barangmu kembali.');
      return ok({ id: id });
    }
    if (o.from !== ON.uid) return fail('Bukan tawaranmu.', 'notfound');
    if (o.status !== 'open') { reconcile(); return fail('Tawaran sudah dijawab.', 'closed'); }
    await w(r, 'update', { status: 'cancelled' });
  } catch (e) { noteWriteFail(e); return fail(dbMsg(e), 'db'); }
  reconcile();
  return ok({ id: id });
}
async function reconcile() {
  if (!ON) return;
  if (ON.recon) { ON.reconAgain = true; return; }
  if (!(ON.got.rec && ON.got.from)) return;
  ON.recon = true;
  var on = ON;
  try {
    do {
      on.reconAgain = false;
      var ids = Array.from(on.rec.keys());
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i], r = on.rec.get(id), o = on.fromMe.get(id);
        if (!r || on.settled.has(id)) continue;
        var who = nameOf(r.to);
        if (!o) {
          if (r.phase === 'pending' && now() - r.createdAt > 30000) {
            await w(recRef(id), 'delete'); on.settled.add(id); giveBundle(r.give); hist('Pengiriman ke ' + who + ' gagal: barangmu kembali.');
          }
          continue;
        }
        if (o.status === 'declined' || o.status === 'cancelled') {
          await w(recRef(id), 'delete'); on.settled.add(id); giveBundle(r.give);
          hist((r.kind === 'gift' ? 'Hadiah ke ' : 'Tukar dengan ') + who + (o.status === 'declined' ? ' ditolak' : ' dibatalkan') + ': barangmu kembali.');
          w(offerRef(id), 'delete').catch(function () {});
        } else if (o.status === 'claimed' && r.kind === 'gift') {
          await w(recRef(id), 'delete'); on.settled.add(id); hist('Hadiah ke ' + who + ' diterima.');
          w(offerRef(id), 'delete').catch(function () {});
        } else if ((o.status === 'accepted' || o.status === 'claimed') && r.kind === 'trade') {
          if (o.status === 'accepted') await w(offerRef(id), 'update', { status: 'claimed' });
          await w(recRef(id), 'delete'); on.settled.add(id); giveBundle(r.want);
          hist('Tukar dengan ' + who + ' berhasil: kamu menerima ' + bundleText(r.want) + '.');
          w(offerRef(id), 'delete').catch(function () {});
        }
      }
      // terminal offers of mine without a receipt are leftovers
      on.fromMe.forEach(function (o2, id2) { if (!on.rec.has(id2) && o2.status !== 'open' && o2.status !== 'accepted') w(offerRef(id2), 'delete').catch(function () {}); });
    } while (on.reconAgain);
  } catch (e) { noteWriteFail(e); }
  on.recon = false; changed();
}

/* ---- online: clans */
function clanMembers(id) {
  var out = [];
  if (S.transport === 'online') {
    if (!ON) return out;
    ON.players.forEach(function (p, pid) { if (p.clanId === id) out.push(pid); });
  } else {
    BOT_IDS.forEach(function (b) { if (BOTS[b].clan === id) out.push(b); });
    if (GT.state.clan && GT.state.clan.id === id) out.push('me');
  }
  return out;
}
async function onCreateClan(name, tag) {
  if (S.readOnly) return fail('Akunmu hanya bisa melihat.', 'readonly');
  var id = 'c_' + tag;
  try {
    var snap = await ON.db.collection('clans').doc(id).get();
    if (snap && snap.exists) return fail('Tag [' + tag + '] sudah dipakai klan lain.', 'taken');
    await w(ref('clans/' + id), 'set', { name: name, tag: tag, ownerUid: ON.uid, createdAt: now() });
    await setPlayerClan(id);
  } catch (e) { noteWriteFail(e); return fail(dbMsg(e), 'db'); }
  setMyClan({ id: id, name: name, tag: tag }); changed();
  return ok({ id: id });
}
async function setPlayerClan(clanId) {
  var mine = ON.players.get(ON.uid);
  await w(ref('players/' + ON.uid), mine ? 'update' : 'set', mine ? { clanId: clanId, updatedAt: now() } :
    { nick: cleanText(GT.state.playerName, NAME_MAX), role: GT.state.role === 'maling' ? 'maling' : 'warga', clanId: clanId, updatedAt: now() });
  if (ON.players.get(ON.uid)) ON.players.get(ON.uid).clanId = clanId; // optimistic; snapshot confirms
}
async function onJoinClan(id) {
  if (S.readOnly) return fail('Akunmu hanya bisa melihat.', 'readonly');
  var c = ON.clans.get(id); if (!c) return fail('Klan tidak ditemukan.', 'notfound');
  try { await setPlayerClan(id); } catch (e) { noteWriteFail(e); return fail(dbMsg(e), 'db'); }
  setMyClan(c); changed();
  return ok({ id: id });
}
async function onLeaveClan() {
  var cur = GT.state.clan; if (!cur) return fail('Kamu tidak ada di klan.', 'noclan');
  try {
    var others = clanMembers(cur.id).filter(function (m) { return m !== ON.uid; });
    await setPlayerClan(null);
    var c = ON.clans.get(cur.id);
    if (c && c.owner === ON.uid) {
      if (!others.length) await w(ref('clans/' + cur.id), 'delete');
      else await w(ref('clans/' + cur.id), 'update', { ownerUid: others[0] });
    }
  } catch (e) { noteWriteFail(e); return fail(dbMsg(e), 'db'); }
  setMyClan(null); changed();
  return ok({});
}

/* ---- online: room presence (cosmetic) */
function syncPeers(peers) {
  if (!ON) return;
  var uids = [], seen = {};
  (peers || []).forEach(function (p) {
    if (!p || p.isMe || p.kind !== 'viewer' || !validId(p.by) || p.by === ON.uid) return;
    if (!seen[p.by]) { seen[p.by] = p; uids.push(p.by); }
  });
  ON.peerUids = uids;
  resolveNames(uids);
  // remote characters on the outdoor map
  ON.remote.forEach(function (r, uid) { if (!seen[uid]) { try { GT.removeNpc(r.npc); } catch (e) {} ON.remote.delete(uid); } });
  uids.forEach(function (uid) {
    var pr = seen[uid].presence || {}, x = Math.round(Number(pr.x)), y = Math.round(Number(pr.y));
    var outdoors = pr.scene === 'out' && isFinite(x) && isFinite(y) && x >= 0 && y >= 0 && x < 60 && y < 60;
    var r = ON.remote.get(uid);
    if (!outdoors) { if (r) { GT.npcHide(r.npc, true); } return; }
    var dir = ['up', 'down', 'left', 'right'].indexOf(pr.dir) >= 0 ? pr.dir : 'down';
    if (!r) {
      if (!worldNow) return;
      var n = GT.addNpc('out', { x: x, y: y, name: nameOf(uid), pal: 6 + (hash(uid) % 2), wander: false, key: 'peer:' + uid, label: labelFor(uid), noAffinity: true, remote: true, dir: dir, lines: [['...']] });
      if (!n) return;
      n.isPlayer = true; n.isRemote = true; n.playerId = uid;
      ON.remote.set(uid, { npc: n }); return;
    }
    var npc = r.npc; r.target = { x: x, y: y, dir: dir };
    if (npc.hidden) { GT.npcHide(npc, false); GT.npcTeleport(npc, x, y, dir); return; }
    if (npc.x === x && npc.y === y) { npc.dir = dir; return; }
    var path = GT.findPath('out', { x: npc.x, y: npc.y }, { x: x, y: y });
    if (path && path.length && path.length <= 8) {
      GT.npcGo(npc, path, function (done) { // blocked (e.g. by my own character) -> jump to the last reported tile
        if (!(r.target && ON && ON.remote.get(uid) === r)) return;
        if (!done) GT.npcTeleport(npc, r.target.x, r.target.y, r.target.dir); else if (npc.x === r.target.x && npc.y === r.target.y) npc.dir = r.target.dir;
      });
    } else GT.npcTeleport(npc, x, y, dir);
  });
  changed();
}
function hash(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
function sendPresence() {
  if (!ON || !ON.room) return;
  var t = now(); if (t - ON.lastPresAt < 250) return;
  var p = GT.player, sc = GT.scene && GT.scene.kind === 'out' ? 'out' : 'in';
  var o = { x: p.x, y: p.y, dir: p.dir, scene: sc };
  var key = o.x + ',' + o.y + ',' + o.dir + ',' + o.scene;
  if (key === ON.lastPresence) return;
  ON.lastPresence = key; ON.lastPresAt = t;
  try { var pr = ON.room.presence(o); if (pr && pr.catch) pr.catch(function () {}); } catch (e) {}
}

/* ------------------------------------------------------------------ public ops (validated, transport-agnostic) */
function needReady() { return S.ready ? null : fail('Sosial belum siap.', 'notready'); }
function checkOffer(kind, to, give, want) {
  var nr = needReady(); if (nr) return nr;
  if (typeof to !== 'string' || !to) return fail('Pilih pemain tujuan.', 'notfound');
  if (to === myId()) return fail('Tidak bisa untuk diri sendiri.', 'self');
  var g = parseBundle(give, true); if (!g) return fail('Isi pemberianmu dengan jumlah bilangan bulat positif.', 'invalid');
  var wnt = {};
  if (kind === 'trade') { wnt = parseBundle(want, true); if (!wnt) return fail('Isi permintaanmu dengan jumlah bilangan bulat positif.', 'invalid'); }
  if (!hasBundle(g)) return fail('Barang atau koinmu tidak cukup.', 'insufficient');
  return { g: g, w: wnt };
}
function sendGift(to, give) {
  var c = checkOffer('gift', to, give, null); if (c.ok === false) return Promise.resolve(c);
  if (S.transport === 'online' && !BOTS[to]) return onSend('gift', to, c.g, {});
  return Promise.resolve(offSend('gift', to, c.g, {}));
}
function proposeTrade(to, give, want) {
  var c = checkOffer('trade', to, give, want); if (c.ok === false) return Promise.resolve(c);
  if (S.transport === 'online' && !BOTS[to]) return onSend('trade', to, c.g, c.w);
  return Promise.resolve(offSend('trade', to, c.g, c.w));
}
function respond(id, accept) {
  var nr = needReady(); if (nr) return Promise.resolve(nr);
  if (typeof id !== 'string') return Promise.resolve(fail('Tawaran tidak ditemukan.', 'notfound'));
  if (S.transport === 'online' && !isLocalOffer(id)) return onRespond(id, !!accept);
  return Promise.resolve(offRespond(id, !!accept));
}
function cancel(id) {
  var nr = needReady(); if (nr) return Promise.resolve(nr);
  if (S.transport === 'online' && !isLocalOffer(String(id))) return onCancel(String(id));
  return Promise.resolve(offCancel(String(id)));
}
function clanCheck(name, tag) {
  var nr = needReady(); if (nr) return nr;
  if (GT.state.clan) return fail('Kamu sudah ada di klan. Keluar dulu.', 'inclan');
  name = cleanText(String(name == null ? '' : name), NAME_MAX);
  tag = String(tag == null ? '' : tag).trim().toUpperCase();
  if (!name) return fail('Nama klan wajib diisi (maks. ' + NAME_MAX + ' huruf).', 'invalid');
  if (!validTag(tag)) return fail('Tag klan 2-4 karakter, hanya A-Z dan 0-9.', 'invalid');
  return { name: name, tag: tag };
}
function createClan(name, tag) {
  var c = clanCheck(name, tag); if (c.ok === false) return Promise.resolve(c);
  if (S.transport === 'online') return onCreateClan(c.name, c.tag);
  if (offlineClans().some(function (x) { return x.tag === c.tag; })) return Promise.resolve(fail('Tag [' + c.tag + '] sudah dipakai klan lain.', 'taken'));
  var cl = { id: 'local:' + c.tag, name: c.name, tag: c.tag, owner: 'me' };
  L.clans.push(cl); setMyClan(cl); refreshLabels(); saveLocal(); changed();
  return Promise.resolve(ok({ id: cl.id }));
}
function joinClan(id) {
  var nr = needReady(); if (nr) return Promise.resolve(nr);
  if (GT.state.clan) return Promise.resolve(fail('Kamu sudah ada di klan. Keluar dulu.', 'inclan'));
  if (S.transport === 'online') return onJoinClan(String(id));
  var c = offlineClans().filter(function (x) { return x.id === id; })[0];
  if (!c) return Promise.resolve(fail('Klan tidak ditemukan.', 'notfound'));
  setMyClan(c); refreshLabels(); changed();
  return Promise.resolve(ok({ id: c.id }));
}
function leaveClan() {
  var nr = needReady(); if (nr) return Promise.resolve(nr);
  if (!GT.state.clan) return Promise.resolve(fail('Kamu tidak ada di klan.', 'noclan'));
  if (S.transport === 'online') return onLeaveClan();
  var cur = GT.state.clan;
  setMyClan(null);
  // a local clan with nobody left disappears
  if (/^local:/.test(cur.id)) L.clans = L.clans.filter(function (c) { return c.id !== cur.id; });
  refreshLabels(); saveLocal(); changed();
  return Promise.resolve(ok({}));
}
function clansView() {
  var list = S.transport === 'online' ? (ON ? Array.from(ON.clans.values()) : []) : offlineClans();
  return list.map(function (c) {
    var mem = clanMembers(c.id);
    return { id: c.id, name: c.name, tag: c.tag, members: mem.map(function (m) { return { id: m, name: nameOf(m) }; }), mine: !!(GT.state.clan && GT.state.clan.id === c.id) };
  });
}

/* ------------------------------------------------------------------ UI */
function injectCss() {
  if (document.getElementById('sx-css')) return;
  var st = document.createElement('style'); st.id = 'sx-css';
  st.textContent =
    '.sx-tabs{display:flex;gap:4px;margin:0 0 8px}' +
    '.sx-tab{flex:1 1 0;min-width:0;min-height:34px;padding:6px 2px;border:2px solid var(--paper-ink);border-radius:4px;background:#fff;color:var(--paper-ink);font-size:8px;line-height:1.3;overflow-wrap:anywhere}' +
    '.sx-tab[aria-selected=true]{background:var(--paper-ink);color:var(--paper)}' +
    '.sx-tab:focus-visible{outline:3px solid #2d7ad6;outline-offset:2px}' +
    '.sx-info{flex:1 1 120px;min-width:0}' +
    '.sx-info b{font-weight:400;overflow-wrap:anywhere}' +
    '.sx-tag{color:#8a5a00}.sx-role{display:inline-block;padding:0 4px;border-radius:3px;background:var(--good);color:#e9ffe0;font-size:7px;margin-left:4px}' +
    '.sx-role.maling{background:var(--bad);color:#ffe3e3}.sx-on{color:#2f6b3a}.sx-off{color:#6b6e8f}' +
    '.sx-acts{display:flex;gap:4px;flex-wrap:wrap;margin-left:auto}' +
    '.sx-row{flex-wrap:wrap}' +
    '.sx-item{display:inline-flex;align-items:center;gap:3px;margin-right:8px;white-space:nowrap}.sx-bundle{display:block;margin:2px 0}' +
    '.sx-err{color:var(--bad);min-height:1.4em}.sx-sec{margin:0 0 4px;font-weight:700}' +
    '.sx-step{display:inline-flex;align-items:center;gap:4px}.mrow .sx-step .num{min-width:3ch;text-align:center;color:var(--paper-ink)}' +
    '.sx-step .mbtn{min-width:30px;padding:4px 6px}' +
    '.sx-hist{margin:4px 0 0;padding:0;list-style:none}.sx-hist li{padding:2px 0;border-bottom:1px dotted var(--paper-edge)}' +
    '.sx-badge{display:inline-block;padding:0 5px;border-radius:3px;background:var(--paper-ink);color:var(--gold);font-size:8px;margin-bottom:6px}' +
    '@media (max-width:420px){.sx-acts{margin-left:0;width:100%}.sx-acts .mbtn{flex:1 1 0}}';
  document.head.appendChild(st);
}
function btn(label, fn, cls, key) {
  var b = h('button', 'mbtn' + (cls ? ' ' + cls : ''), label); b.type = 'button';
  if (key) b.setAttribute('data-fk', key);
  b.addEventListener('click', function (e) { e.stopPropagation(); fn(b); });
  return b;
}
function bundleEl(b) {
  var s = h('span', 'sx-bundle');
  bundleKeys(b).forEach(function (k) {
    var i = h('span', 'sx-item'); i.appendChild(GT.iconEl(itemIcon(k), 16)); i.appendChild(document.createTextNode(itemLabel(k) + ' x' + b[k])); s.appendChild(i);
  });
  return s;
}
function nameLine(id) {
  var wrap = h('span'), t = tagOf(id);
  var b = h('b', null, nameOf(id)); wrap.appendChild(b);
  if (t) wrap.appendChild(h('span', 'sx-tag', ' [' + t + ']'));
  return wrap;
}

function openPanel(tab) {
  if (panel && panel.isOpen()) { if (tab) { curTab = tab; renderPanel(); } return panel; }
  if (GT.isUiOpen()) return null;
  if (tab) curTab = tab;
  panel = GT.modal({
    title: 'Sosial', wide: true, backdropClose: false,
    actions: [{ label: 'Tutup', primary: true }],
    onClose: function () { panel = null; },
    onKey: function (e) {
      var a = document.activeElement;
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && a && a.classList && a.classList.contains('sx-tab')) {
        var order = ['pemain', 'masuk', 'terkirim', 'klan'], i = order.indexOf(curTab);
        curTab = order[(i + (e.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length];
        renderPanel('tab-' + curTab); return true;
      }
      return false;
    }
  });
  renderPanel();
  return panel;
}
function renderPanel(focusKey) {
  if (!panel || !panel.isOpen()) return;
  var body = panel.body, scroll = body.scrollTop;
  var act = document.activeElement, fk = focusKey || (act && act.getAttribute && act.getAttribute('data-fk'));
  var selS = null, selE = null;
  if (!focusKey && act && act.tagName === 'INPUT') { selS = act.selectionStart; selE = act.selectionEnd; }
  var wrap = h('div');
  var badge = h('div', 'sx-badge', !S.ready ? 'Menghubungkan...' : S.transport === 'online' ? 'Online' : 'Offline (pemain simulasi)');
  wrap.appendChild(badge);
  if (S.readOnly) wrap.appendChild(h('p', 'mnote', 'Akunmu hanya bisa melihat: kirim, terima, dan klan dinonaktifkan.'));
  if (S.onlineErr) wrap.appendChild(h('p', 'sx-err', S.onlineErr));
  var tabs = h('div', 'sx-tabs'); tabs.setAttribute('role', 'tablist');
  var ni = inboxList().length;
  [['pemain', 'Pemain'], ['masuk', 'Masuk' + (ni ? ' (' + ni + ')' : '')], ['terkirim', 'Terkirim'], ['klan', 'Klan']].forEach(function (t) {
    var b = h('button', 'sx-tab', t[1]); b.type = 'button'; b.setAttribute('role', 'tab'); b.setAttribute('data-fk', 'tab-' + t[0]);
    b.setAttribute('aria-selected', String(curTab === t[0])); b.tabIndex = curTab === t[0] ? 0 : -1;
    b.addEventListener('click', function () { curTab = t[0]; formErr = ''; renderPanel('tab-' + t[0]); });
    tabs.appendChild(b);
  });
  wrap.appendChild(tabs);
  var content = h('div'); content.setAttribute('role', 'tabpanel');
  if (!S.ready) content.appendChild(h('p', 'mnote', 'Memeriksa koneksi...'));
  else if (curTab === 'pemain') tabPemain(content);
  else if (curTab === 'masuk') tabMasuk(content);
  else if (curTab === 'terkirim') tabTerkirim(content);
  else tabKlan(content);
  wrap.appendChild(content);
  panel.setBody(wrap);
  body.scrollTop = scroll;
  if (fk) {
    var el = body.querySelector('[data-fk="' + fk + '"]');
    if (el) { try { el.focus({ preventScroll: true }); if (selS != null && el.setSelectionRange) el.setSelectionRange(selS, selE); } catch (e) {} }
  }
}
function tabPemain(c) {
  var list = playerList();
  if (!list.length) c.appendChild(h('p', 'mnote', S.transport === 'online' ? 'Belum ada pemain lain. Ajak temanmu membuka artifact ini.' : 'Tidak ada pemain.'));
  list.forEach(function (p) {
    var row = h('div', 'mrow sx-row'), info = h('div', 'sx-info');
    info.appendChild(nameLine(p.id));
    var r = h('span', 'sx-role' + (p.role === 'maling' ? ' maling' : ''), p.role === 'maling' ? 'MALING' : 'WARGA'); info.appendChild(r);
    info.appendChild(h('div', p.online ? 'sx-on' : 'sx-off', p.bot ? 'Pemain simulasi' : p.online ? 'Sedang online' : 'Tidak online'));
    row.appendChild(info);
    var acts = h('div', 'sx-acts');
    var g = btn('Beri', function () { openComposer('gift', p); }, '', 'give-' + p.id); g.disabled = S.readOnly;
    var t = btn('Tukar', function () { openComposer('trade', p); }, '', 'trade-' + p.id); t.disabled = S.readOnly;
    acts.appendChild(g); acts.appendChild(t); acts.appendChild(btn('Profil', function () { openProfileOf(p.id); }, '', 'prof-' + p.id));
    row.appendChild(acts); c.appendChild(row);
  });
}
function tabMasuk(c) {
  var list = inboxList();
  if (!list.length) c.appendChild(h('p', 'mnote', 'Kotak masuk kosong. Tawaran dari pemain lain muncul di sini.'));
  list.forEach(function (o) {
    var row = h('div', 'mrow sx-row'), info = h('div', 'sx-info');
    var head = h('div'); head.appendChild(nameLine(o.from)); head.appendChild(document.createTextNode(o.kind === 'gift' ? ' mengirim hadiah' : ' mengajak tukar')); info.appendChild(head);
    info.appendChild(h('div', 'mnote', o.kind === 'gift' ? 'Isi hadiah:' : 'Kamu dapat:')); info.appendChild(bundleEl(o.give));
    if (o.kind === 'trade') { info.appendChild(h('div', 'mnote', 'Dia minta:')); info.appendChild(bundleEl(o.want)); }
    var lack = o.kind === 'trade' && !hasBundle(o.want);
    if (lack) info.appendChild(h('div', 'sx-err', 'Kamu belum punya yang diminta.'));
    row.appendChild(info);
    var acts = h('div', 'sx-acts');
    var a = btn('Terima', function (b) { b.disabled = true; respond(o.id, true).then(function (r) { toast(r.ok ? 'Tawaran diterima.' : r.error); changed(); }); }, 'primary', 'acc-' + o.id);
    a.disabled = lack || S.readOnly;
    var d = btn('Tolak', function (b) { b.disabled = true; respond(o.id, false).then(function (r) { toast(r.ok ? 'Tawaran ditolak.' : r.error); changed(); }); }, '', 'dec-' + o.id);
    d.disabled = S.readOnly;
    acts.appendChild(a); acts.appendChild(d); row.appendChild(acts); c.appendChild(row);
  });
  histEl(c);
}
function tabTerkirim(c) {
  var list = sentList();
  if (!list.length) c.appendChild(h('p', 'mnote', 'Belum ada tawaran terkirim.'));
  list.forEach(function (o) {
    var row = h('div', 'mrow sx-row'), info = h('div', 'sx-info');
    var head = h('div'); head.appendChild(document.createTextNode((o.kind === 'gift' ? 'Hadiah untuk ' : 'Tukar dengan '))); head.appendChild(nameLine(o.to)); info.appendChild(head);
    info.appendChild(h('div', 'mnote', 'Kamu beri:')); info.appendChild(bundleEl(o.give));
    if (o.kind === 'trade') { info.appendChild(h('div', 'mnote', 'Kamu minta:')); info.appendChild(bundleEl(o.want)); }
    info.appendChild(h('div', null, 'Status: ' + (STATUS_ID[o.status] || o.status)));
    row.appendChild(info);
    if (o.status === 'open' || o.status === 'missing') {
      var acts = h('div', 'sx-acts');
      acts.appendChild(btn('Batalkan', function (b) { b.disabled = true; cancel(o.id).then(function (r) { toast(r.ok ? 'Dibatalkan, barang kembali.' : r.error); changed(); }); }, '', 'can-' + o.id));
      row.appendChild(acts);
    }
    c.appendChild(row);
  });
  histEl(c);
}
function histEl(c) {
  if (!S.hist.length) return;
  c.appendChild(h('p', 'sx-sec', 'Riwayat'));
  var ul = h('ul', 'sx-hist'); S.hist.forEach(function (x) { ul.appendChild(h('li', null, x.text)); }); c.appendChild(ul);
}
function tabKlan(c) {
  var cur = GT.state.clan;
  if (cur) {
    var cl = clansView().filter(function (x) { return x.id === cur.id; })[0];
    var hd = h('p'); hd.appendChild(h('b', 'sx-tag', '[' + cur.tag + '] ')); hd.appendChild(h('b', null, cur.name)); c.appendChild(hd);
    c.appendChild(h('p', 'sx-sec', 'Anggota' + (cl ? ' (' + cl.members.length + ')' : '')));
    (cl ? cl.members : []).forEach(function (m) { c.appendChild(h('div', 'mrow', m.name + (m.id === myId() && m.name !== 'Kamu' ? ' (kamu)' : ''))); });
    var err = h('p', 'sx-err', formErr); err.setAttribute('role', 'alert'); c.appendChild(err);
    var lb = btn('Keluar klan', function (b) { b.disabled = true; leaveClan().then(function (r) { formErr = r.ok ? '' : r.error; if (r.ok) toast('Kamu keluar dari klan.'); changed(); }); }, '', 'leave');
    lb.disabled = S.readOnly; c.appendChild(lb);
    return;
  }
  c.appendChild(h('p', 'sx-sec', 'Buat klan'));
  var f1 = h('label', 'mfield'); f1.appendChild(h('span', null, 'Nama klan (maks. ' + NAME_MAX + ')'));
  var i1 = h('input'); i1.type = 'text'; i1.maxLength = NAME_MAX; i1.autocomplete = 'off'; i1.value = formName; i1.setAttribute('data-fk', 'f-name');
  i1.addEventListener('input', function () { formName = i1.value; }); f1.appendChild(i1);
  var f2 = h('label', 'mfield'); f2.appendChild(h('span', null, 'Tag (2-4 huruf/angka)'));
  var i2 = h('input'); i2.type = 'text'; i2.maxLength = 4; i2.autocomplete = 'off'; i2.autocapitalize = 'characters'; i2.value = formTag; i2.setAttribute('data-fk', 'f-tag');
  i2.addEventListener('input', function () { var v = i2.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); if (v !== i2.value) i2.value = v; formTag = v; }); f2.appendChild(i2);
  c.appendChild(f1); c.appendChild(f2);
  var err2 = h('p', 'sx-err', formErr); err2.setAttribute('role', 'alert'); c.appendChild(err2);
  var cb = btn('Buat klan', function (b) {
    b.disabled = true;
    createClan(formName, formTag).then(function (r) {
      if (!r.ok) { formErr = r.error; b.disabled = false; } else { formName = ''; formTag = ''; formErr = ''; toast('Klan dibuat!'); }
      changed();
    });
  }, 'primary', 'create'); cb.disabled = S.readOnly; c.appendChild(cb);
  c.appendChild(h('p', 'sx-sec', 'Gabung klan'));
  var cls = clansView();
  if (!cls.length) c.appendChild(h('p', 'mnote', 'Belum ada klan.'));
  cls.forEach(function (x) {
    var row = h('div', 'mrow sx-row'), info = h('div', 'sx-info');
    var t = h('div'); t.appendChild(h('b', 'sx-tag', '[' + x.tag + '] ')); t.appendChild(h('b', null, x.name)); info.appendChild(t);
    info.appendChild(h('div', 'mnote', x.members.length + ' anggota: ' + (x.members.map(function (m) { return m.name; }).join(', ') || '-'))); row.appendChild(info);
    var acts = h('div', 'sx-acts'); var jb = btn('Gabung', function (b) { b.disabled = true; joinClan(x.id).then(function (r) { toast(r.ok ? 'Kamu bergabung ke [' + x.tag + '].' : r.error); changed(); }); }, '', 'join-' + x.id);
    jb.disabled = S.readOnly; acts.appendChild(jb); row.appendChild(acts); c.appendChild(row);
  });
}

/* ---- composer: choose what to give (and want) */
function openComposer(kind, rec, preset) {
  if (!S.ready) { toast('Sosial belum siap.'); return null; }
  if (S.readOnly) { toast('Akunmu hanya bisa melihat.'); return null; }
  var give = {}, want = {};
  if (preset && (GT.state.inventory[preset] || 0) > 0) give[preset] = 1;
  var wrap = h('div');
  wrap.appendChild(h('p', 'mnote', kind === 'gift' ? 'Beri hadiah ke ' + rec.name + '. Barang langsung dipegang (escrow) sampai dijawab.' : 'Ajak ' + rec.name + ' tukar barang. Barangmu dipegang (escrow) sampai dijawab.'));
  var err = h('p', 'sx-err'); err.setAttribute('role', 'alert');
  function section(title, opts, store) {
    var sec = h('div'); sec.appendChild(h('p', 'sx-sec', title));
    if (!opts.length) sec.appendChild(h('p', 'mnote', 'Tidak ada yang bisa dipilih.'));
    opts.forEach(function (o) {
      var row = h('div', 'mrow'); row.appendChild(GT.iconEl(itemIcon(o.id), 16));
      row.appendChild(h('span', 'grow', itemLabel(o.id) + ' (maks. ' + o.max + ')'));
      var st = h('span', 'sx-step'), num = h('span', 'num', String(store[o.id] || 0)), step = o.id === 'koin' ? 10 : 1;
      function set(v) { v = Math.max(0, Math.min(o.max, v)); if (v) store[o.id] = v; else delete store[o.id]; num.textContent = String(v); err.textContent = ''; }
      var mi = btn('-', function () { set((store[o.id] || 0) - step); }); mi.setAttribute('aria-label', 'Kurangi ' + itemLabel(o.id));
      var pl = btn('+', function () { set((store[o.id] || 0) + step); }); pl.setAttribute('aria-label', 'Tambah ' + itemLabel(o.id));
      st.appendChild(mi); st.appendChild(num); st.appendChild(pl); row.appendChild(st); sec.appendChild(row);
    });
    return sec;
  }
  var mine = Object.keys(GT.state.inventory).filter(function (k) { return GT.state.inventory[k] > 0 && itemOk(k); }).map(function (k) { return { id: k, max: Math.min(MAX_QTY, GT.state.inventory[k]) }; });
  if (GT.state.coins > 0) mine.push({ id: 'koin', max: Math.min(MAX_KOIN, GT.state.coins) });
  wrap.appendChild(section('Kamu beri', mine, give));
  if (kind === 'trade') {
    var theirs;
    if (rec.bot && L.bots[rec.id]) {
      var bt = L.bots[rec.id];
      theirs = Object.keys(bt.inv).filter(function (k) { return bt.inv[k] > 0; }).map(function (k) { return { id: k, max: bt.inv[k] }; });
      if (bt.coins > 0) theirs.push({ id: 'koin', max: bt.coins });
    } else {
      theirs = Object.keys(GT.ITEMS).map(function (k) { return { id: k, max: 99 }; }); theirs.push({ id: 'koin', max: 1000 });
    }
    wrap.appendChild(section('Kamu minta', theirs, want));
  }
  wrap.appendChild(err);
  var hnd = GT.modal({
    title: kind === 'gift' ? 'Beri hadiah' : 'Ajak tukar', body: wrap,
    actions: [
      { label: 'Kirim', primary: true, id: 'send', onClick: function (m) {
        if (!bundleKeys(give).length) { err.textContent = 'Pilih barang atau koin yang diberikan.'; return false; }
        if (kind === 'trade' && !bundleKeys(want).length) { err.textContent = 'Pilih barang yang diminta.'; return false; }
        var b = m.btn('send'); if (b) b.disabled = true;
        (kind === 'gift' ? sendGift(rec.id, give) : proposeTrade(rec.id, give, want)).then(function (r) {
          if (r.ok) { m.close(); toast(kind === 'gift' ? 'Hadiah dikirim ke ' + rec.name + '.' : 'Ajakan tukar dikirim ke ' + rec.name + '.'); changed(); }
          else { err.textContent = r.error; if (b) b.disabled = false; }
        });
        return false;
      } },
      { label: 'Batal' }
    ]
  });
  return hnd;
}
function openProfileOf(id) {
  var p = playerRec(id); if (!p) return null;
  var wrap = h('div');
  var l1 = h('p'); l1.appendChild(nameLine(id)); wrap.appendChild(l1);
  wrap.appendChild(h('p', null, 'Peran: ' + (p.role === 'maling' ? 'Maling' : 'Warga')));
  var c = p.bot ? clanById(BOTS[id].clan) : clanById(ON && ON.players.get(id) && ON.players.get(id).clanId);
  wrap.appendChild(h('p', null, 'Klan: ' + (c ? '[' + c.tag + '] ' + c.name : '-')));
  if (p.bot && L.bots[id]) {
    var b = L.bots[id], inv = Object.keys(b.inv).map(function (k) { return itemLabel(k) + ' x' + b.inv[k]; }).join(', ');
    wrap.appendChild(h('p', null, 'Koin: ' + b.coins)); wrap.appendChild(h('p', null, 'Tas: ' + (inv || '-')));
    var aff = GT.getAffinity(offNpcFor(id)); var hearts = Math.max(0, Math.min(5, Math.floor(aff / 20)));
    wrap.appendChild(h('p', null, 'Akrab: ' + new Array(hearts + 1).join('♥') + new Array(6 - hearts).join('♡')));
    wrap.appendChild(h('p', 'mnote', 'Pemain simulasi (offline).'));
  } else wrap.appendChild(h('p', 'mnote', p.online ? 'Sedang online.' : 'Tidak online.'));
  return GT.modal({ title: 'Profil pemain', body: wrap, backdropClose: true, actions: [
    { label: 'Beri', onClick: function (m) { m.close(); openComposer('gift', p); } },
    { label: 'Tukar', onClick: function (m) { m.close(); openComposer('trade', p); } },
    { label: 'Tutup', primary: true }
  ] });
}
function openPlayerMenu(rec, preset) {
  GT.menu(rec.name + (rec.tag ? ' [' + rec.tag + ']' : ''), [
    { label: 'Beri hadiah', onPick: function () { openComposer('gift', rec, preset); } },
    { label: 'Ajak tukar', onPick: function () { openComposer('trade', rec, preset); } },
    { label: 'Lihat profil', onPick: function () { openProfileOf(rec.id); } },
    { label: 'Tidak jadi', onPick: function () {} }
  ]);
}

/* ------------------------------------------------------------------ engine hooks */
function npcRec(n) { return n && n.playerId ? playerRec(n.playerId) : null; }
function onInteract(ctx) {
  var n = ctx && ctx.npc;
  if (!n || !n.isPlayer) return false;
  var rec = npcRec(n);
  if (!rec) return false;
  if (ctx.mode === 'message') {
    var line = n.isBot ? pick(BOTS[n.playerId].lines) : '(' + rec.name + ' adalah pemain sungguhan. Pakai menu Sosial untuk berinteraksi.)';
    GT.dialog([line], rec.name, n.isBot ? n : null);
    return true;
  }
  if (n.isBot) GT.npcSay(n, pick(['Hai!', 'Halo, ' + nameOf('me') + '!', 'Ada apa?']));
  openPlayerMenu(rec);
  return true;
}
function giveHandler(itemId) {
  if (!S.ready) { toast('Sosial belum siap.'); return true; }
  var f = GT.facing(), sc = GT.scene, target = null;
  if (sc && sc.npcs) sc.npcs.forEach(function (n) { if (n.isPlayer && !n.hidden && Math.round(n.x) === f.x && Math.round(n.y) === f.y) target = npcRec(n); });
  if (target) { openPlayerMenu(target, itemId); return true; }
  var list = playerList();
  if (!list.length) { toast('Belum ada pemain lain untuk diberi.'); return true; }
  GT.menu('Beri ' + GT.itemName(itemId) + ' ke...', list.map(function (p) { return { label: p.name + (p.tag ? ' [' + p.tag + ']' : ''), onPick: function () { openComposer('gift', p, itemId); } }; }));
  return true;
}

var frameAcc = 0, selfAcc = 0;
function onFrame(dt) {
  if (!S.ready) return;
  frameAcc += dt;
  if (L) {
    var t = now();
    for (var i = 0; i < L.offers.length; i++) { var o = L.offers[i]; if (o.from === 'me' && o.status === 'open' && o.due && o.due <= t) { botDecide(o); break; } }
    if (frameAcc >= 0.5) { frameAcc = 0; botTick(); }
  }
  if (S.transport === 'online' && ON) {
    sendPresence();
    selfAcc += dt;
    if (selfAcc >= 1) { selfAcc = 0; syncSelf(); if (ON.got.rec && ON.got.from) {
      var pend = false; ON.rec.forEach(function (r) { if (r.phase === 'pending') pend = true; });
      if (pend) { buildSent(); reconcileSoon(); }
    } }
  }
}
var reconTimer = 0;
function reconcileSoon() { if (reconTimer) return; reconTimer = setTimeout(function () { reconTimer = 0; reconcile(); }, 0); }
function onWorld(world) {
  worldNow = world;
  if (!S.ready) return;
  populateWorld();
}
function populateWorld() {
  populateBots();
  if (S.transport === 'online' && ON) { ON.remote.clear(); ON.lastPresence = ''; if (ON.room) { try { syncPeers(ON.room.peers()); } catch (e) {} } }
}

function init() {
  injectCss();
  hudBtn = GT.addHudButton({ id: 'btnSosial', label: 'Sosial', key: 'o', onClick: function () { if (!GT.isUiOpen()) openPanel(); } });
  if (hudBtn) hudBtn.setAttribute('aria-label', 'Sosial (O)');
  if (!GT.giveHandler) GT.giveHandler = giveHandler;
  loadL();
  start();
}
async function start() {
  var db = null, user = null, room = null, uid = null;
  try {
    db = await GT.cap('db'); user = await GT.cap('user');
    if (db && user) {
      try { uid = await user.id(); } catch (e) { uid = null; }
      if (!validId(uid)) uid = null;
    }
    if (db && user && uid) room = await GT.cap('room');
  } catch (e) { db = user = room = uid = null; }
  if (db && user && uid) {
    try { startOnline(db, user, room, uid); } catch (e) { console.error('[social] online start failed', e); ON = null; S.transport = 'offline'; }
  }
  if (!L) loadL();
  S.ready = true;
  if (worldNow) populateWorld();
  updateBadge(); changed();
}

GT.register({ id: 'social', init: init, onWorld: onWorld, onFrame: onFrame, onInteract: onInteract });

/* ------------------------------------------------------------------ QA / public API */
GT.social = {
  get transport() { return S.transport; },
  get ready() { return S.ready; },
  get readOnly() { return S.readOnly; },
  players: playerList,
  inbox: function () { return inboxList().map(function (o) { return { id: o.id, from: o.from, kind: o.kind, give: o.give, want: o.want, status: o.status }; }); },
  sent: function () { return sentList().map(function (o) { return { id: o.id, to: o.to, kind: o.kind, give: o.give, want: o.want, status: o.status }; }); },
  clans: clansView,
  sendGift: sendGift,
  proposeTrade: proposeTrade,
  respond: respond,
  cancel: cancel,
  createClan: createClan,
  joinClan: joinClan,
  leaveClan: leaveClan,
  history: function () { return S.hist.slice(); },
  open: openPanel,
  openComposer: openComposer,
  // test hooks
  _botOffer: function (id, kind) { return botMakeOffer(id, kind); },
  _botNpcs: function () { return botNpc; },
  _bots: function () { return L ? L.bots : null; },
  _store: function () { return L; },
  _flush: function () { if (S.transport === 'online') return reconcile(); if (L) { L.offers.forEach(function (o) { if (o.from === 'me' && o.status === 'open') o.due = 1; }); } return Promise.resolve(); },
  _sanitize: { bundle: parseBundle, offer: cleanOffer },
  _on: function () { return ON; }
};
})();

