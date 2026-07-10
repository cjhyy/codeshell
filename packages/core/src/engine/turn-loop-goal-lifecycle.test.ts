import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { HookResult } from "../hooks/events.js";
import type { LLMResponse, Message, StreamEvent, ToolCall, ToolResult } from "../types.js";
import { CANCEL_GOAL_TOOL_NAME } from "../tool-system/builtin/cancel-goal.js";
import { COMPLETE_GOAL_TOOL_NAME } from "../tool-system/builtin/complete-goal.js";
import { backgroundJobRegistry } from "../tool-system/builtin/background-jobs.js";
import { Engine } from "./engine.js";
import { TurnLoop, type TurnLoopConfig, type TurnLoopDeps } from "./turn-loop.js";

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

function makeTurnLoopDeps(
  responses: LLMResponse[],
  options: {
    hook?: (event: string) => Promise<HookResult> | HookResult;
    execute?: (call: ToolCall) => Promise<ToolResult>;
    clearPersistedGoal?: () => void;
  } = {},
): {
  deps: TurnLoopDeps;
  calls: Message[][];
  executedTools: ToolCall[];
} {
  let responseIndex = 0;
  const calls: Message[][] = [];
  const executedTools: ToolCall[] = [];
  const call = async (_systemPrompt: string, messages: Message[]): Promise<LLMResponse> => {
    calls.push(messages.map((message) => ({ ...message })));
    const response = responses[Math.min(responseIndex, responses.length - 1)]!;
    responseIndex++;
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
      async emit(event: string) {
        return options.hook ? options.hook(event) : {};
      },
    } as unknown as TurnLoopDeps["hooks"],
    transcript: {
      appendToolUse() {},
      appendToolResult() {},
      appendTurnBoundary() {},
      appendMessage() {},
    } as unknown as TurnLoopDeps["transcript"],
    systemPrompt: "system",
    tools: [],
    sessionId: "goal-loop-test",
    clearPersistedGoal: options.clearPersistedGoal,
    ctxOverheadStore: { get: () => 0, set: () => {} },
  };

  return { deps, calls, executedTools };
}

describe("TurnLoop goal lifecycle guardrails", () => {
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
      goal: { objective: "ship", tokenBudget: 100 },
      onStream: (event) => {
        events.push(event);
      },
    };

    const result = await new TurnLoop(deps, config).run([{ role: "user", content: "go" }]);

    expect(result.reason).toBe("goal_budget_exhausted");
    expect(result.goalTermination).toBe("token_budget_exhausted");
    expect(calls).toHaveLength(1);
    expect(executedTools).toHaveLength(0);
    expect(
      events.some(
        (event) =>
          event.type === "assistant_message" &&
          typeof event.message.content === "string" &&
          event.message.content.includes("Goal 预算已耗尽"),
      ),
    ).toBe(true);
  });

  it("forces a stop when the stop hook reaches maxStopBlocks, bounding continuations", async () => {
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
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "assistant_message" &&
          typeof event.message.content === "string" &&
          event.message.content.includes("Goal 续跑已达 2 次上限"),
      ),
    ).toBe(true);
  });
});

const provider = "fake-goal-lifecycle";
const engineScenarios = new Map<
  string,
  {
    mainResponses: LLMResponse[];
    mainCalls: number;
    judgeResponse?: string;
  }
>();

class GoalLifecycleClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const scenario = engineScenarios.get(this.model);
    if (!scenario) throw new Error(`missing fake goal lifecycle scenario: ${this.model}`);

    const isMainTurn = (options.tools?.length ?? 0) > 0;
    if (!isMainTurn) {
      return {
        text: scenario.judgeResponse ?? "aux",
        toolCalls: [],
        stopReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    }

    const response =
      scenario.mainResponses[Math.min(scenario.mainCalls, scenario.mainResponses.length - 1)]!;
    scenario.mainCalls++;
    this.recordUsage(
      response.usage ?? { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      options,
    );
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
  activeGoal?: { objective: string; setAtMs?: number };
  goalTerminal?: { objective: string; setAtMs?: number; reason: string };
} {
  const raw = readFileSync(join(dir, "sessions", sessionId, "state.json"), "utf8");
  return JSON.parse(raw);
}

afterEach(() => {
  backgroundJobRegistry.reset();
});

describe("Engine persisted goal lifecycle", () => {
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
        onStream: (event) => {
          if (event.type !== "goal_progress" || event.status !== "exhausted") return;
          const live = (engine as any).activeRunSession;
          live.state.activeGoal = { objective: "goal B", setAtMs: 9_999_999 };
          (engine as any).sessionManager.saveState(live.state);
        },
      });
      const state = persistedState(dir, sessionId);

      expect(result.reason).toBe("completed");
      expect(state.activeGoal).toEqual({ objective: "goal B", setAtMs: 9_999_999 });
      expect(state.goalTerminal?.objective).toBe("goal A");
      expect(state.goalTerminal?.reason).toBe("stop_blocks_exhausted");
    } finally {
      engineScenarios.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
    } finally {
      engineScenarios.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
