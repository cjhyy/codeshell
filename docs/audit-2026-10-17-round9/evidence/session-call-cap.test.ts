import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../../packages/core/src/session/session-manager.js";
import { hasCompleteContextToolPairs } from "../../../packages/core/src/session/transcript.js";
import { ModelFacade } from "../../../packages/core/src/engine/model-facade.js";
import { TurnLoop, type TurnLoopDeps } from "../../../packages/core/src/engine/turn-loop.js";
import { ContextManager } from "../../../packages/core/src/context/manager.js";
import type { LLMResponse, Message, ToolCall, ToolResult } from "../../../packages/core/src/types.js";

// No provider implementation or executable tool is used. The fake client only
// returns completed response objects; the actual Facade, TurnLoop, queue,
// context manager, transcript and SessionManager execute their production code.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function run(callCount: number) {
  const root = mkdtempSync(join(tmpdir(), "audit-r9-cap-"));
  roots.push(root);
  const manager = new SessionManager(join(root, "sessions"));
  const source = manager.create(root, "audit-model", "audit-provider", "source");
  source.transcript.appendMessage("user", "Complete the owned example.");
  const sent: Message[][] = [];
  const executed: string[] = [];
  const calls: ToolCall[] = Array.from({ length: callCount }, (_, i) => ({ id: `call-${i}`, toolName: `AuditTool${i}`, args: {} }));
  const responses: LLMResponse[] = [
    { text: "", toolCalls: calls, stopReason: "tool_use", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
    { text: "done", toolCalls: [], stopReason: "stop", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
  ];
  const client = {
    provider: "audit-provider", model: "audit-model",
    async createMessage(options: { messages: Message[] }) {
      sent.push(structuredClone(options.messages));
      if (!responses.length) throw new Error("Unexpected extra fake-client call");
      return responses.shift()!;
    },
    getUsage: () => ({ records: [], totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0, requestCount: 0 }),
  };
  const model = new ModelFacade(client as never, source.transcript);
  const deps = {
    model,
    toolExecutor: {
      setLogger() {}, getInvestigationGuard: () => undefined, getTaskGuard: () => undefined,
      isConcurrencySafe: () => false,
      async executeSingle(call: ToolCall): Promise<ToolResult> {
        executed.push(call.id);
        return { id: call.id, toolName: call.toolName, result: "owned fake result" };
      },
    },
    contextManager: new ContextManager({ maxTokens: 1_000_000 }),
    hooks: { async emit() { return {}; } },
    transcript: source.transcript,
    systemPrompt: "Owned offline fixture.",
    tools: calls.map(call => ({ name: call.toolName, description: "Owned fake tool", inputSchema: { type: "object", properties: {} } })),
    sessionId: "source", ctxOverheadStore: { get: () => 0, set: () => {} },
  } as unknown as TurnLoopDeps;
  const result = await new TurnLoop(deps, { maxTurns: 5, maxToolCallsPerTurn: 25 }).run(source.transcript.toMessages());
  return { root, manager, source, result, sent, executed };
}

describe("round9 capped tools and durable transcript", () => {
  test("one call above the production Engine default completes live but leaves a full fork uncopyable", async () => {
    const { manager, source, result, sent, executed } = await run(26);
    expect(result.reason).toBe("completed");
    expect(result.text).toBe("done");
    expect(executed).toHaveLength(25);
    expect(sent).toHaveLength(2);
    expect(hasCompleteContextToolPairs(sent[1]!)).toBe(true);
    expect(hasCompleteContextToolPairs(result.messages)).toBe(true);
    expect(JSON.stringify(sent[1])).toContain("Only the first 25 of your 26 tool calls");
    expect(source.transcript.getEvents("tool_use")).toHaveLength(25);
    expect(source.transcript.getEvents("tool_result")).toHaveLength(25);
    const replay = source.transcript.toMessages();
    const uses = replay.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(b => b.type === "tool_use");
    expect(uses).toHaveLength(26);
    expect(hasCompleteContextToolPairs(replay)).toBe(false);
    const bytes = readFileSync(source.transcript.getFilePath(), "utf8");
    expect(() => manager.fork("source", { targetSessionId: "blocked-child" })).toThrow(/pending tool results/);
    expect(readFileSync(source.transcript.getFilePath(), "utf8")).toBe(bytes);
  });

  test("within the same production Engine default, the complete full fork succeeds", async () => {
    const { manager, source, result, executed } = await run(25);
    expect(result.reason).toBe("completed");
    expect(executed).toHaveLength(25);
    expect(hasCompleteContextToolPairs(source.transcript.toMessages())).toBe(true);
    const child = manager.fork("source", { targetSessionId: "normal-child" });
    expect(child.bundle.transcript.toMessages()).toEqual(source.transcript.toMessages());
    expect(hasCompleteContextToolPairs(child.bundle.transcript.toMessages())).toBe(true);
  });
});
