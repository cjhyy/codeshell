/**
 * Pure helpers for the "download image" action behind the Lightbox. Kept free
 * of Electron so they're unit-testable: the IPC handler in index.ts wires these
 * to a save dialog + fs write.
 */

export interface ParsedDataUrl {
  mime: string;
  /** Raw bytes of the image. */
  buffer: Buffer;
}

const DATA_URL_RE = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/;

/**
 * Decode a `data:` URL into its mime + bytes. Returns null for anything that
 * isn't a data URL (e.g. an `https:`/`file:` src we can't write directly), so
 * the caller can fall back to copying an on-disk file instead.
 */
export function parseDataUrl(src: string): ParsedDataUrl | null {
  if (typeof src !== "string") return null;
  const m = DATA_URL_RE.exec(src);
  if (!m) return null;
  const mime = m[1] || "application/octet-stream";
  const isBase64 = Boolean(m[2]);
  const data = m[3] ?? "";
  // A non-base64 data URL with a malformed %-sequence (e.g. `data:text/plain,%ZZ`)
  // makes decodeURIComponent throw URIError. This fn's contract is "return null
  // on failure so the caller falls back" — honor it instead of throwing out.
  let buffer: Buffer;
  try {
    buffer = isBase64 ? Buffer.from(data, "base64") : Buffer.from(decodeURIComponent(data), "utf8");
  } catch {
    return null;
  }
  return { mime, buffer };
}

const MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/bmp": ".bmp",
  "image/avif": ".avif",
};

/** Pick a file extension for a mime, defaulting to .png for unknown images. */
export function extForMime(mime: string): string {
  return MIME_EXT[mime.toLowerCase()] ?? ".png";
}

/**
 * Suggest a download filename. Prefers the source filename (a real path or a
 * pasted attachment's name); falls back to a timestamped name when there's
 * nothing meaningful. The timestamp is supplied by the caller because
 * Date.now() is banned in some envs and we want this pure/testable.
 */
export function suggestImageFilename(
  opts: { name?: string | null; mime?: string | null; stamp: string },
): string {
  const ext = extForMime(opts.mime ?? "image/png");
  const raw = (opts.name ?? "").trim();
  if (raw) {
    // Strip any directory part; keep just the basename.
    const base = raw.split(/[\\/]/).pop() ?? raw;
    if (base) {
      // Ensure it has an image extension; if it already ends in one, keep it.
      return /\.[a-z0-9]{2,5}$/i.test(base) ? base : base + ext;
    }
  }
  return `image-${opts.stamp}${ext}`;
}
