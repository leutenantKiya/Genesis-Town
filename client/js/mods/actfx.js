/*
 * actfx.js - short action effects drawn over the world.
 * chop(tile): the axe swings from behind the shoulder into the tree with a white slash trail; on impact the tree
 * gives a small flash, wood chips fly and a few leaves drift down. About half a second, purely visual (the gather action
 * itself is unchanged and runs at the same time).
 */
(function () {
  'use strict';
  var GT = window.GT;
  if (!GT) return;

  var fx = [];          // active effects: { kind, t, tile, dir, parts: [...] }
  var DUR = 0.5, HIT = 0.19;
  var ANG = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 };

  function chop(tile) {
    var p = GT.player, dir = p.dir;
    // face the tree if we know where it is
    var dx = tile.x - p.x, dy = tile.y - p.y;
    if (Math.abs(dx) + Math.abs(dy) === 1) dir = dx === 1 ? 'right' : dx === -1 ? 'left' : dy === 1 ? 'down' : 'up';
    fx.push({ kind: 'chop', t: 0, tile: { x: tile.x, y: tile.y }, from: { x: p.x, y: p.y }, dir: dir, parts: null });
  }

  function spawnParts(e) {
    var a = ANG[e.dir], parts = [], i;
    for (i = 0; i < 7; i++) { // wood chips, thrown back toward the player and up
      var s = a + Math.PI + (Math.random() - 0.5) * 1.6, v = 30 + Math.random() * 35;
      parts.push({ x: 0, y: 0, vx: Math.cos(s) * v, vy: Math.sin(s) * v - 30, g: 160, life: 0.5 + Math.random() * 0.25, c: Math.random() < 0.5 ? '#c08848' : '#8e5a30', w: Math.random() < 0.4 ? 2 : 1 });
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

  function onDraw(ctx, camX, camY, T) {
    if (!fx.length || !GT.scene || GT.scene.kind !== 'out') return;
    ctx.save();
    fx.forEach(function (e) {
      if (e.kind !== 'chop') return;
      var base = ANG[e.dir], hx = e.from.x * T - camX + T / 2, hy = e.from.y * T - camY + T / 2 - 1;
      var tx = e.tile.x * T - camX + T / 2, ty = e.tile.y * T - camY + T / 2;
      // swing: from behind the shoulder (-110°) to past the target (+40°), fast at first (ease-out)
      var k = Math.min(1, e.t / HIT), ease = 1 - Math.pow(1 - k, 3);
      var side = e.dir === 'left' ? -1 : 1, from = base - side * 1.9, to = base + side * 0.7;
      var ang = from + (to - from) * ease;
      if (e.t < DUR) {
        // slash trail: a fading crescent along the path the axe head took
        var trailFrom = from + (to - from) * Math.max(0, ease - 0.55), fade = e.t < HIT ? 1 : Math.max(0, 1 - (e.t - HIT) / (DUR - HIT));
        for (var w = 0; w < 3; w++) {
          ctx.strokeStyle = 'rgba(255,255,255,' + (fade * (0.9 - w * 0.28)).toFixed(3) + ')';
          ctx.lineWidth = 2.2 - w * 0.6;
          ctx.beginPath();
          ctx.arc(hx, hy, 10 + w * 1.8, Math.min(trailFrom, ang), Math.max(trailFrom, ang), false);
          ctx.stroke();
        }
        if (e.t < DUR * 0.8) drawAxe(ctx, hx, hy, ang);
      }
      // impact flash on the trunk
      if (e.t >= HIT && e.t < HIT + 0.08) {
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
    ctx.restore();
  }

  window.GT_FX = { chop: chop, _active: function () { return fx.length; } };
  GT.register({ id: 'actfx', onFrame: onFrame, onDraw: onDraw });
})();
