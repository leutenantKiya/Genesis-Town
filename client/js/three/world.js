/*
 * world.js - GT3.World(L): every component for one layout (GTVillage.generate or GTHomeland.generate output), in one
 * group, plus what the renderer needs each frame.
 *
 *   var w = GT3.World(L); scene.add(w.group);
 *   w.walkable(x, y)          tile can be walked on (solid tiles and building footprints cannot)
 *   w.update(t, hour, night[, px, pz])  water drift, portal, window and lamp glow, and the lamps' night light round (px, pz) (tile
 *                             units; without them, the point the camera looks at, learnt from face(camera))
 *   w.setSeason(season, snowy) swap the ramps (art.js) and recolour ground, trees, rocks and grass in place
 *   w.dispose()
 */
(function () {
  'use strict';
  var GT3 = window.GT3, S = window.SPRITES;
  if (!GT3) return;
  var THREE = GT3.THREE;
  var SOLID = { tree: 1, fence: 1, sign: 1, mailbox: 1, rock: 1, water: 1, bush: 1, barrel: 1, crate: 1, stall: 1, lamp: 1,
    void: 1, fountain: 1, stage: 1, carousel: 1, table: 1, lily: 1 };

  GT3.World = function (L) {
    var group = new THREE.Group(); group.name = 'world';
    var ground = GT3.Ground(L), nature = GT3.Nature(L), props = GT3.Props(L);
    group.add(ground.group, nature.group, props.group);
    // the public square's fountain, stage and carousel (village v2), and the butterflies, fireflies and frogs
    var fun = GT3.Fun && L.fun ? GT3.Fun(L) : null, life = GT3.Life ? GT3.Life(L) : null;
    if (fun) group.add(fun.group);
    var boats = GT3.Boats ? GT3.Boats(L) : null; // the ferry boats at the public village's landings
    if (boats) group.add(boats.group);
    if (life) group.add(life.group);
    var buildings = (L.buildings || []).filter(function (b) { return !ground.locked(b.dx, b.dy); }).map(function (b) {
      var g = GT3.Building(b); group.add(g); return g;
    });
    var camFocus = null, camDir = new THREE.Vector3();
    var block = new Uint8Array(L.w * L.h);
    (L.buildings || []).forEach(function (b) {
      for (var y = b.y; y < b.y + (b.h || 3); y++) for (var x = b.x; x < b.x + (b.w || 3); x++) block[y * L.w + x] = 1;
    });
    var world = {
      group: group, layout: L, ground: ground, nature: nature, props: props, buildings: buildings, fun: fun, life: life,
      walkable: function (x, y) {
        if (x < 0 || y < 0 || x >= L.w || y >= L.h) return false;
        var i = y * L.w + x;
        return !SOLID[L.tiles[i]] && !block[i] && !ground.locked(x, y);
      },
      // the concert: every night from 19:00 until 01:00 (game time)
      concert: function (hour) { var h = ((hour % 24) + 24) % 24; return !!(L.fun && L.fun.stage) && (h >= 19 || h < 1); },
      update: function (t, hour, night, px, pz) {
        ground.update(t); props.update(t); props.glow(night);
        if (px === undefined && camFocus) { px = camFocus.x; pz = camFocus.z; }
        props.lights(px === undefined ? L.w / 2 : px, pz === undefined ? L.h / 2 : pz);
        if (fun) fun.update(t, night, world.concert(hour));
        if (life) life.update(t, night);
        if (boats) boats.update(t);
        buildings.forEach(function (g) { g.userData.glow(night * 1.4); if (g.userData.tick) g.userData.tick(t); });
      },
      setSeason: function (season, snowy) {
        if (S.setSeason) S.setSeason(season, snowy);
        ground.redraw(); nature.recolor();
      },
      face: function (camera) {
        if (fun) fun.face(camera);
        // where the camera looks at the ground, for the lamps' lights
        camera.getWorldDirection(camDir);
        if (camDir.y < -0.05) { var s = -camera.position.y / camDir.y; camFocus = camFocus || {}; camFocus.x = camera.position.x + camDir.x * s; camFocus.z = camera.position.z + camDir.z * s; }
      }, // the band's sprite cards turn to the camera
      dispose: function () { GT3.dispose(group); }
    };
    return world;
  };
})();
