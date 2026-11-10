/*
 * r3d/fx.js - GT.fx3d, the effects the mods used to draw on the flat 2D overlay, as real 3D (or crisp HTML for text):
 *   label(key, X, Y, h, text, opts)   a text tag at map pixel (X, Y) standing h pixels above the ground; call it every frame
 *                                     you want it shown (it disappears when you stop). Name tags, timers, "+n" stacks.
 *   text(tx, ty, str, color)          a number or word that rises from a tile and fades (+1 Kayu).
 *   burst(tx, ty, kind, dir, hit)     particles: 'chop' wood chips and leaves, 'spark', 'poof'.
 *   flash(tx, ty, color)              a short light on a tile.
 *   monsters(list)                    night monsters, [{id, kind:'boar'|'bat', x, y}] in (fractional) tiles, every frame.
 *   stall3d(marks)                    the Titip Jual counter and the Papan Juara board.
 *   crops(list)                       the farm plots' soil, shoots and wheat, [{x, y, state, grown, wet}]; spots(list): fishing spots [{x, y, h}].
 * Fishing (rod, line, float, rings, the "!") is drawn here too, straight from GT_FISH's state.
 * Mods call these only while the 3D view is on (GT.view === '3d' && GT.fx3d); the 2D view still uses its own drawing.
 */
(function () {
  'use strict';
  var R3D = window.R3D = window.R3D || {};
  var THREE = window.THREE, GT = window.GT;
  if (!THREE || !R3D.geo) return;
  var Builder = R3D.geo.Builder, hash = R3D.geo.hash;

  var T = 12, WL = -0.15, layer = null, rect = null, frame = 0, lastT = 0, scene = null, C0 = null;
  var labels = new Map(), floats = [], flashes = [], mons = new Map(), api = null;
  var MAXP = 200, pm = null, parts = [], tmpM = new THREE.Matrix4(), tmpC = new THREE.Color(), tmpP = new THREE.Vector3(), tmpS = new THREE.Vector3(), tmpQ = new THREE.Quaternion();
  var fish = null, stallKey = '', stallGroup = null, stallLits = null, monMat = null;
  var DIRV = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

  function screenOf(X, Y, h) {
    var q = R3D.mapToScreen ? R3D.mapToScreen(X, Y, h) : null;
    return q ? { x: q.x - rect.left, y: q.y - rect.top } : null;
  }
  function place(el, X, Y, h) {
    var s = screenOf(X, Y, h);
    if (!s) { el.style.display = 'none'; return; }
    el.style.display = ''; el.style.transform = 'translate(' + Math.round(s.x) + 'px,' + Math.round(s.y) + 'px) translate(-50%,-100%)';
  }

  /* ---------------------------------------------------------------- labels and rising text (HTML: crisp at any zoom) */
  function label(key, X, Y, h, text, o) {
    if (!layer || !rect) return;
    o = o || {};
    var e = labels.get(key);
    if (!e) { e = { el: document.createElement('div'), text: null, cls: '' }; layer.appendChild(e.el); labels.set(key, e); }
    var cls = 'gt-fxl' + (o.plain ? ' plain' : '') + (o.big ? ' big' : '') + (o.light ? ' light' : '');
    if (e.cls !== cls) { e.el.className = cls; e.cls = cls; }
    if (e.text !== text) { e.el.textContent = text; e.text = text; }
    e.el.style.color = o.color || ''; e.el.style.opacity = o.alpha == null ? '' : String(o.alpha);
    e.seen = frame;
    place(e.el, X, Y, h || 0);
  }
  function text(tx, ty, str, color) {
    if (!layer) return;
    var el = document.createElement('div'); el.className = 'gt-fxl plain float'; el.textContent = str; el.style.color = color || '#ffffff'; layer.appendChild(el);
    floats.push({ el: el, X: (tx + 0.5) * T, Y: (ty + 0.5) * T, t: 0 });
  }

  /* ---------------------------------------------------------------- particles (one instanced mesh) */
  function emit(x, y, z, vx, vy, vz, g, life, size, hex, grow) {
    var p = null, i;
    for (i = 0; i < MAXP; i++) if (!parts[i] || parts[i].life <= 0) { p = parts[i] = parts[i] || {}; p.i = i; break; }
    if (!p) return;
    p.x = x; p.y = y; p.z = z; p.vx = vx; p.vy = vy; p.vz = vz; p.g = g; p.life = life; p.max = life; p.size = size; p.grow = grow || 0;
    pm.setColorAt(p.i, tmpC.set(hex)); pm.instanceColor.needsUpdate = true;
  }
  function burst(tx, ty, kind, dir, hit) {
    if (!pm) return;
    var d = DIRV[dir] || [0, 1], cx = tx + 0.5, cz = ty + 0.5, i, a, v;
    if (kind === 'spark') {
      if (hit === false) return;
      for (i = 0; i < 9; i++) { a = (Math.random() - 0.5) * 1.8; v = 2.5 + Math.random() * 3; emit(cx, 0.9, cz, (d[0] * Math.cos(a) - d[1] * Math.sin(a)) * v, 1 + Math.random() * 2.5, (d[0] * Math.sin(a) + d[1] * Math.cos(a)) * v, 7, 0.35 + Math.random() * 0.2, 0.07, Math.random() < 0.5 ? '#fff6c8' : '#ffd84a'); }
      return;
    }
    if (kind === 'poof') {
      for (i = 0; i < 10; i++) { a = Math.random() * 6.28; v = 0.8 + Math.random() * 1.4; emit(cx, 0.4, cz, Math.cos(a) * v, 0.6 + Math.random(), Math.sin(a) * v, -0.4, 0.55 + Math.random() * 0.2, 0.13, Math.random() < 0.5 ? '#f4f1e6' : '#cfd3dc', 0.4); }
      return;
    }
    // chop: chips thrown back toward the player, leaves shaken loose
    for (i = 0; i < 8; i++) { a = (Math.random() - 0.5) * 1.5; v = 1.5 + Math.random() * 2; emit(cx, 0.8, cz, (-d[0] * Math.cos(a) + d[1] * Math.sin(a)) * v, 2 + Math.random() * 2.2, (-d[0] * Math.sin(a) - d[1] * Math.cos(a)) * v, 10, 0.5 + Math.random() * 0.25, 0.07 + Math.random() * 0.04, Math.random() < 0.5 ? '#c08848' : '#8e5a30'); }
    for (i = 0; i < 5; i++) emit(cx + (Math.random() - 0.5) * 0.9, 1.9 + Math.random() * 0.6, cz + (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.8, -0.3, (Math.random() - 0.5) * 0.8, 0.9, 0.9 + Math.random() * 0.4, 0.06, Math.random() < 0.5 ? '#58a850' : '#3f8a3a');
  }
  function flash(tx, ty, color) {
    if (!scene) return;
    var m = new THREE.Mesh(flashGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(color && /^#/.test(color) ? color : '#ffffff'), transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending }));
    m.position.set(tx + 0.5, 0.04, ty + 0.5); m.rotation.x = -Math.PI / 2; m.renderOrder = 3; scene.add(m);
    flashes.push({ mesh: m, t: 0 });
  }
  var flashGeo = null;

  /* ---------------------------------------------------------------- fishing: rod tip, line, float, rings, the "!" */
  function ensureFish(C) {
    if (fish) return fish;
    var bobber = new THREE.Group();
    var top = new THREE.Mesh(new THREE.SphereGeometry(0.085, 8, 6), new THREE.MeshBasicMaterial({ color: 0xe8503c }));
    var bot = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.1, 6), new THREE.MeshBasicMaterial({ color: 0xf4f4ec })); bot.position.y = -0.1;
    bobber.add(top); bobber.add(bot);
    var lineGeo = new THREE.BufferGeometry(); lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(17 * 3), 3));
    var line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xf4f4e8, transparent: true, opacity: 0.9 })); line.frustumCulled = false;
    var rings = [0, 1].map(function () { var r = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 24), new THREE.MeshBasicMaterial({ color: 0xe8f8f6, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide })); r.rotation.x = -Math.PI / 2; r.renderOrder = 3; return r; });
    fish = { bobber: bobber, line: line, rings: rings, root: new THREE.Group() };
    fish.root.add(bobber); fish.root.add(line); rings.forEach(function (r) { fish.root.add(r); });
    fish.root.visible = false; C.root.add(fish.root);
    return fish;
  }
  function updateFishing(C, info, t) {
    var F = window.GT_FISH && GT_FISH._state && GT_FISH._state();
    var fo = ensureFish(C);
    if (!F || !R3D.actors || !R3D.actors.playerRig) { fo.root.visible = false; return; }
    var rig = R3D.actors.playerRig(); if (!rig || !rig.rodTip) { fo.root.visible = false; return; }
    rig.root.updateMatrixWorld(true);
    var tip = rig.rodTip.getWorldPosition(new THREE.Vector3());
    var tx = F.tile.x + 0.5, tz = F.tile.y + 0.5, ty = WL + 0.06, k = 1, b = new THREE.Vector3(tx, ty, tz);
    if (F.phase === 'cast') { k = Math.min(1, F.t / 0.45); b.set(tip.x + (tx - tip.x) * k, tip.y + (ty - tip.y) * k + Math.sin(k * Math.PI) * 1.3, tip.z + (tz - tip.z) * k); }
    else if (F.phase === 'wait') b.y += Math.sin(t * 4) * 0.03;
    else if (F.phase === 'bite') b.y -= 0.07;
    else if (F.phase === 'reel') { b.x += Math.sin(t * 9) * 0.07; b.y -= 0.02; }
    fo.root.visible = true;
    fo.bobber.position.copy(b);
    var arr = fo.line.geometry.attributes.position.array, n = 17, sag = F.phase === 'reel' ? 0.15 : 0.5, i;
    for (i = 0; i < n; i++) {
      var s = i / (n - 1);
      arr[i * 3] = tip.x + (b.x - tip.x) * s; arr[i * 3 + 1] = tip.y + (b.y - tip.y) * s - Math.sin(s * Math.PI) * sag * (k < 1 ? 0.3 : 1); arr[i * 3 + 2] = tip.z + (b.z - tip.z) * s;
    }
    fo.line.geometry.attributes.position.needsUpdate = true;
    var splash = F.phase === 'bite' || F.phase === 'reel';
    fo.rings.forEach(function (r, j) {
      if (!splash) { r.material.opacity = 0; return; }
      var ph = (t * 1.6 + j * 0.5) % 1; r.position.set(b.x, WL + 0.03, b.z); r.scale.setScalar(0.2 + ph * 0.7); r.material.opacity = 0.9 * (1 - ph);
    });
    if (F.phase === 'bite') label('fish!', info.player.pos.px + 6, info.player.pos.py + 6, 20 + Math.round(Math.sin(t * 20)), '!', { big: true, plain: true, color: '#ffd84a' });
  }

  /* ---------------------------------------------------------------- night monsters */
  function buildMonster(kind) {
    var B = R3D.rig.acc(), g = new THREE.Group(), H = Math.PI / 2;
    if (kind === 'bat') {
      B.sph(0, 0.1, 0, 0.17, 0.15, 0.19, '#3a2f4a');
      B.sph(-0.07, 0.15, 0.15, 0.03, 0.03, 0.02, '#ff5a5a'); B.sph(0.07, 0.15, 0.15, 0.03, 0.03, 0.02, '#ff5a5a');
      B.cone(-0.09, 0.27, 0.0, 0.05, 0.14, '#2a2236'); B.cone(0.09, 0.27, 0.0, 0.05, 0.14, '#2a2236');
      B.sph(0, 0.05, 0.19, 0.04, 0.025, 0.04, '#e8d8f0');
      g.add(B.mesh(monMat));
      var W = R3D.rig.acc(); W.sph(0.27, 0, 0, 0.3, 0.025, 0.15, '#2a2236'); W.sph(0.4, 0, -0.1, 0.17, 0.02, 0.08, '#3a2f4a');
      var wl = new THREE.Group(), wr = new THREE.Group(), ml = W.mesh(monMat), mr = W.mesh(monMat); mr.scale.x = -1;
      wl.add(ml); wr.add(mr); wl.position.set(0.12, 0.12, 0); wr.position.set(-0.12, 0.12, 0); g.add(wl); g.add(wr); g.userData.wings = [wl, wr];
      g.userData.hover = 1.1;
    } else { // wild boar: a round barrel body, a heavy head with a snout and tusks
      B.cap(0, 0.4, -0.02, 0.26, 0.3, '#5a3a24', H, 0, 0);
      B.sph(0, 0.44, -0.18, 0.28, 0.27, 0.26, '#6e4a2e');
      B.sph(0, 0.4, 0.4, 0.22, 0.21, 0.24, '#6e4a2e');
      B.cap(0, 0.35, 0.6, 0.095, 0.05, '#c9a27a', H, 0, 0);
      B.sph(0, 0.36, 0.7, 0.07, 0.06, 0.03, '#a8785a');
      B.sph(-0.1, 0.5, 0.56, 0.03, 0.03, 0.02, '#ff5a5a'); B.sph(0.1, 0.5, 0.56, 0.03, 0.03, 0.02, '#ff5a5a');
      B.cone(-0.12, 0.3, 0.6, 0.03, 0.14, '#f0f0e0', -0.4, 0, -0.5); B.cone(0.12, 0.3, 0.6, 0.03, 0.14, '#f0f0e0', -0.4, 0, 0.5);
      B.cone(-0.13, 0.65, 0.35, 0.07, 0.14, '#4a2e1c', 0, 0, -0.3); B.cone(0.13, 0.65, 0.35, 0.07, 0.14, '#4a2e1c', 0, 0, 0.3);
      for (var i = 0; i < 5; i++) B.cone(0, 0.66, -0.3 + i * 0.12, 0.05, 0.13, '#3a2414');
      [[-0.17, -0.22], [0.17, -0.22], [-0.17, 0.2], [0.17, 0.2]].forEach(function (p) { B.cap(p[0], 0.13, p[1], 0.06, 0.12, '#3a2414'); });
      B.cap(0, 0.5, -0.5, 0.025, 0.1, '#3a2414', -0.9, 0, 0);
      g.add(B.mesh(monMat, true)); g.userData.hover = 0;
    }
    return g;
  }
  function monsters(list) {
    if (!scene) return;
    for (var i = 0; i < list.length; i++) {
      var m = list[i], e = mons.get(m.id);
      if (!e || e.kind !== m.kind) { if (e) scene.remove(e.g); e = { g: buildMonster(m.kind), kind: m.kind, face: 0 }; mons.set(m.id, e); scene.add(e.g); }
      e.seen = frame; e.x = m.x; e.y = m.y;
    }
  }

  /* ---------------------------------------------------------------- crops on the farm plots, fishing spots */
  var cropKey = '', cropMesh = null, cropMat = null, spotsList = [], ringMesh = null, ringMat = null, RING_MAX = 240;
  function crops(list) {
    if (!scene) return;
    var key = list.map(function (p) { return p.x + ',' + p.y + p.state + (p.grown | 0) + (p.wet ? 'w' : ''); }).join(';');
    if (key === cropKey) return;
    cropKey = key;
    if (cropMesh) { scene.remove(cropMesh); cropMesh.geometry.dispose(); cropMesh = null; }
    if (!list.length) return;
    var B = R3D.rig.acc();
    list.forEach(function (p) {
      var cx = p.x + 0.5, cz = p.y + 0.5, i, h;
      if (p.state === 'empty') { B.sph(cx, 0.0, cz, 0.43, 0.05, 0.43, '#9a6a40'); for (i = 0; i < 3; i++) B.cyl(cx, 0.03, p.y + 0.22 + i * 0.28, 0.4, 0.02, 0.04, '#6e4628'); return; }
      B.sph(cx, 0.0, cz, 0.45, 0.05, 0.45, p.wet ? '#4a3020' : '#7a5232'); // a mound of soil, darker when watered
      for (i = 0; i < 3; i++) B.cyl(cx, 0.03, p.y + 0.22 + i * 0.28, 0.42, 0.02, 0.04, p.wet ? '#33200f' : '#5e3c20');
      var k = p.state === 'ready' ? 1 : Math.min(0.85, 0.22 + (p.grown || 0) * 0.2);
      for (i = 0; i < 9; i++) {
        var px = p.x + 0.16 + (i % 3) * 0.34, pz = p.y + 0.22 + Math.floor(i / 3) * 0.28, hh = hash(p.x * 9 + i, p.y * 7 + i, 5);
        h = (0.18 + 0.38 * k) * (0.85 + 0.3 * hh);
        if (p.state === 'ready') { // golden wheat with heavy ears
          B.cap(px, h / 2, pz, 0.016, h - 0.04, '#c9a64a', 0, 0, (hh - 0.5) * 0.25);
          B.cap(px + (hh - 0.5) * 0.06, h + 0.03, pz, 0.035, 0.1, '#f2d24a', 0, 0, (hh - 0.5) * 0.3);
          B.cone(px + (hh - 0.5) * 0.08, h + 0.14, pz, 0.02, 0.07, '#e8c038', 0, 0, 0);
        } else { // green shoots with leaves
          B.cap(px, h / 2, pz, 0.014, h - 0.03, '#3f9a3a', 0, 0, (hh - 0.5) * 0.2);
          B.sph(px - 0.04, h * 0.72, pz, 0.045 * (0.5 + k), 0.012, 0.025, '#7cc23e'); B.sph(px + 0.04, h * 0.5, pz, 0.045 * (0.5 + k), 0.012, 0.025, '#5fae36');
          B.sph(px, h + 0.01, pz, 0.03 * (0.6 + k), 0.025, 0.03 * (0.6 + k), '#8ed24a');
        }
      }
    });
    if (!cropMat) cropMat = R3D.geo.lit();
    cropMesh = B.mesh(cropMat); cropMesh.receiveShadow = true; cropMesh.userData.nopick = true; scene.add(cropMesh);
  }
  function spots(list) { spotsList = list || []; }
  function updateSpots(t) {
    if (!scene) return;
    if (!ringMesh) {
      ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
      ringMesh = new THREE.InstancedMesh(new THREE.RingGeometry(0.88, 1, 28).rotateX(-Math.PI / 2), ringMat, RING_MAX);
      ringMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); ringMesh.frustumCulled = false; ringMesh.userData.nopick = true; ringMesh.renderOrder = 3;
      ringMesh.setColorAt(0, tmpC.set('#ffffff')); scene.add(ringMesh);
    }
    var n = 0, i, k;
    for (i = 0; i < spotsList.length && n < RING_MAX - 3; i++) {
      var s = spotsList[i];
      for (k = 0; k < 3; k++) {
        var ph = (t * 0.5 + k / 3 + s.h) % 1, r = 0.08 + ph * 0.5;
        tmpP.set(s.x + 0.5, WL + 0.02, s.y + 0.5); tmpS.set(r, 1, r * 0.8); tmpM.compose(tmpP, tmpQ.identity(), tmpS); ringMesh.setMatrixAt(n, tmpM);
        var f = 0.75 * (1 - ph); tmpC.setRGB(f * 0.85, f, f); ringMesh.setColorAt(n, tmpC); n++;
      }
    }
    ringMesh.count = n; ringMesh.instanceMatrix.needsUpdate = true; if (ringMesh.instanceColor) ringMesh.instanceColor.needsUpdate = true;
  }

  /* ---------------------------------------------------------------- Titip Jual counter and Papan Juara board */
  function stall3d(m) {
    if (!scene || !m) return;
    var key = m.consign.x + ',' + m.consign.y + ',' + m.board.x + ',' + m.board.y;
    if (key === stallKey) return;
    stallKey = key;
    if (stallGroup) { scene.remove(stallGroup); stallGroup.traverse(function (o) { if (o.geometry) o.geometry.dispose(); }); }
    var B = new Builder(), x = m.consign.x, y = m.consign.y;
    B.box(x + 0.06, 0, y + 0.1, x + 0.94, 0.55, y + 0.9, '#6a4020', '#b8864a');
    B.box(x + 0.3, 0.55, y + 0.35, x + 0.7, 0.8, y + 0.65, '#e8c070', '#f0d080');
    for (var s = 0; s < 4; s++) { var xa = x + 0.04 + s * 0.23, c = B.col(s % 2 ? '#f6ead0' : '#c8503c', 1); B.quad([xa, 1.15, y + 0.95], [xa + 0.23, 1.15, y + 0.95], [xa + 0.23, 1.6, y + 0.3], [xa, 1.6, y + 0.3], c); B.quad([xa, 1.0, y + 0.95], [xa + 0.23, 1.0, y + 0.95], [xa + 0.23, 1.15, y + 0.95], [xa, 1.15, y + 0.95], c); }
    B.box(x + 0.04, 0, y + 0.9, x + 0.1, 1.15, y + 0.96, '#6a3f22'); B.box(x + 0.9, 0, y + 0.9, x + 0.96, 1.15, y + 0.96, '#6a3f22');
    var bx = m.board.x, by = m.board.y;
    B.box(bx + 0.14, 0, by + 0.45, bx + 0.2, 0.9, by + 0.55, '#6a4020'); B.box(bx + 0.8, 0, by + 0.45, bx + 0.86, 0.9, by + 0.55, '#6a4020');
    B.box(bx, 0.7, by + 0.42, bx + 1, 1.35, by + 0.58, '#3a2a40', '#f6ead0'); B.faceS(bx + 0.06, bx + 0.94, 0.75, 1.3, by + 0.585, '#f6ead0', 1);
    B.faceS(bx + 0.4, bx + 0.6, 0.85, 1.2, by + 0.59, '#e8b030', 1); B.faceS(bx + 0.28, bx + 0.72, 0.98, 1.08, by + 0.59, '#e8b030', 1);
    stallGroup = new THREE.Group(); stallGroup.add(B.mesh(stallLits || (stallLits = R3D.geo.lit()), true)); scene.add(stallGroup);
  }

  /* ---------------------------------------------------------------- module */
  R3D.fx = {
    init: function (C) {
      C0 = C; scene = C.root; T = (window.SPRITES && SPRITES.TILE) || 12;
      layer = document.getElementById('fx'); frame = 0; lastT = 0;
      pm = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAXP);
      pm.instanceMatrix.setUsage(THREE.DynamicDrawUsage); pm.frustumCulled = false; pm.setColorAt(0, tmpC.set('#ffffff')); pm.count = MAXP;
      tmpM.makeScale(0, 0, 0); for (var i = 0; i < MAXP; i++) pm.setMatrixAt(i, tmpM);
      C.scene.add(pm);
      flashGeo = new THREE.PlaneGeometry(1.1, 1.1);
      monMat = R3D.geo.lit();
      api = { label: label, text: text, burst: burst, flash: flash, monsters: monsters, stall3d: stall3d, crops: crops, spots: spots };
      GT.fx3d = api;
    },
    onWorld: function () { stallKey = ''; cropKey = ''; if (cropMesh) { scene.remove(cropMesh); cropMesh.geometry.dispose(); cropMesh = null; } },
    update: function (C, info) {
      frame++;
      var t = info.timeAcc, dt = lastT ? Math.min(0.05, Math.max(0, t - lastT)) : 0.016; lastT = t;
      rect = layer ? layer.getBoundingClientRect() : null;
      // stale labels go
      labels.forEach(function (e, k) { if (e.seen < frame - 1) { if (e.el.parentNode) e.el.parentNode.removeChild(e.el); labels.delete(k); } });
      var i;
      for (i = floats.length - 1; i >= 0; i--) {
        var f = floats[i]; f.t += dt;
        if (f.t > 1.1) { if (f.el.parentNode) f.el.parentNode.removeChild(f.el); floats.splice(i, 1); continue; }
        f.el.style.opacity = String(Math.max(0, 1 - f.t / 1.1)); if (rect) place(f.el, f.X, f.Y, 16 + f.t * 12);
      }
      // particles
      for (i = 0; i < parts.length; i++) {
        var p = parts[i]; if (!p || p.life <= 0) continue;
        p.life -= dt; if (p.life <= 0) { tmpM.makeScale(0, 0, 0); pm.setMatrixAt(i, tmpM); continue; }
        p.vy -= p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; if (p.y < 0.03 && p.g > 2) { p.y = 0.03; p.vy = 0; p.vx *= 0.6; p.vz *= 0.6; }
        var sz = p.size * (p.grow ? 1 + (1 - p.life / p.max) * 2.5 : Math.min(1, p.life / p.max * 3));
        tmpP.set(p.x, p.y, p.z); tmpS.set(sz, sz, sz); tmpM.compose(tmpP, tmpQ.identity(), tmpS); pm.setMatrixAt(i, tmpM);
      }
      pm.instanceMatrix.needsUpdate = true;
      for (i = flashes.length - 1; i >= 0; i--) {
        var fl = flashes[i]; fl.t += dt; fl.mesh.material.opacity = Math.max(0, 0.8 * (1 - fl.t / 0.25));
        if (fl.t > 0.25) { scene.remove(fl.mesh); fl.mesh.material.dispose(); flashes.splice(i, 1); }
      }
      // monsters wander, flap and face the player
      var px = (info.player.pos.px + 6) / T, pz = (info.player.pos.py + 6) / T;
      mons.forEach(function (e, id) {
        if (e.seen < frame - 1) { scene.remove(e.g); mons.delete(id); return; }
        var hover = e.g.userData.hover || 0, bob = Math.sin(t * 6 + e.x) * 0.05;
        e.g.position.set(e.x + 0.5, hover + bob, e.y + 0.5);
        var want = Math.atan2(px - (e.x + 0.5), pz - (e.y + 0.5)); e.face += (((want - e.face + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI) * 0.15; e.g.rotation.y = e.face;
        var w = e.g.userData.wings; if (w) { var fl2 = Math.sin(t * 28) * 0.7; w[0].rotation.z = fl2; w[1].rotation.z = -fl2; }
      });
      updateFishing(C, info, t); updateSpots(t);
    },
    dispose: function (C) {
      GT.fx3d = null; api = null;
      if (cropMesh) { scene.remove(cropMesh); cropMesh.geometry.dispose(); cropMesh = null; } if (cropMat) { cropMat.dispose(); cropMat = null; } cropKey = '';
      if (ringMesh) { scene.remove(ringMesh); ringMesh.geometry.dispose(); ringMesh.dispose(); ringMesh = null; } if (ringMat) { ringMat.dispose(); ringMat = null; } spotsList = [];
      labels.forEach(function (e) { if (e.el.parentNode) e.el.parentNode.removeChild(e.el); }); labels.clear();
      floats.forEach(function (f) { if (f.el.parentNode) f.el.parentNode.removeChild(f.el); }); floats = [];
      flashes.forEach(function (f) { scene.remove(f.mesh); f.mesh.material.dispose(); }); flashes = [];
      mons.forEach(function (e) { scene.remove(e.g); e.g.traverse(function (o) { if (o.geometry) o.geometry.dispose(); }); }); mons.clear();
      if (pm) { C.scene.remove(pm); pm.geometry.dispose(); pm.material.dispose(); pm.dispose(); }
      if (fish) { C.root.remove(fish.root); fish.root.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); fish = null; }
      if (stallGroup) { scene.remove(stallGroup); stallGroup.traverse(function (o) { if (o.geometry) o.geometry.dispose(); }); stallGroup = null; }
      if (stallLits) { stallLits.dispose(); stallLits = null; }
      if (flashGeo) { flashGeo.dispose(); flashGeo = null; }
      if (monMat) { monMat.dispose(); monMat = null; }
      pm = null; parts = []; stallKey = ''; scene = null; layer = null; rect = null;
    }
  };
})();
