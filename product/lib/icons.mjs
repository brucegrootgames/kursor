// Kursor product scripts — Apple ICNS and Windows ICO writers (plus readers used to verify them).
// Both containers accept raw PNG payloads: ICNS since Mac OS X 10.7 for the ic07…ic14 types,
// ICO since Windows Vista. The PNGs come straight from product/icons/kursor-<size>.png.

import fs from 'node:fs';
import path from 'node:path';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function pngSize(buf) {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('not a PNG file');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Reads product/icons/kursor-<n>.png for every size found → Map<size, Buffer>.
export function loadIconPngs(iconsDir) {
  const out = new Map();
  for (const name of fs.readdirSync(iconsDir)) {
    const m = /^kursor-(\d+)\.png$/.exec(name);
    if (!m) continue;
    const buf = fs.readFileSync(path.join(iconsDir, name));
    const { width, height } = pngSize(buf);
    if (width !== height || width !== Number(m[1])) throw new Error(`${name} is ${width}x${height}, expected ${m[1]}x${m[1]}`);
    out.set(width, buf);
  }
  return out;
}

// ---- ICNS -------------------------------------------------------------------------------------
// OSType per pixel size. 1x and 2x slots share one PNG where both exist (Finder picks by points + scale).
export const ICNS_TYPES = {
  32: ['ic11'],          // 16pt @2x
  64: ['ic12'],          // 32pt @2x
  128: ['ic07'],         // 128pt @1x
  256: ['ic08', 'ic13'], // 256pt @1x, 128pt @2x
  512: ['ic09', 'ic14'], // 512pt @1x, 256pt @2x
  1024: ['ic10'],        // 512pt @2x
};

export function buildIcns(pngsBySize) {
  const entries = [];
  for (const [size, types] of Object.entries(ICNS_TYPES)) {
    const png = pngsBySize.get(Number(size));
    if (!png) continue;
    for (const type of types) {
      const head = Buffer.alloc(8);
      head.write(type, 0, 4, 'latin1');
      head.writeUInt32BE(8 + png.length, 4);
      entries.push(head, png);
    }
  }
  if (!entries.length) throw new Error('no PNG sizes usable for an ICNS file (need 32…1024)');
  const body = Buffer.concat(entries);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'latin1');
  header.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([header, body]);
}

export function parseIcns(buf) {
  if (buf.toString('latin1', 0, 4) !== 'icns') throw new Error('bad ICNS magic');
  const total = buf.readUInt32BE(4);
  if (total !== buf.length) throw new Error(`ICNS length ${total} != file size ${buf.length}`);
  const entries = [];
  for (let off = 8; off < buf.length;) {
    const type = buf.toString('latin1', off, off + 4);
    const len = buf.readUInt32BE(off + 4);
    const payload = buf.subarray(off + 8, off + len);
    const png = payload.subarray(0, 8).equals(PNG_MAGIC) ? pngSize(payload) : null;
    entries.push({ type, length: len, png });
    off += len;
  }
  return { total, entries };
}

// ---- ICO --------------------------------------------------------------------------------------
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

export function buildIco(pngsBySize, sizes = ICO_SIZES) {
  const images = sizes.filter((s) => pngsBySize.has(s)).map((s) => ({ size: s, png: pngsBySize.get(s) }));
  if (!images.length) throw new Error('no PNG sizes usable for an ICO file');
  const dir = Buffer.alloc(6 + 16 * images.length);
  dir.writeUInt16LE(0, 0);             // reserved
  dir.writeUInt16LE(1, 2);             // type: icon
  dir.writeUInt16LE(images.length, 4); // count
  let offset = dir.length;
  images.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    dir.writeUInt8(size >= 256 ? 0 : size, e);     // width  (0 = 256)
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1); // height
    dir.writeUInt8(0, e + 2);                      // palette
    dir.writeUInt8(0, e + 3);                      // reserved
    dir.writeUInt16LE(1, e + 4);                   // colour planes
    dir.writeUInt16LE(32, e + 6);                  // bits per pixel
    dir.writeUInt32LE(png.length, e + 8);          // bytes in resource
    dir.writeUInt32LE(offset, e + 12);             // offset from start of file
    offset += png.length;
  });
  return Buffer.concat([dir, ...images.map((i) => i.png)]);
}

export function parseIco(buf) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('bad ICO header');
  const count = buf.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + 16 * i;
    const size = buf.readUInt32LE(e + 8);
    const offset = buf.readUInt32LE(e + 12);
    const payload = buf.subarray(offset, offset + size);
    const isPng = payload.subarray(0, 8).equals(PNG_MAGIC);
    entries.push({
      width: buf.readUInt8(e) || 256, height: buf.readUInt8(e + 1) || 256,
      bpp: buf.readUInt16LE(e + 6), size, offset, isPng, png: isPng ? pngSize(payload) : null,
    });
  }
  return { count, entries };
}
