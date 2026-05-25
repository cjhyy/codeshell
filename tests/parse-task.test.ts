import { describe, expect, test } from "bun:test";
import {
  parseTaskWithImages,
  ImageParseError,
} from "../packages/core/src/engine/parse-task.js";

// 1×1 transparent PNG, base64-encoded — short enough to inline.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";
const PNG_DATAURL = `data:image/png;base64,${PNG_BASE64}`;

function block(mime: string, name: string, dataUrl: string): string {
  return `<codeshell-image mime="${mime}" name="${name}">\n${dataUrl}\n</codeshell-image>`;
}

describe("parseTaskWithImages", () => {
  test("empty string → no images, empty text", () => {
    const out = parseTaskWithImages("");
    expect(out.hasImages).toBe(false);
    expect(out.images).toEqual([]);
    expect(out.text).toBe("");
  });

  test("plain text → passes through untouched", () => {
    const input = "hello there, no images here";
    const out = parseTaskWithImages(input);
    expect(out.hasImages).toBe(false);
    expect(out.images).toEqual([]);
    expect(out.text).toBe(input);
  });

  test("text with the literal substring `<codeshell-image>` but no full block throws", () => {
    // The fast path bails on `indexOf("<codeshell-image")`. An orphaned
    // opener with no closer should NOT silently fall through to "no images
    // parsed" — that's exactly the data-loss bug we want to surface.
    expect(() =>
      parseTaskWithImages("here is a fake mention <codeshell-image and nothing else"),
    ).toThrow(ImageParseError);
  });

  test("one image, no surrounding text", () => {
    const input = block("image/png", "shot.png", PNG_DATAURL);
    const out = parseTaskWithImages(input);
    expect(out.hasImages).toBe(true);
    expect(out.images).toHaveLength(1);
    expect(out.images[0]!.mime).toBe("image/png");
    expect(out.images[0]!.name).toBe("shot.png");
    expect(out.images[0]!.base64).toBe(PNG_BASE64);
    expect(out.images[0]!.dataUrl).toBe(PNG_DATAURL);
    expect(out.text).toBe("");
  });

  test("text + one trailing image (the canonical desktop encoder shape)", () => {
    const input = `what is in this picture?\n\n${block("image/png", "shot.png", PNG_DATAURL)}`;
    const out = parseTaskWithImages(input);
    expect(out.hasImages).toBe(true);
    expect(out.images).toHaveLength(1);
    expect(out.text).toBe("what is in this picture?");
  });

  test("two images, mixed with text, preserve order", () => {
    const a = block("image/png", "a.png", PNG_DATAURL);
    const b = block(
      "image/jpeg",
      "b.jpg",
      `data:image/jpeg;base64,${PNG_BASE64}`,
    );
    const input = `first\n${a}\nmiddle\n${b}\nlast`;
    const out = parseTaskWithImages(input);
    expect(out.images.map((i) => i.name)).toEqual(["a.png", "b.jpg"]);
    expect(out.images[0]!.mime).toBe("image/png");
    expect(out.images[1]!.mime).toBe("image/jpeg");
    // Text contents preserved in order; whitespace collapsed.
    expect(out.text).toBe("first\n\nmiddle\n\nlast");
  });

  test("HTML-escaped attribute round-trips back to the original name", () => {
    const fancyName = `quoted "title" & <stuff>.png`;
    const escaped = fancyName
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const input = block("image/png", escaped, PNG_DATAURL);
    const out = parseTaskWithImages(input);
    expect(out.images[0]!.name).toBe(fancyName);
  });

  test("malformed: opening tag with no closing tag throws", () => {
    const input = `look at this <codeshell-image mime="image/png">\n${PNG_DATAURL}\n`;
    expect(() => parseTaskWithImages(input)).toThrow(ImageParseError);
  });

  test("malformed: body is not a data URL throws", () => {
    const input = `<codeshell-image mime="image/png" name="x.png">\nnot-a-data-url\n</codeshell-image>`;
    expect(() => parseTaskWithImages(input)).toThrow(ImageParseError);
  });

  test("malformed: empty base64 payload throws", () => {
    const input = `<codeshell-image mime="image/png" name="x.png">\ndata:image/png;base64,\n</codeshell-image>`;
    expect(() => parseTaskWithImages(input)).toThrow(ImageParseError);
  });

  test("base64 with embedded whitespace is normalized to a single contiguous string", () => {
    // Real-world: some clients hard-wrap base64. The parser must collapse
    // whitespace inside the payload — otherwise the LLM client forwards a
    // string that the provider rejects.
    const wrapped = PNG_BASE64.match(/.{1,16}/g)!.join("\n");
    const input = `<codeshell-image mime="image/png" name="x.png">\ndata:image/png;base64,${wrapped}\n</codeshell-image>`;
    const out = parseTaskWithImages(input);
    expect(out.images[0]!.base64).toBe(PNG_BASE64);
  });

  test("mismatched opening-tag mime vs data-url mime → opening-tag wins", () => {
    // The desktop validator gates on the opening-tag attribute, so the rest
    // of the pipeline expects that to be the authoritative MIME.
    const input = `<codeshell-image mime="image/webp" name="x.webp">\ndata:image/png;base64,${PNG_BASE64}\n</codeshell-image>`;
    const out = parseTaskWithImages(input);
    expect(out.images[0]!.mime).toBe("image/webp");
    expect(out.images[0]!.dataUrl.startsWith("data:image/webp;base64,")).toBe(true);
  });
});
