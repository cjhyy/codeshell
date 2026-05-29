import { describe, expect, test } from "bun:test";
import { aggregateFileChanges, aggregateFileChangeSummary } from "./fileChangeAggregator";
import type { AgentMessage, Message, ToolMessage } from "../types";

let _idCounter = 0;
function freshId(): string {
  _idCounter += 1;
  return `t-${_idCounter}`;
}

function tool(
  toolName: string,
  args: Record<string, unknown>,
  status: ToolMessage["status"] = "succeeded",
): ToolMessage {
  return {
    kind: "tool",
    id: freshId(),
    toolName,
    args: JSON.stringify(args),
    status,
    startedAt: 0,
  };
}

function user(text = "hi"): Message {
  return { kind: "user", id: freshId(), text };
}

describe("aggregateFileChanges", () => {
  test("returns null when no qualifying tools after last user", () => {
    expect(aggregateFileChanges([user(), tool("Read", { file_path: "a.ts" })])).toBeNull();
  });

  test("returns null when message list is empty", () => {
    expect(aggregateFileChanges([])).toBeNull();
  });

  test("returns null when no user message present (defensive)", () => {
    expect(aggregateFileChanges([tool("Read", { file_path: "a.ts" })])).toBeNull();
  });

  test("counts Edit by line diff of old_string vs new_string", () => {
    const msgs: Message[] = [
      user(),
      tool("Edit", { file_path: "a.ts", old_string: "one\ntwo", new_string: "one\ntwo\nthree" }),
    ];
    expect(aggregateFileChanges(msgs)).toEqual([
      { path: "a.ts", added: 3, removed: 2, count: 1 },
    ]);
  });

  test("counts Write with no removed lines", () => {
    const msgs: Message[] = [
      user(),
      tool("Write", { file_path: "new.ts", content: "line1\nline2\nline3" }),
    ];
    expect(aggregateFileChanges(msgs)).toEqual([
      { path: "new.ts", added: 3, removed: 0, count: 1 },
    ]);
  });

  test("counts NotebookEdit like Edit (new_source / old_source)", () => {
    const msgs: Message[] = [
      user(),
      tool("NotebookEdit", { file_path: "nb.ipynb", old_source: "x", new_source: "x\ny" }),
    ];
    expect(aggregateFileChanges(msgs)).toEqual([
      { path: "nb.ipynb", added: 2, removed: 1, count: 1 },
    ]);
  });

  test("merges multiple edits to the same path", () => {
    const msgs: Message[] = [
      user(),
      tool("Edit", { file_path: "a.ts", old_string: "a", new_string: "a\nb" }),
      tool("Edit", { file_path: "a.ts", old_string: "c", new_string: "c\nd\ne" }),
    ];
    expect(aggregateFileChanges(msgs)).toEqual([
      { path: "a.ts", added: 5, removed: 2, count: 2 },
    ]);
  });

  test("includes subagent toolCalls", () => {
    const agentMsg: AgentMessage = {
      kind: "agent",
      id: "A",
      description: "do stuff",
      done: true,
      startedAt: 0,
      toolCalls: [
        tool("Write", { file_path: "from-agent.ts", content: "hello" }),
      ],
      textBuffer: "",
      toolCount: 1,
    };
    const msgs: Message[] = [user(), agentMsg];
    expect(aggregateFileChanges(msgs)).toEqual([
      { path: "from-agent.ts", added: 1, removed: 0, count: 1 },
    ]);
  });

  test("excludes failed and cancelled tool calls", () => {
    const msgs: Message[] = [
      user(),
      tool("Edit", { file_path: "a.ts", old_string: "x", new_string: "y" }, "failed"),
      tool("Write", { file_path: "b.ts", content: "z" }, "cancelled"),
    ];
    expect(aggregateFileChanges(msgs)).toBeNull();
  });

  test("excludes Read and Bash tools", () => {
    const msgs: Message[] = [
      user(),
      tool("Read", { file_path: "a.ts" }),
      tool("Bash", { command: "ls" }),
    ];
    expect(aggregateFileChanges(msgs)).toBeNull();
  });

  test("scans only after the last user message", () => {
    const msgs: Message[] = [
      user("first"),
      tool("Edit", { file_path: "old.ts", old_string: "a", new_string: "b" }),
      user("second"),
      tool("Edit", { file_path: "new.ts", old_string: "x", new_string: "y\nz" }),
    ];
    expect(aggregateFileChanges(msgs)).toEqual([
      { path: "new.ts", added: 2, removed: 1, count: 1 },
    ]);
  });

  test("handles malformed args JSON without crashing", () => {
    const malformed: ToolMessage = { ...tool("Edit", {}), args: "not-json" };
    const msgs: Message[] = [
      user(),
      malformed,
      tool("Write", { file_path: "ok.ts", content: "x" }),
    ];
    expect(aggregateFileChanges(msgs)).toEqual([
      { path: "ok.ts", added: 1, removed: 0, count: 1 },
    ]);
  });

  test("ignores tools missing file_path", () => {
    const msgs: Message[] = [
      user(),
      tool("Edit", { old_string: "a", new_string: "b" }),
      tool("Write", { file_path: "ok.ts", content: "x" }),
    ];
    expect(aggregateFileChanges(msgs)).toEqual([
      { path: "ok.ts", added: 1, removed: 0, count: 1 },
    ]);
  });

  test("supports `path` as alias for file_path", () => {
    const msgs: Message[] = [
      user(),
      tool("Write", { path: "alias.ts", content: "x\ny" }),
    ];
    expect(aggregateFileChanges(msgs)).toEqual([
      { path: "alias.ts", added: 2, removed: 0, count: 1 },
    ]);
  });

  test("returns session-scoped synthetic diffs from tool payloads", () => {
    const msgs: Message[] = [
      user(),
      tool("Write", { file_path: "new.ts", content: "line1\nline2" }),
      tool("Edit", { file_path: "old.ts", old_string: "before", new_string: "after" }),
    ];

    const summary = aggregateFileChangeSummary(msgs);

    expect(summary?.files).toEqual([
      { path: "new.ts", added: 2, removed: 0, count: 1 },
      { path: "old.ts", added: 1, removed: 1, count: 1 },
    ]);
    expect(summary?.sessionDiffs.map((d) => d.path)).toEqual(["new.ts", "old.ts"]);
    expect(summary?.sessionDiffs[0]?.diff).toContain("--- /dev/null");
    expect(summary?.sessionDiffs[0]?.diff).toContain("+++ b/new.ts");
    expect(summary?.sessionDiffs[0]?.diff).toContain("+line2");
    expect(summary?.sessionDiffs[1]?.diff).toContain("--- a/old.ts");
    expect(summary?.sessionDiffs[1]?.diff).toContain("-before");
    expect(summary?.sessionDiffs[1]?.diff).toContain("+after");
  });

  test("returns session-scoped synthetic diffs for MultiEdit edits array", () => {
    const msgs: Message[] = [
      user(),
      tool("MultiEdit", {
        file_path: "multi.ts",
        edits: [
          { old_string: "one", new_string: "one\ntwo" },
          { old_string: "three", new_string: "four" },
        ],
      }),
    ];

    const summary = aggregateFileChangeSummary(msgs);

    expect(summary?.files).toEqual([{ path: "multi.ts", added: 3, removed: 2, count: 1 }]);
    expect(summary?.sessionDiffs[0]?.diff).toContain("@@ -1 +1,2 @@ edit 1");
    expect(summary?.sessionDiffs[0]?.diff).toContain("-one");
    expect(summary?.sessionDiffs[0]?.diff).toContain("+two");
    expect(summary?.sessionDiffs[0]?.diff).toContain("@@ -1 +1 @@ edit 2");
    expect(summary?.sessionDiffs[0]?.diff).toContain("-three");
    expect(summary?.sessionDiffs[0]?.diff).toContain("+four");
  });
});
