import { describe, expect, test } from "bun:test";
import { probeImageBytes, sanitizeImageBytes } from "../../../packages/server/src/image-byte-probe.ts";

// Bytes copied verbatim from the already maintained test fixture declarations.
// No attachment service import, upload, file staging, native decoder or network.
const IMAGE_FIXTURES = {
  "image/png": Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
  "image/jpeg": Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==",
    "base64",
  ),
  "image/gif": Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"),
  "image/webp": Buffer.from("UklGRhoAAABXRUJQVlA4TA4AAAAvAAAAAAcQEf0PRET/Aw==", "base64"),
} as const;


describe("round14 ordinary in-memory image byte probes", () => {
  for (const [mime, bytes] of Object.entries(IMAGE_FIXTURES)) {
    test(`${mime}: ordinary maintained 1x1 image`, () => {
      expect(probeImageBytes(mime, bytes)).toEqual({ mime, width: 1, height: 1 });
      const sanitized = sanitizeImageBytes(mime, bytes);
      expect(sanitized.image).toEqual({ mime, width: 1, height: 1 });
      expect(sanitized.bytes.equals(bytes)).toBe(true);
      expect(sanitized.trailingBytes).toBe(0);
    });
    test(`${mime}: respects Uint8Array byteOffset and byteLength`, () => {
      const backing = new Uint8Array(bytes.length + 7);
      backing.fill(0x77);
      backing.set(bytes, 3);
      expect(probeImageBytes(mime, backing.subarray(3, 3 + bytes.length)))
        .toEqual({ mime, width: 1, height: 1 });
      expect(backing[0]).toBe(0x77);
      expect(backing[backing.length - 1]).toBe(0x77);
    });
  }
  test("image/jpg alias canonicalizes to image/jpeg", () => {
    expect(probeImageBytes("image/jpg", IMAGE_FIXTURES["image/jpeg"]))
      .toEqual({ mime: "image/jpeg", width: 1, height: 1 });
  });
  test("a nonanimated 87a header retains the ordinary GIF image dimensions", () => {
    const bytes = Buffer.from(IMAGE_FIXTURES["image/gif"]);
    bytes.write("GIF87a", 0, "ascii");
    expect(probeImageBytes("image/gif", bytes))
      .toEqual({ mime: "image/gif", width: 1, height: 1 });
  });
  test("synthetic SOF3 sample without DQT reaches current table rejection (candidate only)", () => {
    // Marker sequence follows T.81 B.1/B.2/H for one 8-bit component and
    // one zero-difference Huffman symbol. Independent pixel decoding and
    // downstream attachment support have NOT been verified. No validity claim.
    const sof3 = Buffer.from("ffc3000b080001000101011100", "hex");
    const dht = Buffer.concat([
      Buffer.from("ffc400140001", "hex"),
      Buffer.alloc(15),
      Buffer.from([0]),
    ]);
    const sos = Buffer.from("ffda0008010100010000", "hex");
    const bytes = Buffer.concat([Buffer.from("ffd8", "hex"), sof3, dht, sos, Buffer.from("7fffd9", "hex")]);
    expect(() => probeImageBytes("image/jpeg", bytes))
      .toThrow("invalid JPEG image structure: missing frame, tables, or scan");
  });
});
