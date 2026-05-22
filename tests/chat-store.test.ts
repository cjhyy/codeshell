import { describe, expect, test, beforeEach } from "bun:test";
import { chatStore } from "../packages/tui/src/ui/store.js";

beforeEach(() => {
  chatStore.clear();
});

describe("chatStore reference stability", () => {
  test("update that changes one entry preserves identity of others", () => {
    chatStore.append({ type: "user", text: "hello" });
    chatStore.append({ type: "tool_start", toolName: "Read", args: {}, toolCallId: "t1" });
    chatStore.append({ type: "assistant_text", text: "ok", streaming: false });

    const before = chatStore.getEntries();
    expect(before).toHaveLength(3);

    chatStore.update((prev) => {
      const idx = prev.findIndex(
        (e) => e.type === "tool_start" && e.toolCallId === "t1",
      );
      if (idx < 0) return prev;
      const next = [...prev];
      next[idx] = { ...prev[idx], args: { path: "/x" } } as (typeof prev)[number];
      return next;
    });

    const after = chatStore.getEntries();
    expect(after).toHaveLength(3);
    expect(after[1]).not.toBe(before[1]);
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
  });

  test("simulated tool_use_args_delta only mutates the matching tool_start", () => {
    chatStore.append({ type: "user", text: "go" });
    chatStore.append({ type: "tool_start", toolName: "Read", args: {}, toolCallId: "t1" });
    chatStore.append({ type: "tool_start", toolName: "Grep", args: {}, toolCallId: "t2" });

    const before = chatStore.getEntries();

    chatStore.update((prev) => {
      const idx = prev.findIndex(
        (e) => e.type === "tool_start" && e.toolCallId === "t2",
      );
      if (idx < 0) return prev;
      const next = [...prev];
      next[idx] = { ...prev[idx], args: { pattern: "foo" } } as (typeof prev)[number];
      return next;
    });

    const after = chatStore.getEntries();
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).not.toBe(before[2]);
    expect((after[2] as Extract<typeof after[number], { type: "tool_start" }>).args).toEqual({
      pattern: "foo",
    });
  });
});
