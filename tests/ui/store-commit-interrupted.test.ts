import { test, expect } from "bun:test";
import { chatStore } from "../../src/ui/store.js";

function reset() {
  chatStore.setEntries([]);
}

test("non-empty partial → entry persisted, streaming flag cleared, suffix appended", () => {
  reset();
  chatStore.append({ type: "assistant_text", text: "hello partial", streaming: true });
  chatStore.commitInterruptedStreaming("\n\n[Request interrupted by user]");
  const entries = chatStore.getEntries();
  const last = entries[entries.length - 1];
  expect(last.type).toBe("assistant_text");
  if (last.type === "assistant_text") {
    expect(last.streaming).toBe(false);
    expect(last.text).toBe("hello partial\n\n[Request interrupted by user]");
  }
});

test("empty partial → no entry mutation of text but streaming finalized", () => {
  reset();
  chatStore.append({ type: "assistant_text", text: "   ", streaming: true });
  chatStore.commitInterruptedStreaming("\n\n[Request interrupted by user]");
  const entries = chatStore.getEntries();
  const last = entries[entries.length - 1];
  if (last.type === "assistant_text") {
    expect(last.text).toBe("   ");      // text unchanged (whitespace-only stays as-is)
    expect(last.streaming).toBe(false); // streaming flag still finalized
  }
});

test("no streaming entry → no-op (does not throw)", () => {
  reset();
  chatStore.append({ type: "user", text: "hi" });
  expect(() => chatStore.commitInterruptedStreaming("...")).not.toThrow();
  expect(chatStore.getEntries().length).toBe(1);
});

test("thinking entries removed alongside commit", () => {
  reset();
  chatStore.append({ type: "thinking", content: "scratch" });
  chatStore.append({ type: "assistant_text", text: "partial", streaming: true });
  chatStore.commitInterruptedStreaming("\n\n[Request interrupted by user]");
  const entries = chatStore.getEntries();
  expect(entries.some((e) => e.type === "thinking")).toBe(false);
});
