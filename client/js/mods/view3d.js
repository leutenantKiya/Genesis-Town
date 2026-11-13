/* view3d.js - Tampilan 2.5D: the outdoor world (the village and Homelands) drawn with the 3D world kit (js/three/*,
 * window.GT3) in an HD-2D look. The engine keeps every position, rule and server call; this view only
 * reads what the engine would draw (engine.js render3d) and draws it in three.js on a canvas under the 2D one.
 * Indoors, without WebGL, or with Tampilan 2D the 2D canvas draws as before.
 *
 * three.js and the kit load the first time the view is on. The choice is kept in localStorage 'gt.view' ('2d' | '3d');
 * the default is 2.5D on every device (owner's choice, 2026-11-13); 2D stays one switch away in Settings, and a device
 * without WebGL falls back to it by itself.
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
    'js/three/actor.js', 'js/three/rod.js', 'js/three/sky.js', 'js/three/rig.js', 'js/three/seethrough.js', 'js/three/fun.js', 'js/three/life.js', 'js/three/world.js', 'js/three/room.js', 'js/three/monsters.js'];
  var mode = saved() || '3d';
  var loading = null, ok = false, failed = false, booted = false;
  var THREE, renderer, cv, scene, camera, rig, sky, world = null, see = null, built = null, seasonKey = '';
  var mctx = null, mtex = null, mDue = false, mAny = false; // the unlit marks sheet (onDrawMarks: the hoe's squares)
  var actors = new Map(), gctx = null, gtex = null, gAt = 0, last = 0, sw = 0, sh = 0, VW = 1, VH = 1;
  var pt = { x: 0, y: 0 }, tmp = null, ray = null, ndc = null, plane = null, hit = null, yawWant = 0, zoom = 1;
  var ui = null, drag = null, took = 0, shownWorld = '', snapNext = true, last0 = 0;

  function saved() { try { var v = localStorage.getItem(LS); return v === '2d' || v === '3d' ? v : null; } catch (e) { return null; } }

  function loadKit() {
    if (loading) return loading;
    loading = new Promise(function (res, rej) {
      var i = 0;
      (function next() {
        if (i >= KIT.length) return res();
        var src = KIT[i++];
        if (window.GT_BOOT) GT_BOOT.set(0.35 + 0.5 * i / KIT.length, (GT_BOOT.zh ? 'Memuat dunia 2.5D… ' : 'Loading the 2.5D world… ') + i + '/' + KIT.length);
        if (src === 'vendor/three.js' && window.THREE) return next();
        var s = document.createElement('script'); s.src = src; s.onload = next; s.onerror = function () { rej(new Error(src)); };
        document.head.appendChild(s);
      })();
    });
    return loading;
  }
  function fail(msg) {
    failed = true; ok = false; GT.setView3d(null); hide(); bootDone();
    if (GT.toast) GT.toast(msg);
  }
  function start() {
    if (ok || failed) return;
    loadKit().then(setup, function () { fail($t('Tampilan 2.5D gagal dimuat. Kembali ke 2D.')); });
  }
  function setup() {
    if (ok || !window.GT3) return fail($t('Tampilan 2.5D gagal dimuat. Kembali ke 2D.'));
    THREE = window.THREE;
    try { renderer = new THREE.WebGLRenderer({ antialias: true }); } catch (e) { return fail($t('Perangkat ini tidak mendukung WebGL. Tampilan kembali ke 2D.')); }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
    cv = renderer.domElement; cv.className = 'gt3d'; cv.setAttribute('aria-hidden', 'true');
    cv.addEventListener('webglcontextlost', function (e) { e.preventDefault(); fail($t('Tampilan 2.5D berhenti (grafis penuh). Kembali ke 2D.')); });
    var scr = document.getElementById('screen'); scr.insertBefore(cv, scr.firstChild);
    scene = new THREE.Scene(); camera = new THREE.PerspectiveCamera(28, 1, 1, 160);
    sky = GT3.Sky(scene, renderer); rig = GT3.Rig(camera); // the lab's camera, unchanged
    tmp = new THREE.Vector3(); ray = new THREE.Raycaster(); ndc = new THREE.Vector2();
    plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); hit = new THREE.Vector3();
    setupUnfold();
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
  function worldBtn(ico, name, fn) {
    var b = button('', name, fn);
    b.appendChild(el('span', 'ico', ico)).setAttribute('aria-hidden', 'true'); b.appendChild(el('span', 'lbl', name)); b.title = name;
    return b;
  }
  function buildUi() {
    var scr = document.getElementById('screen'), c2 = document.getElementById('cv');
    if (!scr || !c2) return;
    ui = { bar: el('div', 'gt3d-bar'), hint: el('div', 'gt3d-hint'), stick: el('div', 'gt3d-stick') };
    var t1 = el('div', 'gt3d-tray'); t1.setAttribute('role', 'group'); t1.setAttribute('aria-label', $t('Dunia'));
    // a phone shows only the icon (css/phone.css), so the names go in aria-label too
    ui.desa = worldBtn('🏘️', $t('Desa'), function () { goWorld('public'); });
    ui.home = worldBtn('🏡', $t('Homeland'), function () { goWorld('home'); });
    t1.appendChild(ui.desa); t1.appendChild(ui.home);
    var t2 = el('div', 'gt3d-tray'); t2.setAttribute('role', 'group'); t2.setAttribute('aria-label', $t('Kamera'));
    t2.appendChild(button('+', $t('Perbesar'), function () { zoom = rig.zoom(zoom * 1.2); }));
    t2.appendChild(button('-', $t('Perkecil'), function () { zoom = rig.zoom(zoom / 1.2); }));
    t2.appendChild(button('↺', $t('Putar kamera ke kiri'), function () { turn(1); })); // Q
    t2.appendChild(button('↻', $t('Putar kamera ke kanan'), function () { turn(-1); })); // E
    ui.bar.appendChild(t1); ui.bar.appendChild(t2);
    ui.hint.innerHTML = $t('<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> atau seret jalan · <kbd>Q</kbd><kbd>E</kbd> putar kamera · scroll zoom');
    ui.stick.setAttribute('aria-hidden', 'true'); ui.stick.appendChild(el('i'));
    scr.appendChild(ui.bar); scr.appendChild(ui.hint); document.body.appendChild(ui.stick);
    // a drag on the world walks: past a small dead zone it is an analog stick (any direction, diagonals too), as in the lab
    c2.addEventListener('pointerdown', function (e) {
      if (!GT.view3dOn() || e.button !== 0 || GT.isUiOpen()) return;
      drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, on: false };
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
      GT.setStick(dx / d, dy / d);
    });
    function end(e) {
      if (!drag || e.pointerId !== drag.id) return;
      if (drag.on) { GT.setStick(null); ui.stick.style.display = 'none'; took = performance.now(); }
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
    if (!to) { GT.toast($t('Masuk dulu untuk ke Homeland.')); return; }
    if (GT.worldId() === to || GT.isUiOpen()) return;
    var p = GT.world && GT.world.portal, me = GT.player;
    if (!p) return;
    if (Math.abs(me.x - p.x) + Math.abs(me.y - p.y) <= 2) { GT_HOME.travel(to); return; }
    if (!(window.GT_MOUSE && GT_MOUSE.goNear(p, function () { GT_HOME.travel(to); }))) { GT.toast($t('Tidak ada jalan ke portal.')); return; }
    GT.toast($t('Berjalan ke portal…'));
  }

  /* ---------------------------------------------------------------- the world of the current outdoor map */
  function ensureWorld(m) {
    if (built === m) return;
    if (world) { world.dispose(); world = null; see = null; }
    if (gtex) { scene.remove(gtex.userData.mesh); gtex.userData.mesh.geometry.dispose(); gtex.userData.mesh.material.dispose(); gtex.dispose(); gtex = null; gctx = null; }
    if (mtex) { scene.remove(mtex.userData.mesh); mtex.userData.mesh.geometry.dispose(); mtex.userData.mesh.material.dispose(); mtex.dispose(); mtex = null; mctx = null; mAny = false; }
    actors.forEach(function (a) { a.actor.dispose(); }); actors.clear(); rods.forEach(function (r) { r.dispose(); }); rods.clear();
    built = m; seasonKey = ''; snapNext = true; stumpSynced = false; stumpSt = null; // a new world: its stumps appear, none fall
    var L = m.layout;
    // the engine's own tiles: it adds the street lamps to the layout's
    // the village layout has no portal of its own: the engine's dock is the big portal everyone travels through
    world = GT3.World(Object.assign({}, L, { tiles: m.tiles, seed: L.seed || m.seed }, L.portal || !m.portal ? {} : { portal: m.portal, bigPortal: true }));
    scene.add(world.group); see = GT3.SeeThrough(world);
    // what mods draw on the ground (crops, fishing ripples) goes on a transparent sheet just above it
    var c = GT3.canvas(L.w * T, L.h * T); gctx = c.getContext('2d'); gctx.imageSmoothingEnabled = false;
    gtex = GT3.tex(c); gtex.minFilter = THREE.NearestFilter; gtex.generateMipmaps = false;
    var mesh = new THREE.Mesh(new THREE.PlaneGeometry(L.w, L.h), GT3.mat({ map: gtex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    mesh.rotation.x = -Math.PI / 2; mesh.position.set(L.w / 2, 0.02, L.h / 2); mesh.receiveShadow = true; mesh.renderOrder = 1;
    gtex.userData.mesh = mesh; scene.add(mesh);
    // markers the player must always see go on a second sheet just above, unlit and unfogged: no sun shading, night or rain
    var mc = GT3.canvas(L.w * T, L.h * T); mctx = mc.getContext('2d'); mctx.imageSmoothingEnabled = false;
    mtex = GT3.tex(mc); mtex.minFilter = THREE.NearestFilter; mtex.generateMipmaps = false;
    var mm = new THREE.Mesh(new THREE.PlaneGeometry(L.w, L.h), new THREE.MeshBasicMaterial({ map: mtex, transparent: true, depthWrite: false, fog: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -3 }));
    mm.rotation.x = -Math.PI / 2; mm.position.set(L.w / 2, 0.03, L.h / 2); mm.renderOrder = 2; mm.visible = false;
    mtex.userData.mesh = mm; scene.add(mm);
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

  /* ---------------------------------------------------------------- the axe: a 3D swing from the sprite's hand
     actfx.js keeps the timing (GT_FX.swings: t, HIT, DUR); here the axe is a real model (handle and steel head, lit like
     the world). Its grip sits on the leaning sprite card at the hand, so on screen it leaves the hand at any camera turn,
     and it sweeps a flat arc in 3D from beside the player to past the target, tilted a little down; chips, leaves and
     sparks fly as small 3D cubes with gravity. */
  var swings = new Map(), bits = [], bitGeo = null;
  function axeModel(SIDE) {
    var g = new THREE.Group(), tilt = new THREE.Group(), arm = new THREE.Group();
    var handle = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.72), GT3.mat({ color: '#6a3f22' }));
    handle.position.z = 0.36;
    var head = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.05, 0.22), GT3.mat({ color: '#d9dde6' }));
    head.position.set(SIDE * 0.1, 0, 0.62); // the cutting edge leads the swing (local +X when SIDE is 1)
    var back = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.065, 0.16), GT3.mat({ color: '#7d8290' }));
    back.position.set(-SIDE * 0.04, 0, 0.62);
    // a tool in the hand: drawn after the world and over its own sprite card, so it reads at every angle and bites
    // visibly into the tree instead of vanishing inside the crown
    [handle, head, back].forEach(function (m) { m.castShadow = true; m.renderOrder = 10; m.material.depthTest = false; arm.add(m); });
    tilt.add(arm); g.add(tilt);
    g.userData = { tilt: tilt, arm: arm, side: SIDE };
    return g;
  }
  /* the pickaxe for mining: the axe's handle with a curved two-pointed head across its end */
  function pickModel(SIDE) {
    var g = new THREE.Group(), tilt = new THREE.Group(), arm = new THREE.Group();
    var handle = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.74), GT3.mat({ color: '#6a3f22' }));
    handle.position.z = 0.37;
    var steel = GT3.mat({ color: '#c8ccd6' }), parts = [handle];
    [-1, 1].forEach(function (k) {
      var arm1 = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.05, 0.06), steel); arm1.position.set(k * 0.1, 0, 0.7); arm1.rotation.y = -k * 0.25; parts.push(arm1);
      var tip = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.04, 0.05), steel); tip.position.set(k * 0.22, 0, 0.65); tip.rotation.y = -k * 0.7; parts.push(tip);
    });
    parts.forEach(function (m) { m.castShadow = true; m.renderOrder = 10; m.material.depthTest = false; arm.add(m); });
    tilt.add(arm); g.add(tilt);
    g.userData = { tilt: tilt, arm: arm, side: SIDE };
    return g;
  }
  function bit(color, x, y, z, vx, vy, vz, life, g, size) {
    bitGeo = bitGeo || new THREE.BoxGeometry(1, 1, 1);
    var m = new THREE.Mesh(bitGeo, new THREE.MeshBasicMaterial({ color: color, fog: true }));
    m.scale.setScalar(size || 0.07); m.position.set(x, y, z); scene.add(m);
    bits.push({ m: m, v: new THREE.Vector3(vx, vy, vz), life: life, g: g == null ? 9 : g, spin: (Math.random() - 0.5) * 12 });
  }
  function burst(e, dx, dz) {
    var tx = e.tile.x + 0.5 - dx * 0.32, tz = e.tile.y + 0.5 - dz * 0.32, i, r = Math.random;
    if (e.kind === 'strike') {
      if (!e.hit) return; // a miss cuts only air
      for (i = 0; i < 9; i++) bit(r() < 0.5 ? '#fff6c8' : '#ffd84a', tx, 0.55, tz, dx * 1.5 + (r() - 0.5) * 2.4, 1.5 + r() * 2, dz * 1.5 + (r() - 0.5) * 2.4, 0.35 + r() * 0.2, 6, 0.05);
      return;
    }
    if (e.kind === 'mine') { // stone chips and a few sparks off the rock
      for (i = 0; i < 8; i++) bit(r() < 0.5 ? '#8a8698' : '#b8b4c4', tx, 0.35, tz, -dx * (1 + r()) + (r() - 0.5) * 1.6, 2 + r() * 1.6, -dz * (1 + r()) + (r() - 0.5) * 1.6, 0.5 + r() * 0.2, 9, r() < 0.4 ? 0.08 : 0.05);
      for (i = 0; i < 5; i++) bit('#fff6c8', tx, 0.4, tz, (r() - 0.5) * 2.4, 1.5 + r() * 1.5, (r() - 0.5) * 2.4, 0.3, 6, 0.04);
      return;
    }
    for (i = 0; i < 7; i++) bit(r() < 0.5 ? '#c08848' : '#8e5a30', tx, 0.5, tz, -dx * (1 + r()) + (r() - 0.5) * 1.6, 2 + r() * 1.8, -dz * (1 + r()) + (r() - 0.5) * 1.6, 0.55 + r() * 0.25, 9, r() < 0.4 ? 0.09 : 0.06);
    for (i = 0; i < 4; i++) bit(r() < 0.5 ? '#48a046' : '#86c85a', e.tile.x + 0.5 + (r() - 0.5) * 0.8, 1.7 + r() * 0.4, e.tile.y + 0.5 + (r() - 0.5) * 0.8, (r() - 0.5) * 0.6, -0.4, (r() - 0.5) * 0.6, 1 + r() * 0.4, 0.6, 0.07);
  }
  function updateSwings(dt) {
    var FX = window.GT_FX, list = FX && FX.swings ? FX.swings() : [], live = new Set();
    var p = rig.pitch, y = yawNow(), up = [-Math.sin(p) * Math.sin(y), Math.cos(p), -Math.sin(p) * Math.cos(y)];
    list.forEach(function (e) {
      live.add(e);
      var s = swings.get(e);
      var dx = e.tile.x + 0.5 - pt.x, dz = e.tile.y + 0.5 - pt.y, dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
      if (!s) {
        // wind up on the side away from the camera, so the axe rises behind the shoulder instead of hanging toward us
        var lx = dz, lz = -dx, away = lx * -Math.sin(y) + lz * -Math.cos(y);
        s = { axe: (e.kind === 'mine' ? pickModel : axeModel)(away > 0.05 ? -1 : 1), burst: false }; scene.add(s.axe); swings.set(e, s);
      }
      // the grip: half way up the leaning card, a little toward the target, i.e. where the sprite's hand is drawn
      s.axe.position.set(pt.x + up[0] * 0.5 + dx * 0.12, up[1] * 0.5, pt.y + up[2] * 0.5 + dz * 0.12);
      s.axe.rotation.set(0, Math.atan2(dx, dz), 0);
      s.axe.userData.tilt.rotation.x = 0.7; // a diagonal chop: from level at the side to down-forward into the trunk
      var k = Math.min(1, e.t / FX.HIT), ease = 1 - Math.pow(1 - k, 3);
      s.axe.userData.arm.rotation.y = s.axe.userData.side * (-1.9 + 2.35 * ease); // from beside and behind, through the target
      s.axe.visible = e.t < FX.DUR * 0.85;
      if (e.t >= FX.HIT && !s.burst) { s.burst = true; burst(e, dx, dz); }
    });
    swings.forEach(function (s, e) { if (!live.has(e)) { GT3.dispose(s.axe); swings.delete(e); } });
    for (var i = bits.length - 1; i >= 0; i--) {
      var b = bits[i]; b.life -= dt;
      if (b.life <= 0 || b.m.position.y < 0) { scene.remove(b.m); b.m.material.dispose(); bits.splice(i, 1); continue; }
      b.v.y -= b.g * dt; b.m.position.addScaledVector(b.v, dt);
      b.m.rotation.x += b.spin * dt; b.m.rotation.y += b.spin * dt * 0.7;
    }
  }

  /* ---------------------------------------------------------------- riding the carousel (ride.js sets GT_RIDE.on)
     The player's card sits on the first horse, which turns with the ride (fun.js: spin.rotation.y = t * 0.55, horse 0
     at radius 1.05, bobbing sin(t * 2.2) * 0.14), and the camera drops low and slowly circles the ride, looking at
     the rider: a cinematic shot. Only the picture changes; the player still stands on their tile for the game. */
  // a warm light that rides with the player, so the ride reads bright at any hour
  var rideLamp = null;
  /* ---------------------------------------------------------------- fishing rods (three/rod.js)
     Every character with e.fish (the player: fishing.js; others: their presence report, players.js) holds a 3D rod
     with its line and float on the water tile they cast to. Outdoors only. */
  var rods = new Map();
  function updateRods(o, now) {
    var want = {};
    if (!o.house && GT3.Rod) o.ents.forEach(function (e) {
      var f = e.fish, key = e.me ? 'me' : (e.n || e.id);
      if (!f || !key || e.px == null || e.hidden) return;
      var r = rods.get(key);
      if (!r) { r = GT3.Rod(); scene.add(r.group); rods.set(key, r); }
      r.update({ x: mx(e.px / T + 0.5), z: mz(e.py / T + 0.5), dir: e.dir, phase: f.phase, fx: mx(f.x + 0.5), fz: mz(f.y + 0.5), hold: !!f.hold, t: f.t }, now / 1000);
      want[key] = 1;
    });
    rods.forEach(function (r, k) { if (!want[k]) { r.dispose(); rods.delete(k); } });
  }
  function rideLight(on) {
    if (!rideLamp) { if (!on) return; rideLamp = new THREE.PointLight(0xffe0b0, 0, 7, 1.2); scene.add(rideLamp); }
    rideLamp.intensity = on ? 2.2 + 5 * (sky ? sky.night : 0) : 0;
  }
  var rodeLast = false; // the figure was on the horse last frame: getting off puts it back on its feet once
  function rideShot(now) {
    var R = window.GT_RIDE, L = world && world.layout, car = L && L.fun && L.fun.carousel;
    if (!R || !R.on || !car) {
      if (rodeLast) { rodeLast = false; rideLight(false); var off = actors.get('me'); if (off) { off.actor.pose(0, 0, 1); off.sat = false; } }
      return;
    }
    rodeLast = true;
    rideLight(true);
    var t = now / 1000, th = t * 0.55, cx = car.x + 0.5, cz = car.y + 0.5;
    var hx = cx + Math.cos(th) * 1.05, hz = cz - Math.sin(th) * 1.05, bob = Math.sin(t * 2.2) * 0.14;
    var me = actors.get('me');
    if (me) { me.actor.set(hx, hz, 'down', 'sit'); me.actor.pose(0.62 + bob, 0, 1); me.actor.group.visible = true; }
    var ca = th * 0.4 + 0.9, r = 5.4;
    camera.position.set(cx + Math.sin(ca) * r, 1.45, cz + Math.cos(ca) * r);
    camera.lookAt(hx, 0.95 + bob, hz);
    if (rideLamp) rideLamp.position.set(hx + Math.sin(ca) * 1.4, 2.2, hz + Math.cos(ca) * 1.4); // from the camera's side
  }

  /* ---------------------------------------------------------------- dropping into the world (after the character screen)
     The player's own 3D card falls from high above, speeding up and spinning twice, lands on their tile with a squash and
     a ring of dust. Being the real sprite, it is lit like the world at that hour and lands exactly where the player is. */
  /* ---------------------------------------------------------------- felled trees (server: state.stumps)
     A tree chopped to its last charge is a stump until it refills, then grows back by stages (nature.js): stump for the
     first third, a sapling, a young tree, grown and choppable again. The moment it is felled near the player, its top
     tips over away from them, lands and fades. msLeft counts down locally from when the state arrived. */
  var stumpSt = null, stumpAt = 0, stumpSynced = false;
  function syncStumps(now) {
    var C = window.GT_CHAIN, st = C && C.state && C.state.st, nat = world && world.nature;
    if (!nat || !nat.stage) return;
    if (st && st !== stumpSt) { stumpSt = st; stumpAt = now; }
    var list = (stumpSt && stumpSt.stumps) || [], want = {};
    list.forEach(function (s) { var left = s.msLeft - (now - stumpAt); if (left > 0) want[s.x + ',' + s.y] = 1 - left / s.msTotal; });
    nat.trees.forEach(function (tr) {
      var p = want[tr.item.tx + ',' + tr.item.ty];
      var name = p == null ? 'full' : p < 0.34 ? 'stump' : p < 0.67 ? 'sapling' : 'young';
      if (name === (tr.stage || 'full')) return;
      var was = tr.stage || 'full', dx = tr.item.x - pt.x, dz = tr.item.z - pt.y;
      nat.stage(tr, name);
      if (name === 'stump' && was === 'full' && stumpSynced && Math.hypot(dx, dz) < 14) {
        nat.fell(tr, dx, dz); // falls away from the player
        var k = 1 - 0.6 * sky.night;
        for (var i = 0; i < 6; i++) bit(new THREE.Color(i % 2 ? '#48a046' : '#86c85a').multiplyScalar(k), tr.item.x + (Math.random() - 0.5), 1.4 + Math.random() * 0.5, tr.item.z + (Math.random() - 0.5), (Math.random() - 0.5) * 0.8, -0.3, (Math.random() - 0.5) * 0.8, 1.2, 0.6, 0.07);
      }
    });
    if (stumpSt) stumpSynced = true;
  }

  /* ---------------------------------------------------------------- walking into a building, with no cut
     Rooms are bigger than their buildings (a 3 x 3 house holds a 10 x 8 room), so the room cannot just sit under the
     roof. The engine changes the scene at once (engine.js doorTransition) and the view unfolds it, in UNFOLD_MS:
       - the building's roof and walls fade out over the first 45%, then it is hidden while you are inside;
       - the room grows out of the door: its doormat stays on the building's door tile while it scales from the
         building's size to its own, fading in early;
       - four mist sheets just above the room's walls close in round it and the village fades away behind them
         (their opening moves toward the camera by the walls' height over tan(pitch), so it frames the room on screen).
     Walking out plays it backwards. Inside, positions are the room's tiles, mapped into the world by `cur`. With
     "Kurangi animasi" or prefers-reduced-motion the change is instant. */
  var UNFOLD_MS = 700, MIST_Y = 1.75, rooms = new Map(), unfold = { p: 0, want: 0, rec: null }, cur = null, mist = null, lamp = null, mistCol = null;
  function setupUnfold() {
    lamp = new THREE.PointLight(0xffd8a0, 0, 16, 1.4); scene.add(lamp);
    // drawn over the world (no depth test): roofs, trees and lamps taller than the sheets never poke through it
    var mat = new THREE.MeshBasicMaterial({ color: 0x1b1d33, transparent: true, opacity: 0, depthWrite: false, depthTest: false, fog: false });
    mist = { mat: mat, planes: [] };
    for (var i = 0; i < 4; i++) { var q = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat); q.rotation.x = -Math.PI / 2; q.renderOrder = 50; q.visible = false; scene.add(q); mist.planes.push(q); }
    mistCol = new THREE.Color();
  }
  function reducedMotion() {
    if (document.documentElement.classList.contains('gt-reduced-motion')) return true;
    try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }
  function smooth(a, b, x) { var t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
  function setAlpha(mats, a) {
    mats.forEach(function (m) { var see = a < 0.999; if (m.transparent !== see) { m.transparent = see; m.needsUpdate = true; } m.opacity = a; m.depthWrite = !see; });
  }
  function roomFor(o) {
    var rec = rooms.get(o.key);
    if (rec && rec.map === o.map) return rec;
    if (rec) { rec.room.dispose(); scene.remove(rec.outer); }
    var b = o.house, m = o.map, room = GT3.Room(m, b), outer = new THREE.Group();
    var lx = m.mat.x + 0.5, lz = m.h - 0.5;
    room.group.position.set(-lx, 0, -lz); outer.add(room.group); outer.position.set(b.dx + 0.5, 0, b.dy + 0.5); outer.visible = false;
    scene.add(outer);
    var s0 = Math.min(1, Math.min((b.w || 3) / m.w, (b.h || 3) / m.h));
    rec = { map: m, b: b, room: room, outer: outer, lx: lx, lz: lz, ax: b.dx + 0.5, az: b.dy + 0.5, s: s0, s0: s0, g: null };
    rooms.set(o.key, rec);
    return rec;
  }
  function buildingOf(b) {
    var g = null;
    if (world) world.buildings.forEach(function (x) { var u = x.userData.building; if (u.dx === b.dx && u.dy === b.dy) g = x; });
    return g;
  }
  // scene tiles -> world: indoors through the room's place and scale, outdoors unchanged
  function mx(x) { return cur ? cur.ax + (x - cur.lx) * cur.s : x; }
  function mz(z) { return cur ? cur.az + (z - cur.lz) * cur.s : z; }
  function updateUnfold(o, dt) {
    var rec = o.house ? roomFor(o) : null;
    if (rec && unfold.rec !== rec) {
      if (unfold.rec) finishUnfold(unfold.rec);
      unfold.rec = rec; rec.g = buildingOf(rec.b);
    }
    unfold.want = rec ? 1 : 0;
    var r = unfold.rec;
    if (!r) { cur = null; return false; }
    if (reducedMotion() || snapNext) unfold.p = unfold.want;
    else unfold.p = unfold.want ? Math.min(1, unfold.p + dt * 1000 / UNFOLD_MS) : Math.max(0, unfold.p - dt * 1000 / UNFOLD_MS);
    var P = unfold.p;
    if (P <= 0 && !unfold.want) { finishUnfold(r); unfold.rec = null; cur = null; return false; }
    r.s = r.s0 + (1 - r.s0) * smooth(0.15, 1, P);
    r.outer.scale.setScalar(r.s); r.outer.visible = true;
    setAlpha(r.room.mats, smooth(0.05, 0.4, P));
    r.room.glow(sky.night);
    if (r.g) { var a = 1 - smooth(0, 0.45, P); setAlpha(r.g.userData.mats, a); r.g.visible = a > 0.01; }
    // the mist: an opening the size of the room (plus a margin), moved toward the camera, sheets on its four sides
    var k = smooth(0.2, 0.9, P), y = yawNow(), off = MIST_Y / Math.tan(rig.pitch), M = 0.5, BIG = 220;
    var x0 = r.ax - r.lx * r.s - M + Math.sin(y) * off, x1 = r.ax + (r.room.w - r.lx) * r.s + M + Math.sin(y) * off;
    var z0 = r.az - r.lz * r.s - M + Math.cos(y) * off, z1 = r.az + (r.room.h - r.lz) * r.s + M + Math.cos(y) * off;
    var sheets = [[x0 - BIG / 2, (z0 + z1) / 2, BIG, BIG * 2], [x1 + BIG / 2, (z0 + z1) / 2, BIG, BIG * 2], [(x0 + x1) / 2, z0 - BIG / 2, x1 - x0, BIG], [(x0 + x1) / 2, z1 + BIG / 2, x1 - x0, BIG]];
    mist.planes.forEach(function (q, i) { var d = sheets[i]; q.position.set(d[0], MIST_Y, d[1]); q.scale.set(d[2], d[3], 1); q.visible = k > 0.001; });
    mistCol.set('#14152a').lerp(scene.background, 0.35);
    mist.mat.color.copy(mistCol); mist.mat.opacity = k;
    // the room is bigger than its building, so neighbours (the Town Hall, trees) stand inside its footprint: the village
    // goes once the mist is half drawn, so they never show through the room; the sky colour turns into the mist
    var gone = k > 0.5;
    world.group.visible = !gone; if (gtex) gtex.userData.mesh.visible = !gone; if (mtex) mtex.userData.mesh.visible = !gone && mAny;
    if (k > 0) { scene.background.lerp(mistCol, k); scene.fog.color.copy(scene.background); }
    lamp.position.set(r.ax + (r.room.w / 2 - r.lx) * r.s, 1.5 * r.s, r.az + (r.room.h / 2 - r.lz) * r.s);
    lamp.intensity = (2.5 + 9 * sky.night) * smooth(0.3, 1, P);
    cur = o.house ? r : null;
    return true;
  }
  function finishUnfold(r) {
    r.outer.visible = false;
    if (r.g) { setAlpha(r.g.userData.mats, 1); r.g.visible = true; }
    mist.planes.forEach(function (q) { q.visible = false; }); mist.mat.opacity = 0;
    if (world) world.group.visible = true; if (gtex) gtex.userData.mesh.visible = true; if (mtex) mtex.userData.mesh.visible = mAny;
    lamp.intensity = 0;
  }

  /* ---------------------------------------------------------------- night monsters: chain.js says where (the server's
     list, wandering), here each is a model (three/monsters.js) that faces the player and trots or flaps */
  var beasts = new Map();
  function updateMonsters(now) {
    var list = (window.GT_CHAIN && GT_CHAIN.monsters && !cur) ? GT_CHAIN.monsters() : [], seen = {}, t = now / 1000;
    list.forEach(function (m) {
      var b = beasts.get(m.id);
      if (b && b.kind !== m.kind) { b.dispose(); b = null; }
      if (!b) { b = GT3.Monster(m.kind); scene.add(b.group); beasts.set(m.id, b); }
      b.set(m.x + 0.5, m.y + 0.5, t + (m.x * 7 + m.y * 3), Math.atan2(m.fx, m.fy));
      seen[m.id] = 1;
    });
    beasts.forEach(function (b, id) { if (!seen[id]) { b.dispose(); beasts.delete(id); } });
  }

  var drop = null;
  function updateDrop(now) {
    var a = actors.get('me');
    if (!drop || !a) return;
    var t = Math.min(1, (now - drop.t0) / drop.ms), lift = 0, spin = 0, sq = 1;
    if (t < 0.7) { var u = t / 0.7; lift = 7 * (1 - u * u); spin = u * Math.PI * 4; }
    else {
      var v = (t - 0.7) / 0.3; sq = v < 0.45 ? 1 - Math.sin(v / 0.45 * Math.PI) * 0.22 : 1;
      if (!drop.dusted) {
        drop.dusted = true;
        var k = 1 - 0.65 * sky.night, c = new THREE.Color('#d8d0bc').multiplyScalar(k);
        for (var i = 0; i < 12; i++) { var ang = i / 12 * Math.PI * 2; bit(c, pt.x + Math.cos(ang) * 0.2, 0.06, pt.y + Math.sin(ang) * 0.2, Math.cos(ang) * 1.3, 0.7, Math.sin(ang) * 1.3, 0.45, 2.5, 0.09); }
      }
    }
    a.actor.pose(lift, spin, sq);
    if (t >= 1) { a.actor.pose(0, 0, 1); var done = drop.done; drop = null; if (done) done(); }
  }

  var api = {
    ready: function () { return ok && mode === '3d' && !!(GT.world && GT.world.layout); },
    idle: function () { hide(); last = 0; },
    groundCtx: function (m) {
      ensureWorld(m);
      var now = performance.now();
      if (now - gAt < 120) return null; // crops and ripples change slowly: ~8 uploads a second
      gAt = now; gtex.needsUpdate = true; mDue = true;
      return gctx;
    },
    /** The unlit marks sheet, on the same beat as groundCtx (null between beats); then marksDone(drew). */
    marksCtx: function () { if (!mDue || !mctx) return null; mDue = false; return mctx; },
    marksDone: function (drew) {
      if (!mtex) return;
      if (drew || mAny) mtex.needsUpdate = true; // empty now and before: the cleared sheet needs no upload
      mAny = !!drew; mtex.userData.mesh.visible = mAny && !!(gtex && gtex.userData.mesh.visible);
    },
    draw: function (o) {
      ensureWorld(o.out || o.map);
      document.documentElement.classList.add('gt-3d'); cv.style.display = 'block'; syncUi();
      size(o);
      var now = performance.now(), dt = last ? Math.min(0.1, (now - last) / 1000) : 0.016; last = now;
      var season = GT.season(), snowy = !!(window.SPRITES && SPRITES.snow), sk = season + (snowy ? '*' : '');
      if (sk !== seasonKey) { seasonKey = sk; world.setSeason(season, snowy); }
      var seen = new Set(), dtU = last0 ? Math.min(0.1, (now - last0) / 1000) : 0.016; last0 = now;
      var unfolding = false;
      cur = null;
      if (o.house) cur = roomFor(o); // the mapping for this frame's entities (its scale is last frame's, a frame behind)
      o.ents.forEach(function (e) {
        if (e.px == null) return;
        var key = e.me ? 'me' : (e.n || e.id); if (!key) return;
        var a = actors.get(key);
        if (a && a.pal !== e.pal) { a.actor.dispose(); a = null; }
        if (!a) { a = { actor: GT3.Actor(e.pal | 0), pal: e.pal }; scene.add(a.actor.group); actors.set(key, a); }
        var x = mx(e.px / T + 0.5), z = mz(e.py / T + 0.5);
        // sitting: standing still on a bench (village v2) lowers the sprite onto the seat, facing out
        var tm = o.house ? o.map : (o.out || o.map), tx = Math.floor(e.px / T + 0.5), ty = Math.floor(e.py / T + 0.5);
        // (or on a chair indoors: the engine puts the player on the chair tile and says so with e.sit)
        var onChair = !!e.sit, sit = onChair || (!(e.step | 0) && tm.tiles && tm.tiles[ty * tm.w + tx] === 'bench');
        a.actor.set(x, z, sit ? screenDir(onChair ? (e.dir || 'down') : 'down') : screenDir(e.dir || 'down'), sit ? 'sit' : e.step | 0); a.outdoor = !o.house;
        if (!(e.me && drop)) { if (sit) a.actor.pose((onChair ? 0.35 : 0.41) - 3 * GT3.PX, 0, 1); else if (a.sat) a.actor.pose(0, 0, 1); }
        a.sat = sit;
        a.actor.group.visible = !e.hidden; // the character screen's throw is drawing the player until it lands
        seen.add(key);
        if (e.me) { pt.x = x; pt.y = z; }
      });
      updateRods(o, now);
      // walking in, the people outside stay where they were until the mist has closed over them (then they go)
      var keepOut = !!o.house && unfold.p < 1 && world.group.visible;
      actors.forEach(function (a, k) { if (!seen.has(k) && !(keepOut && a.outdoor)) { a.actor.dispose(); actors.delete(k); } });
      rig.follow(pt.x, pt.y, dt);
      if (snapNext || Math.hypot(rig.target.x - pt.x, rig.target.z - pt.y) > 8) { rig.snap(); snapNext = false; } // a new world or a long jump: no glide across the map
      rideShot(now);
      sky.set(o.hour, season); sky.follow(pt.x, pt.y);
      world.update(now / 1000, o.hour, sky.night);
      syncStumps(now); world.nature.tick(dt);
      unfolding = updateUnfold(o, dtU);
      if (!unfolding) see.update(pt.x, pt.y, dt, camera); // the building being walked into is the unfold's to fade
      actors.forEach(function (a) { a.actor.face(camera); });
      if (world.face) world.face(camera);
      updateDrop(now);
      updateMonsters(now);
      updateSwings(dt);
      renderer.render(scene, camera);
      if (!booted) { booted = true; if (window.GT_BOOT) GT_BOOT.set(0.95, GT_BOOT.zh ? 'Menyalakan matahari…' : 'Lighting the world…'); setTimeout(bootDone, 350); }
      return toScreen(pt.x, pt.y, 0);
    },
    toScreen: function (x, z, l) { return toScreen(mx(x), mz(z), l); },
    worldDir: worldDir,
    rooms: true, // the engine keeps the 2.5D view indoors: rooms unfold out of their buildings (doorTransition)
    unfoldMs: function () { return reducedMotion() ? 0 : UNFOLD_MS; },
    // a walk on screen axes to the world, by the camera's turn (the lab's walk)
    screenToWorld: function (ix, iz) { var c = Math.cos(yawWant), s = Math.sin(yawWant); return { x: ix * c + iz * s, y: -ix * s + iz * c }; },
    tookClick: function () { return performance.now() - took < 400; },
    // device px per art px at the player's depth: one tile up the card is 12 art px
    artScale: function (S) { var a = toScreen(pt.x, pt.y, 0), b = toScreen(pt.x, pt.y, 1); return Math.max(1, Math.hypot(a.x - b.x, a.y - b.y) * S / T); },
    pick: function (clientX, clientY) {
      var r = cv.getBoundingClientRect(); if (!r.width) return null;
      ndc.set((clientX - r.left) / r.width * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      if (!ray.ray.intersectPlane(plane, hit)) return null;
      if (cur) return { x: Math.floor(cur.lx + (hit.x - cur.ax) / cur.s), y: Math.floor(cur.lz + (hit.z - cur.az) / cur.s) };
      return { x: Math.floor(hit.x), y: Math.floor(hit.z) };
    },
    playerTile: function () { return cur ? { x: cur.lx + (pt.x - cur.ax) / cur.s, y: cur.lz + (pt.y - cur.az) / cur.s } : { x: pt.x, y: pt.y }; }
  };

  window.GT_VIEW3D = {
    get: function () { return mode; },
    set: function (v) {
      mode = v === '3d' ? '3d' : '2d';
      try { localStorage.setItem(LS, mode); } catch (e) { /* storage blocked */ }
      if (mode === '3d') { failed = false; if (ok) GT.setView3d(api); else start(); }
      else { GT.setView3d(null); hide(); }
    },
    toScreen: function (x, z, l) { return toScreen(mx(x), mz(z), l); },
    playerTile: function () { return api.playerTile(); },
    turn: turn,
    // drop the player's own 3D sprite into the world over `ms`, then call done (charscreen.js); false when not drawing
    dropIn: function (ms, done) { if (!GT.view3dOn || !GT.view3dOn()) return false; drop = { t0: performance.now(), ms: ms, done: done, dusted: false }; return true; },
    tookClick: function () { return api.tookClick(); },
    // the lab's keys while the 2.5D view shows (settings.js asks first): Q / E turn, + / - zoom
    onKey: function (e) {
      if (!GT.view3dOn || !GT.view3dOn()) return false;
      var c = e.code, k = c === 'KeyQ' ? 1 : c === 'KeyE' ? -1 : 0, z = c === 'Equal' || c === 'NumpadAdd' ? 1.2 : c === 'Minus' || c === 'NumpadSubtract' ? 1 / 1.2 : 0;
      if (!k && !z) return false;
      if (e.type === 'keydown' && !e.repeat && !GT.isUiOpen()) { if (k) turn(k); else zoom = rig.zoom(zoom * z); }
      return true;
    }
  };
  function bootDone() { if (window.GT_BOOT) GT_BOOT.done(); }
  // the 2D view is ready as soon as the engine is; the 2.5D view ends the boot screen on its first drawn frame (draw)
  GT.register({ id: 'view3d', init: function () { if (mode === '3d') start(); else setTimeout(bootDone, 300); } });
})();
