/* Opaque-pixel measurement of one owned window capture (`screencapture -l`).
 * Captures are taken at the backing scale of the display the window is on, so
 * the PNG size divided by the window's point size is that display's scale. */
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";

/** Minimal PNG decoder (8-bit RGB/RGBA, non-interlaced) → raw pixels. */
export function decodePng(png) {
  assert.equal(png.readUInt32BE(12), 0x49484452, "PNG IHDR");
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const depth = png[24];
  const color = png[25];
  assert.ok(depth === 8 && (color === 6 || color === 2), `Unsupported PNG ${depth}/${color}`);
  const channels = color === 6 ? 4 : 3;
  const chunks = [];
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const data = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = data[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const raw = data[y * (stride + 1) + 1 + x];
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      let value = raw;
      if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + up;
      else if (filter === 3) value = raw + ((left + up) >> 1);
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      }
      pixels[y * stride + x] = value & 0xff;
    }
  }
  return {
    width,
    height,
    channels,
    pixels,
    pixel: (x, y) => {
      const offset = (y * width + x) * channels;
      return [...pixels.subarray(offset, offset + channels), ...(channels === 3 ? [255] : [])];
    },
  };
}

/** Opaque-pixel bbox/count of a per-window capture. */
export function opaquePixels(png) {
  const { width, height, channels, pixels } = decodePng(png);
  let count = 0;
  const box = { left: width, top: height, right: -1, bottom: -1 };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const alpha = channels === 4 ? pixels[(y * width + x) * 4 + 3] : 255;
      if (alpha <= 32) continue;
      count++;
      box.left = Math.min(box.left, x);
      box.top = Math.min(box.top, y);
      box.right = Math.max(box.right, x);
      box.bottom = Math.max(box.bottom, y);
    }
  return { width, height, count, box: count ? box : null };
}
