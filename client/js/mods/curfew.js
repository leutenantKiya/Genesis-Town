/* curfew.js - Jam malam: 21:00-05:59 tidak ada warga di luar rumah.
 * Public: GT.curfew = { active(), homeOf(npc) -> building|null, isHome(npc), sendHome(npc, reason?) -> bool, exempt(npc) -> bool,
 *                       hiddenList(), _tick(dt) }
 *
 * - Warga luar ruangan (8 pengembara, bot sosial, NPC berjiwa) punya rumah deterministik (hash seed + key): rumah biasa, bukan milik pemain.
 *   Penghuni rumah ('house:<id>:n') tinggal di rumahnya (sudah di dalam ruangan, tidak disentuh).
 * - Mulai 21:00 mereka berjalan ke depan pintu rumahnya lalu menghilang (npcHide). Mulai 06:00 mereka muncul lagi di depan pintu
 *   (tile bebas terdekat) dan berkeliaran lagi, bergiliran beberapa detik. Jalan buntu/terhalang > 20 detik: langsung disembunyikan.
 * - Dikecualikan: polisi, pekerja (penjaga Mart / bandar / npc._post), NPC yang sedang mengikuti pemain, NPC yang sedang menjalankan
 *   rencana agen (GT.agent.status(npc).busy; setelah selesai mereka pulang), pemain online (isRemote), NPC yang sedang berkelahi / pingsan.
 * - Muat ulang / dunia baru saat jam malam: NPC yang terlihat dalam 5 detik pertama langsung disembunyikan (tanpa berjalan).
 * - Lompat waktu lewat panel Dev: keadaan dihitung dari jam setiap 0.25 detik, jadi dua arah berlaku segera.
 * - sendHome(npc, 'rest') dipakai combat.js: NPC pingsan pulang, istirahat sampai HP >= 70% (dan bukan jam malam), lalu keluar lagi.
 */
(function(){
if (!window.GT_FLAGS || !window.GT_FLAGS.curfew) return; // feature flag: off in the submission build (js/flags.js)
'use strict';
if (!window.GT) return;
var GT = window.GT;

var clk = 0, born = 0, bornNight = false, acc = 0;
var homes = new Map();      // npc key -> building
var T_WALK = 20;            // detik sebelum teleport-sembunyi

function out(){ return GT.outScene; }
function hourNow(){
  var t = GT.time || {};
  var h = t.h != null ? t.h : t.hour;
  return isFinite(h) ? h : 12;
}
function active(){ var h = hourNow(); return h >= 21 || h < 6; }

function hash(s){
  s = String(s); var h = 2166136261 >>> 0;
  for (var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
function isWorkerKey(k){ return /:keeper$/.test(k || '') || k === 'casino:dealer'; }

function homeOf(npc){
  if (!npc) return null;
  var key = GT.npcKey(npc), b = homes.get(key);
  if (b) return b;
  var bl = GT.buildings || [], m = /^house:(\d+):/.exec(key || '');
  if (m){
    for (var i = 0; i < bl.length; i++) if (bl[i].kind === 'house' && String(bl[i].id) === m[1]){ b = bl[i]; break; }
  } else {
    var hs = bl.filter(function(x){ return x.kind === 'house' && !x.own; });
    if (!hs.length) hs = bl.filter(function(x){ return x.kind === 'house'; });
    if (hs.length) b = hs[hash(GT.seed + '|home|' + key) % hs.length];
  }
  if (b) homes.set(key, b);
  return b || null;
}
function doorOf(b){ return b ? { x:b.dx, y:b.dy + 1 } : null; }

function agentBusy(n){
  try { return !!(GT.agent && GT.agent.status && GT.agent.status(n).busy); } catch(e){ return false; }
}
function exempt(n){
  if (!n) return true;
  if (n.isPolice || n.isRemote) return true;
  var k = n.key || '';
  if (isWorkerKey(k) || /^peer:/.test(k)) return true;
  if (n._post) return true;
  if (n.follow) return true;
  if (n._cb || n._ko > 0) return true;       // combat.js: berkelahi / kabur / pingsan
  if (agentBusy(n)) return true;
  return false;
}

function isHome(n){
  if (!n) return false;
  if (n._cf && n._cf.mode === 'home' && n.hidden) return true;
  var sc = GT.npcScene(n), b = homeOf(n);
  return !!(sc && sc.house && b && sc.house === b);
}

/* ---------- map helpers ---------- */
function visibleAt(sc, x, y, except){
  for (var i = 0; i < sc.npcs.length; i++){
    var o = sc.npcs[i]; if (o === except || o.hidden) continue;
    if ((o.x === x && o.y === y) || (o.moving && o.fx === x && o.fy === y)) return true;
  }
  return false;
}
function playerAt(sc, x, y){
  if (GT.scene !== sc) return false;
  var p = GT.player;
  if (p.x === x && p.y === y) return true;
  try { var g = window.__game && window.__game.player; if (g && p.moving && g.fx === x && g.fy === y) return true; } catch(e){}
  return false;
}
function freeSpot(door, except){
  var sc = out(), m = sc && sc.map; if (!m || !door) return null;
  var W = m.w, H = m.h, seen = new Uint8Array(W * H), q = [door.x, door.y], head = 0, fallback = null, n = 0;
  if (door.x < 0 || door.y < 0 || door.x >= W || door.y >= H) return null;
  seen[door.y * W + door.x] = 1;
  while (head < q.length && n < 140){
    var cx = q[head++], cy = q[head++], i = cy * W + cx; n++;
    var ok = m.walk[i] === 1 && !(m.exit && m.exit.has(i)) && !(m.staff && m.staff.has(i)) && !visibleAt(sc, cx, cy, except) && !playerAt(sc, cx, cy);
    if (ok){
      if (!(m.doorFront && m.doorFront.has(i))) return { x:cx, y:cy };
      if (!fallback) fallback = { x:cx, y:cy };
    }
    var D = [[1,0],[-1,0],[0,1],[0,-1]];
    for (var d = 0; d < 4; d++){
      var nx = cx + D[d][0], ny = cy + D[d][1];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      var ni = ny * W + nx; if (seen[ni]) continue;
      seen[ni] = 1;
      if (m.walk[ni] !== 1) continue;
      q.push(nx, ny);
    }
  }
  return fallback;
}

/* ---------- state machine ---------- */
function startGoing(n, reason, instant){
  var b = homeOf(n); if (!b) return false;
  if (n.follow){ try { GT.npcFollow(n, false); } catch(e){} }
  n._cf = { mode:'going', reason:reason || 'night', t0:clk, retry:0, fail:0, ready:-1, b:b };
  if (instant) enter(n);
  return true;
}
function enter(n){
  var cf = n._cf || (n._cf = { mode:'going', reason:'night', t0:clk, retry:0, fail:0, ready:-1, b:homeOf(n) });
  try { if (n.script) GT.npcGo(n, [], null); } catch(e){}
  n.bubble = null; n.follow = false;
  GT.npcHide(n, true);
  cf.mode = 'home'; cf.ready = -1; cf.since = clk;
  cf.delay = 1 + (hash('wake|' + GT.npcKey(n)) % 11);   // bergiliran keluar
}
function appear(n){
  var cf = n._cf, b = (cf && cf.b) || homeOf(n), door = doorOf(b);
  var spot = freeSpot(door, n); if (!spot) return false;
  var ok = false;
  try { ok = GT.npcTeleport(n, spot.x, spot.y, 'down'); } catch(e){}
  if (!ok){ try { GT.moveNpc(n, 'out', spot.x, spot.y); } catch(e){} }
  GT.npcHide(n, false);
  n.home = { x:n.x, y:n.y }; n.dir = 'down'; n.wait = 0.4 + (hash('w2|' + GT.npcKey(n) + clk.toFixed(0)) % 20) / 10;
  n._cf = null;
  return true;
}
function restOk(n){
  try {
    if (GT.combat && typeof GT.combat.hp === 'function') return GT.combat.hp(n) >= 0.7 * GT.combat.maxHp(n);
  } catch(e){}
  return true;
}

function tickNpc(sc, n, act, dt){
  var cf = n._cf;
  if (cf && cf.mode === 'home'){
    if (!n.hidden){ n._cf = null; return; }                       // dimunculkan pihak lain
    var okWake = !act && (cf.reason !== 'rest' || restOk(n)) && (cf.reason !== 'send' || clk - cf.since > 10);
    if (!okWake){ cf.ready = -1; return; }
    if (cf.ready < 0) cf.ready = clk + cf.delay;
    if (clk >= cf.ready) appear(n);
    return;
  }
  if (cf && cf.mode === 'going'){
    if (n.hidden){ n._cf = null; return; }
    var night = cf.reason === 'night';
    if (night && !act){ n._cf = null; return; }                    // waktu mundur: lanjut berkeliaran
    if (night && exempt(n)){ n._cf = null; return; }               // mulai mengikuti / berencana
    if (n.talking){ cf.t0 += dt; return; }                         // sedang diajak bicara
    var door = doorOf(cf.b);
    var d = Math.abs(n.x - door.x) + Math.abs(n.y - door.y);
    if (!n.moving && d <= 1){ enter(n); return; }
    if (clk - cf.t0 > T_WALK){ enter(n); return; }
    if (!n.script && !n.moving && clk >= cf.retry){
      cf.retry = clk + 0.6;
      var path = GT.findPath(sc, n, door, { avoid:function(x, y){ return (x !== door.x || y !== door.y) && visibleAt(sc, x, y, n); } }) || GT.findPath(sc, n, door);
      if (!path){ if (++cf.fail >= 4) enter(n); return; }
      if (!path.length){ enter(n); return; }
      GT.npcGo(n, path, null);
    }
    return;
  }
  // belum punya status
  if (n.hidden || !act || exempt(n)) return;
  startGoing(n, 'night', bornNight && clk - born < 5);
}

function tick(dt){
  var sc = out(); if (!sc || !sc.npcs) return;
  var act = active();
  sc.npcs.slice().forEach(function(n){
    try { tickNpc(sc, n, act, dt); } catch(e){ console.error('[curfew]', e); }
  });
}

function sendHome(n, reason){
  if (!n) return false;
  var sc = GT.npcScene(n);
  if (n._cf && n._cf.mode === 'home') return true;
  if (sc !== out()) return isHome(n);
  if (n.hidden) return false;
  if (n._cf && n._cf.mode === 'going'){ n._cf.reason = reason || n._cf.reason; return true; }
  return startGoing(n, reason || 'send', false);
}
function hiddenList(){
  var sc = out(); if (!sc) return [];
  return sc.npcs.filter(function(n){ return n._cf && n._cf.mode === 'home'; });
}

GT.curfew = { active:active, homeOf:homeOf, isHome:isHome, sendHome:sendHome, exempt:exempt, hiddenList:hiddenList,
  _tick:function(dt){ clk += dt || 0; tick(dt || 0); } };

GT.register({
  id:'curfew',
  onWorld:function(){ homes.clear(); born = clk; bornNight = active(); },
  onFrame:function(dt){
    clk += dt; acc += dt;
    if (acc < 0.25) return;
    var d = acc; acc = 0;
    tick(d);
  }
});
})();

