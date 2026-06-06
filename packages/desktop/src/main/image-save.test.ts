import { describe, expect, test } from "bun:test";
import { parseDataUrl, extForMime, suggestImageFilename } from "./image-save";

describe("parseDataUrl", () => {
  test("decodes a base64 png data URL", () => {
    // "PNG" in base64 is "UE5H"
    const r = parseDataUrl("data:image/png;base64,UE5H");
    expect(r).not.toBeNull();
    expect(r!.mime).toBe("image/png");
    expect(r!.buffer.toString("utf8")).toBe("PNG");
  });

  test("decodes a non-base64 (url-encoded) data URL", () => {
    const r = parseDataUrl("data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E");
    expect(r).not.toBeNull();
    expect(r!.mime).toBe("image/svg+xml");
    expect(r!.buffer.toString("utf8")).toBe("<svg></svg>");
  });

  test("returns null for a non-data URL", () => {
    expect(parseDataUrl("https://example.com/a.png")).toBeNull();
    expect(parseDataUrl("/abs/path.png")).toBeNull();
  });
});

describe("extForMime", () => {
  test("maps known image mimes", () => {
    expect(extForMime("image/png")).toBe(".png");
    expect(extForMime("image/jpeg")).toBe(".jpg");
    expect(extForMime("image/svg+xml")).toBe(".svg");
  });
  test("defaults unknown to .png", () => {
    expect(extForMime("application/octet-stream")).toBe(".png");
  });
});

describe("suggestImageFilename", () => {
  test("uses the source name when it already has an extension", () => {
    expect(
      suggestImageFilename({ name: "shot.png", mime: "image/png", stamp: "X" }),
    ).toBe("shot.png");
  });

  test("appends an extension when the name lacks one", () => {
    expect(
      suggestImageFilename({ name: "diagram", mime: "image/webp", stamp: "X" }),
    ).toBe("diagram.webp");
  });

  test("strips a directory prefix from the name", () => {
    expect(
      suggestImageFilename({ name: "docs/out/x.png", mime: "image/png", stamp: "X" }),
    ).toBe("x.png");
  });

  test("falls back to a stamped name when there is none", () => {
    expect(
      suggestImageFilename({ name: "", mime: "image/png", stamp: "20260606" }),
    ).toBe("image-20260606.png");
    expect(
      suggestImageFilename({ name: null, mime: "image/gif", stamp: "T" }),
    ).toBe("image-T.gif");
  });
});
