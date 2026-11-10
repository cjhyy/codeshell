import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { PetReusableSessionCandidate } from "./pet-dispatch-service.js";
import type { PetNoticeWiringDeps } from "./pet-notice-wiring.js";
import {
  createBoundSessionRunner,
  createSessionBridgeWiring,
  type SessionBridgeWiring,
} from "./session-bridge-wiring.js";
import {
  NOW,
  SID,
  boundRoute,
  cleanupNoticeEnv,
  env,
  harness,
  longTask,
  resetNoticeEnv,
  settle,
  upsertArgs,
  type Harness,
} from "./test-utils/notice-wiring-harness.js";

let current: Harness | undefined;

beforeEach(resetNoticeEnv);

afterEach(async () => {
  await cleanupNoticeEnv(current);
  current = undefined;
});

describe("bound Session replies", () => {
  const turn = (runId: string, extra: Record<string, unknown> = {}) => [
    { type: "session_started", runId, clientMessageId: `cm-${runId}` },
    { type: "tool_use_start", toolCall: { id: "t1", toolName: "Bash", args: {} } },
    { type: "turn_complete", reason: "completed", text: "改好了", runId, ...extra },
  ];

  test("a completion replied in the bound conversation is not sent again", async () => {
    current = harness();
    current.routes.push(boundRoute());
    await current.handler(SID, upsertArgs({ events: ["done"] }));
    env.clock = NOW + 1_000;
    for (const event of turn("run-1")) current.observeSessionEvent(SID, event);
    await settle(() => current!.desktop.length > 0);
    expect(current.submitted).toHaveLength(1);
    expect(current.submitted[0]!.boundReplyDelivered).toBe(true);
    // The session.reply (published by the bridge) is the one IM message.
    expect(current.published).toEqual([]);
    expect(current.ownerSends).toEqual([]);
    expect(current.desktop.map((input) => input.title)).toEqual(["Mimi 任务已完成"]);
    expect(current.wiring.ledger.byDedupeKey(`${SID}:turn:run-1`)?.decision).toEqual({
      outlet: "desktop",
      reason: "bound-reply-delivered",
    });
  });

  test("an owner-target done stays on IM when its rule names another channel", async () => {
    for (const [channel, suppressed] of [
      ["lark", false],
      ["auto", true],
    ] as const) {
      current?.wiring.dispose();
      current = harness({
        readSettings: () => ({ pet: { notifications: { mergeWindowSec: 0 } } }),
      });
      // Armed before the Session was bound: the rule addresses the owner.
      await current.handler(SID, upsertArgs({ events: ["done"], channel }));
      current.routes.push(boundRoute());
      env.clock = NOW + 1_000;
      for (const event of turn("run-1")) current.observeSessionEvent(SID, event);
      await settle(
        () => current!.submitted.length > 0 && (suppressed || current!.ownerSends.length > 0),
      );
      expect(current.submitted).toHaveLength(1);
      expect(current.submitted[0]!.target).toEqual({ kind: "owner" });
      expect(current.submitted[0]!.boundReplyDelivered === true).toBe(suppressed);
      expect(current.ownerSends.map((send) => send.targetId)).toEqual(
        suppressed ? [] : ["lark:owner"],
      );
    }
  });

  /** A goal-scope rule in a bound Session whose Goal was met mid-run: the report is parked. */
  async function parkGoalReport(overrides: Partial<PetNoticeWiringDeps> = {}): Promise<void> {
    current = harness({
      readSettings: () => ({ pet: { notifications: { mergeWindowSec: 0 } } }),
      ...overrides,
    });
    current.routes.push(boundRoute());
    await current.handler(SID, upsertArgs({ events: ["done"], scope: "goal" }));
    env.clock = NOW + 1_000;
    for (const event of [
      { type: "session_started", runId: "run-1", clientMessageId: "cm-1" },
      { type: "goal_progress", status: "met", goalId: "g-1", round: 1 },
    ])
      current.observeSessionEvent(SID, event);
    await settle();
    expect(current.submitted).toEqual([]);
  }
  const reset = () =>
    current!.emitProjection({ kind: "reset", version: 2, generation: 1, observedAt: env.clock });

  test("a missed snapshot is not a lost worker: the run closes and its reply serves it", async () => {
    await parkGoalReport({ hasLiveWorker: () => true });
    current!.setWorkerState("disconnected");
    reset();
    await settle();
    expect(current!.submitted).toEqual([]);
    current!.setWorkerState("active");
    reset();
    current!.observeSessionEvent(SID, {
      type: "turn_complete",
      reason: "completed",
      completionKind: "goal_control_stop",
      text: "目标完成",
      runId: "run-1",
    });
    await settle(() => current!.submitted.length > 0);
    await current!.idle();
    // Exactly one message: the Session's own reply in the bound chat.
    expect(current!.submitted.map((notice) => notice.boundReplyDelivered)).toEqual([true]);
    expect(current!.published).toEqual([]);
    expect(current!.ownerSends).toEqual([]);
  });

  test("a worker replaced after a missed snapshot sends the parked report", async () => {
    await parkGoalReport({ hasLiveWorker: () => true });
    current!.setWorkerState("disconnected");
    reset();
    await settle();
    expect(current!.submitted).toEqual([]);
    current!.setWorkerState("active", 2);
    reset();
    await settle(() => current!.published.length > 0);
    expect(current!.published).toMatchObject([{ type: "pet.task.completed" }]);
  });

  test("a report parked on a run the worker abandoned goes out when the worker is lost", async () => {
    current = harness({
      readSettings: () => ({ pet: { notifications: { mergeWindowSec: 0 } } }),
      hasLiveWorker: () => false,
    });
    current.routes.push(boundRoute());
    await current.handler(SID, upsertArgs({ events: ["done"], scope: "goal" }));
    env.clock = NOW + 1_000;
    for (const event of [
      { type: "session_started", runId: "run-1", clientMessageId: "cm-1" },
      { type: "goal_progress", status: "met", goalId: "g-1", round: 1 },
    ])
      current.observeSessionEvent(SID, event);
    await settle();
    expect(current.submitted).toEqual([]);
    // The aggregator reports a lost worker as a reset of a disconnected snapshot.
    current.setWorkerState("disconnected");
    current.emitProjection({ kind: "reset", version: 2, generation: 1, observedAt: env.clock });
    await settle(() => current!.published.length > 0);
    expect(
      current.submitted.map((notice) => [notice.dedupeKey, notice.boundReplyDelivered]),
    ).toEqual([[`${SID}:goal:g-1`, undefined]]);
    expect(current.published).toMatchObject([
      { type: "pet.task.completed", target: { channel: "wechat", target: "chat-1" } },
    ]);
  });

  test("shutdown sends parked reports before the router stops", async () => {
    current = harness({ readSettings: () => ({ pet: { notifications: { mergeWindowSec: 0 } } }) });
    current.routes.push(boundRoute());
    await current.handler(SID, upsertArgs({ events: ["done"], scope: "goal" }));
    env.clock = NOW + 1_000;
    for (const event of [
      { type: "session_started", runId: "run-1", clientMessageId: "cm-1" },
      { type: "goal_progress", status: "met", goalId: "g-1", round: 1 },
    ])
      current.observeSessionEvent(SID, event);
    await settle();
    const flushed = current.wiring.flush();
    current.wiring.dispose();
    await flushed;
    await settle(() => current!.published.length > 0);
    expect(current.published).toMatchObject([{ type: "pet.task.completed" }]);
  });

  test("a done without a core run id is served by the bound reply all the same", async () => {
    current = harness();
    current.routes.push(boundRoute());
    await current.handler(SID, upsertArgs({ events: ["done"] }));
    env.clock = NOW + 1_000;
    for (const event of [
      { type: "session_started", clientMessageId: "cm-x" },
      { type: "tool_use_start", toolCall: { id: "t1", toolName: "Bash", args: {} } },
      { type: "turn_complete", reason: "completed", text: "改好了", completedAt: env.clock },
    ])
      current.observeSessionEvent(SID, event);
    await settle(() => current!.submitted.length > 0);
    await current.idle();
    expect(current.submitted.map((notice) => notice.boundReplyDelivered)).toEqual([true]);
    expect(current.published).toEqual([]);
    expect(current.ownerSends).toEqual([]);
  });

  test("once the conversation no longer receives replies, the notice is sent there", async () => {
    current = harness({ readSettings: () => ({ pet: { notifications: { mergeWindowSec: 0 } } }) });
    current.routes.push(boundRoute());
    await current.handler(SID, upsertArgs({ events: ["done"] }));
    // The route is gone (the Session was rebound elsewhere / the route removed).
    current.routes.length = 0;
    env.clock = NOW + 1_000;
    for (const event of turn("run-1")) current.observeSessionEvent(SID, event);
    await settle(() => current!.published.length > 0);
    expect(current.submitted.map((notice) => notice.boundReplyDelivered)).toEqual([undefined]);
    expect(current.published).toMatchObject([
      { type: "pet.task.completed", target: { channel: "wechat", target: "chat-1" } },
    ]);
    current.routes.push(boundRoute());
    await current.handler(SID, upsertArgs({ events: ["failed"] }));
    current.routes.length = 0;
    env.clock = NOW + 2_000;
    for (const event of turn("run-2", { reason: "model_error" }))
      current.observeSessionEvent(SID, event);
    await settle(() => current!.published.length > 1);
    expect(current.published.map((event) => event.type)).toEqual([
      "pet.task.completed",
      "pet.task.failed",
    ]);
  });

  test("routes that cannot be read never swallow the notice", async () => {
    current = harness({
      sessionRoutes: () => ({
        notifyRoutesForSession: async () => {
          throw new Error("routes unreadable");
        },
      }),
    });
    await current.handler(SID, upsertArgs({ events: ["done"], channel: "wechat" }));
    env.clock = NOW + 1_000;
    for (const event of turn("run-1")) current.observeSessionEvent(SID, event);
    await settle(() => current!.ownerSends.length > 0);
    expect(current.submitted.map((notice) => notice.boundReplyDelivered)).toEqual([undefined]);
    expect(current.ownerSends).toHaveLength(1);
  });

  /**
   * The real bridge and the notice tap on one worker stream. Everything that
   * lands in the bound conversation is collected in `conversation`: the
   * bridge's session.reply and anything the notice router publishes to that
   * route. `tapFirst` is the order the two listeners were subscribed in; who
   * tells the conversation is decided by the delivery plan, so it must not matter.
   */
  function realBridge(tapFirst = true) {
    const listeners: Array<(line: string, entry?: { sessionId: string; event: unknown }) => void> =
      [];
    const worker = {
      requestWorker: async () => ({ ok: true }),
      injectWorkerMessage: () => undefined,
      subscribeOutbound: (listener: (typeof listeners)[number]) => {
        listeners.push(listener);
        return () => undefined;
      },
    };
    const replies: Array<{ text: string; target: { channel: string; target: string } }> = [];
    current = harness({ sessionRoutes: () => wiringRef?.routes });
    const h = current;
    const tap = (_line: string, entry?: { sessionId: string; event: unknown }) => {
      if (entry) h.observeSessionEvent(entry.sessionId, entry.event);
    };
    if (tapFirst) listeners.push(tap);
    const wiringRef: SessionBridgeWiring = createSessionBridgeWiring({
      routesFilePath: join(env.dir, "routes.json"),
      resolveSelector: async () =>
        ({
          sessionId: SID,
          workspacePath: "/repo",
          title: "修登录",
          updatedAt: NOW,
        }) as PetReusableSessionCandidate,
      directoryExists: async () => true,
      createRunner: (onTurn) =>
        createBoundSessionRunner(
          worker,
          { getSnapshot: () => ({ sessions: [] }), refreshCatalog: async () => undefined },
          onTurn,
        ),
      health: { check: async () => ({ ok: true }) },
      describeStatus: async () => "",
      publish: async (event) => {
        replies.push(event);
      },
      replyRoutes: (sessionId) => h.wiring.deliveries.replyRoutes(sessionId),
      now: () => env.clock,
    });
    if (!tapFirst) listeners.push(tap);
    const emit = (event: Record<string, unknown>) => {
      for (const listener of listeners) listener("", { sessionId: SID, event });
    };
    const bind = () =>
      wiringRef.sessionBindExecutor(
        { action: "enter", sessionSelector: "session-0123456789abcdef0123" },
        {
          completionTarget: { channel: "wechat", target: "chat-1" },
          senderId: "owner-1",
          isDirectMessage: true,
        },
      );
    /** Every message the bound conversation received, whoever sent it. */
    const conversation = () => [
      ...replies.map((event) => event.text),
      ...h.published
        .filter((event) => event.target.channel === "wechat" && event.target.target === "chat-1")
        .map((event) => event.text),
    ];
    return { h, emit, bind, replies, conversation };
  }

  test("a bound Session's done turn posts exactly once, whichever listener hears it first", async () => {
    for (const tapFirst of [true, false]) {
      current?.wiring.dispose();
      const { h, emit, bind, conversation } = realBridge(tapFirst);
      expect((await bind()).ok).toBe(true);
      await h.handler(SID, upsertArgs({ events: ["done"] }));
      env.clock = NOW + 1_000;
      // The notice ledger outlives the harness: a run id of its own per round.
      const runId = `run-${tapFirst ? "tap" : "bridge"}-first`;
      emit({ type: "session_started", runId, clientMessageId: "cm-1" });
      emit({ type: "tool_use_start", toolCall: { id: "t1", toolName: "Bash", args: {} } });
      emit({ type: "turn_complete", reason: "completed", text: "改好了", runId });
      await settle(() => h.desktop.length > 0 && conversation().length > 0);
      await settle();
      expect(conversation()).toEqual(["改好了"]);
      expect(h.ownerSends).toEqual([]);
      // The owner still gets the desktop record of the outcome.
      expect(h.desktop.map((input) => input.title)).toEqual(["Mimi 任务已完成"]);
    }
  });

  test("a goal met mid-run posts exactly once: the run's closing reply", async () => {
    const { h, emit, bind, conversation } = realBridge();
    expect((await bind()).ok).toBe(true);
    await h.handler(SID, upsertArgs({ events: ["done"], scope: "goal" }));
    env.clock = NOW + 1_000;
    emit({ type: "session_started", runId: "run-1", clientMessageId: "cm-1" });
    emit({ type: "tool_use_start", toolCall: { id: "t1", toolName: "Bash", args: {} } });
    emit({ type: "goal_progress", status: "met", goalId: "g-1", runId: "run-1" });
    // Whether the run forwards a reply is only known when it closes.
    await settle();
    expect(h.submitted).toEqual([]);
    emit({
      type: "turn_complete",
      reason: "completed",
      completionKind: "goal_control_stop",
      text: "目标完成",
      runId: "run-1",
    });
    await settle(() => h.submitted.length > 0 && conversation().length > 0);
    await settle();
    expect(conversation()).toEqual(["目标完成"]);
    expect(h.submitted.map((notice) => [notice.dedupeKey, notice.boundReplyDelivered])).toEqual([
      [`${SID}:goal:g-1`, true],
    ]);
    expect(h.ownerSends).toEqual([]);
  });

  test("a goal met mid-run whose run closes without text is told by the notice instead", async () => {
    const { h, emit, bind, replies, conversation } = realBridge();
    expect((await bind()).ok).toBe(true);
    await h.handler(SID, upsertArgs({ events: ["done"], scope: "goal" }));
    env.clock = NOW + 1_000;
    emit({ type: "session_started", runId: "run-1", clientMessageId: "cm-1" });
    emit({ type: "goal_progress", status: "met", goalId: "g-1", runId: "run-1" });
    emit({
      type: "turn_complete",
      reason: "completed",
      completionKind: "goal_control_stop",
      text: "",
      runId: "run-1",
    });
    await settle(() => conversation().length > 0);
    await settle();
    expect(replies).toEqual([]);
    expect(conversation()).toHaveLength(1);
    expect(h.published).toMatchObject([{ type: "pet.task.completed" }]);
    expect(h.submitted.map((notice) => notice.boundReplyDelivered)).toEqual([undefined]);
  });

  test("a bound Session's turn that ends with no text gets the templated notice in that chat", async () => {
    const { h, emit, bind, replies, conversation } = realBridge();
    expect((await bind()).ok).toBe(true);
    await h.handler(SID, upsertArgs({ events: ["done"] }));
    env.clock = NOW + 1_000;
    emit({ type: "session_started", runId: "run-1", clientMessageId: "cm-1" });
    emit({
      type: "assistant_message",
      message: { role: "assistant", content: [{ type: "text", text: "先看一下" }] },
    });
    emit({ type: "tool_use_start", toolCall: { id: "t1", toolName: "Bash", args: {} } });
    // An explicit empty answer: the bridge forwards nothing for this run.
    emit({ type: "turn_complete", reason: "completed", text: "", runId: "run-1" });
    await settle(() => conversation().length > 0);
    await settle();
    expect(replies).toEqual([]);
    expect(h.published).toMatchObject([
      { type: "pet.task.completed", target: { channel: "wechat", target: "chat-1" } },
    ]);
    expect(conversation()).toHaveLength(1);
    expect(h.submitted.map((notice) => notice.boundReplyDelivered)).toEqual([undefined]);
  });

  test("a failure that is not a model error and left no text gets the templated notice", async () => {
    const { h, emit, bind, replies, conversation } = realBridge();
    expect((await bind()).ok).toBe(true);
    await h.handler(SID, upsertArgs({ events: ["failed"] }));
    env.clock = NOW + 1_000;
    emit({ type: "session_started", runId: "run-1", clientMessageId: "cm-1" });
    emit({ type: "tool_use_start", toolCall: { id: "t1", toolName: "Bash", args: {} } });
    emit({ type: "turn_complete", reason: "max_turns", runId: "run-1" });
    await settle(() => conversation().length > 0);
    await settle();
    expect(replies).toEqual([]);
    expect(h.published).toMatchObject([
      { type: "pet.task.failed", target: { channel: "wechat", target: "chat-1" } },
    ]);
    expect(conversation()).toHaveLength(1);
  });

  test("a bound Session's failed turn posts once: the bridge's failure reply", async () => {
    const { h, emit, bind, conversation } = realBridge();
    expect((await bind()).ok).toBe(true);
    await h.handler(SID, upsertArgs({ events: ["failed"] }));
    env.clock = NOW + 1_000;
    emit({ type: "session_started", runId: "run-1", clientMessageId: "cm-1" });
    emit({ type: "tool_use_start", toolCall: { id: "t1", toolName: "Bash", args: {} } });
    emit({ type: "error", error: "model down", runId: "run-1" });
    emit({ type: "turn_complete", reason: "model_error", runId: "run-1" });
    await settle(() => h.submitted.length > 0 && conversation().length > 0);
    await settle();
    expect(conversation()).toEqual(["这个 Session 本轮执行失败，请在桌面端查看详情后重试。"]);
    expect(h.submitted.map((notice) => [notice.kind, notice.boundReplyDelivered])).toEqual([
      ["session.failed", true],
    ]);
    expect(h.ownerSends).toEqual([]);
  });

  test("a delegated task in a bound Session: Mimi's closure to its origin, the reply to the chat", async () => {
    const { h, emit, bind, conversation } = realBridge();
    expect((await bind()).ok).toBe(true);
    // Started from the desktop; the long task owns run-1.
    const task = longTask({ status: "running", runId: "run-1", completedAt: undefined });
    h.tasks.push(task);
    await h.wiring.armDelegationRule(task);
    env.clock = NOW + 1_000;
    emit({ type: "session_started", runId: "run-1", clientMessageId: "cm-1" });
    emit({ type: "tool_use_start", toolCall: { id: "t1", toolName: "Bash", args: {} } });
    emit({ type: "turn_complete", reason: "completed", text: "改好了", runId: "run-1" });
    await settle(() => conversation().length > 0);
    await settle();
    // The watcher leaves the run to the closure; only the Session's reply is out.
    expect(h.submitted).toEqual([]);
    expect(conversation()).toEqual(["改好了"]);
    Object.assign(task, { status: "completed", completedAt: env.clock });
    await h.wiring.notifyTaskClosed(task, { text: "登录修好了，可以验收。" });
    await settle(() => h.ownerSends.length > 0);
    expect(h.submitted.map((notice) => [notice.kind, notice.body, notice.target.kind])).toEqual([
      ["session.done", "登录修好了，可以验收。", "owner"],
    ]);
    expect(h.ownerSends.map((send) => send.text)).toEqual(["登录修好了，可以验收。"]);
    expect(conversation()).toEqual(["改好了"]);
  });
});
