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
  id?: string;
  method: string;
  params: Record<string, unknown>;
}

function harness(
  respond: (call: Call) => { ok: boolean; result?: unknown; message?: string } | null = () => ({
    ok: true,
  }),
  sessions: { agentSessionId: string; runState: string }[] = [
    { agentSessionId: "s-1", runState: "idle" },
  ],
  onTurn?: (turn: BoundSessionTurnResult) => void | Promise<void>,
) {
  const calls: Call[] = [];
  const turns: BoundSessionTurnResult[] = [];
  const taps = new Set<(line: string, entry?: { sessionId: string; event: unknown }) => void>();
  const emitRaw = (message: unknown) => {
    const line = JSON.stringify(message);
    for (const tap of taps) tap(line);
  };
  const worker: BridgeWorkerLike = {
    requestWorker: async (method, params) => {
      calls.push({ method, params });
      return respond({ method, params }) ?? { ok: false, message: "no response" };
    },
    injectWorkerMessage: (line) => {
      const request = JSON.parse(line) as Call;
      calls.push(request);
      const response = respond(request);
      if (!response) return;
      emitRaw(
        response.ok
          ? {
              method: "agent/runAccepted",
              params: { requestId: request.id, sessionId: request.params.sessionId },
            }
          : { id: request.id, error: { message: response.message } },
      );
    },
    subscribeOutbound: (listener) => {
      taps.add(listener);
      return () => {
        taps.delete(listener);
      };
    },
  };
  const aggregator: BridgeAggregatorLike = {
    getSnapshot: () => ({ sessions }),
    refreshCatalog: async () => undefined,
  };
  const runner = createBoundSessionRunner(worker, aggregator, (turn) => {
    turns.push(turn);
    return onTurn?.(turn);
  });
  const emit = (sessionId: string, event: unknown) => {
    for (const tap of taps) tap("", { sessionId, event });
  };
  return { runner, calls, turns, emit, emitRaw };
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
    expect(run!.params.requireExisting).toBe(true);
  });

  test("queueNextTurn uses the same correct field", async () => {
    const { runner, calls } = harness();
    await runner.queueNextTurn({ sessionId: "s-1", text: "later", clientMessageId: "c-2" });
    const queued = calls.find((call) => call.method === "agent/run");
    expect(queued!.params.task).toBe("later");
    expect(queued!.params.requireExisting).toBe(true);
    expect(queued!.params).not.toHaveProperty("message");
  });
});

describe("run acceptance vs completion", () => {
  test("waits for the matching queue acknowledgement, without awaiting turn completion", async () => {
    const { runner, calls, emitRaw } = harness(() => null);
    let settled = false;
    const started = runner.run({ sessionId: "s-1", text: "long job", clientMessageId: "c-1" });
    void started.then(() => {
      settled = true;
    });
    emitRaw({
      method: "agent/runAccepted",
      params: { requestId: "another-request", sessionId: "s-1" },
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    emitRaw({ method: "agent/runAccepted", params: { requestId: calls[0]!.id, sessionId: "s-1" } });
    expect(await started).toEqual({ started: true });
    expect(await runner.isRunning("s-1")).toBe(true);
  });

  test("silence is rejected instead of being mistaken for a running turn", async () => {
    const { runner } = harness(() => null);
    const result = await runner.run({
      sessionId: "s-1",
      text: "lost input",
      clientMessageId: "c-1",
    });
    expect(result).toMatchObject({ started: false, reason: "worker did not acknowledge the run" });
    expect(await runner.isRunning("s-1")).toBe(false);
  }, 10_000);

  test("a refused queued successor does not settle the current turn", async () => {
    const { runner, emit } = harness(() => ({ ok: false, message: "queue refused" }));
    emit("s-1", { type: "session_started", runId: "active-run", clientMessageId: "active" });
    let finished = false;
    void runner.runDone("s-1").then(() => {
      finished = true;
    });
    await expect(
      runner.queueNextTurn({ sessionId: "s-1", text: "later", clientMessageId: "later" }),
    ).rejects.toThrow("queue refused");
    expect(finished).toBe(false);
    expect(await runner.isRunning("s-1")).toBe(true);
    emit("s-1", { type: "turn_complete", runId: "active-run", reason: "completed" });
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

  test("child events cannot finish the parent or become an IM reply", async () => {
    const { runner, turns, emit } = harness();
    emit("s-1", { type: "session_started", runId: "parent-run", clientMessageId: "parent-input" });
    let finished = false;
    void runner.runDone("s-1").then(() => {
      finished = true;
    });
    emit("s-1", {
      type: "assistant_message",
      agentId: "child-1",
      message: { role: "assistant", content: "child result" },
    });
    emit("s-1", {
      type: "turn_complete",
      agentId: "child-1",
      reason: "completed",
      text: "child result",
    });
    await Promise.resolve();
    expect(turns).toEqual([]);
    expect(finished).toBe(false);
    expect(await runner.isRunning("s-1")).toBe(true);
    emit("s-1", {
      type: "turn_complete",
      runId: "parent-run",
      reason: "completed",
      text: "parent answer",
    });
    expect(turns).toEqual([{ sessionId: "s-1", turnId: "parent-run", text: "parent answer" }]);
  });

  test("completion uses authoritative text and deduplicates its stable run identity", () => {
    const { turns, emit } = harness();
    emit("s-1", { type: "session_started", runId: "run-1", clientMessageId: "input-1" });
    emit("s-1", {
      type: "assistant_message",
      message: { role: "assistant", content: "intermediate progress" },
    });
    const final = {
      type: "turn_complete",
      runId: "run-1",
      reason: "completed",
      text: "final answer",
    };
    emit("s-1", final);
    emit("s-1", final);
    expect(turns).toEqual([{ sessionId: "s-1", turnId: "run-1", text: "final answer" }]);
  });

  test("failed publication can retry the same completion instead of being marked delivered", async () => {
    let attempts = 0;
    const { turns, emit } = harness(undefined, undefined, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("outbox unavailable");
    });
    const final = {
      type: "turn_complete",
      runId: "retry-run",
      reason: "completed",
      text: "answer",
    };
    emit("s-1", final);
    await Promise.resolve();
    await Promise.resolve();
    emit("s-1", final);
    emit("s-1", final);
    await Promise.resolve();
    await Promise.resolve();
    emit("s-1", final);
    expect(attempts).toBe(2);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.turnId).toBe(turns[1]!.turnId);
  });

  test("a failed or stopped turn reports its status without leaking raw errors or progress", () => {
    const { turns, emit } = harness();
    for (const reason of ["model_error", "aborted_streaming"]) {
      emit("s-1", { type: "session_started", runId: reason });
      emit("s-1", {
        type: "assistant_message",
        message: { role: "assistant", content: "intermediate progress" },
      });
      emit("s-1", { type: "error", error: "private provider details" });
      emit("s-1", { type: "turn_complete", runId: reason, reason });
    }
    expect(turns).toHaveLength(2);
    expect(turns[0]!.text).toContain("执行失败");
    expect(turns[1]!.text).toContain("已停止");
    expect(turns.some((turn) => /private|intermediate/.test(turn.text))).toBe(false);
  });

  test("an empty final answer does not send an earlier progress update", () => {
    const { turns, emit } = harness();
    emit("s-1", { type: "session_started", runId: "run-empty" });
    emit("s-1", { type: "assistant_message", message: { role: "assistant", content: "checking" } });
    emit("s-1", { type: "turn_complete", runId: "run-empty", reason: "completed", text: "" });
    expect(turns).toEqual([]);
  });

  test("a late completion from an old run cannot settle a successor", async () => {
    const { runner, emit } = harness();
    emit("s-1", { type: "session_started", runId: "old-run", clientMessageId: "old-input" });
    emit("s-1", {
      type: "turn_complete",
      runId: "old-run",
      reason: "completed",
      text: "old answer",
    });
    emit("s-1", { type: "session_started", runId: "new-run", clientMessageId: "new-input" });
    emit("s-1", {
      type: "turn_complete",
      runId: "old-run",
      reason: "completed",
      text: "old answer",
    });
    expect(await runner.isRunning("s-1")).toBe(true);
    emit("s-1", {
      type: "turn_complete",
      runId: "new-run",
      reason: "completed",
      text: "new answer",
    });
    expect(await runner.isRunning("s-1")).toBe(false);
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
