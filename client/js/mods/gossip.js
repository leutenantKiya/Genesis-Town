/* gossip.js - Gosip warga (Genesis Town v2.4).
 * GT.gossip = {list(), knows(npc, id), create(o), learn(npc, id), spread(force), forNpc(npc), aboutPlayer(), wary(),
 *   onTheft(house, witness), summary(), _meet(a, b), _tick(dt), _clear(), _forceMention(true|false|null)}
 *
 * Item: {id, kind:'pukul'|'curi'|'maling_anon', about:'player'|npcKey, aboutName, victim:npcKey, victimName, place, day, heat, t0}
 * - Pemain memukul NPC -> korban tahu 'pukul' (sekali per korban per jam game). NPC memukul NPC -> gosip tentang penyerang.
 * - Pencurian peti: dilihat (penghuni di dalam) -> 'curi' bernama; tidak dilihat -> 'maling_anon' saat penghuni pulang (jam malam);
 *   warga waspada (peluang saksi +10% selama 1 hari game).
 * - Menyebar siang hari di luar (tiap ~2 dtk, NPC dalam 2 tile, peluang 35%, maks 3 lompatan per jam game).
 * - Tahu gosip tentang pemain: afinitas -5 (sekali per gosip), disebut saat diajak bicara (50%), petugas polisi yang tahu
 *   gosip bernama -> pemain jadi buronan (GT.police.setWanted). Gosip pudar setelah 2 hari game. Disimpan per seed.
 */
(function(){
if (!window.GT_FLAGS || !window.GT_FLAGS.gossip) return; // feature flag: off in the submission build (js/flags.js)
'use strict';
if (!window.GT) return;
var GT = window.GT;
var LS = 'gt.gossip.v1';
var LIFE = 2 * 1440, SPREAD_EVERY = 2, CHANCE = 0.35, MAX_HOPS = 3, WARY_MIN = 1440;

var items = [];            // gossip items
var knows = {};            // id -> {npcKey:1}
var fxDone = {};           // id -> {npcKey:1} (afinitas sudah turun)
var pending = [];          // pencurian tak terlihat menunggu penghuni pulang: {houseId, owner, place, t0}
var seq = 1, clk = 0, acc = 0, hopHour = -1, hops = 0, waryUntil = -1;
var lastHit = {};          // 'a>b' -> menit game
var lastOnPlayer = {};     // npcKey -> clk saat NPC itu terakhir memukul pemain (pemain membela diri = tidak jadi gosip)
var saved = null, forceMention = null, saveT = 0;

function el(tag, cls, text){ var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function out(){ return GT.outScene; }
function total(){ return (GT.time && GT.time.total) || 0; }
function dayNow(){ return (GT.time && GT.time.day) || 1; }
function keyOf(n){ return typeof n === 'string' ? n : GT.npcKey(n); }
function npcOf(k){ if (k && typeof k === 'object') return k; try { return GT.findNpc(k); } catch(e){ return null; } }
function isWorker(n){ var k = (n && n.key) || ''; return /:keeper$/.test(k) || k === 'casino:dealer' || !!(n && n._post); }
function curfewOn(){
  try { if (GT.curfew && GT.curfew.active) return !!GT.curfew.active(); } catch(e){}
  var h = GT.time && GT.time.h; return h >= 21 || h < 6;
}
function itemById(id){ for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i]; return null; }

/* ---------- persistence (per seed) ---------- */
function persistNow(){
  saveT = 0;
  try {
    saved = { v:1, seed:GT.seed, items:items, knows:knows, fx:fxDone, pending:pending, seq:seq, wary:waryUntil };
    window.localStorage.setItem(LS, JSON.stringify(saved));
  } catch(e){}
}
function persist(){ if (!saveT) saveT = setTimeout(persistNow, 400); }
function load(){
  try { saved = JSON.parse(window.localStorage.getItem(LS) || 'null'); } catch(e){ saved = null; }
}
function restoreOrClear(){
  items = []; knows = {}; fxDone = {}; pending = []; seq = 1; waryUntil = -1; lastHit = {}; lastOnPlayer = {};
  if (saved && saved.seed === GT.seed && Array.isArray(saved.items)){
    items = saved.items.filter(function(it){ return it && it.id && it.kind; });
    knows = saved.knows || {}; fxDone = saved.fx || {}; pending = Array.isArray(saved.pending) ? saved.pending : [];
    seq = Math.max(+saved.seq || 1, items.reduce(function(m, it){ return Math.max(m, +it.id || 0); }, 0) + 1);
    waryUntil = isFinite(+saved.wary) ? +saved.wary : -1;
  }
}

/* ---------- text ---------- */
function snippet(it){
  if (it.kind === 'maling_anon') return 'Ada maling di ' + it.place + '!';
  if (it.kind === 'curi') return 'Katanya ada yang mencuri di ' + it.place + '!';
  if (it.about === 'player') return 'Katanya dia mukul ' + it.victimName + '!';
  return 'Katanya ' + (it.aboutName || 'seseorang') + ' mukul ' + it.victimName + '!';
}
function describe(it){
  var pn = (GT.state && GT.state.playerName) || 'Pemain';
  if (it.kind === 'maling_anon') return 'Ada maling di ' + it.place + ' (hari ' + it.day + ')';
  if (it.kind === 'curi') return (it.about === 'player' ? pn : (it.aboutName || 'Seseorang')) + ' mencuri di ' + it.place + ' (hari ' + it.day + ')';
  return (it.about === 'player' ? pn : (it.aboutName || 'Seseorang')) + ' memukul ' + it.victimName + ' (hari ' + it.day + ')';
}

/* ---------- core ---------- */
function create(o){
  o = o || {};
  var kind = o.kind;
  if (kind !== 'pukul' && kind !== 'curi' && kind !== 'maling_anon') return null;
  var vk = o.victim ? keyOf(o.victim) : '';
  var vn = o.victimName || (npcOf(o.victim) ? npcOf(o.victim).name : '') || '';
  var an = o.aboutName || '';
  if (o.about && o.about !== 'player' && !an){ var an0 = npcOf(o.about); an = an0 ? an0.name : ''; }
  var it = { id:seq++, kind:kind, about:(o.about && o.about !== 'player') ? keyOf(o.about) : 'player', aboutName:an, victim:vk, victimName:vn,
    place:o.place || 'kota', day:dayNow(), heat:o.heat != null ? o.heat : (kind === 'maling_anon' ? 1 : 2), t0:total() };
  items.push(it); knows[it.id] = {}; fxDone[it.id] = {};
  if (kind === 'maling_anon') waryUntil = total() + WARY_MIN;
  (o.knowers || []).forEach(function(n){ if (n) learn(n, it.id, null, true); });
  persist();
  try { GT.emit('gossip', { gossip:it }); } catch(e){}
  return it;
}
/* npc mengetahui gosip. quiet = tanpa efek 'korban' tambahan */
function learn(npc, id, from){
  var it = typeof id === 'object' ? id : itemById(id); npc = npcOf(npc);
  if (!it || !npc) return false;
  var k = keyOf(npc), kn = knows[it.id] || (knows[it.id] = {});
  if (kn[k]) return false;
  kn[k] = 1;
  var fx = fxDone[it.id] || (fxDone[it.id] = {});
  if (it.about === 'player' && (it.kind === 'pukul' || it.kind === 'curi')){
    var isVictimHit = it.kind === 'pukul' && it.victim === k;      // korban sudah kehilangan 10 afinitas karena pukulan
    if (!fx[k] && !isVictimHit && !npc.isPolice && !npc.noAffinity){ fx[k] = 1; try { GT.addAffinity(npc, -5); } catch(e){} }
    if (npc.isPolice && GT.police && typeof GT.police.setWanted === 'function'){
      GT.police.setWanted(it.kind === 'curi' ? 'theft' : 'assault', it.kind === 'curi' ? (it.victimName || '') : it.victimName);
    }
  } else if (it.about !== 'player' && it.kind === 'pukul' && it.about !== k && it.victim !== k){
    try { if (GT.agent && GT.agent.addRelation) GT.agent.addRelation(npc, it.about, -5); } catch(e){}
  }
  persist();
  return true;
}
function knowsFn(npc, id){ var kn = knows[id]; return !!(kn && kn[keyOf(npc)]); }

function active(it){ return total() - it.t0 <= LIFE; }
function prune(){
  var n0 = items.length;
  items = items.filter(function(it){
    if (active(it)) return true;
    delete knows[it.id]; delete fxDone[it.id]; return false;
  });
  pending = pending.filter(function(p){ return total() - p.t0 <= LIFE; });
  if (items.length !== n0) persist();
}

/* ---------- spreading ---------- */
function cheb(a, b){ return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)); }
function hearer(n){ return !n.hidden && !n.isRemote && !n.isBot && n.key !== 'casino:dealer'; }
function spread(force){
  var sc = out(); if (!sc || !sc.npcs) return 0;
  if (!force && curfewOn()) return 0;
  var hr = Math.floor(total() / 60);
  if (hr !== hopHour){ hopHour = hr; hops = 0; }
  var npcs = sc.npcs.filter(hearer), done = 0;
  items.forEach(function(it){
    if (!active(it)) return;
    var kn = knows[it.id] || {};
    var tellers = npcs.filter(function(n){ return kn[GT.npcKey(n)] && !n.isPolice && !n.talking; });
    tellers.forEach(function(t){
      npcs.forEach(function(n){
        if (n === t || kn[GT.npcKey(n)] || cheb(n, t) > 2) return;
        if (!force && hops >= MAX_HOPS) return;
        if (!force && Math.random() >= CHANCE) return;
        if (learn(n, it.id, t)){
          kn[GT.npcKey(n)] = 1; hops++; done++;
          GT.npcSay(t, snippet(it));
        }
      });
    });
  });
  return done;
}
/* paksa dua NPC bertemu: saling berbagi semua gosip */
function meet(a, b){
  a = npcOf(a); b = npcOf(b); if (!a || !b) return 0;
  var c = 0;
  items.forEach(function(it){
    var ka = knowsFn(a, it.id), kb = knowsFn(b, it.id);
    if (ka && !kb && learn(b, it.id, a)){ c++; if (!a.isPolice) GT.npcSay(a, snippet(it)); }
    else if (kb && !ka && learn(a, it.id, b)){ c++; if (!b.isPolice) GT.npcSay(b, snippet(it)); }
  });
  return c;
}

/* pencurian tak terlihat: penghuni menemukan saat pulang */
function resolvePending(){
  if (!pending.length) return;
  var sc = out(); if (!sc) return;
  pending.slice().forEach(function(p){
    var cand = null;
    sc.npcs.forEach(function(n){
      if (cand || !n._cf || n._cf.mode !== 'home') return;
      var b = null; try { b = GT.curfew && GT.curfew.homeOf(n); } catch(e){}
      if (b && String(b.id) === String(p.houseId)) cand = n;
    });
    if (!cand && curfewOn() && total() - p.t0 > 30){
      var hid = (GT.curfew && GT.curfew.hiddenList) ? GT.curfew.hiddenList() : [];
      var ok = true; // tidak ada penghuni terpetakan ke rumah ini? pakai tetangga pertama yang sudah pulang
      sc.npcs.forEach(function(n){ try { var b = GT.curfew.homeOf(n); if (b && String(b.id) === String(p.houseId)) ok = false; } catch(e){} });
      if (ok && hid.length) cand = hid[0];
    }
    if (!cand) return;
    pending.splice(pending.indexOf(p), 1);
    create({ kind:'maling_anon', about:'player', place:p.place, knowers:[cand] });
  });
}
function onTheft(house, witness){
  if (!house) return null;
  var place = 'rumah ' + (house.owner || '?');
  if (witness){
    return create({ kind:'curi', about:'player', victim:witness, victimName:house.owner || witness.name, place:place, knowers:[witness] });
  }
  pending.push({ houseId:house.id, owner:house.owner || '', place:place, t0:total() });
  persist();
  return null;
}

/* ---------- queries ---------- */
function list(){ return items.filter(active).map(function(it){ var o = JSON.parse(JSON.stringify(it)); o.knowers = Object.keys(knows[it.id] || {}); return o; }); }
function forNpc(npc){
  var k = keyOf(npc), r = [];
  items.forEach(function(it){ if (active(it) && knows[it.id] && knows[it.id][k]) r.push(describe(it)); });
  return r;
}
function aboutPlayer(){
  return items.filter(function(it){ return active(it) && it.about === 'player'; }).map(function(it){
    return { id:it.id, kind:it.kind, text:describe(it), count:Object.keys(knows[it.id] || {}).length };
  });
}
function summary(){ return aboutPlayer(); }
function wary(){ return total() < waryUntil; }

/* ---------- mention when talking ---------- */
function mentionPages(npc, it){
  var k = keyOf(npc);
  if (it.kind === 'maling_anon') return ['Hati-hati, katanya ada maling di ' + it.place + '.', 'Kunci pintumu baik-baik.'];
  if (it.kind === 'curi') return ['Aku dengar ada yang mencuri di ' + it.place + '...', 'Katanya itu kamu. Jangan begitu lagi, ya.'];
  if (it.victim === k) return ['Kamu memukulku tadi... Aku tidak akan lupa.'];
  return ['Aku dengar kamu memukul ' + it.victimName + '...', 'Jangan suka main tangan, ya.'];
}
function onInteract(ctx){
  if (!ctx || !ctx.npc || ctx.mode !== 'talk') return false;
  var npc = ctx.npc;
  if (npc.isPolice || npc.isPlayer || npc.isRemote || npc.isBot || isWorker(npc) || npc._cb || npc._ko > 0) return false;
  var k = GT.npcKey(npc), mine = items.filter(function(it){ return active(it) && (it.about === 'player') && knows[it.id] && knows[it.id][k]; });
  if (!mine.length) return false;
  var go = forceMention === null ? Math.random() < 0.5 : !!forceMention;
  if (!go) return false;
  var it = mine[mine.length - 1];
  GT.dialog(mentionPages(npc, it), npc.name, npc);
  return true;
}

/* ---------- Profil: kabar tentangmu + status buronan ---------- */
function decorateProfile(){
  var root = document.getElementById('mroot'); if (!root) return;
  var boxes = root.querySelectorAll('.mbox');
  for (var i = 0; i < boxes.length; i++){
    var b = boxes[i], t = b.querySelector('.mtitle');
    if (!t || t.textContent !== 'Profil' || b.getAttribute('data-gos')) continue;
    b.setAttribute('data-gos', '1');
    var body = b.querySelector('.mbody'); if (!body) continue;
    var w = GT.police && GT.police.wanted;
    var p1 = el('p', 'gos-status', 'Status: ' + (w ? 'DICARI karena ' + GT.police.reasonText(w) + ' (denda ' + w.fine + ' koin)' : 'bebas'));
    if (w) p1.style.color = 'var(--bad, #c0392b)';
    body.appendChild(p1);
    var ap = aboutPlayer();
    var p2 = el('p', 'gos-head', 'Kabar tentangmu: ' + (ap.length ? '' : 'belum ada'));
    body.appendChild(p2);
    ap.slice(-4).forEach(function(a){ body.appendChild(el('p', 'mnote gos-line', a.text + ' — ' + a.count + ' warga tahu')); });
  }
}
function watchProfile(){
  var root = document.getElementById('mroot'); if (!root || !window.MutationObserver) return;
  try { new MutationObserver(function(){ try { decorateProfile(); } catch(e){} }).observe(root, { childList:true, subtree:true }); } catch(e){}
}

/* ---------- events ---------- */
function placeLabel(){
  var sc = GT.scene;
  if (sc && sc.house) return 'rumah ' + (sc.house.owner || '?');
  if (sc && sc.kind === 'mart') return 'Mart';
  if (sc && sc.kind === 'casino') return 'Kasino';
  return 'jalan';
}
GT.on('hit', function(e){
  try {
    if (!e || e.noReact) return;
    if (e.target === 'player' && e.attackerNpc){ lastOnPlayer[e.attacker] = clk; return; }
    if (!e.targetNpc) return;
    var t = total();
    if (e.attacker === 'player'){
      if (e.targetNpc.isRemote) return;
      if (lastOnPlayer[e.target] != null && clk - lastOnPlayer[e.target] < 15) return;      // membela diri
      var pk = 'player>' + e.target;
      if (lastHit[pk] != null && t - lastHit[pk] < 60) return;
      lastHit[pk] = t;
      create({ kind:'pukul', about:'player', victim:e.targetNpc, victimName:e.targetNpc.name, place:placeLabel(), knowers:[e.targetNpc] });
    } else if (e.attackerNpc && !e.attackerNpc.isPolice){
      var nk = e.attacker + '>' + e.target;
      if (lastHit[nk] != null && t - lastHit[nk] < 60) return;
      lastHit[nk] = t;
      create({ kind:'pukul', about:e.attackerNpc, aboutName:e.attackerNpc.name, victim:e.targetNpc, victimName:e.targetNpc.name, place:placeLabel(), knowers:[e.targetNpc] });
    }
  } catch(err){ console.error('[gossip]', err); }
});

function tick(dt){
  clk += dt; acc += dt;
  if (acc < SPREAD_EVERY) return;
  acc = 0;
  prune(); resolvePending();
  spread(false);
}

function clear(){ items = []; knows = {}; fxDone = {}; pending = []; waryUntil = -1; lastHit = {}; persist(); }

GT.gossip = {
  list:list, knows:knowsFn, create:create, learn:learn, spread:spread, forNpc:forNpc, aboutPlayer:aboutPlayer, summary:summary,
  wary:wary, onTheft:onTheft, describe:describe, snippet:snippet,
  pendingAnon:function(){ return pending.length; },
  _meet:meet,
  _tick:function(dt){ tick(dt == null ? SPREAD_EVERY : dt); },
  _resolve:resolvePending,
  _clear:clear,
  _forceMention:function(v){ forceMention = (v === true || v === false) ? v : null; }
};

GT.register({
  id:'gossip',
  init:function(){ load(); watchProfile(); window.addEventListener('pagehide', persistNow); },
  onWorld:function(){ restoreOrClear(); },
  onInteract:onInteract,
  onFrame:function(dt){ tick(dt); }
});
})();

