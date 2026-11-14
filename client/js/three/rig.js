/*
 * rig.js - GT3.Rig(camera): the follow camera. A narrow-angle perspective camera high in the south looking down at
 * about 52 degrees, the HD-2D diorama view: rows further north sit higher on screen like the 2D map, near things are
 * a little larger than far ones. It eases toward the target instead of snapping.
 *
 *   var rig = GT3.Rig(camera); rig.follow(x, z, dt)   tile units, dt in seconds
 *   rig.zoom(k)        1 = default (about 16 tiles across on a desktop), larger = closer
 *   rig.turn(rad)      orbit around the target (0 = looking north)
 *   GT3.Rig(camera, { pitch, fov })   degrees; the game uses a steeper, narrower camera than the lab (mods/view3d.js)
 *   rig.distance(d)    camera distance at zoom 1, so the game can match the 2D scale
 */
(function () {
  'use strict';
  var GT3 = window.GT3;
  if (!GT3) return;
  var THREE = GT3.THREE;

  GT3.Rig = function (camera, o) {
    o = o || {};
    var target = new THREE.Vector3(), want = new THREE.Vector3(), first = true;
    var basePitch = (o.pitch || 52) * Math.PI / 180, pitch = basePitch, dist = 30, zoom = 1, yaw = 0, yawWant = 0;
    camera.fov = o.fov || 28; camera.near = 1; camera.far = 160; camera.updateProjectionMatrix();
    function place() {
      var d = dist / zoom;
      camera.position.set(target.x + Math.sin(yaw) * Math.cos(pitch) * d, Math.sin(pitch) * d, target.z + Math.cos(yaw) * Math.cos(pitch) * d);
      camera.lookAt(target.x, 0.6, target.z);
    }
    return {
      follow: function (x, z, dt) {
        want.set(x, 0, z);
        if (first) { target.copy(want); first = false; }
        var k = 1 - Math.pow(0.0015, Math.min(dt || 0.016, 0.1)); // reach 99.85% in one second
        target.lerp(want, k);
        yaw += (yawWant - yaw) * k;
        place();
      },
      snap: function () { target.copy(want); yaw = yawWant; place(); },
      zoom: function (k) { zoom = Math.max(0.45, Math.min(4, k)); place(); return zoom; }, // 4: the game's phone fit times the player's own zoom (view3d.js)
      getZoom: function () { return zoom; },
      distance: function (d) { dist = d; place(); },
      pitch: pitch,
      // the cinematic shot (sleeping, mods/view3d.js) lowers the camera by `down` radians; 0 puts it back exactly
      tilt: function (down) { pitch = basePitch - (down || 0); this.pitch = pitch; place(); },
      turn: function (rad) { yawWant = rad; },
      target: target
    };
  };
})();
