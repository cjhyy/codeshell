import { describe, expect, test } from "bun:test";
import {
  decodeWireForDisplay,
  encodeAttachmentsForWire,
  titleFromWire,
  type ImageAttachment,
} from "./attachments";
import { encodeAnchorsForWire, type Anchor } from "./anchors";

function img(over: Partial<ImageAttachment> = {}): ImageAttachment {
  return {
    id: "x",
    name: "shot.png",
    mime: "image/png",
    dataUrl: "data:image/png;base64,iVBORw0KGgoAAAA",
    size: 10,
    ...over,
  };
}

describe("decodeWireForDisplay", () => {
  test("plain text with no image blocks passes through unchanged", () => {
    const r = decodeWireForDisplay("hello world");
    expect(r.text).toBe("hello world");
    expect(r.images).toEqual([]);
  });

  test("extracts a single image block, leaving the prose as text", () => {
    const wire = encodeAttachmentsForWire("look at this", [img()]);
    const r = decodeWireForDisplay(wire);
    expect(r.text).toBe("look at this");
    expect(r.images).toHaveLength(1);
    expect(r.images[0]!.dataUrl).toBe("data:image/png;base64,iVBORw0KGgoAAAA");
    expect(r.images[0]!.name).toBe("shot.png");
    expect(r.images[0]!.mime).toBe("image/png");
  });

  test("image-only message yields empty text and the image", () => {
    const wire = encodeAttachmentsForWire("", [img()]);
    const r = decodeWireForDisplay(wire);
    expect(r.text).toBe("");
    expect(r.images).toHaveLength(1);
  });

  test("preserves order of multiple images", () => {
    const wire = encodeAttachmentsForWire("two", [
      img({ name: "a.png" }),
      img({ name: "b.png" }),
    ]);
    const r = decodeWireForDisplay(wire);
    expect(r.images.map((i) => i.name)).toEqual(["a.png", "b.png"]);
  });

  test("decodes HTML-escaped names back to original", () => {
    const wire = encodeAttachmentsForWire("", [img({ name: 'a&b"<c>.png' })]);
    const r = decodeWireForDisplay(wire);
    expect(r.images[0]!.name).toBe('a&b"<c>.png');
  });

  // Regression: an empty image body (ephemeral screenshot deleted by encode
  // time) must be dropped, not surfaced as a blank <img src=""> that renders
  // as selectable-but-blank content.
  test("drops an image block with an empty body", () => {
    const wire =
      '<codeshell-image mime="image/png" name="截屏.png">\n\n</codeshell-image>';
    const r = decodeWireForDisplay(wire);
    expect(r.images).toEqual([]);
    expect(r.text).toBe("");
  });

  test("keeps valid images while dropping an empty sibling", () => {
    const wire =
      'look\n\n' +
      '<codeshell-image mime="image/png" name="dead.png">\n  \n</codeshell-image>\n' +
      encodeAttachmentsForWire("", [img({ name: "ok.png" })]);
    const r = decodeWireForDisplay(wire);
    expect(r.images.map((i) => i.name)).toEqual(["ok.png"]);
    expect(r.text).toBe("look");
  });
});

describe("titleFromWire", () => {
  test("uses the prose when present", () => {
    const wire = encodeAttachmentsForWire("fix the bug", [img()]);
    expect(titleFromWire(wire)).toBe("fix the bug");
  });

  test("image-only message titles as an image placeholder, never base64", () => {
    const wire = encodeAttachmentsForWire("", [img()]);
    const title = titleFromWire(wire);
    expect(title).not.toContain("base64");
    expect(title).not.toContain("codeshell-image");
    expect(title).toBe("[图片]");
  });

  test("multiple image-only message reflects the count", () => {
    const wire = encodeAttachmentsForWire("", [img(), img()]);
    expect(titleFromWire(wire)).toBe("[图片 ×2]");
  });

  test("strips the annotations block so the title is the user's prose", () => {
    const anchors: Anchor[] = [
      {
        id: "anchor-1",
        kind: "file",
        label: "x.ts:1",
        locator: { 文件: "x.ts" },
        comment: "note",
      },
    ];
    const wire = encodeAnchorsForWire("修一下登录", anchors);
    const title = titleFromWire(wire);
    expect(title).toBe("修一下登录");
    expect(title).not.toContain("codeshell-annotations");
  });
});
