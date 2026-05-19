/**
 * Drift verification — confirms that the protocol-layer side effects
 * apply through `createInProcessClient`, no matter which caller uses it.
 *
 * Three behaviors that previously diverged between REPL (used protocol)
 * and EngineRunner/run.ts (called engine.run directly):
 *
 *   1. taskManager.setStreamCallback is wired during the run so
 *      TaskCreate/TaskUpdate produce task_update events on the stream.
 *   2. The server's `running` lock rejects a concurrent client.run with
 *      `AlreadyRunning`.
 *   3. Status notifications (status: "running" → "ready") are broadcast.
 *
 * These tests use a mock Engine (no real LLM) so they're fast and
 * deterministic. The Engine surface they need is just `run(...)` and
 * `setAskUser(...)` — both are part of the public Engine API.
 */
import { test, expect } from "bun:test";
import { taskManager } from "../../src/tool-system/builtin/task.js";
import { createInProcessClient } from "../../src/protocol/helpers.js";
import type { Engine } from "../../src/engine/engine.js";
import type { StreamCallback } from "../../src/types.js";

/**
 * Minimal Engine stand-in. Records the onStream callback so each test can
 * pump synthetic events through it (simulating tool calls emitting
 * stream events that would normally flow up from a real LLM turn).
 */
function makeMockEngine(opts: {
  onRun?: (onStream: StreamCallback | undefined) => Promise<void>;
} = {}): Engine {
  const engine = {
    setAskUser: () => {},
    run: async (
      _task: string,
      runOpts: { onStream?: StreamCallback; sessionId?: string; signal?: AbortSignal },
    ) => {
      if (opts.onRun) await opts.onRun(runOpts.onStream);
      return {
        text: "ok",
        reason: "completed" as const,
        sessionId: runOpts.sessionId ?? "test-sid",
        turnCount: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
  } as unknown as Engine;
  return engine;
}

test("taskManager events surface through client.onStreamEvent when running via createInProcessClient", async () => {
  const events: Array<{ type: string }> = [];
  const onStream: StreamCallback = (event) => {
    events.push({ type: event.type });
  };

  const engine = makeMockEngine({
    onRun: async () => {
      // Simulate a TaskCreate tool firing during the turn.
      taskManager.reset();
      taskManager.create("test subject", "test description");
    },
  });

  const { client, close } = createInProcessClient(engine, { onStream });
  try {
    await client.run("test task");
  } finally {
    close();
    taskManager.setStreamCallback(undefined);
    taskManager.reset();
  }

  expect(events.some((e) => e.type === "task_update")).toBe(true);
});

test("concurrent client.run on the same server rejects with AlreadyRunning", async () => {
  let releaseFirst: () => void = () => {};
  let firstRunStarted: () => void = () => {};
  const firstRunStartedPromise = new Promise<void>((r) => {
    firstRunStarted = r;
  });
  const releasePromise = new Promise<void>((r) => {
    releaseFirst = r;
  });

  const engine = makeMockEngine({
    onRun: async () => {
      firstRunStarted();
      await releasePromise;
    },
  });

  const { client, close } = createInProcessClient(engine);
  try {
    // First run blocks inside engine.run until releaseFirst() is called.
    const firstPromise = client.run("first");
    await firstRunStartedPromise;

    // Second run should bounce off the running lock immediately.
    let secondError: Error | null = null;
    try {
      await client.run("second");
    } catch (err) {
      secondError = err as Error;
    }

    expect(secondError).not.toBe(null);
    expect(secondError?.message).toContain("Agent is already running");

    releaseFirst();
    await firstPromise;
  } finally {
    close();
  }
});

test("status notifications fire on client.run lifecycle", async () => {
  const statusUpdates: string[] = [];
  const engine = makeMockEngine();
  const { client, close } = createInProcessClient(engine);

  client.onStatus((status: string) => {
    statusUpdates.push(status);
  });

  try {
    await client.run("test");
  } finally {
    close();
  }

  // Expected sequence:
  //   "ready"     — server constructor's initial notify
  //   "running"   — handleRun sets state at start
  //   "ready"     — handleRun finally restores state
  //   "shutdown"  — close() last notify before transport.close
  expect(statusUpdates).toContain("running");
  expect(statusUpdates.filter((s) => s === "ready").length).toBeGreaterThanOrEqual(1);
  expect(statusUpdates).toContain("shutdown");
});
