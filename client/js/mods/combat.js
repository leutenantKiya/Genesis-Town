/* combat.js - Pukul + HP + efek visual (Genesis Town v2.3).
 *
 * GT.combat = {
 *   hp(ch), maxHp(ch)                     ch = 'player' | npc (atau key NPC). Pemain 100, NPC 60, polisi 120.
 *   hit(attacker, target, opts?) -> {ok, dmg, ko, reason}
 *        reason (bila ok=false): 'invalid' | 'remote' | 'ko' | 'scene' | 'range' | 'cooldown'
 *        Harus bersebelahan (<= 1 tile, scene sama), tidak pingsan, jeda 0.45 dtk per penyerang, dmg 8-14 (opts.dmg menimpa).
 *        opts.noReact = true: pemain memukul NPC tanpa memicu reaksi/afinitas/reputasi (dipakai tes).
 *   heal(ch, n), isKO(ch), setHp(ch, n)   (setHp: debug / tes)
 *   fx(ch, kind)                          kind: 'hit' | 'ko' | 'threat' | 'heal' - hanya visual
 *   threat(from, to, text?)               fx 'threat' + bubble bergetar + emit 'threat' {from, to}
 *   temperament(ch) -> 'pemberani' | 'penakut' | 'netral' (deterministik per seed + key)
 *   punch()                               sama dengan menekan F
 *   state()                               snapshot debug
 * }
 * Event: GT.on('hit', {attacker, target, dmg, ko, attackerNpc, targetNpc}) (attacker/target = 'player' atau GT.npcKey),
 *        GT.on('ko', {target, by, ...}), GT.on('threat', {from, to, ...}), GT.on('wake', {target}).
 * Kunci: F (pukul) + tombol "F" di pad sentuh. Persistensi HP pemain: localStorage 'gt.combat.v1'.
 */
(function(){
if (!window.GT_FLAGS || !window.GT_FLAGS.combat) return; // feature flag: off in the submission build (js/flags.js)
'use strict';
if (!window.GT) return;
var GT = window.GT;
var T = (window.SPRITES && SPRITES.TILE) || 12;
var LS = 'gt.combat.v1';

var DIRV = { up:[0,-1], down:[0,1], left:[-1,0], right:[1,0] };
var P_MAX = 100, N_MAX = 60, COP_MAX = 120, CD = 0.45, KO_T = 4;

var now = 0;                                   // detik nyata (akumulasi dt)
var pHp = P_MAX, pv = newVis(), pPos = { x:0, y:0 };
var pko = null;                                // alur pemain pingsan
var lastHitBy = new Map();                     // penyerang -> waktu pukulan terakhir
var damaged = new Set();                       // NPC dengan HP < max (regen)
var vis = new Set();                           // NPC dengan state visual aktif
var cbs = new Set();                           // NPC yang sedang berkelahi / kabur
var parts = [];                                // partikel & teks melayang
var shake = 0, lastShakeStep = 0;
var regenAcc = 0, lastTotal = null;
var playerAssaultAt = -1e9, policeCalled = -1e9, lastArrest = -1e9;
var REDUCE = false, saveTimer = 0;
try { var mq = window.matchMedia('(prefers-reduced-motion: reduce)'); REDUCE = mq.matches; if (mq.addEventListener) mq.addEventListener('change', function(e){ REDUCE = e.matches; }); } catch(e){}

function newVis(){ return { flash:0, flashDur:0.12, kick:null, lunge:null, ko:false, koSide:1, bar:0, threat:0, heal:0 }; }
function rnd(a, b){ return a + Math.random() * (b - a); }
function rint(a, b){ return Math.floor(rnd(a, b + 1)); }
function pick(a){ return a[Math.floor(Math.random() * a.length)]; }
function hash(s){ s = String(s); var h = 2166136261 >>> 0; for (var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function out(){ return GT.outScene; }

/* ---------------------------------------------------------------- characters */
function norm(ch){
  if (ch === 'player') return 'player';
  if (typeof ch === 'string'){ var f = null; try { f = GT.findNpc(ch); } catch(e){} return f || null; }
  return (ch && typeof ch === 'object') ? ch : null;
}
function isP(c){ return c === 'player'; }
function keyOf(c){ return isP(c) ? 'player' : GT.npcKey(c); }
function sceneOf(c){ return isP(c) ? GT.scene : GT.npcScene(c); }
function isWorker(n){ var k = (n && n.key) || ''; return /:keeper$/.test(k) || k === 'casino:dealer' || !!(n && n._post); }
function isRemote(n){ return !!(n && (n.isRemote || n.remote || /^peer:/.test(n.key || ''))); }
function maxHp(ch){ var c = norm(ch); if (!c) return N_MAX; return isP(c) ? P_MAX : (c.isPolice ? COP_MAX : N_MAX); }
function hp(ch){ var c = norm(ch); if (!c) return 0; if (isP(c)) return pHp; return c._hp == null ? maxHp(c) : c._hp; }
function visOf(c){ if (isP(c)) return pv; return c._v || (c._v = newVis()); }
function isKO(ch){ var c = norm(ch); if (!c) return false; return isP(c) ? !!pko : (c._ko > 0); }
function tilesOf(c){
  var r = [];
  if (isP(c)){
    var p = GT.player; r.push([p.x, p.y]);
    try { var g = window.__game && window.__game.player; if (g && p.moving) r.push([g.fx, g.fy]); } catch(e){}
  } else {
    r.push([c.x, c.y]); if (c.moving) r.push([c.fx, c.fy]);
  }
  return r;
}
function dist1(a, b){
  var A = tilesOf(a), B = tilesOf(b), best = 99;
  A.forEach(function(p){ B.forEach(function(q){ best = Math.min(best, Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1])); }); });
  return best;
}
function cur(c){ return isP(c) ? { x:GT.player.x, y:GT.player.y } : { x:c.x, y:c.y }; }
function dirTo(a, b){
  var p = cur(a), q = cur(b), dx = q.x - p.x, dy = q.y - p.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}
function nameOf(c){ return isP(c) ? 'Kamu' : (c.name || 'NPC'); }
function say(n, text, shakeIt){
  if (!n || isP(n) || n.hidden) return;
  try { GT.npcSay(n, text); } catch(e){}
  if (n.bubble && shakeIt) n.bubble.shake = true;
}

function temperament(ch){
  var c = norm(ch); if (!c || isP(c)) return 'netral';
  if (c.isPolice) return 'pemberani';
  return ['pemberani', 'penakut', 'netral'][hash((GT.seed || 0) + '|temp|' + GT.npcKey(c)) % 3];
}

/* ---------------------------------------------------------------- persistence */
function load(){
  try {
    var d = JSON.parse(window.localStorage.getItem(LS) || 'null');
    if (d && isFinite(+d.hp)) pHp = Math.max(1, Math.min(P_MAX, Math.round(+d.hp)));
  } catch(e){}
}
function persist(){
  if (saveTimer) return;
  saveTimer = setTimeout(persistNow, 250);
}
function persistNow(){
  saveTimer = 0;
  try { window.localStorage.setItem(LS, JSON.stringify({ v:1, hp:Math.max(1, Math.round(pHp)) })); } catch(e){}
}

/* ---------------------------------------------------------------- HP helpers */
function setHpRaw(c, v){
  v = Math.max(0, Math.min(maxHp(c), Math.round(v)));
  if (isP(c)){ pHp = v; persist(); hudDirty = true; }
  else { c._hp = v; if (v < maxHp(c)) damaged.add(c); else damaged.delete(c); }
  return v;
}
function heal(ch, n){
  var c = norm(ch); n = Math.floor(+n); if (!c || !isFinite(n) || n <= 0) return hp(ch);
  if (isKO(c)) return hp(c);
  var before = hp(c), after = setHpRaw(c, before + n);
  if (after > before) { addText(c, '+' + (after - before), '#8cf29a'); fx(c, 'heal'); }
  if (!isP(c)) visOf(c).bar = Math.max(visOf(c).bar, 3);
  return after;
}
function setHp(ch, n){
  var c = norm(ch); if (!c) return 0;
  var v = setHpRaw(c, n);
  if (!isP(c)) visOf(c).bar = 3;
  return v;
}

/* ---------------------------------------------------------------- effects store */
var hudDirty = true;
function worldPos(c){      // pusat badan (piksel dunia)
  var p = cur(c);
  var lp = null;
  if (isP(c)){ try { var g = window.__game && window.__game.player; if (g && GT.player.moving) lp = lerp(g.fx, g.fy, p.x, p.y, 0.5); } catch(e){} }
  else if (c.moving) lp = lerp(c.fx, c.fy, c.x, c.y, c.t);
  return lp || { x:p.x * T + T / 2, y:p.y * T + T / 2 };
}
function lerp(ax, ay, bx, by, t){ t = Math.max(0, Math.min(1, t || 0)); return { x:(ax + (bx - ax) * t) * T + T / 2, y:(ay + (by - ay) * t) * T + T / 2 }; }
function addPart(o){ o.t = 0; parts.push(o); if (parts.length > 160) parts.splice(0, parts.length - 160); return o; }
function addText(c, text, col){
  var w = worldPos(c), sc = sceneOf(c);
  addPart({ k:'text', sc:sc, wx:w.x, wy:w.y - 9, vy:-14, life:0.85, text:text, col:col || '#fff' });
}
function burst(sc, wx, wy, n, cols, speed){
  for (var i = 0; i < n; i++){
    var a = Math.random() * Math.PI * 2, s = rnd(0.5, 1) * (speed || 40);
    addPart({ k:'p', sc:sc, wx:wx, wy:wy, vx:Math.cos(a) * s, vy:Math.sin(a) * s - 6, life:rnd(0.22, 0.4), col:pick(cols), sz:Math.random() < 0.35 ? 2 : 1 });
  }
}
function star(sc, wx, wy, life, big){ addPart({ k:'star', sc:sc, wx:wx, wy:wy, life:life || 0.22, big:!!big }); }

function fx(ch, kind){
  var c = norm(ch); if (!c) return;
  var v = visOf(c), sc = sceneOf(c), w = worldPos(c);
  if (kind === 'hit'){
    v.flash = REDUCE ? 0.08 : 0.12; v.flashDur = v.flash;
    star(sc, w.x, w.y - 2, 0.2, false);
    burst(sc, w.x, w.y - 2, rint(3, 6), ['#ffffff', '#ffe066', '#ff9a3c'], 38);
    if (!isP(c)) v.bar = 3;
  } else if (kind === 'ko'){
    v.flash = REDUCE ? 0.1 : 0.18; v.flashDur = v.flash;
    star(sc, w.x, w.y - 3, 0.3, true);
    burst(sc, w.x, w.y - 3, 6, ['#ffffff', '#ffe066', '#ff6a5a', '#ffe066'], 52);
    addPart({ k:'text', sc:sc, wx:w.x, wy:w.y - 16, vy:-6, life:1.1, text:'KO', col:'#ffe066' });
  } else if (kind === 'threat'){
    v.threat = 1.3;
    if (!isP(c)){ c._shakeUntil = now + 1.3; if (c.bubble) c.bubble.shake = true; }
  } else if (kind === 'heal'){
    v.heal = 0.7;
    for (var i = 0; i < 3; i++) addPart({ k:'plus', sc:sc, wx:w.x + rnd(-4, 4), wy:w.y - 2 + rnd(-2, 3), vy:-12, life:rnd(0.5, 0.8), col:'#8cf29a' });
    if (!isP(c)) v.bar = Math.max(v.bar, 3);
  }
  if (!isP(c)) vis.add(c);
}

/* ---------------------------------------------------------------- hit */
function freeTile(sc, x, y, mover){
  var m = sc.map; if (!m || x < 0 || y < 0 || x >= m.w || y >= m.h) return false;
  var i = y * m.w + x;
  if (m.walk[i] !== 1) return false;
  if (m.exit && m.exit.has(i)) return false;
  if (m.door && m.door.has(i)) return false;
  if (m.staff && m.staff.has(i)) return false;
  if (m.doorFront && m.doorFront.has(i)) return false;
  for (var k = 0; k < sc.npcs.length; k++){
    var o = sc.npcs[k]; if (o === mover || o.hidden) continue;
    if ((o.x === x && o.y === y) || (o.moving && o.fx === x && o.fy === y)) return false;
  }
  if (sc === GT.scene && !isP(mover)){
    var p = GT.player; if (p.x === x && p.y === y) return false;
    try { var g = window.__game && window.__game.player; if (g && p.moving && g.fx === x && g.fy === y) return false; } catch(e){}
  }
  return true;
}
function knockback(att, tgt){
  var sc = sceneOf(tgt); if (!sc) return;
  var p = cur(tgt), q = cur(att), dx = p.x - q.x, dy = p.y - q.y;
  if (dx && dy){ if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }
  dx = Math.sign(dx); dy = Math.sign(dy);
  if (!dx && !dy) return;
  var nx = p.x + dx, ny = p.y + dy;
  if (!freeTile(sc, nx, ny, tgt)) return;
  var v = visOf(tgt);
  v.kick = { dx:-dx * T, dy:-dy * T, t:0, dur:REDUCE ? 0.06 : 0.13 };
  if (isP(tgt)){
    try { GT.teleportPlayer(sc, nx, ny, GT.player.dir); } catch(e){}
  } else {
    tgt.fx = nx; tgt.fy = ny; tgt.x = nx; tgt.y = ny; tgt.moving = false; tgt.t = 0;
    tgt.home = { x:nx, y:ny };
    if (tgt.script){ try { GT.npcGo(tgt, [], null); } catch(e){} }
  }
}

function snd(name, who){
  try {
    if (!window.GT_SFX) return;
    var o = (who && !isP(who) && isFinite(who.x) && isFinite(who.y)) ? { x:who.x, y:who.y } : undefined;
    GT_SFX.play(name, o);
  } catch(e){}
}
function hit(attacker, target, opts){
  opts = opts || {};
  var A = norm(attacker), B = norm(target);
  var fail = function(r){ return { ok:false, dmg:0, ko:false, reason:r }; };
  if (!A || !B || A === B) return fail('invalid');
  if ((!isP(A) && isRemote(A)) || (!isP(B) && isRemote(B))) return fail('remote');
  if (isKO(A) || isKO(B)) return fail('ko');
  if ((!isP(A) && A.hidden) || (!isP(B) && B.hidden)) return fail('scene');
  var sa = sceneOf(A), sb = sceneOf(B);
  if (!sa || sa !== sb) return fail('scene');
  if (isP(A) || isP(B)){ if (sa !== GT.scene) return fail('scene'); }
  if (dist1(A, B) > 1) return fail('range');
  var ka = keyOf(A);
  if (now - (lastHitBy.get(ka) || -9) < CD) return fail('cooldown');
  lastHitBy.set(ka, now);

  var dmg = opts.dmg != null ? Math.max(0, Math.round(+opts.dmg) || 0) : rint(8, 14);
  var before = hp(B), after = setHpRaw(B, before - dmg), ko = after <= 0;
  var d = dirTo(A, B);
  if (!isP(A)){ A.dir = d; vis.add(A); }
  var va = visOf(A);
  var dv = DIRV[d]; va.lunge = { dx:dv[0] * 2, dy:dv[1] * 2, t:0, dur:0.12 };

  // efek
  var wb = worldPos(B), wa = worldPos(A), sc = sa;
  fx(B, 'hit');
  snd('swing', A); snd(isP(B) ? 'hurt' : 'hit', B);
  var hx = wb.x - dv[0] * 4, hy = wb.y - 3 - Math.abs(dv[1]) * 0;
  star(sc, hx, hy, 0.22, true);
  burst(sc, hx, hy, rint(3, 6), ['#ffffff', '#ffe066', '#ff9a3c', '#ff5a4a'], 46);
  addText(B, '-' + dmg, isP(B) ? '#ff6a5a' : '#ffffff');
  if (isP(B)) shakeScreen(0.2);
  if (!isP(B)){ visOf(B).bar = 3; vis.add(B); if (!ko && !B.bubble && Math.random() < 0.7) say(B, pick(['Aduh!', 'Hei!', 'Sakit!', 'Auw!', 'Ih!'])); }
  if (!ko) knockback(A, B);
  persist();
  hudDirty = true;

  var res = { ok:true, dmg:dmg, ko:ko, reason:'' };
  var ev = { attacker:ka, target:keyOf(B), dmg:dmg, ko:ko, attackerNpc:isP(A) ? null : A, targetNpc:isP(B) ? null : B, noReact:!!opts.noReact };
  try { GT.emit('hit', ev); } catch(e){}
  if (ko) knockOut(B, A);
  if (isP(A) && !isP(B) && !opts.noReact) reactToPlayer(B, ko);
  else if (!isP(B) && !isP(A) && !ko) { /* NPC vs NPC: reaksi diurus agent.js */ }
  return res;
}

/* ---------------------------------------------------------------- KO */
function knockOut(c, by){
  var kb = isP(by) ? 'player' : (by ? keyOf(by) : null);
  fx(c, 'ko');
  if (!isP(c)) snd('monster_die', c);
  if (isP(c)){ playerKO(by); }
  else {
    c._ko = KO_T; c._hp = 0; damaged.add(c);
    var v = visOf(c); v.ko = true; v.koSide = (hash(GT.npcKey(c)) & 1) ? 1 : -1; v.bar = 4; vis.add(c);
    c.talking = true; c._eng = false; c.follow && GT.npcFollow(c, false);
    try { if (GT.agent && GT.agent.status && GT.agent.status(c).busy) GT.agent.cancel(c); } catch(e){}
    if (c.script){ try { GT.npcGo(c, [], null); } catch(e){} }
    endCb(c);
    // lawan yang mengejar target pingsan berhenti
    cbs.forEach(function(o){ if (o._cb && o._cb.target === c) endCb(o); });
    say(c, 'Aduh... zZz', false);
  }
  try { GT.emit('ko', { target:keyOf(c), by:kb, targetNpc:isP(c) ? null : c, byNpc:(by && !isP(by)) ? by : null }); } catch(e){}
}
function wakeNpc(n){
  n._ko = 0; n.talking = false; n._eng = false;
  var v = visOf(n); v.ko = false; v.bar = 2;
  var m = maxHp(n);
  setHpRaw(n, Math.max(Math.ceil(m * 0.25), hp(n)));
  n.wait = 1;
  try { GT.emit('wake', { target:keyOf(n), targetNpc:n }); } catch(e){}
  if (n.isPolice) return;
  if (isWorker(n)){
    if (n._post){ try { GT.agent.run(n, [{ 'do':'kerja' }], { source:'post' }); } catch(e){} }
    return;
  }
  try { if (GT.curfew && GT.curfew.sendHome) GT.curfew.sendHome(n, 'rest'); } catch(e){}
}

/* alur pemain pingsan: jatuh -> layar menggelap -> pulang -> dialog -> layar terang */
var fadeEl = null;
function playerKO(by){
  if (pko) return;
  pko = { t:0, phase:'fall', dlgClosed:false, by:by };
  pv.ko = true; pv.koSide = 1;
  try { window.dispatchEvent(new Event('blur')); } catch(e){}      // lepaskan tombol arah yang sedang ditahan
  try { GT.closeAllModals(); } catch(e){}
  cbs.forEach(function(o){ if (o._cb && o._cb.target === 'player') endCb(o); });
  // batalkan ikut / rencana yang melibatkan pemain
  var scs = [out(), GT.scene]; var seen = [];
  scs.forEach(function(sc){
    if (!sc || seen.indexOf(sc) >= 0) return; seen.push(sc);
    sc.npcs.forEach(function(n){
      if (n.follow){
        try { if (GT.agent && GT.agent.cancel) GT.agent.cancel(n); } catch(e){}
        try { GT.npcFollow(n, false); } catch(e){}
      }
    });
  });
  GT.dialog(['Kamu pingsan... dibawa pulang.'], '', null, function(){
    if (!pko) return;
    pko.dlgClosed = true;
    if (pko.phase === 'black') playerWake();
  });
}
function ensureFade(){
  if (fadeEl) return fadeEl;
  var scr = document.getElementById('screen'); if (!scr) return null;
  fadeEl = document.createElement('div'); fadeEl.id = 'cbfade';
  scr.appendChild(fadeEl);
  return fadeEl;
}
function fadeTo(v, dur){
  var f = ensureFade(); if (!f) return;
  f.style.transition = 'opacity ' + (REDUCE ? Math.min(dur, 0.2) : dur) + 's linear';
  f.style.opacity = String(v);
}
function tickPlayerKO(dt){
  if (!pko) return;
  pko.t += dt;
  if (pko.phase === 'fall' && pko.t > 0.45){ pko.phase = 'fade'; fadeTo(1, 0.5); }
  if (pko.phase === 'fade' && pko.t > 1.0){
    pko.phase = 'black';
    try { window.dispatchEvent(new Event('blur')); } catch(e){}
    var own = (GT.buildings || []).filter(function(b){ return b.own; })[0];
    if (own) GT.teleportPlayer('out', own.dx, own.dy + 1, 'down');
    pv.ko = false; pv.kick = null; pv.lunge = null; pv.flash = 0;
    setHpRaw('player', P_MAX);
    hudDirty = true;
    if (pko.dlgClosed) playerWake();
  }
}
function playerWake(){
  var info = pko; pko = null;
  try { window.dispatchEvent(new Event('blur')); } catch(e){}
  fadeTo(0, 0.6);
  try { GT.emit('wake', { target:'player', targetNpc:null }); } catch(e){}
  return info;
}

/* ---------------------------------------------------------------- reaksi NPC terhadap pemukulan pemain */
function endCb(n){
  if (!n || !n._cb) return;
  n._cb = null; cbs.delete(n);
}
function startCb(n, mode, target){
  n._cb = { mode:mode, target:target, t:0, until:now + (mode === 'flee' ? 6 : 12), nextHit:now + 0.45, nextPath:0, chaseT:0, fleeT:0 };
  cbs.add(n);
  if (n.follow){ try { GT.npcFollow(n, false); } catch(e){} }
  try { if (GT.agent && GT.agent.status && GT.agent.status(n).busy) GT.agent.cancel(n); } catch(e){}
  if (n.script){ try { GT.npcGo(n, [], null); } catch(e){} }
}
function reactToPlayer(n, ko){
  playerAssaultAt = now;
  var provoked = !!(n._cb && n._cb.mode === 'fight' && n._cb.target === 'player');
  if (!n.noAffinity){ try { GT.addAffinity(n, -10); } catch(e){} }
  if (!provoked){ try { GT.addReputation(-3); } catch(e){} }
  callPolice(n);
  if (ko) return;
  if (n._cb && n._cb.mode === 'fight'){ n._cb.until = now + 12; return; }
  if (isWorker(n)){
    say(n, pick(['Tolong! Jangan pukul!', 'Aku sedang bekerja!', 'Hei! Hentikan!']), true);
    return;
  }
  var tmp = temperament(n), mode;
  if (n.isPolice) mode = 'fight';
  else if (tmp === 'pemberani') mode = 'fight';
  else if (tmp === 'penakut') mode = 'flee';
  else mode = hp(n) > maxHp(n) * 0.5 ? 'fight' : 'flee';
  if (mode === 'fight'){
    startCb(n, 'fight', 'player');
    GT.combat.threat(n, 'player', n.isPolice ? 'Berhenti! Kamu melawan petugas!' : pick(['Berani sekali kamu!', 'Kubalas kamu!', 'Sini kamu!']));
  } else {
    startCb(n, 'flee', 'player');
    say(n, pick(['Tolong!!', 'Jangan pukul aku!', 'Polisi!!']), true);
  }
}
function callPolice(victim){
  // v2.4: siang atau malam, polisi datang ke lokasi (GT.police.respond); status buronan diurus police.js
  var pl = GT.police;
  if (!pl || typeof pl.respond !== 'function' || !victim || victim.isPolice) return;
  if (now - policeCalled < 8) return;
  var vp = cur(victim), sc = sceneOf(victim);
  policeCalled = now;
  try { pl.respond({ x:vp.x, y:vp.y, scene:(sc === out() ? 'out' : sc), reason:'assault', parties:['player', victim] }); } catch(e){ console.error('[combat] respond', e); }
}
function tickPoliceResponse(o, dt){
  var r = o._respond; if (!r) return;
  if (now > r.until || isKO(o) || o.hidden || GT.scene !== GT.npcScene(o) || pko){ o._respond = null; return; }
  var d = dist1(o, 'player');
  if (d <= 1){
    o._respond = null;
    if (now - playerAssaultAt < 25 && now - lastArrest > 30 && GT.police && GT.police.arrest){
      lastArrest = now;
      try { GT.police.arrest('assault', o); } catch(e){ console.error(e); }
    }
    return;
  }
  if (o.script || o.moving || now < (r.next || 0)) return;
  r.next = now + 0.6;
  var pp = GT.player;
  var path = GT.findPath(GT.scene, o, { x:pp.x, y:pp.y });
  if (path && path.length > 1){ path.pop(); GT.npcGo(o, path.slice(0, 8), null); }
}

function tickCb(n, dt){
  var cb = n._cb; if (!cb) return;
  var sc = GT.npcScene(n);
  if (n.hidden || isKO(n) || !sc || sc !== GT.scene && cb.target === 'player'){ endCb(n); return; }
  var tg = cb.target;
  if (tg !== 'player'){ tg = norm(tg); if (!tg || isKO(tg)){ endCb(n); return; } }
  if (isKO('player') && tg === 'player'){ endCb(n); return; }
  if (now > cb.until){
    if (cb.mode === 'fight') say(n, pick(['Hmph.', 'Awas lain kali.', 'Sudahlah.']), false);
    endCb(n); return;
  }
  if (GT.isUiOpen()){ cb.nextHit = Math.max(cb.nextHit, now + 0.3); return; }
  if (n.talking) return;
  var tp = tg === 'player' ? cur('player') : cur(tg);
  if (cb.mode === 'fight'){
    var d = dist1(n, tg);
    if (d <= 1){
      if (!n.moving){
        n.dir = dirTo(n, tg);
        if (now >= cb.nextHit){
          var cop = n.isPolice;
          var r = hit(n, tg, cop ? { dmg:rint(10, 16) } : undefined);
          cb.nextHit = now + (cop ? 0.6 : 0.8) + (r.ok ? 0 : 0.1);
          if (r.ok) cb.until = Math.max(cb.until, now + 6);
        }
      }
    } else {
      cb.chaseT += dt;
      if (cb.chaseT > 8){ say(n, 'Kabur kau!', false); endCb(n); return; }
      if (!n.script && !n.moving && now >= cb.nextPath){
        cb.nextPath = now + 0.2;
        var path = GT.findPath(sc, n, tp, { avoid:function(x, y){ return (x !== tp.x || y !== tp.y) && occupiedBy(sc, x, y, n); } }) || GT.findPath(sc, n, tp);
        if (path && path.length > 1) GT.npcGo(n, [path[0]], null);
        else if (!path || !path.length) { /* tidak terjangkau */ cb.chaseT += 1; }
      }
    }
  } else if (cb.mode === 'flee'){
    if (n.script || n.moving) return;
    if (now >= cb.nextPath){
      cb.nextPath = now + 0.35;
      var dd = dist1(n, tg);
      if (dd >= 9 && cb.fleeT > 2.5){ endCb(n); return; }
      cb.fleeT += 0.35;
      var dest = fleeSpot(sc, n, tp);
      if (dest){
        var pth = GT.findPath(sc, n, dest);
        if (pth && pth.length) GT.npcGo(n, pth.slice(0, 6), null);
      }
    }
  }
}
function occupiedBy(sc, x, y, except){
  for (var i = 0; i < sc.npcs.length; i++){
    var o = sc.npcs[i]; if (o === except || o.hidden) continue;
    if ((o.x === x && o.y === y) || (o.moving && o.fx === x && o.fy === y)) return true;
  }
  return false;
}
function fleeSpot(sc, n, from){
  var m = sc.map, best = null, bd = -1;
  for (var i = 0; i < 14; i++){
    var a = Math.random() * Math.PI * 2, r = rnd(5, 10);
    var x = Math.round(n.x + Math.cos(a) * r), y = Math.round(n.y + Math.sin(a) * r);
    if (x < 1 || y < 1 || x >= m.w - 1 || y >= m.h - 1) continue;
    var k = y * m.w + x;
    if (m.walk[k] !== 1 || (m.exit && m.exit.has(k)) || (m.doorFront && m.doorFront.has(k)) || occupiedBy(sc, x, y, n)) continue;
    var d = Math.abs(x - from.x) + Math.abs(y - from.y);
    if (d > bd){ bd = d; best = { x:x, y:y }; }
  }
  return best;
}

/* ---------------------------------------------------------------- threat */
function threat(from, to, text){
  var A = norm(from), B = norm(to); if (!A) return;
  fx(A, 'threat');
  if (!isP(A) && text){ say(A, text, true); }
  try { GT.emit('threat', { from:keyOf(A), to:B ? keyOf(B) : String(to), fromNpc:isP(A) ? null : A, toNpc:(!B || isP(B)) ? null : B }); } catch(e){}
}

/* ---------------------------------------------------------------- player input */
function facingNpc(){
  var f = GT.facing(), sc = GT.scene, res = null;
  sc.npcs.forEach(function(n){
    if (n.hidden || res) return;
    if ((n.x === f.x && n.y === f.y) || (n.moving && n.fx === f.x && n.fy === f.y)) res = n;
  });
  return res;
}
var lastWhiff = -9;
function punch(){
  if (pko || GT.isUiOpen() || !GT.scene) return false;
  var n = facingNpc();
  if (n){
    var r = hit('player', n);
    if (r.ok) return true;
    if (r.reason === 'ko') GT.toast(n.name + ' sudah pingsan.');
    else if (r.reason === 'remote') GT.toast('Pemain lain tidak bisa dipukul.');
    if (r.reason !== 'cooldown') return false;
    return false;
  }
  if (now - lastWhiff < 0.3 || now - (lastHitBy.get('player') || -9) < CD) return false;
  lastWhiff = now;
  lastHitBy.set('player', now);
  var d = GT.player.dir, dv = DIRV[d] || DIRV.down, w = worldPos('player');
  pv.lunge = { dx:dv[0] * 2, dy:dv[1] * 2, t:0, dur:0.12 };
  addPart({ k:'swish', sc:GT.scene, wx:w.x + dv[0] * 9, wy:w.y + dv[1] * 8 - 1, dir:d, life:0.14 });
  return true;
}

/* ---------------------------------------------------------------- shake */
function shakeScreen(sec){ if (REDUCE) return; shake = Math.max(shake, sec); }
function tickShake(dt){
  var cv = document.getElementById('cv'); if (!cv) return;
  if (shake > 0){
    shake -= dt;
    if (shake > 0){
      if (now - lastShakeStep > 0.04){
        lastShakeStep = now;
        var s = (window.__game && window.__game.scale) || 2;
        cv.style.transform = 'translate(' + (rint(-1, 1) * s) + 'px,' + (rint(-1, 1) * s) + 'px)';
      }
      return;
    }
    shake = 0; cv.style.transform = '';
  }
}

/* ---------------------------------------------------------------- tick */
function tickVis(v, dt){
  if (v.flash > 0) v.flash = Math.max(0, v.flash - dt);
  if (v.kick){ v.kick.t += dt; if (v.kick.t >= v.kick.dur) v.kick = null; }
  if (v.lunge){ v.lunge.t += dt; if (v.lunge.t >= v.lunge.dur) v.lunge = null; }
  if (v.bar > 0) v.bar = Math.max(0, v.bar - dt);
  if (v.threat > 0) v.threat = Math.max(0, v.threat - dt);
  if (v.heal > 0) v.heal = Math.max(0, v.heal - dt);
}
function tickRegen(){
  var tot = (GT.time && GT.time.total) || 0;
  if (lastTotal == null){ lastTotal = tot; return; }
  var dm = tot - lastTotal; lastTotal = tot;
  if (dm <= 0) return;
  regenAcc += Math.min(dm, 1440);
  var steps = Math.floor(regenAcc / 10);
  if (steps <= 0) return;
  regenAcc -= steps * 10;
  if (!pko && pHp < P_MAX){ pHp = Math.min(P_MAX, pHp + steps); persist(); hudDirty = true; }
  damaged.forEach(function(n){
    if (n._ko > 0) return;
    var h = hp(n) + 2 * steps;
    setHpRaw(n, h);
  });
}
function tick(dt){
  now += dt;
  tickVis(pv, dt);
  vis.forEach(function(n){
    tickVis(visOf(n), dt);
    if (n._shakeUntil && now < n._shakeUntil && n.bubble) n.bubble.shake = true;
    if (n._ko > 0){
      n._ko -= dt; n.talking = true; n._eng = false;
      if (n._ko <= 0) wakeNpc(n);
    }
    var v = n._v;
    if (n._respond) tickPoliceResponse(n, dt);
    if (v && !v.flash && !v.kick && !v.lunge && !v.bar && !v.threat && !v.heal && !v.ko && !(n._ko > 0) && !n._respond && !n._shakeUntil) vis.delete(n);
    else if (n._shakeUntil && now >= n._shakeUntil) n._shakeUntil = 0;
  });
  cbs.forEach(function(n){ try { tickCb(n, dt); } catch(e){ console.error('[combat]', e); endCb(n); } });
  tickPlayerKO(dt);
  tickRegen();
  tickShake(dt);
  // partikel
  for (var i = parts.length - 1; i >= 0; i--){
    var p = parts[i]; p.t += dt;
    if (p.t >= p.life){ parts.splice(i, 1); continue; }
    if (p.k === 'p'){ p.vy += 90 * dt; p.wx += p.vx * dt; p.wy += p.vy * dt; }
    else if (p.k === 'text' || p.k === 'plus'){ p.wy += p.vy * dt; p.vy *= 0.94; }
  }
  updateHud();
}

/* ---------------------------------------------------------------- drawing */
var FONT = {
  '0':['111','101','101','101','111'], '1':['010','110','010','010','111'], '2':['111','001','111','100','111'],
  '3':['111','001','111','001','111'], '4':['101','101','111','001','001'], '5':['111','100','111','001','111'],
  '6':['111','100','111','101','111'], '7':['111','001','010','010','010'], '8':['111','101','111','101','111'],
  '9':['111','101','111','001','111'], '-':['000','000','111','000','000'], '+':['000','010','111','010','000'],
  '!':['010','010','010','000','010'], 'K':['101','101','110','101','101'], 'O':['111','101','101','101','111'],
  'z':['110','010','011'], 'Z':['111','001','010','100','111']
};
function textW(s){ var w = 0; for (var i = 0; i < s.length; i++){ var gl = FONT[s[i]]; w += (gl ? gl[0].length : 3) + 1; } return w - 1; }
function drawGlyphs(g, s, x, y, col){
  var cx = x;
  for (var i = 0; i < s.length; i++){
    var gl = FONT[s[i]]; if (!gl){ cx += 4; continue; }
    g.fillStyle = col;
    for (var r = 0; r < gl.length; r++) for (var c = 0; c < gl[r].length; c++) if (gl[r][c] === '1') g.fillRect(cx + c, y + r, 1, 1);
    cx += gl[0].length + 1;
  }
}
function drawText(g, s, x, y, col){      // x,y = tengah-atas; dengan outline hitam 1 px
  x = Math.round(x - textW(s) / 2); y = Math.round(y);
  var o = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,1],[-1,1],[1,-1]];
  for (var i = 0; i < o.length; i++) drawGlyphs(g, s, x + o[i][0], y + o[i][1], '#14101c');
  drawGlyphs(g, s, x, y, col);
}
var STAR_BIG = ['...y...', '..yWy..', '.yyWyy.', 'yWWWWWy', '.yyWyy.', '..yWy..', '...y...'];
var STAR_SM = ['.y.', 'yWy', '.y.'];
function drawStar(g, cx, cy, big, fade){
  var rows = big ? STAR_BIG : STAR_SM, n = rows.length, x0 = Math.round(cx - n / 2), y0 = Math.round(cy - n / 2);
  for (var r = 0; r < n; r++) for (var c = 0; c < n; c++){
    var ch = rows[r][c]; if (ch === '.') continue;
    g.fillStyle = ch === 'W' ? '#ffffff' : (fade ? '#ff9a3c' : '#ffe066');
    g.fillRect(x0 + c, y0 + r, 1, 1);
  }
}
var tmp = null, tg = null;
function tmpCanvas(){
  if (!tmp){ tmp = document.createElement('canvas'); tmp.width = 16; tmp.height = 20; tg = tmp.getContext('2d'); tg.imageSmoothingEnabled = false; }
  return tg;
}
function spriteTo(t, pal, dir, step){
  t.clearRect(0, 0, 16, 20);
  try { SPRITES.drawCharacter(t, 2, 6, pal, dir, step); }
  catch(e){ try { SPRITES.drawCharacter(t, 2, 6, (pal | 0) % 6, dir, step); } catch(e2){} }
}
/* dipanggil core untuk setiap karakter; true = sudah digambar di sini */
function charDraw(g, n, x, y, pal, dir, step){
  var c = n || 'player', v = isP(c) ? pv : n._v;
  if (isP(c)){ pPos.x = x; pPos.y = y; } else { n._sx = x; n._sy = y; }
  if (!v) return false;
  var ko = isP(c) ? pv.ko : (n._ko > 0 || v.ko);
  if (!(v.flash > 0 || v.kick || v.lunge || ko)) return false;
  var ox = 0, oy = 0;
  if (v.kick){ var k = 1 - Math.min(1, v.kick.t / v.kick.dur); k = k * k; ox += v.kick.dx * k; oy += v.kick.dy * k; }
  if (v.lunge){ var l = v.lunge, lp = l.t / l.dur; lp = lp < 0.5 ? lp * 2 : (1 - lp) * 2; ox += l.dx * lp; oy += l.dy * lp; }
  ox = Math.round(ox); oy = Math.round(oy);
  var t = tmpCanvas();
  spriteTo(t, pal, dir, step);
  var tint = null;
  if (v.flash > 0){
    var f = v.flash / (v.flashDur || 0.12);
    tint = f > 0.5 ? 'rgba(255,255,255,0.9)' : 'rgba(255,60,50,0.6)';
  }
  if (ko && !tint) tint = 'rgba(110,112,128,0.62)';
  if (tint){
    t.globalCompositeOperation = 'source-atop';
    t.fillStyle = tint; t.fillRect(0, 0, 16, 20);
    t.globalCompositeOperation = 'source-over';
  }
  g.save();
  if (ko){
    var side = v.koSide || 1;
    // tidur menyamping: putar 90 derajat di sekitar pusat badan, telapak menyentuh tanah
    g.transform(0, side, -side, 0, x + ox + 6, y + oy + 6);
    g.drawImage(tmp, -8, -11);
  } else {
    g.drawImage(tmp, x + ox - 2, y + oy - 6);
  }
  g.restore();
  return true;
}

function hpColor(f){ return f > 0.5 ? '#58d468' : f > 0.25 ? '#f2c94c' : '#e8504a'; }
function drawBar(g, x, y, f){
  // 14 x 4 dengan bingkai hitam
  g.fillStyle = '#14101c'; g.fillRect(x - 1, y - 1, 14, 4);
  g.fillStyle = '#4a3a52'; g.fillRect(x, y, 12, 2);
  var w = Math.max(f > 0 ? 1 : 0, Math.round(12 * f));
  g.fillStyle = hpColor(f); g.fillRect(x, y, w, 2);
  g.fillStyle = 'rgba(255,255,255,0.45)'; g.fillRect(x, y, w, 1);
}
function drawKoMarks(g, x, y, side){
  var cx = x + 6, cy = y - 3;
  if (REDUCE){
    drawStar(g, cx - 5, cy + 1, false); drawStar(g, cx, cy - 1, false); drawStar(g, cx + 5, cy + 1, false);
  } else {
    for (var i = 0; i < 3; i++){
      var a = now * 4 + i * Math.PI * 2 / 3;
      drawStar(g, cx + Math.cos(a) * 6, cy + Math.sin(a) * 2, false);
    }
  }
  var ph = REDUCE ? 0 : Math.floor(now * 1.6) % 2;
  drawText(g, 'z', cx + 7 + ph, y - 5 - ph, '#cfe3ff');
  drawText(g, 'Z', cx + 12, y - 11 - ph, '#ffffff');
}
function drawThreat(g, x, y, t){
  var cx = x + 6, bob = REDUCE ? 0 : (Math.floor(now * 8) % 2);
  var cy = y - 11 - bob;
  // tanda marah: urat siku merah + seru
  g.fillStyle = '#14101c'; g.fillRect(cx - 4, cy - 1, 9, 9);
  g.fillStyle = '#e8302a'; g.fillRect(cx - 3, cy, 7, 7);
  g.fillStyle = '#ff8a7a'; g.fillRect(cx - 3, cy, 7, 1);
  g.fillStyle = '#ffffff';
  g.fillRect(cx, cy + 1, 1, 3); g.fillRect(cx, cy + 5, 1, 1);
  g.fillStyle = '#e8302a';
  g.fillRect(cx - 6, cy - 2, 1, 2); g.fillRect(cx - 5, cy - 3, 2, 1);
  g.fillRect(cx + 6, cy - 2, 1, 2); g.fillRect(cx + 4, cy - 3, 2, 1);
}
function onDraw(g, camX, camY, TT){
  var sc = GT.scene; if (!sc) return;
  g.save();
  g.globalCompositeOperation = 'source-over';
  // karakter: bar HP, tanda KO, tanda marah
  var list = sc.npcs;
  for (var i = 0; i < list.length; i++){
    var n = list[i]; if (n.hidden || n._sx == null) continue;
    var v = n._v; if (!v) continue;
    var ko = n._ko > 0 || v.ko;
    if (v.bar > 0 || ko){
      var f = Math.max(0, Math.min(1, hp(n) / maxHp(n)));
      var a = ko ? 1 : Math.min(1, v.bar / 0.5);
      g.globalAlpha = a;
      drawBar(g, n._sx, n._sy - 5 - (ko ? 3 : 0), f);
      g.globalAlpha = 1;
    }
    if (ko) drawKoMarks(g, n._sx, n._sy - 3, v.koSide);
    if (v.threat > 0) drawThreat(g, n._sx, n._sy - (n.label ? 3 : 0), v.threat);
  }
  if (pv.threat > 0) drawThreat(g, pPos.x, pPos.y, pv.threat);
  if (pv.ko) drawKoMarks(g, pPos.x, pPos.y - 3, 1);
  // partikel
  for (var j = 0; j < parts.length; j++){
    var p = parts[j]; if (p.sc !== sc) continue;
    var x = Math.round(p.wx - camX), y = Math.round(p.wy - camY), f2 = p.t / p.life;
    if (p.k === 'p'){
      g.globalAlpha = f2 > 0.7 ? 1 - (f2 - 0.7) / 0.3 : 1;
      g.fillStyle = p.col; g.fillRect(x, y, p.sz, p.sz);
    } else if (p.k === 'star'){
      g.globalAlpha = 1;
      if (p.big) drawStar(g, x, y, f2 < 0.75, f2 > 0.5);
      else drawStar(g, x, y, f2 < 0.5, f2 > 0.5);
    } else if (p.k === 'text'){
      g.globalAlpha = f2 > 0.7 ? 1 - (f2 - 0.7) / 0.3 : 1;
      drawText(g, p.text, x, y, p.col);
    } else if (p.k === 'plus'){
      g.globalAlpha = f2 > 0.6 ? 1 - (f2 - 0.6) / 0.4 : 1;
      g.fillStyle = '#14101c'; g.fillRect(x - 2, y - 1, 5, 3); g.fillRect(x - 1, y - 2, 3, 5);
      g.fillStyle = p.col; g.fillRect(x - 1, y, 3, 1); g.fillRect(x, y - 1, 1, 3);
    } else if (p.k === 'swish'){
      g.globalAlpha = 1 - f2;
      g.fillStyle = '#ffffff';
      var horiz = p.dir === 'left' || p.dir === 'right';
      if (horiz){ g.fillRect(x - 1, y - 3, 1, 2); g.fillRect(x, y - 1, 1, 3); g.fillRect(x - 1, y + 2, 1, 2); }
      else { g.fillRect(x - 3, y - 1, 2, 1); g.fillRect(x - 1, y, 3, 1); g.fillRect(x + 2, y - 1, 2, 1); }
    }
  }
  g.restore();
}

/* ---------------------------------------------------------------- HUD (HP) + touch button */
var hudEl = null, hudBar = null, hudNum = null, lastHud = '';
function el(tag, cls, text){ var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function buildHeart(){
  var cv = el('canvas', 'cb-heart'); cv.width = 9; cv.height = 8;
  var g = cv.getContext('2d'), rows = ['.kk...kk.', 'krrk.krrk', 'krwrkrrrk', 'krrrrrrrk', '.krrrrrk.', '..krrrk..', '...krk...', '....k....'];
  var col = { k:'#14101c', r:'#e8504a', w:'#ffb3a8' };
  for (var y = 0; y < 8; y++) for (var x = 0; x < 9; x++){ var c = rows[y][x]; if (c !== '.'){ g.fillStyle = col[c]; g.fillRect(x, y, 1, 1); } }
  cv.setAttribute('aria-hidden', 'true');
  return cv;
}
function buildHud(){
  var hud = document.getElementById('hud'), acts = document.getElementById('acts');
  if (!hud || hudEl) return;
  hudEl = el('div', 'cell cb-hp');
  hudEl.appendChild(el('span', 'lbl', 'HP'));
  var val = el('span', 'val cb-val');
  val.setAttribute('role', 'meter'); val.setAttribute('aria-label', 'HP'); val.setAttribute('aria-valuemin', '0'); val.setAttribute('aria-valuemax', String(P_MAX));
  val.appendChild(buildHeart());
  var bar = el('span', 'cb-bar'); hudBar = el('b'); bar.appendChild(hudBar); val.appendChild(bar);
  hudNum = el('span', 'cb-num', String(P_MAX)); val.appendChild(hudNum);
  hudEl.appendChild(val); hudEl._val = val;
  hud.insertBefore(hudEl, acts || null);
}
function updateHud(){
  if (!hudEl) return;
  var h = Math.max(0, Math.round(pHp)), key = h + ':' + (pv.flash > 0 ? 1 : 0);
  if (key === lastHud) return;
  lastHud = key;
  var f = h / P_MAX;
  hudBar.style.width = (f * 100) + '%';
  hudBar.style.background = hpColor(f);
  hudNum.textContent = String(h);
  hudEl._val.setAttribute('aria-valuenow', String(h));
  hudEl.classList.toggle('hit', pv.flash > 0);
  hudEl.classList.toggle('low', f <= 0.25);
}
function buildPad(){
  var padmap = document.getElementById('padmap'); if (!padmap || document.getElementById('btnF')) return;
  var row = el('div', 'abtop');
  padmap.parentNode.insertBefore(row, padmap);
  var b = el('button', null, 'F'); b.id = 'btnF'; b.type = 'button'; b.setAttribute('aria-label', 'Pukul (F)');
  b.addEventListener('pointerdown', function(e){ e.preventDefault(); b.classList.add('down'); punch(); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(function(t){ b.addEventListener(t, function(){ b.classList.remove('down'); }); });
  b.addEventListener('contextmenu', function(e){ e.preventDefault(); });
  row.appendChild(b); row.appendChild(padmap);
}
function injectCss(){
  if (document.getElementById('cb-css')) return;
  var s = el('style'); s.id = 'cb-css';
  s.textContent =
    '.cb-hp .cb-val{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}' +
    '.cb-heart{width:11px;height:10px;image-rendering:pixelated;flex:none}' +
    '.cb-bar{display:inline-block;width:56px;height:9px;background:#14101c;box-shadow:0 0 0 2px #000,inset 0 0 0 1px #4a3a52;position:relative;flex:none;overflow:hidden}' +
    '.cb-bar b{display:block;height:100%;width:100%;background:#58d468;transition:width .25s steps(6)}' +
    '.cb-bar::after{content:"";position:absolute;inset:0;background:repeating-linear-gradient(90deg,transparent 0 5px,rgba(0,0,0,.28) 5px 6px)}' +
    '.cb-num{min-width:3ch;text-align:right}' +
    '.cb-hp.hit .cb-bar{box-shadow:0 0 0 2px #e8504a,inset 0 0 0 1px #e8504a}' +
    '.cb-hp.low .cb-num{color:#ff8a7a}' +
    '@media (max-width:560px){.cb-bar{width:44px}.cb-hp{flex:0 0 auto}}' +
    '@media (max-width:380px){.cb-bar{width:36px}.cb-num{min-width:0}}' +
    '@media (orientation:landscape) and (max-height:500px){.cb-bar{width:44px}}' +
    '#cbfade{position:absolute;inset:0;background:#000;opacity:0;pointer-events:none;z-index:2}#dlg{z-index:3}#map{z-index:4}' +
    '.abtop{display:flex;align-items:center;gap:8px}' +
    '#btnF{width:40px;height:40px;border-radius:50%;border:0;color:#fff;background:#b0561a;font-size:12px;touch-action:none;box-shadow:0 0 0 3px #000,inset 0 3px 0 rgba(255,255,255,.25),inset 0 -4px 0 rgba(0,0,0,.3)}' +
    '#btnF:active,#btnF.down{background:#d8742c;transform:translateY(2px)}' +
    '@media (orientation:landscape) and (max-height:500px){#btnF{width:34px;height:34px;font-size:10px}}' +
    '@keyframes cbshk{0%{translate:0 0}25%{translate:2px 0}50%{translate:-2px 1px}75%{translate:1px -1px}100%{translate:0 0}}' +
    '.bub.shk{animation:cbshk .18s steps(4) infinite;border-color:#a8281e}' +
    '@media (prefers-reduced-motion:reduce){.bub.shk{animation:none}}';
  document.head.appendChild(s);
}
function patchHelp(){
  var h = document.querySelector('.help');
  if (h && !h.querySelector('.cb-help')){
    var sp = el('span', 'cb-help'); sp.innerHTML = ' &middot; <kbd>F</kbd> pukul';
    h.appendChild(sp);
  }
}

/* ---------------------------------------------------------------- makanan */
var FOOD = { roti:15, apel:10, susu:12, kue:25, permen:5 };
var FOOD_MSG = { roti:'Kamu makan roti. Kenyang!', apel:'Apelnya renyah dan manis.', susu:'Segar! Susunya habis diminum.', kue:'Kue yang lezat. Enak banget!', permen:'Manis... permennya cepat habis.' };
function hookFood(){
  var items = GT.ITEMS || {};
  Object.keys(FOOD).forEach(function(id){
    if (!items[id]) return;
    items[id].use = function(){
      if (pko) return 'keep';
      if (pHp >= P_MAX){ GT.toast('HP-mu sudah penuh.'); return 'keep'; }
      var b = pHp; heal('player', FOOD[id]);
      GT.toast(FOOD_MSG[id] + ' HP +' + Math.round(pHp - b));
      return true;
    };
  });
}

/* ---------------------------------------------------------------- hooks */
function onInteract(ctx){
  var n = ctx && ctx.npc; if (!n) return false;
  if (n._ko > 0){ GT.dialog(['(' + n.name + ' pingsan. zZz...)'], '', null); return true; }
  if (n._cb && (ctx.mode === 'talk' || ctx.mode === 'message')){
    GT.dialog([n._cb.mode === 'fight' ? 'Menjauh dariku!' : 'Jangan pukul aku lagi!'], n.name, null);
    return true;
  }
  return false;
}
function onKey(e){
  if (e.code !== 'KeyF') return false;
  if (e.repeat) return GT.isUiOpen() ? false : true;
  if (GT.isUiOpen()) return false;
  punch();
  return true;
}
function reset(){
  parts.length = 0; cbs.clear(); vis.clear(); damaged.clear(); lastHitBy.clear();
  lastTotal = null; regenAcc = 0;
}
var exposed = false;
function expose(){
  if (exposed || !window.__game) return;
  exposed = true;
  window.__game.combat = GT.combat;
}

GT.combat = {
  hp:hp, maxHp:maxHp, hit:hit, heal:heal, isKO:isKO, setHp:setHp, fx:fx, threat:threat, temperament:temperament, punch:punch,
  state:function(){ return { hp:pHp, ko:!!pko, phase:pko ? pko.phase : null, cbs:cbs.size, parts:parts.length, now:now }; },
  _parts:function(){ return parts.length; }
};

GT.register({
  id:'combat',
  init:function(){
    load(); injectCss(); buildHud(); buildPad(); patchHelp(); hookFood();
    GT.charDraw = charDraw;
    window.addEventListener('pagehide', persistNow);
    window.addEventListener('beforeunload', persistNow);
    updateHud();
  },
  onWorld:function(){ reset(); expose(); },
  onSceneEnter:function(){ expose(); },
  onFrame:function(dt){ expose(); tick(dt); },
  onDraw:onDraw,
  onInteract:onInteract,
  onKey:onKey
});
})();

