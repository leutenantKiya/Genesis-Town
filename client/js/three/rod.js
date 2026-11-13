/* rod.js - a fishing rod in the 2.5D world (window.GT3.Rod), held by a character while they fish: a dark butt, a cork
 * grip with a reel under it, a slim two-part blank that bends toward the fish, a line that sags to a red-and-white float
 * bobbing on the water, and splash rings while a fish bites or fights. Same palette as the 2D rod in mods/fishing.js.
 *
 *   var r = GT3.Rod();  scene.add(r.group);
 *   r.update({ x, z, dir, phase, fx, fz, hold }, t)   x/z: the angler's feet; dir: where they face; fx/fz: the float's
 *                                                     water tile centre; phase: cast | wait | bite | reel; t: seconds
 *   r.dispose()
 * Units: 1 = one tile; the water lies GT3.SINK below the ground.
 */
(function () {
  'use strict';
  var GT3 = window.GT3;
  if (!GT3) return;
  var THREE = GT3.THREE, PX = GT3.PX;
  var UP = new THREE.Vector3(0, 1, 0), tmp = new THREE.Vector3(), q = new THREE.Quaternion();
  var DIRV = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
  var SEG = 14; // points along the line

  // a cylinder of height 1 standing on its base, stretched between two points
  function stick(r0, r1, color) {
    var g = new THREE.CylinderGeometry(r1, r0, 1, 6, 1); g.translate(0, 0.5, 0);
    return new THREE.Mesh(g, GT3.mat({ color: color }));
  }
  function place(mesh, a, b) {
    tmp.subVectors(b, a); var len = tmp.length() || 1e-4;
    mesh.position.copy(a); mesh.scale.set(1, len, 1);
    q.setFromUnitVectors(UP, tmp.normalize()); mesh.quaternion.copy(q);
  }

  GT3.Rod = function () {
    var group = new THREE.Group(); group.name = 'rod';
    var butt = stick(0.032, 0.03, '#4a2a14'), grip = stick(0.036, 0.034, '#d8b07a');
    var low = stick(0.034, 0.024, '#7a4a26'), high = stick(0.022, 0.011, '#8a5a30');
    var reel = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.04, 10), GT3.mat({ color: '#b8bcc8' }));
    var crank = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.012, 0.07), GT3.mat({ color: '#2a2430' }));
    var tipRing = new THREE.Mesh(new THREE.SphereGeometry(0.014, 6, 4), GT3.mat({ color: '#e8e4d8' }));
    [butt, grip, low, high, reel, crank, tipRing].forEach(function (m) { m.castShadow = true; group.add(m); });
    // the line: a thin pale curve from the tip to the float (not lit, so it reads at night as a glint)
    var lineGeo = new THREE.BufferGeometry(); lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SEG * 3), 3));
    var line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xf4f2e6, transparent: true, opacity: 0.85 }));
    line.frustumCulled = false; group.add(line);
    // the float: red cap over a white body
    var flt = new THREE.Group();
    var cap = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), GT3.mat({ color: '#e8503c' }));
    var body = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), GT3.mat({ color: '#f4f4ec' }));
    flt.add(cap); flt.add(body); group.add(flt);
    // splash rings on the water while a fish bites or fights
    var ringMat = new THREE.MeshBasicMaterial({ color: 0xe8f8f6, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
    var ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 24), ringMat); ring.rotation.x = -Math.PI / 2; group.add(ring);

    var hand = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), mid = new THREE.Vector3(), tip = new THREE.Vector3(), fp = new THREE.Vector3();
    var side = new THREE.Vector3();

    function update(s, t) {
      var d = DIRV[s.dir] || [0, 1], wy = -(GT3.SINK || 3 * PX);
      // toward the float (or the way they face), a little to the side, at hand height
      var tx = s.fx - s.x, tz = s.fz - s.z, tl = Math.hypot(tx, tz);
      if (tl < 0.2) { tx = d[0]; tz = d[1]; tl = 1; }
      tx /= tl; tz /= tl;
      side.set(-tz, 0, tx);
      hand.set(s.x + tx * 0.18 + side.x * 0.16, 0.5, s.z + tz * 0.18 + side.z * 0.16);
      // the blank rises out over the water; reeling bends the top toward the float, a bite tugs it
      var pull = s.phase === 'reel' ? 1 : s.phase === 'bite' ? 0.55 : 0;
      var castK = s.phase === 'cast' ? Math.min(1, (s.t || 0) / 0.45) : 1;
      var lift = 0.95 - 0.25 * pull + (s.phase === 'cast' ? 0.35 * (1 - castK) : 0);
      var reach = 0.75 + 0.25 * castK;
      mid.set(hand.x + tx * reach * 0.5, hand.y + lift * 0.62, hand.z + tz * reach * 0.5);
      tip.set(hand.x + tx * reach, hand.y + lift - 0.35 * pull, hand.z + tz * reach);
      if (pull) { var jig = Math.sin(t * (s.hold ? 22 : 9)) * 0.03 * pull; tip.x += tx * jig; tip.z += tz * jig; }
      // butt behind the hand, grip in the hand, then the two parts of the blank
      a.set(hand.x - tx * 0.14, hand.y - 0.08, hand.z - tz * 0.14); b.set(hand.x - tx * 0.04, hand.y - 0.03, hand.z - tz * 0.04);
      place(butt, a, b);
      a.copy(b); b.set(hand.x + tx * 0.1, hand.y + 0.05, hand.z + tz * 0.1);
      place(grip, a, b);
      place(low, b, mid); place(high, mid, tip);
      tipRing.position.copy(tip);
      // the reel hangs under the grip; its crank turns while reeling (fast while the button is held)
      reel.position.set(hand.x + side.x * 0.05, hand.y - 0.06, hand.z + side.z * 0.05);
      reel.quaternion.setFromUnitVectors(UP, side);
      var ca = s.phase === 'reel' ? t * (s.hold ? 18 : 6) : 0;
      crank.position.set(reel.position.x + side.x * 0.03 + Math.cos(ca) * 0.04 * tx, reel.position.y + Math.sin(ca) * 0.04, reel.position.z + side.z * 0.03 + Math.cos(ca) * 0.04 * tz);
      // the float: flies out while casting, bobs while waiting, dips on a bite, darts while reeling
      fp.set(s.fx, wy + 0.02, s.fz);
      if (s.phase === 'cast') { fp.lerpVectors(tip, fp, castK); fp.y += Math.sin(castK * Math.PI) * 0.6; }
      else if (s.phase === 'wait') fp.y += Math.sin(t * 4) * 0.02;
      else if (s.phase === 'bite') fp.y -= 0.05 + Math.abs(Math.sin(t * 14)) * 0.03;
      else if (s.phase === 'reel') { fp.x += Math.sin(t * 9) * 0.1; fp.z += Math.cos(t * 7) * 0.06; fp.y -= 0.03; }
      flt.position.copy(fp);
      // the line sags between the tip and the float, tight while reeling
      var sag = s.phase === 'reel' ? 0.05 : s.phase === 'bite' ? 0.15 : 0.3, P = line.geometry.attributes.position;
      for (var i = 0; i < SEG; i++) {
        var k = i / (SEG - 1), y = tip.y + (fp.y + 0.05 - tip.y) * k - Math.sin(k * Math.PI) * sag * (1 - k * 0.4);
        P.setXYZ(i, tip.x + (fp.x - tip.x) * k, y, tip.z + (fp.z - tip.z) * k);
      }
      P.needsUpdate = true;
      // rings
      var on = s.phase === 'bite' || s.phase === 'reel', ph = (t * 1.6) % 1, rr = 0.06 + ph * 0.32;
      ring.position.set(fp.x, wy + 0.01, fp.z); ring.scale.set(rr, rr, rr);
      ringMat.opacity = on ? (1 - ph) * 0.8 : 0; ring.visible = on;
    }
    function dispose() {
      if (group.parent) group.parent.remove(group);
      group.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    }
    return { group: group, update: update, dispose: dispose };
  };
})();
