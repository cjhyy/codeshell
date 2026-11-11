import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { CronScheduler } from "@cjhyy/code-shell-core/internal";
import type { PetRegisteredFollowUp } from "@cjhyy/code-shell-pet";
import {
  createFollowUpNotifier,
  FOLLOW_UP_MIN_DELIVERY_MS,
  followUpNotice,
} from "./pet-notice-follow-up.js";
import { DEFAULT_MAX_P0_PER_HOUR } from "./pet-notice-policy.js";
import {
  PetFollowUpWakeCoordinator,
  petFollowUpWakeKey,
} from "./pet-follow-up-wake-coordinator.js";
import { PetRegisteredFollowUpStore } from "./pet-registered-follow-up-store.js";
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

function followUp(extra: Partial<PetRegisteredFollowUp> = {}): PetRegisteredFollowUp {
  return {
    id: "registered-followup-000000000000000000000001",
    operationKey: "op-1",
    registrationKey: "reg-1",
    revision: 1,
    title: "看一下发布",
    text: "检查 0.10.1 的发布结果",
    wakeAt: env.clock,
    timezone: "UTC",
    missedPolicy: "fire-once",
    catchUpUntil: env.clock + DAY,
    intent: "remind",
    status: "open",
    createdAt: NOW - DAY,
    updatedAt: NOW - DAY,
    wake: { revision: 1, status: "claimed", claimedAt: env.clock },
    ...extra,
  };
}

const KEY = petFollowUpWakeKey("registered-followup-000000000000000000000001", 1);

async function remind(h: Harness, item = followUp(), text = item.text): Promise<void> {
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
      followUp({ id: `registered-followup-00000000000000000000000${n}` }),
      `第 ${n} 条`,
      `mimi-follow-up:registered-followup-00000000000000000000000${n}:1`,
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
      "mimi-follow-up:registered-followup-000000000000000000000003:1",
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

describe("the wake coordinator", () => {
  async function wakeOnce(h: Harness) {
    const store = new PetRegisteredFollowUpStore(join(env.dir, "follow-ups.json"), {
      now: () => env.clock,
    });
    const coordinator = new PetFollowUpWakeCoordinator({
      store,
      scheduler: () => ({ list: () => [], delete: () => true }) as unknown as CronScheduler,
      now: () => env.clock,
      notify: createFollowUpNotifier({ submit: h.wiring.submitNotice, now: () => env.clock }),
      resume: async () => ({ launched: false, text: "unused" }),
    });
    await coordinator.prepare();
    const row = await store.register({
      operationKey: "op-wake",
      title: "看一下发布",
      text: "检查发布结果",
      wakeAt: env.clock + 60_000,
      timezone: "UTC",
      intent: "remind",
    });
    env.clock += 60_000;
    await coordinator.wake({ creationKey: petFollowUpWakeKey(row.id, row.revision) });
    return store.get(row.id)!;
  }

  test("marks the wake notified once the router took the reminder", async () => {
    current = harness();
    const row = await wakeOnce(current);
    expect(row.wake.status).toBe("notified");
    await current.idle();
    expect(current.ownerSends).toHaveLength(1);
  });

  test("a router that no longer takes notices leaves the wake unknown, not notified", async () => {
    current = harness();
    current.wiring.router.dispose();
    const row = await wakeOnce(current);
    expect(row.wake.status).toBe("unknown");
  });

  test("a router that throws leaves the wake unknown", async () => {
    current = harness();
    current.wiring.router.submit = async () => {
      throw new Error("ledger unwritable");
    };
    const row = await wakeOnce(current);
    expect(row.wake.status).toBe("unknown");
  });
});
