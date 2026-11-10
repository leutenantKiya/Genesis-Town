/*
 * world.js - GT3.World(L): every component for one layout (GTVillage.generate or GTHomeland.generate output), in one
 * group, plus what the renderer needs each frame.
 *
 *   var w = GT3.World(L); scene.add(w.group);
 *   w.walkable(x, y)          tile can be walked on (solid tiles and building footprints cannot)
 *   w.update(t, hour, night)  water drift, portal, window and lamp glow
 *   w.setSeason(season, snowy) swap the ramps (art.js) and recolour ground, trees, rocks and grass in place
 *   w.dispose()
 */
(function () {
  'use strict';
  var GT3 = window.GT3, S = window.SPRITES;
  if (!GT3) return;
  var THREE = GT3.THREE;
  var SOLID = { tree: 1, fence: 1, sign: 1, mailbox: 1, rock: 1, water: 1, bush: 1, barrel: 1, crate: 1, stall: 1, lamp: 1 };

  GT3.World = function (L) {
    var group = new THREE.Group(); group.name = 'world';
    var ground = GT3.Ground(L), nature = GT3.Nature(L), props = GT3.Props(L);
    group.add(ground.group, nature.group, props.group);
    var buildings = (L.buildings || []).filter(function (b) { return !ground.locked(b.dx, b.dy); }).map(function (b) {
      var g = GT3.Building(b); group.add(g); return g;
    });
    var block = new Uint8Array(L.w * L.h);
    (L.buildings || []).forEach(function (b) {
      for (var y = b.y; y < b.y + (b.h || 3); y++) for (var x = b.x; x < b.x + (b.w || 3); x++) block[y * L.w + x] = 1;
    });
    var world = {
      group: group, layout: L, ground: ground, nature: nature, props: props, buildings: buildings,
      walkable: function (x, y) {
        if (x < 0 || y < 0 || x >= L.w || y >= L.h) return false;
        var i = y * L.w + x;
        return !SOLID[L.tiles[i]] && !block[i] && !ground.locked(x, y);
      },
      update: function (t, hour, night) {
        ground.update(t); props.update(t); props.glow(night);
        buildings.forEach(function (g) { g.userData.glow(night * 1.4); });
      },
      setSeason: function (season, snowy) {
        if (S.setSeason) S.setSeason(season, snowy);
        ground.redraw(); nature.recolor();
      },
      dispose: function () { GT3.dispose(group); }
    };
    return world;
  };
})();
