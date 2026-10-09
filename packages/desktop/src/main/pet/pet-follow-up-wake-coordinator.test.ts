import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CronJob, CronScheduler } from "@cjhyy/code-shell-core/internal";
import { PetRegisteredFollowUpStore } from "./pet-registered-follow-up-store.js";
import {
  PetFollowUpWakeCoordinator,
  petFollowUpWakeKey,
} from "./pet-follow-up-wake-coordinator.js";

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0)) await clean();
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "mimi-wake-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  let now = Date.now();
  let failWrite = false;
  const path = join(dir, "follow-ups.json");
  const store = new PetRegisteredFollowUpStore(path, {
    now: () => now,
    replaceFile: async (from, to) => {
      if (failWrite) {
        failWrite = false;
        throw new Error("temporary disk error");
      }
      await rename(from, to);
    },
  });
  const jobs = new Map<string, CronJob>();
  let serial = 0;
  const scheduler = {
    list: () => [...jobs.values()],
    delete: (id: string) => jobs.delete(id),
    create: (name: string, schedule: string, prompt: string, options: Partial<CronJob>) => {
      const existing = [...jobs.values()].find((job) => job.creationKey === options.creationKey);
      if (existing) return existing;
      const job = {
        id: `job-${++serial}`,
        name,
        schedule,
        prompt,
        enabled: true,
        createdAt: now,
        runCount: 0,
        ...options,
      } as CronJob;
      jobs.set(job.id, job);
      return job;
    },
  } as unknown as CronScheduler;
  const sent: string[] = [];
  let resumes = 0;
  let failSend = false;
  const coordinator = new PetFollowUpWakeCoordinator({
    store,
    scheduler: () => scheduler,
    now: () => now,
    notify: async (_row, _text, key) => {
      sent.push(key);
      if (failSend) throw new Error("delivery acknowledgement lost");
    },
    resume: async () => {
      resumes += 1;
      return { launched: true, text: "accepted", taskId: "task-original" };
    },
  });
  cleanups.push(() => coordinator.stop());
  const register = (extra: Record<string, unknown> = {}) =>
    store.register({
      operationKey: `op-${serial}-${store.list().length}`,
      title: "提醒",
      text: "核对结果",
      wakeAt: now + 60_000,
      timezone: "Asia/Singapore",
      intent: "remind",
      ...extra,
    });
  return {
    store,
    coordinator,
    scheduler,
    jobs,
    sent,
    path,
    register,
    advance: (ms: number) => {
      now += ms;
    },
    failWrite: () => {
      failWrite = true;
    },
    failSend: () => {
      failSend = true;
    },
    resumes: () => resumes,
  };
}

describe("registered follow-up wake orchestration", () => {
  test("rebuilds a missing projection and removes obsolete revisions after reschedule/cancel", async () => {
    const f = await fixture();
    const row = await f.register();
    await f.coordinator.start();
    expect(f.scheduler.list()[0]?.creationKey).toBe(petFollowUpWakeKey(row.id, 1));
    const moved = await f.store.reschedule(row.id, 1, {
      wakeAt: row.wakeAt + 60_000,
      timezone: "Asia/Singapore",
    });
    await f.coordinator.reconcile();
    expect(f.scheduler.list().map((job) => job.creationKey)).toEqual([
      petFollowUpWakeKey(row.id, 2),
    ]);
    f.jobs.clear();
    await f.coordinator.reconcile();
    expect(f.scheduler.list()).toHaveLength(1);
    await f.store.cancel(moved.id, moved.revision);
    await f.coordinator.reconcile();
    expect(f.scheduler.list()).toHaveLength(0);
  });

  test("claims once before reminder delivery, never launches reminder work", async () => {
    const f = await fixture();
    const row = await f.register();
    await f.coordinator.start();
    f.advance(60_000);
    const job = { creationKey: petFollowUpWakeKey(row.id, 1) };
    await Promise.all([f.coordinator.wake(job), f.coordinator.wake(job)]);
    expect(f.sent).toHaveLength(1);
    expect(f.resumes()).toBe(0);
    expect(f.store.get(row.id)?.wake.status).toBe("notified");
  });

  test("old timers cannot fire after an explicit edit", async () => {
    const f = await fixture();
    const row = await f.register();
    await f.coordinator.start();
    await f.store.reschedule(row.id, 1, {
      wakeAt: row.wakeAt + 60_000,
      timezone: "Asia/Singapore",
    });
    f.advance(60_000);
    await f.coordinator.wake({ creationKey: petFollowUpWakeKey(row.id, 1) });
    expect(f.sent).toHaveLength(0);
    expect(f.store.get(row.id)?.wake.status).toBe("scheduled");
  });

  test("restart catches up within the deadline without moving the original time", async () => {
    const f = await fixture();
    const row = await f.register();
    f.advance(120_000);
    await f.coordinator.start();
    const job = f.scheduler.list()[0]!;
    expect(job.runAt).toBe(row.wakeAt);
    await f.coordinator.wake(job);
    expect(f.sent).toHaveLength(1);
  });

  test("expired and skip-policy records become visible failures without executing", async () => {
    const f = await fixture();
    const expired = await f.register({ catchUpUntil: Date.now() + 61_000 });
    const skipped = await f.register({ missedPolicy: "skip" });
    f.advance(180_000);
    await f.coordinator.start();
    expect(f.store.get(expired.id)?.wake.status).toBe("failed");
    expect(f.store.get(skipped.id)?.wake.status).toBe("failed");
    expect(f.sent).toHaveLength(0);
    expect(f.scheduler.list()).toHaveLength(0);
  });

  test("an ambiguous external effect is never replayed, including after restart", async () => {
    const f = await fixture();
    const row = await f.register({ intent: "resume", sourceSessionId: "original-session" });
    await f.coordinator.start();
    f.advance(60_000);
    f.failSend();
    const job = { creationKey: petFollowUpWakeKey(row.id, 1) };
    await f.coordinator.wake(job);
    await f.coordinator.wake(job);
    expect(f.resumes()).toBe(1);
    expect(f.sent).toHaveLength(1);
    expect(f.store.get(row.id)?.wake.status).toBe("unknown");
    const reloaded = new PetRegisteredFollowUpStore(f.path);
    await reloaded.load();
    expect(reloaded.get(row.id)?.wake.status).toBe("unknown");
  });

  test("a surviving claim is recorded as unknown before any startup callbacks", async () => {
    const f = await fixture();
    const row = await f.register();
    f.advance(60_000);
    await f.store.claimWake(row.id, 1);
    await Promise.all([
      f.coordinator.start(),
      f.coordinator.wake({ creationKey: petFollowUpWakeKey(row.id, 1) }),
    ]);
    expect(f.sent).toHaveLength(0);
    expect(f.store.get(row.id)?.wake.status).toBe("unknown");
  });

  test("repairs a lost once projection after a pre-effect write error", async () => {
    const f = await fixture();
    const row = await f.register();
    await f.coordinator.start();
    f.advance(60_000);
    f.failWrite();
    await expect(
      f.coordinator.wake({ creationKey: petFollowUpWakeKey(row.id, 1) }),
    ).rejects.toThrow("temporary disk error");
    f.jobs.clear(); // once jobs are retired by the scheduler even on executor failure
    f.coordinator.repairSoon();
    await Bun.sleep(1_100);
    expect(f.scheduler.list()).toHaveLength(1);
    await f.coordinator.wake(f.scheduler.list()[0]!);
    expect(f.sent).toHaveLength(1);
  });

  test("repairs paused or edited scheduler projections from the canonical definition", async () => {
    const f = await fixture();
    const row = await f.register();
    await f.coordinator.start();
    const projected = f.scheduler.list()[0]!;
    projected.enabled = false;
    projected.prompt = "unrelated";
    await f.coordinator.reconcile();
    const repaired = f.scheduler.list()[0]!;
    expect(repaired.id).not.toBe(projected.id);
    expect(repaired.enabled).toBe(true);
    expect(repaired.runAt).toBe(row.wakeAt);
    expect(repaired.prompt).toBe("Registered follow-up wake");
  });
});
