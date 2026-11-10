/*
 * actor.js - GT3.Actor(palette): one character. The 2D sprite (SPRITES.drawCharacter, 9 palettes, 4 directions, 3
 * steps) stands in the 3D world as a card that always turns to the camera, the HD-2D way, with a soft round
 * shadow on the ground. The card is lit like the world (it darkens at night and in shade) but never casts a flat
 * card-shaped shadow.
 *
 *   var a = GT3.Actor(3); scene.add(a.group);
 *   a.set(x, z, dir, step)    tile units (feet at x, z), dir: up | down | left | right, step 0..2
 *   a.face(camera)            turn the card to the camera (call every frame)
 */
(function () {
  'use strict';
  var GT3 = window.GT3, S = window.SPRITES;
  if (!GT3) return;
  var THREE = GT3.THREE, PX = GT3.PX;
  var frames = {}; // palette -> {dir+step: texture}
  var shadowTex = null;

  function frame(pal, dir, step) {
    var set = frames[pal] || (frames[pal] = {}), key = dir + step;
    if (set[key]) return set[key];
    var c = GT3.canvas(12, 16); S.drawCharacter(c.getContext('2d'), 0, 2, pal, dir, step);
    var t = GT3.tex(c); t.userData.shared = true;
    return (set[key] = t);
  }
  function shadow() {
    if (shadowTex) return shadowTex;
    var c = GT3.canvas(16, 8), g = c.getContext('2d');
    for (var y = 0; y < 8; y++) for (var x = 0; x < 16; x++) {
      var dx = (x - 7.5) / 7.5, dy = (y - 3.5) / 3.5, d = dx * dx + dy * dy;
      if (d <= 1) { g.fillStyle = 'rgba(20,18,40,' + (d < 0.45 ? 0.34 : 0.2) + ')'; g.fillRect(x, y, 1, 1); }
    }
    shadowTex = GT3.tex(c); shadowTex.userData.shared = true;
    return shadowTex;
  }

  GT3.Actor = function (palette) {
    var group = new THREE.Group(), pal = palette | 0, dir = 'down', step = 0;
    var mat = GT3.mat({ map: frame(pal, dir, step), alphaTest: 0.5, side: THREE.DoubleSide });
    var w = 12 * PX, h = 16 * PX;
    var card = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    card.position.y = h / 2 - 1 * PX; card.receiveShadow = true; card.name = 'actor-card';
    var pivot = new THREE.Group(); pivot.add(card); group.add(pivot);
    var sh = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.3), new THREE.MeshBasicMaterial({ map: shadow(), transparent: true, depthWrite: false }));
    sh.rotation.x = -Math.PI / 2; sh.position.y = 0.012; sh.renderOrder = 1; group.add(sh);
    group.userData.actor = true;

    return {
      group: group, card: card, material: mat,
      set: function (x, z, d, s) {
        group.position.set(x, 0, z);
        d = d || dir; s = s | 0;
        if (d !== dir || s !== step) { dir = d; step = s; mat.map = frame(pal, dir, step); mat.needsUpdate = true; }
      },
      // turn to the camera and lean back by its pitch, pivoting at the feet: from the high game camera an upright card
      // would show as a squashed head, a leaning one shows the whole sprite at its drawn proportions
      face: function (camera) {
        var dx = camera.position.x - group.position.x, dz = camera.position.z - group.position.z;
        pivot.rotation.order = 'YXZ';
        pivot.rotation.y = Math.atan2(dx, dz);
        pivot.rotation.x = -Math.atan2(camera.position.y - group.position.y, Math.hypot(dx, dz));
      },
      dispose: function () { card.geometry.dispose(); mat.dispose(); sh.geometry.dispose(); sh.material.dispose(); if (group.parent) group.parent.remove(group); }
    };
  };
})();
