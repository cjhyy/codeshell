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

  test("a Session with an owner rule tells the owner, from the template", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ events: ["done", "failed", "blocked"] }));
    expect(await report(current)).toBe(1);
    expect(current.ownerSends).toEqual([
      { targetId: "wechat:owner", text: "「修登录」：登录接口改好了，正在跑测试" },
    ]);
  });

  test("a rule that only wants failures does not hear progress", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ events: ["failed"] }));
    expect(await report(current)).toBe(0);
    expect(current.outbox.events).toHaveLength(0);
  });

  test("nobody waiting: the report stays with Mimi", async () => {
    current = harness();
    await current.wiring.ruleStore.setSystemRule("all-sessions", { state: "active" });
    expect(await report(current)).toBe(0);
    expect(current.submitted).toHaveLength(0);
  });

  test("a bound conversation and an auto owner rule are one message there", async () => {
    current = harness();
    current.routes.push(boundRoute());
    await current.handler(SID, upsertArgs());
    expect(await report(current)).toBe(1);
    expect(current.ownerSends).toHaveLength(0);
    expect(current.published).toEqual([
      expect.objectContaining({
        text: "「修登录」：登录接口改好了，正在跑测试",
        target: { channel: "wechat", target: "chat-1" },
      }),
    ]);
  });

  test("quiet hours hold a report for the digest", async () => {
    current = harness();
    await current.handler(SID, upsertArgs());
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
    await current.handler(SID, upsertArgs());
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
