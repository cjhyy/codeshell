import { describe, expect, test } from "bun:test";
import {
  decodeWireForDisplay,
  encodeAttachmentsForWire,
  titleFromWire,
  buildPathAttachment,
  type ImageAttachment,
} from "./attachments";
import { encodeAnchorsForWire, type Anchor } from "./anchors";

// "AAAA" decodes to 3 bytes; a tiny valid base64 png data URL.
const PNG_URL = "data:image/png;base64,AAAA";

describe("buildPathAttachment (TODO 2.1)", () => {
  test("stages an attachment keeping the absolute path as name", () => {
    const { attachment, error } = buildPathAttachment("/abs/pic.png", PNG_URL, []);
    expect(error).toBeUndefined();
    expect(attachment?.name).toBe("/abs/pic.png");
    expect(attachment?.mime).toBe("image/png");
    expect(attachment?.dataUrl).toBe(PNG_URL);
    expect(attachment?.size).toBeGreaterThan(0);
  });

  test("rejects a non-image mime", () => {
    const r = buildPathAttachment("/a/x.bin", "data:application/octet-stream;base64,AAAA", []);
    expect(r.attachment).toBeUndefined();
    expect(r.error?.kind).toBe("wrong-type");
  });

  test("rejects when the data URL is unparseable", () => {
    const r = buildPathAttachment("/a/x.png", "not-a-data-url", []);
    expect(r.error?.kind).toBe("read-failed");
  });

  test("enforces the max-images count", () => {
    const existing = Array.from({ length: 6 }, (_, i) => ({
      id: `e${i}`,
      name: `${i}.png`,
      mime: "image/png",
      dataUrl: PNG_URL,
      size: 1,
    })) as ImageAttachment[];
    const r = buildPathAttachment("/a/x.png", PNG_URL, existing);
    expect(r.error?.kind).toBe("too-many");
  });

  test("wire payload carries the absolute path as name", () => {
    const { attachment } = buildPathAttachment("/repo/shot.png", PNG_URL, []);
    const wire = encodeAttachmentsForWire("", [attachment!]);
    expect(wire).toContain('name="/repo/shot.png"');
    expect(wire).toContain('path="/repo/shot.png"');
    expect(wire).toContain('origin="file-panel"');
  });
});

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
    const wire = encodeAttachmentsForWire("two", [img({ name: "a.png" }), img({ name: "b.png" })]);
    const r = decodeWireForDisplay(wire);
    expect(r.images.map((i) => i.name)).toEqual(["a.png", "b.png"]);
  });

  test("decodes HTML-escaped names back to original", () => {
    const wire = encodeAttachmentsForWire("", [img({ name: 'a&b"<c>.png' })]);
    const r = decodeWireForDisplay(wire);
    expect(r.images[0]!.name).toBe('a&b"<c>.png');
  });

  test("encodes path metadata attrs while old display decode still extracts the image", () => {
    const wire = encodeAttachmentsForWire("look", [
      img({
        path: '.code-shell/attachments/sid/a&"b.png',
        relPath: '.code-shell/attachments/sid/a&"b.png',
        absPath: "/repo/.code-shell/attachments/sid/a.png",
        sha256: "a".repeat(64),
        origin: "paste",
        sessionId: "sid-1",
      }),
    ]);
    expect(wire).toContain('path=".code-shell/attachments/sid/a&amp;&quot;b.png"');
    expect(wire).toContain(`hash="sha256:${"a".repeat(64)}"`);
    expect(wire).toContain('size="10"');
    expect(wire).toContain('origin="paste"');
    expect(wire).toContain('sessionId="sid-1"');

    const decoded = decodeWireForDisplay(wire);
    expect(decoded.text).toBe("look");
    expect(decoded.images).toHaveLength(1);
    expect(decoded.images[0]!.name).toBe("shot.png");
  });

  test("no-path legacy attachments still encode and decode", () => {
    const wire = encodeAttachmentsForWire("", [img()]);
    expect(wire).not.toContain(" path=");
    expect(wire).not.toContain(" hash=");
    const decoded = decodeWireForDisplay(wire);
    expect(decoded.images[0]!.dataUrl).toBe("data:image/png;base64,iVBORw0KGgoAAAA");
  });

  // Regression: an empty image body (ephemeral screenshot deleted by encode
  // time) must be dropped, not surfaced as a blank <img src=""> that renders
  // as selectable-but-blank content.
  test("drops an image block with an empty body", () => {
    const wire = '<codeshell-image mime="image/png" name="截屏.png">\n\n</codeshell-image>';
    const r = decodeWireForDisplay(wire);
    expect(r.images).toEqual([]);
    expect(r.text).toBe("");
  });

  test("keeps valid images while dropping an empty sibling", () => {
    const wire =
      "look\n\n" +
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
