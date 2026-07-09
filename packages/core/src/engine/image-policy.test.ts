import { describe, it, expect } from "bun:test";
import {
  byteLengthFromBase64,
  enforceImagePolicy,
  dropOversizedImages,
  collectAttachedImagePaths,
  IMAGE_LIMITS,
} from "./image-policy.js";
import type { ParsedImage } from "./parse-task.js";

/**
 * Build a synthetic ParsedImage of a chosen *decoded* byte length.
 *
 * Important to keep tests honest: we go through real base64 round-trip
 * (`Buffer.from(... ).toString("base64")`) so `byteLengthFromBase64` is
 * exercising exactly the wire shape the engine sees.
 */
function img(bytes: number, name = "x.png", mime = "image/png"): ParsedImage {
  // The byte *values* don't matter to the policy — only the length does.
  // Using 0x55 gives a deterministic base64 ('VVVV…') which makes test
  // failures easier to read in diffs.
  const raw = Buffer.alloc(bytes, 0x55);
  const base64 = raw.toString("base64");
  return {
    mime,
    name,
    base64,
    dataUrl: `data:${mime};base64,${base64}`,
  };
}

describe("byteLengthFromBase64", () => {
  it("returns 0 for empty", () => {
    expect(byteLengthFromBase64("")).toBe(0);
  });

  it("computes exact decoded length without decoding", () => {
    for (const n of [1, 2, 3, 4, 17, 64, 1024, 1024 * 1024]) {
      const b64 = Buffer.alloc(n, 0xab).toString("base64");
      expect(byteLengthFromBase64(b64)).toBe(n);
    }
  });

  it("tolerates whitespace in the base64 payload", () => {
    const b64 = Buffer.alloc(100, 0x33).toString("base64");
    const noisy = b64.replace(/(.{20})/g, "$1\n  ");
    expect(byteLengthFromBase64(noisy)).toBe(100);
  });
});

describe("enforceImagePolicy", () => {
  it("ok: empty image list passes", () => {
    expect(enforceImagePolicy([])).toEqual({ ok: true });
  });

  it("ok: small image passes", () => {
    const v = enforceImagePolicy([img(50 * 1024, "tiny.png")]);
    expect(v).toEqual({ ok: true });
  });

  it("ok: multiple images within both caps pass", () => {
    const v = enforceImagePolicy([
      img(500 * 1024, "a.png"),
      img(500 * 1024, "b.png"),
      img(500 * 1024, "c.png"),
    ]);
    expect(v).toEqual({ ok: true });
  });

  it("refuses single image over the per-image cap", () => {
    const big = IMAGE_LIMITS.maxBytesPerImage + 100 * 1024;
    const v = enforceImagePolicy([img(big, "screenshot.png")]);
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.code).toBe("image_too_large");
    expect(v.offender?.name).toBe("screenshot.png");
    expect(v.offender?.bytes).toBe(big);
    expect(v.message).toContain("screenshot.png");
    expect(v.message).toContain("超过单图上限");
  });

  it("refuses when cumulative bytes exceed per-turn cap even if no single image is too large", () => {
    // Each is well under the per-image cap (2 MB) but together (4 ×
    // 1.6 MB = 6.4 MB) they breach the 6 MB per-turn cap. With the cap
    // ratio 6 MB total / 2 MB per image, three images of equal size
    // physically cannot trigger this branch — need at least four.
    const each = 1_600_000;
    const v = enforceImagePolicy([
      img(each, "a.png"),
      img(each, "b.png"),
      img(each, "c.png"),
      img(each, "d.png"),
    ]);
    // Sanity: each is under the per-image cap so we know we're testing
    // the right gate, not the previous one.
    expect(each).toBeLessThan(IMAGE_LIMITS.maxBytesPerImage);
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.code).toBe("images_total_too_large");
    expect(v.totals.totalBytes).toBe(each * 4);
    expect(v.message).toContain("每轮上限");
  });

  it("refuses when image count exceeds the per-turn count cap", () => {
    const tiny = 10 * 1024;
    const list = Array.from({ length: IMAGE_LIMITS.maxImagesPerTurn + 2 }, (_, i) =>
      img(tiny, `img-${i}.png`),
    );
    const v = enforceImagePolicy(list);
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.code).toBe("too_many_images");
    expect(v.totals.imageCount).toBe(IMAGE_LIMITS.maxImagesPerTurn + 2);
  });

  it("per-image cap fires before cumulative cap (single offender wins the report)", () => {
    // One huge file plus several small ones — user should see *which*
    // file is at fault, not a generic 'too much overall' message.
    const offender = img(IMAGE_LIMITS.maxBytesPerImage + 1, "huge.png");
    const v = enforceImagePolicy([
      img(10 * 1024, "small1.png"),
      offender,
      img(10 * 1024, "small2.png"),
    ]);
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.code).toBe("image_too_large");
    expect(v.offender?.name).toBe("huge.png");
  });

  it("missing filename still renders cleanly in the message", () => {
    const a = img(IMAGE_LIMITS.maxBytesPerImage + 1, "");
    const v = enforceImagePolicy([a]);
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.message).toContain("(未命名)");
  });
});

describe("dropOversizedImages", () => {
  it("passes everything through when all images fit", () => {
    const a = img(100, "a.png");
    const b = img(200, "b.png");
    const r = dropOversizedImages([a, b]);
    expect(r.droppedCount).toBe(0);
    expect(r.placeholder).toBe("");
    expect(r.kept).toHaveLength(2);
  });

  it("filters out images over the per-image cap and reports them", () => {
    const small = img(50_000, "ok.png");
    const big = img(IMAGE_LIMITS.maxBytesPerImage + 1024, "huge.png");
    const r = dropOversizedImages([small, big]);
    expect(r.droppedCount).toBe(1);
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0]!.name).toBe("ok.png");
    expect(r.placeholder).toContain("huge.png");
    expect(r.placeholder).toContain("已自动跳过");
  });

  it("aggregates multiple drops into one placeholder", () => {
    const big1 = img(IMAGE_LIMITS.maxBytesPerImage + 100, "a.png");
    const big2 = img(IMAGE_LIMITS.maxBytesPerImage + 200, "b.png");
    const small = img(100, "c.png");
    const r = dropOversizedImages([big1, small, big2]);
    expect(r.droppedCount).toBe(2);
    expect(r.kept.map((i) => i.name)).toEqual(["c.png"]);
    expect(r.placeholder).toContain("a.png");
    expect(r.placeholder).toContain("b.png");
  });

  it("uses (未命名) when the file has no name", () => {
    const big = img(IMAGE_LIMITS.maxBytesPerImage + 1, "");
    const r = dropOversizedImages([big]);
    expect(r.placeholder).toContain("(未命名)");
  });
});

describe("collectAttachedImagePaths", () => {
  // resolve: absolute names pass through; bare names join to a fake cwd.
  const resolve = (name: string) => (name.startsWith("/") ? name : `/work/${name}`);

  it("returns the path for a file-attached image whose name resolves to an existing file", () => {
    const exists = (p: string) => p === "/work/refs/chen.png";
    const out = collectAttachedImagePaths([img(10, "/work/refs/chen.png")], resolve, exists);
    expect(out).toEqual(["/work/refs/chen.png"]);
  });

  it("prefers path attr and returns the original cwd-relative path when it exists", () => {
    const exists = (p: string) => p === "/work/.code-shell/attachments/sid/shot.png";
    const out = collectAttachedImagePaths(
      [Object.assign(img(10, "ignored.png"), { path: ".code-shell/attachments/sid/shot.png" })],
      resolve,
      exists,
    );
    expect(out).toEqual([".code-shell/attachments/sid/shot.png"]);
  });

  it("skips a missing path attr instead of falling back to name", () => {
    const exists = (p: string) => p === "/work/ignored.png";
    const out = collectAttachedImagePaths(
      [Object.assign(img(10, "ignored.png"), { path: ".code-shell/attachments/sid/missing.png" })],
      resolve,
      exists,
    );
    expect(out).toEqual([]);
  });

  it("excludes a pasted screenshot whose name is a bare filename that doesn't exist", () => {
    const exists = (_p: string) => false; // nothing on disk
    const out = collectAttachedImagePaths([img(10, "screenshot.png")], resolve, exists);
    expect(out).toEqual([]);
  });

  it("joins a relative name against cwd before the existence check", () => {
    const exists = (p: string) => p === "/work/a.png";
    const out = collectAttachedImagePaths([img(10, "a.png")], resolve, exists);
    expect(out).toEqual(["/work/a.png"]);
  });

  it("keeps only the images that exist, in order, skipping blanks", () => {
    const exists = (p: string) => p === "/work/keep1.png" || p === "/abs/keep2.png";
    const out = collectAttachedImagePaths(
      [
        img(10, "keep1.png"),
        img(10, "gone.png"),
        img(10, "  "), // blank name → skipped
        img(10, "/abs/keep2.png"),
      ],
      resolve,
      exists,
    );
    expect(out).toEqual(["/work/keep1.png", "/abs/keep2.png"]);
  });
});
