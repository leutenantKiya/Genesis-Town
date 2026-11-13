/*
 * players.js - seeing each other: other players walk around the village, with their name and market title over
 * their heads, and a global chat (press C, or "/" for a command). "/msg name text" is private; "/block name" hides
 * someone's lines in this browser; "/nama NamaBaru" changes your name. Click another player for their card
 * (message them, look at their stall). Indoors you are hidden; your house stays yours.
 * Everything is per world: you see and talk to players on the same island only ("public" or "IS-<id>"); "/msg" is
 * 1:1 and also reaches players in another world. Name, #tag and look are picked on the character screen after login (mods/charscreen.js).
 * The server keeps presence and chat in memory (server/src/social.ts); the economy is unchanged.
 */
(function () {
  'use strict';
  var GT = window.GT;
  if (!GT) return;

  var others = {};        // account -> { nick, title, x, y (tile), sx, sy, vx, vy, rt (last report), dx, dy, dt (drawn), spd, dir, seen }
  var meTag = '', me = null, online = 0, last = 0, timer = 0, busy = false, backoff = 0, curWorld = null, named = true; // named: has the server a chosen display name for me
  var lines = [];         // chat lines shown in the box
  var bubbles = {};       // nick (lower) -> { text, t }
  var box = null, list = null, input = null, head = null;
  var LS_BLOCK = 'gt.chat.blocked';
  /* How often this client reports and asks: often while someone else is near or I am walking, so a friend walks in step
     with what they see on their own screen; seldom when alone and still. The server allows 7 a second (app.ts presenceLimiter).
     Others are drawn where they reported, pushed on by their walking speed for as long as the report is old (the server
     says how old it was, half the round trip adds the way here; LEAD_S at most), and the drawn figure glides there: no
     fixed ease, no stop-and-go between reports. Starting, stopping and turning are reported at once, so the push ends soon. */
  var STEP_MS = 450, FAST_MS = 220, SLOW_MS = 900, LEAD_S = 0.3, GLIDE = 12, rtt = 250, nextAt = 0, holdUntil = 0, guestNext = 0, myLast = null, myMovedAt = 0;

  function C() { return window.GT_CHAIN; }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function blocked() { try { return JSON.parse(localStorage.getItem(LS_BLOCK) || '[]') || []; } catch (e) { return []; } }
  function setBlocked(a) { try { localStorage.setItem(LS_BLOCK, JSON.stringify(a)); } catch (e) { /* storage blocked */ } }
  // chat identity is always name#tag (names repeat, tags do not), never the plain name
  var myTrade = null; // { nick, acct }: the player I am in an open trade with, from the presence answer
  function key(nick, tag) { return String(nick).toLowerCase() + '#' + (tag || ''); }
  function isBlocked(nick, tag) { return blocked().indexOf(key(nick, tag)) >= 0; }
  function tagsOfName(name) { var n = String(name).toLowerCase(), t = {}; Object.keys(others).forEach(function (a) { var o = others[a]; if (String(o.nick).toLowerCase() === n && o.tag) t[o.tag] = 1; }); lines.forEach(function (m) { if (m.fromTag && String(m.from).toLowerCase() === n && m.from !== me) t[m.fromTag] = 1; }); return Object.keys(t); }
  function pal(nick) { var h = 0; for (var i = 0; i < nick.length; i++) h = (h * 31 + nick.charCodeAt(i)) | 0; return Math.abs(h) % 9; }
  // Guests: with no account (and a reachable server) the visitor walks the public village as "Tamu": no keys, no chat.
  var guestId = '', guestNick = '', guestBusy = false, guestRetryAt = 0, guestToldFull = false;
  function guestMode() { var c = C(); return !!(c && !c.state.account && c.state.mode !== 'loading' && !/[?&]mode=offline/.test(location.search) && location.protocol !== 'file:'); }
  function leaveGuest() { if (guestId) { guestId = ''; guestNick = ''; me = null; others = {}; curWorld = null; guestToldFull = false; } }
  function guestTick() {
    var c = C(), now = Date.now();
    if (guestBusy || document.hidden || now < guestRetryAt) return;
    guestBusy = true;
    var p = GT.player, pos = c.standPos();
    var go = guestId ? Promise.resolve() : c.api('/guest/hello', { method: 'POST', body: {} }).then(function (h) { guestId = h.guest; guestNick = h.nick; guestToldFull = false; });
    go.then(function () {
      return c.api('/guest/presence', { method: 'POST', body: { guest: guestId, x: pos.x, y: pos.y, dir: p.dir } });
    }).then(function (r) {
      if (c.state.account) return; // signed in meanwhile: the account loop takes over
      curWorld = 'public'; me = r.me; online = r.online; meTag = '';
      // the server picks a guest's look: draw it on our side too, so the guest sees what everyone else sees
      if (window.GT_CHARSCREEN && r.look != null) window.GT_CHARSCREEN.setMine(r.me, '', r.look, false);
      applyPlayers(r.players || []);
      renderHead();
    }, function (e) {
      if (e && e.status === 404) guestId = ''; // expired: say hello again
      else if (e && e.status === 403) { // kicked or address banned by an admin: say so once and stop knocking until the page is reloaded
        GT.toast((e.message || $t('Kamu dikeluarkan dari desa.'))); guestRetryAt = Date.now() + 365 * 86400000; me = null; others = {}; renderHead();
      }
      else if (e && e.status === 429 && !guestId) { if (!guestToldFull) { guestToldFull = true; GT.toast($t('Desa sedang penuh tamu, coba lagi nanti.')); } guestRetryAt = Date.now() + 20000; }
      else guestRetryAt = Date.now() + 5000;
    }).then(function () { guestBusy = false; });
  }
  function applyPlayers(list) {
    var now = performance.now(), keep = {};
    list.forEach(function (q) {
      keep[q.account] = 1;
      var o = others[q.account];
      var sx = q.fx != null ? q.fx : q.x, sy = q.fy != null ? q.fy : q.y;
      if (!o) o = others[q.account] = { dx: sx, dy: sy, dt: now, sx: sx, sy: sy, vx: 0, vy: 0, rt: now, spd: 0 };
      if (q.vx != null) { o.vx = q.vx; o.vy = q.vy; }
      else { // an older client or a guest sends only tiles: the speed comes from the last two reports
        var gap = (now - o.rt) / 1000, moved = sx !== o.sx || sy !== o.sy;
        if (moved && gap > 0.05 && gap < 1.5) { o.vx = clampV((sx - o.sx) / gap); o.vy = clampV((sy - o.sy) / gap); }
        else if (!moved) { o.vx = 0; o.vy = 0; }
      }
      o.sx = sx; o.sy = sy; o.rt = now; o.x = q.x; o.y = q.y; o.age = ((q.age || 0) + rtt / 2) / 1000;
      o.nick = q.nick; o.tag = q.tag; o.look = q.look; o.title = q.title; o.npc = !!q.npc; o.guest = !!q.guest; o.merchant = q.merchant; o.dir = q.dir; if (q.fish && !q.npc && (!o.fish || o.fish.phase !== q.fish.phase)) { var fp = q.fish.phase; var fs = fp === 'cast' ? 'cast' : fp === 'bite' ? 'bite' : fp === 'reel' ? 'reel' : ''; if (fs) sfx(fs, { vol: 0.6, x: q.x, y: q.y }); } // another player's rod
      o.worn = q.worn || null; o.fish = q.fish || null; o.room = q.room || null; o.account = q.account; o.party = !!q.party; o.trading = q.trading || null; o.tradingWith = q.tradingWith || null; o.seen = now;
    });
    Object.keys(others).forEach(function (a) { if (!keep[a]) delete others[a]; });
  }
  function active() { var c = C(); return !!(c && c.state.account && c.state.mode !== 'offline' && c.state.mode !== 'loading' && !c.state.superseded); }

  /* ---------------------------------------------------------------- presence loop */
  function tick() {
    if (guestMode()) { var gt = performance.now(); if (gt >= guestNext) { guestNext = gt + STEP_MS; guestTick(); } return; }
    if (guestId) leaveGuest();
    if (busy || !active() || document.hidden) return;
    var c = C(), sc = GT.scene, p = GT.player, pos = c.standPos(), w = (GT.worldId && GT.worldId()) || 'public', t = performance.now();
    var out = sc && sc.kind === 'out', sx = p.sx != null ? p.sx : pos.x, sy = p.sy != null ? p.sy : pos.y;
    var room = !out && sc && sc.key ? String(sc.key) : null;
    if (room) { sx = p.x; sy = p.y; } // indoors: where I stand in the room (the others in it see me there)
    if (myLast && (Math.abs(sx - myLast.x) > 0.01 || Math.abs(sy - myLast.y) > 0.01)) myMovedAt = t;
    var fast = t - myMovedAt < 1500 || Object.keys(others).some(function (a) { return !others[a].npc; });
    var fishNow = out && window.GT_FISH && GT_FISH.state ? GT_FISH.state() : null, fishKey = fishNow ? fishNow.phase + fishNow.x + ',' + fishNow.y : '';
    // start, stop, turn, or a new fishing phase (cast, bite, reel, done): tell now
    var turned = myLast && (out || room) && (!!p.moving !== myLast.moving || p.dir !== myLast.dir || fishKey !== myLast.fish) && t - myLast.t > 150;
    if (t < holdUntil || (!turned && t < nextAt - (fast ? SLOW_MS - FAST_MS : 0))) return;
    if (curWorld !== w) { curWorld = w; others = {}; } // other players belong to the world they are in
    // my walking speed since the last report, in tiles a second: the others push me on by it until the next one
    var gap = myLast ? (t - myLast.t) / 1000 : 0, vx = 0, vy = 0;
    if (myLast && gap > 0.05 && gap < 1.5 && p.moving) { vx = clampV((sx - myLast.x) / gap); vy = clampV((sy - myLast.y) / gap); }
    myLast = { x: sx, y: sy, t: t, moving: !!p.moving, dir: p.dir, fish: fishKey };
    nextAt = t + SLOW_MS;
    var body = { world: w, x: pos.x, y: pos.y, dir: p.dir, scene: out ? 'out' : 'in', since: last };
    if (out) { body.fx = Math.round(sx * 1000) / 1000; body.fy = Math.round(sy * 1000) / 1000; body.vx = Math.round(vx * 100) / 100; body.vy = Math.round(vy * 100) / 100; }
    if (fishNow) body.fish = { phase: fishNow.phase, x: fishNow.x, y: fishNow.y }; // others see me fishing
    if (room) { body.room = room; body.rx = p.x; body.ry = p.y; } // inside a building: players in the same room meet
    busy = true;
    c.api('/presence', { method: 'POST', body: body }).then(function (r) {
      rtt += (Math.min(3000, performance.now() - t) - rtt) * 0.2;
      if (r.world !== curWorld) return;
      backoff = 0;
      me = r.me; meTag = r.tag || meTag; online = r.online;
      myTrade = r.trading ? { nick: r.trading, acct: r.tradingWith } : null; // who I am in an open trade with
      named = r.named !== false; if (named && GT.setPlayerName) GT.setPlayerName(me);
      if (window.GT_CHARSCREEN) window.GT_CHARSCREEN.setMine(r.me, r.tag, r.look, named);
      applyPlayers(r.players || []);
      (r.chat || []).forEach(addLine);
      last = r.last || last;
      presenceFns.forEach(function (f) { try { f(r); } catch (e) { /* a listener must not break the loop */ } });
      renderHead();
    }, function () { backoff = Math.min(8, backoff + 1); holdUntil = performance.now() + backoff * STEP_MS; }).then(function () { busy = false; });
  }
  function clampV(v) { return Math.max(-8, Math.min(8, v)); }
  // Move the drawn figure once per frame: toward the reported spot pushed on by the walking speed, quickly but never in
  // a jump (a far jump, a portal or a respawn, is a snap)
  function glide(o, now) {
    if (o.dt === now) return;
    var dt = Math.min(0.1, Math.max(0, (now - o.dt) / 1000)), lead = Math.min(LEAD_S, (o.age || 0) + (now - o.rt) / 1000);
    var tx = o.sx + o.vx * lead, ty = o.sy + o.vy * lead, ex = tx - o.dx, ey = ty - o.dy, d = Math.hypot(ex, ey);
    var k = 1 - Math.exp(-dt * GLIDE), px = o.dx, py = o.dy;
    if (d > 6) { o.dx = tx; o.dy = ty; } else { o.dx += ex * k; o.dy += ey * k; }
    var sp = dt > 0 ? Math.hypot(o.dx - px, o.dy - py) / dt : 0;
    o.spd = o.spd + (sp - o.spd) * Math.min(1, dt * 10); o.dt = now;
  }
  function curX(o, now) { glide(o, now); return o.dx; }
  function curY(o, now) { glide(o, now); return o.dy; }

  /* ---------------------------------------------------------------- drawing */
  // another player's fishing as last reported; the time in the phase runs on locally so the float flies and bobs
  function fishOf(o, now) {
    var f = o.fish; if (!f) return null;
    if (o.fishKey !== f.phase + f.x + ',' + f.y) { o.fishKey = f.phase + f.x + ',' + f.y; o.fishAt = now; }
    return { phase: f.phase, x: f.x, y: f.y, hold: f.phase === 'reel', t: (now - o.fishAt) / 1000 };
  }
  // the others fishing now, at their drawn position: fishing.js draws their rods in the 2D view
  function anglers() {
    if (!GT.scene || GT.scene.kind !== 'out') return [];
    var now = performance.now(), out = [];
    Object.keys(others).forEach(function (a) { var o = others[a], f = !o.npc && fishOf(o, now); if (f) out.push({ x: curX(o, now), y: curY(o, now), dir: o.dir, fish: f }); });
    return out;
  }
  // a player is drawn where I am: outdoors the ones outdoors, inside a building the ones in the same room
  function here(o) { var sc = GT.scene; if (!sc) return false; return sc.kind === 'out' ? !o.room : !!o.room && o.room === String(sc.key); }
  function onEntities(ents, ctx, camX, camY, T) {
    if (!GT.scene) return;
    var now = performance.now();
    Object.keys(others).forEach(function (a) {
      var o = others[a];
      if (o.npc || !here(o)) return; // merchants are already drawn (and clickable) as stall NPCs by chain.js; here they only get a name tag
      var x = curX(o, now), y = curY(o, now), px = x * T, py = y * T;
      var moving = o.spd > 0.4, step = moving ? (Math.floor(now / 160) % 2 ? 1 : 2) : 0;
      var look = o.look != null ? o.look : pal(o.nick || a), W = window.GT_WORN, worn = o.worn;
      // px/py/pal/dir/step/id: the 2.5D view (mods/view3d.js) draws the same player as a 3D card; what they wear rides in the high bits of pal
      ents.push({ py: py, px: px, pal: W && worn ? W.pal(look, worn) : look, dir: o.dir, step: step, id: 'player:' + a, fish: fishOf(o, now), draw: function () {
        if (W && worn) W.back(ctx, px - camX, py - camY, worn, o.dir, step);
        GT.drawChar(ctx, px - camX, py - camY, look, o.dir, step);
        if (W && worn) W.front(ctx, px - camX, py - camY, worn, o.dir, step);
      } });
    });
  }
  // Name tags and bubbles are collected first, then placed so none sits on another: tags that share a row within a
  // few pixels step up, and every bubble goes above its tag, the player's own on top.
  function tone() { return window.GT_THEME ? GT_THEME : null; }
  function fitBubble(ctx, k, now) {
    var b = bubbles[k];
    if (!b || now - b.t > 6000) return null;
    ctx.font = '7px "Pixelify Sans", sans-serif';
    var text = b.text;
    if (ctx.measureText(text).width > 96) { while (text.length > 1 && ctx.measureText(text + '…').width > 96) text = text.slice(0, -1); text += '…'; }
    return text;
  }
  // sc: how big the tags are really drawn (GT_THEME.scale, 0.6 in 2.5D); the boxes must be compared at that size, or two tags
  // that sit apart on screen still count as touching
  function overlapX(a, b) { return Math.abs(a.x - b.x) < (a.w * a.sc + b.w * b.sc) / 2 + 1; }
  function overlaps(a, b) { return overlapX(a, b) && Math.abs(a.y - b.y) < 9 * Math.max(a.sc, b.sc); }
  // what I wear now (the server's state, fresh after every buy or wear)
  function ownWorn() { var c = C(), st = c && c.state && c.state.st, w = st && st.cosmetics && st.cosmetics.worn; return w && Object.keys(w).length ? w : null; }
  // an emote you bought: now and then a small glyph floats up over the head for two seconds (every player has their own rhythm)
  function emoteAt(ctx, worn, x, y, now, seed, sc) {
    var g = worn && window.GT_WORN ? GT_WORN.emote(worn) : null;
    if (!g) return;
    var h = 0, s = String(seed); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    var t = ((now / 1000) + (Math.abs(h) % 9)) % 9;
    if (t > 2.4) return;
    ctx.save(); ctx.globalAlpha = t < 0.3 ? t / 0.3 : t > 1.9 ? Math.max(0, (2.4 - t) / 0.5) : 1;
    ctx.font = Math.round(11 * sc) + 'px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText(g, Math.round(x), Math.round(y - t * 4 * sc)); ctx.restore();
  }
  function onDraw(ctx, camX, camY, T) {
    var TH = tone();
    if (!TH || !GT.scene) return;
    var now = performance.now(), W = ctx.canvas.width / (ctx.getTransform().a || 1);
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    var tags = [], bubs = [], placed = [];
    tagRects = []; drawW = W; drawH = ctx.canvas.height / (ctx.getTransform().d || 1);
    Object.keys(others).forEach(function (a) {
      var o = others[a]; if (!here(o)) return;
      var cx = curX(o, now);
      var at = GT.at(cx, curY(o, now)); // in 2.5D this follows the head at any camera turn
      var x = GT.snap(at.x + T / 2), y = GT.snap(at.y - 3); // every tag starts right above its owner's head
      var small = o.guest || !!guestId, sz = small ? 5 : 7; // a guest's own tag is small and dim; a guest sees everyone's tags small
      ctx.font = sz + 'px "Pixelify Sans", sans-serif';
      var text = o.guest ? $t('Tamu') : o.nick + (!o.npc && o.title && o.title !== $t('Pedagang baru') ? ' · ' + o.title : ''); // merchants stand a tile apart: name only, the stall sign has the shop name
      if (o.trading && !o.npc && !o.guest) text = o.nick + ' \u21c4 ' + o.trading; // in an open trade: everyone in the world sees with whom
      tags.push({ x: x, y: y, w: Math.ceil(ctx.measureText(text).width) + 4, text: text, tone: o.guest ? 'dim' : o.npc ? 'accent' : o.trading ? 'accent' : o.party ? 'party' : 'dark', size: sz, sc: TH.scale || 1, npc: !!o.npc, k: key(o.nick, o.tag), worn: o.worn || null, acct: a });
    });
    tags.sort(function (p, q) { return q.y - p.y || p.x - q.x; }); // lowest first: the ones behind step up
    tags.forEach(function (t) {
      for (var n = 0; n < 4; n++) {
        var hit = placed.filter(function (p) { return overlaps(p, t); })[0];
        if (!hit) break;
        // two merchants a stall apart: slide the right tag a few pixels sideways so both stay on their own heads
        if (hit.npc && t.npc && Math.abs(hit.y - t.y) < 3 * t.sc) t.x = GT.snap(Math.max(t.x, hit.x + (hit.w * hit.sc + t.w * t.sc) / 2 + 1));
        else t.y -= 9 * t.sc;
      }
      placed.push(t);
      var lw = TH.label(ctx, t.text, t.x, t.y, { tone: t.tone, size: t.size });
      tagRects.push({ acct: t.acct, x0: t.x - (t.w * t.sc) / 2 - 2, x1: t.x + (t.w * t.sc) / 2 + 2, y0: t.y - 9 * t.sc, y1: t.y + 2 }); // where the tag sits: a click on it opens the player's card
      var nc = t.worn && window.GT_WORN ? GT_WORN.nameColor(t.worn) : null; // a bought name colour: a coloured line under the tag
      if (nc && lw) { var kk = t.sc || 1; ctx.fillStyle = nc; ctx.fillRect(Math.round(t.x - lw * kk / 2), Math.round(t.y), Math.round(lw * kk), Math.max(1, Math.round(1.5 * kk))); }
      emoteAt(ctx, t.worn, t.x, t.y - 11 * (t.sc || 1), now, t.k, t.sc || 1);
      var bt = fitBubble(ctx, t.k, now);
      if (bt) bubs.push({ x: t.x, y: t.y - 10, text: bt, tag: t });
    });
    if (me && !guestId) {
      var p = GT.player, mt = fitBubble(ctx, key(me, meTag), now), ma = GT.at(p.x, p.y);
      if (mt) bubs.push({ x: GT.snap(ma.x + T / 2), y: GT.snap(ma.y - 4), text: mt, mine: true });
      var mw = ownWorn();
      if (mw) emoteAt(ctx, mw, GT.snap(ma.x + T / 2), GT.snap(ma.y - 12), now, 'me', TH.scale || 1);
    }
    bubs.sort(function (p, q) { return (p.mine ? 1 : 0) - (q.mine ? 1 : 0) || q.y - p.y; }); // my own bubble is drawn last, on top
    var bp = placed.slice(); // bubbles also keep clear of every name tag
    bubs.forEach(function (b) {
      ctx.font = '7px "Pixelify Sans", sans-serif';
      var w = Math.ceil(ctx.measureText(b.text).width) + 6;
      b.w = w;
      for (var n = 0; n < 6; n++) { if (!bp.some(function (q) { return q !== b.tag && Math.abs(q.x - b.x) < (q.w + w) / 2 + 1 && Math.abs(q.y - b.y) < 12; })) break; b.y -= 11; }
      bp.push(b);
      bubble(ctx, TH, b, W);
    });
    tradeBadges(ctx, TH, T, now);
    arrows(ctx, TH, W, T, now);
    ctx.restore();
  }
  // a small badge between two players in an open trade (once per pair; only when they stand near each other on screen)
  function tradeBadges(ctx, TH, T, now) {
    var c = C(), mine = c && c.state && c.state.account, done = {}, spot = function (acct) {
      if (acct === mine) { var p = GT.player, a = GT.at(p.x, p.y); return { x: a.x + T / 2, y: a.y, tx: p.x, ty: p.y }; }
      var o = others[acct]; if (!o || !here(o)) return null;
      var cx = curX(o, now), cy = curY(o, now), a2 = GT.at(cx, cy); return { x: a2.x + T / 2, y: a2.y, tx: cx, ty: cy };
    };
    var pairs = [];
    if (myTrade && mine) pairs.push([mine, myTrade.acct]);
    Object.keys(others).forEach(function (a) { var o = others[a]; if (o.tradingWith && !o.npc && !o.guest) pairs.push([a, o.tradingWith]); });
    pairs.forEach(function (pr) {
      var k = pr[0] < pr[1] ? pr[0] + '|' + pr[1] : pr[1] + '|' + pr[0];
      if (done[k]) return; done[k] = 1;
      var a = spot(pr[0]), b = spot(pr[1]);
      if (!a || !b || Math.abs(a.tx - b.tx) + Math.abs(a.ty - b.ty) > 10) return;
      TH.label(ctx, '\u21c4', GT.snap((a.x + b.x) / 2), GT.snap(Math.min(a.y, b.y) - 16), { tone: 'accent', size: 9 });
    });
  }
  // a small arrow on the screen edge towards each party mate who is off screen (GT.at projects in 2D and 2.5D alike)
  function arrows(ctx, TH, W, T, now) {
    var H = ctx.canvas.height / (ctx.getTransform().d || 1), m = 10;
    Object.keys(others).forEach(function (a) {
      var o = others[a]; if (!o.party) return;
      var at = GT.at(curX(o, now), curY(o, now)), x = at.x + T / 2, y = at.y + T / 2;
      if (x >= 0 && x <= W && y >= 0 && y <= H) return;
      var cx = W / 2, cy = H / 2, dx = x - cx, dy = y - cy, k = Math.min((W / 2 - m) / (Math.abs(dx) || 1e-6), (H / 2 - m) / (Math.abs(dy) || 1e-6));
      var ex = GT.snap(cx + dx * k), ey = GT.snap(cy + dy * k), ang = Math.atan2(dy, dx);
      ctx.save(); ctx.translate(ex, ey); ctx.rotate(ang);
      ctx.fillStyle = '#000'; ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(-4, -5); ctx.lineTo(-4, 5); ctx.closePath(); ctx.fill();
      ctx.fillStyle = TH.get('good') || '#2f7d4a'; ctx.beginPath(); ctx.moveTo(4.5, 0); ctx.lineTo(-3, -3.5); ctx.lineTo(-3, 3.5); ctx.closePath(); ctx.fill();
      ctx.restore();
      ctx.textAlign = ex > W / 2 ? 'right' : 'left'; ctx.textBaseline = 'bottom'; ctx.font = '7px "Pixelify Sans", sans-serif';
      TH.label(ctx, o.nick, Math.max(24, Math.min(W - 24, ex)), Math.max(18, Math.min(H - 4, ey - 8)), { tone: 'party' });
      ctx.textAlign = 'center';
    });
  }
  function bubble(ctx, TH, b, W) {
    var x = Math.max(Math.ceil(b.w / 2) + 1, Math.min(W - Math.ceil(b.w / 2) - 1, b.x)); // keep it on screen
    TH.label(ctx, b.text, x, b.y, { tone: 'paper', size: 7 });
    ctx.fillStyle = TH.get('paper-ink'); ctx.fillRect(GT.snap(Math.max(x - 1, Math.min(b.x, x + 1))), b.y + 1, 2, 2); // the tail points at the speaker
  }

  /* ---------------------------------------------------------------- chat box */
  function build() {
    var screen = document.getElementById('screen');
    if (!screen || box) return;
    box = el('section', 'gt-chat'); box.setAttribute('aria-label', $t('Obrolan'));
    head = el('div', 'gt-chat-head');
    list = el('div', 'gt-chat-list'); list.setAttribute('role', 'log'); list.setAttribute('aria-live', 'polite');
    var form = el('form', 'gt-chat-form');
    input = el('input', 'gt-chat-input'); input.type = 'text'; input.maxLength = 120; input.placeholder = $t('Ketik pesan · /msg nama pesan · /help'); input.setAttribute('aria-label', $t('Pesan'));
    input.autocomplete = 'off'; input.spellcheck = false;
    form.appendChild(input);
    box.appendChild(head); box.appendChild(list); box.appendChild(form);
    screen.appendChild(box);
    // typing never reaches the game's keys
    input.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); closeChat(); }
    });
    input.addEventListener('keyup', function (e) { e.stopPropagation(); });
    form.addEventListener('submit', function (e) { e.preventDefault(); send(input.value); });
    renderHead();
  }
  function renderHead() {
    if (!head) return;
    head.textContent = (me ? $t('Kamu: {0}', [me]) : $t('Obrolan')) + (online ? $t(' · {0} online', [online]) : '');
  }
  function sfx(n, o) { try { window.GT_SFX && GT_SFX.play(n, o); } catch (e) { /* sound never breaks play */ } }
  function addLine(m) {
    if (!m.note && isBlocked(m.from, m.fromTag)) return;
    if (m.sys === 'trade') { lines.push(m); if (lines.length > 60) lines.shift(); renderList(); return; } // the town's line: no sound, no bubble
    if (!m.note && key(m.from, m.fromTag) !== key(me || '', meTag)) sfx('chat', { vol: 0.5 }); // a message from someone else
    lines.push(m);
    if (lines.length > 60) lines.shift();
    if (!m.to && !m.party) bubbles[key(m.from, m.fromTag)] = { text: m.text, t: performance.now() };
    renderList();
  }
  function note(text) { lines.push({ id: 0, t: Date.now(), from: '', to: null, text: text, note: true }); renderList(); }
  function renderList() {
    if (!list) return;
    list.textContent = '';
    var mine = key(me || '', meTag);
    lines.slice(-30).forEach(function (m) {
      var row = el('div', 'gt-chat-line' + (m.to ? ' private' : '') + (m.party ? ' party' : '') + (m.note || m.sys ? ' note' : ''));
      row.dataset.t = String(m.t || Date.now());
      if (m.sys === 'trade') row.textContent = $t('{0} bertukar barang dengan {1}', [m.from, m.with]);
      else if (m.note) row.textContent = m.text;
      else {
        var from = m.from + (m.fromTag ? '#' + m.fromTag : ''), to = m.to ? m.to + (m.toTag ? '#' + m.toTag : '') : '';
        var who = m.party ? $t('[Party] {0}', [from]) : m.to ? (key(m.from, m.fromTag) === mine ? $t('kamu → {0}', [to]) : $t('{0} → kamu', [from])) : from;
        row.appendChild(el('b', null, who + ': '));
        row.appendChild(document.createTextNode(m.text));
      }
      list.appendChild(row);
    });
    list.scrollTop = list.scrollHeight;
    fade();
  }
  function fade() {
    if (!list) return;
    var open = box.classList.contains('open'), now = Date.now();
    [].forEach.call(list.children, function (r) { r.classList.toggle('old', !open && now - (+r.dataset.t || 0) > 12000); });
  }
  function openChat(prefill) {
    if (!active()) { if (C()) GT.toast($t('Masuk dulu untuk mengobrol.')); return; }
    build();
    box.classList.add('open');
    document.documentElement.classList.add('gt-chatting');
    if (prefill != null) input.value = prefill;
    fade();
    setTimeout(function () { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 0);
    if (!named && window.GT_CHARSCREEN) { GT.toast($t('Pilih namamu dulu di layar karakter.')); window.GT_CHARSCREEN.open(); }
  }
  function closeChat() {
    if (!box) return;
    box.classList.remove('open');
    document.documentElement.classList.remove('gt-chatting');
    input.blur();
    fade();
  }
  function send(raw) {
    var text = String(raw || '').trim();
    if (!text) { closeChat(); return; }
    var m;
    if (/^\/help$/i.test(text)) { note($t('Obrolan hanya dengan pemain di pulau yang sama (maks 80 huruf, 1 pesan / 2 detik). /msg nama pesan · pesan pribadi (lintas pulau) | /p pesan · pesan ke party (dari dunia mana pun) | /block nama · sembunyikan pesannya | /unblock nama | /nama NamaBaru · ganti nama | /party nama#tag · ajak ke party')); input.value = ''; return; }
    if ((m = /^\/(block|unblock)\s+(.+)$/i.exec(text))) {
      var target = m[2].trim(), tm = /^(.+)#(\d{5})$/.exec(target), tk;
      if (tm) tk = key(tm[1], tm[2]);
      else {
        var ts = tagsOfName(target);
        if (ts.length !== 1) { note(ts.length ? $t('Ada beberapa pemain bernama {0}. Pakai nama#tag.', [target]) : $t('Pemain {0} belum terlihat. Pakai nama#tag.', [target])); input.value = ''; return; }
        tk = key(target, ts[0]);
      }
      var b = blocked().filter(function (n) { return n !== tk; });
      if (m[1].toLowerCase() === 'block') b.push(tk);
      setBlocked(b); note(m[1].toLowerCase() === 'block' ? $t('{0} disembunyikan di browser ini.', [target]) : $t('{0} terlihat lagi.', [target]));
      input.value = ''; return;
    }
    if ((m = /^\/(party|ajak)\s+(.+)$/i.exec(text))) {
      input.value = '';
      if (window.GT_PARTY) GT_PARTY.invite(m[2].trim()).then(function () { closeChat(); });
      return;
    }
    if ((m = /^\/(dagang|trade)\s+(.+)$/i.exec(text))) {
      input.value = '';
      if (window.GT_TRADE) GT_TRADE.start(m[2].trim()).then(function () { closeChat(); });
      return;
    }
    if ((m = /^\/(nama|name|nick)\s+(.+)$/i.exec(text))) {
      C().api('/name', { method: 'POST', body: { name: m[2].trim() } }).then(function (r) { me = r.name; meTag = r.tag || meTag; named = r.named !== false; if (GT.setPlayerName) GT.setPlayerName(r.name); renderHead(); note($t('Namamu sekarang {0}#{1}.', [r.name, r.tag])); }, function (e) { note(e.message); });
      input.value = ''; return;
    }
    input.value = '';
    C().api('/chat', { method: 'POST', body: { world: (GT.worldId && GT.worldId()) || 'public', text: text } }).then(function () { sfx('chat', { vol: 0.5 }); tick(); }, function (e) { note(e.message); sfx('error', { vol: 0.6 }); input.value = text; });
  }

  /* ---------------------------------------------------------------- player card */
  var tagRects = [], drawW = 0, drawH = 0; // the name tags as last drawn, in the canvas's drawing units
  function playerAt(t) {
    var now = performance.now(), hit = null;
    Object.keys(others).forEach(function (a) { var o = others[a]; if (here(o) && Math.round(curX(o, now)) === t.x && Math.round(curY(o, now)) === t.y) hit = o; });
    return hit;
  }
  // a click on a player's name tag (client coordinates -> the canvas's drawing units, in which the tags were placed)
  function tagAt(cv, cx, cy) {
    var r = cv.getBoundingClientRect();
    if (!r.width || !drawW) return null;
    var x = (cx - r.left) * (drawW / r.width), y = (cy - r.top) * (drawH / r.height), hit = null;
    tagRects.forEach(function (q) { if (x >= q.x0 && x <= q.x1 && y >= q.y0 && y <= q.y1 && others[q.acct]) hit = others[q.acct]; });
    return hit;
  }
  var presenceFns = []; // other mods listen to each successful presence answer
  var cardActions = []; // other mods add buttons: fn(player) -> {label, onClick(handle)} | null
  // the player's look drawn small with GT.drawChar (the same figure as in the world)
  function portrait(o) {
    var PW = 20, PH = 26, k = 3, c = document.createElement('canvas'); // the figure is 12 x 14 with room for what is worn (8 px above, 4 to each side)
    c.width = PW * k; c.height = PH * k; c.setAttribute('aria-hidden', 'true');
    c.style.cssText = 'width:' + PW * k + 'px;height:' + PH * k + 'px;image-rendering:pixelated;display:block;margin:0 auto 4px';
    try {
      var tmp = document.createElement('canvas'), tg, g = c.getContext('2d'), W = window.GT_WORN, worn = o.worn, look = o.look != null ? o.look : pal(o.nick || '');
      tmp.width = PW; tmp.height = PH; tg = tmp.getContext('2d');
      if (W && worn) W.back(tg, 4, 10, worn, 'down', 0);
      GT.drawChar(tg, 4, 10, look, 'down', 0);
      if (W && worn) W.front(tg, 4, 10, worn, 'down', 0);
      g.imageSmoothingEnabled = false; g.drawImage(tmp, 0, 0, PW * k, PH * k);
    } catch (e) { /* the card works without the picture */ }
    return c;
  }
  function card(o) {
    var body = el('div', 'gt-pcard');
    if (o.npc) {
      body.appendChild(el('p', 'gt-pcard-title', o.title || $t('Pedagang')));
      body.appendChild(el('p', 'chain-dim', $t('Pedagang desa. Tanyakan harga lewat obrolan, atau lihat dagangannya.')));
      GT.modal({ title: o.nick + '#' + (o.tag || 'NPC'), body: body, actions: [
        { label: $t('Lihat dagangan'), primary: true, onClick: function (h) { h.close('ok'); var c = C(); if (c && o.merchant) c.open('shop', o.merchant); return true; } },
        { label: $t('Tanya'), onClick: function (h) { h.close('ok'); openChat('/msg ' + o.nick + ' '); return true; } },
        { label: $t('Batal'), close: true }
      ] });
      return;
    }
    sfx('ui_open', { vol: 0.5 });
    var tagged = o.nick + (o.tag ? '#' + o.tag : ''), unique = false; // unique: the plain name reaches only this player (the server says; until then name#tag is the safe handle)
    function handle() { return unique || !o.tag ? o.nick : tagged; }
    body.appendChild(portrait(o));
    body.appendChild(el('p', 'gt-pcard-title', o.guest ? $t('Tamu') : (o.title || $t('Pedagang baru'))));
    var lvl = el('p', 'gt-data', o.guest ? '' : $t('Balai Kota: …')), st = el('p', 'chain-dim', o.guest ? $t('Pengunjung yang belum masuk.') : $t('Warga desa yang sedang jalan-jalan.'));
    if (o.tag) body.appendChild(el('p', 'gt-data', tagged));
    body.appendChild(lvl); body.appendChild(st);
    var acts = [];
    if (!o.guest) acts.push({ label: $t('Pesan'), primary: true, onClick: function (h) { h.close('ok'); openChat('/msg ' + handle() + ' '); return true; } });
    if (!o.guest && o.tag && window.GT_TRADE) acts.push({ label: $t('Trade'), onClick: function (h) { h.close('ok'); GT_TRADE.start(tagged); return true; } });
    if (!o.guest) acts.push({ label: $t('Lihat lapaknya'), onClick: function (h) { h.close('ok'); var c = C(); c.state.marketSeller = { account: o.account, nick: o.nick }; c.state.marketTab = 'lapak'; c.open('market'); return true; } });
    cardActions.forEach(function (f) { var x = null; try { x = f(o); } catch (e) { x = null; } if (x) acts.push(x); });
    acts.push({ label: $t('Batal'), close: true });
    var h = GT.modal({ title: tagged, body: body, actions: acts });
    if (o.guest || !active()) return;
    // the profile: Town Hall level, online, party (GET /api/player)
    C().api('/player?name=' + encodeURIComponent(tagged)).then(function (p) {
      if (!h.isOpen()) return;
      unique = p.unique !== false;
      lvl.textContent = p.th != null ? $t('Balai Kota: level {0}', [p.th]) : $t('Belum punya Homeland');
      st.textContent = (p.online ? $t('Online sekarang') : $t('Sedang tidak terlihat')) + (p.mate ? ' · ' + $t('Satu party denganmu') : p.inParty ? ' · ' + $t('Sedang dalam party') : '');
    }, function () { if (h.isOpen()) lvl.textContent = ''; });
  }

  function onKey(e) {
    if (e.type !== 'keydown' || e.repeat || GT.isUiOpen()) return false;
    if (document.documentElement.classList.contains('gt-fishing') || document.documentElement.classList.contains('gt-fighting')) return false;
    if (e.code === 'KeyC') { openChat(''); return true; }
    if (e.code === 'Slash') { openChat('/'); return true; }
    return false;
  }

  function init() {
    timer = setInterval(tick, 60); // tick decides itself when the next report is due (FAST_MS or SLOW_MS)
    setInterval(fade, 2000);
    var cv = document.getElementById('cv');
    if (cv) cv.addEventListener('click', function (e) {
      if (e.button !== 0 || GT.isUiOpen() || !GT.screenToTile || !GT.scene) return;
      var t = GT.screenToTile(e.clientX, e.clientY), o = tagAt(cv, e.clientX, e.clientY) || (t && playerAt(t)); // the name tag, or the player's own tile
      if (!o) return;
      e.stopImmediatePropagation(); e.preventDefault();
      card(o);
    }, true);
    // build the box once signed in, so recent lines show even before the first message
    var wait = setInterval(function () { if (active()) { build(); clearInterval(wait); } }, 1000);
  }

  function refresh() { others = {}; curWorld = null; backoff = 0; nextAt = 0; holdUntil = 0; tick(); } // after sailing: forget the old world's players at once
  window.GT_PLAYERS = { anglers: anglers, where: function (account) { var o = others[account]; if (!o || !here(o)) return null; var n = performance.now(); return { x: curX(o, n), y: curY(o, n) }; }, onPresence: function (f) { presenceFns.push(f); }, addCardAction: function (f) { cardActions.push(f); }, refresh: refresh, promptName: function () { if (window.GT_CHARSCREEN) window.GT_CHARSCREEN.open(); }, openChat: openChat, closeChat: closeChat, _others: function () { return others; }, _lines: function () { return lines; } };
  GT.register({ id: 'players', init: function (g) { init(g); g.register({ id: 'players-labels', onDraw: onDraw }); }, onEntities: onEntities, onKey: onKey }); // tags and bubbles register last from init, so they draw over every other mod's signs
})();
