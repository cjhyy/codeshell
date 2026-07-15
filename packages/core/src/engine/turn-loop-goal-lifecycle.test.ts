import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions, LLMUsageTracker } from "../llm/types.js";
import type { HookResult } from "../hooks/events.js";
import {
  createGoalStopHook,
  type GoalJudgeLLM,
  type GoalJudgeRuntimeContext,
} from "../hooks/goal-stop-hook.js";
import type { LLMResponse, Message, StreamEvent, ToolCall, ToolResult } from "../types.js";
import { CANCEL_GOAL_TOOL_NAME } from "../tool-system/builtin/cancel-goal.js";
import { COMPLETE_GOAL_TOOL_NAME } from "../tool-system/builtin/complete-goal.js";
import { notificationQueue } from "../tool-system/builtin/agent-notifications.js";
import { backgroundJobRegistry } from "../tool-system/builtin/background-jobs.js";
import { ToolRegistry } from "../tool-system/registry.js";
import type { CapabilityModule } from "../capabilities/index.js";
import { Engine } from "./engine.js";
import { goalConfigFromLifecycle } from "../goal/lifecycle.js";
import { TurnLoop, type TurnLoopConfig, type TurnLoopDeps } from "./turn-loop.js";

const TEST_WORKSPACE_CAPABILITY: CapabilityModule = {
  id: "test-workspace-switch",
  tools: [
    {
      definition: {
        name: "SwitchSessionWorkspace",
        description: "Switch the current test session through the generic workspace bridge.",
        inputSchema: {
          type: "object",
          properties: { target: { type: "string" } },
          required: ["target"],
        },
        source: "builtin",
        permissionDefault: "allow",
        isReadOnly: false,
        isConcurrencySafe: false,
      },
      exposure: { presetTags: [] },
      execute: async (args, ctx) => {
        const target = typeof args.target === "string" ? args.target : "";
        if (!target) return "Error: target is required";
        if (!ctx?.workspace) return "Error: workspace bridge unavailable";
        const workspace = await ctx.workspace.switch(target);
        ctx.setSessionWorkspace?.(workspace);
        return `Switched session workspace to ${workspace.root}`;
      },
    },
  ],
  adjustToolSelection: (names) => {
    names.add("SwitchSessionWorkspace");
  },
};

function stopResponse(text = "not done yet"): LLMResponse {
  return {
    text,
    toolCalls: [],
    stopReason: "stop",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  };
}

function toolResponse(toolCall: ToolCall): LLMResponse {
  return {
    text: "",
    toolCalls: [toolCall],
    stopReason: "tool_use",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  };
}

function toolBatchResponse(toolCalls: ToolCall[]): LLMResponse {
  return {
    text: "",
    toolCalls,
    stopReason: "tool_use",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  };
}

function makeTurnLoopDeps(
  responses: LLMResponse[],
  options: {
    hook?: (event: string, data?: Record<string, unknown>) => Promise<HookResult> | HookResult;
    execute?: (call: ToolCall) => Promise<ToolResult>;
    clearPersistedGoal?: () => boolean | void;
    publishGoalJudgeContext?: (context: GoalJudgeRuntimeContext) => void;
    callDelayMs?: number;
  } = {},
): {
  deps: TurnLoopDeps;
  calls: Message[][];
  executedTools: ToolCall[];
  boundaryTurns: number[];
  assistantTranscriptTurns: number[];
} {
  let responseIndex = 0;
  let transcriptTurn = 0;
  const calls: Message[][] = [];
  const executedTools: ToolCall[] = [];
  const boundaryTurns: number[] = [];
  const assistantTranscriptTurns: number[] = [];
  const call = async (_systemPrompt: string, messages: Message[]): Promise<LLMResponse> => {
    if (options.callDelayMs) await Bun.sleep(options.callDelayMs);
    calls.push(messages.map((message) => ({ ...message })));
    const response = responses[Math.min(responseIndex, responses.length - 1)]!;
    responseIndex++;
    assistantTranscriptTurns.push(transcriptTurn);
    return response;
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
      summarize: undefined,
    } as unknown as TurnLoopDeps["model"],
    toolExecutor: {
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
      async executeSingle(callArg: ToolCall): Promise<ToolResult> {
        executedTools.push(callArg);
        return options.execute
          ? options.execute(callArg)
          : { id: callArg.id, toolName: callArg.toolName, result: "ok" };
      },
    } as unknown as TurnLoopDeps["toolExecutor"],
    contextManager: {
      async manageAsync(messages: Message[]) {
        return messages;
      },
      manage(messages: Message[]) {
        return messages;
      },
      recordActualUsage() {
        return undefined;
      },
      shouldReactiveCompact() {
        return false;
      },
    } as unknown as TurnLoopDeps["contextManager"],
    hooks: {
      async emit(event: string, ctx?: { data?: Record<string, unknown> }) {
        return options.hook ? options.hook(event, ctx?.data) : {};
      },
    } as unknown as TurnLoopDeps["hooks"],
    transcript: {
      appendToolUse() {},
      appendToolResult() {},
      appendTurnBoundary() {
        transcriptTurn++;
        boundaryTurns.push(transcriptTurn);
      },
      appendMessage() {},
    } as unknown as TurnLoopDeps["transcript"],
    systemPrompt: "system",
    tools: [],
    sessionId: "goal-loop-test",
    clearPersistedGoal: options.clearPersistedGoal,
    publishGoalJudgeContext: options.publishGoalJudgeContext,
    ctxOverheadStore: { get: () => 0, set: () => {} },
  };

  return { deps, calls, executedTools, boundaryTurns, assistantTranscriptTurns };
}

describe("TurnLoop goal lifecycle guardrails", () => {
  it("emits met when complete_goal clears the persistent goal", async () => {
    const events: StreamEvent[] = [];
    let clearCalls = 0;
    const { deps } = makeTurnLoopDeps(
      [
        toolResponse({
          id: "complete-1",
          toolName: COMPLETE_GOAL_TOOL_NAME,
          args: { summary: "done" },
        }),
      ],
      {
        clearPersistedGoal: () => {
          clearCalls++;
        },
      },
    );

    const result = await new TurnLoop(deps, {
      maxTurns: 2,
      maxToolCallsPerTurn: 10,
      goal: { objective: "finish", goalId: "goal-complete" } as never,
      onStream: (event) => {
        events.push(event);
      },
    }).run([{ role: "user", content: "go" }]);

    expect(result.reason).toBe("completed");
    expect(clearCalls).toBe(1);
    expect(events).toContainEqual({
      type: "goal_progress",
      goalId: "goal-complete",
      status: "met",
      round: 1,
    });
  });

  it("emits goal_cleared when confirmed cancel_goal clears the persistent goal", async () => {
    const events: StreamEvent[] = [];
    const { deps } = makeTurnLoopDeps([
      toolResponse({
        id: "cancel-1",
        toolName: CANCEL_GOAL_TOOL_NAME,
        args: { confirm: true, reason: "user asked" },
      }),
    ]);

    await new TurnLoop(deps, {
      maxTurns: 2,
      maxToolCallsPerTurn: 10,
      goal: { objective: "finish", goalId: "goal-cancel" } as never,
      onStream: (event) => {
        events.push(event);
      },
    }).run([{ role: "user", content: "stop" }]);

    expect(events).toContainEqual({ type: "goal_cleared", goalId: "goal-cancel" });
  });

  it("does not let an old model response complete an edited Goal revision", async () => {
    const events: StreamEvent[] = [];
    let clearCalls = 0;
    const { deps, calls } = makeTurnLoopDeps(
      [
        toolResponse({
          id: "complete-old-revision",
          toolName: COMPLETE_GOAL_TOOL_NAME,
          args: { summary: "the old objective is done" },
        }),
        stopResponse("continuing under the edited objective"),
      ],
      {
        clearPersistedGoal: () => {
          clearCalls++;
        },
        callDelayMs: 20,
      },
    );
    const loop = new TurnLoop(deps, {
      maxTurns: 3,
      maxToolCallsPerTurn: 10,
      goal: { objective: "old objective", goalId: "goal-edit", revision: 1 },
      onStream: (event) => {
        events.push(event);
      },
    });

    const running = loop.run([{ role: "user", content: "work on the old objective" }]);
    await Bun.sleep(5);
    loop.updateGoal(
      { objective: "new objective", goalId: "goal-edit", revision: 2 },
      "目标已编辑。新的目标：new objective",
    );
    await running;

    expect(clearCalls).toBe(0);
    expect(
      events.some(
        (event) =>
          event.type === "goal_progress" && event.status === "met" && event.goalId === "goal-edit",
      ),
    ).toBe(false);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1])).toContain("新的目标：new objective");
  });

  it("does not let an old model response cancel a resumed Goal revision", async () => {
    const events: StreamEvent[] = [];
    let clearCalls = 0;
    const { deps } = makeTurnLoopDeps(
      [
        toolResponse({
          id: "cancel-old-revision",
          toolName: CANCEL_GOAL_TOOL_NAME,
          args: { confirm: true, reason: "old prompt" },
        }),
        stopResponse("the resumed goal remains active"),
      ],
      {
        clearPersistedGoal: () => {
          clearCalls++;
        },
        callDelayMs: 20,
      },
    );
    const loop = new TurnLoop(deps, {
      maxTurns: 3,
      maxToolCallsPerTurn: 10,
      goal: { objective: "goal", goalId: "goal-resume", revision: 1 },
      onStream: (event) => {
        events.push(event);
      },
    });

    const running = loop.run([{ role: "user", content: "work" }]);
    await Bun.sleep(5);
    loop.updateGoal({ objective: "goal", goalId: "goal-resume", revision: 3 }, "目标已恢复：goal");
    await running;

    expect(clearCalls).toBe(0);
    expect(events.some((event) => event.type === "goal_cleared")).toBe(false);
  });

  it("stops before another model call when pause/delete arrives during a tool batch", async () => {
    let markToolStarted!: () => void;
    let releaseTool!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      markToolStarted = resolve;
    });
    const toolRelease = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const { deps, calls, executedTools } = makeTurnLoopDeps(
      [
        toolResponse({ id: "current-tool", toolName: "Write", args: {} }),
        stopResponse("must never be requested"),
      ],
      {
        execute: async (call) => {
          markToolStarted();
          await toolRelease;
          return { id: call.id, toolName: call.toolName, result: "settled" };
        },
      },
    );
    const loop = new TurnLoop(deps, {
      maxTurns: 5,
      maxToolCallsPerTurn: 10,
      goal: { objective: "finish", goalId: "goal-safe-stop", revision: 1 },
    });

    const running = loop.run([{ role: "user", content: "go" }]);
    await toolStarted;
    loop.updateGoal(undefined);
    releaseTool();
    const result = await running;

    expect(result.reason).toBe("completed");
    expect(executedTools).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("does not start auxiliary or max-turn summaries after the final tool safe boundary", async () => {
    let markToolStarted!: () => void;
    let releaseTool!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      markToolStarted = resolve;
    });
    const toolRelease = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    let summaryCalls = 0;
    const { deps, calls } = makeTurnLoopDeps(
      [
        toolResponse({ id: "last-tool", toolName: "Write", args: {} }),
        stopResponse("must never be requested"),
      ],
      {
        execute: async (call) => {
          markToolStarted();
          await toolRelease;
          return { id: call.id, toolName: call.toolName, result: "settled" };
        },
      },
    );
    deps.model.summarize = async () => {
      summaryCalls++;
      return "must never be requested";
    };
    const loop = new TurnLoop(deps, {
      maxTurns: 1,
      maxToolCallsPerTurn: 10,
      goal: { objective: "finish", goalId: "goal-last-safe-boundary", revision: 1 },
      onStream: () => {},
    });

    const running = loop.run([{ role: "user", content: "go" }]);
    await toolStarted;
    loop.updateGoal(undefined);
    releaseTool();
    expect((await running).reason).toBe("completed");
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(summaryCalls).toBe(0);
  });

  it("stops during async preflight without emitting or starting a model request", async () => {
    let markPreflightStarted!: () => void;
    let releasePreflight!: () => void;
    const preflightStarted = new Promise<void>((resolve) => {
      markPreflightStarted = resolve;
    });
    const preflightRelease = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    const events: StreamEvent[] = [];
    const { deps, calls } = makeTurnLoopDeps([stopResponse("must never be requested")]);
    deps.contextManager.manageAsync = async (messages: Message[]) => {
      markPreflightStarted();
      await preflightRelease;
      return messages;
    };
    const loop = new TurnLoop(deps, {
      maxTurns: 5,
      maxToolCallsPerTurn: 10,
      goal: { objective: "finish", goalId: "goal-preflight-stop", revision: 1 },
      onStream: (event) => {
        events.push(event);
      },
    });

    const running = loop.run([{ role: "user", content: "go" }]);
    await preflightStarted;
    loop.updateGoal(undefined);
    releasePreflight();
    expect((await running).reason).toBe("completed");
    expect(calls).toHaveLength(0);
    expect(events.some((event) => event.type === "stream_request_start")).toBe(false);
  });

  it("does not issue a max-output continuation after a goal pause/delete", async () => {
    const truncated: LLMResponse = {
      text: "partial",
      toolCalls: [],
      stopReason: "max_tokens",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
    const { deps, calls } = makeTurnLoopDeps([truncated, stopResponse("extra")], {
      callDelayMs: 20,
    });
    const loop = new TurnLoop(deps, {
      maxTurns: 5,
      maxToolCallsPerTurn: 10,
      goal: { objective: "finish", goalId: "goal-continuation-stop", revision: 1 },
    });

    const running = loop.run([{ role: "user", content: "go" }]);
    await Bun.sleep(5);
    loop.updateGoal(undefined);
    await running;

    expect(calls).toHaveLength(1);
  });

  it("keeps Goal mode active when complete_goal persistence fails", async () => {
    const events: StreamEvent[] = [];
    let persistCalls = 0;
    const { deps, calls } = makeTurnLoopDeps(
      [
        toolResponse({
          id: "complete-persist-failure",
          toolName: COMPLETE_GOAL_TOOL_NAME,
          args: { summary: "done" },
        }),
        stopResponse("cleanup still needs persistence"),
      ],
      {
        clearPersistedGoal: () => {
          persistCalls++;
          return false;
        },
      },
    );

    const result = await new TurnLoop(deps, {
      maxTurns: 3,
      maxToolCallsPerTurn: 10,
      goal: { objective: "finish", goalId: "goal-persist-failure", revision: 1 },
      onStream: (event) => {
        events.push(event);
      },
    }).run([{ role: "user", content: "go" }]);

    expect(result.reason).toBe("completed");
    expect(persistCalls).toBe(1);
    expect(calls).toHaveLength(2);
    expect(events.some((event) => event.type === "goal_progress" && event.status === "met")).toBe(
      false,
    );
    expect(JSON.stringify(result.messages)).toContain("complete_goal 未能持久化完成状态");
  });

  it("finalizes a stop-hook-blocked no-tool turn before continuing", async () => {
    let stopHookCalls = 0;
    const heartbeatTurns: number[] = [];
    const { deps, boundaryTurns, assistantTranscriptTurns } = makeTurnLoopDeps(
      [stopResponse("blocked"), stopResponse("done")],
      {
        hook: (event) => {
          if (event !== "on_stop") return {};
          stopHookCalls++;
          return stopHookCalls === 1 ? { continueSession: true, messages: ["keep going"] } : {};
        },
      },
    );

    await new TurnLoop(deps, {
      maxTurns: 3,
      maxToolCallsPerTurn: 10,
      goal: { objective: "finish after one block" },
      onTurnBoundary: (turnCount) => {
        heartbeatTurns.push(turnCount);
      },
    }).run([{ role: "user", content: "go" }]);

    expect(assistantTranscriptTurns).toEqual([0, 1]);
    expect(boundaryTurns).toEqual([1, 2]);
    expect(heartbeatTurns).toEqual([1, 2]);
  });

  it("finalizes a no-tool turn before finalize-backfill steering continues", async () => {
    let steerConsumed = false;
    const heartbeatTurns: number[] = [];
    const { deps, boundaryTurns, assistantTranscriptTurns } = makeTurnLoopDeps([
      stopResponse("first answer"),
      stopResponse("answer after steer"),
    ]);
    deps.consumeSteer = (source) => {
      if (source !== "finalize_backfill" || steerConsumed) return [];
      steerConsumed = true;
      return [{ id: "late-steer", text: "incorporate this" }];
    };

    await new TurnLoop(deps, {
      maxTurns: 3,
      maxToolCallsPerTurn: 10,
      onTurnBoundary: (turnCount) => {
        heartbeatTurns.push(turnCount);
      },
    }).run([{ role: "user", content: "go" }]);

    expect(assistantTranscriptTurns).toEqual([0, 1]);
    expect(boundaryTurns).toEqual([1, 2]);
    expect(heartbeatTurns).toEqual([1, 2]);
  });

  it("persists advancing heartbeat state and separate transcript turns across repeated blocks", async () => {
    let stopHookCalls = 0;
    let heartbeat = 0;
    const persistedSnapshots: Array<{ turnCount: number; heartbeat: number }> = [];
    const { deps, boundaryTurns, assistantTranscriptTurns } = makeTurnLoopDeps(
      [stopResponse("blocked 1"), stopResponse("blocked 2"), stopResponse("done")],
      {
        hook: (event) => {
          if (event !== "on_stop") return {};
          stopHookCalls++;
          return stopHookCalls <= 2
            ? { continueSession: true, messages: [`continue ${stopHookCalls}`] }
            : {};
        },
      },
    );

    await new TurnLoop(deps, {
      maxTurns: 4,
      maxToolCallsPerTurn: 10,
      goal: { objective: "finish after repeated blocks" },
      onTurnBoundary: (turnCount) => {
        persistedSnapshots.push({ turnCount, heartbeat: ++heartbeat });
      },
    }).run([{ role: "user", content: "go" }]);

    expect(assistantTranscriptTurns).toEqual([0, 1, 2]);
    expect(boundaryTurns).toEqual([1, 2, 3]);
    expect(persistedSnapshots).toEqual([
      { turnCount: 1, heartbeat: 1 },
      { turnCount: 2, heartbeat: 2 },
      { turnCount: 3, heartbeat: 3 },
    ]);
  });

  it("records exactly one boundary for a normal tool turn and the final no-tool turn", async () => {
    const heartbeatTurns: number[] = [];
    const { deps, boundaryTurns, assistantTranscriptTurns } = makeTurnLoopDeps([
      toolResponse({ id: "read-1", toolName: "Read", args: {} }),
      stopResponse("done"),
    ]);

    await new TurnLoop(deps, {
      maxTurns: 3,
      maxToolCallsPerTurn: 10,
      onTurnBoundary: (turnCount) => {
        heartbeatTurns.push(turnCount);
      },
    }).run([{ role: "user", content: "go" }]);

    expect(assistantTranscriptTurns).toEqual([0, 1]);
    expect(boundaryTurns).toEqual([1, 2]);
    expect(heartbeatTurns).toEqual([1, 2]);
  });

  it("records exactly one boundary for a normal final answer", async () => {
    const heartbeatTurns: number[] = [];
    const { deps, boundaryTurns, assistantTranscriptTurns } = makeTurnLoopDeps([
      stopResponse("done"),
    ]);

    await new TurnLoop(deps, {
      maxTurns: 2,
      maxToolCallsPerTurn: 10,
      onTurnBoundary: (turnCount) => {
        heartbeatTurns.push(turnCount);
      },
    }).run([{ role: "user", content: "go" }]);

    expect(assistantTranscriptTurns).toEqual([0]);
    expect(boundaryTurns).toEqual([1]);
    expect(heartbeatTurns).toEqual([1]);
  });

  it("does not scan sensitive-result tool metadata for a non-goal run", async () => {
    const { deps } = makeTurnLoopDeps([stopResponse("plain completion")]);
    let filterReads = 0;
    deps.tools = new Proxy(
      [
        {
          name: "OrdinaryTool",
          description: "ordinary",
          inputSchema: { type: "object" },
          sensitiveResult: true,
        },
      ],
      {
        get(target, property, receiver) {
          if (property === "filter") filterReads += 1;
          return Reflect.get(target, property, receiver);
        },
      },
    );

    const result = await new TurnLoop(deps, {
      maxTurns: 2,
      maxToolCallsPerTurn: 10,
    }).run([{ role: "user", content: "go" }]);

    expect(result.reason).toBe("completed");
    expect(filterReads).toBe(0);
  });

  it("publishes a sanitized complete-conversation snapshot before public on_stop", async () => {
    const order: string[] = [];
    const snapshots: GoalJudgeRuntimeContext[] = [];
    let publicStopData: Record<string, unknown> | undefined;
    const volatile: Message = { role: "user", content: "VOLATILE_GOAL_GUIDANCE" };
    const { deps } = makeTurnLoopDeps(
      [
        toolResponse({ id: "check-1", toolName: "Bash", args: { command: "bun test" } }),
        stopResponse("current final assistant"),
      ],
      {
        execute: async (call) => ({
          id: call.id,
          toolName: call.toolName,
          result: "4 tests failed",
          isError: true,
        }),
        hook: (event, data) => {
          if (event !== "on_stop") return {};
          order.push("hook");
          publicStopData = data;
          return { data: { goalVerdict: { met: true, gaps: "" } } };
        },
        publishGoalJudgeContext: (context) => {
          order.push("publish");
          snapshots.push(context);
        },
      },
    );

    await new TurnLoop(deps, {
      maxTurns: 4,
      maxToolCallsPerTurn: 10,
      goal: { objective: "ship only after tests pass" },
      volatileContextMessages: [volatile],
    }).run([{ role: "user", content: "go" }, volatile]);

    expect(order).toEqual(["publish", "hook"]);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.renderedConversation).toContain(
      'ASSISTANT TOOL_USE id=check-1 name=Bash input={"command":"bun test"}',
    );
    expect(snapshots[0]!.renderedConversation).toContain(
      "TOOL_RESULT tool_use_id=check-1 error=true:\n4 tests failed",
    );
    expect(snapshots[0]!.renderedConversation).toContain("current final assistant");
    expect(snapshots[0]!.renderedConversation).not.toContain("VOLATILE_GOAL_GUIDANCE");
    expect(publicStopData).not.toHaveProperty("messages");
    expect(publicStopData).not.toHaveProperty("conversation");
    expect(publicStopData).not.toHaveProperty("toolResults");
  });

  it("removes sensitive payloads before publishing the private judge snapshot", async () => {
    const snapshots: any[] = [];
    const secret = "GOAL_JUDGE_MUST_NOT_RETAIN_THIS_SECRET";
    const { deps } = makeTurnLoopDeps(
      [
        toolResponse({ id: "secret-1", toolName: "QueryUsage", args: {} }),
        stopResponse("usage checked"),
      ],
      {
        execute: async (call) => ({
          id: call.id,
          toolName: call.toolName,
          sensitive: true,
          result: `${secret}:result`,
          displayResult: "[credential value withheld]",
          transcriptResult: "[credential value withheld]",
          contentBlocks: [{ type: "text", text: `${secret}:content-block` }],
        }),
        hook: (event) =>
          event === "on_stop" ? { data: { goalVerdict: { met: true, gaps: "" } } } : {},
        publishGoalJudgeContext: (context) => snapshots.push(context),
      },
    );

    await new TurnLoop(deps, {
      maxTurns: 4,
      maxToolCallsPerTurn: 10,
      goal: { objective: "check usage" },
    }).run([{ role: "user", content: "go" }]);

    expect(snapshots).toHaveLength(1);
    expect(JSON.stringify(snapshots[0])).not.toContain(secret);
    expect(snapshots[0].renderedConversation).toContain("[credential value withheld]");
    expect(snapshots[0].renderedConversation).toContain("TOOL_RESULT tool_use_id=secret-1");
  });

  it("honors tool registration metadata that declares sensitive results", async () => {
    const snapshots: any[] = [];
    const secret = "METADATA_DECLARED_RESULT_SECRET";
    const { deps } = makeTurnLoopDeps(
      [
        toolResponse({ id: "metadata-secret-1", toolName: "CredentialLookup", args: {} }),
        stopResponse("credential checked"),
      ],
      {
        execute: async (call) => ({
          id: call.id,
          toolName: call.toolName,
          result: secret,
        }),
        hook: (event) =>
          event === "on_stop" ? { data: { goalVerdict: { met: true, gaps: "" } } } : {},
        publishGoalJudgeContext: (context) => snapshots.push(context),
      },
    );
    deps.tools = [
      {
        name: "CredentialLookup",
        description: "returns credentials",
        inputSchema: { type: "object" },
        sensitiveResult: true,
      },
    ];

    await new TurnLoop(deps, {
      maxTurns: 4,
      maxToolCallsPerTurn: 10,
      goal: { objective: "check credential state" },
    }).run([{ role: "user", content: "go" }]);

    expect(snapshots).toHaveLength(1);
    expect(JSON.stringify(snapshots[0])).not.toContain(secret);
    expect(snapshots[0].renderedConversation).toContain("[credential value withheld]");
  });

  it("carries sensitiveResult from ToolRegistry definitions into TurnLoop", async () => {
    const snapshots: any[] = [];
    const secret = "REGISTRY_TO_TURN_LOOP_SECRET";
    const registry = new ToolRegistry({ builtinTools: [] });
    registry.registerTool({
      name: "RegistryCredentialLookup",
      description: "returns credentials",
      inputSchema: { type: "object", properties: {} },
      source: "builtin",
      permissionDefault: "allow",
      sensitiveResult: true,
    });
    const { deps } = makeTurnLoopDeps(
      [
        toolResponse({ id: "registry-secret-1", toolName: "RegistryCredentialLookup", args: {} }),
        stopResponse("credential checked"),
      ],
      {
        execute: async (call) => ({ id: call.id, toolName: call.toolName, result: secret }),
        hook: (event) =>
          event === "on_stop" ? { data: { goalVerdict: { met: true, gaps: "" } } } : {},
        publishGoalJudgeContext: (context) => snapshots.push(context),
      },
    );
    deps.tools = registry.getToolDefinitions();

    await new TurnLoop(deps, {
      maxTurns: 4,
      maxToolCallsPerTurn: 10,
      goal: { objective: "check registry credential state" },
    }).run([{ role: "user", content: "go" }]);

    expect(deps.tools[0]?.sensitiveResult).toBe(true);
    expect(snapshots).toHaveLength(1);
    expect(JSON.stringify(snapshots[0])).not.toContain(secret);
    expect(snapshots[0].renderedConversation).toContain("[credential value withheld]");
  });

  it("retains all 25 results from one legal tool batch for the judge", async () => {
    const snapshots: any[] = [];
    const toolCalls = Array.from({ length: 25 }, (_, index) => ({
      id: `batch-${index + 1}`,
      toolName: `BatchTool${index + 1}`,
      args: {},
    }));
    const { deps } = makeTurnLoopDeps([toolBatchResponse(toolCalls), stopResponse("batch done")], {
      execute: async (call) => ({
        id: call.id,
        toolName: call.toolName,
        result: `evidence for ${call.toolName}`,
      }),
      hook: (event) =>
        event === "on_stop" ? { data: { goalVerdict: { met: true, gaps: "" } } } : {},
      publishGoalJudgeContext: (context) => snapshots.push(context),
    });

    await new TurnLoop(deps, {
      maxTurns: 4,
      maxToolCallsPerTurn: 25,
      goal: { objective: "inspect the complete batch" },
    }).run([{ role: "user", content: "go" }]);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].renderedConversation).toContain("TOOL_USE id=batch-1 name=BatchTool1");
    expect(snapshots[0].renderedConversation).toContain("evidence for BatchTool13");
    expect(snapshots[0].renderedConversation).toContain("evidence for BatchTool25");
  });

  it("stops with goal_budget_exhausted before executing tool calls", async () => {
    const events: StreamEvent[] = [];
    const { deps, calls, executedTools } = makeTurnLoopDeps([
      {
        text: "I will call a tool, but the run is already over budget.",
        toolCalls: [{ id: "tool-1", toolName: "Write", args: { file_path: "x", content: "x" } }],
        stopReason: "tool_use",
        usage: { promptTokens: 90, completionTokens: 20, totalTokens: 110 },
      },
    ]);
    const config: TurnLoopConfig = {
      maxTurns: 5,
      maxToolCallsPerTurn: 10,
      goal: { objective: "ship", goalId: "goal-token-budget", tokenBudget: 100 },
      onStream: (event) => {
        events.push(event);
      },
    };

    const result = await new TurnLoop(deps, config).run([{ role: "user", content: "go" }]);

    expect(result.reason).toBe("goal_budget_exhausted");
    expect(result.goalTermination).toBe("token_budget_exhausted");
    expect(calls).toHaveLength(1);
    expect(executedTools).toHaveLength(0);
    expect(result.goalTerminationRound).toBe(0);
    expect(
      events.some((event) => event.type === "goal_progress" && event.status === "exhausted"),
    ).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === "assistant_message" &&
          typeof event.message.content === "string" &&
          event.message.content.includes("Goal 预算已耗尽"),
      ),
    ).toBe(true);
  });

  it("returns time exhaustion without publishing a pre-persistence terminal event", async () => {
    const events: StreamEvent[] = [];
    const { deps } = makeTurnLoopDeps([stopResponse("too late")], { callDelayMs: 5 });

    const result = await new TurnLoop(deps, {
      maxTurns: 5,
      maxToolCallsPerTurn: 10,
      goal: { objective: "finish quickly", goalId: "goal-time-budget", timeBudgetMs: 1 },
      onStream: (event) => {
        events.push(event);
      },
    }).run([{ role: "user", content: "go" }]);

    expect(result.goalTermination).toBe("time_budget_exhausted");
    expect(result.goalTerminationRound).toBe(0);
    expect(
      events.some((event) => event.type === "goal_progress" && event.status === "exhausted"),
    ).toBe(false);
  });

  it("charges judge usage to the Goal budget before deciding to continue", async () => {
    let judgeContext: GoalJudgeRuntimeContext | undefined;
    let judgeCalls = 0;
    const judge: GoalJudgeLLM = {
      async createMessage(): Promise<LLMResponse> {
        judgeCalls += 1;
        return {
          text: '{"met":false,"waiting":false,"gaps":"still incomplete"}',
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
    };
    const goalHook = createGoalStopHook({
      goal: "finish within budget",
      llm: judge,
      log: { info() {}, warn() {}, error() {} },
      getJudgeContext: () => judgeContext,
      onJudgeUsage: (usage) => loop.recordGoalJudgeUsage(usage),
    });
    const { deps, calls } = makeTurnLoopDeps([stopResponse("not done")], {
      hook: (event, data) =>
        event === "on_stop"
          ? goalHook({ eventName: "on_stop", data: { ...data, sessionId: "goal-loop-test" } })
          : {},
      publishGoalJudgeContext: (context) => {
        judgeContext = context as GoalJudgeRuntimeContext;
      },
    });
    const events: StreamEvent[] = [];
    const loop = new TurnLoop(deps, {
      maxTurns: 4,
      maxToolCallsPerTurn: 10,
      goal: {
        objective: "finish within budget",
        goalId: "goal-post-judge-budget",
        tokenBudget: 16,
      },
      maxStopBlocks: 3,
      onStream: (event) => {
        events.push(event);
      },
    });

    const result = await loop.run([{ role: "user", content: "go" }]);

    expect(result.reason).toBe("goal_budget_exhausted");
    expect(result.goalTermination).toBe("token_budget_exhausted");
    expect(calls).toHaveLength(1);
    expect(judgeCalls).toBe(1);
    expect(result.goalTerminationRound).toBe(0);
    expect(
      events.some((event) => event.type === "goal_progress" && event.status === "exhausted"),
    ).toBe(false);
  });

  it("does not exhaust stop blocks when tool-use turns with failure strings separate blocks", async () => {
    const events: StreamEvent[] = [];
    let stopHookCalls = 0;
    const responses: LLMResponse[] = [];
    for (let round = 1; round <= 3; round++) {
      responses.push(
        stopResponse(`blocked ${round}`),
        toolResponse({ id: `tool-${round}`, toolName: "ProgressTool", args: { round } }),
      );
    }
    responses.push(stopResponse("goal complete"));

    const { deps, calls, executedTools } = makeTurnLoopDeps(responses, {
      execute: async (call) => ({
        id: call.id,
        toolName: call.toolName,
        result: `Error: simulated WebFetch failure in round ${call.args.round}`,
      }),
      hook: (event) => {
        if (event !== "on_stop") return {};
        stopHookCalls++;
        if (stopHookCalls <= 3) {
          return {
            continueSession: true,
            messages: [`continue ${stopHookCalls}`],
            data: { goalVerdict: { met: false, gaps: "still incomplete" } },
          };
        }
        return { data: { goalVerdict: { met: true, gaps: "" } } };
      },
    });

    const result = await new TurnLoop(deps, {
      maxTurns: 10,
      maxToolCallsPerTurn: 10,
      goal: { objective: "make steady progress" },
      maxStopBlocks: 2,
      onStream: (event) => {
        events.push(event);
      },
    }).run([{ role: "user", content: "go" }]);

    expect(result.reason).toBe("completed");
    expect(result.goalTermination).toBeUndefined();
    expect(stopHookCalls).toBe(4);
    expect(calls).toHaveLength(7);
    expect(executedTools).toHaveLength(3);
    expect(
      events.some((event) => event.type === "goal_progress" && event.status === "exhausted"),
    ).toBe(false);
  });

  it("uses tool_use itself to reset the streak regardless of ToolResult error fields", async () => {
    let stopHookCalls = 0;
    const { deps, calls, executedTools } = makeTurnLoopDeps(
      [
        stopResponse("not done"),
        toolResponse({ id: "failed-tool-1", toolName: "Bash", args: {} }),
        stopResponse("still not done"),
        toolResponse({ id: "failed-tool-2", toolName: "Bash", args: {} }),
        stopResponse("done"),
      ],
      {
        execute: async (call) => ({
          id: call.id,
          toolName: call.toolName,
          result: "Error: command failed",
          error: "command failed",
          isError: true,
        }),
        hook: (event) => {
          if (event !== "on_stop") return {};
          stopHookCalls++;
          return stopHookCalls <= 2
            ? {
                continueSession: true,
                messages: ["continue after the tool attempt"],
                data: { goalVerdict: { met: false, gaps: "try the next step" } },
              }
            : { data: { goalVerdict: { met: true, gaps: "" } } };
        },
      },
    );

    const result = await new TurnLoop(deps, {
      maxTurns: 5,
      maxToolCallsPerTurn: 10,
      goal: { objective: "continue after a tool attempt" },
      maxStopBlocks: 1,
    }).run([{ role: "user", content: "go" }]);

    expect(result.reason).toBe("completed");
    expect(result.goalTermination).toBeUndefined();
    expect(stopHookCalls).toBe(3);
    expect(calls).toHaveLength(5);
    expect(executedTools).toHaveLength(2);
  });

  it("resets the stop-block streak before a truncated tool_use response continues", async () => {
    let stopHookCalls = 0;
    const { deps, calls, executedTools } = makeTurnLoopDeps(
      [
        stopResponse("not done"),
        {
          text: "",
          toolCalls: [{ id: "truncated-tool", toolName: "Write", args: {} }],
          stopReason: "length",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        },
        stopResponse("still not done"),
        stopResponse("done"),
      ],
      {
        hook: (event) => {
          if (event !== "on_stop") return {};
          stopHookCalls++;
          return stopHookCalls <= 2
            ? {
                continueSession: true,
                messages: ["continue after the truncated tool attempt"],
                data: { goalVerdict: { met: false, gaps: "retry remains" } },
              }
            : { data: { goalVerdict: { met: true, gaps: "" } } };
        },
      },
    );

    const result = await new TurnLoop(deps, {
      maxTurns: 6,
      maxToolCallsPerTurn: 10,
      goal: { objective: "recover from a truncated tool call" },
      maxStopBlocks: 1,
    }).run([{ role: "user", content: "go" }]);

    expect(result.reason).toBe("completed");
    expect(result.goalTermination).toBeUndefined();
    expect(stopHookCalls).toBe(3);
    expect(calls).toHaveLength(4);
    expect(executedTools).toHaveLength(0);
  });

  it("resets the stop-block streak before a budget-stop queued steer continues", async () => {
    let stopHookCalls = 0;
    let toolExecutions = 0;
    let steerConsumed = false;
    const { deps, calls, executedTools } = makeTurnLoopDeps(
      [
        toolResponse({ id: "budget-nudge-tool", toolName: "Read", args: {} }),
        stopResponse("not done"),
        toolResponse({ id: "budget-stop-tool", toolName: "Read", args: {} }),
        stopResponse("still not done"),
        stopResponse("done"),
      ],
      {
        execute: async (call) => {
          toolExecutions++;
          return { id: call.id, toolName: call.toolName, result: "ok" };
        },
        hook: (event) => {
          if (event !== "on_stop") return {};
          stopHookCalls++;
          return stopHookCalls <= 2
            ? {
                continueSession: true,
                messages: ["continue after the tool turn"],
                data: { goalVerdict: { met: false, gaps: "one step remains" } },
              }
            : { data: { goalVerdict: { met: true, gaps: "" } } };
        },
      },
    );
    deps.model.getOutputTokens = () => 9;
    deps.consumeSteer = (source) => {
      if (source !== "finalize_backfill" || toolExecutions < 2 || steerConsumed) return [];
      steerConsumed = true;
      return [{ id: "budget-stop-steer", text: "continue with this queued guidance" }];
    };

    const result = await new TurnLoop(deps, {
      maxTurns: 7,
      maxToolCallsPerTurn: 10,
      tokenBudget: 10,
      goal: { objective: "honor queued guidance after the budget stop" },
      maxStopBlocks: 1,
    }).run([{ role: "user", content: "go" }]);

    expect(result.reason).toBe("completed");
    expect(result.goalTermination).toBeUndefined();
    expect(stopHookCalls).toBe(3);
    expect(calls).toHaveLength(5);
    expect(executedTools).toHaveLength(2);
    expect(steerConsumed).toBe(true);
  });

  it("forces a stop after maxStopBlocks consecutive blocks, bounding continuations", async () => {
    const events: StreamEvent[] = [];
    let stopHookCalls = 0;
    const { deps, calls } = makeTurnLoopDeps([stopResponse("round")], {
      hook: (event) => {
        if (event !== "on_stop") return {};
        stopHookCalls++;
        return {
          continueSession: true,
          messages: [`continue ${stopHookCalls}`],
          data: { goalVerdict: { met: false, gaps: "still incomplete" } },
        };
      },
    });
    const config: TurnLoopConfig = {
      maxTurns: 10,
      maxToolCallsPerTurn: 10,
      goal: { objective: "keep working" },
      maxStopBlocks: 2,
      onStream: (event) => {
        events.push(event);
      },
    };

    const result = await new TurnLoop(deps, config).run([{ role: "user", content: "go" }]);

    // Keep the public terminal reason stable while returning structured goal
    // lifecycle metadata for Engine-owned persistence cleanup.
    expect(result.reason).toBe("completed");
    expect(result.goalTermination).toBe("stop_blocks_exhausted");
    expect(stopHookCalls).toBe(3);
    expect(calls).toHaveLength(3);
    expect(
      events.filter((event) => event.type === "goal_progress" && event.status === "not_met"),
    ).toHaveLength(2);
    expect(
      events.some((event) => event.type === "goal_progress" && event.status === "exhausted"),
    ).toBe(false);
    expect(result.goalTerminationRound).toBe(2);
    expect(
      events.some(
        (event) =>
          event.type === "assistant_message" &&
          typeof event.message.content === "string" &&
          event.message.content.includes("Goal 续跑已达 2 次上限"),
      ),
    ).toBe(true);
  });

  it("preserves normal recovery after a single stop block", async () => {
    const events: StreamEvent[] = [];
    let stopHookCalls = 0;
    const { deps, calls, executedTools } = makeTurnLoopDeps(
      [
        stopResponse("not done"),
        toolResponse({ id: "recovery-tool", toolName: "ProgressTool", args: {} }),
        stopResponse("done"),
      ],
      {
        hook: (event) => {
          if (event !== "on_stop") return {};
          stopHookCalls++;
          return stopHookCalls === 1
            ? {
                continueSession: true,
                messages: ["continue once"],
                data: { goalVerdict: { met: false, gaps: "one step remains" } },
              }
            : { data: { goalVerdict: { met: true, gaps: "" } } };
        },
      },
    );

    const result = await new TurnLoop(deps, {
      maxTurns: 5,
      maxToolCallsPerTurn: 10,
      goal: { objective: "recover after one block" },
      maxStopBlocks: 1,
      onStream: (event) => {
        events.push(event);
      },
    }).run([{ role: "user", content: "go" }]);

    expect(result.reason).toBe("completed");
    expect(result.goalTermination).toBeUndefined();
    expect(stopHookCalls).toBe(2);
    expect(calls).toHaveLength(3);
    expect(executedTools).toHaveLength(1);
    expect(
      events.filter((event) => event.type === "goal_progress" && event.status === "not_met"),
    ).toHaveLength(1);
    expect(
      events.some((event) => event.type === "goal_progress" && event.status === "exhausted"),
    ).toBe(false);
  });

  it("bounds repeated ineffective tool-use turns with maxTurns instead of stop blocks", async () => {
    let stopHookCalls = 0;
    const responses = Array.from({ length: 3 }, (_, index) =>
      toolResponse({ id: `ineffective-${index + 1}`, toolName: "Bash", args: {} }),
    );
    const { deps, calls, executedTools } = makeTurnLoopDeps(responses, {
      execute: async (call) => ({
        id: call.id,
        toolName: call.toolName,
        result: "Error: command failed again",
      }),
      hook: (event) => {
        if (event === "on_stop") stopHookCalls++;
        return {};
      },
    });

    const events: StreamEvent[] = [];
    const result = await new TurnLoop(deps, {
      maxTurns: 3,
      maxToolCallsPerTurn: 10,
      goal: { objective: "eventually stop the ineffective loop", goalId: "goal-max-turns" },
      maxStopBlocks: 1,
      onStream: (event) => {
        events.push(event);
      },
    }).run([{ role: "user", content: "go" }]);

    expect(result.reason).toBe("max_turns");
    expect(result.goalTermination).toBe("max_turns_exhausted");
    expect(stopHookCalls).toBe(0);
    expect(executedTools).toHaveLength(3);
    expect(calls).toHaveLength(4);
    expect(result.goalTerminationRound).toBe(0);
    expect(
      events.some((event) => event.type === "goal_progress" && event.status === "exhausted"),
    ).toBe(false);
  });

  it("refreshes the conversation digest across two real stop rounds", async () => {
    let judgeContext: GoalJudgeRuntimeContext | undefined;
    let judgeCalls = 0;
    const observedDigests: string[] = [];
    const judge: GoalJudgeLLM = {
      async createMessage(): Promise<LLMResponse> {
        judgeCalls += 1;
        return {
          text: '{"met":false,"waiting":false,"gaps":"still incomplete"}',
          toolCalls: [],
        };
      },
    };
    const goalHook = createGoalStopHook({
      goal: "finish the unchanged work",
      llm: judge,
      log: { info() {}, warn() {}, error() {} },
      now: () => new Date("2026-07-10T10:00:10.000Z"),
      getJudgeContext: () => judgeContext,
    });
    const { deps } = makeTurnLoopDeps(
      [stopResponse("same stalled output"), stopResponse("same stalled output")],
      {
        hook: (event, data) =>
          event === "on_stop"
            ? goalHook({ eventName: "on_stop", data: { ...data, sessionId: "goal-loop-test" } })
            : {},
        publishGoalJudgeContext: (context) => {
          judgeContext = context;
          observedDigests.push(context.digest);
        },
      },
    );

    await new TurnLoop(deps, {
      maxTurns: 4,
      maxToolCallsPerTurn: 10,
      goal: { objective: "finish the unchanged work" },
      maxStopBlocks: 1,
    }).run([{ role: "user", content: "go" }]);

    expect(observedDigests).toHaveLength(2);
    expect(observedDigests[1]).not.toBe(observedDigests[0]);
    expect(judgeCalls).toBe(2);
  });
});

const provider = "fake-goal-lifecycle";
const engineScenarios = new Map<
  string,
  {
    mainResponses: LLMResponse[];
    mainCalls: number;
    judgeCalls?: number;
    judgeResponse?: string;
    systemPrompts?: string[];
    lastUsage?: LLMUsageTracker;
    mainMessages?: Message[][];
    judgeMessages?: Message[][];
    afterMainCall?: (callNumber: number) => void;
    afterJudgeCall?: (callNumber: number) => void;
  }
>();

class GoalLifecycleClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const scenario = engineScenarios.get(this.model);
    if (!scenario) throw new Error(`missing fake goal lifecycle scenario: ${this.model}`);
    scenario.systemPrompts ??= [];
    scenario.systemPrompts.push(options.systemPrompt);

    const isMainTurn = (options.tools?.length ?? 0) > 0;
    if (!isMainTurn) {
      const isGoalJudge = options.systemPrompt.includes("目标完成度裁判");
      if (isGoalJudge) {
        scenario.judgeMessages ??= [];
        scenario.judgeMessages.push(options.messages.map((message) => ({ ...message })));
        scenario.judgeCalls = (scenario.judgeCalls ?? 0) + 1;
        scenario.afterJudgeCall?.(scenario.judgeCalls);
      }
      const response: LLMResponse = {
        text: isGoalJudge ? (scenario.judgeResponse ?? "aux") : "[]",
        toolCalls: [],
        stopReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
      this.recordUsage(response.usage!, options);
      scenario.lastUsage = this.getUsage();
      return response;
    }

    const response =
      scenario.mainResponses[Math.min(scenario.mainCalls, scenario.mainResponses.length - 1)]!;
    scenario.mainCalls++;
    scenario.mainMessages ??= [];
    scenario.mainMessages.push(options.messages.map((message) => ({ ...message })));
    scenario.afterMainCall?.(scenario.mainCalls);
    this.recordUsage(
      response.usage ?? { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      options,
    );
    scenario.lastUsage = this.getUsage();
    return response;
  }
}

registerProvider(provider, GoalLifecycleClient);

function uniqueModel(name: string): string {
  return `${provider}-${name}-${Date.now()}-${Math.random()}`;
}

function activeGoalFromState(dir: string, sessionId: string): unknown {
  return persistedState(dir, sessionId).activeGoal;
}

function persistedState(
  dir: string,
  sessionId: string,
): {
  activeGoal?: { objective: string; goalId?: string; setAtMs?: number };
  goalTerminal?: { objective: string; goalId?: string; setAtMs?: number; reason: string };
  goalTerminals?: Array<{
    objective: string;
    goalId?: string;
    setAtMs?: number;
    reason: string;
  }>;
  goalLifecycle?: { version: number; phase: string; goalId: string; revision: number };
  workspace?: unknown;
  status?: string;
  turnSeq?: number;
  tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
} {
  const raw = readFileSync(join(dir, "sessions", sessionId, "state.json"), "utf8");
  const state = JSON.parse(raw) as any;
  const lifecycle = state.goalLifecycle;
  if (lifecycle?.version === 1) {
    if (lifecycle.phase === "terminal") {
      state.activeGoal = undefined;
      state.goalTerminal = {
        objective: lifecycle.config.objective,
        goalId: lifecycle.goalId,
        setAtMs: lifecycle.config.setAtMs,
        reason: lifecycle.terminal.reason,
      };
      state.goalTerminals = [state.goalTerminal];
    } else {
      state.activeGoal = {
        ...lifecycle.config,
        goalId: lifecycle.goalId,
        revision: lifecycle.revision,
        ...(lifecycle.phase === "paused" ? { paused: true } : {}),
      };
    }
  }
  return state;
}

afterEach(() => {
  backgroundJobRegistry.reset();
  notificationQueue.reset();
});

describe("Engine persisted goal lifecycle", () => {
  it("passes a failed tool round and the current assistant text to the built-in judge", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-goal-complete-context-"));
    const model = uniqueModel("complete-context");
    const sessionId = "goal-complete-context";
    engineScenarios.set(model, {
      mainResponses: [
        toolResponse({
          id: "failed-check",
          toolName: "Bash",
          args: { command: "printf ENGINE_FAILURE_EVIDENCE; exit 1" },
        }),
        stopResponse("done despite the failed check"),
      ],
      mainCalls: 0,
      judgeResponse: '{"met":true,"waiting":false,"gaps":""}',
    });

    try {
      const engine = new Engine({
        llm: { provider, model, apiKey: "test" } as never,
        cwd: dir,
        sessionStorageDir: join(dir, "sessions"),
        permissionMode: "bypassPermissions",
        headless: true,
      });
      (engine as any).hooks.clear();

      await engine.run("verify the release", {
        sessionId,
        cwd: dir,
        goal: { objective: "ship only after the check passes" },
      });

      const judgePrompt = JSON.stringify(engineScenarios.get(model)?.judgeMessages ?? []);
      expect(engineScenarios.get(model)?.judgeCalls ?? 0).toBeGreaterThan(0);
      expect(judgePrompt).toContain("TOOL_USE id=failed-check name=Bash");
      expect(judgePrompt).toContain("TOOL_RESULT tool_use_id=failed-check error=true");
      expect(judgePrompt).toContain("ENGINE_FAILURE_EVIDENCE");
      expect(judgePrompt).toContain("done despite the failed check");
    } finally {
      engineScenarios.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("publishes exhausted only after the terminal lifecycle commit succeeds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-goal-terminal-publish-barrier-"));
    const model = uniqueModel("terminal-publish-barrier");
    const sessionId = "goal-terminal-publish-barrier";
    const events: StreamEvent[] = [];
    engineScenarios.set(model, {
      mainResponses: [
        {
          text: "over budget",
          toolCalls: [],
          stopReason: "stop",
          usage: { promptTokens: 90, completionTokens: 20, totalTokens: 110 },
        },
      ],
      mainCalls: 0,
      judgeResponse: '{"met":false,"waiting":false,"gaps":"unfinished"}',
    });

    try {
      const engine = new Engine({
        llm: { provider, model, apiKey: "test" } as never,
        cwd: dir,
        sessionStorageDir: join(dir, "sessions"),
        permissionMode: "bypassPermissions",
        headless: true,
      });
      (engine as any).hooks.clear();
      (engine as any).sessionManager.saveGoalTerminalOutcome = () => "failed";

      const result = await engine.run("work", {
        sessionId,
        cwd: dir,
        goal: { objective: "ship", tokenBudget: 100 },
        onStream: (event) => {
          events.push(event);
        },
      });

      expect(result.reason).toBe("goal_budget_exhausted");
      expect(activeGoalFromState(dir, sessionId)).toMatchObject({ objective: "ship" });
      expect(
        events.some((event) => event.type === "goal_progress" && event.status === "exhausted"),
      ).toBe(false);
    } finally {
      engineScenarios.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("G1: does not re-enter headless TurnLoop after the first goal termination", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-goal-headless-terminal-"));
    const model = uniqueModel("headless-terminal");
    const sessionId = "goal-headless-terminal";
    const events: StreamEvent[] = [];
    notificationQueue.enqueue(
      {
        agentId: "already-finished-agent",
        description: "already finished background check",
        status: "completed",
        finalText: "background result waiting to be delivered",
        enqueuedAt: Date.now(),
      },
      sessionId,
    );
    engineScenarios.set(model, {
      mainResponses: [
        stopResponse("budget is exhausted"),
        {
          text: "must not run",
          toolCalls: [{ id: "must-not-run", toolName: "UnknownTool", args: {} }],
          stopReason: "tool_use",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        },
        {
          text: "would overwrite the terminal result",
          toolCalls: [],
          stopReason: "stop",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        },
      ],
      mainCalls: 0,
    });

    try {
      const engine = new Engine({
        llm: { provider, model, apiKey: "test" } as never,
        cwd: dir,
        sessionStorageDir: join(dir, "sessions"),
        permissionMode: "bypassPermissions",
        headless: true,
      });
      (engine as any).hooks.clear();

      const result = await engine.run("bounded headless work", {
        sessionId,
        cwd: dir,
        goal: { objective: "finish within budget", tokenBudget: 10 },
        onStream: (event) => {
          events.push(event);
        },
      });

      expect(engineScenarios.get(model)?.mainCalls).toBe(1);
      expect(events.filter((event) => event.type === "tool_use_start")).toHaveLength(0);
      expect(result.reason).toBe("goal_budget_exhausted");
      expect(result.goalTermination).toBe("token_budget_exhausted");
    } finally {
      engineScenarios.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("G1: persists a later background notification without restarting after termination", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-goal-terminal-notification-"));
    const model = uniqueModel("terminal-notification");
    const sessionId = "goal-terminal-notification";
    engineScenarios.set(model, {
      mainResponses: [
        stopResponse("budget is exhausted"),
        {
          text: "must not summarize after termination",
          toolCalls: [],
          stopReason: "stop",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        },
      ],
      mainCalls: 0,
      afterMainCall: (callNumber) => {
        if (callNumber !== 1) return;
        notificationQueue.enqueue(
          {
            agentId: "just-finished-agent",
            description: "post-termination background check",
            status: "completed",
            finalText: "post-termination background result",
            enqueuedAt: Date.now(),
          },
          sessionId,
        );
      },
    });

    try {
      const engine = new Engine({
        llm: { provider, model, apiKey: "test" } as never,
        cwd: dir,
        sessionStorageDir: join(dir, "sessions"),
        permissionMode: "bypassPermissions",
        headless: true,
      });
      (engine as any).hooks.clear();

      const result = await engine.run("bounded headless work", {
        sessionId,
        cwd: dir,
        goal: { objective: "finish within budget", tokenBudget: 10 },
      });
      const transcript = readFileSync(join(dir, "sessions", sessionId, "transcript.jsonl"), "utf8");

      expect(engineScenarios.get(model)?.mainCalls).toBe(1);
      expect(notificationQueue.getSnapshot(sessionId)).toHaveLength(0);
      expect(transcript).toContain("post-termination background result");
      expect(transcript).toContain('"injected":true');
      expect(result.reason).toBe("goal_budget_exhausted");
      expect(result.goalTermination).toBe("token_budget_exhausted");
    } finally {
      engineScenarios.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("G1 regression: keeps normal headless background continuation without goal termination", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-headless-normal-continuation-"));
    const model = uniqueModel("normal-continuation");
    const sessionId = "headless-normal-continuation";
    engineScenarios.set(model, {
      mainResponses: [
        stopResponse("background work started"),
        stopResponse("background result summarized"),
      ],
      mainCalls: 0,
      afterMainCall: (callNumber) => {
        if (callNumber !== 1) return;
        notificationQueue.enqueue(
          {
            agentId: "normal-finished-agent",
            description: "normal background check",
            status: "completed",
            finalText: "normal background result",
            enqueuedAt: Date.now(),
          },
          sessionId,
        );
      },
    });

    try {
      const engine = new Engine({
        llm: { provider, model, apiKey: "test" } as never,
        cwd: dir,
        sessionStorageDir: join(dir, "sessions"),
        permissionMode: "bypassPermissions",
        headless: true,
      });
      (engine as any).hooks.clear();

      const result = await engine.run("continue normally", { sessionId, cwd: dir });
      const continuationMessages = engineScenarios.get(model)?.mainMessages?.[1] ?? [];

      expect(engineScenarios.get(model)?.mainCalls).toBe(2);
      expect(
        continuationMessages.some(
          (message) =>
            message.role === "user" &&
            typeof message.content === "string" &&
            message.content.includes("normal background result"),
        ),
      ).toBe(true);
      expect(result.text).toBe("background result summarized");
      expect(result.goalTermination).toBeUndefined();
    } finally {
      engineScenarios.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("F7: stops immediately on unrecoverable judge overflow but preserves the active goal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-goal-judge-overflow-"));
    const model = uniqueModel("judge-overflow");
    const sessionId = "goal-judge-overflow-preserves";
    const objective = `OBJECTIVE-HEAD-${"g".repeat(30_000)}-OBJECTIVE-TAIL`;
    engineScenarios.set(model, {
      mainResponses: [stopResponse("cannot judge this prompt")],
      mainCalls: 0,
      judgeResponse: '{"met":true,"waiting":false,"gaps":""}',
    });

    try {
      for (let index = 0; index < 16; index++) {
        backgroundJobRegistry.start(
          `f7-engine-fixed-overflow-${index}`,
          sessionId,
          `BACKGROUND-${index}-${String(index % 10).repeat(2_000)}`,
        );
      }
      const events: StreamEvent[] = [];
      const engine = new Engine({
        llm: { provider, model, apiKey: "test" } as never,
        cwd: dir,
        sessionStorageDir: join(dir, "sessions"),
        permissionMode: "bypassPermissions",
        headless: true,
      });
      (engine as any).hooks.clear();

      const result = await engine.run("start the large goal", {
        sessionId,
        cwd: dir,
        goal: { objective, maxStopBlocks: 3 },
        onStream: (event) => {
          events.push(event);
        },
      });

      expect(result.reason).toBe("completed");
      expect(result.goalTermination).toBe("judge_prompt_too_large");
      expect(engineScenarios.get(model)?.mainCalls).toBe(1);
      expect(
        engineScenarios
          .get(model)
          ?.systemPrompts?.filter((prompt) => prompt.includes("目标完成度裁判")),
      ).toHaveLength(0);
      expect(engine.getGoal(sessionId)?.objective).toBe(objective);
      expect(persistedState(dir, sessionId).activeGoal?.objective).toBe(objective);
      expect(persistedState(dir, sessionId).goalTerminal).toBeUndefined();
      expect(events.some((event) => event.type === "goal_progress" && event.status === "met")).toBe(
        false,
      );
      expect(
        events.some(
          (event) =>
            event.type === "assistant_message" &&
            typeof event.message.content === "string" &&
            event.message.content.includes("目标已保留"),
        ),
      ).toBe(true);
    } finally {
      engineScenarios.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("F7: a bounded long objective still reaches the judge through Engine", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-goal-bounded-objective-"));
    const model = uniqueModel("bounded-objective");
    const sessionId = "goal-bounded-objective-judges";
    const objective = `OBJECTIVE-HEAD-${"x".repeat(30_000)}-OBJECTIVE-TAIL`;
    engineScenarios.set(model, {
      mainResponses: [stopResponse("large goal is complete")],
      mainCalls: 0,
      judgeResponse: '{"met":true,"waiting":false,"gaps":""}',
    });

    try {
      const engine = new Engine({
        llm: { provider, model, apiKey: "test" } as never,
        cwd: dir,
        sessionStorageDir: join(dir, "sessions"),
        permissionMode: "bypassPermissions",
        headless: true,
      });
      (engine as any).hooks.clear();

      const result = await engine.run("finish the large goal", {
        sessionId,
        cwd: dir,
        goal: { objective },
      });

      expect(result.reason).toBe("completed");
      expect(result.goalTermination).toBeUndefined();
      expect(engineScenarios.get(model)?.mainCalls).toBe(1);
      expect(
        engineScenarios
          .get(model)
          ?.systemPrompts?.filter((prompt) => prompt.includes("目标完成度裁判")),
      ).toHaveLength(1);
      expect(persistedState(dir, sessionId).activeGoal).toBeUndefined();
      expect(persistedState(dir, sessionId).goalTerminal?.reason).toBe("completed");
    } finally {
      engineScenarios.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("F7 regression: a normal objective still reaches the judge through Engine", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-goal-normal-objective-"));
    const model = uniqueModel("normal-objective");
    const sessionId = "goal-normal-objective-judges";
    engineScenarios.set(model, {
      mainResponses: [stopResponse("normal goal is complete")],
      mainCalls: 0,
      judgeResponse: '{"met":true,"waiting":false,"gaps":""}',
    });

    try {
      const engine = new Engine({
        llm: { provider, model, apiKey: "test" } as never,
        cwd: dir,
        sessionStorageDir: join(dir, "sessions"),
        permissionMode: "bypassPermissions",
        headless: true,
      });
      (engine as any).hooks.clear();

      const result = await engine.run("finish the normal goal", {
        sessionId,
        cwd: dir,
        goal: { objective: "ship the normal release" },
      });

      expect(result.reason).toBe("completed");
      expect(result.goalTermination).toBeUndefined();
      expect(engineScenarios.get(model)?.mainCalls).toBe(1);
      expect(
        engineScenarios
          .get(model)
          ?.systemPrompts?.filter((prompt) => prompt.includes("目标完成度裁判")),
      ).toHaveLength(1);
    } finally {
      engineScenarios.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes goal judgment to primary even when a distinct auxText model is configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-goal-primary-judge-"));
    const primaryModel = uniqueModel("primary-judge");
    const auxModel = uniqueModel("aux-judge");
    const auxKey = "configured-aux";
    const sessionId = "goal-primary-judge";
    engineScenarios.set(primaryModel, {
      mainResponses: [stopResponse("quota checked")],
      mainCalls: 0,
      judgeResponse: '{"met":true,"waiting":false,"gaps":""}',
    });
    engineScenarios.set(auxModel, {
      mainResponses: [stopResponse("unused")],
      mainCalls: 0,
      judgeResponse: '{"met":false,"waiting":false,"gaps":"aux must not judge"}',
    });

    try {
      const engine = new Engine({
        llm: { provider, model: primaryModel, apiKey: "test" } as never,
        cwd: dir,
        sessionStorageDir: join(dir, "sessions"),
        permissionMode: "bypassPermissions",
        headless: true,
      });
      (engine as any).hooks.clear();
      (engine as any).modelPool.register({
        key: auxKey,
        provider,
        model: auxModel,
        apiKey: "test",
      });
      (engine as any).getSettingsManager = () => ({
        invalidate() {},
        get: () => ({ defaults: { auxText: auxKey } }),
      });

      const result = await engine.run("check quota", {
        sessionId,
        cwd: dir,
        goal: { objective: "finish after quota check", maxStopBlocks: 1 },
      });

      expect(result.reason).toBe("completed");
      expect(
        engineScenarios
          .get(primaryModel)
          ?.systemPrompts?.some((prompt) => prompt.includes("目标完成度裁判")),
      ).toBe(true);
      expect(
        engineScenarios
          .get(auxModel)
          ?.systemPrompts?.some((prompt) => prompt.includes("目标完成度裁判")),
      ).toBe(false);
      expect(engineScenarios.get(primaryModel)?.lastUsage).toMatchObject({
        totalPromptTokens: 11,
        totalCompletionTokens: 6,
        totalTokens: 17,
        requestCount: 2,
      });
      expect(persistedState(dir, sessionId).tokenUsage).toMatchObject({
        promptTokens: 12,
        completionTokens: 7,
        totalTokens: 19,
      });
    } finally {
      engineScenarios.delete(primaryModel);
      engineScenarios.delete(auxModel);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to arm a stale activeGoal that matches its terminal tombstone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-goal-terminal-guard-"));
    const model = uniqueModel("terminal-guard");
    const sessionId = "goal-terminal-guard";
    engineScenarios.set(model, {
      mainResponses: [stopResponse("plain response")],
      mainCalls: 0,
      judgeResponse: '{"met":false,"waiting":false,"gaps":"must not run"}',
    });

    try {
      const engine = new Engine({
        llm: { provider, model, apiKey: "test" } as never,
        cwd: dir,
        sessionStorageDir: join(dir, "sessions"),
        permissionMode: "bypassPermissions",
        headless: true,
      });
      (engine as any).hooks.clear();
      const { state } = (engine as any).sessionManager.create(dir, model, provider, sessionId);
      const staleGoal = { objective: "already exhausted", setAtMs: 42_000 };
      state.status = "completed";
      state.activeGoal = staleGoal;
      state.goalTerminal = {
        ...staleGoal,
        reason: "stop_blocks_exhausted",
        terminatedAtMs: 43_000,
      };
      // Reproduce a historical/foreign whole-state write without passing
      // through SessionManager.saveState's tombstone reconciliation.
      writeFileSync(
        join(dir, "sessions", sessionId, "state.json"),
        JSON.stringify(state, null, 2),
        "utf8",
      );

      const events: StreamEvent[] = [];
      const result = await engine.run("bare follow-up", {
        sessionId,
        cwd: dir,
        onStream: (event) => {
          events.push(event);
        },
      });

      expect(result.reason).toBe("completed");
      expect(engineScenarios.get(model)?.mainCalls).toBe(1);
      expect(events.some((event) => event.type === "goal_progress")).toBe(false);
      expect(persistedState(dir, sessionId).activeGoal).toBeUndefined();
      expect(persistedState(dir, sessionId).goalTerminal?.objective).toBe("already exhausted");
    } finally {
      engineScenarios.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clears a stop-block-exhausted goal and does not re-arm it on a bare send", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-goal-stop-exhausted-"));
    const model = uniqueModel("stop-exhausted");
    const sessionId = "goal-stop-exhausted-clears";
    engineScenarios.set(model, {
      mainResponses: [stopResponse("still working")],
      mainCalls: 0,
      judgeResponse: '{"met":false,"waiting":false,"gaps":"unfinished"}',
    });

    try {
      const engine = new Engine({
        llm: { provider, model, apiKey: "test" } as never,
        cwd: dir,
        sessionStorageDir: join(dir, "sessions"),
        permissionMode: "bypassPermissions",
        headless: true,
      });
      (engine as any).hooks.clear();

      const firstEvents: StreamEvent[] = [];
      const first = await engine.run("keep going", {
        sessionId,
        cwd: dir,
        goal: { objective: "finish the goal", maxStopBlocks: 1 },
        onStream: (event) => {
          firstEvents.push(event);
        },
      });

      expect(first.reason).toBe("completed");
      expect(
        firstEvents.some((event) => event.type === "goal_progress" && event.status === "exhausted"),
      ).toBe(true);
      expect(engine.getGoal(sessionId)).toBeUndefined();
      expect(persistedState(dir, sessionId).activeGoal).toBeUndefined();
      expect(persistedState(dir, sessionId).goalTerminal?.reason).toBe("stop_blocks_exhausted");

      const bareEvents: StreamEvent[] = [];
      await engine.run("plain follow-up", {
        sessionId,
        cwd: dir,
        onStream: (event) => {
          bareEvents.push(event);
        },
      });

      expect(engineScenarios.get(model)?.mainCalls).toBe(3);
      expect(bareEvents.some((event) => event.type === "goal_progress")).toBe(false);
    } finally {
      engineScenarios.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clears a token-budget-exhausted goal so a bare send stays out of goal mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-goal-budget-exhausted-"));
    const model = uniqueModel("budget-exhausted");
    const sessionId = "goal-budget-exhausted-clears";
    engineScenarios.set(model, {
      mainResponses: [stopResponse("over budget")],
      mainCalls: 0,
    });

    try {
      const engine = new Engine({
        llm: { provider, model, apiKey: "test" } as never,
        cwd: dir,
        sessionStorageDir: join(dir, "sessions"),
        permissionMode: "bypassPermissions",
        headless: true,
      });
      (engine as any).hooks.clear();

      const first = await engine.run("bounded work", {
        sessionId,
        cwd: dir,
        goal: { objective: "finish cheaply", tokenBudget: 10 },
      });

      expect(first.reason).toBe("goal_budget_exhausted");
      expect(engine.getGoal(sessionId)).toBeUndefined();
      expect(persistedState(dir, sessionId).goalTerminal?.reason).toBe("token_budget_exhausted");

      const bareEvents: StreamEvent[] = [];
      await engine.run("plain follow-up", {
        sessionId,
        cwd: dir,
        onStream: (event) => {
          bareEvents.push(event);
        },
      });
      expect(engineScenarios.get(model)?.mainCalls).toBe(2);
      expect(bareEvents.some((event) => event.type === "goal_progress")).toBe(false);
    } finally {
      engineScenarios.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("met:true judge crossing the token budget writes a tombstone instead of clearing as met", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-goal-met-budget-exhausted-"));
    const model = uniqueModel("met-budget-exhausted");
    const sessionId = "goal-met-budget-exhausted-tombstone";
    engineScenarios.set(model, {
      mainResponses: [stopResponse("looks complete")],
      mainCalls: 0,
      judgeResponse: '{"met":true,"waiting":false,"gaps":""}',
    });

    try {
      const engine = new Engine({
        llm: { provider, model, apiKey: "test" } as never,
        cwd: dir,
        sessionStorageDir: join(dir, "sessions"),
        permissionMode: "bypassPermissions",
        headless: true,
      });
      (engine as any).hooks.clear();

      const result = await engine.run("bounded completion", {
        sessionId,
        cwd: dir,
        goal: { objective: "finish within sixteen tokens", tokenBudget: 16 },
      });

      expect(result.reason).toBe("goal_budget_exhausted");
      expect(engineScenarios.get(model)?.mainCalls).toBe(1);
      expect(
        engineScenarios
          .get(model)
          ?.systemPrompts?.filter((prompt) => prompt.includes("目标完成度裁判")),
      ).toHaveLength(1);
      expect(engine.getGoal(sessionId)).toBeUndefined();
      expect(persistedState(dir, sessionId).activeGoal).toBeUndefined();
      expect(persistedState(dir, sessionId).goalTerminal).toMatchObject({
        objective: "finish within sixteen tokens",
        reason: "token_budget_exhausted",
      });
    } finally {
      engineScenarios.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clears a goal-mode max-turns termination", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-goal-max-turns-"));
    const model = uniqueModel("max-turns");
    const sessionId = "goal-max-turns-clears";
    engineScenarios.set(model, {
      mainResponses: [toolResponse({ id: "unknown-1", toolName: "UnknownTool", args: {} })],
      mainCalls: 0,
    });

    try {
      const engine = new Engine({
        llm: { provider, model, apiKey: "test" } as never,
        cwd: dir,
        sessionStorageDir: join(dir, "sessions"),
        permissionMode: "bypassPermissions",
        headless: true,
        maxTurns: 1,
      });
      (engine as any).hooks.clear();

      const result = await engine.run("one turn only", {
        sessionId,
        cwd: dir,
        goal: "finish within one turn",
      });

      expect(result.reason).toBe("max_turns");
      expect(engine.getGoal(sessionId)).toBeUndefined();
      expect(persistedState(dir, sessionId).goalTerminal?.reason).toBe("max_turns_exhausted");
    } finally {
      engineScenarios.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the active goal when waiting on finite background work", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-goal-waiting-"));
    const model = uniqueModel("waiting");
    const sessionId = "goal-waiting-retained";
    backgroundJobRegistry.start("finite-job", sessionId, "finite download");
    engineScenarios.set(model, {
      mainResponses: [stopResponse("download started")],
      mainCalls: 0,
      judgeResponse: '{"met":false,"waiting":true,"gaps":"waiting for download"}',
    });

    try {
      const engine = new Engine({
        llm: { provider, model, apiKey: "test" } as never,
        cwd: dir,
        sessionStorageDir: join(dir, "sessions"),
        permissionMode: "bypassPermissions",
        headless: false,
      });
      (engine as any).hooks.clear();

      const result = await engine.run("start the download", {
        sessionId,
        cwd: dir,
        goal: "finish after the download",
      });

      expect(result.reason).toBe("completed");
      expect(engine.getGoal(sessionId)?.objective).toBe("finish after the download");
      expect(persistedState(dir, sessionId).goalTerminal).toBeUndefined();
      expect(persistedState(dir, sessionId).goalLifecycle?.phase).toBe("waiting");
    } finally {
      engineScenarios.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not clear replacement goal B when run goal A terminates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-goal-replaced-during-run-"));
    const model = uniqueModel("replaced-during-run");
    const sessionId = "goal-a-termination-keeps-b";
    let engine!: Engine;
    engineScenarios.set(model, {
      mainResponses: [stopResponse("A is unfinished")],
      mainCalls: 0,
      judgeResponse: '{"met":false,"waiting":false,"gaps":"A remains"}',
      afterJudgeCall: () => {
        const live = (engine as any).activeRunSession;
        (engine as any).sessionManager.saveActiveGoal(
          live.state,
          { objective: "goal B", goalId: "goal-b", revision: 1, setAtMs: 9_999_999 },
          { replaceCurrent: true },
        );
      },
    });

    try {
      engine = new Engine({
        llm: { provider, model, apiKey: "test" } as never,
        cwd: dir,
        sessionStorageDir: join(dir, "sessions"),
        permissionMode: "bypassPermissions",
        headless: true,
      });
      (engine as any).hooks.clear();

      const result = await engine.run("work on A", {
        sessionId,
        cwd: dir,
        goal: { objective: "goal A", maxStopBlocks: 1 },
      });
      const state = persistedState(dir, sessionId);

      expect(result.reason).toBe("completed");
      expect(state.activeGoal).toMatchObject({ objective: "goal B", setAtMs: 9_999_999 });
      expect(state.goalTerminal).toBeUndefined();
    } finally {
      engineScenarios.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const scenario of ["judge-met", "complete_goal", "cancel_goal"] as const) {
    it(`${scenario} records run goal A terminal identity after live goal changes to B`, async () => {
      const dir = mkdtempSync(join(tmpdir(), `engine-goal-${scenario}-replaced-`));
      const model = uniqueModel(`${scenario}-replaced`);
      const sessionId = `${scenario}-records-a`;
      let engine!: Engine;
      let goalAId: string | undefined;
      const mainResponse =
        scenario === "judge-met"
          ? stopResponse("A is complete")
          : scenario === "complete_goal"
            ? toolResponse({
                id: "complete-a",
                toolName: COMPLETE_GOAL_TOOL_NAME,
                args: { summary: "done" },
              })
            : toolResponse({
                id: "cancel-a",
                toolName: CANCEL_GOAL_TOOL_NAME,
                args: { confirm: true, reason: "stop A" },
              });
      engineScenarios.set(model, {
        mainResponses: [mainResponse],
        mainCalls: 0,
        judgeResponse: '{"met":true,"waiting":false,"gaps":""}',
        [scenario === "judge-met" ? "afterJudgeCall" : "afterMainCall"]: () => {
          const live = (engine as any).activeRunSession;
          const lifecycle = live.state.goalLifecycle;
          goalAId = lifecycle ? goalConfigFromLifecycle(lifecycle).goalId : undefined;
          (engine as any).sessionManager.saveActiveGoal(
            live.state,
            { objective: "goal B", goalId: "goal-b", revision: 1, setAtMs: 9_999_999 },
            { replaceCurrent: true },
          );
        },
      });

      try {
        engine = new Engine({
          llm: { provider, model, apiKey: "test" } as never,
          cwd: dir,
          sessionStorageDir: join(dir, "sessions"),
          permissionMode: "bypassPermissions",
          headless: true,
        });
        (engine as any).hooks.clear();

        await engine.run("work on A", {
          sessionId,
          cwd: dir,
          goal: { objective: "goal A", maxStopBlocks: 1 },
        });

        const state = persistedState(dir, sessionId);
        expect(goalAId).toBeString();
        expect(state.activeGoal).toMatchObject({ objective: "goal B", goalId: "goal-b" });
        // V1 stores only the current lifecycle. A stale A completion is a
        // guarded no-op once B owns the slot, rather than an appended tombstone.
        expect(state.goalTerminals).toBeUndefined();
      } finally {
        engineScenarios.delete(model);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("complete_goal clears state.activeGoal so the next bare send cannot inherit it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-goal-complete-"));
    const model = uniqueModel("complete");
    const sessionId = "goal-complete-clears";
    engineScenarios.set(model, {
      mainResponses: [
        toolResponse({
          id: "complete-1",
          toolName: COMPLETE_GOAL_TOOL_NAME,
          args: { summary: "done" },
        }),
        stopResponse("plain follow-up"),
      ],
      mainCalls: 0,
    });

    try {
      const engine = new Engine({
        llm: { provider, model, apiKey: "test" } as never,
        cwd: dir,
        sessionStorageDir: join(dir, "sessions"),
        permissionMode: "bypassPermissions",
        headless: true,
      });
      (engine as any).hooks.clear();

      const result = await engine.run("finish this", {
        sessionId,
        cwd: dir,
        goal: "finish this goal",
      });

      expect(result.reason).toBe("completed");
      expect(engineScenarios.get(model)?.mainCalls).toBe(1);
      expect(engine.getGoal(sessionId)).toBeUndefined();
      expect(activeGoalFromState(dir, sessionId)).toBeUndefined();
      expect(persistedState(dir, sessionId).goalTerminal?.reason).toBe("completed");

      // Simulate a foreign stale writer restoring the just-completed goal, then
      // reload through a fresh Engine. The terminal identity must prevent a
      // resumed bare send from arming the completed goal again.
      const stale = persistedState(dir, sessionId);
      stale.activeGoal = {
        objective: "finish this goal",
        goalId: stale.goalTerminal?.goalId,
        setAtMs: stale.goalTerminal?.setAtMs,
      };
      writeFileSync(
        join(dir, "sessions", sessionId, "state.json"),
        JSON.stringify(stale, null, 2),
        "utf8",
      );
      const reloaded = new Engine({
        llm: { provider, model, apiKey: "test" } as never,
        cwd: dir,
        sessionStorageDir: join(dir, "sessions"),
        permissionMode: "bypassPermissions",
        headless: true,
      });
      (reloaded as any).hooks.clear();
      const followUpEvents: StreamEvent[] = [];
      await reloaded.run("plain follow-up", {
        sessionId,
        cwd: dir,
        onStream: (event) => {
          followUpEvents.push(event);
        },
      });
      expect(followUpEvents.some((event) => event.type === "goal_progress")).toBe(false);
      expect(activeGoalFromState(dir, sessionId)).toBeUndefined();
    } finally {
      engineScenarios.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("desktop workspace switch rebases the live revision before complete_goal persists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-goal-workspace-complete-"));
    const sessionsDir = join(dir, "sessions");
    const model = uniqueModel("workspace-complete");
    const sessionId = "goal-workspace-complete";
    const workspace = {
      root: join(dir, ".worktrees", "feature"),
      kind: "worktree" as const,
      worktree: {
        path: join(dir, ".worktrees", "feature"),
        branch: "worktree/feature",
        baseRef: "main",
        createdBy: "codeshell" as const,
      },
    };
    engineScenarios.set(model, {
      mainResponses: [
        toolResponse({
          id: "switch-workspace-1",
          toolName: "SwitchSessionWorkspace",
          args: { target: "feature" },
        }),
        toolResponse({
          id: "complete-after-switch-1",
          toolName: COMPLETE_GOAL_TOOL_NAME,
          args: { summary: "done after switching" },
        }),
      ],
      mainCalls: 0,
    });

    try {
      const engine = new Engine({
        llm: { provider, model, apiKey: "test" } as never,
        cwd: dir,
        sessionStorageDir: sessionsDir,
        permissionMode: "bypassPermissions",
        builtinToolHost: "desktop",
        capabilities: [TEST_WORKSPACE_CAPABILITY],
        workspaceBridge: {
          switch: async () => {
            // The desktop main-process bridge persists through its own
            // SessionManager before returning the selected workspace to the
            // worker that owns this live Engine bundle.
            engine.getSessionManager().setSessionWorkspace(sessionId, workspace);
            return workspace;
          },
        },
        headless: true,
      });
      (engine as any).hooks.clear();

      const result = await engine.run("switch and finish", {
        sessionId,
        cwd: dir,
        goal: "finish after switching workspace",
      });

      expect(result.reason).toBe("completed");
      expect(engineScenarios.get(model)?.mainCalls).toBe(2);
      const reloaded = persistedState(dir, sessionId);
      expect(reloaded.workspace).toEqual(workspace);
      expect(reloaded.activeGoal).toBeUndefined();
      expect(reloaded.goalTerminal).toMatchObject({
        objective: "finish after switching workspace",
        reason: "completed",
      });
      expect(reloaded.status).toBe("completed");
    } finally {
      engineScenarios.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("desktop workspace switch rebases the live revision before budget exhaustion persists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-goal-workspace-exhaust-"));
    const sessionsDir = join(dir, "sessions");
    const model = uniqueModel("workspace-exhaust");
    const sessionId = "goal-workspace-exhaust";
    const workspace = {
      root: join(dir, ".worktrees", "feature"),
      kind: "worktree" as const,
      worktree: {
        path: join(dir, ".worktrees", "feature"),
        branch: "worktree/feature",
        baseRef: "main",
        createdBy: "codeshell" as const,
      },
    };
    engineScenarios.set(model, {
      mainResponses: [
        toolResponse({
          id: "switch-workspace-before-exhaust-1",
          toolName: "SwitchSessionWorkspace",
          args: { target: "feature" },
        }),
        stopResponse("budget exhausted after switch"),
      ],
      mainCalls: 0,
    });

    try {
      const engine = new Engine({
        llm: { provider, model, apiKey: "test" } as never,
        cwd: dir,
        sessionStorageDir: sessionsDir,
        permissionMode: "bypassPermissions",
        builtinToolHost: "desktop",
        capabilities: [TEST_WORKSPACE_CAPABILITY],
        workspaceBridge: {
          switch: async () => {
            engine.getSessionManager().setSessionWorkspace(sessionId, workspace);
            return workspace;
          },
        },
        headless: true,
      });
      (engine as any).hooks.clear();

      const result = await engine.run("switch until budget ends", {
        sessionId,
        cwd: dir,
        goal: { objective: "finish within budget after switching", tokenBudget: 20 },
      });

      expect(result.reason).toBe("goal_budget_exhausted");
      const reloaded = persistedState(dir, sessionId);
      expect(reloaded.workspace).toEqual(workspace);
      expect(reloaded.activeGoal).toBeUndefined();
      expect(reloaded.goalTerminal).toMatchObject({
        objective: "finish within budget after switching",
        reason: "token_budget_exhausted",
      });
      expect(reloaded.status).toBe("goal_budget_exhausted");
    } finally {
      engineScenarios.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves the second turnSeq when a desktop workspace write advances disk revision", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-workspace-turn-seq-"));
    const sessionsDir = join(dir, "sessions");
    const model = uniqueModel("workspace-turn-seq");
    const sessionId = "workspace-turn-seq";
    const workspace = {
      root: join(dir, ".worktrees", "feature"),
      kind: "worktree" as const,
      worktree: {
        path: join(dir, ".worktrees", "feature"),
        branch: "worktree/feature",
        baseRef: "main",
        createdBy: "codeshell" as const,
      },
    };
    const engine = new Engine({
      llm: { provider, model, apiKey: "test" } as never,
      cwd: dir,
      sessionStorageDir: sessionsDir,
      permissionMode: "bypassPermissions",
      headless: true,
    });
    (engine as any).hooks.clear();
    engineScenarios.set(model, {
      mainResponses: [stopResponse("first turn"), stopResponse("second turn")],
      mainCalls: 0,
      afterMainCall: (callNumber) => {
        if (callNumber === 2) {
          // Mirrors the top-bar main-process SessionManager writing while the
          // worker still owns a live bundle whose turnSeq already advanced.
          engine.getSessionManager().setSessionWorkspace(sessionId, workspace);
        }
      },
    });

    try {
      await engine.run("first", { sessionId, cwd: dir });
      expect(persistedState(dir, sessionId).turnSeq).toBe(1);

      await engine.run("second", { sessionId, cwd: dir });

      const reloaded = persistedState(dir, sessionId);
      expect(reloaded.turnSeq).toBe(2);
      expect(reloaded.workspace).toEqual(workspace);
    } finally {
      engineScenarios.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("confirmed cancel_goal clears state.activeGoal so the next bare send cannot inherit it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-goal-cancel-"));
    const model = uniqueModel("cancel");
    const sessionId = "goal-cancel-clears";
    engineScenarios.set(model, {
      mainResponses: [
        toolResponse({
          id: "cancel-1",
          toolName: CANCEL_GOAL_TOOL_NAME,
          args: { confirm: true, reason: "user asked to stop" },
        }),
      ],
      mainCalls: 0,
    });

    try {
      const engine = new Engine({
        llm: { provider, model, apiKey: "test" } as never,
        cwd: dir,
        sessionStorageDir: join(dir, "sessions"),
        permissionMode: "bypassPermissions",
        headless: true,
      });
      (engine as any).hooks.clear();

      const result = await engine.run("stop this goal", {
        sessionId,
        cwd: dir,
        goal: "keep going until user cancels",
      });

      expect(result.reason).toBe("completed");
      expect(engineScenarios.get(model)?.mainCalls).toBe(1);
      expect(engine.getGoal(sessionId)).toBeUndefined();
      expect(activeGoalFromState(dir, sessionId)).toBeUndefined();
      expect(persistedState(dir, sessionId).goalTerminal?.reason).toBe("cancelled");
    } finally {
      engineScenarios.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
