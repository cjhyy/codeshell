/**
 * Browser-native image compression for the chat composer.
 *
 * Why
 * ---
 * Renderer-side (browser) compression keeps us off native deps (no sharp,
 * no canvas npm package) — `<canvas>.toBlob` is built into Electron's
 * Chromium and does the entire decode → resize → re-encode cycle for us.
 *
 * The engine has a hard policy (`packages/core/src/engine/image-policy.ts`)
 * that refuses any image over 2 MB. Without this step, a user pasting a
 * 4 MB screenshot would have their turn refused with a friendly error
 * but still need to compress manually. This step makes the friendly
 * refusal the *fallback*, not the common case.
 *
 * Strategy
 * --------
 * 1. If the original is already small (≤ TARGET_BYTES), pass through
 *    unchanged. We don't re-encode tiny PNGs into JPEGs lossily for
 *    nothing — that would visibly degrade screenshots of code.
 * 2. Otherwise, load into an <img>, draw onto a canvas with the long
 *    edge clamped to MAX_DIMENSION, and re-encode as JPEG at a fixed
 *    quality. Two re-encode attempts at progressively lower quality
 *    give a soft landing for unusually large inputs.
 * 3. If anything in the pipeline throws (HEIC the canvas can't decode,
 *    OOM, …), return the original — the engine policy will catch it
 *    later. Compression must never *lose* an image.
 *
 * Public surface is just `compressIfNeeded()`. Constants are inline +
 * exported for the tests under `compress.test.ts`.
 *
 * Animated GIF caveat: drawing a GIF to canvas freezes the first frame.
 * That's a one-way conversion. For now we still compress them when
 * oversized — preserving the bytes of a 5 MB GIF is the worse failure
 * (it would just be rejected by the engine anyway). A future change
 * could skip GIFs and surface a warning instead.
 */

import type { ImageAttachment } from "./attachments";

/**
 * Bytes below this we don't bother re-encoding. Matches the engine's
 * `IMAGE_LIMITS.maxBytesPerImage` (2 MB) so anything passing this gate
 * also passes the engine gate.
 *
 * Kept in sync manually because the renderer can't import from core
 * (different build target).
 */
export const TARGET_BYTES = 2 * 1024 * 1024;

/** Long-edge pixel cap. Matches engine's `IMAGE_TARGETS.targetMaxDimension`. */
export const MAX_DIMENSION = 2048;

/**
 * Image clarity level (provider-agnostic). Drives the long-edge cap so the user
 * trades fidelity for token cost. Replaces the old OpenAI-only low/high/original
 * knob: for OpenAI the engine still maps low→low / standard,high→high; for
 * Anthropic (no detail param — it just bills by pixels, ⌈w/28⌉×⌈h/28⌉) the
 * SAVING comes entirely from this renderer-side downscale before send.
 *   low      — 省钱: long edge ≤ 1024 (fewest tokens)
 *   standard — 1568 (old-model native cap; good cost/quality)
 *   high     — 2576 (Opus 4.7/4.8 high-res cap; full fidelity)
 */
export type ImageDetail = "low" | "standard" | "high";

const DETAIL_CAPS: Record<ImageDetail, number> = {
  low: 1024,
  standard: 1568,
  high: 2576,
};

/** Long-edge pixel cap for a clarity level. Unknown/undefined → high (no
 *  surprise downscale of someone who never opted in). */
export function capForDetail(detail: ImageDetail | undefined): number {
  return (detail && DETAIL_CAPS[detail]) || DETAIL_CAPS.high;
}

/**
 * Whether to downsample EVERY image (not just oversized ones). low/standard do
 * — that's how they actually cut tokens (a sub-2MB but 3000px screenshot still
 * costs ~4784 tokens on Opus). high preserves fidelity: compress only when over
 * the byte cap, exactly like the original behaviour.
 */
export function alwaysDownsample(detail: ImageDetail | undefined): boolean {
  return detail === "low" || detail === "standard";
}

/**
 * JPEG quality ladder. We try the first quality; if the result is still
 * over `TARGET_BYTES` we try the next one, and so on. Empirically two
 * steps land every screenshot we've thrown at it under the cap.
 */
const QUALITY_LADDER = [0.82, 0.7, 0.55];

/** MIME types we recompress as JPEG. Others pass through unchanged. */
const RECOMPRESSIBLE = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

/**
 * Compress one ImageAttachment if it exceeds `TARGET_BYTES`. Returns a
 * possibly-new ImageAttachment (with updated dataUrl/size/mime/name) or
 * the original instance unchanged.
 *
 * The function is `async` because `Image.decode()` and `canvas.toBlob()`
 * both need it. It never rejects — failures fall back to the original.
 */
export async function compressIfNeeded(
  att: ImageAttachment,
  detail?: ImageDetail,
): Promise<ImageAttachment> {
  // high/default: only touch oversized images (preserve fidelity). low/standard:
  // downsample every image to cut tokens, even when under the byte cap.
  if (att.size <= TARGET_BYTES && !alwaysDownsample(detail)) return att;
  if (!RECOMPRESSIBLE.has(att.mime)) return att;

  const cap = capForDetail(detail);
  try {
    const img = await loadImage(att.dataUrl);
    const { width, height } = scaledDimensions(
      img.naturalWidth,
      img.naturalHeight,
      cap,
    );
    // Already at/under the cap AND within bytes → nothing to gain, keep original
    // (avoids needlessly re-encoding a small PNG of code into lossy JPEG).
    if (width === img.naturalWidth && height === img.naturalHeight && att.size <= TARGET_BYTES) {
      return att;
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return att;
    ctx.drawImage(img, 0, 0, width, height);

    for (const q of QUALITY_LADDER) {
      const blob = await canvasToBlob(canvas, "image/jpeg", q);
      if (!blob) continue;
      if (blob.size <= TARGET_BYTES || q === QUALITY_LADDER[QUALITY_LADDER.length - 1]) {
        const dataUrl = await blobToDataUrl(blob);
        return {
          ...att,
          mime: "image/jpeg",
          // Rename only the extension so the tooltip still shows where
          // the bytes came from. `a.png` → `a.png.jpg` is the convention
          // ImageMagick uses for non-destructive re-encodes.
          name: att.name.match(/\.jpe?g$/i) ? att.name : `${att.name}.jpg`,
          dataUrl,
          size: blob.size,
        };
      }
    }
    return att;
  } catch (err) {
    // Bubble up to console for triage but keep the original — the
    // engine's policy gate is the safety net.
    console.warn("[attachments] compress failed", err);
    return att;
  }
}

/**
 * Run `compressIfNeeded` on a batch in parallel. Order of the output
 * matches the input order so the renderer's attachment chips don't
 * shuffle when a single image takes longer to encode.
 */
export async function compressBatch(
  atts: ImageAttachment[],
  detail?: ImageDetail,
): Promise<ImageAttachment[]> {
  return Promise.all(atts.map((a) => compressIfNeeded(a, detail)));
}

// ---------------------------------------------------------------- internals

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = src;
  });
}

/**
 * Long-edge clamp that preserves aspect ratio. If the image is already
 * within the cap, returns its natural dimensions unchanged — important
 * so screenshots of code stay readable.
 */
export function scaledDimensions(
  w: number,
  h: number,
  cap: number,
): { width: number; height: number } {
  if (w <= cap && h <= cap) return { width: w, height: h };
  if (w >= h) {
    return { width: cap, height: Math.round((h * cap) / w) };
  }
  return { width: Math.round((w * cap) / h), height: cap };
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), type, quality);
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(new Error("FileReader failed"));
    r.readAsDataURL(blob);
  });
}
