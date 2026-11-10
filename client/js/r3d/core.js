/*
 * r3d/core.js - the 3D renderer shell. A WebGL canvas sits behind the engine's 2D canvas (which carries the compat overlay),
 * an orthographic camera at a fixed tilt follows the player, and small modules build the scene: sky, island, ground, water,
 * props, buildings, actors, lights, weather, compat (see the plan, docs/superpowers/plans/2026-11-10-floating-island-3d.md).
 * World units: 1 tile = 1 unit, tile (x, y) -> (x + 0.5, height, y + 0.5), north (up on the 2D map) = -z.
 * The camera never rotates, so camera-facing billboards share one fixed orientation (C.cam.quaternion).
 * Lighting: a sun that crosses the sky with the game clock (warm at dawn and dusk), a blue moon at night, a sky/ground
 * hemisphere light, and optional shadows. Quality (Rendah / Sedang / Tinggi, Pengaturan) sets pixel ratio, shadows,
 * lamp lights and particle counts.
 */
(function () {
  'use strict';
  var THREE = window.THREE;
  if (!THREE || !window.GT) return;
  var GT = window.GT, R3D = window.R3D || (window.R3D = {});

  var ELEV = 40 * Math.PI / 180;      // camera elevation above the ground
  var DIST = 90;                       // camera distance (ortho: only affects clipping)
  var ZOOM_ROWS = 1.25;                // visible world rows per 2D view row (the tilt shows more ground)
  var ZMIN = 0.6, ZMAX = 1.7;
  var HEMI = 2.5, SUN = 1.7;          // light intensities (three.js uses physical units: ~pi for a fully lit white surface)
  var MODS = ['regions', 'sky', 'island', 'ground', 'water', 'props', 'buildings', 'actors', 'lights', 'weather', 'fx', 'compat', 'interior'];
  var QUALITY = {
    rendah: { pr: 1, shadow: 0, lamps: 0, rain: 160, snow: 120 },
    sedang: { pr: 1.5, shadow: 1024, lamps: 4, rain: 420, snow: 320 },
    tinggi: { pr: 2, shadow: 2048, lamps: 8, rain: 700, snow: 520 }
  };
  var OVERCAST = { hujan: 0.85, berawan: 0.5, salju: 0.55, cerah: 0.05, terik: 0 };

  function qualityName() { var q = null; try { q = localStorage.getItem('gt-q3d'); } catch (e) { /* ignore */ } return QUALITY[q] ? q : 'sedang'; }
  R3D.Q = QUALITY[qualityName()];

  var T = 12, host = null, canvas = null, C = null, size = { w: 0, h: 0 }, zoom = 1, wheelFn = null, qFn = null;
  var tmpV = new THREE.Vector3(), tmpN = new THREE.Vector2(), up = new THREE.Vector3();
  var ray = new THREE.Raycaster(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  var hemi = null, sun = null, moon = null, map = null, shadowHalf = 0, interior = false, imap = null;
  var IN_UPDATE = { actors: 1, fx: 1, interior: 1 }; // what still runs while a room is shown
  var cDaySky = new THREE.Color(0xffffff), cNightSky = new THREE.Color(0x6676b8), cDayGround = new THREE.Color(0x8a90a8), cNightGround = new THREE.Color(0x222842);
  var cWarm = new THREE.Color(0xffb27a), cWhite = new THREE.Color(0xfff6ea), cMoon = new THREE.Color(0x9fb4ff);
  var sunDir = new THREE.Vector3(), moonDir = new THREE.Vector3(), target = new THREE.Vector3();

  /* ---- performance watchdog: if the first 10 seconds average under 20 fps the quality drops one step; if Rendah is still
     too slow the player is offered the 2D view. ?fps shows a small fps counter. ---- */
  var wd = { t0: 0, n: 0, last: 0, done: false, el: null, acc: 0, frames: 0 };
  function watchdog(info) {
    var now = performance.now();
    if (!wd.last) { wd.last = now; wd.t0 = now; return; }
    var dt = now - wd.last; wd.last = now;
    if (wd.el) { wd.acc += dt; wd.frames++; if (wd.acc > 500) { wd.el.textContent = Math.round(wd.frames * 1000 / wd.acc) + ' fps \u00b7 ' + C.renderer.info.render.calls + ' calls'; wd.acc = 0; wd.frames = 0; } }
    if (wd.done || dt > 500) return; // ignore pauses (hidden tab, loading)
    wd.n++;
    if (now - wd.t0 < 10000) return;
    wd.done = true;
    var fps = wd.n * 1000 / (now - wd.t0);
    if (fps >= 20) return;
    var q = qualityName();
    if (q !== 'rendah') {
      try { localStorage.setItem('gt-q3d', q === 'tinggi' ? 'sedang' : 'rendah'); } catch (e) { /* ignore */ }
      window.dispatchEvent(new Event('gt3dquality'));
      GT.toast('Tampilan 3D agak berat di perangkat ini. Kualitas diturunkan.');
      wd.done = false; wd.n = 0; wd.t0 = now; // look again with the lower setting
    } else if (GT.modal) {
      GT.modal({ title: 'Tampilan 3D terasa berat', body: 'Perangkat ini kesulitan menjalankan tampilan 3D (sekitar ' + Math.round(fps) + ' fps). Mau pindah ke tampilan 2D yang lebih ringan? Kamu bisa kembali ke 3D kapan saja dari Pengaturan.',
        actions: [{ label: 'Pindah ke 2D', primary: true, onClick: function () { GT.setView('2d'); return true; } }, { label: 'Tetap 3D', close: true }] });
    }
  }

  function each(fn) { MODS.forEach(function (n) { if (R3D[n]) fn(R3D[n], n); }); }
  function outdoors(fn) { each(function (m, n) { if (n !== 'interior') fn(m, n); }); }

  function applyQuality() {
    var name = qualityName(), Q = (R3D.Q = QUALITY[name]);
    if (!C) return;
    C.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, Q.pr));
    size.w = size.h = 0;
    var on = !!Q.shadow;
    C.renderer.shadowMap.enabled = on;
    C.renderer.shadowMap.type = THREE.PCFShadowMap;
    sun.castShadow = on;
    if (on) { sun.shadow.mapSize.set(Q.shadow, Q.shadow); }
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    shadowHalf = 0;
    C.scene.traverse(function (o) { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) { m.needsUpdate = true; }); });
    each(function (m) { if (m.onQuality) m.onQuality(C); });
  }

  function init(h) {
    host = h; T = (window.SPRITES && SPRITES.TILE) || 12;
    canvas = document.createElement('canvas');
    canvas.id = 'cv3d'; canvas.setAttribute('aria-hidden', 'true');
    host.insertBefore(canvas, host.firstChild);
    var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: false, alpha: false, stencil: true, powerPreference: 'high-performance' });
    R3D.Q = QUALITY[qualityName()];
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, R3D.Q.pr));
    var scene = new THREE.Scene();
    var cam = new THREE.OrthographicCamera(-8, 8, 6, -6, 0.1, 600);
    // fixed orientation: looking north and down at ELEV
    cam.position.set(0, DIST * Math.sin(ELEV), DIST * Math.cos(ELEV));
    cam.lookAt(0, 0, 0); cam.updateMatrixWorld(true);
    hemi = new THREE.HemisphereLight(0xffffff, 0x8a90a8, HEMI); scene.add(hemi);
    sun = new THREE.DirectionalLight(0xfff2dc, SUN); scene.add(sun); scene.add(sun.target);
    sun.shadow.camera.near = 1; sun.shadow.camera.far = 220; sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.04;
    moon = new THREE.DirectionalLight(0x9fb4ff, 0); scene.add(moon); scene.add(moon.target);
    var root = new THREE.Group(); scene.add(root);
    C = { renderer: renderer, scene: scene, cam: cam, root: root, THREE: THREE };
    R3D.ctx = C; // debugging handle (scene, camera, renderer)
    size.w = size.h = 0; zoom = document.documentElement.classList.contains('gt-phone') ? 1.3 : 1; map = null; imap = null; interior = false; shadowHalf = 0;
    each(function (m) { m.init(C); });
    wheelFn = function (e) {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoom = Math.max(ZMIN, Math.min(ZMAX, zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
      size.w = size.h = 0; // re-fit the frustum
    };
    host.addEventListener('wheel', wheelFn, { passive: false });
    qFn = function () { applyQuality(); };
    wd.last = 0; wd.n = 0; wd.done = false; wd.acc = 0; wd.frames = 0;
    try { if (/[?&]fps\b/.test(location.search)) { wd.el = document.createElement('div'); wd.el.style.cssText = 'position:absolute;left:4px;bottom:4px;z-index:9;font:11px monospace;color:#fff;background:rgba(0,0,0,.6);padding:2px 5px;pointer-events:none'; host.appendChild(wd.el); } } catch (e) { /* ignore */ }
    window.addEventListener('gt3dquality', qFn);
    applyQuality();
  }

  function dispose() {
    if (!C) return;
    if (host && wheelFn) host.removeEventListener('wheel', wheelFn);
    if (wd.el && wd.el.parentNode) wd.el.parentNode.removeChild(wd.el); wd.el = null;
    if (qFn) window.removeEventListener('gt3dquality', qFn);
    each(function (m) { m.dispose(C); });
    C.renderer.dispose();
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    C = canvas = hemi = sun = moon = map = imap = null; interior = false;
  }

  R3D.rebuild = function () { map = null; }; // regions.js asks for a rebuild once a docking island has arrived

  function setInterior(on, m) {
    interior = on; imap = on ? m : null;
    C.root.visible = !on;
    each(function (mod) { if (mod.setInterior) mod.setInterior(C, on); });
    size.w = size.h = 0;
  }
  function onWorld(m) {
    var k = GT.scene && GT.scene.kind;
    if (m.kind === 'interior' || (k && k !== 'out')) { // a room: the outdoor world is hidden, not rebuilt
      if (!interior) setInterior(true, m);
      imap = m; R3D.interior.show(C, m, k);
      size.w = size.h = 0;
      return;
    }
    if (interior) { R3D.interior.hide(C); setInterior(false); }
    if (m === map) return; // back outside: the world built earlier is still there
    map = m;
    outdoors(function (mod) { mod.onWorld(C, m); });
  }

  function resize(info) {
    var cvEl = document.getElementById('cv');
    var w = (cvEl && cvEl.clientWidth) || canvas.parentNode.clientWidth, hh = (cvEl && cvEl.clientHeight) || canvas.parentNode.clientHeight;
    if (w === size.w && hh === size.h) return;
    size.w = w; size.h = hh;
    C.renderer.setSize(w, hh, false);
    canvas.style.width = w + 'px'; canvas.style.height = hh + 'px';
    var rows = info.VH / info.T * ZOOM_ROWS / zoom, cols = rows * (w / hh);
    if (interior && imap) { // fit the whole room: its width, or its depth plus the wall height, whichever needs more
      var asp = w / hh, need = Math.max(imap.w + 2.6, (imap.h * Math.sin(ELEV) + 1.9 * Math.cos(ELEV) + 1.8) * asp);
      cols = need; rows = cols / asp;
    }
    var cam = C.cam;
    cam.left = -cols / 2; cam.right = cols / 2; cam.top = rows / 2; cam.bottom = -rows / 2;
    cam.updateProjectionMatrix();
  }

  function weatherOf() {
    var c = document.documentElement.classList, kind = null;
    ['hujan', 'berawan', 'salju', 'terik', 'cerah'].forEach(function (k) { if (!kind && c.contains('gt-w-' + k)) kind = k; });
    return { kind: kind, overcast: kind ? OVERCAST[kind] : 0 };
  }

  // sun, moon and sky light from the game clock, weather and quality
  function lighting(info, px, pz) {
    if (interior) { // a lit room: warm light from the front-left, no day or night
      hemi.color.set(0xfff4e0); hemi.groundColor.set(0xb0a090); hemi.intensity = HEMI * 0.95;
      sunDir.set(-0.35, 0.85, 0.5).normalize(); sun.color.set(0xfff0d8); sun.intensity = SUN * 0.8; moon.intensity = 0;
      target.set(px, 0, pz); sun.target.position.copy(target); sun.position.copy(target).addScaledVector(sunDir, 60);
      sun.target.updateMatrixWorld();
      if (sun.castShadow) { var sc0 = sun.shadow.camera, hh0 = imap ? Math.max(imap.w, imap.h) * 0.75 + 2 : 12; if (Math.abs(hh0 - shadowHalf) > 0.4) { shadowHalf = hh0; sc0.left = -hh0; sc0.right = hh0; sc0.top = hh0; sc0.bottom = -hh0; sc0.updateProjectionMatrix(); } }
      info.shadowsOn = !!sun.castShadow;
      return;
    }
    var h = (info.gameMin % 1440) / 60, d = Math.min(1, info.dark), day = 1 - d, oc = info.weather.overcast;
    var tS = (h - 6) / 12, aS = Math.PI * Math.min(1, Math.max(0, tS)), pow = Math.sin(aS);
    sunDir.set(Math.cos(aS), 0.22 + 0.78 * pow, 0.5).normalize();
    sun.color.copy(cWarm).lerp(cWhite, Math.pow(pow, 0.6));
    sun.intensity = SUN * day * (0.45 + 0.55 * pow) * (1 - 0.5 * oc) * (info.weather.kind === 'terik' ? 1.12 : 1);
    var u = Math.min(1, Math.max(0, (((h - 19) % 24 + 24) % 24) / 10)), aM = Math.PI * u;
    moonDir.set(-Math.cos(aM), 0.45 + 0.55 * Math.sin(aM), 0.4).normalize();
    moon.color.copy(cMoon);
    moon.intensity = 0.8 * SUN * d * (1 - 0.35 * oc);
    hemi.color.copy(cDaySky).lerp(cNightSky, d); hemi.groundColor.copy(cDayGround).lerp(cNightGround, d);
    hemi.intensity = HEMI * (1 - 0.68 * d) * (1 - 0.15 * oc);
    target.set(px, 0, pz);
    sun.target.position.copy(target); sun.position.copy(target).addScaledVector(sunDir, 80);
    moon.target.position.copy(target); moon.position.copy(target).addScaledVector(moonDir, 80);
    sun.target.updateMatrixWorld(); moon.target.updateMatrixWorld();
    if (sun.castShadow) {
      var cam = C.cam, half = Math.max(12, Math.min(44, (cam.right - cam.left) * 0.62));
      if (Math.abs(half - shadowHalf) > 0.4) {
        shadowHalf = half; var sc = sun.shadow.camera; sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half; sc.updateProjectionMatrix();
      }
    }
    info.shadowsOn = !!(sun.castShadow && sun.intensity > 0.05);
  }

  function render(info) {
    resize(info);
    var inside = info.kind !== 'out';
    if (info.map !== (inside ? imap : map)) onWorld(info.map);
    var cam = C.cam, pos = info.player.pos;
    var px = (pos.px + 6) / T, pz = (pos.py + 12) / T;
    if (interior && imap) { px = imap.w / 2; pz = imap.h / 2 + 0.7; }
    cam.position.set(px, DIST * Math.sin(ELEV), pz + DIST * Math.cos(ELEV));
    cam.updateMatrixWorld(true);
    info.weather = weatherOf(); info.quality = R3D.Q;
    lighting(info, px, pz);
    each(function (m, n) { if (!interior || IN_UPDATE[n]) m.update(C, info); });
    C.renderer.render(C.scene, cam);
    watchdog(info);
    if (R3D.compat) R3D.compat.overlay(C, info);
  }

  function screenToTile(cx, cy) {
    if (!canvas || !C) return null;
    var r = canvas.getBoundingClientRect(); if (!r.width) return null;
    tmpN.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(tmpN, C.cam);
    var hit = ray.ray.intersectPlane(plane, tmpV);
    if (!hit) return null;
    return { x: Math.floor(hit.x), y: Math.floor(hit.z) };
  }

  function tileToScreen(x, y, h) {
    if (!canvas || !C) return null;
    var r = canvas.getBoundingClientRect(); if (!r.width) return null;
    tmpV.set(x + 0.5, 0, y + 0.5);
    if (h) { up.set(0, 1, 0).applyQuaternion(C.cam.quaternion); tmpV.addScaledVector(up, h / T); }
    tmpV.project(C.cam);
    return { x: r.left + (tmpV.x + 1) / 2 * r.width, y: r.top + (1 - tmpV.y) / 2 * r.height };
  }

  // map pixel (X, Y) with a height in pixels above the ground (as a camera-facing sprite is measured) -> client coordinates
  function mapToScreen(X, Y, hpx) {
    if (!canvas || !C) return null;
    var r = canvas.getBoundingClientRect(); if (!r.width) return null;
    tmpV.set(X / T, 0, Y / T);
    if (hpx) { up.set(0, 1, 0).applyQuaternion(C.cam.quaternion); tmpV.addScaledVector(up, hpx / T); }
    tmpV.project(C.cam);
    return { x: r.left + (tmpV.x + 1) / 2 * r.width, y: r.top + (1 - tmpV.y) / 2 * r.height };
  }

  R3D.mapToScreen = mapToScreen;
  GT.registerRenderer('3d', { interior: true, init: init, dispose: dispose, render: render, onWorld: onWorld, screenToTile: screenToTile, tileToScreen: tileToScreen, mapToScreen: mapToScreen });
})();
