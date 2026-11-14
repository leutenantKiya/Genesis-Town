/* sprites.js - procedural GBC-style pixel art for Genesis Town.
 * Exposes window.SPRITES = { TILE, drawTile, drawHouse, drawMart, drawCharacter }.
 * All art is hand-authored as small string grids / rect compositions, rendered once
 * into offscreen canvases and then blitted with drawImage.
 */
(function (root) {
  'use strict';

  var TILE = 12;
  var problems = [];

  function mk(w, h) {
    var c;
    if (typeof document !== 'undefined') {
      c = document.createElement('canvas');
    } else {
      c = new OffscreenCanvas(w, h);
    }
    c.width = w; c.height = h;
    return c;
  }
  function R(c, x, y, w, h, col) { c.fillStyle = col; c.fillRect(x, y, w, h); }

  // Paint a grid of palette letters. '.' and ' ' are transparent.
  function paint(c, rows, pal, w, h, ox, oy, tag) {
    ox = ox || 0; oy = oy || 0;
    if (rows.length !== h) problems.push(tag + ': ' + rows.length + ' rows, want ' + h);
    for (var y = 0; y < h && y < rows.length; y++) {
      var row = rows[y];
      if (row.length !== w) problems.push(tag + ' row ' + y + ': len ' + row.length + ', want ' + w);
      for (var x = 0; x < w && x < row.length; x++) {
        var ch = row.charAt(x);
        if (ch === '.' || ch === ' ') continue;
        var col = pal[ch];
        if (!col) { problems.push(tag + ': no color for "' + ch + '"'); continue; }
        c.fillStyle = col;
        c.fillRect(ox + x, oy + y, 1, 1);
      }
    }
  }

  function shade(hex, f) {
    var n = parseInt(hex.slice(1), 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    function a(v) { return Math.max(0, Math.min(255, Math.round(f < 1 ? v * f : v + (255 - v) * (f - 1)))); }
    return 'rgb(' + a(r) + ',' + a(g) + ',' + a(b) + ')';
  }

  /* ------------------------------------------------------------------ */
  /* TILES                                                               */
  /* ------------------------------------------------------------------ */
  var OL = '#2a2430';
  var GRASS = { g: '#78b858', G: '#5a9a48', l: '#98d070' };
  var WOODF = { o: '#d8a868', O: '#b8844c', l: '#e8c088' };

  var T = {};

  T.grass = { pal: GRASS, rows: [
    'gggggggggggg',
    'gggGgggglggg',
    'ggGGgggggggg',
    'gggggggggGgg',
    'glgggggggGGg',
    'gggggggggggg',
    'gggggGgggggg',
    'ggggGGgglggg',
    'gGgggggggggg',
    'GGggglgggggg',
    'gggggggggGgg',
    'ggglggggGGgg'] };

  T.tallgrass = { under: 'grass', pal: { d: '#3c7a38', l: '#68b050' }, rows: [
    '..d....d..d.',
    '.dl.d..dl.dl',
    '.dd.dl.dd.dd',
    'dld.dd.dld.d',
    'dd.dld.dd.ld',
    '.d.dd..d..dd',
    '..dld.dld.d.',
    'd.dd.dldd.d.',
    'dld.dd.d.dld',
    'dd..d.dld.dd',
    'd..dld.dd..d',
    '.d.dd..d.d..'] };

  T.path = { pal: { p: '#d0b080', P: '#b89460', q: '#e4cc9c' }, rows: [
    'pppppppppppp',
    'ppPpppppqppp',
    'pppppppppppp',
    'pppppqppppPp',
    'pPpppppppppp',
    'pppppppPpppp',
    'ppqppppppppp',
    'pppppppppqpp',
    'pppPppppppPp',
    'pppppqpppppp',
    'ppppppppPppp',
    'pPpppppppppp'] };

  T.sand = { pal: { s: '#f0dca0', d: '#d8c080', l: '#f8ecc0' }, rows: [
    'ssssssssssss',
    'sssdssssssls',
    'ssssssssssss',
    'ssssssdsssss',
    'lsssssssssss',
    'sssssssssdss',
    'ssssdssssssl',
    'ssssssssssss',
    'sdssssssssss',
    'ssssslsssdss',
    'ssssssssssss',
    'sssdsssssssl'] };

  T.flower = { under: 'grass', frames: 2, pal: function (f) {
    return { r: '#e84848', p: '#f088c0', w: '#f8f8f8', s: '#3c7a38',
             y: f ? '#fff8b0' : '#f8d838' };
  }, rows: [
    '............',
    '.......r....',
    '......ryr...',
    '..p....r....',
    '.pyp...s....',
    '..ps...s....',
    '...s........',
    '.......w....',
    '......wyw...',
    '.......ws...',
    '.......s....',
    '............'] };

  T.tree = { under: 'grass', pal: { k: '#1c3c20', c: '#388840', C: '#2a6c34', h: '#58b050', t: '#8a5a30', T: '#5e3c20' }, rows: [
    '...kkkkkk...',
    '..kchhhcck..',
    '.kchhhcccck.',
    '.kchhcccCck.',
    'kcchccccCCck',
    'kccccccCCCck',
    'kcccccCCCCck',
    '.kccCCCCCck.',
    '..kkkCCkkk..',
    '....kttTk...',
    '....kttTk...',
    '...kkkkkkk..'] };

  T.fence = { under: 'grass', pal: { f: '#d0a060', F: '#8a6038' }, rows: [
    '............',
    '............',
    '...FFFF.....',
    '...FffF.....',
    '...FffF.....',
    'ffffffffffff',
    'FFFFFFFFFFFF',
    '...FffF.....',
    'ffffffffffff',
    'FFFFFFFFFFFF',
    '...FffF.....',
    '...FFFF.....'] };

  T.sign = { under: 'grass', pal: { f: '#d0a060', F: '#8a6038', d: '#5a3c28' }, rows: [
    '............',
    '..FFFFFFFF..',
    '.FffffffffF.',
    '.FfddddddfF.',
    '.FffffffffF.',
    '.FfdddddffF.',
    '.FffffffffF.',
    '..FFFFFFFF..',
    '.....FF.....',
    '.....Ff.....',
    '.....FF.....',
    '....FFFF....'] };

  T.mailbox = { under: 'grass', pal: { k: '#2a2430', r: '#d84848', R: '#9c2c30', F: '#8a6038', y: '#f8d838' }, rows: [
    '............',
    '............',
    '............',
    '...kkkkkk.y.',
    '..krrrrrrk..',
    '..krrrrrRk..',
    '..kRRRRRRk..',
    '...kkkkkk...',
    '.....FF.....',
    '.....FF.....',
    '.....FF.....',
    '....FFFF....'] };

  T.rock = { under: 'grass', pal: { k: '#2a2430', s: '#a8a8ae', S: '#7a7a82', h: '#d4d4da' }, rows: [
    '............',
    '............',
    '............',
    '....kkkk....',
    '..kkhhssk...',
    '.khhsssssk..',
    '.khssssssSk.',
    'ksssssssSSSk',
    'ksssssSSSSSk',
    '.kSSSSSSSSk.',
    '..kkkkkkkk..',
    '............'] };

  T.floor_wood = { pal: WOODF, rows: [
    'lllooooooooO',
    'oooooooooooO',
    'oooooooooooO',
    'oooolooooooO',
    'oooooooooooO',
    'OOOOOOOOOOOO',
    'oooooOlllooo',
    'oooooOoooooo',
    'oooooOoooooo',
    'oooooOoooloo',
    'oooooOoooooo',
    'OOOOOOOOOOOO'] };

  T.floor_tile = { pal: { t: '#e4e6ee', T: '#b8c0d4', h: '#fafafe' }, rows: [
    'httttThttttT',
    'tttttTtttttT',
    'tttttTtttttT',
    'tttttTtttttT',
    'tttttTtttttT',
    'TTTTTTTTTTTT',
    'httttThttttT',
    'tttttTtttttT',
    'tttttTtttttT',
    'tttttTtttttT',
    'tttttTtttttT',
    'TTTTTTTTTTTT'] };

  T.wall = { pal: { c: '#e4cca4', C: '#cdb088', D: '#7a5a3c', b: '#a8743e', B: '#7e5228' }, rows: [
    'cccccCcccccC',
    'cccccCcccccC',
    'cccccCcccccC',
    'cccccCcccccC',
    'cccccCcccccC',
    'cccccCcccccC',
    'cccccCcccccC',
    'cccccCcccccC',
    'DDDDDDDDDDDD',
    'bbbbbbbbbbbb',
    'bbbbbbbbbbbb',
    'BBBBBBBBBBBB'] };

  T.rug = { pal: { R: '#9c3040', r: '#cc4c58', y: '#f0d070' }, rows: [
    'RRRRRRRRRRRR',
    'RyyyyyyyyyyR',
    'RyrrrrrrrryR',
    'RyrrrrrrrryR',
    'RyrrrrrrrryR',
    'Ryrrryyrrr.R'.replace('.', 'y'),
    'Ryrrryyrrr.R'.replace('.', 'y'),
    'RyrrrrrrrryR',
    'RyrrrrrrrryR',
    'RyrrrrrrrryR',
    'RyyyyyyyyyyR',
    'RRRRRRRRRRRR'] };

  T.doormat = { under: 'floor_wood', pal: { M: '#306878', m: '#4890a0', w: '#78b8c8' }, rows: [
    '............',
    '.MMMMMMMMMM.',
    '.MmmmmmmmmM.',
    '.MmmmmmmmmM.',
    '.MmwwwwwwmM.',
    '.MmmmmmmmmM.',
    '.MmmmmmmmmM.',
    '.MmwwwwwwmM.',
    '.MmmmmmmmmM.',
    '.MmmmmmmmmM.',
    '.MMMMMMMMMM.',
    '............'] };

  T.bed = { under: 'floor_wood', pal: { k: '#2a2430', p: '#f8f8f8', P: '#d0d4e8', b: '#5878d8', B: '#3858b0' }, rows: [
    '.kkkkkkkkkk.',
    '.kppppppppk.',
    '.kppPPPPppk.',
    '.kBBBBBBBBk.',
    '.kbbbbbbbbk.',
    '.kbbbbbbbbk.',
    '.kbbbbbbbbk.',
    '.kbbbbbbbbk.',
    '.kbbbbbbbbk.',
    '.kBBBBBBBBk.',
    '.kkkkkkkkkk.',
    '............'] };

  T.table = { under: 'floor_wood', pal: { F: '#6a4020', T: '#b07840', t: '#d49c5c' }, rows: [
    '............',
    '............',
    '.FFFFFFFFFF.',
    '.FttttttttF.',
    '.FtTTTTTTtF.',
    '.FtTTTTTTtF.',
    '.FTTTTTTTTF.',
    '.FFFFFFFFFF.',
    '.FF......FF.',
    '.FF......FF.',
    '............',
    '............'] };

  T.tv = { under: 'floor_wood', pal: { k: '#2a2430', g: '#8a8a96', c: '#78c0d8', C: '#c0ecf8', r: '#d84848' }, rows: [
    '............',
    '.kkkkkkkkkk.',
    '.kggggggggk.',
    '.kgccccccgk.',
    '.kgcCCcccgk.',
    '.kgcCccccgk.',
    '.kgccccccgk.',
    '.kggggggrgk.',
    '.kkkkkkkkkk.',
    '..kk....kk..',
    '............',
    '............'] };

  T.plant = { under: 'floor_wood', pal: { k: '#2a2430', l: '#48a048', L: '#307830', h: '#78d068', r: '#c06838', R: '#8a4020' }, rows: [
    '.....h......',
    '..h..lL.h...',
    '.hl.lLLhl...',
    '..lLlLLlLl..',
    '...lLLLLl...',
    '....lLLl....',
    '.....LL.....',
    '..kkkkkkkk..',
    '..krrrrrRk..',
    '...krrrRk...',
    '...kRRRRk...',
    '....kkkk....'] };

  T.shelf = { under: 'floor_wood', pal: { k: '#3a2a20', f: '#c08848', r: '#d84848', b: '#4878d8', y: '#f0d048', g: '#58b858', p: '#e888c0', s: '#a07038' }, rows: [
    'kkkkkkkkkkkk',
    'krrbbyyggppk',
    'krrbbyyggppk',
    'kffffffffffk',
    'kyyggrrbbppk',
    'kyyggrrbbppk',
    'kffffffffffk',
    'kbbppyyrrggk',
    'kbbppyyrrggk',
    'kffffffffffk',
    'kkkkkkkkkkkk',
    'ssssssssssss'] };

  T.counter = { under: 'floor_wood', pal: { k: '#2a2430', c: '#ecd8aa', l: '#faeccc', C: '#c0a070', D: '#8a6038', d: '#6a4628' }, rows: [
    '............',
    '............',
    'kkkkkkkkkkkk',
    'llllllllllll',
    'cccccccccccc',
    'CCCCCCCCCCCC',
    'DDDDDDdDDDDD',
    'DDDDDDdDDDDD',
    'DDDDDDdDDDDD',
    'DDDDDDdDDDDD',
    'kkkkkkkkkkkk',
    '............'] };

  T.fridge = { under: 'floor_wood', pal: { k: '#2a2430', w: '#f0f0f4', s: '#c4c8d8', g: '#707880' }, rows: [
    '..kkkkkkkk..',
    '..kwwwwwsk..',
    '..kwwwwwsk..',
    '..kwwwwgsk..',
    '..kkkkkkkk..',
    '..kwwwwwsk..',
    '..kwwwwgsk..',
    '..kwwwwgsk..',
    '..kwwwwwsk..',
    '..kwwwwwsk..',
    '..kkkkkkkk..',
    '............'] };

  T.bookshelf = { under: 'floor_wood', pal: { F: '#7a4a28', k: '#3a2418', r: '#d84848', b: '#4878d8', y: '#f0d048', g: '#58b858' }, rows: [
    'FFFFFFFFFFFF',
    'FrbgyrbgyrbF',
    'FrbgyrbgyrbF',
    'FrbgyrbgyrbF',
    'FFFFFFFFFFFF',
    'FgyrbgyrbgyF',
    'FgyrbgyrbgyF',
    'FgyrbgyrbgyF',
    'FFFFFFFFFFFF',
    'FbgrbyrgyrbF',
    'FbgrbyrgyrbF',
    'kkkkkkkkkkkk'] };

  T.chair = { under: 'floor_wood', pal: { k: '#2a2430', c: '#c48848', C: '#e0a868' }, rows: [
    '............',
    '..kkkkkkkk..',
    '..kcccccck..',
    '..kcCCCCck..',
    '..kcccccck..',
    '..kkkkkkkk..',
    '.kcccccccck.',
    '.kcCCCCCCck.',
    '.kkkkkkkkkk.',
    '..kk....kk..',
    '..kk....kk..',
    '............'] };


  /* ---- casino / extra tiles ---- */
  T.floor_dark = { pal: { d: '#2c2a46', e: '#3c3a62', l: '#4a4872' }, rows: [
    'ldddddeeeeee',
    'dddddddeeeee',
    'dddddddeeeee',
    'dddddddeeeee',
    'dddddddeeeee',
    'dddddddeeeee',
    'leeeeedddddd',
    'eeeeeedddddd',
    'eeeeeedddddd',
    'eeeeeedddddd',
    'eeeeeedddddd',
    'eeeeeedddddd'] };

  T.carpet_red = { pal: { r: '#b02c3c', R: '#8a1c2c', y: '#e8c050' }, rows: [
    'rrrrrrrrrrrr',
    'rrRrrrrrRrrr',
    'rRyRrrrRyRrr',
    'rrRrrrrrRrrr',
    'rrrrrrrrrrrr',
    'rrrrrrrrrrrr',
    'rrrrrrrrrrrr',
    'rrRrrrrrRrrr',
    'rRyRrrrRyRrr',
    'rrRrrrrrRrrr',
    'rrrrrrrrrrrr',
    'rrrrrrrrrrrr'] };

  T.card_table = { under: 'floor_dark', pal: { k: '#14121e', g: '#2c8a4c', W: '#8a5a30', w: '#f8f8f8', r: '#d83838', y: '#f0d048', Y: '#c09018' }, rows: [
    '............',
    '.kkkkkkkkkk.',
    'kWWWWWWWWWWk',
    'kWggggggggWk',
    'kWgwwggyygWk',
    'kWgwrggyYgWk',
    'kWggggwwggWk',
    'kWggggwkggWk',
    'kWWWWWWWWWWk',
    '.kkkkkkkkkk.',
    '..kk....kk..',
    '............'] };

  T.slot = { under: 'floor_dark', pal: { k: '#14121e', R: '#c82c3c', y: '#f0d048', r: '#f8f8f8', g: '#48c058', s: '#b0b0c0', e: '#e04848' }, rows: [
    '...kkkkkk...',
    '..kyRyRyRk..',
    '.kRRRRRRRRke',
    '.kRyyyyyyRkk',
    '.kReeggyyRkk',
    '.kReeggyyRk.',
    '.kRyyyyyyRk.',
    '.kRRRRRRRRk.',
    '.kRRRkkRRRk.',
    '.kRssssssRk.',
    '.kkkkkkkkkk.',
    '............'] };

  T.chest = { under: 'floor_wood', pal: { k: '#2a2430', b: '#a8643a', B: '#7a4222', l: '#c88450', y: '#f8d038', Y: '#c09018' }, rows: [
    '............',
    '............',
    '..kkkkkkkk..',
    '.klYllllYlk.',
    '.kbYbbbbYbk.',
    '.kkkkyykkkk.',
    '.kBYByyBYBk.',
    '.kBYBkkBYBk.',
    '.kBYBBBBYBk.',
    '.kBYBBBBYBk.',
    '.kkkkkkkkkk.',
    '............'] };

  T.dice_table = { under: 'floor_dark', pal: { k: '#14121e', b: '#3a62c0', W: '#8a5a30', w: '#f8f8f8' }, rows: [
    '............',
    '.kkkkkkkkkk.',
    'kWWWWWWWWWWk',
    'kWbbbbbbbbWk',
    'kWbwkwbbbbWk',
    'kWbwwwbwwwWk',
    'kWbkwwbwkwWk',
    'kWbbbbbwwwWk',
    'kWWWWWWWWWWk',
    '.kkkkkkkkkk.',
    '..kk....kk..',
    '............'] };

  T.lamp = { under: 'grass', pal: { k: '#1c1a24', p: '#8a8c9c', P: '#5a5c6c', y: '#fff4a8', Y: '#f8d838' }, rows: [
    '....kkkk....',
    '...kyyyyk...',
    '..kyyYYyyk..',
    '..kyYYYYyk..',
    '...kkkkkk...',
    '....kppk....',
    '....kpPk....',
    '....kpPk....',
    '....kpPk....',
    '....kpPk....',
    '...kkpPkk...',
    '..kPPPPPPk..'] };

  var ANIM_FRAMES = { water: 4, flower: 2 };
  var tileCache = {};

  function drawWater(c, f) {
    R(c, 0, 0, 12, 12, '#4890d8');
    var rowsY = [1, 5, 9];
    for (var i = 0; i < rowsY.length; i++) {
      var y = rowsY[i];
      var sx = (i * 5 + f * 3) % 12;
      for (var k = 0; k < 4; k++) R(c, (sx + k) % 12, y, 1, 1, '#98d0f4');
      var dx = (sx + 6) % 12;
      for (k = 0; k < 3; k++) R(c, (dx + k) % 12, y + 2, 1, 1, '#3070b8');
    }
  }

  function buildTile(type, f) {
    var c = mk(12, 12), g = c.getContext('2d');
    if (type === 'water') { drawWater(g, f); return c; }
    var d = T[type];
    if (!d) { R(g, 0, 0, 12, 12, '#ff00ff'); return c; }
    if (d.under) g.drawImage(getTile(d.under, f), 0, 0);
    var pal = typeof d.pal === 'function' ? d.pal(f) : d.pal;
    paint(g, d.rows, pal, 12, 12, 0, 0, type);
    return c;
  }

  function getTile(type, frame) {
    var n = ANIM_FRAMES[type] || 1;
    var f = n === 1 ? 0 : (((Math.floor(frame) || 0) % n) + n) % n;
    var key = type + ':' + f;
    var c = tileCache[key];
    if (!c && !Object.prototype.hasOwnProperty.call(tileCache, key)) {
      c = tileCache[key] = buildTile(type, f);
    }
    return c;
  }

  function drawTile(ctx, type, x, y, frame) {
    ctx.drawImage(getTile(type, frame), Math.round(x), Math.round(y));
  }

  /* ------------------------------------------------------------------ */
  /* HOUSES                                                              */
  /* ------------------------------------------------------------------ */
  var HOUSE_STYLES = [
    { roof: '#b8442e', roofD: '#7a2a22', roofL: '#e2774a', wall: '#f2e2c4', wallD: '#d8bc94', trim: '#fff6dc', chimney: false },
    { roof: '#4a64a8', roofD: '#2e3d6a', roofL: '#7ea0d8', wall: '#e8e2d4', wallD: '#c8bea8', trim: '#ffffff', chimney: true },
    { roof: '#7a4a82', roofD: '#4a2a4e', roofL: '#b07ab0', wall: '#f4e8c8', wallD: '#d6c49c', trim: '#fffbe8', chimney: false },
    { roof: '#c58a38', roofD: '#8e5a2c', roofL: '#e8b062', wall: '#f2d8c4', wallD: '#d4b098', trim: '#fff0e6', chimney: true },
    // medieval looks (version 3): 'look' picks the extra drawing in buildHouse; the four above are the plain cottages
    { look: 'timber', roof: '#9a4a34', roofD: '#64301f', roofL: '#c47454', wall: '#efe2c2', wallD: '#d4c298', trim: '#fff4d8', beam: '#5a3a22', chimney: true },
    { look: 'stone', roof: '#6a5a4c', roofD: '#443a30', roofL: '#907e6c', wall: '#aaa59c', wallD: '#807a72', trim: '#d8d2c4', chimney: true },
    { look: 'slate', roof: '#4e5870', roofD: '#303848', roofL: '#7684a0', wall: '#f0ece0', wallD: '#d0c8b4', trim: '#ffffff', chimney: true },
    { look: 'thatch', roof: '#cfa84a', roofD: '#9a7a30', roofL: '#ecd078', wall: '#e6d2a8', wallD: '#c4aa7c', trim: '#fff0cc', chimney: false },
    { look: 'tower', roof: '#a8402e', roofD: '#6c261c', roofL: '#d6704e', wall: '#b4aea4', wallD: '#8a847a', trim: '#e8e2d6', chimney: false },
    { look: 'merchant', roof: '#3e7a58', roofD: '#244c36', roofL: '#6aa882', wall: '#f2e6c8', wallD: '#d6c496', trim: '#fff6dc', beam: '#6a4a2c', shutter: '#2e6a4a', chimney: true },
    { look: 'timber', roof: '#58803e', roofD: '#385026', roofL: '#82aa5e', wall: '#e8e6d0', wallD: '#c8c6a8', trim: '#fffff0', beam: '#4a3a2a', chimney: false },
    { look: 'stone', roof: '#3f5f94', roofD: '#283c60', roofL: '#6c90c8', wall: '#bab6ac', wallD: '#908c82', trim: '#e6e2d6', chimney: true }
  ];
  var houseCache = {};

  function window7(c, x, y, st) {
    R(c, x, y, 7, 7, OL);
    R(c, x + 1, y + 1, 5, 5, '#fcfcff');
    R(c, x + 1, y + 1, 2, 2, '#78b8e8'); R(c, x + 4, y + 1, 2, 2, '#78b8e8');
    R(c, x + 1, y + 4, 2, 2, '#5a9ad4'); R(c, x + 4, y + 4, 2, 2, '#5a9ad4');
    R(c, x + 1, y + 1, 1, 1, '#d4f0ff');  R(c, x + 4, y + 1, 1, 1, '#d4f0ff');
    R(c, x - 1, y + 7, 9, 1, st.trim);
    R(c, x - 1, y + 8, 9, 1, st.wallD);
  }

  /* medieval house looks: each paints over the plain cottage body that buildHouse draws first (same doors, windows, footprint) */
  function fieldstone(c, st) {
    var light = shade(st.wall, 1.14), y, x, r = 0;
    R(c, 3, 17, 30, 15, st.wall);
    for (y = 17; y < 32; y += 4, r++) {
      R(c, 3, y + 3, 30, 1, st.wallD);
      for (x = 3 + (r % 2) * 3 + (r * 5) % 4; x < 33; x += 6) { R(c, x, y, 1, 3, st.wallD); R(c, x + 1, y, 3, 1, light); }
    }
  }
  function timberWall(c, st) {
    R(c, 3, 17, 30, 15, st.wall);
    R(c, 3, 17, 2, 15, st.beam); R(c, 31, 17, 2, 15, st.beam); R(c, 12, 17, 1, 6, st.beam); R(c, 23, 17, 1, 6, st.beam);
    R(c, 3, 17, 30, 1, st.beam); R(c, 3, 29, 10, 1, st.beam); R(c, 23, 29, 10, 1, st.beam);
    for (var i = 0; i < 6; i++) { R(c, 5 + i, 30 - Math.floor(i / 2), 1, 1, st.beam); R(c, 30 - i, 30 - Math.floor(i / 2), 1, 1, st.beam); } // low braces
  }
  function slateRoof(c, st) {
    for (var y = 2; y <= 13; y++) {
      var ins = Math.floor((14 - y) / 3.5);
      for (var x = ins + 1; x < 35 - ins; x++) {
        var k = (x + (y >> 1) * 2) % 4;
        if (k === 0) R(c, x, y, 1, 1, st.roofD); else if (k === 2 && y % 2 === 0) R(c, x, y, 1, 1, st.roofL);
      }
    }
  }
  function thatchRoof(c, st) {
    var y, x;
    for (y = 2; y <= 13; y++) {
      var ins = Math.floor((14 - y) / 3.5);
      for (x = ins + 1; x < 35 - ins; x++) { var h = (x * 7 + y * 3) % 5; if (h === 0) R(c, x, y, 1, 2, st.roofD); else if (h === 3) R(c, x, y, 1, 1, st.roofL); }
    }
    R(c, 0, 13, 36, 1, st.roof);
    for (x = 0; x < 36; x++) R(c, x, 14, 1, 2 + (x * 5) % 3, st.roofD); // shaggy eave hanging over the wall
    R(c, 0, 14, 1, 1, OL); R(c, 35, 14, 1, 1, OL);
  }
  function towerBody(c, st) {
    var y, hw;
    R(c, 1, 11, 12, 25, OL); R(c, 2, 11, 10, 24, st.wall);
    for (y = 13; y < 33; y += 4) { R(c, 2, y, 10, 1, st.wallD); R(c, 2 + ((y / 4) % 2) * 3, y + 1, 1, 3, st.wallD); R(c, 8 - ((y / 4) % 2) * 2, y + 1, 1, 3, st.wallD); }
    R(c, 2, 32, 10, 3, '#a8a098'); R(c, 2, 32, 10, 1, '#c4bcb4'); R(c, 1, 35, 12, 1, OL);
    R(c, 1, 11, 12, 1, st.wallD); // shadow under the cone
    for (y = 1; y <= 10; y++) {
      hw = 1 + Math.round((y - 1) * 0.66);
      R(c, 7 - hw, y, hw * 2, 1, y % 3 === 0 ? st.roofD : st.roof);
      R(c, 7 - hw, y, Math.max(1, hw - 1), 1, y === 1 ? st.roofL : y % 3 === 0 ? st.roofD : st.roofL);
      R(c, 7 - hw, y, 1, 1, OL); R(c, 6 + hw, y, 1, 1, OL);
    }
    R(c, 0, 11, 14, 1, OL);
    R(c, 7, 0, 1, 2, '#6a6a6a'); R(c, 8, 0, 3, 2, '#d83c3c'); // pennant on the spire
    R(c, 6, 17, 2, 5, OL); R(c, 6, 27, 2, 5, OL); // arrow slits
  }

  function buildHouse(style, locked) {
    var st = HOUSE_STYLES[style];
    var cv = mk(36, 36), c = cv.getContext('2d');
    var y, x;

    // wall body
    R(c, 2, 15, 32, 21, OL);
    R(c, 3, 15, 30, 20, st.wall);
    // siding lines
    for (y = 20; y < 33; y += 4) R(c, 3, y, 30, 1, st.wallD);
    // foundation
    R(c, 3, 32, 30, 3, '#a8a098');
    R(c, 3, 32, 30, 1, '#c4bcb4');
    R(c, 3, 34, 30, 1, '#807870');
    R(c, 2, 35, 32, 1, OL);
    // eave shadow
    R(c, 3, 15, 30, 2, st.wallD);
    if (st.look === 'stone' || st.look === 'tower') fieldstone(c, st);
    else if (st.look === 'timber' || st.look === 'merchant') timberWall(c, st);

    // roof (trapezoid w/ shingles)
    function inset(yy) { return Math.floor((14 - yy) / 3.5); }
    R(c, inset(0), 0, 36 - inset(0) * 2, 1, OL);
    for (y = 1; y <= 13; y++) {
      var ins = inset(y), w = 36 - ins * 2;
      var col = st.roof;
      if (y === 1) col = st.roofL;
      else if (y % 3 === 0) col = st.roofD;
      R(c, ins, y, w, 1, col);
      if (y > 1 && y % 3 !== 0) {
        for (x = ins + ((y % 2) ? 1 : 3); x < 36 - ins - 1; x += 4) R(c, x, y, 1, 1, st.roofD);
        for (x = ins + ((y % 2) ? 3 : 1); x < 36 - ins - 1; x += 4) R(c, x, y, 1, 1, st.roofL);
      }
      R(c, ins, y, 1, 1, OL);
      R(c, 35 - ins, y, 1, 1, OL);
    }
    // eave band + outline
    R(c, 0, 14, 36, 1, st.roofD);
    R(c, 0, 15, 36, 1, OL);
    R(c, 0, 14, 1, 1, OL); R(c, 35, 14, 1, 1, OL);
    if (st.look === 'slate') slateRoof(c, st);
    else if (st.look === 'thatch') thatchRoof(c, st);

    if (st.chimney) {
      R(c, 25, 2, 5, 8, OL);
      R(c, 26, 3, 3, 7, '#b0604a');
      R(c, 26, 5, 3, 1, '#8a4a3a'); R(c, 26, 8, 3, 1, '#8a4a3a');
      R(c, 24, 1, 7, 2, OL); R(c, 25, 1, 5, 1, '#6a5a5c');
    }

    // windows
    if (st.look === 'tower') towerBody(c, st); else window7(c, 5, 19, st);
    window7(c, 24, 19, st);
    if (st.look === 'merchant') {
      // green shutters, and a shop sign hanging over the door
      R(c, 3, 19, 2, 7, st.shutter); R(c, 31, 19, 2, 7, st.shutter);
      R(c, 14, 16, 8, 1, st.beam); R(c, 14, 17, 1, 1, st.beam); R(c, 21, 17, 1, 1, st.beam);
      R(c, 14, 18, 8, 5, OL); R(c, 15, 19, 6, 3, '#f0d070'); R(c, 16, 20, 4, 1, st.shutter); R(c, 17, 19, 2, 1, '#fff2b0');
    }

    // door
    R(c, 13, 23, 10, 13, OL);
    var door = locked ? '#7e5a48' : '#a0602e';
    var doorD = locked ? '#5e3e30' : '#6e3c20';
    R(c, 14, 24, 8, 11, door);
    R(c, 14, 24, 8, 1, doorD);
    R(c, 15, 25, 6, 3, shade(door, 1.12));
    R(c, 15, 25, 6, 1, doorD); R(c, 15, 27, 6, 1, doorD);
    R(c, 15, 29, 6, 5, shade(door, 1.08));
    R(c, 15, 29, 6, 1, doorD); R(c, 15, 33, 6, 1, doorD);
    R(c, 17, 25, 2, 9, door);
    // step
    R(c, 12, 34, 12, 2, '#c4bcb4');
    R(c, 12, 35, 12, 1, '#807870');
    R(c, 13, 34, 10, 1, '#d8d0c8');
    R(c, 13, 23, 10, 1, OL);
    R(c, 13, 23, 10, 1, st.roofD);
    if (!locked) {
      R(c, 20, 30, 1, 1, '#f8d838'); // knob
    } else {
      // padlock
      R(c, 15, 26, 6, 1, OL);
      R(c, 15, 27, 1, 2, OL); R(c, 20, 27, 1, 2, OL);
      R(c, 16, 27, 1, 2, '#d0d0d8'); R(c, 19, 27, 1, 2, '#d0d0d8');
      R(c, 16, 26, 4, 1, '#d0d0d8');
      R(c, 15, 28, 6, 6, OL);
      R(c, 16, 29, 4, 4, '#f4c828');
      R(c, 16, 29, 4, 1, '#fce47c');
      R(c, 16, 32, 4, 1, '#c08c18');
      R(c, 17, 30, 2, 1, OL); R(c, 17, 31, 2, 1, OL);
      R(c, 17, 30, 1, 1, '#2a2430'); R(c, 18, 31, 1, 1, '#2a2430');
    }
    return cv;
  }

  function drawHouse(ctx, x, y, style, locked) {
    var n = HOUSE_STYLES.length, s = ((Math.floor(style) || 0) % n + n) % n;
    var key = s + ':' + (locked ? 1 : 0);
    var c = houseCache[key] || (houseCache[key] = buildHouse(s, !!locked));
    ctx.drawImage(c, Math.round(x), Math.round(y));
  }

  /* ------------------------------------------------------------------ */
  /* MART                                                                */
  /* ------------------------------------------------------------------ */
  var martCanvas = null;
  var FONT = {
    M: ['X.X', 'XXX', 'XXX', 'X.X', 'X.X'],
    A: ['.X.', 'X.X', 'XXX', 'X.X', 'X.X'],
    R: ['XX.', 'X.X', 'XX.', 'X.X', 'X.X'],
    T: ['XXX', '.X.', '.X.', '.X.', '.X.']
  };

  function buildMart() {
    var cv = mk(36, 36), c = cv.getContext('2d');
    var y, x, i;
    var B = '#3868c8', BD = '#284898', BL = '#5c90e4';

    // wall
    R(c, 2, 11, 32, 25, OL);
    R(c, 3, 20, 30, 15, '#e8ecf4');
    for (y = 25; y < 33; y += 4) R(c, 3, y, 30, 1, '#ccd2e0');
    R(c, 3, 33, 30, 2, '#a8a8b4');
    R(c, 3, 33, 30, 1, '#c4c4d0');
    R(c, 2, 35, 32, 1, OL);

    // roof
    function ins(yy) { return yy <= 2 ? 2 : (yy <= 6 ? 1 : 0); }
    R(c, 2, 0, 32, 1, OL);
    for (y = 1; y <= 8; y++) {
      var n = ins(y);
      R(c, n, y, 36 - 2 * n, 1, y === 1 ? BL : (y % 3 === 0 ? BD : B));
      R(c, n, y, 1, 1, OL); R(c, 35 - n, y, 1, 1, OL);
      if (y > 1 && y % 3 !== 0) for (x = n + (y % 2 ? 2 : 0) + 1; x < 35 - n; x += 4) R(c, x, y, 1, 1, BL);
    }
    R(c, 0, 9, 36, 1, BD);
    R(c, 0, 10, 36, 1, OL);
    R(c, 0, 9, 1, 1, OL); R(c, 35, 9, 1, 1, OL);

    // sign board
    R(c, 3, 11, 30, 9, OL);
    R(c, 4, 12, 28, 7, '#fafafe');
    R(c, 4, 12, 28, 1, '#c8d4ec');
    var letters = ['M', 'A', 'R', 'T'];
    for (i = 0; i < 4; i++) {
      var g = FONT[letters[i]];
      for (var gy = 0; gy < 5; gy++) for (var gx = 0; gx < 3; gx++) {
        if (g[gy].charAt(gx) === 'X') R(c, 10 + i * 4 + gx, 14 + gy, 1, 1, B);
      }
    }
    // little cart-ish icons on the sign
    R(c, 6, 15, 2, 3, '#e8a838'); R(c, 6, 14, 2, 1, OL);
    R(c, 28, 15, 2, 3, '#e8a838'); R(c, 28, 14, 2, 1, OL);

    // striped awning
    R(c, 2, 20, 32, 4, OL);
    for (x = 3; x < 33; x++) {
      var stripe = (Math.floor((x - 3) / 3) % 2 === 0);
      R(c, x, 20, 1, 3, stripe ? B : '#fafafe');
    }
    R(c, 3, 20, 30, 1, BL);
    // scalloped lower edge
    for (x = 3; x < 33; x++) {
      var st2 = (Math.floor((x - 3) / 3) % 2 === 0);
      R(c, x, 23, 1, 1, st2 ? BD : '#c8d0e4');
    }

    // display windows
    function disp(wx) {
      R(c, wx, 26, 8, 7, OL);
      R(c, wx + 1, 27, 6, 5, '#c4e4f8');
      R(c, wx + 1, 27, 2, 1, '#eaf8ff');
      R(c, wx + 1, 30, 6, 1, '#8a6a48');
      R(c, wx + 1, 29, 1, 1, '#d84848'); R(c, wx + 2, 29, 1, 1, '#d84848');
      R(c, wx + 3, 29, 1, 1, '#f0d048'); R(c, wx + 4, 29, 1, 1, '#58b858');
      R(c, wx + 5, 29, 1, 1, '#4878d8'); R(c, wx + 6, 29, 1, 1, '#e888c0');
      R(c, wx + 1, 31, 6, 1, '#a07038');
    }
    disp(4); disp(24);

    // glass door
    R(c, 13, 23, 10, 13, OL);
    R(c, 14, 24, 8, 11, '#a8d8f0');
    R(c, 14, 24, 8, 1, BD);
    R(c, 17, 25, 2, 10, '#6a8aa8');
    R(c, 15, 26, 1, 4, '#e0f4fc'); R(c, 20, 26, 1, 4, '#e0f4fc');
    R(c, 16, 30, 1, 3, '#2a2430'); R(c, 19, 30, 1, 3, '#2a2430');
    R(c, 12, 34, 12, 2, '#c4c4d0');
    R(c, 12, 35, 12, 1, '#807880');
    R(c, 14, 34, 8, 1, '#7a98b4');
    return cv;
  }

  function drawMart(ctx, x, y) {
    if (!martCanvas) martCanvas = buildMart();
    ctx.drawImage(martCanvas, Math.round(x), Math.round(y));
  }


  /* ------------------------------------------------------------------ */
  /* CASINO                                                              */
  /* ------------------------------------------------------------------ */
  var casinoCanvas = null;
  var CFONT = {
    K: ['X.X', 'XX.', 'XX.', 'X.X', 'X.X'],
    A: ['.X.', 'X.X', 'XXX', 'X.X', 'X.X'],
    S: ['XXX', 'X..', 'XXX', '..X', 'XXX'],
    I: ['XXX', '.X.', '.X.', '.X.', 'XXX'],
    N: ['XX.', 'X.X', 'X.X', 'X.X', 'X.X'],
    O: ['XXX', 'X.X', 'X.X', 'X.X', 'XXX']
  };

  function buildCasino() {
    var cv = mk(36, 36), c = cv.getContext('2d');
    var x, y, i;
    var GOLD = '#f4c828', GOLDL = '#fce47c', GOLDD = '#b88810';
    var RED = '#b02438', REDD = '#7c1428', REDL = '#d84858';

    // wall
    R(c, 2, 11, 32, 25, OL);
    R(c, 3, 11, 30, 24, RED);
    for (x = 3; x < 33; x += 6) R(c, x, 16, 1, 18, REDD);
    R(c, 3, 33, 30, 2, '#5c1020');
    R(c, 2, 35, 32, 1, OL);

    // sign board (rows 0..10)
    R(c, 3, 0, 30, 1, OL);
    R(c, 2, 1, 32, 10, OL);
    R(c, 3, 1, 30, 9, GOLD);
    R(c, 3, 1, 30, 1, GOLDL);
    R(c, 3, 9, 30, 1, GOLDD);
    R(c, 4, 2, 28, 7, '#2a1030');
    // bulbs
    for (x = 5; x < 31; x += 3) {
      R(c, x, 2, 1, 1, ((x - 5) / 3) % 2 ? '#fff8c0' : '#ff7088');
      R(c, x + 1, 8, 1, 1, ((x - 5) / 3) % 2 ? '#ff7088' : '#fff8c0');
    }
    var word = ['K', 'A', 'S', 'I', 'N', 'O'];
    for (i = 0; i < 6; i++) {
      var g = CFONT[word[i]];
      for (var gy = 0; gy < 5; gy++) for (var gx = 0; gx < 3; gx++) {
        if (g[gy].charAt(gx) === 'X') {
          R(c, 7 + i * 4 + gx, 3 + gy, 1, 1, GOLD);
        }
      }
      // faint highlight on top row of each letter
      for (gx = 0; gx < 3; gx++) if (g[0].charAt(gx) === 'X') R(c, 7 + i * 4 + gx, 3, 1, 1, GOLDL);
    }

    // awning: red / gold stripes
    R(c, 2, 11, 32, 5, OL);
    for (x = 3; x < 33; x++) {
      var stripe = (Math.floor((x - 3) / 3) % 2 === 0);
      R(c, x, 11, 1, 4, stripe ? REDL : GOLD);
    }
    R(c, 3, 11, 30, 1, GOLDL);
    for (x = 3; x < 33; x++) {
      var st = (Math.floor((x - 3) / 3) % 2 === 0);
      R(c, x, 15, 1, 1, st ? REDD : GOLDD);
    }

    // windows with dice
    function win(wx) {
      R(c, wx, 19, 8, 8, OL);
      R(c, wx + 1, 20, 6, 6, '#2a1030');
      R(c, wx + 1, 20, 6, 1, '#4a2858');
      // gold coin
      R(c, wx + 2, 21, 4, 4, GOLD);
      R(c, wx + 3, 20, 2, 1, GOLD); R(c, wx + 3, 25, 2, 1, GOLDD);
      R(c, wx + 2, 21, 1, 2, GOLDL); R(c, wx + 3, 22, 2, 2, GOLDD);
      R(c, wx + 5, 24, 1, 1, GOLDD);
      R(c, wx, 27, 8, 1, GOLD);
      R(c, wx, 28, 8, 1, GOLDD);
    }
    win(4); win(24);

    // double door
    R(c, 13, 23, 10, 13, OL);
    R(c, 14, 24, 8, 11, '#5c1020');
    R(c, 14, 24, 8, 1, GOLDD);
    R(c, 14, 25, 3, 9, '#7c1c30'); R(c, 19, 25, 3, 9, '#7c1c30');
    R(c, 14, 25, 3, 1, REDL); R(c, 19, 25, 3, 1, REDL);
    R(c, 17, 25, 2, 10, OL);
    R(c, 15, 27, 1, 1, GOLD); R(c, 20, 27, 1, 1, GOLD);
    R(c, 15, 30, 1, 1, GOLD); R(c, 20, 30, 1, 1, GOLD);
    R(c, 13, 23, 10, 1, GOLD);
    // red carpet step
    R(c, 12, 34, 12, 2, '#d03848');
    R(c, 12, 35, 12, 1, '#7c1428');
    R(c, 14, 34, 8, 1, '#f08090');
    R(c, 12, 34, 1, 1, GOLD); R(c, 23, 34, 1, 1, GOLD);
    return cv;
  }

  function drawCasino(ctx, x, y) {
    if (!casinoCanvas) casinoCanvas = buildCasino();
    ctx.drawImage(casinoCanvas, Math.round(x), Math.round(y));
  }

  /* ------------------------------------------------------------------ */
  /* CHARACTERS (12 wide, 14 tall grid drawn at y-2)                     */
  /* ------------------------------------------------------------------ */
  var CH_PAL = [
    { hair: '#5a3820', shirt: '#d84848', skin: '#f8c8a0', pants: '#384880' },
    { hair: '#e8c048', shirt: '#4878d8', skin: '#f8d0b0', pants: '#4a4a60' },
    { hair: '#2a2a38', shirt: '#58b058', skin: '#d8a070', pants: '#5a4a38' },
    { hair: '#d87028', shirt: '#9858c8', skin: '#f8c8a0', pants: '#384870' },
    { hair: '#b8b8c8', shirt: '#f0d048', skin: '#e8b890', pants: '#585868' },
    { hair: '#38a8a0', shirt: '#f088b8', skin: '#a86a48', pants: '#303850' },
    { hair: '#1c1c24', shirt: '#a82838', skin: '#f8c8a0', pants: '#202030' },
    { hair: '#8a5ad0', shirt: '#38b8c8', skin: '#f0c8a8', pants: '#68503a' },
    { hair: '#26346e', shirt: '#2e4488', skin: '#f0c8a0', pants: '#1a2250', police: true }
  ];

  var HEAD = {
    down: [
      '...kkkkkk...',
      '..khhhhhhk..',
      '.khhhhhhhhk.',
      '.kHhhhhhhHk.',
      '.khhssssshk.',
      '.kskssssksk.',
      '.kssssssssk.',
      '..kssssssk..'],
    up: [
      '...kkkkkk...',
      '..khhhhhhk..',
      '.khhhhhhhhk.',
      '.kHhhhhhhHk.',
      '.khhhhhhhhk.',
      '.khhhhhhhhk.',
      '.khhHhhHhhk.',
      '..kssssssk..'],
    left: [
      '...kkkkkk...',
      '..khhhhhhk..',
      '.khhhhhhhhk.',
      '.kHhhhhhhhk.',
      '.kssshhhhhk.',
      '.ksksshhhhk.',
      '.kssssshhhk.',
      '..ksssshhk..']
  };
  var BODY = [
    '.kttttttttk.',
    'kttttttttttk',
    'ksTTTTTTTTsk',
    '..kppppppk..'];
  var LEGS = {
    down: [
      ['..kppkkppk..', '..kbbkkbbk..'],
      ['..kppkkbbk..', '..kbbk......'],
      ['..kbbkkppk..', '......kbbk..']],
    left: [
      ['...kpppppk..', '...kbbbbbk..'],
      ['..kppk.kppk.', '..kbbk.kbbk.'],
      ['.kppk.kppk..', '.kbbk.kbbk..']]
  };
  LEGS.up = LEGS.down;
  // sitting (step 'sit'): these three rows replace the hip row and the leg rows. Seen from the front the thighs come
  // toward the viewer with the shins hanging down; from behind the legs are hidden in front of the body; from the
  // side the thighs run forward and the shin hangs at the front.
  var SIT = {
    down: ['.kppppppppk.', '..kpk..kpk..', '..kbk..kbk..'],
    up:   ['.kppppppppk.', '............', '............'],
    left: ['kppppppppk..', 'kpk.........', 'kbbk........']
  };

  function mirrorRows(rows) {
    return rows.map(function (r) { return r.split('').reverse().join(''); });
  }

  var charCache = {};
  function buildChar(pi, dir, step) {
    var p = CH_PAL[pi];
    var pal = {
      k: OL, h: p.hair, H: shade(p.hair, 0.75), s: p.skin,
      t: p.shirt, T: shade(p.shirt, 0.78), p: p.pants, b: '#4a3028'
    };
    var src = dir === 'right' ? 'left' : dir;
    var rows = step === 'sit' ? HEAD[src].concat(BODY.slice(0, 3), SIT[src]) : HEAD[src].concat(BODY, LEGS[src][step]);
    if (p.police) {
      pal.v = '#141c46'; pal.y = '#f8d838'; pal.H = '#3c52a0'; pal.T = '#1e2e6c';
      rows = rows.slice();
      if (src === 'down') { rows[3] = '.kHhhyyhhHk.'; rows[4] = '.kvvvvvvvvk.'; }
      else if (src === 'up') { rows[4] = '.khhhhhhhhk.'; }
      else { rows[3] = '.kHhhhyhhhk.'; rows[4] = '.kvvvvhhhhk.'; }
      if (src === 'down') rows[8] = '.ktttyttttk.';
    }
    if (dir === 'right') rows = mirrorRows(rows);
    var cv = mk(12, 14), c = cv.getContext('2d');
    paint(c, rows, pal, 12, 14, 0, 0, 'char' + pi + dir + step);
    return cv;
  }

  function drawCharacter(ctx, x, y, palette, dir, step) {
    var pi = ((Math.floor(palette) || 0) % 9 + 9) % 9;
    var d = (dir === 'up' || dir === 'left' || dir === 'right') ? dir : 'down';
    var s = step === 'sit' ? 'sit' : (step === 1 || step === 2) ? step : 0;
    var key = pi + d + s;
    var c = charCache[key] || (charCache[key] = buildChar(pi, d, s));
    ctx.drawImage(c, Math.round(x), Math.round(y) - 2);
  }

  /* ------------------------------------------------------------------ */
  /* WORN COSMETICS (Mall): drawn over / under the 12x14 character       */
  /* ------------------------------------------------------------------ */
  // defs = [{slot, shape, color, color2}] (hat, outfit, cape, pet, decor; the other slots draw nothing here). Same x, y,
  // dir and step as drawCharacter. layer 'back' goes under the character (cape, pet, decor), 'front' over it (outfit, hat,
  // a cape seen from behind, a bird): call back, then drawCharacter, then front. Things reach up to 8 px above the head
  // and 4 px to each side (WORN_PAD), so a card made for them needs that room.
  var PETS = {
    cat: ['k.k...', 'kakk..', 'keaak.', '.kaaak', '.kbaak', '.k.kbk'],
    dog: ['kk....', 'kbkkk.', 'kbeak.', '.kaaak', '.kaaak', '.k..kk'],
    fox: ['k.k...', 'kakk..', 'keaak.', '.kaaak', '.kbaak', '.k.kwk']
  };
  function drawWorn(ctx, x, y, defs, dir, step, layer) {
    if (!defs || !defs.length) return;
    var d = (dir === 'up' || dir === 'left' || dir === 'right') ? dir : 'down';
    var ox = Math.round(x), oy = Math.round(y) - 2, flip = d === 'right', front = layer === 'front';
    var back = layer === 'back';
    function r(px, py, w, h, c) { ctx.fillStyle = c; ctx.fillRect(ox + px, oy + py, w, h); }
    ctx.save();
    if (flip) { ctx.translate(2 * ox + 12, 0); ctx.scale(-1, 1); }
    defs.forEach(function (it) {
      if (!it || !it.color) return;
      var c = it.color, c2 = it.color2 || c, dk = shade(c, 0.7), lt = shade(c, 1.22), k = it.slot, s = it.shape, sd = d === 'left' || d === 'right';
      /* ---- cape: behind the body, or in front of it when seen from behind */
      if (k === 'cape') {
        var h = s === 'long' ? 8 : 5;
        if (d === 'up' && front) {
          r(0, 8, 12, h, OL); r(1, 8, 10, h - 1, c); r(1, 8, 10, 1, c2); r(2, 9, 1, h - 2, dk); r(9, 9, 1, h - 2, dk); r(3, 7 + h - 1, 6, 1, dk);
        } else if (d !== 'up' && back) {
          // an A-line cape hanging behind: as wide as the shoulders at the top, flaring a little towards the hem
          var mid = sd ? 8 : 6;
          for (var cr = 0; cr < h; cr++) {
            var hw = sd ? 3 + (cr >> 1) : 5 + (cr >> 1), left = mid - hw;
            r(left - 1, 8 + cr, 1, 1, OL); r(mid + hw, 8 + cr, 1, 1, OL);
            r(left, 8 + cr, hw * 2, 1, cr === 0 ? c2 : cr === h - 1 ? dk : c);
            if (cr > 1 && cr < h - 1) r(mid - 1, 8 + cr, 1, 1, dk);
          }
          r(mid - hw - 1, 7 + h, hw * 2 + 2, 1, OL);
        }
        return;
      }
      /* ---- pet and decor stand beside the feet (under the character) */
      if (k === 'pet' && s !== 'bird') {
        if (!back) return;
        var rows = PETS[s] || PETS.cat, pal = { k: OL, e: '#14101c', w: '#ffffff', a: c, b: c2 }, py = 14 - rows.length;
        for (var yy = 0; yy < rows.length; yy++) for (var xx = 0; xx < rows[yy].length; xx++) { var ch = rows[yy].charAt(xx); if (ch !== '.' && pal[ch]) r(10 + xx, py + yy, 1, 1, pal[ch]); }
        return;
      }
      if (k === 'pet') { // a small bird on the shoulder
        if (!front) return;
        r(9, 5, 4, 3, OL); r(10, 5, 2, 2, c); r(12, 6, 1, 1, '#f0b030'); r(10, 6, 2, 1, c2); r(9, 4, 1, 1, c2);
        return;
      }
      if (k === 'decor') {
        if (!back) return;
        if (s === 'banner') { r(-3, 0, 1, 14, '#6a4a2c'); r(-2, 1, 5, 4, OL); r(-2, 1, 4, 3, c); r(-2, 4, 4, 1, c2); r(0, 2, 1, 1, c2); }
        else if (s === 'lantern') { r(-3, 6, 1, 8, '#6a4a2c'); r(-4, 5, 3, 1, '#6a4a2c'); r(-4, 6, 3, 4, OL); r(-3, 7, 1, 2, c); r(-4, 9, 3, 1, c2); }
        else if (s === 'flowerbox') { r(-4, 12, 5, 2, OL); r(-3, 12, 3, 1, '#9a6a3a'); r(-4, 10, 1, 2, '#3a7a3a'); r(-3, 9, 1, 3, c); r(-1, 10, 1, 2, '#3a7a3a'); r(-1, 9, 1, 1, c2); r(-2, 11, 1, 1, c2); }
        else { r(-4, 12, 4, 2, OL); r(-3, 12, 2, 1, c2); r(-3, 8, 2, 4, OL); r(-3, 9, 2, 3, c); r(-4, 8, 1, 2, c); r(-2, 7, 1, 1, c2); }
        return;
      }
      if (front === false) return; // outfits and hats are all in the front layer
      /* ---- outfit: over the shirt (rows 8-10), robes and dresses down over the legs */
      if (k === 'outfit') {
        var up = d === 'up';
        if (s === 'tunic') { r(2, 8, 8, 3, c); r(1, 9, 10, 1, c); r(2, 10, 8, 1, c2); if (!up && !sd) r(5, 8, 2, 1, dk); }
        else if (s === 'vest') { r(2, 8, 3, 3, c); r(7, 8, 3, 3, c); r(5, 8, 2, 3, lt); if (!up) r(5, 9, 1, 1, c2); r(2, 10, 8, 1, dk); }
        else if (s === 'overalls') { r(2, 9, 8, 2, c); r(2, 11, 8, 1, c); r(3, 8, 1, 1, c2); r(8, 8, 1, 1, c2); if (!up) { r(4, 9, 4, 1, dk); r(5, 10, 2, 1, c2); } }
        else if (s === 'robe') { r(1, 8, 10, 3, c); r(2, 11, 8, 3, c); r(2, 13, 8, 1, c2); r(2, 10, 8, 1, c2); if (!up) r(5, 8, 2, 6, c2); r(2, 11, 1, 3, dk); r(9, 11, 1, 3, dk); }
        else if (s === 'dress') { r(2, 8, 8, 3, c); r(1, 9, 10, 1, c); r(2, 10, 8, 1, c2); r(1, 11, 10, 1, c); r(0, 12, 12, 1, c); r(0, 13, 12, 1, c2); r(5, 11, 1, 2, dk); }
        else if (s === 'armor') { r(2, 8, 8, 3, c); r(4, 8, 4, 2, lt); r(0, 8, 2, 2, c2); r(10, 8, 2, 2, c2); r(0, 8, 2, 1, lt); r(10, 8, 2, 1, lt); r(2, 10, 8, 1, dk); r(5, 10, 2, 1, c2); }
        else { r(2, 8, 8, 3, c); }
        return;
      }
      /* ---- hat: from the hair line up */
      if (k === 'hat') {
        if (s === 'brim') { r(-1, 0, 14, 2, OL); r(0, 1, 12, 1, dk); r(0, 0, 12, 1, c); r(2, -3, 8, 4, OL); r(3, -2, 6, 3, c); r(3, 0, 6, 1, c2); r(4, -2, 2, 1, lt); }
        else if (s === 'cap') { r(1, -2, 10, 5, OL); r(2, -1, 8, 3, c); r(2, 0, 8, 1, lt); r(5, -2, 2, 1, c2); if (d === 'down') { r(1, 2, 10, 2, OL); r(2, 2, 8, 1, c2); } else if (sd) { r(-1, 2, 5, 2, OL); r(0, 2, 4, 1, c2); } }
        else if (s === 'beret') { r(1, -2, 11, 5, OL); r(2, -1, 9, 3, c); r(3, -2, 5, 1, c); r(2, 1, 8, 1, c2); r(6, -3, 2, 1, OL); r(6, -3, 1, 1, c2); }
        else if (s === 'wizard') {
          r(4, -8, 4, 1, OL); r(5, -7, 2, 1, c); r(3, -7, 6, 6, OL); r(5, -7, 2, 1, c); r(4, -6, 4, 1, c); r(4, -5, 4, 1, c); r(3, -4, 6, 2, c); r(2, -2, 8, 2, c); r(-1, 0, 14, 3, OL); r(0, 1, 12, 1, dk); r(0, 0, 12, 1, c); r(2, -1, 8, 1, c2);
          r(5, -5, 1, 1, c2); r(7, -3, 1, 1, c2); r(3, -3, 1, 1, c2);
        }
        else if (s === 'helm') { r(0, -2, 12, 6, OL); r(1, -1, 10, 5, c); r(1, -1, 10, 1, lt); r(5, -4, 2, 3, OL); r(5, -3, 2, 2, c2); if (d === 'up') r(1, 4, 10, 2, c); else { r(2, 3, 8, 1, OL); r(5, 4, 2, 1, c); r(2, 2, 1, 3, c); r(9, 2, 1, 3, c); } }
        else if (s === 'crown') { r(1, -2, 10, 4, OL); r(2, -1, 8, 2, c); r(2, 1, 8, 1, dk); r(2, -2, 1, 1, c); r(5, -3, 2, 2, c); r(9, -2, 1, 1, c); r(4, 0, 1, 1, c2); r(7, 0, 1, 1, c2); r(5, -2, 2, 1, lt); }
        else { r(2, -1, 8, 3, c); }
      }
    });
    ctx.restore();
  }
  // a pile of worn pieces gets one small whole number, so a 3D actor (which is made from one number: the look) can carry them
  var wornIds = [null], wornIx = {};
  function wornCombo(defs) {
    if (!defs || !defs.length) return 0;
    var key = defs.map(function (d) { return [d.slot, d.shape, d.color, d.color2].join(':'); }).join('|'), id = wornIx[key];
    if (!id) { id = wornIds.length; if (id > 4000) return 0; wornIds.push(defs); wornIx[key] = id; }
    return id;
  }


  /* ------------------------------------------------------------------ */
  /* ICONS (8x8)                                                         */
  /* ------------------------------------------------------------------ */
  var ICONS = {
    roti: { pal: { k: OL, b: '#e0a050', L: '#f8d890', B: '#b87430' }, rows: [
      '........', '..kkkk..', '.kbbbbk.', 'kbLbbbbk', 'kbbbLbbk', 'kBbbbbBk', '.kBBBBk.', '..kkkk..'] },
    apel: { pal: { k: OL, s: '#7a4a28', g: '#58b858', h: '#f8a0a0', r: '#e03838', R: '#a82028' }, rows: [
      '.....g..', '....kgg.', '.kkkskk.', 'krhrrrrk', 'krhrrrRk', 'krrrrrRk', '.krrrRk.', '..kkkk..'] },
    susu: { pal: { k: OL, w: '#fafafe', W: '#c0c8e0', b: '#4878d8', B: '#3858b0' }, rows: [
      '..kkkk..', '.kBBBBk.', 'kwwwwwwk', 'kwbbbbwk', 'kwbwwbwk', 'kwbbbbwk', 'kWWWWWWk', '.kkkkkk.'] },
    bunga: { pal: { k: OL, p: '#f088c0', y: '#f8d838', s: '#3c7a38', g: '#58b858' }, rows: [
      '..kkk...', '.kpppk..', 'kppyppk.', '.kpppk..', '..kkk...', '...sg...', '.ggsg...', '...s....'] },
    kue: { pal: { k: OL, r: '#e03838', p: '#f8a0c8', w: '#fff4e0', c: '#c88848' }, rows: [
      '...kr...', '.kkkrkk.', 'kppppppk', 'kwwwwwwk', 'kcccccck', 'kwwwwwwk', 'kcccccck', '.kkkkkk.'] },
    obeng: { pal: { k: OL, g: '#c8ccd8', R: '#d84848', h: '#f08888' }, rows: [
      '...kkk..', '...kgk..', '...kgk..', '..kkgkk.', '.kRhRRk.', '.kRhRRk.', '.kRRRRk.', '..kkkk..'] },
    permen: { pal: { k: OL, p: '#f070a8', w: '#fafafe', r: '#d03878', s: '#e8e0d0' }, rows: [
      '..kkkk..', '.kpwppk.', 'kpwrrppk', 'kprpprpk', 'kpprrppk', '.kppppk.', '..kkkk..', '...ss...'] },
    koin: { pal: { k: OL, y: '#f4c828', h: '#fce47c', Y: '#c08c18' }, rows: [
      '..kkkk..', '.kyhyyk.', 'kyhyyyyk', 'kyhyYyyk', 'kyyyYyyk', 'kyyyyyYk', '.kYYYYk.', '..kkkk..'] },
    kartu: { pal: { k: OL, w: '#fafafe', W: '#c0c8e0', r: '#d83838' }, rows: [
      '.kkkkkk.', '.kwwwwk.', '.kwrrwk.', '.krrrrk.', '.kwrrwk.', '.kwwwwk.', '.kWWWWk.', '.kkkkkk.'] },
    dadu: { pal: { k: OL, w: '#fafafe', W: '#c0c8e0' }, rows: [
      'kkkkkkkk', 'kwwwwwwk', 'kwkwwkwk', 'kwwwwwwk', 'kwwwwwwk', 'kwkwwkwk', 'kWWWWWWk', 'kkkkkkkk'] }
  };
  ICONS.borgol = { pal: { k: OL, g: '#c8ccd8', G: '#8a90a4', d: '#3a3a4c', h: '#f4f4fa' }, rows: [
      '........', '.kk..kk.', 'khgkkgGk', 'kgdGGdGk', 'kgdGGdGk', 'kggkkGGk', '.kk..kk.', '........'] };
  ICONS.senter = { pal: { k: OL, g: '#8a90a4', G: '#5a5e70', y: '#fff4a8', Y: '#f8d838', r: '#d84848' }, rows: [
      'kkk.....', 'kyykkk..', 'kYYkgGk.', 'kyykGgGk', 'kkkkgGgk', '..kkGgrk', '....kkk.', '........'] };
  var iconCache = {};

  function buildIcon(id, scale) {
    var cv = mk(8 * scale, 8 * scale), c = cv.getContext('2d');
    var base = mk(8, 8), b = base.getContext('2d');
    var d = ICONS[id];
    if (!d) { R(b, 0, 0, 8, 8, '#ff00ff'); }
    else paint(b, d.rows, d.pal, 8, 8, 0, 0, 'icon_' + id);
    c.imageSmoothingEnabled = false;
    c.drawImage(base, 0, 0, 8 * scale, 8 * scale);
    return cv;
  }

  function drawIcon(ctx, id, x, y, size) {
    var scale = Math.max(1, Math.floor((+size || 8) / 8));
    var key = (ICONS[id] ? id : '?') + ':' + scale;
    var c = iconCache[key] || (iconCache[key] = buildIcon(id, scale));
    ctx.drawImage(c, Math.round(x), Math.round(y));
  }

  root.SPRITES = {
    TILE: TILE,
    drawTile: drawTile,
    drawHouse: drawHouse,
    drawMart: drawMart,
    drawCharacter: drawCharacter,
    drawWorn: drawWorn,
    wornCombo: wornCombo,
    wornDefsOf: function (id) { return wornIds[id | 0] || null; },
    WORN_PAD: { l: 4, t: 8, r: 4, b: 0 },
    drawCasino: drawCasino,
    drawIcon: drawIcon,
    ICON_IDS: Object.keys(ICONS),
    HOUSE_STYLES: HOUSE_STYLES,
    // debug helpers (not part of the engine contract)
    _tileTypes: Object.keys(T).concat(['water']),
    _problems: problems,
    // art.js (art pass 1) extends the tile table and reuses the painter
    _T: T,
    _paint: paint,
    // drop the built tiles after a palette change (snow on or off)
    _clearTiles: function () { tileCache = {}; }
  };
})(typeof window !== 'undefined' ? window : globalThis);

