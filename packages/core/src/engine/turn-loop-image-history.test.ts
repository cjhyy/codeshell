import { describe, expect, it } from "bun:test";
import { TurnLoop, type TurnLoopConfig, type TurnLoopDeps } from "./turn-loop.js";
import type { ContentBlock, LLMResponse, Message, ToolCall, ToolResult } from "../types.js";
import { IMAGE_HISTORY_PLACEHOLDER_SUFFIX } from "../context/compaction.js";
import { ContextManager, type ManageOptions } from "../context/manager.js";
import { resetPromptCacheWarmthForTests } from "../context/rewrite-gate.js";

const userImageBase64 = "U".repeat(32_000);
const toolImageBase64 = "T".repeat(32_000);
const placeholder = `[image #1${IMAGE_HISTORY_PLACEHOLDER_SUFFIX}`;

function imageBlock(data: string): ContentBlock {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/png", data },
  };
}

function doneResp(text = "done"): LLMResponse {
  return {
    text,
    toolCalls: [],
    stopReason: "stop",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  };
}

function toolResp(toolName = "Read"): LLMResponse {
  return {
    text: "",
    toolCalls: [{ id: "call_1", toolName, args: {} }],
    stopReason: "tool_use",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  };
}

function makeDeps(
  responses: LLMResponse[],
  execute: (call: ToolCall) => Promise<ToolResult> = async (call) => ({
    id: call.id,
    toolName: call.toolName,
    result: "ok",
  }),
  realContextManager?: ContextManager,
): {
  deps: TurnLoopDeps;
  callArgs: Message[][];
  toolResultAppends: Array<{
    toolCallId: string;
    toolName: string;
    result?: string;
    error?: string;
    contentBlocks?: ContentBlock[];
  }>;
} {
  let i = 0;
  const callArgs: Message[][] = [];
  const toolResultAppends: Array<{
    toolCallId: string;
    toolName: string;
    result?: string;
    error?: string;
    contentBlocks?: ContentBlock[];
  }> = [];
  const call = async (_sys: string, messages: Message[]): Promise<LLMResponse> => {
    callArgs.push(JSON.parse(JSON.stringify(messages)) as Message[]);
    const response = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return response;
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

  // A cache that is always cold: every pending rewrite batch is adopted.
  const adopt = (m: Message[], options?: ManageOptions): Message[] => {
    const batch = options?.externalRewrite?.(m);
    if (!batch || batch.messages === m) return m;
    batch.commit();
    return batch.messages;
  };
  const contextManager = (realContextManager ?? {
    async manageAsync(m: Message[], _signal?: AbortSignal, options?: ManageOptions) {
      return adopt(m, options);
    },
    manage(m: Message[], options?: ManageOptions) {
      return adopt(m, options);
    },
    recordActualUsage() {},
    shouldReactiveCompact() {
      return false;
    },
  }) as unknown as TurnLoopDeps["contextManager"];

  const hooks = {
    async emit() {
      return {};
    },
  } as unknown as TurnLoopDeps["hooks"];

  const transcript = {
    appendToolUse() {},
    appendToolResult(
      toolCallId: string,
      toolName: string,
      result?: string,
      error?: string,
      contentBlocks?: ContentBlock[],
    ) {
      toolResultAppends.push({ toolCallId, toolName, result, error, contentBlocks });
    },
    appendTurnBoundary() {},
    appendTurnStopped() {},
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
    executeSingle: execute,
  } as unknown as TurnLoopDeps["toolExecutor"];

  return {
    deps: {
      model,
      toolExecutor,
      contextManager,
      hooks,
      transcript,
      systemPrompt: "sys",
      tools: [],
      sessionId: "test",
      ctxOverheadStore: { get: () => 0, set: () => {} },
    },
    callArgs,
    toolResultAppends,
  };
}

describe("TurnLoop image-history evidence window", () => {
  it("counts each successful length continuation toward the image retention window", async () => {
    const firstUserMessage: Message = {
      role: "user",
      content: [{ type: "text", text: "verify this screenshot" }, imageBlock(userImageBase64)],
    };
    const truncated: LLMResponse = { ...doneResp("partial evidence"), stopReason: "length" };
    const { deps, callArgs } = makeDeps([
      truncated,
      truncated,
      toolResp(),
      toolResp(),
      toolResp(),
      toolResp(),
      doneResp(),
    ]);

    const result = await new TurnLoop(deps, {
      maxTurns: 10,
      maxToolCallsPerTurn: 10,
      freshImageMessages: [firstUserMessage],
    }).run([firstUserMessage]);

    expect(result.reason).toBe("completed");
    expect(callArgs).toHaveLength(7);
    for (const request of callArgs.slice(0, 6)) {
      expect(JSON.stringify(request)).toContain(userImageBase64);
    }
    expect(JSON.stringify(callArgs[6])).not.toContain(userImageBase64);
    expect(JSON.stringify(callArgs[6])).toContain(placeholder);
  });

  it("keeps a user image available for six requests before replacing its pixels", async () => {
    const firstUserMessage: Message = {
      role: "user",
      content: [{ type: "text", text: "inspect this" }, imageBlock(userImageBase64)],
    };
    const { deps, callArgs } = makeDeps([
      ...Array.from({ length: 6 }, () => toolResp()),
      doneResp(),
    ]);
    const config: TurnLoopConfig = {
      maxTurns: 10,
      maxToolCallsPerTurn: 10,
      freshImageMessages: [firstUserMessage],
    };

    const loop = new TurnLoop(deps, config);
    const result = await loop.run([firstUserMessage]);

    expect(result.reason).toBe("completed");
    expect(JSON.stringify(callArgs[0])).toContain(userImageBase64);
    expect(JSON.stringify(callArgs[1])).toContain(userImageBase64);
    expect(JSON.stringify(callArgs[5])).toContain(userImageBase64);
    expect(JSON.stringify(callArgs[6])).not.toContain(userImageBase64);
    expect(JSON.stringify(callArgs[6])).toContain(placeholder);
    expect(JSON.stringify(result.messages)).not.toContain(userImageBase64);
  });

  it("defers an expired image while the cache is warm and the saving is small", async () => {
    resetPromptCacheWarmthForTests();
    const clock = { now: 1_000_000 };
    const contextManager = new ContextManager({ maxTokens: 200_000, now: () => clock.now });
    const firstUserMessage: Message = {
      role: "user",
      content: [{ type: "text", text: "inspect this" }, imageBlock(userImageBase64)],
    };
    const { deps, callArgs } = makeDeps(
      [...Array.from({ length: 7 }, () => toolResp()), doneResp()],
      undefined,
      contextManager,
    );
    const result = await new TurnLoop(deps, {
      maxTurns: 10,
      maxToolCallsPerTurn: 10,
      freshImageMessages: [firstUserMessage],
    }).run([firstUserMessage]);

    expect(result.reason).toBe("completed");
    expect(callArgs).toHaveLength(8);
    // Past the six-response window, but replacing it would break the cached prefix.
    for (const request of callArgs) expect(JSON.stringify(request)).toContain(userImageBase64);
    expect(contextManager.getPendingRewriteBoundaryMessage()).toBe(firstUserMessage);
  });

  it("applies the deferred image batch once the cache has gone cold", async () => {
    resetPromptCacheWarmthForTests();
    const clock = { now: 1_000_000 };
    const contextManager = new ContextManager({ maxTokens: 200_000, now: () => clock.now });
    const firstUserMessage: Message = {
      role: "user",
      content: [{ type: "text", text: "inspect this" }, imageBlock(userImageBase64)],
    };
    const { deps, callArgs } = makeDeps(
      [...Array.from({ length: 7 }, () => toolResp()), doneResp()],
      async (call) => {
        // The seventh tool call sits idle past the prompt-cache TTL.
        if (callArgs.length === 7) clock.now += 31 * 60_000;
        return { id: call.id, toolName: call.toolName, result: "ok" };
      },
      contextManager,
    );
    const result = await new TurnLoop(deps, {
      maxTurns: 10,
      maxToolCallsPerTurn: 10,
      freshImageMessages: [firstUserMessage],
    }).run([firstUserMessage]);

    expect(result.reason).toBe("completed");
    expect(JSON.stringify(callArgs[6])).toContain(userImageBase64);
    expect(JSON.stringify(callArgs[7])).not.toContain(userImageBase64);
    expect(JSON.stringify(callArgs[7])).toContain(placeholder);
  });

  it("replaces images over the hard count cap immediately, even while warm", async () => {
    resetPromptCacheWarmthForTests();
    const contextManager = new ContextManager({ maxTokens: 200_000 });
    const images = Array.from({ length: 5 }, (_, i) => imageBlock(`${i}`.repeat(1_000)));
    const firstUserMessage: Message = {
      role: "user",
      content: [{ type: "text", text: "compare these" }, ...images],
    };
    const { deps, callArgs } = makeDeps([toolResp(), doneResp()], undefined, contextManager);
    await new TurnLoop(deps, {
      maxTurns: 5,
      maxToolCallsPerTurn: 10,
      freshImageMessages: [firstUserMessage],
    }).run([firstUserMessage]);

    // Fresh images always get their first request; then only four may remain.
    expect(JSON.stringify(callArgs[0])).toContain("0".repeat(1_000));
    expect(JSON.stringify(callArgs[1])).not.toContain("0".repeat(1_000));
    expect(JSON.stringify(callArgs[1])).toContain("4".repeat(1_000));
  });

  it("keeps tool-result evidence across unrelated tool calls and preserves transcript bytes", async () => {
    const initial: Message = { role: "user", content: "please view the image" };
    const { deps, callArgs, toolResultAppends } = makeDeps(
      [toolResp("view_image"), toolResp("Read"), doneResp()],
      async (call) => ({
        id: call.id,
        toolName: call.toolName,
        result: "(image)",
        ...(call.toolName === "view_image" ? { contentBlocks: [imageBlock(toolImageBase64)] } : {}),
      }),
    );
    const config: TurnLoopConfig = { maxTurns: 5, maxToolCallsPerTurn: 10 };

    const loop = new TurnLoop(deps, config);
    const result = await loop.run([initial]);

    expect(result.reason).toBe("completed");
    expect(JSON.stringify(callArgs[0])).not.toContain(toolImageBase64);
    expect(JSON.stringify(callArgs[1])).toContain(toolImageBase64);
    expect(JSON.stringify(callArgs[2])).toContain(toolImageBase64);
    expect(JSON.stringify(result.messages)).toContain(toolImageBase64);
    expect(toolResultAppends[0]?.contentBlocks?.[0]?.source?.data).toBe(toolImageBase64);
  });
});
