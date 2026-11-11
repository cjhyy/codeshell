import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  NOW,
  SID,
  boundRoute,
  cleanupNoticeEnv,
  env,
  harness,
  longTask,
  resetNoticeEnv,
  upsertArgs,
  type Harness,
} from "./test-utils/notice-wiring-harness.js";

let current: Harness | undefined;

beforeEach(resetNoticeEnv);

afterEach(async () => {
  await cleanupNoticeEnv(current);
  current = undefined;
});

const REPORT_ID = "0123456789abcdef0123456789abcdef";
const DAY = 24 * 60 * 60_000;
/** 23:30 UTC on the NOW day: inside the default 23:00–08:30 quiet hours (offset 0). */
const QUIET_NIGHT = Math.floor(NOW / DAY) * DAY + (23 * 60 + 30) * 60_000;
const LARK_CHAT = { kind: "im-gateway" as const, channel: "lark", target: "chat-9" };
const WATCHER = {
  kind: "im-gateway" as const,
  channel: "lark",
  target: "chat-3",
  senderId: "owner-3",
  isDirectMessage: true,
};

/** A WatchSession rule for the WATCHER conversation, as the host action arms it. */
async function watch(h: Harness): Promise<void> {
  await h.wiring.ruleStore.upsertSessionRule({
    sessionId: SID,
    createdBy: "watch-session",
    events: ["done", "failed", "blocked"],
    scope: "turn",
    channel: "lark",
    attention: "always",
    target: { kind: "route", route: WATCHER },
    origin: "user",
    armedAt: env.clock,
  });
}

async function report(
  h: Harness,
  extra: Partial<Parameters<Harness["wiring"]["notifySessionReport"]>[0]> = {},
): Promise<number> {
  const count = await h.wiring.notifySessionReport({
    sessionId: SID,
    reportId: REPORT_ID,
    message: "登录接口改好了，正在跑测试",
    ...extra,
  });
  await h.idle();
  return count;
}

describe("ReportToMimi goes through the delivery plan and the router", () => {
  test("an IM-started task's origin gets Mimi's update (with its media), once", async () => {
    current = harness();
    const task = longTask({ status: "running", completionTarget: LARK_CHAT });
    current.tasks.push(task);
    const composed = {
      text: "进展：登录接口好了，测试在跑。",
      button: { text: "看看", url: "https://example.com/pr/1" },
    };
    expect(await report(current, { task, composed })).toBe(1);
    expect(await report(current, { task, composed })).toBe(1);
    expect(current.submitted[0]).toMatchObject({
      kind: "session.report",
      priority: "P1",
      sessionId: SID,
      target: { kind: "route", route: LARK_CHAT },
      channel: "lark",
      body: "进展：登录接口好了，测试在跑。",
      media: { button: { text: "看看", url: "https://example.com/pr/1" } },
    });
    expect(current.submitted[0]!.reply).toBeUndefined();
    // The replayed report is a duplicate: one message reaches the conversation.
    expect(current.published).toEqual([
      expect.objectContaining({
        type: "pet.task.reported",
        title: "Mimi 工作更新",
        text: "进展：登录接口好了，测试在跑。",
        target: { channel: "lark", target: "chat-9" },
      }),
    ]);
  });

  test("a watching conversation gets the template", async () => {
    current = harness();
    await watch(current);
    expect(await report(current)).toBe(1);
    expect(current.submitted[0]).toMatchObject({
      target: { kind: "route", route: WATCHER },
      channel: "lark",
      facts: { title: "修登录", summary: "登录接口改好了，正在跑测试" },
    });
    expect(current.published).toEqual([
      expect.objectContaining({
        text: "「修登录」：登录接口改好了，正在跑测试",
        target: { channel: "lark", target: "chat-3" },
      }),
    ]);
    expect(current.ownerSends).toHaveLength(0);
  });

  test("a NotifyMe rule gets no milestone: the owner hears the outcome, not progress", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ events: ["done", "failed", "blocked"] }));
    expect(await report(current)).toBe(0);
    expect(current.outbox.events).toHaveLength(0);
    expect(current.desktop).toHaveLength(0);
  });

  test("a desktop-delegated task sends no IM message (nor a desktop one)", async () => {
    current = harness();
    const task = longTask({ status: "running" });
    current.tasks.push(task);
    await current.wiring.armDelegationRule(task);
    expect(await report(current, { task })).toBe(0);
    expect(current.outbox.events).toHaveLength(0);
    expect(current.desktop).toHaveLength(0);
  });

  test("a bound conversation gets no extra message (it already has the turn replies)", async () => {
    current = harness();
    current.routes.push(boundRoute());
    await current.handler(SID, upsertArgs());
    expect(await report(current)).toBe(0);
    expect(current.outbox.events).toHaveLength(0);
  });

  test("the all-sessions rule does not hear progress", async () => {
    current = harness();
    await current.wiring.ruleStore.setSystemRule("all-sessions", { state: "active" });
    expect(await report(current)).toBe(0);
    expect(current.submitted).toHaveLength(0);
  });

  test("a watch of the task's own origin is one message there", async () => {
    current = harness();
    const task = longTask({ status: "running", completionTarget: WATCHER });
    current.tasks.push(task);
    await watch(current);
    expect(await report(current, { task, composed: { text: "Mimi 的进展" } })).toBe(1);
    expect(current.published.map((event) => event.text)).toEqual(["Mimi 的进展"]);
  });

  test("a router that stopped taking notices is no delivery", async () => {
    current = harness();
    await watch(current);
    current.wiring.router.dispose();
    await expect(report(current)).rejects.toThrow("汇报未送出");
  });

  test("quiet hours hold a report for the digest", async () => {
    current = harness();
    await watch(current);
    env.clock = QUIET_NIGHT;
    await report(current);
    expect(current.outbox.events).toHaveLength(0);
    const [record] = current.wiring.ledger.held();
    expect(record).toMatchObject({
      kind: "session.report",
      decision: { outlet: "digest", reason: "quiet-hours" },
    });
  });

  test("a report does not hold back the Session's result (no merge window)", async () => {
    current = harness();
    await watch(current);
    await report(current);
    const decision = await current.wiring.submitNotice({
      kind: "session.done",
      priority: "P1",
      dedupeKey: `${SID}:turn:run-1`,
      sessionId: SID,
      ruleIds: [],
      facts: { title: "修登录", summary: "好了" },
      attention: "always",
      channel: "auto",
      target: { kind: "owner" },
    });
    expect(decision).toMatchObject({ outlet: "im", im: "wechat" });
    // A second report right after a result is merged into the digest.
    const merged = await current.wiring.notifySessionReport({
      sessionId: SID,
      reportId: "fedcba9876543210fedcba9876543210",
      message: "又有进展",
    });
    await current.idle();
    expect(merged).toBe(1);
    expect(
      current.wiring.ledger
        .held()
        .some(
          (record) =>
            record.kind === "session.report" && record.decision?.reason === "merge-window",
        ),
    ).toBe(true);
  });
});
