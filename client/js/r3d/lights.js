/*
 * r3d/lights.js - night lighting around the street lamps. The village's lamp tiles (info.lamps) get: a warm pool of light on
 * the ground (additive, like the 2D view's holes in the darkness), a soft glow at the lamp head, and real point lights on the
 * few lamps nearest to the player (so buildings, trees and characters are lit by them). The number of point lights is fixed
 * per quality setting; unused ones stay at zero intensity so shaders never recompile at dusk.
 */
(function () {
  'use strict';
  var R3D = window.R3D = window.R3D || {};
  var THREE = window.THREE;
  if (!THREE) return;

  var group = null, pool = null, glow = null, poolMat = null, glowMat = null, texPool = null, texGlow = null, lights = [], lamps = [], count = 0;
  var lastKey = '', glowKey = '';

  function radial(stops, size) {
    var c = document.createElement('canvas'); c.width = c.height = size || 64;
    var g = c.getContext('2d'), gr = g.createRadialGradient(size / 2, size / 2, 1, size / 2, size / 2, size / 2 - 1);
    stops.forEach(function (s) { gr.addColorStop(s[0], s[1]); });
    g.fillStyle = gr; g.fillRect(0, 0, size, size);
    var t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  }

  function clearMeshes(C) {
    [pool, glow].forEach(function (m) { if (m) { C.root.remove(m); m.geometry.dispose(); m.dispose && m.dispose(); } });
    pool = glow = null;
  }

  function setCount(C, n) {
    lights.forEach(function (l) { C.scene.remove(l); l.dispose && l.dispose(); });
    lights = [];
    for (var i = 0; i < n; i++) {
      var l = new THREE.PointLight(0xffc27a, 0, 7.5, 1.4);
      C.scene.add(l); lights.push(l);
    }
    count = n;
  }

  function build(C, info) {
    clearMeshes(C);
    lamps = (info.lamps || []).slice();
    var n = lamps.length;
    lastKey = n + ':' + (n ? lamps[0].x + ',' + lamps[0].y : '');
    if (!n) return;
    var m4 = new THREE.Matrix4(), q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)), one = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
    pool = new THREE.InstancedMesh(new THREE.PlaneGeometry(7, 7), poolMat, n);
    glow = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.6, 1.6), glowMat, n);
    for (var i = 0; i < n; i++) {
      p.set(lamps[i].x + 0.5, 0.035, lamps[i].y + 0.5); m4.compose(p, q, one); pool.setMatrixAt(i, m4);
      p.set(lamps[i].x + 0.5, 1.64, lamps[i].y + 0.5); m4.compose(p, C.cam.quaternion, one); glow.setMatrixAt(i, m4);
    }
    pool.frustumCulled = false; glow.frustumCulled = false; pool.renderOrder = 1; glow.renderOrder = 4;
    C.root.add(pool); C.root.add(glow);
  }

  R3D.lights = {
    init: function (C) {
      texPool = radial([[0, 'rgba(255,205,120,0.85)'], [0.35, 'rgba(255,175,80,0.45)'], [0.7, 'rgba(255,150,60,0.14)'], [1, 'rgba(255,140,50,0)']], 128);
      texGlow = radial([[0, 'rgba(255,240,190,1)'], [0.3, 'rgba(255,200,110,0.55)'], [1, 'rgba(255,170,70,0)']], 64);
      poolMat = new THREE.MeshBasicMaterial({ map: texPool, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 });
      glowMat = new THREE.MeshBasicMaterial({ map: texGlow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 });
      setCount(C, (R3D.Q && R3D.Q.lamps) || 0);
      lamps = []; lastKey = '';
    },
    onWorld: function () { lastKey = ''; },
    setInterior: function (C, on) { if (on) lights.forEach(function (l) { l.intensity = 0; }); },
    onQuality: function (C) { setCount(C, (R3D.Q && R3D.Q.lamps) || 0); },
    update: function (C, info) {
      if (glow) { // the glow discs face the camera, which can turn
        var q = C.cam.quaternion, qk = q.x.toFixed(3) + q.y.toFixed(3) + q.z.toFixed(3);
        if (qk !== glowKey) {
          glowKey = qk; var m4 = new THREE.Matrix4(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
          for (var gi = 0; gi < lamps.length; gi++) { p.set(lamps[gi].x + 0.5, 1.64, lamps[gi].y + 0.5); m4.compose(p, q, one); glow.setMatrixAt(gi, m4); }
          glow.instanceMatrix.needsUpdate = true;
        }
      }
      var n = info.lamps ? info.lamps.length : 0;
      var key = n + ':' + (n ? info.lamps[0].x + ',' + info.lamps[0].y : '');
      if (key !== lastKey) build(C, info);
      var d = Math.max(0, Math.min(1, (info.dark - 0.15) / 0.7));
      poolMat.opacity = 0.75 * d; glowMat.opacity = 0.9 * d;
      if (pool) { pool.visible = d > 0.01; glow.visible = d > 0.01; }
      if (!lights.length) return;
      // the lamps nearest to the player get a real light
      var px = (info.player.pos.px + 6) / 12, pz = (info.player.pos.py + 6) / 12, near = [], i;
      if (d > 0.01) for (i = 0; i < lamps.length; i++) { var dx = lamps[i].x + 0.5 - px, dz = lamps[i].y + 0.5 - pz; near.push({ i: i, d: dx * dx + dz * dz }); }
      near.sort(function (a, b) { return a.d - b.d; });
      for (i = 0; i < lights.length; i++) {
        var l = lights[i], nn = near[i];
        if (nn && nn.d < 220) { l.position.set(lamps[nn.i].x + 0.5, 1.6, lamps[nn.i].y + 0.5); l.intensity = 7 * d; }
        else l.intensity = 0;
      }
    },
    dispose: function (C) {
      clearMeshes(C);
      lights.forEach(function (l) { C.scene.remove(l); }); lights = [];
      [poolMat, glowMat, texPool, texGlow].forEach(function (x) { if (x) x.dispose(); });
      poolMat = glowMat = texPool = texGlow = null; lamps = [];
    }
  };
})();
