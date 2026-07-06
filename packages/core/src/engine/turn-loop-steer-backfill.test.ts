import { describe, expect, it } from "bun:test";
import { TurnLoop, type TurnLoopConfig, type TurnLoopDeps } from "./turn-loop.js";
import type { LLMResponse, Message, ToolCall, ToolResult } from "../types.js";
import type { SteerItem } from "./steer-queue.js";

function makeDeps(responses: LLMResponse[], steer: SteerItem | SteerItem[]): {
  deps: TurnLoopDeps;
  modelMessages: Message[][];
  consumeSources: string[];
  appended: Array<{ role: string; content: unknown; opts: unknown }>;
} {
  let responseIdx = 0;
  let backfillServed = false;
  const modelMessages: Message[][] = [];
  const consumeSources: string[] = [];
  const appended: Array<{ role: string; content: unknown; opts: unknown }> = [];
  const steers = Array.isArray(steer) ? steer : [steer];

  const call = async (_sys: string, messages: Message[]): Promise<LLMResponse> => {
    modelMessages.push(messages.map((m) => ({ ...m })));
    const response = responses[Math.min(responseIdx, responses.length - 1)]!;
    responseIdx++;
    return response;
  };

  return {
    modelMessages,
    consumeSources,
    appended,
    deps: {
      model: {
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
      } as unknown as TurnLoopDeps["model"],
      toolExecutor: {
        setLogger() {},
        getInvestigationGuard: () => undefined,
        getTaskGuard: () => undefined,
        isConcurrencySafe: () => false,
        async executeSingle(c: ToolCall): Promise<ToolResult> {
          return { id: c.id, toolName: c.toolName, result: "ok" };
        },
      } as unknown as TurnLoopDeps["toolExecutor"],
      contextManager: {
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
      } as unknown as TurnLoopDeps["contextManager"],
      hooks: {
        async emit() {
          return {};
        },
      } as unknown as TurnLoopDeps["hooks"],
      transcript: {
        appendToolUse() {},
        appendToolResult() {},
        appendTurnBoundary() {},
        appendMessage(role: string, content: unknown, opts: unknown) {
          appended.push({ role, content, opts });
        },
      } as unknown as TurnLoopDeps["transcript"],
      systemPrompt: "sys",
      tools: [],
      sessionId: "s1",
      ctxOverheadStore: { get: () => 0, set: () => {} },
      consumeSteer: (source = "normal_step") => {
        consumeSources.push(source);
        if (source === "finalize_backfill" && !backfillServed) {
          backfillServed = true;
          return steers;
        }
        return [];
      },
    },
  };
}

const stop = (text: string): LLMResponse => ({
  text,
  toolCalls: [],
  stopReason: "stop",
  usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
});

describe("TurnLoop steer finalize backfill", () => {
  it("consumes a steer queued during normal shutdown before run() returns", async () => {
    const events: unknown[] = [];
    const { deps, modelMessages, consumeSources, appended } = makeDeps(
      [stop("done"), stop("continued")],
      { id: "steer-1", text: "one more thing", clientMessageId: "client-1" },
    );
    const config: TurnLoopConfig = {
      maxTurns: 3,
      maxToolCallsPerTurn: 10,
      onStream: (event) => {
        events.push(event);
      },
    };

    const loop = new TurnLoop(deps, config);
    const result = await loop.run([{ role: "user", content: "go" }]);

    expect(result.reason).toBe("completed");
    expect(result.text).toBe("continued");
    expect(modelMessages).toHaveLength(2);
    expect(modelMessages[1]!.some((m) => m.role === "user" && m.content === "one more thing")).toBe(true);
    expect(consumeSources).toContain("finalize_backfill");
    expect(appended).toContainEqual({
      role: "user",
      content: "one more thing",
      opts: { steerId: "steer-1", clientMessageId: "client-1" },
    });
    expect(events).toContainEqual({ type: "steer_injected", text: "one more thing", id: "steer-1" });
  });

  it("counts the finalize backfill continuation against maxTurns", async () => {
    const events: unknown[] = [];
    const { deps, modelMessages } = makeDeps(
      [stop("done"), stop("limit summary")],
      { id: "steer-1", text: "one more thing", clientMessageId: "client-1" },
    );
    const loop = new TurnLoop(deps, {
      maxTurns: 1,
      maxToolCallsPerTurn: 10,
      onStream: (event) => {
        events.push(event);
      },
    });

    const result = await loop.run([{ role: "user", content: "go" }]);

    expect(result.reason).toBe("max_turns");
    expect(result.text).toBe("limit summary");
    expect(modelMessages).toHaveLength(2);
    expect(modelMessages[1]!.some((m) => m.role === "user" && m.content === "one more thing")).toBe(true);
    expect(events.filter((e) =>
      typeof e === "object" &&
      e !== null &&
      (e as { type?: string }).type === "steer_injected"
    )).toHaveLength(1);
  });

  it("skips duplicate queued steers with the same clientMessageId before model history", async () => {
    const events: unknown[] = [];
    const { deps, modelMessages, appended } = makeDeps(
      [stop("done"), stop("continued")],
      [
        { id: "steer-1", text: "first steer", clientMessageId: "client-dup" },
        { id: "steer-2", text: "duplicate steer", clientMessageId: "client-dup" },
      ],
    );
    const claimed = new Set<string>();
    deps.claimClientMessageId = (clientMessageId) => {
      if (claimed.has(clientMessageId)) return false;
      claimed.add(clientMessageId);
      return true;
    };
    const loop = new TurnLoop(deps, {
      maxTurns: 3,
      maxToolCallsPerTurn: 10,
      onStream: (event) => {
        events.push(event);
      },
    });

    const result = await loop.run([{ role: "user", content: "go" }]);

    expect(result.reason).toBe("completed");
    expect(modelMessages).toHaveLength(2);
    expect(modelMessages[1]!.some((m) => m.role === "user" && m.content === "first steer")).toBe(true);
    expect(modelMessages[1]!.some((m) => m.role === "user" && m.content === "duplicate steer")).toBe(false);
    expect(appended).toEqual([
      {
        role: "user",
        content: "first steer",
        opts: { steerId: "steer-1", clientMessageId: "client-dup" },
      },
    ]);
    expect(events.filter((e) =>
      typeof e === "object" &&
      e !== null &&
      (e as { type?: string }).type === "steer_injected"
    )).toEqual([{ type: "steer_injected", text: "first steer", id: "steer-1" }]);
  });
});
