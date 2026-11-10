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
 *   var st = GT3.SeeThrough(world); st.update(px, pz, dt)   (player feet, tile units)
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

  GT3.SeeThrough = function (world) {
    var items = [], entering = false;
    world.buildings.forEach(function (g) {
      var u = g.userData, b = u.building;
      items.push({ kind: 'building', g: g, a: 1, test: function (px, pz) {
        if (px < b.x - 0.15 || px > b.x + (b.w || 3) + 0.15) return 1;
        if (entering && Math.abs(px - u.door.x) < 0.8 && Math.abs(pz - u.door.z) < 1.2) return 0.25;
        return pz > b.y - u.height * REACH && pz < b.y + (b.h || 3) - 0.05 ? 0.4 : 1;
      }, apply: function (a) { setAlpha(u.mats, a); } });
    });
    (world.nature ? world.nature.trees : []).forEach(function (tr) {
      items.push({ kind: 'tree', a: 1, test: function (px, pz) {
        return Math.abs(px - tr.x) < 0.85 && pz < tr.z + 0.2 && pz > tr.z - tr.height * REACH ? 0.45 : 1;
      }, apply: function (a) { world.nature.fade(tr, a); } });
    });

    return {
      enter: function (on) { entering = !!on; },
      update: function (px, pz, dt) {
        var jump = reduced();
        items.forEach(function (it) {
          var goal = it.test(px, pz);
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
