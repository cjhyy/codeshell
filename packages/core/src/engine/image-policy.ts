/**
 * Engine-side image policy: a single source of truth for what counts as
 * an "OK to ship to the model" attachment.
 *
 * Why this exists
 * ---------------
 * The desktop renderer happily takes a 4 MB screenshot, base64-encodes it,
 * and ships it to the LLM. OpenAI-compatible providers stream the request
 * body; a payload that fat plus a flaky link manifests as
 * `OpenAI API error: Connection error.` with no useful classification,
 * three retries deep. That bug is in our session log
 * `s-mppk3ot5-02d35ca4`: textLen=4,364,933, promptTokens=1,091,232.
 *
 * The right fix is to keep the bytes small *before* they leave the host.
 * But not every entry point has the same compressor available:
 *   - desktop renderer has <canvas> + Blob, no native deps
 *   - TUI runs in plain Node and has neither
 *   - MCP tools / future arena agents will need it too
 *
 * So this module owns:
 *   1. The shared *thresholds* every host honors before sending to the LLM
 *      (`IMAGE_LIMITS`).
 *   2. A `byteLengthFromBase64()` helper everyone uses to measure decoded
 *      payload size without actually decoding it.
 *   3. An `enforceImagePolicy()` engine gate that runs *after* parse-task
 *      and *before* the message hits the provider. When a single image
 *      blows the limit, the gate refuses the turn with a friendly error
 *      and a hint telling the user what to do. The engine is the last
 *      place we can refuse cheaply — the next step is a $0.10 vision call
 *      over a flaky socket.
 *
 * Hosts (desktop, TUI) are encouraged to compress upstream so this gate
 * never fires in practice. When it does fire, the user gets a clear
 * message instead of "Connection error. Connection error. Connection
 * error.".
 *
 * Pure + no I/O — safe to use from any caller.
 */

import type { ParsedImage } from "./parse-task.js";

/**
 * Hard limits the engine enforces. Soft hints (target sizes) live in
 * `IMAGE_TARGETS` so hosts know what to aim for when they pre-compress.
 *
 * Rationale for each number:
 *   - `maxBytesPerImage`: 2 MB decoded. OpenAI's `gpt-4o` accepts up to
 *     20 MB but charges by tile count; 2 MB ≈ a 2048×2048 PNG which is
 *     plenty for every UI screenshot. Above this we've measured the
 *     "Connection error" failure mode in practice.
 *   - `maxBytesPerTurn`: 6 MB total, regardless of count. The four-image
 *     attach is the typical worst case from the desktop UI, and 4× the
 *     per-image cap would blow past most providers' rate-limited request
 *     body sizes.
 *   - `maxImagesPerTurn`: 6 (matches the desktop renderer's UI limit, so
 *     a wider engine gate is just dead defense).
 */
export const IMAGE_LIMITS = {
  maxBytesPerImage: 2 * 1024 * 1024,
  maxBytesPerTurn: 6 * 1024 * 1024,
  maxImagesPerTurn: 6,
} as const;

/**
 * Soft targets hosts use when pre-compressing. `targetMaxDimension` is
 * the longest-edge pixel cap that *almost always* keeps a JPEG under
 * `maxBytesPerImage`. Hosts re-encode at `jpegQuality` and only escalate
 * the compression if the result is still over.
 */
export const IMAGE_TARGETS = {
  targetMaxDimension: 2048,
  jpegQuality: 0.82,
} as const;

/**
 * Decode-free size estimate of a base64 string.
 *
 * Returns the count of bytes the base64 string would produce *after*
 * decoding. Used everywhere we need to "weigh" an image without paying
 * the cost of `Buffer.from(s, "base64")` allocation.
 *
 *   - 4 base64 chars → 3 decoded bytes.
 *   - Trailing `=` padding subtracts from the byte count.
 *   - Tolerates whitespace and missing padding by working off `length`
 *     modulo 4 — the wire format strips whitespace via parse-task, so
 *     this only matters when an exotic caller hands us raw textarea text.
 */
export function byteLengthFromBase64(b64: string): number {
  if (!b64) return 0;
  // Strip whitespace defensively; the parser already does this, but other
  // callers (logging stubs, MCP image blocks) might not.
  const clean = b64.replace(/\s+/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}

/**
 * Verdict returned by {@link enforceImagePolicy}. `ok: true` means the
 * caller can proceed with the original images unchanged. `ok: false`
 * carries a user-facing message + machine-readable reason so callers can
 * decide whether to render an error card or refuse the turn outright.
 */
export type ImagePolicyVerdict =
  | { ok: true }
  | {
      ok: false;
      /**
       * Stable string the engine surfaces as the run's terminal reason.
       * Distinct values so a future UI could pick different icons.
       */
      code: "image_too_large" | "images_total_too_large" | "too_many_images";
      /** User-facing message — Chinese-friendly because both UIs are zh. */
      message: string;
      /** Optional fields the UI may use for finer-grained reporting. */
      offender?: {
        name: string;
        mime: string;
        bytes: number;
      };
      totals: {
        imageCount: number;
        totalBytes: number;
      };
    };

function fmtMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Run the per-turn image policy.
 *
 * Three failure modes, all surfaced with a Chinese-language hint that
 * tells the user *what to do next*:
 *
 *   1. Per-image cap exceeded → name the file + the cap, suggest
 *      re-saving / cropping. (`code: "image_too_large"`)
 *   2. Per-turn cumulative cap exceeded → total bytes + cap. The user
 *      likely attached too many screenshots; suggest removing some.
 *      (`code: "images_total_too_large"`)
 *   3. Count cap exceeded → the desktop UI already caps at 6, so this
 *      mostly catches future-MCP / TUI batch paths. (`code: "too_many_images"`)
 *
 * The gate is **strict** — no silent truncation. The "Connection error"
 * failure mode this exists to prevent was effectively a silent truncate
 * (bytes lost mid-stream); a friendly refusal is strictly better.
 */
/**
 * Drop the images that exceed {@link IMAGE_LIMITS.maxBytesPerImage}
 * and return a textual placeholder describing what was removed. The
 * engine uses this to keep a poisoned image out of conversation
 * history while still letting the rest of the turn proceed — Claude
 * Code's "5MB brick session" failure mode is exactly the bug where
 * a too-large image enters history and every subsequent request
 * re-sends it (see docs/research-cc-vs-codex-image-handling.md §A).
 *
 * Returns the filtered image list and, when anything was dropped, a
 * Chinese-language note suitable for prepending to the user text.
 */
export interface DropOversizedResult {
  /** Images that fit under the per-image cap (in original order). */
  kept: ParsedImage[];
  /** A human-readable note about what was removed, or "" if nothing was. */
  placeholder: string;
  /** Number of images removed. */
  droppedCount: number;
}

export function dropOversizedImages(images: readonly ParsedImage[]): DropOversizedResult {
  const kept: ParsedImage[] = [];
  const dropped: Array<{ name: string; bytes: number }> = [];
  for (const img of images) {
    const bytes = byteLengthFromBase64(img.base64);
    if (bytes > IMAGE_LIMITS.maxBytesPerImage) {
      dropped.push({ name: img.name || "(未命名)", bytes });
    } else {
      kept.push(img);
    }
  }
  if (dropped.length === 0) {
    return { kept, placeholder: "", droppedCount: 0 };
  }
  const list = dropped.map((d) => `「${d.name}」(~${fmtMB(d.bytes)})`).join("、");
  const placeholder =
    `[已自动跳过 ${dropped.length} 张超大图片:${list};` +
    `单图上限 ${fmtMB(IMAGE_LIMITS.maxBytesPerImage)}。` +
    `图片未进入对话历史,本轮其余内容继续。]`;
  return { kept, placeholder, droppedCount: dropped.length };
}

export interface ImagePolicyByteInput {
  name: string;
  mime: string;
  bytes: number;
}

export function enforceImageBytePolicy(
  images: readonly ImagePolicyByteInput[],
): ImagePolicyVerdict {
  if (images.length === 0) return { ok: true };

  if (images.length > IMAGE_LIMITS.maxImagesPerTurn) {
    return {
      ok: false,
      code: "too_many_images",
      message:
        `一次最多附 ${IMAGE_LIMITS.maxImagesPerTurn} 张图片，` +
        `本次有 ${images.length} 张。请删掉一些再发。`,
      totals: {
        imageCount: images.length,
        totalBytes: images.reduce((s, i) => s + i.bytes, 0),
      },
    };
  }

  let totalBytes = 0;
  for (const img of images) {
    const bytes = img.bytes;
    if (bytes > IMAGE_LIMITS.maxBytesPerImage) {
      return {
        ok: false,
        code: "image_too_large",
        message:
          `图片「${img.name || "(未命名)"}」解码后约 ${fmtMB(bytes)}，` +
          `超过单图上限 ${fmtMB(IMAGE_LIMITS.maxBytesPerImage)}。` +
          `请先截图压缩或保存为 JPEG（最长边 ≤ ${IMAGE_TARGETS.targetMaxDimension}px）再发。`,
        offender: { name: img.name, mime: img.mime, bytes },
        totals: {
          imageCount: images.length,
          totalBytes: totalBytes + bytes,
        },
      };
    }
    totalBytes += bytes;
  }

  if (totalBytes > IMAGE_LIMITS.maxBytesPerTurn) {
    return {
      ok: false,
      code: "images_total_too_large",
      message:
        `本次附图合计约 ${fmtMB(totalBytes)}，超过每轮上限 ${fmtMB(IMAGE_LIMITS.maxBytesPerTurn)}。` +
        `请删掉一些图片，或先把图片压缩后再发。`,
      totals: {
        imageCount: images.length,
        totalBytes,
      },
    };
  }

  return { ok: true };
}

export function enforceImagePolicy(images: readonly ParsedImage[]): ImagePolicyVerdict {
  return enforceImageBytePolicy(
    images.map((img) => ({
      name: img.name,
      mime: img.mime,
      bytes: byteLengthFromBase64(img.base64),
    })),
  );
}

/**
 * Collect the workspace file paths of any attached images that came from a
 * real file (the desktop composer's path-attach flow sets ParsedImage.name to
 * the absolute path). Pasted screenshots whose name is a bare filename, or any
 * name that doesn't resolve to an existing file, are excluded.
 *
 * Pure given an `exists` predicate + `resolve` joiner, so it's unit-testable
 * without touching the real fs. The engine passes `existsSync` and a
 * cwd-aware joiner; downstream this surfaces the paths to the model so tools
 * like GenerateImage(referenceImages) can use them (the path the composer
 * already knew was otherwise dropped on the way to the LLM).
 */
export function collectAttachedImagePaths(
  images: ReadonlyArray<ParsedImage>,
  resolve: (name: string) => string,
  exists: (absPath: string) => boolean,
): string[] {
  const out: string[] = [];
  for (const img of images) {
    const path = img.path?.trim();
    if (path) {
      if (exists(resolve(path))) out.push(path);
      continue;
    }
    const name = img.name?.trim();
    if (!name) continue;
    const abs = resolve(name);
    if (exists(abs)) out.push(abs);
  }
  return out;
}
