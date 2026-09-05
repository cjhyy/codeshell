import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextManager } from "../context/manager.js";
import type { Message } from "../types.js";
import { TurnLoop, type TurnLoopDeps } from "./turn-loop.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function toolPair(
  id: string,
  name: string,
  input: Record<string, unknown>,
  body: string,
): Message[] {
  return [
    { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: body }] },
  ];
}

function resultText(messages: Message[], id: string): string | undefined {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_result" && block.tool_use_id === id) {
        return typeof block.content === "string" ? block.content : undefined;
      }
    }
  }
  return undefined;
}

function contextHarness(contextManager: ContextManager, volatile: Message[]) {
  const loop = new TurnLoop({ contextManager } as TurnLoopDeps, {
    maxTurns: 10,
    maxToolCallsPerTurn: 10,
    volatileContextMessages: volatile,
  });
  // Exercise the real manager/loop integration without an API or tool executor.
  return loop as unknown as {
    manageContextMessages(messages: Message[]): Promise<Message[]>;
    manageContextMessagesSync(messages: Message[]): Message[];
    restoreVolatileAfterContextManagement(
      original: Message[],
      stableInput: Message[],
      managedStable: Message[],
    ): Message[];
  };
}

describe("TurnLoop preserves volatile prompt prefixes during tool-result cleanup", () => {
  test("persisting each new large result keeps every already-sent message in place", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cs-volatile-prefix-"));
    temporaryDirectories.push(directory);
    const manager = new ContextManager({ maxTokens: 1_000_000 });
    manager.setTranscriptPath(join(directory, "session.jsonl"));
    const volatile: Message = { role: "user", content: "DYNAMIC_SKILL_LISTING" };
    const loop = contextHarness(manager, [volatile]);
    let previous: Message[] = [
      { role: "user", content: "task" },
      volatile,
      ...toolPair("small", "Bash", {}, "already consumed small output"),
    ];
    previous = await loop.manageContextMessages(previous);

    for (const id of ["large-one", "large-two"]) {
      const next = await loop.manageContextMessages([
        ...previous,
        ...toolPair(id, "Bash", {}, "synthetic output ".repeat(4_000)),
      ]);

      expect(JSON.stringify(next.slice(0, previous.length))).toBe(JSON.stringify(previous));
      expect(next[1]).toBe(volatile);
      expect(resultText(next, id)).toContain("<persisted-output>");
      expect(resultText(next, id)!.length).toBeLessThan(3_000);
      previous = next;
    }
    expect(readdirSync(join(directory, "tool-results"))).toHaveLength(2);
  });

  test("the sync path keeps the prefix while still truncating a new oversized result", () => {
    const manager = new ContextManager({ maxTokens: 1_000_000 });
    const volatile: Message = { role: "user", content: "DYNAMIC_MEMORY_INDEX" };
    const loop = contextHarness(manager, [volatile]);
    const previous: Message[] = [
      { role: "user", content: "task" },
      volatile,
      ...toolPair("small", "Bash", {}, "already consumed output"),
    ];
    const next = loop.manageContextMessagesSync([
      ...previous,
      ...toolPair("large", "Bash", {}, "x".repeat(40_000)),
    ]);

    expect(JSON.stringify(next.slice(0, previous.length))).toBe(JSON.stringify(previous));
    expect(next[1]).toBe(volatile);
    expect(resultText(next, "large")).toContain("characters truncated");
    expect(resultText(next, "large")!.length).toBeLessThan(30_000);
    expect(loop.manageContextMessagesSync(next)).toBe(next);
  });

  test("content-equivalent copied history is a no-op, even with array content", () => {
    const manager = new ContextManager({ maxTokens: 1_000_000 });
    const volatile: Message = { role: "user", content: "DYNAMIC_CONTEXT" };
    const loop = contextHarness(manager, [volatile]);
    const stable = toolPair("read", "Read", { file_path: "/synthetic/a.ts" }, "body");
    const original = [stable[0]!, volatile, stable[1]!];
    const copied: Message[] = JSON.parse(JSON.stringify(stable));

    expect(loop.restoreVolatileAfterContextManagement(original, stable, copied)).toBe(original);
  });

  test("preserves multiple volatile boundaries when only the new tail changes", async () => {
    const manager = new ContextManager({ maxTokens: 1_000_000 });
    const first: Message = { role: "user", content: "FIRST_DYNAMIC_CONTEXT" };
    const second: Message = { role: "user", content: "SECOND_DYNAMIC_CONTEXT" };
    const loop = contextHarness(manager, [first, second]);
    const previous: Message[] = [
      { role: "user", content: "task" },
      first,
      ...toolPair("small", "Bash", {}, "small"),
      second,
    ];
    const next = await loop.manageContextMessages([
      ...previous,
      ...toolPair("large", "Bash", {}, "x".repeat(40_000)),
    ]);

    expect(next.slice(0, previous.length)).toEqual(previous);
    expect(next[1]).toBe(first);
    expect(next[4]).toBe(second);
    expect(resultText(next, "large")).toContain("characters truncated");
  });

  test("resets to the tail when a repeated Read rewrites history before the boundary", async () => {
    const manager = new ContextManager({ maxTokens: 1_000_000 });
    const volatile: Message = { role: "user", content: "DYNAMIC_CONTEXT" };
    const loop = contextHarness(manager, [volatile]);
    const original: Message[] = [
      { role: "user", content: "task" },
      ...toolPair("old", "Read", { file_path: "/synthetic/a.ts" }, "old body"),
      volatile,
      ...toolPair("new", "Read", { file_path: "/synthetic/a.ts" }, "new body"),
    ];
    const next = await loop.manageContextMessages(original);

    expect(next.at(-1)).toBe(volatile);
    expect(resultText(next, "old")).toContain("superseded by a newer Read");
    expect(resultText(next, "new")).toBe("new body");
  });

  test("real summary compaction excludes volatile content and restores it at the new tail", async () => {
    const manager = new ContextManager({ maxTokens: 10_000, compactAtRatio: 0.5 });
    const summaryInputs: string[] = [];
    manager.setSummarizeFn(async (prompt) => {
      summaryInputs.push(prompt);
      return "The previous task inspected synthetic files and recorded its decisions. Continue with the remaining work.";
    });
    const volatile: Message = { role: "user", content: "NEVER_SUMMARIZE_THIS_DYNAMIC_CONTEXT" };
    const loop = contextHarness(manager, [volatile]);
    const original: Message[] = [
      { role: "user", content: "task" },
      volatile,
      ...Array.from(
        { length: 14 },
        (_, index): Message => ({
          role: index % 2 === 0 ? "assistant" : "user",
          content: `old message ${index}: ${"detail ".repeat(500)}`,
        }),
      ),
      ...Array.from(
        { length: 8 },
        (_, index): Message => ({
          role: index % 2 === 0 ? "assistant" : "user",
          content: `recent message ${index}`,
        }),
      ),
    ];
    const next = await loop.manageContextMessages(original);

    expect(summaryInputs).toHaveLength(1);
    expect(summaryInputs[0]).not.toContain("NEVER_SUMMARIZE_THIS_DYNAMIC_CONTEXT");
    expect(JSON.stringify(next)).toContain("<anchored-summary>");
    expect(next.length).toBeLessThan(original.length);
    expect(next.at(-1)).toBe(volatile);
    expect(next.filter((message) => message === volatile)).toHaveLength(1);
  });
});
