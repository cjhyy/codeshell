/**
 * Engine-side image compression — the fallback for hosts that didn't
 * pre-compress.
 *
 * The desktop renderer already compresses via <canvas> + Blob before
 * sending; the TUI and MCP image-returning tools historically didn't.
 * When the {@link enforceImagePolicy} gate would otherwise refuse a
 * turn for "image too large", we try to bring the offender(s) under
 * the limit first by:
 *
 *   1. Decoding the base64 payload.
 *   2. Resizing the longest edge down to {@link IMAGE_TARGETS.targetMaxDimension}.
 *   3. Re-encoding as JPEG at {@link IMAGE_TARGETS.jpegQuality}.
 *
 * jimp is the obvious pick — pure-JS, no native binaries, runs in
 * both Node and Bun, supports PNG / JPEG / WebP input. But shipping
 * it as a hard `core` dep would balloon the published bundle for
 * every consumer. So we resolve it dynamically: hosts that want
 * automatic compression just `npm install jimp`; everyone else gets
 * the existing "image too large" refusal.
 *
 * Hosts can also inject a custom {@link ImageCompressor} via
 * {@link setEngineImageCompressor} — useful for tests, future
 * sharp-based compressors, or arena agents with different size
 * targets.
 *
 * The defaults must stay pure-JS so this module is safe to bundle for
 * Electron preload / browser worker contexts. Anything that needs
 * native code (e.g. sharp) should be injected explicitly.
 */

import type { ParsedImage } from "./parse-task.js";
import { IMAGE_LIMITS, IMAGE_TARGETS, byteLengthFromBase64 } from "./image-policy.js";

/**
 * Outcome of one compression attempt. `compressed` is set only when
 * the host actually re-encoded the image — callers can compare bytes
 * before/after to decide whether to log the optimization.
 */
export interface ImageCompressionResult {
  /** The (possibly) re-encoded image, ready to replace the original. */
  image: ParsedImage;
  /** True if the host actually produced new bytes. */
  compressed: boolean;
  /** Source size in decoded bytes (informational only). */
  originalBytes: number;
  /** Final size in decoded bytes (informational only). */
  finalBytes: number;
}

/**
 * Compressor strategy. Implementations should be idempotent — re-
 * running compression on an already-small image should be a no-op,
 * returning `compressed: false`.
 */
export interface ImageCompressor {
  /**
   * Attempt to bring `image` under `maxBytes`. Implementations may
   * downscale, re-encode, or otherwise transform the payload. Return
   * the original image with `compressed: false` if nothing helped.
   *
   * Implementations MUST NOT mutate `image` — return a new ParsedImage
   * with the new base64.
   */
  compress(image: ParsedImage, maxBytes: number): Promise<ImageCompressionResult>;
}

/**
 * No-op compressor: returns the input unchanged. Used when the host
 * didn't install jimp and didn't inject anything else, so behavior
 * stays the same as before this module existed.
 */
const NOOP_COMPRESSOR: ImageCompressor = {
  async compress(image, _maxBytes) {
    const bytes = byteLengthFromBase64(image.base64);
    return {
      image,
      compressed: false,
      originalBytes: bytes,
      finalBytes: bytes,
    };
  },
};

let activeCompressor: ImageCompressor | null = null;

/**
 * Override the engine's active compressor. Pass `null` to clear the
 * override and fall back to lazy jimp resolution. Hosts that want
 * deterministic behavior in tests typically call this with a stub.
 */
export function setEngineImageCompressor(c: ImageCompressor | null): void {
  activeCompressor = c;
}

/** Reset state — for tests. */
export function resetEngineImageCompressor(): void {
  activeCompressor = null;
  cachedJimpCompressor = null;
}

let cachedJimpCompressor: ImageCompressor | null = null;

/**
 * Resolve a jimp-backed compressor on first call. If jimp isn't
 * installed, cache the no-op and stop retrying.
 *
 * jimp's API: `await Jimp.read(buffer)` → resize / quality / getBuffer.
 * v0.x used CamelCase constants (e.g. `Jimp.MIME_JPEG`); v1 moved to
 * an explicit string mime arg. We accept both by feature-testing.
 */
async function resolveJimpCompressor(): Promise<ImageCompressor> {
  if (cachedJimpCompressor) return cachedJimpCompressor;
  try {
    // Dynamic import so consumers without jimp installed don't pay
    // the bundle cost. The default export shape differs across v0/v1,
    // hence the `any` cast. The literal module specifier is a string
    // we resolve at runtime — TS sees no type info for it and would
    // otherwise error TS2307 when jimp isn't on the host's path.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dynImport = (s: string): Promise<any> =>
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      (Function("s", "return import(s)") as (s: string) => Promise<unknown>)(s) as Promise<any>;
    const mod = (await dynImport("jimp")) as unknown as Record<string, unknown>;
    const Jimp = (mod.default ?? mod.Jimp ?? mod) as unknown as {
      read: (input: Buffer) => Promise<JimpImage>;
      MIME_JPEG?: string;
    };
    cachedJimpCompressor = {
      async compress(image, maxBytes) {
        const original = Buffer.from(image.base64, "base64");
        const originalBytes = original.byteLength;
        if (originalBytes <= maxBytes) {
          return { image, compressed: false, originalBytes, finalBytes: originalBytes };
        }

        let pic: JimpImage;
        try {
          pic = await Jimp.read(original);
        } catch {
          // Unknown / corrupt format. Leave it alone; the policy gate
          // will refuse and surface a meaningful message to the user.
          return { image, compressed: false, originalBytes, finalBytes: originalBytes };
        }

        // Scale longest edge down to the target. We may still be over
        // after one pass for very large source images, so loop with
        // decreasing quality / dimension until under cap or we hit the
        // floor.
        const targets = [
          { dim: IMAGE_TARGETS.targetMaxDimension, q: Math.round(IMAGE_TARGETS.jpegQuality * 100) },
          { dim: 1280, q: 75 },
          { dim: 1024, q: 65 },
          { dim: 800, q: 55 },
        ];
        const mime = Jimp.MIME_JPEG ?? "image/jpeg";
        let bestBuf: Buffer | null = null;
        for (const t of targets) {
          const w = pic.bitmap?.width ?? t.dim;
          const h = pic.bitmap?.height ?? t.dim;
          const longest = Math.max(w, h);
          // Only scale down — never up an already-small image.
          if (longest > t.dim) {
            if (w >= h) {
              pic.resize(t.dim, Math.round((h / w) * t.dim));
            } else {
              pic.resize(Math.round((w / h) * t.dim), t.dim);
            }
          }
          pic.quality(t.q);
          const buf: Buffer = await pic.getBufferAsync(mime);
          if (buf.byteLength <= maxBytes) {
            bestBuf = buf;
            break;
          }
          bestBuf = buf;
        }

        if (!bestBuf) {
          return { image, compressed: false, originalBytes, finalBytes: originalBytes };
        }
        const finalBytes = bestBuf.byteLength;
        const out: ParsedImage = {
          ...image,
          base64: bestBuf.toString("base64"),
          mime: "image/jpeg",
        };
        return {
          image: out,
          compressed: true,
          originalBytes,
          finalBytes,
        };
      },
    };
  } catch {
    cachedJimpCompressor = NOOP_COMPRESSOR;
  }
  return cachedJimpCompressor;
}

interface JimpImage {
  bitmap?: { width: number; height: number };
  resize: (w: number, h: number) => JimpImage;
  quality: (q: number) => JimpImage;
  getBufferAsync: (mime: string) => Promise<Buffer>;
}

/**
 * Try compressing every image in the batch so it fits under the
 * single-image cap. Returns the (possibly transformed) batch plus a
 * summary of what changed. Callers should hand the returned images
 * back into {@link enforceImagePolicy} to confirm; this function
 * doesn't itself decide whether the result is acceptable.
 */
export async function tryCompressImages(
  images: readonly ParsedImage[],
): Promise<{ images: ParsedImage[]; anyCompressed: boolean }> {
  if (images.length === 0) return { images: [], anyCompressed: false };
  const compressor = activeCompressor ?? (await resolveJimpCompressor());
  if (compressor === NOOP_COMPRESSOR) {
    return { images: images.slice(), anyCompressed: false };
  }

  const out: ParsedImage[] = [];
  let anyCompressed = false;
  for (const img of images) {
    const bytes = byteLengthFromBase64(img.base64);
    if (bytes <= IMAGE_LIMITS.maxBytesPerImage) {
      out.push(img);
      continue;
    }
    const result = await compressor.compress(img, IMAGE_LIMITS.maxBytesPerImage);
    out.push(result.image);
    if (result.compressed) anyCompressed = true;
  }
  return { images: out, anyCompressed };
}
