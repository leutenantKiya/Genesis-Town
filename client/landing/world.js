/*
 * landing/world.js - the game's own 2.5D world, live, for the landing page.
 *
 * It loads the very files the game's 2.5D view runs (vendor/three.js, the sprite art, the village and Homeland
 * generators and the world kit in js/three/) and plays one layout in a canvas: villagers walk the paths and bridges,
 * water and waterfalls run, clouds drift under the islands, the camera settles in and then turns a few degrees.
 * Nothing here is game state, nothing calls the server, and no game file is changed.
 *
 *   var view = GTWorld.mount(canvas, { map: 'homeland' | 'village', shot: {...}, people: 12, intro: true, drift: true });
 *   view.ready            a promise: the first frame is on the canvas (rejects when WebGL or the kit is missing)
 *   view.season(name)     semi | panas | gugur | dingin: the world recolours in place, as in the game
 *   view.hour(h, smooth)  0..24: sun, window glow, lamps, fireflies (smooth: the sky runs there in about a second)
 *   view.turn(steps)      orbit by 45 degrees a step, eased, snapping to the 45-degree stops (the game's Q and E)
 *   view.nudge(deg)       orbit by any angle (a drag); turning stops the camera's idle sway
 *   view.auto({ spin, time, season, on })  a tour: the camera turns spin degrees a second (it rests 2.5 s after a
 *                         drag or a turn, then picks up again), the clock runs (days fast, nights faster) and the
 *                         season moves on at 02:00; on(state) hears each new season and each dawn and dusk
 *   view.pause(on)        stop or resume the loop (the still stays on the canvas)
 *   view.dispose()
 *
 * A shot is { tx, tz (the tile looked at), dist, yaw, pitch (degrees), fov, hour, season }.
 * GTWorld.shots holds the named ones the page and its stills use.
 */
(function () {
  'use strict';
  var me = document.currentScript, BASE = (me && me.getAttribute('data-game')) || '../';
  var FILES = ['vendor/three.js', 'js/sprites.js', 'js/art.js', 'js/buildings.js', 'js/world/village.js', 'js/world/homeland.js',
    'js/three/kit.js', 'js/three/ground.js', 'js/three/building.js', 'js/three/nature.js', 'js/three/props.js', 'js/three/actor.js',
    'js/three/sky.js', 'js/three/fun.js', 'js/three/life.js', 'js/three/world.js'];
  var SEASONS = ['semi', 'panas', 'gugur', 'dingin'], WORLD_SEED = 20261114, HOME_SEED = 1234567;
  var ALL = ['c', 'n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'];
  var loading = null;

  function script(src) {
    return new Promise(function (ok, no) {
      var s = document.createElement('script'); s.src = BASE + src; s.async = false;
      s.onload = ok; s.onerror = function () { no(new Error('missing ' + src)); };
      document.head.appendChild(s);
    });
  }
  function load() {
    if (!loading) loading = FILES.reduce(function (p, f) { return p.then(function () { return script(f); }); }, Promise.resolve())
      .then(function () { if (!window.THREE || !window.GT3 || !window.GT3.World) throw new Error('the 2.5D kit did not load'); });
    return loading;
  }

  // a Homeland with all nine islands open and every lot built, or the shared village
  function layout(map, seed) {
    if (map === 'village') { var V = window.GTVillage.generate(seed || WORLD_SEED); V.seed = V.seed || seed || WORLD_SEED; return V; }
    var first = window.GTHomeland.generate(seed || HOME_SEED, { th: 5, open: ALL, built: [] });
    var built = (first.lots || []).map(function (l) { return { lot: l.id, kind: l.kind }; });
    var L = window.GTHomeland.generate(seed || HOME_SEED, { th: 5, open: ALL, built: built });
    L.seed = L.seed || seed || HOME_SEED;
    return L;
  }

  var SHOTS = {
    // the hero: the whole Homeland, nine islands over the clouds
    // (centre: the camera looks at the middle of the land, worked out from the map, so the islands sit in the frame's centre)
    home: { map: 'homeland', centre: true, ox: -1.3, oz: 0.9, ty: -8, dist: 84, yaw: 34, pitch: 29, hour: 9.5, season: 'semi', people: 16, reach: 26, shadow: 36,
      narrow: { dist: 104, ty: -13 },   // a stage under 1.8:1 (a phone's hero): further back, and up clear of its control tray
      phone: { dist: 96, pitch: 38, yaw: 34 } }
  };

  function ease(t) { t = Math.max(0, Math.min(1, t)); return 1 - Math.pow(1 - t, 4); }
  function hash(a, b, c) { var h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 1274126177)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }

  function mount(el, opts) {
    opts = opts || {};
    // a <video> host: the world renders on a canvas that is never in the page and plays in the video as a stream, so the
    // page holds one picture layer (the video, its poster the still) and the still stays until the first frame is drawn
    var vid = el.tagName === 'VIDEO' ? el : null, canvas = vid ? document.createElement('canvas') : el, host = vid || el.parentNode;
    var base = opts.shot || SHOTS.home, shot = {}, k; for (k in base) shot[k] = base[k];
    var api = { canvas: canvas, state: 'loading' }, disposed = false, paused = false, visible = true;
    var THREE, GT3, renderer, scene, camera, sky, world, L, people = [], raf = 0, last = 0, clock = 0, born = 0;
    var season = shot.season || 'semi', hour = shot.hour == null ? 9.5 : shot.hour, yawWant = shot.yaw || 0, yaw = yawWant, wantSeason = null,
      hourWant = hour, sway = 1, swayWant = 1, sized = false,
      auto = { spin: 0, time: false, season: false, on: null }, spinK = 0, touched = -1e9, seasonAt = 0, told = '';
    var readyOk, readyNo; api.ready = new Promise(function (a, b) { readyOk = a; readyNo = b; });
    api.ready.catch(function () { /* the still stays */ });

    function size() {
      var box = host.getBoundingClientRect(), w = Math.max(2, Math.round(box.width)), h = Math.max(2, Math.round(box.height));
      // a tall screen (a phone) frames the islands from its own spot
      var tall = h > w * 1.05, src = tall && base.phone ? base.phone : w < h * 1.8 && base.narrow ? base.narrow : {};
      ['tx', 'tz', 'ty', 'dist', 'yaw', 'pitch'].forEach(function (n) { shot[n] = src[n] != null ? src[n] : base[n]; });
      sky.fogRange(shot.dist * 1.05, shot.dist * 3.2); // the haze starts past the islands at any framing
      if (!sized && (!tall || !base.phone || !base.phone.yaw)) yawWant = shot.yaw || 0; // a turn the viewer made outlives a resize
      sized = true;
      // about 1.6 megapixels at most, and never more than 1.5 device pixels a CSS pixel
      var pr = Math.min(window.devicePixelRatio || 1, 1.5, Math.sqrt(1.6e6 / (w * h)));
      renderer.setPixelRatio(Math.max(0.75, pr)); renderer.setSize(w, h, false);
      camera.aspect = w / h; camera.updateProjectionMatrix();
    }
    function place(y, pitchDeg, dist) {
      var p = pitchDeg * Math.PI / 180, a = y * Math.PI / 180;
      camera.position.set(shot.tx + Math.sin(a) * Math.cos(p) * dist, Math.sin(p) * dist + (shot.ty || 0), shot.tz + Math.cos(a) * Math.cos(p) * dist);
      camera.lookAt(shot.tx, shot.ty || 0, shot.tz);
    }

    /* ---- villagers: they stroll tile to tile, liking paths, bridges and the square more than grass */
    var DIRS = [[0, 1, 'down'], [0, -1, 'up'], [1, 0, 'right'], [-1, 0, 'left']];
    function liked(x, y) { var t = L.tiles[y * L.w + x]; return t === 'path' || t === 'bridge' || t === 'plaza' ? 3 : t === 'sand' ? 0.5 : 1; }
    function makePeople(n) {
      var spots = [], x, y;
      for (y = 1; y < L.h - 1; y++) for (x = 1; x < L.w - 1; x++) {
        if (!world.walkable(x, y)) continue;
        var d = Math.hypot(x - shot.tx, y - shot.tz), w = liked(x, y);
        if (d < (shot.reach || 22) && (w > 1 || hash(x, y, 3) < 0.12)) spots.push([x, y, hash(x, y, 7)]);
      }
      spots.sort(function (a, b) { return a[2] - b[2]; });
      for (var i = 0; i < n && i < spots.length; i++) {
        var a = GT3.Actor(i % 8); scene.add(a.group);
        people.push({ a: a, x: spots[i][0], y: spots[i][1], tx: spots[i][0], ty: spots[i][1], p: 1, dir: 'down', wait: spots[i][2] * 3, id: i + 1, t: 0 });
      }
    }
    function stepPeople(dt, tick) {
      for (var i = 0; i < people.length; i++) {
        var n = people[i];
        if (n.p < 1) {
          n.p = Math.min(1, n.p + dt * 1.9); n.t += dt;
          if (n.p >= 1) { n.x = n.tx; n.y = n.ty; n.wait = hash(n.id, tick, 5) < 0.28 ? 0.8 + hash(n.id, tick, 6) * 3 : 0; }
        } else if (n.wait > 0) { n.wait -= dt; n.t = 0; }
        else {
          var best = null, bw = -1;
          for (var d = 0; d < 4; d++) {
            var nx = n.x + DIRS[d][0], ny = n.y + DIRS[d][1];
            if (!world.walkable(nx, ny)) continue;
            var w = liked(nx, ny) * (DIRS[d][2] === n.dir ? 3 : 1) * (0.4 + hash(n.id * 7 + d, tick, 9));
            if (w > bw) { bw = w; best = DIRS[d]; }
          }
          if (best) { n.tx = n.x + best[0]; n.ty = n.y + best[1]; n.dir = best[2]; n.p = 0; } else n.wait = 1;
        }
        var px = n.x + (n.tx - n.x) * n.p + 0.5, pz = n.y + (n.ty - n.y) * n.p + 0.55;
        n.a.set(px, pz, n.dir, n.p < 1 ? [1, 0, 2, 0][Math.floor(n.t * 8) % 4] : 0);
        n.a.face(camera);
      }
    }

    function frame(now) {
      raf = 0;
      if (disposed) return;
      var dt = Math.min(0.1, (now - last) / 1000 || 0.016); last = now;
      if (wantSeason && wantSeason !== season) { season = wantSeason; world.setSeason(season, season === 'dingin'); }
      wantSeason = null;
      clock += dt;
      tour(dt);
      var kTurn = 1 - Math.pow(0.002, dt); yaw += (yawWant - yaw) * kTurn;
      // an hour asked for smoothly runs the sky round the short way (day to night in about a second)
      if (hour !== hourWant) { var dh = ((hourWant - hour + 36) % 24) - 12; hour = Math.abs(dh) < 0.02 ? hourWant : (hour + dh * (1 - Math.pow(0.01, dt)) + 24) % 24; }
      sway += (swayWant - sway) * (1 - Math.pow(0.05, dt)); // the sway stops once the viewer takes the camera
      // the camera comes down out of the sky once, then turns a few degrees back and forth
      var intro = opts.intro ? ease((clock - 0.1) / 2.8) : 1;
      var drift = opts.drift && !auto.spin ? Math.sin(clock * 2 * Math.PI / 38) * 5 * intro * sway : 0;
      place(yaw + drift - (1 - intro) * 38, shot.pitch + (1 - intro) * 16, shot.dist * (1 + (1 - intro) * 0.42));
      sky.set(hour, season); sky.follow(shot.tx, shot.tz);
      world.update(clock, hour, sky.night);
      if (world.face) world.face(camera);
      stepPeople(dt, Math.floor(clock * 0.8));
      renderer.render(scene, camera);
      if (api.state !== 'live' && clock > 0.25) {
        api.state = 'live'; el.setAttribute('data-live', ''); readyOk(api);
        if (vid && canvas.captureStream) { try { vid.srcObject = canvas.captureStream(30); var pr = vid.play(); if (pr && pr.catch) pr.catch(function () { /* the poster stays */ }); } catch (e) { /* the poster stays */ } }
      }
      if (opts.still && clock > 0.4) return; // a still: a few frames, then it rests
      if (!paused && visible) raf = requestAnimationFrame(frame);
      else if (hour !== hourWant) { hour = hourWant; }
    }
    // the tour: the camera turns, the clock runs and the seasons go round, each until the viewer takes it over
    function tour(dt) {
      if (auto.spin) {
        var want = clock - touched > 2.5 ? 1 : 0;
        spinK += (want - spinK) * (1 - Math.pow(want ? 0.3 : 1e-5, dt)); // picks up over about 2 s, stops at once
        yawWant += auto.spin * spinK * dt * (opts.intro ? ease((clock - 1.2) / 2) : 1);
      }
      var next = false;
      if (auto.time) {
        var h0 = hourWant, night = h0 >= 19 || h0 < 6;
        hourWant = (h0 + (night ? 1.5 : 0.75) * dt) % 24; // a day of about 17 s, a night of about 7 s
        if (h0 < 2 && hourWant >= 2) next = true; // a new season comes in the dark, and the dawn shows it
      } else if (clock - seasonAt > 24) next = true;
      if (next) seasonAt = clock;
      if (next && auto.season) { var cur = wantSeason || season; wantSeason = SEASONS[(SEASONS.indexOf(cur) + 1) % SEASONS.length]; }
      var s = wantSeason || season, nt = hourWant >= 19 || hourWant < 6, key = s + (nt ? 'n' : 'd');
      if (key !== told) { told = key; if (auto.on) auto.on({ season: s, night: nt, hour: hourWant }); }
    }
    function kick() { if (!raf && !disposed && !paused && visible && renderer) { last = performance.now(); raf = requestAnimationFrame(frame); } }

    load().then(function () {
      if (disposed) return;
      THREE = window.THREE; GT3 = window.GT3;
      renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, powerPreference: 'high-performance' });
      renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
      scene = new THREE.Scene(); camera = new THREE.PerspectiveCamera(shot.fov || 28, 1, 1, 420);
      sky = GT3.Sky(scene, renderer);
      var R = shot.shadow || 30, sc = sky.sun.shadow.camera; sc.left = -R; sc.right = R; sc.top = R; sc.bottom = -R; sc.far = 140; sc.updateProjectionMatrix();
      if (window.SPRITES.setSeason) window.SPRITES.setSeason(season, season === 'dingin');
      L = layout(shot.map, opts.seed);
      if (base.centre) { // the middle of the land's bounding box (every tile but open sky)
        var x0 = L.w, x1 = 0, y0 = L.h, y1 = 0;
        for (var ty = 0; ty < L.h; ty++) for (var tx = 0; tx < L.w; tx++) { var tt = L.tiles[ty * L.w + tx]; if (tt && tt !== 'void') { if (tx < x0) x0 = tx; if (tx > x1) x1 = tx; if (ty < y0) y0 = ty; if (ty > y1) y1 = ty; } }
        // ox, oz: a small offset, as the perspective draws the near islands larger than the far ones
        base = Object.assign({}, base, { tx: (x0 + x1 + 1) / 2 + (base.ox || 0), tz: (y0 + y1 + 1) / 2 + (base.oz || 0) });
        if (base.phone) base.phone = Object.assign({ tx: base.tx, tz: base.tz }, base.phone);
        shot.tx = base.tx; shot.tz = base.tz;
      }
      world = GT3.World(L); scene.add(world.group);
      makePeople(shot.people == null ? (opts.people || 0) : shot.people);
      size();
      if (window.ResizeObserver) new ResizeObserver(function () { if (!disposed) { size(); if (!raf) { renderer.render(scene, camera); } } }).observe(host);
      if (window.IntersectionObserver && !opts.still) new IntersectionObserver(function (es) { visible = es[0].isIntersecting; kick(); }, { rootMargin: '120px' }).observe(host);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) kick(); });
      canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); paused = true; el.removeAttribute('data-live'); if (vid) vid.srcObject = null; });
      if (opts.still) clock = opts.intro ? 6 : 1;
      born = performance.now(); kick();
    }).catch(function (e) { api.state = 'failed'; readyNo(e); });

    api.season = function (s) { if (SEASONS.indexOf(s) >= 0) { wantSeason = s; kick(); } return api; };
    api.hour = function (h, smooth) { hourWant = ((+h % 24) + 24) % 24; if (!smooth || paused) hour = hourWant; kick(); return api; };
    api.turn = function (steps) { swayWant = 0; touched = clock; yawWant = Math.round((yawWant + 45 * steps - (shot.yaw || 0)) / 45) * 45 + (shot.yaw || 0); kick(); return api; };
    api.nudge = function (deg) { swayWant = 0; touched = clock; yawWant += deg; kick(); return api; };
    api.pause = function (on) { paused = !!on; if (!paused) kick(); return api; };
    api.auto = function (o) { for (var k in o) if (k in auto) auto[k] = o[k]; if (o.season === false || o.time) seasonAt = clock; kick(); return api; };
    api.hold = function () { touched = clock; return api; };
    api.get = function () { return { season: wantSeason || season, hour: hourWant, night: hourWant >= 19 || hourWant < 6, yaw: yawWant, paused: paused }; };
    api.dispose = function () { disposed = true; if (raf) cancelAnimationFrame(raf); if (world) world.dispose(); people.forEach(function (n) { n.a.dispose(); }); if (renderer) renderer.dispose(); };
    return api;
  }

  window.GTWorld = { mount: mount, load: load, shots: SHOTS, SEASONS: SEASONS };
})();
