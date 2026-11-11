import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentBlock, Message, ToolDefinition } from "../types.js";
import {
  matchesToolDiscoverySchema,
  toolDiscoverySchemaBlock,
} from "../utils/tool-schema-discovery.js";
import {
  applyToolResultBudget,
  buildSummarizationPrompt,
  COMPACTABLE_TOOL_NAMES,
  maskOldObservations,
  microcompact,
  serializeContextPackageMessages,
  truncateToolResult,
} from "./compaction.js";
import { ContextManager } from "./manager.js";
import {
  applyToolResultPersistence,
  createContentReplacementState,
  reconstructContentReplacementState,
} from "./tool-result-storage.js";
import {
  createToolTextReplacement,
  replaceToolResultText,
  toolResultText,
} from "./tool-output-budget.js";

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

function round(id: string, name: string, content: string | ContentBlock[]): Message[] {
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

describe("native discovery text and metadata survive context management", () => {
  const tool: ToolDefinition = JSON.parse(schema);
  const content: ContentBlock[] = [
    { type: "text", text: "MCP health notice\n\n" },
    toolDiscoverySchemaBlock(tool),
    { type: "text", text: "\n\nUse CallTool for tools unavailable as native references." },
  ];
  const expectedText = content.map((block) => block.text).join("");

  test.each(["sync", "async"] as const)(
    "%s keeps annotations and every schema byte across cleanup and resume",
    async (mode) => {
      const directory = tempDirectory();
      const messages = [
        ...round("native", "ToolSearch", content),
        ...round("wrapped", "CallTool", content),
        ...round("read", "Read", "old file contents"),
        ...round("old-snapshot", "browser_observe", "old browser snapshot"),
        ...round("new-snapshot", "browser_observe", "new browser snapshot"),
        ...round("ordinary", "Bash", "ordinary output ".repeat(2_000)),
      ];
      const expected = JSON.stringify(content);
      const cleaned = maskOldObservations(microcompact(messages, { keepRecentN: 0 })).messages;
      const budgeted = applyToolResultBudget(cleaned, 100, 50);
      const state = createContentReplacementState();
      state.replacements.set("native", "stale persisted preview");
      const persisted = applyToolResultPersistence(budgeted, {
        toolResultsDir: directory,
        state,
        perResultThreshold: 100,
        perResultTokenLimit: 50,
        perMessageCap: 100,
        perMessageTokenLimit: 50,
      });
      const config = {
        maxTokens: 1_000_000,
        maxToolResultChars: 100,
        toolOutputTokenLimit: 50,
        toolMessageTokenLimit: 50,
      };
      const manager = new ContextManager(config);
      const transcriptPath = join(directory, "transcript.jsonl");
      manager.setTranscriptPath(transcriptPath);
      const manage = (context: ContextManager, input: Message[]) =>
        mode === "sync" ? context.manage(input) : context.manageAsync(input);
      const managed = await manage(manager, persisted);
      const resumed = new ContextManager(config);
      resumed.setTranscriptPath(transcriptPath);
      resumed.initReplacementStateFromMessages(managed);
      const replayed = await manage(resumed, managed);
      for (const stage of [cleaned, budgeted, persisted, managed, replayed]) {
        for (const id of ["native", "wrapped"]) {
          const result = findResult(stage, id);
          expect(JSON.stringify(result.content)).toBe(expected);
          expect(toolResultText(result.content)).toBe(expectedText);
          expect(matchesToolDiscoverySchema((result.content as ContentBlock[])[1]!, tool)).toBe(
            true,
          );
        }
      }
    },
  );

  test("budget text projection counts explicit separators once and invalidates changed schema bytes", () => {
    const full = createToolTextReplacement(content, { maxChars: expectedText.length });
    expect(full.text).toBe(expectedText);
    expect(full.parts).toEqual(content.map((block) => block.text));
    const shortened = createToolTextReplacement(content, { maxChars: 200 });
    const replacement = replaceToolResultText(content, shortened.text, shortened.parts);
    expect(shortened.text.length).toBeLessThanOrEqual(200);
    expect(toolResultText(replacement)).toBe(shortened.text);
    expect(matchesToolDiscoverySchema((replacement as ContentBlock[])[1]!, tool)).toBe(false);
  });

  test("annotations alone do not exempt ordinary output from persistence or break preview replay", () => {
    const directory = tempDirectory();
    const messages = round("ordinary", "Bash", content);
    const state = createContentReplacementState();
    const options = { toolResultsDir: directory, state, perResultThreshold: 100 };
    const persisted = applyToolResultPersistence(messages, options);
    const replacement = findResult(persisted, "ordinary").content;
    const text = toolResultText(replacement)!;
    expect(text).toContain("Full output saved to:");
    expect(text.length).toBeLessThan(expectedText.length);
    expect(state.replacements.get("ordinary")).toBe(text);
    const files = readdirSync(directory).filter((name) => name.endsWith(".txt"));
    expect(files).toHaveLength(1);
    expect(readFileSync(join(directory, files[0]!), "utf8")).toBe(expectedText);
    const restored = reconstructContentReplacementState(messages, directory);
    expect(restored.replacements.get("ordinary")).toBe(text);
    expect(applyToolResultPersistence(messages, { ...options, state: restored })).toEqual(
      persisted,
    );
    expect(matchesToolDiscoverySchema((replacement as ContentBlock[])[1]!, tool)).toBe(false);
  });

  test("summary and portable context prompts preserve explicit separators without exposing annotations", () => {
    const smallTool = { ...tool, description: "检索数据🧪" };
    const block = toolDiscoverySchemaBlock(smallTool);
    const blocks: ContentBlock[] = [
      { type: "text", text: "health\n\n" },
      block,
      { type: "text", text: "\n\nusage" },
    ];
    const messages = round("schema", "ToolSearch", blocks);
    const expected = `health\n\n${block.text}\n\nusage`;
    expect(buildSummarizationPrompt(messages)).toContain(expected);
    const portable = serializeContextPackageMessages(messages);
    expect(portable.text).toContain(expected);
    expect(portable.text).not.toContain("discoveredTool");
    expect(portable.hasSummarizableContent).toBe(true);
  });
});
