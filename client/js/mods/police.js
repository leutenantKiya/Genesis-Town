/* police.js - Polisi: patroli malam, status BURONAN (wanted), perkelahian dilerai kapan saja.
 * Public: GT.police = {list(), near(x,y,r), sees(x,y), count (get/set), setCount(n), arrest(reason, by),
 *   post(), wanted (getter: null | {reason:'assault'|'theft'|'pick', victim, since, fine}), setWanted(reason, victim),
 *   clearWanted(), respond({x,y,scene,reason,parties}), confront(officer), _forceSpawn(true|false|null), _tick()}
 *
 * v2.4: pemain TIDAK lagi ditangkap hanya karena reputasi buruk. Ditangkap hanya bila (a) buronan dan petugas
 * ada dalam 1 tile, (b) kejahatan sedang berlangsung (membongkar kunci di depan polisi, thief.js memanggil arrest('pick')).
 * Buronan: polisi melihat pemukulan / bongkar kunci, atau kabar kejahatan bernama sampai ke petugas (gossip.js).
 * Bicara (A) / E ke petugas: tidak buronan = obrolan biasa; buronan = dialog + menu "Bayar denda" / "Kabur".
 * arrest(reason): denda min(100, koin), obeng disita, pulang ke rumah, buronan hilang;
 *   reputasi -10 (assault/theft) atau -15 (pick). Mengembalikan {reason, fine, rep, confiscated}.
 * respond(): petugas patroli terdekat (malam) atau petugas yang muncul di pos (siang) datang ke lokasi perkelahian.
 */
(function(){
if (!window.GT_FLAGS || !window.GT_FLAGS.police) return; // feature flag: off in the submission build (js/flags.js)
'use strict';
if (!window.GT) return;
var GT = window.GT;

var NAMES = ['Polisi Andi', 'Polisi Budi', 'Polisi Cahyo', 'Polisi Dedi'];
var MAX = 4, LS = 'gt.police.v1';
var PAL = 8;
var FINES = { assault:40, theft:60, pick:80 };
var WANTED_DAYS = 2, RESP_GIVEUP = 40, CHASE_T = 12;

var count = 2;
var forced = null;            // null | true | false
var officers = [];            // {npc, mode:'idle'|'walk'|'return', wait, dfT, retT, gen}
var post = null;              // {x,y}
var roads = null;             // Set of tile indexes: 'path' tiles reachable from post, minus door fronts
var junctions = [];           // [{x,y}]
var wanted = null;            // null | {reason, victim, since (menit game), fine}
var clk = 0;                  // detik nyata (akumulasi dt)
var grace = 0;                // tidak ada penangkapan jarak dekat sampai clk ini (setelah 'Kabur')
var flow = null;              // alur konfrontasi yang sedang terbuka {npc}
var pending = null;           // petugas yang menunggu UI kosong untuk konfrontasi
var hl = { pAt:-1e9, nAt:-1e9, playerFirst:false, firstAt:-1e9, victim:'' };
var acc = 0, devDone = false, gen = 0, badge = null, lastBadge = '';

function el(tag, cls, text){ var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

/* ---------- persistence (count only) ---------- */
function load(){
  try {
    var d = JSON.parse(window.localStorage.getItem(LS) || 'null');
    if (d && isFinite(+d.count)) count = Math.max(0, Math.min(MAX, Math.floor(+d.count)));
  } catch(e){}
}
function persist(){ try { window.localStorage.setItem(LS, JSON.stringify({ count:count })); } catch(e){} }

/* ---------- time ---------- */
function hourNow(){
  var t = GT.time || {};
  return t.h != null ? t.h : (t.hour != null ? t.hour : 12);
}
function isNight(){
  if (forced !== null) return forced;
  if (typeof GT.isNight === 'function'){ try { return !!GT.isNight(); } catch(e){} }
  var h = hourNow(); return h >= 19 || h < 6;
}
function nightId(){
  var t = GT.time || {}, d = t.day != null ? t.day : 1;
  return hourNow() < 6 ? d - 1 : d;
}
function lampNear(x, y){
  if (typeof GT.lampNear !== 'function') return false;
  try { return !!GT.lampNear(x, y); } catch(e){ return false; }
}

/* ---------- map helpers ---------- */
function out(){ return GT.outScene; }
function idx(m, x, y){ return y * m.w + x; }
function inb(m, x, y){ return x >= 0 && y >= 0 && x < m.w && y < m.h; }
var D4 = [[1,0],[-1,0],[0,1],[0,-1]];

function buildRoads(){
  var sc = out(); post = null; roads = null; junctions = [];
  if (!sc || !sc.map) return;
  var m = sc.map, W = m.w, H = m.h, df = m.doorFront;
  function isPath(x, y){ return inb(m, x, y) && m.tiles[idx(m, x, y)] === 'path' && m.walk[idx(m, x, y)] === 1; }
  function isDF(x, y){ return !!(df && df.has(idx(m, x, y))); }
  // post: main-grid corner road tile nearest the world center (stable tie-break by position)
  var BS = 6, best = null, bd = 1e9, cx = W / 2, cy = H / 2, x, y;
  for (y = 0; y < H; y++) for (x = 0; x < W; x++){
    if (!isPath(x, y) || isDF(x, y)) continue;
    var grid = (x % BS === 0 && y % BS === 0) ? 0 : 1000;
    var d = grid + Math.abs(x - cx) + Math.abs(y - cy) + (x * 0.001 + y * 0.0001);
    if (d < bd){ bd = d; best = { x:x, y:y }; }
  }
  if (!best) return;
  post = best;
  // road component reachable from the post over path tiles (not door fronts)
  var seen = new Set(), q = [post.x, post.y], head = 0;
  seen.add(idx(m, post.x, post.y));
  while (head < q.length){
    var qx = q[head++], qy = q[head++];
    for (var k = 0; k < 4; k++){
      var nx = qx + D4[k][0], ny = qy + D4[k][1];
      if (!isPath(nx, ny) || isDF(nx, ny)) continue;
      var ni = idx(m, nx, ny); if (seen.has(ni)) continue;
      seen.add(ni); q.push(nx, ny);
    }
  }
  roads = seen;
  var any = [];
  seen.forEach(function(i){
    var tx = i % W, ty = (i / W) | 0, n = 0;
    for (var k = 0; k < 4; k++) if (seen.has(idx(m, tx + D4[k][0], ty + D4[k][1]))) n++;
    any.push({ x:tx, y:ty });
    if (n >= 3) junctions.push({ x:tx, y:ty });
  });
  if (junctions.length < 2) junctions = any;
}
function isRoad(x, y){
  var m = out() && out().map;
  return !!(roads && m && inb(m, x, y) && roads.has(idx(m, x, y)));
}
function occupied(x, y){
  var sc = out(); if (!sc) return false;
  for (var i = 0; i < sc.npcs.length; i++){
    var n = sc.npcs[i]; if (n.hidden) continue;
    if ((n.x === x && n.y === y) || (n.moving && n.fx === x && n.fy === y)) return true;
  }
  var p = GT.player;
  return (p.x === x && p.y === y);
}
/* nearest free road tile around (x,y) via BFS over road tiles */
function freeRoadNear(x, y){
  var m = out().map, q = [x, y], head = 0, seen = new Set();
  seen.add(idx(m, x, y));
  while (head < q.length){
    var qx = q[head++], qy = q[head++];
    if (isRoad(qx, qy) && !occupied(qx, qy)) return { x:qx, y:qy };
    for (var k = 0; k < 4; k++){
      var nx = qx + D4[k][0], ny = qy + D4[k][1];
      if (!inb(m, nx, ny) || !isRoad(nx, ny)) continue;
      var ni = idx(m, nx, ny); if (seen.has(ni)) continue;
      seen.add(ni); q.push(nx, ny);
    }
  }
  return null;
}
function roadPath(from, to){
  var sc = out();
  var p = GT.findPath(sc, from, to, { avoid:function(x, y){ return !isRoad(x, y) || occupied(x, y); } });
  if (!p) p = GT.findPath(sc, from, to, { avoid:function(x, y){ return !isRoad(x, y); } });
  return p;
}

/* ---------- officers ---------- */
function livePolice(){ return officers.filter(function(o){ return o.npc && !o.npc.hidden; }); }
function spawnOne(temp){
  var sc = out(); if (!sc || !post) return null;
  var t = freeRoadNear(post.x, post.y); if (!t) return null;
  var used = {}; officers.forEach(function(o){ used[o.npc.name] = 1; });
  var name = NAMES[0]; for (var i = 0; i < NAMES.length; i++) if (!used[NAMES[i]]){ name = NAMES[i]; break; }
  var npc = GT.addNpc('out', { x:t.x, y:t.y, name:name, pal:PAL, label:'POLISI', wander:false, noAffinity:true,
    key:'police:' + name, dir:'down', lines:[['Selamat malam.']] });
  if (!npc) return null;
  // addNpc may relocate to a free (non-road) tile; keep police on roads
  if (!isRoad(npc.x, npc.y)){ GT.removeNpc(npc); return null; }
  npc.isPolice = true; npc.isPlayer = false;
  var o = { npc:npc, mode:'idle', wait:(officers.length ? 2.5 + officers.length : 0.2) + Math.random() * 0.5, dfT:0, retT:0, gen:gen, temp:!!temp, resp:null };
  officers.push(o);
  return o;
}
function dropOfficer(o){
  var i = officers.indexOf(o); if (i >= 0) officers.splice(i, 1);
  GT.removeNpc(o.npc);
}
function patrol(o){
  var n = o.npc, tries = 0, dest, p;
  while (tries++ < 8){
    dest = junctions[Math.floor(Math.random() * junctions.length)];
    if (!dest || (Math.abs(dest.x - n.x) + Math.abs(dest.y - n.y) < 4 && junctions.length > 3)) continue;
    p = roadPath(n, dest);
    if (p && p.length) break; p = null;
  }
  if (!p){ o.mode = 'idle'; o.wait = 2; return; }
  o.mode = 'walk';
  GT.npcGo(n, p, function(){ if (o.mode === 'walk'){ o.mode = 'idle'; o.wait = 1.5 + Math.random() * 3; } });
}
function sendHome(o){
  var n = o.npc;
  if (o.mode === 'return') return;
  o.mode = 'return'; o.retT = 0;
  walkToPost(o);
}
function walkToPost(o){
  var n = o.npc;
  if (Math.abs(n.x - post.x) + Math.abs(n.y - post.y) <= 1 && !n.moving){ dropOfficer(o); return; }
  var p = roadPath(n, post);
  if (!p){ p = freeRoadNear(post.x, post.y) ? roadPath(n, freeRoadNear(post.x, post.y)) : null; }
  if (!p || !p.length){ o.wait = 1; return; }
  // never step onto the post itself if blocked; the last step may fail harmlessly and we despawn when adjacent
  GT.npcGo(n, p, function(){
    if (o.mode !== 'return') return;
    if (Math.abs(n.x - post.x) + Math.abs(n.y - post.y) <= 1) dropOfficer(o);
    else o.wait = 0.5;
  });
}
function stepAside(o){
  var n = o.npc, m = out().map, df = m.doorFront;
  for (var k = 0; k < 4; k++){
    var nx = n.x + D4[k][0], ny = n.y + D4[k][1];
    if (!isRoad(nx, ny) || occupied(nx, ny)) continue;
    GT.npcGo(n, [{ x:nx, y:ny }], function(){ if (o.mode === 'walk' || o.mode === 'idle') o.wait = 1; });
    o.mode = 'idle'; o.wait = 1.2; return true;
  }
  return false;
}

function tickOfficer(o, dt){
  var n = o.npc, m = out().map, df = m.doorFront;
  if (n.talking) return;
  // door-front courtesy (not while responding)
  if (o.mode !== 'respond' && !n.moving && !n.script && df && df.has(idx(m, n.x, n.y))){
    o.dfT += dt;
    if (o.dfT > 2){ o.dfT = 0; stepAside(o); return; }
  } else if (!(df && df.has(idx(m, n.x, n.y)))) o.dfT = 0;
  if (o.mode === 'respond'){ tickRespond(o, dt); return; }
  if (o.mode === 'return'){
    o.retT += dt;
    if (o.retT > 45){ dropOfficer(o); return; }          // safety: never hang around all day
    if (!n.script && !n.moving){ o.wait -= dt; if (o.wait <= 0){ o.wait = 1; walkToPost(o); } }
    return;
  }
  if (o.mode === 'idle'){
    if (n.script || n.moving) return;
    o.wait -= dt;
    if (o.wait <= 0) patrol(o);
    return;
  }
  if (o.mode === 'walk' && !n.script && !n.moving){ o.mode = 'idle'; o.wait = 1; }
}

/* ---------- merespons perkelahian / mengejar buronan ---------- */
function pathTo(n, to){
  var sc = out();
  var p = GT.findPath(sc, n, to, { avoid:function(x, y){ return (x !== to.x || y !== to.y) && (!isRoad(x, y) || occupied(x, y)); } });
  if (!p) p = GT.findPath(sc, n, to, { avoid:function(x, y){ return (x !== to.x || y !== to.y) && occupied(x, y); } });
  if (!p) p = GT.findPath(sc, n, to);
  return p;
}
function finishResp(o){
  o.resp = null;
  if (o.temp){ o.mode = 'idle'; sendHome(o); }
  else { o.mode = 'idle'; o.wait = 1.5; }
}
function respTarget(r){
  if (r.chase) return { x:GT.player.x, y:GT.player.y };
  if (r.indoor) return r.door;
  var pn = r.parties.filter(function(q){ return q && typeof q === 'object' && !q.hidden && out().npcs.indexOf(q) >= 0; })[0];
  if (pn && !r.arrived) return { x:pn.x, y:pn.y };
  return { x:r.x, y:r.y };
}
function tickRespond(o, dt){
  var n = o.npc, r = o.resp;
  if (!r){ o.mode = 'idle'; o.wait = 1; return; }
  r.t += dt;
  if (r.chase){
    if (r.t > CHASE_T || !wanted){ finishResp(o); return; }
  } else if (r.t > RESP_GIVEUP){ finishResp(o); return; }
  var tg = respTarget(r), d = Math.abs(n.x - tg.x) + Math.abs(n.y - tg.y);
  if (r.waiting){
    // indoor incident: wait at the door front, warn when a wanted player comes out
    var p = GT.player;
    if (!r.warned && wanted && GT.scene === out() && Math.abs(p.x - n.x) + Math.abs(p.y - n.y) <= 5){
      r.warned = true; GT.npcSay(n, 'Berhenti! Kamu dicari!');
      r.chase = true; r.t = 0; r.waiting = false;
    }
    return;
  }
  if (!r.chase && !r.arrived && d <= 2){
    r.arrived = true;
    if (n.script){ try { GT.npcGo(n, [], null); } catch(e){} }
    onArrive(o);
    return;
  }
  if (r.chase && d <= 1) return;
  if (n.script || n.moving) return;
  if (clk < r.next) return;
  r.next = clk + 0.5;
  var path = pathTo(n, tg);
  if (path && path.length){ if (path.length > 1 && !r.chase) path = path.slice(0, -1); if (path.length) GT.npcGo(n, path.slice(0, 6), null); }
  else if (++r.fail > 12) finishResp(o);
}
function walkAway(a, from){
  var sc = out(), best = null, bd = -1;
  for (var i = 0; i < 12; i++){
    var ang = Math.random() * Math.PI * 2, rr = 3 + Math.random() * 3;
    var x = Math.round(a.x + Math.cos(ang) * rr), y = Math.round(a.y + Math.sin(ang) * rr);
    var m = sc.map; if (!inb(m, x, y) || m.walk[idx(m, x, y)] !== 1 || occupied(x, y)) continue;
    var dd = Math.abs(x - from.x) + Math.abs(y - from.y);
    if (dd > bd){ bd = dd; best = { x:x, y:y }; }
  }
  if (!best) return;
  var p = GT.findPath(sc, a, best);
  if (p && p.length){ try { GT.npcGo(a, p.slice(0, 8), null); a.wait = 2; } catch(e){} }
}
function onArrive(o){
  var n = o.npc, r = o.resp, parties = r.parties || [];
  var tg = { x:r.x, y:r.y };
  parties.forEach(function(q){ if (q && typeof q === 'object'){ tg = { x:q.x, y:q.y }; } });
  // face the fight
  n.dir = tg.x > n.x ? 'right' : tg.x < n.x ? 'left' : tg.y > n.y ? 'down' : 'up';
  var npcs = parties.filter(function(q){ return q && typeof q === 'object'; });
  var hasPlayer = parties.indexOf('player') >= 0 || r.reason === 'assault';
  if (r.indoor){
    if (hasPlayer && hl.playerFirst && clk - hl.pAt < 30) setWanted('assault', hl.victim);
    r.waiting = true; r.arrived = true; r.t = Math.min(r.t, RESP_GIVEUP - 25);
    GT.npcSay(n, 'Ada keributan di dalam?');
    return;
  }
  if (npcs.length >= 2 && !hasPlayer){
    try { if (GT.agent && GT.agent.endFight) GT.agent.endFight(); } catch(e){}
    GT.npcSay(n, 'Bubar! Jangan ribut!');
    try {
      if (GT.agent && GT.agent.addRelation){ GT.agent.addRelation(npcs[0], npcs[1], 10); GT.agent.addRelation(npcs[1], npcs[0], 10); }
    } catch(e){}
    walkAway(npcs[0], npcs[1]); walkAway(npcs[1], npcs[0]);
    finishResp(o);
    return;
  }
  GT.npcSay(n, 'Hentikan! Jangan berkelahi!');
  if (wanted || (hl.playerFirst && clk - hl.pAt < 30)){
    if (!wanted) setWanted('assault', hl.victim);
    if (GT.isUiOpen()) pending = o; else confront(n);
  } else {
    GT.toast('Polisi memperingatkan: jangan berkelahi di kota ini.');
  }
  finishResp(o);
}

/* respond({x,y,scene,reason,parties}) -> {ok, officer, temp} | false */
function respond(opts){
  opts = opts || {};
  var sc = out(); if (!sc || !sc.map || !sc.npcs) return false;
  if (!roads) buildRoads();
  if (!post) return false;
  var x = Math.round(+opts.x), y = Math.round(+opts.y);
  var indoor = !!(opts.scene && opts.scene !== 'out' && opts.scene !== sc);
  var door = null;
  if (indoor){
    var rt = opts.scene && opts.scene.returnTo;
    if (!rt) return false;
    door = { x:rt.x, y:rt.y }; x = door.x; y = door.y;
  }
  if (!isFinite(x) || !isFinite(y)) return false;
  var night = isNight();
  // already someone responding? (max 1 responder during the day; at night an active one covers the incident)
  var busy = officers.filter(function(o){ return o.mode === 'respond' && o.resp && !o.resp.chase; });
  if (busy.length) return false;
  var o = null;
  if (night){
    var best = 1e9;
    officers.forEach(function(q){
      if (q.temp || q.mode === 'return' || q.npc.hidden) return;
      var d = Math.abs(q.npc.x - x) + Math.abs(q.npc.y - y);
      if (d < best){ best = d; o = q; }
    });
  }
  var isTemp = false;
  if (!o){ o = spawnOne(true); isTemp = true; if (!o) return false; }
  if (o.npc.script){ try { GT.npcGo(o.npc, [], null); } catch(e){} }
  o.mode = 'respond'; o.dfT = 0;
  o.resp = { x:x, y:y, reason:opts.reason || 'fight', parties:(opts.parties || []).slice(), t:0, next:0, fail:0, indoor:indoor, door:door, arrived:false };
  GT.npcSay(o.npc, 'Ada keributan! Aku datang!');
  return { ok:true, officer:o.npc, temp:isTemp };
}
function startChase(npc){
  var o = officers.filter(function(q){ return q.npc === npc; })[0]; if (!o) return false;
  if (o.npc.script){ try { GT.npcGo(o.npc, [], null); } catch(e){} }
  o.mode = 'respond'; o.resp = { x:GT.player.x, y:GT.player.y, reason:'chase', parties:[], t:0, next:0, fail:0, indoor:false, door:null, arrived:true, chase:true };
  return true;
}

function tick(dt){
  var sc = out();
  if (!sc || !sc.map || !sc.npcs) return;
  if (!roads) buildRoads();
  if (!post) return;
  // forget officers that vanished from the scene (e.g. regenerated world)
  officers = officers.filter(function(o){ return sc.npcs.indexOf(o.npc) >= 0; });
  var night = isNight();
  var perm = officers.filter(function(o){ return !o.temp; });
  if (night){
    perm.forEach(function(o){ if (o.mode === 'return'){ o.mode = 'idle'; o.wait = 1; } });
    var keep = perm.slice();
    while (keep.length > count){ var x = keep.pop(); dropOfficer(x); }
    var guard = 0;
    while (officers.filter(function(o){ return !o.temp; }).length < count && guard++ < 6){
      var o2 = spawnOne(); if (!o2) break;
    }
  } else {
    perm.forEach(function(o){ if (o.mode !== 'return' && o.mode !== 'respond') sendHome(o); });
  }
  officers.slice().forEach(function(o){ tickOfficer(o, dt); });
  // wanted: expiry + pending confrontation + badge
  if (wanted && GT.time && GT.time.total - wanted.since > WANTED_DAYS * 1440) clearWanted();
  if (flow && !GT.isUiOpen()){ flow = null; grace = Math.max(grace, clk + 3); }
  if (pending && !GT.isUiOpen() && GT.scene === sc){ var pn = pending.npc; pending = null; if (wanted && pn && !pn.hidden) confront(pn); }
  updateBadge();
  // proximity arrest: only a wanted player with an officer within 1 tile
  if (wanted && GT.scene === sc && clk >= grace && !GT.isUiOpen()){
    var p = GT.player;
    for (var i = 0; i < officers.length; i++){
      var n = officers[i].npc;
      if (n.hidden || n._cb) continue;          // an officer already fighting the player (combat.js) does not arrest
      var near1 = (Math.abs(n.x - p.x) + Math.abs(n.y - p.y) <= 1) || (n.moving && Math.abs(n.fx - p.x) + Math.abs(n.fy - p.y) <= 1);
      if (near1){ arrest(wanted.reason, n); break; }
    }
  }
}

/* ---------- wanted ---------- */
function reasonText(w){
  if (!w) return '';
  if (w.reason === 'theft') return w.victim ? 'mencuri di rumah ' + w.victim : 'mencuri';
  if (w.reason === 'pick') return 'membongkar kunci rumah' + (w.victim ? ' ' + w.victim : '');
  return 'memukul ' + (w.victim || 'warga');
}
function setWanted(reason, victim){
  if (reason !== 'assault' && reason !== 'theft' && reason !== 'pick') reason = 'assault';
  var t = (GT.time && GT.time.total) || 0, was = !!wanted;
  wanted = { reason:reason, victim:victim ? String(victim).slice(0, 24) : '', since:t, fine:FINES[reason] };
  updateBadge();
  if (!was){ try { GT.toast('Kamu dicari polisi!'); } catch(e){} }
  try { GT.emit('wanted', { wanted:wanted }); } catch(e){}
  return wanted;
}
function clearWanted(){
  if (!wanted) return false;
  wanted = null; updateBadge();
  try { GT.emit('wanted', { wanted:null }); } catch(e){}
  return true;
}
function updateBadge(){
  if (!badge) return;
  var key = wanted ? wanted.reason : '';
  if (key === lastBadge) return;
  lastBadge = key;
  badge.style.display = wanted ? 'inline-block' : 'none';
  badge.title = wanted ? 'Dicari karena ' + reasonText(wanted) : '';
}
function buildBadge(){
  if (badge) return;
  var role = document.getElementById('role'); if (!role || !role.parentNode) return;
  var st = document.createElement('style'); st.id = 'pol-css';
  st.textContent = '#wantedBadge{display:none;margin-left:3px;background:var(--bad,#c0392b);color:#fff}';
  document.head.appendChild(st);
  badge = el('span', 'badge wanted', 'DICARI'); badge.id = 'wantedBadge';
  badge.setAttribute('role', 'status');
  role.parentNode.insertBefore(badge, role.nextSibling);
  lastBadge = '\u0000';
}

/* ---------- arrest ---------- */
function arrest(reason, by){
  reason = reason || 'assault';
  var st = GT.state;
  var fine = Math.max(0, Math.min(100, st.coins | 0));
  if (fine > 0) GT.spendCoins(fine);
  var repD = reason === 'pick' ? -15 : -10;
  GT.addReputation(repD);
  var conf = 0;
  var have = (st.inventory && st.inventory.obeng) | 0;
  if (have > 0 && GT.removeItem('obeng', have)) conf = have;
  clearWanted(); pending = null; flow = null;
  var own = GT.buildings.filter(function(b){ return b.own; })[0];
  if (own) GT.teleportPlayer('out', own.dx, own.dy + 1, 'down');
  var lines = ['Kamu ditangkap!', 'Denda ' + fine + ' koin.' + (conf ? ' Obeng disita.' : '') + ' Reputasimu turun. Kamu dipulangkan ke rumah.'];
  var res = { reason:reason, fine:fine, rep:repD, confiscated:conf };
  if (GT.isUiOpen()) GT.toast('Kamu ditangkap! Denda ' + fine + ' koin.');
  else GT.dialog(lines, (by && by.name) || 'Polisi', by || null);
  try { GT.emit('arrest', res); } catch(e){}
  return res;
}

/* ---------- interaction ---------- */
function confront(npc){
  var w = wanted; if (!w || !npc) return false;
  grace = Math.max(grace, clk + 4);
  GT.dialog(['Kamu dicari karena ' + reasonText(w) + '.'], npc.name, npc, function(){
    if (!wanted){ return; }
    flow = { npc:npc };
    GT.menu('Dicari polisi: denda ' + wanted.fine + ' koin', [
      { label:'Bayar denda (' + wanted.fine + ' koin)', onPick:function(){ flow = null; payFine(npc); } },
      { label:'Kabur', onPick:function(){ flow = null; grace = clk + 3; GT.npcSay(npc, 'Berhenti!'); startChase(npc); } }
    ]);
  });
  return true;
}
function payFine(npc){
  var w = wanted; if (!w) return false;
  if ((GT.state.coins | 0) >= w.fine){
    GT.spendCoins(w.fine);
    clearWanted();
    GT.addReputation(5);
    GT.toast('Denda ' + w.fine + ' koin dibayar. Reputasi naik.');
    if (npc) GT.npcSay(npc, 'Baik. Jangan diulangi, ya.');
    try { GT.emit('finepaid', { fine:w.fine }); } catch(e){}
    return true;
  }
  GT.toast('Koinmu tidak cukup untuk membayar denda!');
  arrest(w.reason, npc);
  return false;
}
function onInteract(ctx){
  if (!ctx || !ctx.npc || !ctx.npc.isPolice) return false;
  if (ctx.mode !== 'talk' && ctx.mode !== 'message') return false;
  var rep = GT.state.reputation, npc = ctx.npc;
  if (wanted){ confront(npc); return true; }
  var night = isNight();
  if (rep < 0) GT.dialog(['Aku mengawasimu.', 'Jaga kelakuanmu di kota ini, ya.'], npc.name, npc);
  else GT.dialog([night ? 'Selamat malam, warga.' : 'Selamat siang, warga.', night ? 'Tetap waspada. Jalan yang gelap rawan maling.' : 'Kota ini aman selama semua warga rukun.'], npc.name, npc);
  return true;
}

/* ---------- hit tracking (who started it? did an officer see it?) ---------- */
GT.on('hit', function(e){
  try {
    if (!e || e.noReact) return;
    if (e.attacker === 'player' && e.targetNpc){
      if (clk - Math.max(hl.pAt, hl.nAt) > 10){ hl.playerFirst = true; hl.firstAt = clk; }
      hl.pAt = clk; hl.victim = e.targetNpc.name || '';
      if (GT.scene === out() && GT.npcScene(e.targetNpc) === out()){
        var t = e.targetNpc;
        if (t.isPolice || sees(t.x, t.y)) setWanted('assault', hl.victim);
      }
    } else if (e.target === 'player' && e.attackerNpc){
      if (clk - Math.max(hl.pAt, hl.nAt) > 10) hl.playerFirst = false;
      hl.nAt = clk;
    }
  } catch(err){ console.error('[police]', err); }
});

/* ---------- query API ---------- */
function list(){ return livePolice().map(function(o){ return o.npc; }); }
function near(x, y, r){
  r = r == null ? 2 : r;
  return list().some(function(n){ return Math.abs(n.x - x) + Math.abs(n.y - y) <= r; });
}
function sees(x, y){
  var lamp = null;
  return list().some(function(n){
    var d = Math.sqrt((n.x - x) * (n.x - x) + (n.y - y) * (n.y - y));
    if (d > 5) return false;
    if (d <= 2) return true;
    if (lamp === null) lamp = lampNear(x, y);
    return lamp;
  });
}

/* ---------- dev section ---------- */
function addDev(){
  if (devDone || typeof GT.addDevSection !== 'function') return;
  devDone = true;
  try {
    GT.addDevSection('Polisi', function(box){
      var row = el('div'); row.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap';
      var val = el('span', null, ''); val.setAttribute('role', 'status');
      function refresh(){ val.textContent = 'Jumlah polisi: ' + count + ' (aktif: ' + list().length + ')'; }
      function btn(t, label, fn){ var b = el('button', 'mbtn', t); b.type = 'button'; b.setAttribute('aria-label', label); b.addEventListener('click', function(){ fn(); refresh(); }); return b; }
      row.appendChild(btn('-', 'Kurangi polisi', function(){ setCount(count - 1); }));
      row.appendChild(val);
      row.appendChild(btn('+', 'Tambah polisi', function(){ setCount(count + 1); }));
      box.appendChild(row);
      box.appendChild(el('p', 'mnote', 'Polisi berpatroli saat malam (0 sampai ' + MAX + '); siang hari hanya datang bila ada keributan.'));
      refresh();
    });
  } catch(e){ devDone = false; }
}

function setCount(n){
  n = Math.max(0, Math.min(MAX, Math.floor(+n) || 0));
  count = n; persist();
  if (out()) tick(0);
  return count;
}

/* ---------- lifecycle ---------- */
function reset(){
  gen++;
  officers.forEach(function(o){ try { GT.removeNpc(o.npc); } catch(e){} });
  officers = []; wanted = null; flow = null; pending = null; grace = 0;
  hl = { pAt:-1e9, nAt:-1e9, playerFirst:false, firstAt:-1e9, victim:'' };
  lastBadge = '\u0000'; updateBadge();
  buildRoads();
}

GT.police = {
  list: list, near: near, sees: sees, arrest: arrest, setCount: setCount,
  setWanted: setWanted, clearWanted: clearWanted, isWanted: function(){ return !!wanted; }, reasonText: reasonText,
  respond: respond, confront: confront, payFine: payFine,
  post: function(){ return post ? { x:post.x, y:post.y } : null; },
  _forceSpawn: function(v){ forced = (v === true || v === false) ? v : null; if (out()) tick(0); },
  _state: function(){ return { clk:clk, hl:hl, grace:grace, wanted:wanted, modes:officers.map(function(o){ return o.mode + (o.resp ? ':' + o.resp.reason : ''); }) }; },
  _tick: function(dt){ clk += dt || 0; tick(dt || 0); }
};
Object.defineProperty(GT.police, 'wanted', { get: function(){ return wanted ? { reason:wanted.reason, victim:wanted.victim, since:wanted.since, fine:wanted.fine } : null; }, enumerable: true });
Object.defineProperty(GT.police, 'count', { get: function(){ return count; }, set: function(v){ setCount(v); }, enumerable: true });

GT.register({
  id:'police',
  init:function(){ load(); addDev(); buildBadge(); },
  onWorld:function(){ reset(); },
  onInteract:onInteract,
  onFrame:function(dt){
    if (!devDone) addDev();
    if (!badge) buildBadge();
    clk += dt; acc += dt;
    if (acc < 0.25) return;
    var d = acc; acc = 0;
    tick(d);
  }
});
})();

