/*
 * Genesis Town v2 engine.  Mods talk to the engine ONLY through window.GT (defined synchronously, boot is deferred
 * until DOMContentLoaded / next tick so every GT.register() has run).  Contract notes beyond SPEC2.md:
 *
 *  GT.register(mod)       mod = {id, init(GT), onWorld(world), onSceneEnter(scene), onFrame(dt), onInteract(ctx)->bool, onKey(e)->bool}
 *                         onInteract ctx = {mode:'talk'|'message'|'bump', scene, tile:{x,y}, tileType, npc|null, door|null, building|null, locked:bool}
 *                           mode 'talk' = A / Space / Enter / Z, 'message' = E, 'bump' = walking into a locked door.
 *                           tileType is the faced tile ('door' for door tiles, 'npc' is NOT used: look at ctx.npc).
 *                           For casino dice_table the dealer is ctx.npc; for the mart counter the keeper is ctx.npc.
 *                         onKey(e) is only called while no modal is open; return true to swallow the key.
 *                         mod.onMinimap(g, C) runs on the map sheet (M) after the player marker: g = its 2D context, C = canvas pixels per tile (2).
 *                         v2.3 draw hooks: mod.onDraw(ctx, camX, camY, T) runs after the world + night overlay; GT.charDraw = fn(ctx, npc|null(player), x, y, pal, dir, step)
 *                         -> true if it drew the character itself (combat.js: flash / KO pose). npc.bubble.shake = true shakes the speech bubble.
 *                         mod.onDrawGround(ctx, camX, camY, T): on the ground, under characters, lit like the ground (crops, ripples).
 *                         mod.onDrawMarks(ctx, camX, camY, T): same place, for markers the player must always see (the hoe's squares):
 *                         in 2.5D they sit on an unlit sheet, so night, rain and the sun's shading never dim them. Return true when it drew.
 *                         mod.onPlayerDir(dir): the player pressed a direction (keys, joystick, D-pad), not a mod's GT.walkDir.
 *  GT.modal(opts)         {title, body:Element|string(plain text, \n = new paragraph), actions:[{label,primary,id,disabled,onClick(handle,ev),close}],
 *                          wide, closable:false (no X/Esc), sticky:true (a click on the dark backdrop does not close it), onClose(reason), onKey(e)->bool (called for keydown while on top)}
 *                         Clicking an action runs onClick and does NOT close the modal unless the action has no onClick, has close:true,
 *                         or onClick returns true.  handle = {close(reason), el, box, body, setBody(x), setTitle(t), setActions(list), btn(id), isOpen()}.
 *                         Esc / X close with reason 'esc' / 'x'.  A click on the dark backdrop closes it (reason 'backdrop') unless sticky:true or closable:false.  close() is idempotent.
 *  GT.menu(title, opts)   modal list; picking an option closes the menu FIRST, then calls onPick (so it can open another modal). Digits 1-9 pick. An option is {label, onPick, disabled?, icon?} (icon: an emoji shown before the words).
 *  Extra helpers          GT.addHudButton({id,label,key,onClick,secondary}), GT.hotkey(key,fn), GT.addNpc(sceneRef,def), GT.removeNpc(npc),
 *                         GT.moveNpc(npc,sceneRef,x,y), GT.npcHide(npc,bool), GT.npcTeleport(npc,x,y,dir), GT.findNpc(key), GT.getScene(ref),
 *                         GT.doorFront(b), GT.getAffinity(npc), GT.setAffinity(npc,v), GT.addAffinity(npc,d), GT.iconEl(id,size),
 *                         GT.openShop(), GT.openBag(), GT.openProfile(), GT.time, GT.isQA, GT.engageNpc(npc).
 *  findPath(scene,from,to) returns the tiles AFTER `from` up to and including `to` ([] when equal, null when unreachable); scene may be null (current),
 *                         'out', a scene object, or a building. Ignores actors.
 *  npc fields mods may set: npc.label (small tag above head), npc.remote, npc.hidden (use GT.npcHide).
 */
(function(){
'use strict';
var T = (window.SPRITES && SPRITES.TILE) || 12;
var WT = 60, HT = 60, BS = 6, NB = 10;
var DIRS = {up:[0,-1], down:[0,1], left:[-1,0], right:[1,0]};
var OPP = {up:'down', down:'up', left:'right', right:'left'};
var DIRLIST = ['up','down','left','right'];
var SOLID = new Set(['void','fountain','stage','carousel','lily','tree','fence','sign','mailbox','rock','water','wall','bed','table','tv','plant','counter','fridge','bookshelf','shelf','chair','card_table','slot','chest','dice_table','lamp','bush','barrel','crate','stall']);
// furniture of the room interiors added with the Kingshot-style buildings (art registered by regRoomTiles below)
['ore_rock','lb_wall','news_board','roulette','rack','pew','sack','crate_i','barrel_i','tank','display','log','stove'].forEach(function(t){ SOLID.add(t); });
var ANIMATED = {water:1, flower:1};
var MOVE_T = 0.15, NPC_T = 0.26, NPC_FAST = 0.18, TURN_T = 0.09, CPS = 48;
var REDUCE = false;
try { REDUCE = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch(e){}

/* ---------- QA mode (skips first-boot modal, regen confirm and auto-opened shop; never needed by players) ---------- */
function qaMode(){
  if (window.GT_QA === false) return false;
  if (window.GT_QA === true) return true;
  try { if (/(^|[#&,;])qa($|[&,;=])/.test(String(location.hash).replace(/^#/, '#'))) return true; } catch(e){}
  try { if (navigator.webdriver) return true; } catch(e){}
  return false;
}
var QA = false;

/* ---------- data pools ---------- */
var EN = window.GT_LANG === 'en'; // villager names follow the language; both lists have the same length so the seeded village stays deterministic
var FIRST = EN ? ['Emma','Noah','Olivia','Liam','Ava','Lucas','Mia','Ethan','Chloe','Owen','Grace','Leo','Zoe','Henry','Ruby','Oscar','Ivy','Felix','Nora','Theo','Alice','Max','Lily','Sam','Hazel','Eli','Clara','Finn','Maya','Jude','Rose','Ian','Lena','Cole','Faye','Dean','Nina','Kai','Amy','Ross','Tess','Hugo','Vera','Luke'] : ['Budi','Siti','Agus','Dewi','Rina','Joko','Wayan','Putu','Ayu','Bayu','Citra','Dimas','Eko','Fajar','Gita','Hadi','Intan','Kadek','Lestari','Maya','Nanda','Oka','Putri','Rizky','Sari','Tono','Utami','Vina','Wahyu','Yuni','Zaki','Andi','Bimo','Dian','Endah','Farah','Galih','Heru','Indra','Jaya','Kirana','Lina','Mawar','Nugi'];
var LAST = EN ? ['Smith','Baker','Turner','Parker','Hughes','Fisher','Cooper','Mason','Brooks','Warren','Hayes','Foster','Reed','Carter','Bishop','Porter','Webb','Lane','Holt','Wells'] : ['Santoso','Wijaya','Pratama','Hartono','Siregar','Nugroho','Saputra','Kusuma','Hidayat','Lubis','Purnama','Setiawan','Wibowo','Rahman','Susanto','Halim','Utomo','Permata','Firmansyah','Gunawan'];
var PARK = EN ? ['Jasmine','Ylang','Flame Tree','Magnolia','Orchid','Lotus','Rose','Dahlia'] : ['Melati','Kenanga','Flamboyan','Cempaka','Anggrek','Teratai','Mawar','Dahlia'];
var NPC_LINES = [
  $t('Halo! Cuacanya cerah ya hari ini.'),
  $t('Kamu warga baru? Selamat datang di Genesis Town!'),
  $t('Rumah yang bergembok cuma bisa dimasuki kalau kamu diundang.'),
  $t('Katanya ada Mart di dekat sini. Stok mie instannya banyak!'),
  $t('Aku lagi jalan-jalan sore. Kamu juga?'),
  $t('Hati-hati di rumput tinggi. Banyak serangga!'),
  $t('Taman kota itu tempat favoritku buat bersantai.'),
  $t('Setiap kota dibuat ulang, jalanannya berubah lho.'),
  $t('Ada beberapa tetangga yang sudah mengundangmu, coba cari rumah yang tidak bergembok.'),
  $t('Aku lupa mau ke mana tadi... hehe.'),
  $t('Peta ada di tombol M. Praktis banget!'),
  $t('Ada Kasino di kota ini, tapi cuma pakai koin permainan lho.')
];
var HOME_LINES = [
  [$t('Selamat datang di rumahku!'),$t('Anggap saja rumah sendiri ya.')],
  [$t('Eh, ada tamu! Silakan duduk.')],
  [$t('Kamu diundang masuk, jadi jangan sungkan.')],
  [$t('Rumahku kecil, tapi nyaman.')]
];
var MART_LINES = [
  [$t('Selamat datang di Mart Genesis!'),$t('Mau beli apa hari ini?')],
  [$t('Hari ini roti dan susu lagi segar.'),$t('Silakan lihat-lihat dulu!')],
  [$t('Obeng juga ada lho, buat yang butuh.'),$t('Mau beli apa?')],
  [$t('Jangan lupa bawa tas belanja sendiri.'),$t('Mau beli apa?')]
];
var CASINO_LINES = [
  [$t('Selamat datang di Kasino Genesis!'),$t('(Meja belum dibuka: modul kasino belum terpasang.)')]
];
var SIGN_LINES = [
  $t('Dilarang menginjak bunga.'),
  $t('Jaga kebersihan taman ya!'),
  $t('Awas rumput tinggi, banyak serangga.'),
  $t('Bebek dilarang diberi makan roti.')
];

/* ---------- PRNG ---------- */
function mulberry32(a){ return function(){ a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function makeR(seed){
  var f = mulberry32(seed >>> 0);
  var r = {f:f};
  r.int = function(a,b){ return a + Math.floor(f() * (b - a + 1)); };
  r.pick = function(arr){ return arr[Math.floor(f() * arr.length)]; };
  r.chance = function(p){ return f() < p; };
  r.shuffle = function(arr){ for (var i = arr.length - 1; i > 0; i--){ var j = Math.floor(f() * (i + 1)); var t = arr[i]; arr[i] = arr[j]; arr[j] = t; } return arr; };
  return r;
}
function hashStr(s){ s = String(s); var h = 2166136261 >>> 0; for (var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function randomSeed(){ return (Math.random() * 4294967296) >>> 0; }
function pickRand(arr){ return arr[Math.floor(Math.random() * arr.length)]; }
function el(tag, cls, text){ var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

/* ---------- tile / sprite fallbacks (art is developed in parallel) ---------- */
var tileOk = {};
var FB_COL = {card_table:['#2d7a3e','#1b5128'], slot:['#8a8fa8','#c0392b'], chest:['#8a5a2b','#f2c94c'], carpet_red:['#9c2f40','#7d2433'], floor_dark:['#3a3550','#2d2940'], dice_table:['#2d7a3e','#f4f1dc']};
function tileSupported(t){
  if (t in tileOk) return tileOk[t];
  var ok = true;
  try {
    if (window.SPRITES && SPRITES._tileTypes && SPRITES._tileTypes.indexOf(t) >= 0) ok = true;
    else {
      var c = document.createElement('canvas'); c.width = c.height = T;
      var g = c.getContext('2d', {willReadFrequently:true});
      SPRITES.drawTile(g, t, 0, 0, 0);
      var d = g.getImageData(5, 5, 1, 1).data;
      ok = !(d[0] === 255 && d[1] === 0 && d[2] === 255);
    }
  } catch(e){ ok = false; }
  tileOk[t] = ok; return ok;
}
function fbTile(g, t, x, y){
  var c = FB_COL[t] || ['#ff00ff','#ff00ff'];
  g.fillStyle = c[0]; g.fillRect(x, y, T, T);
  if (t === 'carpet_red' || t === 'floor_dark') return;
  g.fillStyle = c[1]; g.fillRect(x + 2, y + 2, T - 4, T - 4);
}
function drawTileSafe(g, t, x, y, f){
  if (t === 'lamp' && !tileSupported('lamp')) fbLamp(g, x, y);
  else if (FB_COL[t] && !tileSupported(t)) fbTile(g, t, x, y); else SPRITES.drawTile(g, t, x, y, f);
}
function fbLamp(g, x, y){   // simple stand-in street lamp when sprites.js has no 'lamp' tile
  SPRITES.drawTile(g, 'grass', x, y, 0);
  g.fillStyle = '#1c1a24'; g.fillRect(x + 4, y, 4, 4); g.fillRect(x + 5, y + 4, 2, 7); g.fillRect(x + 3, y + 10, 6, 2);
  g.fillStyle = '#f8d838'; g.fillRect(x + 5, y + 1, 2, 2);
  g.fillStyle = '#8a8c9c'; g.fillRect(x + 5, y + 5, 1, 5);
}
// sitting on a chair indoors (client-only, draw-only): the player stays on the walkable tile beside the chair for the
// server and every mod; only the drawing puts the character on the chair. Any movement, a talk key or a scene change stands up.
var sitSpot = null; // {x, y, dir, scene} the chair tile and the way the character faces
function sitDown(cx, cy){
  var m = scene.map, dir = 'down', hit = false;
  [['up', 0, -1], ['left', -1, 0], ['right', 1, 0], ['down', 0, 1]].forEach(function(q){
    if (hit) return;
    var tt = inb(m, cx + q[1], cy + q[2]) ? m.tiles[(cy + q[2])*m.w + cx + q[1]] : '';
    if (tt === 'table' || tt === 'card_table' || tt === 'dice_table'){ dir = q[0]; hit = true; }
  });
  sitSpot = { x:cx, y:cy, dir:dir, scene:scene };
  P.dir = dir;
}
function selfPos(){ return sitSpot ? { px:sitSpot.x * T, py:sitSpot.y * T } : lerpPos(P); }
function drawChar(g, x, y, pal, dir, step){
  if (SPRITES.charShadow && scene && scene.kind === 'out') SPRITES.charShadow(g, x, y);
  // sitting: standing still on a bench (the public square, village v2) sets the sprite down on the seat, facing out
  if (!step && scene){
    var m = scene.map, tx = Math.round((x + camX) / T), ty = Math.round((y + camY) / T), st = inb(m, tx, ty) ? m.tiles[ty*m.w + tx] : '';
    if (scene.kind === 'out' && st === 'bench'){ y -= 3; dir = 'down'; step = 'sit'; }
    else if (st === 'chair' && sitSpot && sitSpot.x === tx && sitSpot.y === ty){ y -= 3; dir = sitSpot.dir; step = 'sit'; }
  }
  try { SPRITES.drawCharacter(g, x, y, pal, dir, step); }
  catch(e){ SPRITES.drawCharacter(g, x, y, (pal | 0) % 6, dir, step); }
}

/* ---------- GT state / events ---------- */
var ITEMS = {
  roti:   {name:$t('Roti'),   price:10, icon:'roti'},
  apel:   {name:$t('Apel'),   price:8,  icon:'apel'},
  susu:   {name:$t('Susu'),   price:12, icon:'susu'},
  bunga:  {name:$t('Bunga'),  price:15, icon:'bunga'},
  kue:    {name:$t('Kue'),    price:25, icon:'kue'},
  obeng:  {name:$t('Obeng'),  price:60, icon:'obeng'},
  permen: {name:$t('Permen'), price:3,  icon:'permen'}
};
var SHOP_CORE = ['roti','apel','susu','bunga','kue','permen','obeng'];
var CONSUMABLE = {roti:$t('Kamu makan roti. Kenyang!'), apel:$t('Apelnya renyah dan manis.'), susu:$t('Segar! Susunya habis diminum.'), kue:$t('Kue yang lezat. Enak banget!'), permen:$t('Manis... permennya cepat habis.')};
var state = { coins:500, inventory:{}, role:'warga', reputation:0, affinity:{}, clan:null, playerName:$t('Kamu'), onboarded:false };
var LS_KEY = 'gt.v2';
var listeners = {};
function on(evt, fn){ (listeners[evt] = listeners[evt] || []).push(fn); return function(){ off(evt, fn); }; }
function off(evt, fn){ var a = listeners[evt]; if (!a) return; var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
function emit(evt, data){
  var a = listeners[evt]; if (!a) return;
  a.slice().forEach(function(fn){ try { fn(data); } catch(e){ console.error('[GT] listener error for ' + evt, e); } });
}
var saveTimer = 0, savedSeed = null;
function lsRead(){ try { var s = window.localStorage.getItem(LS_KEY); return s ? JSON.parse(s) : null; } catch(e){ return null; } }
function save(){
  if (saveTimer) return;
  saveTimer = setTimeout(saveNow, 150);
}
function saveNow(){
  saveTimer = 0;
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify({ v:2, coins:state.coins, inventory:state.inventory, role:state.role, playerName:state.playerName,
      affinity:state.affinity, reputation:state.reputation, clan:state.clan, onboarded:state.onboarded, seed:seed, gameMin:gameMin,
      dayLength:dayLength, timePaused:timePaused, devEnabled:devEnabled }));
  } catch(e){}
}
function num(v, lo, hi, dflt){ v = +v; if (!isFinite(v)) return dflt; return Math.max(lo, Math.min(hi, v)); }
function loadSaved(){
  var d = lsRead();
  if (!d || typeof d !== 'object') return;
  try {
    if (d.coins != null) state.coins = Math.floor(num(d.coins, 0, 1e9, 500));
    if (d.inventory && typeof d.inventory === 'object'){
      Object.keys(d.inventory).slice(0, 60).forEach(function(k){
        var c = Math.floor(num(d.inventory[k], 0, 99999, 0)); if (c > 0 && k.length <= 24) state.inventory[k] = c;
      });
    }
    if (d.role === 'warga' || d.role === 'maling') state.role = d.role;
    if (typeof d.playerName === 'string' && d.playerName.trim()) state.playerName = d.playerName.trim().slice(0, 16);
    if (d.affinity && typeof d.affinity === 'object'){
      Object.keys(d.affinity).slice(0, 400).forEach(function(k){ state.affinity[k] = Math.round(num(d.affinity[k], 0, 100, 40)); });
    }
    state.reputation = Math.round(num(d.reputation, -1000, 1000, 0));
    if (d.clan && typeof d.clan === 'object' && typeof d.clan.id === 'string') state.clan = {id:String(d.clan.id).slice(0, 40), name:String(d.clan.name || '').slice(0, 24), tag:String(d.clan.tag || '').slice(0, 4)};
    state.onboarded = !!d.onboarded;
    if (d.seed != null && isFinite(+d.seed)) savedSeed = (+d.seed) >>> 0;
    if (d.gameMin != null && isFinite(+d.gameMin)) gameMin = num(d.gameMin, 0, 1e8, gameMin);
    if (d.dayLength != null && isFinite(+d.dayLength)) dayLength = num(d.dayLength, 1, 60, 10);
    if (d.timePaused === true) timePaused = true;
    if (d.devEnabled === true) devEnabled = true;
  } catch(e){}
}
function addCoins(n){
  n = Math.floor(+n); if (!isFinite(n) || n === 0) return state.coins;
  state.coins = Math.max(0, Math.min(1e9, state.coins + n));
  emit('coins', {coins:state.coins, delta:n}); hudDirty = true; save();
  return state.coins;
}
function spendCoins(n){
  n = Math.floor(+n); if (!isFinite(n) || n < 0) return false;
  if (state.coins < n) return false;
  if (n === 0) return true;
  state.coins -= n;
  emit('coins', {coins:state.coins, delta:-n}); hudDirty = true; save();
  return true;
}
function addItem(id, n){
  n = n == null ? 1 : Math.floor(+n); if (!id || !isFinite(n) || n <= 0) return false;
  state.inventory[id] = (state.inventory[id] || 0) + n;
  emit('inventory', {id:id, count:state.inventory[id], delta:n}); save(); return true;
}
function removeItem(id, n){
  n = n == null ? 1 : Math.floor(+n); if (!id || !isFinite(n) || n <= 0) return false;
  if ((state.inventory[id] || 0) < n) return false;
  state.inventory[id] -= n; if (state.inventory[id] <= 0) delete state.inventory[id];
  emit('inventory', {id:id, count:state.inventory[id] || 0, delta:-n}); save(); return true;
}
function hasItem(id, n){ n = n == null ? 1 : Math.floor(+n); return (state.inventory[id] || 0) >= n; }
function setRole(r){
  if (r !== 'warga' && r !== 'maling') return;
  var old = state.role; state.role = r; hudDirty = true; save();
  if (old !== r) emit('role', {role:r, old:old});
}
function addRep(d){ state.reputation = Math.round(num(state.reputation + d, -1000, 1000, 0)); save(); hudDirty = true; return state.reputation; }

/* affinity */
function npcKey(n){ return n ? (n.key || ('anon:' + (n.name || '?'))) : ''; }
function defaultAff(n){ return n && n.aff0 != null ? n.aff0 : 40; }
function getAffinity(n){ var k = npcKey(n); return state.affinity[k] != null ? state.affinity[k] : defaultAff(n); }
function setAffinity(n, v){
  var k = npcKey(n), old = getAffinity(n);
  v = Math.round(num(v, 0, 100, old)); state.affinity[k] = v; save();
  if (v !== old) emit('affinity', {key:k, npc:n, value:v, delta:v - old});
  return v;
}
function addAffinity(n, d){ return setAffinity(n, getAffinity(n) + d); }
function hearts(n){ var h = Math.max(0, Math.min(5, Math.floor(getAffinity(n) / 20))); return new Array(h + 1).join('♥') + new Array(5 - h + 1).join('♡'); }

/* ---------- map structure ---------- */
function newMap(w, h, fill, kind){
  return { w:w, h:h, kind:kind, tiles:new Array(w*h).fill(fill), walk:null, blocked:new Set(),
    bld:new Map(), door:new Map(), info:new Map(), exit:new Set(), buildings:[], cache:null };
}
function finalize(m){
  m.walk = new Uint8Array(m.w * m.h);
  for (var i = 0; i < m.tiles.length; i++) m.walk[i] = (SOLID.has(m.tiles[i]) || m.blocked.has(i)) ? 0 : 1;
}
// Art pass 1 (2026-11-01): the outdoor world is cached in layers (see js/art.js): ground variants, a soft noise tint,
// grass lips and water banks, drop shadows, props drawn without their grass base, tree trunks, then buildings.
// Canopies and stall awnings are drawn later in the y-sorted pass (render). Interiors keep the original path.
function valueNoise(seed, x, y){
  function h(ix, iy){ return (hashStr(seed + ':' + ix + ',' + iy) % 1000) / 1000; }
  var x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  var a = h(x0, y0), b = h(x0 + 1, y0), c = h(x0, y0 + 1), d = h(x0 + 1, y0 + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
// per-season noise tint on the grass: [dark rgb, light rgb, dark strength, light strength]
var seasonSet = false;
var NOISE_TINT = { semi: ['20,60,30', '220,240,120', 0.45, 0.28], panas: ['16,64,24', '244,240,96', 0.45, 0.30],
  gugur: ['64,40,12', '240,196,104', 0.45, 0.30], snow: ['120,140,180', '255,255,255', 0.35, 0.4] };
function buildWorldCache(m){
  var Sp = SPRITES, c = document.createElement('canvas');
  c.width = m.w * T; c.height = m.h * T;
  var g = c.getContext('2d'); g.imageSmoothingEnabled = false;
  var x, y, i, t, gt, ground = new Array(m.w * m.h);
  for (y = 0; y < m.h; y++) for (x = 0; x < m.w; x++){
    i = y*m.w + x; t = m.tiles[i]; gt = Sp.groundOf(t) || 'grass'; ground[i] = gt;
    var hv = hashStr(m.seed + ':' + x + ',' + y) % 10;
    Sp.drawGround(g, gt, x*T, y*T, gt === 'grass' ? (hv < 6 ? 0 : hv < 8 ? 1 : hv < 9 ? 2 : 3) : hv & 3);
    if (gt === 'grass'){
      var n = valueNoise(m.seed, x / 5, y / 5) - 0.5;
      var nt = Sp.snow ? NOISE_TINT.snow : NOISE_TINT[Sp.season] || NOISE_TINT.semi;
      g.fillStyle = n < 0 ? 'rgba(' + nt[0] + ',' + (-n * nt[2]).toFixed(3) + ')' : 'rgba(' + nt[1] + ',' + (n * nt[3]).toFixed(3) + ')';
      g.fillRect(x*T, y*T, T, T);
    }
  }
  function gAt(xx, yy){ return (xx < 0 || yy < 0 || xx >= m.w || yy >= m.h) ? 'grass' : ground[yy*m.w + xx]; }
  for (y = 0; y < m.h; y++) for (x = 0; x < m.w; x++){
    gt = ground[y*m.w + x];
    if (gt === 'water') Sp.drawEdges(g, 'water', x*T, y*T, {n:gAt(x, y-1) !== 'water', s:gAt(x, y+1) !== 'water', w:gAt(x-1, y) !== 'water', e:gAt(x+1, y) !== 'water'});
    else if (gt !== 'grass') Sp.drawEdges(g, gt, x*T, y*T, {n:gAt(x, y-1) === 'grass', s:gAt(x, y+1) === 'grass', w:gAt(x-1, y) === 'grass', e:gAt(x+1, y) === 'grass'});
  }
  m.buildings.forEach(function(b){ Sp.buildingShadow(g, b.x*T, b.y*T, (b.w || 3)*T, (b.h || 3)*T); });
  m.canopies = [];
  for (y = 0; y < m.h; y++) for (x = 0; x < m.w; x++){
    t = m.tiles[y*m.w + x];
    if (Sp.GROUND_TYPES[t]) continue;
    if (t === 'tree'){
      Sp.drawTrunk(g, x*T, y*T);
      m.canopies.push({x:x, y:y, kind:Sp.treeKind(x, y, x === 0 || y === 0 || x === m.w - 1 || y === m.h - 1), fog:!!(m.locked && m.locked[y*m.w + x])});
      continue;
    }
    if (t === 'rock' || t === 'bush' || t === 'barrel' || t === 'crate') Sp.shadowEllipse(g, x*T + 6, y*T + 10, 5, 2);
    if (t === 'lamp' && !tileSupported('lamp')){ fbLamp(g, x*T, y*T); continue; }
    Sp.drawOverlay(g, t, x*T, y*T, 0);
  }
  m.buildings.forEach(function(b){
    if (b.kind === 'mart') Sp.drawMart(g, b.x*T, b.y*T);
    else if (b.kind === 'casino' && !m.layout){ if (Sp.drawCasino) Sp.drawCasino(g, b.x*T, b.y*T); else Sp.drawHouse(g, b.x*T, b.y*T, 2, false); }
    else if (PUBLIC_KINDS[b.kind] && Sp.drawPublic) Sp.drawPublic(g, b.kind, b.x*T, b.y*T, b.w, b.h);
    else Sp.drawHouse(g, b.x*T, b.y*T, b.style, !b.invited);
  });
  if (m.layout && m.layout.lots) drawLots(g, m);
  if (m.portal) drawPortal(g, m);
  if (m.locked){
    // fog over areas that are not open yet, a little lighter along the edge so the border reads as mist
    for (y = 0; y < m.h; y++) for (x = 0; x < m.w; x++){
      if (!m.locked[y*m.w + x]) continue;
      var edge = (x > 0 && !m.locked[y*m.w + x - 1]) || (x < m.w - 1 && !m.locked[y*m.w + x + 1]) || (y > 0 && !m.locked[(y - 1)*m.w + x]) || (y < m.h - 1 && !m.locked[(y + 1)*m.w + x]);
      g.fillStyle = edge ? 'rgba(30,26,58,0.38)' : 'rgba(30,26,58,0.55)';
      g.fillRect(x*T, y*T, T, T);
    }
  }
  m.layered = true;
  m.cache = c;
}
/** Homeland building lots that are still empty: a patch of bare earth with four stakes and a small sign at the door. */
function drawLots(g, m){
  var taken = {};
  m.buildings.forEach(function(b){ if (b.lot) taken[b.lot] = 1; });
  m.layout.lots.forEach(function(l){
    if (taken[l.id]) return;
    var x0 = l.x*T, y0 = l.y*T, w = l.w*T, h = l.h*T, k;
    g.fillStyle = 'rgba(138,96,56,0.55)'; g.fillRect(x0 + 2, y0 + 2, w - 4, h - 4);
    g.fillStyle = 'rgba(190,150,96,0.45)'; for (k = 0; k < 6; k++) g.fillRect(x0 + 4 + ((k*7) % (w - 8)), y0 + 4 + ((k*11) % (h - 8)), 2, 1);
    [[0,0],[w-3,0],[0,h-4],[w-3,h-4]].forEach(function(p){ g.fillStyle = '#3d2610'; g.fillRect(x0 + p[0], y0 + p[1], 3, 4); g.fillStyle = '#b07840'; g.fillRect(x0 + p[0], y0 + p[1], 3, 1); });
    var sx = l.door.x*T + 4, sy = l.door.y*T + 3;
    g.fillStyle = '#3d2610'; g.fillRect(sx + 2, sy + 4, 1, 4);
    g.fillStyle = '#2a2430'; g.fillRect(sx - 1, sy - 1, 7, 6); g.fillStyle = '#f2e2c4'; g.fillRect(sx, sy, 5, 4);
    g.fillStyle = l.kind === 'kolam' ? '#3d7fc2' : l.kind === 'tambang' ? '#6a6678' : l.kind === 'penggergajian' ? '#4f7a3a' : l.kind === 'kincir' ? '#e0a060' : l.kind === 'gudang' ? '#b4523c' : '#c8502e'; g.fillRect(sx + 1, sy + 1, 3, 2);
  });
}
/** The portal: a small stone arch with a swirling oval (the mod adds a shimmer on top). Public village and Homelands both have one;
 *  the village's (m.bigPortal) is drawn 2 wide and 1.6 tall, standing on the same tile and growing out of it sideways and upward. */
function drawPortal(g, m){
  var d = m.portal, x0 = d.x*T, y0 = d.y*T, sx = m.bigPortal ? 2 : 1, sy = m.bigPortal ? 1.6 : 1;
  function rc(c, ax, ay, aw, ah){ // a rect given for the small arch, scaled about the tile's bottom centre
    g.fillStyle = c;
    var l = Math.round(x0 + T/2 + (ax - T/2)*sx), t = Math.round(y0 + T + (ay - T)*sy);
    g.fillRect(l, t, Math.max(1, Math.round(aw*sx)), Math.max(1, Math.round(ah*sy)));
  }
  rc('#5a5668', 0, T - 3, T, 3);
  rc('#8a869a', 0, T - 3, T, 1);
  rc('#2a2430', 1, -7, T - 2, T + 5);
  rc('#6a6678', 1, -6, 2, T + 3); rc('#6a6678', T - 3, -6, 2, T + 3); rc('#6a6678', 1, -7, T - 2, 2);
  rc('#9a96ac', 1, -7, T - 2, 1); rc('#9a96ac', 1, -6, 1, T + 3);
  rc('#3b2a78', 3, -5, T - 6, T + 1);
  rc('#6a4fd8', 4, -4, T - 8, T - 1);
  rc('#a58cff', 5, -2, T - 10, T - 5);
  rc('#e4dcff', 5, 0, 2, 2);
}
function buildCache(m){
  if (m.kind === 'world' && SPRITES.drawGround) return buildWorldCache(m);
  var c = document.createElement('canvas');
  c.width = m.w * T; c.height = m.h * T;
  var g = c.getContext('2d'); g.imageSmoothingEnabled = false;
  for (var y = 0; y < m.h; y++) for (var x = 0; x < m.w; x++){
    var tl = m.tiles[y*m.w + x];
    if (m.floorKind && FLOORLESS[tl]) drawTileSafe(g, m.floorKind, x*T, y*T, 0); // room furniture without its own floor
    drawTileSafe(g, tl, x*T, y*T, 0);
  }
  m.buildings.forEach(function(b){
    if (b.kind === 'mart') SPRITES.drawMart(g, b.x*T, b.y*T);
    else if (b.kind === 'casino'){
      if (SPRITES.drawCasino) SPRITES.drawCasino(g, b.x*T, b.y*T); else SPRITES.drawHouse(g, b.x*T, b.y*T, 2, false);
    }
    else SPRITES.drawHouse(g, b.x*T, b.y*T, b.style, !b.invited);
  });
  m.cache = c;
}

/* ---------- world generation ---------- */
// Hackathon world (2026-11-02): the shared seeded generator in js/world/village.js builds the village; the server
// runs the same file, so every player sees the same map. `worldUnlocked` lists chunks opened by town projects.
// The old block-grid generator (tryWorld) stays as the fallback when village.js is missing.
var worldUnlocked = [];
// Homeland (2026-11-08): the outdoor world is the public village or a player's Homeland built from a layout the server
// inputs generate (GT.switchWorld). worldId is 'public' or 'HL-<id>'; the village seed stays in `seed` the whole time.
var worldId = 'public', homeLayout = null;
function genWorld(seed){
  if (homeLayout) return fromLayout(homeLayout);
  if (window.GTVillage) return fromLayout(GTVillage.generate(seed, worldUnlocked));
  for (var att = 0; att < 40; att++){
    var w = tryWorld(seed, att);
    if (w) { w.attempt = att; return w; }
  }
  throw new Error($t('Gagal membuat dunia'));
}

function tryWorld(seed, att){
  var R = makeR((seed + att * 7919) >>> 0);
  var m = newMap(WT, HT, 'grass', 'world');
  m.seed = seed;
  var reserved = new Set();
  function I(x,y){ return y * WT + x; }
  function inb(x,y){ return x >= 0 && y >= 0 && x < WT && y < HT; }
  function set(x,y,t){ if (inb(x,y)) m.tiles[I(x,y)] = t; }

  // roads: top row + left column of every block
  var bx, by, i;
  for (by = 0; by < NB; by++) for (bx = 0; bx < NB; bx++){
    var ox = bx*BS, oy = by*BS;
    for (i = 0; i < BS; i++){ set(ox + i, oy, 'path'); set(ox, oy + i, 'path'); }
  }
  for (i = 1; i < WT - 1; i++) set(i, HT - 2, 'path'); // closing road along the south edge
  for (i = 0; i < WT; i++){ set(i, 0, 'tree'); set(i, HT-1, 'tree'); set(0, i, 'tree'); set(WT-1, i, 'tree'); }

  // block types
  var types = []; for (i = 0; i < NB*NB; i++) types.push('house');
  var ownB = {x:R.int(3,6), y:R.int(3,6)};
  var marts = [];
  while (marts.length < 2){
    var cx = R.int(1,8), cy = R.int(1,8);
    if (Math.abs(cx - ownB.x) + Math.abs(cy - ownB.y) < 2) continue;
    if (marts.some(function(q){ return Math.abs(q.x-cx) + Math.abs(q.y-cy) < 4; })) continue;
    marts.push({x:cx, y:cy});
  }
  marts.forEach(function(q){ types[q.y*NB + q.x] = 'mart'; });
  // exactly one casino block (own PRNG so the rest of the layout keeps its v1 random stream)
  var RC = makeR((seed * 31 + att * 977 + 0xCA51) >>> 0), ccand = [];
  for (by = 1; by <= 8; by++) for (bx = 1; bx <= 8; bx++){
    if (types[by*NB + bx] !== 'house') continue;
    if (Math.abs(bx - ownB.x) + Math.abs(by - ownB.y) < 2) continue;
    ccand.push(by*NB + bx);
  }
  var cpick = RC.pick(ccand); types[cpick] = 'casino';
  var nPark = R.int(10, 14), guard = 0;
  while (nPark > 0 && guard++ < 500){
    var px = R.int(0,9), py = R.int(0,9);
    if (types[py*NB + px] !== 'house' || (px === ownB.x && py === ownB.y)) continue;
    types[py*NB + px] = 'park'; nPark--;
  }
  // Art pass 1: a market plaza and the player's fenced farm next to the player's block (own PRNG).
  var RM = makeR((seed * 131 + att * 31 + 0x3A7C) >>> 0);
  function freeNb(order){
    for (var q = 0; q < order.length; q++){
      var nx = ownB.x + order[q][0], ny = ownB.y + order[q][1];
      if (nx >= 0 && ny >= 0 && nx < NB && ny < NB && types[ny*NB + nx] === 'house') return ny*NB + nx;
    }
    return -1;
  }
  var plazaI = freeNb([[0,1],[1,0],[-1,0],[0,-1]]);
  if (plazaI >= 0) types[plazaI] = 'plaza';
  var farmI = freeNb(RM.chance(0.5) ? [[-1,0],[1,0],[0,-1],[0,1],[1,1],[-1,1]] : [[1,0],[-1,0],[0,-1],[0,1],[-1,1],[1,1]]);
  if (farmI >= 0) types[farmI] = 'farm';
  m.blockTypes = types;
  // scatter a cluster of `tile` around (cx,cy) on free tiles inside [x0..x1]x[y0..y1]
  function cluster(cx, cy, rad, n, tile, x0, y0, x1, y1, avoid){
    for (var q = 0; q < n * 3 && n > 0; q++){
      var xx = cx + R.int(-rad, rad), yy = cy + R.int(-rad, rad);
      if (xx < x0 || xx > x1 || yy < y0 || yy > y1 || reserved.has(I(xx, yy)) || (avoid && avoid(xx, yy))) continue;
      if (m.tiles[I(xx, yy)] !== 'grass') continue;
      set(xx, yy, tile); n--;
    }
  }

  var houses = [];
  function fullName(){ return R.pick(FIRST) + ' ' + R.pick(LAST); }

  for (by = 0; by < NB; by++) for (bx = 0; bx < NB; bx++){
    var type = types[by*NB + bx];
    var ox2 = bx*BS, oy2 = by*BS;
    var ix0 = ox2 + 1, iy0 = oy2 + 1;
    var ix1 = Math.min(ox2 + 5, WT - 2), iy1 = Math.min(oy2 + 5, HT - 3); // interior bounds (inclusive)
    var x, y;
    if (type === 'plaza'){
      for (y = iy0; y <= iy1; y++) for (x = ix0; x <= ix1; x++){ set(x, y, 'plaza'); reserved.add(I(x, y)); }
      // four stalls in one row; merchants stand behind (north), customers in front (south); column ix0+2 stays open
      var sxs = [ix0, ix0 + 1, ix0 + 3, ix0 + 4].filter(function(v){ return v <= ix1; });
      var stallColors = ['#e8503c', '#4a8ad8', '#e8a13c', '#58a858'];
      m.market = { stalls: [], block: {bx:bx, by:by} };
      sxs.forEach(function(sx, k){ set(sx, iy0 + 1, 'stall'); m.market.stalls.push({x:sx, y:iy0 + 1, seat:{x:sx, y:iy0}, color:stallColors[k % 4]}); });
      if (iy1 >= iy0 + 4){ set(ix0, iy1, 'crate'); set(ix1, iy1, 'barrel'); }
      m.info.set(I(ix0 + 2, iy0), $t('Pasar Genesis. Pedagang berjualan di sini setiap hari.'));
      continue;
    }
    if (type === 'farm'){
      // fence ring with a gate on the south side; 3x2 soil plots inside, a walking row below them
      for (x = ix0; x <= ix1; x++){ set(x, iy0, 'fence'); reserved.add(I(x, iy0)); }
      for (y = iy0 + 1; y <= iy1; y++){ set(ix0, y, 'fence'); set(ix1, y, 'fence'); reserved.add(I(ix0, y)); reserved.add(I(ix1, y)); }
      var gateX = ix0 + 2;
      for (x = ix0 + 1; x < ix1; x++){ if (x !== gateX){ set(x, iy1, 'fence'); } else set(x, iy1, 'path'); reserved.add(I(x, iy1)); }
      m.farm = { plots: [], gate: {x:gateX, y:iy1}, block: {bx:bx, by:by} };
      for (y = iy0 + 1; y <= iy0 + 2; y++) for (x = ix0 + 1; x <= ix1 - 1; x++){ set(x, y, 'soil'); reserved.add(I(x, y)); m.farm.plots.push({x:x, y:y}); }
      for (x = ix0 + 1; x <= ix1 - 1; x++) if (iy0 + 3 < iy1) reserved.add(I(x, iy0 + 3));
      continue;
    }
    if (type === 'park'){
      var pathRow = iy0 + R.int(1, 3); if (pathRow > iy1) pathRow = iy1;
      for (x = ix0; x <= ix1; x++){ set(x, pathRow, 'path'); reserved.add(I(x, pathRow)); }
      // sign next to the west road
      var sy = iy0; do { sy = iy0 + R.int(0, iy1 - iy0); } while (sy === pathRow);
      set(ix0, sy, 'sign'); reserved.add(I(ix0, sy));
      var parkName = R.pick(PARK);
      m.info.set(I(ix0, sy), $t('Taman {0}. {1}', [parkName, R.pick(SIGN_LINES)]));
      // pond
      var pw = R.int(2,3), ph = 2, tries = 0, placed = false;
      while (!placed && tries++ < 30){
        var pxx = R.int(ix0 + 1, Math.max(ix0 + 1, ix1 - pw + 1)), pyy = R.int(iy0, Math.max(iy0, iy1 - ph + 1));
        var okp = pxx + pw - 1 <= ix1 && pyy + ph - 1 <= iy1;
        for (y = pyy; y < pyy + ph && okp; y++) for (x = pxx; x < pxx + pw && okp; x++) if (reserved.has(I(x,y))) okp = false;
        if (!okp) continue;
        for (y = pyy; y < pyy + ph; y++) for (x = pxx; x < pxx + pw; x++){ set(x, y, 'water'); reserved.add(I(x,y)); }
        // sand ring where free
        for (y = pyy - 1; y <= pyy + ph; y++) for (x = pxx - 1; x <= pxx + pw; x++){
          if (x < ix0 || x > ix1 || y < iy0 || y > iy1 || reserved.has(I(x,y))) continue;
          set(x, y, 'sand'); reserved.add(I(x,y));
        }
        placed = true;
      }
      // groves and patches (clustered), with a little scatter so it still feels natural
      cluster(R.int(ix0, ix1), R.int(iy0, iy1), 2, R.int(3, 5), 'tree', ix0, iy0, ix1, iy1);
      cluster(R.int(ix0, ix1), R.int(iy0, iy1), 1, R.int(3, 5), 'flower', ix0, iy0, ix1, iy1);
      cluster(R.int(ix0, ix1), R.int(iy0, iy1), 1, R.int(2, 4), 'tallgrass', ix0, iy0, ix1, iy1);
      cluster(R.int(ix0, ix1), R.int(iy0, iy1), 1, R.int(1, 3), 'bush', ix0, iy0, ix1, iy1);
      for (y = iy0; y <= iy1; y++) for (x = ix0; x <= ix1; x++){
        if (reserved.has(I(x,y)) || m.tiles[I(x,y)] !== 'grass') continue;
        var r = R.f();
        if (r < 0.06) set(x, y, 'tallgrass'); else if (r < 0.09) set(x, y, 'flower'); else if (r < 0.10) set(x, y, 'rock');
      }
      continue;
    }

    // house, mart or casino
    var maxHx = Math.min(ox2 + 3, WT - 4);
    var hx = R.int(ox2 + 1, maxHx);
    var hy = (by === NB - 1) ? oy2 + 1 : R.int(oy2 + 1, oy2 + 3);
    var b = { kind:type, bx:bx, by:by, x:hx, y:hy, dx:hx + 1, dy:hy + 2, style:R.int(0,3) };
    var big = (type !== 'house');
    if (type === 'house'){
      b.id = houses.length; b.owner = fullName(); b.invited = false; b.own = false;
      b.iseed = R.int(1, 1073741823); b.hasNpc = R.chance(0.4);
      houses.push(b);
    } else { b.invited = true; b.owner = type === 'mart' ? $t('Mart Genesis') : $t('Kasino Genesis'); b.iseed = (seed ^ (bx * 131 + by * 17)) >>> 0; }
    m.buildings.push(b);
    for (y = hy; y < hy + 3; y++) for (x = hx; x < hx + 3; x++){
      var bi = I(x,y);
      set(x, y, 'grass'); m.blocked.add(bi); reserved.add(bi);
      if (x === b.dx && y === b.dy) m.door.set(bi, b); else m.bld.set(bi, b);
    }
    // path stub from the door down to the road
    for (y = hy + 3; y <= Math.min(oy2 + 5, HT - 2); y++){ set(b.dx, y, 'path'); reserved.add(I(b.dx, y)); }
    if (big){
      for (x = hx - 1; x <= hx + 3; x++) if (x >= ix0 && x <= ix1 && hy + 3 <= iy1){ set(x, hy + 3, 'path'); reserved.add(I(x, hy + 3)); }
    }
    // mailbox
    if (type === 'house'){
      var mxs = [hx + 3, hx - 1]; if (R.chance(0.5)) mxs.reverse();
      for (var k = 0; k < 2; k++){
        var mx = mxs[k];
        if (mx >= ix0 && mx <= ix1 && !reserved.has(I(mx, hy + 2))){
          set(mx, hy + 2, 'mailbox'); reserved.add(I(mx, hy + 2)); b.mail = I(mx, hy + 2);
          m.info.set(I(mx, hy + 2), $t('Kotak surat milik {0}. Isinya kosong.', [b.owner]));
          break;
        }
      }
    }
    // fence along the top yard edge
    if (type === 'house' && hy > iy0 && R.chance(0.45)){
      for (x = ix0; x <= ix1; x++) if (!reserved.has(I(x, iy0))){ set(x, iy0, 'fence'); reserved.add(I(x, iy0)); }
    }
    // decor: flowers along the house front, props against the walls, one themed cluster per lot
    var nearDoor = function(xx, yy){ return Math.abs(xx - b.dx) <= 1 && yy > hy + 2; };
    if (type === 'house'){
      [b.dx - 1, b.dx + 1].forEach(function(fx){ if (fx >= ix0 && fx <= ix1 && hy + 3 <= iy1 && !reserved.has(I(fx, hy + 3))) set(fx, hy + 3, 'flower'); });
      var side = R.chance(0.5) ? hx - 1 : hx + 3;
      if (side >= ix0 && side <= ix1 && !reserved.has(I(side, hy + 1))){ set(side, hy + 1, R.chance(0.5) ? 'barrel' : 'crate'); reserved.add(I(side, hy + 1)); }
      var theme = R.int(0, 3), cx0 = R.int(ix0, ix1), cy0 = R.int(iy0, iy1);
      if (theme === 0) cluster(cx0, cy0, 1, R.int(3, 5), 'flower', ix0, iy0, ix1, iy1, nearDoor);
      else if (theme === 1) cluster(cx0, cy0, 1, R.int(2, 3), 'bush', ix0, iy0, ix1, iy1, nearDoor);
      else if (theme === 2) cluster(cx0, cy0, 1, R.int(2, 3), 'tree', ix0, iy0, ix1, iy1, nearDoor);
      else cluster(cx0, cy0, 1, R.int(2, 4), 'tallgrass', ix0, iy0, ix1, iy1, nearDoor);
    }
    for (y = iy0; y <= iy1; y++) for (x = ix0; x <= ix1; x++){
      if (reserved.has(I(x,y)) || m.tiles[I(x,y)] !== 'grass') continue;
      var rr = R.f();
      if (rr < 0.05) set(x, y, 'flower');
      else if (rr < 0.10) set(x, y, 'tallgrass');
      else if (rr < 0.12 && !nearDoor(x, y)) set(x, y, 'rock');
    }
  }

  // ownership / invitations
  var own = houses.filter(function(h){ return h.bx === ownB.x && h.by === ownB.y; })[0];
  if (!own) return null;
  own.own = true; own.invited = true; own.owner = $t('Kamu');
  if (own.mail != null) m.info.set(own.mail, $t('Kotak surat milikmu. Belum ada surat.'));
  var others = R.shuffle(houses.filter(function(h){ return h !== own; }));
  for (i = 0; i < 4; i++) others[i].invited = true;
  m.houses = houses; m.own = own;
  m.marts = m.buildings.filter(function(q){ return q.kind === 'mart'; });
  m.casino = m.buildings.filter(function(q){ return q.kind === 'casino'; })[0] || null;
  if (!m.casino) return null;
  m.spawn = {x:own.dx, y:own.dy + 1};
  finalize(m);
  placeLamps(m, seed, att, reserved);

  // validate: BFS from spawn must reach the front of every door
  var reach = bfs(m, m.spawn.x, m.spawn.y);
  if (!reach[I(m.spawn.x, m.spawn.y)]) return null;
  var bad = false;
  m.buildings.forEach(function(q){ if (!reach[I(q.dx, q.dy + 1)]) bad = true; });
  if (bad) return null;
  m.reach = reach;
  m.doorFront = new Set();
  m.buildings.forEach(function(q){ m.doorFront.add(I(q.dx, q.dy + 1)); });
  m.npcSpawns = [];
  for (var yy = 1; yy < HT - 1; yy++) for (var xx = 1; xx < WT - 1; xx++){
    var ii = I(xx, yy);
    if (reach[ii] && !m.doorFront.has(ii) && (Math.abs(xx - m.spawn.x) + Math.abs(yy - m.spawn.y) > 4)) m.npcSpawns.push([xx,yy]);
  }
  R.shuffle(m.npcSpawns);
  m.r = R;
  buildCache(m);
  return m;
}

var HOME_NAMES = { townhall:$t('Balai Kota'), kolam:$t('Kolam Ikan'), tambang:$t('Tambang'), restoran:$t('Restoran'), rumah:$t('Rumah Pekerja'), rumahsakit:$t('Rumah Sakit'), penggergajian:$t('Penggergajian'), kincir:$t('Kincir Angin'), gudang:$t('Gudang') };
var PUBLIC_KINDS = { hall:1, church:1, clinic:1, post:1, broker:1, warung:1, townhall:1, kolam:1, tambang:1, restoran:1, rumah:1, rumahsakit:1, penggergajian:1, kincir:1, gudang:1, mall:1, casino:1, papan:1, tambangpub:1 };
var HOME_KINDS = { townhall:1, kolam:1, tambang:1, restoran:1, rumah:1, rumahsakit:1, penggergajian:1, kincir:1, gudang:1 };
function layoutChunk(L, x, y){ return homeLayout && window.GTHomeland ? GTHomeland.chunkOf(L, x, y) : GTVillage.chunkOf(L, x, y); }
function fromLayout(L){
  var R = makeR((L.seed ^ 0x9e3779b9) >>> 0), x, y, i;
  var m = newMap(L.w, L.h, 'grass', 'world');
  m.seed = L.seed; m.layout = L; m.tiles = L.tiles.slice(); m.chunks = L.chunks; m.plaza = L.plaza;
  Object.keys(L.info).forEach(function(k){ m.info.set(+k, L.info[k]); });
  var houses = [];
  L.buildings.forEach(function(lb){
    var b = { kind:lb.kind, x:lb.x, y:lb.y, w:lb.w, h:lb.h, dx:lb.dx, dy:lb.dy, style:lb.style || 0, open:lb.open, chunk:lb.chunk, lot:lb.lot || null };
    if (lb.kind === 'house'){
      b.id = houses.length; b.own = !!lb.own; b.owner = b.own ? $t('Kamu') : R.pick(FIRST) + ' ' + R.pick(LAST);
      b.invited = b.own; b.iseed = R.int(1, 1073741823); b.hasNpc = R.chance(0.4);
      houses.push(b);
    } else {
      b.id = lb.lot || lb.kind; b.name = lb.name || HOME_NAMES[lb.kind] || lb.kind; b.owner = b.name; b.invited = HOME_KINDS[lb.kind] ? false : lb.open; // Homeland buildings are never entered: the door opens the mod's menu b.iseed = hashStr(L.seed + ':' + lb.kind);
    }
    if (lb.mail != null){ b.mail = lb.mail; m.info.set(lb.mail, b.own ? $t('Kotak surat milikmu. Belum ada surat.') : $t('Kotak surat milik {0}. Isinya kosong.', [b.owner])); }
    m.buildings.push(b);
    for (y = b.y; y < b.y + b.h; y++) for (x = b.x; x < b.x + b.w; x++){
      i = y*m.w + x; m.blocked.add(i);
      if (x === b.dx && y === b.dy) m.door.set(i, b); else m.bld.set(i, b);
    }
  });
  var own = houses.filter(function(h){ return h.own; })[0];
  R.shuffle(houses.filter(function(h){ return !h.own && h.open; })).slice(0, 4).forEach(function(h){ h.invited = true; });
  m.houses = houses; m.own = own; m.marts = []; m.casino = null;
  m.market = { stalls: L.market.stalls.map(function(s){ return { x:s.x, y:s.y, seat:{x:s.seat.x, y:s.seat.y}, color:s.color }; }) };
  m.farm = { plots: L.farm.plots.slice(), gate: L.farm.gate };
  m.spawn = { x:L.spawn.x, y:L.spawn.y };
  m.portal = homeLayout ? { x:L.portal.x, y:L.portal.y } : (GTVillage.dockOf ? GTVillage.dockOf(L) : null);
  m.bigPortal = !homeLayout && !!m.portal; // the village portal, where everyone on the server arrives, is drawn about twice a Homeland's (look only, the tile is the same)
  finalize(m);
  // locked chunks: generated and drawn under fog, but nobody walks there until a town project opens them
  m.locked = new Uint8Array(m.w * m.h);
  for (y = 0; y < m.h; y++) for (x = 0; x < m.w; x++) if (!layoutChunk(L, x, y).open){ m.locked[y*m.w + x] = 1; m.walk[y*m.w + x] = 0; }
  var reserved = new Set();
  for (y = L.plaza.y0; y <= L.plaza.y1; y++) for (x = L.plaza.x0; x <= L.plaza.x1; x++) reserved.add(y*m.w + x);
  for (y = L.farm.y0; y <= L.farm.y1 + 1; y++) for (x = L.farm.x0; x <= L.farm.x1; x++) reserved.add(y*m.w + x);
  m.buildings.forEach(function(b){ reserved.add((b.dy + 1)*m.w + b.dx); });
  if (!homeLayout) placeLamps(m, L.seed, L.attempt, reserved); // Homelands stay lamp-free so the server's walk map matches
  else m.lamps = (L.lamps || []).map(function(q){ return {x:q.x, y:q.y}; }); // the Lighting project's lamps come from the shared generator
  var reach = bfs(m, m.spawn.x, m.spawn.y);
  m.reach = reach;
  m.doorFront = new Set();
  m.buildings.forEach(function(q){ m.doorFront.add((q.dy + 1)*m.w + q.dx); });
  m.npcSpawns = [];
  for (y = 1; y < m.h - 1; y++) for (x = 1; x < m.w - 1; x++){
    i = y*m.w + x;
    if (reach[i] && !m.doorFront.has(i) && (Math.abs(x - m.spawn.x) + Math.abs(y - m.spawn.y) > 4)) m.npcSpawns.push([x, y]);
  }
  R.shuffle(m.npcSpawns);
  m.r = R; m.attempt = L.attempt;
  buildCache(m);
  return m;
}
/** Name of the area at an outdoor tile: the chunk, or the landmark the player stands next to. */
function areaName(x, y){
  var m = world, L = m && m.layout;
  if (!L) return $t('Blok ({0},{1})', [Math.floor(x / BS), Math.floor(y / BS)]);
  if (homeLayout) return layoutChunk(L, x, y).name;
  if (L.plaza && x >= L.plaza.x0 - 1 && x <= L.plaza.x1 + 1 && y >= L.plaza.y0 - 1 && y <= L.plaza.y1 + 1) return $t('Pasar Genesis');
  for (var k = 0; k < m.buildings.length; k++){ var b = m.buildings[k]; if (b.name && Math.abs(x - b.dx) <= 2 && y >= b.dy && y <= b.dy + 2) return b.name; }
  return layoutChunk(L, x, y).name;
}

/* street lamps: solid 'lamp' tiles on road-side grass.  Own PRNG (the v1 random stream is untouched).  Each lamp is only kept if the
   walkable region stays connected (exactly one tile lost) and every door front stays reachable.  Pass 1 lights ~half of the doors,
   pass 2 adds more lamps (up to 25-35 total) while keeping at least ~35% of doors dark. */
function placeLamps(m, seed, att, reserved){
  var RL = makeR((Math.imul(seed >>> 0, 2654435761) ^ Math.imul(att + 1, 40503) ^ 0x1A4B5) >>> 0);
  var W = m.w, H = m.h, i;
  var base = bfs(m, m.spawn.x, m.spawn.y), baseCount = 0;
  var fronts = m.buildings.map(function(b){ return {x:b.dx, y:b.dy + 1}; }).filter(function(f){ return base[f.y*W + f.x]; });
  for (i = 0; i < base.length; i++) baseCount += base[i];
  var lamps = [], lit = new Uint8Array(fronts.length), litN = 0;
  function cheb(a, b, c, d){ return Math.max(Math.abs(a - c), Math.abs(b - d)); }
  var cands = [], x, y;
  for (y = 2; y < H - 2; y++) for (x = 2; x < W - 2; x++){
    var idx = y*W + x, t = m.tiles[idx];
    if (t !== 'grass' && t !== 'flower' && t !== 'tallgrass') continue;
    if (reserved.has(idx) || m.blocked.has(idx) || m.walk[idx] !== 1) continue;
    if (m.tiles[idx - 1] !== 'path' && m.tiles[idx + 1] !== 'path' && m.tiles[idx - W] !== 'path' && m.tiles[idx + W] !== 'path') continue;
    var nearDoor = false;
    for (i = 0; i < fronts.length; i++) if (cheb(x, y, fronts[i].x, fronts[i].y) <= 1) { nearDoor = true; break; }
    if (nearDoor) continue;
    cands.push({x:x, y:y, i:idx});
  }
  RL.shuffle(cands);
  var target = RL.int(25, 35);
  function newly(c){ var a = []; for (var k = 0; k < fronts.length; k++) if (!lit[k] && cheb(c.x, c.y, fronts[k].x, fronts[k].y) <= 4) a.push(k); return a; }
  function tryAdd(c, minSp, maxLit, needGain){
    for (var k = 0; k < lamps.length; k++) if (cheb(c.x, c.y, lamps[k].x, lamps[k].y) < minSp) return false;
    var nw = newly(c);
    if (needGain && !nw.length) return false;
    if ((litN + nw.length) / fronts.length > maxLit) return false;
    m.walk[c.i] = 0;
    var r = bfs(m, m.spawn.x, m.spawn.y), cnt = 0, ok = true;
    for (k = 0; k < r.length; k++) cnt += r[k];
    if (cnt !== baseCount - lamps.length - 1) ok = false;
    for (k = 0; ok && k < fronts.length; k++) if (!r[fronts[k].y*W + fronts[k].x]) ok = false;
    if (!ok){ m.walk[c.i] = 1; return false; }
    m.tiles[c.i] = 'lamp'; lamps.push({x:c.x, y:c.y});
    nw.forEach(function(q){ lit[q] = 1; litN++; });
    m.info.set(c.i, $t('Tiang listrik. Lampunya menyala saat malam.'));
    return true;
  }
  var c;
  for (i = 0; i < cands.length && lamps.length < target; i++) tryAdd(cands[i], 4, 0.55, true);
  for (i = 0; i < cands.length && lamps.length < target; i++) if (m.tiles[cands[i].i] !== 'lamp') tryAdd(cands[i], 3, 0.62, false);
  m.lamps = lamps;
  m.litFrac = litN / Math.max(1, fronts.length);
}

function bfs(m, sx, sy){
  var seen = new Uint8Array(m.w * m.h), q = [sx, sy], head = 0;
  if (sx < 0 || sy < 0 || sx >= m.w || sy >= m.h || !m.walk[sy*m.w + sx]) return seen;
  seen[sy*m.w + sx] = 1;
  while (head < q.length){
    var x = q[head++], y = q[head++];
    for (var d = 0; d < 4; d++){
      var dv = DIRS[DIRLIST[d]], nx = x + dv[0], ny = y + dv[1];
      if (nx < 0 || ny < 0 || nx >= m.w || ny >= m.h) continue;
      var ni = ny*m.w + nx;
      if (seen[ni] || !m.walk[ni]) continue;
      seen[ni] = 1; q.push(nx, ny);
    }
  }
  return seen;
}

/* ---------- interiors ---------- */
function genHouseInterior(h){
  var R = makeR(h.iseed), w = 10, hh = 8;
  var m = newMap(w, hh, R.chance(0.6) ? 'floor_wood' : 'floor_tile', 'interior');
  function I(x,y){ return y*w + x; }
  var x, y;
  for (x = 0; x < w; x++){ m.tiles[I(x,0)] = 'wall'; m.tiles[I(x,hh-1)] = 'wall'; }
  for (y = 0; y < hh; y++){ m.tiles[I(0,y)] = 'wall'; m.tiles[I(w-1,y)] = 'wall'; }
  m.mat = {x:4, y:hh-1};
  m.tiles[I(4,hh-1)] = 'doormat'; m.exit.add(I(4,hh-1));
  m.entry = {x:4, y:hh-2};
  for (y = 5; y <= 6; y++) for (x = 3; x <= 6; x++) m.tiles[I(x,y)] = 'rug';
  var names = {bed:$t('Kasur yang empuk. Jangan tidur dulu!'), bookshelf:$t('Buku resep, komik, dan satu kamus tebal.'), tv:$t('Acaranya lagi seru, tapi kamu tidak punya waktu nonton.'), fridge:$t('Isinya jus jeruk dan telur. Jangan diambil!'), plant:$t('Tanamannya terawat dengan baik.')};
  var items = ['bed','bookshelf','tv','fridge','plant'];
  var slots = R.shuffle([1,2,3,4,5,6,7,8]);
  items.forEach(function(it, n){ m.tiles[I(slots[n],1)] = it; m.info.set(I(slots[n],1), names[it]); });
  var tx = R.int(2,7);
  m.tiles[I(tx,3)] = 'table'; m.info.set(I(tx,3), $t('Meja makan. Ada sepiring pisang goreng.'));
  m.tiles[I(tx,4)] = 'chair'; m.info.set(I(tx,4), $t('Kursi kayu yang kokoh.'));
  if (R.chance(0.6)){ m.tiles[I(1,6)] = 'plant'; m.info.set(I(1,6), names.plant); }
  if (R.chance(0.6)){ m.tiles[I(8,6)] = 'plant'; m.info.set(I(8,6), names.plant); }
  // storage chest on a free back-wall slot (row 1 is always reachable from row 2); separate PRNG keeps the layout above unchanged
  var free = slots.slice(5), RK = makeR((h.iseed ^ 0x5eed1234) >>> 0);
  var cxs = RK.pick(free);
  m.tiles[I(cxs,1)] = 'chest'; m.chest = {x:cxs, y:1};
  finalize(m);
  m.npcs = [];
  if (h.hasNpc || h.own){
    var cand = [];
    for (y = 2; y <= 6; y++) for (x = 1; x <= 8; x++) if (m.walk[I(x,y)] && !(x === 4 && y >= 5)) cand.push([x,y]);
    var c = R.pick(cand);
    var nm = h.own ? $t('Ibu') : h.owner.split(' ')[0];
    var npc = mkNpc(c[0], c[1], nm, R.int(1,5), h.own ? [[$t('Kamu sudah pulang, nak?'),$t('Jangan lupa makan ya.')],[$t('Rumah ini selalu terbuka buatmu.')]] : HOME_LINES, {turns:true});
    npc.key = 'house:' + h.id + ':0';
    if (h.own) npc.aff0 = 70;
    m.npcs.push(npc);
  }
  buildCache(m);
  return m;
}

// Public buildings: one room per kind, furnished from the existing interior tiles. Mods add what each one does
// (the project board in the Balai Desa, the player market in the Kantor Makelar).
function genPublicInterior(b){
  var w = 12, hh = 9, k = b.kind;
  var m = newMap(w, hh, k === 'clinic' || k === 'post' ? 'floor_tile' : 'floor_wood', 'interior');
  function I(x,y){ return y*w + x; }
  function put(x, y, t, txt){ m.tiles[I(x,y)] = t; if (txt) m.info.set(I(x,y), txt); }
  var x, y;
  for (x = 0; x < w; x++){ m.tiles[I(x,0)] = 'wall'; m.tiles[I(x,hh-1)] = 'wall'; }
  for (y = 0; y < hh; y++){ m.tiles[I(0,y)] = 'wall'; m.tiles[I(w-1,y)] = 'wall'; }
  m.mat = {x:6, y:hh-1}; m.tiles[I(6,hh-1)] = 'doormat'; m.exit.add(I(6,hh-1)); m.entry = {x:6, y:hh-2};
  m.board = null;
  if (k === 'hall'){
    for (x = 3; x <= 8; x++) put(x, 3, 'table', $t('Meja rapat warga.'));
    for (x = 3; x <= 8; x += 2){ put(x, 2, 'chair'); put(x, 4, 'chair'); }
    put(5, 1, 'bookshelf', $t('Papan proyek desa. Bicara di sini untuk melihat dan menyumbang.')); m.board = {x:5, y:1};
    put(6, 1, 'bookshelf', $t('Arsip desa: peta lama dan catatan panen.'));
    put(1, 1, 'plant'); put(10, 1, 'plant');
  } else if (k === 'church'){
    for (y = 3; y <= 6; y++){ for (x = 2; x <= 4; x++) put(x, y, 'chair'); for (x = 7; x <= 9; x++) put(x, y, 'chair'); }
    put(5, 1, 'table', $t('Meja di depan, dengan lilin dan bunga segar.')); put(6, 1, 'table', $t('Meja di depan, dengan lilin dan bunga segar.'));
    put(1, 1, 'plant'); put(10, 1, 'plant');
    for (x = 5; x <= 6; x++) for (y = 3; y <= 6; y++) put(x, y, 'rug');
  } else if (k === 'clinic'){
    put(2, 1, 'bed', $t('Ranjang periksa yang bersih.')); put(4, 1, 'bed', $t('Ranjang periksa yang bersih.'));
    put(8, 3, 'counter', $t('Meja perawat. Obat belum dijual di sini (segera).')); put(9, 3, 'counter', $t('Meja perawat.'));
    put(10, 1, 'shelf', $t('Rak obat dan perban.')); put(1, 6, 'plant');
  } else if (k === 'post'){
    for (x = 3; x <= 8; x++) put(x, 3, 'counter', $t('Loket pos. Kirim barang ke pemain lain lewat Tas NEAR (on-chain).'));
    put(2, 1, 'shelf', $t('Rak paket.')); put(9, 1, 'shelf', $t('Rak paket.')); put(10, 6, 'plant');
  } else if (k === 'broker'){
    put(3, 2, 'table', $t('Meja makelar. Daftar lapak Pasar Pemain ada di sini.')); put(4, 2, 'table', $t('Meja makelar.')); m.board = {x:3, y:2};
    put(5, 2, 'table', $t('Meja makelar pulau. Pulau Pribadi dijual di sini.')); m.board2 = {x:5, y:2};
    put(3, 3, 'chair'); put(8, 1, 'bookshelf', $t('Buku catatan transaksi.')); put(9, 1, 'bookshelf', $t('Buku catatan transaksi.')); put(1, 6, 'plant');
  } else {
    put(3, 2, 'counter', $t('Kopi tubruk dan pisang goreng.')); put(4, 2, 'counter'); put(5, 2, 'counter');
    for (x = 2; x <= 8; x += 3){ put(x, 5, 'table', $t('Meja warung. Warga suka ngobrol di sini.')); put(x + 1, 5, 'chair'); }
    put(10, 1, 'fridge', $t('Es teh manis.'));
  }
  finalize(m);
  m.npcs = [];
  buildCache(m);
  return m;
}
/* ROOMS-BEGIN
   Rooms of the other buildings (mall, casino, news hall, public mine, church, clinic, post office and the Homeland
   buildings). One spec per kind: size, floor and a fill() that puts the furniture; the door is bottom centre. All of
   them keep a free aisle from the door mat to every piece you can use. Scene key = 'kind:id' (see houseScene). */
var ROOM_TITLE = { hall:$t('Balai Desa'), church:$t('Gereja'), clinic:$t('Klinik'), post:$t('Kantor Pos'), broker:$t('Kantor Makelar'), warung:$t('Warung'),
  townhall:$t('Balai Kota'), kolam:$t('Kolam Ikan'), tambang:$t('Tambang'), restoran:$t('Restoran'), rumah:$t('Rumah Pekerja'), rumahsakit:$t('Rumah Sakit'),
  penggergajian:$t('Penggergajian'), kincir:$t('Kincir Angin'), gudang:$t('Gudang'), mall:$t('Mall Genesis'), casino:$t('Kasino Genesis'),
  papan:$t('Balai Berita'), tambangpub:$t('Tambang Umum') };
// tiles with no floor of their own: the room's floor is drawn under them (buildCache)
var FLOORLESS = {ore_rock:1, lb_wall:1, news_board:1, roulette:1, rack:1, pew:1, sack:1, crate_i:1, barrel_i:1, tank:1, display:1, log:1, stove:1};
var ROOMS = {
  mall: { w:14, h:10, floor:'floor_tile', fill: function(c){
    var x;
    for (x = 2; x <= 4; x++) c.put(x, 1, 'shelf', $t('Rak penuh barang dagangan dari seluruh negeri.'));
    for (x = 9; x <= 11; x++) c.put(x, 1, 'shelf', $t('Rak penuh barang dagangan dari seluruh negeri.'));
    c.put(6, 1, 'display', $t('Etalase kaca: topi, jubah, dan hiasan paling baru.')); c.put(7, 1, 'display', $t('Etalase kaca: topi, jubah, dan hiasan paling baru.'));
    for (x = 5; x <= 8; x++) c.put(x, 3, 'counter', $t('Meja kasir Mall. Bicara di sini untuk berbelanja.'));
    [[2,5],[3,5],[2,6],[3,6],[10,5],[11,5],[10,6],[11,6]].forEach(function(p){ c.put(p[0], p[1], 'rack', $t('Gantungan penuh baju dan jubah cantik.')); });
    c.put(5, 6, 'display', $t('Etalase: peliharaan lucu dan hiasan rumah.')); c.put(8, 6, 'display', $t('Etalase: peliharaan lucu dan hiasan rumah.'));
    c.put(1, 8, 'plant'); c.put(12, 8, 'plant'); c.put(1, 1, 'plant'); c.put(12, 1, 'plant');
    c.rect(6, 4, 7, 8, 'rug');
  }},
  casino: { w:12, h:10, floor:'floor_dark', fill: function(c){
    c.rect(5, 2, 6, 8, 'carpet_red');
    [1,2,3,4,7,8,9,10].forEach(function(sx){ c.put(sx, 1, 'slot', $t('Mesin slot berkedip. Hadiahnya tiket, bukan koin.')); });
    c.put(5, 1, 'roulette', $t('Meja Untung: lempar dadu dengan chip, hanya untuk seru-seruan.')); c.put(6, 1, 'roulette', $t('Meja Untung: lempar dadu dengan chip, hanya untuk seru-seruan.'));
    [[2,4],[3,4],[8,4],[9,4]].forEach(function(p){ c.put(p[0], p[1], 'card_table', $t('Meja kartu. Hanya untuk senang-senang.')); });
    [[2,6],[3,6],[8,6],[9,6]].forEach(function(p){ c.put(p[0], p[1], 'dice_table', $t('Meja dadu. Hanya untuk senang-senang.')); });
    c.put(1, 8, 'plant', $t('Tanaman plastik. Tetap terlihat mewah.')); c.put(10, 8, 'plant', $t('Tanaman plastik. Tetap terlihat mewah.'));
    c.put(1, 3, 'chair'); c.put(10, 3, 'chair');
  }},
  papan: { w:12, h:8, floor:'floor_wood', fill: function(c){
    var x;
    for (x = 3; x <= 8; x++) c.put(x, 1, 'lb_wall', $t('Papan Juara: pedagang terbaik hari ini dan sepanjang masa.'));
    [1,2,9,10].forEach(function(nx){ c.put(nx, 1, 'news_board', $t('Papan berita: kabar terbaru dari seluruh desa.')); });
    c.put(5, 4, 'table', $t('Meja redaksi. Penuh catatan dan tinta.')); c.put(6, 4, 'table', $t('Meja redaksi. Penuh catatan dan tinta.'));
    c.put(4, 4, 'chair'); c.put(7, 4, 'chair');
    c.put(1, 4, 'bookshelf', $t('Arsip berita lama, diikat rapi.')); c.put(10, 4, 'bookshelf', $t('Arsip berita lama, diikat rapi.'));
    c.put(1, 6, 'plant'); c.put(10, 6, 'plant');
    c.rect(5, 2, 6, 3, 'rug');
  }},
  tambangpub: { w:12, h:9, floor:'floor_dark', fill: function(c){
    var x;
    for (x = 1; x <= 10; x++) c.put(x, 1, 'ore_rock', $t('Dinding terowongan penuh bijih berkilau. Tambang sungguhan ada di luar.'));
    [[1,2],[1,3],[10,2],[10,3],[1,5],[10,5]].forEach(function(p){ c.put(p[0], p[1], 'ore_rock', $t('Dinding terowongan penuh bijih berkilau. Tambang sungguhan ada di luar.')); });
    c.put(3, 6, 'crate_i', $t('Peti perkakas penambang.')); c.put(4, 6, 'crate_i', $t('Peti perkakas penambang.')); c.put(8, 6, 'barrel_i', $t('Tong air untuk para penambang.'));
    c.put(5, 3, 'table', $t('Meja peta tambang. Garis-garis bijih ditandai kapur.')); c.put(6, 3, 'table', $t('Meja peta tambang. Garis-garis bijih ditandai kapur.'));
    c.put(7, 3, 'chair'); c.put(8, 4, 'sack', $t('Karung bijih mentah.'));
  }},
  church: { w:12, h:10, floor:'floor_wood', fill: function(c){
    var x, y;
    c.rect(5, 2, 6, 8, 'rug');
    c.put(5, 1, 'table', $t('Meja di depan, dengan lilin dan bunga segar.')); c.put(6, 1, 'table', $t('Meja di depan, dengan lilin dan bunga segar.'));
    c.put(2, 1, 'bookshelf', $t('Buku nyanyian dan doa.')); c.put(9, 1, 'bookshelf', $t('Buku nyanyian dan doa.'));
    for (y = 3; y <= 7; y += 2){ for (x = 2; x <= 4; x++) c.put(x, y, 'pew', $t('Bangku gereja dari kayu jati.')); for (x = 7; x <= 9; x++) c.put(x, y, 'pew', $t('Bangku gereja dari kayu jati.')); }
    c.put(1, 1, 'plant'); c.put(10, 1, 'plant'); c.put(1, 8, 'plant'); c.put(10, 8, 'plant');
  }},
  clinic: { w:12, h:9, floor:'floor_tile', fill: function(c){
    var x;
    [2,4,8,10].forEach(function(bx){ c.put(bx, 1, 'bed', $t('Ranjang periksa yang bersih.')); });
    c.put(6, 1, 'shelf', $t('Rak obat dan perban.'));
    for (x = 4; x <= 7; x++) c.put(x, 4, 'counter', $t('Meja perawat. Antrean pasien selalu rapi.'));
    c.put(1, 4, 'display', $t('Lemari kaca berisi botol obat.')); c.put(10, 4, 'fridge', $t('Lemari pendingin khusus obat.'));
    c.put(1, 7, 'plant'); c.put(10, 7, 'plant');
  }},
  post: { w:12, h:9, floor:'floor_tile', fill: function(c){
    var x;
    for (x = 3; x <= 8; x++) c.put(x, 3, 'counter', $t('Loket pos. Surat dan paket dilayani di sini.'));
    [1,2,9,10].forEach(function(sx){ c.put(sx, 1, 'sack', $t('Karung surat menunggu diantar.')); });
    [4,5,7,8].forEach(function(sx){ c.put(sx, 1, 'shelf', $t('Rak paket.')); });
    c.put(1, 6, 'crate_i', $t('Peti paket siap kirim.')); c.put(10, 6, 'crate_i', $t('Peti paket siap kirim.')); c.put(10, 5, 'sack', $t('Karung surat menunggu diantar.'));
    c.put(1, 3, 'plant');
  }},
  townhall: { w:12, h:9, floor:'floor_wood', fill: function(c){
    c.rect(5, 3, 6, 7, 'rug');
    c.put(5, 2, 'table', $t('Meja kerja walikota, rapi dan penuh stempel.')); c.put(6, 2, 'table', $t('Meja kerja walikota, rapi dan penuh stempel.'));
    c.put(4, 2, 'chair'); c.put(7, 2, 'chair');
    [2,3,4,5,6,7,8,9].forEach(function(bx){ c.put(bx, 1, 'bookshelf', $t('Peraturan dan peta kota.')); });
    c.put(1, 1, 'plant'); c.put(10, 1, 'plant'); c.put(1, 7, 'plant'); c.put(10, 7, 'plant');
    c.put(2, 5, 'table', $t('Meja rapat warga.')); c.put(3, 5, 'chair'); c.put(9, 5, 'table', $t('Meja rapat warga.')); c.put(8, 5, 'chair');
  }},
  kolam: { w:10, h:8, floor:'floor_wood', fill: function(c){
    [2,3,6,7].forEach(function(tx){ c.put(tx, 1, 'tank', $t('Bak ikan segar. Airnya jernih.')); });
    c.put(1, 1, 'barrel_i', $t('Tong garam untuk ikan asin.')); c.put(8, 1, 'barrel_i', $t('Tong garam untuk ikan asin.'));
    c.put(4, 4, 'table', $t('Meja potong ikan.')); c.put(5, 4, 'table', $t('Meja potong ikan.'));
    c.put(1, 4, 'rack', $t('Gantungan jaring dan pancing.')); c.put(8, 5, 'crate_i', $t('Peti es untuk ikan.')); c.put(8, 6, 'crate_i', $t('Peti es untuk ikan.'));
  }},
  tambang: { w:10, h:8, floor:'floor_dark', fill: function(c){
    var x;
    for (x = 1; x <= 8; x++) c.put(x, 1, 'ore_rock', $t('Dinding tambang penuh bijih.'));
    c.put(1, 2, 'ore_rock', $t('Dinding tambang penuh bijih.')); c.put(8, 2, 'ore_rock', $t('Dinding tambang penuh bijih.'));
    c.put(2, 5, 'crate_i', $t('Peti perkakas penambang.')); c.put(3, 5, 'crate_i', $t('Peti perkakas penambang.')); c.put(7, 5, 'barrel_i', $t('Tong air.'));
    c.put(5, 3, 'table', $t('Meja peta tambang.')); c.put(6, 3, 'sack', $t('Karung bijih mentah.'));
  }},
  restoran: { w:12, h:9, floor:'floor_wood', fill: function(c){
    var x;
    c.put(1, 1, 'stove', $t('Kompor besar. Selalu ada sup yang mendidih.')); c.put(2, 1, 'stove', $t('Kompor besar. Selalu ada sup yang mendidih.'));
    c.put(3, 1, 'fridge', $t('Lemari pendingin penuh bahan masakan.')); c.put(4, 1, 'shelf', $t('Rak bumbu dan piring.'));
    for (x = 6; x <= 9; x++) c.put(x, 2, 'counter', $t('Meja pesanan. Makanan hangat siap saji.'));
    c.put(3, 5, 'table', $t('Meja makan. Wangi sup memenuhi ruangan.')); c.put(2, 5, 'chair'); c.put(4, 5, 'chair');
    c.put(8, 5, 'table', $t('Meja makan. Wangi sup memenuhi ruangan.')); c.put(7, 5, 'chair'); c.put(9, 5, 'chair');
    c.put(1, 7, 'plant'); c.put(10, 7, 'plant');
  }},
  rumah: { w:10, h:8, floor:'floor_wood', fill: function(c){
    [1,3,5,7].forEach(function(bx){ c.put(bx, 1, 'bed', $t('Kasur sederhana untuk pekerja yang lelah.')); });
    c.put(8, 1, 'plant'); c.put(8, 3, 'fridge', $t('Isinya bekal untuk besok.'));
    c.put(5, 4, 'table', $t('Meja makan pekerja.')); c.put(4, 4, 'chair'); c.put(6, 4, 'chair');
    c.put(1, 5, 'chest', $t('Peti barang pribadi pekerja.')); c.put(1, 6, 'plant');
  }},
  rumahsakit: { w:14, h:9, floor:'floor_tile', fill: function(c){
    var x;
    [2,4,6,8,10,12].forEach(function(bx){ c.put(bx, 1, 'bed', $t('Ranjang rawat inap yang bersih.')); });
    for (x = 5; x <= 8; x++) c.put(x, 4, 'counter', $t('Meja perawat. Pekerja yang pingsan dirawat di sini.'));
    c.put(1, 3, 'fridge', $t('Lemari pendingin khusus obat.')); c.put(12, 3, 'shelf', $t('Rak obat dan perban.'));
    c.put(1, 7, 'plant'); c.put(12, 7, 'plant'); c.put(11, 5, 'display', $t('Lemari kaca berisi botol obat.'));
  }},
  penggergajian: { w:12, h:9, floor:'floor_wood', fill: function(c){
    var x;
    for (x = 1; x <= 3; x++) c.put(x, 1, 'log', $t('Tumpukan kayu gelondongan.'));
    for (x = 1; x <= 2; x++) c.put(x, 2, 'log', $t('Tumpukan kayu gelondongan.'));
    c.put(9, 1, 'crate_i', $t('Peti papan kayu siap kirim.')); c.put(10, 1, 'crate_i', $t('Peti papan kayu siap kirim.')); c.put(10, 2, 'crate_i', $t('Peti papan kayu siap kirim.'));
    c.put(5, 4, 'table', $t('Meja gergaji. Serbuk kayu di mana-mana.')); c.put(6, 4, 'table', $t('Meja gergaji. Serbuk kayu di mana-mana.'));
    c.put(10, 5, 'barrel_i', $t('Tong minyak untuk mata gergaji.')); c.put(1, 6, 'log', $t('Tumpukan kayu gelondongan.')); c.put(1, 7, 'log', $t('Tumpukan kayu gelondongan.'));
  }},
  kincir: { w:8, h:8, floor:'floor_wood', fill: function(c){
    [1,2,6].forEach(function(sx){ c.put(sx, 1, 'sack', $t('Karung tepung hasil gilingan.')); });
    c.put(1, 2, 'sack', $t('Karung tepung hasil gilingan.')); c.put(6, 2, 'sack', $t('Karung tepung hasil gilingan.'));
    c.put(3, 3, 'table', $t('Batu giling besar yang terus berputar.')); c.put(4, 3, 'table', $t('Batu giling besar yang terus berputar.'));
    c.put(6, 5, 'barrel_i', $t('Tong gandum.')); c.put(1, 5, 'crate_i', $t('Peti gandum.'));
  }},
  gudang: { w:12, h:9, floor:'floor_wood', fill: function(c){
    [1,2,4,5,7,8,10].forEach(function(cx){ c.put(cx, 1, 'crate_i', $t('Peti-peti tersusun rapi sampai ke langit-langit.')); });
    [1,2,10].forEach(function(cx){ c.put(cx, 2, 'barrel_i', $t('Tong penuh bahan simpanan.')); });
    c.put(1, 4, 'crate_i', $t('Peti-peti tersusun rapi sampai ke langit-langit.')); c.put(2, 4, 'crate_i', $t('Peti-peti tersusun rapi sampai ke langit-langit.'));
    c.put(9, 4, 'sack', $t('Karung gandum.')); c.put(10, 4, 'sack', $t('Karung gandum.')); c.put(10, 5, 'sack', $t('Karung gandum.'));
    c.put(1, 6, 'barrel_i', $t('Tong penuh bahan simpanan.')); c.put(10, 7, 'barrel_i', $t('Tong penuh bahan simpanan.'));
    c.put(5, 4, 'table', $t('Meja catatan stok.')); c.put(6, 4, 'table', $t('Meja catatan stok.')); c.put(5, 5, 'chair');
  }}
};
function genRoom(b){
  var sp = ROOMS[b.kind], w = sp.w, hh = sp.h, dx = w >> 1;
  var m = newMap(w, hh, sp.floor, 'interior');
  m.floorKind = sp.floor;
  function I(x,y){ return y*w + x; }
  var x, y;
  for (x = 0; x < w; x++){ m.tiles[I(x,0)] = 'wall'; m.tiles[I(x,hh-1)] = 'wall'; }
  for (y = 0; y < hh; y++){ m.tiles[I(0,y)] = 'wall'; m.tiles[I(w-1,y)] = 'wall'; }
  m.mat = {x:dx, y:hh-1}; m.tiles[I(dx,hh-1)] = 'doormat'; m.exit.add(I(dx,hh-1)); m.entry = {x:dx, y:hh-2};
  m.board = null;
  var c = {
    put: function(px, py, t, txt){ if (px < 1 || py < 1 || px > w-2 || py > hh-2) return; m.tiles[I(px,py)] = t; if (txt) m.info.set(I(px,py), txt); },
    rect: function(x0, y0, x1, y1, t){ for (var yy = y0; yy <= y1; yy++) for (var xx = x0; xx <= x1; xx++) c.put(xx, yy, t); }
  };
  sp.fill(c);
  finalize(m);
  m.npcs = [];
  buildCache(m);
  return m;
}
// Pixel art of the room furniture, registered into the sprite tile table (the 2.5D room reads the same table)
function regRoomTiles(){
  var S = window.SPRITES;
  if (!S || !S._T || S._T.ore_rock) return;
  var K = '#2a2430';
  var A = {
    ore_rock: { pal: { k:K, r:'#7a7486', R:'#5c566a', b:'#58a8e8', g:'#e8c040', h:'#a49eb4' }, rows: [
      '............', '....kkkk....', '..kkhhrrkk..', '.khhrrbrrrk.', '.khrbbrrgrk.', 'krrrrrrggrrk',
      'krbrrrrrrrRk', 'krrrrrrbbrRk', '.krrgrrrbRk.', '.kRrrrrrRRk.', '..kRRRRRRk..', '...kkkkkk...'] },
    lb_wall: { pal: { k:K, W:'#8a5a30', d:'#2c3a44', w:'#e8e2d0', y:'#f0c840', s:'#b0b8c0' }, rows: [
      'kkkkkkkkkkkk', 'kWWWWWWWWWWk', 'kWddddddddWk', 'kWdydwwwwdWk', 'kWddddddddWk', 'kWdsdwwwddWk',
      'kWddddddddWk', 'kWdydwwwwdWk', 'kWddddddddWk', 'kWWWWWWWWWWk', '.kkkkkkkkkk.', '............'] },
    news_board: { pal: { k:K, W:'#8a5a30', c:'#c89a58', w:'#f4f0e0', y:'#f0d048', r:'#d86060', g:'#58a860', p:'#4a4a58' }, rows: [
      '.kkkkkkkkkk.', 'kWWWWWWWWWWk', 'kWccccccccWk', 'kWcwwcyyccWk', 'kWcwpcyyccWk', 'kWccccccrrWk',
      'kWcgggcrrcWk', 'kWcgpgcccwWk', 'kWccccwwpcWk', 'kWWWWWWWWWWk', '.kk......kk.', '............'] },
    roulette: { pal: { k:K, W:'#8a5a30', G:'#2c8a4c', r:'#d83838', b:'#2a2a38', y:'#f0d048', w:'#f4f0e0' }, rows: [
      '............', '.kkkkkkkkkk.', 'kWWWWWWWWWWk', 'kWGGkkkkGGWk', 'kWGkrbrbrkWk', 'kWkbrwywbrkk',
      'kWkrbywwrbkk', 'kWGkbrbrbkWk', 'kWGGkkkkGGWk', 'kWWWWWWWWWWk', '.kkkkkkkkkk.', '............'] },
    rack: { pal: { k:K, s:'#b0b0c0', r:'#d84848', b:'#4878d8', g:'#58b858', y:'#f0d048', p:'#c070c0' }, rows: [
      '............', '.kkkkkkkkkk.', '.kssssssssk.', '.krrbbggyyk.', '.krrbbggyyk.', '.krrbbggyyk.',
      '.kprbbgpyyk.', '.kpr.bgp.yk.', '..kp..bp..k.', '..k...b...k.', '..kkkkkkkkk.', '............'] },
    pew: { pal: { k:K, W:'#8a5a30', w:'#b07840', l:'#cf9658' }, rows: [
      '............', '............', 'kkkkkkkkkkkk', 'kWWWWWWWWWWk', 'kllllllllllk', 'kwwwwwwwwwwk',
      'kkkkkkkkkkkk', '.kwwwwwwwwk.', '.kWWWWWWWWk.', '.kkkkkkkkkk.', '.kk......kk.', '............'] },
    sack: { pal: { k:K, s:'#d8c08a', S:'#b8a068', L:'#8a6a38', t:'#a07838' }, rows: [
      '............', '....kkkk....', '...ktttk....', '....kssk....', '...kSSSSk...', '..kSssssSk..',
      '.kSsssssssk.', '.kSssLLsssk.', '.kSssLLsssk.', '.kSSsssssSk.', '..kkSSSSkk..', '....kkkk....'] },
    crate_i: { pal: { k:K, w:'#c08848', W:'#8a5a30', l:'#dca868' }, rows: [
      '............', '.kkkkkkkkkk.', '.kllllllllk.', '.kWwwwwwwWk.', '.kwWwwwwWwk.', '.kwwWwwWwwk.',
      '.kwwwWWwwwk.', '.kwwWwwWwwk.', '.kwWwwwwWwk.', '.kWwwwwwwWk.', '.kkkkkkkkkk.', '............'] },
    barrel_i: { pal: { k:K, w:'#a8683a', W:'#7a4a28', i:'#5a5a68', l:'#c88850' }, rows: [
      '............', '...kkkkkk...', '..kllllllk..', '.kwwlwwwwwk.', '.kiiiiiiiik.', '.kwwwlwwwwk.',
      '.kwwwwwwwwk.', '.kiiiiiiiik.', '.kWwwwwwwWk.', '..kWWWWWWk..', '...kkkkkk...', '............'] },
    tank: { pal: { k:K, g:'#9ad8e8', G:'#5ab0cc', w:'#d8f4f8', o:'#f08838', W:'#8a5a30' }, rows: [
      '............', '.kkkkkkkkkk.', '.kWWWWWWWWk.', '.kgwggggggk.', '.kgggggoggk.', '.kggGggggok.',
      '.kgggggGggk.', '.kgogggggwk.', '.kGGGGGGGGk.', '.kWWWWWWWWk.', '.kkkkkkkkkk.', '............'] },
    display: { pal: { k:K, s:'#b0b8c8', g:'#bfe4f0', w:'#f4fcff', y:'#f0d048', r:'#d84848', b:'#4878d8', W:'#8a5a30' }, rows: [
      '............', '.kkkkkkkkkk.', '.kwggggggsk.', '.kgggggggsk.', '.kgyggrggbk.', '.kgyyggrrbk.',
      '.kgggggggsk.', '.kssssssssk.', '.kWWWWWWWWk.', '.kWWWWWWWWk.', '.kkkkkkkkkk.', '............'] },
    log: { pal: { k:K, b:'#7a4a28', B:'#5a3418', c:'#d8a868', C:'#b8844c', r:'#8a5a30' }, rows: [
      '............', '............', '.kkkkkkkkkk.', 'kccCbbbbBBBk', 'kcCCbbbbBBBk', 'kccCbbrbBBBk',
      '.kkkkkkkkkk.', 'kccCbbbbBBBk', 'kcCCbbbbBBBk', 'kccCbbrbBBBk', '.kkkkkkkkkk.', '............'] },
    stove: { pal: { k:K, s:'#8a8c9c', S:'#6a6c7c', f:'#f08838', y:'#f8d848', d:'#2a2a34', l:'#b0b2c0' }, rows: [
      '............', '.kkkkkkkkkk.', '.kllllllllk.', '.kdSdddSddk.', '.kdSdddSddk.', '.ksssssssSk.',
      '.kskkkkkksk.', '.kkfyyfkkSk.', '.kkyffykkSk.', '.kksssssssk.', '.kkkkkkkkkk.', '............'] }
  };
  Object.keys(A).forEach(function(t){ S._T[t] = A[t]; if (S._tileTypes && S._tileTypes.indexOf(t) < 0) S._tileTypes.push(t); });
}
regRoomTiles();
/* ROOMS-END */

function genMartInterior(b, martIdx){
  var w = 11, hh = 9;
  var m = newMap(w, hh, 'floor_tile', 'interior');
  function I(x,y){ return y*w + x; }
  var x, y;
  for (x = 0; x < w; x++){ m.tiles[I(x,0)] = 'wall'; m.tiles[I(x,hh-1)] = 'wall'; }
  for (y = 0; y < hh; y++){ m.tiles[I(0,y)] = 'wall'; m.tiles[I(w-1,y)] = 'wall'; }
  m.mat = {x:5, y:hh-1};
  m.tiles[I(5,hh-1)] = 'doormat'; m.exit.add(I(5,hh-1));
  m.entry = {x:5, y:hh-2};
  var shelfTxt = [$t('Rak penuh mie instan dan biskuit.'),$t('Sabun, sampo, dan odol berjejer rapi.'),$t('Camilan keripik aneka rasa.'),$t('Minuman kaleng dingin.')];
  var n = 0;
  for (x = 1; x <= 2; x++){ m.tiles[I(x,1)] = 'shelf'; m.info.set(I(x,1), shelfTxt[n++ % 4]); }
  for (x = 6; x <= 7; x++){ m.tiles[I(x,1)] = 'fridge'; m.info.set(I(x,1), $t('Lemari pendingin: es krim dan susu.')); }
  for (x = 8; x <= 9; x++){ m.tiles[I(x,1)] = 'shelf'; m.info.set(I(x,1), shelfTxt[n++ % 4]); }
  for (x = 4; x <= 5; x++){ m.tiles[I(x,2)] = 'counter'; m.info.set(I(x,2), $t('Meja kasir. Mesin kasirnya berkedip-kedip.')); }
  // staff-only pocket behind the counter (x=4..5, row 1), enclosed by a plant at (3,1), the fridge and the counter
  m.tiles[I(3,1)] = 'plant'; m.info.set(I(3,1), $t('Tanaman hias di belakang kasir.'));
  m.staff = new Set(); for (x = 4; x <= 5; x++) m.staff.add(I(x,1));
  for (y = 4; y <= 5; y++){
    for (x = 2; x <= 4; x++){ m.tiles[I(x,y)] = 'shelf'; m.info.set(I(x,y), shelfTxt[n++ % 4]); }
    for (x = 6; x <= 8; x++){ m.tiles[I(x,y)] = 'shelf'; m.info.set(I(x,y), shelfTxt[n++ % 4]); }
  }
  m.tiles[I(1,7)] = 'plant'; m.info.set(I(1,7), $t('Tanaman hias di dekat pintu.'));
  m.tiles[I(9,7)] = 'plant'; m.info.set(I(9,7), $t('Tanaman hias di dekat pintu.'));
  finalize(m);
  // the pocket is fully enclosed (plant, fridge, counter) and blocked for the player via m.staff.
  var keeper = mkNpc(4, 1, $t('Penjaga Mart'), 3, MART_LINES, {});
  keeper.dir = 'down'; keeper.key = 'mart:' + martIdx + ':keeper';
  m.npcs = [keeper];
  buildCache(m);
  return m;
}

function genCasinoInterior(b){
  var w = 11, hh = 9;
  var m = newMap(w, hh, 'floor_dark', 'interior');
  function I(x,y){ return y*w + x; }
  var x, y;
  for (y = 3; y <= 7; y++) for (x = 4; x <= 6; x++) m.tiles[I(x,y)] = 'carpet_red';
  for (x = 3; x <= 7; x++) m.tiles[I(x,7)] = 'carpet_red';
  for (x = 0; x < w; x++){ m.tiles[I(x,0)] = 'wall'; m.tiles[I(x,hh-1)] = 'wall'; }
  for (y = 0; y < hh; y++){ m.tiles[I(0,y)] = 'wall'; m.tiles[I(w-1,y)] = 'wall'; }
  m.mat = {x:5, y:hh-1};
  m.tiles[I(5,hh-1)] = 'doormat'; m.exit.add(I(5,hh-1));
  m.entry = {x:5, y:hh-2};
  [1,2,3,7,8,9].forEach(function(sx){ m.tiles[I(sx,1)] = 'slot'; });
  [4,5,6].forEach(function(dx){ m.tiles[I(dx,2)] = 'dice_table'; });
  [[2,4],[2,5],[8,4],[8,5]].forEach(function(p){ m.tiles[I(p[0],p[1])] = 'card_table'; });
  m.tiles[I(1,7)] = 'plant'; m.info.set(I(1,7), $t('Tanaman plastik. Tetap terlihat mewah.'));
  m.tiles[I(9,7)] = 'plant'; m.info.set(I(9,7), $t('Tanaman plastik. Tetap terlihat mewah.'));
  m.staff = new Set(); [4,5,6].forEach(function(sx){ m.staff.add(I(sx,1)); });
  finalize(m);
  var dealer = mkNpc(5, 1, $t('Bandar'), 6, CASINO_LINES, {});
  dealer.dir = 'down'; dealer.key = 'casino:dealer';
  m.npcs = [dealer];
  buildCache(m);
  return m;
}

/* ---------- NPCs ---------- */
function mkNpc(x, y, name, pal, lines, o){
  o = o || {};
  return { x:x, y:y, fx:x, fy:y, dir:'down', moving:false, t:0, flip:false, pal:pal, name:name, lines:lines,
    wait:0.5 + Math.random()*2, talking:false, home:{x:x, y:y}, leash:o.leash || 0, wander:!!o.wander, turns:!!o.turns,
    key:o.key || null, follow:false, script:null, hidden:false, bubble:null, label:o.label || null, spd:0, lastTalk:-1e9 };
}

/* ---------- state ---------- */
var world = null, scene = null, outScene = null, seed = 0;
var interiors = new Map();
var P = { x:0, y:0, fx:0, fy:0, dir:'down', moving:false, t:0, flip:false, turnT:0 };
var held = [];            // stack of held directions
var waitRelease = false;
var D = null;             // dialog state
var mapOpen = false;
var tr = null;            // transition
var timeAcc = 0;
var gameMin = 8 * 60;     // in-game minutes since day 1 00:00
var dayLength = 10;       // real minutes per full 24h game day (1..60); game minutes per real second = 24 / dayLength
var timePaused = false, devEnabled = false;
var VW = 180, VH = 132, S = 2;
var booted = false;
var hudDirty = true;
var modals = [];

function makeOutScene(){
  var npcs = [], sp = homeLayout ? [] : world.npcSpawns, n = 0; // Homelands start without townsfolk
  for (var i = 0; i < sp.length && npcs.length < 8; i++){
    var x = sp[i][0], y = sp[i][1];
    // keep NPCs spread out: not too close to another NPC
    var close = false;
    for (var j = 0; j < npcs.length; j++) if (Math.abs(npcs[j].x - x) + Math.abs(npcs[j].y - y) < 6) close = true;
    if (close) continue;
    var name = FIRST[(world.seed + n * 13 + i) % FIRST.length];
    var npc = mkNpc(x, y, name, 1 + (n % 5), NPC_LINES.map(function(l){ return [l]; }), {wander:true, leash:9});
    npc.key = 'out:' + n;
    npc.dir = pickRand(DIRLIST);
    npcs.push(npc); n++;
  }
  return { kind:'out', map:world, npcs:npcs, name:null, key:'out' };
}

function regen(s){
  seed = (s == null) ? randomSeed() : (s >>> 0);
  world = genWorld(seed);
  interiors = new Map();
  scene = makeOutScene();
  outScene = scene;
  P.x = P.fx = world.spawn.x; P.y = P.fy = world.spawn.y; P.dir = 'down'; P.moving = false; P.t = 0; P.turnT = 0;
  closeDialog(true); setMap(false); tr = null;
  waitRelease = held.length > 0;
  hudDirty = true;
  save();
  if (booted){
    callMods('onWorld', [world]);
    emit('world', world);
    callMods('onSceneEnter', [scene]);
    emit('scene', scene);
  }
  return seed;
}

/** Swaps the outdoor world: 'public' (the village) or 'HL-<id>' with a GTHomeland layout (GTHomeland.generate). Fires onWorld
    for every mod (remote players and island-only things die with the old scenes). The caller places the player. */
function switchWorld(id, layout){
  id = String(id || 'public');
  if (id !== 'public' && !(/^HL-\d+$/.test(id) && layout && layout.tiles && window.GTHomeland)) return false;
  held.length = 0;
  worldId = id; homeLayout = id === 'public' ? null : layout;
  regen(seed);
  return true;
}

function houseScene(b){
  var key = b.kind + ':' + (b.id != null ? b.id : (b.bx + '_' + b.by));
  var sc = interiors.get(key);
  if (!sc){
    var m, kind = b.kind;
    var villageCasino = kind === 'casino' && !!world.layout; // the village casino is a new building with its own room; the old play-coin casino stays legacy
    if (kind === 'mart') m = genMartInterior(b, world.marts.indexOf(b));
    else if (kind === 'casino' && !villageCasino) m = genCasinoInterior(b);
    else if (ROOMS[kind]) m = genRoom(b);
    else if (PUBLIC_KINDS[kind]) m = genPublicInterior(b);
    else m = genHouseInterior(b);
    // scene.kind 'kasino' (not 'casino') keeps the legacy play-coin casino code (casino.js, dealer, "Meja belum dibuka") off the new room
    sc = { kind:villageCasino ? 'kasino' : kind, map:m, npcs:m.npcs, house:b, key:key, name:null };
    interiors.set(key, sc);
  }
  return sc;
}

function allScenes(){ var a = [outScene]; interiors.forEach(function(sc){ a.push(sc); }); return a; }
function resolveScene(ref){
  if (ref == null) return scene;
  if (typeof ref === 'string'){
    if (ref === 'out' || ref === 'outdoor') return outScene;
    var found = null;
    allScenes().forEach(function(sc){ if (sc && sc.key === ref) found = sc; });
    if (found) return found;
    if (ref === 'casino' && world && world.casino) return houseScene(world.casino);
    var mm = /^(house|mart|casino):(.+)$/.exec(ref);
    if (mm && world){
      var bb = world.buildings.filter(function(b){ return b.kind === mm[1] && (mm[1] === 'house' ? String(b.id) === mm[2] : (mm[1] === 'casino' || String(world.marts.indexOf(b)) === mm[2])); })[0];
      if (bb) return houseScene(bb);
    }
    // any other room key is 'kind:id' (kind of a public building, id its lot or kind): the scene of that building
    var pk = /^([a-z]+):(.+)$/.exec(ref);
    if (pk && world && PUBLIC_KINDS[pk[1]]){
      var pb = world.buildings.filter(function(b){ return b.kind === pk[1] && String(b.id != null ? b.id : (b.bx + '_' + b.by)) === pk[2]; })[0];
      if (pb) return houseScene(pb);
    }
    return null;
  }
  if (ref.map && ref.npcs) return ref;
  if (ref.dx != null && ref.kind) return houseScene(ref);
  return null;
}

/* ---------- collision ---------- */
function inb(m,x,y){ return x >= 0 && y >= 0 && x < m.w && y < m.h; }
function npcAtTile(x, y, sc){
  sc = sc || scene;
  for (var i = 0; i < sc.npcs.length; i++){
    var n = sc.npcs[i];
    if (n.hidden) continue;
    if ((n.x === x && n.y === y) || (n.moving && n.fx === x && n.fy === y)) return n;
  }
  return null;
}
function playerAt(x, y){ return (P.x === x && P.y === y) || (P.moving && P.fx === x && P.fy === y); }
function canEnterPlayer(x, y){
  var m = scene.map;
  // Hackathon change: the player may walk through other characters, so nobody can block a path.
  return inb(m,x,y) && m.walk[y*m.w + x] === 1 && !(m.staff && m.staff.has(y*m.w + x));
}
function canEnterNpc(n, x, y, allowDF, sc){
  sc = sc || scene;
  var m = sc.map;
  if (!inb(m,x,y) || m.walk[y*m.w + x] !== 1) return false;
  if (sc === scene && playerAt(x,y)) return false;
  var o = npcAtTile(x,y,sc); if (o && o !== n) return false;
  if (!allowDF && m.doorFront && m.doorFront.has(y*m.w + x)) return false;
  return true;
}

/* ---------- pathfinding / NPC script control ---------- */
function findPath(sc, from, to, opt){
  sc = resolveScene(sc); if (!sc || !from || !to) return null;
  var m = sc.map, W = m.w, H = m.h;
  var sx = Math.round(from.x), sy = Math.round(from.y), tx = Math.round(to.x), ty = Math.round(to.y);
  if (![sx, sy, tx, ty].every(isFinite)) return null;
  if (!inb(m, sx, sy) || !inb(m, tx, ty)) return null;
  if (m.walk[ty*W + tx] !== 1) return null;
  if (sx === tx && sy === ty) return [];
  var prev = new Int32Array(W * H).fill(-1), q = [sy*W + sx], head = 0, goal = ty*W + tx, avoid = opt && opt.avoid;
  prev[sy*W + sx] = sy*W + sx;
  while (head < q.length){
    var cur = q[head++];
    if (cur === goal) break;
    var cx = cur % W, cy = (cur / W) | 0;
    for (var d = 0; d < 4; d++){
      var dv = DIRS[DIRLIST[d]], nx = cx + dv[0], ny = cy + dv[1];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      var ni = ny*W + nx;
      if (prev[ni] !== -1 || m.walk[ni] !== 1) continue;
      if (avoid && ni !== goal && avoid(nx, ny)) continue;
      prev[ni] = cur; q.push(ni);
    }
  }
  if (prev[goal] === -1) return null;
  var path = [], c = goal, start = sy*W + sx;
  while (c !== start){ path.push({x:c % W, y:(c / W) | 0}); c = prev[c]; }
  return path.reverse();
}

function startNpcStep(n, dx, dy, spd){
  n.dir = dx > 0 ? 'right' : dx < 0 ? 'left' : dy > 0 ? 'down' : 'up';
  n.fx = n.x; n.fy = n.y; n.x += dx; n.y += dy; n.moving = true; n.t = 0; n.flip = !n.flip; n.spd = spd || 0;
}
function finishScript(n, ok){
  var s = n.script; if (!s) return;
  n.script = null; n.wait = 0.5; n.spd = 0;
  n.home = {x:n.x, y:n.y};
  if (s.done){ try { s.done(!!ok); } catch(e){ console.error('[GT] npcGo callback', e); } }
}
function npcGo(npc, path, done){
  if (!npc){ if (done) done(false); return false; }
  if (npc.script) finishScript(npc, false);
  var arr = [];
  if (Array.isArray(path)) path.forEach(function(p){ if (p && isFinite(p.x) && isFinite(p.y)) arr.push({x:Math.round(p.x), y:Math.round(p.y)}); });
  npc.script = { path:arr, i:0, stuck:0, done:done || null };
  if (!arr.length) setTimeout(function(){ if (npc.script && !npc.script.path.length) finishScript(npc, true); }, 0);
  return true;
}
function stepScript(sc, n, dt){
  var s = n.script;
  if (s.i >= s.path.length){ finishScript(n, true); return; }
  var nx = s.path[s.i];
  if (nx.x === n.x && nx.y === n.y){ s.i++; return; }
  if (Math.abs(nx.x - n.x) + Math.abs(nx.y - n.y) !== 1){
    for (var j = 0; j < s.path.length; j++) if (s.path[j].x === n.x && s.path[j].y === n.y){ s.i = j + 1; return; }
    finishScript(n, false); return;
  }
  if (canEnterNpc(n, nx.x, nx.y, true, sc)){
    startNpcStep(n, nx.x - n.x, nx.y - n.y, NPC_FAST); s.i++; s.stuck = 0;
  } else {
    n.dir = nx.x > n.x ? 'right' : nx.x < n.x ? 'left' : nx.y > n.y ? 'down' : 'up';
    s.stuck += dt;
    if (s.stuck > 6) finishScript(n, false);
  }
}
function stepFollow(sc, n, dt){
  var dist = Math.abs(n.x - P.x) + Math.abs(n.y - P.y);
  if (dist <= 1){
    if (dist === 1) n.dir = P.x > n.x ? 'right' : P.x < n.x ? 'left' : P.y > n.y ? 'down' : 'up';
    return;
  }
  var goal = {x:P.x, y:P.y};
  var path = findPath(sc, n, goal, {avoid:function(x, y){ var o = npcAtTile(x, y, sc); return !!o && o !== n; }}) || findPath(sc, n, goal);
  if (!path || !path.length) return;
  var nx = path[0];
  if (canEnterNpc(n, nx.x, nx.y, true, sc)) startNpcStep(n, nx.x - n.x, nx.y - n.y, dist > 3 ? 0.12 : NPC_FAST);   // catch up when far behind
  else n.dir = nx.x > n.x ? 'right' : nx.x < n.x ? 'left' : nx.y > n.y ? 'down' : 'up';
}
function npcFollow(npc, on){
  if (!npc) return;
  npc.follow = !!on;
  if (!on){ npc.wait = 1; npc.home = {x:npc.x, y:npc.y}; npc.spd = 0; if (!npc.wander){ npc.wander = true; npc.leash = Math.max(npc.leash || 0, 3); } }
}
function npcSay(npc, text){
  if (!npc || text == null) return;
  npc.bubble = { text:String(text).slice(0, 140), t:3 };
}

/* nearest free walkable tile around (x,y): not occupied, not exit/doorFront/staff */
function freeTileNear(sc, x, y, extraBlock){
  var m = sc.map, W = m.w, seen = new Uint8Array(W * m.h), q = [x, y], head = 0;
  if (!inb(m, x, y)) return null;
  seen[y*W + x] = 1;
  while (head < q.length){
    var cx = q[head++], cy = q[head++], i = cy*W + cx;
    var ok = m.walk[i] === 1 && !(cx === x && cy === y) && !m.exit.has(i) && !(m.doorFront && m.doorFront.has(i)) && !(m.staff && m.staff.has(i))
      && !npcAtTile(cx, cy, sc) && !(sc === scene && playerAt(cx, cy)) && !(extraBlock && extraBlock(cx, cy));
    if (ok) return {x:cx, y:cy};
    for (var d = 0; d < 4; d++){
      var dv = DIRS[DIRLIST[d]], nx = cx + dv[0], ny = cy + dv[1];
      if (!inb(m, nx, ny)) continue;
      var ni = ny*W + nx; if (seen[ni]) continue;
      if (m.walk[ni] !== 1 && !(nx === x && ny === y)) { seen[ni] = 1; continue; }
      seen[ni] = 1; q.push(nx, ny);
    }
  }
  return null;
}
function placeNpc(sc, n, x, y){
  n.x = n.fx = x; n.y = n.fy = y; n.moving = false; n.t = 0; n.home = {x:x, y:y};
}
function evictAt(sc, x, y, except){
  for (var i = 0; i < sc.npcs.length; i++){
    var n = sc.npcs[i];
    if (n === except || n.hidden) continue;
    if ((n.x === x && n.y === y) || (n.moving && n.fx === x && n.fy === y)){
      var t = freeTileNear(sc, x, y);
      if (t) placeNpc(sc, n, t.x, t.y);
    }
  }
}
function removeNpcFromScenes(npc){
  allScenes().forEach(function(sc){ var i = sc.npcs.indexOf(npc); if (i >= 0) sc.npcs.splice(i, 1); });
}
function npcSceneOf(npc){
  var r = null; allScenes().forEach(function(sc){ if (sc.npcs.indexOf(npc) >= 0) r = sc; }); return r;
}

/* single place that changes the active scene; followers come along */
function setScene(sc, x, y, dir){
  var old = scene, fol = [];
  if (old && old !== sc) fol = old.npcs.filter(function(n){ return n.follow && !n.hidden; });
  fol.forEach(function(n){ var i = old.npcs.indexOf(n); if (i >= 0) old.npcs.splice(i, 1); });
  scene = sc;
  P.x = P.fx = x; P.y = P.fy = y; P.dir = dir || P.dir; P.moving = false; P.t = 0; P.turnT = 0;
  evictAt(sc, x, y, null);
  fol.forEach(function(n){
    if (n.script) finishScript(n, false);
    var t = freeTileNear(sc, x, y) || {x:x, y:y};
    placeNpc(sc, n, t.x, t.y);
    n.dir = P.dir === 'up' ? 'up' : 'down';
    sc.npcs.push(n);
  });
  waitRelease = held.length > 0; hudDirty = true;
  if (booted){ callMods('onSceneEnter', [sc]); emit('scene', sc); }
}

/* ---------- dialog ---------- */
var elSm, elDlg, elTxt, elWho, elNext, elLoc, elSeed, elMap, elMM, elCv, elScreen, elFit, elFx, elCoins, elClock, elRole, elClan, elHud, elActs, elMroot, elToasts, elApp;
function openDialog(pages, who, npc, after){
  if (typeof pages === 'string') pages = [pages];
  if (!pages || !pages.length) return;
  D = { pages:pages, i:0, shown:0, acc:0, done:false, who:who || '', npc:npc || null, after:after || null };
  if (npc){ npc.talking = true; npc._eng = true; }
  elDlg.classList.add('on');
  elWho.textContent = D.who; elWho.classList.toggle('on', !!D.who);
  elWho.setAttribute('data-hearts', (npc && D.who && !npc.noAffinity) ? hearts(npc) : '');
  renderDialog();
}
function renderDialog(){
  if (!D) return;
  var s = D.pages[D.i], n = Math.min(D.shown, s.length);
  elTxt.textContent = '';
  var a = document.createElement('span'); a.textContent = s.slice(0, n);
  var b = document.createElement('span'); b.className = 'h'; b.textContent = s.slice(n);
  elTxt.appendChild(a); elTxt.appendChild(b);
  var more = D.done && D.i < D.pages.length - 1;
  elNext.classList.toggle('on', more);
}
function closeDialog(silent){
  if (!D) return;
  var d = D;
  if (d.npc){ d.npc.talking = false; d.npc._eng = false; d.npc.wait = 1; }
  D = null;
  elDlg.classList.remove('on'); elWho.classList.remove('on'); elNext.classList.remove('on');
  if (held.length) waitRelease = true;
  if (!silent){
    emit('dialogClose', {who:d.who, npc:d.npc});
    if (d.after){ try { d.after(); } catch(e){ console.error('[GT] dialog callback', e); } }
  }
}
function advanceDialog(){
  if (!D) return;
  var s = D.pages[D.i];
  if (!D.done){ D.shown = s.length; D.done = true; renderDialog(); return; }
  if (D.i < D.pages.length - 1){ D.i++; D.shown = 0; D.acc = 0; D.done = false; renderDialog(); }
  else closeDialog();
}
function updateDialog(dt){
  if (!D || D.done) return;
  D.acc += dt;
  var s = D.pages[D.i], n = Math.min(s.length, Math.floor(D.acc * CPS));
  if (n !== D.shown){ D.shown = n; if (n >= s.length) D.done = true; renderDialog(); }
}

/* ---------- toasts ---------- */
function toast(text){
  if (text == null || !elToasts) return;
  var msg = String(text).slice(0, 600); // long messages wrap in full (the chip has no height limit); they stay up longer
  var ms = Math.min(12000, 2400 + Math.max(0, msg.length - 40) * 55);
  // the same message again just stays up longer instead of stacking copies
  for (var i = 0; i < elToasts.children.length; i++){
    var c = elToasts.children[i];
    if (c.textContent === msg){ clearTimeout(c._gtT); c._gtT = setTimeout(function(){ if (c.parentNode) c.parentNode.removeChild(c); }, ms); emit('toast', msg); return; }
  }
  var t = el('div', 'toast', msg);
  elToasts.appendChild(t);
  while (elToasts.children.length > 3) elToasts.removeChild(elToasts.firstChild);
  t._gtT = setTimeout(function(){ if (t.parentNode) t.parentNode.removeChild(t); }, ms);
  emit('toast', String(text));
}

/* ---------- modal system ---------- */
var modalSeq = 0;
var FOCUSABLE = 'button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])';
function setContent(node, c){
  node.textContent = '';
  if (c == null) return;
  if (typeof c === 'string'){
    c.split('\n').forEach(function(line){ node.appendChild(el('p', null, line)); });
  } else if (c.nodeType) node.appendChild(c);
}
function focusables(box){
  return Array.prototype.filter.call(box.querySelectorAll(FOCUSABLE), function(e){ return e.offsetParent !== null && !e.closest('[inert]'); });
}
function modal(o){
  o = o || {};
  var h = { id:++modalSeq, opts:o, closed:false };
  var over = el('div', 'mover'), box = el('div', 'mbox' + (o.wide ? ' wide' : ''));
  box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.tabIndex = -1;
  var head = el('div', 'mhead'), title = el('h2', 'mtitle', o.title || '');
  title.id = 'mt' + h.id; box.setAttribute('aria-labelledby', title.id);
  head.appendChild(title);
  if (o.closable !== false){
    var x = el('button', 'mx', '×'); x.type = 'button'; x.setAttribute('aria-label', $t('Tutup'));
    x.addEventListener('click', function(){ h.close('x'); });
    head.appendChild(x);
  }
  var body = el('div', 'mbody'), foot = el('div', 'mfoot');
  setContent(body, o.body);
  box.appendChild(head); box.appendChild(body); box.appendChild(foot);
  over.appendChild(box);
  // a click on the dimmed backdrop closes the modal, except sticky ones (payments, confirmations, trade, typed words)
  over.addEventListener('pointerdown', function(e){ if (e.target === over && !o.sticky && o.closable !== false) h.close('backdrop'); });
  h.el = over; h.box = box; h.body = body; h.foot = foot; h.title = title;
  h.isOpen = function(){ return !h.closed; };
  h.setBody = function(c){ setContent(body, c); };
  h.setTitle = function(t){ title.textContent = t; };
  h.btn = function(id){ return foot.querySelector('[data-id="' + id + '"]'); };
  h.setActions = function(list){
    foot.textContent = '';
    (list || []).forEach(function(a){
      var b = el('button', 'mbtn' + (a.primary ? ' primary' : ''), a.label); b.type = 'button';
      if (a.id != null) b.setAttribute('data-id', a.id);
      if (a.disabled) b.disabled = true;
      b.addEventListener('click', function(ev){
        var r;
        if (a.onClick){ try { r = a.onClick(h, ev); } catch(e){ console.error('[GT] modal action', e); } }
        if (!a.onClick || a.close || r === true) h.close('action');
      });
      foot.appendChild(b);
    });
  };
  h.close = function(reason){ closeModal(h, reason || 'close'); };
  h.setActions(o.actions);
  modals.push(h);
  elMroot.appendChild(over);
  syncModalStack();
  if (modals.length === 1 && booted){ held.length = 0; }
  // initial focus
  setTimeout(function(){ if (!h.closed && modals[modals.length - 1] === h) focusInto(h); }, 0);
  focusInto(h);
  try { window.GT_SFX && GT_SFX.play('ui_open'); } catch(e){}
  emit('modalOpen', {id:h.id});
  return h;
}
function focusInto(h){
  var tgt = h.box.querySelector('[data-autofocus]') || h.foot.querySelector('.primary') || h.body.querySelector('button,input') || h.foot.querySelector('button') || h.box.querySelector('.mx');
  try { (tgt || h.box).focus({preventScroll:true}); } catch(e){}
}
function syncModalStack(){
  modals.forEach(function(m, i){ m.el.classList.toggle('under', i !== modals.length - 1); });
  var any = modals.length > 0;
  if (elApp){ if (any) elApp.setAttribute('inert', ''); else elApp.removeAttribute('inert'); }
}
function closeModal(h, reason){
  if (h.closed) return;
  h.closed = true;
  var i = modals.indexOf(h); if (i >= 0) modals.splice(i, 1);
  if (h.el.parentNode) h.el.parentNode.removeChild(h.el);
  syncModalStack();
  if (modals.length){ focusInto(modals[modals.length - 1]); }
  else {
    try { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); } catch(e){}
    if (held.length) waitRelease = true;
  }
  if (h.opts.onClose){ try { h.opts.onClose(reason); } catch(e){ console.error('[GT] modal onClose', e); } }
  try { window.GT_SFX && GT_SFX.play('ui_close'); } catch(e){}
  emit('modalClose', {id:h.id, reason:reason});
}
function closeAllModals(){ modals.slice().reverse().forEach(function(m){ m.close('all'); }); }
function modalKey(e){
  var top = modals[modals.length - 1];
  if (!top) return;
  if (e.key === 'Escape' || e.code === 'Escape'){
    if (top.opts.onKey){ try { if (top.opts.onKey(e) === true){ e.preventDefault(); return; } } catch(err){ console.error(err); } }
    if (top.opts.closable !== false){ e.preventDefault(); top.close('esc'); }
    return;
  }
  if (e.key === 'Tab'){
    var f = focusables(top.box);
    if (!f.length){ e.preventDefault(); top.box.focus(); return; }
    var first = f[0], last = f[f.length - 1], act = document.activeElement;
    if (!top.box.contains(act)){ e.preventDefault(); first.focus(); }
    else if (e.shiftKey && (act === first || act === top.box)){ e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && act === last){ e.preventDefault(); first.focus(); }
    return;
  }
  if (top.opts.onKey){
    try { if (top.opts.onKey(e) === true){ e.preventDefault(); e.stopPropagation(); return; } } catch(err){ console.error(err); }
  }
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && document.activeElement && document.activeElement.classList.contains('mopt')){
    var opts = Array.prototype.slice.call(top.box.querySelectorAll('.mopt')), k = opts.indexOf(document.activeElement);
    if (k >= 0){ e.preventDefault(); opts[(k + (e.key === 'ArrowDown' ? 1 : opts.length - 1)) % opts.length].focus(); }
  }
}
function menu(title, options){
  options = options || [];
  var list = el('div', 'mlist'), h;
  options.forEach(function(o, i){
    var b = el('button', 'mbtn mopt', (i < 9 ? (i + 1) + '. ' : '')); b.type = 'button';
    if (o.icon){ var ic = el('span', 'mopt-ic', o.icon); ic.setAttribute('aria-hidden', 'true'); b.appendChild(ic); } // o.icon: an emoji before the words
    b.appendChild(document.createTextNode(o.label));
    if (o.disabled) b.disabled = true;
    b.addEventListener('click', function(){ h.close('pick'); if (o.onPick){ try { o.onPick(); } catch(e){ console.error('[GT] menu pick', e); } } });
    list.appendChild(b);
  });
  h = modal({ title:title, body:list, onKey:function(e){
    if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey){
      var idx = +e.key - 1, btn = list.children[idx];
      if (btn && !btn.disabled){ btn.click(); return true; }
    }
    return false;
  }});
  var first = list.querySelector('button:not([disabled])'); if (first) first.setAttribute('data-autofocus', '');
  focusInto(h);
  return h;
}
function isUiOpen(){ return !!D || modals.length > 0 || mapOpen || !!tr; }

/* ---------- icons ---------- */
function iconEl(id, size){
  size = Math.max(8, Math.floor((size || 16) / 8) * 8);
  var c = document.createElement('canvas'); c.width = c.height = size; c.style.width = c.style.height = size + 'px';
  c.setAttribute('aria-hidden', 'true');
  var g = c.getContext('2d'); g.imageSmoothingEnabled = false;
  try {
    if (SPRITES.drawIcon) SPRITES.drawIcon(g, id, 0, 0, size);
    else throw new Error('no icons');
  } catch(e){
    g.fillStyle = '#6b6e8f'; g.fillRect(1, 1, size - 2, size - 2);
    g.fillStyle = '#fff'; g.font = (size - 4) + 'px monospace'; g.textBaseline = 'top'; g.fillText(String(id).charAt(0).toUpperCase(), 3, 1);
  }
  return c;
}
function itemName(id){ return (ITEMS[id] && ITEMS[id].name) || id; }

/* ---------- Tas (inventory) / Profil / Peran / Toko / konfirmasi ---------- */
function openBag(){
  if (modals.length || tr) return null;
  var h = modal({ title:$t('Tas'), actions:[{label:$t('Tutup'), primary:true}] });
  function render(){
    var wrap = el('div');
    var money = el('div', 'mmoney', $t('Koin: {0}', [state.coins])); wrap.appendChild(money);
    var ids = Object.keys(state.inventory).filter(function(k){ return state.inventory[k] > 0; });
    if (!ids.length) wrap.appendChild(el('p', 'mnote', $t('Tasmu kosong. Beli sesuatu di Mart!')));
    ids.forEach(function(id){
      var row = el('div', 'mrow');
      row.appendChild(iconEl((ITEMS[id] && ITEMS[id].icon) || id, 16));
      row.appendChild(el('span', 'grow', itemName(id)));
      row.appendChild(el('span', 'num', 'x' + state.inventory[id]));
      var use = el('button', 'mbtn', CONSUMABLE[id] ? $t('Makan') : $t('Pakai')); use.type = 'button';
      use.addEventListener('click', function(){ useItem(id); render(); });
      var give = el('button', 'mbtn', $t('Beri')); give.type = 'button';
      give.addEventListener('click', function(){
        var handled = false;
        try { if (typeof GT.giveHandler === 'function') handled = GT.giveHandler(id) === true; } catch(e){ console.error(e); }
        emit('giveRequest', {item:id});
        if (!handled) toast($t('Beri {0}: pakai menu Sosial atau bicara dengan NPC.', [itemName(id)]));
      });
      row.appendChild(use); row.appendChild(give);
      wrap.appendChild(row);
    });
    h.setBody(wrap);
  }
  render();
  var offInv = on('inventory', function(){ if (h.isOpen()) render(); });
  var offCoin = on('coins', function(){ if (h.isOpen()) render(); });
  h.opts.onClose = function(){ offInv(); offCoin(); };
  return h;
}
function useItem(id){
  var def = ITEMS[id] || {};
  if (typeof def.use === 'function'){
    var ok = false, keep = false; try { var ur = def.use(GT); ok = ur === true; keep = ur === 'keep'; } catch(e){ console.error(e); }
    if (keep) return;   // 'keep': handled (toast shown) but the item is not consumed
    if (ok){ removeItem(id, 1); return; }
  }
  if (CONSUMABLE[id] && removeItem(id, 1)){ toast(CONSUMABLE[id]); return; }
  toast($t('{0} belum bisa dipakai sekarang.', [itemName(id)]));
}
function roleLabel(r){ return r === 'maling' ? $t('MALING') : $t('WARGA'); }
function openProfile(){
  if (modals.length || tr) return null;
  var wrap = el('div');
  var f1 = el('label', 'mfield'); f1.appendChild(el('span', null, $t('Nama')));
  var inp = el('input'); inp.type = 'text'; inp.maxLength = 16; inp.value = state.playerName; inp.autocomplete = 'off'; inp.setAttribute('data-autofocus', ''); inp.id = 'profname';
  f1.appendChild(inp); wrap.appendChild(f1);
  var f2 = el('div', 'mfield'); f2.appendChild(el('span', null, $t('Peran')));
  var seg = el('div', 'mseg'); seg.setAttribute('role', 'radiogroup');
  [['warga', $t('Warga')], ['maling', $t('Maling')]].filter(function(r){ return r[0] !== 'maling' || thiefOn(); }).forEach(function(r){
    var lab = el('label'), rb = el('input'); rb.type = 'radio'; rb.name = 'perans'; rb.value = r[0]; rb.checked = state.role === r[0];
    lab.appendChild(rb); lab.appendChild(el('span', null, r[1])); seg.appendChild(lab);
  });
  f2.appendChild(seg); wrap.appendChild(f2);
  if (thiefOn()) wrap.appendChild(el('p', 'mnote', $t('Maling bisa membongkar kunci rumah (butuh obeng), tapi berisiko ketahuan dan reputasi turun.')));
  wrap.appendChild(el('p', null, $t('Reputasi: {0}', [state.reputation])));
  wrap.appendChild(el('p', null, $t('Klan: {0}', [state.clan ? '[' + state.clan.tag + '] ' + state.clan.name : '-'])));
  wrap.appendChild(el('p', null, $t('Koin: {0}', [state.coins])));
  var h = modal({ title:$t('Profil'), body:wrap, sticky:true, actions:[
    {label:$t('Batal')},
    {label:$t('Simpan'), primary:true, onClick:function(m){
      var nm = (inp.value || '').trim().slice(0, 16) || $t('Kamu');
      state.playerName = nm;
      var sel = seg.querySelector('input:checked'); if (sel) setRole(sel.value);
      save(); hudDirty = true; toast($t('Profil disimpan.')); m.close('save');
    }}
  ]});
  inp.addEventListener('keydown', function(e){ if (e.key === 'Enter'){ e.preventDefault(); h.btn && h.foot.querySelector('.primary').click(); } });
  return h;
}
function openRoleChoice(){
  var wrap = el('div');
  wrap.appendChild(el('p', null, $t('Selamat datang di Genesis Town! Pilih perananmu. Kamu bisa mengubahnya nanti di menu Profil.')));
  var b1 = el('button', 'choice'); b1.type = 'button'; b1.setAttribute('data-autofocus', '');
  b1.appendChild(el('b', null, $t('Warga'))); b1.appendChild(document.createTextNode($t('Hidup normal: belanja, mengobrol, bermain.')));
  var b2 = el('button', 'choice'); b2.type = 'button';
  b2.appendChild(el('b', null, $t('Maling'))); b2.appendChild(document.createTextNode($t('Bisa membongkar kunci rumah, tapi reputasi berisiko.')));
  wrap.appendChild(b1); wrap.appendChild(b2);
  var h = modal({ title:$t('Pilih peran'), body:wrap, closable:false });
  function pick(r){ setRole(r); state.onboarded = true; save(); h.close('pick'); toast($t('Peran: {0}.', [roleLabel(r).toLowerCase()])); }
  b1.addEventListener('click', function(){ pick('warga'); });
  b2.addEventListener('click', function(){ pick('maling'); });
  onboardModal = h;
  return h;
}
var onboardModal = null;
function thiefOn(){ return !!(window.GT_FLAGS && window.GT_FLAGS.thief); }
function skipOnboarding(){
  state.onboarded = true; save();
  if (onboardModal && onboardModal.isOpen()) onboardModal.close('skip');
  onboardModal = null;
}
function shopItems(){
  var ids = SHOP_CORE.slice();
  Object.keys(ITEMS).forEach(function(k){ if (ITEMS[k] && ITEMS[k].shop && ids.indexOf(k) < 0) ids.push(k); });
  return ids.filter(function(k){ return ITEMS[k] && ITEMS[k].price > 0; });
}
function openShop(keeper){
  if (modals.length) return null;
  var h = modal({ title:$t('Mart Genesis'), sticky:true, actions:[{label:$t('Selesai'), primary:true}] });
  function render(){
    var wrap = el('div');
    wrap.appendChild(el('div', 'mmoney', $t('Koin: {0}', [state.coins])));
    shopItems().forEach(function(id){
      var it = ITEMS[id], row = el('div', 'mrow');
      row.appendChild(iconEl(it.icon || id, 16));
      var g = el('span', 'grow', it.name); row.appendChild(g);
      row.appendChild(el('span', 'num', $t('{0} koin', [it.price])));
      var b = el('button', 'mbtn', $t('Beli')); b.type = 'button'; b.setAttribute('data-id', 'buy-' + id);
      b.disabled = state.coins < it.price;
      b.addEventListener('click', function(){
        if (!spendCoins(it.price)){ toast($t('Koin tidak cukup.')); return; }
        addItem(id, 1);
        if (keeper) addAffinity(keeper, 1);
        toast($t('Membeli {0}.', [it.name]));
        render();
      });
      row.appendChild(b); wrap.appendChild(row);
    });
    var have = Object.keys(state.inventory).filter(function(k){ return state.inventory[k] > 0; }).map(function(k){ return itemName(k) + ' x' + state.inventory[k]; });
    wrap.appendChild(el('p', 'mnote', $t('Tasmu: {0}', [have.length ? have.join(', ') : $t('kosong')])));
    var sc = h.body.scrollTop;
    h.setBody(wrap); h.body.scrollTop = sc;
    // keep keyboard focus on a sensible button after re-render
    if (h.box.contains(document.activeElement) === false) focusInto(h);
  }
  render();
  var offInv = on('inventory', function(){ if (h.isOpen()) render(); });
  var offCoin = on('coins', function(){ if (h.isOpen()) render(); });
  h.opts.onClose = function(){ offInv(); offCoin(); };
  return h;
}
function confirmRegen(){
  if (QA){ doRegen(); return; }
  if (modals.length || tr) return;
  modal({ title:$t('Generasi ulang?'), sticky:true, body:$t('Kota baru akan dibuat dengan seed baru. Koin dan isi tasmu tetap dibawa.'), actions:[
    {label:$t('Batal')},
    {label:$t('Ya, buat baru'), primary:true, onClick:function(m){ m.close('ok'); doRegen(); }}
  ]});
}
function doRegen(){
  held.length = 0;
  var ns = randomSeed();
  transition(function(){ regen(ns); });
}

/* ---------- HUD buttons / hotkeys ---------- */
var hudButtons = [];   // secondary buttons shown in the "Menu" list on narrow screens
var hotkeys = {};      // code -> fn
function hotkey(key, fn){
  var code = /^[A-Za-z]$/.test(key) ? 'Key' + key.toUpperCase() : key;
  hotkeys[code] = fn;
}
function addHudButton(o){
  if (!o || !o.label) return null;
  var b = el('button', 'btn' + (o.secondary === false ? '' : ' sec'), o.label); b.type = 'button';
  if (o.id) b.id = o.id;
  b.addEventListener('click', function(e){ e.currentTarget.blur(); if (!isUiOpen() && o.onClick) o.onClick(); });
  elActs.insertBefore(b, document.getElementById('menubtn'));
  if (o.key) hotkey(o.key, function(){ if (o.onClick) o.onClick(); });
  hudButtons.push({label:o.label, key:o.key, onClick:o.onClick, secondary:o.secondary !== false});
  return b;
}
function openMenu(){
  if (isUiOpen()) return;
  var opts = [{label:$t('Profil (P)'), onPick:openProfile}];
  hudButtons.forEach(function(hb){ if (hb.secondary) opts.push({label:hb.label + (hb.key ? ' (' + hb.key + ')' : ''), onPick:function(){ if (hb.onClick) hb.onClick(); }}); });
  opts.push({label:$t('Peta (M)'), onPick:function(){ setMap(true); }});
  menu($t('Menu'), opts);
}

/* ---------- Dev panel ---------- */
var devSections = [], devModal = null;
function addDevSection(title, build){
  if (typeof build !== 'function') return;
  var rec = {title:String(title == null ? '' : title).slice(0, 40), build:build};
  devSections.push(rec);
  if (devModal && devModal.isOpen() && devModal._wrap) renderDevSection(devModal._wrap, rec);
}
function renderDevSection(wrap, rec){
  var sec = el('div', 'dsec');
  if (rec.title) sec.appendChild(el('h3', null, rec.title));
  wrap.appendChild(sec);
  try { rec.build(sec); } catch(e){ console.error('[GT] dev section "' + rec.title + '"', e); }
}
function fmtMin(v){ return (Math.round(v * 10) / 10).toString().replace('.', ','); }
function openDev(){
  if (!window.GT_DEV_HOST) return null; // the Dev panel is for local play only
  if (devModal && devModal.isOpen()) return devModal;
  if (modals.length || tr || D || mapOpen) return null;
  var wrap = el('div');
  // 1. day length
  var s1 = el('div', 'dsec'); s1.appendChild(el('h3', null, $t('Panjang 1 hari (menit nyata)')));
  var num = el('input'); num.type = 'number'; num.min = 1; num.max = 60; num.step = 1; num.id = 'dev-daylen'; num.setAttribute('aria-label', $t('Panjang 1 hari dalam menit'));
  var rng = el('input'); rng.type = 'range'; rng.min = 1; rng.max = 60; rng.step = 1; rng.id = 'dev-dayrange'; rng.setAttribute('aria-label', $t('Panjang 1 hari (slider)'));
  var info = el('p', 'mnote'); info.id = 'dev-dayinfo';
  function syncDay(from){
    if (from !== num) num.value = String(Math.round(dayLength * 10) / 10);
    if (from !== rng) rng.value = String(Math.round(dayLength));
    info.textContent = $t('Siang ≈ {0} menit, malam ≈ {1} menit', [fmtMin(dayLength * 13 / 24), fmtMin(dayLength * 11 / 24)]);
  }
  function setLen(v, from){ if (!isFinite(v) || v < 1) return; setDayLength(v); syncDay(from); }
  num.addEventListener('input', function(){ var v = parseFloat(num.value); if (isFinite(v)) setLen(Math.min(60, v), num); });
  num.addEventListener('change', function(){ syncDay(null); });
  rng.addEventListener('input', function(){ setLen(+rng.value, rng); });
  var r1 = el('div', 'mrow'); r1.appendChild(num); r1.appendChild(el('span', 'grow', $t('menit = 1 hari (1-60)')));
  s1.appendChild(r1); s1.appendChild(rng); s1.appendChild(info);
  wrap.appendChild(s1);
  syncDay(null);
  // 2. time
  var s2 = el('div', 'dsec'); s2.appendChild(el('h3', null, $t('Waktu')));
  var now = el('p', null); now.id = 'dev-now'; s2.appendChild(now);
  var bt = el('div', 'dbtns');
  [[$t('Pagi 07:00'), 7, 'pagi'], [$t('Siang 12:00'), 12, 'siang'], [$t('Senja 18:00'), 18, 'senja'], [$t('Malam 22:00'), 22, 'malam']].forEach(function(p){
    var b = el('button', 'mbtn', p[0]); b.type = 'button'; b.id = 'dev-t-' + p[2];
    b.addEventListener('click', function(){ setTime(p[1], 0); refresh(); });
    bt.appendChild(b);
  });
  var pb = el('button', 'mbtn', ''); pb.type = 'button'; pb.id = 'dev-pause';
  pb.addEventListener('click', function(){ pauseTime(!timePaused); refresh(); });
  bt.appendChild(pb);
  s2.appendChild(bt);
  wrap.appendChild(s2);
  // 3. developer mode
  var s3 = el('div', 'dsec'); s3.appendChild(el('h3', null, $t('Mode developer')));
  var lab = el('label', 'dchk'), cb = el('input'); cb.type = 'checkbox'; cb.id = 'dev-mode'; cb.checked = devEnabled;
  cb.addEventListener('change', function(){ GT.dev.enabled = cb.checked; });
  var tx = el('span'); tx.appendChild(document.createTextNode($t('Mode developer ')));
  tx.appendChild(el('span', 'mnote', $t('- Izinkan perintah `#` di chat NPC (mis. `#ikut aku`).')));
  lab.appendChild(cb); lab.appendChild(tx); s3.appendChild(lab);
  wrap.appendChild(s3);
  function refresh(){
    var ci = clockInfo();
    now.textContent = $t('Sekarang {0} (hari {1}, {2}){3}', [ci.hhmm, ci.day, ci.night ? 'malam' : ci.light < 0.98 ? 'senja/fajar' : 'siang', timePaused ? $t(' - waktu berhenti') : '']);
    pb.textContent = timePaused ? $t('Lanjut waktu') : $t('Pause waktu');
    if (cb.checked !== devEnabled) cb.checked = devEnabled;
  }
  refresh();
  devSections.forEach(function(rec){ renderDevSection(wrap, rec); });
  var timer = setInterval(function(){ if (devModal && devModal.isOpen()) refresh(); }, 400);
  var h = modal({ title:$t('Panel Developer'), body:wrap, sticky:true, actions:[{label:$t('Tutup'), primary:true}], onClose:function(){ clearInterval(timer); if (devModal === h) devModal = null; } });
  h._wrap = wrap; devModal = h;
  return h;
}
function devKey(e){
  if (!window.GT_DEV_HOST) return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  var t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''))) return false;
  if (e.repeat) return false;
  if (devModal && devModal.isOpen()){
    if (modals[modals.length - 1] === devModal){ e.preventDefault(); devModal.close('key'); return true; }
    return false;
  }
  if (modals.length || D || tr || mapOpen) return false;
  e.preventDefault(); openDev(); return true;
}

/* ---------- map overlay ---------- */
function setMap(on){
  mapOpen = !!on;
  elMap.classList.toggle('on', mapOpen);
  if (mapOpen) drawMinimap();
}
var MM_COL = { fountain:'#64c4e2', stage:'#b07840', carousel:'#e8503c', lily:'#2a8cc0', mud:'#6a4a2c', bench:'#c6bba4', void:'#9fd0f0', grass:'#5fae36', flower:'#5fae36', tallgrass:'#56a232', path:'#d0903c', plaza:'#c6bba4', stall:'#e8a13c', water:'#2a8cc0', bridge:'#8e5a30',
  tree:'#2e6a34', bush:'#3f8a2e', rock:'#8a8478', sand:'#e8bf72', soil:'#6a4024', fence:'#8a6038' };
// the minimap takes its ground, water and tree colours from the current season ramps (art.js PAL)
function syncMinimapColours(){
  var P = window.SPRITES && SPRITES.PAL; if (!P) return;
  MM_COL.grass = MM_COL.flower = P.grass[1]; MM_COL.tallgrass = P.grass[0]; MM_COL.path = P.path[1]; MM_COL.plaza = P.plaza[2];
  MM_COL.water = P.water[1];
  var winter = SPRITES.season === 'dingin';
  MM_COL.tree = (winter ? P.leaf.pine : P.leaf.oak)[1]; MM_COL.bush = (winter ? P.leaf.pine : P.leaf.oak)[0];
}
function minimapBase(){
  if (world.mmCache) return world.mmCache;
  var c = document.createElement('canvas'), W = world.w, H = world.h;
  c.width = W * 2; c.height = H * 2;
  var g = c.getContext('2d'), x, y;
  for (y = 0; y < H; y++) for (x = 0; x < W; x++){ g.fillStyle = MM_COL[world.tiles[y*W + x]] || '#5fae36'; g.fillRect(x*2, y*2, 2, 2); }
  world.buildings.forEach(function(b){
    g.fillStyle = b.own ? '#f2c94c' : b.name ? '#e8503c' : b.invited ? '#7fd18a' : '#d98c5f';
    g.fillRect(b.x*2, b.y*2, (b.w || 3)*2, (b.h || 3)*2);
  });
  if (world.locked){ g.fillStyle = 'rgba(26,27,46,0.6)'; for (y = 0; y < H; y++) for (x = 0; x < W; x++) if (world.locked[y*W + x]) g.fillRect(x*2, y*2, 2, 2); }
  world.mmCache = c;
  return c;
}
function drawMinimap(){
  var g = elMM.getContext('2d'); g.imageSmoothingEnabled = false;
  var base = minimapBase();
  if (elMM.width !== base.width){ elMM.width = base.width; elMM.height = base.height; }
  g.drawImage(base, 0, 0);
  if (world.lamps && clockInfo().night){ g.fillStyle = '#ffe066'; world.lamps.forEach(function(l){ g.fillRect(l.x * 2, l.y * 2, 2, 2); }); }
  var px, py, C = 2;
  if (scene.kind === 'out'){ px = P.x + 0.5; py = P.y + 0.5; }
  else { px = scene.house.dx + 0.5; py = scene.house.dy + 0.5; }
  var blink = REDUCE ? true : Math.floor(timeAcc * 3) % 2 === 0;
  g.fillStyle = '#000'; g.fillRect(Math.round(px*C) - 3, Math.round(py*C) - 3, 6, 6);
  g.fillStyle = blink ? '#ff3b3b' : '#ffffff'; g.fillRect(Math.round(px*C) - 2, Math.round(py*C) - 2, 4, 4);
  callMods('onMinimap', [g, C]);
}

/* ---------- transitions ---------- */
function transition(fn){
  if (REDUCE){ fn(); return; }
  tr = { ph:0, t:0, fn:fn };
}
function updateTransition(dt){
  tr.t += dt / 0.16;
  if (tr.t >= 1){
    if (tr.ph === 0){ var f = tr.fn; tr.ph = 1; tr.t = 0; f(); }
    else tr = null;
  }
}

/* ---------- mods ---------- */
var mods = [];
function register(mod){
  if (!mod || typeof mod !== 'object') return;
  mods.push(mod);
  if (booted){
    callOne(mod, 'init', [GT]);
    if (world) callOne(mod, 'onWorld', [world]);
    if (scene) callOne(mod, 'onSceneEnter', [scene]);
  }
}
function callOne(mod, hook, args){
  if (typeof mod[hook] !== 'function') return undefined;
  try { return mod[hook].apply(mod, args); } catch(e){ console.error('[GT mod ' + (mod.id || '?') + '] ' + hook + ' failed', e); return undefined; }
}
function callMods(hook, args){ for (var i = 0; i < mods.length; i++) callOne(mods[i], hook, args); }
function callModsBool(hook, args){
  for (var i = 0; i < mods.length; i++) if (callOne(mods[i], hook, args) === true) return true;
  return false;
}

/* ---------- interaction ---------- */
/* In the 2.5D view a door has no black fade: the scene changes at once and the view unfolds the room out of the
   building (mods/view3d.js), while unfoldT holds the controls for as long as that takes. */
var unfoldT = 0;
function doorTransition(fn){
  if (v3on() && view3d.unfoldMs){ fn(); unfoldT = view3d.unfoldMs() / 1000; return; }
  transition(fn);
}
function doorBump(door, ctxIn){
  if (door.kind === 'mart' || door.kind === 'casino' || door.invited){
    doorTransition(function(){ enterBuilding(door); });
  } else {
    if (!ctxIn){
      var m = scene.map;
      var c = { mode:'bump', scene:scene, tile:{x:door.dx, y:door.dy}, tileType:'door', npc:null, door:door, building:door, locked:true };
      if (callModsBool('onInteract', [c])) return;
    }
    openDialog($t('Rumah {0} terkunci. Kamu belum diundang.', [door.owner]), '');
  }
}
function enterBuilding(door){
  var sc = houseScene(door);
  sc.returnTo = {x:door.dx, y:door.dy + 1};
  setScene(sc, sc.map.entry.x, sc.map.entry.y, 'up');
}
function leaveBuilding(){
  doorTransition(function(){
    var sc = scene, back = sc.returnTo || world.spawn;
    setScene(outScene, back.x, back.y, 'down');
  });
}

function facingTile(){ var d = DIRS[P.dir]; return {x:P.x + d[0], y:P.y + d[1]}; }
function engage(npc){
  var f = facingTile();
  if (npc.moving){ if (npc.x === f.x && npc.y === f.y){ npc.fx = npc.x; npc.fy = npc.y; } else { npc.x = npc.fx; npc.y = npc.fy; } npc.moving = false; npc.t = 0; }
  npc.talking = true; npc._eng = true; npc.dir = OPP[P.dir];
}
function keeperOf(sc){ var r = null; sc.npcs.forEach(function(n){ if (n.key && /:keeper$/.test(n.key)) r = n; }); return r; }

function interact(mode){
  mode = mode || 'talk';
  if (tr || modals.length || unfoldT > 0) return;
  if (mapOpen){ setMap(false); return; }
  if (D){ advanceDialog(); return; }
  if (P.moving) return;
  if (sitSpot){ sitSpot = null; return; }
  var m = scene.map, f = facingTile();
  if (!inb(m, f.x, f.y)) return;
  var idx = f.y*m.w + f.x, tt = m.tiles[idx];
  var npc = npcAtTile(f.x, f.y);
  if (!npc && tt === 'counter' && scene.kind === 'mart') npc = keeperOf(scene);
  if (!npc && tt === 'dice_table' && scene.kind === 'casino'){ var dl = scene.npcs.filter(function(n){ return n.key === 'casino:dealer' && !n.hidden && !n.moving && Math.abs(n.x - f.x) <= 1 && n.y === f.y - 1; })[0]; npc = dl || null; }
  var door = m.door.get(idx) || null;
  var bld = door || m.bld.get(idx) || scene.house || null;
  var ctx = { mode:mode, scene:scene, tile:{x:f.x, y:f.y}, tileType:door ? 'door' : tt, npc:npc, door:door, building:bld,
    locked:!!(door && !(door.kind === 'mart' || door.kind === 'casino' || door.invited)) };
  if (npc) engage(npc);
  if (callModsBool('onInteract', [ctx])) return;
  if (tt === 'chair' && !npc && scene.kind !== 'out' && mode !== 'message'){ sitDown(f.x, f.y); return; }
  if (mode === 'message'){
    if (npc) openDialog($t('({0} sedang sibuk dan belum bisa membalas pesan.)', [npc.name]), '', npc);
    else toast($t('Hadapi seseorang lalu tekan E untuk kirim pesan.'));
    return;
  }
  if (npc){
    var lines = npc.lines[Math.floor(Math.random() * npc.lines.length)];
    if (timeAcc - npc.lastTalk >= 60){ npc.lastTalk = timeAcc; addAffinity(npc, 1); }
    var after = null;
    if (scene.kind === 'mart' && /:keeper$/.test(npc.key || '')) after = function(){ if (!QA) openShop(npc); };
    openDialog(lines.slice(), npc.name, npc, after);
    return;
  }
  if (door){ doorBump(door, ctx); return; }
  if (m.info.has(idx)){ openDialog(m.info.get(idx), ''); return; }
  if (tt === 'chest'){ openDialog($t('Peti kayu. Tertutup rapat dan tidak bisa dibuka sekarang.'), ''); return; }
  if (scene.kind === 'casino' && (tt === 'card_table' || tt === 'dice_table' || tt === 'slot')){
    openDialog($t('Meja belum dibuka. (Modul kasino belum terpasang.)'), ''); return;
  }
  if (m.bld.has(idx)){
    var b = m.bld.get(idx);
    var txt = b.kind === 'mart' ? $t('Mart Genesis. Pintunya ada di tengah bawah.') : b.kind === 'casino' ? $t('Kasino Genesis. Koin permainan saja! Pintunya ada di tengah bawah.') : (b.own ? $t('Ini rumahmu. Masuk lewat pintu di tengah.') : $t('Rumah {0}.', [b.owner]));
    openDialog(txt, '');
  }
}

/* ---------- update ---------- */
function canControl(){ return !D && !tr && !mapOpen && !modals.length && !(unfoldT > 0); }
// held arrows are screen directions (turned by the 2.5D camera) unless a mod pressed them as world ones (mouse.js paths)
function desired(){ if (!held.length) return null; var h = held[held.length - 1]; return h.world ? h.d : worldDir(h.d); }

/* ---------- free walking (2.5D outdoors) ----------
   In the 2.5D view outdoors the player walks freely, diagonals too: P.cx / P.cy is the centre of the feet
   in tile units, and P.x / P.y stay the tile under it, which is what the server, interactions, NPCs and mods see. Held
   arrows add up (two keys walk a diagonal), turned by the camera; a drag on the world is an analog stick (GT.setStick).
   FREE_SPEED * sqrt(2) stays under the server's walking check (8 tiles a second, Manhattan, worldmap.ts). */
var FREE_SPEED = 5, FREE_R = 0.28, stick = null;
function freeOn(){ return v3on() && scene.kind === 'out'; }
function freeOk(x, y){
  var r = FREE_R, c = [[-r, -r], [r, -r], [-r, r], [r, r]];
  for (var i = 0; i < 4; i++) if (!canEnterPlayer(Math.floor(x + c[i][0]), Math.floor(y + c[i][1]))) return false;
  return true;
}
function updatePlayerFree(dt){
  // placed by someone else (a door, a teleport, a world switch): start again from the middle of that tile
  if (P.cx == null || Math.floor(P.cx) !== P.x || Math.floor(P.cy) !== P.y){ P.cx = P.x + 0.5; P.cy = P.y + 0.5; }
  P.fx = P.x; P.fy = P.y; P.t = 0; P.turnT = 0;
  if (P.bumpT > 0) P.bumpT -= dt;
  if (!canControl()){ P.moving = false; return; }
  var sx = 0, sy = 0, wx = 0, wy = 0;
  held.forEach(function(h){ var v = DIRS[h.d]; if (h.world){ wx += v[0]; wy += v[1]; } else { sx += v[0]; sy += v[1]; } });
  if (stick){ sx += stick.x; sy += stick.y; }
  sx = Math.max(-1, Math.min(1, sx)); sy = Math.max(-1, Math.min(1, sy));
  var r = view3d.screenToWorld ? view3d.screenToWorld(sx, sy) : {x:sx, y:sy};
  var mx = r.x + wx, my = r.y + wy, len = Math.hypot(mx, my);
  if (waitRelease){ if (len > 0.01) { P.moving = false; return; } waitRelease = false; }
  if (len < 0.01){ P.moving = false; P.walkT = 0; return; }
  mx /= len; my /= len;
  // lane assist: walking along one axis eases to the middle of the lane, so doors, bridges and paths line up
  var k = Math.min(1, dt * 8), cx = P.cx + (Math.floor(P.cx) + 0.5 - P.cx) * k, cy = P.cy + (Math.floor(P.cy) + 0.5 - P.cy) * k;
  if (Math.abs(mx) < 0.2 && freeOk(cx, P.cy)) P.cx = cx;
  if (Math.abs(my) < 0.2 && freeOk(P.cx, cy)) P.cy = cy;
  // walking up into a door goes in, as a grid step into it does
  var m = scene.map, dtx = Math.floor(P.cx), dty = Math.floor(P.cy - FREE_R - 0.04);
  if (my < -0.6 && dty !== P.y && inb(m, dtx, dty) && m.door.has(dty*m.w + dtx) && !(P.bumpT > 0)){
    P.bumpT = 0.8; P.dir = 'up'; P.moving = false; doorBump(m.door.get(dty*m.w + dtx)); return;
  }
  var sp = FREE_SPEED * dt, nx = P.cx + mx * sp, ny = P.cy + my * sp;
  if (freeOk(nx, P.cy)) P.cx = nx;
  if (freeOk(P.cx, ny)) P.cy = ny;
  else if (my < -0.6 && !(P.bumpT > 0)){
    // the step up was stopped by the door itself: go in. The check above only sees the door inside a 0.04-tile band
    // in front of it, which a step of 5 tiles a second (0.08 a frame, more on a slow frame) often jumps over.
    var btx = Math.floor(P.cx), bty = Math.floor(ny - FREE_R);
    if (bty !== P.y && inb(m, btx, bty) && m.door.has(bty*m.w + btx)){ P.bumpT = 0.8; P.dir = 'up'; P.moving = false; doorBump(m.door.get(bty*m.w + btx)); return; }
  }
  P.dir = Math.abs(mx) > Math.abs(my) ? (mx > 0 ? 'right' : 'left') : (my > 0 ? 'down' : 'up');
  P.walkT = (P.walkT || 0) + dt; P.flip = Math.floor(P.walkT / MOVE_T) % 2 === 0;
  P.moving = true;
  var tx = Math.floor(P.cx), ty = Math.floor(P.cy);
  if (tx !== P.x || ty !== P.y){ P.x = P.fx = tx; P.y = P.fy = ty; hudDirty = true; }
}

function tryMove(d){
  var m = scene.map, dv = DIRS[d], nx = P.x + dv[0], ny = P.y + dv[1];
  P.dir = d;
  if (!inb(m, nx, ny)) return false;
  var idx = ny*m.w + nx;
  if (m.door.has(idx)){ doorBump(m.door.get(idx)); return false; }
  if (m.exit.has(idx)){ leaveBuilding(); return false; }
  var fo = npcAtTile(nx, ny);
  if (fo && fo.follow && !fo.moving && !fo.script && !fo.hidden && nx === fo.x && ny === fo.y && !P.moving && m.walk[idx] === 1 && !(m.staff && m.staff.has(idx))){
    // swap with own follower: it steps into the player's tile (tween), no overlap at any frame
    var ox = P.x, oy = P.y;
    P.fx = P.x; P.fy = P.y; P.x = nx; P.y = ny; P.moving = true; P.t = 0; P.flip = !P.flip;
    fo.dir = OPP[d]; fo.fx = fo.x; fo.fy = fo.y; fo.x = ox; fo.y = oy; fo.moving = true; fo.t = 0; fo.flip = !fo.flip; fo.spd = 0;
    return true;
  }
  if (!canEnterPlayer(nx, ny)) return false;
  P.fx = P.x; P.fy = P.y; P.x = nx; P.y = ny; P.moving = true; P.t = 0; P.flip = !P.flip;
  return true;
}

function updatePlayer(dt){
  if (freeOn()) return updatePlayerFree(dt);
  if (P.cx != null){ P.cx = null; P.moving = false; P.t = 0; P.fx = P.x; P.fy = P.y; } // back on the grid (indoors, 2D)
  var chained = false;
  if (P.moving){
    P.t += dt / MOVE_T;
    if (P.t < 1) return;
    P.moving = false; chained = true;
    var carry = (P.t - 1) * MOVE_T; P.t = 0;
    hudDirty = true;
    if (!canControl()) return;
    dt = carry;
  }
  if (!canControl()) return;
  var d = desired();
  if (waitRelease){ if (!d) waitRelease = false; else return; }
  if (!d){ P.turnT = 0; return; }
  if (P.dir !== d){ P.dir = d; P.turnT = chained ? 0 : TURN_T; }
  if (P.turnT > 0){ P.turnT -= dt; if (P.turnT > 0) return; }
  if (tryMove(d) && dt > 0){ P.t = Math.min(0.9, dt / MOVE_T); }
}

function updateNpcs(sc, dt, isCur){
  var arr = sc.npcs.slice();
  for (var i = 0; i < arr.length; i++){
    var n = arr[i];
    if (n.bubble){ n.bubble.t -= dt; if (n.bubble.t <= 0) n.bubble = null; }
    if (!isCur && !n.script) continue;
    if (n.moving){
      n.t += dt / (n.spd || NPC_T);
      if (n.t >= 1){ n.moving = false; n.t = 0; if (!(n.script || n.follow)) continue; } else continue;
    }
    if (n.hidden) continue;
    if (n.talking){
      if (n._eng && !(D && D.npc === n) && !modals.length){ n.talking = false; n._eng = false; n.wait = Math.max(n.wait, 1); }
      else continue;
    }
    if (n.script){ stepScript(sc, n, dt); continue; }
    if (n.follow){ if (isCur) stepFollow(sc, n, dt); continue; }
    n.wait -= dt;
    if (n.wait > 0) continue;
    n.wait = 0.7 + Math.random() * 2.3;
    if (n.turns && !n.wander){ n.dir = pickRand(DIRLIST); continue; }
    if (!n.wander) continue;
    var d = pickRand(DIRLIST), dv = DIRS[d];
    n.dir = d;
    var nx = n.x + dv[0], ny = n.y + dv[1];
    if (Math.abs(nx - n.home.x) + Math.abs(ny - n.home.y) > n.leash) continue;
    if (!canEnterNpc(n, nx, ny, false, sc)) continue;
    n.fx = n.x; n.fy = n.y; n.x = nx; n.y = ny; n.moving = true; n.t = 0; n.flip = !n.flip; n.spd = 0;
  }
}

function update(dt){
  timeAcc += dt;
  if (!timePaused) gameMin += dt * 24 / dayLength;
  checkClock();
  callMods('onFrame', [dt]);
  if (tr) updateTransition(dt);
  if (unfoldT > 0) unfoldT -= dt;
  if (mapOpen){ drawMinimap(); return; }
  updateDialog(dt);
  if (sitSpot && (sitSpot.scene !== scene || tr || held.length || stick || P.moving)) sitSpot = null;
  updatePlayer(dt);
  if (!tr || tr.ph === 1){
    if (playerFx.bubble){ playerFx.bubble.t -= dt; if (playerFx.bubble.t <= 0) playerFx.bubble = null; }
    updateNpcs(scene, dt, true);
    allScenes().forEach(function(sc){ if (sc !== scene) updateNpcs(sc, dt, false); });
  }
}

/* ---------- render ---------- */
var ctx;
var camX = 0, camY = 0;
function lerpPos(o){
  if (o === P && P.cx != null) return { px:(P.cx - 0.5) * T, py:(P.cy - 0.5) * T }; // free walking: no rounding, the 3D view is smooth
  var t = o.moving ? Math.min(1, o.t) : 1;
  var a = o.moving ? o.fx : o.x, b = o.x, c = o.moving ? o.fy : o.y, e = o.y;
  return { px:Math.round((a + (b - a) * t) * T), py:Math.round((c + (e - c) * t) * T) };
}
function smoothAt(){
  if (P.cx != null) return { x:P.cx - 0.5, y:P.cy - 0.5 };
  var t = P.moving ? Math.min(1, P.t) : 1;
  return P.moving ? { x:P.fx + (P.x - P.fx) * t, y:P.fy + (P.y - P.fy) * t } : { x:P.x, y:P.y };
}
function charStep(o){
  if (!o.moving) return 0;
  return o.flip ? 1 : 2;
}
/* 2.5D view (mods/view3d.js): outdoors it draws the world in three.js under this canvas. The engine still owns every
   position; it hands the view the same entities it would draw, then draws the mods' overlays (signs, monsters, tags,
   effects) on this now transparent canvas with camX/camY moved so the player's 2D feet sit on the player's 3D feet.
   The view keeps one world pixel at the player's depth equal to one canvas pixel, so overlays near the player line up. */
var playerHidden = false; // the character screen's throw draws the player itself until it lands (GT.setPlayerHidden)
var cleanView = false; // a cinematic moment (the carousel ride): no mod overlays on the picture (GT.setCleanView)
var view3d = null, ovK = 0; // ovK: while the 3D overlays draw, device px per art px at the player's depth (else 0)
// indoors too when the view can draw rooms (view3d.rooms): the room stands where its building is, in the same world
function v3on(){ return !!(view3d && scene && view3d.ready() && (scene.kind === 'out' || (scene.house && view3d.rooms))); }
/** Where a mod draws something that stands on tile (tx, ty) (fractions allowed): the tile's top-left in the overlay's
    units, as tx*T - camX, ty*T - camY in 2D. In 2.5D it follows that tile's feet on screen at any camera turn, and
    offsets from it stay in art pixels at the sprites' size, so a hat still sits on a head. */
function at(tx, ty){
  if (ovK){ var p = view3d.toScreen(tx + 0.5, ty + 0.5, 0); return { x: p.x * S / ovK - 6, y: p.y * S / ovK - 12 }; }
  return { x: tx * T - camX, y: ty * T - camY };
}
/** A walking direction as pressed (screen) to the world direction under the 2.5D camera's turn. */
function worldDir(d){ return d && v3on() && view3d.worldDir ? view3d.worldDir(d) : d; }
function render3d(pp){
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, elCv.width, elCv.height); ctx.setTransform(S, 0, 0, S, 0, 0);
  var ents = [];
  scene.npcs.forEach(function(n){ if (n.hidden) return; var p = lerpPos(n); ents.push({py:p.py, px:p.px, n:n, pal:n.pal, dir:n.dir, step:charStep(n)}); });
  ents.push({py:pp.py, px:pp.px, n:null, pal:0, dir:P.dir, step:charStep(P), me:true, hidden:playerHidden, sit:!!sitSpot});
  callMods('onEntities', [ents, ctx, camX, camY, T]); // mods add {px, py, pal, dir, step, id}; their draw() is not called
  var outside = scene.kind === 'out', g = outside ? view3d.groundCtx(scene.map) : null;
  if (g) {
    g.clearRect(0, 0, g.canvas.width, g.canvas.height); callMods('onDrawGround', [g, 0, 0, T]);
    var mk = view3d.marksCtx && view3d.marksCtx();
    if (mk) {
      mk.clearRect(0, 0, mk.canvas.width, mk.canvas.height);
      var drew = false;
      for (var mi = 0; mi < mods.length; mi++) if (callOne(mods[mi], 'onDrawMarks', [mk, 0, 0, T]) === true) drew = true;
      view3d.marksDone(drew); // nothing drawn now or last time: no texture upload
    }
  }
  var feet = view3d.draw({ ents:ents, VW:VW, VH:VH, S:S, map:scene.map, hour:clockInfo().phase * 24,
    out: outScene.map, house: outside ? null : scene.house, key: outside ? null : scene.key });
  ovK = view3d.artScale(S);
  camX = pp.px + 6 - feet.x * S / ovK; camY = pp.py + 12 - feet.y * S / ovK;
  ctx.setTransform(ovK, 0, 0, ovK, 0, 0);
  if (window.GT_THEME) GT_THEME.scale = 0.6;
  try { if (!cleanView) callMods('onDraw', [ctx, camX, camY, T]); }
  finally { ovK = 0; if (window.GT_THEME) GT_THEME.scale = 1; ctx.setTransform(S, 0, 0, S, 0, 0); }
  lastDark = currentDark();
  if (tr){
    var a = tr.ph === 0 ? tr.t : 1 - tr.t;
    ctx.fillStyle = 'rgba(0,0,0,' + Math.max(0, Math.min(1, a)).toFixed(3) + ')';
    ctx.fillRect(0, 0, VW, VH);
  }
  renderFx(ents);
}
function render(){
  var m = scene.map, mw = m.w * T, mh = m.h * T;
  var pp = selfPos();
  if (v3on()) return render3d(pp);
  if (view3d) view3d.idle();
  ctx.fillStyle = '#0b0c14'; ctx.fillRect(0, 0, VW, VH);
  if (mw <= VW) camX = -Math.floor((VW - mw) / 2); else camX = Math.max(0, Math.min(mw - VW, pp.px + 6 - Math.floor(VW / 2)));
  if (mh <= VH) camY = -Math.floor((VH - mh) / 2); else camY = Math.max(0, Math.min(mh - VH, pp.py + 6 - Math.floor(VH / 2)));
  // static layer
  var sx = Math.max(0, camX), sy = Math.max(0, camY);
  var ex = Math.min(mw, camX + VW), ey = Math.min(mh, camY + VH);
  if (ex > sx && ey > sy) ctx.drawImage(m.cache, sx, sy, ex - sx, ey - sy, sx - camX, sy - camY, ex - sx, ey - sy);
  // animated tiles
  var frame = Math.floor(timeAcc * 2.5);
  var tx0 = Math.max(0, Math.floor(camX / T)), ty0 = Math.max(0, Math.floor(camY / T));
  var tx1 = Math.min(m.w - 1, Math.floor((camX + VW - 1) / T)), ty1 = Math.min(m.h - 1, Math.floor((camY + VH - 1) / T));
  for (var y = ty0; y <= ty1; y++) for (var x = tx0; x <= tx1; x++){
    var tt = m.tiles[y*m.w + x];
    if (!ANIMATED[tt]) continue;
    if (m.layered){
      if (tt === 'water') SPRITES.drawWaterAnim(ctx, x*T - camX, y*T - camY, frame, x, y);
      else SPRITES.drawOverlay(ctx, tt, x*T - camX, y*T - camY, frame);
    } else SPRITES.drawTile(ctx, tt, x*T - camX, y*T - camY, frame);
  }
  // ground-level mod drawing (crops, markers): under characters and canopies, darkened at night
  callMods('onDrawGround', [ctx, camX, camY, T]);
  callMods('onDrawMarks', [ctx, camX, camY, T]);
  // entities sorted by y
  var ents = [];
  scene.npcs.forEach(function(n){ if (n.hidden) return; var p = lerpPos(n); ents.push({py:p.py, px:p.px, n:n}); });
  if (!playerHidden) ents.push({py:pp.py, px:pp.px, n:null});
  // mods may add their own characters (other players) as {py, draw}: they join the same y-sort as NPCs and trees
  callMods('onEntities', [ents, ctx, camX, camY, T]);
  ents.sort(function(a, b){ return a.py - b.py; });
  // overhead art (tree canopies, stall awnings) joins the y-sort; slightly before same-row characters
  var all = ents;
  if (m.canopies || m.market){
    all = ents.slice();
    if (m.canopies) m.canopies.forEach(function(cn){
      if (cn.x < tx0 - 1 || cn.x > tx1 + 1 || cn.y < ty0 || cn.y > ty1 + 2) return;
      all.push({py:cn.y*T - 0.5, draw:function(){
        SPRITES.drawCanopy(ctx, cn.kind, cn.x*T - camX, cn.y*T - camY);
        if (cn.fog){ ctx.fillStyle = 'rgba(30,26,58,0.55)'; ctx.fillRect(cn.x*T - camX - 4, cn.y*T - camY - 12, T + 8, T + 12); }
      }});
    });
    if (m.market && SPRITES.drawAwning) m.market.stalls.forEach(function(st){
      all.push({py:st.y*T - 0.5, draw:function(){ SPRITES.drawAwning(ctx, st.x*T - camX, st.y*T - camY, st.color); }});
    });
    all.sort(function(a, b){ return a.py - b.py; });
  }
  for (var i = 0; i < all.length; i++){
    var e = all[i];
    if (e.draw){ e.draw(); continue; }
    // GT.charDraw(ctx, npcOrNull(player), x, y, pal, dir, step) -> true when a mod (combat.js) drew the character itself
    var chd = GT.charDraw, hand = false;
    if (typeof chd === 'function'){ try { hand = chd(ctx, e.n, e.px - camX, e.py - camY, e.n ? e.n.pal : 0, e.n ? e.n.dir : P.dir, charStep(e.n || P)) === true; } catch(err){ hand = false; } }
    if (hand) continue;
    if (e.n) drawChar(ctx, e.px - camX, e.py - camY, e.n.pal, e.n.dir, charStep(e.n));
    else drawChar(ctx, e.px - camX, e.py - camY, 0, P.dir, charStep(P));
  }
  if (scene.kind === 'out') drawNight();
  else lastDark = 0;
  if (!cleanView) callMods('onDraw', [ctx, camX, camY, T]);
  if (tr){
    var a = tr.ph === 0 ? tr.t : 1 - tr.t;
    ctx.fillStyle = 'rgba(0,0,0,' + Math.max(0, Math.min(1, a)).toFixed(3) + ')';
    ctx.fillRect(0, 0, VW, VH);
  }
  renderFx(ents);
}

/* ---------- night lighting ----------
   Darkness is rendered into an offscreen canvas at logical resolution (deep-blue fill), each visible lamp punches a radial hole
   (destination-out), then it is composited over the world + characters; a faint warm glow is added around lamps. Outdoor only. */
var nightCv = null, nightCtx = null, darkOverride = null, lastDark = 0, LAMP_R = 3.3;
function currentDark(){ return darkOverride != null ? darkOverride : 1 - lightAt(gameMin % 1440); }
function drawNight(){
  var d = currentDark();
  lastDark = d;
  if (!(d > 0.01)) return;
  if (!nightCv || nightCv.width !== VW || nightCv.height !== VH){
    nightCv = document.createElement('canvas'); nightCv.width = VW; nightCv.height = VH; nightCtx = nightCv.getContext('2d');
  }
  var g = nightCtx, t = Math.min(1, d), k = sstep((t - 0.2) / 0.8);
  var cr = Math.round(104 + (8 - 104) * k), cg = Math.round(46 + (14 - 46) * k), cb = Math.round(84 + (52 - 84) * k);
  g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, VW, VH);
  g.fillStyle = 'rgba(' + cr + ',' + cg + ',' + cb + ',' + (0.84 * t).toFixed(3) + ')';
  g.fillRect(0, 0, VW, VH);
  var L = world.lamps || [], vis = [], i;
  for (i = 0; i < L.length; i++){
    var fl = REDUCE ? 1 : 1 + 0.03 * Math.sin(timeAcc * 8 + i * 2.3) + 0.02 * Math.sin(timeAcc * 21 + i * 5.1);
    var r = LAMP_R * T * fl, cx = L[i].x * T + T / 2 - camX, cy = L[i].y * T + 3 - camY;
    if (cx + r < 0 || cy + r < 0 || cx - r > VW || cy - r > VH) continue;
    vis.push(cx, cy, r);
  }
  g.globalCompositeOperation = 'destination-out';
  for (i = 0; i < vis.length; i += 3){
    var gr = g.createRadialGradient(vis[i], vis[i+1], 1, vis[i], vis[i+1], vis[i+2]);
    gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(0.35, 'rgba(0,0,0,0.93)'); gr.addColorStop(0.6, 'rgba(0,0,0,0.62)'); gr.addColorStop(0.85, 'rgba(0,0,0,0.2)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(vis[i] - vis[i+2], vis[i+1] - vis[i+2], vis[i+2] * 2, vis[i+2] * 2);
  }
  g.globalCompositeOperation = 'source-over';
  ctx.drawImage(nightCv, 0, 0);
  for (i = 0; i < vis.length; i += 3){
    var wg = ctx.createRadialGradient(vis[i], vis[i+1], 1, vis[i], vis[i+1], vis[i+2] * 0.95);
    wg.addColorStop(0, 'rgba(255,205,120,' + (0.34 * t).toFixed(3) + ')'); wg.addColorStop(0.45, 'rgba(255,170,70,' + (0.14 * t).toFixed(3) + ')'); wg.addColorStop(1, 'rgba(255,150,50,0)');
    ctx.fillStyle = wg; ctx.fillRect(vis[i] - vis[i+2], vis[i+1] - vis[i+2], vis[i+2] * 2, vis[i+2] * 2);
  }
}

/* speech bubbles + name tags (HTML over the canvas: crisp text, clamped to the screen) */
var fxBub = new Map(), fxTag = new Map();
var playerFx = {label:null, bubble:null};  // the player's own speech bubble (GT.playerSay)
function fxSync(map, npc, want, cls, text){
  var rec = map.get(npc);
  if (!want){ if (rec){ if (rec.e.parentNode) rec.e.parentNode.removeChild(rec.e); map.delete(npc); } return null; }
  if (!rec){ rec = {e:el('div', cls), text:null, w:0, h:0}; elFx.appendChild(rec.e); map.set(npc, rec); }
  if (rec.text !== text){ rec.e.textContent = text; rec.text = text; rec.w = 0; }
  return rec;
}
function renderFx(ents){
  if (!elFx) return;
  var sw = VW * S, sh = VH * S;
  var live = new Set();
  ents.forEach(function(en){
    var n = en.n || (playerFx.bubble ? playerFx : null); if (!n) return;
    live.add(n);
    var cx = (en.px - camX + T / 2) * S, top = (en.py - camY) * S;
    if (v3on()){ var sp = view3d.toScreen(en.px / T + 0.5, en.py / T + 0.5, 1); cx = sp.x * S; top = sp.y * S; }
    var visible = cx > -20 && cx < sw + 20 && top > -20 && top < sh + 20;
    var tag = fxSync(fxTag, n, !!n.label && visible, 'ntag', n.label);
    var tagH = 0;
    if (tag){
      if (!tag.w){ tag.w = tag.e.offsetWidth; tag.h = tag.e.offsetHeight; }
      var tx = Math.max(tag.w / 2 + 1, Math.min(sw - tag.w / 2 - 1, cx));
      tag.e.style.transform = 'translate(' + Math.round(tx - tag.w / 2) + 'px,' + Math.round(top - tag.h - 2 * S) + 'px)';
      tagH = tag.h + 2;
    }
    var bub = fxSync(fxBub, n, !!n.bubble && visible, 'bub', n.bubble ? n.bubble.text : '');
    if (bub){
      bub.e.classList.toggle('shk', !!(n.bubble && n.bubble.shake));
      if (!bub.w){ bub.w = bub.e.offsetWidth; bub.h = bub.e.offsetHeight; }
      var bx = Math.max(bub.w / 2 + 2, Math.min(sw - bub.w / 2 - 2, cx));
      var by = Math.max(2, top - bub.h - 8 - tagH - 2 * S);
      bub.e.style.transform = 'translate(' + Math.round(bx - bub.w / 2) + 'px,' + Math.round(by) + 'px)';
    }
  });
  [fxBub, fxTag].forEach(function(map){
    map.forEach(function(rec, n){ if (!live.has(n)){ if (rec.e.parentNode) rec.e.parentNode.removeChild(rec.e); map.delete(n); } });
  });
}

/* ---------- HUD ---------- */
var lastLoc = '', lastSeed = -1, lastCoins = -1, lastClock = '', lastRole = '', lastClan = '\u0000', lastSm = '';
function locText(){
  if (scene.kind === 'out') return areaName(P.x, P.y);
  if (scene.house && scene.house.name) return scene.house.name;
  if (scene.kind === 'mart') return $t('Mart Genesis');
  if (scene.kind === 'casino' || scene.kind === 'kasino') return $t('Kasino Genesis');
  if (scene.house.kind !== 'house' && ROOM_TITLE[scene.house.kind]) return ROOM_TITLE[scene.house.kind];
  return scene.house.own ? $t('Rumah Kamu') : $t('Rumah {0}', [scene.house.owner]);
}
function pad2(n){ return (n < 10 ? '0' : '') + n; }
function sstep(t){ t = t < 0 ? 0 : t > 1 ? 1 : t; return t*t*(3 - 2*t); }
/* daylight 0..1 for a minute-of-day: full 07:00-17:00, dusk fades 17:00-19:00, night 19:00-05:00, dawn 05:00-07:00 */
function lightAt(fm){
  var h = fm / 60;
  if (h >= 7 && h < 17) return 1;
  if (h >= 17 && h < 19) return 1 - sstep((h - 17) / 2);
  if (h >= 19 || h < 5) return 0;
  return sstep((h - 5) / 2);
}
function clockInfo(){
  var tot = Math.floor(gameMin), day = Math.floor(tot / 1440) + 1, mm = tot % 1440, hh = Math.floor(mm / 60), mi = mm % 60, fm = gameMin % 1440;
  return { total:tot, day:day, hour:hh, minute:mi, hhmm:pad2(hh) + ':' + pad2(mi),
    h:hh, m:mi, night:(hh >= 19 || hh < 6), light:lightAt(fm), phase:fm / 1440 };
}
var evHour = -1, evNight = null;
function checkClock(){
  var mm = Math.floor(gameMin) % 1440, h = Math.floor(mm / 60), n = (h >= 19 || h < 6);
  if (evNight === null){ evNight = n; evHour = h; return; }
  if (h !== evHour){ evHour = h; emit('hour', {h:h}); }
  if (n !== evNight){ evNight = n; emit('daynight', {night:n}); }
}
function setTime(h, m){
  h = Math.floor(+h); m = Math.floor(+(m || 0));
  if (!isFinite(h) || !isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) return false;
  gameMin = Math.floor(gameMin / 1440) * 1440 + h * 60 + m;
  checkClock(); hudDirty = true; save(); return true;
}
function setDayLength(v){
  v = +v; if (!isFinite(v)) return dayLength;
  dayLength = Math.max(1, Math.min(60, v));
  save(); emit('dayLength', {minutes:dayLength}); return dayLength;
}
function pauseTime(on){
  var was = timePaused; timePaused = on === undefined ? true : !!on;
  save(); if (was !== timePaused) emit('timePaused', {paused:timePaused});
}
function lampNear(x, y, r){
  r = r == null ? 4 : r;
  var L = world && world.lamps; if (!L) return false;
  for (var i = 0; i < L.length; i++) if (Math.abs(L[i].x - x) <= r && Math.abs(L[i].y - y) <= r) return true;
  return false;
}
var hudDay = null;      // server day-of-season shown in WAKTU (set by chain.js when signed in)
function setHudDay(n){ hudDay = n == null ? null : n; hudDirty = true; }
function updateHud(){
  var l = locText();
  if (l !== lastLoc){ lastLoc = l; elLoc.textContent = l; }
  if (seed !== lastSeed){ lastSeed = seed; elSeed.textContent = String(seed); }
  if (state.coins !== lastCoins){ lastCoins = state.coins; elCoins.textContent = String(state.coins); }
  var ci = clockInfo(), cs = ci.hhmm + ' H' + (hudDay != null ? hudDay : ci.day);
  if (cs !== lastClock){ lastClock = cs; elClock.textContent = cs; }
  var smc = ci.night ? 'night' : (ci.light < 0.98 ? 'dusk' : '');
  if (smc !== lastSm){ lastSm = smc; elSm.className = 'sm' + (smc ? ' ' + smc : ''); }
  if (state.role !== lastRole){ lastRole = state.role; elRole.textContent = roleLabel(state.role); elRole.classList.toggle('maling', state.role === 'maling'); }
  var clan = state.clan && state.clan.tag ? '[' + state.clan.tag + ']' : '';
  if (clan !== lastClan){ lastClan = clan; elClan.textContent = clan; }
}

/* ---------- layout ---------- */
// Hackathon change (2026-11-01): full-window layout. When <html> has class "gt-full" (set by mods/settings.js on
// desktop, or by the fullscreen toggle) the view fills the window: the largest whole-pixel scale that shows at least
// 15x11 tiles, then as many columns/rows as fit (up to 40x24). Otherwise the original boxed layout below runs.
// Full window: the game covers the whole window, edge to edge (the HUD floats over it, settings.js). The view is the
// window's own size at a whole-pixel scale, so no band is left round it; past 48 x 30 tiles the scale grows instead,
// so a big screen sees no further than anyone else. The pixel or two over the edge is clipped by #screen.
function layoutFull(){
  if (window.scrollY || window.scrollX) window.scrollTo(0, 0); // the page never scrolls in a full window
  var W = elFit.clientWidth || window.innerWidth;
  var H = Math.max(11 * T, elFit.clientHeight || window.innerHeight); // #fit is the whole game area (css/settings.css)
  var s = Math.max(1, Math.min(6, Math.floor(Math.min(W / (15 * T), H / (11 * T)))));
  while (s < 8 && (W / s > 48 * T || H / s > 30 * T)) s++;
  S = s; VW = Math.max(11 * T, Math.ceil(W / s)); VH = Math.max(11 * T, Math.ceil(H / s));
  elCv.width = VW * s; elCv.height = VH * s;
  elCv.style.width = (VW * s) + 'px'; elCv.style.height = (VH * s) + 'px';
  elScreen.style.width = Math.min(W, VW * s) + 'px'; elScreen.style.height = Math.min(H, VH * s) + 'px';
  var fsTable = [10, 8, 10, 12, 14, 16, 18];
  elScreen.style.setProperty('--fs', fsTable[Math.min(s, 6)] + 'px');
  elScreen.classList.toggle('short', VH * s < 340);
  try { var sr = elScreen.getBoundingClientRect(); document.documentElement.style.setProperty('--toastTop', Math.max(8, Math.round(sr.top + 8)) + 'px'); } catch(e){}
  ctx = elCv.getContext('2d');
  ctx.setTransform(s, 0, 0, s, 0, 0);
  ctx.imageSmoothingEnabled = false;
  fxBub.forEach(function(r){ r.w = 0; }); fxTag.forEach(function(r){ r.w = 0; });
}
// Phone (html.gt-phone, css/phone.css): the canvas fills the space #fit gets between the status bar and the controls.
// At least 11 columns at the largest whole-pixel scale; as many rows as the height allows (9 to 32, so tall phones
// such as a Pro Max or a Pixel get no empty bands).
// Landscape (html.gt-land): the view fills #fit edge to edge like the full window, at the scale that shows about ten
// rows (big enough to tap), and never fewer than 15 columns.
function layoutPhone(){
  var W = elFit.clientWidth || window.innerWidth, H = elFit.clientHeight || 300;
  if (document.documentElement.classList.contains('gt-land')){
    var ls = Math.max(1, Math.min(6, Math.floor(H / (10 * T))));
    while (ls > 1 && W / (ls * T) < 15) ls--;
    S = ls; VW = Math.max(11 * T, Math.ceil(W / ls)); VH = Math.max(7 * T, Math.ceil(H / ls));
    elCv.width = VW * ls; elCv.height = VH * ls;
    elCv.style.width = (VW * ls) + 'px'; elCv.style.height = (VH * ls) + 'px';
    elScreen.style.width = Math.min(W, VW * ls) + 'px'; elScreen.style.height = Math.min(H, VH * ls) + 'px';
    elScreen.style.setProperty('--fs', [10, 8, 10, 12, 14, 16, 18][Math.min(ls, 6)] + 'px');
    elScreen.classList.toggle('short', VH * ls < 340);
    try { var lr = elScreen.getBoundingClientRect(); document.documentElement.style.setProperty('--toastTop', Math.max(8, Math.round(lr.top + 8)) + 'px'); } catch(e){}
    ctx = elCv.getContext('2d');
    ctx.setTransform(ls, 0, 0, ls, 0, 0);
    ctx.imageSmoothingEnabled = false;
    fxBub.forEach(function(r){ r.w = 0; }); fxTag.forEach(function(r){ r.w = 0; });
    return;
  }
  var s = Math.max(1, Math.min(6, Math.floor(W / (11 * T))));
  if (s > 2 && Math.floor(W / (T * s)) < 13) s--; // prefer a wider view over bigger pixels
  var cols = Math.max(11, Math.min(40, Math.floor(W / (T * s))));
  var rows = Math.max(9, Math.min(32, Math.floor(H / (T * s))));
  S = s; VW = cols * T; VH = rows * T;
  elCv.width = VW * s; elCv.height = VH * s;
  elCv.style.width = (VW * s) + 'px'; elCv.style.height = (VH * s) + 'px';
  elScreen.style.width = (VW * s) + 'px';
  var fsTable = [10, 8, 10, 12, 14, 16, 18];
  elScreen.style.setProperty('--fs', fsTable[Math.min(s, 6)] + 'px');
  elScreen.classList.toggle('short', VH * s < 340);
  try { var sr = elScreen.getBoundingClientRect(); document.documentElement.style.setProperty('--toastTop', Math.max(8, Math.round(sr.top + 8)) + 'px'); } catch(e){}
  ctx = elCv.getContext('2d');
  ctx.setTransform(s, 0, 0, s, 0, 0);
  ctx.imageSmoothingEnabled = false;
  fxBub.forEach(function(r){ r.w = 0; }); fxTag.forEach(function(r){ r.w = 0; });
}
function layout(){
  elScreen.style.height = ''; // only the full window sets it
  if (document.documentElement.classList.contains('gt-phone')) return layoutPhone();
  if (document.documentElement.classList.contains('gt-full')) return layoutFull();
  var avail = elFit.clientWidth || 340;
  var sW = Math.floor(avail / (15 * T)); // prefer ~15 columns
  if (sW < 2) sW = Math.max(1, Math.floor(avail / (11 * T))); // tiny screens: 11-column minimum
  function apply(s){
    var cols = Math.max(11, Math.min(17, Math.floor(avail / (T * s))));
    S = s; VW = cols * T; VH = 11 * T;
    elCv.width = VW * s; elCv.height = VH * s;
    elCv.style.width = (VW * s) + 'px'; elCv.style.height = (VH * s) + 'px';
    elScreen.style.width = (VW * s) + 'px';
    var fsTable = [10, 8, 10, 12, 14, 16, 18];
    elScreen.style.setProperty('--fs', fsTable[Math.min(s, 6)] + 'px');
    elScreen.classList.toggle('short', VH * s < 340);
  }
  var s;
  // measure the real page height: biggest scale whose page still fits the window, floor 1
  for (s = Math.max(1, Math.min(sW, 6)); s > 1; s--){
    apply(s);
    if (document.documentElement.scrollHeight <= window.innerHeight) break;
  }
  apply(s);
  try { var sr = elScreen.getBoundingClientRect(); document.documentElement.style.setProperty('--toastTop', Math.max(8, Math.round(sr.top + 8)) + 'px'); } catch(e){}
  ctx = elCv.getContext('2d');
  ctx.setTransform(s, 0, 0, s, 0, 0);
  ctx.imageSmoothingEnabled = false;
  fxBub.forEach(function(r){ r.w = 0; }); fxTag.forEach(function(r){ r.w = 0; });
}

/* ---------- input ---------- */
var KEYDIR = { ArrowUp:'up', KeyW:'up', ArrowDown:'down', KeyS:'down', ArrowLeft:'left', KeyA:'left', ArrowRight:'right', KeyD:'right' };
function pressDir(d, id, world){
  id = id || d;
  // a direction from the player (keys, joystick, D-pad) takes over from a click-walk at once (mods/mouse.js)
  if (id !== 'mouse'){ releaseDir('mouse'); callMods('onPlayerDir', [d]); }
  releaseDir(id);
  held.push({id:id, d:d, world:!!world});
  var wd = world ? d : worldDir(d);
  if (canControl() && !P.moving && !waitRelease && P.dir !== wd){ P.dir = wd; P.turnT = TURN_T; }
}
function releaseDir(id){ for (var i = held.length - 1; i >= 0; i--) if (held[i].id === id) held.splice(i, 1); }
function typingIn(t){ return !!(t && (t.isContentEditable || (t.tagName === 'INPUT' && !/^(button|checkbox|radio|range|submit)$/i.test(t.type)) || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')); }
function onButton(e){ return !!(e.target && e.target.closest && e.target.closest('button')); }
function setupInput(){
  window.addEventListener('keydown', function(e){
    if ((e.code === 'F2' || e.code === 'Backquote') && devKey(e)) return;
    if (typingIn(e.target)) return; // letters typed into chat or a form never walk the player
    if (modals.length){ modalKey(e); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (callModsBool('onKey', [e])){ e.preventDefault(); return; }
    var d = KEYDIR[e.code];
    if (d){ e.preventDefault(); if (!e.repeat) pressDir(d, e.code, e.gtWorld); return; } // gtWorld: a mod walking a map path (mouse.js)
    if (e.code === 'Space' || e.code === 'Enter' || e.code === 'KeyZ'){
      if (onButton(e)) return;
      e.preventDefault();
      if (!e.repeat) interact('talk');
      return;
    }
    if (e.code === 'KeyE'){ e.preventDefault(); if (!e.repeat) interact('message'); return; }
    if (e.code === 'KeyM'){ e.preventDefault(); if (!e.repeat && !tr && !D) setMap(!mapOpen); else if (!e.repeat && mapOpen) setMap(false); return; }
    if (e.code === 'Escape' && mapOpen){ setMap(false); return; }
    var hk = hotkeys[e.code];
    if (hk){ e.preventDefault(); if (!e.repeat && !isUiOpen()) hk(); return; }
  });
  window.addEventListener('keyup', function(e){
    var d = KEYDIR[e.code];
    if (d){ releaseDir(e.code); if (!modals.length) e.preventDefault(); }
    else if ((e.code === 'Space' || e.code === 'Enter') && !modals.length && !onButton(e)) e.preventDefault();
  });
  window.addEventListener('blur', function(){ held.length = 0; stick = null; });
  // a text field taking focus (chat opened with / or C while walking) swallows the key's keyup: stop walking now
  document.addEventListener('focusin', function(e){ if (typingIn(e.target)){ held.length = 0; stick = null; } });
  document.addEventListener('visibilitychange', function(){ if (document.hidden) held.length = 0; });
  document.addEventListener('focusin', function(e){
    if (!modals.length) return;
    var top = modals[modals.length - 1];
    if (!top.box.contains(e.target) && !(e.target.closest && e.target.closest('#toasts'))) focusInto(top);
  });

  // touch pad
  Array.prototype.forEach.call(document.querySelectorAll('.dp'), function(btn){
    var dir = btn.getAttribute('data-dir');
    function down(e){ e.preventDefault(); try { btn.setPointerCapture(e.pointerId); } catch(_){} btn.classList.add('down'); pressDir(dir, 'pad:' + dir); }
    function up(e){ btn.classList.remove('down'); releaseDir('pad:' + dir); }
    btn.addEventListener('pointerdown', down);
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('lostpointercapture', up);
    btn.addEventListener('contextmenu', function(e){ e.preventDefault(); });
  });
  function actionBtn(id, mode){
    var b = document.getElementById(id);
    b.addEventListener('pointerdown', function(e){ e.preventDefault(); b.classList.add('down'); interact(mode); });
    ['pointerup','pointercancel','pointerleave'].forEach(function(t){ b.addEventListener(t, function(){ b.classList.remove('down'); }); });
    b.addEventListener('contextmenu', function(e){ e.preventDefault(); });
  }
  actionBtn('btnA', 'talk'); actionBtn('btnE', 'message');
  document.getElementById('padmap').addEventListener('click', function(e){ toggleMapUi(); e.currentTarget.blur(); });
  document.getElementById('mapbtn').addEventListener('click', function(e){ toggleMapUi(); e.currentTarget.blur(); });
  document.getElementById('bagbtn').addEventListener('click', function(e){ e.currentTarget.blur(); if (!isUiOpen()) openBag(); });
  document.getElementById('profbtn').addEventListener('click', function(e){ e.currentTarget.blur(); if (!isUiOpen()) openProfile(); });
  document.getElementById('menubtn').addEventListener('click', function(e){ e.currentTarget.blur(); openMenu(); });
  elMap.addEventListener('click', function(){ setMap(false); });
  elDlg.addEventListener('pointerdown', function(e){ e.preventDefault(); advanceDialog(); });
  document.getElementById('regen').addEventListener('click', function(e){ e.currentTarget.blur(); confirmRegen(); });
  // Mods run init first (chain.js binds I to the NEAR Tas); only fill in defaults they did not claim.
  if (!hotkeys.KeyI) hotkey('I', openBag);
  if (!hotkeys.KeyP) hotkey('P', openProfile);
  if (window.GT_DEV_HOST) addHudButton({id:'devbtn', label:'Dev', onClick:openDev});
}
function toggleMapUi(){ if (tr || D || modals.length) return; setMap(!mapOpen); }

/* ---------- loop ---------- */
var last = 0;
function frame(ts){
  var dt = last ? Math.min(0.05, (ts - last) / 1000) : 0.016;
  last = ts;
  update(dt);
  render();
  updateHud();
  requestAnimationFrame(frame);
}

/* ---------- GT public API ---------- */
function teleportPlayer(ref, x, y, dir){
  var sc = resolveScene(ref) || scene;
  var m = sc.map;
  x = Math.round(x); y = Math.round(y);
  if (!inb(m, x, y) || m.walk[y*m.w + x] !== 1){
    var t = freeTileNear(sc, Math.max(0, Math.min(m.w - 1, x)), Math.max(0, Math.min(m.h - 1, y))); if (t){ x = t.x; y = t.y; }
  }
  if (sc !== scene) setScene(sc, x, y, dir || P.dir);
  else { P.x = P.fx = x; P.y = P.fy = y; P.moving = false; P.t = 0; if (dir) P.dir = dir; evictAt(sc, x, y, null); hudDirty = true; }
}
function addNpc(ref, def){
  var sc = resolveScene(ref) || outScene; def = def || {};
  var x = Math.round(def.x), y = Math.round(def.y);
  if (!isFinite(x) || !isFinite(y) || !canEnterNpc(null, x, y, false, sc)){
    var t = freeTileNear(sc, isFinite(x) ? x : sc.map.w >> 1, isFinite(y) ? y : sc.map.h >> 1); if (!t) return null; x = t.x; y = t.y;
  }
  var n = mkNpc(x, y, String(def.name || 'NPC').slice(0, 24), def.pal != null ? def.pal : 1, def.lines || [['...']], {wander:!!def.wander, leash:def.leash || 0, turns:!!def.turns, key:def.key || null, label:def.label || null});
  if (def.dir) n.dir = def.dir;
  if (def.aff0 != null) n.aff0 = def.aff0;
  if (def.remote) n.remote = true;
  if (def.noAffinity) n.noAffinity = true;
  sc.npcs.push(n);
  return n;
}
function removeNpc(npc){ if (npc){ if (npc.script) finishScript(npc, false); removeNpcFromScenes(npc); } }
function moveNpc(npc, ref, x, y){
  var sc = resolveScene(ref); if (!npc || !sc) return false;
  if (npc.script) finishScript(npc, false);
  npc.follow = false;
  removeNpcFromScenes(npc);
  var t = (isFinite(x) && isFinite(y) && canEnterNpc(null, Math.round(x), Math.round(y), true, sc)) ? {x:Math.round(x), y:Math.round(y)} : freeTileNear(sc, Math.round(x) || 1, Math.round(y) || 1);
  if (!t){ t = {x:Math.round(x), y:Math.round(y)}; }
  placeNpc(sc, npc, t.x, t.y);
  sc.npcs.push(npc);
  return true;
}
function npcTeleport(npc, x, y, dir){
  var sc = npcSceneOf(npc) || scene;
  if (!npc || !canEnterNpc(npc, Math.round(x), Math.round(y), true, sc)) return false;
  placeNpc(sc, npc, Math.round(x), Math.round(y)); if (dir) npc.dir = dir; return true;
}
function npcHide(npc, on){ if (npc){ npc.hidden = !!on; if (on){ npc.moving = false; npc.t = 0; npc.fx = npc.x; npc.fy = npc.y; npc.talking = false; } } }
function findNpc(key){ var r = null; allScenes().forEach(function(sc){ sc.npcs.forEach(function(n){ if (n.key === key) r = n; }); }); return r; }

var GT = {
  // Shared world from the server: same seed and opened chunks for every player. No-op when nothing changed.
  setWorld: function(s, unlocked){
    if (worldId !== 'public') return false; // the village follows the server only while we stand in it
    var u = (unlocked || []).slice().sort();
    if (world && seed === (s >>> 0) && u.join(',') === worldUnlocked.join(',')) return false;
    var keepPos = world && seed === (s >>> 0) ? {x:P.x, y:P.y, scene:scene && scene.kind} : null;
    worldUnlocked = u; regen(s);
    if (keepPos && keepPos.scene === 'out' && world.walk[keepPos.y*world.w + keepPos.x]){ P.x = P.fx = keepPos.x; P.y = P.fy = keepPos.y; }
    return true;
  },
  // Snowy ground (art.js palette swap); rebuilds the baked world only when it changed.
  worldId: function(){ return worldId; },
  switchWorld: switchWorld,
  setSnow: function(on){ GT.setSeason(SPRITES.season, on); },
  // The world follows the season: palette ramps (art.js), baked ground, minimap, and the one gt-s-<season> class on <html>.
  setSeason: function(season, snowy){
    if (!/^(semi|panas|gugur|dingin)$/.test(season)) season = 'semi';
    var root = document.documentElement, cls = 'gt-s-' + season, had = root.classList.contains(cls), first = !seasonSet;
    var changed = !!(window.SPRITES && SPRITES.setSeason && SPRITES.setSeason(season, snowy));
    if (changed || first) { syncMinimapColours(); if (world){ world.mmCache = null; if (changed) buildWorldCache(world); if (mapOpen) drawMinimap(); } }
    ['semi', 'panas', 'gugur', 'dingin'].forEach(function(x){ if (x !== season) root.classList.remove('gt-s-' + x); });
    if (!had) root.classList.add(cls);
    if (!had || first){ seasonSet = true; emit('season', {season:season, snowy:!!SPRITES.snow}); }
    return changed;
  },
  season: function(){ return window.SPRITES ? SPRITES.season : 'semi'; },
  // daylight 0..1 and the current season's ambient light colour (rgba string), for mods that tint the world
  daylight: function(){ return clockInfo().light; },
  ambientLight: function(){ return window.SPRITES && SPRITES.ambientLight ? SPRITES.ambientLight() : null; },
  version: 2,
  state: state,
  ITEMS: ITEMS,
  register: register,
  addCoins: addCoins, spendCoins: spendCoins,
  addItem: addItem, removeItem: removeItem, hasItem: hasItem,
  on: on, off: off, emit: emit,
  npcKey: npcKey,
  findPath: findPath, npcGo: npcGo, npcFollow: npcFollow, npcSay: npcSay,
  playerSay: function(text, secs){ playerFx.bubble = text == null ? null : {text:String(text).slice(0, 140), t:secs || 5}; },
  setPlayerName: function(name){ name = String(name || '').trim().slice(0, 16); if (name){ state.playerName = name; save(); hudDirty = true; } },
  teleportPlayer: teleportPlayer,
  enterBuilding: function(b){ if (b) transition(function(){ enterBuilding(b); }); },
  dialog: function(pages, who, npc, after){ openDialog(pages, who, npc, after); },
  toast: toast, modal: modal, menu: menu, isUiOpen: isUiOpen, drawChar: function(g, x, y, pal, dir, step){ drawChar(g, x, y, pal, dir, step); },
  rng: function(salt){ var r = makeR((seed ^ hashStr(salt)) >>> 0), f = function(){ return r.f(); }; f.int = r.int; f.pick = r.pick; f.chance = r.chance; f.shuffle = r.shuffle; return f; },
  cap: function(name){
    return new Promise(function(resolve){
      var done = false, timer = 0;
      function fin(v){ if (!done){ done = true; clearTimeout(timer); resolve(v == null ? null : v); } }
      try {
        if (!(window.claude && typeof window.claude.use === 'function')) return fin(null);
        timer = setTimeout(function(){ fin(null); }, 10000);
        Promise.resolve(window.claude.use(name)).then(fin, function(){ fin(null); });
      } catch(e){ fin(null); }
    });
  },
  // extras
  facing: function(){ return facingTile(); },
  addHudButton: addHudButton, hotkey: hotkey, setHudDay: setHudDay,
  interact: function(mode){ return interact(mode || 'talk'); },
  // A point on the screen (e.g. a mouse click) to the map tile under it, in the current scene
  screenToTile: function(clientX, clientY){
    if (v3on()) return view3d.pick(clientX, clientY);
    var r = elCv.getBoundingClientRect(); if (!r.width) return null;
    var wx = (clientX - r.left) * (VW / r.width) + camX, wy = (clientY - r.top) * (VH / r.height) + camY;
    return { x: Math.floor(wx / T), y: Math.floor(wy / T) };
  },
  addNpc: addNpc, removeNpc: removeNpc, moveNpc: moveNpc, npcTeleport: npcTeleport, npcHide: npcHide, findNpc: findNpc, npcScene: npcSceneOf,
  engageNpc: function(npc){ if (npc) engage(npc); },
  getScene: resolveScene,
  // walk into a building from a mod (e.g. a Homeland menu): the same door transition as walking through its door
  enterRoom: function(b){ if (b && b.kind && ROOMS[b.kind] || (b && PUBLIC_KINDS[b.kind])) doorTransition(function(){ enterBuilding(b); }); },
  doorFront: function(b){ return b ? {x:b.dx, y:b.dy + 1} : null; },
  getAffinity: getAffinity, setAffinity: setAffinity, addAffinity: addAffinity,
  addReputation: addRep,
  setRole: setRole,
  iconEl: iconEl, itemName: itemName,
  openShop: function(k){ return openShop(k || null); }, openBag: openBag, openProfile: openProfile,
  closeAllModals: closeAllModals,
  isQA: function(){ return QA; },
  giveHandler: null,
  // day / night
  isNight: function(){ return clockInfo().night; },
  setDayLength: setDayLength, setTime: setTime, pauseTime: pauseTime,
  lampNear: lampNear,
  addDevSection: addDevSection,
  openDev: function(){ return openDev(); },
  // the 2.5D view registers here (mods/view3d.js); null turns it off
  setView3d: function(v){ view3d = v || null; },
  at: function(tx, ty){ return at(tx, ty); },
  // Round an overlay position for crisp drawing: whole art pixels in 2D, whole screen pixels in 2.5D. There one overlay
  // unit is several screen pixels while the camera glides, so rounding to units made tags hop and shiver as you walked.
  snap: function(v){ return ovK ? Math.round(v * ovK) / ovK : Math.round(v); },
  setPlayerHidden: function(on){ playerHidden = !!on; },
  // where the player's feet are on #screen (CSS px) and how big one art pixel of their sprite is there, in 2D and 2.5D,
  // so an effect drawn over the view (the character screen's throw) can land exactly on the real sprite
  playerScreen: function(){
    var pp = selfPos();
    if (v3on()){ var p = view3d.toScreen(pp.px / T + 0.5, pp.py / T + 0.5, 0); return { x:p.x * S, y:p.y * S, scale:view3d.artScale(S) }; }
    return { x:(pp.px + 6 - camX) * S, y:(pp.py + 12 - camY) * S, scale:S };
  },
  // an analog walk on screen axes (-1..1 each), e.g. a drag in the 2.5D view; null lets go
  // true: a clean picture for a cinematic moment, the mods' overlays (tags, bubbles, markers, signs) are not drawn
  setCleanView: function(on){ cleanView = !!on; },
  setStick: function(x, y){ stick = x == null ? null : {x:+x || 0, y:+y || 0}; },
  // a direction held by an on-screen control (the phone's joystick), like a held arrow key; null lets go
  padDir: function(d){ releaseDir('joy'); if (d === 'up' || d === 'down' || d === 'left' || d === 'right') pressDir(d, 'joy'); },
  // a mod walking the player along a map path (mods/mouse.js): one world direction held under its own id, null lets go.
  // Any direction the player gives cancels it and calls the mods' onPlayerDir(dir).
  walkDir: function(d){ releaseDir('mouse'); if (d === 'up' || d === 'down' || d === 'left' || d === 'right') pressDir(d, 'mouse', true); },
  // true while the player walks freely (2.5D outdoors), where GT.setStick steers; else held directions step tiles
  freeWalk: function(){ return freeOn(); },
  view3dOn: function(){ return v3on(); }
};
GT.dev = {};
Object.defineProperty(GT.dev, 'enabled', { enumerable:true, get: function(){ return devEnabled; }, set: function(v){
  v = !!v; if (v === devEnabled) return; devEnabled = v; save(); emit('dev', {enabled:v});
}});
Object.defineProperties(GT, {
  dayLength: { get: function(){ return dayLength; } },
  timePaused: { get: function(){ return timePaused; } },
  lamps: { get: function(){ return (world && world.lamps) || []; } },
  world: { get: function(){ return world; } },
  scene: { get: function(){ return scene; } },
  outScene: { get: function(){ return outScene; } },
  // sx / sy: where the player is drawn, in tiles, between two tiles while walking (players.js sends it so others see
  // the same smooth walk); x / y stay the tile, which is what the server checks
  player: { get: function(){ var l = smoothAt(); return { x:P.x, y:P.y, dir:P.dir, moving:P.moving, sx:l.x, sy:l.y }; } },
  sitting: { get: function(){ return sitSpot ? { x:sitSpot.x, y:sitSpot.y, dir:sitSpot.dir } : null; } },
  time: { get: function(){ return clockInfo(); } },
  buildings: { get: function(){ return world ? world.buildings : []; } },
  seed: { get: function(){ return seed; } }
});
window.GT = GT;

/* ---------- debug ---------- */
function reachableReport(){
  var r = bfs(world, world.spawn.x, world.spawn.y), bad = [];
  world.buildings.forEach(function(b){ if (!r[(b.dy + 1)*world.w + b.dx]) bad.push({kind:b.kind, x:b.dx, y:b.dy}); });
  return { ok: bad.length === 0, unreachable: bad, doors: world.buildings.length };
}
function exposeDebug(){
  var g = {
    // run n frames of game updates by hand (tests; a hidden browser tab gets no animation frames)
    step: function(n, dt){ for (var i = 0; i < (n || 1); i++) update(dt || 0.016); render(); updateHud(); },
    regen: function(s){ return regen(s); },

    reachable: reachableReport,
    teleport: function(x, y, dir){ P.x = P.fx = x; P.y = P.fy = y; P.moving = false; P.t = 0; if (dir) P.dir = dir; },
    isWalkable: function(x, y){ var m = scene.map; return inb(m,x,y) && m.walk[y*m.w + x] === 1; },
    interact: function(mode){ interact(mode); },
    setMap: setMap,
    closeDialog: function(){ closeDialog(); },
    enterHouse: function(b){ enterBuilding(b); },
    skipOnboarding: skipOnboarding,
    closeModals: closeAllModals,
    openShop: function(){ return openShop(keeperOf(scene)); },
    openBag: openBag, openProfile: openProfile,
    setTime: setTime, setHudDay: setHudDay, setDayLength: setDayLength, pauseTime: pauseTime, isNight: function(){ return clockInfo().night; },
    lampNear: lampNear, openDev: openDev,
    renderOnce: function(){ render(); },
    setDarkness: function(d){ darkOverride = (d == null) ? null : Math.max(0, Math.min(1, +d)); },
    GT: GT,
    VERSION: 2
  };
  Object.defineProperties(g, {
    seed:   { get: function(){ return seed; } },
    scene:  { get: function(){ return scene.kind; } },
    sceneName: { get: function(){ return locText(); } },
    player: { get: function(){ return { x:P.x, y:P.y, dir:P.dir, moving:P.moving, fx:P.fx, fy:P.fy }; } },
    world:  { get: function(){ return world; } },
    map:    { get: function(){ return scene.map; } },
    houses: { get: function(){ return world.houses; } },
    marts:  { get: function(){ return world.marts; } },
    casino: { get: function(){ return world.casino; } },
    ownHouse: { get: function(){ return world.own; } },
    spawn:  { get: function(){ return world.spawn; } },
    npcs:   { get: function(){ return scene.npcs; } },
    dialog: { get: function(){ return D ? { text:D.pages[D.i], page:D.i, pages:D.pages.length, done:D.done, who:D.who } : null; } },
    dialogOpen: { get: function(){ return !!D; } },
    mapOpen: { get: function(){ return mapOpen; } },
    transitioning: { get: function(){ return !!tr; } },
    scale: { get: function(){ return S; } },
    viewport: { get: function(){ return { w:VW, h:VH, scale:S }; } },
    openModal: { get: function(){ return modals.length; } },
    modalOpen: { get: function(){ return modals.length > 0; } },
    qa: { get: function(){ return QA; } },
    time: { get: function(){ return clockInfo(); } },
    lamps: { get: function(){ return world.lamps; } },
    dayLength: { get: function(){ return dayLength; } },
    timePaused: { get: function(){ return timePaused; } },
    darkness: { get: function(){ return lastDark; } },
    cam: { get: function(){ return {x:camX, y:camY}; } },
    nightCanvas: { get: function(){ return nightCv; } },
    devOpen: { get: function(){ return !!(devModal && devModal.isOpen()); } },
    state: { get: function(){ return { seed:seed, scene:scene.kind, location:locText(), player:g.player, dialogOpen:!!D, mapOpen:mapOpen, transitioning:!!tr,
      coins:state.coins, inventory:state.inventory, role:state.role, playerName:state.playerName, reputation:state.reputation, affinity:state.affinity, clan:state.clan, openModal:modals.length }; } }
  });
  window.__game = g;
}

/* ---------- boot ---------- */
function boot(){
  if (booted) return;
  QA = qaMode();
  elDlg = document.getElementById('dlg'); elTxt = document.getElementById('dtxt'); elWho = document.getElementById('dwho'); elNext = document.getElementById('dnext');
  elLoc = document.getElementById('loc'); elSeed = document.getElementById('seed'); elMap = document.getElementById('map'); elMM = document.getElementById('mm');
  elCv = document.getElementById('cv'); elScreen = document.getElementById('screen'); elFit = document.getElementById('fit'); elFx = document.getElementById('fx');
  elCoins = document.getElementById('coins'); elClock = document.getElementById('clock'); elSm = document.getElementById('sm'); elRole = document.getElementById('role'); elClan = document.getElementById('clan');
  elHud = document.getElementById('hud'); elActs = document.getElementById('acts'); elMroot = document.getElementById('mroot'); elToasts = document.getElementById('toasts'); elApp = document.getElementById('app');
  loadSaved();
  booted = true;
  // mods may register more mods from init, so index loop
  for (var mi = 0; mi < mods.length; mi++) callOne(mods[mi], 'init', [GT]);
  layout();
  regen(savedSeed != null ? savedSeed : undefined);
  setupInput();
  exposeDebug();
  window.addEventListener('resize', layout);
  window.addEventListener('orientationchange', layout);
  window.addEventListener('pagehide', saveNow);
  window.addEventListener('beforeunload', saveNow);
  try {
    if (window.ResizeObserver){
      var lastH = elHud.offsetHeight;
      new ResizeObserver(function(){ var h2 = elHud.offsetHeight; if (h2 !== lastH){ lastH = h2; layout(); } }).observe(elHud);
    }
  } catch(e){}
  // The thief role only exists when the `thief` flag is on (off in the hackathon build): no role choice otherwise.
  if (!thiefOn() && state.role === 'maling'){ state.role = 'warga'; save(); }
  if (!state.onboarded){
    if (QA) { /* tests: no first-boot modal */ }
    else if (thiefOn()) openRoleChoice();
    else { state.onboarded = true; state.role = 'warga'; save(); }
  }
  requestAnimationFrame(frame);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else setTimeout(boot, 0);
})();
