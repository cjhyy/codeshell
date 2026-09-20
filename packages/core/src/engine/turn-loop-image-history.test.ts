import { describe, expect, it } from "bun:test";
import { TurnLoop, type TurnLoopConfig, type TurnLoopDeps } from "./turn-loop.js";
import type { ContentBlock, LLMResponse, Message, ToolCall, ToolResult } from "../types.js";
import { IMAGE_HISTORY_PLACEHOLDER_SUFFIX } from "../context/compaction.js";

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
