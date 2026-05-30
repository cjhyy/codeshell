import { describe, expect, it } from "bun:test";
import {
  buildStreamItems,
  toolGroupLabel,
  toolGroupToolCount,
  type ToolGroup,
} from "../packages/desktop/src/renderer/messages/streamGroups";
import type {
  AssistantMessage,
  Message,
  ThinkingMessage,
  ToolMessage,
  UserMessage,
} from "../packages/desktop/src/renderer/types";

function tool(over: Partial<ToolMessage> & { id: string }): ToolMessage {
  return {
    kind: "tool",
    id: over.id,
    toolName: over.toolName ?? "Bash",
    args: "{}",
    status: "succeeded",
    startedAt: 0,
    ...over,
  } as ToolMessage;
}

function assistant(id: string, text = "ok"): AssistantMessage {
  return { kind: "assistant", id, text, done: true };
}

function thinking(id: string, text = "..."): ThinkingMessage {
  return { kind: "thinking", id, text, done: true };
}

function user(id: string, text = "hi"): UserMessage {
  return { kind: "user", id, text };
}

describe("toolGroupLabel", () => {
  it("renders the Chinese summary with the count", () => {
    expect(toolGroupLabel(5)).toBe("已处理 5 条命令");
  });
});

describe("buildStreamItems — basics", () => {
  it("passes through when there are no tools", () => {
    const msgs: Message[] = [user("u1"), assistant("a1")];
    expect(buildStreamItems(msgs)).toEqual(msgs as never);
  });

  it("does NOT group a single tool (no buddy)", () => {
    const msgs: Message[] = [
      user("u1"),
      tool({ id: "t1" }),
      assistant("a1"),
    ];
    const out = buildStreamItems(msgs);
    // user + tool + assistant — no tool_group, no turn_process_group
    // (level-2 needs ≥1 tool, but the single tool still wraps in a
    // turn_process_group with one item).
    const kinds = out.map((m) => m.kind);
    expect(kinds).toContain("user");
    expect(kinds).toContain("turn_process_group");
    // The process group should hold the single tool, not a tool_group.
    const tp = out.find((m) => m.kind === "turn_process_group");
    if (tp?.kind === "turn_process_group") {
      expect(tp.items.some((it) => it.kind === "tool_group")).toBe(false);
      expect(tp.toolCount).toBe(1);
    }
  });

  it("folds 2+ adjacent tools into one tool_group", () => {
    const msgs: Message[] = [
      user("u1"),
      tool({ id: "t1" }),
      tool({ id: "t2" }),
      tool({ id: "t3" }),
      assistant("a1"),
    ];
    const out = buildStreamItems(msgs);
    const tp = out.find((m) => m.kind === "turn_process_group");
    expect(tp).toBeDefined();
    if (tp?.kind === "turn_process_group") {
      const groups = tp.items.filter(
        (it): it is ToolGroup => it.kind === "tool_group",
      );
      expect(groups).toHaveLength(1);
      expect(toolGroupToolCount(groups[0]!)).toBe(3);
    }
  });
});

// Regression for TODO-week.md #10 — transparent thinking / assistant
// text between two tool calls must NOT break the level-1 fold.
describe("buildStreamItems — transparent items between tools", () => {
  it("absorbs a thinking message between two tools into the same group", () => {
    const msgs: Message[] = [
      user("u1"),
      tool({ id: "t1" }),
      thinking("th1", "let me check..."),
      tool({ id: "t2" }),
      assistant("a1"),
    ];
    const out = buildStreamItems(msgs);
    const tp = out.find((m) => m.kind === "turn_process_group");
    expect(tp).toBeDefined();
    if (tp?.kind === "turn_process_group") {
      const groups = tp.items.filter(
        (it): it is ToolGroup => it.kind === "tool_group",
      );
      // Single group, both tools inside, with the thinking item
      // sandwiched between them.
      expect(groups).toHaveLength(1);
      const g = groups[0]!;
      expect(toolGroupToolCount(g)).toBe(2);
      expect(g.items.map((it) => it.kind)).toEqual([
        "tool",
        "thinking",
        "tool",
      ]);
    }
  });

  it("does NOT absorb assistant text — it is a hard break that splits the run", () => {
    // Assistant text is deliberately NOT transparent (unlike thinking):
    // it stays visible between command groups, so two tools sandwiching it
    // do not fold into one group.
    const msgs: Message[] = [
      tool({ id: "t1" }),
      assistant("a1", "now running tests"),
      tool({ id: "t2" }),
    ];
    const out = buildStreamItems(msgs);
    const groups = out.filter(
      (it): it is ToolGroup => it.kind === "tool_group",
    );
    expect(groups).toHaveLength(0);
    // The assistant text survives between the two inline tool rows.
    expect(out.map((it) => it.kind)).toEqual(["tool", "assistant", "tool"]);
  });

  it("assistant between transparent thinking items still hard-breaks the run", () => {
    // thinking is transparent, but the assistant in the middle is a hard
    // break — so the run flushes at the assistant and neither half reaches
    // 2 tools, leaving no tool_group.
    const msgs: Message[] = [
      tool({ id: "t1" }),
      thinking("th1"),
      assistant("a1", "..."),
      thinking("th2"),
      tool({ id: "t2" }),
    ];
    const out = buildStreamItems(msgs);
    const groups = out.filter(
      (it): it is ToolGroup => it.kind === "tool_group",
    );
    expect(groups).toHaveLength(0);
    expect(out.map((it) => it.kind)).toEqual([
      "tool",
      "thinking",
      "assistant",
      "thinking",
      "tool",
    ]);
  });

  it("does NOT absorb a trailing assistant — run must end on a tool", () => {
    const msgs: Message[] = [
      tool({ id: "t1" }),
      tool({ id: "t2" }),
      assistant("a1", "summary"),
    ];
    const out = buildStreamItems(msgs);
    // The two tools merge; the assistant stays outside the group.
    const groups = out.filter(
      (it): it is ToolGroup => it.kind === "tool_group",
    );
    expect(groups).toHaveLength(1);
    expect(toolGroupToolCount(groups[0]!)).toBe(2);
    expect(groups[0]!.items.map((it) => it.kind)).toEqual(["tool", "tool"]);
    // The trailing assistant survives as a sibling.
    const hasAssistant = out.some((it) => it.kind === "assistant");
    expect(hasAssistant).toBe(true);
  });

  it("flushes when a hard break (user message) lands between tools", () => {
    const msgs: Message[] = [
      tool({ id: "t1" }),
      user("u2", "wait, do X first"),
      tool({ id: "t2" }),
    ];
    const out = buildStreamItems(msgs);
    // Two single-tool runs, separated by a user. No merge.
    const groups = out.filter(
      (it): it is ToolGroup => it.kind === "tool_group",
    );
    expect(groups).toHaveLength(0);
  });
});
