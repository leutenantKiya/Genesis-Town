/*
 * monsters.js - GT3.Monster(kind): the night monsters as small low-poly models, in the 2D sprites' colours.
 *   'boar'  a wild boar: a chunky body, a darker ridge, a snout with tusks, red eyes, four legs that trot
 *   'bat'   a bat swarm's bat: a small body hanging in the air, two wings that flap, red eyes
 * Anything else is drawn as the boar. Lit like the world (they are hard to see at night, as they should be), with
 * eyes that glow a little so they read in the dark.
 *
 *   var m = GT3.Monster('boar'); scene.add(m.group);
 *   m.set(x, z, t, yaw)   tile units; t = seconds (animation), yaw = facing (0 looks south, toward the camera)
 */
(function () {
  'use strict';
  var GT3 = window.GT3;
  if (!GT3) return;
  var THREE = GT3.THREE;
  var geos = {}, mats = {};
  function box(parts, w, h, d, x, y, z, color, rx) { parts.push({ geo: new THREE.BoxGeometry(w, h, d), matrix: GT3.xform(x, y, z, 1, 1, 1, 0, rx || 0), color: color }); }
  function shade(top, side, dark) { return function (n) { return n.y > 0.5 ? top : n.y < -0.5 ? dark : side; }; }

  function boarBody() {
    var p = [];
    box(p, 0.46, 0.3, 0.7, 0, 0.36, 0, shade('#6e4a2e', '#5a3a24', '#3a2414'));
    box(p, 0.16, 0.1, 0.62, 0, 0.55, -0.02, '#3a2414'); // the bristly ridge
    box(p, 0.34, 0.26, 0.24, 0, 0.36, 0.42, shade('#6e4a2e', '#5a3a24', '#3a2414')); // head
    box(p, 0.2, 0.14, 0.1, 0, 0.3, 0.58, '#c9a27a'); // snout
    box(p, 0.04, 0.09, 0.04, -0.1, 0.24, 0.6, '#f0f0e0'); box(p, 0.04, 0.09, 0.04, 0.1, 0.24, 0.6, '#f0f0e0'); // tusks
    box(p, 0.08, 0.1, 0.06, -0.12, 0.52, 0.36, '#3a2414'); box(p, 0.08, 0.1, 0.06, 0.12, 0.52, 0.36, '#3a2414'); // ears
    box(p, 0.06, 0.04, 0.06, 0, 0.42, -0.38, '#3a2414'); // tail
    return GT3.merge(p);
  }
  function eyes(y, z, gap) {
    var p = [];
    box(p, 0.05, 0.05, 0.02, -gap, y, z, '#ff5a5a'); box(p, 0.05, 0.05, 0.02, gap, y, z, '#ff5a5a');
    return GT3.merge(p);
  }
  function leg() { return GT3.merge([{ geo: new THREE.BoxGeometry(0.08, 0.24, 0.08), matrix: GT3.xform(0, -0.12, 0), color: '#3a2414' }]); }
  function batBody() {
    var p = [];
    box(p, 0.2, 0.22, 0.18, 0, 0, 0, shade('#4a3e5e', '#3a2f4a', '#241c30'));
    box(p, 0.05, 0.08, 0.04, -0.06, 0.14, 0, '#2a2236'); box(p, 0.05, 0.08, 0.04, 0.06, 0.14, 0, '#2a2236'); // ears
    return GT3.merge(p);
  }
  function wing(side) {
    var s = new THREE.Shape();
    s.moveTo(0, 0); s.lineTo(side * 0.34, 0.1); s.lineTo(side * 0.42, -0.06); s.lineTo(side * 0.28, -0.02); s.lineTo(side * 0.2, -0.12); s.lineTo(side * 0.1, -0.05); s.lineTo(0, -0.08);
    var g = new THREE.ShapeGeometry(s); g.rotateX(-Math.PI / 2);
    return g;
  }
  function geo(name, make) { return geos[name] || (geos[name] = make()); }
  function mat(name, o) { return mats[name] || (mats[name] = GT3.mat(o)); }

  GT3.Monster = function (kind) {
    var group = new THREE.Group(), body = new THREE.Group(); group.add(body);
    var solid = mat('solid', { vertexColors: true }), glow = mat('eyes', { vertexColors: true, emissive: 0xff3030, emissiveIntensity: 0.9 });
    var legs = [], wings = [];
    // a soft round shadow, as the characters have
    var sh = new THREE.Mesh(new THREE.CircleGeometry(0.3, 12), new THREE.MeshBasicMaterial({ color: 0x141228, transparent: true, opacity: 0.28, depthWrite: false }));
    sh.rotation.x = -Math.PI / 2; sh.position.y = 0.015; group.add(sh);
    if (kind === 'bat') {
      var b = new THREE.Mesh(geo('bat', batBody), solid); body.add(b);
      var e = new THREE.Mesh(geo('bat-eyes', function () { return eyes(0.02, 0.1, 0.05); }), glow); body.add(e);
      [-1, 1].forEach(function (sd) {
        var w = new THREE.Mesh(geo('wing' + sd, function () { return wing(sd); }), mat('wing', { color: '#2a2236', side: THREE.DoubleSide }));
        w.position.set(sd * 0.08, 0.04, 0); body.add(w); wings.push({ m: w, side: sd });
      });
      body.position.y = 1.0; sh.scale.setScalar(0.6);
    } else {
      body.add(new THREE.Mesh(geo('boar', boarBody), solid));
      body.add(new THREE.Mesh(geo('boar-eyes', function () { return eyes(0.42, 0.545, 0.09); }), glow));
      [[-0.15, 0.22], [0.15, 0.22], [-0.15, -0.22], [0.15, -0.22]].forEach(function (q, i) {
        var l = new THREE.Mesh(geo('leg', leg), solid); l.position.set(q[0], 0.24, q[1]); body.add(l); legs.push({ m: l, ph: i % 3 === 0 ? 0 : Math.PI });
      });
    }
    body.traverse(function (o) { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

    return {
      group: group, kind: kind,
      set: function (x, z, t, yaw) {
        group.position.set(x, 0, z);
        if (yaw != null) body.rotation.y = yaw;
        if (kind === 'bat') {
          body.position.y = 1.0 + Math.sin(t * 3) * 0.12;
          var f = Math.sin(t * 14) * 0.9;
          wings.forEach(function (w) { w.m.rotation.z = w.side * f; });
        } else {
          legs.forEach(function (l) { l.m.rotation.x = Math.sin(t * 9 + l.ph) * 0.45; });
          body.position.y = Math.abs(Math.sin(t * 9)) * 0.03;
        }
      },
      dispose: function () { if (group.parent) group.parent.remove(group); sh.geometry.dispose(); sh.material.dispose(); }
    };
  };
})();
