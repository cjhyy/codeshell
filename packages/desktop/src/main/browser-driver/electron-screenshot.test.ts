import { describe, expect, test } from "bun:test";
import type { WebContents } from "electron";
import { captureElectronPage } from "./electron-screenshot.js";

function fixture(options: { zoom?: number; empty?: boolean; destroyed?: boolean } = {}) {
  const captures: unknown[] = [];
  const resizes: unknown[] = [];
  const image = {
    isEmpty: () => options.empty ?? false,
    getSize: () => ({ width: 4000, height: 2800 }),
    resize: (size: unknown) => {
      resizes.push(size);
      return { toJPEG: () => Buffer.from("resized") };
    },
    toJPEG: () => Buffer.from("original"),
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
    });
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
