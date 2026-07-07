import { describe, expect, it } from "bun:test";
import { TurnLoop, type TurnLoopConfig, type TurnLoopDeps } from "./turn-loop.js";
import type { ContentBlock, LLMResponse, Message, ToolCall, ToolResult } from "../types.js";

const userImageBase64 = "U".repeat(32_000);
const toolImageBase64 = "T".repeat(32_000);
const placeholder = "[image #1, 已处理 / already provided earlier]";

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

describe("TurnLoop image-history first consumption", () => {
  it("sends a current user image once, then downgrades it for the later model turn", async () => {
    const firstUserMessage: Message = {
      role: "user",
      content: [{ type: "text", text: "inspect this" }, imageBlock(userImageBase64)],
    };
    const { deps, callArgs } = makeDeps([toolResp(), doneResp()]);
    const config: TurnLoopConfig = {
      maxTurns: 5,
      maxToolCallsPerTurn: 10,
      freshImageMessages: [firstUserMessage],
    };

    const loop = new TurnLoop(deps, config);
    const result = await loop.run([firstUserMessage]);

    expect(result.reason).toBe("completed");
    expect(JSON.stringify(callArgs[0])).toContain(userImageBase64);
    expect(JSON.stringify(callArgs[1])).not.toContain(userImageBase64);
    expect(JSON.stringify(callArgs[1])).toContain(placeholder);
    expect(JSON.stringify(result.messages)).not.toContain(userImageBase64);
  });

  it("preserves a tool-result image for its first model consumption, then downgrades it", async () => {
    const initial: Message = { role: "user", content: "please view the image" };
    const { deps, callArgs, toolResultAppends } = makeDeps(
      [toolResp("view_image"), doneResp()],
      async (call) => ({
        id: call.id,
        toolName: call.toolName,
        result: "(image)",
        contentBlocks: [imageBlock(toolImageBase64)],
      }),
    );
    const config: TurnLoopConfig = { maxTurns: 5, maxToolCallsPerTurn: 10 };

    const loop = new TurnLoop(deps, config);
    const result = await loop.run([initial]);

    expect(result.reason).toBe("completed");
    expect(JSON.stringify(callArgs[0])).not.toContain(toolImageBase64);
    expect(JSON.stringify(callArgs[1])).toContain(toolImageBase64);
    expect(JSON.stringify(result.messages)).not.toContain(toolImageBase64);
    expect(JSON.stringify(result.messages)).toContain(placeholder);
    expect(toolResultAppends[0]?.contentBlocks?.[0]?.source?.data).toBe(toolImageBase64);
  });
});
