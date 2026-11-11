import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CronJob, CronScheduler } from "@cjhyy/code-shell-core/internal";
import { createPetFollowUpRules } from "./pet-follow-up-rules.js";
import {
  createFollowUpNotifier,
  FOLLOW_UP_MIN_DELIVERY_MS,
  followUpNotice,
  type FollowUpNoticeSource,
} from "./pet-notice-follow-up.js";
import { DEFAULT_MAX_P0_PER_HOUR } from "./pet-notice-policy.js";
import { ruleScheduleKey } from "./pet-rule-schedule.js";
import {
  NOW,
  SID,
  cleanupNoticeEnv,
  env,
  harness,
  resetNoticeEnv,
  type Harness,
} from "./test-utils/notice-wiring-harness.js";

let current: Harness | undefined;

beforeEach(resetNoticeEnv);

afterEach(async () => {
  await cleanupNoticeEnv(current);
  current = undefined;
});

const DAY = 24 * 60 * 60_000;
/** 23:30 UTC on the NOW day: inside the default 23:00–08:30 quiet hours (offset 0). */
const QUIET_NIGHT = Math.floor(NOW / DAY) * DAY + (23 * 60 + 30) * 60_000;
const ROUTE = { kind: "im-gateway" as const, channel: "lark", target: "chat-7", senderId: "me" };

const RULE = "rule-00000000-0000-4000-8000-000000000001";

function followUp(extra: Partial<FollowUpNoticeSource> = {}): FollowUpNoticeSource {
  return { title: "看一下发布", catchUpUntil: env.clock + DAY, ...extra };
}

const KEY = ruleScheduleKey(RULE, 1, NOW);

async function remind(
  h: Harness,
  item = followUp(),
  text = "检查 0.10.1 的发布结果",
): Promise<void> {
  await createFollowUpNotifier({ submit: h.wiring.submitNotice, now: () => env.clock })(
    item,
    text,
    KEY,
  );
  await h.idle();
}

describe("follow-up reminders go through the notice router", () => {
  test("away, without an IM origin: the owner's last IM gets it, once", async () => {
    current = harness();
    await remind(current);
    expect(current.submitted).toHaveLength(1);
    expect(current.submitted[0]).toMatchObject({
      kind: "followup.due",
      priority: "P1",
      dedupeKey: KEY,
      channel: "auto",
      target: { kind: "owner" },
      body: "「看一下发布」：检查 0.10.1 的发布结果",
    });
    expect(current.ownerSends).toEqual([
      { targetId: "wechat:owner", text: "「看一下发布」：检查 0.10.1 的发布结果" },
    ]);
    expect(current.outbox.events[0]).toMatchObject({ title: "Mimi 跟进提醒" });
    // Not a second message from anywhere else: the desktop stays quiet while away.
    expect(current.desktop).toHaveLength(0);
  });

  test("present, without an IM origin: only the desktop (via the router's outlet)", async () => {
    current = harness({
      presence: { getSystemIdleTimeSec: () => 0, hasFocusedWindow: () => true },
    });
    await remind(current);
    expect(current.outbox.events).toHaveLength(0);
    // Shown as the owner wrote it: their title, their text.
    expect(current.desktop).toEqual([
      expect.objectContaining({ title: "看一下发布", body: "检查 0.10.1 的发布结果" }),
    ]);
  });

  test("with an IM origin: back to that conversation, with a desktop record", async () => {
    current = harness({
      presence: { getSystemIdleTimeSec: () => 0, hasFocusedWindow: () => true },
    });
    await remind(current, followUp({ completionTarget: ROUTE }));
    expect(current.published).toEqual([
      expect.objectContaining({
        type: "pet.task.reported",
        text: "「看一下发布」：检查 0.10.1 的发布结果",
        target: { channel: "lark", target: "chat-7" },
      }),
    ]);
    expect(current.desktop).toHaveLength(1);
  });

  test("quiet hours do not hold a reminder the owner timed (a result would wait)", async () => {
    current = harness();
    env.clock = QUIET_NIGHT;
    await remind(current, followUp());
    expect(current.ownerSends).toHaveLength(1);
    // Control: a plain result at the same moment goes to the digest.
    const result = await current.wiring.submitNotice({
      kind: "session.done",
      priority: "P1",
      dedupeKey: "s:turn:run-1",
      sessionId: SID,
      ruleIds: [],
      facts: { title: "修登录" },
      attention: "always",
      channel: "auto",
      target: { kind: "owner" },
    });
    expect(result).toMatchObject({ outlet: "digest", reason: "quiet-hours" });
  });

  test("its outbox expiry is the catch-up deadline, not the next quiet-hours start", async () => {
    current = harness();
    // 22:50: quiet hours begin in 10 minutes; a P1 result would expire then.
    env.clock = QUIET_NIGHT - 40 * 60_000;
    await remind(current, followUp({ catchUpUntil: env.clock + 20 * 60_000 }));
    expect(current.outbox.events[0]?.expiresAt).toBe(env.clock + 20 * 60_000);
  });

  test("a tight catch-up window still leaves a minimum delivery window", () => {
    const notice = followUpNotice(followUp({ catchUpUntil: env.clock }), "x", KEY, env.clock);
    expect(notice.expiresAt).toBe(env.clock + FOLLOW_UP_MIN_DELIVERY_MS);
  });

  test("the same wake is one reminder, also after a restart", async () => {
    current = harness();
    await remind(current);
    current.wiring.dispose();
    await current.wiring.flush();
    current = harness();
    await remind(current);
    expect(current.ownerSends).toHaveLength(0);
    expect(current.outbox.events).toHaveLength(0);
  });

  const capped = () =>
    harness({
      readSettings: () => ({ pet: { notifications: { maxPerHour: 1, maxP0PerHour: 2 } } }),
    });
  const due = (n: number) =>
    createFollowUpNotifier({ submit: current!.wiring.submitNotice, now: () => env.clock })(
      followUp(),
      `第 ${n} 条`,
      ruleScheduleKey(`rule-00000000-0000-4000-8000-00000000000${n}`, 1, NOW),
    );

  test("it skips the P1/P2 cap but shares the P0 backstop", async () => {
    current = capped();
    expect(DEFAULT_MAX_P0_PER_HOUR).toBeGreaterThan(2);
    for (const n of [1, 2, 3]) await due(n);
    await current.idle();
    // Two over IM despite maxPerHour 1; the third is over the P0 backstop.
    expect(current.ownerSends.map((send) => send.text)).toEqual([
      "「看一下发布」：第 1 条",
      "「看一下发布」：第 2 条",
    ]);
    const third = current.wiring.ledger.byDedupeKey(
      ruleScheduleKey("rule-00000000-0000-4000-8000-000000000003", 1, NOW),
    );
    expect(third?.decision).toMatchObject({ outlet: "digest", reason: "p0-cap" });
    // Held by the backstop, it is still shown on the desktop right away.
    expect(current.desktop.map((entry) => entry.body)).toEqual(["第 3 条"]);
  });

  test("a follow-up held by the backstop goes out the next hour, even in quiet hours", async () => {
    current = capped();
    env.clock = QUIET_NIGHT;
    for (const n of [1, 2, 3]) await due(n);
    // A result in the same quiet night waits for the morning.
    await current.wiring.submitNotice({
      kind: "session.done",
      priority: "P1",
      dedupeKey: "s:turn:run-9",
      ruleIds: [],
      facts: { title: "修登录" },
      attention: "always",
      channel: "auto",
      target: { kind: "owner" },
    });
    await current.idle();
    expect(current.ownerSends).toHaveLength(2);
    // Still this hour: the P0 backstop is full, nothing more goes out.
    await current.wiring.router.flushDigest();
    await current.idle();
    expect(current.ownerSends).toHaveLength(2);
    // Next hour, still quiet hours: the held follow-up goes out with its text.
    env.clock = QUIET_NIGHT + 60 * 60_000;
    await current.wiring.router.flushDigest();
    await current.idle();
    expect(current.ownerSends.map((send) => send.text)).toEqual([
      "「看一下发布」：第 1 条",
      "「看一下发布」：第 2 条",
      "到点的跟进：\n- 「看一下发布」：第 3 条",
    ]);
    expect(current.wiring.ledger.held().map((record) => record.kind)).toEqual(["session.done"]);
  });

  test("held follow-ups and held results are separate digests", async () => {
    current = capped();
    // 20:13, so the next hour is not yet quiet hours.
    env.clock = NOW - 2 * 60 * 60_000;
    for (const n of [1, 2, 3]) await due(n);
    await current.wiring.submitNotice({
      kind: "session.done",
      priority: "P1",
      dedupeKey: "s:turn:run-9",
      ruleIds: [],
      facts: { title: "修登录" },
      attention: "digest",
      channel: "auto",
      target: { kind: "owner" },
    });
    env.clock += 60 * 60_000;
    await current.wiring.router.flushDigest();
    await current.idle();
    expect(
      current.ownerSends
        .slice(2)
        .map((send) => send.text)
        .sort(),
    ).toEqual(["你不在时：\n- 「修登录」做完了", "到点的跟进：\n- 「看一下发布」：第 3 条"]);
  });
});

describe("a follow-up rule coming due", () => {
  /** Register through the host action, as Mimi's ManageFollowUp does, then let it fire. */
  async function wakeOnce(h: Harness, context: Record<string, unknown> = {}) {
    const jobs: CronJob[] = [];
    const runtime = await createPetFollowUpRules({
      rules: h.wiring.ruleStore,
      sessions: () => [],
      summaryStore: {
        load: async () => undefined,
        get: () => undefined,
        set: () => undefined,
        flush: async () => undefined,
      },
      summaryService: { summarize: async () => null },
      inbox: {
        getSnapshot: () => ({ revision: 0, dismissedIds: [] }),
        addIfAbsentDurably: async () => ({
          added: false,
          snapshot: { revision: 0, dismissedIds: [] },
        }),
      },
      tasks: { get: () => undefined, getSnapshot: () => ({ tasks: [] }) } as never,
      longTasks: { control: async () => ({ ok: false, message: "unused" }) } as never,
      scheduler: () =>
        ({
          list: () => jobs,
          create: (_name: string, _schedule: string, _prompt: string, opts: Partial<CronJob>) => {
            const job = { id: `job-${jobs.length}`, enabled: true, ...opts } as CronJob;
            jobs.push(job);
            return job;
          },
          delete: (id: string) => {
            const index = jobs.findIndex((job) => job.id === id);
            if (index >= 0) jobs.splice(index, 1);
            return index >= 0;
          },
        }) as unknown as CronScheduler,
      submitNotice: h.wiring.submitNotice,
      dispatch: () => null,
      now: () => env.clock,
      onError: () => undefined,
    });
    await runtime.coordinator.start();
    const receipt = await runtime.followUpHost(
      {
        action: "register",
        title: "看一下发布",
        text: "检查发布结果",
        wakeAt: env.clock + 60_000,
        timezone: "UTC",
        intent: "remind",
      },
      { originClientMessageId: "turn-1", requestedAt: env.clock, ...context },
    );
    const id = String(receipt.followUpId);
    env.clock += 60_000;
    const job = jobs.find((entry) => entry.creationKey?.startsWith(`mimi-follow-up:rule:${id}:`));
    expect(job).toBeDefined();
    await runtime.coordinator.wake(job!);
    runtime.coordinator.stop();
    return { rule: h.wiring.ruleStore.get(id)!, key: job!.creationKey! };
  }

  test("is a followup.due notice keyed by its occurrence, and settles notified", async () => {
    current = harness();
    const { rule, key } = await wakeOnce(current);
    expect(rule.wake?.status).toBe("notified");
    await current.idle();
    expect(current.submitted).toEqual([
      expect.objectContaining({
        kind: "followup.due",
        dedupeKey: key,
        target: { kind: "owner" },
        channel: "auto",
        body: "「看一下发布」：检查发布结果",
      }),
    ]);
    expect(current.ownerSends).toHaveLength(1);
  });

  test("a follow-up asked over IM goes back to that conversation", async () => {
    current = harness();
    await wakeOnce(current, { completionTarget: ROUTE });
    await current.idle();
    expect(current.submitted[0]).toMatchObject({
      channel: "lark",
      target: { kind: "route", route: { channel: "lark", target: "chat-7" } },
    });
  });

  test("a router that no longer takes notices leaves the wake unknown, not notified", async () => {
    current = harness();
    current.wiring.router.dispose();
    const { rule } = await wakeOnce(current);
    expect(rule.wake?.status).toBe("unknown");
  });

  test("a router that throws leaves the wake unknown", async () => {
    current = harness();
    current.wiring.router.submit = async () => {
      throw new Error("ledger unwritable");
    };
    const { rule } = await wakeOnce(current);
    expect(rule.wake?.status).toBe("unknown");
  });
});
