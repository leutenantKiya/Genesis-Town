/*
 * r3d/rig.js - the 3D character: a blocky low-poly person (head with hair and face, torso, two arms, two legs) built from the
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
  var cache = {}, mats = null, smats = null, axeGeo = null;

  function partsFor(look) {
    var idx = ((Math.floor(look) || 0) % 9 + 9) % 9;
    if (cache[idx]) return cache[idx];
    var p = CH_PAL[idx], H = new Builder(), T = new Builder(), A = new Builder(), L = new Builder(), eye = '#2a2430';
    // head: neck at the origin, face toward +z
    H.box(-0.21, 0, -0.19, 0.21, 0.38, 0.19, p.skin);
    H.box(-0.225, 0.27, -0.205, 0.225, 0.43, 0.205, p.hair, p.hair);
    H.box(-0.205, 0.03, -0.205, 0.205, 0.28, -0.12, p.hair);
    H.box(-0.225, 0.1, -0.2, -0.205, 0.28, 0.02, p.hair); H.box(0.205, 0.1, -0.2, 0.225, 0.28, 0.02, p.hair);
    H.box(-0.115, 0.14, 0.19, -0.055, 0.22, 0.2, eye); H.box(0.055, 0.14, 0.19, 0.115, 0.22, 0.2, eye);
    H.box(-0.1, 0.17, 0.2, -0.075, 0.2, 0.205, '#ffffff'); H.box(0.075, 0.17, 0.2, 0.1, 0.2, 0.205, '#ffffff');
    if (p.police) {
      H.box(-0.235, 0.33, -0.22, 0.235, 0.47, 0.22, '#141c46', '#26346e');
      H.box(-0.2, 0.32, 0.2, 0.2, 0.36, 0.34, '#0c1230');
      H.box(-0.045, 0.38, 0.22, 0.045, 0.45, 0.228, '#f8d838');
    }
    // torso: from the hips up
    T.box(-0.21, 0, -0.13, 0.21, 0.34, 0.13, p.shirt, p.shirt);
    T.box(-0.215, 0, -0.135, 0.215, 0.07, 0.135, p.pants);
    if (p.police) { T.box(-0.04, 0.2, 0.13, 0.04, 0.28, 0.14, '#f8d838'); }
    // arm: hangs from the shoulder; sleeve then skin
    A.box(-0.07, -0.16, -0.07, 0.07, 0, 0.07, p.shirt, p.shirt);
    A.box(-0.062, -0.3, -0.062, 0.062, -0.16, 0.062, p.skin);
    // leg: hangs from the hip; pants then a shoe that points forward
    L.box(-0.078, -0.26, -0.078, 0.078, 0, 0.078, p.pants);
    L.box(-0.084, -0.32, -0.084, 0.084, -0.26, 0.13, '#4a3028', '#6a4a40');
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
    var B = new Builder();
    B.box(-0.025, -0.06, -0.025, 0.025, 0.46, 0.025, '#6a3f22'); // handle (points along +y, rotated forward in the hand)
    B.box(-0.03, 0.34, -0.17, 0.03, 0.5, 0.0, '#d9dde6', '#ffffff');
    B.box(-0.035, 0.36, -0.02, 0.035, 0.48, 0.03, '#7d8290');
    axeGeo = B.geometry();
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
    rig = { root: root, body: body, look: look, meshes: meshes, legL: legL, legR: legR, torso: torso, head: head, armL: armL, armR: armR, axe: axe, matKey: 'lit', hatKey: null, hat: null, stencil: !!(opts && opts.ghost) };
    return rig;
  }

  function setHat(rig, name, color) {
    var key = name ? name + ':' + color : null;
    if (key === rig.hatKey) return;
    rig.hatKey = key;
    if (rig.hat) { rig.hat.parent.remove(rig.hat); rig.hat.geometry.dispose(); rig.hat = null; }
    if (!name) return;
    var B = new Builder(), c = color || '#e8c048', attach = rig.head;
    if (name === 'syal') {
      B.box(-0.245, -0.07, -0.18, 0.245, 0.06, 0.18, c, c);
      B.box(0.08, -0.34, 0.16, 0.2, -0.04, 0.2, c);
    } else if (name === 'mahkota') {
      B.cyl(0, 0.38, 0, 0.22, 0.1, 8, c, 1, '#fff2a0');
      for (var i = 0; i < 5; i++) { var a = i / 5 * 6.2832; B.cone(Math.cos(a) * 0.2, 0.48, Math.sin(a) * 0.2, 0.06, 0.14, 4, c); }
    } else { // caping: wide round hat
      B.cyl(0, 0.33, 0, 0.56, 0.03, 12, '#2a2430');
      B.cone(0, 0.35, 0, 0.54, 0.22, 12, c, 1, '#ffffff');
      B.cone(0, 0.52, 0, 0.12, 0.1, 6, '#2a2430');
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

  R3D.rig = {
    create: create, pose: pose, setHat: setHat, destroy: destroy,
    disposeAll: function () {
      Object.keys(cache).forEach(function (k) { var c = cache[k]; c.head.dispose(); c.torso.dispose(); c.arm.dispose(); c.leg.dispose(); });
      cache = {};
      if (axeGeo) axeGeo.dispose(); axeGeo = null;
      if (mats) Object.keys(mats).forEach(function (k) { mats[k].dispose(); }); mats = null;
      if (smats) Object.keys(smats).forEach(function (k) { smats[k].dispose(); }); smats = null;
    }
  };
})();
