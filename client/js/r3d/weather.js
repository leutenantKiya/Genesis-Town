/*
 * r3d/weather.js - rain and snow as real 3D particles in a volume that follows the player. The weather kind comes from the
 * game's own weather class on <html> (gt-w-hujan, gt-w-salju, ...) which chain.js keeps in step with the server, so every
 * player sees the same weather. Rain = falling streaks, snow = drifting flakes. Particle counts follow the quality setting.
 * (Overcast sky, darker light and the colour mood are handled in core.js, sky.js and CSS.)
 */
(function () {
  'use strict';
  var R3D = window.R3D = window.R3D || {};
  var THREE = window.THREE;
  if (!THREE) return;

  var kind = null, obj = null, mat = null, SPAN = 44, HEIGHT = 22;

  var RAIN_VS = [
    'attribute vec3 aOff; attribute float aEnd; attribute float aSpeed;',
    'uniform float uTime; uniform vec3 uCenter; uniform float uSpan; uniform float uHeight;',
    'void main(){',
    '  vec3 p = aOff;',
    '  p.x = uCenter.x + mod(p.x - uCenter.x + uSpan * 0.5, uSpan) - uSpan * 0.5;',
    '  p.z = uCenter.z + mod(p.z - uCenter.z + uSpan * 0.5, uSpan) - uSpan * 0.5;',
    '  p.y = mod(p.y - uTime * aSpeed, uHeight);',
    '  p += vec3(-0.4, 1.6, -0.2) * aEnd;',
    '  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);',
    '}'
  ].join('\n');
  var RAIN_FS = 'void main(){ gl_FragColor = vec4(0.78, 0.88, 1.0, 0.75); }';

  var SNOW_VS = [
    'attribute vec3 aOff; attribute float aSpeed;',
    'uniform float uTime; uniform vec3 uCenter; uniform float uSpan; uniform float uHeight; uniform float uSize;',
    'void main(){',
    '  vec3 p = aOff;',
    '  float sway = sin(uTime * 0.8 + aOff.x * 3.1 + aOff.z) * 0.6;',
    '  p.x = uCenter.x + mod(p.x + sway - uCenter.x + uSpan * 0.5, uSpan) - uSpan * 0.5;',
    '  p.z = uCenter.z + mod(p.z + cos(uTime * 0.6 + aOff.z * 2.3) * 0.5 - uCenter.z + uSpan * 0.5, uSpan) - uSpan * 0.5;',
    '  p.y = mod(p.y - uTime * aSpeed, uHeight);',
    '  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);',
    '  gl_PointSize = uSize * (0.7 + aSpeed * 0.6);',
    '}'
  ].join('\n');
  var SNOW_FS = 'void main(){ gl_FragColor = vec4(1.0, 1.0, 1.0, 0.92); }';

  function weatherKind() {
    var c = document.documentElement.classList;
    return c.contains('gt-w-hujan') ? 'hujan' : c.contains('gt-w-salju') ? 'salju' : null;
  }

  function clear(C) {
    if (obj) { C.scene.remove(obj); obj.geometry.dispose(); }
    if (mat) mat.dispose();
    obj = mat = null; kind = null;
  }

  function build(C, k) {
    clear(C);
    kind = k;
    if (!k) return;
    var Q = R3D.Q || { rain: 300, snow: 250 }, n = k === 'hujan' ? Q.rain : Q.snow, i;
    var off = new Float32Array(n * (k === 'hujan' ? 2 : 1) * 3), speed = new Float32Array(n * (k === 'hujan' ? 2 : 1)), end = new Float32Array(n * 2);
    var cx = 0;
    for (i = 0; i < n; i++) {
      var x = Math.random() * 400, y = Math.random() * HEIGHT, z = Math.random() * 400, s = k === 'hujan' ? 14 + Math.random() * 8 : 0.7 + Math.random() * 0.9;
      if (k === 'hujan') {
        off.set([x, y, z, x, y, z], i * 6); speed[i * 2] = speed[i * 2 + 1] = s; end[i * 2] = 0; end[i * 2 + 1] = 1; // second vertex trails above and behind
      } else { off.set([x, y, z], i * 3); speed[i] = s; }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((k === 'hujan' ? n * 2 : n) * 3), 3));
    g.setAttribute('aOff', new THREE.BufferAttribute(off, 3));
    g.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
    var uni = { uTime: { value: 0 }, uCenter: { value: new THREE.Vector3() }, uSpan: { value: SPAN }, uHeight: { value: HEIGHT } };
    if (k === 'hujan') {
      g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
      mat = new THREE.ShaderMaterial({ uniforms: uni, vertexShader: RAIN_VS, fragmentShader: RAIN_FS, transparent: true, depthWrite: false });
      obj = new THREE.LineSegments(g, mat);
    } else {
      uni.uSize = { value: 3 * Math.min(window.devicePixelRatio || 1, 2) };
      mat = new THREE.ShaderMaterial({ uniforms: uni, vertexShader: SNOW_VS, fragmentShader: SNOW_FS, transparent: true, depthWrite: false });
      obj = new THREE.Points(g, mat);
    }
    obj.frustumCulled = false; obj.renderOrder = 6;
    C.scene.add(obj);
  }

  R3D.weather = {
    init: function (C) { obj = mat = null; kind = null; },
    onWorld: function () {},
    onQuality: function (C) { if (kind) build(C, kind); },
    update: function (C, info) {
      var k = weatherKind();
      if (k !== kind) build(C, k);
      if (!obj) return;
      var u = mat.uniforms, reduce = info.reduce;
      u.uTime.value = reduce ? 0 : info.timeAcc;
      u.uCenter.value.set((info.player.pos.px + 6) / 12, 0, (info.player.pos.py + 6) / 12);
    },
    dispose: function (C) { clear(C); }
  };
})();
