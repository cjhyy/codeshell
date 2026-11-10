import { expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationSessionRoute, PetLongTask } from "@cjhyy/code-shell-pet";
import { PET_RULE_UPSERT_ACTION } from "@cjhyy/code-shell-pet/protocol";
import type { DesktopNotificationInput } from "../../desktop-notifier.js";
import type { HostActionHandler } from "../../host-action-dispatch.js";
import type { GatewayControlEventInput } from "../../im-gateway-control-server.js";
import type { ImGatewayOwnerChannel } from "../../im-gateway-service.js";
import { collectImDecisions, PetImDecisions } from "../pet-im-decisions.js";
import type { NoticeSubmission } from "../pet-notice-router.js";
import {
  wirePetNotices,
  type PetNoticeWiring,
  type PetNoticeWiringDeps,
} from "../pet-notice-wiring.js";
import { createSessionOutcomeTap, SessionOutcomeDeriver } from "../session-outcome.js";
import type {
  DesktopPendingDecision,
  DesktopPetProjectionEvent,
  DesktopPetProjectionSnapshot,
  DesktopPetSession,
} from "../pet-state-aggregator.js";

/**
 * Shared harness for the notice wiring suites: a real `wirePetNotices` over a
 * temporary userData folder, with the gateway, projection and desktop faked.
 * Suites call {@link resetNoticeEnv} before and {@link cleanupNoticeEnv}
 * after each test, and move the test clock through {@link env}.
 */

export const SID = "s-work";
export const NOW = 1_700_000_000_000;

/** The current test's userData folder and clock (one suite file runs its tests in order). */
export const env = { dir: "", clock: NOW };

export async function resetNoticeEnv(): Promise<void> {
  env.dir = await mkdtemp(join(tmpdir(), "pet-notice-wiring-"));
  env.clock = NOW;
}

/** A fresh, empty userData folder (the previous wiring must be disposed first). */
export async function freshNoticeDir(): Promise<void> {
  await rm(env.dir, { recursive: true, force: true });
  env.dir = await mkdtemp(join(tmpdir(), "pet-notice-wiring-"));
}

export async function cleanupNoticeEnv(harness: Harness | undefined): Promise<void> {
  harness?.wiring.dispose();
  await rm(env.dir, { recursive: true, force: true });
}

/** A real source file of `size` bytes: notices freeze copies of their files. */
export async function sourceFile(name: string, size: number): Promise<string> {
  const path = join(env.dir, name);
  await writeFile(path, Buffer.alloc(size, 1));
  return path;
}

/** Where the notice router froze a file (`<userData>/pet/notice-media/<record>/<n><ext>`). */
export const frozenPath = expect.stringMatching(
  /\/pet\/notice-media\/notice-[0-9a-f-]{36}\/\d+\.\w+$/u,
);

export function session(id: string, extra: Partial<DesktopPetSession> = {}): DesktopPetSession {
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

export function longTask(overrides: Partial<PetLongTask> = {}): PetLongTask {
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

export interface OwnerSend {
  targetId: string;
  text: string;
  key?: string;
  attachments?: string[];
}

export interface Harness {
  wiring: PetNoticeWiring;
  /** Feed one raw stream event the way the main-process tap does: interpreted once. */
  observeSessionEvent(sessionId: string, event: unknown): void;
  handler: HostActionHandler;
  submitted: NoticeSubmission[];
  /**
   * Wait until the wiring is idle: every Session's observed outcomes applied
   * (rules spent included) and every submitted notice fully routed and sent.
   * Waits on the work itself, not on a clock, so a loaded machine cannot race it.
   */
  idle(): Promise<void>;
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
  setWorkerState(state: DesktopPetProjectionSnapshot["workerState"], generation?: number): void;
  emitProjection(event: DesktopPetProjectionEvent): void;
  subscribeProjection(listener: (event: DesktopPetProjectionEvent) => void): () => void;
}

export function harness(overrides: Partial<PetNoticeWiringDeps> = {}): Harness {
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
  let generation = 1;
  const snapshot = (): DesktopPetProjectionSnapshot => ({
    version: 1,
    generation,
    workerState,
    sessions,
    pending,
    observedAt: env.clock,
    workMemorySegments: [],
  });
  const wiring = wirePetNotices({
    userDataDir: env.dir,
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
    now: () => env.clock,
    log: () => undefined,
    timezoneOffsetMin: () => 0,
    ...overrides,
  } as PetNoticeWiringDeps);
  if (!handler) throw new Error("host action handler was not registered");
  const submitted: NoticeSubmission[] = [];
  const submissions: Promise<unknown>[] = [];
  const realSubmit = wiring.router.submit.bind(wiring.router);
  wiring.router.submit = (notice) => {
    submitted.push(structuredClone(notice));
    const routed = realSubmit(notice);
    submissions.push(routed);
    return routed;
  };
  const idle = async (): Promise<void> => {
    // A round can submit more notices (a parked report, a digest): repeat until none appear.
    for (let seen = -1; seen !== submissions.length; ) {
      seen = submissions.length;
      await wiring.ready;
      const ids = new Set(sessions.map((entry) => entry.agentSessionId));
      await Promise.all([...ids].map((id) => wiring.watcher.observe(id, [])));
      await Promise.allSettled(submissions);
    }
  };
  return {
    wiring,
    observeSessionEvent: createSessionOutcomeTap(
      {
        coordinator: () => undefined,
        watcher: (sessionId, outcomes) => wiring.observeSessionOutcomes(sessionId, outcomes),
      },
      new SessionOutcomeDeriver({ now: () => env.clock }),
    ),
    handler: (sessionId, args) => handler!(sessionId, args),
    submitted,
    idle,
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
    setWorkerState: (state, next) => {
      workerState = state;
      if (next !== undefined) generation = next;
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

export function upsertArgs(extra: Record<string, unknown> = {}): Record<string, unknown> {
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

export function boundRoute(): ConversationSessionRoute {
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

export const SETTLE_DEADLINE_MS = 2_000;

export function pause(ms = 1): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Let queued async work (rule writes, ledger writes, sends) run. With `until`,
 * keep waiting until the expected outcome is visible or the deadline passes,
 * so a loaded machine cannot fail a test by being slow; `poke` re-drives the
 * work on each round. Without it, a short drain for "nothing happens" checks.
 */
export async function settle(until?: () => boolean, poke?: () => Promise<void>): Promise<void> {
  for (let index = 0; index < 20; index += 1) await pause();
  if (!until) return;
  const deadline = Date.now() + SETTLE_DEADLINE_MS;
  while (!until() && Date.now() < deadline) {
    await poke?.();
    await pause(2);
  }
}

/** Timers on the test clock: `advance` runs every callback that came due. */
export function fakeTimers() {
  const timers = new Set<{ at: number; callback: () => void }>();
  return {
    setTimeout: (callback: () => void, delay: number) => {
      const timer = { at: env.clock + delay, callback };
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer: unknown) => {
      timers.delete(timer as { at: number; callback: () => void });
    },
    pending: () => [...timers].map((timer) => timer.at).sort((a, b) => a - b),
    advance: (to: number) => {
      env.clock = to;
      for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
        if (timer.at > env.clock) continue;
        timers.delete(timer);
        timer.callback();
      }
    },
  };
}

/** PetImDecisions as main wires it: rule candidates from the wiring, sends through its router. */
export function decisionRelay(
  h: Harness,
  extra: Partial<ConstructorParameters<typeof PetImDecisions>[0]> = {},
) {
  const lines: string[] = [];
  const approvals: unknown[] = [];
  const relay = new PetImDecisions({
    read: () => collectImDecisions(h.snapshot(), h.tasks, lines, h.wiring.decisions.deliveryFor),
    now: () => env.clock,
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
          observedAt: env.clock,
        });
    },
    router: h.wiring.router,
    isOwnerConversation: h.wiring.decisions.isOwnerConversation,
    ownerChannelIsDirect: h.wiring.decisions.ownerChannelIsDirect,
    isAway: h.wiring.decisions.isAway,
    decisionStatus: h.wiring.decisions.decisionStatus,
    projectionLive: h.wiring.decisions.projectionLive,
    workerGone: h.wiring.decisions.workerGone,
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
  const raise = (requestId = "req-1", createdAt = env.clock, connectionId = "worker") => {
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
          connectionId,
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
      observedAt: env.clock,
    });
  };
  /** Past the 15 s grace, then a few looks (as the grace timer and events would). */
  const poll = async (until?: () => boolean) => {
    env.clock += 16_000;
    for (let index = 0; index < 3; index += 1) await relay.scan();
    await settle(until, () => relay.scan());
  };
  const code = () => relay["options"].read()[0]?.code;
  return { relay, approvals, raise, poll, code };
}

export const OWNER_DM = {
  channel: "wechat",
  target: "owner-dm",
  senderId: "me",
  isDirectMessage: true,
};
/** Presence is re-read after the settings cache (5 s) expires. */
export const SETTINGS_TTL = 5_001;
