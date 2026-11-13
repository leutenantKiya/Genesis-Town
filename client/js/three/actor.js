/*
 * actor.js - GT3.Actor(palette): one character. The 2D sprite (SPRITES.drawCharacter, 9 palettes, 4 directions, 3
 * steps) stands in the 3D world as a card that always turns to the camera, the HD-2D way, with a soft round
 * shadow on the ground. The card is lit like the world (it darkens at night and in shade) but never casts a flat
 * card-shaped shadow. Its depth is that of an upright card at its feet, so a wall behind the player never cuts into the sprite.
 *
 *   var a = GT3.Actor(3 + (SPRITES.wornCombo(defs) << 4)); scene.add(a.group);   (the worn part is optional: the Mall's cosmetics)
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

  // The card is the 12x16 sprite plus room around it for worn cosmetics (hats up to 8 px above the head, a cape, a pet or
  // a banner 4 px to each side), the sprite standing where it always stood: its feet keep their height, so a player with
  // nothing on looks exactly as before. The palette number is the look (low 4 bits) plus a worn-pieces number from
  // SPRITES.wornCombo (the rest), made by the mods that know what a player wears.
  var PAD = S && S.WORN_PAD ? S.WORN_PAD : { l: 4, t: 8, r: 4, b: 0 };
  var CW = 12 + PAD.l + PAD.r, CH = 16 + PAD.t + PAD.b;
  function frame(pal, dir, step) {
    var set = frames[pal] || (frames[pal] = {}), key = dir + step;
    if (set[key]) return set[key];
    var c = GT3.canvas(CW, CH), g = c.getContext('2d'), look = pal & 15, defs = pal >> 4 ? S.wornDefsOf(pal >> 4) : null;
    if (defs) S.drawWorn(g, PAD.l, PAD.t + 2, defs, dir, step, 'back');
    S.drawCharacter(g, PAD.l, PAD.t + 2, look, dir, step);
    if (defs) S.drawWorn(g, PAD.l, PAD.t + 2, defs, dir, step, 'front');
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
    var w = CW * PX, h = CH * PX;
    // The card leans back about a tile, so next to a wall its top half sat inside the building and the wall hid it
    // (the player "sank" into it). Each pixel takes its depth from where its camera ray crosses an upright plane at the
    // feet (facing the camera, 0.35 nearer so ground and the wall at the tile edge never win): what stands behind the
    // feet never covers the sprite, what stands in front still does. A plane, so the depth interpolates exactly.
    mat.onBeforeCompile = function (sh) {
      sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n' +
        'vec3 gtF = (modelMatrix * vec4(0.0, ' + (-(h / 2 - PX)).toFixed(4) + ', 0.0, 1.0)).xyz;\n' +
        'vec3 gtN = cameraPosition - gtF; gtN.y = 0.0; gtN = normalize(gtN); gtF += gtN * 0.35;\n' +
        'vec3 gtD = (modelMatrix * vec4(transformed, 1.0)).xyz - cameraPosition;\n' +
        'vec4 gtQ = projectionMatrix * viewMatrix * vec4(cameraPosition + gtD * (dot(gtF - cameraPosition, gtN) / dot(gtD, gtN)), 1.0);\n' +
        'gl_Position.z = gtQ.z / gtQ.w * gl_Position.w;');
    };
    mat.customProgramCacheKey = function () { return 'gt-actor-upright-depth'; };
    var card = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    card.position.y = h / 2 - 1 * PX; card.receiveShadow = true; card.name = 'actor-card';
    var pivot = new THREE.Group(); pivot.add(card); group.add(pivot);
    var sh = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.3), new THREE.MeshBasicMaterial({ map: shadow(), transparent: true, depthWrite: false }));
    sh.rotation.x = -Math.PI / 2; sh.position.y = 0.012; sh.renderOrder = 1; group.add(sh);
    group.userData.actor = true;

    return {
      group: group, card: card, material: mat,
      // a jump or fall: the card rises `lift` tiles, spins `spin` radians about its middle and squashes to `squash` of
      // its height (feet stay down); the ground shadow shrinks while it is up. pose(0, 0, 1) is standing.
      pose: function (lift, spin, squash) {
        pivot.position.y = lift || 0;
        card.rotation.z = spin || 0;
        var q = squash == null ? 1 : squash;
        card.scale.set(1 + (1 - q) * 0.6, q, 1); card.position.y = (h / 2) * q - 1 * PX;
        sh.scale.setScalar(Math.max(0.35, 1 - (lift || 0) * 0.12));
      },
      set: function (x, z, d, s) {
        group.position.set(x, 0, z);
        d = d || dir; s = s === 'sit' ? 'sit' : s | 0;
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
