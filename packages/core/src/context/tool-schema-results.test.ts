import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentBlock, Message } from "../types.js";
import {
  applyToolResultBudget,
  COMPACTABLE_TOOL_NAMES,
  maskOldObservations,
  microcompact,
  truncateToolResult,
} from "./compaction.js";
import { ContextManager } from "./manager.js";
import {
  applyToolResultPersistence,
  createContentReplacementState,
} from "./tool-result-storage.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "codeshell-tool-schema-"));
  directories.push(directory);
  return directory;
}

// Non-ASCII schema descriptions can fit the 24k character discovery budget
// while exceeding ordinary per-result token limits.
const schema = JSON.stringify({
  name: "mcp__catalog__lookup",
  description: "检索结构化数据🧪".repeat(2_000),
  inputSchema: {
    type: "object",
    properties: { filters: { type: "array", items: { type: "object" } } },
    required: ["filters"],
  },
});

function round(id: string, name: string, content: string): Message[] {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id,
          name,
          input:
            name === "CallTool"
              ? { name: "ToolSearch", args: { query: "select:mcp__catalog__lookup" } }
              : {},
        },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
  ];
}

function findResult(messages: Message[], id: string): ContentBlock {
  const block = messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .find((candidate) => candidate.type === "tool_result" && candidate.tool_use_id === id);
  if (!block) throw new Error(`Missing tool result ${id}`);
  return block;
}

describe("ToolSearch schemas remain in conversation history", () => {
  test("microcompaction and browser observation masking preserve all discovered schemas", () => {
    const messages = [
      ...round("discovery", "ToolSearch", schema),
      ...round("wrapped", "CallTool", schema),
      ...round("read", "Read", "old file contents"),
      ...round("old-snapshot", "browser_observe", "old browser snapshot"),
      ...round("new-snapshot", "browser_observe", "new browser snapshot"),
    ];
    expect(COMPACTABLE_TOOL_NAMES.has("ToolSearch")).toBe(false);
    const compacted = microcompact(messages, { keepRecentN: 0 });
    expect(findResult(compacted, "read").content).toContain("Old tool result cleared");
    const masked = maskOldObservations(compacted);
    expect(masked.maskedCount).toBe(1);
    for (const id of ["discovery", "wrapped"]) {
      expect(findResult(masked.messages, id)).toBe(findResult(messages, id));
      expect(findResult(masked.messages, id).content).toBe(schema);
    }
  });

  test("aggregate character and token caps reduce ordinary results, keeping schema bytes", () => {
    const discovery = round("discovery", "ToolSearch", schema);
    const ordinary = round("ordinary", "Bash", "output ".repeat(2_000));
    const messages: Message[] = [
      discovery[0]!,
      ordinary[0]!,
      {
        role: "user",
        content: [findResult(discovery, "discovery"), findResult(ordinary, "ordinary")],
      },
    ];
    const original = JSON.stringify(messages);
    for (const [characters, tokens] of [
      [1_000, Infinity],
      [Infinity, 300],
    ]) {
      const result = applyToolResultBudget(messages, characters, tokens);
      expect(findResult(result, "discovery").content).toBe(schema);
      expect((findResult(result, "ordinary").content as string).length).toBeLessThan(1_000);
    }
    expect(JSON.stringify(messages)).toBe(original);
  });

  test("persistence does not save schemas or replay stale saved replacements", () => {
    const directory = tempDirectory();
    const state = createContentReplacementState();
    state.replacements.set("discovery", "stale preview without schemas");
    const messages = [
      ...round("discovery", "ToolSearch", schema),
      ...round("wrapped", "CallTool", schema),
      ...round("ordinary", "Bash", "ordinary output ".repeat(2_000)),
    ];
    const result = applyToolResultPersistence(messages, {
      toolResultsDir: directory,
      state,
      perResultThreshold: 100,
      perResultTokenLimit: 50,
      perMessageCap: 100,
      perMessageTokenLimit: 50,
    });
    expect(findResult(result, "discovery").content).toBe(schema);
    expect(findResult(result, "wrapped").content).toBe(schema);
    expect(findResult(result, "ordinary").content).toContain("Full output saved to:");
    expect(readdirSync(directory).filter((name) => name.endsWith(".txt"))).toHaveLength(1);
    expect(state.replacements.has("wrapped")).toBe(false);
  });

  test.each(["sync", "async"] as const)(
    "%s management preserves schemas across persistence, truncation, budgets and resume",
    async (mode) => {
      const directory = tempDirectory();
      const config = {
        maxTokens: 1_000_000,
        maxToolResultChars: 100,
        toolOutputTokenLimit: 50,
        toolMessageTokenLimit: 50,
      };
      const transcriptPath = join(directory, "transcript.jsonl");
      const manager = new ContextManager(config);
      manager.setTranscriptPath(transcriptPath);
      const messages = [
        ...round("discovery", "ToolSearch", schema),
        ...round("wrapped", "CallTool", schema),
      ];
      const original = JSON.stringify(messages);
      const manage = (context: ContextManager, input: Message[]) =>
        mode === "sync" ? context.manage(input) : context.manageAsync(input);
      expect(JSON.stringify(await manage(manager, messages))).toBe(original);
      const resumed = new ContextManager(config);
      resumed.setTranscriptPath(transcriptPath);
      resumed.initReplacementStateFromMessages(messages);
      const appended = [...messages, ...round("next-discovery", "ToolSearch", schema)];
      expect(JSON.stringify((await manage(resumed, appended)).slice(0, messages.length))).toBe(
        original,
      );
    },
  );

  test("a complete discovery response fits the single-result 30k truncation boundary", () => {
    expect(schema.length).toBeLessThan(24_000);
    expect(truncateToolResult(schema)).toBe(schema);
    const fullBudget = "x".repeat(24_000);
    expect(truncateToolResult(fullBudget)).toBe(fullBudget);
  });
});
