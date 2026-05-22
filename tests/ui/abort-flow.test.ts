/**
 * Abort-flow integration — exercises the Phase 2/3 collaboration between
 * QueryGuard and chatStore on user-cancel:
 *  - forceEnd flips the guard to idle synchronously
 *  - commitInterruptedStreaming captures the partial assistant text + suffix
 *  - a "late chunk" arriving after forceEnd does NOT cause a double-commit
 *    because the streaming flag is already cleared.
 */
import { test, expect } from "bun:test";
import { chatStore } from "../../packages/tui/src/ui/store.js";
import { QueryGuard } from "../../packages/tui/src/ui/query-guard.js";

function reset() {
  chatStore.setEntries([]);
}

test("forceEnd + commitInterruptedStreaming yields a single interrupted entry", () => {
  reset();
  const g = new QueryGuard();
  g.reserve();
  g.tryStart(new AbortController());

  chatStore.append({ type: "assistant_text", text: "halfway", streaming: true });

  // Simulate Esc
  chatStore.commitInterruptedStreaming("\n\n[Request interrupted by user]");
  g.forceEnd("user-cancel");

  const entries = chatStore.getEntries();
  const assistantEntries = entries.filter((e) => e.type === "assistant_text");
  expect(assistantEntries.length).toBe(1);
  const first = assistantEntries[0];
  if (first.type === "assistant_text") {
    expect(first.streaming).toBe(false);
    expect(first.text).toContain("halfway");
    expect(first.text).toContain("[Request interrupted by user]");
  }
  expect(g.getSnapshot()).toBe(false);
});

test("late chunk after forceEnd does not double-write the partial", () => {
  reset();
  const g = new QueryGuard();
  g.reserve();
  g.tryStart(new AbortController());

  chatStore.append({ type: "assistant_text", text: "first half", streaming: true });

  // User Esc — partial captured + suffix appended
  chatStore.commitInterruptedStreaming("\n\n[Request interrupted by user]");
  g.forceEnd("user-cancel");

  // Late chunk lands and engine's catch tries to commit again. Since the
  // streaming flag has been cleared, the second call is a no-op on the
  // assistant entry; the suffix appears exactly once.
  chatStore.commitInterruptedStreaming("\n\n[Request interrupted by user]");

  const entries = chatStore.getEntries();
  const assistantEntries = entries.filter((e) => e.type === "assistant_text");
  expect(assistantEntries.length).toBe(1);
  const first = assistantEntries[0];
  if (first.type === "assistant_text") {
    const occurrences =
      first.text.split("[Request interrupted by user]").length - 1;
    expect(occurrences).toBe(1);
  }
});

test("forceEnd while guard is RESERVED (no controller yet) — partial still committed cleanly", () => {
  reset();
  const g = new QueryGuard();
  g.reserve(); // RESERVED, no controller attached

  chatStore.append({ type: "assistant_text", text: "early bytes", streaming: true });

  chatStore.commitInterruptedStreaming("\n\n[Request interrupted by user]");
  g.forceEnd("user-cancel"); // should not throw even without controller

  expect(g.getSnapshot()).toBe(false);
  const entries = chatStore.getEntries();
  const last = entries[entries.length - 1];
  if (last.type === "assistant_text") {
    expect(last.streaming).toBe(false);
    expect(last.text).toContain("early bytes");
  }
});
