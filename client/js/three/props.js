/*
 * props.js - GT3.Props(L): the small solid things of a layout, as low-poly models in the 2D sprites' own colours:
 * fences (rails join the fence tiles next to them), signs, mailboxes, street lamps, barrels, crates, the market stall
 * counters with their striped awnings (L.market.stalls), and the Homeland portal (L.portal).
 *
 * Everything static is merged into one mesh; lamp heads, awnings and the portal are separate so they can glow or move.
 * Returns { group, glow(k) (0 day .. 1 night), update(t) }.
 */
(function () {
  'use strict';
  var GT3 = window.GT3;
  if (!GT3) return;
  var THREE = GT3.THREE, R = GT3.R;
  var C = {
    fence: '#d0a060', fenceD: '#8a6038', sign: '#d0a060', signFace: '#f2e2c4', ink: '#5a3c28',
    mail: '#d84848', mailD: '#9c2c30', post: '#8a6038', flag: '#f8d838',
    lamp: '#6a6c7c', lampD: '#4a4c5c', bulb: '#fff4a8',
    barrel: '#8e5a30', barrelL: '#b07840', ring: '#5a5a6e', crate: '#c08848', crateD: '#8e5a2c', crateL: '#dcaa64',
    stall: '#c08848', stallD: '#8e5a2c', stallL: '#e2b06a'
  };
  function shaded(top, side, dark) { return function (n) { return n.y > 0.5 ? top : n.y < -0.5 || n.z < -0.5 ? (dark || side) : side; }; }
  function box(parts, w, h, d, x, y, z, color, ry) { parts.push({ geo: new THREE.BoxGeometry(w, h, d), matrix: GT3.xform(x, y + h / 2, z, 1, 1, 1, ry || 0), color: color }); }
  function cyl(parts, r, h, x, y, z, color, seg) { parts.push({ geo: new THREE.CylinderGeometry(r, r, h, seg || 8), matrix: GT3.xform(x, y + h / 2, z), color: color }); }

  GT3.Props = function (L) {
    var W = L.w, H = L.h, group = new THREE.Group(), parts = [], heads = [], x, y;
    function at(xx, yy) { return xx < 0 || yy < 0 || xx >= W || yy >= H ? null : L.tiles[yy * W + xx]; }
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      var t = at(x, y), cx = x + 0.5, cz = y + 0.5;
      if (t === 'fence') {
        box(parts, 0.12, 0.62, 0.12, cx, 0, cz, shaded(C.fence, C.fence, C.fenceD));
        var e = at(x + 1, y) === 'fence', s = at(x, y + 1) === 'fence';
        [0.22, 0.44].forEach(function (ry) {
          if (e) box(parts, 1.0, 0.07, 0.05, cx + 0.5, ry, cz, shaded(C.fence, C.fenceD));
          if (s) box(parts, 0.05, 0.07, 1.0, cx, ry, cz + 0.5, shaded(C.fence, C.fenceD));
          if (!e && !s && at(x - 1, y) !== 'fence' && at(x, y - 1) !== 'fence') box(parts, 0.5, 0.07, 0.05, cx, ry, cz, shaded(C.fence, C.fenceD));
        });
      } else if (t === 'sign') {
        box(parts, 0.08, 0.7, 0.08, cx, 0, cz, C.post);
        box(parts, 0.7, 0.36, 0.08, cx, 0.46, cz, shaded(C.sign, C.signFace, C.fenceD));
        box(parts, 0.44, 0.04, 0.01, cx, 0.62, cz + 0.045, C.ink);
        box(parts, 0.32, 0.04, 0.01, cx, 0.54, cz + 0.045, C.ink);
      } else if (t === 'mailbox') {
        box(parts, 0.07, 0.5, 0.07, cx, 0, cz, C.post);
        box(parts, 0.36, 0.26, 0.26, cx, 0.5, cz, shaded(C.mail, C.mail, C.mailD));
        box(parts, 0.03, 0.22, 0.03, cx + 0.2, 0.62, cz, C.flag);
        box(parts, 0.1, 0.07, 0.03, cx + 0.24, 0.8, cz, C.flag);
      } else if (t === 'lamp') {
        cyl(parts, 0.11, 0.1, cx, 0, cz, C.lampD, 6);
        box(parts, 0.07, 1.42, 0.07, cx, 0.1, cz, shaded(C.lamp, C.lamp, C.lampD));
        box(parts, 0.36, 0.05, 0.36, cx, 1.52, cz, C.lampD);
        box(parts, 0.3, 0.06, 0.3, cx, 1.79, cz, C.lampD);
        heads.push([cx, cz]);
      } else if (t === 'barrel') {
        cyl(parts, 0.27, 0.58, cx, 0, cz, function (n) { return n.y > 0.5 ? C.barrelL : C.barrel; }, 9);
        cyl(parts, 0.285, 0.05, cx, 0.12, cz, C.ring, 9); cyl(parts, 0.285, 0.05, cx, 0.42, cz, C.ring, 9);
      } else if (t === 'crate') {
        box(parts, 0.62, 0.56, 0.62, cx, 0, cz, shaded(C.crateL, C.crate, C.crateD));
        box(parts, 0.64, 0.06, 0.64, cx, 0.5, cz, C.crateD);
        box(parts, 0.08, 0.5, 0.64, cx - 0.27, 0.03, cz, C.crateD); box(parts, 0.08, 0.5, 0.64, cx + 0.27, 0.03, cz, C.crateD);
      } else if (t === 'stall') {
        box(parts, 0.98, 0.62, 0.72, cx, 0, cz + 0.06, shaded(C.stallL, C.stall, C.stallD));
        box(parts, 1.0, 0.06, 0.76, cx, 0.62, cz + 0.06, C.stallD);
        box(parts, 0.06, 1.5, 0.06, cx - 0.46, 0, cz - 0.28, C.stallD); box(parts, 0.06, 1.5, 0.06, cx + 0.46, 0, cz - 0.28, C.stallD);
        box(parts, 0.06, 1.24, 0.06, cx - 0.46, 0, cz + 0.4, C.stallD); box(parts, 0.06, 1.24, 0.06, cx + 0.46, 0, cz + 0.4, C.stallD);
        // goods on the counter: small coloured blocks, the same four colours as the 2D counter
        ['#ffd84a', '#86c85a', '#6cc8e4', '#e8503c'].forEach(function (c, i) { box(parts, 0.14, 0.1, 0.14, cx - 0.33 + i * 0.22, 0.68, cz + 0.12, c); });
      }
    }
    var mat = GT3.mat({ vertexColors: true });
    if (parts.length) {
      var mesh = new THREE.Mesh(GT3.merge(parts), mat);
      mesh.castShadow = true; mesh.receiveShadow = true; mesh.name = 'props';
      group.add(mesh);
    }

    /* --- lamp heads: their own material so they light up at night */
    var headMat = GT3.mat({ color: C.bulb, emissive: 0xffd88a, emissiveIntensity: 0 });
    if (heads.length) {
      var hp = []; heads.forEach(function (h) { box(hp, 0.24, 0.22, 0.24, h[0], 1.57, h[1], '#ffffff'); });
      var hm = new THREE.Mesh(GT3.merge(hp), headMat); hm.castShadow = true; hm.name = 'lamp-heads';
      group.add(hm);
    }

    /* --- awnings over the market stalls, in each stall's colour */
    ((L.market && L.market.stalls) || []).forEach(function (st) {
      var c = GT3.canvas(12, 8), g = c.getContext('2d');
      for (var i = 0; i < 12; i++) R(g, i, 0, 1, 8, Math.floor(i / 3) % 2 ? '#f6f0e0' : st.color);
      R(g, 0, 7, 12, 1, 'rgba(0,0,0,0.25)');
      var a = new THREE.Mesh(GT3.quad([st.x - 0.04, 1.2, st.y + 0.9], [st.x + 1.04, 1.2, st.y + 0.9], [st.x + 1.04, 1.52, st.y + 0.18], [st.x - 0.04, 1.52, st.y + 0.18]), GT3.mat({ map: GT3.tex(c), side: THREE.DoubleSide }));
      a.castShadow = true; a.receiveShadow = true; a.name = 'awning';
      group.add(a);
    });

    /* --- the Homeland portal: a ring of standing stones round a slowly turning disc */
    var disc = null;
    if (L.portal) {
      var pp = [], px = L.portal.x + 0.5, pz = L.portal.y + 0.5;
      for (var k = 0; k < 8; k++) { var an = k / 8 * Math.PI * 2; box(pp, 0.16, 0.34 + (k % 2) * 0.14, 0.16, px + Math.cos(an) * 0.62, 0, pz + Math.sin(an) * 0.62, shaded('#c4bcb4', '#a8a098', '#807870'), an); }
      var pm = new THREE.Mesh(GT3.merge(pp), mat); pm.castShadow = true; pm.receiveShadow = true; group.add(pm);
      var dc = GT3.canvas(24, 24), dg = dc.getContext('2d');
      for (var yy = 0; yy < 24; yy++) for (var xx = 0; xx < 24; xx++) {
        var dx = xx - 11.5, dy = yy - 11.5, d = Math.sqrt(dx * dx + dy * dy); if (d > 11.5) continue;
        var sw = (Math.atan2(dy, dx) + d * 0.35) % (Math.PI / 2);
        R(dg, xx, yy, 1, 1, d > 10.5 ? '#2a2a6a' : sw < 0.5 ? '#c4b4ff' : sw < 1.1 ? '#8a7ae8' : '#5a4ab8');
      }
      var dt = GT3.tex(dc);
      disc = new THREE.Mesh(new THREE.CircleGeometry(0.5, 20), new THREE.MeshBasicMaterial({ map: dt, transparent: true, alphaTest: 0.5 }));
      disc.rotation.x = -Math.PI / 2; disc.position.set(px, 0.03, pz); disc.name = 'portal';
      group.add(disc);
    }

    return {
      group: group,
      glow: function (k) { headMat.emissiveIntensity = 1.6 * k; },
      update: function (t) { if (disc) disc.rotation.z = t * 0.6; }
    };
  };
})();
