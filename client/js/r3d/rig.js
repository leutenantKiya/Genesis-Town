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
  function shade(hex, k) { var c = new THREE.Color(hex); c.multiplyScalar(k); return '#' + c.getHexString(); }

  // ---- the person: realistic proportions (about six and a half heads tall, 1.32 units), a modelled face, hands and hair ----
  // Pivots: the neck (head), the shoulders (arms) and the hips (legs, torso) sit at the heights set in create().
  var HEAD = { rx: 0.106, ry: 0.132, rz: 0.114, cy: 0.135 };
  function hdome(A, thetaLen, hex, grow) { // hair: a full dome over the crown, then a ring below it with the face's wedge left open
    var g = grow || 1.1, sx = HEAD.rx * g, sy = HEAD.ry * g, sz = HEAD.rz * g;
    A.put(new THREE.SphereGeometry(1, 22, 8, 0, Math.PI * 2, 0, 1.05), 0, HEAD.cy + 0.004, -0.004, sx, sy, sz, 0, 0, 0, hex);
    A.put(new THREE.SphereGeometry(1, 22, 8, Math.PI / 2 + 0.85, Math.PI * 2 - 1.7, 1.04, Math.max(0.1, thetaLen - 1.04)), 0, HEAD.cy + 0.004, -0.004, sx, sy, sz, 0, 0, 0, hex);
  }
  function fringe(A, n, y, hc, hl, w) { for (var j = 0; j < n; j++) { var t = n === 1 ? 0 : (j / (n - 1) - 0.5); A.sph(t * (w || 0.16), y - Math.abs(t) * 0.03, 0.092 - Math.abs(t) * 0.03, 0.04, 0.032, 0.03, j % 2 ? hc : hl); } }

  // hair styles by look: 0 short side-swept, 1 long and straight, 2 spiky, 3 ponytail, 4 bun, 5 bob, 6 short with sideburns, 7 twin tails, 8 police cap
  function hairFor(A, idx, hc) {
    var hl = shade(hc, 1.2), hd = shade(hc, 0.8), i;
    switch (idx) {
      case 0: hdome(A, 1.72, hc); fringe(A, 4, 0.205, hc, hl); A.sph(0.04, 0.215, 0.075, 0.07, 0.025, 0.04, hl); break;
      case 1:
        hdome(A, 2.0, hc, 1.12); fringe(A, 3, 0.2, hc, hl, 0.15);
        A.sph(0, 0.0, -0.075, 0.1, 0.2, 0.045, hd); A.cap(-0.108, 0.04, 0.0, 0.026, 0.14, hc); A.cap(0.108, 0.04, 0.0, 0.026, 0.14, hc);
        break;
      case 2:
        hdome(A, 1.6, hc, 1.07);
        for (i = 0; i < 8; i++) { var a = i / 8 * 6.283; A.cone(Math.cos(a) * 0.055, 0.262, Math.sin(a) * 0.05 - 0.01, 0.03, 0.08 + (i % 2) * 0.03, i % 2 ? hc : hl, Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5); }
        fringe(A, 3, 0.2, hc, hl, 0.13); break;
      case 3:
        hdome(A, 1.78, hc); fringe(A, 4, 0.205, hc, hl);
        A.sph(0, 0.185, -0.105, 0.026, 0.026, 0.026, '#d84848'); A.cap(0, 0.1, -0.14, 0.032, 0.17, hd, -0.35, 0, 0); break;
      case 4:
        hdome(A, 1.72, hc); fringe(A, 3, 0.208, hc, hl, 0.13); A.sph(0, 0.262, -0.035, 0.05, 0.045, 0.05, hl); break;
      case 5:
        hdome(A, 2.2, hc, 1.13); fringe(A, 5, 0.198, hc, hl, 0.17); A.cap(-0.106, 0.05, 0.0, 0.03, 0.06, hc); A.cap(0.106, 0.05, 0.0, 0.03, 0.06, hc); break;
      case 6:
        hdome(A, 1.68, hc, 1.07); fringe(A, 3, 0.205, hc, hl, 0.14); A.sph(-0.098, 0.1, 0.03, 0.014, 0.04, 0.026, hc); A.sph(0.098, 0.1, 0.03, 0.014, 0.04, 0.026, hc); break;
      case 7:
        hdome(A, 1.78, hc); fringe(A, 4, 0.205, hc, hl);
        A.sph(-0.115, 0.17, -0.03, 0.022, 0.022, 0.022, '#f8f0ff'); A.sph(0.115, 0.17, -0.03, 0.022, 0.022, 0.022, '#f8f0ff');
        A.cap(-0.13, 0.04, -0.03, 0.03, 0.16, hc, 0, 0, 0.1); A.cap(0.13, 0.04, -0.03, 0.03, 0.16, hc, 0, 0, -0.1); break;
      default: // police cap: a rounded crown, a band, a shiny visor and a badge
        hdome(A, 1.5, hc, 1.05); fringe(A, 2, 0.19, hc, hl, 0.1);
        A.put(new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, 1.45), 0, 0.2, -0.004, 0.118, 0.1, 0.122, 0, 0, 0, '#1b2658');
        A.cyl(0, 0.19, -0.004, 0.123, 0.03, 0.127, '#0f1740'); A.sph(0, 0.185, 0.1, 0.08, 0.01, 0.065, '#0b1030'); A.sph(0, 0.215, 0.122, 0.016, 0.016, 0.006, '#f8d838');
    }
  }

  var EYES = ['#5a3820', '#3a74b8', '#4a3424', '#3d7a52', '#6a7a88', '#2e2a30', '#4a3424', '#7a4a8a', '#3a2a20'];
  function partsFor(look) {
    var idx = ((Math.floor(look) || 0) % 9 + 9) % 9;
    if (cache[idx]) return cache[idx];
    prims();
    var p = CH_PAL[idx], H = new Acc(), T = new Acc(), A = new Acc(), L = new Acc();
    var sk = p.skin, skd = shade(sk, 0.9), lip = shade(sk, 0.78), cy = HEAD.cy;
    // head: the neck is the origin, the face looks toward +z
    H.sph(0, cy, 0, HEAD.rx, HEAD.ry, HEAD.rz, sk);                                   // skull
    H.sph(0, 0.062, 0.028, 0.074, 0.062, 0.07, sk);                                   // jaw and chin
    H.cyl(0, -0.03, 0, 0.046, 0.12, 0.046, sk);                                       // neck
    H.sph(-0.099, cy - 0.005, 0.0, 0.017, 0.032, 0.022, skd); H.sph(0.099, cy - 0.005, 0.0, 0.017, 0.032, 0.022, skd); // ears
    H.sph(0, 0.118, 0.1, 0.014, 0.034, 0.02, sk); H.sph(0, 0.093, 0.114, 0.021, 0.017, 0.02, skd);                       // nose: bridge and tip
    [-1, 1].forEach(function (s) {
      H.sph(s * 0.044, 0.137, 0.093, 0.022, 0.0135, 0.012, '#fbf8f4');                 // eye white
      H.sph(s * 0.044, 0.137, 0.1, 0.0105, 0.0105, 0.007, EYES[idx]);                  // iris
      H.sph(s * 0.044, 0.137, 0.106, 0.0052, 0.0052, 0.004, '#101018');                // pupil
      H.sph(s * 0.041, 0.141, 0.109, 0.0028, 0.0028, 0.002, '#ffffff');                // sparkle
      H.sph(s * 0.044, 0.152, 0.094, 0.025, 0.006, 0.01, shade(p.hair, 0.8));          // brow
      H.sph(s * 0.044, 0.151, 0.093, 0.024, 0.005, 0.01, skd);                         // upper lid
    });
    H.sph(0, 0.062, 0.096, 0.03, 0.0075, 0.012, lip); H.sph(0, 0.049, 0.095, 0.025, 0.0085, 0.012, shade(lip, 1.08));       // lips
    hairFor(H, idx, p.hair);
    // torso: from the hips up, a waist and a broad chest with trapezius, the collar open at the neck
    T.sph(0, 0.05, 0, 0.15, 0.09, 0.105, p.pants);                                    // hips
    T.sph(0, 0.2, 0, 0.135, 0.16, 0.09, p.shirt);                                     // waist and belly
    T.sph(0, 0.34, 0, 0.19, 0.125, 0.105, p.shirt);                                   // chest
    T.sph(0, 0.405, 0, 0.165, 0.055, 0.088, p.shirt);                                 // shoulder line
    T.cyl(0, 0.118, 0, 0.14, 0.03, 0.097, '#4a3028'); T.sph(0, 0.118, 0.098, 0.022, 0.014, 0.008, '#c8b890'); // belt and buckle
    T.cyl(0, 0.44, 0, 0.056, 0.08, 0.056, sk); T.sph(0, 0.41, 0.045, 0.05, 0.03, 0.03, sk); // neck and chest skin
    T.sph(0, 0.415, -0.012, 0.075, 0.03, 0.06, shade(p.shirt, 1.1));                  // collar
    if (p.police) { T.sph(-0.075, 0.33, 0.1, 0.022, 0.022, 0.008, '#f8d838'); T.cyl(0, 0.2, 0.085, 0.07, 0.01, 0.01, '#f8d838', Math.PI / 2, 0, 0); }
    // arm: hangs from the shoulder; one continuous arm, a short sleeve with a cuff, and a hand with fingers and a thumb
    A.sph(0, 0.0, 0, 0.06, 0.06, 0.06, p.shirt);
    A.cap(0, -0.3, 0, 0.038, 0.2, sk);
    A.cap(0, -0.1, 0, 0.048, 0.1, p.shirt); A.cyl(0, -0.2, 0, 0.052, 0.02, 0.052, shade(p.shirt, 1.12));
    A.sph(0, -0.47, 0.004, 0.034, 0.05, 0.022, sk); A.sph(0, -0.512, 0.008, 0.028, 0.022, 0.016, skd); A.sph(-0.028, -0.45, 0.01, 0.011, 0.03, 0.012, sk);
    // leg: hangs from the hip; one continuous leg (thigh, shin), an ankle and a shoe with a sole
    L.cap(0, -0.2, 0, 0.07, 0.2, p.pants);
    L.cap(0, -0.48, 0, 0.055, 0.1, shade(p.pants, 0.96));
    L.sph(0, -0.595, 0.045, 0.054, 0.042, 0.105, '#4a3028'); L.sph(0, -0.624, 0.05, 0.052, 0.014, 0.102, '#d8cabc');
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
    var legL = part(P.leg, -0.085, 0.635), legR = part(P.leg, 0.085, 0.635), torso = part(P.torso, 0, 0.635);
    var head = part(P.head, 0, 1.07), armL = part(P.arm, -0.205, 1.0), armR = part(P.arm, 0.205, 1.0);
    var axe = new THREE.Mesh(axeGeo, mats.lit); axe.rotation.x = Math.PI / 2; axe.position.set(0, -0.5, 0.03); axe.visible = false; axe.frustumCulled = false;
    armR.add(axe);
    var rod = new THREE.Group(); rod.position.set(0.25, 0.8, 0.22); rod.rotation.x = -0.6; rod.visible = false;
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
      B.put(new THREE.TorusGeometry(0.115, 0.036, 8, 22), 0, 0.0, 0, 1, 1, 1.0, Math.PI / 2, 0, 0, c);
      B.cap(0.06, -0.11, 0.1, 0.03, 0.1, c, 0.1, 0, 0.1);
    } else if (name === 'mahkota') {
      B.cyl(0, 0.265, 0, 0.108, 0.06, 0.112, c);
      for (var i = 0; i < 5; i++) { var a = i / 5 * 6.2832; B.cone(Math.cos(a) * 0.1, 0.325, Math.sin(a) * 0.1, 0.03, 0.09, '#fff2a0'); B.sph(Math.cos(a) * 0.1, 0.375, Math.sin(a) * 0.1, 0.014, 0.014, 0.014, '#e84a5a'); }
    } else { // caping: wide round hat
      B.cone(0, 0.255, 0, 0.34, 0.12, c, 0, 0, 0); B.cyl(0, 0.2, 0, 0.34, 0.014, 0.34, '#2a2430'); B.sph(0, 0.32, 0, 0.04, 0.03, 0.04, '#2a2430');
    }
    rig.hat = B.mesh(mats.lit);
    attach.add(rig.hat);
  }

  function matFor(st) { return st.tint === 'white' ? 'white' : st.tint === 'red' ? 'red' : st.ko ? 'ko' : 'lit'; }

  // st: {moving, t, dir, swing:{p,dir}|null, fish, ko, side, tint}
  function pose(rig, st) {
    var t = st.t, ph = t * 9, s = st.moving ? Math.sin(ph) * 0.55 : 0;
    var ry = DIRY[(st.swing && st.swing.dir) || st.dir] || 0;
    rig.root.rotation.y = ry;
    rig.legL.rotation.x = s; rig.legR.rotation.x = -s;
    rig.armL.rotation.x = -s * 0.9; rig.armR.rotation.x = s * 0.9;
    rig.armL.rotation.z = 0.09; rig.armR.rotation.z = -0.09;
    rig.body.position.y = st.moving ? Math.abs(Math.sin(ph)) * 0.03 : Math.sin(t * 2.2) * 0.006;
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
        PR.cam.position.set(0, 0.74, 4.0); PR.cam.lookAt(0, 0.68, 0);
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
