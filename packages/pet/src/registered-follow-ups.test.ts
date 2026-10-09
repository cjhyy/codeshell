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
      id: "registered-followup-a",
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
      validatePetRunParams({ behaviorMode: "pet", kind: "pet", profileParams: { followUps: [row] } }),
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
          follow_up_id: "registered-followup-a",
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
        followUpId: "registered-followup-a",
        expectedRevision: 2,
        wakeAt: 10_000,
        timezone: "UTC",
        missedPolicy: "skip",
        catchUpUntil: 12_000,
      },
    });
    expect(
      await manageFollowUpTool({ action: "cancel", follow_up_id: "registered-followup-a" }, ctx),
    ).toContain("requires");
    expect(
      await manageFollowUpTool({ action: "complete", follow_up_id: "registered-followup-a" }, ctx),
    ).toContain("expected_revision");
    expect(
      await manageFollowUpTool({ action: "dismiss", follow_up_id: "followup-a" }, ctx),
    ).toContain("accepted");
    expect(isPetFollowUpMutationPayload({ ...register, catchUpUntil: 4_999 })).toBe(false);
    expect(isPetFollowUpMutationPayload({ ...register, timezone: "bad/zone" })).toBe(false);
    expect(isPetFollowUpMutationPayload({ ...register, wakeAt: Infinity })).toBe(false);
  });
});
