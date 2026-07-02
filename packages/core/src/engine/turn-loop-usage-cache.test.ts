import { describe, it, expect } from "bun:test";
import { TurnLoop, type TurnLoopDeps, type TurnLoopConfig } from "./turn-loop.js";
import type { LLMResponse, Message, StreamEvent } from "../types.js";

/**
 * Prompt-cache visibility in the UI: the usage_update event that feeds the
 * context ring must carry the provider's cache token counts (cacheReadTokens /
 * cacheCreationTokens) so the ring's hover tooltip can show a hit rate. Before
 * this, usage_update only carried promptTokens and the cache numbers — already
 * parsed by the providers and logged — never reached the renderer.
 * See docs/todo/prompt-cache-optimization.md.
 */
function makeDeps(responses: LLMResponse[]): {
  deps: TurnLoopDeps;
} {
  let i = 0;
  const call = async (_sys: string, messages: Message[]): Promise<LLMResponse> => {
    void messages;
    const r = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return r;
  };
  const model = {
    call,
    callWithoutStreaming: call,
    getUsage: () => ({
      records: [],
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      requestCount: 0,
    }),
    getOutputTokens: () => 0,
    summarize: undefined,
  } as unknown as TurnLoopDeps["model"];

  const contextManager = {
    async manageAsync(m: Message[]) {
      return m;
    },
    manage(m: Message[]) {
      return m;
    },
    recordActualUsage() {},
    shouldReactiveCompact() {
      return false;
    },
  } as unknown as TurnLoopDeps["contextManager"];

  const hooks = {
    async emit() {
      return {};
    },
  } as unknown as TurnLoopDeps["hooks"];

  const transcript = {
    appendToolUse() {},
    appendToolResult() {},
    appendTurnBoundary() {},
    appendMessage() {},
  } as unknown as TurnLoopDeps["transcript"];

  const toolExecutor = {
    setLogger() {},
    getInvestigationGuard() {
      return undefined;
    },
    getTaskGuard() {
      return undefined;
    },
    isConcurrencySafe() {
      return false;
    },
  } as unknown as TurnLoopDeps["toolExecutor"];

  const deps: TurnLoopDeps = {
    model,
    toolExecutor,
    contextManager,
    hooks,
    transcript,
    systemPrompt: "sys",
    tools: [],
    sessionId: "test",
    ctxOverheadStore: { get: () => 0, set: () => {} },
  };

  return { deps };
}

const respWithCache = (): LLMResponse => ({
  text: "done",
  toolCalls: [],
  stopReason: "stop",
  usage: {
    promptTokens: 1000,
    completionTokens: 20,
    totalTokens: 1020,
    cacheReadTokens: 800,
    cacheCreationTokens: 50,
  },
});

const respNoCache = (): LLMResponse => ({
  text: "done",
  toolCalls: [],
  stopReason: "stop",
  usage: { promptTokens: 1000, completionTokens: 20, totalTokens: 1020 },
});

async function runCapturingEvents(responses: LLMResponse[]): Promise<StreamEvent[]> {
  const { deps } = makeDeps(responses);
  const events: StreamEvent[] = [];
  const config: TurnLoopConfig = {
    maxTurns: 5,
    maxToolCallsPerTurn: 10,
    onStream: (e) => {
      events.push(e);
    },
  };
  const loop = new TurnLoop(deps, config);
  await loop.run([{ role: "user", content: "hi" }]);
  return events;
}

describe("TurnLoop usage_update carries cache tokens", () => {
  it("forwards cacheReadTokens and cacheCreationTokens from the response usage", async () => {
    const events = await runCapturingEvents([respWithCache()]);
    const usageUpdate = events.find((e) => e.type === "usage_update") as
      | Extract<StreamEvent, { type: "usage_update" }>
      | undefined;
    expect(usageUpdate).toBeDefined();
    expect(usageUpdate!.promptTokens).toBe(1000);
    expect(usageUpdate!.cacheReadTokens).toBe(800);
    expect(usageUpdate!.cacheCreationTokens).toBe(50);
  });

  it("omits cache fields when the provider reported none", async () => {
    const events = await runCapturingEvents([respNoCache()]);
    const usageUpdate = events.find((e) => e.type === "usage_update") as
      | Extract<StreamEvent, { type: "usage_update" }>
      | undefined;
    expect(usageUpdate).toBeDefined();
    expect(usageUpdate!.promptTokens).toBe(1000);
    expect(usageUpdate!.cacheReadTokens).toBeUndefined();
    expect(usageUpdate!.cacheCreationTokens).toBeUndefined();
  });
});
