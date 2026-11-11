import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createNoticeActionSources } from "./pet-notice-action-sources.js";
import type { NoticeDraft } from "./pet-session-rule-watcher.js";
import type { SessionOutcome } from "./session-outcome.js";
import {
  NOW,
  SID,
  cleanupNoticeEnv,
  env,
  harness,
  longTask,
  resetNoticeEnv,
  settle,
  upsertArgs,
  type Harness,
} from "./test-utils/notice-wiring-harness.js";

function draft(patch: Partial<NoticeDraft>): NoticeDraft {
  return {
    kind: "session.blocked",
    priority: "P0",
    dedupeKey: "k",
    sessionId: SID,
    delivery: {} as NoticeDraft["delivery"],
    facts: {},
    ...patch,
  };
}

function sources(
  options: { external?: boolean; task?: boolean; last?: () => Promise<string> } = {},
) {
  return createNoticeActionSources({
    isExternal: () => options.external === true,
    activeTask: () => (options.task ? longTask({ id: "task-7", status: "running" }) : undefined),
    ...(options.last ? { lastUserMessage: options.last } : {}),
  });
}

describe("what each notice's open item offers", () => {
  test("a Goal waiting for the owner, and a limit stop", () => {
    expect(
      sources({ task: true }).forDraft(
        draft({ context: { reason: "user", goalId: "g-1", revision: 3 } }),
      ),
    ).toEqual({
      sessionId: SID,
      runtime: "native",
      family: "goal",
      reason: "user",
      goalId: "g-1",
      revision: 3,
      taskId: "task-7",
    });
    expect(
      sources({ external: true }).forDraft(draft({ context: { reason: "goal_exhausted" } })),
    ).toEqual({ sessionId: SID, runtime: "external", family: "limit", reason: "goal_exhausted" });
  });

  test("a failure offers 重试 only when there is a last message to resend", async () => {
    const failed = draft({ kind: "session.failed" });
    expect(await sources({ last: async () => "做完登录页" }).forDraft(failed)).toEqual({
      sessionId: SID,
      runtime: "native",
      family: "failure",
      retry: true,
    });
    expect(await sources({ last: async () => "  " }).forDraft(failed)).toEqual({
      sessionId: SID,
      runtime: "native",
      family: "failure",
    });
    const unreadable = sources({ last: () => Promise.reject(new Error("EACCES")) });
    expect(await unreadable.forDraft(failed)).not.toHaveProperty("retry");
    expect(await sources().forDraft(failed)).not.toHaveProperty("retry");
  });

  test("a result offers open for its changed files (never links read from prose), or nothing", () => {
    expect(
      sources().forDraft(
        draft({
          kind: "session.done",
          facts: { summary: "PR：https://github.com/o/r/pull/2" },
          context: { changedFiles: { cwd: "/w", paths: ["/w/a.ts"] } },
        }),
      ),
    ).toEqual({
      sessionId: SID,
      runtime: "native",
      family: "open",
      artifacts: [{ kind: "file", path: "/w/a.ts" }],
    });
    expect(sources().forDraft(draft({ kind: "session.done", facts: { summary: "好了" } }))).toBe(
      undefined,
    );
  });

  test("a task closure: retry a failed task; open what a completed one made", () => {
    const s = sources();
    expect(s.forTask(longTask({ status: "failed" }))).toEqual({
      sessionId: SID,
      runtime: "native",
      family: "failure",
      taskId: "task-1",
      retry: true,
    });
    const done = (at: number): SessionOutcome =>
      ({
        sessionId: SID,
        runKey: "r",
        at,
        final: true,
        turn: 1,
        inRun: true,
        kind: "done",
        scope: "turn",
        changedFiles: { cwd: "/w", paths: [`/w/${at}.ts`] },
      }) as SessionOutcome;
    const task = longTask({
      status: "completed",
      createdAt: NOW,
      artifacts: [{ kind: "file", label: "图", reference: "/w/out.png" }],
    });
    s.observe(SID, [done(NOW - 1)]);
    // Files changed before the task began are not its result.
    expect(s.forTask(task)?.artifacts).toEqual([{ kind: "file", path: "/w/out.png", label: "图" }]);
    s.observe(SID, [done(NOW + 5)]);
    expect(s.forTask(task)?.artifacts).toEqual([
      { kind: "file", path: `/w/${NOW + 5}.ts` },
      { kind: "file", path: "/w/out.png", label: "图" },
    ]);
    expect(s.forTask(longTask({ status: "cancelled" }))).toBeUndefined();
  });
});

let current: Harness | undefined;
beforeEach(resetNoticeEnv);
afterEach(async () => {
  await cleanupNoticeEnv(current);
  current = undefined;
});

describe("open items on routed notices", () => {
  const run = (extra: Record<string, unknown>) => [
    { type: "session_started", runId: "run-1", clientMessageId: "cm-1" },
    { type: "tool_use_start", toolCall: { id: "t1", toolName: "Edit", args: {} } },
    { type: "turn_complete", reason: "completed", runId: "run-1", ...extra },
  ];

  test("a limit stop tells the owner how to continue", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ channel: "wechat", events: ["blocked"] }));
    env.clock = NOW + 1_000;
    for (const event of run({ text: "预算用完了", completionKind: "limit_stop" }))
      current.observeSessionEvent(SID, event);
    await settle(() => current!.ownerSends.length > 0);
    await current.idle();
    const text = current.ownerSends[0]!.text;
    expect(text).toBe("「修登录」需要你决定\n要继续、停下，还是交给 Mimi？直接回我就行。");
    const [item] = current.wiring.router.openActionItems("wechat");
    expect(item?.actions).toMatchObject({
      family: "limit",
      reason: "limit",
      sessionId: SID,
    });
  });

  test("a finished turn that changed files offers open; the desktop text has no reply line", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ channel: "wechat" }));
    env.clock = NOW + 1_000;
    const events = run({ text: "改好了" });
    events.splice(2, 0, {
      type: "turn_diff",
      turnId: "u-1",
      cwd: "/work",
      files: [{ path: "/work/login.ts", status: "modified", diff: "", added: 1, removed: 0 }],
    } as never);
    for (const event of events) current.observeSessionEvent(SID, event);
    await settle(() => current!.ownerSends.length > 0);
    await current.idle();
    expect(current.ownerSends[0]!.text).toBe(
      "「修登录」做完了：改好了\n想在电脑上打开结果就回我。",
    );
    expect(current.desktop.every((input) => !input.body.includes("回我"))).toBe(true);
  });
});
