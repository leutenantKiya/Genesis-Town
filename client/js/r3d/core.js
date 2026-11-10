/*
 * r3d/core.js - the 3D renderer shell (Phase 0): WebGL canvas behind the 2D canvas, orthographic tilted camera that follows
 * the player, a sky colour from the game clock, a test marker on the player's tile, and tile <-> screen conversion.
 * Later phases add the island, water, buildings and actors (see the plan). World units: 1 tile = 1 unit,
 * tile (x, y) -> (x + 0.5, height, y + 0.5), north (up on the 2D map) = -z.
 */
(function () {
  'use strict';
  var THREE = window.THREE;
  if (!THREE || !window.GT) return;
  var GT = window.GT;

  var ELEV = 40 * Math.PI / 180;      // camera elevation above the ground
  var DIST = 60;                       // camera distance (ortho: only affects clipping)
  var ZOOM_ROWS = 1.25;                // visible world rows per 2D view row (the tilt shows more ground)

  var host = null, canvas = null, renderer = null, scene3 = null, cam = null;
  var marker = null, sky = null, ground = null;
  var target = new THREE.Vector3(), ray = new THREE.Raycaster(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  var tmpV = new THREE.Vector3(), tmpN = new THREE.Vector2();
  var DAY = new THREE.Color('#8fc7f0'), DUSK = new THREE.Color('#d98c5f'), NIGHT = new THREE.Color('#0d1230');
  var size = { w: 0, h: 0 };

  function init(h) {
    host = h;
    canvas = document.createElement('canvas');
    canvas.id = 'cv3d';
    canvas.setAttribute('aria-hidden', 'true');
    host.insertBefore(canvas, host.firstChild);
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    scene3 = new THREE.Scene();
    sky = new THREE.Color();
    scene3.background = sky;
    cam = new THREE.OrthographicCamera(-8, 8, 6, -6, 0.1, 400);
    scene3.add(new THREE.HemisphereLight(0xffffff, 0x556070, 1.0));
    var sun = new THREE.DirectionalLight(0xffffff, 1.2); sun.position.set(-20, 40, 15); scene3.add(sun);
    // Phase 0 stand-ins: a flat ground slab under the map and a marker on the player's tile
    ground = new THREE.Mesh(new THREE.BoxGeometry(1, 0.4, 1), new THREE.MeshLambertMaterial({ color: 0x6aa84f }));
    scene3.add(ground);
    marker = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.2, 0.7), new THREE.MeshLambertMaterial({ color: 0xe8503c }));
    scene3.add(marker);
    size.w = size.h = 0;
  }

  function dispose() {
    if (!renderer) return;
    scene3.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) { m.dispose(); }); }
    });
    renderer.dispose();
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    renderer = scene3 = cam = canvas = marker = ground = null;
  }

  function onWorld(map) {
    if (!ground || !map) return;
    ground.scale.set(map.w, 1, map.h);
    ground.position.set(map.w / 2, -0.2, map.h / 2);
  }

  function resize(info) {
    var w = canvas.parentNode.clientWidth, hh = canvas.parentNode.clientHeight;
    var cvEl = document.getElementById('cv');
    if (cvEl) { w = cvEl.clientWidth || w; hh = cvEl.clientHeight || hh; }
    if (w === size.w && hh === size.h) return;
    size.w = w; size.h = hh;
    renderer.setSize(w, hh, false);
    canvas.style.width = w + 'px'; canvas.style.height = hh + 'px';
    var rows = info.VH / info.T * ZOOM_ROWS, cols = rows * (w / hh);
    cam.left = -cols / 2; cam.right = cols / 2; cam.top = rows / 2; cam.bottom = -rows / 2;
    cam.updateProjectionMatrix();
  }

  function skyColor(dark) {
    var d = Math.max(0, Math.min(1, dark));
    if (d < 0.5) sky.copy(DAY).lerp(DUSK, d / 0.5); else sky.copy(DUSK).lerp(NIGHT, (d - 0.5) / 0.5);
  }

  function render(info) {
    resize(info);
    var pos = info.player.pos; // pixel position in 2D units (tile * T)
    var px = pos.px / info.T + 0.5, pz = pos.py / info.T + 0.5;
    target.set(px, 0, pz);
    cam.position.set(px, DIST * Math.sin(ELEV), pz + DIST * Math.cos(ELEV));
    cam.lookAt(target);
    marker.position.set(px, 0.6, pz);
    skyColor(info.dark);
    renderer.render(scene3, cam);
  }

  function screenToTile(cx, cy) {
    if (!canvas) return null;
    var r = canvas.getBoundingClientRect(); if (!r.width) return null;
    tmpN.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(tmpN, cam);
    var hit = ray.ray.intersectPlane(plane, tmpV);
    if (!hit) return null;
    return { x: Math.floor(hit.x), y: Math.floor(hit.z) };
  }

  function tileToScreen(x, y, h) {
    if (!canvas) return null;
    var r = canvas.getBoundingClientRect(); if (!r.width) return null;
    tmpV.set(x + 0.5, h ? h / 12 : 0, y + 0.5).project(cam);
    return { x: r.left + (tmpV.x + 1) / 2 * r.width, y: r.top + (1 - tmpV.y) / 2 * r.height };
  }

  GT.registerRenderer('3d', { init: init, dispose: dispose, render: render, onWorld: onWorld, screenToTile: screenToTile, tileToScreen: tileToScreen });
})();
