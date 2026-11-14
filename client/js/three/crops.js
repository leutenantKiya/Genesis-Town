/*
 * crops.js - GT3.Crops(L): the wheat on the farm plots in the 2.5D view, standing up. Each planted plot is two crossed
 * upright cards (seen from any camera angle) with the stage's stalks painted on; the cards lean with the wind from their
 * foot. The crops come from window.GT_CROPS() (mods/chain.js): [{ x, y, stage 0-6, ripe }] for the plots in this world,
 * the same stages the 2D view draws on the ground.
 */
(function () {
  'use strict';
  var GT3 = window.GT3 = window.GT3 || {};
  var STAGES = 7, CW = 12, CH = 14;

  // one texture per stage (0-6 growing, 7 ripe): green sprouts, taller and yellower each stage, ripe tall and golden
  // with a grain head. Drawn bottom up so the card's foot is the plot's soil.
  var texCache = null;
  function textures() {
    if (texCache) return texCache;
    texCache = [];
    for (var s = 0; s <= STAGES; s++) {
      var ripe = s === STAGES, c = GT3.canvas(CW, CH), g = c.getContext('2d');
      var h = ripe ? 12 : 2 + s * 1.4;
      var body = ripe ? '#c99a2e' : s < 4 ? '#3f9a3c' : s < 6 ? '#7aae35' : '#b2b432';
      var tip = ripe ? '#f2d24a' : s < 4 ? '#7cc23e' : s < 6 ? '#a8d44a' : '#d6c940';
      [1, 4, 7, 10].forEach(function (bx, k) {
        if (s === 0 && k % 2) return; // the youngest stage: two sprouts
        var hk = Math.max(1, Math.round(h - (k % 2 ? 1 : 0))), low = Math.max(1, Math.floor(hk / 2));
        g.fillStyle = body; g.fillRect(bx, CH - low, 1, low);
        g.fillStyle = tip; g.fillRect(bx, CH - hk, 1, hk - low);
        if (ripe) { g.fillStyle = '#f7e27a'; g.fillRect(bx - 1, CH - hk - 1, 3, 2); }
        else if (s >= 2) { g.fillStyle = tip; g.fillRect(bx - 1, CH - hk + 1, 1, 1); g.fillRect(bx + 1, CH - hk + 1, 1, 1); }
      });
      var t = GT3.tex(c); t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
      texCache.push(new THREE.MeshBasicMaterial({ map: t, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide }));
    }
    return texCache;
  }

  GT3.Crops = function (L) {
    var group = new THREE.Group(); group.name = 'crops';
    var plane = new THREE.PlaneGeometry(0.9, 0.9 * CH / CW); plane.translate(0, 0.45 * CH / CW, 0); // foot at y = 0
    var live = {}; // "x,y" -> { root, a, b, stage }
    function make(x, y) {
      var root = new THREE.Group(), mats = textures();
      var a = new THREE.Mesh(plane, mats[0]), b = new THREE.Mesh(plane, mats[0]);
      a.rotation.y = Math.PI / 4; b.rotation.y = -Math.PI / 4;
      root.add(a, b); root.position.set(x + 0.5, 0.02, y + 0.5);
      group.add(root);
      return { root: root, a: a, b: b, stage: -1, seed: (x * 7 + y * 13) % 17 };
    }
    return {
      group: group,
      update: function (t) {
        var list = (window.GT_CROPS && window.GT_CROPS()) || [], seen = {};
        for (var i = 0; i < list.length; i++) {
          var c = list[i], k = c.x + ',' + c.y; seen[k] = 1;
          var e = live[k] || (live[k] = make(c.x, c.y)), st = c.ripe ? STAGES : Math.max(0, Math.min(STAGES - 1, c.stage | 0));
          if (e.stage !== st) { var m = textures()[st]; e.a.material = m; e.b.material = m; e.stage = st; }
          // the wind leans the stalks from their foot; the youngest stage stands still
          var amp = st === 0 ? 0 : st < 4 ? 0.05 : 0.09;
          e.root.rotation.z = Math.sin(t * 2.4 + e.seed) * amp;
          e.root.rotation.x = Math.sin(t * 1.9 + e.seed * 1.7) * amp * 0.6;
        }
        for (var key in live) if (!seen[key]) { group.remove(live[key].root); delete live[key]; }
      }
    };
  };
})();
