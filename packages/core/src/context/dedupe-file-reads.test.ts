import { describe, test, expect } from "bun:test";
import { dedupeFileReads } from "./compaction.js";
import type { Message } from "../types.js";

// TODO §8.3 — same file Read multiple times keeps only the latest copy.

/** One assistant tool_use + the following user tool_result, as two messages. */
function readPair(id: string, filePath: string, body: string): Message[] {
  return [
    {
      role: "assistant",
      content: [{ type: "tool_use", id, name: "Read", input: { file_path: filePath } }],
    } as unknown as Message,
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: body }],
    } as unknown as Message,
  ];
}

function resultContent(messages: Message[], toolUseId: string): string | undefined {
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === "tool_result" && b.tool_use_id === toolUseId) {
        return typeof b.content === "string" ? b.content : undefined;
      }
    }
  }
  return undefined;
}

describe("dedupeFileReads", () => {
  test("clears all but the latest Read of the same file", () => {
    const messages: Message[] = [
      ...readPair("r1", "/proj/a.ts", "VERSION ONE of a.ts"),
      ...readPair("r2", "/proj/a.ts", "VERSION TWO of a.ts"),
      ...readPair("r3", "/proj/a.ts", "VERSION THREE of a.ts"),
    ];
    const { messages: out, clearedCount } = dedupeFileReads(messages);
    expect(clearedCount).toBe(2);
    expect(resultContent(out, "r1")).toContain("superseded by a newer Read");
    expect(resultContent(out, "r2")).toContain("superseded by a newer Read");
    // Newest survives intact.
    expect(resultContent(out, "r3")).toBe("VERSION THREE of a.ts");
  });

  test("different files are independent — each keeps its own latest", () => {
    const messages: Message[] = [
      ...readPair("a1", "/proj/a.ts", "a old"),
      ...readPair("b1", "/proj/b.ts", "b only"),
      ...readPair("a2", "/proj/a.ts", "a new"),
    ];
    const { messages: out, clearedCount } = dedupeFileReads(messages);
    expect(clearedCount).toBe(1);
    expect(resultContent(out, "a1")).toContain("superseded");
    expect(resultContent(out, "a2")).toBe("a new"); // a's latest kept
    expect(resultContent(out, "b1")).toBe("b only"); // b read once → untouched
  });

  test("a single Read is never touched", () => {
    const messages = readPair("only", "/proj/x.ts", "the content");
    const { clearedCount } = dedupeFileReads(messages);
    expect(clearedCount).toBe(0);
  });

  test("idempotent — already-cleared results are not re-counted", () => {
    const messages: Message[] = [
      ...readPair("r1", "/proj/a.ts", "old"),
      ...readPair("r2", "/proj/a.ts", "new"),
    ];
    const first = dedupeFileReads(messages);
    expect(first.clearedCount).toBe(1);
    const second = dedupeFileReads(first.messages);
    expect(second.clearedCount).toBe(0); // nothing left to clear
  });

  test("non-Read tools are not deduped (Edit/Write results are diffs, not snapshots)", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/proj/a.ts" } }],
      } as unknown as Message,
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "e1", content: "edit 1 diff" }],
      } as unknown as Message,
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "e2", name: "Edit", input: { file_path: "/proj/a.ts" } }],
      } as unknown as Message,
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "e2", content: "edit 2 diff" }],
      } as unknown as Message,
    ];
    const { clearedCount } = dedupeFileReads(messages);
    expect(clearedCount).toBe(0);
  });
});
