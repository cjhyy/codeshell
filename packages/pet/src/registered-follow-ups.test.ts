import { describe, expect, test } from "bun:test";
import type { ToolContext } from "@cjhyy/code-shell-core/extension";
import { manageFollowUpTool } from "./follow-ups.js";
import { isPetHostActionRequest } from "./host-actions.js";
import { isPetFollowUpMutationPayload } from "./registered-follow-ups.js";
import { petRunOptionsFrom, validatePetRunParams } from "./run-params.js";

const register = {
  action: "register",
  title: "交材料",
  text: "提醒我交材料",
  wakeAt: 5_000,
  timezone: "Asia/Singapore",
  intent: "remind",
};
function manager() {
  const actions: unknown[] = [];
  const ctx = {
    runScopedServices: {
      requestPetHostAction: (value: unknown) => {
        actions.push(value);
        return { ok: true };
      },
    },
  } as unknown as ToolContext;
  return { ctx, actions };
}

describe("registered follow-up capability boundary", () => {
  test("preserves a session-free registered row through protocol and Engine profile parsing", () => {
    const row = {
      kind: "registered",
      id: "rule-00000000-0000-4000-8000-00000000000a",
      title: "交材料",
      text: "提醒我交材料",
      revision: 1,
      wakeAt: 5_000,
      timezone: "Asia/Singapore",
      missedPolicy: "fire-once",
      catchUpUntil: 86_405_000,
      intent: "remind",
      status: "open",
      createdAt: 1_000,
      wakeState: "unknown",
      wakeDetail: "上次递送结果不确定",
    };
    expect(
      validatePetRunParams({
        behaviorMode: "pet",
        kind: "pet",
        profileParams: { followUps: [row] },
      }),
    ).toBeNull();
    expect(petRunOptionsFrom({ followUps: [row] }).followUps).toEqual([row]);
    expect(
      petRunOptionsFrom({ followUps: [{ ...row, wakeState: "guaranteed-delivery" }] }).followUps,
    ).toEqual([]);
    expect(
      petRunOptionsFrom({ followUps: [{ ...row, sourceSessionId: "session-a" }] }).followUps,
    ).toEqual([]);
    const legacy = {
      id: "followup-old",
      title: "old",
      text: "old",
      terminalAt: 1,
      sessionSelector: "session-old",
    };
    expect(petRunOptionsFrom({ followUps: [legacy] }).followUps).toEqual([
      { kind: "derived-session", ...legacy },
    ]);
  });
  test("records a native reminder without trusting model-authored routes or operation identity", async () => {
    const { ctx, actions } = manager();
    expect(
      await manageFollowUpTool(
        {
          action: "register",
          title: "交材料",
          text: "提醒我交材料",
          wake_at: 5_000,
          timezone: "Asia/Singapore",
          __signal: new AbortController().signal,
        },
        ctx,
      ),
    ).toContain("accepted");
    expect(actions).toEqual([{ kind: "followUpMutation", payload: register }]);
    expect(isPetHostActionRequest(actions[0])).toBe(true);
    for (const extra of [
      { operationKey: "forged" },
      { completionTarget: { target: "other" } },
      { target_id: "other" },
      { executor: "codeshell" },
    ]) {
      expect(
        await manageFollowUpTool(
          { action: "register", title: "x", text: "x", wake_at: 5_000, timezone: "UTC", ...extra },
          ctx,
        ),
      ).toContain("unsupported");
    }
    expect(actions).toHaveLength(1);
  });

  test("resume needs an exact source and ordinary reminders cannot smuggle execution targets", async () => {
    expect(isPetFollowUpMutationPayload({ ...register, intent: "resume" })).toBe(false);
    expect(
      isPetFollowUpMutationPayload({
        ...register,
        intent: "resume",
        sourceSessionId: " session-a",
      }),
    ).toBe(false);
    expect(isPetFollowUpMutationPayload({ ...register, sourceSessionId: "session-a" })).toBe(false);
    expect(
      isPetFollowUpMutationPayload({
        ...register,
        intent: "resume",
        sourceSessionId: "session-a",
        taskId: "task-a",
      }),
    ).toBe(true);
  });

  test("mutations use version fences and preserve explicit catch-up expiry", async () => {
    const { ctx, actions } = manager();
    expect(
      await manageFollowUpTool(
        {
          action: "reschedule",
          follow_up_id: "rule-00000000-0000-4000-8000-00000000000a",
          expected_revision: 2,
          wake_at: 10_000,
          timezone: "UTC",
          missed_policy: "skip",
          catch_up_until: 12_000,
        },
        ctx,
      ),
    ).toContain("accepted");
    expect(actions[0]).toEqual({
      kind: "followUpMutation",
      payload: {
        action: "reschedule",
        followUpId: "rule-00000000-0000-4000-8000-00000000000a",
        expectedRevision: 2,
        wakeAt: 10_000,
        timezone: "UTC",
        missedPolicy: "skip",
        catchUpUntil: 12_000,
      },
    });
    expect(
      await manageFollowUpTool(
        { action: "cancel", follow_up_id: "rule-00000000-0000-4000-8000-00000000000a" },
        ctx,
      ),
    ).toContain("requires");
    expect(
      await manageFollowUpTool(
        { action: "complete", follow_up_id: "rule-00000000-0000-4000-8000-00000000000a" },
        ctx,
      ),
    ).toContain("expected_revision");
    expect(
      await manageFollowUpTool({ action: "dismiss", follow_up_id: "followup-a" }, ctx),
    ).toContain("accepted");
    expect(isPetFollowUpMutationPayload({ ...register, catchUpUntil: 4_999 })).toBe(false);
    expect(isPetFollowUpMutationPayload({ ...register, timezone: "bad/zone" })).toBe(false);
    expect(isPetFollowUpMutationPayload({ ...register, wakeAt: Infinity })).toBe(false);
  });

  test("rule ids are registered rows: completing one needs its revision", async () => {
    const { ctx, actions } = manager();
    const id = "rule-00000000-0000-4000-8000-000000000001";
    expect(await manageFollowUpTool({ action: "complete", follow_up_id: id }, ctx)).toContain(
      "expected_revision",
    );
    expect(
      await manageFollowUpTool({ action: "complete", follow_up_id: id, expected_revision: 3 }, ctx),
    ).toContain("accepted");
    expect(actions).toEqual([
      {
        kind: "followUpMutation",
        payload: { action: "complete", followUpId: id, expectedRevision: 3 },
      },
    ]);
  });
});

describe("recurring follow-ups", () => {
  const recurring = {
    action: "register",
    title: "周报",
    text: "提醒我写周报",
    timezone: "Asia/Shanghai",
    intent: "remind",
    recurrence: "0 17 * * 5",
    scheduleLabel: "每周五 17:00",
  };

  test("the model passes a cron recurrence instead of wake_at", async () => {
    const { ctx, actions } = manager();
    expect(
      await manageFollowUpTool(
        {
          action: "register",
          title: "周报",
          text: "提醒我写周报",
          timezone: "Asia/Shanghai",
          recurrence: "0 17 * * 5",
          schedule_label: "每周五 17:00",
        },
        ctx,
      ),
    ).toContain("accepted");
    expect(actions).toEqual([{ kind: "followUpMutation", payload: recurring }]);
    expect(isPetHostActionRequest(actions[0])).toBe(true);
  });

  test("more often than once an hour is rejected with a clear reason", async () => {
    const { ctx, actions } = manager();
    for (const recurrence of ["*/30 * * * *", "0,30 9 * * *", "* 9 * * *", "0-5 9 * * *"]) {
      const reply = await manageFollowUpTool(
        { action: "register", title: "x", text: "x", timezone: "UTC", recurrence },
        ctx,
      );
      expect(reply).toContain("at most once an hour");
      expect(isPetFollowUpMutationPayload({ ...recurring, recurrence })).toBe(false);
    }
    expect(actions).toHaveLength(0);
  });

  test("a recurrence that is not a 5-field cron is rejected", async () => {
    const { ctx } = manager();
    for (const recurrence of ["every day at 9", "0 9 * *", "0 9 * * * *", "60 9 * * *", ""]) {
      const reply = await manageFollowUpTool(
        { action: "register", title: "x", text: "x", timezone: "UTC", recurrence },
        ctx,
      );
      expect(reply).toContain("Error");
      expect(isPetFollowUpMutationPayload({ ...recurring, recurrence })).toBe(false);
    }
  });

  test("exactly one of wake_at and recurrence; catch_up_until only with wake_at", async () => {
    const { ctx } = manager();
    expect(
      await manageFollowUpTool(
        {
          action: "register",
          title: "x",
          text: "x",
          timezone: "UTC",
          recurrence: "0 9 * * *",
          wake_at: 5_000,
        },
        ctx,
      ),
    ).toContain("either wake_at or recurrence");
    expect(
      await manageFollowUpTool({ action: "register", title: "x", text: "x", timezone: "UTC" }, ctx),
    ).toContain("either wake_at or recurrence");
    expect(isPetFollowUpMutationPayload({ ...recurring, catchUpUntil: 10_000 })).toBe(false);
    expect(isPetFollowUpMutationPayload({ ...recurring, wakeAt: 5_000 })).toBe(false);
    expect(isPetFollowUpMutationPayload({ ...recurring, missedPolicy: "skip" })).toBe(true);
  });

  test("a recurrence needs a one-line schedule_label; a one-shot takes none", async () => {
    const { ctx, actions } = manager();
    const base = { action: "register", title: "x", text: "x", timezone: "UTC" };
    for (const schedule_label of [undefined, "", "工作日\n09:00", " 前后空格 ", "长".repeat(65)]) {
      expect(
        await manageFollowUpTool({ ...base, recurrence: "0 9 * * 1-5", schedule_label }, ctx),
      ).toContain("schedule_label");
    }
    expect(
      await manageFollowUpTool({ ...base, wake_at: 5_000, schedule_label: "明天" }, ctx),
    ).toContain("recurrence only");
    expect(actions).toHaveLength(0);
    const { scheduleLabel: _label, ...unlabelled } = recurring;
    expect(isPetFollowUpMutationPayload(unlabelled)).toBe(false);
    expect(isPetFollowUpMutationPayload({ ...register, scheduleLabel: "明天" })).toBe(false);
  });

  test("reschedule can switch a follow-up to a recurrence", async () => {
    const { ctx, actions } = manager();
    expect(
      await manageFollowUpTool(
        {
          action: "reschedule",
          follow_up_id: "rule-00000000-0000-4000-8000-000000000001",
          expected_revision: 2,
          timezone: "UTC",
          recurrence: "15 8 * * 1-5",
          schedule_label: "工作日 08:15",
        },
        ctx,
      ),
    ).toContain("accepted");
    expect(actions[0]).toEqual({
      kind: "followUpMutation",
      payload: {
        action: "reschedule",
        followUpId: "rule-00000000-0000-4000-8000-000000000001",
        expectedRevision: 2,
        timezone: "UTC",
        recurrence: "15 8 * * 1-5",
        scheduleLabel: "工作日 08:15",
      },
    });
  });

  test("a recurring registered row survives Engine profile parsing", () => {
    const row = {
      kind: "registered",
      id: "rule-00000000-0000-4000-8000-000000000001",
      title: "周报",
      text: "提醒我写周报",
      revision: 1,
      wakeAt: 5_000,
      recurrence: "0 17 * * 5",
      scheduleLabel: "每周五 17:00",
      timezone: "Asia/Shanghai",
      missedPolicy: "fire-once",
      catchUpUntil: 86_405_000,
      intent: "remind",
      status: "open",
      createdAt: 1_000,
      wakeState: "scheduled",
    };
    expect(petRunOptionsFrom({ followUps: [row] }).followUps).toEqual([row]);
    expect(
      petRunOptionsFrom({ followUps: [{ ...row, recurrence: "*/5 * * * *" }] }).followUps,
    ).toEqual([]);
  });
});
