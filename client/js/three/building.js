/*
 * building.js - GT3.Building(b): one building as a 3D model. b is a building record from the layout
 * ({ kind, x, y, w, h, dx, dy, style? }): the model stands on the footprint, its front on the south edge (where the
 * door tile is), so nothing about footprints, doors or collision changes.
 *
 * The front wall carries the game's own 2D facade (door, windows, sign, awning: SPRITES.drawPublic / drawHouse), cut
 * below the painted roof band. Side and back walls, the gabled roof and the gables are generated from the same style
 * colours. By kind: a bell tower (church), a flag (hall, townhall), a cloth awning (warung, restoran), a chimney
 * (house styles that have one). Windows glow at night (glow(0..1)).
 *
 * Returns a THREE.Group with userData: { building: b, box (THREE.Box3, world space), mats (every material, for the
 * see-through fade), glow(k), door: {x, z} }.
 */
(function () {
  'use strict';
  var GT3 = window.GT3, S = window.SPRITES;
  if (!GT3) return;
  var THREE = GT3.THREE, TILE = GT3.TILE, PX = GT3.PX, R = GT3.R, OL = '#2a2430';

  function styleOf(b) {
    var pub = S.PUBLIC_STYLE && S.PUBLIC_STYLE[b.kind];
    if (pub) return { st: pub, pub: true };
    var hs = S.HOUSE_STYLES || [];
    return { st: hs[(((b.style | 0) % hs.length) + hs.length) % hs.length] || { roof: '#b8442e', roofD: '#7a2a22', roofL: '#e2774a', wall: '#f2e2c4', wallD: '#d8bc94' }, pub: false };
  }

  /** Side and back walls: siding lines and the stone foot of the 2D wall; tiles sideways every 12 px. */
  function wallCanvas(hPx, st) {
    var c = GT3.canvas(TILE, hPx), g = c.getContext('2d');
    R(g, 0, 0, TILE, hPx, st.wall);
    R(g, 0, 0, TILE, 2, st.wallD); // the eave's shadow
    for (var y = 4; y < hPx - 3; y += 4) R(g, 0, y, TILE, 1, st.wallD);
    R(g, 0, hPx - 3, TILE, 3, '#a8a098'); R(g, 0, hPx - 3, TILE, 1, '#c4bcb4'); R(g, 0, hPx - 1, TILE, 1, '#807870');
    return c;
  }
  /** One roof slope: shingle rows as in the 2D roof (light ridge row, a dark row every third, short highlights). */
  function roofCanvas(wPx, hPx, st) {
    var c = GT3.canvas(wPx, hPx), g = c.getContext('2d');
    for (var y = 0; y < hPx; y++) {
      R(g, 0, y, wPx, 1, y === 0 ? st.roofL : (y % 3 === 0 ? st.roofD : st.roof));
      if (y > 0 && y % 3 !== 0) for (var x = 1 + (y % 2 ? 2 : 0) + ((y / 3) | 0) % 2; x < wPx - 1; x += 5) R(g, x, y, 2, 1, st.roofL);
    }
    R(g, 0, hPx - 1, wPx, 1, OL); R(g, 0, hPx - 2, wPx, 1, st.roofD);
    R(g, 0, 0, 1, hPx, OL); R(g, wPx - 1, 0, 1, hPx, OL);
    return c;
  }
  /** Window glass of a facade as an emissive map (warm light), found by colour; the door never glows. */
  function glowCanvas(src, doorRect) {
    var w = src.width, h = src.height, c = GT3.canvas(w, h), g = c.getContext('2d');
    var d = src.getContext('2d').getImageData(0, 0, w, h).data, out = g.createImageData(w, h), o = out.data;
    for (var i = 0; i < d.length; i += 4) {
      var px = (i / 4) % w, py = Math.floor(i / 4 / w);
      var inDoor = doorRect && px >= doorRect[0] && px < doorRect[0] + doorRect[2] && py >= doorRect[1];
      var glass = !inDoor && d[i + 3] > 0 && d[i + 2] > d[i] + 24 && d[i + 1] > 140 && d[i + 2] >= d[i + 1] - 8;
      o[i] = glass ? 255 : 0; o[i + 1] = glass ? 206 : 0; o[i + 2] = glass ? 120 : 0; o[i + 3] = 255;
    }
    g.putImageData(out, 0, 0);
    return c;
  }
  function stripes(wPx, hPx, a, b) {
    var c = GT3.canvas(wPx, hPx), g = c.getContext('2d');
    for (var x = 0; x < wPx; x++) R(g, x, 0, 1, hPx, Math.floor(x / 3) % 2 ? b : a);
    R(g, 0, 0, wPx, 1, OL);
    for (x = 0; x < wPx; x += 3) R(g, x + 2, hPx - 1, 1, 1, 'rgba(0,0,0,0)');
    return c;
  }
  function box(w, h, d, x, y, z, color) { return { geo: new THREE.BoxGeometry(w, h, d), matrix: GT3.xform(x, y, z), color: color }; }

  GT3.Building = function (b) {
    var so = styleOf(b), st = so.st, pub = so.pub, kind = b.kind;
    var W = pub ? (b.w || 3) : 3, D = pub ? (b.h || 3) : 3, pw = W * TILE, ph = D * TILE;
    var group = new THREE.Group(); group.name = 'building:' + kind; group.position.set(b.x, 0, b.y);
    var mats = [];
    function M(o) { var m = GT3.mat(o); mats.push(m); return m; }

    /* --- the 2D facade, cut below its painted roof band */
    var art = GT3.canvas(pw, ph), ag = art.getContext('2d');
    if (pub) S.drawPublic(ag, kind, 0, 0, W, D); else S.drawHouse(ag, 0, 0, b.style | 0, false);
    var inset = pub ? 1 : 2, roofPx = pub ? Math.round(ph * 0.38) + 2 : 16;
    var wallPx = ph - roofPx, Hw = wallPx * PX;
    var face = GT3.crop(art, inset, roofPx, pw - 2 * inset, wallPx);
    var cx = Math.floor(W / 2) * TILE + TILE / 2 - inset; // door column centre, in facade pixels
    var x0 = inset * PX, x1 = W - inset * PX, z0 = inset * PX, z1 = D - inset * PX, zc = (z0 + z1) / 2, half = (z1 - z0) / 2;

    var frontMat = M({ map: GT3.tex(face), emissive: 0xffffff, emissiveMap: GT3.tex(glowCanvas(face, [cx - 6, wallPx - 15, 12])), emissiveIntensity: 0 });
    var front = new THREE.Mesh(GT3.quad([x0, 0, z1], [x1, 0, z1], [x1, Hw, z1], [x0, Hw, z1]), frontMat);

    /* --- side and back walls */
    var wtex = GT3.tex(wallCanvas(wallPx, st), true);
    var walls = new THREE.Mesh(GT3.merge([
      { geo: GT3.quad([x1, 0, z0], [x0, 0, z0], [x0, Hw, z0], [x1, Hw, z0], [0, 0, W, 1]) },
      { geo: GT3.quad([x1, 0, z1], [x1, 0, z0], [x1, Hw, z0], [x1, Hw, z1], [0, 0, D, 1]) },
      { geo: GT3.quad([x0, 0, z0], [x0, 0, z1], [x0, Hw, z1], [x0, Hw, z0], [0, 0, D, 1]) }
    ]), M({ map: wtex, vertexColors: true }));

    /* --- roof: two slopes, ridge east-west, a small overhang all round */
    var rh = Math.min(1.9, D * 0.36), o = 2 * PX, k = rh / half, eave = Hw - k * o, ridge = Hw + rh;
    var xa = x0 - o, xb = x1 + o, slope = Math.sqrt((half + o) * (half + o) + (ridge - eave) * (ridge - eave));
    var rtex = GT3.tex(roofCanvas(Math.round((xb - xa) * TILE), Math.max(4, Math.round(slope * TILE)), st));
    var roof = new THREE.Mesh(GT3.merge([
      { geo: GT3.quad([xa, eave, z1 + o], [xb, eave, z1 + o], [xb, ridge, zc], [xa, ridge, zc]) },
      { geo: GT3.quad([xb, eave, z0 - o], [xa, eave, z0 - o], [xa, ridge, zc], [xb, ridge, zc]) }
    ]), M({ map: rtex, vertexColors: true, side: THREE.DoubleSide }));

    /* --- trim: gables, ridge cap, and what the kind adds */
    var tri = function (p0, p1, p2) { var g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([].concat(p0, p1, p2), 3)); return g; };
    var trim = [
      { geo: tri([x1, Hw, z1], [x1, Hw, z0], [x1, ridge - k * 0.001, zc]), color: st.wall },
      { geo: tri([x0, Hw, z0], [x0, Hw, z1], [x0, ridge - k * 0.001, zc]), color: st.wall },
      box(xb - xa + PX, 1.5 * PX, 2.5 * PX, (xa + xb) / 2, ridge + 0.4 * PX, zc, st.roofD),
      // barge boards: a dark strip under each roof edge gives the thin roof some body
      box(xb - xa, 1.2 * PX, 1 * PX, (xa + xb) / 2, eave - 0.3 * PX, z1 + o - 0.5 * PX, st.roofD),
      box(xb - xa, 1.2 * PX, 1 * PX, (xa + xb) / 2, eave - 0.3 * PX, z0 - o + 0.5 * PX, st.roofD)
    ];
    var extras = [];
    if (!pub && st.chimney) {
      var chx = x1 - 9 * PX, chz = zc - half * 0.45;
      trim.push(box(4 * PX, 9 * PX, 4 * PX, chx, ridge - k * (half * 0.45) + 2.5 * PX, chz, '#b0604a'));
      trim.push(box(5.4 * PX, 1.4 * PX, 5.4 * PX, chx, ridge - k * (half * 0.45) + 7.4 * PX, chz, '#6a5a5c'));
    }
    if (kind === 'hall' || kind === 'townhall') {
      var px = x1 - 5 * PX;
      trim.push(box(1 * PX, 14 * PX, 1 * PX, px, ridge + 7 * PX, zc, '#6a6a6a'));
      extras.push(GT3.nearFlag(px + 5 * PX, ridge + 11.5 * PX, zc, 8 * PX, 5.5 * PX));
    }
    if (kind === 'church') {
      // bell tower over the door: its front is the tower painted in the 2D art
      var tw = 16 * PX, td = 13 * PX, tpx = roofPx + 4, th = tpx * PX, tx = (cx + inset) * PX, tz = z1 - td / 2 + 1 * PX, ty = Hw - 4 * PX;
      var tface = GT3.crop(art, cx + inset - 8, 0, 16, tpx);
      var tower = new THREE.Mesh(GT3.quad([tx - tw / 2, ty, tz + td / 2], [tx + tw / 2, ty, tz + td / 2], [tx + tw / 2, ty + th, tz + td / 2], [tx - tw / 2, ty + th, tz + td / 2]), M({ map: GT3.tex(tface), alphaTest: 0.5 }));
      extras.push(tower);
      trim.push({ geo: new THREE.BoxGeometry(tw - 2 * PX, th - 4 * PX, td), matrix: GT3.xform(tx, ty + (th - 4 * PX) / 2, tz - 0.5 * PX), color: function (n) { return n.z > 0.5 ? st.wallD : st.wall; } });
      trim.push({ geo: new THREE.ConeGeometry(tw * 0.72, 9 * PX, 4, 1), matrix: GT3.xform(tx, ty + th + 2.5 * PX, tz, 1, 1, 1, Math.PI / 4), color: function (n) { return n.x + n.z > 0 ? st.roof : st.roofD; } });
      trim.push(box(1 * PX, 5 * PX, 1 * PX, tx, ty + th + 9 * PX, tz, '#c8a030'));
      trim.push(box(3 * PX, 1 * PX, 1 * PX, tx, ty + th + 9.5 * PX, tz, '#c8a030'));
    }
    if (kind === 'warung' || kind === 'restoran') {
      var atex = GT3.tex(stripes(pw - 2 * inset, 6, '#d83c3c', '#f8f8f8'));
      var ay = Hw - 2 * PX, awn = new THREE.Mesh(GT3.quad([x0, ay - 5 * PX, z1 + 6 * PX], [x1, ay - 5 * PX, z1 + 6 * PX], [x1, ay, z1 + 0.2 * PX], [x0, ay, z1 + 0.2 * PX]), M({ map: atex, side: THREE.DoubleSide }));
      extras.push(awn);
    }
    var trimMesh = new THREE.Mesh(GT3.merge(trim), M({ vertexColors: true }));

    [front, walls, roof, trimMesh].concat(extras).forEach(function (m) { m.castShadow = true; m.receiveShadow = true; group.add(m); });

    group.userData = {
      building: b, mats: mats,
      box: new THREE.Box3(new THREE.Vector3(b.x + x0, 0, b.y + z0), new THREE.Vector3(b.x + x1, ridge, b.y + z1)),
      door: { x: b.dx + 0.5, z: b.dy + 1 },
      height: ridge,
      glow: function (v) { frontMat.emissiveIntensity = v; }
    };
    return group;
  };
})();
