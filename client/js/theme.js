/*
 * theme.js - the UI tokens for canvas code. CSS reads css/theme.css directly; anything drawn on the game canvas
 * (name tags, bubbles, floating numbers, countdown labels) asks here, so canvas and DOM share one palette and follow
 * the season. Values are read from <html> once and re-read when its class changes (html.gt-s-<season>).
 *
 *   GT_THEME.get('accent')            -> '#f28fb0'   (any token name from css/theme.css, without the --)
 *   GT_THEME.season()                 -> 'semi' | 'panas' | 'gugur' | 'dingin'
 *   GT_THEME.label(ctx, text, x, y, {tone, size, align, bold})
 *       draws a small chip centred on x with its baseline at y: tone 'dark' (default: HUD chip), 'paper' (ink on
 *       paper) or 'accent' (ink on the season accent). Returns the chip's width.
 *   GT_THEME.text(ctx, text, x, y, colour, size)   outlined text with no chip (floating numbers)
 */
(function () {
  'use strict';
  var cache = {}, root = document.documentElement;
  function get(name) {
    if (cache[name] == null) cache[name] = getComputedStyle(root).getPropertyValue('--' + name).trim() || '';
    return cache[name];
  }
  function season() { var m = /(?:^|\s)gt-s-(semi|panas|gugur|dingin)(?:\s|$)/.exec(root.className); return m ? m[1] : 'semi'; }
  try { new MutationObserver(function () { cache = {}; }).observe(root, { attributes: true, attributeFilter: ['class', 'style'] }); } catch (e) { /* old browser: values stay as first read */ }

  var TONES = {
    dark: function () { return { bg: get('hud') || '#14152a', fg: get('hud-ink') || '#dfe8c2', alpha: 0.85 }; },
    paper: function () { return { bg: get('paper') || '#f4f1dc', fg: get('paper-ink') || '#1c1c2c', alpha: 1 }; },
    accent: function () { return { bg: get('accent') || '#f28fb0', fg: get('accent-ink') || '#1c1c2c', alpha: 1 }; }
  };
  // in 2.5D an overlay unit spans several screen pixels: anchor labels on whole screen pixels so they glide with the camera
  function snap(v) { return window.GT && GT.snap ? GT.snap(v) : Math.round(v); }
  function font(size, bold) { return (bold ? '600 ' : '') + (size || 7) + 'px "Pixelify Sans", sans-serif'; }

  function label(ctx, text, x, y, o) {
    o = o || {};
    var t = (TONES[o.tone] || TONES.dark)(), size = o.size || 7;
    ctx.save();
    var k = window.GT_THEME.scale || 1; // the 2.5D view draws labels smaller so they do not cover the world (view3d.js)
    if (k !== 1) { ctx.translate(snap(x), snap(y)); ctx.scale(k, k); x = 0; y = 0; }
    ctx.font = font(size, o.bold);
    ctx.textBaseline = 'bottom';
    var w = Math.ceil(ctx.measureText(text).width) + 4, h = size + 3;
    var left = Math.round(o.align === 'left' ? x : o.align === 'right' ? x - w : x - w / 2), top = Math.round(y) - h;
    ctx.globalAlpha = t.alpha;
    ctx.fillStyle = t.bg; ctx.fillRect(left, top, w, h);
    ctx.globalAlpha = 1;
    if (o.tone === 'paper' || o.tone === 'accent') { ctx.fillStyle = get('paper-ink') || '#1c1c2c'; ctx.fillRect(left, top + h, w, 1); } // the hard bottom edge
    ctx.fillStyle = t.fg; ctx.textAlign = 'left';
    ctx.fillText(text, left + 2, Math.round(y) - 1);
    ctx.restore();
    return w;
  }

  function text(ctx, str, x, y, colour, size) {
    ctx.save();
    var k = window.GT_THEME.scale || 1;
    if (k !== 1) { ctx.translate(snap(x), snap(y)); ctx.scale(k, k); x = 0; y = 0; }
    ctx.font = (size || 8) + 'px "Press Start 2P", monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillStyle = get('outline') || '#0b0c16';
    [[-1, 0], [1, 0], [0, -1], [0, 1]].forEach(function (d) { ctx.fillText(str, Math.round(x) + d[0], Math.round(y) + d[1]); });
    ctx.fillStyle = colour || get('hud-ink') || '#dfe8c2';
    ctx.fillText(str, Math.round(x), Math.round(y));
    ctx.restore();
  }

  window.GT_THEME = { get: get, season: season, label: label, text: text, scale: 1 };
})();
