import { describe, it, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "./engine.js";
import { buildSessionTitle } from "./session-title.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { GoalConfig } from "./goal.js";
import type { LLMResponse, SessionState } from "../types.js";

function fakeClient(text: string, opts?: { throws?: boolean }): LLMClientBase {
  return {
    provider: "fake",
    model: "fake",
    createMessage: async () => {
      if (opts?.throws) throw new Error("boom");
      return {
        text,
        toolCalls: [],
        stopReason: "end_turn",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
    getUsage: () => ({
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
    }),
  } as unknown as LLMClientBase;
}

describe("buildSessionTitle", () => {
  it("returns a trimmed one-line title from the LLM", async () => {
    const usages: Array<NonNullable<LLMResponse["usage"]>> = [];
    const title = await buildSessionTitle(
      fakeClient("  修复登录超时问题  \n"),
      "帮我看看登录为什么会超时",
      "登录超时通常是因为...",
      (usage) => usages.push(usage),
    );
    expect(title).toBe("修复登录超时问题");
    expect(usages).toEqual([{ promptTokens: 1, completionTokens: 1, totalTokens: 2 }]);
  });

  it("strips surrounding quotes the model sometimes adds", async () => {
    const title = await buildSessionTitle(fakeClient('"配置热切换设计"'), "q", "a");
    expect(title).toBe("配置热切换设计");
  });

  it("strips surrounding curly quotes the model sometimes adds", async () => {
    const title = await buildSessionTitle(fakeClient("“配置热切换设计”"), "q", "a");
    expect(title).toBe("配置热切换设计");
  });

  it("returns null when the LLM throws (best-effort)", async () => {
    const title = await buildSessionTitle(fakeClient("x", { throws: true }), "q", "a");
    expect(title).toBeNull();
  });

  it("returns null when the model yields empty text", async () => {
    const title = await buildSessionTitle(fakeClient("   "), "q", "a");
    expect(title).toBeNull();
  });
});

const engineProvider = "fake-engine-session-title";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

interface EngineTitleScenario {
  responses: Array<LLMResponse | Error>;
  title: Deferred<string>;
  primaryCalls: number;
  primaryCallStarted?: (callNumber: number) => void;
  primaryGates?: Map<number, Promise<void>>;
}

const engineTitleScenarios = new Map<string, EngineTitleScenario>();

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FakeEngineTitleClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const scenario = engineTitleScenarios.get(this.model);
    if (!scenario) throw new Error(`missing title scenario: ${this.model}`);

    if (options.systemPrompt.startsWith("You generate a very short title")) {
      const text = await scenario.title.promise;
      return {
        text,
        toolCalls: [],
        stopReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    }

    const callNumber = scenario.primaryCalls++;
    scenario.primaryCallStarted?.(callNumber);
    await scenario.primaryGates?.get(callNumber);
    const response = scenario.responses.shift();
    if (!response) throw new Error(`missing primary response: ${this.model}`);
    if (response instanceof Error) throw response;
    this.recordUsage(
      response.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      options,
    );
    return response;
  }
}

registerProvider(engineProvider, FakeEngineTitleClient);

function primaryResponse(text: string): LLMResponse {
  return {
    text,
    toolCalls: [],
    stopReason: "stop",
    usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
  };
}

function toolResponse(id: string): LLMResponse {
  return {
    text: "",
    toolCalls: [{ id, toolName: "MissingTool", args: {} }],
    stopReason: "tool_use",
    usage: { promptTokens: 4, completionTokens: 1, totalTokens: 5 },
  };
}

function readState(storageDir: string, sessionId: string): SessionState {
  return JSON.parse(
    readFileSync(join(storageDir, sessionId, "state.json"), "utf-8"),
  ) as SessionState;
}

describe("Engine session title persistence", () => {
  it("merges a delayed title after a later serial session-state update", async () => {
    const root = mkdtempSync(join(tmpdir(), "engine-title-serial-"));
    const storageDir = join(root, "sessions");
    const sessionId = "title-serial-session";
    const model = `${engineProvider}-${Date.now()}-${Math.random()}`;
    const title = deferred<string>();
    engineTitleScenarios.set(model, {
      title,
      primaryCalls: 0,
      responses: [primaryResponse("run A answer")],
    });

    try {
      const engine = new Engine({
        llm: { provider: engineProvider, model, apiKey: "test" } as never,
        cwd: root,
        sessionStorageDir: storageDir,
        enabledBuiltinTools: [],
        headless: true,
        permissionMode: "bypassPermissions",
      });
      (engine as any).hooks.clear();
      let titlePersisted!: () => void;
      const persisted = new Promise<void>((resolve) => {
        titlePersisted = resolve;
      });

      await engine.run("first request", {
        sessionId,
        onStream: (event) => {
          if (event.type === "session_title") titlePersisted();
        },
      });

      // A has fully returned. Advance the same session serially before its
      // fire-and-forget title finishes; no second/concurrent run is involved.
      engine.getSessionManager().updateSessionState(sessionId, {
        status: "aborted_streaming",
        turnCount: 17,
      });

      title.resolve("serial late title");
      await persisted;

      const finalState = readState(storageDir, sessionId);
      expect(finalState.title).toBe("serial late title");
      expect(finalState.status).toBe("aborted_streaming");
      expect(finalState.turnCount).toBe(17);
    } finally {
      engineTitleScenarios.delete(model);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("merges a late title into the latest state without rolling back a later run", async () => {
    const root = mkdtempSync(join(tmpdir(), "engine-title-race-"));
    const storageDir = join(root, "sessions");
    const sessionId = "title-race-session";
    const model = `${engineProvider}-${Date.now()}-${Math.random()}`;
    const title = deferred<string>();
    const secondRunBlocked = deferred<void>();
    let secondRunReachedTurnTwo!: () => void;
    const reachedTurnTwo = new Promise<void>((resolve) => {
      secondRunReachedTurnTwo = resolve;
    });
    engineTitleScenarios.set(model, {
      title,
      primaryCalls: 0,
      primaryCallStarted: (callNumber) => {
        if (callNumber === 2) secondRunReachedTurnTwo();
      },
      primaryGates: new Map([[2, secondRunBlocked.promise]]),
      responses: [
        primaryResponse("run A answer"),
        toolResponse("run-b-1"),
        new Error("run B failed"),
      ],
    });

    try {
      const engine = new Engine({
        llm: { provider: engineProvider, model, apiKey: "test" } as never,
        cwd: root,
        sessionStorageDir: storageDir,
        enabledBuiltinTools: [],
        maxTurns: 2,
        headless: true,
        permissionMode: "bypassPermissions",
      });
      (engine as any).hooks.clear();
      let titlePersisted!: () => void;
      const persisted = new Promise<void>((resolve) => {
        titlePersisted = resolve;
      });
      const onStream = (event: { type: string }) => {
        if (event.type === "session_title") titlePersisted();
      };

      const runA = await engine.run("first request", { sessionId, onStream });
      expect(runA.reason).toBe("completed");

      const requestedGoal: GoalConfig = { objective: "run B goal" };
      const runBPromise = engine.run("second request", {
        sessionId,
        onStream,
        goal: requestedGoal,
      });
      await reachedTurnTwo;
      const runningB = readState(storageDir, sessionId);
      expect(runningB.status).toBe("active");
      expect(runningB.activeGoal?.objective).toBe(requestedGoal.objective);

      title.resolve("late title");
      await persisted;

      const afterLateTitle = readState(storageDir, sessionId);
      expect(afterLateTitle.title).toBe("late title");
      expect(afterLateTitle.status).toBe("active");
      expect(afterLateTitle.activeGoal).toEqual(runningB.activeGoal);

      secondRunBlocked.resolve();
      const runB = await runBPromise;
      expect(runB.reason).toBe("model_error");

      const finalState = readState(storageDir, sessionId);
      expect(finalState.title).toBe("late title");
      expect(finalState.status).toBe("model_error");
      expect(finalState.turnCount).toBe(2);
      expect(finalState.activeGoal).toEqual(runningB.activeGoal);
    } finally {
      engineTitleScenarios.delete(model);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists a title and folds its billed usage into the latest session state", async () => {
    const root = mkdtempSync(join(tmpdir(), "engine-title-normal-"));
    const storageDir = join(root, "sessions");
    const sessionId = "title-normal-session";
    const model = `${engineProvider}-${Date.now()}-${Math.random()}`;
    const title = deferred<string>();
    engineTitleScenarios.set(model, {
      title,
      primaryCalls: 0,
      responses: [primaryResponse("normal answer")],
    });

    try {
      const engine = new Engine({
        llm: { provider: engineProvider, model, apiKey: "test" } as never,
        cwd: root,
        sessionStorageDir: storageDir,
        enabledBuiltinTools: [],
        headless: true,
        permissionMode: "bypassPermissions",
      });
      (engine as any).hooks.clear();
      let titlePersisted!: () => void;
      const persisted = new Promise<void>((resolve) => {
        titlePersisted = resolve;
      });

      await engine.run("normal request", {
        sessionId,
        onStream: (event) => {
          if (event.type === "session_title") titlePersisted();
        },
      });
      const beforeTitle = readState(storageDir, sessionId);

      title.resolve("normal title");
      await persisted;

      const afterTitle = readState(storageDir, sessionId);
      expect(afterTitle.title).toBe("normal title");
      expect(afterTitle.status).toBe(beforeTitle.status);
      expect(afterTitle.turnCount).toBe(beforeTitle.turnCount);
      expect(afterTitle.tokenUsage).toEqual({
        ...beforeTitle.tokenUsage,
        promptTokens: beforeTitle.tokenUsage.promptTokens + 1,
        completionTokens: beforeTitle.tokenUsage.completionTokens + 1,
        totalTokens: beforeTitle.tokenUsage.totalTokens + 2,
      });
      expect(afterTitle.workspace).toEqual(beforeTitle.workspace);
      expect(afterTitle.activeGoal).toEqual(beforeTitle.activeGoal);
    } finally {
      engineTitleScenarios.delete(model);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
