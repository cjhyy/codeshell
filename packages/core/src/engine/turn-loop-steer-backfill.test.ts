import { describe, expect, it } from "bun:test";
import { TurnLoop, type TurnLoopConfig, type TurnLoopDeps } from "./turn-loop.js";
import type { ContentBlock, LLMResponse, Message, ToolCall, ToolResult } from "../types.js";
import type { InputAttachmentMeta } from "../protocol/types.js";
import type { SteerItem } from "./steer-queue.js";

function makeDeps(
  responses: LLMResponse[],
  steer: SteerItem | SteerItem[],
): {
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

const toolUse = (): LLMResponse => ({
  text: "",
  toolCalls: [{ id: "tool-1", toolName: "Read", args: {} }],
  stopReason: "tool_use",
  usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
});

describe("TurnLoop steer finalize backfill", () => {
  it("consumes steer queued during a tool batch before the next model call without splitting tool adjacency", async () => {
    const events: unknown[] = [];
    let responseIdx = 0;
    let steerQueuedAfterTool = false;
    let steerServed = false;
    const modelMessages: Message[][] = [];
    const appended: Array<{ role: string; content: unknown; opts: unknown }> = [];
    const consumeSources: string[] = [];
    const responses = [toolUse(), stop("done")];
    const call = async (_sys: string, messages: Message[]): Promise<LLMResponse> => {
      modelMessages.push(messages.map((m) => ({ ...m })));
      return responses[Math.min(responseIdx++, responses.length - 1)]!;
    };
    const deps: TurnLoopDeps = {
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
          steerQueuedAfterTool = true;
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
        if (source === "normal_step" && steerQueuedAfterTool && !steerServed) {
          steerServed = true;
          return [
            {
              id: "steer-after-tool",
              text: "check the adjacent result first",
              clientMessageId: "client-after-tool",
            },
          ];
        }
        return [];
      },
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
    expect(consumeSources.slice(0, 2)).toEqual(["normal_step", "normal_step"]);

    const turn2Messages = modelMessages[1]!;
    const toolUseIdx = turn2Messages.findIndex(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.content) &&
        m.content.some((b) => b.type === "tool_use" && b.id === "tool-1"),
    );
    const toolResultIdx = turn2Messages.findIndex(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        m.content.some((b) => b.type === "tool_result" && b.tool_use_id === "tool-1"),
    );
    const steerIdx = turn2Messages.findIndex(
      (m) => m.role === "user" && m.content === "check the adjacent result first",
    );

    expect(toolUseIdx).toBeGreaterThan(-1);
    expect(toolResultIdx).toBe(toolUseIdx + 1);
    expect(steerIdx).toBe(toolResultIdx + 1);
    expect(appended).toContainEqual({
      role: "user",
      content: "check the adjacent result first",
      opts: { steerId: "steer-after-tool", clientMessageId: "client-after-tool" },
    });
    expect(events).toContainEqual({
      type: "steer_injected",
      text: "check the adjacent result first",
      id: "steer-after-tool",
    });
  });

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
    expect(modelMessages[1]!.some((m) => m.role === "user" && m.content === "one more thing")).toBe(
      true,
    );
    expect(consumeSources).toContain("finalize_backfill");
    expect(appended).toContainEqual({
      role: "user",
      content: "one more thing",
      opts: { steerId: "steer-1", clientMessageId: "client-1" },
    });
    expect(events).toContainEqual({
      type: "steer_injected",
      text: "one more thing",
      id: "steer-1",
    });
  });

  it("builds steer attachments into structured user message content before backfill continuation", async () => {
    const events: unknown[] = [];
    const attachment: InputAttachmentMeta = {
      id: "att-1",
      sessionId: "s1",
      kind: "image",
      origin: "paste",
      path: ".code-shell/attachments/s1/shot.png",
      absPath: "/tmp/work/.code-shell/attachments/s1/shot.png",
      relPath: ".code-shell/attachments/s1/shot.png",
      mime: "image/png",
      size: 12,
      sha256: "0".repeat(64),
      originalName: "shot.png",
      createdAt: 1,
    };
    const imageContent: ContentBlock[] = [
      { type: "text", text: "inspect this screenshot" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "iVBORw0KGgo=",
        },
      },
    ];
    const { deps, modelMessages, appended } = makeDeps([stop("done"), stop("continued")], {
      id: "steer-image",
      text: "inspect this screenshot",
      clientMessageId: "client-image",
      attachments: [attachment],
    });
    const built: SteerItem[] = [];
    deps.buildSteerUserMessageContent = async (item) => {
      built.push(item);
      return imageContent;
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
    expect(built).toEqual([
      {
        id: "steer-image",
        text: "inspect this screenshot",
        clientMessageId: "client-image",
        attachments: [attachment],
      },
    ]);
    const injected = modelMessages[1]!.find(
      (message) =>
        message.role === "user" &&
        Array.isArray(message.content) &&
        message.content.some((block) => block.type === "image"),
    );
    expect(injected?.content).toEqual(imageContent);
    expect(appended).toContainEqual({
      role: "user",
      content: imageContent,
      opts: { steerId: "steer-image", clientMessageId: "client-image" },
    });
    expect(events).toContainEqual({
      type: "steer_injected",
      text: "inspect this screenshot",
      id: "steer-image",
    });
  });

  it("counts the finalize backfill continuation against maxTurns", async () => {
    const events: unknown[] = [];
    const { deps, modelMessages } = makeDeps([stop("done"), stop("limit summary")], {
      id: "steer-1",
      text: "one more thing",
      clientMessageId: "client-1",
    });
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
    expect(modelMessages[1]!.some((m) => m.role === "user" && m.content === "one more thing")).toBe(
      true,
    );
    expect(
      events.filter(
        (e) =>
          typeof e === "object" && e !== null && (e as { type?: string }).type === "steer_injected",
      ),
    ).toHaveLength(1);
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
    expect(modelMessages[1]!.some((m) => m.role === "user" && m.content === "first steer")).toBe(
      true,
    );
    expect(
      modelMessages[1]!.some((m) => m.role === "user" && m.content === "duplicate steer"),
    ).toBe(false);
    expect(appended).toEqual([
      {
        role: "user",
        content: "first steer",
        opts: { steerId: "steer-1", clientMessageId: "client-dup" },
      },
    ]);
    expect(
      events.filter(
        (e) =>
          typeof e === "object" && e !== null && (e as { type?: string }).type === "steer_injected",
      ),
    ).toEqual([{ type: "steer_injected", text: "first steer", id: "steer-1" }]);
  });
});
