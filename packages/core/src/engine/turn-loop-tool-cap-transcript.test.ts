import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../session/session-manager.js";
import { hasCompleteContextToolPairs } from "../session/transcript.js";
import { ContextManager } from "../context/manager.js";
import { ModelFacade } from "./model-facade.js";
import { TurnLoop, type TurnLoopDeps } from "./turn-loop.js";
import type { LLMResponse, Message, ToolCall, ToolResult } from "../types.js";

/**
 * The model facade persists every tool_use of a response before TurnLoop caps
 * the batch at maxToolCallsPerTurn. The dropped calls must still be closed in
 * the durable transcript, otherwise replay and full fork see pending calls.
 */
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

async function runCapped(callCount: number, cap: number) {
  const root = mkdtempSync(join(tmpdir(), "turn-cap-transcript-"));
  roots.push(root);
  const manager = new SessionManager(join(root, "sessions"));
  const source = manager.create(root, "test-model", "test-provider", "source");
  source.transcript.appendMessage("user", "Run the batch.");
  const calls: ToolCall[] = Array.from({ length: callCount }, (_, i) => ({
    id: `call-${i}`,
    toolName: `Tool${i}`,
    args: {},
  }));
  const responses: LLMResponse[] = [
    { text: "", toolCalls: calls, stopReason: "tool_use", usage },
    { text: "done", toolCalls: [], stopReason: "stop", usage },
  ];
  const client = {
    provider: "test-provider",
    model: "test-model",
    async createMessage(_options: { messages: Message[] }) {
      const next = responses.shift();
      if (!next) throw new Error("unexpected extra model call");
      return next;
    },
    getUsage: () => ({
      records: [],
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      requestCount: 0,
    }),
  };
  const executed: string[] = [];
  const deps = {
    model: new ModelFacade(client as never, source.transcript),
    toolExecutor: {
      setLogger() {},
      getInvestigationGuard: () => undefined,
      getTaskGuard: () => undefined,
      isConcurrencySafe: () => false,
      async executeSingle(call: ToolCall): Promise<ToolResult> {
        executed.push(call.id);
        return { id: call.id, toolName: call.toolName, result: "ok" };
      },
    },
    contextManager: new ContextManager({ maxTokens: 1_000_000 }),
    hooks: {
      async emit() {
        return {};
      },
    },
    transcript: source.transcript,
    systemPrompt: "test",
    tools: calls.map((call) => ({
      name: call.toolName,
      description: "test tool",
      inputSchema: { type: "object", properties: {} },
    })),
    sessionId: "source",
    ctxOverheadStore: { get: () => 0, set: () => {} },
  } as unknown as TurnLoopDeps;
  const result = await new TurnLoop(deps, { maxTurns: 5, maxToolCallsPerTurn: cap }).run(
    source.transcript.toMessages(),
  );
  return { manager, source, result, executed };
}

describe("TurnLoop per-turn tool cap — durable transcript", () => {
  it("closes dropped calls in the transcript so replay and full fork stay valid", async () => {
    const { manager, source, result, executed } = await runCapped(4, 3);
    expect(result.reason).toBe("completed");
    expect(executed).toEqual(["call-0", "call-1", "call-2"]);

    const replay = source.transcript.toMessages();
    expect(hasCompleteContextToolPairs(replay)).toBe(true);
    const dropped = replay
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((b) => b.type === "tool_result" && b.tool_use_id === "call-3");
    expect(String(dropped?.content)).toContain("not executed");

    const child = manager.fork("source", { targetSessionId: "child" });
    expect(hasCompleteContextToolPairs(child.bundle.transcript.toMessages())).toBe(true);
  });
});
