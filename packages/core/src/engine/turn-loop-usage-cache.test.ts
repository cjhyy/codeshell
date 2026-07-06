import { describe, it, expect } from "bun:test";
import { TurnLoop, type TurnLoopDeps, type TurnLoopConfig } from "./turn-loop.js";
import type { LLMResponse, Message, StreamEvent, TokenUsage } from "../types.js";

/**
 * Prompt-cache visibility in the UI: the usage_update event that feeds the
 * context ring must carry the provider's cache token counts (cacheReadTokens /
 * cacheCreationTokens) so the ring's hover tooltip can show a hit rate. Before
 * this, usage_update only carried promptTokens and the cache numbers — already
 * parsed by the providers and logged — never reached the renderer.
 * See docs/todo/prompt-cache-optimization.md.
 */
function makeDeps(
  responses: LLMResponse[],
  recordCumulativeUsage?: TurnLoopDeps["recordCumulativeUsage"],
): {
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
    recordCumulativeUsage,
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

async function runCapturingEventsWithCumulative(responses: LLMResponse[]): Promise<StreamEvent[]> {
  let cumulative = {
    cumulativePromptTokens: 0,
    cumulativeCacheReadTokens: 0,
    cumulativeCacheCreationTokens: 0,
  };
  const recordCumulativeUsage = (usage: TokenUsage) => {
    cumulative = {
      cumulativePromptTokens: cumulative.cumulativePromptTokens + usage.promptTokens,
      cumulativeCacheReadTokens:
        cumulative.cumulativeCacheReadTokens + (usage.cacheReadTokens ?? 0),
      cumulativeCacheCreationTokens:
        cumulative.cumulativeCacheCreationTokens + (usage.cacheCreationTokens ?? 0),
    };
    return cumulative;
  };
  const { deps } = makeDeps(responses, recordCumulativeUsage);
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
    expect(usageUpdate!.singleTurnPromptTokens).toBe(1000);
    expect(usageUpdate!.singleTurnCacheReadTokens).toBe(800);
    expect(usageUpdate!.singleTurnCacheCreationTokens).toBe(50);
    expect(usageUpdate!.singleTurnCacheHitRate).toBeCloseTo(0.8, 5);
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
    expect(usageUpdate!.singleTurnCacheHitRate).toBeUndefined();
  });

  it("emits whole-session cumulative fields from the monotonic recorder", async () => {
    const events = await runCapturingEventsWithCumulative([respWithCache()]);
    const usageUpdate = events.find((e) => e.type === "usage_update") as
      | Extract<StreamEvent, { type: "usage_update" }>
      | undefined;
    expect(usageUpdate).toBeDefined();
    expect(usageUpdate!.cumulativePromptTokens).toBe(1000);
    expect(usageUpdate!.cumulativeCacheReadTokens).toBe(800);
    expect(usageUpdate!.cumulativeCacheCreationTokens).toBe(50);
    expect(usageUpdate!.cumulativeCacheHitRate).toBeCloseTo(0.8, 5);
    expect(usageUpdate!.sessionPromptTokens).toBe(1000);
  });

  it("sums continuation responses into the current single-turn metric", async () => {
    const events = await runCapturingEvents([
      {
        ...respWithCache(),
        text: "part one",
        stopReason: "max_tokens",
      },
      {
        text: "part two",
        toolCalls: [],
        stopReason: "stop",
        usage: {
          promptTokens: 200,
          completionTokens: 10,
          totalTokens: 210,
          cacheReadTokens: 100,
          cacheCreationTokens: 0,
        },
      },
    ]);
    const usageUpdates = events.filter(
      (e): e is Extract<StreamEvent, { type: "usage_update" }> =>
        e.type === "usage_update" && e.singleTurnPromptTokens !== undefined,
    );
    expect(usageUpdates.length).toBeGreaterThanOrEqual(2);
    const finalUpdate = usageUpdates[usageUpdates.length - 1]!;
    expect(finalUpdate.singleTurnPromptTokens).toBe(1200);
    expect(finalUpdate.singleTurnCacheReadTokens).toBe(900);
    expect(finalUpdate.singleTurnCacheCreationTokens).toBe(50);
    expect(finalUpdate.singleTurnCacheHitRate).toBeCloseTo(0.75, 5);
  });
});
