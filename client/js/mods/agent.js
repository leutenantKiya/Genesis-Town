/*
 * agent.js - "NPC agen": NPC berjiwa bertindak seperti pemain asli. Registry aksi + perencana + pelaksana.
 *
 * GT.agent = { registerAction(name, spec), actions(), run(npc, plan, opts), status(npc), cancel(npc), wallet(npc), bag(npc),
 *              resolve(text), skills, observe(npc), parseText(text, ctx), normalizePlan(plan), promptActions(), ... }
 *
 * Menambah aksi baru (otak langsung melihatnya lewat actions()/promptActions()):
 *   GT.agent.registerAction('lompat', {
 *     desc: 'Melompat gembira di tempat.',
 *     params: { kali: 'number: berapa kali' },
 *     label: function(a){ return 'Lompat ' + (a.kali || 1) + 'x'; },          // opsional: teks di daftar tugas
 *     run: async function(npc, args, ctx){ ctx.say('Hup!'); return { ok:true, note:'lompat' }; }
 *   });
 *   run(): Promise<{ok, note}>. ctx = {say, log, signal, wallet(), bag(), go(dest), npc}. Patuhi ctx.signal (batal).
 * Data dompet/tas/ingatan/keterampilan disimpan per seed di localStorage (selalu try/catch).
 */
(function(){
'use strict';
var GT = window.GT;
if (!GT) return;

var STORE_KEY = 'gt.agent.v1';
var DELAY = { shop:1500, talk:1100, give:450, play:800, tick:1500, actTimeout:240000, settle:120 };
var MAX_STEPS = 8;
var rngFn = Math.random;
function r01(){ var v = +rngFn(); return v >= 0 && v < 1 ? v : 0; }

/* ------------------------------------------------------------------ util */
function clampStr(s, n){ return String(s == null ? '' : s).slice(0, n); }
function hash(s){ var h = 2166136261; s = String(s); for (var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function escRe(s){ return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function norm(t){ return ' ' + String(t == null ? '' : t).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim() + ' '; }
function playerName(){ return clampStr((GT.state && GT.state.playerName) || $t('Kamu'), 16); }
function now(){ try { return GT.time.total; } catch(e){ return 0; } }
function key(npc){ return GT.npcKey(npc); }
function W(){ return GT.world; }
function isWorkerKey(k){ return /:keeper$/.test(k) || k === 'casino:dealer'; }
function itemName(id){ try { return GT.itemName(id); } catch(e){ return id; } }
function ABORT(){ var e = new Error('dibatalkan'); e.aborted = true; return e; }
function chk(ctx){ if (ctx && ctx.signal && ctx.signal.aborted) throw ABORT(); }
function sleep(ms, signal){
  return new Promise(function(res, rej){
    if (signal && signal.aborted) return rej(ABORT());
    var t = setTimeout(function(){ if (signal) signal.removeEventListener('abort', ab); res(); }, ms);
    function ab(){ clearTimeout(t); rej(ABORT()); }
    if (signal) signal.addEventListener('abort', ab, { once:true });
  });
}
function waitUntil(cond, signal, maxMs){
  return new Promise(function(res, rej){
    if (signal && signal.aborted) return rej(ABORT());
    var t0 = Date.now();
    var iv = setInterval(function(){
      if (signal && signal.aborted){ clearInterval(iv); return rej(ABORT()); }
      var ok = false; try { ok = cond(); } catch(e){ ok = true; }
      if (ok){ clearInterval(iv); if (signal) signal.removeEventListener('abort', ab); res(true); }
      else if (maxMs && Date.now() - t0 > maxMs){ clearInterval(iv); if (signal) signal.removeEventListener('abort', ab); res(false); }
    }, 250);
    function ab(){ clearInterval(iv); rej(ABORT()); }
    if (signal) signal.addEventListener('abort', ab, { once:true });
  });
}
function fail(note){ return { ok:false, note:note }; }
function okr(note){ return { ok:true, note:note }; }

/* ------------------------------------------------------------------ data (dompet, tas, ingatan, keterampilan) */
var curSeed = null;
var data = {};            // npcKey -> {w, b, mem, auto, g}
var skillStore = {};      // nama -> plan
var relD = {};            // 'a>b' -> perubahan hubungan (persisten per seed)
var enrolled = {};        // npcKey -> provider
var saveTimer = 0;

function lsGet(){ try { var r = window.localStorage.getItem(STORE_KEY); return r ? JSON.parse(r) : null; } catch(e){ return null; } }
function lsSet(o){ try { window.localStorage.setItem(STORE_KEY, JSON.stringify(o)); } catch(e){} }
function scheduleSave(){ if (saveTimer) return; saveTimer = setTimeout(function(){ saveTimer = 0; saveNow(); }, 400); }
function saveNow(){
  if (curSeed == null) return;
  try {
    var st = lsGet() || {}; if (!st.seeds || typeof st.seeds !== 'object') st.seeds = {};
    var o = { npcs:{}, skills:skillStore, rel:relD };
    Object.keys(data).slice(0, 80).forEach(function(k){
      var d = data[k]; o.npcs[k] = { w:d.w, b:d.b, m:d.mem.slice(-20), a:d.auto, g:d.g };
    });
    delete st.seeds[curSeed]; st.seeds[curSeed] = o;
    var ks = Object.keys(st.seeds); while (ks.length > 4){ delete st.seeds[ks.shift()]; }
    lsSet(st);
  } catch(e){}
}
function loadSeed(sd){
  data = {}; skillStore = {}; relD = {};
  try {
    var st = lsGet(), o = st && st.seeds && st.seeds[sd];
    if (o && typeof o === 'object'){
      Object.keys(o.npcs || {}).slice(0, 80).forEach(function(k){
        var v = o.npcs[k]; if (!v || typeof v !== 'object') return;
        var b = {}; if (v.b && typeof v.b === 'object') Object.keys(v.b).slice(0, 20).forEach(function(id){ var c = Math.floor(+v.b[id]); if (c > 0 && isFinite(c) && GT.ITEMS[id]) b[id] = Math.min(c, 999); });
        var w = Math.floor(+v.w); if (!isFinite(w) || w < 0) w = startWallet(k, sd);
        data[clampStr(k, 60)] = { w:Math.min(w, 1e6), b:b, mem:(Array.isArray(v.m) ? v.m : []).slice(-20).map(function(x){ return clampStr(x, 140); }), auto:typeof v.a === 'boolean' ? v.a : null, g:Math.floor(+v.g) || 0 };
      });
      if (o.rel && typeof o.rel === 'object') Object.keys(o.rel).slice(0, 400).forEach(function(k){ var v = Math.round(+o.rel[k]); if (isFinite(v) && v) relD[clampStr(k, 130)] = Math.max(-200, Math.min(200, v)); });
      var sk = o.skills; if (sk && typeof sk === 'object') Object.keys(sk).slice(0, 20).forEach(function(n){ var p = normalizePlan(sk[n]); if (p.steps.length) skillStore[clampStr(n, 24)] = p.steps; });
    }
  } catch(e){}
  curSeed = sd;
}
function startWallet(k, sd){ return 90 + (hash((sd == null ? curSeed : sd) + '|' + k) % 60); }
function dat(k){
  var d = data[k];
  if (!d){ d = data[k] = { w:startWallet(k), b:{}, mem:[], auto:null, g:0 }; scheduleSave(); }
  return d;
}
function wallet(npc){ return dat(key(npc)).w; }
function bag(npc){ var b = dat(key(npc)).b, o = {}; Object.keys(b).forEach(function(id){ o[id] = b[id]; }); return o; }
function addW(npc, n){ var d = dat(key(npc)); d.w = Math.max(0, Math.min(1e6, d.w + Math.floor(n))); scheduleSave(); return d.w; }
function spendW(npc, n){
  n = Math.floor(+n); if (!isFinite(n) || n < 0) return false;
  var d = dat(key(npc)); if (d.w < n) return false;
  d.w -= n; scheduleSave(); return true;
}
function addB(npc, id, n){ var d = dat(key(npc)); d.b[id] = Math.min(999, (d.b[id] || 0) + Math.floor(n)); scheduleSave(); }
function takeB(npc, id, n){
  var d = dat(key(npc)); n = Math.floor(n);
  if (!(n > 0) || (d.b[id] || 0) < n) return false;
  d.b[id] -= n; if (d.b[id] <= 0) delete d.b[id]; scheduleSave(); return true;
}
function remember(npc, text){
  var d = dat(key(npc)); text = clampStr(String(text || '').replace(/\s+/g, ' ').trim(), 120);
  if (!text) return false;
  d.mem.push(text); if (d.mem.length > 20) d.mem.splice(0, d.mem.length - 20);
  scheduleSave(); return true;
}

/* ------------------------------------------------------------------ hubungan NPC<->NPC, jam malam, helper tempur */
function chKey(x){ return x === 'player' ? 'player' : (typeof x === 'string' ? x : key(x)); }
function relBase(a, b){ return (hash(curSeed + '|rel|' + a + '>' + b) % 81) - 30; }       // -30..50 per pasangan terarah
function relation(a, b){
  var ka = chKey(a), kb = chKey(b);
  if (ka === kb) return 100;
  if (kb === 'player'){ var na = typeof a === 'string' ? npcByKey(a) : a; return na ? Math.max(-100, Math.min(100, (GT.getAffinity(na) - 50) * 2)) : 0; }
  if (ka === 'player') return 0;
  return Math.max(-100, Math.min(100, relBase(ka, kb) + (relD[ka + '>' + kb] || 0)));
}
function addRelation(a, b, d){
  var ka = chKey(a), kb = chKey(b);
  if (!ka || !kb || ka === kb || ka === 'player') return 0;
  if (kb === 'player'){ var na = typeof a === 'string' ? npcByKey(a) : a; if (na) GT.addAffinity(na, Math.round(d / 3)); return relation(a, b); }
  var cur = relation(ka, kb), nv = Math.max(-100, Math.min(100, cur + Math.round(d)));
  relD[ka + '>' + kb] = nv - relBase(ka, kb);
  scheduleSave();
  return nv;
}
function setRelation(a, b, v){ var ka = chKey(a), kb = chKey(b); if (kb === 'player' || ka === kb) return relation(a, b); relD[ka + '>' + kb] = Math.max(-100, Math.min(100, Math.round(v))) - relBase(ka, kb); scheduleSave(); return relation(ka, kb); }
function relationsOf(npc){
  var out = [], k = key(npc), seen = {};
  knownChars(npc).forEach(function(c){ if (seen[c.key] || c.key === k) return; seen[c.key] = 1; out.push({ key:c.key, name:c.name, v:relation(k, c.key) }); });
  out.sort(function(x, y){ return y.v - x.v; });
  return out;
}
function relSummary(npc){
  var r = relationsOf(npc), like = r.filter(function(x){ return x.v >= 20; }).slice(0, 3), dis = r.filter(function(x){ return x.v <= -20; }).reverse().slice(0, 3);
  return { suka:like, benci:dis };
}
function curfewNow(){
  try { if (GT.curfew && typeof GT.curfew.active === 'function') return !!GT.curfew.active(); } catch(e){}
  var h = 12; try { h = GT.time.h; if (!isFinite(h)) h = GT.time.hour; } catch(e){}
  return h >= 21 || h < 6;
}
function combat(){ var c = GT.combat; return c && typeof c.hit === 'function' ? c : null; }
function temper(npc){ try { if (GT.combat && typeof GT.combat.temperament === 'function'){ var t = GT.combat.temperament(npc); if (t) return String(t); } } catch(e){} return ['pemberani', 'penakut', 'netral'][hash(curSeed + '|temp|' + key(npc)) % 3]; }
function isKO(ch){ try { return !!(GT.combat && GT.combat.isKO && GT.combat.isKO(ch)); } catch(e){ return false; } }
function cfx(ch, kind){ try { if (GT.combat && GT.combat.fx) GT.combat.fx(ch, kind); } catch(e){} }
function dist1(a, b){ return Math.abs(a.x - b.x) + Math.abs(a.y - b.y); }
var THREATS = [$t('Awas kamu ya!'), $t('Jangan macam-macam denganku!'), $t('Mau cari gara-gara?'), $t('Kuhajar kamu nanti!'), $t('Sini, kalau berani!')];
var CALM = [$t('Sudahlah, kita baikan saja.'), $t('Maaf ya, aku terbawa emosi.'), $t('Yuk damai.'), $t('Ayo kita lupakan.')];
function pickOf(a){ return a[Math.floor(r01() * a.length) % a.length]; }
// target string -> karakter yang boleh diserang; {err} bila tidak
function combatTarget(npc, a){
  var c = resolveChar(a.target || '', npc);
  if (!c) return { err:$t('tidak tahu siapa "{0}"', [clampStr(a.target, 20)]) };
  if (c.kind === 'npc' && c.key === key(npc)) return { err:$t('tidak bisa pada diri sendiri') };
  if (c.kind === 'npc' && isWorkerKey(c.key)) return { err:$t('{0} sedang bertugas', [c.name]) };
  return { c:c };
}
// penolakan karena suka (relasi >= 20 / affinity pemain >= 60); null bila boleh
function likeGate(npc, c){
  if (c.kind === 'player') return GT.getAffinity(npc) >= 60 ? { reply:$t('Aku nggak tega menyakiti {0}.', [playerName()]) } : null;
  return relation(npc, c.key) >= 20 ? { reply:$t('Aku nggak mau menyakiti {0}, dia temanku.', [c.name]) } : null;
}
function combatGate(npc, plan){
  for (var i = 0; i < plan.length; i++){
    var d = plan[i]['do'];
    if (d !== 'ancam' && d !== 'pukul') continue;
    var t = combatTarget(npc, plan[i]); if (t.err) continue;
    var g = likeGate(npc, t.c); if (g) return { reason:'suka', reply:g.reply };
  }
  return null;
}
var MOVERS = { pergi:1, beli:1, beri:1, minta:1, bicara:1, ikuti:1, main_kasino:1, ancam:1, pukul:1, damai:1 };
// apakah rencana ini memaksa NPC keluar rumah (untuk jam malam)?
function needsOutdoor(npc, plan, depth){
  var sc = npcSc(npc);
  return (plan || []).some(function(s){
    var d = s['do'];
    if (d === 'lakukan' && (depth || 0) < 2){ var pl = skillStore[String(s.nama || '').toLowerCase()]; return !!pl && needsOutdoor(npc, pl, (depth || 0) + 1); }
    if (!MOVERS[d]) return false;
    if (!sc || sc === outS()) return true;
    var who = s.kepada || s.target || s.dari || (d === 'pergi' ? s.tujuan : null);
    if (d === 'pergi'){ var pd = resolvePlace(s.tujuan, npc); return !(pd && pd.t === 'bld' && sc.house === pd.b) && !(pd && pd.t === 'char' && charPos(pd.who) && charPos(pd.who).sc === sc); }
    if (d === 'beli' || d === 'main_kasino' || d === 'ikuti') return true;
    var c = who ? resolveChar(who, npc) : null, tp = c ? charPos(c) : null;
    return !(tp && tp.sc === sc);
  });
}

/* ------------------------------------------------------------------ registry aksi */
var actions = {};
var actionOrder = [];
function registerAction(name, spec){
  name = String(name || '').trim().toLowerCase();
  if (!/^[a-z_][a-z0-9_]{0,23}$/.test(name) || !spec || typeof spec.run !== 'function') return false;
  actions[name] = { name:name, desc:clampStr(spec.desc || '', 200), params:spec.params || {}, run:spec.run, label:typeof spec.label === 'function' ? spec.label : null, timeout:spec.timeout != null ? spec.timeout : DELAY.actTimeout, quiet:!!spec.quiet };
  if (actionOrder.indexOf(name) < 0) actionOrder.push(name);
  return true;
}
function listActions(){ return actionOrder.map(function(n){ var a = actions[n]; return { name:n, desc:a.desc, params:a.params }; }); }
function promptActions(){
  return actionOrder.map(function(n){
    var a = actions[n], ps = Object.keys(a.params || {}).map(function(p){ return p + ' (' + a.params[p] + ')'; }).join(', ');
    return '- ' + n + (ps ? ' {' + ps + '}' : '') + ': ' + a.desc;
  }).join('\n');
}

/* ------------------------------------------------------------------ normalisasi rencana */
var ALIASKEY = { action:'do', aksi:'do', type:'do', tindakan:'do', destination:'tujuan', tempat:'tujuan', lokasi:'tujuan', quantity:'n', jumlah:'n', qty:'n', barang:'item',
  to:'kepada', untuk:'kepada', from:'dari', dari_siapa:'dari', message:'pesan', teks:'pesan', minutes:'menit', durasi:'menit', game:'permainan', bet:'taruhan', note:'catatan', steps:'langkah', name:'nama' };
function normStep(o, notes){
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  var s = {};
  Object.keys(o).forEach(function(k){ var lk = String(k).toLowerCase(), ak = ALIASKEY[lk] || lk; if (!(ak in s) || lk === ak) s[ak] = o[k]; });
  var nm = String(s['do'] == null ? '' : s['do']).trim().toLowerCase().replace(/\s+/g, '_');
  if (!actions[nm]){ if (notes && nm) notes.push($t('aksi tak dikenal: {0}', [clampStr(nm, 24)])); return null; }
  var out = { 'do':nm };
  var ps = actions[nm].params || {};
  Object.keys(ps).forEach(function(p){
    if (s[p] == null) return;
    var spec = String(ps[p]), v = s[p];
    if (/^number/.test(spec)){ v = Math.floor(+v); if (!isFinite(v)) return; out[p] = Math.max(0, Math.min(100000, v)); }
    else if (/^array/.test(spec)){ if (Array.isArray(v)) out[p] = v.slice(0, MAX_STEPS); }
    else out[p] = clampStr(typeof v === 'object' ? '' : v, 160);
  });
  if (nm === 'beri' || nm === 'minta'){
    if (out.item == null && s.koin != null){ out.item = 'koin'; var kn = Math.floor(+s.koin); if (isFinite(kn) && kn > 0 && out.n == null) out.n = kn; }
  }
  return out;
}
function normalizePlan(plan){
  var notes = [], steps = [];
  if (plan && !Array.isArray(plan) && typeof plan === 'object') plan = [plan];
  if (!Array.isArray(plan)) return { steps:steps, notes:notes };
  for (var i = 0; i < plan.length && steps.length < MAX_STEPS; i++){
    var s = normStep(plan[i], notes);
    if (s) steps.push(s);
  }
  if (plan.length > MAX_STEPS) notes.push($t('rencana dipotong {0} langkah', [MAX_STEPS]));
  return { steps:steps, notes:notes };
}
function stepLabel(s){
  var a = actions[s['do']];
  try { if (a && a.label) return clampStr(a.label(s), 80); } catch(e){}
  var ps = Object.keys(s).filter(function(k){ return k !== 'do'; }).map(function(k){ return typeof s[k] === 'object' ? '' : s[k]; }).filter(Boolean).join(' ');
  return clampStr(s['do'] + (ps ? ' ' + ps : ''), 80);
}

/* ------------------------------------------------------------------ dunia: bangunan, tile, tetangga */
function outS(){ return GT.outScene; }
function npcSc(npc){ return GT.npcScene(npc); }
function inInterior(npc){ var s = npcSc(npc); return !!s && s !== outS(); }
function occupiedAt(sc, x, y, except){
  if (sc === GT.scene){ var p = GT.player; if (p.x === x && p.y === y) return true; }
  return sc.npcs.some(function(n){ return n !== except && !n.hidden && ((n.x === x && n.y === y) || (n.moving && n.fx === x && n.fy === y)); });
}
function walkableAt(sc, x, y){ var m = sc.map; return x >= 0 && y >= 0 && x < m.w && y < m.h && m.walk[y * m.w + x] === 1; }
function route(sc, from, to, npc){
  var avoid = function(x, y){ return occupiedAt(sc, x, y, npc); };
  return GT.findPath(sc, from, to, { avoid:avoid }) || GT.findPath(sc, from, to);
}
function shortest(sc, from, tiles, npc){
  var best = null;
  for (var i = 0; i < tiles.length && i < 14; i++){
    var t = tiles[i], p = route(sc, from, t, npc);
    if (p && (!best || p.length < best.path.length)) best = { tile:t, path:p };
  }
  return best;
}
function neighborTiles(sc, pos, npc, maxR){
  var out = [], m = sc.map;
  for (var r = 1; r <= (maxR || 2); r++){
    for (var dy = -r; dy <= r; dy++) for (var dx = -r; dx <= r; dx++){
      if (Math.abs(dx) + Math.abs(dy) !== r) continue;
      var x = pos.x + dx, y = pos.y + dy;
      if (!walkableAt(sc, x, y) || occupiedAt(sc, x, y, npc)) continue;
      var i = y * m.w + x;
      if (m.exit && m.exit.has(i)) continue;
      if (sc !== outS() && m.doorFront && m.doorFront.has(i)) continue;
      out.push({ x:x, y:y });
    }
    if (out.length >= 4) break;
  }
  return out;
}
function doorFrontTiles(b, npc){
  var f = GT.doorFront(b), out = [];
  if (!occupiedAt(outS(), f.x, f.y, npc)) out.push(f);
  [[-1, 0], [1, 0], [0, 1], [-1, 1], [1, 1], [0, 2]].forEach(function(d){
    var x = f.x + d[0], y = f.y + d[1];
    if (walkableAt(outS(), x, y) && !occupiedAt(outS(), x, y, npc)) out.push({ x:x, y:y });
  });
  return out;
}
function parkTiles(from, npc){
  var w = W(), types = w.blockTypes || [], nb = Math.round(Math.sqrt(types.length)) || 10, bs = Math.floor(w.w / nb) || 6, blocks = [];
  types.forEach(function(t, i){ if (t === 'park'){ var bx = i % nb, by = Math.floor(i / nb); blocks.push({ bx:bx, by:by, cx:bx * bs + bs / 2, cy:by * bs + bs / 2 }); } });
  blocks.sort(function(a, b){ return (Math.abs(a.cx - from.x) + Math.abs(a.cy - from.y)) - (Math.abs(b.cx - from.x) + Math.abs(b.cy - from.y)); });
  var out = [];
  blocks.slice(0, 2).forEach(function(b){
    var tl = [];
    for (var y = b.by * bs; y < (b.by + 1) * bs; y++) for (var x = b.bx * bs; x < (b.bx + 1) * bs; x++) tl.push({ x:x, y:y, d:Math.abs(x + 0.5 - b.cx) + Math.abs(y + 0.5 - b.cy) });
    tl.sort(function(a, c){ return a.d - c.d; });
    var n = 0;
    for (var i = 0; i < tl.length && n < 8; i++){
      if (!walkableAt(outS(), tl[i].x, tl[i].y) || occupiedAt(outS(), tl[i].x, tl[i].y, npc)) continue;
      n++; out.push({ x:tl[i].x, y:tl[i].y });
    }
  });
  return out;
}

/* ------------------------------------------------------------------ gerak: jalan, masuk, keluar (lintas scene) */
function walkPath(npc, path, ctx){
  return new Promise(function(res){
    var settled = false;
    function fin(v){ if (settled) return; settled = true; if (ctx.signal) ctx.signal.removeEventListener('abort', ab); res(!!v); }
    function ab(){ try { GT.npcGo(npc, []); } catch(e){} fin(false); }
    if (ctx.signal && ctx.signal.aborted) return res(false);
    if (ctx.signal) ctx.signal.addEventListener('abort', ab, { once:true });
    GT.npcGo(npc, path, function(ok){ fin(ok); });
  });
}
// jalan di dalam satu scene ke salah satu tile -> {ok, note}
async function walkTiles(npc, sc, tilesFn, ctx){
  var tries = 0;
  while (tries < 4){
    chk(ctx);
    if (npcSc(npc) !== sc) return fail($t('berpindah tempat'));
    var tiles = tilesFn();
    if (!tiles || !tiles.length) return fail('tak_ada_jalan');
    var here = tiles.some(function(t){ return t.x === npc.x && t.y === npc.y; });
    if (here) return okr('sampai');
    var best = shortest(sc, { x:npc.x, y:npc.y }, tiles, npc);
    if (!best && isWorkerKey(key(npc))){        // petugas di kantong staf (terkurung): pindah langsung ke tile tujuan terdekat
      var tt = tiles[0];
      if (tt && GT.moveNpc(npc, sc, tt.x, tt.y)){ await sleep(DELAY.settle, ctx.signal); return okr('sampai'); }
    }
    if (!best) return fail('tak_ada_jalan');
    if (!best.path.length) return okr('sampai');
    if (npc.follow) GT.npcFollow(npc, false);
    var ok = await walkPath(npc, best.path, ctx);
    chk(ctx);
    if (ok) return okr('sampai');
    tries++;
    await sleep(200, ctx.signal);
  }
  return fail('jalan_terhalang');
}
async function leaveBuilding(npc, ctx){
  var sc = npcSc(npc);
  if (!sc || sc === outS()) return okr($t('di luar'));
  var m = sc.map, e = m.entry || m.mat;
  if (e && !(npc.x === e.x && npc.y === e.y)){
    var p = route(sc, { x:npc.x, y:npc.y }, e, npc);
    if (p && p.length){ await walkPath(npc, p, ctx); chk(ctx); }
  }
  if (npcSc(npc) !== sc) return okr($t('di luar'));
  var f = GT.doorFront(sc.house);
  GT.moveNpc(npc, 'out', f.x, f.y);
  npc.wait = 0.6;
  await sleep(DELAY.settle, ctx.signal);
  return okr('keluar');
}
function isHomeOf(npc, b){ var h = homeDest(npc); return !!h && h.t === 'bld' && h.b === b; }
function enterAllowed(npc, b){
  if (!b) return false;
  return b.kind === 'mart' || b.kind === 'casino' || !!b.invited || isHomeOf(npc, b);
}
async function goBuilding(npc, b, ctx){
  if (!b) return fail($t('tempat tak ditemukan'));
  var cur = npcSc(npc);
  if (cur && cur.house === b) return okr($t('sudah di sana'));
  if (!enterAllowed(npc, b)) return fail($t('terkunci: Rumah {0}', [b.owner || '?']));
  if (cur && cur !== outS()){ var lv = await leaveBuilding(npc, ctx); if (!lv.ok) return lv; }
  chk(ctx);
  var wk = await walkTiles(npc, outS(), function(){ return doorFrontTiles(b, npc); }, ctx);
  if (!wk.ok) return wk;
  var f = GT.doorFront(b);
  if (Math.abs(npc.x - f.x) + Math.abs(npc.y - f.y) > 2) return fail('jalan_terhalang');
  var sc = GT.getScene(b);
  if (!sc) return fail($t('tempat tak ditemukan'));
  chk(ctx);
  var en = sc.map.entry || { x:1, y:1 };
  GT.moveNpc(npc, sc, en.x, en.y);
  npc.wait = 0.6;
  await sleep(DELAY.settle, ctx.signal);
  return okr('masuk');
}
async function goOutdoorTiles(npc, tilesFn, ctx){
  var cur = npcSc(npc);
  if (cur && cur !== outS()){ var lv = await leaveBuilding(npc, ctx); if (!lv.ok) return lv; }
  return walkTiles(npc, outS(), tilesFn, ctx);
}

/* ------------------------------------------------------------------ entitas: tempat, karakter, barang */
var ALIAS = { bunga:['kembang'], kue:['kek', 'cake'], permen:['permen'], susu:['susu'], roti:['roti'], apel:['apel'], obeng:['obeng'] };
function itemId(x){
  if (x == null) return null;
  var s = String(x).trim().toLowerCase();
  if (!s) return null;
  var ids = Object.keys(GT.ITEMS || {});
  if (ids.indexOf(s) >= 0) return s;
  var hit = null;
  ids.forEach(function(id){
    var names = [String((GT.ITEMS[id] && GT.ITEMS[id].name) || '').toLowerCase()].concat(ALIAS[id] || []);
    if (names.indexOf(s) >= 0) hit = id;
  });
  return hit;
}
function itemsIn(s){
  var found = [];
  Object.keys(GT.ITEMS || {}).forEach(function(id){
    var names = [id, String((GT.ITEMS[id] && GT.ITEMS[id].name) || '').toLowerCase()].concat(ALIAS[id] || []);
    names.forEach(function(nm){
      if (!nm) return;
      var re = new RegExp('\\b' + escRe(nm) + '\\b', 'g'), m;
      while ((m = re.exec(s))){ if (!found.some(function(f){ return f.id === id && f.idx === m.index; })) found.push({ id:id, idx:m.index, end:m.index + m[0].length }); }
    });
  });
  found.sort(function(a, b){ return a.idx - b.idx; });
  var out = [];
  found.forEach(function(f){ if (!out.length || out[out.length - 1].id !== f.id || f.idx >= out[out.length - 1].end) out.push(f); });
  return out;
}
var NUMW = { satu:1, dua:2, tiga:3, empat:4, lima:5, enam:6, tujuh:7, delapan:8, sembilan:9, sepuluh:10, sebuah:1, seporsi:1 };
var NUMRE = '(\\d{1,3}|' + Object.keys(NUMW).join('|') + ')';
function toNum(t){ return /^\d+$/.test(t) ? +t : (NUMW[t] || null); }
function qtyOf(s, it){
  var before = s.slice(0, it.idx), after = s.slice(it.end);
  var m = new RegExp(NUMRE + '\\s+(?:buah|biji|porsi|potong|bungkus|botol|kotak|batang)?\\s*$').exec(before);
  if (m && !/koin\s*$/.test(before)) return toNum(m[1]);
  m = new RegExp('^\\s*' + NUMRE + '\\b(?!\\s*(koin|coin|menit|jam))').exec(after);
  if (m) return toNum(m[1]);
  return 1;
}
function coinsIn(s){
  var m = /\b(\d{1,5})\s*(koin|coin|uang|rupiah|perak)\b/.exec(s) || /\b(koin|coin|uang)\s+(\d{1,5})\b/.exec(s);
  if (!m) return null;
  return +(m[1].match(/^\d/) ? m[1] : m[2]);
}
function nearestMart(npc){
  var ms = (W().marts || []).slice();
  var sc = npc ? npcSc(npc) : null, px = npc ? npc.x : 0, py = npc ? npc.y : 0;
  if (sc && sc !== outS() && sc.house){ px = sc.house.dx; py = sc.house.dy; }
  ms.sort(function(a, b){ return (Math.abs(a.dx - px) + Math.abs(a.dy - py)) - (Math.abs(b.dx - px) + Math.abs(b.dy - py)); });
  return ms[0] || null;
}
function houseById(id){ return (W().houses || []).filter(function(h){ return String(h.id) === String(id); })[0] || null; }
function homeDest(npc){
  var w = W(), k = key(npc), m = /^house:(\d+):0$/.exec(k), d = dat(k);
  if (m){ var h = houseById(m[1]) || w.own; if (h) return { t:'bld', b:h, label:'rumah' }; }
  if (npc._post && npc._post.sc && npc._post.sc.house) return { t:'bld', b:npc._post.sc.house, label:'pos' };
  try { if (GT.curfew && typeof GT.curfew.homeOf === 'function' && !isWorkerKey(k)){ var cb = GT.curfew.homeOf(npc); if (cb && cb.kind && cb.dx != null) return { t:'bld', b:cb, label:'rumah' }; } } catch(e){}
  if (!npc._home0 || npc._home0.seed !== curSeed){
    var sc = npcSc(npc);
    npc._home0 = (sc === outS()) ? { x:npc.x, y:npc.y, seed:curSeed } : { x:w.spawn.x, y:w.spawn.y, seed:curSeed };
  }
  return { t:'spot', x:npc._home0.x, y:npc._home0.y, label:'rumah' };
}
function playerHouse(){ var o = W().own; return o ? { t:'bld', b:o, label:$t('rumah {0}', [playerName()]) } : null; }
function npcByKey(k){
  var n = GT.findNpc(k);
  if (n) return n;
  var m = /^house:(\d+):0$/.exec(k);
  if (m){ try { GT.getScene('house:' + m[1]); } catch(e){} return GT.findNpc(k); }
  return null;
}
function knownChars(self){
  var w = W(), out = [], sk = self ? key(self) : '';
  function add(name, k, extra){
    name = String(name || '').trim(); if (!name || k === sk) return;
    out.push({ name:name, lname:name.toLowerCase(), key:k, house:extra || null });
  }
  if (w.own) add($t('Ibu'), 'house:' + w.own.id + ':0', w.own);
  (w.houses || []).forEach(function(h){
    if (h.own) return;
    var first = String(h.owner || '').split(' ')[0];
    add(first, 'house:' + h.id + ':0', h);
  });
  outS().npcs.forEach(function(n){ if (n.key) add(n.name, n.key); });
  add($t('Bandar'), 'casino:dealer');
  out.sort(function(a, b){ return b.lname.length - a.lname.length; });
  return out;
}
var PLAYER_WORDS = /\b(aku|saya|gue|gw|kemari|kesini|sini|pemain|player|dekatku|sampingku|tempatku|padaku|kepadaku|untukku|ku)\b/;
function resolveChar(text, self){
  var s = norm(text);
  if (!s.trim()) return null;
  var pn = playerName().toLowerCase();
  if (pn !== 'kamu' && new RegExp('\\b' + escRe(pn) + '\\b').test(s)) return { kind:'player', name:playerName() };
  var cs = knownChars(self);
  for (var i = 0; i < cs.length; i++){
    if (new RegExp('\\b' + escRe(cs[i].lname) + '\\b').test(s)) return { kind:'npc', name:cs[i].name, key:cs[i].key };
  }
  if (PLAYER_WORDS.test(s) || /\b(kamu|kau|anda)\b/.test(s)) return { kind:'player', name:playerName() };
  return null;
}
function resolvePlace(text, npc){
  var s = norm(text), w = W();
  if (!s.trim()) return null;
  var m = /\bblok\s+(\d+)\s+(\d+)\b/.exec(s);
  if (m) return { t:'tile', x:+m[1], y:+m[2], label:$t('blok {0},{1}', [m[1], m[2]]) };
  if (/\brumah\w*\b|\bpulang\b|\bkamar\b/.test(s)){
    if (/\brumahku\b|\brumah\s+(aku|saya|ku|gue|gw|pemain|player|ibu|kamu|mu)\b|\brumahmu\b/.test(s) || (playerName().toLowerCase() !== 'kamu' && new RegExp('\\brumah\\s+' + escRe(playerName().toLowerCase()) + '\\b').test(s))) return playerHouse();
    var hs = (w.houses || []).filter(function(h){ return !h.own && h.owner; });
    for (var i = 0; i < hs.length; i++){
      var first = String(hs[i].owner).split(' ')[0].toLowerCase();
      if (first && new RegExp('\\b' + escRe(first) + '\\b').test(s)) return { t:'bld', b:hs[i], label:$t('Rumah {0}', [hs[i].owner]) };
    }
    return homeDest(npc);
  }
  if (/\b(mart|minimarket|supermarket|toko|warung|belanja)\b/.test(s)){ var mt = nearestMart(npc); return mt ? { t:'bld', b:mt, label:$t('Mart') } : null; }
  if (/\b(kasino|casino|judi)\b/.test(s)) return w.casino ? { t:'bld', b:w.casino, label:$t('Kasino') } : null;
  if (/\b(taman|park|kebun)\b/.test(s)) return { t:'park', label:'taman' };
  var c = resolveChar(text, npc);
  if (c) return { t:'char', who:c, label:c.name };
  return null;
}
function resolveAll(text, npc){
  var s = norm(text), out = { places:[], chars:[], items:[], numbers:[] };
  var pl = resolvePlace(text, npc);
  if (pl) out.places.push({ type:pl.t, label:pl.label, id:pl.b ? (pl.b.kind + ':' + (pl.b.id != null ? pl.b.id : '')) : null, x:pl.x, y:pl.y });
  var c = resolveChar(text, npc); if (c) out.chars.push(c);
  itemsIn(s).forEach(function(it){ out.items.push({ id:it.id, name:itemName(it.id), n:qtyOf(s, it) }); });
  (s.match(/\b\d+\b/g) || []).forEach(function(n){ out.numbers.push(+n); });
  return out;
}

/* ------------------------------------------------------------------ pergi ke tujuan / karakter */
function charPos(c){
  if (!c) return null;
  if (c.kind === 'player') return { sc:GT.scene, x:GT.player.x, y:GT.player.y, player:true };
  var n = npcByKey(c.key); if (!n) return null;
  var sc = npcSc(n); if (!sc) return null;
  return { sc:sc, x:n.x, y:n.y, npc:n };
}
async function goChar(npc, c, ctx){
  if (c.kind === 'npc' && c.key === key(npc)) return okr($t('sudah di sana'));
  for (var attempt = 0; attempt < 7; attempt++){
    chk(ctx);
    var tp = charPos(c);
    if (!tp) return fail($t('tidak menemukan {0}', [c.name]));
    var sc = npcSc(npc);
    if (sc === tp.sc){
      var d = Math.abs(npc.x - tp.x) + Math.abs(npc.y - tp.y);
      if (d <= 2 && (d <= 1 || attempt >= 1 || true)) return okr($t('dekat {0}', [c.name]));
      var wk = await walkTiles(npc, sc, function(){ var t2 = charPos(c); return t2 && t2.sc === sc ? neighborTiles(sc, t2, npc, 2) : []; }, ctx);
      if (!wk.ok && wk.note === 'tak_ada_jalan') return fail($t('tidak bisa menjangkau {0}', [c.name]));
      continue;
    }
    if (tp.sc === outS()){
      var lv = await leaveBuilding(npc, ctx); if (!lv.ok) return lv;
      continue;
    }
    var gb = await goBuilding(npc, tp.sc.house, ctx);
    if (!gb.ok) return gb;
  }
  return fail($t('tidak berhasil mendekati {0}', [c.name]));
}
async function goDest(npc, d, ctx){
  if (!d) return fail($t('tujuan tidak dikenal'));
  if (npc.follow) GT.npcFollow(npc, false);
  if (d.t === 'bld') return goBuilding(npc, d.b, ctx);
  if (d.t === 'char') return goChar(npc, d.who, ctx);
  if (d.t === 'park') return goOutdoorTiles(npc, function(){ return parkTiles({ x:npc.x, y:npc.y }, npc); }, ctx);
  if (d.t === 'spot' || d.t === 'tile'){
    return goOutdoorTiles(npc, function(){
      var tx = Math.max(0, Math.min(W().w - 1, d.x)), ty = Math.max(0, Math.min(W().h - 1, d.y)), out = [];
      for (var r = 0; r <= 3 && !out.length; r++) for (var dy = -r; dy <= r; dy++) for (var dx = -r; dx <= r; dx++){
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        var x = tx + dx, y = ty + dy;
        if (walkableAt(outS(), x, y) && !occupiedAt(outS(), x, y, npc)) out.push({ x:x, y:y });
      }
      return out;
    }, ctx);
  }
  return fail($t('tujuan tidak dikenal'));
}

/* ------------------------------------------------------------------ log, event */
var listeners = [];
function onEvent(fn){ listeners.push(fn); return function(){ var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; }
function emit(type, o){ o = o || {}; o.type = type; listeners.slice().forEach(function(f){ try { f(o); } catch(e){} }); }

/* ------------------------------------------------------------------ menjalankan rencana */
var runs = {};           // npcKey -> run
var runSeq = 0;
function summarizePlan(steps){ return steps.map(stepLabel).join(', '); }
function runKind(steps){
  var has = function(n){ return steps.some(function(s){ return s['do'] === n; }); };
  if (has('beli')) return 'fetch';
  if (steps.length === 1 && steps[0]['do'] === 'kerja') return 'post';
  if (has('pergi') || has('pulang') || has('tidur')) return steps.length === 1 ? 'goto' : 'plan';
  return 'plan';
}
function mkCtx(r){
  var npc = r.npc;
  return {
    npc:npc, signal:r.ctl.signal, source:r.source, depth:r.depth || 0, forced:!!r.forced,
    say:function(t){ GT.npcSay(npc, t); emit('say', { npc:npc, key:r.key, text:String(t) }); },
    log:function(t){ emit('log', { npc:npc, key:r.key, text:String(t) }); },
    wallet:function(){ return wallet(npc); },
    bag:function(){ return bag(npc); },
    go:function(d){ return goDest(npc, typeof d === 'string' ? resolvePlace(d, npc) : d, mkCtxSelf(r)); },
    _run:r
  };
}
function mkCtxSelf(r){ return r._ctx || (r._ctx = mkCtx(r)); }
function setThought(npc, on, text){
  try {
    if (on){ if (npc._thoughtSaved === undefined){ npc._thoughtSaved = npc.label || null; } npc.label = clampStr(text || '...', 22); }
    else if (npc._thoughtSaved !== undefined){ npc.label = npc._thoughtSaved; delete npc._thoughtSaved; }
  } catch(e){}
}
function run(npc, plan, opts){
  opts = opts || {};
  var np = normalizePlan(plan);
  if (!npc || !np.steps.length) return Promise.resolve({ ok:false, done:[], note:$t('rencana kosong'), dropped:np.notes });
  var k = key(npc), cur = runs[k];
  try { homeDest(npc); } catch(e){}
  if (cur){
    if (opts.source === 'auto' && cur.source !== 'auto') return Promise.resolve({ ok:false, done:[], busy:true, note:$t('sedang sibuk') });
    cancel(npc, 'baru');
  }
  var r = { id:++runSeq, key:k, npc:npc, ctl:new AbortController(), steps:np.steps, states:np.steps.map(function(){ return { state:'wait', note:'' }; }), i:0,
    source:opts.source || 'player', depth:opts.depth || 0, kind:runKind(np.steps), started:now(), epoch:opts.epoch, forced:!!opts.forced };
  runs[k] = r;
  if (r.source === 'auto') setThought(npc, true, '… ' + stepLabel(np.steps[0]));
  emit('plan', { npc:npc, key:k, steps:np.steps.map(stepLabel), source:r.source, dropped:np.notes });
  r.promise = exec(r, opts);
  return r.promise;
}
async function exec(r, opts){
  var npc = r.npc, res = { ok:true, done:[], dropped:[] };
  var ctx = mkCtxSelf(r);
  for (var i = 0; i < r.steps.length; i++){
    r.i = i;
    if (r.ctl.signal.aborted){ res.ok = false; res.cancelled = true; break; }
    var st = r.steps[i], a = actions[st['do']];
    r.states[i] = { state:'run', note:'' };
    if (r.source === 'auto') setThought(npc, true, '… ' + stepLabel(st));
    emit('step', { npc:npc, key:r.key, i:i, state:'run', label:stepLabel(st) });
    var out;
    try {
      var p = a.run(npc, st, ctx);
      if (a.timeout) p = Promise.race([p, new Promise(function(resv){ setTimeout(function(){ resv({ ok:false, note:$t('waktu habis') }); }, a.timeout); })]);
      out = await p;
    } catch(e){
      if (e && e.aborted) out = { ok:false, note:'dibatalkan', cancelled:true };
      else out = { ok:false, note:$t('galat: {0}', [clampStr(e && e.message, 60)]) };
    }
    if (!out || typeof out !== 'object') out = { ok:true, note:'' };
    if (r.ctl.signal.aborted){ res.ok = false; res.cancelled = true; r.states[i] = { state:'cancel', note:'dibatalkan' }; emit('step', { npc:npc, key:r.key, i:i, state:'cancel', label:stepLabel(st), note:'dibatalkan' }); break; }
    var note = clampStr(out.note || '', 120);
    r.states[i] = { state:out.ok ? 'ok' : 'fail', note:note };
    res.done.push({ step:st, ok:!!out.ok, note:note });
    emit('step', { npc:npc, key:r.key, i:i, state:out.ok ? 'ok' : 'fail', label:stepLabel(st), note:note });
    if (!out.ok){ res.ok = false; res.failed = { i:i, step:st, note:note }; break; }
  }
  if (runs[r.key] === r) delete runs[r.key];
  if (r.source === 'auto') setThought(npc, false);
  if (res.cancelled) settleAfterCancel(npc);
  emit('end', { npc:npc, key:r.key, ok:res.ok, cancelled:!!res.cancelled, failed:res.failed || null, source:r.source, kind:r.kind });
  return res;
}
function cancel(npc, why){
  if (!npc) return false;
  var k = key(npc), r = runs[k];
  stopFollow(k);
  if (npc.follow) { try { GT.npcFollow(npc, false); } catch(e){} }
  if (!r) return false;
  r.cancelWhy = why || 'batal';
  try { r.ctl.abort(); } catch(e){}
  try { if (npc.script) GT.npcGo(npc, []); } catch(e){}
  delete runs[k];
  if (r.source === 'auto') setThought(npc, false);
  return true;
}
function settleAfterCancel(npc){
  try { npc.hidden = false; npc.wait = Math.max(npc.wait || 0, 0.6); } catch(e){}
}
function status(npc){
  if (!npc) return { busy:false };
  var k = key(npc), r = runs[k], d = dat(k);
  var o = { busy:!!r, step:r ? r.i : -1, plan:[], wallet:d.w, bag:bag(npc), memory:d.mem.slice(-10), source:r ? r.source : null, kind:r ? r.kind : null, auto:isAuto(k) };
  if (r) o.plan = r.steps.map(function(s, i){ return { 'do':s['do'], label:stepLabel(s), state:r.states[i].state, note:r.states[i].note }; });
  return o;
}
function runOf(k){ return runs[k] || null; }

/* ------------------------------------------------------------------ ikuti (karakter lain) */
var followers = {};
function stopFollow(k){ var f = followers[k]; if (f){ clearInterval(f.iv); delete followers[k]; } }
function startFollowNpc(npc, c){
  var k = key(npc); stopFollow(k);
  var busy = false, f = followers[k] = { c:c, iv:0 };
  f.iv = setInterval(function(){
    if (busy || npc.script || runs[k]) return;
    var tp = charPos(c), sc = npcSc(npc);
    if (!tp || tp.sc !== sc){ stopFollow(k); return; }
    if (Math.abs(npc.x - tp.x) + Math.abs(npc.y - tp.y) <= 2) return;
    var best = shortest(sc, { x:npc.x, y:npc.y }, neighborTiles(sc, tp, npc, 2), npc);
    if (best && best.path.length){ busy = true; GT.npcGo(npc, best.path.slice(0, 12), function(){ busy = false; }); }
  }, 900);
}

/* ------------------------------------------------------------------ aksi bawaan */
function describeThing(a){
  if (a.item === 'koin' || (!a.item && a.n && /koin/.test(String(a.item)))) return $t('{0} koin', [a.n || 0]);
  var id = itemId(a.item); return itemName(id || a.item) + ' x' + (a.n || 1);
}
function clampN(v, lo, hi, def){ v = Math.floor(+v); if (!isFinite(v)) v = def; return Math.max(lo, Math.min(hi, v)); }
function localTime(){ try { return GT.time; } catch(e){ return { h:12, m:0, total:0, day:1 }; } }

registerAction('pergi', {
  desc: $t('Berjalan ke suatu tempat/orang. tujuan: rumah (rumahmu sendiri), rumah aku (rumah pemain), rumah <nama pemilik>, mart, kasino, taman, aku (pemain), <nama orang>, blok x,y. Bisa masuk bangunan yang terbuka.'),
  params: { tujuan:$t('string: tempat atau orang tujuan') },
  label: function(a){ return $t('Pergi ke {0}', [a.tujuan || '?']); },
  run: async function(npc, a, ctx){
    var d = resolvePlace(a.tujuan, npc);
    if (!d) return fail($t('tidak tahu tempat "{0}"', [clampStr(a.tujuan, 24)]));
    var r = await goDest(npc, d, ctx);
    return r.ok ? okr($t('sampai di {0}', [d.label])) : fail(r.note);
  }
});
registerAction('ikuti', {
  desc: $t('Mengikuti pemain atau karakter lain terus-menerus sampai "berhenti".'),
  params: { target:$t('string: aku (pemain) atau nama orang') },
  label: function(a){ return $t('Ikuti {0}', [a.target || 'aku']); },
  run: async function(npc, a, ctx){
    var c = resolveChar(a.target || 'aku', npc) || { kind:'player', name:playerName() };
    stopFollow(key(npc));
    if (c.kind === 'player'){
      var sc = npcSc(npc);
      if (sc !== GT.scene){ var g = await goChar(npc, c, ctx); if (!g.ok) return g; }
      GT.npcFollow(npc, true);
    } else {
      var g2 = await goChar(npc, c, ctx); if (!g2.ok) return g2;
      startFollowNpc(npc, c);
    }
    return okr(c.kind === 'player' ? $t('Ikut denganmu') : $t('ikut {0}', [c.name]));
  }
});
registerAction('berhenti', {
  desc: $t('Berhenti mengikuti dan diam di tempat.'),
  params: {},
  label: function(){ return $t('Berhenti'); },
  run: async function(npc){
    stopFollow(key(npc));
    try { if (npc.script) GT.npcGo(npc, []); GT.npcFollow(npc, false); } catch(e){}
    return okr('berhenti');
  }
});
registerAction('beli', {
  desc: $t('Membeli barang di Mart dengan uang sendiri (otomatis ke Mart dulu). Harga mengikuti harga toko.'),
  params: { item:'string: roti|apel|susu|bunga|kue|permen|obeng', n:$t('number: jumlah (default 1)') },
  label: function(a){ return $t('Beli {0} x{1}', [itemName(itemId(a.item) || a.item), a.n || 1]); },
  run: async function(npc, a, ctx){
    var id = itemId(a.item); if (!id) return fail($t('barang tidak dikenal: {0}', [clampStr(a.item, 20)]));
    var n = clampN(a.n, 1, 20, 1), price = Math.floor(GT.ITEMS[id].price) || 0;
    if (!(price > 0)) return fail($t('{0} tidak dijual', [itemName(id)]));
    var total = price * n;
    if (wallet(npc) < total) return fail($t('uang kurang untuk {0} x{1} (butuh {2}, punya {3})', [itemName(id), n, total, wallet(npc)]));
    var sc = npcSc(npc);
    if (!sc || sc.kind !== 'mart'){
      var m = nearestMart(npc); if (!m) return fail($t('tidak ada Mart'));
      var g = await goBuilding(npc, m, ctx); if (!g.ok) return fail(g.note);
    }
    await sleep(DELAY.shop, ctx.signal);
    if (!spendW(npc, total)) return fail($t('uang kurang'));
    addB(npc, id, n);
    ctx.say($t('Beli {0} dulu.', [itemName(id)]));
    return okr($t('beli {0} x{1} (−{2} koin)', [itemName(id), n, total]));
  }
});
function holdings(npc, a){
  // -> {kind:'koin'|'item', id, n} | {err}
  var isCoin = a.item === 'koin' || a.item === 'coin' || a.item === 'uang';
  if (isCoin){ var n = clampN(a.n, 1, 100000, 0); if (!n) return { err:$t('jumlah koin kosong') }; return { kind:'koin', n:n }; }
  if (String(a.item || '').toLowerCase() === 'semua'){
    var b = bag(npc), ids = Object.keys(b);
    if (!ids.length) return { err:$t('tas kosong') };
    return { kind:'all', ids:ids };
  }
  var id = itemId(a.item); if (!id) return { err:$t('barang tidak dikenal: {0}', [clampStr(a.item, 20)]) };
  return { kind:'item', id:id, n:clampN(a.n, 1, 99, 1) };
}
registerAction('beri', {
  desc: $t('Memberikan barang atau koin milikmu (dari tas/dompet NPC) kepada pemain atau NPC lain. Berjalan ke orangnya dulu.'),
  params: { item:$t('string: nama barang, "koin", atau "semua"'), n:$t('number: jumlah'), kepada:$t('string: aku (pemain) atau nama orang') },
  label: function(a){ return $t('Beri {0} ke {1}', [a.item === 'koin' ? $t('{0} koin', [a.n || 0]) : itemName(itemId(a.item) || a.item) + ' x' + (a.n || 1), a.kepada || 'aku']); },
  run: async function(npc, a, ctx){
    var c = resolveChar(a.kepada || 'aku', npc); if (!c) return fail($t('tidak tahu siapa "{0}"', [clampStr(a.kepada, 20)]));
    var h = holdings(npc, a); if (h.err) return fail(h.err);
    if (h.kind === 'koin' && wallet(npc) < h.n) return fail($t('uang tidak cukup ({0} < {1})', [wallet(npc), h.n]));
    if (h.kind === 'item' && (bag(npc)[h.id] || 0) < h.n) return fail($t('tidak punya {0} x{1}', [itemName(h.id), h.n]));
    var g = await goChar(npc, c, ctx); if (!g.ok) return fail(g.note);
    chk(ctx);
    await sleep(DELAY.give, ctx.signal);
    var tn = c.kind === 'npc' ? npcByKey(c.key) : null;
    if (h.kind === 'koin'){
      if (!spendW(npc, h.n)) return fail($t('uang tidak cukup'));
      if (c.kind === 'player') GT.addCoins(h.n); else if (tn) addW(tn, h.n); else { addW(npc, h.n); return fail($t('penerima hilang')); }
      if (c.kind === 'player') GT.toast($t('{0} memberimu {1} koin.', [npc.name, h.n])); else if (tn) addRelation(tn, npc, 10);
      ctx.say($t('Ini {0} koin.', [h.n]));
      return okr($t('beri {0} koin ke {1}', [h.n, c.name]));
    }
    var ids = h.kind === 'all' ? h.ids : [h.id], parts = [];
    for (var i = 0; i < ids.length; i++){
      var n = h.kind === 'all' ? (bag(npc)[ids[i]] || 0) : h.n;
      if (!takeB(npc, ids[i], n)) { if (h.kind === 'all') continue; return fail($t('tidak punya {0}', [itemName(ids[i])])); }
      if (c.kind === 'player') GT.addItem(ids[i], n); else if (tn) addB(tn, ids[i], n); else { addB(npc, ids[i], n); return fail($t('penerima hilang')); }
      parts.push(itemName(ids[i]) + ' x' + n);
    }
    if (!parts.length) return fail($t('tidak ada yang bisa diberikan'));
    if (c.kind === 'player') GT.toast($t('{0} memberimu {1}.', [npc.name, parts.join(', ')]));
    else if (tn) addRelation(tn, npc, 10);
    ctx.say($t('Ini buatmu: {0}.', [parts.join(', ')]));
    return okr($t('beri {0} ke {1}', [parts.join(', '), c.name]));
  }
});
function askPlayer(npc, thing, signal){
  return new Promise(function(res){
    var done = false, h = null, tmo = 0;
    function fin(v){ if (done) return; done = true; clearTimeout(tmo); if (signal) signal.removeEventListener('abort', ab); res(v); try { if (h && h.isOpen()) h.close('x'); } catch(e){} }
    function ab(){ fin(false); }
    if (signal){ if (signal.aborted) return res(false); signal.addEventListener('abort', ab, { once:true }); }
    var open = function(){
      if (done) return;
      var p = document.createElement('p'); p.textContent = $t('{0} meminta {1} darimu. Beri?', [npc.name, thing]);
      h = GT.modal({ title:$t('Permintaan'), body:p, closable:true, actions:[
        { id:'ya', label:$t('Beri'), primary:true, onClick:function(){ fin(true); return true; } },
        { id:'tidak', label:$t('Tolak'), onClick:function(){ fin(false); return true; } }
      ], onClose:function(){ fin(false); } });
    };
    var tries = 0;
    (function wait(){ if (done) return; if (GT.isUiOpen() && tries++ < 60) return setTimeout(wait, 500); open(); })();
    tmo = setTimeout(function(){ fin(false); }, 60000);
  });
}
registerAction('minta', {
  desc: $t('Meminta barang atau koin dari pemain atau NPC lain. Pemain akan ditanya; NPC memutuskan sendiri berdasarkan kedekatan.'),
  params: { item:$t('string: nama barang atau "koin"'), n:$t('number: jumlah'), dari:$t('string: aku (pemain) atau nama orang') },
  label: function(a){ return $t('Minta {0} dari {1}', [a.item === 'koin' ? $t('{0} koin', [a.n || 0]) : itemName(itemId(a.item) || a.item) + ' x' + (a.n || 1), a.dari || 'aku']); },
  run: async function(npc, a, ctx){
    var c = resolveChar(a.dari || 'aku', npc); if (!c) return fail($t('tidak tahu siapa "{0}"', [clampStr(a.dari, 20)]));
    var isCoin = a.item === 'koin' || a.item === 'uang', id = isCoin ? null : itemId(a.item);
    if (!isCoin && !id) return fail($t('barang tidak dikenal'));
    var n = clampN(a.n, 1, isCoin ? 10000 : 99, 1);
    var g = await goChar(npc, c, ctx); if (!g.ok) return fail(g.note);
    chk(ctx);
    var thing = isCoin ? $t('{0} koin', [n]) : itemName(id) + ' x' + n;
    ctx.say($t('Boleh minta {0}?', [thing]));
    await sleep(DELAY.talk, ctx.signal);
    if (c.kind === 'player'){
      var yes = await askPlayer(npc, thing, ctx.signal); chk(ctx);
      if (!yes) return fail($t('{0} menolak', [playerName()]));
      if (isCoin){ if (!GT.spendCoins(n)) return fail($t('koinmu tidak cukup')); addW(npc, n); }
      else { if (!GT.removeItem(id, n)) return fail($t('kamu tidak punya {0}', [itemName(id)])); addB(npc, id, n); }
      return okr($t('dapat {0} dari {1}', [thing, c.name]));
    }
    var tn = npcByKey(c.key); if (!tn) return fail($t('{0} tidak ada', [c.name]));
    var aff = 20 + (hash(key(npc) + '>' + c.key) % 60);
    if (aff < 50) { GT.npcSay(tn, $t('Maaf, lagi nggak bisa.')); return fail($t('{0} menolak', [c.name])); }
    if (isCoin){ if (!spendW(tn, n)) { GT.npcSay(tn, $t('Uangku kurang.')); return fail($t('{0} tidak punya cukup koin', [c.name])); } addW(npc, n); }
    else { if (!takeB(tn, id, n)) { GT.npcSay(tn, $t('Aku tidak punya itu.')); return fail($t('{0} tidak punya {1}', [c.name, itemName(id)])); } addB(npc, id, n); }
    GT.npcSay(tn, $t('Nih, ambil.'));
    return okr($t('dapat {0} dari {1}', [thing, c.name]));
  }
});
registerAction('bicara', {
  desc: $t('Berjalan ke seseorang lalu mengatakan sesuatu. Jika lawan bicara NPC berjiwa, ia membalas dengan otaknya sendiri.'),
  params: { kepada:$t('string: aku (pemain) atau nama orang'), pesan:$t('string: kalimat singkat') },
  label: function(a){ return $t('Bicara ke {0}', [a.kepada || 'aku']); },
  run: async function(npc, a, ctx){
    var c = resolveChar(a.kepada || 'aku', npc); if (!c) return fail($t('tidak tahu siapa "{0}"', [clampStr(a.kepada, 20)]));
    var msg = clampStr(a.pesan || $t('Halo!'), 140);
    var g = await goChar(npc, c, ctx); if (!g.ok) return fail(g.note);
    chk(ctx);
    ctx.say(msg);
    ctx.log(npc.name + ' ke ' + c.name + ': ' + msg);
    await sleep(DELAY.talk, ctx.signal);
    var tn = c.kind === 'npc' ? npcByKey(c.key) : null, reply = '';
    if (tn){
      try { if (GT.soul && typeof GT.soul._replyTo === 'function') reply = await GT.soul._replyTo(tn, npc.name, msg, ctx.signal); } catch(e){ reply = ''; }
      chk(ctx);
      if (!reply) reply = [$t('Oh, begitu.'), $t('Iya, halo juga!'), $t('Hmm, boleh juga.'), $t('Oke, makasih ya.')][hash(c.key + msg) % 4];
      GT.npcSay(tn, reply);
      ctx.log(c.name + ': ' + reply);
      remember(tn, $t('{0} bilang: {1}', [npc.name, msg]));
      await sleep(DELAY.talk, ctx.signal);
    }
    remember(npc, $t('Bicara ke {0}: {1}', [c.name, msg]));
    return okr($t('bicara ke {0}', [c.name]));
  }
});
registerAction('main_kasino', {
  desc: $t('Pergi ke Kasino lalu bermain dengan uang sendiri (koin permainan). permainan: dadu atau slot.'),
  params: { permainan:'string: dadu|slot', taruhan:$t('number: koin per ronde (10-100)'), ronde:$t('number: jumlah ronde (default 3)') },
  label: function(a){ return $t('Main {0} di kasino', [a.permainan || 'dadu']); },
  run: async function(npc, a, ctx){
    var C = GT.casino; if (!C || typeof C.rollDice !== 'function') return fail($t('kasino belum tersedia'));
    var game = /slot/i.test(a.permainan || '') ? 'slot' : 'dadu';
    var bet = clampN(a.taruhan, C.MIN_BET || 10, 100, 10), rounds = clampN(a.ronde, 1, 6, 3);
    if (wallet(npc) < bet) return fail($t('uang kurang untuk taruhan {0}', [bet]));
    var cas = W().casino; if (!cas) return fail($t('tidak ada Kasino'));
    var g = await goBuilding(npc, cas, ctx); if (!g.ok) return fail(g.note);
    var net = 0, played = 0;
    for (var i = 0; i < rounds; i++){
      chk(ctx);
      if (wallet(npc) < bet) break;
      await sleep(DELAY.play, ctx.signal);
      if (!spendW(npc, bet)) break;
      var pay = 0;
      if (game === 'dadu'){
        var side = r01() < 0.5 ? 'besar' : 'kecil', dice = C.rollDice(), oc = C.diceOutcome(dice, side, bet);
        pay = oc.payout;
      } else { var res = C.spinSlot(); pay = C.slotPayout(res, bet); }
      if (pay > 0) addW(npc, pay);
      net += pay - bet; played++;
      ctx.say(pay > bet ? $t('Menang!') : pay === bet ? $t('Imbang.') : $t('Yah, kalah.'));
    }
    if (!played) return fail($t('tidak sempat bermain'));
    remember(npc, $t('Main {0} di kasino: {1}{2} koin', [game, net >= 0 ? '+' : '', net]));
    return okr($t('main {0} {1}x ({2}{3} koin)', [game, played, net >= 0 ? '+' : '−', Math.abs(net)]));
  }
});
registerAction('tunggu', {
  desc: $t('Menunggu beberapa menit waktu permainan di tempat sekarang.'),
  params: { menit:$t('number: menit waktu game (1-720)') },
  label: function(a){ return $t('Tunggu {0} menit', [a.menit || 15]); },
  timeout: 0,
  run: async function(npc, a, ctx){
    var m = clampN(a.menit, 1, 720, 15), t0 = now();
    await waitUntil(function(){ return now() - t0 >= m; }, ctx.signal, 0);
    return okr($t('menunggu {0} menit', [m]));
  }
});
registerAction('pulang', {
  desc: $t('Pulang ke rumah sendiri.'),
  params: {},
  label: function(){ return $t('Pulang'); },
  run: async function(npc, a, ctx){
    var d = homeDest(npc);
    var r = await goDest(npc, d, ctx);
    return r.ok ? okr($t('sudah di rumah')) : fail(r.note);
  }
});
registerAction('tidur', {
  desc: $t('Pulang lalu tidur sampai pukul 06:00.'),
  params: {},
  label: function(){ return $t('Tidur'); },
  timeout: 0,
  run: async function(npc, a, ctx){
    var r = await goDest(npc, homeDest(npc), ctx);
    if (!r.ok) return fail(r.note);
    var t = localTime(), mins = t.h * 60 + t.m, target = t.total - mins + (mins < 360 ? 360 : 1440 + 360);
    ctx.say($t('Zzz...'));
    await waitUntil(function(){ return now() >= target; }, ctx.signal, 0);
    return okr($t('bangun pukul 06:00'));
  }
});
registerAction('kerja', {
  desc: $t('Kembali ke pos kerja (penjaga Mart, bandar kasino). Warga biasa: tidak ada efek.'),
  params: {},
  label: function(){ return $t('Kembali kerja'); },
  run: async function(npc, a, ctx){
    var p = npc._post;
    if (!p || !p.sc) return okr($t('tidak punya pos'));
    var sc = npcSc(npc);
    if (sc !== p.sc){
      if (sc && sc !== outS()){ var lv = await leaveBuilding(npc, ctx); if (!lv.ok) return lv; }
      var gb = await goBuilding(npc, p.sc.house, ctx);
      if (!gb.ok) GT.moveNpc(npc, p.sc, p.x, p.y);
    }
    chk(ctx);
    if (npcSc(npc) === p.sc && (npc.x !== p.x || npc.y !== p.y)){
      var path = GT.findPath(p.sc, { x:npc.x, y:npc.y }, { x:p.x, y:p.y });
      if (path && path.length){ await walkPath(npc, path, ctx); chk(ctx); }
    }
    if (npcSc(npc) !== p.sc) GT.moveNpc(npc, p.sc, p.x, p.y);
    else if (npc.x !== p.x || npc.y !== p.y){ if (!GT.npcTeleport(npc, p.x, p.y, p.dir)) GT.moveNpc(npc, p.sc, p.x, p.y); }
    npc.hidden = false; npc.wander = p.wander; npc.leash = p.leash; npc.turns = p.turns; npc.follow = false;
    npc.home = { x:p.x, y:p.y }; npc.dir = p.dir; npc.wait = 1;
    p.returned = true; npc._post = null;
    return okr($t('kembali ke pos'));
  }
});
registerAction('ingat', {
  desc: $t('Mencatat sesuatu ke ingatanmu (dibaca lagi di observasi berikutnya).'),
  params: { catatan:$t('string: catatan singkat') },
  label: function(a){ return $t('Ingat: {0}', [clampStr(a.catatan, 40)]); },
  quiet: true,
  run: async function(npc, a){ return remember(npc, a.catatan) ? okr($t('mengingat: {0}', [clampStr(a.catatan, 60)])) : fail($t('catatan kosong')); }
});
registerAction('ajari', {
  desc: $t('Menyimpan keterampilan baru: nama + daftar langkah (aksi) yang bisa dijalankan lagi dengan "lakukan".'),
  params: { nama:$t('string: nama keterampilan'), langkah:$t('array: daftar langkah [{do:...}]') },
  label: function(a){ return $t('Pelajari "{0}"', [clampStr(a.nama, 20)]); },
  quiet: true,
  run: async function(npc, a){
    var r = skills.teach(a.nama, a.langkah);
    return r.ok ? okr($t('belajar "{0}" ({1} langkah)', [r.name, r.steps])) : fail(r.note);
  }
});
registerAction('lakukan', {
  desc: $t('Menjalankan keterampilan yang pernah diajarkan.'),
  params: { nama:$t('string: nama keterampilan') },
  label: function(a){ return $t('Lakukan "{0}"', [clampStr(a.nama, 20)]); },
  timeout: 0,
  run: async function(npc, a, ctx){
    var nm = String(a.nama || '').trim().toLowerCase(), pl = skillStore[nm];
    if (!pl) return fail($t('belum bisa "{0}"', [clampStr(nm, 20)]));
    if ((ctx.depth || 0) >= 2) return fail($t('terlalu dalam'));
    var steps = normalizePlan(pl).steps, n = 0;
    for (var i = 0; i < steps.length; i++){
      chk(ctx);
      var act = actions[steps[i]['do']];
      if (steps[i]['do'] === 'lakukan' && (ctx.depth || 0) >= 1) return fail($t('terlalu dalam'));
      var sub = Object.create(ctx); sub.depth = (ctx.depth || 0) + 1;
      var out;
      try { out = await act.run(npc, steps[i], sub); } catch(e){ if (e && e.aborted) throw e; out = fail('galat'); }
      if (!out || !out.ok){ return fail($t('"{0}" gagal di langkah {1}: {2}', [nm, i + 1, clampStr(out && out.note, 60)])); }
      n++;
      ctx.log('  ✓ ' + (out.note || stepLabel(steps[i])));
    }
    return okr($t('selesai "{0}" ({1} langkah)', [nm, n]));
  }
});
registerAction('lapor', {
  desc: $t('Menyampaikan pesan kepada pemain (toast + catatan obrolan). Cocok di akhir rencana.'),
  params: { pesan:$t('string: laporan singkat') },
  label: function(){ return $t('Lapor'); },
  quiet: true,
  run: async function(npc, a, ctx){
    var msg = clampStr(a.pesan || $t('Sudah beres.'), 140);
    GT.toast(npc.name + ': ' + msg); ctx.say(msg);
    emit('report', { npc:npc, key:key(npc), text:msg });
    return okr($t('lapor: {0}', [msg]));
  }
});
registerAction('hadiah', {
  desc: $t('Memberi pemain hadiah kecil gratis (maksimal sekali sehari).'),
  params: {},
  label: function(){ return $t('Beri hadiah'); },
  run: async function(npc, a, ctx){
    var d = dat(key(npc)), day = localTime().day;
    if (d.g === day) return fail($t('Hari ini sudah kuberi hadiah, besok lagi ya.'));
    var ids = Object.keys(GT.ITEMS || {}).filter(function(id){ var p = GT.ITEMS[id].price; return p > 0 && p <= 15; });
    if (!ids.length) return fail($t('Aku lagi tidak punya apa-apa.'));
    var id = ids[Math.floor(r01() * ids.length) % ids.length];
    d.g = day; scheduleSave(); npc._lastGift = id;
    GT.addItem(id, 1);
    GT.toast($t('{0} memberimu {1}.', [npc.name, itemName(id)]));
    ctx.say($t('Nih, buatmu!'));
    return { ok:true, note:$t('hadiah {0}', [itemName(id)]), item:id };
  }
});

/* ------------------------------------------------------------------ ancam / pukul / damai + perkelahian */
var fight = null, activeCombat = 0, lastScan = 0, lastThreat = {};
function doHit(att, tg){ try { return GT.combat.hit(att, tg) || { ok:false, reason:'?' }; } catch(e){ return { ok:false, reason:'galat' }; } }
function hpRatio(n){ try { var m = GT.combat.maxHp(n); return m > 0 ? GT.combat.hp(n) / m : 1; } catch(e){ return 1; } }
async function approach(npc, c, ctx, maxD){
  for (var t = 0; t < 6; t++){
    chk(ctx);
    var tp = charPos(c); if (!tp) return fail($t('tidak menemukan {0}', [c.name]));
    var sc = npcSc(npc);
    if (sc === tp.sc){
      if (dist1(npc, tp) <= maxD) return okr($t('dekat {0}', [c.name]));
      var wk = await walkTiles(npc, sc, function(){ var t2 = charPos(c); return t2 && t2.sc === sc ? neighborTiles(sc, t2, npc, 1) : []; }, ctx);
      if (!wk.ok && wk.note === 'tak_ada_jalan') return fail($t('tidak bisa menjangkau {0}', [c.name]));
      continue;
    }
    var g = await goChar(npc, c, ctx); if (!g.ok) return fail(g.note);
  }
  return fail($t('tidak berhasil mendekati {0}', [c.name]));
}
function fleeFrom(n, from){
  try {
    var sc = npcSc(n); if (!sc) return false;
    var best = [], R = 7;
    for (var dy = -R; dy <= R; dy += 1) for (var dx = -R; dx <= R; dx += 1){
      var x = n.x + dx, y = n.y + dy, d = Math.abs(dx) + Math.abs(dy);
      if (d < 4 || d > R || !walkableAt(sc, x, y) || occupiedAt(sc, x, y, n)) continue;
      best.push({ x:x, y:y, sc:dist1({ x:x, y:y }, from) - 0.3 * d });
    }
    best.sort(function(a, b){ return b.sc - a.sc; });
    for (var i = 0; i < Math.min(6, best.length); i++){
      var pth = GT.findPath(sc, { x:n.x, y:n.y }, best[i]);
      if (pth && pth.length){ if (n.follow) GT.npcFollow(n, false); GT.npcGo(n, pth.slice(0, 10)); n.wait = 2; return true; }
    }
  } catch(e){}
  return false;
}
function startFight(a, b, why){
  if (fight || !combat() || !a || !b || a === b) return false;
  if (isWorkerKey(key(a)) || isWorkerKey(key(b)) || a.hidden || b.hidden) return false;
  var sc = npcSc(a); if (!sc || sc !== npcSc(b)) return false;
  var bad = false;
  [a, b].forEach(function(n){ var r = runs[key(n)]; if (r && r.source !== 'auto') bad = true; });
  if (bad) return false;
  [a, b].forEach(function(n){ if (runs[key(n)]) cancel(n, 'berkelahi'); stopFollow(key(n)); });
  fight = { a:a, b:b, sc:sc, n:0, turn:0, fail:0, stuck:0, t0:Date.now(), iv:0, why:why || '' };
  cfx(a, 'threat'); cfx(b, 'threat');
  GT.npcSay(a, pickOf(THREATS)); GT.npcSay(b, $t('Ayo maju!'));
  fight.iv = setInterval(fightTick, 800);
  remember(a, $t('Berkelahi dengan {0}', [b.name])); remember(b, $t('Berkelahi dengan {0}', [a.name]));
  emit('fight', { a:a, b:b, state:'start' });
  // v2.4: polisi melerai perkelahian (siang atau malam)
  try { if (GT.police && GT.police.respond) GT.police.respond({ x:a.x, y:a.y, scene:(sc === outS() ? 'out' : sc), reason:'fight', parties:[a, b] }); } catch(e){}
  return true;
}
function endFight(why, loser){
  var f = fight; if (!f) return;
  clearInterval(f.iv); fight = null;
  [f.a, f.b].forEach(function(n){ n.wait = 1.5; });
  if (loser && !isKO(loser)){
    var win = loser === f.a ? f.b : f.a;
    GT.npcSay(loser, $t('Sudah, aku menyerah!')); fleeFrom(loser, win);
    addRelation(loser, win, -5);
  }
  emit('fight', { a:f.a, b:f.b, state:'end', why:why });
}
function fightTick(){
  var f = fight; if (!f) return;
  if (document.hidden || (GT.isUiOpen && GT.isUiOpen())) return;
  var a = f.a, b = f.b;
  if (npcSc(a) !== f.sc || npcSc(b) !== f.sc || a.hidden || b.hidden) return endFight('pisah');
  if (isKO(a) || isKO(b)) return endFight('ko');
  if (f.n >= 14 || Date.now() - f.t0 > 40000) return endFight('lelah');
  var ra = hpRatio(a), rb = hpRatio(b);
  if (ra < 0.3 || rb < 0.3) return endFight('menyerah', ra < rb ? a : b);
  a.wait = Math.max(a.wait || 0, 1); b.wait = Math.max(b.wait || 0, 1);
  if (dist1(a, b) > 1){
    var m = f.turn % 2 ? b : a, o = m === a ? b : a; f.turn++;
    if (m.script) return;
    var best = shortest(f.sc, { x:m.x, y:m.y }, neighborTiles(f.sc, o, m, 1), m);
    if (best && best.path.length) GT.npcGo(m, best.path.slice(0, 4)); else if (++f.stuck > 8) endFight('terhalang');
    return;
  }
  var att = f.turn % 2 ? b : a, tg = att === a ? b : a; f.turn++;
  if (att.script) return;
  att.dir = tg.x > att.x ? 'right' : tg.x < att.x ? 'left' : tg.y > att.y ? 'down' : 'up';
  var r = doHit(att, tg);
  if (r.ok){ f.n++; if (r.ko) endFight('ko'); }
  else if (++f.fail > 10) endFight('gagal');
}
// efek ancaman: bubble + FX + reaksi sasaran menurut watak. -> 'none' | 'flee' | 'give' | 'fight'
function threatEffects(npc, c){
  var line = pickOf(THREATS), tobj = c.kind === 'player' ? 'player' : npcByKey(c.key);
  if (GT.combat && typeof GT.combat.threat === 'function'){ try { GT.combat.threat(npc, tobj || 'player', line); } catch(e){ cfx(npc, 'threat'); GT.npcSay(npc, line); } }
  else { cfx(npc, 'threat'); GT.npcSay(npc, line); }
  if (c.kind === 'player'){ try { GT.toast($t('{0} mengancammu!', [npc.name])); GT.addAffinity(npc, -3); } catch(e){} return 'none'; }
  var tn = npcByKey(c.key); if (!tn) return 'none';
  addRelation(tn, npc, -10);
  remember(tn, $t('{0} mengancamku', [npc.name]));
  if (isWorkerKey(c.key)){ GT.npcSay(tn, $t('Tolong! Jangan ganggu aku!')); return 'none'; }
  var tm = temper(tn);
  if (tm === 'penakut'){
    var coins = Math.min(10, wallet(tn));
    if (coins >= 3 && r01() < 0.5){ spendW(tn, coins); addW(npc, coins); GT.npcSay(tn, $t('Ini {0} koin, jangan pukul aku!', [coins])); return 'give'; }
    GT.npcSay(tn, $t('Hii! Jangan!')); fleeFrom(tn, npc); return 'flee';
  }
  if (tm === 'pemberani' && (relation(tn, npc) < -45 || r01() < 0.5)){
    GT.npcSay(tn, $t('Kamu yang cari gara-gara!'));
    return startFight(tn, npc, 'balas') ? 'fight' : 'none';
  }
  GT.npcSay(tn, tm === 'pemberani' ? $t('Coba saja kalau berani.') : $t('Hei, apa maksudmu?'));
  return 'none';
}
function fightScan(){
  if (fight || activeCombat || !combat() || document.hidden || !W() || curSeed == null) return;
  var t = now(), dt = lastScan ? Math.min(120, t - lastScan) : 0; lastScan = t;
  if (dt <= 0 || curfewNow() || (GT.isUiOpen && GT.isUiOpen()) || GT.scene !== outS()) return;
  var ns = outS().npcs.filter(function(n){ return n.key && !n.hidden && !n.isPolice && !n.isRemote && !isWorkerKey(n.key) && !n.follow && !n.talking && !runs[n.key] && !isKO(n); });
  var worst = null;
  for (var i = 0; i < ns.length; i++) for (var j = 0; j < ns.length; j++){
    if (i === j) continue;
    var a = ns[i], b = ns[j];
    if (Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) > 2) continue;
    var rl = relation(a, b); if (rl >= -20) continue;
    var pk = a.key + '>' + b.key; if (t - (lastThreat[pk] || -1e9) < 120) continue;
    if (!worst || rl < worst.rl) worst = { a:a, b:b, rl:rl, pk:pk };
  }
  if (!worst || r01() >= 1 - Math.pow(0.8, dt / 60)) return;
  lastThreat[worst.pk] = t;
  if (worst.rl < -45){ startFight(worst.a, worst.b, 'benci'); return; }
  var res = threatEffects(worst.a, { kind:'npc', key:worst.b.key, name:worst.b.name });
  emit('threat', { a:worst.a, b:worst.b, outcome:res });
}

registerAction('ancam', {
  desc: $t('Mengancam seseorang (berjalan ke dekatnya, menggertak). Yang penakut bisa kabur atau memberi koin, yang pemberani bisa membalas dan berkelahi. Hubungannya dengan korban memburuk. Tidak mau pada orang yang disukai.'),
  params: { target:$t('string: nama orang atau aku (pemain)') },
  label: function(a){ return $t('Ancam {0}', [a.target || '?']); },
  run: async function(npc, a, ctx){
    var t = combatTarget(npc, a); if (t.err) return fail(t.err);
    var c = t.c;
    if (!ctx.forced){ var g = likeGate(npc, c); if (g){ ctx.say(g.reply); return fail($t('menolak: {0} disukai', [c.name])); } }
    var ap = await approach(npc, c, ctx, 2); if (!ap.ok) return fail(ap.note);
    chk(ctx);
    var out = threatEffects(npc, c);
    await sleep(DELAY.talk, ctx.signal);
    remember(npc, $t('Mengancam {0}', [c.name]));
    return okr($t('ancam {0}{1}', [c.name, out === 'flee' ? $t(' (kabur)') : out === 'give' ? $t(' (memberi koin)') : out === 'fight' ? $t(' (membalas)') : '']));
  }
});
registerAction('pukul', {
  desc: $t('Memukul seseorang (berjalan sampai bersebelahan, lalu memukul beberapa kali sampai lawan pingsan/kabur). Tidak mau pada orang yang disukai. target boleh pemain (aku).'),
  params: { target:$t('string: nama orang atau aku (pemain)'), kali:$t('number: jumlah pukulan (default 3)') },
  label: function(a){ return $t('Pukul {0}{1}', [a.target || '?', a.kali ? ' x' + a.kali : '']); },
  run: async function(npc, a, ctx){
    if (!combat()) return fail($t('belum bisa memukul'));
    var t = combatTarget(npc, a); if (t.err) return fail(t.err);
    var c = t.c;
    if (!ctx.forced){ var g = likeGate(npc, c); if (g){ ctx.say(g.reply); return fail($t('menolak: {0} disukai', [c.name])); } }
    var kali = clampN(a.kali, 1, 10, 3), hits = 0, total = 0, ko = false, bad = 0, why = '';
    activeCombat++;
    try {
      ctx.say($t('Rasakan ini!'));
      while (hits < kali && bad < 6){
        var ap = await approach(npc, c, ctx, 1);
        if (!ap.ok){ why = ap.note; break; }
        var tgt = c.kind === 'player' ? 'player' : npcByKey(c.key);
        if (!tgt){ why = $t('{0} hilang', [c.name]); break; }
        if (isKO(tgt)){ ko = true; break; }
        var tp = charPos(c); if (tp) npc.dir = tp.x > npc.x ? 'right' : tp.x < npc.x ? 'left' : tp.y > npc.y ? 'down' : 'up';
        var r = doHit(npc, tgt);
        if (r.ok){ hits++; total += r.dmg || 0; if (r.ko){ ko = true; break; } } else { bad++; why = String(r.reason || 'gagal'); }
        await sleep(800, ctx.signal);
      }
    } finally { activeCombat--; }
    if (!hits) return fail(why ? $t('tidak bisa memukul {0} ({1})', [c.name, clampStr(why, 30)]) : $t('tidak memukul'));
    remember(npc, $t('Memukul {0} {1}x', [c.name, hits]));
    return okr($t('pukul {0} {1}x (−{2} HP){3}', [c.name, hits, total, ko ? $t(', pingsan') : '']));
  }
});
registerAction('damai', {
  desc: $t('Berdamai dengan seseorang (berjalan ke dekatnya, meminta maaf). Hubungan membaik dan perkelahian di antara mereka berhenti.'),
  params: { target:$t('string: nama orang atau aku (pemain)') },
  label: function(a){ return $t('Berdamai dengan {0}', [a.target || '?']); },
  run: async function(npc, a, ctx){
    var c = resolveChar(a.target || '', npc); if (!c) return fail($t('tidak tahu siapa "{0}"', [clampStr(a.target, 20)]));
    if (c.kind === 'npc' && c.key === key(npc)) return fail($t('tidak bisa pada diri sendiri'));
    var ap = await approach(npc, c, ctx, 2); if (!ap.ok) return fail(ap.note);
    chk(ctx);
    ctx.say(pickOf(CALM));
    cfx(npc, 'heal');
    if (c.kind === 'player'){ GT.addAffinity(npc, 1); }
    else {
      var tn = npcByKey(c.key);
      if (tn){
        addRelation(npc, tn, 15); addRelation(tn, npc, 15);
        if (fight && ((fight.a === npc && fight.b === tn) || (fight.a === tn && fight.b === npc))) endFight('damai');
        await sleep(DELAY.talk, ctx.signal);
        GT.npcSay(tn, $t('Iya, sudah. Maaf juga.'));
      }
    }
    remember(npc, $t('Berdamai dengan {0}', [c.name]));
    return okr($t('berdamai dengan {0}', [c.name]));
  }
});
GT.on('hit', function(e){
  try {
    if (!e) return;
    var at = e.attackerNpc || (e.attacker && typeof e.attacker === 'object' ? e.attacker : null), tg = e.targetNpc || (e.target && typeof e.target === 'object' ? e.target : null);
    if (!at || !tg) return;
    addRelation(tg, at, -25); addRelation(at, tg, -5);
  } catch(err){}
});

/* ------------------------------------------------------------------ keterampilan */
function teach(name, steps){
  name = clampStr(String(name || '').trim().toLowerCase().replace(/\s+/g, ' '), 24);
  if (!name) return { ok:false, note:$t('nama keterampilan kosong') };
  var np = normalizePlan(steps);
  if (!np.steps.length) return { ok:false, note:$t('langkah kosong') };
  if (Object.keys(skillStore).length >= 20 && !skillStore[name]) return { ok:false, note:$t('terlalu banyak keterampilan') };
  skillStore[name] = np.steps; scheduleSave();
  return { ok:true, name:name, steps:np.steps.length };
}
var skills = {};
Object.defineProperties(skills, {
  teach:  { value:function(n, st){ var r = teach(n, st); syncSkillView(); return r; } },
  forget: { value:function(name){ name = String(name || '').trim().toLowerCase(); if (!skillStore[name]) return false; delete skillStore[name]; scheduleSave(); syncSkillView(); return true; } },
  list:   { value:function(){ return Object.keys(skillStore); } },
  get:    { value:function(name){ var p = skillStore[String(name || '').trim().toLowerCase()]; return p ? JSON.parse(JSON.stringify(p)) : null; } }
});
function syncSkillView(){
  Object.keys(skills).forEach(function(k){ delete skills[k]; });
  Object.keys(skillStore).forEach(function(k){ skills[k] = skillStore[k]; });
}

/* ------------------------------------------------------------------ observasi */
function sceneLabel(sc){
  if (!sc || sc === outS()) return $t('di luar');
  if (sc.kind === 'mart') return $t('di Mart');
  if (sc.kind === 'casino') return $t('di Kasino');
  return sc.house ? (sc.house.own ? $t('di rumah {0}', [playerName()]) : $t('di rumah {0}', [sc.house.owner])) : $t('di dalam');
}
function observe(npc){
  var k = key(npc), d = dat(k), t = localTime(), sc = npcSc(npc), w = W();
  var near = [];
  if (sc){
    sc.npcs.forEach(function(n){ if (n === npc || n.hidden) return; var dist = Math.abs(n.x - npc.x) + Math.abs(n.y - npc.y); if (dist <= 10) near.push({ nama:n.name, jarak:dist }); });
    if (sc === GT.scene){ var p = GT.player, dp = Math.abs(p.x - npc.x) + Math.abs(p.y - npc.y); near.push({ nama:$t('{0} (pemain)', [playerName()]), jarak:dp }); }
  }
  near.sort(function(a, b){ return a.jarak - b.jarak; });
  var ps = GT.scene === outS() ? $t('di luar') : sceneLabel(GT.scene);
  var places = ['rumah (rumahmu)', 'rumah aku (rumah ' + playerName() + ')', 'mart', 'kasino', 'taman'];
  (w.houses || []).forEach(function(h){ if (!h.own && h.invited && h.owner) places.push($t('rumah {0}', [String(h.owner).split(' ')[0]])); });
  var r = runs[k];
  return {
    nama:npc.name, waktu:t.hhmm || (t.h + ':' + t.m), hari:t.day, malam:!!t.night,
    scene:sceneLabel(sc), posisi:{ x:npc.x, y:npc.y },
    pemain:{ nama:playerName(), lokasi:ps },
    sekitar:near.slice(0, 6), tempat:places.slice(0, 12),
    dompet:d.w, tas:bag(npc), tugas:r ? r.steps.map(stepLabel).join(' > ') : null,
    ingatan:d.mem.slice(-10), keterampilan:Object.keys(skillStore),
    gosip:(function(){ try { return GT.gossip && GT.gossip.forNpc ? GT.gossip.forNpc(npc) : []; } catch(e){ return []; } })(),
    relasi:(function(){ var r = relSummary(npc); return { disukai:r.suka.map(function(x){ return x.name + ' ' + x.v; }), dibenci:r.benci.map(function(x){ return x.name + ' ' + x.v; }) }; })()
  };
}

/* ------------------------------------------------------------------ parser teks Indonesia -> rencana */
var STOP = /\b(berhenti|stop|diam|tunggu (di )?sini|tunggu disini|stay|lepas|cukup sampai sini)\b|\bjangan\s+ikut\w*|\b(tidak|nggak|gak|ga|enggak)\s+usah\s+ikut\w*/;
var FOLLOW = /\b(ikut\w*|temani|temenin|menemani|jalan bareng|ayo jalan|follow)\b/;
var COME = /\b(kemari|kesini|ke sini|mendekat|dekati aku|samperin aku|menghampiri|hampiri aku|datang ke aku|ke tempatku|datang)\b/;
var VERBS = 'beli\\w*|membeli|belanja|kasih\\w*|beri\\w*|berikan|ambilkan|ambilin|belikan|ikut\\w*|main|bermain|tunggu|pulang|tidur|bilang|katakan|bicara|ngobrol|lapor\\w*|ingat\\w*|minta\\w*|lakukan|jalankan|ajari|ancam\\w*|mengancam|gertak\\w*|menggertak|pukul\\w*|memukul|serang\\w*|menyerang|hajar\\w*|menghajar|tonjok\\w*|menonjok|hantam\\w*|baikan|berbaikan|damai|berdamai|maafkan';
var SPLIT_VERB = new RegExp('\\s+(?=(?:' + VERBS + ')\\b)', 'g');
var SKIP_BEFORE = /\b(jangan|tidak|nggak|gak|ga|mau|bisa|ayo|tolong|coba|mari|boleh|harus|usah|dan|lalu|terus|ke|dari|untuk|buat)$/;

function splitClauses(raw){
  var t = ' ' + String(raw || '').toLowerCase().replace(/[“”"]/g, '').replace(/[,;]+/g, ' | ').replace(/\s+/g, ' ') + ' ';
  t = t.replace(/\s+(lalu|terus|kemudian|setelah itu|habis itu|abis itu|selanjutnya|trus|baru|sesudah itu)\s+/g, ' | ');
  t = t.replace(/\s+dan\s+(?=(?:ke|pergi|menuju|beli\w*|membeli|kasih\w*|beri\w*|berikan|ikut\w*|main|bermain|pulang|tidur|tunggu|bilang|katakan|bicara|ambil\w*|lapor\w*|ingat\w*|minta\w*|ancam\w*|mengancam|gertak\w*|menggertak|pukul\w*|memukul|serang\w*|menyerang|hajar\w*|menghajar|tonjok\w*|menonjok|hantam\w*|baikan|berbaikan|damai|berdamai|maafkan)\b)/g, ' | ');
  var parts = t.split('|'), out = [];
  parts.forEach(function(p){
    p = p.trim(); if (!p) return;
    // pecah sebelum kata kerja bila tidak didahului kata pembantu
    var words = p.split(' '), cur = [];
    words.forEach(function(wd, i){
      if (i > 0 && new RegExp('^(?:' + VERBS + ')$').test(wd) && !SKIP_BEFORE.test(words[i - 1])){ out.push(cur.join(' ')); cur = []; }
      cur.push(wd);
    });
    out.push(cur.join(' '));
  });
  return out.map(function(x){ return x.trim(); }).filter(Boolean);
}
function placeToken(d, npc){
  if (!d) return null;
  if (d.t === 'char') return d.who.kind === 'player' ? 'aku' : d.who.name;
  if (d.t === 'bld'){
    if (d.b.kind === 'mart') return 'mart';
    if (d.b.kind === 'casino') return 'kasino';
    if (d.b.own) return 'rumah aku';
    var h = homeDest(npc);
    if (h && h.t === 'bld' && h.b === d.b) return 'rumah';
    return $t('rumah {0}', [String(d.b.owner || '').split(' ')[0]]);
  }
  if (d.t === 'park') return 'taman';
  if (d.t === 'spot') return 'rumah';
  if (d.t === 'tile') return $t('blok {0},{1}', [d.x, d.y]);
  return null;
}
function parseText(text, c){
  c = c || {};
  var npc = c.npc, steps = [], skipped = [], bought = [];
  var raw = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  // ajari NAMA: langkah, langkah
  var mt = /^\s*(?:tolong\s+)?ajari(?:n)?\s+(?:kamu\s+)?(.+?)\s*[:\-]\s*(.+)$/i.exec(raw);
  if (mt){
    var sub = parseText(mt[2], c);
    return { steps:[{ 'do':'ajari', nama:clampStr(mt[1].trim().toLowerCase(), 24), langkah:sub.steps }], skipped:sub.skipped, teach:true };
  }
  var clauses = splitClauses(raw);
  clauses.forEach(function(cl){
    var s = norm(cl).replace(/\brumahmu\b|\brumah kamu\b/g, ' rumah ').replace(/\s+/g, ' ');
    s = ' ' + s.trim() + ' ';
    var its = itemsIn(s), added = 0;
    function push(st){ steps.push(st); added++; }
    if (STOP.test(s)){ push({ 'do':'berhenti' }); return; }
    var m = /\b(?:lakukan|jalankan|kerjakan|terapkan)\s+(?:skill\s+|keahlian\s+|keterampilan\s+)?([a-z0-9 ]+?)\s*$/.exec(s);
    if (m){ var nm = m[1].trim(); if (nm && (skillStore[nm] || true)){ push({ 'do':'lakukan', nama:nm }); return; } }
    m = /\bingat\w*\s+(?:bahwa\s+|kalau\s+)?(.+?)\s*$/.exec(s);
    if (m){ push({ 'do':'ingat', catatan:clampStr(m[1], 100) }); return; }
    var hv = /\b(damai|berdamai|baikan|berbaikan|maafkan|minta maaf)\b/.exec(s) || /\b(ancam\w*|mengancam|gertak\w*|menggertak)\b/.exec(s) || /\b(pukul\w*|memukul|serang\w*|menyerang|hajar\w*|menghajar|tonjok\w*|menonjok|hantam\w*|menghantam)\b/.exec(s);
    if (hv && !(/\bpukul\s+\d/.test(s))){
      var hw = hv[1], kind = /damai|baikan|maaf/.test(hw) ? 'damai' : /ancam|gertak/.test(hw) ? 'ancam' : 'pukul';
      var htg = resolveChar(s.replace(hv[0], ' '), npc);
      if (!htg){ skipped.push(cl); return; }
      var hst = { 'do':kind, target:htg.kind === 'player' ? 'aku' : htg.name };
      if (kind === 'pukul'){ var hk = /\b(\d{1,2})\s*(kali|x)\b/.exec(s) || new RegExp('\\b' + NUMRE + '\\s*kali\\b').exec(s); if (hk) hst.kali = toNum(hk[1]) || 3; }
      push(hst); return;
    }
    if (/\btunggu\b/.test(s)){
      var nn = /\b(\d{1,4})\s*(menit|jam)?\b/.exec(s), mn = 30;
      if (nn) mn = +nn[1] * (nn[2] === 'jam' ? 60 : 1);
      else { var wm = new RegExp('\\b' + NUMRE + '\\s*(menit|jam)?\\b').exec(s); if (wm && NUMW[wm[1]]) mn = NUMW[wm[1]] * (wm[2] === 'jam' ? 60 : 1); }
      push({ 'do':'tunggu', menit:Math.max(1, Math.min(720, mn)) }); return;
    }
    if (/\b(tidur|istirahat)\b/.test(s)){ push({ 'do':'tidur' }); return; }
    if (/\b(main|bermain|judi|taruh\w*)\b/.test(s) && /\b(dadu|slot|kasino|casino)\b/.test(s) || /\b(dadu|slot)\b/.test(s) && /\bmain\b/.test(s)){
      var g = /\bslot\b/.test(s) ? 'slot' : 'dadu', st = { 'do':'main_kasino', permainan:g };
      var tb = /\b(?:taruhan|bet)\s*(\d{1,4})\b/.exec(s) || /\b(\d{1,4})\s*koin\b/.exec(s);
      if (tb) st.taruhan = +tb[1];
      push(st); return;
    }
    if (/\b(bilang|katakan|sampaikan|ngomong|bicara|ngobrol|sapa\w*|tanya\w*)\b/.test(s) && !/\b(kasih|beri|beli)\b/.test(s)){
      var who = null, rest = s;
      var mw = /\b(?:ke|kepada|sama|dengan|pada)\s+([a-z]+(?:\s+[a-z]+)?)\b/.exec(s);
      var tgt = resolveChar(mw ? mw[1] : s, npc) || resolveChar(s, npc);
      var pesan = s.replace(/\b(bilang|katakan|sampaikan|ngomong|bicara|ngobrol|sapa\w*|tanya\w*|ke|kepada|sama|dengan|pada)\b/g, ' ');
      if (tgt){ if (tgt.kind === 'player') pesan = pesan.replace(PLAYER_WORDS, ' '); else pesan = pesan.replace(new RegExp('\\b' + escRe(tgt.name.toLowerCase()) + '\\b'), ' '); }
      pesan = pesan.replace(/\s+/g, ' ').trim();
      push({ 'do':'bicara', kepada:tgt ? (tgt.kind === 'player' ? 'aku' : tgt.name) : 'aku', pesan:pesan || $t('Halo!') }); return;
    }
    if (/\b(ambilkan|ambilin|belikan|beliin|bawakan|bawain|carikan|cariin|mintakan)\b/.test(s) && its.length){
      its.forEach(function(it){ bought.push({ id:it.id, n:qtyOf(s, it) }); });
      push({ 'do':'pergi', tujuan:'mart' });
      bought.slice(-its.length).forEach(function(b){ push({ 'do':'beli', item:b.id, n:b.n }); });
      push({ 'do':'pergi', tujuan:'aku' });
      bought.slice(-its.length).forEach(function(b){ push({ 'do':'beri', item:b.id, n:b.n, kepada:'aku' }); });
      return;
    }
    if (/\bminta\w*\b/.test(s) && !/\bmintakan\b/.test(s)){
      var from = resolveChar(s.replace(/\bminta\w*\b/, ' '), npc), co = coinsIn(s);
      var fr = from ? (from.kind === 'player' ? 'aku' : from.name) : 'aku';
      if (co) push({ 'do':'minta', item:'koin', n:co, dari:fr });
      else if (its.length) its.forEach(function(it){ push({ 'do':'minta', item:it.id, n:qtyOf(s, it), dari:fr }); });
      else skipped.push(cl);
      return;
    }
    if (/\b(kasih\w*|beri\w*|berikan|kirim\w*|traktir\w*|serahkan)\b/.test(s)){
      var to = resolveChar(s.replace(/\b(kasih\w*|beri\w*|berikan|kirim\w*|traktir\w*|serahkan)\b/, ' '), npc);
      var kep = to ? (to.kind === 'player' ? 'aku' : to.name) : 'aku', co2 = coinsIn(s);
      if (co2) push({ 'do':'beri', item:'koin', n:co2, kepada:kep });
      else if (its.length){
        its.forEach(function(it){
          var n = qtyOf(s, it), have = npc ? (bag(npc)[it.id] || 0) : 0;
          if (have < n && kep === 'aku'){ push({ 'do':'pergi', tujuan:'mart' }); push({ 'do':'beli', item:it.id, n:n - have }); push({ 'do':'pergi', tujuan:'aku' }); }
          push({ 'do':'beri', item:it.id, n:n, kepada:kep });
        });
      }
      else if (bought.length) bought.forEach(function(b){ push({ 'do':'beri', item:b.id, n:b.n, kepada:kep }); });
      else if (/\b(hadiah|kado|kejutan|oleh oleh)\b/.test(s)) push({ 'do':'hadiah' });
      else skipped.push(cl);
      return;
    }
    if (/\b(hadiah|kado|kejutan)\b/.test(s)){ push({ 'do':'hadiah' }); return; }
    if (/\b(beli\w*|membeli|belanja)\b/.test(s)){
      if (its.length) its.forEach(function(it){ var n = qtyOf(s, it); bought.push({ id:it.id, n:n }); push({ 'do':'beli', item:it.id, n:n }); });
      else skipped.push(cl);
      return;
    }
    if (FOLLOW.test(s)){
      var ft = resolveChar(s.replace(FOLLOW, ' '), npc);
      push({ 'do':'ikuti', target:ft && ft.kind === 'npc' ? ft.name : 'aku' }); return;
    }
    if (/\bkerja\b/.test(s)){ push({ 'do':'kerja' }); return; }
    var pl = resolvePlace(s, npc);
    if (/\bpulang\b/.test(s) && (!pl || pl.t !== 'bld' || /\bpulang\b/.test(s) && !/\brumah\w*\b/.test(s))){ push({ 'do':'pulang' }); return; }
    if (pl){
      var movey = /\b(ke|menuju|pergi|ayo|antar\w*|jalan|samperin|kesana|datangi|kunjungi|mampir|masuk|temui|temuin|hampiri)\b/.test(s);
      var tok = placeToken(pl, npc);
      if (movey || cl.trim().split(/\s+/).length <= 2){ if (tok) push({ 'do':'pergi', tujuan:tok }); else skipped.push(cl); return; }
    }
    if (COME.test(s)){ push({ 'do':'pergi', tujuan:'aku' }); return; }
    skipped.push(cl);
  });
  return { steps:steps.slice(0, MAX_STEPS), skipped:skipped };
}

/* ------------------------------------------------------------------ otonomi */
var auto = { qa:false, state:{}, hook:null, lastLlm:0, iv:0 };
function isAuto(k){
  if (isWorkerKey(k)) return false;
  var d = data[k];
  if (d && typeof d.auto === 'boolean') return d.auto;
  return enrolled[k] === 'local';
}
function setAuto(npc, on){ var d = dat(key(npc)); d.auto = !!on; scheduleSave(); return d.auto; }
function enroll(k, provider){ if (!k) return; enrolled[k] = provider || 'local'; }
function unenroll(k){ delete enrolled[k]; delete auto.state[k]; }
function hourBucket(){ return localTime().h; }
function routinePlan(npc){
  var k = key(npc), t = localTime(), h = t.h, rnd = GT.rng('agent:' + k + ':' + t.day + ':' + h), d = dat(k);
  var trait = hash(k) % 5;                        // 0 rumahan, 1 sosial, 2 penjelajah, 3 penjudi, 4 dermawan
  var inv = d.b, has = function(id){ return (inv[id] || 0) > 0; };
  var aff = GT.getAffinity(npc);
  // hadiah untuk pemain
  if (aff >= 60 && d.g !== t.day && rnd() < 0.3 && h >= 8 && h < 21){
    if (Object.keys(inv).length) return [{ 'do':'pergi', tujuan:'aku' }, { 'do':'beri', item:Object.keys(inv)[0], n:1, kepada:'aku' }, { 'do':'lapor', pesan:$t('Ini sedikit hadiah buatmu.') }];
    if (d.w >= 30) return [{ 'do':'pergi', tujuan:'mart' }, { 'do':'beli', item:'apel', n:1 }, { 'do':'pergi', tujuan:'aku' }, { 'do':'beri', item:'apel', n:1, kepada:'aku' }];
  }
  if (curfewNow() || h >= 22 || h < 5) return [{ 'do':'tidur' }];
  if (h < 10){
    if (d.w >= 12 && !has('roti')) return [{ 'do':'pergi', tujuan:'mart' }, { 'do':'beli', item:'roti', n:1 }, { 'do':'pulang' }];
    return [{ 'do':'pergi', tujuan:'taman' }, { 'do':'tunggu', menit:30 }];
  }
  if (h < 15){
    var r = rnd();
    var friends = (W().houses || []).filter(function(x){ return !x.own && x.invited && x.owner; });
    if (trait === 1 && friends.length && r < 0.6){
      var f = friends[Math.floor(rnd() * friends.length) % friends.length], nm = String(f.owner).split(' ')[0];
      return [{ 'do':'pergi', tujuan:$t('rumah {0}', [nm]) }, { 'do':'bicara', kepada:nm, pesan:$t('Halo {0}, main ke sini nih!', [nm]) }, { 'do':'pulang' }];
    }
    if (r < 0.5) return [{ 'do':'pergi', tujuan:'taman' }, { 'do':'tunggu', menit:45 }];
    var cs = knownChars(npc).filter(function(c){ return c.key.indexOf('out:') === 0 || /^house:/.test(c.key); });
    if (cs.length && r < 0.8){ var c2 = cs[Math.floor(rnd() * cs.length) % cs.length]; return [{ 'do':'bicara', kepada:c2.name, pesan:$t('Halo, apa kabar?') }]; }
    return [{ 'do':'pergi', tujuan:'taman' }, { 'do':'pulang' }];
  }
  if (h < 18){
    if (d.w >= 15){
      var ids = Object.keys(GT.ITEMS || {}).filter(function(id){ var p = GT.ITEMS[id].price; return p > 0 && p <= Math.min(25, d.w) && id !== 'obeng'; });
      if (ids.length){ var it = ids[Math.floor(rnd() * ids.length) % ids.length]; return [{ 'do':'pergi', tujuan:'mart' }, { 'do':'beli', item:it, n:1 }, { 'do':'pulang' }]; }
    }
    return [{ 'do':'pulang' }];
  }
  if (trait === 3 && d.w >= 50 && rnd() < 0.7) return [{ 'do':'main_kasino', permainan:rnd() < 0.5 ? 'dadu' : 'slot', taruhan:10, ronde:3 }, { 'do':'pulang' }];
  return [{ 'do':'pulang' }];
}
function autoGoal(npc, forced){
  var k = key(npc);
  if (runs[k]) return Promise.resolve(false);
  var hk = auto.hook, llm = hk && hk.isLlm && hk.isLlm(npc);
  if (curfewNow()){ run(npc, [{ 'do':'tidur' }], { source:'auto' }); return Promise.resolve(true); }
  var st = auto.state[k] || (auto.state[k] = { next:0, llm:-1e9 });
  var t = now();
  if (llm && hk.autoPlan){
    if (document.hidden || (!forced && t - st.llm < 180) || Date.now() - auto.lastLlm < 8000) return Promise.resolve(false);
    st.llm = t; auto.lastLlm = Date.now();
    return Promise.resolve(hk.autoPlan(npc)).then(function(plan){
      if (!plan || runs[k]) return false;
      run(npc, plan, { source:'auto' }); return true;
    }, function(){ return false; });
  }
  var plan = routinePlan(npc);
  if (!plan || !plan.length) return Promise.resolve(false);
  if (plan.some(function(s){ return s['do'] === 'beri' && s.kepada === 'aku'; })) dat(k).g = localTime().day;
  run(npc, plan, { source:'auto' });
  return Promise.resolve(true);
}
var lastDay = -1;
function autoTick(){
  if (!W() || curSeed == null) return;
  var t = localTime();
  if (t.day !== lastDay){
    lastDay = t.day;
    Object.keys(data).forEach(function(k){ if (data[k].w < 60) data[k].w += 40; });
    scheduleSave();
  }
  if (document.hidden) return;
  if (GT.isQA() && !auto.qa) return;
  var total = t.total;
  Object.keys(enrolled).forEach(function(k){
    if (!isAuto(k) || runs[k]) return;
    var st = auto.state[k] || (auto.state[k] = { next:total + 60 + hash(k + curSeed) % 90, llm:-1e9 });
    var nk = t.h >= 21 ? t.day : t.day - 1;
    if (curfewNow() && st.nightDay !== nk){ var n0 = npcByKey(k); if (n0 && !n0.follow && !n0._post && npcSc(n0) === outS()){ st.nightDay = nk; st.next = 0; } else if (n0 && npcSc(n0) !== outS()) st.nightDay = nk; }
    if (total < st.next) return;
    var npc = npcByKey(k); if (!npc) { st.next = total + 60; return; }
    if (npc.talking || npc.follow || npc._post || (GT.isUiOpen() && GT.scene === npcSc(npc) && false)) { st.next = total + 30; return; }
    st.next = total + 120 + Math.floor(r01() * 120);
    autoGoal(npc, false);
  });
  // NPC yang nyasar di bangunan orang lama-lama pulang sendiri
  Object.keys(enrolled).forEach(function(k){
    if (runs[k] || isWorkerKey(k)) return;
    var npc = GT.findNpc(k); if (!npc) return;
    var sc = npcSc(npc);
    if (!sc || sc === outS() || !sc.house || isHomeOf(npc, sc.house)) { delete auto.state[k + ':in']; return; }
    var s2 = auto.state[k + ':in'] || (auto.state[k + ':in'] = { since:total });
    if (total - s2.since >= 150){ delete auto.state[k + ':in']; run(npc, [{ 'do':'pulang' }], { source:'auto' }); }
  });
}

/* ------------------------------------------------------------------ dunia berganti */
function cancelAll(){
  Object.keys(runs).forEach(function(k){ var r = runs[k]; try { r.ctl.abort(); } catch(e){} delete runs[k]; });
  Object.keys(followers).forEach(stopFollow);
  if (fight) endFight('dunia');
  lastThreat = {}; lastScan = 0;
}
function onWorld(){
  if (curSeed != null) saveNow();
  cancelAll();
  auto.state = {}; enrolled = {};
  loadSeed(GT.seed);
  syncSkillView();
}

GT.agent = {
  version:2,
  relation:relation,
  addRelation:addRelation,
  setRelation:setRelation,
  relations:function(npc){ return relationsOf(npc); },
  relSummary:relSummary,
  combatGate:combatGate,
  needsOutdoor:needsOutdoor,
  curfewNow:curfewNow,
  fightActive:function(){ return !!fight || activeCombat > 0; },
  startFight:startFight,
  endFight:function(){ endFight('manual'); },
  temperament:temper,
  _fightScan:fightScan,
  registerAction:registerAction,
  actions:listActions,
  promptActions:promptActions,
  run:run,
  status:status,
  cancel:function(npc){ return cancel(npc, 'batal'); },
  cancelAll:cancelAll,
  wallet:wallet,
  bag:bag,
  addWallet:function(npc, n){ return addW(npc, n); },
  giveCoins:function(npc, n){ n = Math.floor(+n); if (!(n > 0) || !GT.spendCoins(n)) return false; addW(npc, n); return true; },
  resolve:function(text, npc){ return resolveAll(text, npc); },
  resolvePlace:resolvePlace,
  resolveChar:resolveChar,
  itemId:itemId,
  skills:skills,
  teach:function(n, s){ return skills.teach(n, s); },
  forget:function(n){ return skills.forget(n); },
  observe:observe,
  parseText:parseText,
  normalizePlan:normalizePlan,
  describe:summarizePlan,
  stepLabel:stepLabel,
  remember:remember,
  giftedToday:function(npc){ return dat(key(npc)).g === localTime().day; },
  memory:function(npc){ return dat(key(npc)).mem.slice(); },
  on:onEvent,
  enroll:enroll,
  unenroll:unenroll,
  setAuto:setAuto,
  isAuto:function(npc){ return isAuto(key(npc)); },
  setHook:function(h){ auto.hook = h || null; },
  npcByKey:npcByKey,
  homeOf:homeDest,
  autoGoal:function(npc){ return autoGoal(npc, true); },
  routine:routinePlan,
  setQaAuto:function(on){ auto.qa = !!on; },
  _setDelays:function(o){ if (o) Object.keys(o).forEach(function(k){ if (k in DELAY && isFinite(+o[k])) DELAY[k] = +o[k]; }); },
  _setRng:function(fn){ rngFn = typeof fn === 'function' ? fn : Math.random; },
  _runs:function(){ return Object.keys(runs); },
  _save:saveNow
};

GT.register({
  id:'agent',
  init:function(){ auto.iv = setInterval(autoTick, DELAY.tick); setInterval(function(){ try { fightScan(); } catch(e){ console.error('[agent] fightScan', e); } }, 1000); window.addEventListener('pagehide', saveNow); },
  onWorld:function(){ onWorld(); }
});
})();

