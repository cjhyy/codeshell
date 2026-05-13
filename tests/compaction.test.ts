import { describe, it, expect } from "bun:test";
import {
  estimateTokens,
  windowCompact,
  microcompact,
  truncateToolResult,
  buildSummarizationPrompt,
  applySummaryCompaction,
} from "../src/context/compaction.js";
import type { Message } from "../src/types.js";

describe("estimateTokens", () => {
  it("estimates string messages", () => {
    const messages: Message[] = [
      { role: "user", content: "hello world" },
    ];
    const tokens = estimateTokens(messages);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(30);
  });

  it("estimates content block messages", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "a".repeat(100) },
          { type: "tool_use", id: "1", name: "Read", input: { path: "/a" } },
        ],
      },
    ];
    const tokens = estimateTokens(messages);
    expect(tokens).toBeGreaterThan(25);
  });

  it("returns 0 for empty", () => {
    expect(estimateTokens([])).toBe(0);
  });
});

describe("windowCompact", () => {
  it("keeps first + last N", () => {
    const msgs: Message[] = Array.from({ length: 10 }, (_, i) => ({
      role: "user" as const,
      content: `msg${i}`,
    }));
    const result = windowCompact(msgs, 3);
    expect(result).toHaveLength(4); // first + 3
    expect((result[0].content as string)).toBe("msg0");
    expect((result[1].content as string)).toBe("msg7");
    expect((result[3].content as string)).toBe("msg9");
  });

  it("returns original if short enough", () => {
    const msgs: Message[] = [{ role: "user", content: "a" }, { role: "user", content: "b" }];
    expect(windowCompact(msgs, 5)).toHaveLength(2);
  });
});

describe("microcompact", () => {
  /** Pair an assistant tool_use with the user tool_result that follows it. */
  function round(id: string, tool: string, input: Record<string, unknown>, result: string): Message[] {
    return [
      { role: "assistant", content: [{ type: "tool_use", id, name: tool, input }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: result }] },
    ];
  }

  it("clears old whitelisted tool results with a fingerprint of the call", () => {
    const msgs: Message[] = [
      ...round("1", "Read", { file_path: "/a.ts" }, "contents of a"),
      ...round("2", "Read", { file_path: "/b.ts" }, "contents of b"),
      ...round("3", "Read", { file_path: "/c.ts" }, "contents of c"),
      ...round("4", "Read", { file_path: "/d.ts" }, "contents of d"),
    ];
    const result = microcompact(msgs, { keepRecentN: 2 });
    // tool_result for rounds 1+2 should be fingerprinted; rounds 3+4 kept.
    expect((result[1].content as any)[0].content).toBe(
      "[Old tool result cleared — Read file_path=/a.ts]",
    );
    expect((result[3].content as any)[0].content).toBe(
      "[Old tool result cleared — Read file_path=/b.ts]",
    );
    expect((result[5].content as any)[0].content).toBe("contents of c");
    expect((result[7].content as any)[0].content).toBe("contents of d");
  });

  it("does nothing when fewer rounds than keepRecentN", () => {
    const msgs: Message[] = [...round("1", "Read", { file_path: "/x" }, "ok")];
    const result = microcompact(msgs, { keepRecentN: 5 });
    expect((result[1].content as any)[0].content).toBe("ok");
  });

  it("never clears orchestration tool results", () => {
    const msgs: Message[] = [
      ...round("t1", "TaskCreate", { subject: "step 1" }, '{"taskId":"1"}'),
      ...round("t2", "TaskUpdate", { taskId: "1", status: "in_progress" }, "ok"),
      ...round("t3", "TaskUpdate", { taskId: "1", status: "completed" }, "ok"),
      ...round("t4", "Agent", { description: "subagent" }, "report"),
    ];
    // Aggressive cap that would clear *everything* if the whitelist failed.
    const result = microcompact(msgs, { keepRecentN: 0 });
    expect((result[1].content as any)[0].content).toBe('{"taskId":"1"}');
    expect((result[3].content as any)[0].content).toBe("ok");
    expect((result[5].content as any)[0].content).toBe("ok");
    expect((result[7].content as any)[0].content).toBe("report");
  });

  it("counts rounds by compactable tool only — orchestration rounds don't push out Reads", () => {
    const msgs: Message[] = [
      ...round("r1", "Read", { file_path: "/a" }, "A"),
      ...round("t1", "TaskUpdate", { taskId: "1", status: "in_progress" }, "ok"),
      ...round("t2", "TaskUpdate", { taskId: "1", status: "completed" }, "ok"),
      ...round("r2", "Read", { file_path: "/b" }, "B"),
    ];
    // keepRecentN=2 must keep BOTH Reads, even though three orchestration
    // rounds happened between them — orchestration rounds are not counted.
    const result = microcompact(msgs, { keepRecentN: 2 });
    expect((result[1].content as any)[0].content).toBe("A");
    expect((result[7].content as any)[0].content).toBe("B");
  });

  it("fires onClear once with cleared round count and tool names", () => {
    const msgs: Message[] = [
      ...round("1", "Read", { file_path: "/a" }, "A"),
      ...round("2", "Bash", { command: "ls" }, "out"),
      ...round("3", "Read", { file_path: "/c" }, "C"),
    ];
    let calls = 0;
    let captured: { clearedRounds: number; toolNames: string[] } | undefined;
    microcompact(msgs, {
      keepRecentN: 1,
      onClear: (info) => {
        calls++;
        captured = info;
      },
    });
    expect(calls).toBe(1);
    expect(captured?.clearedRounds).toBe(2);
    expect(captured?.toolNames).toEqual(["Bash", "Read"]);
  });
});

describe("truncateToolResult", () => {
  it("returns short content unchanged", () => {
    expect(truncateToolResult("short", 100)).toBe("short");
  });

  it("truncates long content with head+tail", () => {
    const long = "x".repeat(1000);
    const result = truncateToolResult(long, 200);
    expect(result.length).toBeLessThan(1000);
    expect(result).toContain("characters truncated");
  });
});

describe("applySummaryCompaction", () => {
  it("replaces middle with summary", () => {
    const msgs: Message[] = Array.from({ length: 10 }, (_, i) => ({
      role: "user" as const,
      content: `msg${i}`,
    }));
    const result = applySummaryCompaction(msgs, "Summary of work done", 3);
    // first + summary + last 3 = 5
    expect(result).toHaveLength(5);
    expect((result[0].content as string)).toBe("msg0");
    expect((result[1].content as string)).toContain("Summary of work done");
    expect((result[2].content as string)).toBe("msg7");
  });
});

describe("buildSummarizationPrompt", () => {
  it("includes message content", () => {
    const msgs: Message[] = [
      { role: "user", content: "fix the bug" },
      { role: "assistant", content: "I found the issue" },
    ];
    const prompt = buildSummarizationPrompt(msgs);
    expect(prompt).toContain("fix the bug");
    expect(prompt).toContain("found the issue");
    expect(prompt).toContain("Summarize");
  });
});
