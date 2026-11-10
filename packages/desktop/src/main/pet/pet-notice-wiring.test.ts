import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationSessionRoute, PetLongTask } from "@cjhyy/code-shell-pet";
import { PET_RULE_UPSERT_ACTION } from "@cjhyy/code-shell-pet/protocol";
import type { DesktopNotificationInput } from "../desktop-notifier.js";
import type { HostActionHandler } from "../host-action-dispatch.js";
import type { GatewayControlEventInput } from "../im-gateway-control-server.js";
import type { ImGatewayOwnerChannel } from "../im-gateway-service.js";
import { collectImDecisions, PetImDecisions } from "./pet-im-decisions.js";
import { PetNoticeLedger } from "./pet-notice-ledger.js";
import type { NoticeSubmission } from "./pet-notice-router.js";
import type { PetReusableSessionCandidate } from "./pet-dispatch-service.js";
import {
  createBoundSessionRunner,
  createSessionBridgeWiring,
  type SessionBridgeWiring,
} from "./session-bridge-wiring.js";
import {
  parsePetNotificationSettings,
  petNotificationSettingsView,
  wirePetNotices,
  type PetNoticeWiring,
  type PetNoticeWiringDeps,
} from "./pet-notice-wiring.js";
import { createSessionOutcomeTap, SessionOutcomeDeriver } from "./session-outcome.js";
import type {
  DesktopPendingDecision,
  DesktopPetProjectionEvent,
  DesktopPetProjectionSnapshot,
  DesktopPetSession,
} from "./pet-state-aggregator.js";

const SID = "s-work";
const NOW = 1_700_000_000_000;

let dir: string;

/** A real source file of `size` bytes: notices freeze copies of their files. */
async function sourceFile(name: string, size: number): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, Buffer.alloc(size, 1));
  return path;
}

/** Where the notice router froze a file (`<userData>/pet/notice-media/<record>/<n><ext>`). */
const frozenPath = expect.stringMatching(/\/pet\/notice-media\/notice-[0-9a-f-]{36}\/\d+\.\w+$/u);
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
  /** Feed one raw stream event the way the main-process tap does: interpreted once. */
  observeSessionEvent(sessionId: string, event: unknown): void;
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
  setWorkerState(state: DesktopPetProjectionSnapshot["workerState"]): void;
  emitProjection(event: DesktopPetProjectionEvent): void;
  subscribeProjection(listener: (event: DesktopPetProjectionEvent) => void): () => void;
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
  let workerState: DesktopPetProjectionSnapshot["workerState"] = "active";
  const snapshot = (): DesktopPetProjectionSnapshot => ({
    version: 1,
    generation: 1,
    workerState,
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
    observeSessionEvent: createSessionOutcomeTap(
      {
        coordinator: () => undefined,
        watcher: (sessionId, outcomes) => wiring.observeSessionOutcomes(sessionId, outcomes),
      },
      new SessionOutcomeDeriver({ now: () => clock }),
    ),
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
    setWorkerState: (state) => {
      workerState = state;
    },
    emitProjection: (event) => {
      for (const listener of [...listeners]) listener(event);
    },
    subscribeProjection: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
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

const SETTLE_DEADLINE_MS = 2_000;

function pause(ms = 1): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Let queued async work (rule writes, ledger writes, sends) run. With `until`,
 * keep waiting until the expected outcome is visible or the deadline passes,
 * so a loaded machine cannot fail a test by being slow; `poke` re-drives the
 * work on each round. Without it, a short drain for "nothing happens" checks.
 */
async function settle(until?: () => boolean, poke?: () => Promise<void>): Promise<void> {
  for (let index = 0; index < 20; index += 1) await pause();
  if (!until) return;
  const deadline = Date.now() + SETTLE_DEADLINE_MS;
  while (!until() && Date.now() < deadline) {
    await poke?.();
    await pause(2);
  }
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
          quietHours: { start: "21:00", end: "07:00", enabled: false },
          maxPerHour: 3,
          maxP0PerHour: -1,
          mergeWindowSec: "10",
          presenceIdleSec: 300,
          delegatedFromDesktop: "desktop",
        },
      },
    });
    expect(parsed).toEqual({
      // Switched off with enabled:false (a null is the settings writer's "delete").
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
    // A null is "reset to default", never "off".
    expect(
      parsePetNotificationSettings({ pet: { notifications: { quietHours: null } } }).quietHours,
    ).toEqual({ start: "23:00", end: "08:30" });
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
        fires: "这个会话下一次完成实际工作后（你在电脑前时发桌面，不在时发微信）",
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
    for (const event of events) current.observeSessionEvent(SID, event);
    await settle(() => current!.submitted.length > 0);
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

  test("a WeChat rule's result held for quiet hours is digested to WeChat, owner present", async () => {
    let present = false;
    current = harness({
      presence: {
        getSystemIdleTimeSec: () => (present ? 0 : 3_600),
        hasFocusedWindow: () => present,
      },
    });
    // 23:30 at UTC+0, inside the default 23:00–08:30 quiet hours.
    clock = Date.UTC(2026, 10, 9, 23, 30, 0);
    await current.handler(SID, upsertArgs({ channel: "wechat" }));
    clock += 1_000;
    for (const event of [
      { type: "session_started", runId: "run-1", clientMessageId: "cm-1" },
      { type: "tool_use_start", toolCall: { id: "t1", toolName: "Bash", args: {} } },
      { type: "turn_complete", reason: "completed", text: "测试都过了", runId: "run-1" },
    ])
      current.observeSessionEvent(SID, event);
    await settle(() => current!.wiring.ledger.held().length > 0);
    expect(current.ownerSends).toEqual([]);
    present = true;
    clock = Date.UTC(2026, 10, 10, 8, 30, 0);
    await current.wiring.router.flushDigest();
    expect(current.ownerSends).toHaveLength(1);
    expect(current.ownerSends[0]).toMatchObject({
      targetId: "wechat:owner",
      text: "你不在时：\n- 「修登录」做完了",
    });
    expect(current.desktop.map((input) => input.title)).toEqual(["Mimi：你不在时"]);
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
      current.observeSessionEvent(SID, event);
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
    for (const event of turn("run-1")) current.observeSessionEvent(SID, event);
    await settle();
    expect(current.submitted).toEqual([]);
    // A later turn in the same Session is the owner's own work again.
    for (const event of turn("run-2")) current.observeSessionEvent(SID, event);
    await settle(() => current!.submitted.length > 0);
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
    await settle(() => nudged.length > 0);
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
          path: await sourceFile("comic.png", 123),
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
          path: await sourceFile("a.zip", 10),
        },
        {
          kind: "image" as const,
          name: "big.png",
          mimeType: "image/png",
          size: 5_000,
          path: await sourceFile("big.png", 5_000),
        },
        {
          kind: "image" as const,
          name: "a.png",
          mimeType: "image/png",
          size: 10,
          path: await sourceFile("a.png", 10),
        },
        {
          kind: "image" as const,
          name: "b.png",
          mimeType: "image/png",
          size: 10,
          path: await sourceFile("b.png", 10),
        },
      ],
      button: { text: "查看", url: "https://example.com/r" },
    };
    await current.wiring.notifyTaskClosed(longTask(), { text: "好了", media });
    // WeChat target: images only, ≤1 000 bytes, at most one.
    expect(current.materialized).toEqual([[expect.stringMatching(/\/2\.png$/u)]]);
    // Accepted: the copies are gone.
    expect(await readdir(join(dir, "pet", "notice-media"))).toEqual([]);
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
          path: await sourceFile("r.txt", 10),
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
    // The send runs in the background so it never delays the inbound turn.
    await current.wiring.router.resendsSettled();
    expect(current.ownerSends).toEqual([
      expect.objectContaining({ targetId: "lark:owner", text: "报告好了", attachments: ["r.txt"] }),
    ]);
  });
});

/** Timers on the test clock: `advance` runs every callback that came due. */
function fakeTimers() {
  const timers = new Set<{ at: number; callback: () => void }>();
  return {
    setTimeout: (callback: () => void, delay: number) => {
      const timer = { at: clock + delay, callback };
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer: unknown) => {
      timers.delete(timer as { at: number; callback: () => void });
    },
    pending: () => [...timers].map((timer) => timer.at).sort((a, b) => a - b),
    advance: (to: number) => {
      clock = to;
      for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
        if (timer.at > clock) continue;
        timers.delete(timer);
        timer.callback();
      }
    },
  };
}

/** PetImDecisions as main wires it: rule candidates from the wiring, sends through its router. */
function decisionRelay(
  h: Harness,
  extra: Partial<ConstructorParameters<typeof PetImDecisions>[0]> = {},
) {
  const lines: string[] = [];
  const approvals: unknown[] = [];
  const relay = new PetImDecisions({
    read: () => collectImDecisions(h.snapshot(), h.tasks, lines, h.wiring.decisions.deliveryFor),
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
    router: h.wiring.router,
    isOwnerConversation: h.wiring.decisions.isOwnerConversation,
    ownerChannelIsDirect: h.wiring.decisions.ownerChannelIsDirect,
    isAway: h.wiring.decisions.isAway,
    decisionStatus: h.wiring.decisions.decisionStatus,
    projection: { subscribe: h.subscribeProjection },
    nudges: [h.wiring.decisions.onBlocked],
    onAwayChange: h.wiring.decisions.onAwayChange,
    sweepMs: 0,
    onError: (error) => {
      throw error;
    },
    ...extra,
  });
  /** A pending request (again, after a restart: `createdAt` of the original). */
  const raise = (requestId = "req-1", createdAt = clock) => {
    const pending = {
      agentSessionId: SID,
      requestId,
      routeGeneration: 1,
      workerGeneration: 1,
      kind: "tool_approval",
      title: "等待批准 Bash",
      createdAt,
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
  /** Past the 15 s grace, then a few looks (as the grace timer and events would). */
  const poll = async (until?: () => boolean) => {
    clock += 16_000;
    for (let index = 0; index < 3; index += 1) await relay.scan();
    await settle(until, () => relay.scan());
  };
  const code = () => relay["options"].read()[0]?.code;
  return { relay, approvals, raise, poll, code };
}

const OWNER_DM = { channel: "wechat", target: "owner-dm", senderId: "me", isDirectMessage: true };
/** Presence is re-read after the settings cache (5 s) expires. */
const SETTINGS_TTL = 5_001;

describe("startup", () => {
  test("a hanging resend during recovery does not hold up ready", async () => {
    // A young claim from before the restart, on an idempotent channel: recovery resends it.
    const before = new PetNoticeLedger({
      path: join(dir, "pet", "notices.json"),
      now: () => clock,
    });
    const record = await before.record({
      kind: "session.done",
      priority: "P1",
      dedupeKey: "done:before-restart",
      ruleIds: [],
      facts: { title: "旧任务", target: { kind: "owner" } },
      body: "「旧任务」做完了",
      decision: { outlet: "im", im: "wechat", reason: "away-last-inbound" },
    });
    await before.claim(record.id, "wechat", "「旧任务」做完了");
    await before.flush();
    clock = NOW + 60_000;
    const attempts: string[] = [];
    current = harness({
      imTimeoutMs: 60_000,
      gateway: {
        ownerChannels: () => [
          { id: "wechat", label: "微信", ready: "ready", targetId: "wechat:owner", isDirect: true },
        ],
        listOwnerMessageTargets: () => [],
        sendOwnerMessage: (_targetId, text) => {
          attempts.push(text);
          return new Promise(() => undefined);
        },
        supportsIdempotentOwnerSend: () => true,
        lastOwnerInboundChannel: () => "wechat",
        isOwnerConversation: () => false,
      },
    });
    const outcome = await Promise.race([
      current.wiring.ready.then(() => "ready"),
      pause(1_000).then(() => "blocked"),
    ]);
    expect(outcome).toBe("ready");
    await settle(() => attempts.length > 0);
    expect(attempts).toEqual(["「旧任务」做完了"]);
  });
});

describe("burst load", () => {
  test("a burst of notices reads the owner channels and targets once", async () => {
    const reads = { channels: 0, targets: 0 };
    const sends: string[] = [];
    current = harness({
      gateway: {
        ownerChannels: () => {
          reads.channels += 1;
          return [
            {
              id: "wechat",
              label: "微信",
              ready: "ready",
              targetId: "wechat:owner",
              isDirect: true,
            },
          ];
        },
        listOwnerMessageTargets: () => {
          reads.targets += 1;
          return [];
        },
        sendOwnerMessage: async (_targetId, text) => {
          sends.push(text);
          return {};
        },
        supportsIdempotentOwnerSend: () => true,
        lastOwnerInboundChannel: () => "wechat",
        isOwnerConversation: () => false,
      },
      readSettings: () => ({ pet: { notifications: { quietHours: { enabled: false } } } }),
    });
    for (let index = 0; index < 5; index += 1)
      await current.wiring.router.submit({
        kind: "session.done",
        priority: "P1",
        dedupeKey: `done:burst-${index}`,
        sessionId: `s-${index}`,
        ruleIds: [],
        facts: { title: `任务${index}` },
        attention: "always",
        channel: "auto",
        target: { kind: "owner" },
      });
    expect(sends).toHaveLength(5);
    expect(reads).toEqual({ channels: 1, targets: 1 });
  });
});

describe("digest after sleep", () => {
  test("waking, unlocking and the owner's next inbound turn send a due digest", async () => {
    const power = new EventEmitter();
    current = harness({ powerEvents: power as unknown as PetNoticeWiringDeps["powerEvents"] });
    await current.wiring.ready;
    const night = (day: number) => Date.UTC(2026, 10, day, 23, 30, 0);
    const morning = (day: number) => Date.UTC(2026, 10, day + 1, 8, 30, 0);
    const hold = async (day: number, title: string) => {
      clock = night(day);
      const decision = await current!.wiring.router.submit({
        kind: "session.done",
        priority: "P1",
        dedupeKey: `done:${title}`,
        sessionId: SID,
        ruleIds: [],
        facts: { title },
        attention: "always",
        channel: "auto",
        target: { kind: "owner" },
      });
      expect(decision).toMatchObject({ outlet: "digest", reason: "quiet-hours" });
      clock = morning(day);
    };
    const sent = () => current!.ownerSends.map((send) => send.text);

    await hold(9, "一");
    power.emit("resume");
    await settle(() => sent().length === 1);
    expect(sent()).toEqual(["你不在时：\n- 「一」做完了"]);

    await hold(10, "二");
    power.emit("unlock-screen");
    await settle(() => sent().length === 2);
    expect(sent()[1]).toBe("你不在时：\n- 「二」做完了");

    await hold(11, "三");
    const replay = current.wiring.inboundReplay(OWNER_DM)!;
    await replay.take();
    replay.finish();
    await settle(() => sent().length === 3);
    expect(sent()[2]).toBe("你不在时：\n- 「三」做完了");

    current.wiring.dispose();
    expect(power.listenerCount("resume") + power.listenerCount("unlock-screen")).toBe(0);
  });
});

describe("goal pauses", () => {
  test("a cancelled Goal's queued and held pauses are never replayed or digested", async () => {
    current = harness();
    const TWO = "s-two";
    current.sessions.push(session(TWO));
    current.channels[0] = { ...current.channels[0]!, ready: "unavailable" };
    // SID: a named, unavailable WeChat queues the pause; TWO: digest attention holds it.
    await current.handler(
      SID,
      upsertArgs({ scope: "goal", events: ["blocked"], channel: "wechat" }),
    );
    await current.handler(TWO, upsertArgs({ sessionId: TWO, scope: "goal", events: ["blocked"] }));
    const [two] = current.wiring.ruleStore.activeForSession(TWO);
    await current.wiring.ruleStore.update(two!.id, two!.version, { attention: "digest" });
    clock = NOW + 1_000;
    for (const id of [SID, TWO])
      for (const event of [
        { type: "session_started", runId: `run-${id}`, clientMessageId: `cm-${id}` },
        {
          type: "goal_progress",
          status: "not_met",
          goalId: `g-${id}`,
          revision: 1,
          waitingForUser: "用哪个数据库？",
          runId: `run-${id}`,
        },
        { type: "turn_complete", reason: "completed", runId: `run-${id}` },
      ])
        current.observeSessionEvent(id, event);
    await settle(
      () =>
        current!.wiring.ledger.queued().length === 1 && current!.wiring.ledger.held().length === 1,
    );
    for (const id of [SID, TWO])
      current.observeSessionEvent(id, { type: "goal_cleared", goalId: `g-${id}` });
    await settle(
      () =>
        current!.wiring.ledger.queued().length === 0 && current!.wiring.ledger.held().length === 0,
    );
    expect(current.wiring.ledger.queued()).toEqual([]);
    expect(current.wiring.ledger.held()).toEqual([]);
    current.channels[0] = { ...current.channels[0]!, ready: "ready" };
    const replay = current.wiring.inboundReplay(OWNER_DM)!;
    expect(await replay.take()).toEqual([]);
    replay.finish();
    clock += 60 * 60_000;
    await current.wiring.router.flushDigest();
    expect(current.ownerSends).toEqual([]);
    expect(current.published).toEqual([]);
  });
});

describe("decision prompts through the router", () => {
  test("a non-IM Session with a blocked rule gets exactly one owner prompt, answered by code", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ events: ["blocked"] }));
    const d = decisionRelay(current);
    d.raise();
    await settle();
    await d.poll(() => current!.ownerSends.length > 0);
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
    await d.poll(() => current!.ownerSends.length > 0);
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
    await d.poll(() => current!.ownerSends.length > 0);
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

  /** Stop this run (stores flushed) and start the next one on the same files. */
  async function restart(overrides: Partial<PetNoticeWiringDeps> = {}): Promise<void> {
    await current!.wiring.flush();
    current!.wiring.dispose();
    current = harness(overrides);
    await current.wiring.ready;
  }
  const promptOf = (code: string | undefined) =>
    current!.wiring.ledger.prompts().find((record) => record.prompt?.code === code)?.prompt;

  test("a restart during the grace period prompts once, when the grace ends", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ events: ["blocked"] }));
    const raisedAt = clock;
    const before = decisionRelay(current);
    before.raise();
    clock = raisedAt + 5_000;
    await before.relay.scan();
    expect(current.ownerSends).toEqual([]);
    // Grace has no record: it is derived from the decision's own createdAt.
    expect(current.wiring.ledger.prompts()).toEqual([]);

    await restart();
    const timers = fakeTimers();
    const d = decisionRelay(current, timers);
    d.relay.start();
    d.raise("req-1", raisedAt);
    await settle();
    expect(current.ownerSends).toEqual([]);
    expect(timers.pending()).toContain(raisedAt + 15_000);
    timers.advance(raisedAt + 15_000);
    await settle(() => current!.ownerSends.length > 0);
    expect(current.ownerSends).toHaveLength(1);
    expect(promptOf(d.code())).toMatchObject({ phase: "im", channel: "wechat" });
    d.relay.stop();
  });

  test("after a restart a prompt that reached IM is not sent again and still times out", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ events: ["blocked"] }));
    const raisedAt = clock;
    const before = decisionRelay(current);
    before.raise();
    await settle();
    await before.poll(() => current!.ownerSends.length > 0);
    const code = before.code()!;
    expect(promptOf(code)).toMatchObject({ phase: "im", channel: "wechat" });

    await restart();
    const d = decisionRelay(current);
    d.raise("req-1", raisedAt);
    await d.relay.scan();
    expect(current.ownerSends).toEqual([]);
    // The record says the owner's chat got the code: a bare reply there counts.
    expect(await d.relay.reply({ message: "1", origin: OWNER_DM })).toContain("单独的编号");
    clock = raisedAt + 10 * 60_000;
    await d.relay.scan();
    await settle(() => current!.ownerSends.length > 0);
    expect(d.approvals).toEqual([
      expect.objectContaining({ approved: false, failure: "timed_out" }),
    ]);
    expect(current.ownerSends.map((send) => send.text)).toEqual([
      expect.stringContaining(`确认 ${code} 已超时`),
    ]);
    expect(promptOf(code)).toMatchObject({
      phase: "expired",
      expiryNotice: { channel: "wechat", sent: true },
    });
  });

  test("the owner leaving escalates at once, and a restart never escalates again", async () => {
    let present = true;
    const focus = new EventEmitter();
    const overrides: Partial<PetNoticeWiringDeps> = {
      presence: {
        getSystemIdleTimeSec: () => (present ? 0 : 3_600),
        hasFocusedWindow: () => present,
      },
      focusEvents: focus as unknown as PetNoticeWiringDeps["focusEvents"],
    };
    current = harness(overrides);
    await current.handler(SID, upsertArgs({ events: ["blocked"] }));
    const timers = fakeTimers();
    const d = decisionRelay(current, timers);
    d.relay.start();
    const raisedAt = clock;
    d.raise();
    await settle();
    timers.advance(raisedAt + 15_000);
    await settle(() => promptOf(d.code()) !== undefined);
    expect(current.ownerSends).toEqual([]);
    expect(promptOf(d.code())).toMatchObject({ phase: "desktop" });
    // No poll: the window losing focus is the event.
    present = false;
    focus.emit("browser-window-blur");
    await settle(() => current!.ownerSends.length > 0);
    expect(current.ownerSends).toHaveLength(1);
    expect(current.ownerSends[0]!.text).toContain(`回答 ${d.code()} 1`);
    expect(promptOf(d.code())).toMatchObject({
      phase: "im",
      channel: "wechat",
      escalatedAt: raisedAt + 15_000,
    });
    d.relay.stop();

    await restart(overrides);
    const again = decisionRelay(current);
    again.raise("req-1", raisedAt);
    await again.relay.scan();
    await settle();
    expect(current.ownerSends).toEqual([]);
  });

  test("the prompt's deadline timer denies it and tells the chat it went to", async () => {
    current = harness();
    await current.handler(SID, upsertArgs({ events: ["blocked"] }));
    const timers = fakeTimers();
    const d = decisionRelay(current, timers);
    d.relay.start();
    const raisedAt = clock;
    d.raise();
    await settle();
    timers.advance(raisedAt + 15_000);
    await settle(() => current!.ownerSends.length > 0);
    await settle(() => timers.pending().includes(raisedAt + 10 * 60_000));
    expect(timers.pending()).toEqual([raisedAt + 10 * 60_000]);
    timers.advance(raisedAt + 10 * 60_000);
    await settle(() => current!.ownerSends.length > 1);
    expect(d.approvals).toEqual([
      expect.objectContaining({ approved: false, failure: "timed_out" }),
    ]);
    expect(current.ownerSends.map((send) => send.targetId)).toEqual([
      "wechat:owner",
      "wechat:owner",
    ]);
    expect(current.ownerSends[1]!.text).toContain("已超时");
    d.relay.stop();
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
    await d.poll(() => current!.ownerSends.length > 0);
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
    await d.poll(() => current!.wiring.ledger.queued().length > 0);
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
    await settle(() => current!.wiring.ledger.queued().length === 0);
    expect(current.wiring.ledger.queued()).toEqual([]);
    expect(current.wiring.ledger.get(queued[0]!.id)?.delivery).toMatchObject({
      status: "revoked",
      error: "resolved",
    });
    // The prompt's own lifecycle ends too (it left the projection unanswered from here).
    await d.relay.scan();
    expect(current.wiring.ledger.get(queued[0]!.id)?.prompt).toMatchObject({ phase: "revoked" });
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

  test("a completion replied in the bound conversation is not sent again", async () => {
    current = harness();
    current.routes.push(boundRoute());
    await current.handler(SID, upsertArgs({ events: ["done"] }));
    clock = NOW + 1_000;
    for (const event of turn("run-1")) current.observeSessionEvent(SID, event);
    await settle(() => current!.desktop.length > 0);
    expect(current.submitted).toHaveLength(1);
    expect(current.submitted[0]!.boundReplyDelivered).toBe(true);
    // The session.reply (published by the bridge) is the one IM message.
    expect(current.published).toEqual([]);
    expect(current.ownerSends).toEqual([]);
    expect(current.desktop.map((input) => input.title)).toEqual(["Mimi 任务已完成"]);
    expect(current.wiring.ledger.byDedupeKey(`${SID}:turn:run-1`)?.decision).toEqual({
      outlet: "desktop",
      reason: "bound-reply-delivered",
    });
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
      // Armed before the Session was bound: the rule addresses the owner.
      await current.handler(SID, upsertArgs({ events: ["done"], channel }));
      current.routes.push(boundRoute());
      clock = NOW + 1_000;
      for (const event of turn("run-1")) current.observeSessionEvent(SID, event);
      await settle(
        () => current!.submitted.length > 0 && (suppressed || current!.ownerSends.length > 0),
      );
      expect(current.submitted).toHaveLength(1);
      expect(current.submitted[0]!.target).toEqual({ kind: "owner" });
      expect(current.submitted[0]!.boundReplyDelivered === true).toBe(suppressed);
      expect(current.ownerSends.map((send) => send.targetId)).toEqual(
        suppressed ? [] : ["lark:owner"],
      );
    }
  });

  test("a report parked on a run the worker abandoned goes out when the worker is lost", async () => {
    current = harness({ readSettings: () => ({ pet: { notifications: { mergeWindowSec: 0 } } }) });
    current.routes.push(boundRoute());
    await current.handler(SID, upsertArgs({ events: ["done"], scope: "goal" }));
    clock = NOW + 1_000;
    for (const event of [
      { type: "session_started", runId: "run-1", clientMessageId: "cm-1" },
      { type: "goal_progress", status: "met", goalId: "g-1", round: 1 },
    ])
      current.observeSessionEvent(SID, event);
    await settle();
    expect(current.submitted).toEqual([]);
    // The aggregator reports a lost worker as a reset of a disconnected snapshot.
    current.setWorkerState("disconnected");
    current.emitProjection({ kind: "reset", version: 2, generation: 1, observedAt: clock });
    await settle(() => current!.published.length > 0);
    expect(
      current.submitted.map((notice) => [notice.dedupeKey, notice.boundReplyDelivered]),
    ).toEqual([[`${SID}:goal:g-1`, undefined]]);
    expect(current.published).toMatchObject([
      { type: "pet.task.completed", target: { channel: "wechat", target: "chat-1" } },
    ]);
  });

  test("shutdown sends parked reports before the router stops", async () => {
    current = harness({ readSettings: () => ({ pet: { notifications: { mergeWindowSec: 0 } } }) });
    current.routes.push(boundRoute());
    await current.handler(SID, upsertArgs({ events: ["done"], scope: "goal" }));
    clock = NOW + 1_000;
    for (const event of [
      { type: "session_started", runId: "run-1", clientMessageId: "cm-1" },
      { type: "goal_progress", status: "met", goalId: "g-1", round: 1 },
    ])
      current.observeSessionEvent(SID, event);
    await settle();
    const flushed = current.wiring.flush();
    current.wiring.dispose();
    await flushed;
    await settle(() => current!.published.length > 0);
    expect(current.published).toMatchObject([{ type: "pet.task.completed" }]);
  });

  test("a done without a core run id is served by the bound reply all the same", async () => {
    current = harness();
    current.routes.push(boundRoute());
    await current.handler(SID, upsertArgs({ events: ["done"] }));
    clock = NOW + 1_000;
    for (const event of [
      { type: "session_started", clientMessageId: "cm-x" },
      { type: "tool_use_start", toolCall: { id: "t1", toolName: "Bash", args: {} } },
      { type: "turn_complete", reason: "completed", text: "改好了", completedAt: clock },
    ])
      current.observeSessionEvent(SID, event);
    await settle(() => current!.submitted.length > 0);
    expect(current.submitted.map((notice) => notice.boundReplyDelivered)).toEqual([true]);
    expect(current.published).toEqual([]);
    expect(current.ownerSends).toEqual([]);
  });

  test("once the conversation no longer receives replies, the notice is sent there", async () => {
    current = harness({ readSettings: () => ({ pet: { notifications: { mergeWindowSec: 0 } } }) });
    current.routes.push(boundRoute());
    await current.handler(SID, upsertArgs({ events: ["done"] }));
    // The route is gone (the Session was rebound elsewhere / the route removed).
    current.routes.length = 0;
    clock = NOW + 1_000;
    for (const event of turn("run-1")) current.observeSessionEvent(SID, event);
    await settle(() => current!.published.length > 0);
    expect(current.submitted.map((notice) => notice.boundReplyDelivered)).toEqual([undefined]);
    expect(current.published).toMatchObject([
      { type: "pet.task.completed", target: { channel: "wechat", target: "chat-1" } },
    ]);
    current.routes.push(boundRoute());
    await current.handler(SID, upsertArgs({ events: ["failed"] }));
    current.routes.length = 0;
    clock = NOW + 2_000;
    for (const event of turn("run-2", { reason: "model_error" }))
      current.observeSessionEvent(SID, event);
    await settle(() => current!.published.length > 1);
    expect(current.published.map((event) => event.type)).toEqual([
      "pet.task.completed",
      "pet.task.failed",
    ]);
  });

  test("routes that cannot be read never swallow the notice", async () => {
    current = harness({
      sessionRoutes: () => ({
        notifyRoutesForSession: async () => {
          throw new Error("routes unreadable");
        },
      }),
    });
    await current.handler(SID, upsertArgs({ events: ["done"], channel: "wechat" }));
    clock = NOW + 1_000;
    for (const event of turn("run-1")) current.observeSessionEvent(SID, event);
    await settle(() => current!.ownerSends.length > 0);
    expect(current.submitted.map((notice) => notice.boundReplyDelivered)).toEqual([undefined]);
    expect(current.ownerSends).toHaveLength(1);
  });

  /**
   * The real bridge and the notice tap on one worker stream. Everything that
   * lands in the bound conversation is collected in `conversation`: the
   * bridge's session.reply and anything the notice router publishes to that
   * route. `tapFirst` is the order the two listeners were subscribed in; who
   * tells the conversation is decided by the delivery plan, so it must not matter.
   */
  function realBridge(tapFirst = true) {
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
    const replies: Array<{ text: string; target: { channel: string; target: string } }> = [];
    current = harness({ sessionRoutes: () => wiringRef?.routes });
    const h = current;
    const tap = (_line: string, entry?: { sessionId: string; event: unknown }) => {
      if (entry) h.observeSessionEvent(entry.sessionId, entry.event);
    };
    if (tapFirst) listeners.push(tap);
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
      replyRoutes: (sessionId) => h.wiring.deliveries.replyRoutes(sessionId),
      now: () => clock,
    });
    if (!tapFirst) listeners.push(tap);
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
    /** Every message the bound conversation received, whoever sent it. */
    const conversation = () => [
      ...replies.map((event) => event.text),
      ...h.published
        .filter((event) => event.target.channel === "wechat" && event.target.target === "chat-1")
        .map((event) => event.text),
    ];
    return { h, emit, bind, replies, conversation };
  }

  test("a bound Session's done turn posts exactly once, whichever listener hears it first", async () => {
    for (const tapFirst of [true, false]) {
      current?.wiring.dispose();
      const { h, emit, bind, conversation } = realBridge(tapFirst);
      expect((await bind()).ok).toBe(true);
      await h.handler(SID, upsertArgs({ events: ["done"] }));
      clock = NOW + 1_000;
      // The notice ledger outlives the harness: a run id of its own per round.
      const runId = `run-${tapFirst ? "tap" : "bridge"}-first`;
      emit({ type: "session_started", runId, clientMessageId: "cm-1" });
      emit({ type: "tool_use_start", toolCall: { id: "t1", toolName: "Bash", args: {} } });
      emit({ type: "turn_complete", reason: "completed", text: "改好了", runId });
      await settle(() => h.desktop.length > 0 && conversation().length > 0);
      await settle();
      expect(conversation()).toEqual(["改好了"]);
      expect(h.ownerSends).toEqual([]);
      // The owner still gets the desktop record of the outcome.
      expect(h.desktop.map((input) => input.title)).toEqual(["Mimi 任务已完成"]);
    }
  });

  test("a goal met mid-run posts exactly once: the run's closing reply", async () => {
    const { h, emit, bind, conversation } = realBridge();
    expect((await bind()).ok).toBe(true);
    await h.handler(SID, upsertArgs({ events: ["done"], scope: "goal" }));
    clock = NOW + 1_000;
    emit({ type: "session_started", runId: "run-1", clientMessageId: "cm-1" });
    emit({ type: "tool_use_start", toolCall: { id: "t1", toolName: "Bash", args: {} } });
    emit({ type: "goal_progress", status: "met", goalId: "g-1", runId: "run-1" });
    // Whether the run forwards a reply is only known when it closes.
    await settle();
    expect(h.submitted).toEqual([]);
    emit({
      type: "turn_complete",
      reason: "completed",
      completionKind: "goal_control_stop",
      text: "目标完成",
      runId: "run-1",
    });
    await settle(() => h.submitted.length > 0 && conversation().length > 0);
    await settle();
    expect(conversation()).toEqual(["目标完成"]);
    expect(h.submitted.map((notice) => [notice.dedupeKey, notice.boundReplyDelivered])).toEqual([
      [`${SID}:goal:g-1`, true],
    ]);
    expect(h.ownerSends).toEqual([]);
  });

  test("a goal met mid-run whose run closes without text is told by the notice instead", async () => {
    const { h, emit, bind, replies, conversation } = realBridge();
    expect((await bind()).ok).toBe(true);
    await h.handler(SID, upsertArgs({ events: ["done"], scope: "goal" }));
    clock = NOW + 1_000;
    emit({ type: "session_started", runId: "run-1", clientMessageId: "cm-1" });
    emit({ type: "goal_progress", status: "met", goalId: "g-1", runId: "run-1" });
    emit({
      type: "turn_complete",
      reason: "completed",
      completionKind: "goal_control_stop",
      text: "",
      runId: "run-1",
    });
    await settle(() => conversation().length > 0);
    await settle();
    expect(replies).toEqual([]);
    expect(conversation()).toHaveLength(1);
    expect(h.published).toMatchObject([{ type: "pet.task.completed" }]);
    expect(h.submitted.map((notice) => notice.boundReplyDelivered)).toEqual([undefined]);
  });

  test("a bound Session's turn that ends with no text gets the templated notice in that chat", async () => {
    const { h, emit, bind, replies, conversation } = realBridge();
    expect((await bind()).ok).toBe(true);
    await h.handler(SID, upsertArgs({ events: ["done"] }));
    clock = NOW + 1_000;
    emit({ type: "session_started", runId: "run-1", clientMessageId: "cm-1" });
    emit({
      type: "assistant_message",
      message: { role: "assistant", content: [{ type: "text", text: "先看一下" }] },
    });
    emit({ type: "tool_use_start", toolCall: { id: "t1", toolName: "Bash", args: {} } });
    // An explicit empty answer: the bridge forwards nothing for this run.
    emit({ type: "turn_complete", reason: "completed", text: "", runId: "run-1" });
    await settle(() => conversation().length > 0);
    await settle();
    expect(replies).toEqual([]);
    expect(h.published).toMatchObject([
      { type: "pet.task.completed", target: { channel: "wechat", target: "chat-1" } },
    ]);
    expect(conversation()).toHaveLength(1);
    expect(h.submitted.map((notice) => notice.boundReplyDelivered)).toEqual([undefined]);
  });

  test("a failure that is not a model error and left no text gets the templated notice", async () => {
    const { h, emit, bind, replies, conversation } = realBridge();
    expect((await bind()).ok).toBe(true);
    await h.handler(SID, upsertArgs({ events: ["failed"] }));
    clock = NOW + 1_000;
    emit({ type: "session_started", runId: "run-1", clientMessageId: "cm-1" });
    emit({ type: "tool_use_start", toolCall: { id: "t1", toolName: "Bash", args: {} } });
    emit({ type: "turn_complete", reason: "max_turns", runId: "run-1" });
    await settle(() => conversation().length > 0);
    await settle();
    expect(replies).toEqual([]);
    expect(h.published).toMatchObject([
      { type: "pet.task.failed", target: { channel: "wechat", target: "chat-1" } },
    ]);
    expect(conversation()).toHaveLength(1);
  });

  test("a bound Session's failed turn posts once: the bridge's failure reply", async () => {
    const { h, emit, bind, conversation } = realBridge();
    expect((await bind()).ok).toBe(true);
    await h.handler(SID, upsertArgs({ events: ["failed"] }));
    clock = NOW + 1_000;
    emit({ type: "session_started", runId: "run-1", clientMessageId: "cm-1" });
    emit({ type: "tool_use_start", toolCall: { id: "t1", toolName: "Bash", args: {} } });
    emit({ type: "error", error: "model down", runId: "run-1" });
    emit({ type: "turn_complete", reason: "model_error", runId: "run-1" });
    await settle(() => h.submitted.length > 0 && conversation().length > 0);
    await settle();
    expect(conversation()).toEqual(["这个 Session 本轮执行失败，请在桌面端查看详情后重试。"]);
    expect(h.submitted.map((notice) => [notice.kind, notice.boundReplyDelivered])).toEqual([
      ["session.failed", true],
    ]);
    expect(h.ownerSends).toEqual([]);
  });

  test("a delegated task in a bound Session: Mimi's closure to its origin, the reply to the chat", async () => {
    const { h, emit, bind, conversation } = realBridge();
    expect((await bind()).ok).toBe(true);
    // Started from the desktop; the long task owns run-1.
    const task = longTask({ status: "running", runId: "run-1", completedAt: undefined });
    h.tasks.push(task);
    await h.wiring.armDelegationRule(task);
    clock = NOW + 1_000;
    emit({ type: "session_started", runId: "run-1", clientMessageId: "cm-1" });
    emit({ type: "tool_use_start", toolCall: { id: "t1", toolName: "Bash", args: {} } });
    emit({ type: "turn_complete", reason: "completed", text: "改好了", runId: "run-1" });
    await settle(() => conversation().length > 0);
    await settle();
    // The watcher leaves the run to the closure; only the Session's reply is out.
    expect(h.submitted).toEqual([]);
    expect(conversation()).toEqual(["改好了"]);
    Object.assign(task, { status: "completed", completedAt: clock });
    await h.wiring.notifyTaskClosed(task, { text: "登录修好了，可以验收。" });
    await settle(() => h.ownerSends.length > 0);
    expect(h.submitted.map((notice) => [notice.kind, notice.body, notice.target.kind])).toEqual([
      ["session.done", "登录修好了，可以验收。", "owner"],
    ]);
    expect(h.ownerSends.map((send) => send.text)).toEqual(["登录修好了，可以验收。"]);
    expect(conversation()).toEqual(["改好了"]);
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
