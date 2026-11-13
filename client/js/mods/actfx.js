/*
 * actfx.js - short action effects drawn over the world. Purely visual: the actions themselves run on the server.
 * - chop(tile): the axe swings into the tree with a white slash trail; on impact a flash, wood chips and leaves.
 * - mine(tile): the pickaxe (a curved two-pointed steel head) swings into the rock; on impact stone chips and sparks.
 * - strike(tile, hit): the same swing at a monster; on a hit it bursts sparks, on a miss the slash cuts air.
 * - float(tile, text, colour): a number or word that rises and fades over a tile ("-1", "Meleset!", "-4 energi").
 * - flash(tile, colour): a tile blinks (a monster hit white, the player hit red).
 * - rustle(tile, found): the grass at the tile shakes (green blades jump up); `found` pops a seed icon over it.
 * - poof(tile): a puff of smoke where a beaten monster was.
 * - shake(px): a small screen shake (skipped with "Kurangi animasi").
 */
(function () {
  'use strict';
  var GT = window.GT;
  if (!GT) return;

  var fx = [];          // swings: { kind, t, tile, from, dir, hit, parts }
  var texts = [];       // { tile, text, col, t }
  var flashes = [];     // { tile, col, t }
  var rustles = [];     // { tile, t, parts } tufts of grass shaken by a search
  var puffs = [];       // { tile, t, parts }
  var DUR = 0.5, HIT = 0.19;
  var ANG = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 };

  function reduced() { return document.documentElement.classList.contains('gt-reduced-motion'); }
  function dirTo(tile) {
    var p = GT.player, dx = tile.x - p.x, dy = tile.y - p.y;
    if (!dx && !dy) return p.dir;
    return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
  }
  function swing(kind, tile, hit) {
    var p = GT.player;
    try { if (window.GT_SFX) GT_SFX.play('swing'); } catch (e) { /* sound never blocks */ }
    fx.push({ kind: kind, t: 0, tile: { x: tile.x, y: tile.y }, from: { x: p.x, y: p.y }, dir: dirTo(tile), hit: hit !== false, parts: null });
  }
  function chop(tile) { swing('chop', tile, true); }
  function mine(tile) { swing('mine', tile, true); }
  function strike(tile, hit) { swing('strike', tile, hit); }
  // callers pass hex colours; the three they use map to tokens (gold, dim, warning), anything else passes through
  var TOKEN_OF = { '#ffd84a': 'gold', '#cfd8ff': 'hud-dim', '#ff8a7a': 'warn' };
  function themed(col) {
    var n = TOKEN_OF[String(col || '').toLowerCase()], T = window.GT_THEME;
    if (!n || !T) return col;
    if (n === 'warn') return T.get('warn-bg') || col; // the pale warning tone: --bad is too dark to read on grass
    return T.get(n) || col;
  }
  function float(tile, text, col) { texts.push({ tile: { x: tile.x, y: tile.y }, text: String(text), col: themed(col || '#ffffff'), t: 0 }); }
  function flash(tile, col) { flashes.push({ tile: { x: tile.x, y: tile.y }, col: col || 'rgba(255,255,255,0.85)', t: 0 }); }
  function poof(tile) {
    var parts = [];
    for (var i = 0; i < 10; i++) { var a = Math.random() * Math.PI * 2, v = 10 + Math.random() * 18; parts.push({ x: 0, y: 0, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 8, r: 1 + Math.random() * 2 }); }
    puffs.push({ tile: { x: tile.x, y: tile.y }, t: 0, parts: parts });
  }
  function rustle(tile, found) {
    var parts = [], i;
    for (i = 0; i < 9; i++) parts.push({ x: (Math.random() - 0.5) * 8, y: 2 + Math.random() * 3, vx: (Math.random() - 0.5) * 16, vy: -14 - Math.random() * 14, c: Math.random() < 0.5 ? '#58b048' : '#8ad060' });
    rustles.push({ tile: { x: tile.x, y: tile.y }, t: 0, parts: parts });
    if (found) texts.push({ tile: { x: tile.x, y: tile.y }, text: '🌱 +1', col: themed('#ffd84a'), t: -0.25 });
  }
  function shake(px) {
    if (reduced()) return;
    var cv = document.getElementById('cv');
    if (!cv || !cv.animate) return;
    var d = px || 2;
    cv.animate([{ transform: 'translate(0,0)' }, { transform: 'translate(' + d + 'px,-' + d + 'px)' }, { transform: 'translate(-' + d + 'px,' + d + 'px)' }, { transform: 'translate(' + (d / 2) + 'px,0)' }, { transform: 'translate(0,0)' }], { duration: 220, easing: 'steps(5)' });
  }

  function spawnParts(e) {
    var a = ANG[e.dir], parts = [], i;
    if (e.kind === 'strike') {
      if (!e.hit) return []; // a miss cuts only air
      for (i = 0; i < 9; i++) { // sparks thrown away from the player
        var s = a + (Math.random() - 0.5) * 1.8, v = 35 + Math.random() * 40;
        parts.push({ x: 0, y: 0, vx: Math.cos(s) * v, vy: Math.sin(s) * v - 20, g: 120, life: 0.35 + Math.random() * 0.2, c: Math.random() < 0.5 ? '#fff6c8' : '#ffd84a', w: 1 });
      }
      return parts;
    }
    if (e.kind === 'mine') {
      for (i = 0; i < 8; i++) { // stone chips, thrown back toward the player and up
        var s3 = a + Math.PI + (Math.random() - 0.5) * 1.8, v3 = 30 + Math.random() * 35;
        parts.push({ x: 0, y: 0, vx: Math.cos(s3) * v3, vy: Math.sin(s3) * v3 - 30, g: 170, life: 0.45 + Math.random() * 0.25, c: Math.random() < 0.5 ? '#8a8698' : '#b8b4c4', w: Math.random() < 0.4 ? 2 : 1 });
      }
      for (i = 0; i < 5; i++) { var s4 = a + (Math.random() - 0.5) * 2; parts.push({ x: 0, y: 0, vx: Math.cos(s4) * 50, vy: Math.sin(s4) * 50 - 25, g: 120, life: 0.25 + Math.random() * 0.15, c: '#fff6c8', w: 1 }); } // sparks
      return parts;
    }
    for (i = 0; i < 7; i++) { // wood chips, thrown back toward the player and up
      var s2 = a + Math.PI + (Math.random() - 0.5) * 1.6, v2 = 30 + Math.random() * 35;
      parts.push({ x: 0, y: 0, vx: Math.cos(s2) * v2, vy: Math.sin(s2) * v2 - 30, g: 160, life: 0.5 + Math.random() * 0.25, c: Math.random() < 0.5 ? '#c08848' : '#8e5a30', w: Math.random() < 0.4 ? 2 : 1 });
    }
    for (i = 0; i < 4; i++) { // leaves shaken loose from the canopy
      parts.push({ x: (Math.random() - 0.5) * 10, y: -12 - Math.random() * 6, vx: (Math.random() - 0.5) * 14, vy: 6 + Math.random() * 6, g: 4, sway: Math.random() * 6, life: 0.9 + Math.random() * 0.4, c: Math.random() < 0.5 ? '#48a046' : '#86c85a', w: 1, leaf: true });
    }
    return parts;
  }

  function onFrame(dt) {
    dt = Math.min(dt, 0.05);
    for (var i = fx.length - 1; i >= 0; i--) {
      var e = fx[i];
      e.t += dt;
      if (e.t >= HIT && !e.parts) e.parts = spawnParts(e);
      if (e.parts) e.parts.forEach(function (q) { q.life -= dt; q.vy += q.g * dt; q.x += q.vx * dt + (q.leaf ? Math.sin((e.t + q.sway) * 8) * 0.25 : 0); q.y += q.vy * dt; });
      var alive = e.t < DUR || (e.parts && e.parts.some(function (q) { return q.life > 0; }));
      if (!alive) fx.splice(i, 1);
    }
    for (var r = rustles.length - 1; r >= 0; r--) { var ru = rustles[r]; ru.t += dt; ru.parts.forEach(function (q) { q.vy += 70 * dt; q.x += q.vx * dt; q.y += q.vy * dt; }); if (ru.t > 0.55) rustles.splice(r, 1); }
    [texts, flashes, puffs].forEach(function (list) { for (var j = list.length - 1; j >= 0; j--) { list[j].t += dt; if (list[j].t > (list === texts ? 1.1 : list === flashes ? 0.25 : 0.7)) list.splice(j, 1); } });
    puffs.forEach(function (p) { p.parts.forEach(function (q) { q.x += q.vx * dt; q.y += q.vy * dt; q.vx *= 0.9; q.vy *= 0.9; }); });
  }

  function drawAxe(ctx, hx, hy, ang) {
    // handle from the hand along `ang`, head at the far end (pixel-ish: short line segments)
    var L = 7, ex = hx + Math.cos(ang) * L, ey = hy + Math.sin(ang) * L;
    ctx.strokeStyle = '#6a3f22'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(ex, ey); ctx.stroke();
    var px = Math.cos(ang + Math.PI / 2), py = Math.sin(ang + Math.PI / 2);
    ctx.fillStyle = '#d9dde6';
    ctx.beginPath();
    ctx.moveTo(ex - Math.cos(ang) * 2.5, ey - Math.sin(ang) * 2.5);
    ctx.lineTo(ex + px * 3.5, ey + py * 3.5);
    ctx.lineTo(ex + Math.cos(ang) * 1 + px * 1, ey + Math.sin(ang) * 1 + py * 1);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#7d8290'; ctx.fillRect(Math.round(ex) - 1, Math.round(ey) - 1, 2, 2);
  }

  function drawPick(ctx, hx, hy, ang) {
    // handle from the hand, a steel head across its end curving back at both points (a pickaxe, not an axe)
    var L = 7.5, ex = hx + Math.cos(ang) * L, ey = hy + Math.sin(ang) * L, px = Math.cos(ang + Math.PI / 2), py = Math.sin(ang + Math.PI / 2);
    var bx = Math.cos(ang), by = Math.sin(ang);
    ctx.strokeStyle = '#6a3f22'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.strokeStyle = '#c8ccd6'; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(ex + px * 4.5 - bx * 1.8, ey + py * 4.5 - by * 1.8); ctx.quadraticCurveTo(ex + bx * 1.2, ey + by * 1.2, ex - px * 4.5 - bx * 1.8, ey - py * 4.5 - by * 1.8); ctx.stroke();
    ctx.fillStyle = '#7d8290'; ctx.fillRect(Math.round(ex) - 1, Math.round(ey) - 1, 2, 2);
  }

  function onDraw(ctx, camX, camY, T) {
    if (!GT.scene || GT.scene.kind !== 'out') return;
    if (!fx.length && !texts.length && !flashes.length && !puffs.length && !rustles.length) return;
    ctx.save();
    var v3 = GT.view3dOn && GT.view3dOn(); // 2.5D: view3d.js swings a 3D axe from the sprite's hand and throws 3D chips
    flashes.forEach(function (f) {
      ctx.globalAlpha = Math.max(0, 1 - f.t / 0.25);
      ctx.fillStyle = f.col;
      var fa = GT.at(f.tile.x, f.tile.y);
      ctx.fillRect(fa.x + 1, fa.y - 2, T - 2, T + 1);
      ctx.globalAlpha = 1;
    });
    if (!v3) fx.forEach(function (e) {
      var ea = GT.at(e.from.x, e.from.y), ta = GT.at(e.tile.x, e.tile.y);
      var base = ANG[e.dir], hx = ea.x + T / 2, hy = ea.y + T / 2 - 1;
      var tx = ta.x + T / 2, ty = ta.y + T / 2;
      // swing: from behind the shoulder to past the target, fast at first (ease-out)
      var k = Math.min(1, e.t / HIT), ease = 1 - Math.pow(1 - k, 3);
      var side = e.dir === 'left' ? -1 : 1, from = base - side * 1.9, to = base + side * 0.7;
      var ang = from + (to - from) * ease;
      var reach = e.kind === 'strike' ? 12 : 10;
      if (e.t < DUR) {
        var trailFrom = from + (to - from) * Math.max(0, ease - 0.55), fade = e.t < HIT ? 1 : Math.max(0, 1 - (e.t - HIT) / (DUR - HIT));
        for (var w = 0; w < 3; w++) {
          ctx.strokeStyle = 'rgba(255,255,255,' + (fade * (0.9 - w * 0.28)).toFixed(3) + ')';
          ctx.lineWidth = 2.2 - w * 0.6;
          ctx.beginPath();
          ctx.arc(hx, hy, reach + w * 1.8, Math.min(trailFrom, ang), Math.max(trailFrom, ang), false);
          ctx.stroke();
        }
        if (e.t < DUR * 0.8) (e.kind === 'mine' ? drawPick : drawAxe)(ctx, hx, hy, ang);
      }
      // impact flash on the target
      if (e.hit && e.t >= HIT && e.t < HIT + 0.08) {
        ctx.fillStyle = 'rgba(255,248,200,' + (1 - (e.t - HIT) / 0.08).toFixed(3) + ')';
        ctx.fillRect(Math.round(tx) - 3, Math.round(ty) - 1, 6, 3);
        ctx.fillRect(Math.round(tx) - 1, Math.round(ty) - 3, 2, 7);
      }
      if (e.parts) e.parts.forEach(function (q) {
        if (q.life <= 0) return;
        ctx.globalAlpha = Math.min(1, q.life * 3);
        ctx.fillStyle = q.c;
        ctx.fillRect(Math.round(tx + q.x), Math.round(ty + q.y), q.w, q.leaf ? 1 : q.w);
        ctx.globalAlpha = 1;
      });
    });
    rustles.forEach(function (ru) { // the tuft sways side to side, blades jump up and fall
      var ra = GT.at(ru.tile.x, ru.tile.y), cx = ra.x + T / 2, cy = ra.y + T / 2 + 2, sway = Math.sin(ru.t * 40) * 1.5 * Math.max(0, 1 - ru.t / 0.4);
      ctx.fillStyle = '#3f9a3c';
      for (var b = -2; b <= 2; b++) ctx.fillRect(Math.round(cx + b * 2 + sway * (b % 2 ? 1 : -1)), Math.round(cy - 5 + Math.abs(b)), 1, 5 - Math.abs(b));
      ru.parts.forEach(function (q) { ctx.globalAlpha = Math.max(0, 1 - ru.t / 0.55); ctx.fillStyle = q.c; ctx.fillRect(Math.round(cx + q.x), Math.round(cy + q.y), 1, 2); ctx.globalAlpha = 1; });
    });
    puffs.forEach(function (p) {
      var pa = GT.at(p.tile.x, p.tile.y), cx = pa.x + T / 2, cy = pa.y + T / 2, a = Math.max(0, 1 - p.t / 0.7);
      p.parts.forEach(function (q) { ctx.fillStyle = 'rgba(230,230,236,' + (a * 0.9).toFixed(3) + ')'; var r = q.r * (1 + p.t * 2); ctx.fillRect(Math.round(cx + q.x - r / 2), Math.round(cy + q.y - r / 2), Math.ceil(r), Math.ceil(r)); });
    });
    // rising words and numbers, outlined so they read on any ground
    texts.forEach(function (s) {
      if (s.t < 0) return;
      var k = s.t / 1.1, sa = GT.at(s.tile.x, s.tile.y), x = GT.snap(sa.x + T / 2), y = GT.snap(sa.y - 2 - k * 10);
      ctx.globalAlpha = k < 0.7 ? 1 : Math.max(0, 1 - (k - 0.7) / 0.3);
      if (window.GT_THEME) GT_THEME.text(ctx, s.text, x, y, s.col, 8);
      ctx.globalAlpha = 1;
    });
    ctx.restore();
  }

  window.GT_FX = { chop: chop, mine: mine, strike: strike, float: float, flash: flash, rustle: rustle, poof: poof, shake: shake, _active: function () { return fx.length + texts.length; },
    // the swings in progress and their timing, for the 2.5D view's 3D axe (view3d.js)
    swings: function () { return fx; }, DUR: DUR, HIT: HIT };
  GT.register({ id: 'actfx', onFrame: onFrame, init: function (g) { g.register({ id: 'actfx-draw', onDraw: onDraw }); } }); // drawn last, over signs and tags
})();
