import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CronJob, CronScheduler, CreateJobOptions } from "@cjhyy/code-shell-core/internal";
import { PetRuleStore, type ScheduleNoticeRule } from "./pet-rule-store.js";
import { isPetRuleScheduleJob, PetRuleScheduler, ruleScheduleKey } from "./pet-rule-schedule.js";
import type { RuleWakeOutcome, ScheduleWhen } from "./pet-schedule-rule.js";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
/** 2023-11-14 22:13:20 UTC. */
const NOW = 1_700_000_000_000;
/** 2023-11-15 09:00 UTC: the first "0 9 * * *" after NOW. */
const NINE = Date.UTC(2023, 10, 15, 9, 0);
const ID = "rule-00000000-0000-4000-8000-0000000000aa";
const ID2 = "rule-00000000-0000-4000-8000-0000000000bb";

let dir: string;
let clock = NOW;

beforeEach(async () => {
  clock = NOW;
  dir = await mkdtemp(join(tmpdir(), "pet-rule-schedule-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** In-memory stand-in for the core scheduler: only what the coordinator uses. */
function fakeScheduler() {
  const jobs = new Map<string, CronJob>();
  let next = 0;
  return {
    jobs,
    list: () => [...jobs.values()].map((job) => ({ ...job })),
    create(name: string, schedule: string, prompt: string, opts: CreateJobOptions = {}): CronJob {
      const job: CronJob = {
        id: `job-${(next += 1)}`,
        name,
        schedule,
        prompt,
        enabled: true,
        runCount: 0,
        createdAt: 0,
        ...opts,
      };
      jobs.set(job.id, job);
      return job;
    },
    delete: (id: string) => jobs.delete(id),
    byKey: (key: string) => [...jobs.values()].find((job) => job.creationKey === key),
  };
}

class PowerEvents {
  private listeners = new Map<string, Set<() => void>>();
  on(event: string, listener: () => void) {
    (this.listeners.get(event) ?? this.listeners.set(event, new Set()).get(event)!).add(listener);
    return this;
  }
  removeListener(event: string, listener: () => void) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }
  emit(event: string) {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

function setup(
  options: {
    fire?: (rule: ScheduleNoticeRule) => Promise<RuleWakeOutcome>;
    store?: PetRuleStore;
  } = {},
) {
  const store =
    options.store ?? new PetRuleStore({ path: join(dir, "rules.json"), now: () => clock });
  const scheduler = fakeScheduler();
  const fired: Array<{ id: string; occurrence: number; at: number }> = [];
  const errors: unknown[] = [];
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  const power = new PowerEvents();
  const coordinator = new PetRuleScheduler({
    rules: store,
    scheduler: () => scheduler as unknown as CronScheduler,
    now: () => clock,
    fire: async (rule, due) => {
      fired.push({ id: rule.id, occurrence: due.occurrence, at: clock });
      return options.fire ? options.fire(rule) : { status: "notified", detail: rule.then.text };
    },
    onError: (error) => errors.push(error),
    log: (event, data) => logs.push({ event, data }),
    powerEvents: power,
    legacyFollowUpsPath: join(dir, "follow-ups.json"),
  });
  return { store, scheduler, coordinator, fired, errors, logs, power };
}

function once(at: number, extra: Partial<ScheduleWhen> = {}): ScheduleWhen {
  return { kind: "schedule", at, timezone: "UTC", missedPolicy: "fire-once", ...extra };
}
const daily: ScheduleWhen = {
  kind: "schedule",
  cron: "0 9 * * *",
  label: "每天 09:00",
  timezone: "UTC",
  missedPolicy: "fire-once",
};

function create(store: PetRuleStore, when: ScheduleWhen, id = ID) {
  return store.createScheduleRule({
    id,
    when,
    then: { mode: "remind", title: "交材料", text: "提醒我交材料" },
    channel: "auto",
    target: { kind: "owner" },
  });
}

async function settled(coordinator: PetRuleScheduler) {
  await coordinator.reconcile();
  await coordinator.idle();
  await coordinator.reconcile();
}

describe("projection", () => {
  test("each scheduled occurrence is one absolute job, retired when the rule changes", async () => {
    const f = setup();
    await create(f.store, once(NOW + HOUR));
    await f.coordinator.start();
    const key = ruleScheduleKey(ID, 1, NOW + HOUR);
    expect(f.scheduler.byKey(key)).toMatchObject({
      name: "交材料",
      schedule: "once",
      once: true,
      runAt: NOW + HOUR,
      timezone: "UTC",
      missedPolicy: "fire-once",
      catchUpUntil: NOW + HOUR + DAY,
    });
    expect(isPetRuleScheduleJob(f.scheduler.byKey(key)!)).toBe(true);

    await f.store.rescheduleRule(ID, 1, once(NOW + 2 * HOUR, { missedPolicy: "skip" }));
    await settled(f.coordinator);
    expect(f.scheduler.list().map((job) => job.creationKey)).toEqual([
      ruleScheduleKey(ID, 2, NOW + 2 * HOUR),
    ]);
    expect(f.scheduler.list()[0]).not.toHaveProperty("catchUpUntil");

    await f.store.update(ID, 2, { state: "cancelled" });
    await settled(f.coordinator);
    expect(f.scheduler.list()).toEqual([]);
    f.coordinator.stop();
  });

  test("a staggered occurrence's job runs at its instant plus the stagger", async () => {
    const f = setup();
    await create(f.store, once(NOW + HOUR));
    await create(f.store, once(NOW + HOUR), ID2);
    await f.coordinator.start();
    expect(f.scheduler.byKey(ruleScheduleKey(ID2, 1, NOW + HOUR))?.runAt).toBe(NOW + HOUR + 60_000);
    f.coordinator.stop();
  });

  test("an edited or paused job is replaced from the rule", async () => {
    const f = setup();
    await create(f.store, once(NOW + HOUR));
    await f.coordinator.start();
    const job = f.scheduler.byKey(ruleScheduleKey(ID, 1, NOW + HOUR))!;
    f.scheduler.jobs.set(job.id, { ...job, enabled: false });
    await settled(f.coordinator);
    const replaced = f.scheduler.byKey(ruleScheduleKey(ID, 1, NOW + HOUR))!;
    expect(replaced.id).not.toBe(job.id);
    expect(replaced.enabled).toBe(true);
    f.coordinator.stop();
  });
});

describe("wake", () => {
  test("claims before the effect and fires once; a duplicate or stale trigger is a no-op", async () => {
    const f = setup();
    await create(f.store, once(NOW + HOUR));
    await f.coordinator.start();
    clock = NOW + HOUR;
    const job = f.scheduler.byKey(ruleScheduleKey(ID, 1, NOW + HOUR))!;
    await f.coordinator.wake(job);
    await f.coordinator.wake(job);
    await f.coordinator.wake({ ...job, creationKey: ruleScheduleKey(ID, 7, NOW + HOUR) });
    expect(f.fired).toEqual([{ id: ID, occurrence: NOW + HOUR, at: NOW + HOUR }]);
    expect(f.store.get(ID)).toMatchObject({
      state: "active",
      version: 1,
      wake: { status: "notified", detail: "提醒我交材料" },
    });
    await settled(f.coordinator);
    expect(f.scheduler.list()).toEqual([]);
    f.coordinator.stop();
  });

  test("a repeating rule fires once per occurrence and projects the next", async () => {
    const f = setup();
    await create(f.store, daily);
    await f.coordinator.start();
    clock = NINE + 5_000;
    await f.coordinator.wake(f.scheduler.byKey(ruleScheduleKey(ID, 1, NINE))!);
    await settled(f.coordinator);
    expect(f.fired.map((entry) => entry.occurrence)).toEqual([NINE]);
    expect(f.scheduler.list().map((job) => job.creationKey)).toEqual([
      ruleScheduleKey(ID, 1, NINE + DAY),
    ]);
    clock = NINE + DAY;
    await f.coordinator.wake(f.scheduler.byKey(ruleScheduleKey(ID, 1, NINE + DAY))!);
    expect(f.fired.map((entry) => entry.occurrence)).toEqual([NINE, NINE + DAY]);
    f.coordinator.stop();
  });

  test("an effect that throws is recorded unknown and never retried", async () => {
    const f = setup({
      fire: async () => {
        throw new Error("router gone");
      },
    });
    await create(f.store, once(NOW + HOUR));
    await f.coordinator.start();
    clock = NOW + HOUR;
    const job = f.scheduler.byKey(ruleScheduleKey(ID, 1, NOW + HOUR))!;
    await f.coordinator.wake(job);
    await f.coordinator.wake(job);
    expect(f.fired).toHaveLength(1);
    expect(f.store.get(ID)?.wake).toMatchObject({ status: "unknown" });
    expect(f.store.get(ID)?.wake?.detail).toContain("router gone");
    expect(f.errors).toHaveLength(1);
    f.coordinator.stop();
  });

  test("a job the scheduler reports missed is settled by the same rules (skip: no effect)", async () => {
    const f = setup();
    await create(f.store, once(NOW + HOUR, { missedPolicy: "skip" }));
    await f.coordinator.start();
    clock = NOW + 2 * HOUR;
    await f.coordinator.missed(f.scheduler.byKey(ruleScheduleKey(ID, 1, NOW + HOUR))!);
    expect(f.fired).toEqual([]);
    expect(f.store.get(ID)?.wake).toMatchObject({ status: "failed" });
    expect(f.store.get(ID)?.wake?.detail).toContain("已错过");
    f.coordinator.stop();
  });
});

describe("sleep, wake and restart", () => {
  test("fire-once catches up once on resume, within its deadline", async () => {
    const f = setup();
    await create(f.store, once(NOW + HOUR));
    await f.coordinator.start();
    // Asleep past the moment; the timer has not fired.
    clock = NOW + 5 * HOUR;
    f.power.emit("resume");
    await settled(f.coordinator);
    f.power.emit("unlock-screen");
    await settled(f.coordinator);
    expect(f.fired).toEqual([{ id: ID, occurrence: NOW + HOUR, at: NOW + 5 * HOUR }]);
    f.coordinator.stop();
  });

  test("skip never catches up; past the deadline nothing fires either", async () => {
    const f = setup();
    await create(f.store, once(NOW + HOUR, { missedPolicy: "skip" }));
    await create(f.store, once(NOW + HOUR, { catchUpUntil: NOW + 2 * HOUR }), ID2);
    await f.coordinator.start();
    clock = NOW + 3 * HOUR;
    f.power.emit("resume");
    await settled(f.coordinator);
    expect(f.fired).toEqual([]);
    expect(f.store.get(ID)?.wake?.status).toBe("failed");
    expect(f.store.get(ID2)?.wake?.status).toBe("failed");
  });

  test("a repeating rule asleep for days fires one catch-up, then waits for the next", async () => {
    const f = setup();
    await create(f.store, { ...daily, cron: "0 * * * *" });
    await f.coordinator.start();
    const first = Date.UTC(2023, 10, 14, 23, 0);
    // Within the hour after an occurrence: it catches up, once.
    clock = first + 3 * DAY + 30 * 60_000;
    f.power.emit("resume");
    await settled(f.coordinator);
    expect(f.fired).toHaveLength(1);
    expect(f.store.get(ID)?.wake).toMatchObject({
      status: "scheduled",
      occurrence: first + 3 * DAY + HOUR,
    });
    expect(f.scheduler.list().map((job) => job.runAt)).toEqual([first + 3 * DAY + HOUR]);
    f.coordinator.stop();
  });

  test("a daily rule's catch-up window ends before its next occurrence", async () => {
    const f = setup();
    await create(f.store, daily);
    await f.coordinator.start();
    clock = NINE + 23 * HOUR + 59 * 60_000 + 30_000;
    f.power.emit("resume");
    await settled(f.coordinator);
    expect(f.fired).toEqual([]);
    expect(f.store.get(ID)?.wake).toMatchObject({ occurrence: NINE + DAY, status: "scheduled" });
    expect(f.store.get(ID)?.wake?.detail).toContain("错过");
    f.coordinator.stop();
  });

  test("restart: a surviving claim becomes unknown before anything runs; a due rule catches up", async () => {
    const store = new PetRuleStore({ path: join(dir, "rules.json"), now: () => clock });
    await create(store, once(NOW + HOUR));
    await create(store, once(NOW + HOUR), ID2);
    clock = NOW + HOUR;
    await store.claimOccurrence(ID, 1, NOW + HOUR);
    clock = NOW + 2 * HOUR;
    const f = setup({
      store: new PetRuleStore({ path: join(dir, "rules.json"), now: () => clock }),
    });
    await f.coordinator.prepare();
    expect(f.store.get(ID)?.wake?.status).toBe("unknown");
    await f.coordinator.start();
    await f.coordinator.idle();
    expect(f.fired.map((entry) => entry.id)).toEqual([ID2]);
    expect(f.store.get(ID)?.wake?.status).toBe("unknown");
    f.coordinator.stop();
  });
});

describe("old follow-ups", () => {
  test("follow-ups.json and its cron jobs are removed once, and logged", async () => {
    const f = setup();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "follow-ups.json"), '{"version":1,"entries":[]}\n');
    f.scheduler.create("old", "once", "Registered follow-up wake", {
      once: true,
      runAt: NOW + HOUR,
      creationKey: "mimi-follow-up:registered-followup-000000000000000000000001:1",
    });
    const unrelated = f.scheduler.create("daily", "0 9 * * *", "report");
    expect(isPetRuleScheduleJob(f.scheduler.list()[0]!)).toBe(true);
    await f.coordinator.start();
    expect(f.scheduler.list().map((job) => job.id)).toEqual([unrelated.id]);
    await expect(stat(join(dir, "follow-ups.json"))).rejects.toThrow();
    expect(f.logs).toEqual([
      { event: "pet.followUp.legacy_dropped", data: { jobs: 1, file: true } },
    ]);
    f.coordinator.stop();
    await f.coordinator.start();
    expect(f.logs).toHaveLength(1);
    // An old job firing before cleanup does nothing.
    await f.coordinator.wake({
      creationKey: "mimi-follow-up:registered-followup-000000000000000000000001:1",
    });
    expect(f.fired).toEqual([]);
    expect(await readFile(join(dir, "rules.json"), "utf8").catch(() => "none")).toBe("none");
    f.coordinator.stop();
  });
});

describe("robust startup", () => {
  test("a rule table that cannot load leaves the scheduler off, without throwing", async () => {
    const logs: string[] = [];
    const coordinator = new PetRuleScheduler({
      rules: {
        load: async () => {
          throw new Error("disk gone");
        },
      } as never,
      scheduler: () => fakeScheduler() as unknown as CronScheduler,
      fire: async () => ({ status: "notified" }),
      log: (event) => logs.push(event),
    });
    await expect(coordinator.start()).resolves.toBeUndefined();
    expect(logs).toEqual(["pet.followUp.scheduler_off"]);
  });

  test("a rules.json from a newer build: start succeeds and nothing is written", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "rules.json"), JSON.stringify({ version: 99, rules: [] }), {
      mode: 0o600,
    });
    const f = setup();
    await f.coordinator.start();
    expect(f.errors).toEqual([]);
    expect(JSON.parse(await readFile(join(dir, "rules.json"), "utf8"))).toEqual({
      version: 99,
      rules: [],
    });
    f.coordinator.stop();
  });

  test("cleaning up the old follow-ups is best effort: a failure still lets rules run", async () => {
    const f = setup();
    // A directory where the old file was: removing it fails.
    await mkdir(join(dir, "follow-ups.json"), { recursive: true });
    await create(f.store, once(NOW + HOUR));
    await f.coordinator.start();
    expect(f.logs.map((entry) => entry.event)).toEqual(["pet.followUp.legacy_drop_failed"]);
    expect(f.scheduler.byKey(ruleScheduleKey(ID, 1, NOW + HOUR))).toBeDefined();
    f.coordinator.stop();
  });
});

describe("older builds", () => {
  test("job keys live in the namespace older builds route away from automations", () => {
    const key = ruleScheduleKey(ID, 2, NINE);
    expect(key).toBe(`mimi-follow-up:rule:${ID}:2:${NINE}`);
    // The old wake coordinator's identity check rejects it: it never runs it.
    expect(/^mimi-follow-up:(registered-followup-[a-f0-9]{24}):(\d+)$/u.test(key)).toBe(false);
  });

  test("jobs of the pre-review build (mimi-rule:) are retired and never run", async () => {
    const f = setup();
    const stray = `mimi-rule:${ID}:1:${NOW + HOUR}`;
    f.scheduler.create("pre-review", "once", "Mimi scheduled rule", {
      once: true,
      runAt: NOW + HOUR,
      creationKey: stray,
    });
    expect(isPetRuleScheduleJob({ creationKey: stray })).toBe(true);
    await f.coordinator.start();
    expect(f.scheduler.list()).toEqual([]);
    expect(f.logs).toEqual([
      { event: "pet.followUp.legacy_dropped", data: { jobs: 1, file: false } },
    ]);
    await f.coordinator.wake({ creationKey: stray });
    expect(f.fired).toEqual([]);
    f.coordinator.stop();
  });

  test("only old-store jobs are retired; a stray rule job is reconciled away, not logged", async () => {
    const f = setup();
    f.scheduler.create("stray", "once", "Mimi scheduled rule", {
      once: true,
      runAt: NOW + HOUR,
      creationKey: ruleScheduleKey(ID2, 1, NOW + HOUR),
    });
    await f.coordinator.start();
    expect(f.scheduler.list()).toEqual([]);
    expect(f.logs).toEqual([]);
    f.coordinator.stop();
  });
});
