import { describe, expect, test } from "bun:test";
import { TurnLoop, type TurnLoopDeps } from "./turn-loop.js";
import type { LLMResponse, ToolCall, ToolDefinition } from "../types.js";

describe("TurnLoop deferred model snapshots", () => {
  test("fallback and continuation retain snapshots; revocation preserves sensitive Goal metadata", async () => {
    const search: ToolDefinition = { name: "ToolSearch", description: "discover", inputSchema: {} };
    const secret: ToolDefinition = {
      name: "PrivateRead",
      description: "sensitive fixture",
      inputSchema: {},
      sensitiveResult: true,
    };
    let active = [search];
    let eligible = [search];
    let snapshots = 0,
      primaryCalls = 0;
    const captured: Array<{ kind: string; names: string[] }> = [];
    const retainedResults: unknown[] = [];
    const response = (toolName?: string, stopReason = "tool_use"): LLMResponse => ({
      text: toolName ? "" : "done",
      stopReason: toolName ? stopReason : "stop",
      toolCalls: toolName ? [{ id: `${toolName}-${primaryCalls}`, toolName, args: {} }] : [],
    });
    const deps = {
      tools: [search],
      getTools: () => {
        snapshots++;
        return structuredClone(active);
      },
      getEligibleTools: () => eligible,
      model: {
        call: async (_system: string, _messages: unknown, tools: ToolDefinition[]) => {
          captured.push({ kind: "primary", names: tools.map((tool) => tool.name) });
          primaryCalls++;
          if (primaryCalls === 1) {
            active = [search, secret];
            eligible = active;
            throw new Error("synthetic streaming failure after eligibility changed");
          }
          if (primaryCalls === 2) {
            active = [search];
            return { text: "partial", stopReason: "length", toolCalls: [] };
          }
          if (primaryCalls === 3) return response("PrivateRead");
          return response();
        },
        callWithoutStreaming: async (
          _system: string,
          _messages: unknown,
          tools: ToolDefinition[],
        ) => {
          captured.push({ kind: "fallback", names: tools.map((tool) => tool.name) });
          return response("ToolSearch");
        },
        getUsage: () => ({
          records: [],
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
          totalTokens: 0,
          requestCount: 0,
        }),
        getOutputTokens: () => 0,
      },
      toolExecutor: {
        setLogger() {},
        getInvestigationGuard() {},
        getTaskGuard() {},
        isConcurrencySafe: () => false,
        executeSingle: async (call: ToolCall) => {
          if (call.toolName === "PrivateRead") eligible = [search];
          return {
            id: call.id,
            toolName: call.toolName,
            result: call.toolName === "PrivateRead" ? "PRIVATE_FIXTURE_DATA" : "selected",
          };
        },
      },
      contextManager: {
        manageAsync: async (messages: unknown) => messages,
        manage: (messages: unknown) => messages,
        recordActualUsage() {},
        shouldReactiveCompact: () => false,
      },
      hooks: { emit: async () => ({}) },
      transcript: {
        appendToolUse() {},
        appendToolResult: (...args: unknown[]) => retainedResults.push(args),
        appendTurnBoundary() {},
        appendMessage() {},
      },
      systemPrompt: "fixture",
      sessionId: "fixture",
      ctxOverheadStore: { get: () => 0, set() {} },
    } as unknown as TurnLoopDeps;
    const result = await new TurnLoop(deps, {
      maxTurns: 8,
      maxToolCallsPerTurn: 10,
      goal: { objective: "fixture" },
    }).run([{ role: "user", content: "go" }]);
    expect(result.reason).toBe("completed");
    expect(snapshots).toBe(3);
    expect(captured).toEqual([
      { kind: "primary", names: ["ToolSearch"] },
      { kind: "fallback", names: ["ToolSearch"] },
      { kind: "primary", names: ["ToolSearch", "PrivateRead"] },
      { kind: "primary", names: ["ToolSearch", "PrivateRead"] },
      { kind: "primary", names: ["ToolSearch"] },
    ]);
    expect(JSON.stringify(retainedResults)).not.toContain("PRIVATE_FIXTURE_DATA");
    expect(JSON.stringify(result.messages)).not.toContain("PRIVATE_FIXTURE_DATA");
  });
});
