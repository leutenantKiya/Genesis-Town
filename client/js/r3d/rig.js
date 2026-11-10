/*
 * r3d/rig.js - the 3D character: a soft, rounded stylised person (round head with face and hair, torso, two arms, two legs) built from the
 * same nine colour palettes as the 2D character art (skin, hair, shirt, pants; the police palette gets a cap). Parts are
 * pivoted at the neck, shoulders and hips so they can swing. One rig = one Group; geometry is cached per palette so a crowd
 * costs six draw calls per person. Poses: stand, walk, chop (axe swing), fish, hit flash (white/red), knocked out.
 * Hats (caping, mahkota, syal) are built from the cosmetic's colour. Facing: +z is "down" (south) on the map.
 */
(function () {
  'use strict';
  var R3D = window.R3D = window.R3D || {};
  var THREE = window.THREE;
  if (!THREE || !R3D.geo) return;
  var Builder = R3D.geo.Builder;

  var CH_PAL = [
    { hair: '#5a3820', shirt: '#d84848', skin: '#f8c8a0', pants: '#384880' },
    { hair: '#e8c048', shirt: '#4878d8', skin: '#f8d0b0', pants: '#4a4a60' },
    { hair: '#2a2a38', shirt: '#58b058', skin: '#d8a070', pants: '#5a4a38' },
    { hair: '#d87028', shirt: '#9858c8', skin: '#f8c8a0', pants: '#384870' },
    { hair: '#b8b8c8', shirt: '#f0d048', skin: '#e8b890', pants: '#585868' },
    { hair: '#38a8a0', shirt: '#f088b8', skin: '#a86a48', pants: '#303850' },
    { hair: '#1c1c24', shirt: '#a82838', skin: '#f8c8a0', pants: '#202030' },
    { hair: '#8a5ad0', shirt: '#38b8c8', skin: '#f0c8a8', pants: '#68503a' },
    { hair: '#26346e', shirt: '#2e4488', skin: '#f0c8a0', pants: '#1a2250', police: true }
  ];
  var DIRY = { down: 0, up: Math.PI, left: -Math.PI / 2, right: Math.PI / 2 };
  var cache = {}, mats = null, smats = null, axeGeo = null, rodGeo = null;

  // ---- smooth, rounded building blocks (spheres, capsules, cones): characters are soft stylised figures, not boxes ----
  var M4 = new THREE.Matrix4(), QQ = new THREE.Quaternion(), V1 = new THREE.Vector3(), V2 = new THREE.Vector3(), EU = new THREE.Euler();
  var SPH = null, CYL = null, CONE = null, capCache = {};
  function prims() {
    if (SPH) return;
    SPH = new THREE.SphereGeometry(1, 18, 13); CYL = new THREE.CylinderGeometry(1, 1, 1, 14, 1); CONE = new THREE.ConeGeometry(1, 1, 7, 1);
  }
  function capGeo(r, len) { var k = r + ':' + len; return capCache[k] || (capCache[k] = new THREE.CapsuleGeometry(r, len, 4, 10)); }
  function Acc() { this.pos = []; this.nor = []; this.col = []; this.idx = []; this.n = 0; }
  Acc.prototype.put = function (geo, x, y, z, sx, sy, sz, rx, ry, rz, hex) {
    EU.set(rx || 0, ry || 0, rz || 0); QQ.setFromEuler(EU); V1.set(x, y, z); V2.set(sx, sy, sz); M4.compose(V1, QQ, V2);
    var g = geo.clone(); g.applyMatrix4(M4);
    var p = g.attributes.position, nn = g.attributes.normal, c = new THREE.Color(hex), i;
    for (i = 0; i < p.count; i++) { this.pos.push(p.getX(i), p.getY(i), p.getZ(i)); this.nor.push(nn.getX(i), nn.getY(i), nn.getZ(i)); this.col.push(c.r, c.g, c.b); }
    var ix = g.index; for (i = 0; i < ix.count; i++) this.idx.push(ix.getX(i) + this.n);
    this.n += p.count; g.dispose(); return this;
  };
  Acc.prototype.sph = function (x, y, z, rx, ry, rz, hex) { return this.put(SPH, x, y, z, rx, ry, rz, 0, 0, 0, hex); };
  Acc.prototype.cap = function (x, y, z, r, len, hex, rx, ry, rz, sx, sz) { return this.put(capGeo(r, len), x, y, z, sx || 1, 1, sz || 1, rx, ry, rz, hex); };
  Acc.prototype.cyl = function (x, y, z, rx, h, rz, hex, ax, ay, az) { return this.put(CYL, x, y, z, rx, h, rz, ax, ay, az, hex); };
  Acc.prototype.cone = function (x, y, z, r, h, hex, ax, ay, az) { return this.put(CONE, x, y, z, r, h, r, ax, ay, az, hex); };
  Acc.prototype.geometry = function () {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3)); g.setIndex(this.idx); return g;
  };
  Acc.prototype.mesh = function (mat) { var m = new THREE.Mesh(this.geometry(), mat); m.frustumCulled = false; m.castShadow = true; return m; };
  function hairCap(r, thetaLen, openFront) { // a dome of hair; the front wedge is left open for the face
    var w = openFront == null ? 0.95 : openFront;
    return new THREE.SphereGeometry(r, 22, 12, Math.PI / 2 + w, Math.PI * 2 - 2 * w, 0, thetaLen);
  }
  // hair: a full dome over the crown, then a ring below it with the face's wedge left open
  function dome(A, r, thetaLen, x, y, z, hex) {
    A.put(new THREE.SphereGeometry(r, 22, 8, 0, Math.PI * 2, 0, 1.05), x, y, z, 1, 1, 1, 0, 0, 0, hex);
    A.put(new THREE.SphereGeometry(r, 22, 8, Math.PI / 2 + 0.95, Math.PI * 2 - 1.9, 1.04, Math.max(0.1, thetaLen - 1.04)), x, y, z, 1, 1, 1, 0, 0, 0, hex);
  }
  function shade(hex, k) { var c = new THREE.Color(hex); c.multiplyScalar(k); return '#' + c.getHexString(); }

  // hair styles by look: 0 short sweep, 1 long with side locks, 2 spiky, 3 ponytail, 4 bun, 5 bob, 6 short dark, 7 twin tails, 8 under a police cap
  function hairFor(A, idx, hc) {
    var hl = shade(hc, 1.18), hd = shade(hc, 0.82), i;
    function fringe(n, y) { for (var j = 0; j < n; j++) { var t = n === 1 ? 0 : (j / (n - 1) - 0.5); A.sph(t * 0.34, y - 0.035 - Math.abs(t) * 0.05, 0.168 - Math.abs(t) * 0.07, 0.09, 0.08, 0.075, j % 2 ? hc : hl); } }
    switch (idx) {
      case 0: dome(A, 0.256, 1.72, 0, 0.235, -0.012, hc); fringe(4, 0.355); break;
      case 1:
        dome(A, 0.258, 2.0, 0, 0.235, -0.015, hc); fringe(3, 0.35);
        A.cap(-0.215, 0.05, 0.02, 0.06, 0.2, hc, 0, 0, 0.05); A.cap(0.215, 0.05, 0.02, 0.06, 0.2, hc, 0, 0, -0.05); A.sph(0, 0.04, -0.17, 0.2, 0.26, 0.1, hd);
        break;
      case 2:
        dome(A, 0.252, 1.65, 0, 0.235, -0.012, hc);
        for (i = 0; i < 7; i++) { var a = i / 7 * 6.283; A.cone(Math.cos(a) * 0.12, 0.47, Math.sin(a) * 0.1 - 0.02, 0.07, 0.17 + (i % 2) * 0.05, i % 2 ? hc : hl, Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5); }
        fringe(3, 0.35); break;
      case 3:
        dome(A, 0.256, 1.78, 0, 0.235, -0.012, hc); fringe(4, 0.355);
        A.sph(0, 0.34, -0.24, 0.05, 0.05, 0.05, '#d84848'); A.cap(0, 0.2, -0.3, 0.07, 0.2, hd, -0.35, 0, 0); break;
      case 4:
        dome(A, 0.256, 1.72, 0, 0.235, -0.012, hc); fringe(3, 0.36); A.sph(0, 0.52, -0.04, 0.115, 0.1, 0.115, hl); break;
      case 5:
        dome(A, 0.262, 2.25, 0, 0.225, -0.012, hc); fringe(5, 0.34);
        A.cap(-0.225, 0.08, 0.0, 0.055, 0.1, hc); A.cap(0.225, 0.08, 0.0, 0.055, 0.1, hc); break;
      case 6:
        dome(A, 0.254, 1.7, 0, 0.235, -0.012, hc); fringe(3, 0.36);
        A.sph(-0.2, 0.3, 0.06, 0.06, 0.07, 0.07, hc); A.sph(0.2, 0.3, 0.06, 0.06, 0.07, 0.07, hc); break;
      case 7:
        dome(A, 0.256, 1.78, 0, 0.235, -0.012, hc); fringe(4, 0.355);
        A.sph(-0.24, 0.33, -0.03, 0.045, 0.045, 0.045, '#f8f0ff'); A.sph(0.24, 0.33, -0.03, 0.045, 0.045, 0.045, '#f8f0ff');
        A.cap(-0.27, 0.12, -0.03, 0.06, 0.22, hc, 0, 0, 0.12); A.cap(0.27, 0.12, -0.03, 0.06, 0.22, hc, 0, 0, -0.12); break;
      default:
        dome(A, 0.25, 1.6, 0, 0.23, -0.01, hc); fringe(2, 0.33);
        // police cap: a rounded crown, a band, a shiny visor and a badge
        A.put(new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, 1.45), 0, 0.31, -0.01, 0.275, 0.22, 0.275, 0, 0, 0, '#1b2658');
        A.cyl(0, 0.315, -0.01, 0.285, 0.05, 0.285, '#0f1740'); A.sph(0, 0.33, 0.215, 0.2, 0.02, 0.15, '#0b1030'); A.sph(0, 0.375, 0.27, 0.035, 0.035, 0.012, '#f8d838');
    }
  }

  function partsFor(look) {
    var idx = ((Math.floor(look) || 0) % 9 + 9) % 9;
    if (cache[idx]) return cache[idx];
    prims();
    var p = CH_PAL[idx], H = new Acc(), T = new Acc(), A = new Acc(), L = new Acc(), eye = '#241c2c';
    var cheek = shade(p.skin, 0.93), blush = '#f09a8a';
    // head: the neck is the origin, the face looks toward +z
    H.sph(0, 0.225, 0, 0.235, 0.228, 0.226, p.skin);
    H.sph(-0.232, 0.205, 0.0, 0.04, 0.052, 0.034, cheek); H.sph(0.232, 0.205, 0.0, 0.04, 0.052, 0.034, cheek);
    H.sph(-0.088, 0.2, 0.205, 0.04, 0.054, 0.024, eye); H.sph(0.088, 0.2, 0.205, 0.04, 0.054, 0.024, eye);
    H.sph(-0.077, 0.218, 0.226, 0.013, 0.015, 0.008, '#ffffff'); H.sph(0.099, 0.218, 0.226, 0.013, 0.015, 0.008, '#ffffff');
    H.sph(-0.098, 0.18, 0.226, 0.007, 0.007, 0.004, '#ffffff'); H.sph(0.078, 0.18, 0.226, 0.007, 0.007, 0.004, '#ffffff');
    H.sph(-0.14, 0.128, 0.163, 0.04, 0.025, 0.016, blush); H.sph(0.14, 0.128, 0.163, 0.04, 0.025, 0.016, blush);
    H.sph(0, 0.158, 0.222, 0.02, 0.018, 0.018, shade(p.skin, 0.92));
    H.sph(0, 0.108, 0.208, 0.03, 0.01, 0.01, '#a8504a');
    hairFor(H, idx, p.hair);
    // torso: from the hips up, with a neck on top
    T.cap(0, 0.2, 0, 0.13, 0.07, p.shirt, 0, 0, 0, 1.3, 0.86);
    T.sph(0, 0.075, 0, 0.19, 0.1, 0.135, p.pants);
    T.cyl(0, 0.125, 0, 0.2, 0.03, 0.14, '#4a3028');
    T.cyl(0, 0.365, 0, 0.055, 0.1, 0.055, p.skin);
    T.sph(0, 0.335, 0.03, 0.09, 0.03, 0.06, shade(p.shirt, 1.12)); // collar
    if (p.police) { T.sph(-0.1, 0.27, 0.105, 0.03, 0.03, 0.01, '#f8d838'); T.cyl(0, 0.2, 0.1, 0.12, 0.012, 0.012, '#f8d838', Math.PI / 2, 0, 0); }
    // arm: hangs from the shoulder; a sleeve, a forearm and a round hand
    A.sph(0, -0.005, 0, 0.075, 0.075, 0.075, p.shirt);
    A.cap(0, -0.1, 0, 0.062, 0.1, p.shirt);
    A.cap(0, -0.235, 0, 0.05, 0.07, p.skin);
    A.sph(0, -0.31, 0.005, 0.054, 0.054, 0.054, p.skin);
    // leg: hangs from the hip; trousers and a rounded shoe that points forward
    L.cap(0, -0.14, 0, 0.074, 0.12, p.pants);
    L.sph(0, -0.285, 0.035, 0.085, 0.055, 0.135, '#4a3028'); L.sph(0, -0.318, 0.04, 0.083, 0.02, 0.13, '#c8b8a8');
    return (cache[idx] = { head: H.geometry(), torso: T.geometry(), arm: A.geometry(), leg: L.geometry() });
  }

  function ensure() {
    if (mats) return;
    mats = {
      lit: R3D.geo.lit(),
      white: new THREE.MeshBasicMaterial({ color: 0xffffff }),
      red: new THREE.MeshBasicMaterial({ color: 0xff4a3c }),
      ko: new THREE.MeshLambertMaterial({ vertexColors: true, color: 0x7c7e94, side: THREE.DoubleSide }),
      ghost: new THREE.MeshBasicMaterial({ color: 0xa8b8ff, transparent: true, opacity: 0.5, depthFunc: THREE.GreaterDepth, depthWrite: false,
        stencilWrite: true, stencilRef: 1, stencilFunc: THREE.NotEqualStencilFunc })
    };
    // the player's own materials mark the stencil where the body is visible, so the see-through silhouette only fills the hidden parts
    smats = {};
    ['lit', 'white', 'red', 'ko'].forEach(function (k) {
      var m = mats[k].clone(); m.stencilWrite = true; m.stencilRef = 1; m.stencilFunc = THREE.AlwaysStencilFunc; m.stencilZPass = THREE.ReplaceStencilOp; smats[k] = m;
    });
    prims();
    var X = new Acc();
    X.cyl(0, 0.2, 0, 0.026, 0.52, 0.026, '#6a3f22'); // handle (points along +y, turned forward in the hand)
    X.put(new THREE.BoxGeometry(1, 1, 1), 0, 0.42, -0.09, 0.05, 0.15, 0.17, 0, 0, 0, '#d9dde6');
    X.put(new THREE.BoxGeometry(1, 1, 1), 0, 0.42, 0.0, 0.07, 0.17, 0.06, 0, 0, 0, '#7d8290');
    axeGeo = X.geometry();
    var RB = new Acc();
    RB.cyl(0, 0, 0.65, 0.016, 1.3, 0.016, '#7a4a28', Math.PI / 2, 0, 0); RB.cyl(0, 0, 0.1, 0.03, 0.2, 0.03, '#3a2414', Math.PI / 2, 0, 0);
    rodGeo = RB.geometry();
  }

  function create(look, opts) {
    ensure();
    var P = partsFor(look), root = new THREE.Group(), body = new THREE.Group(), meshes = [], rig;
    root.add(body);
    function part(geo, x, y) {
      var g = new THREE.Group(); g.position.set(x, y, 0);
      var m = new THREE.Mesh(geo, (opts && opts.ghost) ? smats.lit : mats.lit); m.frustumCulled = false; m.castShadow = true; g.add(m); meshes.push(m);
      if (opts && opts.ghost) { var gm = new THREE.Mesh(geo, mats.ghost); gm.renderOrder = 5; gm.frustumCulled = false; g.add(gm); }
      body.add(g); return g;
    }
    var legL = part(P.leg, -0.09, 0.32), legR = part(P.leg, 0.09, 0.32), torso = part(P.torso, 0, 0.32);
    var head = part(P.head, 0, 0.66), armL = part(P.arm, -0.28, 0.63), armR = part(P.arm, 0.28, 0.63);
    var axe = new THREE.Mesh(axeGeo, mats.lit); axe.rotation.x = Math.PI / 2; axe.position.set(0, -0.3, 0.02); axe.visible = false; axe.frustumCulled = false;
    armR.add(axe);
    var rod = new THREE.Group(); rod.position.set(0.28, 0.5, 0.2); rod.rotation.x = -0.6; rod.visible = false;
    var rodM = new THREE.Mesh(rodGeo, mats.lit); rodM.frustumCulled = false; rod.add(rodM);
    var rodTip = new THREE.Object3D(); rodTip.position.z = 1.3; rod.add(rodTip); body.add(rod);
    rig = { root: root, body: body, look: look, meshes: meshes, legL: legL, legR: legR, torso: torso, head: head, armL: armL, armR: armR, axe: axe, rod: rod, rodTip: rodTip, matKey: 'lit', hatKey: null, hat: null, stencil: !!(opts && opts.ghost) };
    return rig;
  }

  function setHat(rig, name, color) {
    var key = name ? name + ':' + color : null;
    if (key === rig.hatKey) return;
    rig.hatKey = key;
    if (rig.hat) { rig.hat.parent.remove(rig.hat); rig.hat.geometry.dispose(); rig.hat = null; }
    if (!name) return;
    var B = new Acc(), c = color || '#e8c048', attach = rig.head; prims();
    if (name === 'syal') { // a scarf wound round the neck with a tail hanging in front
      B.put(new THREE.TorusGeometry(0.2, 0.062, 8, 22), 0, 0.0, 0, 1, 1, 1.0, Math.PI / 2, 0, 0, c);
      B.cap(0.1, -0.17, 0.16, 0.055, 0.18, c, 0.1, 0, 0.1);
    } else if (name === 'mahkota') {
      B.cyl(0, 0.44, 0, 0.215, 0.1, 0.215, c);
      for (var i = 0; i < 5; i++) { var a = i / 5 * 6.2832; B.cone(Math.cos(a) * 0.2, 0.55, Math.sin(a) * 0.2, 0.055, 0.15, '#fff2a0'); B.sph(Math.cos(a) * 0.2, 0.63, Math.sin(a) * 0.2, 0.025, 0.025, 0.025, '#e84a5a'); }
    } else { // caping: wide round hat
      B.cone(0, 0.42, 0, 0.56, 0.2, c, 0, 0, 0); B.cyl(0, 0.325, 0, 0.56, 0.025, 0.56, '#2a2430'); B.sph(0, 0.52, 0, 0.07, 0.05, 0.07, '#2a2430');
    }
    rig.hat = B.mesh(mats.lit);
    attach.add(rig.hat);
  }

  function matFor(st) { return st.tint === 'white' ? 'white' : st.tint === 'red' ? 'red' : st.ko ? 'ko' : 'lit'; }

  // st: {moving, t, dir, swing:{p,dir}|null, fish, ko, side, tint}
  function pose(rig, st) {
    var t = st.t, ph = t * 9, s = st.moving ? Math.sin(ph) * 0.8 : 0;
    var ry = DIRY[(st.swing && st.swing.dir) || st.dir] || 0;
    rig.root.rotation.y = ry;
    rig.legL.rotation.x = s; rig.legR.rotation.x = -s;
    rig.armL.rotation.x = -s * 0.9; rig.armR.rotation.x = s * 0.9;
    rig.armL.rotation.z = 0; rig.armR.rotation.z = 0;
    rig.body.position.y = st.moving ? Math.abs(Math.sin(ph)) * 0.045 : Math.sin(t * 2.2) * 0.008;
    rig.body.rotation.z = 0; rig.body.rotation.x = 0;
    rig.head.rotation.x = st.moving ? Math.sin(ph * 2) * 0.03 : 0;
    var axe = false;
    if (st.swing) {
      var p = Math.min(1, st.swing.p), a;
      if (p < 0.2) a = -2.7 * (p / 0.2); else if (p < 0.45) a = -2.7 + 3.0 * ((p - 0.2) / 0.25); else a = 0.3 * (1 - (p - 0.45) / 0.55);
      rig.armR.rotation.x = a; rig.armL.rotation.x = a * 0.4; rig.body.rotation.x = Math.max(0, 0.18 * Math.sin(p * 3.14));
      axe = true;
    } else if (st.fish) {
      rig.armR.rotation.x = -1.25; rig.armL.rotation.x = -0.55; rig.body.rotation.x = -0.05;
    }
    rig.axe.visible = axe;
    rig.rod.visible = !!st.fish && !st.ko;
    if (st.ko) {
      rig.body.rotation.z = (st.side || 1) * Math.PI / 2; rig.body.position.y = 0.2;
      rig.legL.rotation.x = rig.legR.rotation.x = 0; rig.armL.rotation.x = rig.armR.rotation.x = 0; rig.axe.visible = false;
    }
    var mk = matFor(st);
    if (mk !== rig.matKey) { rig.matKey = mk; var m = (rig.stencil ? smats : mats)[mk]; for (var i = 0; i < rig.meshes.length; i++) rig.meshes[i].material = m; rig.axe.material = m; if (rig.hat) rig.hat.material = m; }
  }

  function destroy(rig) {
    if (rig.hat) { rig.hat.geometry.dispose(); }
    if (rig.root.parent) rig.root.parent.remove(rig.root);
  }

  // A picture of a character for the character screen: a small private renderer draws the same 3D rig onto the given canvas.
  var PR = null;
  function portrait(cv, look, dir, step) {
    try {
      if (!PR) {
        var r = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true }); r.setClearColor(0x000000, 0);
        var sc = new THREE.Scene(); sc.add(new THREE.HemisphereLight(0xffffff, 0x8a90a8, 2.4));
        var sun = new THREE.DirectionalLight(0xfff2dc, 1.9); sun.position.set(-1.2, 2.2, 2.6); sc.add(sun);
        PR = { r: r, scene: sc, cam: new THREE.PerspectiveCamera(26, 0.8, 0.1, 20), rigs: {} };
        PR.cam.position.set(0, 0.62, 3.3); PR.cam.lookAt(0, 0.55, 0);
      }
      var key = Math.floor(look) || 0, rg = PR.rigs[key];
      if (!rg) { rg = PR.rigs[key] = create(key, null); rg.root.visible = false; PR.scene.add(rg.root); }
      Object.keys(PR.rigs).forEach(function (k) { PR.rigs[k].root.visible = (+k === key); });
      pose(rg, { moving: false, t: step ? 0.9 : 0, dir: dir || 'down', swing: null, fish: false, ko: false });
      if (PR.r.domElement.width !== cv.width || PR.r.domElement.height !== cv.height) PR.r.setSize(cv.width, cv.height, false);
      PR.cam.aspect = cv.width / cv.height; PR.cam.updateProjectionMatrix();
      PR.r.render(PR.scene, PR.cam);
      var g = cv.getContext('2d'); g.clearRect(0, 0, cv.width, cv.height); g.drawImage(PR.r.domElement, 0, 0, cv.width, cv.height);
      return true;
    } catch (e) { return false; }
  }

  R3D.rig = {
    portrait: portrait,
    acc: function () { prims(); return new Acc(); },
    create: create, pose: pose, setHat: setHat, destroy: destroy,
    disposeAll: function () {
      Object.keys(cache).forEach(function (k) { var c = cache[k]; c.head.dispose(); c.torso.dispose(); c.arm.dispose(); c.leg.dispose(); });
      cache = {};
      if (axeGeo) axeGeo.dispose(); axeGeo = null;
      if (rodGeo) rodGeo.dispose(); rodGeo = null;
      if (mats) Object.keys(mats).forEach(function (k) { mats[k].dispose(); }); mats = null;
      if (smats) Object.keys(smats).forEach(function (k) { smats[k].dispose(); }); smats = null;
    }
  };
})();
