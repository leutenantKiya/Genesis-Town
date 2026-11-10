/*
 * sky.js - GT3.Sky(scene, renderer): the light of the world by hour and season.
 *   - a warm key light (the sun) from the south-east that casts shadows, travelling across the day; a cool moon at night
 *   - a hemisphere fill: sky colour from above, ground bounce from below, so shaded sides stay readable, never black
 *   - the background and the distance haze in the sky's colour
 * Colours per season come from DESIGN.md (the ambient light column), so Gugur light is amber and Dingin light is blue.
 *
 *   var sky = GT3.Sky(scene, renderer); sky.set(hour, season); sky.follow(x, z)   (shadows are cast around this point)
 *   sky.night  -> 0 (day) .. 1 (deep night), for window and lamp glow
 */
(function () {
  'use strict';
  var GT3 = window.GT3;
  if (!GT3) return;
  var THREE = GT3.THREE;
  //            sun colour, sky (hemisphere top), ground bounce, background by day
  var SEASON = {
    semi:   { sun: '#fff0dc', sky: '#cfe6ff', bounce: '#7a8a5a', bg: '#9fd0f0' },
    panas:  { sun: '#ffe6bc', sky: '#d4ecff', bounce: '#7a8a4a', bg: '#8ccaf2' },
    gugur:  { sun: '#ffd09a', sky: '#f0dcc4', bounce: '#7a6440', bg: '#e8c49a' },
    dingin: { sun: '#e8f0ff', sky: '#dce8ff', bounce: '#9aa8c0', bg: '#c4d6ec' }
  };
  var NIGHT = { sun: '#9fb4ff', sky: '#2a3460', bounce: '#1a1e30', bg: '#141a34' };
  var DUSK = { sun: '#ffa060', sky: '#f0b8a0', bounce: '#5a4a50', bg: '#e89a80' };

  GT3.Sky = function (scene, renderer) {
    var hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 1.0), sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    var cam = sun.shadow.camera; cam.left = -22; cam.right = 22; cam.top = 22; cam.bottom = -22; cam.near = 1; cam.far = 80;
    sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.02;
    scene.add(hemi, sun, sun.target);
    var fog = new THREE.Fog(0xffffff, 40, 90); scene.fog = fog;
    var bg = new THREE.Color(), tmp = new THREE.Color(), tmp2 = new THREE.Color(), focus = new THREE.Vector3();
    var api = { night: 0, hemi: hemi, sun: sun };
    function mix(a, b, k, out) { return out.set(a).lerp(tmp2.set(b), k); }

    api.set = function (hour, season) {
      var P = SEASON[season] || SEASON.semi;
      // daylight 0..1 from the hour: full 8-16, ramps at dawn (5-8) and dusk (16-19.5)
      var h = ((hour % 24) + 24) % 24, day = h < 5 || h > 19.5 ? 0 : h < 8 ? (h - 5) / 3 : h > 16 ? 1 - (h - 16) / 3.5 : 1;
      var dusk = Math.max(0, 1 - Math.abs(h - 18) / 1.6) * (h > 15 ? 1 : 0) + Math.max(0, 1 - Math.abs(h - 6) / 1.2) * 0.6;
      api.night = 1 - day;
      var a = day > 0 ? P : NIGHT;
      mix(P.sun, NIGHT.sun, 1 - day, sun.color); if (dusk) sun.color.lerp(tmp.set(DUSK.sun), dusk * 0.6);
      mix(P.sky, NIGHT.sky, 1 - day, hemi.color); if (dusk) hemi.color.lerp(tmp.set(DUSK.sky), dusk * 0.35);
      mix(P.bounce, NIGHT.bounce, 1 - day, hemi.groundColor);
      mix(P.bg, NIGHT.bg, 1 - day, bg); if (dusk) bg.lerp(tmp.set(DUSK.bg), dusk * 0.5);
      // lit faces land near the art's own colours (sun + fill about pi), shaded faces keep a third of it in the sky's tint
      sun.intensity = 0.3 + 1.9 * day;
      hemi.intensity = 0.5 + 0.5 * day;
      // the sun crosses from the east (morning) to the west (evening), always a little south so fronts are lit
      var arc = (Math.min(Math.max(h, 6), 18) - 6) / 12, ang = Math.PI * arc, elev = 0.32 + Math.sin(arc * Math.PI) * 0.5;
      if (!day) { ang = Math.PI * 0.35; elev = 0.9; }
      api._dir = new THREE.Vector3(Math.cos(ang) * 0.8, elev, 0.6).normalize();
      api.follow(focus.x, focus.z);
      if (scene.background && scene.background.isColor) scene.background.copy(bg); else scene.background = bg.clone();
      fog.color.copy(bg);
      return api;
    };
    api.follow = function (x, z) {
      focus.set(x, 0, z);
      var d = api._dir || new THREE.Vector3(0.4, 0.8, 0.5);
      sun.position.set(x + d.x * 40, d.y * 40, z + d.z * 40); sun.target.position.set(x, 0, z);
      sun.target.updateMatrixWorld();
    };
    api.fogRange = function (near, far) { fog.near = near; fog.far = far; };
    return api;
  };
})();
