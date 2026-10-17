import { describe, expect, test } from "bun:test";
import type { Message, LLMResponse } from "../../../packages/core/src/types.js";
import { estimateTokens, snipCompact } from "../../../packages/core/src/context/compaction.js";
import { ContextManager } from "../../../packages/core/src/context/manager.js";
import { hasCompleteContextToolPairs } from "../../../packages/core/src/session/transcript.js";
import { TurnLoop, type TurnLoopDeps } from "../../../packages/core/src/engine/turn-loop.js";

// Offline evidence: only a fake model and no executable tools. Assertions below
// deliberately describe the current defect, not the desired fixed behavior.
function history(callIndex = 2): Message[] {
  const messages: Message[] = [
    { role: "user", content: "Standing instructions for this owned fixture." },
    { role: "user", content: "Inspect the owned example and continue." },
  ];
  if (callIndex === 1) messages.pop();
  messages.push(
    { role: "assistant", content: [{ type: "tool_use", id: "prefix-read", name: "Read", input: { file_path: "/owned/example.txt" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "prefix-read", content: "PREFIX_RESULT_FACT: the owned example is complete." }] },
  );
  for (let index = 4; index < 24; index++) {
    messages.push({
      role: index % 2 ? "user" : "assistant",
      content: index < 16 ? `old ${index}: ${"owned historical detail ".repeat(1000)}` : `recent ${index}`,
    });
  }
  return messages;
}

describe("round4 snip prefix pair evidence", () => {
  test("default snip orphans a valid call at the prefix boundary; complete-prefix control stays valid", () => {
    const original = history();
    expect(hasCompleteContextToolPairs(original)).toBe(true);
    const out = snipCompact(original);
    expect(out.length).toBeLessThan(original.length);
    expect(JSON.stringify(out)).toContain("prefix-read");
    expect(JSON.stringify(out)).not.toContain("PREFIX_RESULT_FACT");
    expect(hasCompleteContextToolPairs(out)).toBe(false);
    const control = snipCompact(history(1));
    expect(hasCompleteContextToolPairs(control)).toBe(true);
    expect(JSON.stringify(control)).toContain("PREFIX_RESULT_FACT");
  });

  test("real manager and TurnLoop send the orphaned request to both fake model attempts", async () => {
    const original = history();
    const manager = new ContextManager({ maxTokens: estimateTokens(original) / 0.88 });
    let summaryCalls = 0;
    manager.setSummarizeFn(async () => { summaryCalls++; throw new Error("owned summary unavailable"); });
    const sent: Message[][] = [];
    const call = async (_system: string, messages: Message[]): Promise<LLMResponse> => {
      sent.push(structuredClone(messages));
      if (!hasCompleteContextToolPairs(messages)) throw new Error("owned fake provider rejects incomplete tool pairs");
      return { text: "done", toolCalls: [], stopReason: "stop" };
    };
    const deps = {
      model: { call, callWithoutStreaming: call, getOutputTokens: () => 0, getUsage: () => ({ records: [], totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0, requestCount: 0 }) },
      toolExecutor: { setLogger() {}, getInvestigationGuard: () => undefined, getTaskGuard: () => undefined, isConcurrencySafe: () => false },
      contextManager: manager,
      hooks: { async emit() { return {}; } },
      transcript: { appendToolUse() {}, appendToolResult() {}, appendTurnBoundary() {}, appendMessage() {} },
      systemPrompt: "owned fixture system",
      tools: [], sessionId: "round4-owned-snip",
      ctxOverheadStore: { get: () => 0, set: () => {} },
    } as unknown as TurnLoopDeps;
    const loop = new TurnLoop(deps, { maxTurns: 5, maxToolCallsPerTurn: 10 });
    const result = await loop.run(original);
    expect(summaryCalls).toBe(1);
    expect(sent).toHaveLength(2);
    expect(sent.every((messages) => !hasCompleteContextToolPairs(messages))).toBe(true);
    expect(sent.every((messages) => !JSON.stringify(messages).includes("PREFIX_RESULT_FACT"))).toBe(true);
    expect(result.reason).toBe("model_error");
    // The error-exit repair happens after the rejected calls and cannot restore
    // the original successful result. It inserts a cancellation result instead.
    expect(hasCompleteContextToolPairs(result.messages)).toBe(true);
    expect(JSON.stringify(result.messages)).toContain("Tool execution was cancelled");
    expect(JSON.stringify(result.messages)).not.toContain("PREFIX_RESULT_FACT");
  });
});
