import { describe, expect, test } from "bun:test";
import {
  createBoundSessionRunner,
  type BridgeAggregatorLike,
  type BridgeWorkerLike,
  type BoundSessionTurnResult,
} from "./session-bridge-wiring.js";

/**
 * These drive the REAL runner rather than a fake one.
 *
 * Every earlier test in this feature injected a stub BoundSessionRunner, so a
 * whole class of defect was invisible: the runner sent `message` where core's
 * agent/run requires `task`, which silently refused every delivery while the
 * suite stayed green. The wire shape is the contract, so it is asserted here.
 */

interface Call {
  method: string;
  params: Record<string, unknown>;
}

function harness(
  respond: (call: Call) => { ok: boolean; result?: unknown; message?: string } = () => ({
    ok: true,
  }),
  sessions: { agentSessionId: string; runState: string }[] = [
    { agentSessionId: "s-1", runState: "idle" },
  ],
) {
  const calls: Call[] = [];
  const turns: BoundSessionTurnResult[] = [];
  let tap: ((line: string, entry?: { sessionId: string; event: unknown }) => void) | undefined;
  const worker: BridgeWorkerLike = {
    requestWorker: async (method, params) => {
      calls.push({ method, params });
      return respond({ method, params });
    },
    subscribeOutbound: (listener) => {
      tap = listener;
      return () => {
        tap = undefined;
      };
    },
  };
  const aggregator: BridgeAggregatorLike = {
    getSnapshot: () => ({ sessions }),
    refreshCatalog: async () => undefined,
  };
  const runner = createBoundSessionRunner(worker, aggregator, (turn) => turns.push(turn));
  const emit = (sessionId: string, event: unknown) => tap?.("", { sessionId, event });
  return { runner, calls, turns, emit };
}

describe("the agent/run wire contract", () => {
  test("sends task, which is the field core actually requires", async () => {
    // Regression: sending `message` made core reject every turn at ingress
    // (protocol/server.ts runInputError), losing the user's text silently.
    const { runner, calls } = harness();
    await runner.run({ sessionId: "s-1", text: "继续修那个 bug", clientMessageId: "c-1" });
    const run = calls.find((call) => call.method === "agent/run");
    expect(run).toBeDefined();
    expect(run!.params.task).toBe("继续修那个 bug");
    expect(run!.params).not.toHaveProperty("message");
    expect(run!.params.sessionId).toBe("s-1");
    expect(run!.params.clientMessageId).toBe("c-1");
  });

  test("queueNextTurn uses the same correct field", async () => {
    const { runner, calls } = harness();
    await runner.queueNextTurn({ sessionId: "s-1", text: "later", clientMessageId: "c-2" });
    const queued = calls.find((call) => call.method === "agent/run");
    expect(queued!.params.task).toBe("later");
    expect(queued!.params).not.toHaveProperty("message");
  });
});

describe("run acceptance vs completion", () => {
  test("a long turn counts as started instead of waiting for it to finish", async () => {
    // agent/run resolves only at turn END. Awaiting it would blow the worker
    // timeout on any real Session and make the caller re-send.
    const { runner } = harness(() => ({ ok: true }));
    const started = await Promise.race([
      runner
        .run({ sessionId: "s-1", text: "long job", clientMessageId: "c-1" })
        .then((r) => r.started),
      new Promise((resolve) => setTimeout(() => resolve("timed-out"), 5_000)),
    ]);
    expect(started).toBe(true);
  });

  test("a genuinely refused run reports the reason", async () => {
    const { runner } = harness(() => ({ ok: false, message: "no such session" }));
    const result = await runner.run({ sessionId: "s-1", text: "x", clientMessageId: "c-1" });
    expect(result.started).toBe(false);
    expect(result.reason).toBe("no such session");
  });

  test("a queue that is refused throws instead of vanishing", async () => {
    // Silently swallowing this is what turned a dead worker into a lost message.
    const { runner } = harness(() => ({ ok: false, message: "worker gone" }));
    await expect(
      runner.queueNextTurn({ sessionId: "s-1", text: "x", clientMessageId: "c-1" }),
    ).rejects.toThrow(/worker gone/u);
  });
});

describe("observing the live stream", () => {
  test("a steer is confirmed only once the engine says it was injected", async () => {
    const { runner, emit } = harness();
    expect(runner.wasInjected("s-1", "steer-1")).toBe(false);
    emit("s-1", { type: "steer_injected", id: "steer-1", text: "hi" });
    expect(runner.wasInjected("s-1", "steer-1")).toBe(true);
    // Another session's steer never counts as this one's.
    expect(runner.wasInjected("s-2", "steer-1")).toBe(false);
  });

  test("runDone waits for the turn and resolves when it completes", async () => {
    const { runner, emit } = harness();
    emit("s-1", { type: "stream_request_start", turnNumber: 1 });
    expect(await runner.isRunning("s-1")).toBe(true);
    let settled = false;
    const done = runner.runDone("s-1").then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    emit("s-1", { type: "turn_complete", reason: "completed" });
    await done;
    expect(settled).toBe(true);
  });

  test("the turn's final assistant text is reported once", async () => {
    const { runner, turns, emit } = harness();
    emit("s-1", { type: "stream_request_start", turnNumber: 1 });
    emit("s-1", {
      type: "assistant_message",
      message: { role: "assistant", content: "第一步完成" },
    });
    emit("s-1", {
      type: "assistant_message",
      message: { role: "assistant", content: [{ type: "text", text: "已修复登录问题" }] },
    });
    expect(turns).toEqual([]);
    emit("s-1", { type: "turn_complete", reason: "completed" });
    expect(turns).toHaveLength(1);
    expect(turns[0]!.text).toBe("已修复登录问题");
    expect(turns[0]!.sessionId).toBe("s-1");
    void runner;
  });

  test("a turn that produced no text reports nothing", async () => {
    const { turns, emit } = harness();
    emit("s-1", { type: "stream_request_start", turnNumber: 1 });
    emit("s-1", { type: "turn_complete", reason: "completed" });
    expect(turns).toEqual([]);
  });

  test("tool output never reaches the conversation", async () => {
    const { turns, emit } = harness();
    emit("s-1", { type: "stream_request_start", turnNumber: 1 });
    emit("s-1", { type: "tool_use_start", toolCall: { name: "Read" } });
    emit("s-1", { type: "text_delta", text: "partial" });
    emit("s-1", {
      type: "assistant_message",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    });
    emit("s-1", { type: "turn_complete", reason: "completed" });
    expect(turns.map((turn) => turn.text)).toEqual(["done"]);
  });
});

describe("external runtimes", () => {
  test("a session missing from the projection is not steerable", () => {
    // codex / claude-code turns never pass through agent/run or agent/steer,
    // so the bridge must queue rather than attempt a steer that cannot work.
    const { runner } = harness(() => ({ ok: true }), []);
    expect(runner.supportsSteer("s-external")).toBe(false);
  });

  test("a native session in the projection is steerable", () => {
    const { runner } = harness(
      () => ({ ok: true }),
      [{ agentSessionId: "s-1", runState: "running" }],
    );
    expect(runner.supportsSteer("s-1")).toBe(true);
  });
});
