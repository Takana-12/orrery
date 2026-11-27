// Draws the Orrery icons (no image tools needed): three tilted orbits around a small pale star, on deep indigo.
// An orrery is a model of bodies in orbit — here, agents going round while you watch from the middle.
// The tray icon has two states: quiet (all bodies pale) and "needs you" (one body turns amber).
// Windows takes icon.ico and the 32-pixel tray images; macOS takes icon.icns (the tile drawn smaller, with the margin
// Mac icons have) and 18-point tray images with @2x versions for the menu bar.
//   node apps/desktop/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
};

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const TILT = (-26 * Math.PI) / 180;
const SQUASH = 0.42; // how flat the orbits look (viewed at an angle)
const PALE = [0xc9, 0xd2, 0xf5];
const BLUE = [0x8f, 0xb4, 0xff];
const AMBER = [0xf4, 0xb7, 0x56];
const STAR = [0xff, 0xf6, 0xe0];

/** Colour of one sample point (0..1 coordinates). Returns [r, g, b, alpha 0..1]. */
function sample(x, y, { alert, small, scale = 1 }) {
  // rounded tile with a soft radial indigo; `scale` < 1 draws it smaller, leaving a transparent margin
  const cx = (x - 0.5) / scale;
  const cy = (y - 0.5) / scale;
  if (Math.abs(cx) > 0.5 || Math.abs(cy) > 0.5) return [0, 0, 0, 0];
  const r = 0.22;
  const dx = Math.max(Math.abs(cx) - (0.5 - r), 0);
  const dy = Math.max(Math.abs(cy) - (0.5 - r), 0);
  if (dx * dx + dy * dy > r * r) return [0, 0, 0, 0];
  const dist = Math.hypot(cx, cy);
  let col = mix([0x25, 0x2b, 0x55], [0x0b, 0x0d, 0x1c], Math.min(1, dist / 0.62));

  // into orbit space: undo the tilt, then un-squash
  const rx = cx * Math.cos(-TILT) - cy * Math.sin(-TILT);
  const ry = (cx * Math.sin(-TILT) + cy * Math.cos(-TILT)) / SQUASH;
  const rr = Math.hypot(rx, ry);
  const line = small ? 0.034 : 0.011;
  const orbits = small ? [0.2, 0.37] : [0.15, 0.27, 0.39];
  for (const [i, R] of orbits.entries()) {
    if (Math.abs(rr - R) < line) col = mix(col, PALE, small ? 0.6 : 0.5 - i * 0.08);
  }

  // the star: a small core with a glow
  const glow = Math.max(0, 1 - dist / (small ? 0.2 : 0.16));
  col = mix(col, STAR, glow * glow * 0.9);
  if (dist < (small ? 0.075 : 0.045)) col = STAR;

  // bodies on their orbits
  const body = (R, phi, size, colour) => {
    const u = R * Math.cos(phi);
    const v = R * Math.sin(phi) * SQUASH;
    const bx = u * Math.cos(TILT) - v * Math.sin(TILT);
    const by = u * Math.sin(TILT) + v * Math.cos(TILT);
    const d = Math.hypot(cx - bx, cy - by);
    if (colour === AMBER) col = mix(col, AMBER, Math.max(0, 1 - d / (size * 2.6)) ** 2 * 0.55); // warm halo
    if (d < size) col = colour;
  };
  if (small) {
    body(0.2, 2.5, 0.055, PALE);
    body(0.37, 5.6, alert ? 0.1 : 0.07, alert ? AMBER : BLUE);
  } else {
    body(0.15, 2.4, 0.022, PALE);
    body(0.27, 0.5, 0.03, BLUE);
    body(0.39, 3.9, 0.036, alert ? AMBER : PALE);
  }
  return [...col, 1];
}

function png(size, opts) {
  const S = 4;
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let R = 0, G = 0, B = 0, A = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const c = sample((x + (sx + 0.5) / S) / size, (y + (sy + 0.5) / S) / size, opts);
          R += c[0] * c[3]; G += c[1] * c[3]; B += c[2] * c[3]; A += c[3];
        }
      }
      const i = (y * size + x) * 4;
      px[i] = A ? R / A : 0;
      px[i + 1] = A ? G / A : 0;
      px[i + 2] = A ? B / A : 0;
      px[i + 3] = (A / (S * S)) * 255;
    }
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** An .ico that simply wraps PNG images (supported since Windows Vista). */
function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = 6 + 16 * pngs.length;
  const entries = pngs.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

/** An .icns that wraps PNG images (macOS 10.7 and later). */
function icns(pngs) {
  const TYPES = { 16: 'icp4', 32: 'icp5', 64: 'icp6', 128: 'ic07', 256: 'ic08', 512: 'ic09', 1024: 'ic10' };
  const entries = pngs.map(({ size, data }) => {
    const head = Buffer.alloc(8);
    head.write(TYPES[size], 0, 'ascii');
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const body = Buffer.concat(entries);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

writeFileSync(join(here, 'icon.png'), png(256, { alert: true, small: false }));
writeFileSync(join(here, 'icon.ico'), ico([16, 32, 48, 256].map((size) => ({ size, data: png(size, { alert: true, small: size < 48 }) }))));
writeFileSync(join(here, 'tray.png'), png(32, { alert: false, small: true }));
writeFileSync(join(here, 'tray-alert.png'), png(32, { alert: true, small: true }));
// macOS: Apple's icon grid puts the tile at 824 of 1024 pixels.
writeFileSync(join(here, 'icon.icns'), icns([16, 32, 64, 128, 256, 512, 1024].map((size) => ({ size, data: png(size, { alert: true, small: size < 48, scale: 824 / 1024 }) }))));
for (const [name, alert] of [['tray-mac', false], ['tray-mac-alert', true]]) {
  writeFileSync(join(here, `${name}.png`), png(18, { alert, small: true }));
  writeFileSync(join(here, `${name}@2x.png`), png(36, { alert, small: true }));
}
console.log('icons written');
