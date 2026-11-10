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
    // A young claim from before the restart, on an idempotent channel: recovery resends it.
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
      gateway: {
        ownerChannels: () => [
          { id: "wechat", label: "微信", ready: "ready", targetId: "wechat:owner", isDirect: true },
        ],
        listOwnerMessageTargets: () => [],
        sendOwnerMessage: (_targetId, text) => {
          attempts.push(text);
          return new Promise(() => undefined);
        },
        supportsIdempotentOwnerSend: () => true,
        lastOwnerInboundChannel: () => "wechat",
        isOwnerConversation: () => false,
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
