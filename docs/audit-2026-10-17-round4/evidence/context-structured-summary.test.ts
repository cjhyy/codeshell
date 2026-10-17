import { describe, expect, test } from "bun:test";
import type { Message, ToolResult } from "../../../packages/core/src/types.js";
import { estimateTokens, serializeContextPackageMessages } from "../../../packages/core/src/context/compaction.js";
import { ContextManager } from "../../../packages/core/src/context/manager.js";
import { toolResultToBlock } from "../../../packages/core/src/engine/turn-loop.js";

// No model client is created. The fake summarizer can preserve this fact only
// if the real prompt serializer makes it visible. Tests expect the current bug.
const FACT = "OWNED_STRUCTURED_FACT: measured width is 321 pixels; next step is resize to 400.";
function messages(structured: boolean): Message[] {
  const tool: ToolResult = {
    id: "owned-measurement", toolName: "mcp_owned_measure", result: FACT,
    ...(structured ? { contentBlocks: [{ type: "text" as const, text: FACT }] } : {}),
  };
  const out: Message[] = [
    { role: "user", content: "Standing instructions for the owned fixture." },
    { role: "user", content: "Measure the owned example." },
    { role: "assistant", content: [{ type: "tool_use", id: tool.id, name: tool.toolName, input: {} }] },
    { role: "user", content: [toolResultToBlock(tool)] },
  ];
  for (let index = 4; index < 30; index++) {
    out.push({ role: index % 2 ? "user" : "assistant", content: `detail ${index}: ${"owned historical discussion ".repeat(300)}` });
  }
  return out;
}
function summarize(prompt: string): string {
  return "Owned summary of prior discussion and remaining work. ".repeat(2) + (prompt.includes(FACT) ? FACT : "No measurement appeared in the supplied conversation.");
}

describe("round4 structured tool result summary evidence", () => {
  test("automatic summary omits text from the real toolResultToBlock shape; scalar control preserves it", async () => {
    const structured = messages(true);
    const manager = new ContextManager({ maxTokens: estimateTokens(structured) / 0.88 });
    const prompts: string[] = [];
    manager.setSummarizeFn(async (prompt) => { prompts.push(prompt); return summarize(prompt); });
    const compacted = await manager.manageAsync(structured);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("[tool_result]: ");
    expect(prompts[0]).not.toContain(FACT);
    expect(compacted.length).toBeLessThan(structured.length);
    expect(JSON.stringify(compacted)).not.toContain(FACT);
    expect(JSON.stringify(structured)).toContain(FACT);
    // The separate portable context package path already understands the same
    // structured shape, so this is not an unsupported content contract.
    expect(serializeContextPackageMessages(structured).text).toContain(FACT);
    const scalar = messages(false);
    const control = new ContextManager({ maxTokens: estimateTokens(scalar) / 0.88 });
    control.setSummarizeFn(async (prompt) => summarize(prompt));
    expect(JSON.stringify(await control.manageAsync(scalar))).toContain(FACT);
  });

  test("range archival also replaces the only structured result with a summary that never received its text", async () => {
    const structured = messages(true);
    const manager = new ContextManager({ maxTokens: 1_000_000 });
    let prompt = "";
    manager.setSummarizeFn(async (value) => { prompt = value; return summarize(value); });
    const archived = await manager.summarizeRange(structured, { start: 1, end: 4 });
    expect(prompt).not.toContain(FACT);
    expect(JSON.stringify(archived)).not.toContain(FACT);
    expect(archived[0]).toBe(structured[0]);
    expect(archived.at(-1)).toBe(structured.at(-1));
    expect(JSON.stringify(structured)).toContain(FACT);
    const control = new ContextManager({ maxTokens: 1_000_000 });
    control.setSummarizeFn(async (value) => summarize(value));
    expect(JSON.stringify(await control.summarizeRange(messages(false), { start: 1, end: 4 }))).toContain(FACT);
  });
});
