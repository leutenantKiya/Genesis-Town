/* thief.js - Maling: bongkar kunci rumah, curi isi peti, reputasi. Warga: peti sendiri = penyimpanan.
 * Public: GT.thief = {pickLock(door), startPicking(door), steal(house), openStorage(), witnessed(door),
 *   press(), minigame(), stolenToday(house), storage(), _setRng(fn), _force(seq|null)}
 * _force: null (real marker) | true | false | [true,false,...] (queue; empty queue falls back to real marker).
 */
(function(){
if (!window.GT_FLAGS || !window.GT_FLAGS.thief) return; // feature flag: off in the submission build (js/flags.js)
'use strict';
if (!window.GT) return;
var GT = window.GT;

var rng = Math.random;
var forced = null;          // null | bool | array
var cur = null;             // active minigame
var stolen = {};            // houseKey -> day
var chest = {};             // itemId -> count (own-chest storage)
var stolenSeed = null;
var LS = 'gt.thief.v1';
var REDUCE = false;
try { REDUCE = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch(e){}

var LOOT = ['roti','apel','susu','bunga','kue','permen'];
var PINS = 3, MAX_STRIKES = 3;

function rint(a, b){ return a + Math.floor(rng() * (b - a + 1)); }
function el(tag, cls, text){ var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

/* ---------- persistence (best effort) ---------- */
function load(){
  try {
    var d = JSON.parse(window.localStorage.getItem(LS) || 'null');
    if (d && typeof d === 'object'){
      if (d.chest && typeof d.chest === 'object'){
        Object.keys(d.chest).forEach(function(k){
          var n = Math.floor(+d.chest[k]);
          if (GT.ITEMS[k] && isFinite(n) && n > 0) chest[k] = n;
        });
      }
      if (d.stolen && typeof d.stolen === 'object' && d.seed != null){
        stolenSeed = d.seed;
        Object.keys(d.stolen).forEach(function(k){ var v = Math.floor(+d.stolen[k]); if (isFinite(v)) stolen[k] = v; });
      }
    }
  } catch(e){}
}
function persist(){
  try { window.localStorage.setItem(LS, JSON.stringify({ chest:chest, stolen:stolen, seed:GT.seed })); } catch(e){}
}
function checkSeed(){
  var s = GT.seed;
  if (stolenSeed !== s){ stolenSeed = s; stolen = {}; }
}

/* ---------- css ---------- */
function css(){
  if (document.getElementById('thf-css')) return;
  var s = document.createElement('style'); s.id = 'thf-css';
  s.textContent =
    '.thf-bar{position:relative;height:34px;margin:8px 0;border:3px solid var(--paper-ink);border-radius:4px;background:#d9d5bb;overflow:hidden;touch-action:manipulation}' +
    '.thf-zone{position:absolute;top:0;bottom:0;background:var(--good);opacity:.85}' +
    '.thf-mark{position:absolute;top:-2px;bottom:-2px;width:6px;margin-left:-3px;background:var(--btn);border:1px solid #fff;border-radius:1px}' +
    '.thf-row{display:flex;gap:6px;align-items:center;margin:4px 0;flex-wrap:wrap}' +
    '.thf-dot{width:14px;height:14px;border:2px solid var(--paper-ink);border-radius:50%;background:#fff;display:inline-block}' +
    '.thf-dot.ok{background:var(--good)}.thf-dot.bad{background:var(--bad)}' +
    '.thf-msg{min-height:2.6em;color:#4a4d75}.thf-msg.ok{color:var(--good)}.thf-msg.bad{color:var(--bad)}' +
    '.thf-big{width:100%;min-height:52px;font-size:11px}';
  document.head.appendChild(s);
}

/* ---------- risk ---------- */
function doorFront(b){ return { x:b.dx, y:b.dy + 1 }; }
function witnessed(door){
  if (!door) return false;
  if (door.hasNpc) return true;
  var sc = GT.outScene, f = doorFront(door), hit = false;
  if (!sc || !sc.npcs) return false;
  sc.npcs.forEach(function(n){
    if (n.hidden) return;
    if (Math.abs(n.x - f.x) + Math.abs(n.y - f.y) <= 3) hit = true;
  });
  return hit;
}
function isNight(){
  try {
    if (typeof GT.isNight === 'function') return !!GT.isNight();
    if (GT.time && typeof GT.time.night === 'boolean') return GT.time.night;
    var h = GT.time && GT.time.h;
    return h >= 19 || h < 6;
  } catch(e){ return false; }
}
function lampNear(f){
  try { return typeof GT.lampNear === 'function' ? !!GT.lampNear(f.x, f.y, 4) : false; } catch(e){ return false; }
}
function policeSees(f){
  try { return !!(GT.police && typeof GT.police.sees === 'function' && GT.police.sees(f.x, f.y)); } catch(e){ return false; }
}
/* conditions(door) -> {night, dark, lampNear, policeSees} */
function conditions(door){
  var f = door ? doorFront(door) : { x:0, y:0 };
  var night = isNight(), lamp = door ? lampNear(f) : false;
  return { night:night, dark:night && !lamp, lampNear:lamp, policeSees:door ? policeSees(f) : false };
}
function sfx(n){ try { window.GT_SFX && GT_SFX.play(n); } catch(e){} }
function caught(){
  sfx('hurt');
  var amt = Math.min(50, GT.state.coins);
  if (amt > 0) GT.spendCoins(amt);
  GT.addReputation(-10);
  GT.toast('Ketahuan! Denda ' + amt + ' koin, reputasi turun.');
  return amt;
}

/* ---------- minigame ---------- */
function whenFree(fn, tries){
  tries = tries == null ? 100 : tries;
  if (!GT.isUiOpen() || tries <= 0) { fn(); return; }
  setTimeout(function(){ whenFree(fn, tries - 1); }, 30);
}
function tri(u){ u = u - Math.floor(u); return 1 - Math.abs(2 * u - 1); }

function startPicking(door){
  if (cur) return null;
  css();
  var cond = conditions(door);
  var g = { cond:cond, door:door, pin:0, strikes:0, done:false, zone:0, zw:0.2, t0:0, period:1.7, last:0, raf:0, handle:null };
  cur = g;
  var body = el('div');
  body.appendChild(el('p', 'mnote', 'Tekan Cungkil (A / Spasi / E) saat penanda ada di zona hijau. Pasang ' + PINS + ' pin sebelum ' + MAX_STRIKES + ' kali meleset.'));
  var hint = el('p', 'mnote thf-hint', cond.dark ? 'Gelap \u2014 kamu lebih leluasa' : (cond.night ? 'Terang \u2014 hati-hati' : 'Siang hari'));
  hint.setAttribute('data-cond', cond.dark ? 'dark' : (cond.night ? 'lit' : 'day'));
  body.appendChild(hint);
  var bar = el('div', 'thf-bar'), zone = el('div', 'thf-zone'), mark = el('div', 'thf-mark');
  bar.appendChild(zone); bar.appendChild(mark); body.appendChild(bar);
  var rowP = el('div', 'thf-row'), rowS = el('div', 'thf-row');
  rowP.appendChild(el('span', null, 'Pin'));
  rowS.appendChild(el('span', null, 'Meleset'));
  var pd = [], sd = [], i;
  for (i = 0; i < PINS; i++){ var d = el('span', 'thf-dot'); pd.push(d); rowP.appendChild(d); }
  for (i = 0; i < MAX_STRIKES; i++){ var d2 = el('span', 'thf-dot'); sd.push(d2); rowS.appendChild(d2); }
  body.appendChild(rowP); body.appendChild(rowS);
  var msg = el('p', 'thf-msg'); msg.setAttribute('role', 'status'); msg.setAttribute('aria-live', 'polite');
  body.appendChild(msg);
  var big = el('button', 'mbtn primary thf-big', 'Cungkil'); big.type = 'button';
  big.setAttribute('data-autofocus', '');
  body.appendChild(big);

  function newPin(){
    g.zw = (Math.max(0.1, 0.2 - g.pin * 0.03) + (REDUCE ? 0.07 : 0)) * (cond.dark ? 1.4 : 1);
    var lo = g.zw / 2 + 0.04, hi = 1 - g.zw / 2 - 0.04;
    g.zone = lo + rng() * (hi - lo);
    g.period = (2.4 - g.pin * 0.3) * (REDUCE ? 2 : 1) * (cond.dark ? 1 / 0.7 : 1);
    g.t0 = performance.now();
    zone.style.left = ((g.zone - g.zw / 2) * 100) + '%';
    zone.style.width = (g.zw * 100) + '%';
  }
  function pos(){ return tri((performance.now() - g.t0) / 1000 / g.period); }
  g.pos = pos;
  function paint(){
    if (g.done) return;
    mark.style.left = (pos() * 100) + '%';
    g.raf = requestAnimationFrame(paint);
  }
  function dots(){
    pd.forEach(function(d, k){ d.className = 'thf-dot' + (k < g.pin ? ' ok' : ''); });
    sd.forEach(function(d, k){ d.className = 'thf-dot' + (k < g.strikes ? ' bad' : ''); });
  }
  function finish(ok){
    if (g.done) return;
    g.done = true; cancelAnimationFrame(g.raf);
    var door2 = g.door;
    if (g.handle) g.handle.close('done');
    cur = null;
    if (ok){
      sfx('door'); GT.toast('Klik! Kunci terbuka.');
      whenFree(function(){ GT.enterBuilding(door2); });
    } else {
      sfx('error');
      var broke = rng() < 0.5;
      if (broke){ GT.removeItem('obeng', 1); GT.toast('Gagal membongkar. Obengmu patah!'); }
      else GT.toast('Gagal membongkar, tapi obengmu masih utuh.');
    }
  }
  g.press = function(){
    if (g.done) return null;
    var hit;
    if (Array.isArray(forced) && forced.length) hit = !!forced.shift();
    else if (typeof forced === 'boolean') hit = forced;
    else hit = Math.abs(pos() - g.zone) <= g.zw / 2;
    if (hit){
      g.pin++; sfx('ui_click');
      msg.className = 'thf-msg ok'; msg.textContent = 'Pas! Pin ' + g.pin + ' terpasang.';
      dots();
      if (g.pin >= PINS){ finish(true); return true; }
      newPin();
    } else {
      g.strikes++; sfx('error');
      msg.className = 'thf-msg bad'; msg.textContent = 'Meleset! (' + g.strikes + '/' + MAX_STRIKES + ')';
      dots();
      if (g.strikes >= MAX_STRIKES){ finish(false); return false; }
      g.t0 = performance.now();
    }
    return hit;
  };
  function guarded(){
    var n = performance.now();
    if (n - g.last < 220) return;
    g.last = n;
    g.press();
  }
  big.addEventListener('click', guarded);
  g.handle = GT.modal({
    title: 'Bongkar kunci', body: body,
    actions: [{ label:'Batal', close:true }],
    onKey: function(e){
      if (e.repeat) { if (/^(Space|Enter|KeyE|KeyA|KeyZ)$/.test(e.code)) return true; return false; }
      if (/^(Space|Enter|KeyE|KeyA|KeyZ)$/.test(e.code)){ guarded(); return true; }
      return false;
    },
    onClose: function(){
      if (!g.done){ g.done = true; cancelAnimationFrame(g.raf); cur = null; }
    }
  });
  newPin(); dots();
  msg.textContent = 'Siap...';
  if (REDUCE) mark.style.transition = 'none';
  g.raf = requestAnimationFrame(paint);
  return g;
}

/* attempt flow: item check -> witness roll -> minigame */
function pickLock(door){
  if (!door) return false;
  if (GT.state.role !== 'maling'){ GT.toast('Hanya maling yang bisa membongkar kunci.'); return false; }
  if (!GT.hasItem('obeng')){ GT.toast('Kamu butuh obeng. Beli di mart.'); return false; }
  var cond = conditions(door);
  if (cond.policeSees && rng() < 0.7){
    if (GT.police && typeof GT.police.arrest === 'function') GT.police.arrest('pick');
    else caught();
    return 'caught';
  }
  var wary = 0;
  try { wary = GT.gossip && GT.gossip.wary && GT.gossip.wary() ? 0.10 : 0; } catch(e){}
  if (witnessed(door) && rng() < (cond.dark ? 0.10 : 0.35) + wary){ caught(); return 'caught'; }
  return startPicking(door) ? 'started' : false;
}

/* ---------- chest ---------- */
function houseKey(h){ return 'h' + (h && h.id != null ? h.id : '?'); }
function stolenToday(h){ checkSeed(); return stolen[houseKey(h)] === GT.time.day; }
function steal(house){
  if (!house) return false;
  if (GT.state.role !== 'maling') return false;
  checkSeed();
  var k = houseKey(house), day = GT.time.day;
  if (stolen[k] === day){
    GT.dialog(['Peti ini sudah kamu kuras hari ini.', 'Coba lagi besok.'], '');
    return true;
  }
  stolen[k] = day; persist();
  var coins = rint(15, 60);
  if (conditions(house).dark) coins = Math.floor(coins * 1.5);
  var lines = ['Kamu membuka peti diam-diam...'], txt = 'Kamu dapat ' + coins + ' koin';
  GT.addCoins(coins); sfx('coin');
  if (rng() < 0.4){
    var it = LOOT[Math.floor(rng() * LOOT.length)];
    GT.addItem(it, 1);
    txt += ' dan 1 ' + GT.itemName(it);
  }
  lines.push(txt + '.');
  GT.dialog(lines, '');
  // v2.4: dilihat saksi (penghuni di dalam) -> gosip bernama; tidak dilihat -> gosip anonim; polisi melihat -> buronan
  try {
    var wit = null, sc = GT.scene;
    if (sc && sc.npcs) sc.npcs.forEach(function(n){ if (!wit && !n.hidden && !n.isPolice) wit = n; });
    if (GT.gossip && GT.gossip.onTheft) GT.gossip.onTheft(house, wit);
    if (policeSees(doorFront(house)) && GT.police && GT.police.setWanted) GT.police.setWanted('theft', house.owner);
  } catch(e){ console.error('[thief]', e); }
  return { coins:coins };
}

/* own chest = storage */
function openStorage(){
  css();
  var body = el('div'), h;
  function row(id, n, label, onClick){
    var r = el('div', 'mrow');
    try { r.appendChild(GT.iconEl(GT.ITEMS[id].icon || id, 16)); } catch(e){}
    r.appendChild(el('span', 'grow', GT.itemName(id)));
    r.appendChild(el('span', 'num', 'x' + n));
    var b = el('button', 'mbtn', label); b.type = 'button'; b.addEventListener('click', onClick);
    r.appendChild(b);
    return r;
  }
  function render(){
    body.textContent = '';
    var inv = GT.state.inventory, any = false;
    body.appendChild(el('p', null, 'Tas kamu'));
    Object.keys(inv).forEach(function(id){
      if (!(inv[id] > 0) || !GT.ITEMS[id]) return;
      any = true;
      body.appendChild(row(id, inv[id], 'Simpan', function(){ if (GT.removeItem(id, 1)){ chest[id] = (chest[id] || 0) + 1; persist(); render(); } }));
    });
    if (!any) body.appendChild(el('p', 'mnote', '(kosong)'));
    body.appendChild(el('p', null, 'Isi peti'));
    any = false;
    Object.keys(chest).forEach(function(id){
      if (!(chest[id] > 0) || !GT.ITEMS[id]) return;
      any = true;
      body.appendChild(row(id, chest[id], 'Ambil', function(){
        if (chest[id] > 0){ chest[id]--; if (chest[id] <= 0) delete chest[id]; GT.addItem(id, 1); persist(); render(); }
      }));
    });
    if (!any) body.appendChild(el('p', 'mnote', '(kosong)'));
  }
  render();
  h = GT.modal({ title:'Peti penyimpanan', body:body, actions:[{ label:'Tutup', close:true }] });
  return h;
}

/* ---------- interaction hooks ---------- */
function isDealer(npc){ return !!npc && (npc.key === 'casino:dealer' || npc.name === 'Bandar'); }
var DISTRUST = -30;
function isWorkerNpc(npc){ var k = GT.npcKey(npc); return /:keeper$/.test(k) || k === 'casino:dealer'; }

function onInteract(ctx){
  if (!ctx) return false;
  // reputation gate
  if (ctx.npc && (ctx.mode === 'talk' || ctx.mode === 'message') && GT.state.reputation < DISTRUST && !ctx.npc.isPlayer && !ctx.npc.isPolice && !ctx.npc.isBot && !isDealer(ctx.npc) && !isWorkerNpc(ctx.npc)){
    GT.dialog(['Aku tidak percaya kamu.'], ctx.npc.name, ctx.npc);
    return true;
  }
  // locked door
  if (ctx.door && ctx.locked && (ctx.mode === 'bump' || ctx.mode === 'talk') && GT.state.role === 'maling'){
    var door = ctx.door;
    GT.menu('Pintu terkunci', [
      { label:'Bongkar kunci (butuh obeng)', onPick:function(){ pickLock(door); } },
      { label:'Pergi' }
    ]);
    return true;
  }
  // chests
  if (ctx.tileType === 'chest' && ctx.mode === 'talk' && ctx.scene && ctx.scene.kind === 'house' && ctx.scene.house){
    var h = ctx.scene.house;
    if (h.own){ openStorage(); return true; }
    if (GT.state.role === 'maling'){ steal(h); return true; }
  }
  return false;
}

GT.thief = {
  pickLock: pickLock,
  startPicking: startPicking,
  steal: steal,
  openStorage: openStorage,
  witnessed: witnessed,
  conditions: conditions,
  stolenToday: stolenToday,
  caught: caught,
  press: function(){ return cur ? cur.press() : null; },
  minigame: function(){ return cur; },
  storage: function(){ return chest; },
  _setRng: function(fn){ rng = typeof fn === 'function' ? fn : Math.random; },
  _force: function(v){ forced = Array.isArray(v) ? v.slice() : (v == null ? null : !!v); }
};

GT.register({ id:'thief', init:function(){ load(); }, onInteract:onInteract });
})();

