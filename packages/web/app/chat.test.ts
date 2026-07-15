import { describe, expect, test } from "bun:test";
import { appendUserMessage, chatFromTranscript, emptyChat, foldStreamEvent } from "./chat.js";

describe("chat stream folding", () => {
  test("text deltas accumulate into one streaming assistant item", () => {
    let s = appendUserMessage(emptyChat, "hi");
    s = foldStreamEvent(s, { type: "text_delta", text: "Hel" });
    s = foldStreamEvent(s, { type: "text_delta", text: "lo" });
    expect(s.items).toHaveLength(2);
    expect(s.items[1]).toEqual({ kind: "assistant", text: "Hello", streaming: true });
    expect(s.running).toBe(true);
  });

  test("tool_use_start seals the stream and adds a tool line; turn_complete stops running", () => {
    let s = appendUserMessage(emptyChat, "do it");
    s = foldStreamEvent(s, { type: "text_delta", text: "Working" });
    s = foldStreamEvent(s, { type: "tool_use_start", toolCall: { name: "Bash" } });
    s = foldStreamEvent(s, { type: "text_delta", text: "Done" });
    s = foldStreamEvent(s, { type: "turn_complete", reason: "completed" });
    expect(s.items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(s.items[2]!.text).toContain("Bash");
    expect(s.running).toBe(false);
    expect(s.items.every((i) => !i.streaming)).toBe(true);
  });

  test("error events surface and stop the run", () => {
    let s = appendUserMessage(emptyChat, "x");
    s = foldStreamEvent(s, { type: "error", error: "boom" });
    expect(s.items[1]).toEqual({ kind: "error", text: "boom" });
    expect(s.running).toBe(false);
  });

  test("unknown events are ignored", () => {
    const s = foldStreamEvent(emptyChat, { type: "memory_recalled" });
    expect(s).toEqual(emptyChat);
  });
});

describe("chatFromTranscript", () => {
  test("maps user/assistant messages, skips system reminders and unknowns", () => {
    const s = chatFromTranscript([
      { message: { role: "user", content: "question" } },
      { message: { role: "user", content: "<system-reminder>internal</system-reminder>" } },
      { message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
      { type: "tool_result", result: {} },
    ]);
    expect(s.items).toEqual([
      { kind: "user", text: "question" },
      { kind: "assistant", text: "answer" },
    ]);
  });
});
