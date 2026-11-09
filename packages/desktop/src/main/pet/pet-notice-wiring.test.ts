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
import { collectImDecisions, PetImDecisions } from "./pet-im-decisions.js";
import type { NoticeSubmission } from "./pet-notice-router.js";
import type { PetReusableSessionCandidate } from "./pet-dispatch-service.js";
import {
  createBoundSessionRunner,
  createSessionBridgeWiring,
  type SessionBridgeWiring,
} from "./session-bridge-wiring.js";
import {
  mergeRuleAttributes,
  parsePetNotificationSettings,
  petNotificationSettingsView,
  wirePetNotices,
  type PetNoticeWiring,
  type PetNoticeWiringDeps,
} from "./pet-notice-wiring.js";
import type { NoticeRule } from "./pet-rule-store.js";
import type {
  DesktopPendingDecision,
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
  pending: DesktopPendingDecision[];
  tasks: PetLongTask[];
  routes: ConversationSessionRoute[];
  channels: ImGatewayOwnerChannel[];
  directTargets: Set<string>;
  snapshot(): DesktopPetProjectionSnapshot;
  emitProjection(event: DesktopPetProjectionEvent): void;
}

function harness(overrides: Partial<PetNoticeWiringDeps> = {}): Harness {
  const sessions = [session(SID)];
  const pending: DesktopPendingDecision[] = [];
  const tasks: PetLongTask[] = [];
  const routes: ConversationSessionRoute[] = [];
  const channels: ImGatewayOwnerChannel[] = [
    { id: "wechat", label: "微信", ready: "ready", targetId: "wechat:owner", isDirect: true },
    { id: "lark", label: "飞书", ready: "unknown", targetId: "lark:owner", isDirect: true },
  ];
  /** Owner targets confirmed as private chats (tests drop one to model a group). */
  const directTargets = new Set(["wechat:owner", "lark:owner"]);
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
    pending,
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
          ...(directTargets.has(target.id) ? { isDirect: true as const } : {}),
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
      isOwnerConversation: (channel, target) =>
        (channel === "wechat" && target === "owner-dm") ||
        (channel === "lark" && target === "dm-1"),
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
    pending,
    tasks,
    routes,
    channels,
    directTargets,
    snapshot,
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

  test("uses the settings schema's bounds", () => {
    const parsed = parsePetNotificationSettings({
      pet: {
        notifications: {
          quietHours: { start: "22:00", end: "25:00" },
          maxPerHour: 61,
          maxP0PerHour: 120,
          mergeWindowSec: 3_600,
          presenceIdleSec: 10,
        },
      },
    });
    expect(parsed).toMatchObject({
      quietHours: { start: "23:00", end: "08:30" },
      maxPerHour: 6,
      maxP0PerHour: 120,
      mergeWindowSec: 3_600,
      presenceIdleSec: 120,
    });
  });

  test("quiet hours switched off keep their times for the form", () => {
    const settings = {
      pet: { notifications: { quietHours: { start: "22:15", end: "07:45", enabled: false } } },
    };
    expect(parsePetNotificationSettings(settings).quietHours).toBeNull();
    expect(petNotificationSettingsView(settings).quietHours).toEqual({
      enabled: false,
      start: "22:15",
      end: "07:45",
    });
    expect(petNotificationSettingsView({}).quietHours).toEqual({
      enabled: true,
      start: "23:00",
      end: "08:30",
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

  test("a pending decision nudges the decision module and never becomes a second prompt", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ events: ["blocked"] }));
    const nudged: string[] = [];
    current.wiring.decisions.onBlocked((sessionId) => nudged.push(sessionId));
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
    expect(nudged).toEqual([SID]);
    expect(current.submitted).toEqual([]);
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
    expect(current.wiring.decisions.rulesFor(SID)).toBeDefined();
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
    await rm(dir, { recursive: true, force: true });
    dir = await mkdtemp(join(tmpdir(), "pet-notice-wiring-"));
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
    await rm(dir, { recursive: true, force: true });
    dir = await mkdtemp(join(tmpdir(), "pet-notice-wiring-"));
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
    current.channels[1] = {
      id: "lark",
      label: "飞书",
      ready: "ready",
      targetId: "lark:owner",
      isDirect: true,
    };
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

/** PetImDecisions as main wires it: rule candidates from the wiring, sends through its router. */
function decisionRelay(h: Harness) {
  const lines: string[] = [];
  const approvals: unknown[] = [];
  const relay = new PetImDecisions({
    read: () => collectImDecisions(h.snapshot(), h.tasks, lines, h.wiring.decisions.rulesFor),
    now: () => clock,
    approve: async (_entry, decision) => {
      approvals.push(decision);
      const [resolved] = h.pending.splice(0);
      if (resolved)
        h.emitProjection({
          kind: "pending-remove",
          sessionId: resolved.agentSessionId,
          requestId: resolved.requestId,
          version: 3,
          generation: 1,
          observedAt: clock,
        });
    },
    submit: (notice) => h.wiring.router.submitWithOutcome(notice),
    prior: (dedupeKey) => h.wiring.router.priorDecision(dedupeKey),
    isOwnerConversation: h.wiring.decisions.isOwnerConversation,
    ownerChannelIsDirect: h.wiring.decisions.ownerChannelIsDirect,
    isAway: h.wiring.decisions.isAway,
    decisionStatus: h.wiring.decisions.decisionStatus,
    onError: (error) => {
      throw error;
    },
  });
  const raise = (requestId = "req-1") => {
    const pending = {
      agentSessionId: SID,
      requestId,
      routeGeneration: 1,
      workerGeneration: 1,
      kind: "tool_approval",
      title: "等待批准 Bash",
      createdAt: clock,
      status: "pending",
    } as DesktopPendingDecision;
    h.pending.push(pending);
    lines.push(
      JSON.stringify({
        method: "agent/approvalRequest",
        params: {
          sessionId: SID,
          requestId,
          connectionId: "worker",
          generation: 1,
          request: { toolName: "Bash", description: "List files", args: { command: "ls" } },
        },
      }),
    );
    h.emitProjection({
      kind: "pending-upsert",
      pending,
      version: 2,
      generation: 1,
      observedAt: clock,
    });
  };
  /** Past the 15 s grace, then a few polls. */
  const poll = async () => {
    clock += 16_000;
    for (let index = 0; index < 3; index += 1) await relay.tick();
    await settle();
  };
  const code = () => relay["options"].read()[0]?.code;
  return { relay, approvals, raise, poll, code };
}

const OWNER_DM = { channel: "wechat", target: "owner-dm", senderId: "me", isDirectMessage: true };
/** Presence is re-read after the settings cache (5 s) expires. */
const SETTINGS_TTL = 5_001;

describe("decision prompts through the router", () => {
  test("a non-IM Session with a blocked rule gets exactly one owner prompt, answered by code", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ events: ["blocked"] }));
    const d = decisionRelay(current);
    d.raise();
    await settle();
    await d.poll();
    const code = d.code()!;
    expect(code).toMatch(/^[0-9A-F]{12}$/u);
    expect(current.ownerSends).toHaveLength(1);
    expect(current.ownerSends[0]!.targetId).toBe("wechat:owner");
    expect(current.ownerSends[0]!.text).toContain(`回答 ${code} 1`);
    expect(current.ownerSends[0]!.text).toContain("ls");
    expect(current.published).toEqual([]);
    // The pet's pending peek is the desktop surface; no native notification on top.
    expect(current.desktop).toEqual([]);
    expect(
      await d.relay.reply({ message: `回答 ${code} 1`, origin: { ...OWNER_DM, target: "x" } }),
    ).toContain("不属于当前私聊");
    expect(await d.relay.reply({ message: `回答 ${code} 1`, origin: OWNER_DM })).toContain(
      "已处理",
    );
    expect(d.approvals).toEqual([{ approved: true }]);
  });

  test("an owner target that is a group gets the generic text: no question, options or code", async () => {
    current = harness();
    current.directTargets.delete("wechat:owner");
    current.channels[0] = { id: "wechat", label: "微信", ready: "ready", targetId: "wechat:owner" };
    await current.handler(SID, upsertArgs({ events: ["blocked"] }));
    const d = decisionRelay(current);
    d.raise();
    await settle();
    await d.poll();
    expect(current.ownerSends).toHaveLength(1);
    const text = current.ownerSends[0]!.text;
    expect(text).toContain("请打开桌面 Session 处理");
    expect(text).not.toContain(d.code()!);
    expect(text).not.toContain("ls");
    // Nothing answerable went out, so a bare number is ordinary chat.
    expect(await d.relay.reply({ message: "1", origin: OWNER_DM })).toBeUndefined();
  });

  test("a prompt kept on the desktop escalates to IM once when the owner leaves", async () => {
    let present = true;
    current = harness({
      presence: {
        getSystemIdleTimeSec: () => (present ? 0 : 3_600),
        hasFocusedWindow: () => present,
      },
    });
    await current.handler(SID, upsertArgs({ events: ["blocked"] }));
    const d = decisionRelay(current);
    d.raise();
    await settle();
    await d.poll();
    expect(current.ownerSends).toEqual([]);
    present = false;
    clock += SETTINGS_TTL;
    await d.poll();
    await d.poll();
    expect(current.ownerSends).toHaveLength(1);
    expect(current.ownerSends[0]!.text).toContain(`回答 ${d.code()} 1`);
    // Answered on the desktop: the escalation record shares the request id and is settled.
    expect(await d.relay.reply({ message: "1", origin: OWNER_DM })).toContain("单独的编号");
  });

  test("an IM-started task gets its prompt in its own conversation exactly once", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ events: ["blocked"] }));
    current.tasks.push(
      longTask({
        status: "running",
        completedAt: undefined,
        completionTarget: {
          kind: "im-gateway",
          channel: "lark",
          target: "chat-9",
          senderId: "owner-1",
          isDirectMessage: true,
        },
      }),
    );
    const d = decisionRelay(current);
    d.raise();
    await settle();
    await d.poll();
    await d.poll();
    expect(current.ownerSends).toEqual([]);
    expect(current.published).toHaveLength(1);
    expect(current.published[0]).toMatchObject({ target: { channel: "lark", target: "chat-9" } });
    expect(current.published[0]!.text).toContain(`回答 ${d.code()} 1`);
    expect(current.desktop).toEqual([]);
  });

  test("owner present with an auto rule: no IM prompt, only the pet's pending surface", async () => {
    current = harness({
      presence: { getSystemIdleTimeSec: () => 0, hasFocusedWindow: () => true },
    });
    await current.handler(SID, upsertArgs({ events: ["blocked"] }));
    const d = decisionRelay(current);
    d.raise();
    await settle();
    await d.poll();
    expect(current.ownerSends).toEqual([]);
    expect(current.published).toEqual([]);
    expect(current.desktop).toEqual([]);
    current.wiring.router.start();
    expect(current.wiring.attention.getSnapshot().surfaceablePendingCount).toBe(1);
    // A code the owner never received answers nothing, and a bare number is ordinary chat.
    expect(await d.relay.reply({ message: "1", origin: OWNER_DM })).toBeUndefined();
  });

  test("quiet hours never hold a P0 decision prompt", async () => {
    current = harness({
      readSettings: () => ({
        pet: { notifications: { quietHours: { start: "00:00", end: "23:59" } } },
      }),
    });
    await current.handler(SID, upsertArgs({ events: ["blocked"] }));
    const d = decisionRelay(current);
    d.raise();
    await settle();
    await d.poll();
    expect(current.ownerSends).toHaveLength(1);
    expect(current.ownerSends[0]!.text).toContain(`回答 ${d.code()}`);
  });

  test("a resolved decision's queued prompt is revoked and never replayed", async () => {
    current = harness();
    current.channels[1] = { id: "lark", label: "飞书", ready: "unavailable" };
    await current.handler(SID, upsertArgs({ events: ["blocked"], channel: "lark" }));
    const d = decisionRelay(current);
    d.raise();
    await settle();
    await d.poll();
    expect(current.ownerSends).toEqual([]);
    const queued = current.wiring.ledger.queued();
    expect(queued.map((record) => [record.kind, record.requestId])).toEqual([
      ["session.blocked", "req-1"],
    ]);
    // Answered on the desktop.
    current.pending.length = 0;
    current.emitProjection({
      kind: "pending-remove",
      sessionId: SID,
      requestId: "req-1",
      version: 3,
      generation: 1,
      observedAt: clock,
    });
    await settle();
    expect(current.wiring.ledger.queued()).toEqual([]);
    expect(current.wiring.ledger.get(queued[0]!.id)?.delivery).toMatchObject({
      status: "revoked",
      error: "resolved",
    });
    current.channels[1] = {
      id: "lark",
      label: "飞书",
      ready: "ready",
      targetId: "lark:owner",
      isDirect: true,
    };
    const replay = current.wiring.inboundReplay({
      channel: "lark",
      target: "dm-1",
      isDirectMessage: true,
    })!;
    expect(await replay.take()).toEqual([]);
    replay.finish();
    expect(current.ownerSends).toEqual([]);
  });
});

describe("bound Session replies", () => {
  const turn = (runId: string, extra: Record<string, unknown> = {}) => [
    { type: "session_started", runId, clientMessageId: `cm-${runId}` },
    { type: "tool_use_start", toolCall: { id: "t1", toolName: "Bash", args: {} } },
    { type: "turn_complete", reason: "completed", text: "改好了", runId, ...extra },
  ];
  const bound = { channel: "wechat", target: "chat-1", senderId: "owner-1" };

  test("a completion already replied in the bound conversation is not sent again", async () => {
    current = harness();
    current.routes.push(boundRoute());
    await current.handler(SID, upsertArgs({ events: ["done"] }));
    clock = NOW + 1_000;
    current.wiring.recordBoundReply(SID, "run-1", bound);
    for (const event of turn("run-1")) current.wiring.observeSessionEvent(SID, event);
    await settle();
    expect(current.submitted).toHaveLength(1);
    expect(current.submitted[0]!.boundReplyDelivered).toBe(true);
    // The session.reply (published by the bridge) is the one IM message.
    expect(current.published).toEqual([]);
    expect(current.ownerSends).toEqual([]);
    expect(current.desktop.map((input) => input.title)).toEqual(["Mimi 任务已完成"]);
  });

  test("an owner-target done stays on IM when its rule names another channel", async () => {
    for (const [channel, suppressed] of [
      ["lark", false],
      ["auto", true],
    ] as const) {
      current?.wiring.dispose();
      current = harness({
        readSettings: () => ({ pet: { notifications: { mergeWindowSec: 0 } } }),
      });
      await current.handler(SID, upsertArgs({ events: ["done"], channel }));
      clock = NOW + 1_000;
      current.wiring.recordBoundReply(SID, "run-1", bound);
      for (const event of turn("run-1")) current.wiring.observeSessionEvent(SID, event);
      await settle();
      expect(current.submitted[0]!.target).toEqual({ kind: "owner" });
      expect(current.submitted[0]!.boundReplyDelivered === true).toBe(suppressed);
      expect(current.ownerSends).toHaveLength(suppressed ? 0 : 1);
    }
  });

  test("a done without a core run id is never paired with a bound reply", async () => {
    current = harness();
    current.routes.push(boundRoute());
    await current.handler(SID, upsertArgs({ events: ["done"] }));
    clock = NOW + 1_000;
    current.wiring.recordBoundReply(SID, String(clock), bound);
    for (const event of [
      { type: "session_started", clientMessageId: "cm-x" },
      { type: "tool_use_start", toolCall: { id: "t1", toolName: "Bash", args: {} } },
      { type: "turn_complete", reason: "completed", text: "改好了", completedAt: clock },
    ])
      current.wiring.observeSessionEvent(SID, event);
    await settle();
    expect(current.submitted[0]!.boundReplyDelivered).toBeUndefined();
    expect(current.published).toHaveLength(1);
  });

  /**
   * Main subscribes the notice tap to the worker stream BEFORE the bound
   * Session runner. Both run synchronously per line and the rule watcher
   * defers through promises, so the runner always hands the turn's reply to
   * the outbox before a done notice is decided. A goal is met mid-run, so
   * that notice waits for the run to end first.
   */
  function realBridge() {
    const listeners: Array<(line: string, entry?: { sessionId: string; event: unknown }) => void> =
      [];
    const worker = {
      requestWorker: async () => ({ ok: true }),
      injectWorkerMessage: () => undefined,
      subscribeOutbound: (listener: (typeof listeners)[number]) => {
        listeners.push(listener);
        return () => undefined;
      },
    };
    const replies: unknown[] = [];
    current = harness({
      sessionRoutes: () => wiringRef?.routes,
      boundReplies: () => wiringRef,
    });
    const h = current;
    listeners.push((_line, entry) => {
      if (entry) h.wiring.observeSessionEvent(entry.sessionId, entry.event);
    });
    const wiringRef: SessionBridgeWiring = createSessionBridgeWiring({
      routesFilePath: join(dir, "routes.json"),
      resolveSelector: async () =>
        ({
          sessionId: SID,
          workspacePath: "/repo",
          title: "修登录",
          updatedAt: NOW,
        }) as PetReusableSessionCandidate,
      directoryExists: async () => true,
      createRunner: (onTurn) =>
        createBoundSessionRunner(
          worker,
          { getSnapshot: () => ({ sessions: [] }), refreshCatalog: async () => undefined },
          onTurn,
        ),
      health: { check: async () => ({ ok: true }) },
      describeStatus: async () => "",
      publish: async (event) => {
        replies.push(event);
      },
      onReplyForwarded: ({ sessionId, turnId, route }) =>
        h.wiring.recordBoundReply(sessionId, turnId, route),
      now: () => clock,
    });
    const emit = (event: Record<string, unknown>) => {
      for (const listener of listeners) listener("", { sessionId: SID, event });
    };
    const bind = () =>
      wiringRef.sessionBindExecutor(
        { action: "enter", sessionSelector: "session-0123456789abcdef0123" },
        {
          completionTarget: { channel: "wechat", target: "chat-1" },
          senderId: "owner-1",
          isDirectMessage: true,
        },
      );
    return { h, emit, bind, replies };
  }

  test("listener order: a turn's done is decided after its bound reply is in the outbox", async () => {
    const { h, emit, bind, replies } = realBridge();
    expect((await bind()).ok).toBe(true);
    await h.handler(SID, upsertArgs({ events: ["done"] }));
    clock = NOW + 1_000;
    emit({ type: "session_started", runId: "run-1", clientMessageId: "cm-1" });
    emit({ type: "tool_use_start", toolCall: { id: "t1", toolName: "Bash", args: {} } });
    emit({ type: "turn_complete", reason: "completed", text: "改好了", runId: "run-1" });
    await settle();
    expect(replies).toHaveLength(1);
    expect(h.submitted.map((notice) => notice.boundReplyDelivered)).toEqual([true]);
    expect(h.published).toEqual([]);
  });

  test("a goal met before turn_complete waits for the run, then for its reply", async () => {
    const { h, emit, bind, replies } = realBridge();
    expect((await bind()).ok).toBe(true);
    await h.handler(SID, upsertArgs({ events: ["done"], scope: "goal" }));
    clock = NOW + 1_000;
    emit({ type: "session_started", runId: "run-1", clientMessageId: "cm-1" });
    emit({ type: "tool_use_start", toolCall: { id: "t1", toolName: "Bash", args: {} } });
    emit({ type: "goal_progress", status: "met", goalId: "g-1", runId: "run-1" });
    await settle();
    expect(h.submitted).toEqual([]);
    emit({
      type: "turn_complete",
      reason: "completed",
      completionKind: "goal_control_stop",
      text: "目标完成",
      runId: "run-1",
    });
    await settle();
    expect(replies).toHaveLength(1);
    expect(h.submitted.map((notice) => [notice.dedupeKey, notice.boundReplyDelivered])).toEqual([
      [`${SID}:goal:g-1`, true],
    ]);
    expect(h.published).toEqual([]);
  });

  test("a done notice waits for the same run's in-flight reply", async () => {
    let finish!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      finish = resolve;
    });
    current = harness({
      boundReplies: () => ({
        pendingReply: (sessionId, runId) =>
          sessionId === SID && runId === "run-1" ? inFlight : undefined,
      }),
    });
    current.routes.push(boundRoute());
    await current.handler(SID, upsertArgs({ events: ["done"] }));
    clock = NOW + 1_000;
    for (const event of turn("run-1")) current.wiring.observeSessionEvent(SID, event);
    await settle();
    expect(current.submitted).toEqual([]);
    current.wiring.recordBoundReply(SID, "run-1", bound);
    finish();
    await settle();
    expect(current.submitted.map((notice) => notice.boundReplyDelivered)).toEqual([true]);
    expect(current.published).toEqual([]);
  });

  test("another run's reply does not swallow this run's done; failed still goes through", async () => {
    current = harness({ readSettings: () => ({ pet: { notifications: { mergeWindowSec: 0 } } }) });
    current.routes.push(boundRoute());
    await current.handler(SID, upsertArgs({ events: ["done"] }));
    clock = NOW + 1_000;
    current.wiring.recordBoundReply(SID, "run-0", bound);
    for (const event of turn("run-1")) current.wiring.observeSessionEvent(SID, event);
    await settle();
    expect(current.published).toHaveLength(1);
    expect(current.published[0]).toMatchObject({ type: "pet.task.completed" });
    await current.handler(SID, upsertArgs({ events: ["failed"] }));
    clock = NOW + 2_000;
    current.wiring.recordBoundReply(SID, "run-2", bound);
    for (const event of turn("run-2", { reason: "model_error" }))
      current.wiring.observeSessionEvent(SID, event);
    await settle();
    expect(current.submitted.at(-1)).toMatchObject({ kind: "session.failed" });
    expect(current.submitted.at(-1)!.boundReplyDelivered).toBeUndefined();
    expect(current.published.map((event) => event.type)).toEqual([
      "pet.task.completed",
      "pet.task.failed",
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
