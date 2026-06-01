import { describe, expect, test } from "bun:test";
import { buildStreamItems, reconcileStreamItems, type TurnProcessGroup } from "./streamGroups";
import type { AssistantMessage, Message, ThinkingMessage, ToolMessage } from "../types";

let idCounter = 0;
function freshId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function user(text = "hi"): Message {
  return { kind: "user", id: freshId("user"), text };
}

function assistant(text: string): AssistantMessage {
  return { kind: "assistant", id: freshId("assistant"), text, done: true };
}

function thinking(text = "thinking"): ThinkingMessage {
  return { kind: "thinking", id: freshId("thinking"), text, done: true };
}

function tool(toolName = "Read", startedAt = 1, endedAt = startedAt + 5): ToolMessage {
  return {
    kind: "tool",
    id: freshId("tool"),
    toolName,
    args: "{}",
    result: "ok",
    status: "succeeded",
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
  };
}

function processGroups(items: ReturnType<typeof buildStreamItems>): TurnProcessGroup[] {
  return items.filter((item): item is TurnProcessGroup => item.kind === "turn_process_group");
}

describe("buildStreamItems", () => {
  test("wraps the whole turn (lead + middle text + tools) into one process card, but leaves the final summary outside", () => {
    const lead = assistant("我先查一下。");
    const middle = assistant("目录比较大，我继续读核心入口。");
    const final = assistant("总结如下。");
    const messages: Message[] = [
      user(),
      lead,
      tool("Glob", 10, 20),
      tool("Grep", 21, 30),
      tool("Read", 31, 40),
      middle,
      tool("Read", 50, 60),
      tool("Read", 61, 70),
      final,
    ];

    const items = buildStreamItems(messages);
    // One outer card spanning [lead .. last tool]; the final summary
    // text after the last tool stays inline outside the card.
    expect(items.map((item) => item.kind)).toEqual([
      "user",
      "turn_process_group",
      "assistant",
    ]);

    const groups = processGroups(items);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.toolCount).toBe(5);
    // The lead-in and the mid-run narration both live INSIDE the card.
    expect(groups[0]?.items.some((item) => item.kind === "assistant")).toBe(true);
    // The trailing summary is NOT inside the card.
    const last = items[items.length - 1];
    expect(last?.kind).toBe("assistant");
    if (last?.kind === "assistant") expect(last.text).toBe("总结如下。");
  });

  test("inside the outer card, adjacent tools fold into a tool_group but assistant text splits them", () => {
    const messages: Message[] = [
      user(),
      tool("Glob", 10, 20),
      tool("Grep", 21, 30),
      assistant("中间说明。"),
      tool("Read", 50, 60),
      tool("Read", 61, 70),
      assistant("结束。"),
    ];

    const groups = processGroups(buildStreamItems(messages));
    expect(groups).toHaveLength(1);
    // Outer card holds: [tool_group(2), assistant, tool_group(2)].
    const inner = groups[0]!.items;
    expect(inner.map((it) => it.kind)).toEqual([
      "tool_group",
      "assistant",
      "tool_group",
    ]);
  });

  test("keeps thinking transparent between adjacent tools", () => {
    const messages: Message[] = [
      user(),
      tool("Read", 10, 20),
      thinking(),
      tool("Grep", 21, 30),
    ];

    const groups = processGroups(buildStreamItems(messages));
    expect(groups).toHaveLength(1);
    expect(groups[0]?.toolCount).toBe(2);
    expect(groups[0]?.items).toHaveLength(1);
    const inner = groups[0]?.items[0];
    expect(inner?.kind).toBe("tool_group");
    if (inner?.kind === "tool_group") {
      expect(inner.items.map((item) => item.kind)).toEqual(["tool", "thinking", "tool"]);
    }
  });

  test("a purely conversational turn (no tools) renders inline, no empty process card", () => {
    const messages: Message[] = [user(), assistant("你好，这是回答。")];
    const items = buildStreamItems(messages);
    expect(items.map((it) => it.kind)).toEqual(["user", "assistant"]);
    expect(processGroups(items)).toHaveLength(0);
  });
});

describe("reconcileStreamItems", () => {
  test("reuses the previous group object when content is unchanged", () => {
    // Same message objects (same ids) folded twice — mirrors the app, where
    // a 50ms batch hands the SAME stable reducer messages back to the fold.
    // buildStreamItems allocates fresh group wrappers each call; reconcile
    // should hand back the previous render's wrapper so React.memo skips it.
    const msgs: Message[] = [user(), tool("Read", 10, 15), tool("Grep", 16, 20)];
    const prev = buildStreamItems(msgs);
    const next = buildStreamItems(msgs);
    const reconciled = reconcileStreamItems(prev, next);
    const prevGroup = prev.find((i) => i.kind === "turn_process_group");
    const recGroup = reconciled.find((i) => i.kind === "turn_process_group");
    expect(recGroup).toBe(prevGroup);
  });

  test("returns a fresh group object when the group content changes", () => {
    const base: Message[] = [user(), tool("Read", 10, 15), tool("Grep", 16, 20)];
    const prev = buildStreamItems(base);
    // A new tool appended this turn → different signature → no reuse.
    const next = buildStreamItems([...base, tool("Read", 21, 25)]);
    const reconciled = reconcileStreamItems(prev, next);
    const prevGroup = prev.find((i) => i.kind === "turn_process_group");
    const recGroup = reconciled.find((i) => i.kind === "turn_process_group");
    expect(recGroup).not.toBe(prevGroup);
  });

  test("empty previous render passes new items through unchanged", () => {
    const next = buildStreamItems([user(), tool("Read", 10, 15), tool("Grep", 16, 20)]);
    expect(reconcileStreamItems([], next)).toBe(next);
  });

  test("plain (non-group) messages pass through by their own identity", () => {
    const prev = buildStreamItems([user(), assistant("hi")]);
    const next = buildStreamItems([user(), assistant("hi")]);
    const reconciled = reconcileStreamItems(prev, next);
    // No groups to reuse → returns the new array as-is.
    expect(reconciled).toBe(next);
  });
});
