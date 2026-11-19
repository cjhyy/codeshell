import { describe, expect, test } from "bun:test";
import type { WebContents } from "electron";
import { captureElectronPage, isFlatBitmap } from "./electron-screenshot.js";

/** A 100x100 BGRA frame of one color, optionally with a block of another. */
function bitmap(fill: number, block?: { rows: number; value: number }): Buffer {
  const pixels = Buffer.alloc(100 * 100 * 4, fill);
  if (block) pixels.fill(block.value, 0, block.rows * 100 * 4);
  return pixels;
}

function fixture(
  options: { zoom?: number; empty?: boolean; destroyed?: boolean; pixels?: Buffer } = {},
) {
  const captures: unknown[] = [];
  const resizes: unknown[] = [];
  const toBitmap = () => options.pixels ?? bitmap(255, { rows: 40, value: 20 });
  const image = {
    isEmpty: () => options.empty ?? false,
    getSize: () => ({ width: 4000, height: 2800 }),
    resize: (size: unknown) => {
      resizes.push(size);
      return { toJPEG: () => Buffer.from("resized"), toBitmap };
    },
    toJPEG: () => Buffer.from("original"),
    toBitmap,
  };
  const contents = {
    isDestroyed: () => options.destroyed ?? false,
    getZoomFactor: () => options.zoom ?? 1,
    capturePage: async (...args: unknown[]) => {
      captures.push(args);
      return image;
    },
  } as unknown as WebContents;
  return { contents, captures, resizes };
}

describe("Electron screenshot capture", () => {
  test("captures its own hidden viewport and bounds the encoded pixel dimensions", async () => {
    const f = fixture({ zoom: 1.25 });
    const result = await captureElectronPage(f.contents, { maxDim: 1568 });
    expect(f.captures).toEqual([[undefined, { stayHidden: true }]]);
    expect(f.resizes).toEqual([{ width: 1568, height: 1097, quality: "best" }]);
    expect(result).toEqual({
      ok: true,
      mediaType: "image/jpeg",
      base64: Buffer.from("resized").toString("base64"),
      blank: false,
    });
  });

  test("flags a whole-viewport frame that is one flat color, but never a region", async () => {
    const white = fixture({ pixels: bitmap(255) });
    expect((await captureElectronPage(white.contents, { maxDim: 1568 })).blank).toBe(true);
    const region = await captureElectronPage(white.contents, {
      region: { x: 0, y: 0, width: 50, height: 50 },
      maxDim: 5000,
    });
    expect(region.ok).toBe(true);
    expect(region.blank).toBeUndefined();
  });

  test("a flat frame tolerates a speck; real content is not flat", () => {
    expect(isFlatBitmap(bitmap(255))).toBe(true);
    expect(isFlatBitmap(bitmap(0))).toBe(true);
    const speck = bitmap(255);
    speck.fill(0, 5000 * 4, 5020 * 4);
    expect(isFlatBitmap(speck)).toBe(true);
    // Compression noise around one color is still a blank frame.
    const noisy = bitmap(250);
    for (let at = 0; at < noisy.length; at += 4) noisy[at] = 250 + ((at / 4) % 5);
    expect(isFlatBitmap(noisy)).toBe(true);
    expect(isFlatBitmap(bitmap(255, { rows: 10, value: 30 }))).toBe(false);
    expect(isFlatBitmap(Buffer.alloc(0))).toBe(false);
  });

  test("converts the visible CSS region with page zoom without adding display density", async () => {
    const f = fixture({ zoom: 1.25 });
    await captureElectronPage(f.contents, {
      region: { x: 800, y: 560, width: 800, height: 560 },
      maxDim: 5000,
    });
    expect(f.captures).toEqual([
      [{ x: 1000, y: 700, width: 1000, height: 700 }, { stayHidden: true }],
    ]);
    expect(f.resizes).toEqual([]);
  });

  test("rounds fractional region edges inward so capture stays within the visible intersection", async () => {
    const f = fixture({ zoom: 1.25 });
    await captureElectronPage(f.contents, {
      region: { x: 10.1, y: 20.1, width: 100.2, height: 50.2 },
      maxDim: 1568,
    });
    expect(f.captures).toEqual([[{ x: 13, y: 26, width: 124, height: 61 }, { stayHidden: true }]]);
  });

  test("does not capture a destroyed target or an empty visible region", async () => {
    const gone = fixture({ destroyed: true });
    expect((await captureElectronPage(gone.contents, { maxDim: 1568 })).ok).toBe(false);
    expect(gone.captures).toHaveLength(0);
    const small = fixture();
    expect(
      (
        await captureElectronPage(small.contents, {
          region: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 },
          maxDim: 1568,
        })
      ).ok,
    ).toBe(false);
    expect(small.captures).toHaveLength(0);
  });

  test("reports an empty capture instead of returning an unusable image", async () => {
    const f = fixture({ empty: true });
    expect(await captureElectronPage(f.contents, { maxDim: 1568 })).toEqual({
      ok: false,
      detail: "screenshot returned no image",
    });
    expect(f.resizes).toHaveLength(0);
  });
});
