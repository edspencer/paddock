/**
 * png.mjs — minimal PNG decoder (8-bit, non-interlaced) + pixel helpers.
 *
 * Why hand-roll this instead of pulling `sharp`/`canvas`?
 *  - This box has no ImageMagick and no native image module in node_modules,
 *    and NODE_ENV=production makes installing native deps a coin flip.
 *  - We only ever decode PNGs that *we* just produced with ffmpeg, so the
 *    format space is tiny and fully known: 8-bit, non-interlaced, RGBA/RGB/GRAY.
 *
 * Used for two things, both load-bearing:
 *  1. caption.mjs measures the ink bounding box of rendered text (so the pill
 *     hugs the glyphs) — no font-metrics library required, works for any script.
 *  2. verify.mjs proves a caption is actually visible in an extracted frame by
 *     comparing real pixels, not by eyeballing.
 */
import fs from "node:fs";
import zlib from "node:zlib";

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * Decode a PNG file to raw RGBA.
 * @returns {{width:number,height:number,data:Buffer}} data is w*h*4 RGBA bytes.
 */
export function readPng(file) {
  const buf = fs.readFileSync(file);
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error(`not a PNG: ${file}`);

  let off = 8;
  let ihdr = null;
  const idat = [];
  let palette = null;
  let trns = null;

  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      ihdr = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8],
        colorType: body[9],
        interlace: body[12],
      };
    } else if (type === "IDAT") idat.push(body);
    else if (type === "PLTE") palette = Buffer.from(body);
    else if (type === "tRNS") trns = Buffer.from(body);
    else if (type === "IEND") break;
    off += 12 + len; // len + type + data + crc
  }

  if (!ihdr) throw new Error(`no IHDR in ${file}`);
  if (ihdr.bitDepth !== 8) throw new Error(`unsupported bit depth ${ihdr.bitDepth} in ${file}`);
  if (ihdr.interlace !== 0) throw new Error(`interlaced PNG unsupported: ${file}`);
  const nc = CHANNELS[ihdr.colorType];
  if (!nc) throw new Error(`unsupported color type ${ihdr.colorType} in ${file}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width: w, height: h } = ihdr;
  const stride = w * nc;
  const px = Buffer.alloc(h * stride);

  // Undo the per-scanline PNG filters (RFC 2083 §6).
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + stride);
    p += stride;
    const outRow = y * stride;
    const prevRow = outRow - stride;
    for (let i = 0; i < stride; i++) {
      const x = line[i];
      const a = i >= nc ? px[outRow + i - nc] : 0;
      const b = y > 0 ? px[prevRow + i] : 0;
      const c = y > 0 && i >= nc ? px[prevRow + i - nc] : 0;
      let v;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const pp = a + b - c;
          const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`bad PNG filter ${filter} on row ${y}`);
      }
      px[outRow + i] = v & 0xff;
    }
  }

  // Normalise every colour type to RGBA.
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0, n = w * h; i < n; i++) {
    const s = i * nc, d = i * 4;
    switch (ihdr.colorType) {
      case 0: data[d] = data[d + 1] = data[d + 2] = px[s]; data[d + 3] = 255; break;
      case 2: data[d] = px[s]; data[d + 1] = px[s + 1]; data[d + 2] = px[s + 2]; data[d + 3] = 255; break;
      case 3: {
        const idx = px[s];
        data[d] = palette[idx * 3]; data[d + 1] = palette[idx * 3 + 1]; data[d + 2] = palette[idx * 3 + 2];
        data[d + 3] = trns && idx < trns.length ? trns[idx] : 255;
        break;
      }
      case 4: data[d] = data[d + 1] = data[d + 2] = px[s]; data[d + 3] = px[s + 1]; break;
      case 6: px.copy(data, d, s, s + 4); break;
    }
  }
  return { width: w, height: h, data };
}

/**
 * Bounding box of pixels whose alpha > threshold ("where the ink is").
 * @returns {{x:number,y:number,w:number,h:number}|null} null if fully transparent.
 */
export function alphaBBox(img, threshold = 8) {
  const { width, height, data } = img;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Mean per-channel absolute difference between two same-size images, 0..255. */
export function meanAbsDiff(a, b, region) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  const r = region ?? { x: 0, y: 0, w: a.width, h: a.height };
  let sum = 0, n = 0;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * a.width + x) * 4;
      sum += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
      n += 3;
    }
  }
  return n ? sum / n : 0;
}

/** Fraction of pixels in `region` differing by more than `tol` on any channel. */
export function changedFraction(a, b, region, tol = 12) {
  const r = region ?? { x: 0, y: 0, w: a.width, h: a.height };
  let hit = 0, n = 0;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * a.width + x) * 4;
      const d = Math.max(
        Math.abs(a.data[i] - b.data[i]),
        Math.abs(a.data[i + 1] - b.data[i + 1]),
        Math.abs(a.data[i + 2] - b.data[i + 2]),
      );
      if (d > tol) hit++;
      n++;
    }
  }
  return n ? hit / n : 0;
}

/** Count pixels in `region` within `tol` of an [r,g,b] colour. */
export function countNear(img, rgb, region, tol = 26) {
  const r = region ?? { x: 0, y: 0, w: img.width, h: img.height };
  let hit = 0;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * img.width + x) * 4;
      if (Math.abs(img.data[i] - rgb[0]) <= tol &&
          Math.abs(img.data[i + 1] - rgb[1]) <= tol &&
          Math.abs(img.data[i + 2] - rgb[2]) <= tol) hit++;
    }
  }
  return hit;
}
