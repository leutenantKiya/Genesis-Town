/*
 * rig.js - GT3.Rig(camera): the follow camera. A narrow-angle perspective camera high in the south looking down at
 * about 52 degrees, the HD-2D diorama view: rows further north sit higher on screen like the 2D map, near things are
 * a little larger than far ones. It eases toward the target instead of snapping.
 *
 *   var rig = GT3.Rig(camera); rig.follow(x, z, dt)   tile units, dt in seconds
 *   rig.zoom(k)        1 = default (about 16 tiles across on a desktop), larger = closer
 *   rig.turn(rad)      orbit around the target (0 = looking north)
 */
(function () {
  'use strict';
  var GT3 = window.GT3;
  if (!GT3) return;
  var THREE = GT3.THREE;

  GT3.Rig = function (camera) {
    var target = new THREE.Vector3(), want = new THREE.Vector3(), first = true;
    var pitch = 52 * Math.PI / 180, dist = 30, zoom = 1, yaw = 0, yawWant = 0;
    camera.fov = 28; camera.near = 1; camera.far = 160; camera.updateProjectionMatrix();
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
      zoom: function (k) { zoom = Math.max(0.45, Math.min(2.4, k)); place(); return zoom; },
      getZoom: function () { return zoom; },
      turn: function (rad) { yawWant = rad; },
      target: target
    };
  };
})();
