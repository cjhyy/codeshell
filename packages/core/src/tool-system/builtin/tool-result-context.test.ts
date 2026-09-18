import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextManager } from "../../context/manager.js";
import { estimateStringTokens } from "../../context/token-counter.js";
import { toolResultToBlock } from "../../engine/turn-loop.js";
import type { ContentBlock, Message, ToolResult } from "../../types.js";
import { createToolRegistryHarness } from "../testing/tool-registry-harness.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function rootDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "builtin-context-budget-"));
  roots.push(root);
  return root;
}

function history(result: ToolResult): Message[] {
  return [
    { role: "user", content: "Inspect the diagnostics and preserve the evidence." },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: result.id, name: result.toolName, input: {} }],
    },
    { role: "user", content: [toolResultToBlock(result)] },
  ];
}

function resultBlock(messages: Message[]): ContentBlock {
  return (messages.at(-1)!.content as ContentBlock[])[0]!;
}

function textOf(block: ContentBlock): string {
  return typeof block.content === "string"
    ? block.content
    : (block.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n\n");
}

function savedPath(preview: string): string {
  const match = /Full output saved to: ([^\n]+)/.exec(preview);
  expect(match).not.toBeNull();
  return match![1]!;
}

test("a large builtin Read remains recoverable through file tools after context reduction and resume", async () => {
  const root = rootDirectory();
  const file = join(root, "diagnostics.txt");
  const lines = Array.from({ length: 600 }, (_, i) => `${i}: ${"diagnostic detail ".repeat(5)}`);
  lines[300] = "UNIQUE_MIDDLE_FAILURE: dependency checksum mismatch";
  lines[599] = "FINAL_FAILURE: release validation did not pass";
  writeFileSync(file, lines.join("\n"));
  const harness = createToolRegistryHarness({ cwd: root, builtinTools: ["Read", "Grep"] });
  const read = await harness.execute("Read", { file_path: file });
  expect(read.isError).toBe(false);
  const original = history(read);
  const originalBytes = JSON.stringify(original);
  const transcript = join(root, "transcript.jsonl");
  const manager = new ContextManager({ maxTokens: 1_000_000 });
  manager.setTranscriptPath(transcript);
  const reduced = await manager.manageAsync(original);
  const preview = textOf(resultBlock(reduced));
  expect(preview).toContain("FINAL_FAILURE");
  expect(preview).not.toContain("UNIQUE_MIDDLE_FAILURE");
  expect(readFileSync(savedPath(preview), "utf8")).toBe(read.result);
  const recovered = await harness.execute("Grep", {
    path: savedPath(preview),
    pattern: "UNIQUE_MIDDLE_FAILURE",
    output_mode: "content",
  });
  expect(recovered.isError).toBe(false);
  expect(recovered.result).toContain("dependency checksum mismatch");
  expect(JSON.stringify(original)).toBe(originalBytes);
  const resumed = new ContextManager({ maxTokens: 1_000_000 });
  resumed.setTranscriptPath(transcript);
  resumed.initReplacementStateFromMessages(original);
  expect(await resumed.manageAsync(original)).toEqual(reduced);
});

test("registry multimodal results keep image order and readable Unicode diagnostics under a shared budget", async () => {
  const root = rootDirectory();
  const harness = createToolRegistryHarness({ cwd: root, builtinTools: [] });
  const first = "检查开始 🚀\n" + "成功检查🧪".repeat(2_000);
  const last = "最终错误 ❌：截图与预期不符";
  const image: ContentBlock = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "aW1hZ2UtZml4dHVyZQ==" },
  };
  harness.registry.registerTool(
    {
      name: "InspectionFixture",
      description: "Return a screenshot between its diagnostic text and conclusion",
      inputSchema: { type: "object", properties: {} },
      permissionDefault: "allow",
    },
    async () => ({
      contentBlocks: [{ type: "text", text: first }, image, { type: "text", text: last }],
    }),
  );
  const result = await harness.execute("InspectionFixture");
  expect(result.isError).toBe(false);
  const manager = new ContextManager({ maxTokens: 1_000_000, toolOutputTokenLimit: 700 });
  manager.setTranscriptPath(join(root, "transcript.jsonl"));
  const reduced = resultBlock(await manager.manageAsync(history(result)));
  const parts = reduced.content as ContentBlock[];
  expect(parts.map((part) => part.type)).toEqual(["text", "image", "text"]);
  expect(parts[1]).toBe(image);
  expect(parts[0]!.text).toContain("检查开始 🚀");
  expect(parts[2]!.text).toContain(last);
  expect(estimateStringTokens(textOf(reduced))).toBeLessThanOrEqual(700);
  expect(readFileSync(savedPath(textOf(reduced)), "utf8")).toBe(`${first}\n\n${last}`);
  expect(result.contentBlocks?.[0]!.text).toBe(first);
  expect(result.contentBlocks?.[2]!.text).toBe(last);
});
