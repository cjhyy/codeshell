import { afterEach, describe, expect, it } from "bun:test";
import { AgentServer } from "./server.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import { ErrorCodes, Methods } from "./types.js";
import type { Engine, EngineResult, EngineRunOptions } from "../engine/engine.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(assertion: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(message);
}

function makeAskingEngine(sessionId: string, hold = false, consumeSteers = false) {
  const gate = deferred();
  if (!hold) gate.resolve();
  const state = {
    askUserAsync: undefined as ((question: string) => Promise<unknown>) | undefined,
    receipt: undefined as unknown,
    continued: false,
    active: false,
    runs: [] as Array<{ task: string; opts: EngineRunOptions }>,
    steers: [] as Array<{ sessionId: string; text: string; id: string; clientMessageId?: string }>,
    pendingSteers: new Map<string, string>(),
    unsteered: [] as string[],
    runGates: new Map<string, Promise<void>>(),
    followUpError: undefined as Error | undefined,
    resolveWorkspace: (): { cwd: string } | Promise<{ cwd: string }> => ({ cwd: "/tmp" }),
    release: gate.resolve,
  };
  const engine = {
    setAskUser() {},
    setAskUserAsync(fn: (question: string) => Promise<unknown>) {
      state.askUserAsync = fn;
    },
    setPlanMode() {},
    setBrowserBridge() {},
    setInjectCredential() {},
    setSessionMessageRouter() {},
    isHeadless: () => false,
    getGoal: () => undefined,
    resolveSessionRunWorkspace: () => state.resolveWorkspace(),
    enqueueSteer(sid: string, text: string, id: string, clientMessageId?: string) {
      if (!state.active || sid !== sessionId) return { accepted: false, id };
      state.steers.push({ sessionId: sid, text, id, clientMessageId });
      if (!consumeSteers) state.pendingSteers.set(id, text);
      return { accepted: true, id };
    },
    unsteer(_sid: string, id: string) {
      state.unsteered.push(id);
      return state.pendingSteers.delete(id);
    },
    async run(task: string, opts: EngineRunOptions): Promise<EngineResult> {
      state.runs.push({ task, opts });
      state.active = true;
      opts.onStream?.({
        type: "session_started",
        sessionId,
        promptTokens: 0,
        runId: `run-${state.runs.length}`,
        clientMessageId: opts.clientMessageId,
      });
      try {
        const runGate = state.runGates.get(task);
        if (runGate) await runGate;
        if (state.runs.length > 1 && state.followUpError) throw state.followUpError;
        if (state.runs.length === 1) {
          state.receipt = await state.askUserAsync!(`question for ${sessionId}`);
          state.continued = true;
          opts.signal?.addEventListener("abort", gate.resolve, { once: true });
          if (opts.signal?.aborted) gate.resolve();
          await gate.promise;
        }
        const reason = opts.signal?.aborted ? "aborted_streaming" : "completed";
        opts.onStream?.({ type: "turn_complete", reason });
        return {
          text: "continued",
          reason,
          sessionId,
          turnCount: 1,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      } finally {
        state.active = false;
      }
    },
  } as unknown as Engine;
  return { engine, state };
}

const servers: AgentServer[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});
let sequence = 0;

function fixture(
  options: { hold?: boolean; consumeSteers?: boolean; secondSession?: boolean } = {},
) {
  const sid = `async-question-${++sequence}`;
  const asking = makeAskingEngine(sid, options.hold, options.consumeSteers);
  const second = options.secondSession ? makeAskingEngine(`${sid}-other`) : undefined;
  const engines = [asking.engine, ...(second ? [second.engine] : [])];
  const manager = new ChatSessionManager({
    runtime: {} as never,
    idleTtlMs: 10,
    engineFactory: () => {
      const engine = engines.shift();
      if (!engine) throw new Error("unexpected session creation");
      return engine;
    },
  });
  const sent: any[] = [];
  let onMessage: (message: unknown) => void = () => {};
  const server = new AgentServer({
    chatManager: manager,
    transport: {
      send: (message: unknown) => sent.push(message),
      onMessage: (callback: (message: unknown) => void) => {
        onMessage = callback;
      },
      close() {},
    } as any,
  });
  servers.push(server);
  let rpcId = 0;
  const request = (method: string, params: Record<string, unknown>) => {
    const id = ++rpcId;
    onMessage({ jsonrpc: "2.0", id, method, params });
    return id;
  };
  const questions = () =>
    sent.filter(
      (message) =>
        message.method === Methods.ApprovalRequest &&
        message.params?.request?.toolName === "__ask_user__",
    );
  const run = (params: Record<string, unknown> = {}) =>
    request(Methods.Run, { sessionId: sid, task: "ask and keep working", ...params });
  const answer = (requestId: string, text = "use blue", sessionId = sid) =>
    request(Methods.Approve, { sessionId, requestId, decision: { approved: true, answer: text } });
  const ready = async () => {
    await waitFor(() => asking.state.continued, `async tool must return; ${JSON.stringify(sent)}`);
    return questions().find((message) => message.params.sessionId === sid)!;
  };
  return { sid, manager, sent, asking, second, request, run, answer, ready, questions };
}

describe("AgentServer asynchronous user questions", () => {
  it("returns immediately and keeps a question pending after the requesting run completes", async () => {
    const f = fixture();
    const runId = f.run();
    const question = await f.ready();
    await waitFor(
      () => f.sent.some((message) => message.id === runId && message.result),
      "run should complete without an answer",
    );
    expect(question.params.request.args.asynchronous).toBe(true);
    expect(f.manager.get(f.sid)!.isBusy()).toBe(false);
    expect(
      f.manager.get(f.sid)!.pendingApprovals.get(question.params.requestId)?.metadata,
    ).toMatchObject({
      kind: "ask_user",
      asynchronous: true,
      surfaceable: false,
    });
    expect(f.asking.state.runs).toHaveLength(1);
  });

  it("steers an answer into the running session without starting a duplicate turn", async () => {
    const f = fixture({ hold: true, consumeSteers: true });
    f.run();
    const question = await f.ready();
    const answerId = f.answer(question.params.requestId);
    await waitFor(() => f.asking.state.steers.length === 1, "answer should steer while running");
    expect(f.asking.state.steers[0]).toMatchObject({ sessionId: f.sid });
    expect(f.asking.state.steers[0]!.text).toContain("use blue");
    expect(f.asking.state.steers[0]!.text).toContain(`question for ${f.sid}`);
    expect(f.manager.get(f.sid)!.pendingApprovals.size).toBe(0);
    expect(f.sent.find((message) => message.id === answerId)?.result?.ok).toBe(true);
    f.asking.state.release();
    await f.manager.get(f.sid)!.settled;
    await waitFor(
      () => f.asking.state.unsteered.length === 1,
      "completed run should confirm consumption",
    );
    expect(f.asking.state.runs).toHaveLength(1);
  });

  it("keeps failed preflight retryable and only resolves the card after successful admission", async () => {
    const f = fixture();
    f.run();
    const question = await f.ready();
    await f.manager.get(f.sid)!.settled;
    f.asking.state.resolveWorkspace = () => {
      throw new Error("workspace is temporarily unavailable");
    };
    const failedId = f.answer(question.params.requestId, "keep this answer");
    await waitFor(
      () => f.sent.some((message) => message.id === failedId && message.error),
      "failed preflight must reject the submission",
    );
    expect(f.asking.state.runs).toHaveLength(1);
    expect(f.manager.get(f.sid)!.pendingApprovals.get(question.params.requestId)?.submitting).toBe(
      false,
    );
    expect(f.sent.some((message) => message.method === Methods.ApprovalResolved)).toBe(false);

    f.asking.state.resolveWorkspace = () => ({ cwd: "/tmp" });
    const retryId = f.answer(question.params.requestId, "keep this answer");
    await waitFor(
      () => f.sent.some((message) => message.id === retryId && message.result?.ok),
      "retry must acknowledge admission",
    );
    expect(f.asking.state.runs).toHaveLength(2);
    expect(f.manager.get(f.sid)!.pendingApprovals.size).toBe(0);
    expect(f.sent.filter((message) => message.method === Methods.ApprovalResolved)).toHaveLength(1);
  });

  it("deduplicates an in-flight answer and keeps the idle session alive during preflight", async () => {
    const f = fixture();
    f.run();
    const question = await f.ready();
    const session = f.manager.get(f.sid)!;
    await session.settled;
    const workspaceGate = deferred();
    f.asking.state.resolveWorkspace = async () => {
      await workspaceGate.promise;
      return { cwd: "/tmp" };
    };
    const answerId = f.answer(question.params.requestId);
    const duplicateId = f.answer(question.params.requestId);
    expect(f.sent.find((message) => message.id === duplicateId)?.error?.code).toBe(
      ErrorCodes.InvalidParams,
    );
    expect(f.sent.some((message) => message.id === answerId)).toBe(false);
    expect(f.sent.some((message) => message.method === Methods.ApprovalResolved)).toBe(false);
    session.lastActivityAt = Date.now() - 60_000;
    f.manager.sweepIdle();
    expect(f.manager.get(f.sid)).toBe(session);
    workspaceGate.resolve();
    await waitFor(
      () => f.sent.some((message) => message.id === answerId && message.result?.ok),
      "submission should complete after preflight",
    );
    expect(f.asking.state.runs).toHaveLength(2);
  });

  it("does not acknowledge or restart an answer cancelled during preflight", async () => {
    const f = fixture();
    f.run();
    const question = await f.ready();
    await f.manager.get(f.sid)!.settled;
    const workspaceGate = deferred();
    f.asking.state.resolveWorkspace = async () => {
      await workspaceGate.promise;
      return { cwd: "/tmp" };
    };
    const answerId = f.answer(question.params.requestId);
    f.request(Methods.Cancel, { sessionId: f.sid });
    workspaceGate.resolve();
    await waitFor(
      () => f.sent.some((message) => message.id === answerId && message.error),
      "cancelled submission must reject without an unhandled rejection",
    );
    expect(f.asking.state.runs).toHaveLength(1);
    expect(f.manager.get(f.sid)!.pendingApprovals.size).toBe(0);
    const resolved = f.sent.filter((message) => message.method === Methods.ApprovalResolved);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].params.approved).toBe(false);
  });

  it("queues an old answer behind a different run with original authority and acknowledges before that run ends", async () => {
    const f = fixture();
    f.run({ permissionMode: "plan", planMode: true, toolAllowlist: ["Read"] });
    const question = await f.ready();
    const session = f.manager.get(f.sid)!;
    await session.settled;
    const otherRun = deferred();
    f.asking.state.runGates.set("unrelated task", otherRun.promise);
    f.run({ task: "unrelated task", permissionMode: "bypassPermissions", planMode: false });
    await waitFor(() => f.asking.state.runs.length === 2, "new run should start");
    const answerId = f.answer(question.params.requestId, "answer for the original plan");
    await waitFor(
      () => f.sent.some((message) => message.id === answerId && message.result?.ok),
      "queued answer should be acknowledged before the unrelated run completes",
    );
    expect(f.asking.state.steers).toHaveLength(0);
    expect(f.asking.state.runs).toHaveLength(2);
    expect(session.queueDepth()).toBe(1);
    otherRun.resolve();
    await waitFor(() => f.asking.state.runs.length === 3, "original answer should run next");
    expect(f.asking.state.runs[2]!.opts).toMatchObject({
      permissionMode: "plan",
      planMode: true,
      toolAllowlist: ["Read"],
    });
  });

  it("keeps an admitted answer recoverable when its later run fails", async () => {
    const f = fixture();
    f.run();
    const question = await f.ready();
    await f.manager.get(f.sid)!.settled;
    f.asking.state.followUpError = new Error("model setup failed");
    const answerId = f.answer(question.params.requestId, "recoverable blue");
    await waitFor(
      () => f.sent.some((message) => message.id === answerId && message.result?.ok),
      "admission should acknowledge even if the later run fails",
    );
    await waitFor(
      () => f.sent.some((message) => message.params?.event?.error?.includes("recoverable blue")),
      "failure should retain the submitted answer for recovery",
    );
    expect(f.asking.state.runs).toHaveLength(2);
  });

  it("starts an idle follow-up with the requesting turn's permission and tool limits", async () => {
    const f = fixture();
    f.run({
      permissionMode: "plan",
      planMode: true,
      toolAllowlist: ["Read"],
      skillAllowlist: [],
      disableGoal: true,
      clientMessageId: "original-user-input",
    });
    const question = await f.ready();
    await f.manager.get(f.sid)!.settled;
    f.answer(question.params.requestId, "choose green");
    await waitFor(
      () => f.asking.state.runs.length === 2,
      "idle answer should start a continuation",
    );
    const continuation = f.asking.state.runs[1]!;
    expect(continuation.task).toContain("choose green");
    expect(continuation.opts).toMatchObject({
      permissionMode: "plan",
      planMode: true,
      toolAllowlist: ["Read"],
      skillAllowlist: [],
      disableGoal: true,
    });
    expect(continuation.opts.clientMessageId).not.toBe("original-user-input");
    expect(continuation.opts.approvalRouter).toBeDefined();
  });

  it("requeues an accepted steer if the run finishes before consuming it", async () => {
    const f = fixture({ hold: true });
    f.run();
    const question = await f.ready();
    f.answer(question.params.requestId, "late answer");
    await waitFor(
      () => f.asking.state.steers.length === 1,
      "answer should first be accepted as steer",
    );
    f.asking.state.release();
    await waitFor(
      () => f.asking.state.runs.length === 2,
      "unconsumed steer should become a follow-up",
    );
    expect(f.asking.state.pendingSteers.size).toBe(0);
    expect(f.asking.state.runs[1]!.task).toContain("late answer");
    expect(f.asking.state.runs[1]!.opts.clientMessageId).toBe(
      f.asking.state.steers[0]!.clientMessageId,
    );
  });

  it("rejects a mismatched session and accepts each answer only once", async () => {
    const f = fixture({ secondSession: true });
    f.run();
    f.run({ sessionId: `${f.sid}-other` });
    const question = await f.ready();
    await waitFor(() => f.questions().length === 2, "both sessions should have a question");
    const wrongId = f.answer(question.params.requestId, "wrong session", `${f.sid}-other`);
    expect(f.sent.find((message) => message.id === wrongId)?.error?.code).toBe(
      ErrorCodes.InvalidParams,
    );
    expect(f.manager.get(f.sid)!.pendingApprovals.size).toBe(1);
    f.answer(question.params.requestId, "right answer");
    const duplicateId = f.answer(question.params.requestId, "duplicate answer");
    expect(f.sent.find((message) => message.id === duplicateId)?.error?.code).toBe(
      ErrorCodes.InvalidParams,
    );
    await waitFor(() => f.asking.state.runs.length === 2, "only original session should resume");
    expect(f.second!.state.runs).toHaveLength(1);
    expect(f.manager.get(`${f.sid}-other`)!.pendingApprovals.size).toBe(1);
  });

  it("cancels outstanding questions without treating cancellation as an answer", async () => {
    const f = fixture();
    f.run();
    const question = await f.ready();
    await f.manager.get(f.sid)!.settled;
    f.request(Methods.Cancel, { sessionId: f.sid });
    expect(f.manager.get(f.sid)!.pendingApprovals.size).toBe(0);
    expect(
      f.sent.some(
        (message) =>
          message.method === Methods.ApprovalResolved &&
          message.params?.requestId === question.params.requestId,
      ),
    ).toBe(true);
    const answerId = f.answer(question.params.requestId, "too late");
    expect(f.sent.find((message) => message.id === answerId)?.error?.code).toBe(
      ErrorCodes.InvalidParams,
    );
    expect(f.asking.state.runs).toHaveLength(1);
    expect(f.asking.state.steers).toHaveLength(0);
  });

  it("closes a completed session's outstanding question without resuming it", async () => {
    const f = fixture();
    f.run();
    const question = await f.ready();
    await f.manager.get(f.sid)!.settled;
    const closeId = f.request(Methods.CloseSession, { sessionId: f.sid });
    await waitFor(
      () => f.sent.some((message) => message.id === closeId && message.result?.ok),
      "close should finish without waiting for an answer",
    );
    expect(f.manager.get(f.sid)).toBeUndefined();
    expect(
      f.sent.some(
        (message) =>
          message.method === Methods.ApprovalResolved &&
          message.params?.requestId === question.params.requestId,
      ),
    ).toBe(true);
    const lateId = f.answer(question.params.requestId, "answer after close");
    expect(f.sent.find((message) => message.id === lateId)?.error?.code).toBe(
      ErrorCodes.SessionClosed,
    );
    expect(f.asking.state.runs).toHaveLength(1);
  });

  it.each([
    { approved: false, reason: "declined" },
    { approved: true, answer: "   " },
  ])("does not continue without an actual answer: %j", async (decision) => {
    const f = fixture();
    f.run();
    const question = await f.ready();
    await f.manager.get(f.sid)!.settled;
    const answerId = f.request(Methods.Approve, {
      sessionId: f.sid,
      requestId: question.params.requestId,
      decision,
    });
    expect(f.manager.get(f.sid)!.pendingApprovals.size).toBe(decision.approved ? 1 : 0);
    if (decision.approved) {
      expect(f.sent.find((message) => message.id === answerId)?.error?.code).toBe(
        ErrorCodes.InvalidParams,
      );
    }
    expect(f.asking.state.runs).toHaveLength(1);
    expect(f.asking.state.steers).toHaveLength(0);
  });

  it("does not revive an unconsumed answer after Stop followed immediately by a new user turn", async () => {
    const f = fixture({ hold: true });
    f.run();
    const question = await f.ready();
    f.answer(question.params.requestId, "stale answer");
    await waitFor(() => f.asking.state.steers.length === 1, "answer should be queued as steer");
    const session = f.manager.get(f.sid)!;
    const oldEpoch = session.cancellationEpoch;
    f.request(Methods.Cancel, { sessionId: f.sid });
    f.run({ task: "new user task", clientMessageId: "new-user-input" });
    await waitFor(
      () => f.asking.state.runs.length === 2 && !session.isBusy(),
      "new user turn should finish",
    );
    expect(session.cancellationEpoch).toBeGreaterThan(oldEpoch);
    expect(session.wasCancelledSinceLastTurn()).toBe(false);
    expect(f.asking.state.runs.map((entry) => entry.task)).toEqual([
      "ask and keep working",
      "new user task",
    ]);
    expect(f.asking.state.pendingSteers.size).toBe(0);
  });

  it("keeps idle sessions resident while a question is pending and permits eviction after cancellation", async () => {
    const f = fixture();
    f.run();
    await f.ready();
    const session = f.manager.get(f.sid)!;
    await session.settled;
    session.lastActivityAt = Date.now() - 60_000;
    f.manager.sweepIdle();
    expect(f.manager.get(f.sid)).toBe(session);
    f.request(Methods.Cancel, { sessionId: f.sid });
    f.manager.sweepIdle();
    expect(f.manager.get(f.sid)).toBeUndefined();
  });
});
