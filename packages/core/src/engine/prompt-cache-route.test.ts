import { describe, expect, test } from "bun:test";
import type { Message, LLMResponse } from "../types.js";
import type { PromptCacheStrategy } from "../llm/prompt-cache.js";
import { PromptCacheRouteMemory } from "./prompt-cache-route.js";
import { TurnLoop, type TurnLoopDeps } from "./turn-loop.js";

const HYBRID = { provider: "openai", model: "gpt-5.6-sol" };
const MINUTE = 60_000;

describe("PromptCacheRouteMemory", () => {
  test("a reported implicit fallback sticks for the route: no tail placement, implicit TTL", () => {
    const routes = new PromptCacheRouteMemory();
    expect(routes.usesExplicitBreakpoints(HYBRID)).toBe(true);
    expect(routes.ttlMs(HYBRID)).toBe(30 * MINUTE);

    expect(routes.observe(HYBRID, "openai-hybrid")).toBe(false);
    expect(routes.observe(HYBRID, undefined)).toBe(false);
    expect(routes.observe(HYBRID, "openai-implicit")).toBe(true);
    // Reported once; later observations change nothing.
    expect(routes.observe(HYBRID, "openai-implicit")).toBe(false);

    expect(routes.usesExplicitBreakpoints(HYBRID)).toBe(false);
    expect(routes.ttlMs(HYBRID)).toBe(5 * MINUTE);
    expect(routes.policy(HYBRID).strategy).toBe("openai-implicit");
    // Tool discovery does not depend on the cache fields.
    expect(routes.policy(HYBRID).toolDiscovery).toBe(
      new PromptCacheRouteMemory().policy(HYBRID).toolDiscovery,
    );
  });

  test("other routes and implicit-only routes are unaffected", () => {
    const routes = new PromptCacheRouteMemory();
    routes.observe(HYBRID, "openai-implicit");
    const otherEndpoint = { ...HYBRID, baseUrl: "https://gateway.example/v1" };
    expect(routes.usesExplicitBreakpoints(otherEndpoint)).toBe(true);
    // A route configured implicit never records a "fallback".
    const implicitRoute = { provider: "openai", model: "gpt-5.5" };
    expect(routes.observe(implicitRoute, "openai-implicit")).toBe(false);
  });
});

function done(): LLMResponse {
  return {
    text: "",
    toolCalls: [{ id: "c1", toolName: "Read", args: {} }],
    stopReason: "tool_use",
    usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
  };
}

describe("TurnLoop follows the client's effective cache strategy", () => {
  test("after a fallback the volatile message stops moving to the request tail", async () => {
    let strategy: PromptCacheStrategy = "openai-hybrid";
    const requests: Message[][] = [];
    let calls = 0;
    const call = async (_system: string, messages: Message[]): Promise<LLMResponse> => {
      requests.push([...messages]);
      calls++;
      // The endpoint rejected explicit fields during the first request.
      strategy = "openai-implicit";
      return calls >= 3 ? { ...done(), toolCalls: [], stopReason: "stop" } : done();
    };
    const fallbacks: number[] = [];
    const volatile: Message = { role: "user", content: "VOLATILE_RUNTIME_CONTEXT" };
    const deps = {
      model: {
        call,
        callWithoutStreaming: call,
        getOutputTokens: () => 0,
        getEffectivePromptCacheStrategy: () => strategy,
      },
      toolExecutor: {
        setLogger() {},
        getInvestigationGuard: () => undefined,
        getTaskGuard: () => undefined,
        isConcurrencySafe: () => false,
        executeSingle: async (c: { id: string; toolName: string }) => ({
          id: c.id,
          toolName: c.toolName,
          result: "ok",
        }),
      },
      contextManager: {
        manageAsync: async (m: Message[]) => m,
        manage: (m: Message[]) => m,
        recordActualUsage: () => undefined,
        shouldReactiveCompact: () => false,
      },
      hooks: { emit: async () => ({}) },
      transcript: {
        appendToolUse() {},
        appendToolResult() {},
        appendTurnBoundary() {},
        appendTurnStopped() {},
        appendMessage() {},
      },
      systemPrompt: "sys",
      tools: [],
      sessionId: "route-test",
      ctxOverheadStore: { get: () => 0, set: () => {} },
    } as unknown as TurnLoopDeps;

    const task: Message = { role: "user", content: "task" };
    const result = await new TurnLoop(deps, {
      maxTurns: 5,
      maxToolCallsPerTurn: 5,
      volatileContextMessages: [volatile],
      volatileContextAtTail: true,
      onPromptCacheFallback: () => fallbacks.push(calls),
    }).run([volatile, task]);

    expect(result.reason).toBe("completed");
    expect(requests.length).toBe(3);
    // First request: explicit route, the volatile message rides the tail.
    expect(requests[0]!.at(-1)).toBe(volatile);
    // Afterwards it stays where the first request put it.
    for (const request of requests.slice(1)) {
      expect(request.indexOf(volatile)).toBe(1);
      expect(request.slice(0, 2)).toEqual(requests[0]!);
    }
    expect(fallbacks).toEqual([1]);
  });
});
