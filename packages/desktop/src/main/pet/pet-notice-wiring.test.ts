import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationSessionRoute, PetLongTask } from "@cjhyy/code-shell-pet";
import { PET_RULE_UPSERT_ACTION } from "@cjhyy/code-shell-pet/protocol";
import type { DesktopNotificationInput } from "../desktop-notifier.js";
import type { HostActionHandler } from "../host-action-dispatch.js";
import type { GatewayControlEventInput } from "../im-gateway-control-server.js";
import type { ImGatewayOwnerChannel } from "../im-gateway-service.js";
import type { NoticeSubmission } from "./pet-notice-router.js";
import {
  mergeRuleAttributes,
  parsePetNotificationSettings,
  wirePetNotices,
  type PetNoticeWiring,
  type PetNoticeWiringDeps,
} from "./pet-notice-wiring.js";
import type { NoticeRule } from "./pet-rule-store.js";
import type {
  DesktopPetProjectionEvent,
  DesktopPetProjectionSnapshot,
  DesktopPetSession,
} from "./pet-state-aggregator.js";

const SID = "s-work";
const NOW = 1_700_000_000_000;

let dir: string;
let clock = NOW;

function session(id: string, extra: Partial<DesktopPetSession> = {}): DesktopPetSession {
  return {
    agentSessionId: id,
    title: "修登录",
    runState: "running",
    queueDepth: 0,
    lastActivityAt: NOW,
    pendingDecisionCount: 0,
    freshness: { source: "live", observedAt: NOW, workerState: "active" },
    ...extra,
  } as DesktopPetSession;
}

function longTask(overrides: Partial<PetLongTask> = {}): PetLongTask {
  return {
    id: "task-1",
    sessionId: SID,
    objective: "修复登录问题",
    status: "completed",
    attempt: 1,
    artifacts: [],
    revision: 1,
    createdAt: NOW - 10_000,
    updatedAt: NOW - 10 * 60_000,
    completedAt: NOW - 10 * 60_000,
    resultSummary: "登录修好了",
    ...overrides,
  } as PetLongTask;
}

interface OwnerSend {
  targetId: string;
  text: string;
  key?: string;
  attachments?: string[];
}

interface Harness {
  wiring: PetNoticeWiring;
  handler: HostActionHandler;
  submitted: NoticeSubmission[];
  published: GatewayControlEventInput[];
  ownerSends: OwnerSend[];
  materialized: string[][];
  desktop: DesktopNotificationInput[];
  sessions: DesktopPetSession[];
  tasks: PetLongTask[];
  routes: ConversationSessionRoute[];
  channels: ImGatewayOwnerChannel[];
  emitProjection(event: DesktopPetProjectionEvent): void;
}

function harness(overrides: Partial<PetNoticeWiringDeps> = {}): Harness {
  const sessions = [session(SID)];
  const tasks: PetLongTask[] = [];
  const routes: ConversationSessionRoute[] = [];
  const channels: ImGatewayOwnerChannel[] = [
    { id: "wechat", label: "微信", ready: "ready", targetId: "wechat:owner" },
    { id: "lark", label: "飞书", ready: "unknown", targetId: "lark:owner" },
  ];
  const published: GatewayControlEventInput[] = [];
  const ownerSends: OwnerSend[] = [];
  const materialized: string[][] = [];
  const desktop: DesktopNotificationInput[] = [];
  const listeners = new Set<(event: DesktopPetProjectionEvent) => void>();
  let handler: HostActionHandler | undefined;
  const snapshot = (): DesktopPetProjectionSnapshot => ({
    version: 1,
    generation: 1,
    workerState: "active",
    sessions,
    pending: [],
    observedAt: clock,
    workMemorySegments: [],
  });
  const wiring = wirePetNotices({
    userDataDir: dir,
    bridge: {
      setHostActionHandler: (action, registered) => {
        expect(action).toBe(PET_RULE_UPSERT_ACTION);
        handler = registered;
        return () => {
          handler = undefined;
        };
      },
    },
    projection: {
      getSnapshot: snapshot,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    longTasks: {
      activeForSession: (id) =>
        tasks.find(
          (task) =>
            task.sessionId === id && !["completed", "failed", "cancelled"].includes(task.status),
        ),
      getSnapshot: () => ({ tasks }),
    },
    sessionRoutes: () => ({
      notifyRoutesForSession: async (id) => routes.filter((route) => route.sessionId === id),
    }),
    gateway: {
      ownerChannels: () => channels,
      listOwnerMessageTargets: () =>
        [
          { id: "wechat:owner", channel: "wechat", attachments: ["image"] },
          { id: "lark:owner", channel: "lark", attachments: ["image", "file"] },
        ].map((target) => ({
          ...target,
          label: target.channel,
          maxTextLength: 8_000,
          maxAttachments: 1,
          maxAttachmentBytes: 1_000,
          proactiveReady: "ready" as const,
        })) as never,
      sendOwnerMessage: async (targetId, text, attachments, options) => {
        ownerSends.push({
          targetId,
          text,
          ...(options?.idempotencyKey ? { key: options.idempotencyKey } : {}),
          ...(attachments.length > 0
            ? { attachments: attachments.map((attachment) => attachment.name) }
            : {}),
        });
        return {};
      },
      supportsIdempotentOwnerSend: (channel) => channel === "wechat",
      lastOwnerInboundChannel: () => "wechat",
    },
    publishRoute: async (event) => {
      published.push(event);
    },
    materializeAttachments: async (files) => {
      materialized.push(files.map((file) => file.path));
      return files.map((file) => ({
        kind: file.kind,
        name: file.name,
        mimeType: file.mimeType,
        data: new Uint8Array(),
      }));
    },
    notifyDesktop: async (input) => {
      desktop.push(input);
      return "shown";
    },
    readSettings: () => ({}),
    // Away from the computer: auto notices go to IM.
    presence: { getSystemIdleTimeSec: () => 3_600, hasFocusedWindow: () => false },
    now: () => clock,
    log: () => undefined,
    timezoneOffsetMin: () => 0,
    ...overrides,
  } as PetNoticeWiringDeps);
  if (!handler) throw new Error("host action handler was not registered");
  const submitted: NoticeSubmission[] = [];
  const realSubmit = wiring.router.submit.bind(wiring.router);
  wiring.router.submit = async (notice) => {
    submitted.push(structuredClone(notice));
    return realSubmit(notice);
  };
  return {
    wiring,
    handler: (sessionId, args) => handler!(sessionId, args),
    submitted,
    published,
    ownerSends,
    materialized,
    desktop,
    sessions,
    tasks,
    routes,
    channels,
    emitProjection: (event) => {
      for (const listener of listeners) listener(event);
    },
  };
}

function upsertArgs(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: SID,
    createdBy: "notify-me",
    events: ["done", "failed"],
    scope: "turn",
    channel: "auto",
    attention: "always",
    ...extra,
  };
}

function boundRoute(): ConversationSessionRoute {
  return {
    schemaVersion: 1,
    id: "route-1",
    routeKey: "im:wechat\u0000chat-1\u0000owner-1",
    channel: "wechat",
    target: "chat-1",
    senderId: "owner-1",
    sessionId: SID,
    sessionTitle: "修登录",
    mode: "bound",
    origin: "enter",
    status: "active",
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  } as ConversationSessionRoute;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1)
    await new Promise((resolve) => setTimeout(resolve, 1));
}

let current: Harness | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pet-notice-wiring-"));
  clock = NOW;
});

afterEach(async () => {
  current?.wiring.dispose();
  current = undefined;
  await rm(dir, { recursive: true, force: true });
});

describe("parsePetNotificationSettings", () => {
  test("defaults until the settings schema exists", () => {
    expect(parsePetNotificationSettings({})).toEqual({
      quietHours: { start: "23:00", end: "08:30" },
      maxPerHour: 6,
      maxP0PerHour: 12,
      mergeWindowSec: 600,
      presenceIdleSec: 120,
      delegatedFromDesktop: "auto",
    });
  });

  test("reads bounded values and falls back on malformed ones", () => {
    const parsed = parsePetNotificationSettings({
      pet: {
        notifications: {
          quietHours: null,
          maxPerHour: 3,
          maxP0PerHour: -1,
          mergeWindowSec: "10",
          presenceIdleSec: 300,
          delegatedFromDesktop: "desktop",
        },
      },
    });
    expect(parsed).toEqual({
      quietHours: null,
      maxPerHour: 3,
      maxP0PerHour: 12,
      mergeWindowSec: 600,
      presenceIdleSec: 300,
      delegatedFromDesktop: "desktop",
    });
  });
});

describe("mergeRuleAttributes", () => {
  const base = {
    attention: "important",
    channel: "auto",
    target: { kind: "owner" },
  } as unknown as NoticeRule;
  test("strongest attention, named IM over auto, route over owner", () => {
    const route = {
      kind: "route",
      route: { kind: "im-gateway", channel: "wechat", target: "chat-1" },
    } as const;
    expect(
      mergeRuleAttributes([
        base,
        { ...base, attention: "always", channel: "lark" },
        { ...base, channel: "desktop", target: route },
      ]),
    ).toEqual({ attention: "always", channel: "lark", target: route });
    expect(mergeRuleAttributes([{ ...base, channel: "desktop" }]).channel).toBe("desktop");
    expect(mergeRuleAttributes([{ ...base, channel: "desktop" }, base]).channel).toBe("auto");
  });
});

describe("NotifyMe host action", () => {
  test("stores a user rule and reports its effect", async () => {
    current = harness();
    const reply = await current.handler(SID, upsertArgs());
    expect(reply).toMatchObject({
      ok: true,
      status: "ok",
      effect: {
        fires: "这个会话下一次完成实际工作后",
        channel: "auto",
        im: { channel: "wechat", label: "微信", ready: "ready" },
        quietHours: "23:00–08:30 只推需要你决定的事",
      },
    });
    const [rule] = current.wiring.ruleStore.activeForSession(SID);
    expect(rule).toMatchObject({
      origin: "user",
      target: { kind: "owner" },
      when: { kind: "session", sessionId: SID, scope: "turn", armedAt: NOW },
    });
    expect((reply as { effect: { ruleId: string } }).effect.ruleId).toBe(rule!.id);
  });

  test("a goal rule on a bound Session targets its IM conversation", async () => {
    current = harness();
    current.routes.push(boundRoute());
    const reply = await current.handler(SID, upsertArgs({ scope: "goal", channel: "lark" }));
    // The bound conversation's channel is the one that will actually be used.
    expect(reply).toMatchObject({
      status: "ok",
      effect: {
        fires: "目标完成或卡住时",
        channel: "lark",
        im: { channel: "wechat", label: "微信", ready: "ready" },
      },
    });
    expect(current.wiring.ruleStore.activeForSession(SID)[0]!.target).toMatchObject({
      kind: "route",
      route: { kind: "im-gateway", channel: "wechat", target: "chat-1", senderId: "owner-1" },
    });
  });

  test("an unbound channel returns the bound channels and saves nothing", async () => {
    current = harness();
    const reply = await current.handler(SID, upsertArgs({ channel: "telegram" }));
    expect(reply).toEqual({
      ok: true,
      status: "unknown_channel",
      channels: [
        { id: "wechat", label: "微信", ready: "ready" },
        { id: "lark", label: "飞书", ready: "unknown" },
      ],
    });
    expect(current.wiring.ruleStore.activeForSession(SID)).toEqual([]);
  });

  test("rejects malformed args, another Session's id and unknown Sessions", async () => {
    current = harness();
    await expect(current.handler(SID, upsertArgs({ events: ["later"] }))).rejects.toThrow(
      "invalid notice rule request",
    );
    await expect(current.handler(SID, { ...upsertArgs(), extra: 1 })).rejects.toThrow(
      "invalid notice rule request",
    );
    await expect(current.handler("s-other", upsertArgs())).rejects.toThrow("for itself");
    await expect(current.handler("s-ghost", upsertArgs({ sessionId: "s-ghost" }))).rejects.toThrow(
      "unknown work Session",
    );
    current.sessions[0] = session(SID, { external: { cli: "codex" } });
    await expect(current.handler(SID, upsertArgs())).rejects.toThrow("unknown work Session");
  });
});

describe("rule watcher wiring", () => {
  test("a done draft reaches the router with the matched rules' attributes", async () => {
    current = harness();
    current.routes.push(boundRoute());
    await current.handler(SID, upsertArgs({ attention: "important" }));
    current.routes.length = 0;
    await current.handler(SID, upsertArgs({ channel: "lark" }));
    expect(current.wiring.ruleStore.activeForSession(SID)).toHaveLength(2);
    clock = NOW + 1_000;
    const events = [
      { type: "session_started", runId: "run-1", clientMessageId: "cm-1" },
      { type: "tool_use_start", toolCall: { id: "t1", toolName: "Bash", args: {} } },
      { type: "turn_complete", reason: "completed", text: "测试都过了", runId: "run-1" },
    ];
    for (const event of events) current.wiring.observeSessionEvent(SID, event);
    await settle();
    expect(current.submitted).toHaveLength(1);
    expect(current.submitted[0]).toMatchObject({
      kind: "session.done",
      sessionId: SID,
      attention: "always",
      channel: "lark",
      target: { kind: "route", route: { channel: "wechat", target: "chat-1" } },
      facts: { title: "修登录", summary: "测试都过了" },
    });
    expect(current.submitted[0]!.ruleIds).toHaveLength(2);
    // The route pins the channel: one message back to the bound WeChat conversation.
    expect(current.published).toHaveLength(1);
    expect(current.published[0]).toMatchObject({
      type: "pet.task.completed",
      title: "Mimi 任务已完成",
      text: "「修登录」做完了：测试都过了",
      target: { channel: "wechat", target: "chat-1" },
    });
    expect(current.published[0]!.deliveryKey).toMatch(/^[0-9a-f]{64}$/u);
    expect(current.wiring.ruleStore.activeForSession(SID)).toEqual([]);
  });

  test("Sessions with a long task leave done to the closure notice", async () => {
    current = harness();
    current.tasks.push(longTask({ status: "running", completedAt: undefined, updatedAt: NOW }));
    await current.handler(SID, upsertArgs());
    clock = NOW + 1_000;
    for (const event of [
      { type: "session_started", runId: "run-1", clientMessageId: "cm-1" },
      { type: "tool_use_start", toolCall: { id: "t1", toolName: "Bash", args: {} } },
      { type: "turn_complete", reason: "completed", runId: "run-1" },
    ])
      current.wiring.observeSessionEvent(SID, event);
    await settle();
    expect(current.submitted).toEqual([]);
  });

  test("a closed long task owns only the run it closed", async () => {
    current = harness();
    current.tasks.push(longTask({ runId: "run-1", completedAt: NOW, updatedAt: NOW }));
    await current.handler(SID, upsertArgs());
    clock = NOW + 1_000;
    const turn = (runId: string) => [
      { type: "session_started", runId, clientMessageId: `cm-${runId}` },
      { type: "tool_use_start", toolCall: { id: "t1", toolName: "Bash", args: {} } },
      { type: "turn_complete", reason: "completed", runId },
    ];
    for (const event of turn("run-1")) current.wiring.observeSessionEvent(SID, event);
    await settle();
    expect(current.submitted).toEqual([]);
    // A later turn in the same Session is the owner's own work again.
    for (const event of turn("run-2")) current.wiring.observeSessionEvent(SID, event);
    await settle();
    expect(current.submitted.map((notice) => notice.dedupeKey)).toEqual([`${SID}:turn:run-2`]);
  });

  test("a pending decision becomes a blocked notice for a rule that watches it", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ events: ["blocked"] }));
    clock = NOW + 1_000;
    current.emitProjection({
      kind: "pending-upsert",
      pending: {
        agentSessionId: SID,
        requestId: "req-1",
        workerGeneration: 1,
        kind: "ask_user",
        title: "用哪个数据库？",
        createdAt: clock,
        status: "pending",
      } as never,
      version: 2,
      generation: 1,
      observedAt: clock,
    });
    await settle();
    expect(current.submitted[0]).toMatchObject({
      kind: "session.blocked",
      priority: "P0",
      requestId: "req-1",
      channel: "auto",
      target: { kind: "owner" },
    });
  });
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
    clock = Date.UTC(2026, 10, 9, 23, 30, 0);
    const route = { kind: "im-gateway" as const, channel: "wechat", target: "chat-9" };
    await current.wiring.notifyTaskClosed(longTask({ completionTarget: route }), { text: "一" });
    clock += 5 * 60_000;
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
          path: "/w/comic.png",
        },
      ],
      button: { text: "打开", url: "https://example.com/comic" },
    };
    // A quiet-hours closure with media is still sent, never digested.
    clock = Date.UTC(2026, 10, 9, 23, 30, 0);
    const task = longTask({ completionTarget: route });
    await current.wiring.notifyTaskClosed(task, { text: "漫画在这。", media });
    await current.wiring.notifyTaskClosed(task, { text: "漫画在这。", media });
    expect(current.published).toHaveLength(1);
    expect(current.published[0]).toMatchObject({
      text: "漫画在这。",
      attachments: media.attachments,
      button: media.button,
      target: { channel: "wechat", target: "chat-9" },
    });
    // Desktop shows it too (named channel), pointing at the Session for the files.
    expect(current.desktop[0]).toMatchObject({ sessionId: SID });
    expect(current.desktop[0]!.body).toContain("含 1 个附件");
  });

  test("owner-target media is filtered by the target's capabilities", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ channel: "wechat" }));
    const media = {
      attachments: [
        {
          kind: "file" as const,
          name: "a.zip",
          mimeType: "application/zip",
          size: 10,
          path: "/w/a.zip",
        },
        {
          kind: "image" as const,
          name: "big.png",
          mimeType: "image/png",
          size: 5_000,
          path: "/w/big.png",
        },
        {
          kind: "image" as const,
          name: "a.png",
          mimeType: "image/png",
          size: 10,
          path: "/w/a.png",
        },
        {
          kind: "image" as const,
          name: "b.png",
          mimeType: "image/png",
          size: 10,
          path: "/w/b.png",
        },
      ],
      button: { text: "查看", url: "https://example.com/r" },
    };
    await current.wiring.notifyTaskClosed(longTask(), { text: "好了", media });
    // WeChat target: images only, ≤1 000 bytes, at most one.
    expect(current.materialized).toEqual([["/w/a.png"]]);
    expect(current.ownerSends).toEqual([
      {
        targetId: "wechat:owner",
        text: "好了\n查看：https://example.com/r",
        key: expect.stringMatching(/^[0-9a-f]{24}$/u),
        attachments: ["a.png"],
      },
    ]);
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

describe("pending-notice replay", () => {
  test("a queued notice is taken when the inbound turn starts and settled then", async () => {
    current = harness();
    current.channels[1] = { id: "lark", label: "飞书", ready: "unavailable" };
    await current.handler(SID, upsertArgs({ channel: "lark" }));
    await current.wiring.notifyTaskClosed(longTask({ status: "failed", lastError: "编译失败" }));
    expect(current.ownerSends).toEqual([]);
    const origin = { channel: "lark", target: "dm-1", senderId: "owner", isDirectMessage: true };
    expect(await current.wiring.inboundReplay({ ...origin, channel: "wechat" })!.take()).toEqual(
      [],
    );
    expect(
      await current.wiring.inboundReplay({ ...origin, isDirectMessage: false })!.take(),
    ).toEqual([]);
    expect(current.wiring.inboundReplay(undefined)).toBeUndefined();

    // Taken but the turn never started (e.g. it failed first): released.
    const first = current.wiring.inboundReplay(origin)!;
    expect(await first.take()).toEqual([
      { kind: "session.failed", title: "修登录", body: "「修登录」没做完：编译失败" },
    ]);
    const concurrent = current.wiring.inboundReplay(origin)!;
    expect(await concurrent.take()).toEqual([]);
    concurrent.finish();
    first.finish();

    // A message that waited in the queue takes them only when its turn starts.
    const queued = current.wiring.inboundReplay(origin)!;
    const second = current.wiring.inboundReplay(origin)!;
    expect(await second.take()).toHaveLength(1);
    second.started();
    second.finish();
    await settle();
    expect(await queued.take()).toEqual([]);
    queued.finish();
  });

  test("a queued owner notice with media is sent on the next inbound, not put in the turn", async () => {
    current = harness();
    current.channels[1] = { id: "lark", label: "飞书", ready: "unavailable" };
    await current.handler(SID, upsertArgs({ channel: "lark" }));
    const media = {
      attachments: [
        {
          kind: "file" as const,
          name: "r.txt",
          mimeType: "text/plain",
          size: 10,
          path: "/w/r.txt",
        },
      ],
    };
    await current.wiring.notifyTaskClosed(longTask(), { text: "报告好了", media });
    expect(current.ownerSends).toEqual([]);
    current.channels[1] = { id: "lark", label: "飞书", ready: "ready", targetId: "lark:owner" };
    const replay = current.wiring.inboundReplay({
      channel: "lark",
      target: "dm-1",
      isDirectMessage: true,
    })!;
    expect(await replay.take()).toEqual([]);
    expect(current.ownerSends).toEqual([
      expect.objectContaining({ targetId: "lark:owner", text: "报告好了", attachments: ["r.txt"] }),
    ]);
  });
});

describe("viewed Sessions", () => {
  test("setActiveSession records what the owner looked at", async () => {
    current = harness();
    const probe = (
      current.wiring.router as unknown as {
        options: { wasSessionViewedSince(id: string, ms: number): boolean };
      }
    ).options;
    expect(probe.wasSessionViewedSince(SID, NOW - 1)).toBe(false);
    current.wiring.attention.setActiveSession(SID);
    clock = NOW + 5_000;
    current.wiring.attention.setActiveSession(null);
    expect(probe.wasSessionViewedSince(SID, NOW + 4_000)).toBe(true);
    expect(probe.wasSessionViewedSince(SID, NOW + 6_000)).toBe(false);
  });
});
