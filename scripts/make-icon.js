'use strict';
/**
 * Generates assets/icon.png (256x256): indigo→purple rounded square with a white "K".
 * Pure Node (zlib) — no image libraries needed.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = Number(process.argv[2]) || 256;
const F = S / 256; // scale factor for geometry
const px = Buffer.alloc(S * S * 4);

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = Array.from({ length: 256 }, (_, n) => {
    c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  }));
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function distToSeg(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

const R = 56 * F; // corner radius
const from = [0x63, 0x66, 0xf1];
const to = [0x8b, 0x5c, 0xf6];
const strokes = [
  [92, 64, 92, 192],
  [92, 132, 168, 64],
  [112, 114, 170, 192],
].map((s) => s.map((v) => v * F));

for (let y = 0; y < S; y += 1) {
  for (let x = 0; x < S; x += 1) {
    const i = (y * S + x) * 4;
    // rounded-square coverage (anti-aliased)
    const cx = Math.min(Math.max(x + 0.5, R), S - R);
    const cy = Math.min(Math.max(y + 0.5, R), S - R);
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    const alpha = Math.max(0, Math.min(1, R - d + 0.5));
    if (alpha <= 0) continue;
    const t = (x + y) / (2 * S);
    let r = from[0] + (to[0] - from[0]) * t;
    let g = from[1] + (to[1] - from[1]) * t;
    let b = from[2] + (to[2] - from[2]) * t;
    const kd = Math.min(...strokes.map((s) => distToSeg(x + 0.5, y + 0.5, ...s)));
    const k = Math.max(0, Math.min(1, 13 * F - kd + 0.5));
    r = r + (255 - r) * k;
    g = g + (255 - g) * k;
    b = b + (255 - b) * k;
    px[i] = Math.round(r);
    px[i + 1] = Math.round(g);
    px[i + 2] = Math.round(b);
    px[i + 3] = Math.round(alpha * 255);
  }
}

const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y += 1) {
  raw[y * (S * 4 + 1)] = 0;
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = process.argv[3] || path.join(__dirname, '..', 'assets', S === 256 ? 'icon.png' : `icon-${S}.png`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
