/**
 * Magic-number image validation for theme-pack assets. Mirrors the desktop
 * plugin-media detector (PNG IHDR / JPEG SOF / WebP dimensions) and adds GIF so
 * theme sprites can be animated: a theme pack's "motion" comes from the image
 * format itself (APNG / animated WebP / GIF), never from executable content.
 *
 * We validate the true format by bytes (not by extension), enforce sane bounds,
 * and return the canonical media type + extension the installer renames to.
 */

export type ThemeImageType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface ThemeImageInfo {
  mediaType: ThemeImageType;
  ext: "png" | "jpg" | "webp" | "gif";
  width: number;
  height: number;
}

const MAX_DIMENSION = 8192;
const MAX_PIXELS = 40_000_000;

const EXT_BY_TYPE: Record<ThemeImageType, ThemeImageInfo["ext"]> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

function jpegDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset];
    offset += 1;
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      continue;
    }
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isStartOfFrame) {
      if (length < 7) return null;
      return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  return null;
}

function readUInt24LE(bytes: Buffer, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function webpDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (
    bytes.length < 30 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP" ||
    bytes.readUInt32LE(4) + 8 > bytes.length
  ) {
    return null;
  }
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8X")
    return { width: readUInt24LE(bytes, 24) + 1, height: readUInt24LE(bytes, 27) + 1 };
  if (chunk === "VP8L" && bytes[20] === 0x2f) {
    return {
      width: 1 + (((bytes[22] & 0x3f) << 8) | bytes[21]),
      height: 1 + (((bytes[24] & 0x0f) << 10) | (bytes[23] << 2) | (bytes[22] >> 6)),
    };
  }
  if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

/** Detect the true image type + dimensions from the first bytes, or null. */
export function detectThemeImage(bytes: Buffer): ThemeImageInfo | null {
  let type: ThemeImageType | null = null;
  let dims: { width: number; height: number } | null = null;

  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.readUInt32BE(8) === 13 &&
    bytes.toString("ascii", 12, 16) === "IHDR"
  ) {
    // PNG (and APNG, which shares the PNG signature — its acTL chunk just adds
    // animation; we accept it as a valid PNG without needing to parse frames).
    type = "image/png";
    dims = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  } else if (
    bytes.length >= 10 &&
    (bytes.toString("ascii", 0, 6) === "GIF87a" || bytes.toString("ascii", 0, 6) === "GIF89a")
  ) {
    // GIF (may be animated) — logical screen dimensions are LE at offset 6.
    type = "image/gif";
    dims = { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  } else {
    const jpeg = jpegDimensions(bytes);
    if (jpeg) {
      type = "image/jpeg";
      dims = jpeg;
    } else {
      const webp = webpDimensions(bytes);
      if (webp) {
        type = "image/webp";
        dims = webp;
      }
    }
  }

  if (!type || !dims) return null;
  if (
    dims.width <= 0 ||
    dims.height <= 0 ||
    dims.width > MAX_DIMENSION ||
    dims.height > MAX_DIMENSION ||
    dims.width * dims.height > MAX_PIXELS
  ) {
    return null;
  }
  return { mediaType: type, ext: EXT_BY_TYPE[type], width: dims.width, height: dims.height };
}
