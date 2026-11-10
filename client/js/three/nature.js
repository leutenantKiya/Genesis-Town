/*
 * nature.js - GT3.Nature(L): trees, rocks, bushes, tall grass and flowers of one layout.
 *
 * Trees, rocks and bushes are solid low-poly models (no leaf cards: a crown of cut-out cards reads as speckle from the
 * game camera), coloured from the season's ramps in art.js (PAL.leaf.oak / pine / fruit), so a season change recolours
 * them: Semi blossom, Panas fruit, Gugur orange crowns, Dingin bare oaks and snow-tipped pines. Tall grass and flowers
 * are the 2D sprites stood up as crossed cards, the way HD-2D games keep pixel art in a 3D scene; there are only as
 * many as the 2D map has, never scattered extra.
 *
 * One InstancedMesh per model kind. Returns { group, recolor() (after a season change), trees: [{x, z, kind, mesh,
 * index}], fade(tree, alpha) (the see-through pass), update(t) }.
 */
(function () {
  'use strict';
  var GT3 = window.GT3, S = window.SPRITES;
  if (!GT3) return;
  var THREE = GT3.THREE;
  var ROCK = ['#7a7a82', '#a8a8ae', '#c4c4ca', '#d4d4da'];

  function rampAt(r, i) { return r[Math.max(0, Math.min(r.length - 1, i))]; }
  /** colour a crown face by how high it sits and how much it faces up: the lit top reads as the ramp's light end */
  function crownColor(pal, y0, y1, rng) {
    return function (n, c) {
      var h = (c.y - y0) / (y1 - y0), up = n.y;
      var step = up < -0.3 ? 0 : (h > 0.62 && up > 0.25) ? 2 : 1;
      if (step === 2 && up > 0.75 && rng() < 0.35) step = 3;
      if (step === 1 && rng() < 0.12) step = 2;
      return rampAt(pal, step);
    };
  }
  function blob(r, x, y, z, sx, sy, sz, color, detail) {
    return { geo: new THREE.IcosahedronGeometry(r, detail == null ? 0 : detail), matrix: GT3.xform(x, y, z, sx, sy, sz), color: color };
  }
  function trunk(h, r) { return { geo: new THREE.CylinderGeometry(r * 0.8, r, h, 6), matrix: GT3.xform(0, h / 2, 0), color: function (n) { return n.x + n.z > 0.3 ? S.PAL.bark[2] : n.x + n.z < -0.6 ? S.PAL.bark[0] : S.PAL.bark[1]; } }; }

  /* ---------------------------------------------------------------- the models, built from the current ramps */
  var BUILD = {
    oak: function () {
      var p = S.PAL.leaf.oak, rng = GT3.rng(11), col = crownColor(p, 0.7, 1.9, rng);
      return GT3.merge([trunk(1.0, 0.1),
        blob(0.56, 0, 1.22, 0, 1, 0.92, 1, col), blob(0.4, -0.36, 1.0, 0.12, 1, 0.9, 1, col), blob(0.42, 0.36, 1.05, -0.06, 1, 0.9, 1, col), blob(0.34, 0.04, 1.58, -0.04, 1, 0.9, 1, col)]);
    },
    fruit: function () {
      var p = S.PAL.leaf.fruit, rng = GT3.rng(12), col = crownColor(p.slice(0, 3).concat([p[2]]), 0.6, 1.6, rng);
      var parts = [trunk(0.85, 0.09), blob(0.5, 0, 1.08, 0, 1, 0.88, 1, col), blob(0.34, -0.3, 0.9, 0.1, 1, 0.9, 1, col), blob(0.34, 0.3, 0.92, -0.04, 1, 0.9, 1, col)];
      var s = GT3.season();
      if (s !== 'gugur') [[-0.3, 1.15, 0.36], [0.28, 1.25, 0.32], [0.05, 0.86, 0.46], [0.42, 0.92, 0.2], [-0.42, 0.98, 0.2], [0.1, 1.42, 0.24]].forEach(function (q, i) {
        parts.push({ geo: new THREE.BoxGeometry(0.11, 0.11, 0.11), matrix: GT3.xform(q[0], q[1], q[2]), color: s === 'semi' ? p[3] : (i % 2 ? '#e8503c' : '#f29a3a') });
      });
      return GT3.merge(parts);
    },
    pine: function () {
      var p = S.PAL.leaf.pine, parts = [trunk(0.5, 0.09)];
      [[0.62, 0.55, 0.8], [0.5, 0.95, 0.72], [0.36, 1.32, 0.64]].forEach(function (t, i) {
        parts.push({ geo: new THREE.ConeGeometry(t[0], t[2], 7), matrix: GT3.xform(0, t[1] + t[2] / 2 - 0.1, 0, 1, 1, 1, i * 0.4),
          color: function (n, c) { return n.y < -0.5 ? p[0] : c.y > t[1] + t[2] * 0.62 ? (i === 2 ? p[3] : p[2]) : p[1]; } });
      });
      return GT3.merge(parts);
    },
    bare: function () {
      var p = S.PAL.leaf.oak, parts = [trunk(1.15, 0.1)];
      [[0.55, 0.9, 0.7], [-0.6, 1.0, -0.4], [0.2, 1.1, 2.4], [-0.1, 1.2, 4.0]].forEach(function (b) {
        parts.push({ geo: new THREE.BoxGeometry(0.06, 0.6, 0.06), matrix: GT3.xform(Math.sin(b[2]) * 0.18, b[1], Math.cos(b[2]) * 0.18, 1, 1, 1, b[2], 0, b[0]), color: p[1] });
        parts.push({ geo: new THREE.BoxGeometry(0.1, 0.05, 0.1), matrix: GT3.xform(Math.sin(b[2]) * 0.18 + Math.sin(b[0]) * -0.28, b[1] + 0.3, Math.cos(b[2]) * 0.18, 1, 1, 1, b[2]), color: p[3] });
      });
      parts.push(blob(0.12, 0, 1.2, 0, 1.4, 0.5, 1.4, p[3]));
      return GT3.merge(parts);
    },
    rock: function () {
      var snow = GT3.snowy();
      return GT3.merge([
        { geo: new THREE.DodecahedronGeometry(0.36, 0), matrix: GT3.xform(0, 0.16, 0, 1.1, 0.62, 0.95), color: function (n) { return n.y > 0.6 ? (snow ? '#f4f7fb' : ROCK[3]) : n.y < -0.2 ? ROCK[0] : n.x + n.z > 0 ? ROCK[2] : ROCK[1]; } },
        { geo: new THREE.DodecahedronGeometry(0.17, 0), matrix: GT3.xform(0.28, 0.08, 0.2, 1, 0.7, 1), color: function (n) { return n.y > 0.6 ? (snow ? '#f4f7fb' : ROCK[2]) : ROCK[1]; } }]);
    },
    bush: function () {
      var p = S.PAL.leaf.oak, rng = GT3.rng(13), col = crownColor(p, 0, 0.6, rng), parts = [blob(0.36, 0, 0.26, 0, 1.15, 0.78, 1, col), blob(0.22, 0.3, 0.18, 0.12, 1, 0.8, 1, col)];
      if (GT3.season() !== 'dingin') [[0.12, 0.42, 0.26], [-0.2, 0.34, 0.24], [0.3, 0.3, 0.2]].forEach(function (q) { parts.push({ geo: new THREE.BoxGeometry(0.08, 0.08, 0.08), matrix: GT3.xform(q[0], q[1], q[2]), color: '#d84a5a' }); });
      return GT3.merge(parts);
    }
  };

  /** two crossed cards carrying a 2D sprite, standing on the tile */
  function cardGeo(w, h) {
    var a = GT3.quad([-w / 2, 0, 0], [w / 2, 0, 0], [w / 2, h, 0], [-w / 2, h, 0]);
    var b = GT3.quad([0, 0, w / 2], [0, 0, -w / 2], [0, h, -w / 2], [0, h, w / 2]);
    return GT3.merge([{ geo: a }, { geo: b }]);
  }

  GT3.Nature = function (L) {
    var W = L.w, H = L.h, group = new THREE.Group(), seed = (L.seed | 0) || 1;
    var CH = L.chunk || 16, open = {};
    (L.chunks || []).forEach(function (c) { open[c.cx + ',' + c.cy] = c.open !== false; });
    function fog(x, y) { var k = Math.floor(x / CH) + ',' + Math.floor(y / CH); return k in open ? !open[k] : false; }
    var spots = { oak: [], fruit: [], pine: [], rock: [], bush: [], tallgrass: [], flower: [] };
    var x, y;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      var t = L.tiles[y * W + x], h = GT3.hash(x, y, seed);
      var item = { x: x + 0.5 + ((h % 100) / 100 - 0.5) * 0.18, z: y + 0.55 + (((h >>> 8) % 100) / 100 - 0.5) * 0.14, ry: ((h >>> 16) % 628) / 100, s: 0.88 + ((h >>> 4) % 30) / 100, fog: fog(x, y), tx: x, ty: y };
      if (t === 'tree') spots[S.treeKind(x, y, x === 0 || y === 0 || x === W - 1 || y === H - 1)].push(item);
      else if (t === 'rock' || t === 'bush' || t === 'tallgrass' || t === 'flower') { if (t === 'tallgrass' || t === 'flower') item.s = 1; spots[t].push(item); }
    }

    var meshes = {}, trees = [], m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), sc = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
    var solidMat = GT3.mat({ vertexColors: true });
    var dim = new THREE.Color(0.45, 0.43, 0.58), full = new THREE.Color(1, 1, 1);
    // a tree's size: its own scale times its growth stage (it.k: 0 = felled to a stump, then a sapling, a young tree, 1 grown)
    function scaleOf(it) { return it.k == null ? it.s : Math.max(0.0001, it.s * it.k); }
    function place(mesh, list) {
      list.forEach(function (it, i) {
        var s = scaleOf(it);
        q.setFromAxisAngle(UP, it.ry); m4.compose(v.set(it.x, 0, it.z), q, sc.set(s, s, s));
        mesh.setMatrixAt(i, m4); mesh.setColorAt(i, it.fog ? dim : full);
      });
      mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    function kindModel(k) { return (k === 'oak' || k === 'fruit') && GT3.season() === 'dingin' ? 'bare' : k; }
    function build() {
      ['oak', 'fruit', 'pine', 'rock', 'bush'].forEach(function (k) {
        var list = spots[k];
        if (!list.length) return;
        var old = meshes[k];
        var m = new THREE.InstancedMesh(BUILD[kindModel(k)](), solidMat, list.length);
        m.castShadow = true; m.receiveShadow = true; m.name = 'nature:' + k;
        place(m, list);
        if (old) { group.remove(old); old.geometry.dispose(); }
        meshes[k] = m; group.add(m);
      });
    }
    build();
    ['oak', 'fruit', 'pine'].forEach(function (k) { spots[k].forEach(function (it, i) { trees.push({ x: it.x, z: it.z, kind: k, index: i, item: it, height: k === 'pine' ? 2.0 : 1.9 }); }); });

    /* --- sprites stood up: tall grass and flowers */
    var cards = {}, cardGeoShared = cardGeo(0.75, 0.75);
    function buildCards() {
      ['tallgrass', 'flower'].forEach(function (k) {
        var list = spots[k];
        if (!list.length) return;
        var cv = GT3.tileCanvas(k, 0), tx = GT3.tex(cv);
        // the sprite's bottom rows are the tile's lower edge: trim nothing, stand it on the ground
        var mat = GT3.mat({ map: tx, alphaTest: 0.5, side: THREE.DoubleSide });
        var old = cards[k];
        var m = new THREE.InstancedMesh(cardGeoShared, mat, list.length);
        m.castShadow = true; m.receiveShadow = true; m.name = 'cards:' + k;
        place(m, list);
        if (old) { group.remove(old); old.material.map.dispose(); old.material.dispose(); }
        cards[k] = m; group.add(m);
      });
    }
    buildCards();

    /* --- the see-through pass: a faded tree is hidden in its instanced mesh and drawn by a transparent copy */
    var ghosts = {}; // tree index in `trees` -> mesh
    var ghostMat = GT3.mat({ vertexColors: true, transparent: true, opacity: 0.45, depthWrite: false });
    function setHidden(tr, hidden) {
      var m = meshes[tr.kind], it = tr.item, s = hidden ? 0.0001 : scaleOf(it);
      q.setFromAxisAngle(UP, it.ry); m4.compose(v.set(it.x, 0, it.z), q, sc.set(s, s, s));
      m.setMatrixAt(tr.index, m4); m.instanceMatrix.needsUpdate = true;
    }
    function fade(tr, alpha) {
      var id = trees.indexOf(tr), g = ghosts[id];
      if (alpha >= 0.999) {
        if (g) { group.remove(g); g.material.dispose(); delete ghosts[id]; setHidden(tr, false); }
        return;
      }
      if (!g) {
        g = new THREE.Mesh(meshes[tr.kind].geometry, ghostMat.clone());
        q.setFromAxisAngle(UP, tr.item.ry); g.quaternion.copy(q); g.position.set(tr.item.x, 0, tr.item.z); g.scale.setScalar(scaleOf(tr.item));
        g.renderOrder = 2; ghosts[id] = g; group.add(g); setHidden(tr, true);
      }
      g.material.opacity = alpha;
    }

    /* --- felled trees: a stump while the tree is spent, then it grows back by stages; the felled top falls and fades
       stage(tr, 'stump' | 'sapling' | 'young' | 'full'); fell(tr, dx, dz) drops the top away along (dx, dz); tick(dt) */
    var STAGE_K = { stump: 0, sapling: 0.4, young: 0.7, full: 1 };
    var stumpGeo = null, stumpMat = null, stumps = {}, falls = [];
    function stumpOf(tr) {
      if (!stumpGeo) {
        stumpGeo = new THREE.CylinderGeometry(0.1, 0.14, 0.22, 7); stumpGeo.translate(0, 0.11, 0);
        stumpMat = GT3.mat({ color: S.PAL.bark[1] });
      }
      var m = new THREE.Mesh(stumpGeo, stumpMat); m.castShadow = true; m.receiveShadow = true;
      m.position.set(tr.item.x, 0, tr.item.z); m.rotation.y = tr.item.ry; m.scale.setScalar(tr.item.s);
      return m;
    }
    function applyK(tr) {
      var m = meshes[tr.kind], it = tr.item, s = scaleOf(it);
      q.setFromAxisAngle(UP, it.ry); m4.compose(v.set(it.x, 0, it.z), q, sc.set(s, s, s));
      m.setMatrixAt(tr.index, m4); m.instanceMatrix.needsUpdate = true;
    }
    function stage(tr, name) {
      var id = trees.indexOf(tr), goal = STAGE_K[name];
      if (goal == null) return;
      tr.stage = name; tr.kGoal = goal;
      if (ghosts[id]) fade(tr, 1); // a see-through copy would show the old size
      if (name === 'stump') {
        if (!stumps[id]) { stumps[id] = stumpOf(tr); group.add(stumps[id]); }
        tr.item.k = 0; applyK(tr); // the felled top goes at once (fell() animates a copy of it)
      } else if (stumps[id]) { group.remove(stumps[id]); delete stumps[id]; }
    }
    function fell(tr, dx, dz) {
      var it = tr.item, mat = solidMat.clone(); mat.transparent = true;
      var m = new THREE.Mesh(meshes[tr.kind].geometry, mat); m.castShadow = true;
      var len = Math.hypot(dx, dz) || 1, axis = new THREE.Vector3(dz / len, 0, -dx / len); // tips the top toward (dx, dz)
      m.position.set(it.x, 0.2, it.z); m.scale.setScalar(it.s); group.add(m);
      falls.push({ m: m, axis: axis, yaw: new THREE.Quaternion().setFromAxisAngle(UP, it.ry), t: 0 });
    }
    var tq = new THREE.Quaternion();
    function tick(dt) {
      trees.forEach(function (tr) { // grow toward the stage size instead of popping
        var k = tr.item.k == null ? 1 : tr.item.k, d = tr.kGoal - k;
        if (tr.kGoal == null || d === 0) return;
        tr.item.k = Math.abs(d) < 0.01 ? tr.kGoal : k + d * Math.min(1, dt * 3);
        if (tr.item.k === 1) tr.item.k = null;
        applyK(tr);
      });
      for (var i = falls.length - 1; i >= 0; i--) {
        var f = falls[i]; f.t += dt;
        var u = Math.min(1, f.t / 0.8), ang = u * u * (Math.PI / 2 - 0.06); // tips over, speeding up
        if (f.t > 0.8 && f.t < 1.05) ang -= Math.sin((f.t - 0.8) / 0.25 * Math.PI) * 0.09; // a small bounce on the ground
        tq.setFromAxisAngle(f.axis, ang); f.m.quaternion.copy(tq).multiply(f.yaw);
        if (f.t > 1.4) { f.m.material.opacity = Math.max(0, 1 - (f.t - 1.4) / 0.7); f.m.position.y -= dt * 0.25; f.m.material.depthWrite = false; }
        if (f.t > 2.1) { group.remove(f.m); f.m.material.dispose(); falls.splice(i, 1); }
      }
    }

    return {
      group: group, trees: trees, fade: fade, stage: stage, fell: fell, tick: tick,
      recolor: function () {
        Object.keys(ghosts).forEach(function (id) { fade(trees[id], 1); });
        build(); buildCards();
        if (stumpMat) stumpMat.color.set(S.PAL.bark[1]);
      },
      update: function () {}
    };
  };
})();
