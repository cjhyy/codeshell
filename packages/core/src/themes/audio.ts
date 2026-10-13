/** PCM WAV is the only installed audio format; packs never supply decoders. */
export interface ThemeWavInfo {
  mediaType: "audio/wav";
  channels: 1 | 2;
  sampleRate: number;
  durationSeconds: number;
}

export const MAX_THEME_SOUND_BYTES = 2 * 1024 * 1024;
export const MAX_THEME_MUSIC_BYTES = 32 * 1024 * 1024;

/** Validate the complete RIFF layout, not merely a WAV signature or extension. */
export function detectThemeWav(bytes: Uint8Array): ThemeWavInfo | null {
  if (bytes.byteLength < 44) return null;
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    data.toString("latin1", 0, 4) !== "RIFF" ||
    data.toString("latin1", 8, 12) !== "WAVE" ||
    data.readUInt32LE(4) !== data.length - 8
  ) {
    return null;
  }
  let format: { channels: 1 | 2; sampleRate: number; blockAlign: number } | undefined;
  let sampleBytes: number | undefined;
  let offset = 12;
  while (offset < data.length) {
    if (offset + 8 > data.length) return null;
    const id = data.toString("latin1", offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    const next = end + (size % 2);
    if (next > data.length) return null;
    if (id === "fmt ") {
      // PCM's optional extension must be empty. Float, compressed and
      // extensible formats require additional decoder policy and are rejected.
      if (format || (size !== 16 && size !== 18)) return null;
      if (size === 18 && data.readUInt16LE(start + 16) !== 0) return null;
      const encoding = data.readUInt16LE(start);
      const channels = data.readUInt16LE(start + 2);
      const sampleRate = data.readUInt32LE(start + 4);
      const byteRate = data.readUInt32LE(start + 8);
      const blockAlign = data.readUInt16LE(start + 12);
      const bitsPerSample = data.readUInt16LE(start + 14);
      if (
        encoding !== 1 ||
        (channels !== 1 && channels !== 2) ||
        bitsPerSample !== 16 ||
        sampleRate < 8_000 ||
        sampleRate > 96_000 ||
        blockAlign !== channels * 2 ||
        byteRate !== sampleRate * blockAlign
      ) {
        return null;
      }
      format = { channels, sampleRate, blockAlign };
    } else if (id === "data") {
      if (sampleBytes !== undefined || size === 0) return null;
      sampleBytes = size;
    }
    offset = next;
  }
  if (!format || sampleBytes === undefined || sampleBytes % format.blockAlign !== 0) return null;
  return {
    mediaType: "audio/wav",
    channels: format.channels,
    sampleRate: format.sampleRate,
    durationSeconds: sampleBytes / (format.sampleRate * format.blockAlign),
  };
}
