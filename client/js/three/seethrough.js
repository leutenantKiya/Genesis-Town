/*
 * seethrough.js - GT3.SeeThrough(world): buildings and tree crowns fade when they would hide the local player
 * (DESIGN.md "See-through buildings"). Only the local player triggers it; other characters behind a building stay hidden.
 *   - behind a building (between its back wall and the roof's reach toward the camera, within its width) or standing
 *     inside its footprint: the building fades to 40% over 250 ms and comes back over 200 ms
 *   - at a door, walking in: 25% over 180 ms (enter(true)), back over 300 ms after coming out
 *   - under or just behind a tree crown: the tree fades to 45%
 *   - "Kurangi animasi" (html.gt-reduced-motion) or prefers-reduced-motion: jump straight to the target
 * The ground shadows stay: only the models fade.
 *
 *   var st = GT3.SeeThrough(world); st.update(px, pz, dt, camera)   (player feet, tile units)
 * With the camera, "would hide" is a sight line: from the camera to the player's feet, middle and head; whatever box
 * it crosses first fades. That holds at every camera turn (Q / E). Without it, the old rule assumes the camera south.
 */
(function () {
  'use strict';
  var GT3 = window.GT3;
  if (!GT3) return;
  var REACH = 0.8; // how far behind an object of height 1 the camera's view is blocked (1 / tan of the camera pitch)

  function reduced() {
    if (document.documentElement.classList.contains('gt-reduced-motion')) return true;
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }
  function setAlpha(mats, a) {
    mats.forEach(function (m) {
      var see = a < 0.999;
      if (m.transparent !== see) { m.transparent = see; m.needsUpdate = true; }
      m.opacity = a; m.depthWrite = !see;
    });
  }

  var THREE = GT3.THREE, ray = new THREE.Ray(), hit = new THREE.Vector3(), aim = new THREE.Vector3();
  var EYES = [0.25, 0.7, 1.2]; // feet, middle and head of a standing character, in tiles above the ground
  /** Does the line from the camera to any of the player's points cross `box` before it reaches the player? */
  function hides(box, cam, px, pz) {
    for (var i = 0; i < EYES.length; i++) {
      aim.set(px, EYES[i], pz);
      var d = aim.distanceTo(cam.position);
      ray.origin.copy(cam.position); ray.direction.copy(aim).sub(cam.position).normalize();
      if (ray.intersectBox(box, hit) && hit.distanceTo(cam.position) < d - 0.05) return true;
    }
    return false;
  }

  GT3.SeeThrough = function (world) {
    var items = [], entering = false;
    world.buildings.forEach(function (g) {
      var u = g.userData, b = u.building;
      items.push({ kind: 'building', g: g, a: 1, x: b.x + (b.w || 3) / 2, z: b.y + (b.h || 3) / 2, test: function (px, pz, cam) {
        if (entering && Math.abs(px - u.door.x) < 0.8 && Math.abs(pz - u.door.z) < 1.2) return 0.25;
        if (cam) return hides(u.box, cam, px, pz) ? 0.4 : 1;
        if (px < b.x - 0.15 || px > b.x + (b.w || 3) + 0.15) return 1;
        return pz > b.y - u.height * REACH && pz < b.y + (b.h || 3) - 0.05 ? 0.4 : 1;
      }, apply: function (a) { setAlpha(u.mats, a); } });
    });
    (world.nature ? world.nature.trees : []).forEach(function (tr) {
      var crown = new THREE.Box3(new THREE.Vector3(tr.x - 0.75, 0.5, tr.z - 0.75), new THREE.Vector3(tr.x + 0.75, tr.height + 0.2, tr.z + 0.75));
      items.push({ kind: 'tree', a: 1, x: tr.x, z: tr.z, test: function (px, pz, cam) {
        if (cam) return hides(crown, cam, px, pz) ? 0.45 : 1;
        return Math.abs(px - tr.x) < 0.85 && pz < tr.z + 0.2 && pz > tr.z - tr.height * REACH ? 0.45 : 1;
      }, apply: function (a) { world.nature.fade(tr, a); } });
    });

    return {
      enter: function (on) { entering = !!on; },
      update: function (px, pz, dt, cam) {
        var jump = reduced();
        items.forEach(function (it) {
          // only what stands near the player can hide them; everything else just eases back to solid
          var goal = Math.abs(it.x - px) < 6 && Math.abs(it.z - pz) < 6 ? it.test(px, pz, cam) : 1;
          if (goal === it.a) return;
          if (jump) it.a = goal;
          else {
            var out = goal < it.a, ms = it.kind === 'building' && goal === 0.25 ? 180 : out ? 250 : (it.a <= 0.26 ? 300 : 200);
            var step = (dt * 1000 / ms) * (1 - Math.min(goal, it.a)); // full range in `ms`
            it.a = out ? Math.max(goal, it.a - step) : Math.min(goal, it.a + step);
          }
          it.apply(it.a);
        });
      }
    };
  };
})();
