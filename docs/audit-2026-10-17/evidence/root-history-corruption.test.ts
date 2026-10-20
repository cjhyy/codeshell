import { test, expect } from "bun:test";
import { parseRecentHistory, parseClaudeTranscriptLine } from "../../../packages/coding/src/cc-orchestrator/session-history.ts";

const healthy = JSON.stringify({ type: "user", message: { content: "healthy question" } });
test("R2-04 valid JSON null record aborts otherwise healthy Claude history", () => {
  expect(() => parseRecentHistory(`${healthy}\nnull\n`, 10)).toThrow();
  expect(() => parseClaudeTranscriptLine("null")).toThrow();
});

test("R2-04 malformed JSON is skipped while healthy transcript remains readable", () => {
  expect(parseRecentHistory(`${healthy}\n{ broken\n`, 10).messages).toEqual([{ role: "user", text: "healthy question" }]);
  expect(parseClaudeTranscriptLine("{ broken")).toEqual([]);
});
