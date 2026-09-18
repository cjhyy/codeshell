import { describe, test, expect } from "bun:test";
import { dedupeFileReads } from "./compaction.js";
import type { ContentBlock, Message } from "../types.js";

// TODO §8.3 — same file Read multiple times keeps only the latest copy.

/** One assistant tool_use + the following user tool_result, as two messages. */
function readPair(
  id: string,
  filePath: string,
  body: string,
  range: { offset?: unknown; limit?: unknown } = {},
  isError = false,
): Message[] {
  return [
    {
      role: "assistant",
      content: [{ type: "tool_use", id, name: "Read", input: { file_path: filePath, ...range } }],
    } as unknown as Message,
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: body,
          ...(isError ? { is_error: true } : {}),
        },
      ],
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

  test.each([
    [
      { offset: 1, limit: 100 },
      { offset: 101, limit: 100 },
    ],
    [
      { offset: 1, limit: 100 },
      { offset: 1, limit: 200 },
    ],
    [{}, { offset: 1, limit: 100 }],
  ])("preserves distinct requested ranges: %j then %j", (firstRange, secondRange) => {
    const messages = [
      ...readPair("first", "/proj/a.ts", "first range", firstRange),
      ...readPair("second", "/proj/a.ts", "second range", secondRange),
    ];
    const out = dedupeFileReads(messages);
    expect(out.clearedCount).toBe(0);
    expect(out.messages).toBe(messages);
  });

  test.each([
    { offset: 1, limit: 2000 },
    { offset: 0, limit: 0 },
    { offset: -5, limit: -5 },
  ])("matches Read's default range with explicit or fallback values: %j", (range) => {
    const messages = [
      ...readPair("first", "/proj/a.ts", "old default page"),
      ...readPair("second", "/proj/a.ts", "new default page", range),
    ];
    const out = dedupeFileReads(messages);
    expect(out.clearedCount).toBe(1);
    expect(resultContent(out.messages, "first")).toContain("superseded");
    expect(resultContent(out.messages, "second")).toBe("new default page");
  });

  test.each([
    { offset: 1.5 },
    { limit: 100.5 },
    { offset: Infinity },
    { limit: Infinity },
    { offset: "1" },
    { limit: "2000" },
  ])("leaves ambiguous ranges untouched even when repeated: %j", (range) => {
    const messages = [
      ...readPair("first", "/proj/a.ts", "old content", range),
      ...readPair("second", "/proj/a.ts", "new content", range),
    ];
    expect(dedupeFileReads(messages).clearedCount).toBe(0);
  });

  test.each([
    ["Error: File not found: /proj/a.ts", false],
    ["Error reading file: EACCES: permission denied", false],
    ["request interrupted", true],
  ] as Array<[string, boolean]>)(
    "a failed Read preserves the previous successful result: %s",
    (body, isError) => {
      const messages = [
        ...readPair("first", "/proj/a.ts", "successful content"),
        ...readPair("failed", "/proj/a.ts", body, {}, isError),
      ];
      const out = dedupeFileReads(messages);
      expect(out.clearedCount).toBe(0);
      expect(resultContent(out.messages, "first")).toBe("successful content");
      expect(resultContent(out.messages, "failed")).toBe(body);
    },
  );

  test.each([
    "",
    "(no output)",
    "1\tpartial content\n\n... content truncated",
    "head\n\n... [90000 characters truncated] ...\n\ntail",
    "head\n[... tool output truncated ...]\ntail",
    "Output too large (20KB) — truncated to fit the per-message budget.\nPreview: partial",
    "<persisted-output>\nFull output saved to: /tmp/result.txt\nPreview: partial\n</persisted-output>",
    "Image file (not displayed by Read).\nPath: a.ts",
    "Binary file (not displayed by Read).\nPath: a.ts",
  ])("an incomplete Read does not supersede complete content: %s", (body) => {
    const messages = [
      ...readPair("first", "/proj/a.ts", "complete successful content"),
      ...readPair("incomplete", "/proj/a.ts", body),
    ];
    const out = dedupeFileReads(messages);
    expect(out.clearedCount).toBe(0);
    expect(out.messages).toBe(messages);
  });

  test("a later success supersedes the matching success without erasing an intervening error", () => {
    const messages = [
      ...readPair("first", "/proj/a.ts", "old success", { offset: 20, limit: 10 }),
      ...readPair("failed", "/proj/a.ts", "Error reading file: interrupted", {
        offset: 20,
        limit: 10,
      }),
      ...readPair("last", "/proj/a.ts", "new success", { offset: 20, limit: 10 }),
    ];
    const out = dedupeFileReads(messages);
    expect(out.clearedCount).toBe(1);
    expect(resultContent(out.messages, "first")).toContain("superseded");
    expect(resultContent(out.messages, "failed")).toBe("Error reading file: interrupted");
    expect(resultContent(out.messages, "last")).toBe("new success");
  });

  test("parallel Read pages remain separate and dedup leaves the original history untouched", () => {
    const pairs = [
      readPair("page-one-old", "/proj/中文.ts", "1\t第一段", { offset: 1, limit: 100 }),
      readPair("page-two", "/proj/中文.ts", "101\t第二段", { offset: 101, limit: 100 }),
      readPair("page-one-new", "/proj/中文.ts", "1\t更新内容", { offset: 1, limit: 100 }),
    ];
    const messages: Message[] = [
      { role: "assistant", content: pairs.flatMap((pair) => pair[0].content as ContentBlock[]) },
      { role: "user", content: pairs.flatMap((pair) => pair[1].content as ContentBlock[]) },
    ];
    const original = structuredClone(messages);
    for (const message of messages) {
      for (const block of message.content as ContentBlock[]) Object.freeze(block);
      Object.freeze(message.content);
      Object.freeze(message);
    }
    Object.freeze(messages);

    const out = dedupeFileReads(messages);
    expect(out.clearedCount).toBe(1);
    expect(resultContent(out.messages, "page-one-old")).toContain("superseded");
    expect(resultContent(out.messages, "page-two")).toBe("101\t第二段");
    expect(resultContent(out.messages, "page-one-new")).toBe("1\t更新内容");
    expect(messages).toEqual(original);
    expect(dedupeFileReads(out.messages).clearedCount).toBe(0);
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
