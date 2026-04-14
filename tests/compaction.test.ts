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
      { role: "user", content: "hello world" }, // 11 chars → ~3 tokens
    ];
    expect(estimateTokens(messages)).toBe(3);
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
  it("clears old tool results", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "big output 1" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "2", content: "big output 2" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "3", content: "big output 3" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "4", content: "recent" }] },
    ];
    const result = microcompact(msgs, 2);
    // First 2 should be cleared, last 2 kept
    expect((result[0].content as any)[0].content).toBe("[Old tool result content cleared]");
    expect((result[1].content as any)[0].content).toBe("[Old tool result content cleared]");
    expect((result[2].content as any)[0].content).toBe("big output 3");
    expect((result[3].content as any)[0].content).toBe("recent");
  });

  it("does nothing if fewer than threshold", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "ok" }] },
    ];
    const result = microcompact(msgs, 3);
    expect((result[0].content as any)[0].content).toBe("ok");
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
