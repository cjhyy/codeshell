import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CronJob, CronScheduler } from "@cjhyy/code-shell-core/internal";
import type { PetFollowUpWake } from "@cjhyy/code-shell-pet";
import type { PetHostActionContext } from "./pet-dispatch-service.js";
import {
  createPetFollowUpRules,
  followUpRuleId,
  petFollowUpOperationKey,
} from "./pet-follow-up-rules.js";
import type { PetLongTask } from "./pet-long-task-store.js";
import type { NoticeSubmission } from "./pet-notice-types.js";
import { PetRuleStore } from "./pet-rule-store.js";
import type { DesktopPetSession } from "./pet-state-aggregator.js";

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60_000;
const ROUTE = {
  kind: "im-gateway" as const,
  channel: "wechat",
  target: "owner-1",
  senderId: "owner-1",
};

let dir: string;
let clock = NOW;

beforeEach(async () => {
  clock = NOW;
  dir = await mkdtemp(join(tmpdir(), "pet-follow-up-rules-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function session(id: string, extra: Partial<DesktopPetSession> = {}): DesktopPetSession {
  return {
    agentSessionId: id,
    title: id,
    runState: "dormant",
    queueDepth: 0,
    pendingDecisionCount: 0,
    lastActivityAt: 1,
    freshness: { source: "disk", observedAt: 1, workerState: "active" },
    ...extra,
  };
}

async function setup(
  options: {
    sessions?: DesktopPetSession[];
    tasks?: PetLongTask[];
    wakeFollowUp?: (
      wake: PetFollowUpWake,
    ) => Promise<{ launched: boolean; text: string; taskId?: string }>;
  } = {},
) {
  const rules = new PetRuleStore({ path: join(dir, "rules.json"), now: () => clock });
  const jobs: CronJob[] = [];
  const submitted: NoticeSubmission[] = [];
  const wakes: PetFollowUpWake[] = [];
  const tasks = options.tasks ?? [];
  const runtime = await createPetFollowUpRules({
    rules,
    sessions: () => options.sessions ?? [],
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
        added: true,
        snapshot: { revision: 1, dismissedIds: [] },
      }),
    },
    tasks: {
      get: (id: string) => tasks.find((task) => task.id === id),
      getSnapshot: () => ({ tasks }),
    } as never,
    longTasks: { control: async () => ({ ok: true }) } as never,
    scheduler: () =>
      ({
        list: () => jobs,
        create: (name: string, schedule: string, prompt: string, opts: Partial<CronJob>) => {
          const job = {
            id: `job-${jobs.length}-${Math.random()}`,
            name,
            schedule,
            prompt,
            enabled: true,
            ...opts,
          } as CronJob;
          jobs.push(job);
          return job;
        },
        delete: (id: string) => {
          const index = jobs.findIndex((job) => job.id === id);
          if (index >= 0) jobs.splice(index, 1);
          return index >= 0;
        },
      }) as unknown as CronScheduler,
    submitNotice: async (notice) => {
      submitted.push(notice);
      return { outlet: "desktop" } as never;
    },
    dispatch: () => ({
      wakeFollowUp: async (wake) => {
        wakes.push(wake);
        return options.wakeFollowUp
          ? options.wakeFollowUp(wake)
          : { launched: true, text: "已交回原任务", taskId: "task-new" };
      },
    }),
    now: () => clock,
    onError: () => undefined,
  });
  return { rules, runtime, jobs, submitted, wakes, host: runtime.followUpHost };
}

const desktop: PetHostActionContext = {
  originClientMessageId: "turn-1",
  requestedAt: NOW,
  actionIndex: 0,
};
const remind = {
  action: "register",
  title: "交材料",
  text: "提醒我交材料",
  wakeAt: NOW + HOUR,
  timezone: "UTC",
  intent: "remind",
};

describe("ManageFollowUp on schedule rules", () => {
  test("register: a desktop turn's follow-up goes to the owner; the rule id is host-derived", async () => {
    const f = await setup();
    const receipt = await f.host(remind, desktop);
    const id = followUpRuleId(petFollowUpOperationKey(desktop));
    expect(receipt).toEqual({
      action: "register",
      followUpId: id,
      title: "交材料",
      revision: 1,
      wakeAt: NOW + HOUR,
      timezone: "UTC",
      intent: "remind",
      status: "open",
      wakeState: "scheduled",
    });
    expect(f.rules.get(id)).toMatchObject({
      createdBy: "follow-up",
      origin: "user",
      when: {
        kind: "schedule",
        at: NOW + HOUR,
        missedPolicy: "fire-once",
        catchUpUntil: NOW + HOUR + 24 * HOUR,
      },
      then: { mode: "remind", title: "交材料", text: "提醒我交材料" },
      channel: "auto",
      target: { kind: "owner" },
    });
  });

  test("register over IM targets that conversation, from the turn, never the model", async () => {
    const f = await setup();
    const receipt = await f.host(remind, {
      ...desktop,
      completionTarget: ROUTE,
      senderId: "owner-1",
    });
    expect(f.rules.get(String(receipt.followUpId))).toMatchObject({
      channel: "wechat",
      target: { kind: "route", route: { channel: "wechat", target: "owner-1" } },
    });
    await expect(f.host({ ...remind, completionTarget: ROUTE }, desktop)).rejects.toThrow(
      "invalid follow-up request",
    );
    await expect(f.host(remind)).rejects.toThrow("authenticated current turn");
  });

  test("a replayed registration returns the rule as it is now; another slot is another rule", async () => {
    const f = await setup();
    const first = await f.host(remind, desktop);
    const second = await f.host(remind, { ...desktop, actionIndex: 1 });
    expect(second.followUpId).not.toBe(first.followUpId);
    await f.host({ action: "cancel", followUpId: String(first.followUpId), expectedRevision: 1 });
    expect(await f.host(remind, desktop)).toMatchObject({
      followUpId: first.followUpId,
      status: "cancelled",
      revision: 2,
    });
    expect(f.rules.list()).toHaveLength(2);
  });

  test("register with a recurrence stores a repeating rule at its next occurrence", async () => {
    const f = await setup();
    const { wakeAt: _once, ...base } = remind;
    const receipt = await f.host({ ...base, recurrence: "0 9 * * 1-5" }, desktop);
    // 2023-11-14 is a Tuesday: next is Wednesday 09:00 UTC.
    expect(receipt).toMatchObject({ recurrence: "0 9 * * 1-5", wakeAt: Date.UTC(2023, 10, 15, 9) });
    expect(f.rules.get(String(receipt.followUpId))?.when).toEqual({
      kind: "schedule",
      cron: "0 9 * * 1-5",
      timezone: "UTC",
      missedPolicy: "fire-once",
    });
    await expect(
      f.host({ ...base, recurrence: "0 9 31 2 *" }, { ...desktop, actionIndex: 2 }),
    ).rejects.toThrow("不会触发");
    await expect(
      f.host({ ...base, recurrence: "*/20 * * * *" }, { ...desktop, actionIndex: 3 }),
    ).rejects.toThrow("invalid follow-up request");
  });

  test("reschedule, complete, dismiss and cancel use the rule's version", async () => {
    const f = await setup();
    const id = String((await f.host(remind, desktop)).followUpId);
    await expect(
      f.host({
        action: "reschedule",
        followUpId: id,
        expectedRevision: 5,
        wakeAt: NOW + 2 * HOUR,
        timezone: "UTC",
      }),
    ).rejects.toThrow("版本已更新");
    await expect(
      f.host({
        action: "reschedule",
        followUpId: id,
        expectedRevision: 1,
        wakeAt: NOW - 1,
        timezone: "UTC",
      }),
    ).rejects.toThrow("必须在未来");
    expect(
      await f.host({
        action: "reschedule",
        followUpId: id,
        expectedRevision: 1,
        recurrence: "30 8 * * *",
        timezone: "UTC",
      }),
    ).toMatchObject({
      revision: 2,
      recurrence: "30 8 * * *",
      wakeAt: Date.UTC(2023, 10, 15, 8, 30),
    });
    await expect(f.host({ action: "complete", followUpId: id })).rejects.toThrow(
      "expectedRevision",
    );
    expect(await f.host({ action: "dismiss", followUpId: id, expectedRevision: 2 })).toMatchObject({
      action: "dismiss",
      status: "cancelled",
      revision: 3,
    });
    await expect(
      f.host({ action: "complete", followUpId: id, expectedRevision: 3 }),
    ).rejects.toThrow("已处理");
    expect(await f.runtime.petFollowUps.listOpen()).toEqual([]);
    const other = String((await f.host(remind, { ...desktop, actionIndex: 1 })).followUpId);
    expect(
      await f.host({ action: "complete", followUpId: other, expectedRevision: 1 }),
    ).toMatchObject({
      status: "completed",
    });
    await expect(
      f.host({
        action: "complete",
        followUpId: "rule-00000000-0000-4000-8000-0000000000ff",
        expectedRevision: 1,
      }),
    ).rejects.toThrow("不存在");
  });

  test("resume needs a live native Session and a matching task", async () => {
    const resume = { ...remind, intent: "resume", sourceSessionId: "s-native" };
    const f = await setup({
      sessions: [session("s-native"), session("s-codex", { external: { cli: "codex" } })],
      tasks: [{ id: "task-a", sessionId: "s-native", status: "running" } as PetLongTask],
    });
    await expect(f.host({ ...resume, sourceSessionId: "s-codex" }, desktop)).rejects.toThrow(
      "不受当前 Host 支持",
    );
    await expect(f.host({ ...resume, sourceSessionId: "s-gone" }, desktop)).rejects.toThrow(
      "已不存在",
    );
    await expect(f.host({ ...resume, taskId: "task-other" }, desktop)).rejects.toThrow("不匹配");
    const receipt = await f.host(resume, desktop);
    expect(f.rules.get(String(receipt.followUpId))?.then).toEqual({
      mode: "run-mimi",
      title: "交材料",
      text: "提醒我交材料",
      sourceSessionId: "s-native",
      taskId: "task-a",
    });
  });
});

describe("firing", () => {
  test("remind: the text is the reminder, through the router", async () => {
    const f = await setup();
    const id = String((await f.host(remind, desktop)).followUpId);
    await f.runtime.coordinator.start();
    clock = NOW + HOUR;
    await f.runtime.coordinator.wake(f.jobs[0]!);
    f.runtime.coordinator.stop();
    expect(f.submitted).toEqual([
      expect.objectContaining({
        kind: "followup.due",
        dedupeKey: `mimi-rule:${id}:1:${NOW + HOUR}`,
        body: "「交材料」：提醒我交材料",
      }),
    ]);
    expect(f.wakes).toEqual([]);
    expect(f.rules.get(id)?.wake).toMatchObject({ status: "notified", detail: "提醒我交材料" });
  });

  test("run-mimi: Mimi continues the exact Session, the reminder carries her result", async () => {
    let validated: unknown;
    const f = await setup({
      sessions: [session("s-native")],
      wakeFollowUp: async (wake) => {
        // Re-checked by the dispatch turn while the occurrence is claimed.
        validated = (() => {
          try {
            f.runtime.validateContinuation(wake);
            return "ok";
          } catch (error) {
            return String(error);
          }
        })();
        return { launched: true, text: "已交回原任务", taskId: "task-new" };
      },
    });
    const id = String(
      (
        await f.host(
          { ...remind, intent: "resume", sourceSessionId: "s-native" },
          { ...desktop, completionTarget: ROUTE },
        )
      ).followUpId,
    );
    await f.runtime.coordinator.start();
    clock = NOW + HOUR;
    await f.runtime.coordinator.wake(f.jobs[0]!);
    f.runtime.coordinator.stop();
    expect(f.wakes).toEqual([
      {
        id,
        revision: 1,
        occurrence: NOW + HOUR,
        title: "交材料",
        text: "提醒我交材料",
        intent: "resume",
        sourceSessionId: "s-native",
        completionTarget: expect.objectContaining({ channel: "wechat", target: "owner-1" }),
      },
    ]);
    expect(validated).toBe("ok");
    expect(f.submitted[0]).toMatchObject({ body: "「交材料」：已交回原任务", channel: "wechat" });
    expect(f.rules.get(id)?.wake).toMatchObject({ status: "launched", taskId: "task-new" });
    // After the occurrence settled, a late continuation is refused.
    expect(() => f.runtime.validateContinuation(f.wakes[0]!)).toThrow("授权已变化");
  });

  test("run-mimi does not wake Mimi for a Session that is busy or waiting on a decision", async () => {
    const f = await setup({ sessions: [session("s-native", { pendingDecisionCount: 1 })] });
    await f.host({ ...remind, intent: "resume", sourceSessionId: "s-native" }, desktop);
    await f.runtime.coordinator.start();
    clock = NOW + HOUR;
    await f.runtime.coordinator.wake(f.jobs[0]!);
    f.runtime.coordinator.stop();
    expect(f.wakes).toEqual([]);
    expect(f.submitted[0]?.body).toContain("等待你的决定");
  });
});
