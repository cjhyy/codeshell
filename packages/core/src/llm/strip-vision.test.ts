import { describe, it, expect } from "bun:test";
import { stripVisionFromHistory, VISION_PLACEHOLDER } from "./strip-vision.js";
import type { Message } from "../types.js";

const img = (data = "AAAA"): Message => ({
  role: "user",
  content: [
    { type: "text", text: "look at this" },
    { type: "image", source: { type: "base64", media_type: "image/png", data } },
  ],
});

describe("stripVisionFromHistory", () => {
  it("returns input unchanged when model supports vision", () => {
    const msgs = [img()];
    const out = stripVisionFromHistory(msgs, true);
    expect(out).toBe(msgs); // identity — no copy when nothing to do
  });

  it("replaces image blocks with a text placeholder when vision unsupported", () => {
    const out = stripVisionFromHistory([img()], false);
    const content = out[0].content as Exclude<Message["content"], string>;
    expect(content.some((b) => b.type === "image")).toBe(false);
    const placeholder = content.find((b) => b.type === "text" && b.text === VISION_PLACEHOLDER);
    expect(placeholder).toBeDefined();
    // original text must survive
    expect(content.some((b) => b.type === "text" && b.text === "look at this")).toBe(true);
  });

  it("does not mutate the input messages (store stays intact)", () => {
    const msgs = [img()];
    stripVisionFromHistory(msgs, false);
    const orig = msgs[0].content as Exclude<Message["content"], string>;
    expect(orig.some((b) => b.type === "image")).toBe(true);
  });

  it("leaves string-content messages untouched", () => {
    const msgs: Message[] = [{ role: "user", content: "plain text" }];
    const out = stripVisionFromHistory(msgs, false);
    expect(out[0].content).toBe("plain text");
  });

  it("leaves messages without images untouched (same reference)", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "no image here" }] },
    ];
    const out = stripVisionFromHistory(msgs, false);
    expect(out[0]).toBe(msgs[0]);
  });

  it("collapses consecutive images into one placeholder per message", () => {
    const msgs: Message[] = [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "A" } },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "B" } },
        ],
      },
    ];
    const out = stripVisionFromHistory(msgs, false);
    const content = out[0].content as Exclude<Message["content"], string>;
    const placeholders = content.filter((b) => b.type === "text" && b.text === VISION_PLACEHOLDER);
    expect(placeholders).toHaveLength(1);
  });

  it("preserves non-image, non-text blocks (e.g. tool_result)", () => {
    const msgs: Message[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "ok" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "A" } },
        ],
      },
    ];
    const out = stripVisionFromHistory(msgs, false);
    const content = out[0].content as Exclude<Message["content"], string>;
    expect(content.some((b) => b.type === "tool_result")).toBe(true);
    expect(content.some((b) => b.type === "image")).toBe(false);
  });

  it("strips images nested inside tool_result.content when vision unsupported", () => {
    const msgs: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: [
              { type: "text", text: "before" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
            ],
          },
        ],
      },
    ];
    const out = stripVisionFromHistory(msgs, false);
    const content = out[0].content as Exclude<Message["content"], string>;
    const tr = content.find((b) => b.type === "tool_result");
    expect(tr).toBeDefined();
    expect(Array.isArray(tr!.content)).toBe(true);
    const inner = tr!.content as Exclude<Message["content"], string>;
    expect(inner.some((b) => b.type === "image")).toBe(false);
    // original inner text survives
    expect(inner.some((b) => b.type === "text" && b.text === "before")).toBe(true);
    // a placeholder replaced the image
    expect(inner.some((b) => b.type === "text" && b.text === VISION_PLACEHOLDER)).toBe(true);
  });

  it("does NOT touch nested tool_result images when vision IS supported", () => {
    const msgs: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: [
              { type: "text", text: "before" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
            ],
          },
        ],
      },
    ];
    const out = stripVisionFromHistory(msgs, true);
    expect(out).toBe(msgs); // identity
    const content = out[0].content as Exclude<Message["content"], string>;
    const tr = content.find((b) => b.type === "tool_result");
    const inner = tr!.content as Exclude<Message["content"], string>;
    expect(inner.some((b) => b.type === "image")).toBe(true);
  });
});
