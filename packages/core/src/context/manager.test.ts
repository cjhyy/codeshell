import { describe, it, expect } from "bun:test";
import { ContextManager } from "./manager.js";
import type { Message } from "../types.js";

function baseMessages(): Message[] {
  return [
    { role: "user", content: "sys/context" },
    { role: "user", content: "keep-before" },
    { role: "assistant", content: "turn-1" },
    { role: "user", content: "turn-2" },
    { role: "assistant", content: "turn-3" },
    { role: "user", content: "keep-after" },
  ];
}

const LONG_SUMMARY =
  "SUMMARY: three middle turns condensed into one anchored record for the archive.";

describe("ContextManager.summarizeRange", () => {
  it("replaces only the given index window with one summary", async () => {
    const cm = new ContextManager({ maxTokens: 100_000 });
    cm.setSummarizeFn(async () => LONG_SUMMARY);

    const out = await cm.summarizeRange(baseMessages(), { start: 2, end: 5 });
    const texts = out.map((m) => String(m.content));

    expect(texts[0]).toContain("sys/context");
    expect(texts[1]).toContain("keep-before");
    expect(texts.some((t) => t.includes("three middle turns condensed"))).toBe(true);
    expect(texts.at(-1)).toContain("keep-after");
    // The collapsed range no longer appears verbatim.
    expect(texts.some((t) => t === "turn-2")).toBe(false);
    expect(texts.some((t) => t === "turn-3")).toBe(false);
    expect(texts.some((t) => t === "turn-1")).toBe(false);
    // Exactly one summary message replaced the 3-message window: 6 - 3 + 1 = 4.
    expect(out.length).toBe(4);
  });

  it("passes the range to the summarize function and preserves surrounding messages", async () => {
    const cm = new ContextManager({ maxTokens: 100_000 });
    let receivedPrompt = "";
    cm.setSummarizeFn(async (prompt) => {
      receivedPrompt = prompt;
      return LONG_SUMMARY;
    });

    const out = await cm.summarizeRange(baseMessages(), { start: 2, end: 5 });
    // The window's content, not the surrounding messages, drove the prompt.
    expect(receivedPrompt).toContain("turn-1");
    expect(receivedPrompt).toContain("turn-2");
    expect(receivedPrompt).toContain("turn-3");
    expect(receivedPrompt).not.toContain("keep-before");
    expect(receivedPrompt).not.toContain("keep-after");
    // Surrounding messages are the identical references.
    const original = baseMessages();
    expect(out[0].content).toBe(original[0].content);
    expect(out[out.length - 1].content).toBe(original[5].content);
  });

  it("summarizes a window at the very start", async () => {
    const cm = new ContextManager({ maxTokens: 100_000 });
    cm.setSummarizeFn(async () => LONG_SUMMARY);

    const out = await cm.summarizeRange(baseMessages(), { start: 0, end: 3 });
    const texts = out.map((m) => String(m.content));
    expect(texts.some((t) => t.includes("three middle turns condensed"))).toBe(true);
    expect(texts.some((t) => t === "sys/context")).toBe(false);
    expect(texts.at(-1)).toContain("keep-after");
    // 6 - 3 + 1 = 4.
    expect(out.length).toBe(4);
  });

  it("summarizes the entire transcript into one message", async () => {
    const cm = new ContextManager({ maxTokens: 100_000 });
    cm.setSummarizeFn(async () => LONG_SUMMARY);

    const messages = baseMessages();
    const out = await cm.summarizeRange(messages, { start: 0, end: messages.length });
    expect(out.length).toBe(1);
    expect(String(out[0].content)).toContain("three middle turns condensed");
  });

  it("returns the input unchanged for an empty range", async () => {
    const cm = new ContextManager({ maxTokens: 100_000 });
    let called = false;
    cm.setSummarizeFn(async () => {
      called = true;
      return LONG_SUMMARY;
    });

    const messages = baseMessages();
    const out = await cm.summarizeRange(messages, { start: 3, end: 3 });
    expect(out).toBe(messages);
    expect(called).toBe(false);
  });

  it("returns the input unchanged when no summarize function is set", async () => {
    const cm = new ContextManager({ maxTokens: 100_000 });
    const messages = baseMessages();
    const out = await cm.summarizeRange(messages, { start: 2, end: 5 });
    expect(out).toBe(messages);
  });

  it("returns the input unchanged when the summary is empty or too short", async () => {
    const cm = new ContextManager({ maxTokens: 100_000 });
    cm.setSummarizeFn(async () => "too short");
    const messages = baseMessages();
    const out = await cm.summarizeRange(messages, { start: 2, end: 5 });
    expect(out).toBe(messages);
  });

  it("clamps out-of-bounds and inverted ranges", async () => {
    const cm = new ContextManager({ maxTokens: 100_000 });
    cm.setSummarizeFn(async () => LONG_SUMMARY);

    // end beyond length is clamped to length; start below 0 clamped to 0.
    const out = await cm.summarizeRange(baseMessages(), { start: -5, end: 999 });
    expect(out.length).toBe(1);
    expect(String(out[0].content)).toContain("three middle turns condensed");

    // Inverted range (start > end) collapses to empty → unchanged.
    const messages = baseMessages();
    const inverted = await cm.summarizeRange(messages, { start: 4, end: 2 });
    expect(inverted).toBe(messages);
  });

  it("produces an anchored summary that extractAnchoredSummary can recover", async () => {
    const cm = new ContextManager({ maxTokens: 100_000 });
    cm.setSummarizeFn(async () => LONG_SUMMARY);

    const out = await cm.summarizeRange(baseMessages(), { start: 2, end: 5 });
    const { extractAnchoredSummary } = await import("./compaction.js");
    expect(extractAnchoredSummary(out)).toBe(LONG_SUMMARY);
  });

  it("reports a range compaction event via onCompact", async () => {
    const cm = new ContextManager({ maxTokens: 100_000 });
    cm.setSummarizeFn(async () => LONG_SUMMARY);
    const events: string[] = [];
    cm.setOnCompact((info) => events.push(info.strategy));

    await cm.summarizeRange(baseMessages(), { start: 2, end: 5 });
    expect(events).toContain("range");
  });
});
