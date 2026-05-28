import { afterEach, describe, expect, it } from "bun:test";
import {
  setEngineImageCompressor,
  resetEngineImageCompressor,
  tryCompressImages,
  type ImageCompressor,
} from "../packages/core/src/engine/image-compression";
import {
  IMAGE_LIMITS,
  byteLengthFromBase64,
} from "../packages/core/src/engine/image-policy";
import type { ParsedImage } from "../packages/core/src/engine/parse-task";

function fakeImage(decodedBytes: number, name = "x.png"): ParsedImage {
  // Build a base64 string whose decoded length is the requested size.
  const n = Math.ceil((decodedBytes * 4) / 3);
  return {
    name,
    mime: "image/png",
    base64: "A".repeat(n).slice(0, n),
  } as ParsedImage;
}

const tinyB64 = (bytes: number): string =>
  Buffer.alloc(bytes, 0).toString("base64");

afterEach(() => {
  resetEngineImageCompressor();
});

describe("tryCompressImages", () => {
  it("returns input untouched when nothing is over the cap", async () => {
    const small = { name: "s.png", mime: "image/png", base64: tinyB64(100) } as ParsedImage;
    const { images, anyCompressed } = await tryCompressImages([small]);
    expect(anyCompressed).toBe(false);
    expect(images).toHaveLength(1);
    expect(images[0]!.base64).toBe(small.base64);
  });

  it("delegates oversized images to the active compressor", async () => {
    const compressedB64 = tinyB64(500); // ~500 bytes — well under cap
    const stub: ImageCompressor = {
      async compress(image, _maxBytes) {
        return {
          image: { ...image, base64: compressedB64, mime: "image/jpeg" },
          compressed: true,
          originalBytes: byteLengthFromBase64(image.base64),
          finalBytes: byteLengthFromBase64(compressedB64),
        };
      },
    };
    setEngineImageCompressor(stub);
    const big = fakeImage(IMAGE_LIMITS.maxBytesPerImage + 100, "screenshot.png");
    const { images, anyCompressed } = await tryCompressImages([big]);
    expect(anyCompressed).toBe(true);
    expect(images[0]!.mime).toBe("image/jpeg");
    expect(byteLengthFromBase64(images[0]!.base64)).toBeLessThan(
      IMAGE_LIMITS.maxBytesPerImage,
    );
  });

  it("leaves under-cap images alone even when an oversized sibling is present", async () => {
    const stub: ImageCompressor = {
      async compress(image, _maxBytes) {
        return {
          image: { ...image, base64: tinyB64(200), mime: "image/jpeg" },
          compressed: true,
          originalBytes: byteLengthFromBase64(image.base64),
          finalBytes: 200,
        };
      },
    };
    setEngineImageCompressor(stub);
    const small = { name: "s.png", mime: "image/png", base64: tinyB64(100) } as ParsedImage;
    const big = fakeImage(IMAGE_LIMITS.maxBytesPerImage + 100, "big.png");
    const { images, anyCompressed } = await tryCompressImages([small, big]);
    expect(anyCompressed).toBe(true);
    // The small image is unchanged; the big one was rewritten.
    expect(images[0]!.base64).toBe(small.base64);
    expect(images[1]!.mime).toBe("image/jpeg");
  });

  it("falls through cleanly when the compressor declines (anyCompressed=false)", async () => {
    const noop: ImageCompressor = {
      async compress(image, _max) {
        const bytes = byteLengthFromBase64(image.base64);
        return { image, compressed: false, originalBytes: bytes, finalBytes: bytes };
      },
    };
    setEngineImageCompressor(noop);
    const big = fakeImage(IMAGE_LIMITS.maxBytesPerImage + 100, "x.png");
    const { images, anyCompressed } = await tryCompressImages([big]);
    expect(anyCompressed).toBe(false);
    expect(images[0]!.base64).toBe(big.base64);
  });
});
