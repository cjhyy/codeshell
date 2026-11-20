import { describe, expect, test } from "bun:test";
import {
  attachmentReferenceDisplay,
  formatAttachmentReferences,
  splitAttachmentReferences,
} from "./attachment-references.js";
import { outputUserMessage } from "./output-user-message.js";

const image = "/repo/.code-shell/attachments/s-1/abc-截屏 2026.png";
const references = [
  { kind: "image" as const, path: image },
  { kind: "directory" as const, path: "/repo/docs" },
];

describe("attachment references", () => {
  test("the written block splits back into typed text and paths", () => {
    const written = formatAttachmentReferences("修复一下\n第二行", references);
    expect(written).toContain("<codeshell_attachments>");
    expect(splitAttachmentReferences(written)).toEqual({ text: "修复一下\n第二行", references });
  });

  test("an attachment-only turn has empty text", () => {
    expect(splitAttachmentReferences(formatAttachmentReferences("", references))).toEqual({
      text: "",
      references,
    });
  });

  test("text without the exact trailing block is returned unchanged", () => {
    const quoted = "看看这个 <codeshell_attachments> 标签是什么";
    expect(splitAttachmentReferences(quoted)).toEqual({ text: quoted, references: [] });
    const altered = formatAttachmentReferences("x", references).replace(
      "- directory:",
      "- folder:",
    );
    expect(splitAttachmentReferences(altered)).toEqual({ text: altered, references: [] });
    expect(formatAttachmentReferences("x", [{ kind: "file", path: "  " }])).toBe("x");
  });

  test("display metadata never claims file contents", () => {
    expect(attachmentReferenceDisplay(references[0]!)).toEqual({
      name: "abc-截屏 2026.png",
      size: 0,
      path: image,
      absPath: image,
      mime: "image/png",
    });
    expect(attachmentReferenceDisplay(references[1]!).name).toBe("docs/");
  });

  test("the bubble event shows the typed text and lists the attachments", () => {
    const event = outputUserMessage(
      { content: formatAttachmentReferences("修复一下", references), clientMessageId: "c1" },
      "s-1",
      "/repo",
    );
    expect(event.text).toBe("修复一下");
    expect(event.attachments?.map((item) => item.path)).toEqual([image, "/repo/docs"]);
    // An explicit displayText still wins, and plain text gets no attachments.
    expect(
      outputUserMessage(
        { content: formatAttachmentReferences("x", references), displayText: "shown" },
        "s-1",
        "/repo",
      ).text,
    ).toBe("shown");
    expect(outputUserMessage({ content: "plain" }, "s-1", "/repo").attachments).toBeUndefined();
  });
});
