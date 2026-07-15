/** UTF-8-safe byte truncation shared by source adapters and the source tool boundary. */
export interface TruncatedText {
  text: string;
  truncated: boolean;
}

function normalizeByteLimit(maxBytes: number, byteLength: number): number {
  if (!Number.isFinite(maxBytes)) return 0;
  return Math.max(0, Math.min(Math.trunc(maxBytes), byteLength));
}

export function truncateUtf8Bytes(buffer: Buffer, maxBytes: number): TruncatedText {
  const limit = normalizeByteLimit(maxBytes, buffer.byteLength);
  if (buffer.byteLength <= limit) {
    return { text: buffer.toString("utf8"), truncated: false };
  }

  let end = limit;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return { text: buffer.subarray(0, end).toString("utf8"), truncated: true };
}

export function truncateUtf8Text(text: string, maxBytes: number): TruncatedText {
  return truncateUtf8Bytes(Buffer.from(text, "utf8"), maxBytes);
}
