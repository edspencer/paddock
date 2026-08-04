/**
 * png.mjs — a minimal, dependency-free PNG writer.
 *
 * The demo's Read-an-image beat needs a real PNG on disk inside the project
 * directory (Paddock serves it through the project's raw-file endpoint, so a
 * placeholder path renders a broken image). Rather than ship a binary asset or
 * shell out to an image tool, we draw it: ~60 lines of zlib + CRC gets a
 * deterministic, reviewable, diff-free image that regenerates identically on
 * every run.
 */
import zlib from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A mutable RGB canvas. */
export class Canvas {
  constructor(width, height, bg = [0, 0, 0]) {
    this.width = width;
    this.height = height;
    this.px = Buffer.alloc(width * height * 3);
    this.fill(0, 0, width, height, bg);
  }

  fill(x, y, w, h, [r, g, b]) {
    for (let yy = Math.max(0, y); yy < Math.min(this.height, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(this.width, x + w); xx++) {
        const o = (yy * this.width + xx) * 3;
        this.px[o] = r;
        this.px[o + 1] = g;
        this.px[o + 2] = b;
      }
    }
  }

  /** Rounded-ish swatch: a filled rect with the corner pixels knocked out. */
  swatch(x, y, w, h, color, radius = 3) {
    this.fill(x, y, w, h, color);
    return { x, y, w, h, radius };
  }

  toPNG() {
    // Each scanline is prefixed with filter byte 0 (None).
    const raw = Buffer.alloc(this.height * (this.width * 3 + 1));
    for (let y = 0; y < this.height; y++) {
      const src = y * this.width * 3;
      const dst = y * (this.width * 3 + 1);
      raw[dst] = 0;
      this.px.copy(raw, dst + 1, src, src + this.width * 3);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.width, 0);
    ihdr.writeUInt32BE(this.height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // colour type: truecolour RGB
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }
}

/**
 * The demo asset: a terminal palette preview — two rows of eight swatches
 * (normal + bright ANSI), which is exactly what the seeded chat says it is.
 */
export function palettePreviewPNG() {
  const NORMAL = [
    [0x1c, 0x1b, 0x1a], [0xc2, 0x60, 0x3c], [0x7d, 0x9a, 0x62], [0xd0, 0xa2, 0x49],
    [0x5b, 0x82, 0xa8], [0x9a, 0x6d, 0xa8], [0x63, 0xa0, 0x9c], [0xd6, 0xd2, 0xc8],
  ];
  const BRIGHT = [
    [0x4a, 0x46, 0x42], [0xe0, 0x7b, 0x53], [0x9a, 0xba, 0x7c], [0xe8, 0xbe, 0x6a],
    [0x78, 0xa0, 0xc8], [0xb8, 0x8a, 0xc8], [0x82, 0xbf, 0xba], [0xf2, 0xef, 0xe8],
  ];
  const PAD = 16;
  const CELL = 60;
  const GAP = 8;
  const w = PAD * 2 + CELL * 8 + GAP * 7;
  const h = PAD * 2 + CELL * 2 + GAP;
  const c = new Canvas(w, h, [0x14, 0x13, 0x12]);
  BRIGHT.forEach((_, i) => {
    const x = PAD + i * (CELL + GAP);
    c.swatch(x, PAD, CELL, CELL, NORMAL[i]);
    c.swatch(x, PAD + CELL + GAP, CELL, CELL, BRIGHT[i]);
  });
  return c.toPNG();
}
