// Draws the app icons (a 16x16 pixel-art house with a sun) and writes PNGs to client/icons. Node only, no dependencies.
// Run: node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'icons');
mkdirSync(out, { recursive: true });

const BG = '#14152a';
const C = { '.': null, S: '#f6c945', s: '#ffe27a', R: '#d6453d', r: '#a82f2c', W: '#f1e6d0', w: '#d9c9a6', D: '#6b3f26', G: '#7a5230', B: '#5aa9e6', g: '#3f9a4a' };
// 16x16 art: sun top-right, red roof, cream wall, door and window, grass line
const ART = [
  '................',
  '..........sSs...',
  '.........sSSSs..',
  '..........sSs...',
  '.....rr.........',
  '....rRRr........',
  '...rRRRRr.......',
  '..rRRRRRRr......',
  '.rRRRRRRRRr.....',
  'rRRRRRRRRRRr....',
  '..WWWWWWWWWW....',
  '..WBBWWWWDDW....',
  '..WBBWWWWDDW....',
  '..WWWWWWWDDW....',
  'gggggggggggggggg',
  'gggggggggggggggg'
];

function hex(c) { return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)); }

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgb) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 3 + 1)] = 0; rgb.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// Renders the art scaled (nearest neighbour) to `art` pixels, centred on a `size` square of the background colour.
function render(size, art) {
  const rgb = Buffer.alloc(size * size * 3);
  const bg = hex(BG), off = Math.floor((size - art) / 2), scale = art / 16;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let px = bg;
    const ax = x - off, ay = y - off;
    if (ax >= 0 && ay >= 0 && ax < art && ay < art) {
      const col = C[ART[Math.floor(ay / scale)][Math.floor(ax / scale)]];
      if (col) px = hex(col);
    }
    rgb[(y * size + x) * 3] = px[0]; rgb[(y * size + x) * 3 + 1] = px[1]; rgb[(y * size + x) * 3 + 2] = px[2];
  }
  return rgb;
}
function write(name, size, art) { writeFileSync(join(out, name), png(size, render(size, art))); console.log(name, size + 'x' + size); }

write('icon-192.png', 192, 192);
write('icon-512.png', 512, 512);
write('maskable-512.png', 512, 384); // art inside the central 75%, safe for any mask shape
write('apple-touch-icon.png', 180, 180);
