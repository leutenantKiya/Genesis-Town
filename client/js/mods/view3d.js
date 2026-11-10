/* view3d.js - Tampilan 2.5D: the outdoor world (the village and Homelands) drawn with the 3D world kit (js/three/*,
 * window.GT3) in the HD-2D look of lab3d.html. The engine keeps every position, rule and server call; this view only
 * reads what the engine would draw (engine.js render3d) and draws it in three.js on a canvas under the 2D one.
 * Indoors, without WebGL, or with Tampilan 2D the 2D canvas draws as before.
 *
 * three.js and the kit load the first time the view is on. The choice is kept in localStorage 'gt.view' ('2d' | '3d');
 * the default is 2.5D on a computer and 2D on a phone (the forest is heavy on a small GPU).
 * The camera is the lab's (GT3.Rig defaults: pitch 52, fov 28) and so are its keys and controls: Q / E turn it by 45
 * degrees, + / - and the mouse wheel over the world zoom, a drag on the world walks (the lab's ring), and the lab's
 * trays (top right of the view) hold Desa / Homeland, zoom and turn, with the lab's key hint. Desa / Homeland walk to
 * the portal first: the server only lets a player travel from there. The season and the hour follow the server.
 * The arrows and WASD walk the way they point on screen (worldDir), and sprites face the same way.
 * The mods' overlays (signs, monsters, hats, effects, name tags) are placed with GT.at, which follows each tile's feet
 * on screen at any turn (engine.js render3d).
 *
 *   window.GT_VIEW3D = { get(), set('2d' | '3d'), toScreen(x, z, lift) (canvas px), playerTile(), turn(steps) }
 */
(function () {
  'use strict';
  var LS = 'gt.view', T = 12, STEP = Math.PI / 4;
  var DV = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
  var KIT = ['vendor/three.js', 'js/three/kit.js', 'js/three/ground.js', 'js/three/building.js', 'js/three/nature.js', 'js/three/props.js',
    'js/three/actor.js', 'js/three/sky.js', 'js/three/rig.js', 'js/three/seethrough.js', 'js/three/world.js'];
  var mode = saved() || (phone() ? '2d' : '3d');
  var loading = null, ok = false, failed = false;
  var THREE, renderer, cv, scene, camera, rig, sky, world = null, see = null, built = null, seasonKey = '';
  var actors = new Map(), gctx = null, gtex = null, gAt = 0, last = 0, sw = 0, sh = 0, VW = 1, VH = 1;
  var pt = { x: 0, y: 0 }, tmp = null, ray = null, ndc = null, plane = null, hit = null, yawWant = 0, zoom = 1;
  var KEY = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
  var ui = null, drag = null, took = 0, shownWorld = '';

  function saved() { try { var v = localStorage.getItem(LS); return v === '2d' || v === '3d' ? v : null; } catch (e) { return null; } }
  function phone() { try { return matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 900; } catch (e) { return false; } }

  function loadKit() {
    if (loading) return loading;
    loading = new Promise(function (res, rej) {
      var i = 0;
      (function next() {
        if (i >= KIT.length) return res();
        var src = KIT[i++];
        if (src === 'vendor/three.js' && window.THREE) return next();
        var s = document.createElement('script'); s.src = src; s.onload = next; s.onerror = function () { rej(new Error(src)); };
        document.head.appendChild(s);
      })();
    });
    return loading;
  }
  function fail(msg) {
    failed = true; ok = false; GT.setView3d(null); hide();
    if (GT.toast) GT.toast(msg);
  }
  function start() {
    if (ok || failed) return;
    loadKit().then(setup, function () { fail('Tampilan 2.5D gagal dimuat. Kembali ke 2D.'); });
  }
  function setup() {
    if (ok || !window.GT3) return fail('Tampilan 2.5D gagal dimuat. Kembali ke 2D.');
    THREE = window.THREE;
    try { renderer = new THREE.WebGLRenderer({ antialias: true }); } catch (e) { return fail('Perangkat ini tidak mendukung WebGL. Tampilan kembali ke 2D.'); }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
    cv = renderer.domElement; cv.className = 'gt3d'; cv.setAttribute('aria-hidden', 'true');
    cv.addEventListener('webglcontextlost', function (e) { e.preventDefault(); fail('Tampilan 2.5D berhenti (grafis penuh). Kembali ke 2D.'); });
    var scr = document.getElementById('screen'); scr.insertBefore(cv, scr.firstChild);
    scene = new THREE.Scene(); camera = new THREE.PerspectiveCamera(28, 1, 1, 160);
    sky = GT3.Sky(scene, renderer); rig = GT3.Rig(camera); // the lab's camera, unchanged
    tmp = new THREE.Vector3(); ray = new THREE.Raycaster(); ndc = new THREE.Vector2();
    plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); hit = new THREE.Vector3();
    ok = true;
    buildUi();
    if (mode === '3d') GT.setView3d(api);
  }

  /* ---------------------------------------------------------------- the lab's controls, in the game */
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function button(text, label, fn) {
    var b = el('button', null, text); b.type = 'button'; if (label) b.setAttribute('aria-label', label);
    b.addEventListener('click', function (e) { e.currentTarget.blur(); fn(); });
    return b;
  }
  function buildUi() {
    var scr = document.getElementById('screen'), c2 = document.getElementById('cv');
    if (!scr || !c2) return;
    ui = { bar: el('div', 'gt3d-bar'), hint: el('div', 'gt3d-hint'), stick: el('div', 'gt3d-stick') };
    var t1 = el('div', 'gt3d-tray'); t1.setAttribute('role', 'group'); t1.setAttribute('aria-label', 'Dunia');
    ui.desa = button('Desa', null, function () { goWorld('public'); });
    ui.home = button('Homeland', null, function () { goWorld('home'); });
    t1.appendChild(ui.desa); t1.appendChild(ui.home);
    var t2 = el('div', 'gt3d-tray'); t2.setAttribute('role', 'group'); t2.setAttribute('aria-label', 'Kamera');
    t2.appendChild(button('+', 'Perbesar', function () { zoom = rig.zoom(zoom * 1.2); }));
    t2.appendChild(button('-', 'Perkecil', function () { zoom = rig.zoom(zoom / 1.2); }));
    t2.appendChild(button('↺', 'Putar kamera ke kiri', function () { turn(-1); }));
    t2.appendChild(button('↻', 'Putar kamera ke kanan', function () { turn(1); }));
    ui.bar.appendChild(t1); ui.bar.appendChild(t2);
    ui.hint.innerHTML = '<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> atau seret jalan · <kbd>Q</kbd><kbd>E</kbd> putar kamera · scroll zoom';
    ui.stick.setAttribute('aria-hidden', 'true'); ui.stick.appendChild(el('i'));
    scr.appendChild(ui.bar); scr.appendChild(ui.hint); document.body.appendChild(ui.stick);
    // a drag on the world walks: past a small dead zone it holds the arrow it points at on screen, the way mouse.js walks
    c2.addEventListener('pointerdown', function (e) {
      if (!GT.view3dOn() || e.button !== 0 || GT.isUiOpen()) return;
      drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, on: false, dir: null };
    });
    c2.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var dx = e.clientX - drag.x0, dy = e.clientY - drag.y0, d = Math.hypot(dx, dy);
      if (!drag.on) {
        if (d <= 12) return;
        drag.on = true;
        try { c2.setPointerCapture(e.pointerId); } catch (_) { /* old browsers */ }
        ui.stick.style.left = drag.x0 + 'px'; ui.stick.style.top = drag.y0 + 'px'; ui.stick.style.display = 'block';
      }
      var k = d > 26 ? 26 / d : 1;
      ui.stick.firstChild.style.transform = 'translate(' + dx * k + 'px,' + dy * k + 'px)';
      var dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
      if (dir !== drag.dir) { if (drag.dir) key('keyup', drag.dir); key('keydown', dir); drag.dir = dir; }
    });
    function end(e) {
      if (!drag || e.pointerId !== drag.id) return;
      if (drag.on) { if (drag.dir) key('keyup', drag.dir); ui.stick.style.display = 'none'; took = performance.now(); }
      drag = null;
    }
    c2.addEventListener('pointerup', end); c2.addEventListener('pointercancel', end);
    // the wheel over the world zooms (over the hotbar it still picks the item in hand)
    c2.addEventListener('wheel', function (e) {
      if (!GT.view3dOn()) return;
      e.preventDefault(); e.stopPropagation();
      zoom = rig.zoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    }, { passive: false });
  }
  function key(type, d) { window.dispatchEvent(new KeyboardEvent(type, { code: KEY[d], key: KEY[d], bubbles: true, cancelable: true })); }
  function syncUi() {
    var w = GT.worldId ? GT.worldId() : 'public';
    if (!ui || w === shownWorld) return;
    shownWorld = w;
    ui.desa.setAttribute('aria-pressed', String(w === 'public'));
    ui.home.setAttribute('aria-pressed', String(w !== 'public'));
  }
  // Desa / Homeland travel from the portal, walking there first when the player is further than the server allows
  function goWorld(kind) {
    var H = window.GT_HOME && GT_HOME.state ? GT_HOME.state() : null;
    var to = kind === 'public' ? 'public' : H && H.world;
    if (!to) { GT.toast('Masuk dulu untuk ke Homeland.'); return; }
    if (GT.worldId() === to || GT.isUiOpen()) return;
    var p = GT.world && GT.world.portal, me = GT.player;
    if (!p) return;
    if (Math.abs(me.x - p.x) + Math.abs(me.y - p.y) <= 2) { GT_HOME.travel(to); return; }
    if (!(window.GT_MOUSE && GT_MOUSE.goNear(p, function () { GT_HOME.travel(to); }))) { GT.toast('Tidak ada jalan ke portal.'); return; }
    GT.toast('Berjalan ke portal…');
  }

  /* ---------------------------------------------------------------- the world of the current outdoor map */
  function ensureWorld(m) {
    if (built === m) return;
    if (world) { world.dispose(); world = null; see = null; }
    if (gtex) { scene.remove(gtex.userData.mesh); gtex.userData.mesh.geometry.dispose(); gtex.userData.mesh.material.dispose(); gtex.dispose(); gtex = null; gctx = null; }
    actors.forEach(function (a) { a.actor.dispose(); }); actors.clear();
    built = m; seasonKey = '';
    var L = m.layout;
    // the engine's own tiles: it adds the street lamps to the layout's
    world = GT3.World(Object.assign({}, L, { tiles: m.tiles, seed: L.seed || m.seed }));
    scene.add(world.group); see = GT3.SeeThrough(world);
    // what mods draw on the ground (crops, fishing ripples) goes on a transparent sheet just above it
    var c = GT3.canvas(L.w * T, L.h * T); gctx = c.getContext('2d'); gctx.imageSmoothingEnabled = false;
    gtex = GT3.tex(c); gtex.minFilter = THREE.NearestFilter; gtex.generateMipmaps = false;
    var mesh = new THREE.Mesh(new THREE.PlaneGeometry(L.w, L.h), GT3.mat({ map: gtex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    mesh.rotation.x = -Math.PI / 2; mesh.position.set(L.w / 2, 0.02, L.h / 2); mesh.receiveShadow = true; mesh.renderOrder = 1;
    gtex.userData.mesh = mesh; scene.add(mesh);
  }
  function size(o) {
    var el = document.getElementById('cv'), w = el.clientWidth, h = el.clientHeight;
    VW = o.VW; VH = o.VH;
    if (w === sw && h === sh) return;
    sw = w; sh = h;
    renderer.setSize(w, h);
    camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix(); rig.zoom(zoom);
  }
  // the camera's turn now (eased) and where it is going (yawWant): 0 looks north
  function yawNow() { return Math.atan2(camera.position.x - rig.target.x, camera.position.z - rig.target.z); }
  function dirOf(x, z) { return Math.abs(x) > Math.abs(z) + 1e-6 ? (x > 0 ? 'right' : 'left') : (z > 0 ? 'down' : 'up'); }
  // screen direction -> world direction (the lab's walk: mx = ix c + iz s, mz = -ix s + iz c)
  function worldDir(d) { var v = DV[d], c = Math.cos(yawWant), s = Math.sin(yawWant); return v ? dirOf(v[0] * c + v[1] * s, -v[0] * s + v[1] * c) : d; }
  // world direction -> the way the sprite looks on screen
  function screenDir(d) { var v = DV[d], y = yawNow(), c = Math.cos(y), s = Math.sin(y); return v ? dirOf(v[0] * c - v[1] * s, v[0] * s + v[1] * c) : d; }
  function turn(steps) { yawWant += steps * STEP; rig.turn(yawWant); }
  // three.js puts display:block on its canvas inline, so the class alone cannot hide it (indoors, Tampilan 2D)
  function hide() { document.documentElement.classList.remove('gt-3d'); if (cv) cv.style.display = 'none'; }
  function toScreen(x, z, lift) {
    var k = (lift || 0), p = rig.pitch, y = yawNow(); // the cards lean away from the camera by about its pitch (actor.js)
    tmp.set(x - k * Math.sin(p) * Math.sin(y), k * Math.cos(p), z - k * Math.sin(p) * Math.cos(y)).project(camera);
    return { x: (tmp.x + 1) / 2 * VW, y: (1 - tmp.y) / 2 * VH };
  }

  var api = {
    ready: function () { return ok && mode === '3d' && !!(GT.world && GT.world.layout); },
    idle: function () { hide(); last = 0; },
    groundCtx: function (m) {
      ensureWorld(m);
      var now = performance.now();
      if (now - gAt < 120) return null; // crops and ripples change slowly: ~8 uploads a second
      gAt = now; gtex.needsUpdate = true;
      return gctx;
    },
    draw: function (o) {
      ensureWorld(o.map);
      document.documentElement.classList.add('gt-3d'); cv.style.display = 'block'; syncUi();
      size(o);
      var now = performance.now(), dt = last ? Math.min(0.1, (now - last) / 1000) : 0.016; last = now;
      var season = GT.season(), snowy = !!(window.SPRITES && SPRITES.snow), sk = season + (snowy ? '*' : '');
      if (sk !== seasonKey) { seasonKey = sk; world.setSeason(season, snowy); }
      var seen = new Set();
      o.ents.forEach(function (e) {
        if (e.px == null) return;
        var key = e.me ? 'me' : (e.n || e.id); if (!key) return;
        var a = actors.get(key);
        if (a && a.pal !== e.pal) { a.actor.dispose(); a = null; }
        if (!a) { a = { actor: GT3.Actor(e.pal | 0), pal: e.pal }; scene.add(a.actor.group); actors.set(key, a); }
        var x = e.px / T + 0.5, z = e.py / T + 0.5;
        a.actor.set(x, z, screenDir(e.dir || 'down'), e.step | 0);
        seen.add(key);
        if (e.me) { pt.x = x; pt.y = z; }
      });
      actors.forEach(function (a, k) { if (!seen.has(k)) { a.actor.dispose(); actors.delete(k); } });
      rig.follow(pt.x, pt.y, dt);
      sky.set(o.hour, season); sky.follow(pt.x, pt.y);
      world.update(now / 1000, o.hour, sky.night);
      see.update(pt.x, pt.y, dt);
      actors.forEach(function (a) { a.actor.face(camera); });
      renderer.render(scene, camera);
      return toScreen(pt.x, pt.y, 0);
    },
    toScreen: toScreen,
    worldDir: worldDir,
    tookClick: function () { return performance.now() - took < 400; },
    // device px per art px at the player's depth: one tile up the card is 12 art px
    artScale: function (S) { var a = toScreen(pt.x, pt.y, 0), b = toScreen(pt.x, pt.y, 1); return Math.max(1, Math.hypot(a.x - b.x, a.y - b.y) * S / T); },
    pick: function (clientX, clientY) {
      var r = cv.getBoundingClientRect(); if (!r.width) return null;
      ndc.set((clientX - r.left) / r.width * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      if (!ray.ray.intersectPlane(plane, hit)) return null;
      return { x: Math.floor(hit.x), y: Math.floor(hit.z) };
    },
    playerTile: function () { return { x: pt.x, y: pt.y }; }
  };

  window.GT_VIEW3D = {
    get: function () { return mode; },
    set: function (v) {
      mode = v === '3d' ? '3d' : '2d';
      try { localStorage.setItem(LS, mode); } catch (e) { /* storage blocked */ }
      if (mode === '3d') { failed = false; if (ok) GT.setView3d(api); else start(); }
      else { GT.setView3d(null); hide(); }
    },
    toScreen: function (x, z, l) { return toScreen(x, z, l); },
    playerTile: function () { return api.playerTile(); },
    turn: turn,
    tookClick: function () { return api.tookClick(); },
    // the lab's keys while the 2.5D view shows (settings.js asks first): Q / E turn, + / - zoom
    onKey: function (e) {
      if (!GT.view3dOn || !GT.view3dOn()) return false;
      var c = e.code, k = c === 'KeyQ' ? -1 : c === 'KeyE' ? 1 : 0, z = c === 'Equal' || c === 'NumpadAdd' ? 1.2 : c === 'Minus' || c === 'NumpadSubtract' ? 1 / 1.2 : 0;
      if (!k && !z) return false;
      if (e.type === 'keydown' && !e.repeat && !GT.isUiOpen()) { if (k) turn(k); else zoom = rig.zoom(zoom * z); }
      return true;
    }
  };
  GT.register({ id: 'view3d', init: function () { if (mode === '3d') start(); } });
})();
