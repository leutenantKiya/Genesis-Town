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
  var MODS = ['regions', 'sky', 'island', 'ground', 'water', 'props', 'buildings', 'actors', 'lights', 'weather', 'compat'];
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
  var hemi = null, sun = null, moon = null, map = null, shadowHalf = 0;
  var cDaySky = new THREE.Color(0xffffff), cNightSky = new THREE.Color(0x6676b8), cDayGround = new THREE.Color(0x8a90a8), cNightGround = new THREE.Color(0x222842);
  var cWarm = new THREE.Color(0xffb27a), cWhite = new THREE.Color(0xfff6ea), cMoon = new THREE.Color(0x9fb4ff);
  var sunDir = new THREE.Vector3(), moonDir = new THREE.Vector3(), target = new THREE.Vector3();

  function each(fn) { MODS.forEach(function (n) { if (R3D[n]) fn(R3D[n], n); }); }

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
    size.w = size.h = 0; zoom = 1; map = null; shadowHalf = 0;
    each(function (m) { m.init(C); });
    wheelFn = function (e) {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoom = Math.max(ZMIN, Math.min(ZMAX, zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
      size.w = size.h = 0; // re-fit the frustum
    };
    host.addEventListener('wheel', wheelFn, { passive: false });
    qFn = function () { applyQuality(); };
    window.addEventListener('gt3dquality', qFn);
    applyQuality();
  }

  function dispose() {
    if (!C) return;
    if (host && wheelFn) host.removeEventListener('wheel', wheelFn);
    if (qFn) window.removeEventListener('gt3dquality', qFn);
    each(function (m) { m.dispose(C); });
    C.renderer.dispose();
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    C = canvas = hemi = sun = moon = map = null;
  }

  R3D.rebuild = function () { map = null; }; // regions.js asks for a rebuild once a docking island has arrived

  function onWorld(m) {
    map = m;
    each(function (mod) { mod.onWorld(C, m); });
  }

  function resize(info) {
    var cvEl = document.getElementById('cv');
    var w = (cvEl && cvEl.clientWidth) || canvas.parentNode.clientWidth, hh = (cvEl && cvEl.clientHeight) || canvas.parentNode.clientHeight;
    if (w === size.w && hh === size.h) return;
    size.w = w; size.h = hh;
    C.renderer.setSize(w, hh, false);
    canvas.style.width = w + 'px'; canvas.style.height = hh + 'px';
    var rows = info.VH / info.T * ZOOM_ROWS / zoom, cols = rows * (w / hh);
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
    if (info.map !== map) onWorld(info.map);
    var cam = C.cam, pos = info.player.pos;
    var px = (pos.px + 6) / T, pz = (pos.py + 12) / T;
    cam.position.set(px, DIST * Math.sin(ELEV), pz + DIST * Math.cos(ELEV));
    cam.updateMatrixWorld(true);
    info.weather = weatherOf(); info.quality = R3D.Q;
    lighting(info, px, pz);
    each(function (m) { m.update(C, info); });
    C.renderer.render(C.scene, cam);
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

  GT.registerRenderer('3d', { init: init, dispose: dispose, render: render, onWorld: onWorld, screenToTile: screenToTile, tileToScreen: tileToScreen, mapToScreen: mapToScreen });
})();
