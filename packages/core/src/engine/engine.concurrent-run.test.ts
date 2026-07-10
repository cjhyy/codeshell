import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Engine } from "./engine.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { LLMResponse, StreamEvent } from "../types.js";

const fakeProvider = "fake-engine-concurrent-run";

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function deferred(resolved = false): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  const result = { promise, resolve };
  if (resolved) resolve();
  return result;
}

type CallGate = {
  entered: Deferred;
  release: Deferred;
  text: string;
};

type Scenario = {
  calls: number;
  gates: CallGate[];
};

const scenarios = new Map<string, Scenario>();

class ConcurrentRunClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const scenario = scenarios.get(this.model);
    if (!scenario) throw new Error(`missing fake scenario: ${this.model}`);
    const gate = scenario.gates[scenario.calls];
    if (!gate) throw new Error(`unexpected model call ${scenario.calls + 1}`);
    scenario.calls++;
    gate.entered.resolve();
    await gate.release.promise;
    this.recordUsage({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }, options);
    return {
      text: gate.text,
      toolCalls: [],
      stopReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }
}

registerProvider(fakeProvider, ConcurrentRunClient);

function makeGate(text: string, released = false): CallGate {
  return { entered: deferred(), release: deferred(released), text };
}

function makeEngine(dir: string, model: string): Engine {
  const engine = new Engine({
    llm: { provider: fakeProvider, model, apiKey: "test" } as never,
    cwd: dir,
    sessionStorageDir: join(dir, "sessions"),
    enabledBuiltinTools: [],
    maxTurns: 2,
    headless: true,
    permissionMode: "bypassPermissions",
    settingsScope: "isolated",
  });
  (engine as any).hooks.clear();
  return engine;
}

describe("Engine.run concurrent re-entry guard", () => {
  it("rejects a second run without replacing the active run controls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-concurrent-run-"));
    const model = `${fakeProvider}-${Date.now()}-${Math.random()}`;
    const firstCall = makeGate("");
    scenarios.set(model, { calls: 0, gates: [firstCall] });
    let firstRun: ReturnType<Engine["run"]> | undefined;

    try {
      const engine = makeEngine(dir, model);
      firstRun = engine.run("first task", {
        sessionId: "session-first",
        cwd: dir,
        goal: "finish the first task",
      });
      await firstCall.entered.promise;

      const activeTurnLoop = (engine as any).activeTurnLoop;
      const activeRunSession = (engine as any).activeRunSession;
      const activeGoalHook = (engine as any).activeGoalHook;
      expect((engine as any).runInProgress).toBe(true);
      expect(activeTurnLoop).not.toBeNull();
      expect(activeRunSession.state.sessionId).toBe("session-first");
      expect(activeGoalHook).not.toBeNull();
      expect((engine as any).lastSessionId).toBe("session-first");

      const alreadyAborted = new AbortController();
      alreadyAborted.abort();
      await expect(
        engine.run("second task", {
          sessionId: "session-second",
          cwd: dir,
          signal: alreadyAborted.signal,
        }),
      ).rejects.toThrow("Engine.run() cannot start while another run is in progress");

      expect((engine as any).activeTurnLoop).toBe(activeTurnLoop);
      expect((engine as any).activeRunSession).toBe(activeRunSession);
      expect((engine as any).activeGoalHook).toBe(activeGoalHook);
      expect((engine as any).lastSessionId).toBe("session-first");
      expect(scenarios.get(model)?.calls).toBe(1);
      expect(existsSync(join(dir, "sessions", "session-second"))).toBe(false);

      expect(engine.enqueueSteer("session-second", "wrong run", "steer-second")).toEqual({
        accepted: false,
        id: "steer-second",
      });
      expect(engine.enqueueSteer("session-first", "right run", "steer-first")).toEqual({
        accepted: true,
        id: "steer-first",
      });
      expect(engine.unsteer("session-first", "steer-first")).toBe(true);

      expect(engine.clearGoal("session-second")).toBe(false);
      expect(engine.clearGoal("session-first")).toBe(true);
      expect(activeRunSession.state.activeGoal).toBeUndefined();
      expect((engine as any).activeGoalHook).toBeNull();
      expect((engine as any).activeTurnLoop).toBe(activeTurnLoop);

      firstCall.release.resolve();
      const result = await firstRun;
      expect(result.sessionId).toBe("session-first");
      expect(result.text).toBe("");
      expect((engine as any).runInProgress).toBe(false);
    } finally {
      firstCall.release.resolve();
      await firstRun?.catch(() => {});
      scenarios.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows sequential runs and resets active controls between them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-sequential-run-"));
    const model = `${fakeProvider}-${Date.now()}-${Math.random()}`;
    const firstCall = makeGate("");
    const secondCall = makeGate("");
    scenarios.set(model, { calls: 0, gates: [firstCall, secondCall] });
    let firstRun: ReturnType<Engine["run"]> | undefined;
    let secondRun: ReturnType<Engine["run"]> | undefined;

    try {
      const engine = makeEngine(dir, model);
      firstRun = engine.run("first task", { sessionId: "session-one", cwd: dir });
      await firstCall.entered.promise;
      expect((engine as any).runInProgress).toBe(true);
      expect((engine as any).activeRunSession.state.sessionId).toBe("session-one");
      expect((engine as any).lastSessionId).toBe("session-one");

      firstCall.release.resolve();
      const firstResult = await firstRun;
      expect(firstResult.text).toBe("");
      expect(scenarios.get(model)?.calls).toBe(1);
      expect((engine as any).activeTurnLoop).toBeNull();
      expect((engine as any).activeRunSession).toBeNull();
      expect((engine as any).activeGoalHook).toBeNull();
      expect((engine as any).runInProgress).toBe(false);

      secondRun = engine.run("second task", { sessionId: "session-two", cwd: dir });
      await secondCall.entered.promise;
      expect((engine as any).runInProgress).toBe(true);
      expect((engine as any).activeTurnLoop).not.toBeNull();
      expect((engine as any).activeRunSession.state.sessionId).toBe("session-two");
      expect((engine as any).lastSessionId).toBe("session-two");

      secondCall.release.resolve();
      const secondResult = await secondRun;
      expect(secondResult.text).toBe("");
      expect(secondResult.sessionId).toBe("session-two");
      expect((engine as any).activeTurnLoop).toBeNull();
      expect((engine as any).activeRunSession).toBeNull();
      expect((engine as any).activeGoalHook).toBeNull();
      expect((engine as any).runInProgress).toBe(false);
      expect((engine as any).lastSessionId).toBe("session-two");
    } finally {
      firstCall.release.resolve();
      secondCall.release.resolve();
      await firstRun?.catch(() => {});
      await secondRun?.catch(() => {});
      scenarios.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves the normal single-run lifecycle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-single-run-"));
    const model = `${fakeProvider}-${Date.now()}-${Math.random()}`;
    const call = makeGate("", true);
    const events: StreamEvent[] = [];
    scenarios.set(model, { calls: 0, gates: [call] });

    try {
      const engine = makeEngine(dir, model);
      const result = await engine.run("single task", {
        sessionId: "session-single",
        cwd: dir,
        onStream: (event) => events.push(event),
      });

      expect(result).toMatchObject({
        text: "",
        reason: "completed",
        sessionId: "session-single",
        turnCount: 1,
      });
      expect(events.some((event) => event.type === "session_started")).toBe(true);
      expect(
        events.some((event) => event.type === "turn_complete" && event.reason === "completed"),
      ).toBe(true);
      expect((engine as any).activeTurnLoop).toBeNull();
      expect((engine as any).activeRunSession).toBeNull();
      expect((engine as any).activeGoalHook).toBeNull();
      expect((engine as any).runInProgress).toBe(false);
      expect((engine as any).lastSessionId).toBe("session-single");
    } finally {
      call.release.resolve();
      scenarios.delete(model);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
