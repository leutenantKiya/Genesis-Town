/*
 * r3d/buildings.js - every building of the village and the Homeland as procedural low-poly 3D, built from the same data
 * and the same palettes as the 2D art (buildings.js / sprites.js): houses (4 styles, padlocked when not invited), Balai
 * Desa, church, clinic, post office, broker, warung, Balai Kota (grows with its level), Kolam Ikan, Tambang, Restoran,
 * Rumah Pekerja and Rumah Sakit. Footprints are the map's own (b.x, b.y, b.w, b.h); the door is the bottom-middle tile
 * (b.dx, b.dy) facing south, toward the camera. Windows are a separate material that lights up at night.
 */
(function () {
  'use strict';
  var R3D = window.R3D = window.R3D || {};
  var THREE = window.THREE;
  if (!THREE || !R3D.geo) return;
  var Builder = R3D.geo.Builder;

  var group = null, litMat = null, glassMat = null;
  var GLASS_DAY = new THREE.Color('#a8d8f0'), GLASS_NIGHT = new THREE.Color('#ffd27a');

  var PAL = {
    hall:   { roof: '#a8442e', roofL: '#d8704a', wall: '#f2e2c4', sign: '#f6ead0', tab: '#a8442e' },
    church: { roof: '#4a5878', roofL: '#7488b0', wall: '#ece6da', sign: '#ffffff', tab: '#4a5878' },
    clinic: { roof: '#2e8a86', roofL: '#5cb8b0', wall: '#f6f6f2', sign: '#ffffff', tab: '#d8404a' },
    post:   { roof: '#d0702c', roofL: '#f0a050', wall: '#f4e6c8', sign: '#fff4dc', tab: '#c8403a' },
    broker: { roof: '#3c7a48', roofL: '#68a870', wall: '#efe4cc', sign: '#fff8e4', tab: '#3c7a48' },
    warung: { roof: '#8a5a30', roofL: '#b07a44', wall: '#c89a62', sign: '#fff0d8', tab: '#e8a838' },
    townhall: { roof: '#2f5fa8', roofL: '#5c8ed8', wall: '#f2e8cc', sign: '#fff6d8', tab: '#2f5fa8' },
    kolam:  { roof: '#2a7ab0', roofL: '#5cb0e0', wall: '#e4f0ec', sign: '#f2fbff', tab: '#3d7fc2' },
    tambang: { roof: '#5c5868', roofL: '#8a8698', wall: '#a8a2a0', sign: '#ece8e0', tab: '#6a6678' },
    restoran: { roof: '#b8422e', roofL: '#e0705a', wall: '#f6e4c8', sign: '#fff4dc', tab: '#c8502e' },
    rumah:  { roof: '#8a4a2c', roofL: '#b87048', wall: '#e8d4a8', sign: '#fff2d4', tab: '#8a4a2c' },
    rumahsakit: { roof: '#c84a4a', roofL: '#e88080', wall: '#f8f6f2', sign: '#ffffff', tab: '#d8404a' }
  };
  var HOUSES = [
    { roof: '#b8442e', roofL: '#e2774a', wall: '#f2e2c4', chimney: false },
    { roof: '#4a64a8', roofL: '#7ea0d8', wall: '#e8e2d4', chimney: true },
    { roof: '#7a4a82', roofL: '#b07ab0', wall: '#f4e8c8', chimney: false },
    { roof: '#c58a38', roofL: '#e8b062', wall: '#f2d8c4', chimney: true }
  ];
  var FOUND = '#a8a098', DARK = '#2a2430';

  function clear(C) {
    if (group) { C.root.remove(group); group.traverse(function (o) { if (o.geometry) o.geometry.dispose(); }); }
    group = null;
  }

  // ---- pieces shared by several kinds -------------------------------------------------------------------------
  function window3(B, G, cx, z, y0, k) {
    B.box(cx - 0.3, y0 - 0.04, z - 0.01, cx + 0.3, y0 + 0.54, z + 0.03, DARK, null, k);
    G.faceS(cx - 0.25, cx + 0.25, y0, y0 + 0.5, z + 0.035, '#ffffff', 1);
    B.box(cx - 0.02, y0, z + 0.03, cx + 0.02, y0 + 0.5, z + 0.05, DARK, null, k);
    B.box(cx - 0.25, y0 + 0.23, z + 0.03, cx + 0.25, y0 + 0.27, z + 0.05, DARK, null, k);
  }
  function door3(B, dx, z, h, col, k) {
    B.box(dx + 0.08, 0.1, z - 0.01, dx + 0.92, h + 0.06, z + 0.03, DARK, null, k);
    B.faceS(dx + 0.14, dx + 0.86, 0.1, h, z + 0.035, col, k);
    B.box(dx + 0.48, 0.1, z + 0.035, dx + 0.52, h, z + 0.05, '#6a4020', null, k);
    B.box(dx + 0.72, 0.5, z + 0.035, dx + 0.78, 0.56, z + 0.06, '#f0d048', null, k);
    B.box(dx - 0.02, 0, z + 0.02, dx + 1.02, 0.1, z + 0.28, '#c4bcb4', null, k); // step
  }
  function sign3(B, dx, z, y0, p, k) {
    B.box(dx + 0.02, y0, z + 0.0, dx + 0.98, y0 + 0.3, z + 0.08, DARK, null, k);
    B.faceS(dx + 0.07, dx + 0.93, y0 + 0.04, y0 + 0.26, z + 0.085, p.sign, k);
    B.faceS(dx + 0.38, dx + 0.62, y0 + 0.08, y0 + 0.22, z + 0.09, p.tab, k);
  }
  function body(B, b, p, wallH, k, opts) {
    opts = opts || {};
    var x = b.x, y = b.y, w = b.w, h = b.h;
    B.box(x + 0.0, 0, y + 0.0, x + w, 0.12, y + h, FOUND, '#c4bcb4', k);
    B.box(x + 0.05, 0.12, y + 0.05, x + w - 0.05, wallH, y + h - 0.05, p.wall, null, k);
    // darker band near the ground, like the 2D siding
    B.box(x + 0.04, 0.12, y + 0.04, x + w - 0.04, 0.3, y + h - 0.04, opts.wallD || '#cdbf9e', null, k);
    if (!opts.noRoof) {
      var rise = opts.rise || Math.max(0.9, Math.min(w, h) * 0.34);
      B.gable(x - 0.22, y - 0.18, x + w + 0.22, y + h + 0.2, wallH, wallH + rise, p.roof, p.wall, k, p.roofL);
      B.box(x - 0.24, wallH - 0.05, y + h + 0.0, x + w + 0.24, wallH + 0.02, y + h + 0.22, '#fff6dc', null, k); // front eave trim
      return wallH + rise;
    }
    return wallH;
  }
  function windows(B, G, b, skip, z, y0, k) {
    for (var i = 0; i < b.w; i++) {
      var tx = b.x + i;
      if (tx >= b.dx - 0 && tx <= b.dx + 0) continue;
      if (skip && skip(tx)) continue;
      window3(B, G, tx + 0.5, z, y0, k);
    }
  }
  function awning(B, x0, x1, z, y, depth, a, bcol, k) {
    var n = Math.max(2, Math.round((x1 - x0) / 0.25));
    for (var s = 0; s < n; s++) {
      var xa = x0 + s * (x1 - x0) / n, xb = x0 + (s + 1) * (x1 - x0) / n, c = B.col(s % 2 ? bcol : a, k);
      B.quad([xa, y - 0.25, z + depth], [xb, y - 0.25, z + depth], [xb, y, z], [xa, y, z], c);
    }
    B.box(x0, 0, z + depth - 0.04, x0 + 0.06, y - 0.25, z + depth + 0.02, '#6a3f22', null, k);
    B.box(x1 - 0.06, 0, z + depth - 0.04, x1, y - 0.25, z + depth + 0.02, '#6a3f22', null, k);
  }
  function flag(B, x, y0, z, k) {
    B.box(x - 0.02, y0, z - 0.02, x + 0.02, y0 + 1.1, z + 0.02, '#d8d0c8', null, k);
    B.box(x + 0.02, y0 + 0.75, z - 0.01, x + 0.55, y0 + 1.08, z + 0.01, '#e8503c', null, k);
    B.box(x + 0.02, y0 + 0.75, z - 0.01, x + 0.55, y0 + 0.9, z + 0.01, '#fafafa', null, k);
  }
  function cross3(B, cx, cy, z, s, col, k) { // a plus sign on the south face
    B.faceS(cx - s * 0.18, cx + s * 0.18, cy - s * 0.5, cy + s * 0.5, z, col, k);
    B.faceS(cx - s * 0.5, cx + s * 0.5, cy - s * 0.18, cy + s * 0.18, z, col, k);
  }
  function chimney(B, x, z, y0, y1, k) { B.box(x, y0, z, x + 0.3, y1, z + 0.3, '#8a4a3a', '#5a2e1a', k); }

  // ---- one builder per kind ----------------------------------------------------------------------------------
  function house(B, G, b, k) {
    var st = HOUSES[((Math.floor(b.style) || 0) % 4 + 4) % 4], zf = b.y + b.h, locked = b.invited === false || (b.invited == null ? false : !b.invited);
    var p = { roof: st.roof, roofL: st.roofL, wall: st.wall, sign: '#fff6dc', tab: st.roof };
    var top = body(B, b, p, 1.55, k);
    windows(B, G, b, null, zf - 0.05, 0.75, k);
    door3(B, b.dx, zf - 0.05, 1.05, locked ? '#7e5a48' : '#a0602e', k);
    if (locked) { B.box(b.dx + 0.4, 0.45, zf - 0.0, b.dx + 0.6, 0.68, zf + 0.12, '#f4c828', '#fce47c', k); }
    if (st.chimney) chimney(B, b.x + b.w - 0.95, b.y + 0.55, 1.2, top + 0.15, k);
  }
  function hall(B, G, b, k) {
    var p = PAL.hall, zf = b.y + b.h, top = body(B, b, p, 1.9, k, { rise: 1.15 });
    windows(B, G, b, function (tx) { return Math.abs(tx - b.dx) < 1; }, zf - 0.05, 0.85, k);
    door3(B, b.dx, zf - 0.05, 1.25, '#8a5a30', k);
    sign3(B, b.dx, zf - 0.05, 1.42, p, k);
    // portico: two columns and a small roof over the entrance
    B.box(b.dx - 0.6, 0, zf + 0.5, b.dx - 0.4, 1.6, zf + 0.7, '#ece6da', '#fff', k);
    B.box(b.dx + 1.4, 0, zf + 0.5, b.dx + 1.6, 1.6, zf + 0.7, '#ece6da', '#fff', k);
    B.gable(b.dx - 0.8, zf + 0.0, b.dx + 1.8, zf + 0.8, 1.6, 2.15, p.roof, p.wall, k, p.roofL);
    flag(B, b.x + b.w / 2, top - 0.05, b.y + b.h / 2, k);
  }
  function church(B, G, b, k) {
    var p = PAL.church, zf = b.y + b.h, tx0 = b.dx - 0.6, tx1 = b.dx + 1.6, tz0 = zf - 1.9;
    // nave behind the tower
    B.box(b.x, 0, b.y, b.x + b.w, 0.12, zf, FOUND, '#c4bcb4', k);
    B.box(b.x + 0.05, 0.12, b.y + 0.05, b.x + b.w - 0.05, 1.8, tz0 + 0.2, p.wall, null, k);
    B.gable(b.x - 0.2, b.y - 0.15, b.x + b.w + 0.2, tz0 + 0.3, 1.8, 2.8, p.roof, p.wall, k, p.roofL);
    for (var i = 0; i < b.w; i++) { var wx = b.x + i + 0.5; if (wx > tx0 - 0.1 && wx < tx1 + 0.1) continue; window3(B, G, wx, tz0 + 0.2, 0.9, k); }
    // front tower with door, spire and cross
    B.box(tx0, 0, tz0, tx1, 3.2, zf - 0.02, p.wall, null, k);
    B.box(tx0 - 0.04, 3.2, tz0 - 0.04, tx1 + 0.04, 3.32, zf + 0.02, '#cfc6b4', null, k);
    B.pyramid(tx0 - 0.1, tz0 - 0.1, tx1 + 0.1, zf + 0.06, 3.32, 4.9, p.roof, k, p.roofL);
    B.box(b.dx + 0.46, 4.85, tz0 + 0.95 - 0.04, b.dx + 0.54, 5.5, tz0 + 0.95 + 0.04, '#f2c94c', null, k);
    B.box(b.dx + 0.3, 5.15, tz0 + 0.95 - 0.04, b.dx + 0.7, 5.23, tz0 + 0.95 + 0.04, '#f2c94c', null, k);
    door3(B, b.dx, zf - 0.02, 1.3, '#6a4020', k);
    B.box(b.dx + 0.05, 1.4, zf - 0.02, b.dx + 0.95, 1.46, zf + 0.04, '#cfc6b4', null, k);
    window3(B, G, b.dx + 0.5, zf - 0.02, 2.0, k);
    window3(B, G, b.dx + 0.5, zf - 0.02, 2.55, k);
  }
  function clinic(B, G, b, k) {
    var p = PAL.clinic, zf = b.y + b.h, top = body(B, b, p, 1.6, k, { wallD: '#d8dcd8' });
    windows(B, G, b, null, zf - 0.05, 0.75, k);
    door3(B, b.dx, zf - 0.05, 1.1, '#2e8a86', k);
    B.box(b.dx - 0.15, 1.2, zf - 0.05, b.dx + 1.15, 1.58, zf + 0.04, '#ffffff', null, k);
    cross3(B, b.dx + 0.5, 1.39, zf + 0.045, 0.62, '#d8404a', k);
  }
  function post(B, G, b, k) {
    var p = PAL.post, zf = b.y + b.h;
    body(B, b, p, 1.6, k);
    windows(B, G, b, null, zf - 0.05, 0.75, k);
    door3(B, b.dx, zf - 0.05, 1.1, '#8a5a30', k);
    sign3(B, b.dx, zf - 0.05, 1.22, p, k);
    var mx = b.dx + 1.45; // red post box
    B.box(mx - 0.04, 0, zf + 0.35, mx + 0.04, 0.55, zf + 0.43, '#3a3a48', null, k);
    B.box(mx - 0.2, 0.55, zf + 0.25, mx + 0.2, 0.95, zf + 0.53, '#c8403a', '#e86a5a', k);
    B.box(mx - 0.2, 0.75, zf + 0.53, mx + 0.2, 0.79, zf + 0.545, DARK, null, k);
  }
  function broker(B, G, b, k) {
    var p = PAL.broker, zf = b.y + b.h;
    body(B, b, p, 1.6, k);
    windows(B, G, b, null, zf - 0.05, 0.75, k);
    door3(B, b.dx, zf - 0.05, 1.1, '#6a4a30', k);
    sign3(B, b.dx, zf - 0.05, 1.22, p, k);
    B.box(b.x + 0.2, 1.62, zf - 0.02, b.x + b.w - 0.2, 1.86, zf + 0.06, '#24502e', null, k);
  }
  function warung(B, G, b, k) {
    var p = PAL.warung, zf = b.y + b.h;
    body(B, b, p, 1.5, k, { wallD: '#a87a48' });
    windows(B, G, b, null, zf - 0.05, 0.7, k);
    door3(B, b.dx, zf - 0.05, 1.05, '#6a4020', k);
    awning(B, b.x + 0.1, b.x + b.w - 0.1, zf + 0.0, 1.35, 0.8, '#e8a838', '#fff0d8', k);
    [b.x + 0.7, b.x + b.w - 1.2].forEach(function (tx) {
      B.cyl(tx + 0.25, 0, zf + 0.7, 0.28, 0.5, 7, '#a0703c', k, '#d8a868');
      B.cyl(tx + 0.25, 0.5, zf + 0.7, 0.04, 0.0, 4, '#6a4020', k);
    });
  }
  function townhall(B, G, b, k) {
    var p = PAL.townhall, zf = b.y + b.h, lvl = Math.max(1, Math.min(5, b.level || b.th || 1)), top = body(B, b, p, 2.1 + (lvl - 1) * 0.12, k, { rise: 1.2 });
    windows(B, G, b, function (tx) { return Math.abs(tx - b.dx) < 1 && false; }, zf - 0.05, 0.9, k);
    door3(B, b.dx, zf - 0.05, 1.3, '#8a5a30', k);
    sign3(B, b.dx, zf - 0.05, 1.5, p, k);
    // clock tower on the ridge, taller with each level
    var cx = b.x + b.w / 2, cz = b.y + b.h / 2, th = 1.0 + lvl * 0.25;
    B.box(cx - 0.55, top - 0.3, cz - 0.55, cx + 0.55, top + th, cz + 0.55, p.wall, null, k);
    B.faceS(cx - 0.3, cx + 0.3, top + th - 0.6, top + th - 0.1, cz + 0.56, '#fff6d8', k);
    B.box(cx - 0.02, top + th - 0.4, cz + 0.56, cx + 0.02, top + th - 0.15, cz + 0.58, DARK, null, k);
    B.pyramid(cx - 0.65, cz - 0.65, cx + 0.65, cz + 0.65, top + th, top + th + 0.9, p.roof, k, p.roofL);
    flag(B, cx, top + th + 0.85, cz, k);
    B.box(b.dx - 0.4, 0, zf + 0.0, b.dx + 1.4, 0.18, zf + 0.5, '#c4bcb4', null, k); // steps
  }
  function kolam(B, G, b, k) {
    var x = b.x, y = b.y, w = b.w, h = b.h, wood = '#8a5a30', woodL = '#b07840';
    var gap0 = b.dx, gap1 = b.dx + 1;
    B.box(x, 0, y, x + w, 0.06, y + h, '#6e5a3a', null, k);
    B.box(x + 0.1, 0, y + 0.1, x + w - 0.1, 0.34, y + 0.35, wood, woodL, k);
    B.box(x + 0.1, 0, y + 0.1, x + 0.35, 0.34, y + h - 0.1, wood, woodL, k);
    B.box(x + w - 0.35, 0, y + 0.1, x + w - 0.1, 0.34, y + h - 0.1, wood, woodL, k);
    B.box(x + 0.1, 0, y + h - 0.35, gap0, 0.34, y + h - 0.1, wood, woodL, k);
    B.box(gap1, 0, y + h - 0.35, x + w - 0.1, 0.34, y + h - 0.1, wood, woodL, k);
    B.flat(x + 0.35, y + 0.35, x + w - 0.35, y + h - 0.35, 0.22, '#3d9fd6', k);
    B.flat(x + 0.5, y + 0.6, x + 1.3, y + 1.0, 0.225, '#7fcdf0', k);
    B.box(x + w - 0.9, 0, y + 0.05, x + w - 0.8, 1.0, y + 0.15, '#6a4020', null, k); // little fishing pole
    B.box(x + w - 0.9, 0.95, y + 0.1, x + w - 0.3, 1.0, y + 0.15, '#6a4020', null, k);
  }
  function tambang(B, G, b, k) {
    var x = b.x, y = b.y, w = b.w, h = b.h, cx = x + w / 2;
    B.blob(x + 0.8, 0.85, y + 0.9, 1.1, 0.95, 0.95, '#8a8698', k, 11, '#aaa6b8');
    B.blob(x + w - 0.8, 0.8, y + 0.9, 1.05, 0.9, 0.95, '#7a7688', k, 12, '#9a96a8');
    B.blob(cx, 1.2, y + 0.7, 1.3, 1.1, 0.9, '#8f8b9c', k, 13, '#b0acbe');
    B.box(x + 0.35, 0, y + 1.25, x + w - 0.35, 1.2, y + h - 0.25, '#7d798b', '#9a96a8', k);
    B.box(b.dx - 0.05, 0.02, y + h - 0.3, b.dx + 1.05, 1.0, y + h - 0.2, '#14101c', null, k);
    B.box(b.dx - 0.15, 0, y + h - 0.32, b.dx - 0.02, 1.1, y + h - 0.18, '#8a5a30', '#b07840', k);
    B.box(b.dx + 1.02, 0, y + h - 0.32, b.dx + 1.15, 1.1, y + h - 0.18, '#8a5a30', '#b07840', k);
    B.box(b.dx - 0.2, 1.05, y + h - 0.34, b.dx + 1.2, 1.2, y + h - 0.16, '#6a4020', '#b07840', k);
    B.box(x + 0.2, 0, y + h - 0.2, x + 0.8, 0.28, y + h + 0.3, '#5a5868', '#9a96a8', k); // ore cart
  }
  function restoran(B, G, b, k) {
    var p = PAL.restoran, zf = b.y + b.h;
    body(B, b, p, 1.55, k, { wallD: '#dcc09a' });
    windows(B, G, b, null, zf - 0.05, 0.75, k);
    door3(B, b.dx, zf - 0.05, 1.05, '#8a5a30', k);
    awning(B, b.x + 0.1, b.x + b.w - 0.1, zf + 0.0, 1.3, 0.7, '#e0705a', '#fff4dc', k);
    chimney(B, b.x + b.w - 0.9, b.y + 0.5, 1.2, 2.5, k);
  }
  function rumah(B, G, b, k) {
    var p = PAL.rumah, zf = b.y + b.h;
    body(B, b, p, 1.45, k, { wallD: '#c8b080' });
    windows(B, G, b, null, zf - 0.05, 0.7, k);
    door3(B, b.dx, zf - 0.05, 1.0, '#6a4020', k);
    chimney(B, b.x + 0.5, b.y + 0.5, 1.2, 2.3, k);
  }
  function rumahsakit(B, G, b, k) {
    var p = PAL.rumahsakit, zf = b.y + b.h;
    body(B, b, p, 1.55, k, { wallD: '#dcd8d4' });
    windows(B, G, b, null, zf - 0.05, 0.75, k);
    door3(B, b.dx, zf - 0.05, 1.05, '#d8404a', k);
    B.box(b.dx - 0.2, 1.15, zf - 0.05, b.dx + 1.2, 1.55, zf + 0.04, '#ffffff', null, k);
    cross3(B, b.dx + 0.5, 1.35, zf + 0.045, 0.6, '#d8404a', k);
  }
  function generic(B, G, b, k) {
    var p = { roof: '#3868c8', roofL: '#5c90e4', wall: '#e8ecf4', sign: '#fafafe', tab: '#3868c8' }, zf = b.y + b.h;
    body(B, b, p, 1.6, k);
    windows(B, G, b, null, zf - 0.05, 0.75, k);
    door3(B, b.dx, zf - 0.05, 1.1, '#8a5a30', k);
    sign3(B, b.dx, zf - 0.05, 1.22, p, k);
  }
  var KINDS = { house: house, hall: hall, church: church, clinic: clinic, post: post, broker: broker, warung: warung, townhall: townhall, kolam: kolam, tambang: tambang, restoran: restoran, rumah: rumah, rumahsakit: rumahsakit };

  R3D.buildings = {
    init: function (C) { litMat = R3D.geo.lit(); glassMat = R3D.geo.basic(); group = null; },
    onWorld: function (C, m) {
      clear(C);
      group = new THREE.Group(); C.root.add(group);
      var B = new Builder(), G = new Builder();
      m.buildings.forEach(function (b) {
        var k = (m.locked && m.locked[b.y * m.w + b.x]) ? 0.5 : 1;
        if (b.dx == null) b.dx = b.x + Math.floor(b.w / 2);
        (KINDS[b.kind] || generic)(B, G, b, k);
      });
      if (!B.empty()) group.add(B.mesh(litMat));
      if (!G.empty()) group.add(G.mesh(glassMat));
    },
    update: function (C, info) {
      var d = Math.min(1, info.dark);
      glassMat.color.copy(GLASS_DAY).lerp(GLASS_NIGHT, d);
    },
    dispose: function (C) {
      clear(C);
      if (litMat) litMat.dispose(); if (glassMat) glassMat.dispose();
      litMat = glassMat = null;
    }
  };
})();
