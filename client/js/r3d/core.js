/*
 * r3d/core.js - the 3D renderer shell. A WebGL canvas sits behind the engine's 2D canvas (which carries the compat overlay),
 * an orthographic camera at a fixed tilt follows the player, and small modules build the scene: sky, island, ground, props,
 * actors, compat (see the plan, docs/superpowers/plans/2026-11-10-floating-island-3d.md).
 * World units: 1 tile = 1 unit, tile (x, y) -> (x + 0.5, height, y + 0.5), north (up on the 2D map) = -z.
 * The camera never rotates, so camera-facing billboards share one fixed orientation (C.cam.quaternion).
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
  var MODS = ['sky', 'island', 'ground', 'water', 'props', 'actors', 'compat'];

  var T = 12, host = null, canvas = null, C = null, size = { w: 0, h: 0 }, zoom = 1, wheelFn = null;
  var tmpV = new THREE.Vector3(), tmpN = new THREE.Vector2(), up = new THREE.Vector3();
  var ray = new THREE.Raycaster(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  var hemi = null, sun = null;
  var map = null;

  function each(fn) { MODS.forEach(function (n) { if (R3D[n]) fn(R3D[n], n); }); }

  function init(h) {
    host = h; T = (window.SPRITES && SPRITES.TILE) || 12;
    canvas = document.createElement('canvas');
    canvas.id = 'cv3d'; canvas.setAttribute('aria-hidden', 'true');
    host.insertBefore(canvas, host.firstChild);
    var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    var scene = new THREE.Scene();
    var cam = new THREE.OrthographicCamera(-8, 8, 6, -6, 0.1, 600);
    // fixed orientation: looking north and down at ELEV
    cam.position.set(0, DIST * Math.sin(ELEV), DIST * Math.cos(ELEV));
    cam.lookAt(0, 0, 0); cam.updateMatrixWorld(true);
    hemi = new THREE.HemisphereLight(0xffffff, 0x6b7388, 1.05); scene.add(hemi);
    sun = new THREE.DirectionalLight(0xffffff, 1.0); sun.position.set(-20, 40, 15); scene.add(sun);
    var root = new THREE.Group(); scene.add(root);
    C = { renderer: renderer, scene: scene, cam: cam, root: root, THREE: THREE };
    R3D.ctx = C; // debugging handle (scene, camera, renderer)
    size.w = size.h = 0; zoom = 1; map = null;
    each(function (m) { m.init(C); });
    wheelFn = function (e) {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoom = Math.max(ZMIN, Math.min(ZMAX, zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
      size.w = size.h = 0; // re-fit the frustum
    };
    host.addEventListener('wheel', wheelFn, { passive: false });
  }

  function dispose() {
    if (!C) return;
    if (host && wheelFn) host.removeEventListener('wheel', wheelFn);
    each(function (m) { m.dispose(C); });
    C.renderer.dispose();
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    C = canvas = hemi = sun = map = null;
  }

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

  function render(info) {
    resize(info);
    if (info.map !== map) onWorld(info.map);
    var cam = C.cam, pos = info.player.pos;
    var px = (pos.px + 6) / T, pz = (pos.py + 12) / T;
    cam.position.set(px, DIST * Math.sin(ELEV), pz + DIST * Math.cos(ELEV));
    cam.updateMatrixWorld(true);
    var d = Math.min(1, info.dark);
    hemi.intensity = 1.05 - 0.72 * d; sun.intensity = 1.0 - 0.8 * d;
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
