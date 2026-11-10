/*
 * r3d/icons.js - item icons as small soft 3D models (fish, wood, ore, wheat, bread, meal, tool, coin) for the 3D view's
 * interface: the hotbar, the bag, the shops and the market. A private renderer draws each model once onto a 128 px canvas;
 * R3D.icons.draw(canvas, id) then copies that picture, smoothly scaled, onto any canvas. Needs rig.js (its soft-shape builder).
 */
(function () {
  'use strict';
  var R3D = window.R3D = window.R3D || {};
  var THREE = window.THREE;
  if (!THREE || !R3D.rig || !R3D.rig.acc) return;

  var PR = null, cache = {}, SIZE = 128, H = Math.PI / 2;

  function box(A, x, y, z, sx, sy, sz, rx, ry, rz, hex) { return A.put(BOX, x, y, z, sx, sy, sz, rx, ry, rz, hex); }
  var BOX = new THREE.BoxGeometry(1, 1, 1), TOR = null;

  // each model sits on y = 0, about one unit across, facing +z
  var MODELS = {
    fish: function (A) {
      A.sph(0, 0.34, 0, 0.5, 0.22, 0.18, '#5b9be0'); A.sph(0.02, 0.26, 0.05, 0.44, 0.13, 0.15, '#e8f4ff');
      A.sph(-0.58, 0.34, 0, 0.1, 0.22, 0.035, '#3f73c4'); A.sph(-0.5, 0.34, 0, 0.12, 0.1, 0.05, '#4a82d4');
      A.cone(0.02, 0.56, 0, 0.11, 0.2, '#3f73c4'); A.sph(-0.05, 0.2, 0.17, 0.12, 0.05, 0.03, '#4a82d4');
      A.sph(0.34, 0.4, 0.14, 0.055, 0.055, 0.03, '#ffffff'); A.sph(0.35, 0.4, 0.165, 0.028, 0.028, 0.02, '#1e2234');
      [-0.12, 0.02, 0.16].forEach(function (x) { A.sph(x, 0.42, 0.13, 0.03, 0.1, 0.03, '#3f73c4'); });
    },
    wood: function (A) {
      A.cyl(0, 0.24, 0.0, 0.24, 1.0, 0.24, '#8a5a30', 0, 0, H); A.cyl(0.5, 0.24, 0.0, 0.2, 0.03, 0.2, '#e8c080', 0, 0, H);
      A.cyl(0.515, 0.24, 0.0, 0.12, 0.02, 0.12, '#cfa060', 0, 0, H); A.cyl(0.525, 0.24, 0.0, 0.045, 0.02, 0.045, '#a8743e', 0, 0, H);
      A.cyl(0.05, 0.62, -0.02, 0.2, 0.86, 0.2, '#9a6a3a', 0, 0, H); A.cyl(0.48, 0.62, -0.02, 0.17, 0.03, 0.17, '#ecc88a', 0, 0, H);
      A.cyl(0.495, 0.62, -0.02, 0.09, 0.02, 0.09, '#cfa060', 0, 0, H);
    },
    ore: function (A) {
      A.sph(0, 0.27, 0, 0.48, 0.31, 0.4, '#8b90a6'); A.sph(-0.32, 0.17, 0.2, 0.26, 0.19, 0.21, '#6c7088'); A.sph(0.3, 0.14, 0.18, 0.22, 0.15, 0.18, '#a0a5ba');
      A.cone(0.06, 0.62, 0.0, 0.11, 0.42, '#8fe0f4', 0.18, 0, -0.22); A.cone(-0.18, 0.5, 0.08, 0.085, 0.32, '#c4f2ff', 0.1, 0, 0.3); A.cone(0.26, 0.42, 0.05, 0.07, 0.26, '#74cde8', 0.2, 0, -0.5);
    },
    wheat: function (A) {
      [[-0.2, -0.2], [0, 0.0], [0.2, 0.2]].forEach(function (t, i) {
        var lean = t[1], x = t[0] * 0.5;
        A.cap(x, 0.5, 0, 0.022, 0.8, '#c9a64a', 0, 0, -lean);
        A.cap(x - Math.sin(lean) * 0.55 * -1, 0.97 - Math.abs(lean) * 0.1, 0, 0.055, 0.22, '#f2d24a', 0, 0, -lean);
        A.cone(x + lean * 0.58, 1.22 - Math.abs(lean) * 0.12, 0, 0.04, 0.12, '#e8c038', 0, 0, -lean);
        A.sph(x + (i - 1) * 0.12, 0.68, 0.05, 0.1, 0.02, 0.04, '#7cc23e', 0, 0, (i - 1) * 0.7);
      });
      A.cyl(0, 0.22, 0, 0.085, 0.1, 0.085, '#c84a3a');
    },
    bread: function (A) {
      A.sph(0, 0.24, 0, 0.56, 0.26, 0.32, '#d9983e'); A.sph(0, 0.32, 0, 0.5, 0.22, 0.28, '#eab35a');
      [-0.24, 0, 0.24].forEach(function (x) { A.sph(x, 0.5, 0.03, 0.09, 0.02, 0.05, '#f9dca0', 0, -0.5, 0); });
    },
    meal: function (A) {
      A.sph(0, 0.4, 0, 0.5, 0.34, 0.5, '#b8582a'); A.cyl(0, 0.04, 0, 0.26, 0.08, 0.26, '#8a4020');
      A.put(TOR || (TOR = new THREE.TorusGeometry(0.46, 0.045, 8, 28)), 0, 0.64, 0, 1, 1, 1, H, 0, 0, '#8a4020');
      A.sph(0, 0.62, 0, 0.44, 0.12, 0.44, '#fbf5e4');
      A.sph(-0.12, 0.74, 0.06, 0.15, 0.09, 0.14, '#e4793a'); A.sph(0.16, 0.73, -0.04, 0.13, 0.08, 0.12, '#7cc23e'); A.sph(0.02, 0.77, 0.16, 0.09, 0.07, 0.09, '#f2d24a'); A.sph(-0.04, 0.76, -0.14, 0.1, 0.07, 0.1, '#d84a4a');
    },
    tool: function (A) {
      A.cap(0.04, 0.5, 0, 0.045, 0.82, '#8a5a30', 0, 0, 0.18);
      A.cap(0.04, 0.96, 0, 0.1, 0.5, '#c8ccd8', H, 0, 0, 0.9, 1); A.sph(0.36, 0.94, 0, 0.1, 0.1, 0.1, '#e8ecf6'); A.sph(-0.28, 0.94, 0, 0.1, 0.1, 0.1, '#a8aec0');
      A.cyl(0.0, 0.2, 0, 0.065, 0.08, 0.065, '#6a4020');
    },
    coin: function (A) {
      A.cyl(0, 0.5, 0, 0.5, 0.12, 0.5, '#f2c94c', H, 0, 0); A.put(TOR || (TOR = new THREE.TorusGeometry(0.46, 0.045, 8, 28)), 0, 0.5, 0.06, 1, 1, 1.2, 0, 0, 0, '#d9a024');
      A.cyl(0, 0.5, 0.07, 0.33, 0.03, 0.33, '#ffe27a', H, 0, 0); A.cyl(0, 0.5, 0.09, 0.15, 0.02, 0.15, '#f2c94c', H, 0, 0);
    }
  };

  function renderer() {
    if (PR) return PR;
    var r = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true }); r.setClearColor(0x000000, 0); r.setSize(SIZE, SIZE, false);
    var sc = new THREE.Scene(); sc.add(new THREE.HemisphereLight(0xffffff, 0x9096b0, 2.3));
    var sun = new THREE.DirectionalLight(0xfff4e0, 2.1); sun.position.set(-1.5, 2.4, 2.8); sc.add(sun);
    var cam = new THREE.PerspectiveCamera(28, 1, 0.1, 30); cam.position.set(0.8, 1.35, 3.0); cam.lookAt(0, 0.56, 0);
    return (PR = { r: r, scene: sc, cam: cam, mat: R3D.geo.lit() });
  }

  function picture(id) {
    if (cache[id]) return cache[id];
    var build = MODELS[id]; if (!build) return null;
    var P = renderer(), A = R3D.rig.acc();
    build(A);
    var m = A.mesh(P.mat); m.castShadow = false;
    P.scene.add(m); P.r.render(P.scene, P.cam); P.scene.remove(m); m.geometry.dispose();
    var cv = document.createElement('canvas'); cv.width = cv.height = SIZE;
    cv.getContext('2d').drawImage(P.r.domElement, 0, 0);
    return (cache[id] = cv);
  }

  R3D.icons = {
    has: function (id) { return !!MODELS[id]; },
    // paints the icon onto cv (any size); false when there is no 3D picture for this item
    draw: function (cv, id) {
      try {
        var p = picture(id); if (!p) return false;
        var g = cv.getContext('2d'); g.clearRect(0, 0, cv.width, cv.height); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
        g.drawImage(p, 0, 0, cv.width, cv.height); return true;
      } catch (e) { return false; }
    },
    dispose: function () {
      cache = {};
      if (PR) { PR.mat.dispose(); PR.r.dispose(); PR = null; }
    }
  };
})();
