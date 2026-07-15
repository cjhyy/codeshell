export interface ProbedImage {
  mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  width: number;
  height: number;
}

type SupportedImageMime = ProbedImage["mime"];

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function invalid(mime: string, detail: string): never {
  throw new Error(`invalid ${mime} image structure: ${detail}`);
}

function ascii(buffer: Buffer, start: number, length: number): string {
  return buffer.toString("ascii", start, start + length);
}

function detectMime(buffer: Buffer): SupportedImageMime | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 6 &&
    (ascii(buffer, 0, 6) === "GIF87a" || ascii(buffer, 0, 6) === "GIF89a")
  ) {
    return "image/gif";
  }
  if (buffer.length >= 12 && ascii(buffer, 0, 4) === "RIFF" && ascii(buffer, 8, 4) === "WEBP") {
    return "image/webp";
  }
  return null;
}

function crc32(buffer: Buffer, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc ^= buffer[index]!;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function probePng(buffer: Buffer): ProbedImage {
  if (buffer.length < 33) invalid("PNG", "truncated header");
  let offset = 8;
  let width = 0;
  let height = 0;
  let chunks = 0;
  let sawData = false;
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) invalid("PNG", "truncated chunk header");
    const length = buffer.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = typeStart + 4;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (chunkEnd > buffer.length) invalid("PNG", "truncated chunk payload");
    const type = ascii(buffer, typeStart, 4);
    if (!/^[A-Za-z]{4}$/.test(type)) invalid("PNG", "invalid chunk type");
    if (buffer.readUInt32BE(dataEnd) !== crc32(buffer, typeStart, dataEnd)) {
      invalid("PNG", `${type} CRC mismatch`);
    }
    if (chunks === 0) {
      if (type !== "IHDR" || length !== 13) invalid("PNG", "IHDR must be first");
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      if (width === 0 || height === 0) invalid("PNG", "zero dimensions");
      if (buffer[dataStart + 10] !== 0 || buffer[dataStart + 11] !== 0) {
        invalid("PNG", "unsupported compression or filter method");
      }
      if ((buffer[dataStart + 12] ?? 2) > 1) invalid("PNG", "invalid interlace method");
    }
    if (type === "IDAT") sawData = true;
    if (type === "IEND") {
      if (length !== 0 || !sawData || chunkEnd !== buffer.length) {
        invalid("PNG", "invalid IEND or missing image data");
      }
      return { mime: "image/png", width, height };
    }
    offset = chunkEnd;
    chunks += 1;
  }
  return invalid("PNG", "missing IEND");
}

function probeJpeg(buffer: Buffer): ProbedImage {
  if (buffer.length < 16) invalid("JPEG", "truncated header");
  let offset = 2;
  let width = 0;
  let height = 0;
  let sawScan = false;
  let sawQuantization = false;
  let sawEntropyTable = false;

  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) invalid("JPEG", "expected marker");
    while (buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) invalid("JPEG", "truncated marker");
    const marker = buffer[offset++]!;
    if (marker === 0xd9) {
      if (!width || !height || !sawScan || !sawQuantization || !sawEntropyTable) {
        invalid("JPEG", "missing frame, tables, or scan");
      }
      if (offset !== buffer.length) invalid("JPEG", "trailing bytes after EOI");
      return { mime: "image/jpeg", width, height };
    }
    if (marker === 0x00 || marker === 0xd8) invalid("JPEG", "invalid marker ordering");
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) invalid("JPEG", "truncated segment length");
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) {
      invalid("JPEG", "truncated segment");
    }
    const payload = offset + 2;
    const segmentEnd = offset + segmentLength;
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 8) invalid("JPEG", "short SOF segment");
      height = buffer.readUInt16BE(payload + 1);
      width = buffer.readUInt16BE(payload + 3);
      if (!width || !height) invalid("JPEG", "zero dimensions");
    } else if (marker === 0xdb) {
      sawQuantization = true;
    } else if (marker === 0xc4 || marker === 0xcc) {
      sawEntropyTable = true;
    } else if (marker === 0xda) {
      if (segmentLength < 6) invalid("JPEG", "short SOS segment");
      sawScan = true;
      offset = segmentEnd;
      while (offset < buffer.length) {
        if (buffer[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        let next = offset + 1;
        while (buffer[next] === 0xff) next += 1;
        if (next >= buffer.length) invalid("JPEG", "truncated entropy marker");
        const code = buffer[next]!;
        if (code === 0x00 || (code >= 0xd0 && code <= 0xd7)) {
          offset = next + 1;
          continue;
        }
        // Let the outer marker parser consume EOI or a progressive scan marker.
        break;
      }
      continue;
    }
    offset = segmentEnd;
  }
  return invalid("JPEG", "missing EOI");
}

function skipGifSubBlocks(buffer: Buffer, start: number): number {
  let offset = start;
  while (offset < buffer.length) {
    const length = buffer[offset++]!;
    if (length === 0) return offset;
    if (offset + length > buffer.length) invalid("GIF", "truncated data sub-block");
    offset += length;
  }
  return invalid("GIF", "unterminated data sub-blocks");
}

function probeGif(buffer: Buffer): ProbedImage {
  if (buffer.length < 14) invalid("GIF", "truncated logical screen descriptor");
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  if (!width || !height) invalid("GIF", "zero dimensions");
  const globalTableBytes = buffer[10]! & 0x80 ? 3 * 2 ** ((buffer[10]! & 0x07) + 1) : 0;
  let offset = 13 + globalTableBytes;
  if (offset > buffer.length) invalid("GIF", "truncated global color table");
  let sawImage = false;
  while (offset < buffer.length) {
    const introducer = buffer[offset]!;
    if (introducer === 0x3b) {
      if (!sawImage || offset + 1 !== buffer.length) invalid("GIF", "invalid trailer");
      return { mime: "image/gif", width, height };
    }
    if (introducer === 0x21) {
      if (offset + 2 > buffer.length) invalid("GIF", "truncated extension");
      offset = skipGifSubBlocks(buffer, offset + 2);
      continue;
    }
    if (introducer !== 0x2c || offset + 10 > buffer.length) {
      invalid("GIF", "invalid image block");
    }
    const packed = buffer[offset + 9]!;
    offset += 10;
    if (packed & 0x80) offset += 3 * 2 ** ((packed & 0x07) + 1);
    if (offset >= buffer.length) invalid("GIF", "truncated local table or LZW header");
    const minimumCodeSize = buffer[offset++]!;
    if (minimumCodeSize < 2 || minimumCodeSize > 11) invalid("GIF", "invalid LZW code size");
    offset = skipGifSubBlocks(buffer, offset);
    sawImage = true;
  }
  return invalid("GIF", "missing trailer");
}

function readUint24LE(buffer: Buffer, offset: number): number {
  return buffer[offset]! | (buffer[offset + 1]! << 8) | (buffer[offset + 2]! << 16);
}

function probeWebp(buffer: Buffer): ProbedImage {
  if (buffer.length < 20) invalid("WebP", "truncated RIFF header");
  if (buffer.readUInt32LE(4) !== buffer.length - 8) invalid("WebP", "RIFF size mismatch");
  let offset = 12;
  let width = 0;
  let height = 0;
  let sawImagePayload = false;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) invalid("WebP", "truncated chunk header");
    const type = ascii(buffer, offset, 4);
    const size = buffer.readUInt32LE(offset + 4);
    const payload = offset + 8;
    const end = payload + size;
    const paddedEnd = end + (size & 1);
    if (end > buffer.length || paddedEnd > buffer.length) invalid("WebP", "truncated chunk");
    if (type === "VP8 ") {
      if (
        size < 10 ||
        buffer[payload + 3] !== 0x9d ||
        buffer[payload + 4] !== 0x01 ||
        buffer[payload + 5] !== 0x2a
      ) {
        invalid("WebP", "invalid VP8 frame header");
      }
      width = buffer.readUInt16LE(payload + 6) & 0x3fff;
      height = buffer.readUInt16LE(payload + 8) & 0x3fff;
      sawImagePayload = true;
    } else if (type === "VP8L") {
      if (size < 5 || buffer[payload] !== 0x2f) invalid("WebP", "invalid VP8L header");
      const bits = buffer.readUInt32LE(payload + 1);
      if (bits >>> 29) invalid("WebP", "unsupported VP8L version");
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
      sawImagePayload = true;
    } else if (type === "VP8X") {
      if (size !== 10) invalid("WebP", "invalid VP8X header");
      width = readUint24LE(buffer, payload + 4) + 1;
      height = readUint24LE(buffer, payload + 7) + 1;
    } else if (type === "ANMF") {
      if (size < 16) invalid("WebP", "short animation frame");
      sawImagePayload = true;
    }
    offset = paddedEnd;
  }
  if (offset !== buffer.length || !width || !height || !sawImagePayload) {
    invalid("WebP", "missing dimensions or image payload");
  }
  return { mime: "image/webp", width, height };
}

/** Verify byte signature, bounded container structure, and declared MIME before staging. */
export function probeImageBytes(declaredMime: string, bytes: Uint8Array): ProbedImage {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const mime = declaredMime === "image/jpg" ? "image/jpeg" : declaredMime;
  const detected = detectMime(buffer);
  if (!detected) throw new Error("image byte signature is not a supported image");
  if (detected !== mime) {
    throw new Error(`image MIME ${mime} does not match byte signature ${detected}`);
  }
  switch (detected) {
    case "image/png":
      return probePng(buffer);
    case "image/jpeg":
      return probeJpeg(buffer);
    case "image/gif":
      return probeGif(buffer);
    case "image/webp":
      return probeWebp(buffer);
  }
}
