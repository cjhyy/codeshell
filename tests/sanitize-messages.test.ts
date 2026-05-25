import { describe, expect, test } from "bun:test";
import type { Message } from "../packages/core/src/types.js";
import {
  sanitizeContent,
  sanitizeMessages,
  sanitizeTaskString,
} from "../packages/core/src/logging/sanitize-messages.js";

// Long enough that the sanitizer doesn't treat it as a short marker URL.
const BIG_BASE64 = "iVBORw0KGgo".repeat(20) + "AAAA"; // > 64 chars

describe("sanitizeContent", () => {
  test("string content passes through identical", () => {
    expect(sanitizeContent("hello")).toBe("hello");
  });

  test("text-only ContentBlock[] passes through with same reference (no allocation)", () => {
    const blocks = [{ type: "text" as const, text: "hi" }];
    const out = sanitizeContent(blocks);
    expect(out).toBe(blocks); // identity — touched=false path
  });

  test("image block is replaced by a metadata stub", () => {
    const content = [
      { type: "text" as const, text: "look" },
      {
        type: "image" as const,
        source: { type: "base64" as const, media_type: "image/png", data: BIG_BASE64 },
      },
    ];
    const out = sanitizeContent(content) as Array<Record<string, unknown>>;
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ type: "text", text: "look" });
    expect(out[1]).toEqual({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        bytes: BIG_BASE64.length,
        omitted: true,
      },
    });
    // The base64 payload itself must not appear anywhere in the serialized form.
    expect(JSON.stringify(out)).not.toContain(BIG_BASE64);
  });

  test("image_url part with data: URL is replaced by a metadata stub", () => {
    const content = [
      { type: "text" as const, text: "look" },
      {
        type: "image_url" as const,
        image_url: { url: `data:image/png;base64,${BIG_BASE64}` },
      },
      // ^ this isn't a ContentBlock shape per core/types but the sanitizer
      // is defensive on intent — providers may pre-translate before logging.
    ] as unknown as Message["content"];
    const out = sanitizeContent(content) as Array<Record<string, unknown>>;
    expect(JSON.stringify(out)).not.toContain(BIG_BASE64);
    const stub = out[1] as { image_url: { url: string; omitted: boolean; bytes: number } };
    expect(stub.image_url.omitted).toBe(true);
    expect(stub.image_url.bytes).toBe(BIG_BASE64.length);
    expect(stub.image_url.url.startsWith("data:image/png;base64,")).toBe(true);
    expect(stub.image_url.url).toContain("omitted");
  });

  test("short image data is left alone (not treated as base64 payload)", () => {
    // <64 chars: still a structural image block, but we don't bother rewriting
    // because real image bytes don't fit in that range.
    const blocks = [
      {
        type: "image" as const,
        source: { type: "base64" as const, media_type: "image/png", data: "short" },
      },
    ];
    expect(sanitizeContent(blocks)).toBe(blocks);
  });
});

describe("sanitizeMessages", () => {
  test("pure-text array returns the original reference (zero-allocation path)", () => {
    const msgs: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    expect(sanitizeMessages(msgs)).toBe(msgs);
  });

  test("one user message with an image → only that message is rewritten", () => {
    const msgs: Message[] = [
      { role: "user", content: "first turn" },
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: BIG_BASE64 },
          },
        ],
      },
    ];
    const out = sanitizeMessages(msgs);
    expect(out).not.toBe(msgs); // touched
    expect(out[0]).toBe(msgs[0]); // first one untouched (reference equality)
    expect(JSON.stringify(out)).not.toContain(BIG_BASE64);
  });
});

describe("sanitizeTaskString", () => {
  test("plain text task passes through identical", () => {
    expect(sanitizeTaskString("hello world")).toBe("hello world");
  });

  test("task with a <codeshell-image> block has the base64 redacted but the wrapper kept", () => {
    const dataUrl = `data:image/png;base64,${BIG_BASE64}`;
    const raw = `what is this\n\n<codeshell-image mime="image/png" name="x.png">\n${dataUrl}\n</codeshell-image>`;
    const out = sanitizeTaskString(raw);
    expect(out).toContain("<codeshell-image");
    expect(out).toContain("</codeshell-image>");
    expect(out).toContain("omitted");
    expect(out).not.toContain(BIG_BASE64);
  });

  test("multiple image blocks are all redacted", () => {
    const dataUrl = `data:image/png;base64,${BIG_BASE64}`;
    const raw = `a\n<codeshell-image mime="image/png">${dataUrl}</codeshell-image>\nb\n<codeshell-image mime="image/png">${dataUrl}</codeshell-image>\nc`;
    const out = sanitizeTaskString(raw);
    expect(out).not.toContain(BIG_BASE64);
    expect((out.match(/omitted/g) ?? []).length).toBe(2);
  });
});
