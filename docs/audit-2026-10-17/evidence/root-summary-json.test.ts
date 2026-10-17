import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractJSON } from "../../../packages/core/src/utils/json.ts";
globalThis.fetch = (() => { throw new Error("audit fixture forbids network"); }) as typeof fetch;
const { MemoryOrchestrator } = await import("../../../packages/core/src/services/memory-orchestrator.ts");
const { listSessionMemories } = await import("../../../packages/core/src/services/session-memory.ts");

async function summaryFixture(response: string) {
  const baseDir = mkdtempSync(join(tmpdir(), "cs-audit-summary-json-"));
  const calls: string[] = [];
  try {
    const orchestrator = new MemoryOrchestrator({ baseDir, projectDir: join(baseDir, "project"), callLLM: async (system: string) => {
      calls.push(system);
      return system.includes("extraction") ? "[]" : response;
    } });
    await orchestrator.run([
      { role: "user", content: "Remember the format example." },
      { role: "assistant", content: "I noted the example." },
      { role: "user", content: "Keep the punctuation exactly." },
    ], "fixture-summary");
    return { calls: calls.length, entries: listSessionMemories(baseDir) };
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
}

test("R2-12 greedy fence extraction merges a valid summary JSON with a later fenced example", async () => {
  const response = '```json\n{"summary":"Kept example","keyTopics":[],"decisions":[]}\n```\nExample:\n```txt\nsample\n```';
  const extracted = extractJSON(response);
  const result = await summaryFixture(response);
  console.log(JSON.stringify({ case: "multiple-fences", extracted, result }));
  expect(() => JSON.parse(extracted)).toThrow();
  expect(result.calls).toBe(2);
  expect(result.entries).toHaveLength(0);
});

test("R2-13 trailing comma repair changes comma-brace characters inside summary string", async () => {
  const response = '{"summary":"The literal ,} must stay.","keyTopics":["format",],"decisions":[]}';
  const result = await summaryFixture(response);
  console.log(JSON.stringify({ case: "trailing-comma-repair", response, result }));
  expect(result.calls).toBe(2);
  expect(result.entries).toHaveLength(1);
  expect(result.entries[0].summary).toBe("The literal } must stay.");
});

test("single fence and valid punctuation JSON normal control", async () => {
  const response = '```json\n{"summary":"The literal ,} must stay.","keyTopics":["format"],"decisions":[]}\n```';
  const result = await summaryFixture(response);
  expect(result.entries).toHaveLength(1);
  expect(result.entries[0].summary).toBe("The literal ,} must stay.");
});
