import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { PetLongTask } from "@cjhyy/code-shell-pet";
import { PetLongTaskCoordinator } from "./pet-long-task-coordinator.js";
import { PetLongTaskStore } from "./pet-long-task-store.js";
import { petDelegationClientMessageId } from "./pet-work-delegation-host.js";
import { createSessionOutcomeTap } from "./session-outcome.js";
import {
  NOW,
  SID,
  cleanupNoticeEnv,
  env,
  freshNoticeDir,
  frozenPath,
  harness,
  longTask,
  resetNoticeEnv,
  settle,
  sourceFile,
  upsertArgs,
  type Harness,
} from "./test-utils/notice-wiring-harness.js";

let current: Harness | undefined;

beforeEach(resetNoticeEnv);

afterEach(async () => {
  await cleanupNoticeEnv(current);
  current = undefined;
});

describe("long-task closure", () => {
  test("one notice per closure, addressed to the task's IM origin, spending the rules", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ channel: "lark" }));
    const route = { kind: "im-gateway" as const, channel: "wechat", target: "chat-9" };
    const task = longTask({ completionTarget: route });
    await current.wiring.notifyTaskClosed(task, { text: "登录修好了，测试全过。" });
    await current.wiring.notifyTaskClosed(task, { text: "登录修好了，测试全过。" });
    expect(current.submitted).toHaveLength(2);
    expect(current.submitted[0]).toMatchObject({
      kind: "session.done",
      priority: "P1",
      dedupeKey: "task:task-1:1:completed",
      sessionId: SID,
      attention: "always",
      channel: "wechat",
      reply: true,
      target: { kind: "route", route },
      body: "登录修好了，测试全过。",
      facts: { title: "修登录", summary: "登录修好了" },
    });
    // The replay of the same closure is a duplicate: exactly one message goes out.
    expect(current.published).toHaveLength(1);
    expect(current.published[0]).toMatchObject({
      type: "pet.task.completed",
      title: "Mimi 任务已完成",
      text: "登录修好了，测试全过。",
      target: { channel: "wechat", target: "chat-9" },
    });
    expect(current.published[0]!.deliveryKey).toMatch(/^[0-9a-f]{64}$/u);
    expect(current.ownerSends).toEqual([]);
    expect(current.wiring.ruleStore.activeForSession(SID)).toEqual([]);
    expect(current.wiring.ruleStore.list()[0]!.state).toBe("spent");
  });

  test("a desktop-started task uses the rule's channel for the owner", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ channel: "lark" }));
    await current.wiring.notifyTaskClosed(longTask({ status: "failed", lastError: "编译失败" }));
    expect(current.submitted).toHaveLength(1);
    expect(current.submitted[0]).toMatchObject({
      kind: "session.failed",
      dedupeKey: "task:task-1:1:failed",
      channel: "lark",
      target: { kind: "owner" },
      facts: { error: "编译失败" },
    });
    expect(current.submitted[0]!.body).toBeUndefined();
    // Named IM: both the desktop and the owner's Lark target.
    expect(current.ownerSends).toEqual([
      { targetId: "lark:owner", text: "「修登录」没做完：编译失败" },
    ]);
    expect(current.desktop).toHaveLength(1);
    expect(current.desktop[0]).toMatchObject({ title: "Mimi 任务执行失败", sessionId: SID });
  });

  test("without rules a desktop task follows the delegatedFromDesktop setting", async () => {
    current = harness({
      readSettings: () => ({ pet: { notifications: { delegatedFromDesktop: "desktop" } } }),
    });
    await current.wiring.notifyTaskClosed(longTask());
    expect(current.submitted[0]).toMatchObject({ channel: "desktop", ruleIds: [] });
    expect(current.ownerSends).toEqual([]);
    expect(current.desktop).toHaveLength(1);
  });

  test("a retried attempt that fails again notifies again", async () => {
    // No merge window, so the second failure is visible as its own send.
    current = harness({
      readSettings: () => ({ pet: { notifications: { mergeWindowSec: 0 } } }),
    });
    await current.wiring.notifyTaskClosed(longTask({ status: "failed", attempt: 1 }));
    await current.wiring.notifyTaskClosed(longTask({ status: "failed", attempt: 2 }));
    expect(current.submitted.map((notice) => notice.dedupeKey)).toEqual([
      "task:task-1:1:failed",
      "task:task-1:2:failed",
    ]);
    expect(current.ownerSends).toHaveLength(2);
  });

  test("IM-started results reply immediately, in quiet hours and inside the merge window", async () => {
    current = harness();
    // 23:30 at UTC+0, inside the default 23:00–08:30 quiet hours.
    env.clock = Date.UTC(2026, 10, 9, 23, 30, 0);
    const route = { kind: "im-gateway" as const, channel: "wechat", target: "chat-9" };
    await current.wiring.notifyTaskClosed(longTask({ completionTarget: route }), { text: "一" });
    env.clock += 5 * 60_000;
    await current.wiring.notifyTaskClosed(longTask({ id: "task-2", completionTarget: route }), {
      text: "二",
    });
    expect(current.published.map((event) => event.text)).toEqual(["一", "二"]);
  });

  test("an image result reaches the route once, with its attachments and button", async () => {
    current = harness();
    const route = {
      kind: "im-gateway" as const,
      channel: "wechat",
      target: "chat-9",
      replyAttachmentKinds: ["image" as const],
    };
    const media = {
      attachments: [
        {
          kind: "image" as const,
          name: "comic.png",
          mimeType: "image/png",
          size: 123,
          path: await sourceFile("comic.png", 123),
        },
      ],
      button: { text: "打开", url: "https://example.com/comic" },
    };
    // A quiet-hours closure with media is still sent, never digested.
    env.clock = Date.UTC(2026, 10, 9, 23, 30, 0);
    const task = longTask({ completionTarget: route });
    await current.wiring.notifyTaskClosed(task, { text: "漫画在这。", media });
    await current.wiring.notifyTaskClosed(task, { text: "漫画在这。", media });
    expect(current.published).toHaveLength(1);
    expect(current.published[0]).toMatchObject({
      text: "漫画在这。",
      // The frozen copy, in the outbox's own descriptor shape (no digest field).
      attachments: [{ ...media.attachments[0], path: frozenPath }],
      button: media.button,
      target: { channel: "wechat", target: "chat-9" },
    });
    expect(Object.keys(current.published[0]!.attachments![0]!).sort()).toEqual([
      "kind",
      "mimeType",
      "name",
      "path",
      "size",
    ]);
    // Desktop shows it too (named channel), pointing at the Session for the files.
    expect(current.desktop[0]).toMatchObject({ sessionId: SID });
    expect(current.desktop[0]!.body).toContain("含 1 个附件");
  });

  test("a cancelled task produces no notice", async () => {
    current = harness();
    await current.handler(SID, upsertArgs());
    await current.wiring.notifyTaskClosed(longTask({ status: "cancelled" }), { text: "已取消" });
    expect(current.submitted).toEqual([]);
    expect(current.published).toEqual([]);
    expect(current.desktop).toEqual([]);
    expect(current.wiring.ruleStore.activeForSession(SID)).toHaveLength(1);
  });
});

describe("delegation rules", () => {
  const running = (overrides: Partial<PetLongTask> = {}) =>
    longTask({ status: "running", completedAt: undefined, verificationMode: "turn", ...overrides });

  test("an IM delegation arms an always-on rule back to its conversation", async () => {
    current = harness();
    const route = { kind: "im-gateway" as const, channel: "wechat", target: "chat-9" };
    const task = running({ completionTarget: route, verificationMode: "goal" });
    current.tasks.push(task);
    await current.wiring.armDelegationRule(task);
    const rules = current.wiring.ruleStore.activeForSession(SID);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      origin: "delegation",
      createdBy: "delegation",
      when: {
        kind: "session",
        sessionId: SID,
        events: ["done", "failed", "blocked"],
        scope: "goal",
        armedAt: NOW,
      },
      channel: "wechat",
      attention: "always",
      target: { kind: "route", route },
    });
    // Blocked prompts for this Session now have somewhere to go.
    expect(current.wiring.decisions.deliveryFor(SID, undefined)).toBeDefined();
  });

  test("a desktop delegation targets the owner on the delegatedFromDesktop channel", async () => {
    current = harness();
    await current.wiring.armDelegationRule(running());
    expect(current.wiring.ruleStore.activeForSession(SID)[0]).toMatchObject({
      when: { scope: "turn", events: ["done", "failed", "blocked"] },
      channel: "auto",
      target: { kind: "owner" },
    });
    current.wiring.dispose();
    await freshNoticeDir();
    current = harness({
      readSettings: () => ({ pet: { notifications: { delegatedFromDesktop: "desktop" } } }),
    });
    await current.wiring.armDelegationRule(running());
    expect(current.wiring.ruleStore.activeForSession(SID)[0]).toMatchObject({
      channel: "desktop",
      target: { kind: "owner" },
    });
  });

  test("re-arming a continuation updates the one rule; an owner rule is left alone", async () => {
    current = harness();
    await current.wiring.armDelegationRule(running());
    await current.wiring.armDelegationRule(running({ id: "task-2", verificationMode: "goal" }));
    const rules = current.wiring.ruleStore.activeForSession(SID);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ version: 2, when: { scope: "goal" } });

    current.wiring.dispose();
    await freshNoticeDir();
    current = harness();
    await current.handler(SID, upsertArgs({ channel: "lark", events: ["done"] }));
    await current.wiring.armDelegationRule(running());
    expect(current.wiring.ruleStore.activeForSession(SID)).toEqual([
      expect.objectContaining({ origin: "user", channel: "lark", version: 1 }),
    ]);
  });

  test("a paused owner rule also keeps the automatic rule out", async () => {
    current = harness();
    await current.handler(SID, upsertArgs());
    const [owner] = current.wiring.ruleStore.activeForSession(SID);
    await current.wiring.ruleStore.update(owner!.id, owner!.version, { state: "paused" });
    await current.wiring.armDelegationRule(running());
    expect(current.wiring.ruleStore.activeForSession(SID)).toEqual([]);
    expect(current.wiring.ruleStore.list()).toEqual([
      expect.objectContaining({ origin: "user", state: "paused" }),
    ]);
  });

  test("a rule that cannot be stored is logged and never thrown", async () => {
    const logged: string[] = [];
    current = harness({ log: (event) => logged.push(event) });
    current.wiring.ruleStore.upsertSessionRule = async () => {
      throw new Error("disk full");
    };
    await expect(current.wiring.armDelegationRule(running())).resolves.toBeUndefined();
    expect(logged).toContain("pet.notice.delegation_rule_failed");
  });

  test("the long task's closure spends the delegation rule with its one notice", async () => {
    current = harness();
    await current.wiring.armDelegationRule(running());
    const [rule] = current.wiring.ruleStore.activeForSession(SID);
    await current.wiring.notifyTaskClosed(longTask(), { text: "登录修好了" });
    expect(current.submitted).toHaveLength(1);
    expect(current.submitted[0]!.ruleIds).toEqual([rule!.id]);
    expect(current.wiring.ruleStore.activeForSession(SID)).toEqual([]);
    expect(current.wiring.ruleStore.get(rule!.id)?.state).toBe("spent");
  });

  test("a cancelled delegation spends only its automatic rule, silently", async () => {
    current = harness();
    await current.wiring.armDelegationRule(
      running({ completionTarget: { kind: "im-gateway", channel: "wechat", target: "chat-9" } }),
    );
    await current.handler(SID, upsertArgs());
    await current.wiring.notifyTaskClosed(longTask({ status: "cancelled" }));
    expect(current.submitted).toEqual([]);
    expect(current.wiring.ruleStore.activeForSession(SID)).toEqual([
      expect.objectContaining({ origin: "user" }),
    ]);
  });

  test("NotifyMe on a delegated Session takes the rule over; re-arming and cancel leave it", async () => {
    current = harness();
    // A desktop delegation: Mimi's rule targets the owner, like NotifyMe does.
    await current.wiring.armDelegationRule(running());
    const [delegation] = current.wiring.ruleStore.activeForSession(SID);
    await current.handler(SID, upsertArgs({ channel: "lark", events: ["done"] }));
    const [owned] = current.wiring.ruleStore.activeForSession(SID);
    expect(owned).toMatchObject({
      id: delegation!.id,
      origin: "user",
      createdBy: "notify-me",
      channel: "lark",
      when: { events: ["done"] },
    });
    // Mimi re-driving the task never rewrites the owner's rule.
    await current.wiring.armDelegationRule(running({ id: "task-2", verificationMode: "goal" }));
    expect(current.wiring.ruleStore.activeForSession(SID)).toEqual([owned!]);
    // Cancelling the task spends only Mimi's own rules.
    await current.wiring.notifyTaskClosed(longTask({ status: "cancelled" }));
    expect(current.wiring.ruleStore.activeForSession(SID)).toEqual([owned!]);
  });
});

describe("the real coordinator and watcher on one tap", () => {
  test("an IM-delegated done is told once, by the closure, in its conversation", async () => {
    const store = new PetLongTaskStore(join(env.dir, "long-tasks.json"), () => env.clock);
    current = harness({
      longTasks: store,
      readSettings: () => ({ pet: { notifications: { mergeWindowSec: 0 } } }),
    });
    const h = current;
    const route = { kind: "im-gateway" as const, channel: "wechat", target: "chat-9" };
    const identity = { runId: "run-1", clientMessageId: petDelegationClientMessageId("cm-im") };
    let tap: (sessionId: string, event: unknown) => void = () => undefined;
    const coordinator = new PetLongTaskCoordinator({
      store,
      projection: { getSnapshot: h.snapshot, subscribe: h.subscribeProjection },
      worker: {
        hasLiveWorker: () => true,
        requestWorker: async () => ({ ok: false as const, message: "no worker" }),
      },
      launcher: {
        start: async (delegation) => {
          tap(SID, { type: "session_started", sessionId: SID, promptTokens: 0, ...identity });
          return { sessionId: delegation.targetSessionId ?? SID, cwd: "/work/app" };
        },
      },
      now: () => env.clock,
      onDelegationStarted: (task) => h.wiring.armDelegationRule(task),
      onTaskClosed: (task) => h.wiring.notifyTaskClosed(task, { text: "登录修好了，可以验收。" }),
    });
    // main's tap: one interpretation, coordinator first, then the notice watcher.
    tap = createSessionOutcomeTap(
      {
        coordinator: (sessionId, event, outcomes) =>
          void coordinator.observeSessionEvent(sessionId, event, outcomes),
        watcher: (sessionId, outcomes) => h.wiring.observeSessionOutcomes(sessionId, outcomes),
      },
      h.deriver,
    );
    await coordinator.start();
    try {
      const launch = await coordinator.startDelegation({
        clientMessageId: "cm-im",
        task: "修复登录问题",
        workspacePath: "/work/app",
        targetSessionId: SID,
        completionTarget: route,
      });
      expect(h.wiring.ruleStore.activeForSession(SID)).toMatchObject([{ origin: "delegation" }]);
      env.clock = NOW + 1_000;
      tap(SID, { type: "tool_use_start", toolCall: { id: "t1", toolName: "Bash", args: {} } });
      tap(SID, { type: "turn_complete", reason: "completed", text: "改好了", ...identity });
      await settle(() => h.published.length > 0);
      await h.idle();
      await settle();
      expect(store.get(launch.taskId)?.status).toBe("completed");
      // The watcher left the run to the closure: one notice, Mimi's text, back to the chat.
      expect(h.submitted.map((notice) => [notice.dedupeKey, notice.body])).toEqual([
        [`task:${launch.taskId}:1:completed`, "登录修好了，可以验收。"],
      ]);
      expect(h.published).toMatchObject([
        { type: "pet.task.completed", target: { channel: "wechat", target: "chat-9" } },
      ]);
      expect(h.ownerSends).toEqual([]);
      expect(h.wiring.ruleStore.activeForSession(SID)).toEqual([]);
    } finally {
      coordinator.stop();
    }
  });
});
