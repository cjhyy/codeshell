import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { PetNoticeLedger } from "./pet-notice-ledger.js";
import {
  NOW,
  OWNER_DM,
  SID,
  boundRoute,
  cleanupNoticeEnv,
  env,
  harness,
  longTask,
  pause,
  resetNoticeEnv,
  session,
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

describe("rule watcher wiring", () => {
  test("a done draft reaches the router with the matched rules' attributes", async () => {
    current = harness();
    current.routes.push(boundRoute());
    await current.handler(SID, upsertArgs({ attention: "important" }));
    current.routes.length = 0;
    await current.handler(SID, upsertArgs({ channel: "lark" }));
    expect(current.wiring.ruleStore.activeForSession(SID)).toHaveLength(2);
    env.clock = NOW + 1_000;
    const events = [
      { type: "session_started", runId: "run-1", clientMessageId: "cm-1" },
      { type: "tool_use_start", toolCall: { id: "t1", toolName: "Bash", args: {} } },
      { type: "turn_complete", reason: "completed", text: "测试都过了", runId: "run-1" },
    ];
    for (const event of events) current.observeSessionEvent(SID, event);
    // The draft reaches the router before its publish (two ledger writes) and
    // the two rule spends land: wait for that work itself, not a timed poll.
    await settle(() => current!.submitted.length > 0);
    await current.idle();
    expect(current.submitted).toHaveLength(1);
    expect(current.submitted[0]).toMatchObject({
      kind: "session.done",
      sessionId: SID,
      attention: "always",
      channel: "lark",
      target: { kind: "route", route: { channel: "wechat", target: "chat-1" } },
      facts: { title: "修登录", summary: "测试都过了" },
    });
    expect(current.submitted[0]!.ruleIds).toHaveLength(2);
    // The route pins the channel: one message back to the bound WeChat conversation.
    expect(current.published).toHaveLength(1);
    expect(current.published[0]).toMatchObject({
      type: "pet.task.completed",
      title: "Mimi 任务已完成",
      text: "「修登录」做完了：测试都过了",
      target: { channel: "wechat", target: "chat-1" },
    });
    expect(current.published[0]!.deliveryKey).toMatch(/^[0-9a-f]{64}$/u);
    expect(current.wiring.ruleStore.activeForSession(SID)).toEqual([]);
  });

  test("a WeChat rule's result held for quiet hours is digested to WeChat, owner present", async () => {
    let present = false;
    current = harness({
      presence: {
        getSystemIdleTimeSec: () => (present ? 0 : 3_600),
        hasFocusedWindow: () => present,
      },
    });
    // 23:30 at UTC+0, inside the default 23:00–08:30 quiet hours.
    env.clock = Date.UTC(2026, 10, 9, 23, 30, 0);
    await current.handler(SID, upsertArgs({ channel: "wechat" }));
    env.clock += 1_000;
    for (const event of [
      { type: "session_started", runId: "run-1", clientMessageId: "cm-1" },
      { type: "tool_use_start", toolCall: { id: "t1", toolName: "Bash", args: {} } },
      { type: "turn_complete", reason: "completed", text: "测试都过了", runId: "run-1" },
    ])
      current.observeSessionEvent(SID, event);
    await settle(() => current!.wiring.ledger.held().length > 0);
    expect(current.ownerSends).toEqual([]);
    present = true;
    env.clock = Date.UTC(2026, 10, 10, 8, 30, 0);
    await current.wiring.router.flushDigest();
    expect(current.ownerSends).toHaveLength(1);
    expect(current.ownerSends[0]).toMatchObject({
      targetId: "wechat:owner",
      text: "你不在时：\n- 「修登录」做完了",
    });
    expect(current.desktop.map((input) => input.title)).toEqual(["Mimi：你不在时"]);
  });

  test("Sessions with a long task leave done to the closure notice", async () => {
    current = harness();
    current.tasks.push(longTask({ status: "running", completedAt: undefined, updatedAt: NOW }));
    await current.handler(SID, upsertArgs());
    env.clock = NOW + 1_000;
    for (const event of [
      { type: "session_started", runId: "run-1", clientMessageId: "cm-1" },
      { type: "tool_use_start", toolCall: { id: "t1", toolName: "Bash", args: {} } },
      { type: "turn_complete", reason: "completed", runId: "run-1" },
    ])
      current.observeSessionEvent(SID, event);
    await settle();
    expect(current.submitted).toEqual([]);
  });

  test("a closed long task owns only the run it closed", async () => {
    current = harness();
    current.tasks.push(longTask({ runId: "run-1", completedAt: NOW, updatedAt: NOW }));
    await current.handler(SID, upsertArgs());
    env.clock = NOW + 1_000;
    const turn = (runId: string) => [
      { type: "session_started", runId, clientMessageId: `cm-${runId}` },
      { type: "tool_use_start", toolCall: { id: "t1", toolName: "Bash", args: {} } },
      { type: "turn_complete", reason: "completed", runId },
    ];
    for (const event of turn("run-1")) current.observeSessionEvent(SID, event);
    await settle();
    expect(current.submitted).toEqual([]);
    // A later turn in the same Session is the owner's own work again.
    for (const event of turn("run-2")) current.observeSessionEvent(SID, event);
    await settle(() => current!.submitted.length > 0);
    expect(current.submitted.map((notice) => notice.dedupeKey)).toEqual([`${SID}:turn:run-2`]);
  });

  test("a pending decision nudges the decision module and never becomes a second prompt", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ events: ["blocked"] }));
    const nudged: string[] = [];
    current.wiring.decisions.onBlocked((sessionId) => nudged.push(sessionId));
    env.clock = NOW + 1_000;
    current.emitProjection({
      kind: "pending-upsert",
      pending: {
        agentSessionId: SID,
        requestId: "req-1",
        workerGeneration: 1,
        kind: "ask_user",
        title: "用哪个数据库？",
        createdAt: env.clock,
        status: "pending",
      } as never,
      version: 2,
      generation: 1,
      observedAt: env.clock,
    });
    await settle(() => nudged.length > 0);
    expect(nudged).toEqual([SID]);
    expect(current.submitted).toEqual([]);
  });
});

describe("startup", () => {
  test("a hanging resend during recovery does not hold up ready", async () => {
    // A young claim from before the restart that the outbox never took: recovery writes it now.
    const before = new PetNoticeLedger({
      path: join(env.dir, "pet", "notices.json"),
      now: () => env.clock,
    });
    const record = await before.record({
      kind: "session.done",
      priority: "P1",
      dedupeKey: "done:before-restart",
      ruleIds: [],
      facts: { title: "旧任务", target: { kind: "owner" } },
      body: "「旧任务」做完了",
      decision: { outlet: "im", im: "wechat", reason: "away-last-inbound" },
    });
    await before.claim(record.id, "wechat", "「旧任务」做完了");
    await before.flush();
    env.clock = NOW + 60_000;
    const attempts: string[] = [];
    current = harness({
      imTimeoutMs: 60_000,
      outbox: {
        publish: (event) => {
          attempts.push(event.text);
          return new Promise(() => undefined);
        },
        revoke: async () => undefined,
        state: () => undefined,
      },
    });
    const outcome = await Promise.race([
      current.wiring.ready.then(() => "ready"),
      pause(1_000).then(() => "blocked"),
    ]);
    expect(outcome).toBe("ready");
    await settle(() => attempts.length > 0);
    expect(attempts).toEqual(["「旧任务」做完了"]);
  });
});

describe("goal pauses", () => {
  test("a pause in an IM-delegated task is a reply in its conversation, like its prompts", async () => {
    current = harness();
    const route = { kind: "im-gateway" as const, channel: "lark", target: "chat-9" };
    const task = longTask({
      status: "running",
      completedAt: undefined,
      verificationMode: "goal",
      completionTarget: route,
    });
    current.tasks.push(task);
    await current.wiring.armDelegationRule(task);
    env.clock = NOW + 1_000;
    for (const event of [
      { type: "session_started", runId: "run-1", clientMessageId: "cm-1" },
      {
        type: "goal_progress",
        status: "not_met",
        goalId: "g-1",
        revision: 1,
        waitingForUser: "用哪个数据库？",
        runId: "run-1",
      },
    ])
      current.observeSessionEvent(SID, event);
    await settle(() => current!.published.length > 0);
    await current.idle();
    expect(current.submitted).toMatchObject([
      { kind: "session.blocked", reply: true, target: { kind: "route", route } },
    ]);
    expect(current.published).toMatchObject([{ target: { channel: "lark", target: "chat-9" } }]);
  });

  test("a cancelled Goal's queued and held pauses are never replayed or digested", async () => {
    current = harness();
    const TWO = "s-two";
    current.sessions.push(session(TWO));
    current.channels[0] = { ...current.channels[0]!, ready: "unavailable" };
    // SID: a named, unavailable WeChat queues the pause; TWO: digest attention holds it.
    await current.handler(
      SID,
      upsertArgs({ scope: "goal", events: ["blocked"], channel: "wechat" }),
    );
    await current.handler(TWO, upsertArgs({ sessionId: TWO, scope: "goal", events: ["blocked"] }));
    const [two] = current.wiring.ruleStore.activeForSession(TWO);
    await current.wiring.ruleStore.update(two!.id, two!.version, { attention: "digest" });
    env.clock = NOW + 1_000;
    for (const id of [SID, TWO])
      for (const event of [
        { type: "session_started", runId: `run-${id}`, clientMessageId: `cm-${id}` },
        {
          type: "goal_progress",
          status: "not_met",
          goalId: `g-${id}`,
          revision: 1,
          waitingForUser: "用哪个数据库？",
          runId: `run-${id}`,
        },
        { type: "turn_complete", reason: "completed", runId: `run-${id}` },
      ])
        current.observeSessionEvent(id, event);
    await settle(
      () =>
        current!.wiring.ledger.queued().length === 1 && current!.wiring.ledger.held().length === 1,
    );
    for (const id of [SID, TWO])
      current.observeSessionEvent(id, { type: "goal_cleared", goalId: `g-${id}` });
    await settle(
      () =>
        current!.wiring.ledger.queued().length === 0 && current!.wiring.ledger.held().length === 0,
    );
    expect(current.wiring.ledger.queued()).toEqual([]);
    expect(current.wiring.ledger.held()).toEqual([]);
    current.channels[0] = { ...current.channels[0]!, ready: "ready" };
    const replay = current.wiring.inboundReplay(OWNER_DM)!;
    expect(await replay.take()).toEqual([]);
    replay.finish();
    env.clock += 60 * 60_000;
    await current.wiring.router.flushDigest();
    expect(current.ownerSends).toEqual([]);
    expect(current.published).toEqual([]);
  });
});

describe("external runtime Sessions", () => {
  const CODEX = "s-codex";
  /** A desktop-run Codex Session: never in the worker projection. */
  function externalHarness(
    facts: { busy?: boolean; title?: string } = {},
    overrides: Parameters<typeof harness>[0] = {},
  ) {
    const state = { busy: false, title: "Codex 修登录", ...facts };
    const known = (id: string) =>
      id === CODEX
        ? { sessionId: id, runtime: "codex" as const, running: true, live: true, ...state }
        : undefined;
    return {
      state,
      harness: harness({
        externalSessions: { get: known, has: (id) => known(id) !== undefined },
        ...overrides,
      }),
    };
  }
  const turn = (runId: string, tools: string[] = ["Bash"]) => [
    { type: "session_started", runId, clientMessageId: `cm-${runId}` },
    ...tools.map((toolName) => ({
      type: "tool_use_start",
      toolCall: { id: `t-${runId}`, toolName, args: {} },
    })),
    { type: "turn_complete", reason: "completed", text: "测试都过了", runId },
  ];

  test("NotifyMe and the bell accept it; its done notice carries the catalog title", async () => {
    current = externalHarness().harness;
    expect(current.wiring.isEligibleSession(CODEX)).toBe(true);
    expect(current.wiring.isEligibleSession("s-ghost")).toBe(false);
    await current.handler(CODEX, upsertArgs({ sessionId: CODEX }));
    await expect(current.handler("s-ghost", upsertArgs({ sessionId: "s-ghost" }))).rejects.toThrow(
      "unknown work Session",
    );
    env.clock = NOW + 1_000;
    for (const event of turn("run-1")) current.observeSessionEvent(CODEX, event);
    await settle(() => current!.submitted.length > 0);
    expect(current.submitted).toMatchObject([
      { kind: "session.done", sessionId: CODEX, facts: { title: "Codex 修登录" } },
    ]);
  });

  test("queued work behind its turn carries the done to the follow-up turn", async () => {
    const external = externalHarness({ busy: true });
    current = external.harness;
    await current.handler(CODEX, upsertArgs({ sessionId: CODEX }));
    env.clock = NOW + 1_000;
    for (const event of turn("run-1")) current.observeSessionEvent(CODEX, event);
    await settle();
    expect(current.submitted).toEqual([]);
    external.state.busy = false;
    // The follow-up turn did nothing itself but reports the carried work.
    for (const event of turn("run-2", [])) current.observeSessionEvent(CODEX, event);
    await settle(() => current!.submitted.length > 0);
    expect(current.submitted.map((notice) => notice.dedupeKey)).toEqual([`${CODEX}:turn:run-2`]);
  });

  /** The worker goes away for good (the same loss a reclaimed worker reports). */
  const loseWorker = (target: Harness, gone: () => void) => {
    gone();
    target.setWorkerState("disconnected");
    target.emitProjection({ kind: "reset", version: 2, generation: 1, observedAt: env.clock });
  };

  test("a lost worker does not forget its open turn's work", async () => {
    let live = true;
    current = externalHarness({}, { hasLiveWorker: () => live }).harness;
    await current.handler(CODEX, upsertArgs({ sessionId: CODEX }));
    env.clock = NOW + 1_000;
    const [started, work, complete] = turn("run-1");
    current.observeSessionEvent(CODEX, started);
    current.observeSessionEvent(CODEX, work);
    loseWorker(current, () => (live = false));
    await settle();
    // The closing event names no run: only the kept turn knows its id and its work.
    current.observeSessionEvent(CODEX, { ...complete, runId: undefined });
    await settle(() => current!.submitted.length > 0);
    expect(current.submitted.map((notice) => notice.dedupeKey)).toEqual([`${CODEX}:turn:run-1`]);
  });

  test("a lost worker does not flush its parked report", async () => {
    let live = true;
    current = externalHarness({}, { hasLiveWorker: () => live }).harness;
    current.routes.push({ ...boundRoute(), sessionId: CODEX });
    await current.handler(CODEX, upsertArgs({ sessionId: CODEX, events: ["failed"] }));
    env.clock = NOW + 1_000;
    const [started, work] = turn("run-1");
    current.observeSessionEvent(CODEX, started);
    current.observeSessionEvent(CODEX, work);
    // A failure inside the run: its report waits for the bound reply at the close.
    current.observeSessionEvent(CODEX, { type: "error", error: "boom" });
    await settle();
    loseWorker(current, () => (live = false));
    await settle();
    // A native Session's parked report would go out now; the external run is still open.
    expect(current.submitted).toEqual([]);
    current.observeSessionEvent(CODEX, {
      type: "turn_complete",
      reason: "model_error",
      runId: "run-1",
    });
    await settle(() => current!.submitted.length > 0);
    await settle();
    expect(current.submitted.map((notice) => notice.dedupeKey)).toEqual([`${CODEX}:failed:run-1`]);
  });
});
