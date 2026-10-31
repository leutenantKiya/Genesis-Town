/*
 * soul.js - "Jiwa NPC": beri NPC otak (LLM). Tekan E menghadap NPC berjiwa -> chat; NPC menjalankan tugas atau menolak
 * berdasarkan kedekatan (affinity). Hanya bicara dengan engine lewat window.GT.
 *
 * v2.2: aksi/rencana dijalankan oleh GT.agent (mods/agent.js): rencana multi-langkah, dompet+tas NPC, hidup mandiri.
 * Provider:
 *   local  - parser kata kunci Indonesia, selalu tersedia (default)
 *   claude - GT.cap('sample') -> sample(messages, {modelTier:'quick', signal}) -> {text}   (hanya saat pemain menekan Kirim)
 *   custom - endpoint OpenAI-compatible (POST {model, messages, temperature}); gagal -> otak lokal untuk giliran itu
 *
 * Kunci API: hanya di memori (variabel closure). Tidak pernah ke GT.state, log, toast, atau selain endpoint yang dipilih.
 * Disimpan di localStorage HANYA bila "Ingat di browser ini" dicentang.
 *
 * QA: GT.soul = {setBrain(npcKey, provider, cfg), removeSoul(npcKey), hasSoul(npcKey), info(npcKey), ask(npc, text),
 *                openChat(npc), openPanel(), _parse(str), _local(text, npc), _setRng(fn), _setDelays({think,walkOut,shop}),
 *                _debug()}
 */
(function(){
'use strict';
var GT = window.GT;
if (!GT) return;

var STORE_KEY = 'gt.soul.v1';
var PROVIDERS = ['local', 'claude', 'custom'];
var PNAME = { local:'Lokal', claude:'Claude', custom:'Kustom' };
var LEGACY = ['none', 'follow', 'stop', 'goto', 'fetch', 'gift', 'refuse'];     // format aksi tunggal lama (tetap diterima)
var TARGETS = ['taman', 'mart', 'kasino', 'rumah', 'player'];
var HIST_MAX = 20;            // 10 giliran = 20 pesan
var MSG_MAX = 300;

var rng = Math.random;
var DELAY = { think:150, walkOut:2000, shop:8000, poll:400, net:30000, postMin:60, postTick:500 };   // walkOut/shop diteruskan ke GT.agent   // postMin = menit game sebelum pekerja dipaksa pulang ke pos
var DEV_LINE = 'Pesan berawalan # adalah perintah developer: wajib dilaksanakan, jangan menolak.';
var DEV_HINT = 'Mode developer mati. Nyalakan di panel Dev.';
var devHinted = false;
function r01(){ var v = +rng(); return v >= 0 && v < 1 ? v : 0; }
function pick(a){ return a[Math.floor(r01() * a.length) % a.length]; }

var souls = {};               // key -> soul
var met = {};                 // key -> name
var custom = { url:'', model:'', key:'', remember:false };   // 'key' tidak pernah dikeluarkan lewat API
var storedSeed = null;
var storedOwn = null;
var epoch = 0;
var chats = {};               // key -> modal handle

/* ------------------------------------------------------------------ util */
function el(tag, cls, text){
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function clampStr(s, n){ return String(s == null ? '' : s).slice(0, n); }
function playerName(){ return clampStr((GT.state && GT.state.playerName) || 'Kamu', 16); }
function curDay(){ try { return GT.time.day; } catch(e){ return 1; } }
function curHour(){ try { return GT.time.hour; } catch(e){ return 12; } }
function period(h){ return h < 5 ? 'malam' : h < 11 ? 'pagi' : h < 15 ? 'siang' : h < 18 ? 'sore' : 'malam'; }
function hearts(a){ var n = Math.max(0, Math.min(5, Math.floor(a / 20))); return new Array(n + 1).join('♥') + new Array(5 - n + 1).join('♡'); }
function hash(s){ var h = 2166136261; s = String(s); for (var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function escRe(s){ return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function sceneLabel(sc){
  if (!sc || sc.kind === 'out') return 'di luar';
  if (sc.kind === 'mart') return 'di Mart';
  if (sc.kind === 'casino') return 'di Kasino';
  return sc.house ? (sc.house.own ? 'di Rumah Kamu' : 'di Rumah ' + sc.house.owner) : 'di dalam';
}
function devEnabled(){ try { return !!(GT.dev && GT.dev.enabled); } catch(e){ return false; } }
// '#perintah' / '# perintah' / '#"perintah"' (hanya di awal pesan; kutip opsional) -> perintah | null.  'developer:' tidak lagi memaksa.
function parseDev(text){
  var m = /^\s*#\s*([\s\S]*)$/.exec(String(text == null ? '' : text));
  if (!m) return null;
  var c = m[1].trim().replace(/^["'\u201C\u201D\u2018\u2019\u201E`\u00AB\u00BB]+/, '').replace(/["'\u201C\u201D\u2018\u2019`\u00AB\u00BB]+$/, '').trim();
  return c || null;
}
function isWorker(npc){ var k = GT.npcKey(npc); return /:keeper$/.test(k) || k === 'casino:dealer'; }

/* ------------------------------------------------------------------ storage (opsional, selalu try/catch) */
function lsGet(){ try { var r = window.localStorage.getItem(STORE_KEY); return r ? JSON.parse(r) : null; } catch(e){ return null; } }
function lsSet(o){ try { window.localStorage.setItem(STORE_KEY, JSON.stringify(o)); } catch(e){} }
function persist(){
  var o = { seed:storedSeed, own:storedOwn, souls:{}, met:{}, custom:{ url:custom.url, model:custom.model, remember:!!custom.remember } };
  Object.keys(souls).forEach(function(k){ o.souls[k] = { p:souls[k].provider, n:souls[k].name }; });
  Object.keys(met).slice(0, 60).forEach(function(k){ o.met[k] = met[k]; });
  if (custom.remember && custom.key) o.custom.key = custom.key;
  lsSet(o);
}
function loadStore(){
  var d = lsGet();
  if (!d || typeof d !== 'object') return;
  try {
    if (d.seed != null && isFinite(+d.seed)) storedSeed = +d.seed;
    if (d.own != null && isFinite(+d.own)) storedOwn = +d.own;
    if (d.custom && typeof d.custom === 'object'){
      custom.url = clampStr(d.custom.url, 300); custom.model = clampStr(d.custom.model, 80);
      custom.remember = !!d.custom.remember;
      if (custom.remember && typeof d.custom.key === 'string') custom.key = clampStr(d.custom.key, 400);
    }
    if (d.souls && typeof d.souls === 'object') Object.keys(d.souls).slice(0, 60).forEach(function(k){
      var v = d.souls[k]; if (!v || PROVIDERS.indexOf(v.p) < 0) return;
      souls[clampStr(k, 60)] = mkSoul(clampStr(k, 60), clampStr(v.n, 24), v.p);
      try { GT.agent.enroll(clampStr(k, 60), v.p); } catch(e){}
    });
    if (d.met && typeof d.met === 'object') Object.keys(d.met).slice(0, 60).forEach(function(k){ if (typeof d.met[k] === 'string') met[clampStr(k, 60)] = clampStr(d.met[k], 24); });
  } catch(e){}
}

function mkSoul(key, name, provider){
  return { key:key, name:name || met[key] || key, provider:provider || 'local', hist:[], ctrl:null, post:null };
}
function ensureSoul(npc){
  var k = GT.npcKey(npc);
  var s = souls[k];
  if (!s){ s = souls[k] = mkSoul(k, npc.name, 'local'); persist(); GT.agent.enroll(k, 'local'); }
  s.name = npc.name || s.name;
  return s;
}
function meet(k, name){
  if (!k || /^anon:/.test(k)) return;
  if (met[k] !== name){ met[k] = clampStr(name, 24); persist(); }
}

/* ------------------------------------------------------------------ parser JSON {reply, plan:[{do,...}], affinity_delta} (format lama {action} tetap diterima) */
function stripFences(s){
  s = String(s);
  s = s.replace(/```[a-zA-Z0-9_-]*[ \t]*\r?\n?([\s\S]*?)```/g, '$1');
  s = s.replace(/```[a-zA-Z0-9_-]*[ \t]*\r?\n?/g, '');
  return s;
}
function candidates(s){
  var out = [], starts = 0;
  for (var i = 0; i < s.length && out.length < 8 && starts < 40; i++){
    if (s.charAt(i) !== '{') continue;
    starts++;
    var depth = 0, inStr = false, esc = false;
    for (var j = i; j < s.length; j++){
      var c = s.charAt(j);
      if (inStr){ if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
      else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}'){ depth--; if (depth === 0){ out.push(s.slice(i, j + 1)); break; } }
    }
  }
  return out;
}
function tryJson(c){
  try { return JSON.parse(c); } catch(e){}
  try {
    var t = c.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(t);
  } catch(e){}
  return undefined;
}
function lowerKeys(o){ var r = {}; Object.keys(o).forEach(function(k){ r[k.toLowerCase()] = o[k]; }); return r; }
// format lama {type,target,item} -> rencana
function legacyToPlan(type, target, item){
  switch (type){
    case 'follow': return [{ 'do':'ikuti', target:'aku' }];
    case 'stop': return [{ 'do':'berhenti' }];
    case 'goto': return target ? [{ 'do':'pergi', tujuan:target === 'player' ? 'aku' : target }] : [];
    case 'fetch': return item ? [{ 'do':'pergi', tujuan:'mart' }, { 'do':'beli', item:item, n:1 }, { 'do':'pergi', tujuan:'aku' }, { 'do':'beri', item:item, n:1, kepada:'aku' }] : [];
    case 'gift': return [{ 'do':'hadiah' }];
  }
  return [];
}
// rencana -> aksi lama (untuk kompatibilitas hasil ask())
function legacyOf(plan){
  var none = { type:'none', target:null, item:null };
  if (!plan || !plan.length) return none;
  var a = plan[0], d = a['do'];
  if (plan.length === 1){
    if (d === 'ikuti') return { type:'follow', target:null, item:null };
    if (d === 'berhenti') return { type:'stop', target:null, item:null };
    if (d === 'hadiah') return { type:'gift', target:null, item:null };
    if (d === 'pergi'){ var t = String(a.tujuan || '').toLowerCase(); return { type:'goto', target:t === 'aku' ? 'player' : t, item:null }; }
    if (d === 'pulang') return { type:'goto', target:'rumah', item:null };
  }
  if (d === 'pergi' && plan[1] && plan[1]['do'] === 'beli' && String(a.tujuan).toLowerCase() === 'mart' && plan.length <= 4 && !plan.some(function(s){ return s['do'] === 'bicara' || s['do'] === 'main_kasino'; }))
    return { type:'fetch', target:null, item:plan[1].item || null };
  return { type:'plan', target:null, item:null };
}
function normObj(o){
  o = lowerKeys(o);
  var reply = typeof o.reply === 'string' ? o.reply : (o.reply != null && typeof o.reply !== 'object' ? String(o.reply) : '');
  var refuse = o.refuse === true || o.menolak === true, plan = null, notes = [];
  if (Array.isArray(o.plan) || (o.plan && typeof o.plan === 'object')){
    var np = GT.agent.normalizePlan(o.plan); plan = np.steps; notes = np.notes;
  }
  var a = o.action;
  if (!plan){
    var type = 'none', target = null, item = null;
    if (typeof a === 'string') type = a;
    else if (a && typeof a === 'object'){
      if (Array.isArray(a)){ var np2 = GT.agent.normalizePlan(a); plan = np2.steps; notes = np2.notes; }
      else if (a['do'] != null || a['DO'] != null){ var np3 = GT.agent.normalizePlan([a]); plan = np3.steps; notes = np3.notes; }
      else { a = lowerKeys(a); type = a.type; target = a.target; item = a.item; }
    }
    if (!plan){
      type = String(type == null ? 'none' : type).trim().toLowerCase();
      if (type === 'refuse') refuse = true;
      if (LEGACY.indexOf(type) < 0) type = 'none';
      target = target == null ? null : String(target).trim().toLowerCase();
      if (TARGETS.indexOf(target) < 0) target = null;
      item = item == null ? null : String(item).trim().toLowerCase();
      if (!item || !Object.prototype.hasOwnProperty.call(GT.ITEMS || {}, item)) item = null;
      plan = GT.agent.normalizePlan(legacyToPlan(type, target, item)).steps;
    }
  } else if (typeof a === 'string' && a.trim().toLowerCase() === 'refuse') refuse = true;
  var d = Number(o.affinity_delta);
  d = isFinite(d) ? Math.max(-2, Math.min(2, Math.round(d))) : 0;
  var act = refuse && !plan.length ? { type:'refuse', target:null, item:null } : legacyOf(plan);
  return { reply:clampStr(reply.replace(/\s+/g, ' ').trim(), 280), plan:plan, notes:notes, refuse:refuse, action:act, affinity_delta:d };
}
function parseBrain(str){
  var raw = String(str == null ? '' : str).slice(0, 8000);
  var s = stripFences(raw);
  var cs = candidates(s);
  for (var i = 0; i < cs.length; i++){
    var v = tryJson(cs[i]);
    if (v && typeof v === 'object' && !Array.isArray(v)){
      var lk = lowerKeys(v);
      if ('reply' in lk || 'action' in lk || 'plan' in lk || 'affinity_delta' in lk){ var r = normObj(v); r.parsed = true; return r; }
    }
  }
  var t = s.trim();
  if (t.charAt(0) === '"'){ var sv = tryJson(t); if (typeof sv === 'string') t = sv; }
  return { reply:clampStr(t.replace(/\s+/g, ' ').trim(), 280), plan:[], notes:[], refuse:false, action:{ type:'none', target:null, item:null }, affinity_delta:0, parsed:false };
}

/* ------------------------------------------------------------------ otak lokal (kata kunci Indonesia, multi-langkah via GT.agent.parseText) */
var RUDE = /\b(bodoh|tolol|goblok|bego|anjing|anjir|babi|bangsat|sialan|brengsek|jelek|idiot|tai|kampret|bacot|sinting|jancok|asu|kontol|memek|monyet|sampah|enyah|benci kamu|pergi sana|dasar lu|dasar kamu|cerewet|nyebelin)\b/;
var POLITE = /\b(tolong|please|makasih|terima kasih|terimakasih|thanks|thx|sayang|hebat|keren|manis|cantik|ganteng|maaf|baik banget|kamu baik)\b/;
var FETCH_VERB = /\b(ambil\w*|beli\w*|cariin|carikan|mintakan)\b/;
var GREET = /\b(halo|hai|hi|hello|hei|selamat (pagi|siang|sore|malam)|apa kabar|gimana kabar|kabarmu|lagi apa|lagi ngapain|sedang apa|assalamualaikum|permisi|woi)\b/;
function norm(t){ return ' ' + String(t).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim() + ' '; }
function planReply(steps, per){
  var first = steps[0], d = first['do'];
  if (steps.length === 1){
    if (d === 'ikuti') return pick(['Oke, aku ikut!', 'Siap, aku jalan di belakangmu.']);
    if (d === 'berhenti') return pick(['Baik, aku berhenti di sini.', 'Oke, aku diam di sini.']);
    if (d === 'hadiah') return pick(['Nih, ada sesuatu buatmu!', 'Hmm, aku punya sesuatu. Ambil ya.']);
    if (d === 'pergi'){
      var tj = String(first.tujuan || ''), lab = tj === 'aku' ? 'tempatmu' : tj === 'mart' ? 'Mart' : tj === 'kasino' ? 'Kasino' : tj;
      return pick(['Oke, aku ke ' + lab + ' dulu.', 'Baik, aku jalan ke ' + lab + '.']);
    }
    if (d === 'ajari') return 'Oke, aku pelajari "' + first.nama + '".';
    if (d === 'ingat') return 'Baik, aku ingat.';
    if (d === 'tidur') return 'Oke, aku tidur dulu.';
    if (d === 'ancam') return pick(['Oke, kugertak dia.', 'Baik, kuberi dia peringatan.']);
    if (d === 'pukul') return pick(['Oke, kuhajar dia!', 'Baik, kuberi dia pelajaran.']);
    if (d === 'damai') return pick(['Oke, aku coba berdamai.', 'Baik, kuajak dia baikan.']);
  }
  var l = legacyOf(steps);
  if (l.type === 'fetch' && l.item) return pick(['Oke, aku belikan ' + GT.itemName(l.item) + ' dulu ya.', 'Siap! ' + GT.itemName(l.item) + ' segera datang.']);
  var txt = steps.map(function(s){ return GT.agent.stepLabel(s).toLowerCase(); }).join(', lalu ');
  return 'Siap! ' + clampStr(txt.charAt(0).toUpperCase() + txt.slice(1), 200) + '.';
}
function localBrain(text, c){
  c = c || {};
  var s = norm(text), name = c.name || 'NPC', aff = c.aff == null ? 40 : c.aff, per = period(c.hour == null ? 12 : c.hour);
  var out = { reply:'', plan:[], notes:[], refuse:false, action:{ type:'none', target:null, item:null }, affinity_delta:0 };
  function say(a){ out.reply = pick(a); return out; }
  if (RUDE.test(s)){ out.affinity_delta = -2; return say(['Kasar banget sih!', 'Aku nggak suka dikatai begitu.', 'Hei, yang sopan dong.']); }
  if (POLITE.test(s)) out.affinity_delta = 1;
  var pr = GT.agent.parseText(text, { npc:c.npcObj || null });
  if (pr.steps.length){
    out.plan = pr.steps; out.action = legacyOf(pr.steps);
    out.reply = planReply(pr.steps, per);
    if (pr.skipped.length) out.notes.push('dilewati: ' + pr.skipped.join('; '));
    return out;
  }
  if (FETCH_VERB.test(s)) return say(['Mau diambilkan apa? Misalnya roti, apel, susu, atau kue.', 'Barang apa yang kamu mau?']);
  if (/\b(makasih|terima kasih|terimakasih|thanks|thx)\b/.test(s)) return say(['Sama-sama!', 'Sama-sama, senang membantu.']);
  if (/\b(siapa kamu|namamu|siapa namamu)\b/.test(s)) return say(['Aku ' + name + '. Senang berteman denganmu.']);
  if (GREET.test(s)){
    if (/kabar/.test(s)) return say(aff >= 60 ? ['Kabarku baik, apalagi ketemu kamu!', 'Baik-baik saja! Kamu sendiri?'] : ['Baik-baik saja.', 'Lumayan. Kamu?']);
    if (/lagi (apa|ngapain)|sedang apa/.test(s)) return say(['Lagi jalan-jalan santai saja.', 'Lagi menikmati ' + per + ' ini.']);
    return say(aff >= 60 ? ['Halo ' + playerName() + '! Selamat ' + per + '.', 'Hai! Senang kamu datang.'] : aff < 30 ? ['Hm.', 'Ada apa?'] : ['Halo. Selamat ' + per + '.', 'Hai, ' + playerName() + '.']);
  }
  return say(aff < 30 ? ['Hm.', 'Terserah.'] : ['Hmm, aku kurang paham. Coba "ikut aku", "ke mart lalu beli roti", atau "ambilkan roti".', 'Maksudnya apa ya? Aku bisa ikut, pergi ke suatu tempat, beli barang, atau beberapa langkah sekaligus.']);
}

/* ------------------------------------------------------------------ persona + prompt */
var TRAITS = ['ramah dan hangat', 'santai dan suka bercanda', 'pendiam tapi perhatian', 'penasaran dan banyak bicara', 'tenang dan bijak'];
function roleOf(npc){
  var k = GT.npcKey(npc), w = GT.world, m;
  if (w && (m = /^house:(\d+):0$/.exec(k))){
    if (w.own && String(w.own.id) === m[1]) return 'ibu ' + playerName() + ', tinggal serumah dengan ' + playerName() + ' di Rumah Kamu';
    var h = (w.houses || []).filter(function(x){ return String(x.id) === m[1]; })[0];
    return 'penghuni Rumah ' + (h ? h.owner : 'warga');
  }
  if (/:keeper$/.test(k)) return 'penjaga Mart Genesis';
  if (k === 'casino:dealer') return 'bandar di Kasino Genesis (koin permainan saja)';
  return 'warga yang berkeliaran di Genesis Town';
}
function affLabel(a){ return a < 30 ? 'rendah (kamu tidak mau membantu)' : a < 60 ? 'sedang (kadang menolak tugas jalan/ambil barang)' : 'tinggi (senang membantu)'; }
function buildSystem(npc, aff, dev, auto){
  var items = Object.keys(GT.ITEMS || {}).map(function(id){ return id + ' (' + ((GT.ITEMS[id] && GT.ITEMS[id].price) || '?') + ' koin)'; }).join(', ');
  var trait = GT.npcKey(npc).indexOf('house:') === 0 && roleOf(npc).indexOf('ibu ') === 0 ? 'penyayang dan sedikit cerewet' : TRAITS[hash(GT.npcKey(npc) + npc.name) % TRAITS.length];
  var obs = {};
  try { obs = GT.agent.observe(npc); } catch(e){}
  var lines = [
    'Kamu adalah ' + npc.name + ', ' + roleOf(npc) + ' di Genesis Town (kota pixel). Watakmu ' + trait + '.',
    auto ? 'Sekarang kamu bebas melakukan apa saja seperti pemain asli. Sekarang pukul ' + (GT.time && GT.time.hhmm || '--:--') + ' (' + period(curHour()) + ').'
         : 'Kamu sedang mengobrol dengan pemain bernama ' + playerName() + '. Sekarang pukul ' + (GT.time && GT.time.hhmm || '--:--') + ' (' + period(curHour()) + ').',
    'Tingkat kedekatanmu dengan ' + playerName() + ': ' + aff + '/100, ' + affLabel(aff) + '.',
    'Kamu punya dompet dan tas sendiri; membeli memakai uangmu sendiri. Jangan merencanakan pembelian yang melebihi dompetmu.',
    'Jawab singkat (maks 2 kalimat), Bahasa Indonesia santai, tetap dalam karakter. Jangan menyebut dirimu AI atau model.',
    'Barang di Mart: ' + items + '.',
    'Aksi yang tersedia (hanya pakai aksi ini, maks ' + 8 + ' langkah, berurutan):\n' + GT.agent.promptActions(),
    'Keadaan sekarang (JSON): ' + JSON.stringify(obs),
    'Hubunganmu dengan warga lain bisa baik atau buruk (lihat "relasi"). Kamu boleh mengancam/memukul (aksi ancam/pukul) hanya orang yang kamu benci; jangan menyakiti orang yang kamu sukai. Malam hari (21:00-05:59) kamu lebih suka di rumah.',
    'Kalau kedekatan di bawah 30 kamu menolak semua permintaan; antara 30 dan 59 kadang menolak tugas jalan/beli; 60 ke atas senang membantu. Jika pemain kasar, beri affinity_delta negatif. Menolak: plan kosong.',
    'Balas HANYA dengan satu objek JSON, tanpa teks lain, persis dengan format: {"reply":"...","plan":[{"do":"pergi","tujuan":"mart"},{"do":"beli","item":"roti","n":2},{"do":"pergi","tujuan":"aku"},{"do":"beri","item":"roti","n":2,"kepada":"aku"}],"affinity_delta":-2..2}. plan boleh [] bila hanya mengobrol.'
  ];
  if (dev) lines.push(DEV_LINE);
  return lines.join('\n');
}


/* ------------------------------------------------------------------ provider: error handling */
function fail(code, msg){ var e = new Error(msg || code); e.soulCode = code; return e; }
function sanitize(m){
  m = String(m == null ? '' : m);
  if (custom.key) m = m.split(custom.key).join('***');
  return m.replace(/Bearer\s+\S+/gi, 'Bearer ***').slice(0, 160);
}
function classify(e){
  if (e && e.soulCode) return e.soulCode;
  var s = ((e && (e.code || (e.error && e.error.code) || e.name)) || '') + ' ' + ((e && e.message) || e || '');
  s = String(s).toLowerCase();
  if (/rate_limited|rate limit|ratelimit|too many/.test(s)) return 'rate_limited';
  if (/not_granted|notgranted|not granted|permission|denied|consent/.test(s)) return 'not_granted';
  if (/abort/.test(s)) return 'aborted';
  return 'error';
}
function withAbort(p, ctrl){
  return new Promise(function(resolve, reject){
    function onAbort(){ reject(fail(ctrl.timedOut ? 'timeout' : 'aborted', ctrl.timedOut ? 'waktu habis' : 'dibatalkan')); }
    if (ctrl.signal.aborted) return onAbort();
    ctrl.signal.addEventListener('abort', onAbort, { once:true });
    Promise.resolve(p).then(resolve, reject);
  });
}
function sleep(ms, ctrl){
  return withAbort(new Promise(function(res){ setTimeout(res, ms); }), ctrl);
}
function historyMsgs(soul){
  var h = soul.hist.slice(-HIST_MAX);
  while (h.length && h[0].role !== 'user') h.shift();
  return h;
}

async function callClaude(soul, npc, text, aff, ctrl){
  var cap = await withAbort(GT.cap('sample'), ctrl);
  var fn = typeof cap === 'function' ? cap : (cap && typeof cap.sample === 'function' ? cap.sample.bind(cap) : null);
  if (!fn) throw fail('unavailable', 'Tidak tersedia di tampilan ini');
  var sys = buildSystem(npc, aff, ctrl.dev), h = historyMsgs(soul), msgs = [];
  h.forEach(function(m){ msgs.push({ role:m.role, content:m.content }); });
  msgs.push({ role:'user', content:text });
  msgs[0] = { role:'user', content:sys + '\n\nPesan pemain:\n' + msgs[0].content };   // memoryless: persona + format ikut di pesan pertama
  var res;
  var tools = soulTools(npc);
  try { res = await withAbort(fn(msgs, { modelTier:'quick', signal:ctrl.signal, tools:tools }), ctrl); }
  catch(e){
    var c0 = classify(e);
    if (c0 === 'error' && !ctrl.signal.aborted){      // runtime tanpa dukungan tools: coba lagi tanpa tools
      try { res = await withAbort(fn(msgs, { modelTier:'quick', signal:ctrl.signal }), ctrl); }
      catch(e2){ var c2 = classify(e2); throw fail(c2, sanitize(e2 && e2.message)); }
    } else throw fail(c0, sanitize(e && e.message));
  }
  var out = typeof res === 'string' ? res : (res && (res.text != null ? res.text : res.content));
  if (out == null) throw fail('format', 'Balasan Claude kosong');
  return parseBrain(out);
}

async function callCustom(soul, npc, text, aff, ctrl){
  var url = custom.url;
  if (!urlOk(url)) throw fail('config', 'URL endpoint belum diatur atau tidak valid');
  var msgs = [{ role:'system', content:buildSystem(npc, aff, ctrl.dev) }];
  historyMsgs(soul).forEach(function(m){ msgs.push({ role:m.role, content:m.content }); });
  msgs.push({ role:'user', content:text });
  var headers = { 'Content-Type':'application/json' };
  if (custom.key) headers['Authorization'] = 'Bearer ' + custom.key;
  var timer = setTimeout(function(){ ctrl.timedOut = true; try { ctrl.abort(); } catch(e){} }, DELAY.net);
  try {
    var resp;
    try {
      resp = await withAbort(fetch(url, { method:'POST', headers:headers, signal:ctrl.signal, credentials:'omit', referrerPolicy:'no-referrer', cache:'no-store',
        body:JSON.stringify({ model:custom.model || 'gpt-4o-mini', messages:msgs, temperature:0.7 }) }), ctrl);
    } catch(e){
      var c0 = classify(e);
      if (c0 === 'aborted' || c0 === 'timeout') throw e;
      throw fail('network', 'Koneksi ke endpoint gagal (jaringan, CORS, atau diblokir CSP). ' + sanitize(e && e.message));
    }
    if (!resp.ok){
      if (resp.status === 401 || resp.status === 403) throw fail('http', 'Kunci API ditolak (' + resp.status + ')');
      if (resp.status === 429) throw fail('http', 'Endpoint membatasi permintaan (429)');
      throw fail('http', 'Endpoint membalas status ' + resp.status);
    }
    var data;
    try { data = await withAbort(resp.json(), ctrl); } catch(e){ if (classify(e) === 'aborted' || classify(e) === 'timeout') throw e; throw fail('format', 'Balasan endpoint bukan JSON'); }
    var content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof content !== 'string') throw fail('format', 'Balasan endpoint tidak sesuai format OpenAI (choices[0].message.content)');
    return parseBrain(content);
  } finally { clearTimeout(timer); }
}

async function callLocal(soul, npc, text, aff, ctrl, noDelay){
  if (!noDelay && DELAY.think > 0) await sleep(DELAY.think, ctrl);
  return localBrain(text, { name:npc.name, aff:aff, hour:curHour(), npcObj:npc });
}

function urlOk(u){
  u = String(u || '').trim();
  if (/^https:\/\/[^\s/]+/i.test(u)) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(u);
}

// alat baca-saja untuk Claude: lihat sekitar, cari, status saya (hasil juga sudah ada di prompt lewat observe())
function soulTools(npc){
  function def(name, desc, props, fn){
    var t = { name:name, description:desc, execute:function(input){ return fn(input || {}); } }; if (Object.keys(props).length) t.inputSchema = { type:'object', properties:props, required:Object.keys(props) }; return t;
  }
  return [
    def('lihat_sekitar', 'Lihat siapa dan apa yang ada di sekitarmu sekarang.', {}, function(){ var o = GT.agent.observe(npc); return JSON.stringify({ scene:o.scene, sekitar:o.sekitar, pemain:o.pemain, waktu:o.waktu }); }),
    def('cari', 'Cari di mana seseorang atau suatu tempat berada.', { nama:{ type:'string' } }, function(a){
      var nm = a && a.nama; var c = GT.agent.resolveChar(nm, npc);
      if (c){
        if (c.kind === 'player') return playerName() + ' (pemain) ' + (GT.scene === GT.outScene ? 'ada di luar' : sceneLabel(GT.scene)) + ', jarak sekitar ' + (Math.abs(GT.player.x - npc.x) + Math.abs(GT.player.y - npc.y)) + ' langkah.';
        var n = GT.agent.npcByKey(c.key); return n ? c.name + ' ' + sceneLabel(GT.npcScene(n)) + '.' : c.name + ' tidak terlihat.';
      }
      var pl = GT.agent.resolvePlace(nm, npc);
      return pl ? (pl.label + (pl.b ? ' pintunya di blok ' + pl.b.dx + ',' + pl.b.dy : '') + '.') : 'tidak ditemukan';
    }),
    def('status_saya', 'Lihat dompet, tas, tugas, dan ingatanmu.', {}, function(){ var o = GT.agent.observe(npc); return JSON.stringify({ dompet:o.dompet, tas:o.tas, tugas:o.tugas, ingatan:o.ingatan, keterampilan:o.keterampilan }); })
  ];
}

/* ------------------------------------------------------------------ pekerja (penjaga Mart / bandar) yang dipaksa developer pergi: kembali ke pos lewat aksi 'kerja' */
function capturePost(npc){
  return { npc:npc, sc:GT.npcScene(npc), x:npc.x, y:npc.y, dir:npc.dir, wander:npc.wander, leash:npc.leash, turns:npc.turns, until:0, returning:false, returned:false, epoch:epoch };
}
function registerPost(soul, npc, cap){
  if (!soul.post || soul.post.epoch !== epoch) soul.post = cap;
  soul.post.until = (GT.time && GT.time.total || 0) + DELAY.postMin;
  soul.post.returning = false;
  npc._post = soul.post;
}
function placeAtPost(npc, p){
  if (!p.sc) return;
  try { GT.agent.cancel(npc); } catch(e){}
  if (GT.npcScene(npc) !== p.sc) GT.moveNpc(npc, p.sc, p.x, p.y);
  else if (npc.x !== p.x || npc.y !== p.y){ if (!GT.npcTeleport(npc, p.x, p.y, p.dir)) GT.moveNpc(npc, p.sc, p.x, p.y); }
  GT.npcHide(npc, false);
  npc.wander = p.wander; npc.leash = p.leash; npc.turns = p.turns; npc.follow = false;
  npc.home = { x:p.x, y:p.y }; npc.dir = p.dir; npc.wait = 1;
  npc._post = null;
}
function agentBusy(npc){ try { return GT.agent.status(npc).busy; } catch(e){ return false; } }
function sendHome(soul){
  var p = soul.post; if (!p || p.returning || p.epoch !== epoch) return;
  var npc = p.npc;
  p.returning = true; npc._post = p;
  GT.agent.run(npc, [{ 'do':'kerja' }], { source:'post' }).then(function(res){
    if (p.epoch !== epoch) return;
    if (p.returned){ if (soul.post === p) soul.post = null; return; }
    p.returning = false;
    if (!res.cancelled) p.until = (GT.time && GT.time.total || 0) + 5;
  });
}
function postTick(){
  var now = GT.time && GT.time.total || 0;
  Object.keys(souls).forEach(function(k){
    var s = souls[k], p = s.post;
    if (!p) return;
    if (p.epoch !== epoch){ s.post = null; return; }
    if (!p.returning && now >= p.until){
      if (agentBusy(p.npc) || p.npc.follow) p.until = now + 5; else sendHome(s);
    }
  });
}

/* ------------------------------------------------------------------ gerbang affinity (dipaksa di kode, berlaku untuk SELURUH rencana) */
function planClass(plan){
  var ds = plan.map(function(s){ return s['do']; });
  if (!ds.length) return 'none';
  if (ds.every(function(d){ return d === 'berhenti' || d === 'ingat' || d === 'ajari'; })) return 'free';
  if (ds.length === 1 && ds[0] === 'hadiah') return 'gift';
  if (ds.length === 1 && ds[0] === 'ikuti') return 'follow';
  return 'task';
}
function gate(npc, plan, aff){
  var c = planClass(plan);
  if (c === 'none' || c === 'free') return null;
  var mover = c !== 'gift';
  if (mover && isWorker(npc)) return { reason:'kerja', reply:'Aku lagi kerja, nggak bisa pergi.' };
  if (aff < 30) return { reason:'affinity_rendah', reply:'Aku lagi nggak mood bantu kamu.' };
  if (aff < 60 && c === 'task' && r01() < 0.5) return { reason:'acak', reply:'Hmm, lagi malas nih. Lain kali ya.' };
  return null;
}
// jam malam: tugas yang memaksa NPC keluar rumah ditolak (kecuali '#')
function nightGate(npc, plan){
  try { if (plan.length && !isWorker(npc) && GT.agent.curfewNow() && GT.agent.needsOutdoor(npc, plan)) return { reason:'jam_malam', reply:'Sudah malam, aku di rumah saja.' }; } catch(e){}
  return null;
}
// tidak mau mengancam/memukul orang yang disukai (relasi >= 20; pemain: kedekatan >= 60)
function suka(npc, plan){
  try { return GT.agent.combatGate(npc, plan); } catch(e){ return null; }
}
function planCost(plan){
  var t = 0;
  plan.forEach(function(s){ if (s['do'] === 'beli'){ var id = GT.agent.itemId(s.item), n = Math.max(1, Math.min(20, Math.floor(+s.n) || 1)); if (id) t += (Math.floor(GT.ITEMS[id].price) || 0) * n; } });
  return t;
}

/* ------------------------------------------------------------------ eksekusi rencana + replan + log obrolan */
var logs = {};          // npcKey -> [{kind,text}]  (riwayat tugas untuk obrolan)
var views = {};         // npcKey -> fn(event) bila obrolan terbuka
function pushLog(k, kind, text){
  var a = logs[k] || (logs[k] = []);
  a.push({ kind:kind, text:clampStr(text, 160) });
  if (a.length > 40) a.splice(0, a.length - 40);
}
function onAgentEvent(ev){
  var k = ev.key; if (!k) return;
  if (ev.type === 'plan'){ pushLog(k, 'plan', JSON.stringify(ev.steps)); }
  else if (ev.type === 'step' && ev.state !== 'run'){ pushLog(k, ev.state === 'ok' ? 'ok' : ev.state === 'fail' ? 'fail' : 'cancel', ev.note || ev.label); }
  else if (ev.type === 'log'){ pushLog(k, 'say', ev.text); }
  else if (ev.type === 'end'){
    var s = souls[k];
    if (ev.source === 'player' && !ev.cancelled && ev.ok && !views[k]) GT.toast((ev.npc && ev.npc.name || 'NPC') + ': tugas selesai.');
    else if (ev.source === 'player' && !ev.cancelled && !ev.ok && !views[k] && ev.failed) GT.toast((ev.npc && ev.npc.name || 'NPC') + ': gagal, ' + clampStr(ev.failed.note, 60));
  }
  if (views[k]) { try { views[k](ev); } catch(e){} }
}
function startPlan(soul, npc, plan, forced, replanned){
  var cap = (forced && isWorker(npc) && planClass(plan) !== 'free') ? capturePost(npc) : null;
  var p = GT.agent.run(npc, plan, { source:'player', epoch:epoch, forced:!!forced });
  if (cap) registerPost(soul, npc, cap);
  var ep = epoch;
  p.then(function(res){
    if (ep !== epoch || !res) return;
    if (res.failed && !res.cancelled && !res.busy){
      if (soul.provider !== 'local' && !replanned) return replan(soul, npc, plan, res, forced);
      GT.npcSay(npc, 'Maaf, gagal: ' + clampStr(res.failed.note, 60));
    }
    var cur = GT.agent.status(npc);
    if (soul.post && !cur.busy && !res.cancelled && !npc.follow) sendHome(soul);
    else if (soul.post && !cur.busy && res.cancelled && soul.post.epoch === epoch && !soul.post.returning) { /* dibatalkan: postTick akan memulangkan */ }
  });
  return p;
}
async function replan(soul, npc, plan, res, forced){
  var ep = epoch, ctrl = new AbortController();
  ctrl.timedOut = false; ctrl.userAbort = false; ctrl.dev = !!forced;
  try {
    var txt = '[SISTEM] Rencana gagal di langkah ' + (res.failed.i + 1) + ' (' + GT.agent.stepLabel(res.failed.step) + '): ' + res.failed.note + '. Buat rencana baru untuk melanjutkan atau memperbaikinya, atau plan kosong bila mustahil. Dompetmu sekarang ' + GT.agent.wallet(npc) + ' koin.';
    var br = await brainCall(soul, npc, txt, GT.getAffinity(npc), ctrl, true);
    if (ep !== epoch) return;
    if (br.reply) GT.npcSay(npc, br.reply);
    var np = br.plan.length ? GT.agent.normalizePlan(br.plan).steps : [];
    if (np.length && !GT.agent.status(npc).busy){ pushLog(npc ? GT.npcKey(npc) : '', 'sys', 'Rencana diperbarui.'); startPlan(soul, npc, np, forced, true); }
    else GT.npcSay(npc, 'Maaf, gagal: ' + clampStr(res.failed.note, 60));
  } catch(e){
    GT.npcSay(npc, 'Maaf, gagal: ' + clampStr(res.failed.note, 60));
  }
}
function brainCall(soul, npc, text, aff, ctrl, noFallbackMsg){
  var p = soul.provider === 'claude' ? callClaude(soul, npc, text, aff, ctrl) : soul.provider === 'custom' ? callCustom(soul, npc, text, aff, ctrl) : callLocal(soul, npc, text, aff, ctrl, true);
  return Promise.resolve(p).catch(function(e){
    if (soul.provider === 'local') throw e;
    return callLocal(soul, npc, text, aff, ctrl, true);
  });
}

/* ------------------------------------------------------------------ ask() */
function emptyRes(soul, extra){
  var r = { ok:false, provider:soul ? soul.provider : 'local', usedProvider:soul ? soul.provider : 'local', fellBack:false, reply:'',
    action:{ type:'none', target:null, item:null }, requested:{ type:'none', target:null, item:null }, plan:[], affinity_delta:0, refused:false, executed:false, note:'' };
  Object.keys(extra || {}).forEach(function(k){ r[k] = extra[k]; });
  return r;
}
function fallbackNote(provider, e, code){
  var who = provider === 'claude' ? 'Claude' : 'Endpoint kustom';
  if (code === 'unavailable') return 'Claude: Tidak tersedia di tampilan ini. Memakai otak lokal untuk pesan ini.';
  if (code === 'not_granted') return 'Claude: Tidak tersedia (izin belum diberikan). Memakai otak lokal untuk pesan ini.';
  if (code === 'timeout') return who + ' terlalu lama menjawab. Memakai otak lokal untuk pesan ini.';
  var m = e && e.soulCode ? sanitize(e.message) : 'terjadi kesalahan';
  return who + ' gagal: ' + m + ' Memakai otak lokal untuk pesan ini.';
}

function ask(npc, text){
  if (!npc) return Promise.resolve(emptyRes(null, { error:'no_npc' }));
  text = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, MSG_MAX);
  if (!text) return Promise.resolve(emptyRes(souls[GT.npcKey(npc)], { error:'kosong' }));
  var soul = ensureSoul(npc);
  if (soul.ctrl) return Promise.resolve(emptyRes(soul, { error:'busy', busy:true }));
  var cmd = parseDev(text), forced = false, hint = '';
  if (cmd){
    if (devEnabled()) forced = true;
    else if (!devHinted){ devHinted = true; hint = DEV_HINT; }
  }
  return askAsync(soul, npc, forced ? cmd : text, forced, hint);
}
async function askAsync(soul, npc, text, forced, hint){
  var ctrl = soul.ctrl = new AbortController();
  ctrl.timedOut = false; ctrl.userAbort = false; ctrl.dev = !!forced;
  var ep = epoch, aff = GT.getAffinity(npc), res = emptyRes(soul, { text:text, affinity_before:aff, forced:!!forced, hint:hint || '' });
  try {
    var br;
    try {
      if (soul.provider === 'claude') br = await callClaude(soul, npc, text, aff, ctrl);
      else if (soul.provider === 'custom') br = await callCustom(soul, npc, text, aff, ctrl);
      else br = await callLocal(soul, npc, text, aff, ctrl);
    } catch(e){
      var code = classify(e);
      if (ctrl.userAbort || (code === 'aborted' && !ctrl.timedOut)) return emptyRes(soul, { aborted:true, error:'aborted' });
      if (code === 'rate_limited'){
        GT.toast('Terlalu cepat, coba lagi sebentar.');
        return emptyRes(soul, { error:'rate_limited', note:'Claude sedang membatasi permintaan. Coba lagi sebentar.', text:text });
      }
      if (soul.provider === 'local') throw e;
      res.fellBack = true; res.usedProvider = 'local'; res.note = fallbackNote(soul.provider, e, code); res.error = code;
      br = await callLocal(soul, npc, text, aff, ctrl, true);
    }
    if (ctrl.userAbort || ctrl.signal.aborted && !ctrl.timedOut) return emptyRes(soul, { aborted:true, error:'aborted' });
    if (ep !== epoch) return emptyRes(soul, { aborted:true, error:'dunia_berubah' });
    // --- adjudikasi (selalu di kode, bukan di prompt)
    var plan = br.plan || [], reply = br.reply, act = legacyOf(plan);
    if (br.refuse && !plan.length) act = { type:'refuse', target:null, item:null };
    res.requested = { type:act.type, target:act.target, item:act.item };
    var delta = br.affinity_delta | 0;
    var g = forced ? null : (gate(npc, plan, aff) || nightGate(npc, plan) || suka(npc, plan));
    if (forced){
      // '#': gerbang affinity / penolakan acak / "lagi kerja" dilewati; otak menolak -> parser lokal; tak ada -> "Siap, developer."
      delta = 0;
      if (!plan.length){
        var lb = localBrain(text, { name:npc.name, aff:aff, hour:curHour(), npcObj:npc });
        if (lb.plan.length){ plan = lb.plan; act = legacyOf(plan); reply = lb.reply; res.devOverride = true; }
        else { act = { type:'none', target:null, item:null }; reply = 'Siap, developer.'; }
      }
    } else if (g){
      res.refused = true; res.refuseReason = g.reason;
      reply = g.reply; plan = []; act = { type:'refuse', target:null, item:null };
    } else if (act.type === 'refuse'){
      res.refused = true; res.refuseReason = 'otak';
      if (!reply) reply = 'Aku lagi nggak mood bantu kamu.';
    }
    // --- eksekusi
    var ex = { executed:false };
    if (!res.refused && plan.length){
      var cost = planCost(plan);
      if (cost > GT.agent.wallet(npc)){
        ex = { executed:false, note:'koin_kurang', reply:'Uangku belum cukup (' + cost + ' koin, dompetku ' + GT.agent.wallet(npc) + ').' };
      } else if (planClass(plan) === 'gift' && GT.agent.giftedToday(npc)){
        ex = { executed:false, note:'sudah_hari_ini', reply:'Hari ini sudah kuberi hadiah, besok lagi ya.' };
      } else {
        npc._lastGift = null;
        startPlan(soul, npc, plan, forced, false);
        ex = { executed:true, sys:'Rencana: ' + GT.agent.describe(plan) };
        if (act.type === 'gift' && npc._lastGift) act.item = npc._lastGift;
      }
    }
    if (ex.reply) reply = ex.reply;
    res.executed = !!ex.executed; res.execNote = ex.note || ''; res.sys = ex.sys || ''; res.noop = false;
    res.plan = res.refused ? [] : plan;
    res.requested = res.requested.type === 'none' && act.type !== 'none' ? { type:act.type, target:act.target, item:act.item } : res.requested;
    res.reply = reply || '...';
    res.action = act;
    // --- affinity
    if (delta){ GT.addAffinity(npc, delta); }
    res.affinity_delta = delta; res.affinity = GT.getAffinity(npc);
    res.ok = true;
    // --- riwayat (konten asisten = hasil akhir)
    soul.hist.push({ role:'user', content:text });
    soul.hist.push({ role:'assistant', content:JSON.stringify({ reply:res.reply, plan:res.plan, affinity_delta:delta }) });
    if (soul.hist.length > HIST_MAX * 2) soul.hist.splice(0, soul.hist.length - HIST_MAX * 2);
    GT.npcSay(npc, res.reply);
    return res;
  } catch(e){
    return emptyRes(soul, { error:'internal', note:sanitize(e && e.message) });
  } finally {
    if (soul.ctrl === ctrl) soul.ctrl = null;
  }
}
function abortSoul(soul){
  var c = soul && soul.ctrl;
  if (c){ c.userAbort = true; try { c.abort(); } catch(e){} }
}

/* ------------------------------------------------------------------ hook ke agen: rencana mandiri (LLM) dan balasan NPC-ke-NPC */
function llmCtrl(ms){
  var c = new AbortController(); c.timedOut = false; c.userAbort = false; c.dev = false;
  var t = setTimeout(function(){ c.timedOut = true; try { c.abort(); } catch(e){} }, ms || 20000);
  c.done = function(){ clearTimeout(t); };
  return c;
}
async function autoPlanFor(npc){
  var s = souls[GT.npcKey(npc)]; if (!s || s.provider === 'local') return null;
  var tmp = { provider:s.provider, hist:[], name:s.name }, c = llmCtrl(25000);
  try {
    var br = await brainCall(tmp, npc, 'Apa yang mau kamu lakukan sekarang? Pilih satu rencana singkat (1-4 langkah) yang cocok dengan waktu, wataknya, dan dompetmu. Akhiri dengan lapor bila ada hasil yang perlu diketahui ' + playerName() + '.', GT.getAffinity(npc), c, true);
    return br.plan && br.plan.length ? br.plan : null;
  } catch(e){ return null; } finally { c.done(); }
}
async function replyToNpc(tn, fromName, msg, signal){
  var s = souls[GT.npcKey(tn)];
  if (!s) return '';
  if (s.provider === 'local') return localBrain(msg, { name:tn.name, aff:GT.getAffinity(tn), hour:curHour(), npcObj:tn }).reply;
  var tmp = { provider:s.provider, hist:[], name:s.name }, c = llmCtrl(15000);
  if (signal) signal.addEventListener('abort', function(){ try { c.abort(); } catch(e){} }, { once:true });
  try {
    var br = await brainCall(tmp, tn, fromName + ' berkata kepadamu: "' + clampStr(msg, 140) + '". Balas singkat saja (plan harus []).', GT.getAffinity(tn), c, true);
    return br.reply || '';
  } catch(e){ return ''; } finally { c.done(); }
}


/* ------------------------------------------------------------------ UI: CSS */
function injectCss(){
  if (document.getElementById('soul-css')) return;
  var st = document.createElement('style'); st.id = 'soul-css';
  st.textContent = [
    '.sl-head{margin:0 0 6px;display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center}',
    '.sl-tag{padding:1px 6px;border-radius:3px;background:var(--paper-ink);color:var(--paper)}',
    '.sl-log{max-height:36vh;min-height:96px;overflow:auto;overscroll-behavior:contain;border:2px solid var(--paper-ink);border-radius:4px;background:#fff;padding:6px;margin-bottom:6px}',
    '.sl-m{margin:0 0 6px;padding:4px 6px;border-radius:4px;line-height:1.6;overflow-wrap:anywhere}',
    '.sl-m.me{background:#dfe8c2;margin-left:14%}',
    '.sl-m.npc{background:#e3e9f7;margin-right:14%}',
    '.sl-m.sys{color:#4a4d75;border-left:3px solid var(--paper-edge);border-radius:0;padding-left:6px}',
    '.sl-st{min-height:16px;margin-bottom:6px;color:#4a4d75}',
    '.sl-f{display:block;margin:0 0 10px}',
    '.sl-f>span{display:block;margin-bottom:4px}',
    '.sl-f input[type=password],.sl-f input[type=text],.sl-in{width:100%;font:inherit;font-size:10px;padding:8px;border:2px solid var(--paper-ink);border-radius:4px;background:#fff;color:var(--paper-ink);box-sizing:border-box}',
    '.sl-in:focus-visible,.sl-f input:focus-visible{outline:3px solid #2d7ad6;outline-offset:2px}',
    '.sl-err{min-height:14px;color:var(--bad);margin:0 0 6px}',
    '.sl-chk{display:flex;gap:8px;align-items:flex-start;margin:0 0 8px;cursor:pointer}',
    '.sl-chk input{margin-top:3px;flex:none}',
    '.sl-sub{display:block;color:#4a4d75;margin-top:2px}',
    '.sl-dev{display:inline-block;margin-right:6px;padding:0 5px;border-radius:3px;background:#b3261e;color:#fff;font-size:8px;line-height:1.5;vertical-align:middle}',
    '.sl-ok{color:var(--good)}',
    '.sl-wal{margin:0 0 6px;color:#4a4d75;overflow-wrap:anywhere}',
    '.sl-plan{margin-bottom:6px}',
    '.sl-plan-t{margin-bottom:2px}',
    '.sl-step{display:flex;gap:6px;line-height:1.6;overflow-wrap:anywhere}',
    '.sl-g{flex:none;width:1.2em;text-align:center}',
    '.sl-step[data-state=ok] .sl-g{color:var(--good)}',
    '.sl-step[data-state=fail] .sl-g{color:var(--bad)}',
    '.sl-step[data-state=run]{font-weight:bold}',
    '.sl-note{color:#4a4d75;font-weight:normal}',
    '.sl-r2{padding-top:0;border-top:0;flex-wrap:wrap;gap:6px}',
    '.sl-rel{margin:0 0 8px;overflow-wrap:anywhere}'
  ].join('\n');
  document.head.appendChild(st);
}

/* ------------------------------------------------------------------ UI: chat */
var GLYPH = { wait:'○', run:'…', ok:'✓', fail:'✗', cancel:'–' };
function bagText(npc){
  var b = GT.agent.bag(npc), ids = Object.keys(b);
  return 'Dompet: ' + GT.agent.wallet(npc) + ' koin · Tas: ' + (ids.length ? ids.map(function(id){ return GT.itemName(id) + ' x' + b[id]; }).join(', ') : 'kosong');
}
function openChat(npc){
  if (!npc) return null;
  var soul = ensureSoul(npc), key = soul.key;
  if (chats[key] && chats[key].isOpen()) return chats[key];
  injectCss();
  var wrap = el('div'), head = el('div', 'sl-head'), tagH = el('span'), tagP = el('span', 'sl-tag');
  head.appendChild(tagH); head.appendChild(tagP);
  var wal = el('div', 'sl-wal'); wal.setAttribute('data-wallet', '1');
  var log = el('div', 'sl-log'); log.setAttribute('role', 'log'); log.setAttribute('aria-live', 'polite'); log.setAttribute('aria-label', 'Percakapan');
  var status = el('div', 'sl-st'); status.setAttribute('role', 'status');
  var input = el('input', 'sl-in'); input.type = 'text'; input.maxLength = 200; input.autocomplete = 'off';
  input.placeholder = 'Ketik pesan, mis. "ke mart lalu beli roti"'; input.setAttribute('aria-label', 'Pesan untuk ' + npc.name); input.setAttribute('data-autofocus', '');
  wrap.appendChild(head); wrap.appendChild(wal); wrap.appendChild(log); wrap.appendChild(status); wrap.appendChild(input);
  var locked = false, closeTimer = 0, h, planBox = null, planRows = [];
  function addLine(kind, text, dev){
    var d = el('div', 'sl-m ' + kind);
    if (dev){ var tg = el('span', 'sl-dev', 'DEV'); tg.setAttribute('data-dev', '1'); d.appendChild(tg); d.setAttribute('data-dev', '1'); }
    d.appendChild(document.createTextNode(text)); log.appendChild(d); log.scrollTop = log.scrollHeight;
    return d;
  }
  function refreshHead(){
    tagH.textContent = hearts(GT.getAffinity(npc)) + ' ' + GT.getAffinity(npc);
    tagP.textContent = 'Otak: ' + PNAME[soul.provider];
    wal.textContent = bagText(npc);
    var cb = h && h.btn('batal'); if (cb) cb.disabled = !GT.agent.status(npc).busy;
  }
  function setBusy(b){
    status.textContent = b ? 'Berpikir…' : '';
    var sb = h && h.btn('send'); if (sb) sb.disabled = b || locked;
    input.readOnly = b || locked;
  }
  // daftar tugas (checklist) yang tercentang langsung
  function buildPlan(labels, states){
    planBox = el('div', 'sl-m sys sl-plan'); planBox.setAttribute('data-plan', '1');
    planBox.appendChild(el('div', 'sl-plan-t', 'Tugas ' + npc.name + ':'));
    planRows = labels.map(function(lb, i){
      var row = el('div', 'sl-step'), g = el('span', 'sl-g', GLYPH[(states && states[i] && states[i].state) || 'wait']), t = el('span', null, lb);
      row.setAttribute('data-state', (states && states[i] && states[i].state) || 'wait');
      row.appendChild(g); row.appendChild(t);
      if (states && states[i] && states[i].note){ row.appendChild(el('span', 'sl-note', ' — ' + states[i].note)); }
      planBox.appendChild(row); return row;
    });
    log.appendChild(planBox); log.scrollTop = log.scrollHeight;
  }
  function setStep(i, state, note){
    var row = planRows[i]; if (!row) return;
    row.setAttribute('data-state', state);
    row.firstChild.textContent = GLYPH[state] || '○';
    var old = row.querySelector('.sl-note'); if (old) old.remove();
    if (note) row.appendChild(el('span', 'sl-note', ' — ' + note));
    log.scrollTop = log.scrollHeight;
  }
  function onEvt(ev){
    if (!h || !h.isOpen()) return;
    if (ev.type === 'plan') buildPlan(ev.steps);
    else if (ev.type === 'step'){ setStep(ev.i, ev.state, ev.state === 'run' ? '' : ev.note); }
    else if (ev.type === 'log'){ if (/^\s*✓/.test(ev.text)) return; addLine('npc', ev.text); }
    else if (ev.type === 'end'){
      if (ev.cancelled) addLine('sys', 'Tugas dibatalkan.');
      else if (!ev.ok && ev.failed) addLine('sys', 'Gagal: ' + ev.failed.note + '.');
      else if (ev.ok && ev.source === 'player') addLine('sys', 'Tugas selesai.');
    } else if (ev.type === 'report') addLine('npc', npc.name + ': ' + ev.text);
    refreshHead();
  }
  views[key] = onEvt;
  // riwayat singkat
  var past = soul.hist.slice(-6);
  if (!past.length) addLine('sys', npc.name + ' menoleh padamu. Ketik pesan lalu tekan Kirim.');
  past.forEach(function(m){
    if (m.role === 'user') addLine('me', playerName() + ': ' + m.content);
    else { var o = parseBrain(m.content); addLine('npc', npc.name + ': ' + (o.reply || '...')); }
  });
  // tugas yang sedang berjalan (obrolan ditutup-buka tidak membatalkan)
  var stt = GT.agent.status(npc);
  if (stt.busy){ buildPlan(stt.plan.map(function(p){ return p.label; }), stt.plan); }
  function send(){
    if (soul.ctrl || locked) return;
    var t = input.value.replace(/\s+/g, ' ').trim();
    if (!t){ input.focus(); return; }
    input.value = '';
    var isDev = devEnabled() && !!parseDev(t);
    addLine('me', playerName() + ': ' + t, isDev);
    setBusy(true);
    ask(npc, t).then(function(res){
      if (!h.isOpen() || res.aborted) return;
      setBusy(false);
      if (res.busy) return;
      if (res.error === 'rate_limited'){ addLine('sys', res.note); input.value = t; input.focus(); return; }
      if (res.note && res.fellBack) addLine('sys', res.note);
      if (!res.ok){ addLine('sys', 'Gagal memproses pesan. Coba lagi.'); input.value = t; return; }
      addLine('npc', npc.name + ': ' + res.reply);
      if (res.hint) addLine('sys', res.hint);
      if (res.refused) addLine('sys', 'Menolak.');
      else if (res.executed && res.sys && !planBox) addLine('sys', res.sys + '.');
      else if (res.requested && res.requested.type !== 'none' && !res.executed) addLine('sys', 'Tidak dijalankan.');
      if (res.affinity_delta) addLine('sys', 'Kedekatan ' + (res.affinity_delta > 0 ? '+' : '') + res.affinity_delta);
      refreshHead();
      if (res.executed && res.plan && res.plan.length === 1 && res.plan[0]['do'] === 'ikuti'){
        locked = true; setBusy(false); status.textContent = 'Menutup obrolan…';
        closeTimer = setTimeout(function(){ if (h.isOpen()) h.close('aksi'); }, 1100);
      } else { input.focus(); }
    });
  }
  input.addEventListener('keydown', function(e){
    if (e.key === 'Enter' && !e.isComposing){ e.preventDefault(); e.stopPropagation(); send(); }
  });
  h = GT.modal({
    title:'Jiwa: ' + npc.name,
    body:wrap,
    actions:[
      { id:'send', label:'Kirim', primary:true, onClick:send },
      { id:'batal', label:'Batalkan tugas', onClick:function(){
          if (GT.agent.cancel(npc)) { if (!planBox) addLine('sys', 'Tugas dibatalkan.'); }
          else addLine('sys', 'Tidak ada tugas yang berjalan.');
          refreshHead(); return false;
        } },
      { id:'cfg', label:'Atur', onClick:function(){ openConfig(key, npc.name, refreshHead); } },
      { id:'close', label:'Tutup' }
    ],
    onClose:function(){
      clearTimeout(closeTimer);
      abortSoul(soul);          // hanya membatalkan panggilan otak yang menggantung, BUKAN tugas yang sedang berjalan
      if (views[key] === onEvt) delete views[key];
      delete chats[key];
    }
  });
  chats[key] = h;
  refreshHead();
  return h;
}


/* ------------------------------------------------------------------ UI: pengaturan otak per NPC */
function claudePresent(){ try { return !!(window.claude && typeof window.claude.use === 'function'); } catch(e){ return false; } }
function openConfig(key, name, onDone){
  injectCss();
  var cur = souls[key] ? souls[key].provider : 'local';
  var body = el('div');
  body.appendChild(el('p', null, 'Pilih otak untuk ' + name + ':'));
  var seg = el('div', 'mseg'); seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-label', 'Provider otak');
  var radios = {};
  [['local', 'Lokal (tanpa AI)'], ['claude', 'Claude (bawaan artifact)'], ['custom', 'Endpoint kustom']].forEach(function(p){
    var lab = el('label'), r = el('input'); r.type = 'radio'; r.name = 'sl-prov'; r.value = p[0]; r.checked = (p[0] === cur);
    if (p[0] === 'claude' && !claudePresent()) { /* tetap boleh dipilih; jatuh ke lokal bila tak tersedia */ }
    lab.appendChild(r); lab.appendChild(el('span', null, p[1])); seg.appendChild(lab); radios[p[0]] = r;
  });
  body.appendChild(seg);
  var info = el('p', 'mnote'); info.style.marginTop = '8px'; body.appendChild(info);

  var cbox = el('div'); cbox.style.display = 'none';
  function field(label, type, val, ph){
    var l = el('label', 'sl-f'), s = el('span', null, label), i = el('input'); i.type = type; i.value = val || ''; if (ph) i.placeholder = ph;
    i.autocomplete = type === 'password' ? 'new-password' : 'off'; i.spellcheck = false; i.setAttribute('autocapitalize', 'off');
    l.appendChild(s); l.appendChild(i); cbox.appendChild(l); return i;
  }
  var fUrl = field('Endpoint URL', 'text', custom.url, 'https://api.openai.com/v1/chat/completions');
  var fKey = field('Kunci API (disembunyikan)', 'password', '', custom.key ? '(sudah diisi untuk sesi ini)' : 'sk-...');
  var fModel = field('Model', 'text', custom.model, 'gpt-4o-mini');
  var chkL = el('label', 'sl-chk'), chk = el('input'); chk.type = 'checkbox'; chk.checked = !!custom.remember;
  chkL.appendChild(chk); chkL.appendChild(el('span', null, 'Ingat di browser ini (kunci disimpan di localStorage perangkat ini)'));
  cbox.appendChild(chkL);
  cbox.appendChild(el('p', 'mnote', 'Kunci hanya dikirim ke endpoint di atas. Tanpa centang, kunci hilang saat halaman ditutup.'));
  cbox.appendChild(el('p', 'mnote', 'Di dalam claude.ai, koneksi ke situs lain diblokir; mode ini jalan saat file dibuka di luar claude.ai.'));
  var forget = el('button', 'mbtn', 'Lupakan kunci'); forget.type = 'button'; forget.style.marginBottom = '8px';
  forget.addEventListener('click', function(){ custom.key = ''; fKey.value = ''; fKey.placeholder = 'sk-...'; persist(); errEl.textContent = ''; GT.toast('Kunci dilupakan.'); });
  cbox.appendChild(forget);
  body.appendChild(cbox);
  var errEl = el('p', 'sl-err'); errEl.setAttribute('role', 'alert'); body.appendChild(errEl);

  function sync(){
    var v = cur;
    PROVIDERS.forEach(function(p){ if (radios[p].checked) v = p; });
    cur = v;
    cbox.style.display = v === 'custom' ? '' : 'none';
    if (v === 'local') info.textContent = 'Parser kata kunci Indonesia, bisa beberapa langkah: "ke mart lalu beli roti dan susu terus kasih ke aku", ikut aku, berhenti, main dadu, tunggu 30 menit, ajari X: ..., lakukan X. Selalu tersedia. Awali pesan dengan # untuk perintah paksa (mode developer).';
    else if (v === 'claude') info.textContent = claudePresent() ? 'Memakai Claude bawaan artifact. Izin diminta saat kamu menekan Kirim pertama kali.' : 'Tidak tersedia di tampilan ini. Pesan akan dijawab otak lokal.';
    else info.textContent = 'Endpoint OpenAI-compatible (Chat Completions). Bila gagal, giliran itu dijawab otak lokal.';
  }
  Object.keys(radios).forEach(function(p){ radios[p].addEventListener('change', sync); });
  sync();
  var hh = GT.modal({
    title:'Atur jiwa: ' + name,
    body:body,
    actions:[
      { label:'Simpan', primary:true, onClick:function(){
        sync();
        var cfg = null;
        if (cur === 'custom'){
          var u = fUrl.value.trim();
          if (!urlOk(u)){ errEl.textContent = 'URL harus https:// (http:// hanya untuk localhost).'; fUrl.focus(); return false; }
          cfg = { url:u, model:fModel.value.trim() || 'gpt-4o-mini', remember:chk.checked };
          if (fKey.value) cfg.key = fKey.value;
        }
        if (!setBrain(key, cur, cfg)){ errEl.textContent = 'Pengaturan tidak valid.'; return false; }
        fKey.value = '';
        GT.toast('Jiwa ' + name + ': ' + PNAME[cur]);
        if (onDone) onDone();
        return true;
      } },
      { label:'Batal' }
    ]
  });
  return hh;
}

/* ------------------------------------------------------------------ UI: panel Jiwa */
function candidateKeys(){
  var list = [], w = GT.world;
  if (w && w.own) list.push('house:' + w.own.id + ':0');
  Object.keys(souls).forEach(function(k){ if (list.indexOf(k) < 0) list.push(k); });
  Object.keys(met).forEach(function(k){ if (list.indexOf(k) < 0) list.push(k); });
  return list;
}
function nameOfKey(k){
  var n = GT.findNpc(k);
  if (n) return n.name;
  if (souls[k]) return souls[k].name;
  if (met[k]) return met[k];
  var w = GT.world;
  if (w && w.own && k === 'house:' + w.own.id + ':0') return 'Ibu';
  return k;
}
function npcOfKey(k){ try { return GT.agent.npcByKey(k); } catch(e){ return GT.findNpc(k); } }
function openGiveCoins(k, nm, after){
  var n = npcOfKey(k); if (!n) { GT.toast('NPC tidak ditemukan.'); return null; }
  var body = el('div'); body.appendChild(el('p', null, 'Beri koin dari dompetmu (' + GT.state.coins + ' koin) ke ' + nm + '.'));
  var acts = [10, 50, 100].map(function(v){
    return { label:'+' + v, onClick:function(){
      if (GT.agent.giveCoins(n, v)){ GT.toast(nm + ' menerima ' + v + ' koin.'); if (after) after(); } else GT.toast('Koinmu tidak cukup.');
      return true;
    } };
  });
  acts.push({ label:'Batal' });
  return GT.modal({ title:'Beri koin', body:body, actions:acts });
}
function openPanel(){
  if (GT.isUiOpen()) return null;
  injectCss();
  var body = el('div'), list = el('div'), skillBox = el('div');
  body.appendChild(el('p', 'mnote', 'Beri jiwa ke NPC, lalu hadapi dan tekan E untuk kirim pesan. Daftar: Ibu dan NPC yang pernah kamu ajak bicara.'));
  body.appendChild(list); body.appendChild(skillBox);
  var h = GT.modal({ title:'Jiwa NPC', body:body, backdropClose:true, actions:[{ label:'Tutup', primary:true }] });
  function render(){
    list.textContent = '';
    var keys = candidateKeys();
    keys.forEach(function(k){
      var nm = nameOfKey(k), s = souls[k], n = GT.findNpc(k);
      var row = el('div', 'mrow'), g = el('div', 'grow');
      var t = el('div', null, nm + (/^house:/.test(k) && GT.world && GT.world.own && k === 'house:' + GT.world.own.id + ':0' ? ' (ibumu)' : ''));
      var sub = el('span', 'sl-sub', (s ? 'Jiwa: ' + PNAME[s.provider] : 'Belum berjiwa') + (n ? ' · ' + sceneLabel(GT.npcScene(n)) : ''));
      g.appendChild(t); g.appendChild(sub);
      if (s && n){
        var st = GT.agent.status(n), tk = el('span', 'sl-sub', 'Tugas: ' + (st.busy ? st.plan.map(function(p){ return p.label; }).join(' > ') : 'tidak ada'));
        tk.setAttribute('data-task', '1');
        var wl = el('span', 'sl-sub', 'Dompet ' + st.wallet + ' koin · ' + bagText(n).split(' · ')[1]);
        g.appendChild(tk); g.appendChild(wl);
      }
      row.appendChild(g);
      var b1 = el('button', 'mbtn', s ? 'Atur' : 'Beri jiwa'); b1.type = 'button';
      b1.setAttribute('aria-label', (s ? 'Atur jiwa ' : 'Beri jiwa ') + nm);
      b1.addEventListener('click', function(){ openConfig(k, nm, render); });
      row.appendChild(b1);
      if (s){
        var b2 = el('button', 'mbtn', 'Copot'); b2.type = 'button'; b2.setAttribute('aria-label', 'Copot jiwa ' + nm);
        b2.addEventListener('click', function(){ removeSoul(k); GT.toast('Jiwa ' + nm + ' dicopot.'); render(); });
        row.appendChild(b2);
      }
      list.appendChild(row);
      if (s && n){
        var r2 = el('div', 'mrow sl-r2');
        var lab = el('label', 'sl-chk'), cb = el('input'); cb.type = 'checkbox'; cb.checked = GT.agent.isAuto(n); cb.setAttribute('data-auto', k);
        if (isWorker(n)) cb.disabled = true;
        cb.addEventListener('change', function(){ GT.agent.setAuto(n, cb.checked); GT.toast(nm + (cb.checked ? ' hidup mandiri.' : ' tidak lagi mandiri.')); });
        lab.appendChild(cb); lab.appendChild(el('span', null, 'Hidup mandiri' + (isWorker(n) ? ' (pekerja)' : s.provider !== 'local' ? ' (memakai kuota otak)' : '')));
        r2.appendChild(lab);
        var b3 = el('button', 'mbtn', 'Beri koin'); b3.type = 'button'; b3.setAttribute('aria-label', 'Beri koin ke ' + nm);
        b3.addEventListener('click', function(){ openGiveCoins(k, nm, render); });
        r2.appendChild(b3);
        var b4 = el('button', 'mbtn', 'Batalkan tugas'); b4.type = 'button'; b4.disabled = !GT.agent.status(n).busy;
        b4.addEventListener('click', function(){ GT.agent.cancel(n); render(); });
        r2.appendChild(b4);
        list.appendChild(r2);
        var rs = null; try { rs = GT.agent.relSummary(n); } catch(e){}
        if (rs){
          var rb = el('div', 'sl-sub sl-rel'); rb.setAttribute('data-rel', k);
          var fmt = function(a){ return a.length ? a.map(function(x){ return x.name + ' ' + (x.v > 0 ? '+' : '') + x.v; }).join(', ') : '-'; };
          rb.appendChild(el('b', null, 'Hubungan'));
          rb.appendChild(el('span', 'sl-relL', ' Suka: ' + fmt(rs.suka)));
          rb.appendChild(el('span', 'sl-relD', ' · Tidak suka: ' + fmt(rs.benci)));
          list.appendChild(rb);
        }
      }
    });
    if (!keys.length) list.appendChild(el('p', 'mnote', 'Belum ada NPC. Ajak bicara seseorang dulu.'));
    skillBox.textContent = '';
    var sk = GT.agent.skills.list();
    skillBox.appendChild(el('p', 'mnote', 'Keterampilan yang diajarkan (ajari NAMA: langkah, langkah):'));
    if (!sk.length) skillBox.appendChild(el('p', 'mnote', '(belum ada)'));
    sk.forEach(function(name){
      var r = el('div', 'mrow'), gg = el('div', 'grow');
      gg.appendChild(el('div', null, name));
      gg.appendChild(el('span', 'sl-sub', (GT.agent.skills.get(name) || []).map(function(s){ return GT.agent.stepLabel(s); }).join(' > ')));
      r.appendChild(gg);
      var fb = el('button', 'mbtn', 'Lupakan'); fb.type = 'button'; fb.setAttribute('aria-label', 'Lupakan keterampilan ' + name);
      fb.addEventListener('click', function(){ GT.agent.skills.forget(name); render(); });
      r.appendChild(fb); skillBox.appendChild(r);
    });
  }
  render();
  function sig(){
    return candidateKeys().map(function(k){ var n = souls[k] && GT.findNpc(k), st = n ? GT.agent.status(n) : null; return k + (st ? ':' + st.busy + ':' + st.wallet + ':' + st.plan.map(function(p){ return p.state; }).join('') : ''); }).join('|') + '#' + GT.agent.skills.list().join(',');
  }
  var lastSig = sig();
  var iv = setInterval(function(){
    if (!h.isOpen()){ clearInterval(iv); return; }
    try { var sg = sig(); if (sg !== lastSig && !(document.activeElement && body.contains(document.activeElement))){ lastSig = sg; render(); } } catch(e){}
  }, 1200);
  return h;
}


/* ------------------------------------------------------------------ API publik */
function applyCustom(cfg){
  if (!cfg || typeof cfg !== 'object') return true;
  if (cfg.url != null){
    var u = String(cfg.url).trim();
    if (!urlOk(u)) return false;
    custom.url = clampStr(u, 300);
  }
  if (cfg.model != null) custom.model = clampStr(String(cfg.model).trim(), 80);
  if (typeof cfg.key === 'string' && cfg.key) custom.key = clampStr(cfg.key, 400);
  if (cfg.remember != null) custom.remember = !!cfg.remember;
  return true;
}
function setBrain(key, provider, cfg){
  if (!key || typeof key !== 'string' || PROVIDERS.indexOf(provider) < 0) return false;
  if (provider === 'custom' && !applyCustom(cfg)) return false;
  if (provider !== 'custom' && cfg && cfg.remember != null) custom.remember = !!cfg.remember;
  var s = souls[key];
  if (!s) s = souls[key] = mkSoul(key, nameOfKey(key), provider);
  if (s.provider !== provider) { s.hist = []; }
  s.provider = provider;
  try { GT.agent.enroll(key, provider); } catch(e){}
  persist();
  return true;
}
function removeSoul(key){
  var s = souls[key]; if (!s) return false;
  abortSoul(s);
  try { var rn = GT.agent.npcByKey(key); if (rn) GT.agent.cancel(rn); } catch(e){}
  try { GT.agent.unenroll(key); } catch(e){}
  if (s.post && s.post.epoch === epoch){ try { placeAtPost(s.post.npc, s.post); } catch(e){} }
  s.post = null;
  delete souls[key]; persist();
  if (chats[key] && chats[key].isOpen()) chats[key].close('copot');
  return true;
}

function onWorldChange(){
  epoch++;
  Object.keys(souls).forEach(function(k){
    var s = souls[k];
    s.post = null;
    abortSoul(s);
  });
  var sd = GT.seed;
  var ownNow = (GT.world && GT.world.own && GT.world.own.id != null) ? +GT.world.own.id : null;
  if (storedSeed != null && storedSeed !== sd){
    var keep = null, ok = storedOwn != null && ownNow != null ? souls['house:' + storedOwn + ':0'] : null;
    var oldMet = storedOwn != null ? met['house:' + storedOwn + ':0'] : null;
    souls = {}; met = {};
    if (ok){
      var nk = 'house:' + ownNow + ':0';
      ok.key = nk; souls[nk] = ok;
      if (oldMet) met[nk] = oldMet;
    }
  }
  storedSeed = sd; if (ownNow != null) storedOwn = ownNow;
  Object.keys(souls).forEach(function(k){ souls[k].hist = []; try { GT.agent.enroll(k, souls[k].provider); } catch(e){} });
  logs = {};
  persist();
}

function jobKind(k){
  try { var n = GT.findNpc(k); if (!n) return null; var st = GT.agent.status(n); return st.busy ? st.kind : null; } catch(e){ return null; }
}
GT.soul = {
  version:2,
  setBrain:setBrain,
  removeSoul:removeSoul,
  hasSoul:function(k){ return !!souls[k]; },
  info:function(k){ var s = souls[k]; return s ? { provider:s.provider, busy:!!s.ctrl, job:jobKind(k), turns:s.hist.length / 2, hasKey:!!custom.key } : null; },
  ask:ask,
  openChat:openChat,
  openPanel:openPanel,
  _parse:parseBrain,
  _isDevCommand:function(t){ return !!parseDev(t); },
  _devCommand:function(t){ return parseDev(t); },
  _resetDevHint:function(){ devHinted = false; },
  _local:function(text, npc){ return localBrain(text, { name:npc ? npc.name : 'NPC', aff:npc ? GT.getAffinity(npc) : 40, hour:curHour(), npcObj:npc || null }); },
  _replyTo:replyToNpc,
  _autoPlan:autoPlanFor,
  _setRng:function(fn){ rng = typeof fn === 'function' ? fn : Math.random; },
  _setDelays:function(o){
    if (!o) return;
    Object.keys(o).forEach(function(k){ if (k in DELAY && isFinite(+o[k])) DELAY[k] = +o[k]; });
    try { var ao = {}; if (o.shop != null) ao.shop = Math.min(+o.shop, 4000); if (o.walkOut != null) ao.settle = +o.walkOut; GT.agent._setDelays(ao); } catch(e){}
  },
  _debug:function(){ return { souls:Object.keys(souls).map(function(k){ var s = souls[k]; return { key:k, provider:s.provider, hist:s.hist.length, job:jobKind(k), busy:!!s.ctrl }; }), met:Object.keys(met), epoch:epoch, custom:{ url:custom.url, model:custom.model, remember:custom.remember, hasKey:!!custom.key } }; }
};

GT.register({
  id:'soul',
  init:function(){
    loadStore();
    injectCss();
    GT.addHudButton({ id:'btnJiwa', label:'Jiwa', key:'J', onClick:openPanel });
    setInterval(postTick, DELAY.postTick);
    GT.agent.on(onAgentEvent);
    GT.agent.setHook({ isLlm:function(npc){ var sl = souls[GT.npcKey(npc)]; return !!sl && sl.provider !== 'local'; }, autoPlan:autoPlanFor });
    GT.on('dialogClose', function(d){ if (d && d.npc){ var k = GT.npcKey(d.npc); meet(k, d.npc.name); } });
  },
  onWorld:function(){ onWorldChange(); },
  onInteract:function(ctx){
    if (!ctx || !ctx.npc) return false;
    var npc = ctx.npc, k = GT.npcKey(npc);
    meet(k, npc.name);
    if (ctx.mode === 'message' && souls[k]){ openChat(npc); return true; }
    return false;
  }
});
})();

