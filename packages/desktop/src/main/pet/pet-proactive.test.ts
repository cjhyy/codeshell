import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReplyModel } from "./pet-notice-reply-interpreter.js";
import { createPetProactive, type PetProactive } from "./pet-proactive.js";
import { PetProactiveStateStore } from "./pet-proactive-state.js";
import { ruleScheduleKey, type RuleScheduleDue } from "./pet-rule-schedule.js";
import type { SystemScheduleNoticeRule, SystemScheduleRuleId } from "./pet-rule-store.js";
import {
  cleanupNoticeEnv,
  env,
  harness,
  longTask,
  resetNoticeEnv,
  type Harness,
} from "./test-utils/notice-wiring-harness.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** 2023-11-15 09:00 UTC (the tests run at UTC offset 0). */
const NINE = Date.UTC(2023, 10, 15, 9, 0);

let h: Harness | undefined;
let notifications: Record<string, unknown> = {};

beforeEach(async () => {
  await resetNoticeEnv();
  notifications = {};
});
afterEach(async () => {
  await cleanupNoticeEnv(h);
  h = undefined;
});

interface Setup {
  h: Harness;
  proactive: PetProactive;
  calls: Array<{ systemPrompt: string; user: string }>;
  logs: string[];
  /** The next answers the model gives (then "{}"; a thrown Error = unavailable). */
  answers: Array<string | Error>;
}

async function setup(
  settings: Record<string, unknown>,
  existing?: Harness,
  zone: () => string = () => "UTC",
): Promise<Setup> {
  notifications = settings;
  h = existing ?? harness({ readSettings: () => ({ pet: { notifications } }) });
  await h.wiring.ready;
  h.wiring.settingsChanged();
  // No Session is running unless a test says so.
  if (!existing) h.sessions.splice(0);
  const calls: Setup["calls"] = [];
  const answers: Setup["answers"] = [];
  const logs: string[] = [];
  const model: ReplyModel = async ({ systemPrompt, user }) => {
    calls.push({ systemPrompt, user });
    const answer = answers.shift() ?? "{}";
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const wiring = h.wiring;
  const harnessRef = h;
  const proactive = createPetProactive({
    rules: wiring.ruleStore,
    state: new PetProactiveStateStore(join(env.dir, "pet", "proactive.json")),
    ledger: wiring.ledger,
    tasks: () => harnessRef.tasks,
    sessions: () => harnessRef.sessions,
    pending: () => harnessRef.pending,
    wasSessionViewedSince: () => false,
    settings: wiring.settings,
    onSettingsChange: wiring.onSettingsChange,
    submit: wiring.submitNotice,
    models: [model],
    now: () => env.clock,
    timezoneOffsetMin: () => 0,
    timezone: zone,
    log: (event) => logs.push(event),
  });
  await proactive.start();
  return { h, proactive, calls, logs, answers };
}

function rule(f: Setup, id: SystemScheduleRuleId): SystemScheduleNoticeRule {
  const found = f.h.wiring.ruleStore.get(id);
  if (!found) throw new Error(`no ${id}`);
  return found as SystemScheduleNoticeRule;
}

function due(f: Setup, id: SystemScheduleRuleId, occurrence: number): RuleScheduleDue {
  return {
    occurrence,
    deadline: occurrence + HOUR,
    key: ruleScheduleKey(id, rule(f, id).version, occurrence),
  };
}

describe("system rules follow the settings", () => {
  test("switching briefs and the heartbeat on, retiming and off", async () => {
    const f = await setup({});
    const rules = f.h.wiring.ruleStore;
    expect(rules.list().filter((row) => row.origin === "system")).toEqual([]);
    notifications = {
      briefs: { evening: { enabled: true, time: "19:00" } },
      heartbeat: { enabled: true },
    };
    f.h.wiring.settingsChanged();
    await f.proactive.sync();
    expect(rules.get("system-brief-evening")).toMatchObject({
      state: "active",
      when: { cron: "0 19 * * *", timezone: "UTC" },
    });
    expect(rules.get("system-heartbeat")?.state).toBe("active");
    notifications = {};
    f.h.wiring.settingsChanged();
    await f.proactive.sync();
    expect(rules.get("system-brief-evening")?.state).toBe("paused");
    expect(rules.get("system-heartbeat")?.state).toBe("paused");
  });
});

describe("briefs", () => {
  test("nothing to report: nothing is sent and no model is asked", async () => {
    env.clock = NINE;
    const f = await setup({ briefs: { morning: { enabled: true } } });
    const result = await f.proactive.fire(
      rule(f, "system-brief-morning"),
      due(f, "system-brief-morning", NINE),
    );
    expect(result.detail).toContain("没有需要汇报");
    expect(f.calls).toEqual([]);
    expect(f.h.submitted).toEqual([]);
  });

  test("the model's lines (each tied to a record) reach the owner once that day", async () => {
    env.clock = NINE;
    const f = await setup({ briefs: { morning: { enabled: true } } });
    f.h.tasks.push(longTask({ completedAt: NINE - HOUR, objective: "修复登录问题" }));
    f.answers.push(
      JSON.stringify({
        opening: "早！",
        items: [{ refs: ["r1"], text: "登录修好了" }],
        closing: "今天先做哪个？",
      }),
    );
    const first = await f.proactive.fire(
      rule(f, "system-brief-morning"),
      due(f, "system-brief-morning", NINE),
    );
    await f.h.idle();
    expect(first.detail).toContain("已发送早报");
    expect(f.h.submitted).toMatchObject([
      { kind: "brief.morning", priority: "P1", target: { kind: "owner" }, channel: "auto" },
    ]);
    expect(f.h.ownerSends.map((send) => send.text)).toEqual([
      "早！\n- 【完成】登录修好了\n今天先做哪个？",
    ]);
    // The records went to the model as data, with refs.
    expect(JSON.parse(f.calls[0]!.user).records[0]).toMatchObject({ ref: "r1", type: "done" });

    // Fired again the same day (the owner moved the time): skipped.
    env.clock = NINE + 2 * HOUR;
    const again = await f.proactive.fire(
      rule(f, "system-brief-morning"),
      due(f, "system-brief-morning", NINE + 2 * HOUR),
    );
    expect(again.detail).toContain("已经发过");
    expect(f.h.ownerSends).toHaveLength(1);
    expect(f.proactive.status().briefs.morning).toEqual({ lastSentDay: "2023-11-15" });
  });

  test("slept through: caught up later that day, never on the next", async () => {
    env.clock = NINE + DAY + 3 * HOUR;
    const f = await setup({ briefs: { morning: { enabled: true } } });
    f.h.tasks.push(longTask({ completedAt: NINE - HOUR }));
    const missed = await f.proactive.fire(
      rule(f, "system-brief-morning"),
      due(f, "system-brief-morning", NINE),
    );
    expect(missed).toMatchObject({ status: "failed" });
    expect(missed.detail).toContain("错过了当天的早报");
    expect(f.h.submitted).toEqual([]);

    env.clock = NINE + DAY + 4 * HOUR;
    const caughtUp = await f.proactive.fire(
      rule(f, "system-brief-morning"),
      due(f, "system-brief-morning", NINE + DAY),
    );
    await f.h.idle();
    expect(caughtUp.detail).toContain("已发送早报");
    // No model answered: the template, one line per record, fitting the hour (13:00).
    expect(f.h.ownerSends.map((send) => send.text)).toEqual([
      "今天到现在的情况：\n- 【完成】「修复登录问题」：登录修好了",
    ]);
  });

  test("inside quiet hours the brief is held, not sent", async () => {
    const seven = Date.UTC(2023, 10, 15, 7, 0);
    env.clock = seven;
    const f = await setup({ briefs: { morning: { enabled: true, time: "07:00" } } });
    f.h.tasks.push(longTask({ completedAt: seven - HOUR }));
    await f.proactive.fire(rule(f, "system-brief-morning"), due(f, "system-brief-morning", seven));
    await f.h.idle();
    expect(f.h.ownerSends).toEqual([]);
    expect(f.h.wiring.ledger.held().map((record) => record.kind)).toEqual(["brief.morning"]);
    // Quiet hours over: the whole brief goes out (not a one-line digest entry).
    env.clock = Date.UTC(2023, 10, 15, 8, 30);
    await f.h.wiring.router.flushDigest();
    await f.h.idle();
    expect(f.h.ownerSends.map((send) => send.text)).toEqual([
      "早上好，今天的情况：\n- 【完成】「修复登录问题」：登录修好了",
    ]);
  });

  test("a brief the router did not take (shutting down) is not marked sent", async () => {
    env.clock = NINE;
    const f = await setup({ briefs: { morning: { enabled: true } } });
    f.h.tasks.push(longTask({ completedAt: NINE - HOUR }));
    f.h.wiring.router.dispose();
    const result = await f.proactive.fire(
      rule(f, "system-brief-morning"),
      due(f, "system-brief-morning", NINE),
    );
    expect(result).toMatchObject({ status: "failed" });
    expect(f.proactive.status().briefs.morning).toEqual({});
  });

  test("a fire in another timezone than the rule's retimes the rules", async () => {
    env.clock = NINE;
    let zone = "UTC";
    const f = await setup({ briefs: { morning: { enabled: true } } }, undefined, () => zone);
    zone = "Asia/Shanghai";
    await f.proactive.fire(rule(f, "system-brief-morning"), due(f, "system-brief-morning", NINE));
    await f.proactive.sync();
    expect(rule(f, "system-brief-morning").when.timezone).toBe("Asia/Shanghai");
  });
});

describe("heartbeat", () => {
  const TEN = Date.UTC(2023, 10, 15, 10, 0);

  async function beat(f: Setup, at = env.clock, id: SystemScheduleRuleId = "system-heartbeat") {
    return f.proactive.fire(rule(f, id), due(f, id, at));
  }

  /** A result that came in and the owner has not looked at. */
  async function newResult(f: Setup, id: string, at: number) {
    await f.h.wiring.ledger.record({
      kind: "session.done",
      priority: "P1",
      dedupeKey: `done:${id}`,
      sessionId: id,
      ruleIds: [],
      facts: { title: `会话 ${id}`, target: { kind: "owner" } },
      decision: { outlet: "desktop", reason: "present-desktop" },
    });
    void at;
  }

  test("no new facts: no model call; outside active hours: not even a look", async () => {
    env.clock = TEN;
    const f = await setup({ heartbeat: { enabled: true } });
    expect((await beat(f)).detail).toContain("未调用模型");
    env.clock = Date.UTC(2023, 10, 15, 23, 30);
    expect((await beat(f)).detail).toContain("不在活跃时段");
    expect(f.calls).toEqual([]);
  });

  test("a new fact is judged once; say goes to the owner through the router", async () => {
    env.clock = TEN;
    const f = await setup({ heartbeat: { enabled: true } });
    await newResult(f, "s-a", TEN);
    env.clock = TEN + MIN;
    f.answers.push('{"say":true,"text":"会话 s-a 做完了，你还没看。"}');
    expect((await beat(f)).detail).toContain("已提醒");
    await f.h.idle();
    expect(f.h.submitted).toMatchObject([{ kind: "heartbeat", target: { kind: "owner" } }]);
    expect(f.h.ownerSends.map((send) => send.text)).toEqual(["会话 s-a 做完了，你还没看。"]);
    env.clock = TEN + 31 * MIN;
    await beat(f);
    expect(f.calls).toHaveLength(1);
  });

  test("a failed judgement is judged again later, not taken as silence", async () => {
    env.clock = TEN;
    const f = await setup({ heartbeat: { enabled: true } });
    await newResult(f, "s-a", TEN);
    env.clock = TEN + MIN;
    f.answers.push(new Error("down"));
    expect(await beat(f)).toMatchObject({ status: "failed" });
    env.clock = TEN + 31 * MIN;
    f.answers.push('{"say":false}');
    await beat(f);
    expect(f.calls).toHaveLength(2);
  });

  test("4 messages a day: past that, no model is asked and the facts wait", async () => {
    env.clock = TEN;
    const f = await setup({ heartbeat: { enabled: true } });
    for (let index = 0; index < 5; index += 1) {
      await newResult(f, `s-${index}`, env.clock);
      env.clock += MIN;
      f.answers.push('{"say":true,"text":"有事"}');
      const result = await beat(f);
      if (index === 4) expect(result.detail).toContain("已达上限");
      env.clock += 30 * MIN;
    }
    expect(f.calls).toHaveLength(4);
    expect(f.h.submitted.filter((notice) => notice.kind === "heartbeat")).toHaveLength(4);
    // Not consumed: the fifth result is still unjudged (seen only once judged).
    const stored = JSON.parse(await readFile(join(env.dir, "pet", "proactive.json"), "utf8"));
    expect(stored.heartbeat.seen).toHaveLength(4);
    expect(f.proactive.status().heartbeat).toMatchObject({
      saidToday: 4,
      atSayCap: true,
      atJudgeCap: false,
    });
  });

  test("8 judgements a day, counted durably across a restart", async () => {
    env.clock = TEN;
    let f = await setup({ heartbeat: { enabled: true } });
    let calls = 0;
    for (let index = 0; index < 9; index += 1) {
      await newResult(f, `s-${index}`, env.clock);
      env.clock += MIN;
      f.answers.push('{"say":false}');
      const before = f.calls.length;
      await beat(f);
      calls += f.calls.length - before;
      env.clock += 30 * MIN;
      if (index === 3) {
        // A restart in between: a fresh store over the same file.
        f.proactive.dispose();
        f = await setup({ heartbeat: { enabled: true } }, f.h);
      }
    }
    expect(calls).toBe(8);
    expect(f.proactive.status().heartbeat).toMatchObject({ judgedToday: 8, atJudgeCap: true });
  });

  test("after a long gap the heartbeat looks back two hours at most", async () => {
    env.clock = TEN;
    const f = await setup({ heartbeat: { enabled: true } });
    expect((await beat(f)).detail).toContain("未调用模型");
    // Off (or asleep) for five hours; one result came in early, one late.
    env.clock = TEN + 60 * MIN;
    await newResult(f, "s-old", env.clock);
    env.clock = TEN + 4 * 60 * MIN;
    await newResult(f, "s-new", env.clock);
    env.clock = TEN + 5 * 60 * MIN;
    f.answers.push('{"say":false}');
    await beat(f);
    const facts = JSON.parse(f.calls[0]!.user).facts as Array<{ title: string }>;
    expect(facts.map((fact) => fact.title)).toEqual(["会话 s-new"]);
  });

  test("beats run one at a time: a recheck and a regular beat never both pass the cap", async () => {
    env.clock = TEN;
    const f = await setup({ heartbeat: { enabled: true } });
    // Three messages already today.
    for (let index = 0; index < 3; index += 1) {
      env.clock += MIN;
      await newResult(f, `s-${index}`, env.clock);
      env.clock += MIN;
      f.answers.push('{"say":true,"text":"有事"}');
      await beat(f);
    }
    env.clock += MIN;
    await newResult(f, "s-x", env.clock);
    env.clock += MIN;
    await f.h.wiring.ruleStore.setSystemSchedule("system-heartbeat-recheck", {
      when: { kind: "schedule", at: env.clock + MIN, timezone: "UTC", missedPolicy: "skip" },
      state: "active",
    });
    f.answers.push('{"say":true,"text":"第四条"}', '{"say":true,"text":"第五条"}');
    await Promise.all([beat(f), beat(f, env.clock, "system-heartbeat-recheck")]);
    expect(f.h.submitted.filter((notice) => notice.kind === "heartbeat")).toHaveLength(4);
  });

  test('"look again in N minutes" arms one recheck; the recheck never arms another', async () => {
    env.clock = TEN;
    const f = await setup({ heartbeat: { enabled: true } });
    await newResult(f, "s-a", TEN);
    env.clock = TEN + MIN;
    f.answers.push('{"say":false,"recheckInMin":15}');
    expect((await beat(f)).detail).toContain("15 分钟后再看");
    const recheck = f.h.wiring.ruleStore.get("system-heartbeat-recheck");
    expect(recheck).toMatchObject({ state: "active", when: { at: TEN + 16 * MIN } });
    // The facts stay new for the recheck.
    env.clock = TEN + 16 * MIN;
    f.answers.push('{"say":false,"recheckInMin":15}');
    expect((await beat(f, TEN + 16 * MIN, "system-heartbeat-recheck")).detail).toBe("暂不打扰。");
    expect(f.calls).toHaveLength(2);
    expect(f.h.wiring.ruleStore.get("system-heartbeat-recheck")?.version).toBe(recheck!.version);
    // Now judged: the next heartbeat has nothing new.
    env.clock = TEN + 31 * MIN;
    await beat(f);
    expect(f.calls).toHaveLength(2);
  });

  test("a heartbeat inside quiet hours is never even a look", async () => {
    const late = Date.UTC(2023, 10, 15, 21, 30);
    env.clock = late;
    const f = await setup({
      heartbeat: { enabled: true },
      quietHours: { start: "21:00", end: "08:00" },
    });
    await newResult(f, "s-a", late);
    expect((await beat(f)).detail).toContain("不在活跃时段");
    expect(f.calls).toEqual([]);
  });
});
