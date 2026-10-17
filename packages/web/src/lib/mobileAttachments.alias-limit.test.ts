import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  MOBILE_INLINE_IMAGE_BYTES,
  MOBILE_MAX_IMAGE_BYTES,
  normalizeMobileImage,
  prepareMobileAttachments,
} from "./mobileAttachments";

// Own synthetic bytes and controlled browser conversion. These tests verify
// admission/metadata and cleanup; they do not claim to decode real JPEG bytes.
describe("JPEG alias uses the ordinary per-image limit", () => {
  let previousBitmap: PropertyDescriptor | undefined;
  let previousDocument: PropertyDescriptor | undefined;
  let convertedBytes: number;
  let bitmaps: Blob[];
  let closed: number;
  let draws: Array<{ width: number; height: number }>;
  let encodes: Array<{ mime: string; quality: number }>;

  beforeEach(() => {
    previousBitmap = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");
    previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    convertedBytes = MOBILE_INLINE_IMAGE_BYTES + 1;
    bitmaps = [];
    closed = 0;
    draws = [];
    encodes = [];
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: async (file: Blob) => {
        bitmaps.push(file);
        return { width: 8192, height: 4096, close: () => closed++ };
      },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        createElement: (tag: string) => {
          expect(tag).toBe("canvas");
          return {
            width: 0,
            height: 0,
            getContext: () => ({
              drawImage: (
                _bitmap: unknown,
                _x: number,
                _y: number,
                width: number,
                height: number,
              ) => draws.push({ width, height }),
            }),
            toBlob: (next: (blob: Blob) => void, mime: string, quality: number) => {
              encodes.push({ mime, quality });
              next(new Blob([new Uint8Array(convertedBytes)], { type: mime }));
            },
          };
        },
      },
    });
  });

  afterEach(() => {
    for (const [key, descriptor] of [
      ["createImageBitmap", previousBitmap],
      ["document", previousDocument],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  const alias = (size: number) =>
    new File([new Uint8Array(size)], "owned photo.jpeg", {
      type: "image/jpg",
      lastModified: 1234,
    });

  test("oversized alias converts before normalized metadata and upload body are sent", async () => {
    const input = alias(MOBILE_MAX_IMAGE_BYTES + 1);
    const begins: unknown[] = [];
    const puts: Array<{ size: number; type: string; header: string }> = [];
    const result = await prepareMobileAttachments([{ clientId: "owned", file: input }], {
      beginUpload: async (metadata) => {
        begins.push(metadata);
        return { clientId: "owned", uploadId: "owned-upload", putUrl: "/owned", expiresAt: 1 };
      },
      fetch: async (_url, init) => {
        const body = init?.body as File;
        puts.push({
          size: body.size,
          type: body.type,
          header: (init?.headers as Record<string, string>)["Content-Type"],
        });
        return new Response(null, { status: 201 });
      },
    });
    expect(bitmaps).toHaveLength(1);
    expect(bitmaps[0].size).toBe(input.size);
    expect(bitmaps[0].type).toBe("image/jpeg");
    expect(closed).toBe(1);
    expect(draws).toEqual([{ width: 4096, height: 2048 }]);
    expect(encodes).toEqual([{ mime: "image/jpeg", quality: 0.88 }]);
    const metadata = {
      clientId: "owned",
      name: "owned photo.jpg",
      mime: "image/jpeg",
      size: convertedBytes,
    };
    expect(begins).toEqual([metadata]);
    expect(puts).toEqual([{ size: convertedBytes, type: "image/jpeg", header: "image/jpeg" }]);
    expect(result).toEqual([{ ...metadata, transport: "upload", uploadId: "owned-upload" }]);
  });

  test("an alias still above the limit after conversion rejects before any upload", async () => {
    convertedBytes = MOBILE_MAX_IMAGE_BYTES + 1;
    let begins = 0;
    let puts = 0;
    await expect(
      prepareMobileAttachments([{ clientId: "owned", file: alias(convertedBytes) }], {
        beginUpload: async () => {
          begins++;
          throw new Error("Upload must not begin");
        },
        fetch: async () => {
          puts++;
          throw new Error("Upload must not run");
        },
      }),
    ).rejects.toThrow("Image exceeds the 10 MiB limit");
    expect(begins).toBe(0);
    expect(puts).toBe(0);
    expect(closed).toBe(1);
  });

  test("small and exactly-at-limit aliases retain their bytes, filename and timestamp", async () => {
    for (const size of [3, MOBILE_MAX_IMAGE_BYTES]) {
      const input = alias(size);
      const normalized = await normalizeMobileImage(input);
      expect(normalized.type).toBe("image/jpeg");
      expect(normalized.size).toBe(size);
      expect(normalized.name).toBe(input.name);
      expect(normalized.lastModified).toBe(input.lastModified);
      expect(new Uint8Array(await normalized.arrayBuffer())).toEqual(
        new Uint8Array(await input.arrayBuffer()),
      );
    }
    expect(bitmaps).toEqual([]);
    expect(closed).toBe(0);
  });

  test("oversized GIF still rejects without flattening or starting an upload", async () => {
    const input = new File([new Uint8Array(MOBILE_MAX_IMAGE_BYTES + 1)], "owned.gif", {
      type: "image/gif",
    });
    await expect(normalizeMobileImage(input)).rejects.toThrow("Image exceeds the 10 MiB limit");
    expect(bitmaps).toEqual([]);
    expect(closed).toBe(0);
  });

  test("ordinary supported images remain the same File", async () => {
    for (const type of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
      const input = new File([new Uint8Array([1, 2, 3])], "owned", { type });
      expect(await normalizeMobileImage(input)).toBe(input);
    }
    expect(bitmaps).toEqual([]);
  });
});
