import { randomUUID } from "node:crypto";
import {
  injectMobileRunAndAwaitAcceptance,
  type MobileRunBridge,
} from "@cjhyy/code-shell-server/mobile-remote";
import {
  createNoticeActionExecutor,
  type NoticeActionControls,
  type NoticeActionExecutor,
  type NoticeActionRouter,
  type NoticeLiveGoal,
} from "./pet-notice-actions.js";
import {
  interpretReply,
  type ReplyInterpretation,
  type ReplyItem,
  type ReplyModel,
} from "./pet-notice-reply-interpreter.js";
import { createReplyModels } from "./pet-notice-reply-models.js";
import type { NoticeActionRecord } from "./pet-notice-types.js";

type WorkerRequest = (
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  options: { meta: { origin: "host"; producer: string } },
) => Promise<{ ok: true; result: unknown } | { ok: false; message: string; code?: number }>;

/** The slice of the desktop external runtime service the actions use (trusted Main calls). */
export interface NoticeExternalRuntime {
  get(sessionId: string): unknown;
  isSessionRunning(sessionId: string): boolean;
  getGoal(sessionId: string): unknown;
  updateGoal(
    sessionId: string,
    patch: { paused: false; expectedGoalId: string; expectedRevision: number },
  ): Promise<{ updated?: boolean }>;
  deleteGoal(
    sessionId: string,
    expected: { expectedGoalId: string; expectedRevision: number },
  ): { cleared: boolean };
  send(
    sessionId: string,
    input: { text: string; displayText: string; clientMessageId: string },
  ): Promise<unknown>;
}

export interface NoticeActionControlsDeps {
  worker: MobileRunBridge & { requestWorker: WorkerRequest };
  external: () => NoticeExternalRuntime | undefined;
  /** The projection's Sessions (run state). */
  sessions: () => ReadonlyArray<{ agentSessionId: string; runState?: string }>;
  longTasks: {
    get(taskId: string): { status: string } | undefined;
    control(request: {
      taskId: string;
      action: "retry" | "cancel";
    }): Promise<{ ok: true } | { ok: false; message: string }>;
  };
  /** Raw transcript events of a Session (rawTranscript.getSessionEvents). */
  readEvents: (
    sessionId: string,
  ) => Promise<Array<{ type: string; data: Record<string, unknown> }>>;
  workspace: (sessionId: string) => Promise<string | undefined>;
  openPath: (path: string) => Promise<string>;
  revealPath: (path: string) => void;
  openExternal: (url: string) => Promise<void>;
  locateSession: (sessionId: string) => void;
}

const META = { meta: { origin: "host" as const, producer: "pet-notice-action" } };
/** The reply model budget in a chat bound to a Session (its route call times out at 20 s). */
export const BOUND_TIMEOUT_MS = 8_000;
const MAX_MESSAGE = 12_000;

function liveGoal(value: unknown): NoticeLiveGoal | null {
  if (!value || typeof value !== "object") return null;
  const goal = value as { goal?: unknown; goalId?: unknown; revision?: unknown; paused?: unknown };
  if (typeof goal.goal !== "string" || !goal.goal) return null;
  return {
    ...(typeof goal.goalId === "string" ? { goalId: goal.goalId } : {}),
    ...(typeof goal.revision === "number" ? { revision: goal.revision } : {}),
    paused: goal.paused === true,
  };
}

/** The text of one transcript message (its text blocks); undefined when it has none. */
function messageText(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((block) =>
      block && typeof block === "object" && (block as { type?: unknown }).type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .join("")
    .trim();
  return text || undefined;
}

/** The text of a Session's last message from its user, from its transcript events. */
export function lastUserMessageIn(
  events: ReadonlyArray<{ type: string; data: Record<string, unknown> }>,
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== "message" || event.data.role !== "user") continue;
    // Host-injected continuations and agent / policy messages are not the user's.
    if (event.data.injected === true) continue;
    const authority = event.data.authority;
    if (authority !== undefined && authority !== "user") continue;
    const text = messageText(event.data.content);
    return text && text.length <= MAX_MESSAGE ? text : undefined;
  }
  return undefined;
}

/**
 * Main's controls behind notice items: native Sessions through the worker's
 * RPC (`agent/goalGet`, `agent/goalDelete`, `agent/run`), desktop external
 * runtimes through their service, long tasks through the coordinator, and
 * the desktop shell for opening results.
 */
export function createNoticeActionControls(deps: NoticeActionControlsDeps): NoticeActionControls {
  const request = async (method: string, params: Record<string, unknown>) => {
    const outcome = await deps.worker.requestWorker(method, params, 10_000, META);
    if (!outcome.ok) throw new Error(outcome.message);
    return outcome.result;
  };
  return {
    async goal(sessionId, runtime) {
      if (runtime === "external") return liveGoal(deps.external()?.getGoal(sessionId));
      return liveGoal(await request("agent/goalGet", { sessionId }));
    },
    sessionState(sessionId, runtime) {
      if (runtime === "external") {
        const external = deps.external();
        if (!external?.get(sessionId)) return "missing";
        return external.isSessionRunning(sessionId) ? "running" : "idle";
      }
      const session = deps.sessions().find((entry) => entry.agentSessionId === sessionId);
      // A Session the catalog no longer lists was deleted (or archived away).
      if (!session) return "missing";
      return session.runState === "running" || session.runState === "queued" ? "running" : "idle";
    },
    async send(sessionId, runtime, input) {
      if (runtime === "external") {
        const external = deps.external();
        if (!external) throw new Error("external runtime service is unavailable");
        await external.send(sessionId, input);
        return;
      }
      const acceptance = await injectMobileRunAndAwaitAcceptance(
        deps.worker,
        {
          id: `pet-notice-action-${randomUUID()}`,
          params: {
            sessionId,
            task: input.text,
            displayText: input.displayText,
            clientMessageId: input.clientMessageId,
            requireExisting: true,
          },
        },
        META.meta,
      );
      if (!acceptance.ok) throw new Error(acceptance.message);
    },
    async resumeGoal(sessionId, runtime, expected) {
      const cas = { expectedGoalId: expected.goalId, expectedRevision: expected.revision };
      if (runtime === "external") {
        const external = deps.external();
        if (!external) throw new Error("external runtime service is unavailable");
        // It sends its own resume message: a new run, with fresh counters.
        return (await external.updateGoal(sessionId, { paused: false, ...cas })).updated === true;
      }
      // Core schedules the resume turn itself.
      const result = (await request("agent/goalUpdate", { sessionId, paused: false, ...cas })) as {
        updated?: unknown;
      };
      return result?.updated === true;
    },
    async deleteGoal(sessionId, runtime, expected) {
      const cas = { expectedGoalId: expected.goalId, expectedRevision: expected.revision };
      if (runtime === "external")
        return deps.external()?.deleteGoal(sessionId, cas).cleared === true;
      const result = (await request("agent/goalDelete", { sessionId, ...cas })) as {
        deleted?: unknown;
      };
      return result?.deleted === true;
    },
    task: (taskId) => deps.longTasks.get(taskId),
    controlTask: (taskId, action) => deps.longTasks.control({ taskId, action }),
    async lastUserMessage(sessionId) {
      return lastUserMessageIn(await deps.readEvents(sessionId));
    },
    workspace: deps.workspace,
    async openPath(path) {
      const error = await deps.openPath(path);
      if (error) throw new Error(`failed to open: ${error}`);
    },
    revealPath: deps.revealPath,
    openExternal: deps.openExternal,
    locateSession: deps.locateSession,
  };
}

/**
 * What PetImDecisions needs to read owner replies and act on notice items:
 * the reply model chain (auxiliary, then Mimi's model) and the item executor
 * over Main's controls.
 */
export function createOwnerReplyHandling(
  deps: NoticeActionControlsDeps & {
    router: NoticeActionRouter & { openActionItems(channel: string): NoticeActionRecord[] };
    /** Settings cwd for the reply models. */
    cwd: string;
    models?: ReplyModel[];
    onError: (error: unknown) => void;
  },
): {
  interpret: (
    message: string,
    items: ReplyItem[],
    options: { bound: boolean },
  ) => Promise<ReplyInterpretation | undefined>;
  actions: {
    items(channel: string): NoticeActionRecord[];
    execute: NoticeActionExecutor["execute"];
  };
} {
  const executor = createNoticeActionExecutor({
    router: deps.router,
    controls: createNoticeActionControls(deps),
    onError: deps.onError,
  });
  const models = deps.models ?? createReplyModels(deps.cwd);
  return {
    interpret: (message, items, { bound }) =>
      interpretReply({
        message,
        items,
        // A bound chat answers inside the gateway's 20 s route call: one model, 8 s.
        ...(bound ? { models: models.slice(0, 1), timeoutMs: BOUND_TIMEOUT_MS } : { models }),
        onError: (error) => deps.onError(error),
      }),
    actions: {
      items: (channel) => deps.router.openActionItems(channel),
      execute: (request) => executor.execute(request),
    },
  };
}
