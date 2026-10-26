const zlib = require('node:zlib');
const { nativeImage } = require('electron');

// Draws the app/tray icon in code (blue disc with a white pointer dot) so the
// repo needs no binary assets. scripts/install-app.mjs also uses makeIco()
// for the .exe icon.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// Returns PNG bytes for a size×size icon (anti-aliased edges).
function drawPng(size) {
  const rows = [];
  const c = (size - 1) / 2;
  const discR = size * 0.47;
  const dotR = size * 0.14;
  for (let y = 0; y < size; y++) {
    const row = [0];
    for (let x = 0; x < size; x++) {
      // Coverage in [0,1] from the distance to each circle's edge.
      const disc = Math.min(1, Math.max(0, discR - Math.hypot(x - c, y - c) + 0.5));
      const dot = Math.min(1, Math.max(0, dotR - Math.hypot(x - c * 1.25, y - c * 0.75) + 0.5));
      const mix = (blue, white) => Math.round(blue + (white - blue) * dot);
      row.push(mix(11, 255), mix(99, 255), mix(206, 255), Math.round(255 * disc));
    }
    rows.push(Buffer.from(row));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function makeIcon(size = 32) {
  return nativeImage.createFromBuffer(drawPng(size));
}

// Windows .ico containing PNG images (supported since Windows Vista).
function makeIco(sizes = [16, 24, 32, 48, 64, 128, 256]) {
  const pngs = sizes.map(drawPng);
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, i) => {
    const e = 6 + 16 * i;
    header[e] = size >= 256 ? 0 : size; // 0 means 256
    header[e + 1] = size >= 256 ? 0 : size;
    header.writeUInt16LE(1, e + 4); // colour planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(pngs[i].length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += pngs[i].length;
  });
  return Buffer.concat([header, ...pngs]);
}

module.exports = { makeIcon, makeIco, drawPng };
