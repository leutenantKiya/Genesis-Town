/*
 * r3d/boot.js - loads the optional 3D view on demand (floating-island plan, docs/superpowers/plans/2026-11-10-floating-island-3d.md).
 *
 * Always loaded (tiny). It does nothing in the 2D view. When the view is 3d (?view=3d, the saved setting, or the settings
 * menu) it checks WebGL2, loads vendor/three.js and js/r3d/core.js once, and core.js registers the renderer with
 * GT.registerRenderer('3d', ...). Any failure falls back to the 2D view with a toast, so the game is never stuck.
 */
(function () {
  'use strict';
  var state = 'idle'; // idle | loading | ready | failed

  function hasWebGL2() {
    try {
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl2');
      return !!gl;
    } catch (e) { return false; }
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('gagal memuat ' + src)); };
      document.head.appendChild(s);
    });
  }

  function fail(why) {
    state = 'failed';
    try { console.warn('[3d]', why); } catch (e) { /* ignore */ }
    if (window.GT) {
      if (window.GT.toast) window.GT.toast('Tampilan 3D tidak bisa dijalankan di perangkat ini. Kembali ke 2D.');
      window.GT.setView('2d');
    }
  }

  function load() {
    if (state === 'loading' || state === 'ready' || state === 'failed') return;
    state = 'loading';
    if (!hasWebGL2()) return fail('WebGL2 tidak tersedia');
    var parts = ['geo', 'regions', 'sky', 'island', 'ground', 'water', 'props', 'buildings', 'rig', 'actors', 'lights', 'weather', 'compat', 'core']; // core last: it registers the renderer
    loadScript('vendor/three.js')
      .then(function () { return parts.reduce(function (p, n) { return p.then(function () { return loadScript('js/r3d/' + n + '.js'); }); }, Promise.resolve()); })
      .then(function () { state = 'ready'; })
      .catch(function (e) { fail(e && e.message); });
  }

  function init() {
    var GT = window.GT;
    if (!GT) return;
    GT.on('view', function (e) { if (e && e.need) load(); });
    if (GT.viewWanted === '3d') load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
