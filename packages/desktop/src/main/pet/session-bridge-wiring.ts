/**
 * Composition root for entering a Work Session from a chat.
 *
 * Everything in this feature is deliberately a small testable piece; this file
 * is the one place that knows how they fit together, so index.ts gains a few
 * lines rather than another inline branch it would have to grow for every
 * future change.
 *
 * It owns three concerns: constructing the store and bridge, exposing the
 * sessionBind executor for the host-action table, and turning a Session's
 * final answer into a durable outbound event.
 */

import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import type { ConversationSessionRoute } from "@cjhyy/code-shell-pet";
import {
  injectMobileRunAndAwaitAcceptance,
  type MobileRunBridge,
} from "@cjhyy/code-shell-server/mobile-remote";
import { ConversationSessionRouteStore } from "./conversation-session-route-store.js";
import { createConversationSessionBindValidator } from "./conversation-session-bind-validator.js";
import {
  SessionConversationBridge,
  type BoundSessionDisposition,
  type BoundSessionHealth,
  type BoundSessionInbound,
  type BoundSessionRunner,
} from "./session-conversation-bridge.js";
import { createSessionBindHostAction, type BindActionContext } from "./session-bind-host-action.js";
import type { PetReusableSessionCandidate } from "./pet-dispatch-service.js";

export interface SessionBridgeWiringDeps {
  /** `<userData>/pet/conversation-session-routes.json`. */
  routesFilePath: string;
  /** The strict selector gate DelegateWork's reuse path already applies. */
  resolveSelector(selector: string): Promise<PetReusableSessionCandidate | null>;
  /**
   * Workspace existence. Defaults to a real stat; injectable so tests can
   * exercise the wiring without creating a worktree on disk.
   */
  directoryExists?(path: string): Promise<boolean>;
  /**
   * Build the runner, receiving the callback that routes a finished turn back
   * to the conversation. Taking a factory rather than a runner keeps the
   * reply loop closed here instead of in the composition root, which cannot
   * reference the wiring it is still constructing.
   */
  createRunner(onTurn: (result: BoundSessionTurnResult) => Promise<void>): BoundSessionRunner;
  health: BoundSessionHealth;
  /** Human-readable status for /session, without waking a model. */
  describeStatus(route: ConversationSessionRoute): Promise<string>;
  /** Durable outbound publish, already deduplicated by deliveryKey. */
  publish(event: {
    deliveryKey: string;
    type: "session.reply";
    text: string;
    target: { channel: string; target: string };
  }): Promise<void>;
  /** Initial retry delay for a reply not yet persisted to the outbox. */
  deliveryRetryMs?: number;
  onDeliveryError?(error: unknown, turn: BoundSessionTurnResult): void;
  now?: () => number;
}

export interface SessionBridgeWiring {
  routes: ConversationSessionRouteStore;
  bridge: SessionConversationBridge;
  /** Register under the `sessionBind` key of the Mimi host-action table. */
  sessionBindExecutor(
    payload: Record<string, unknown>,
    context?: {
      completionTarget?: { channel: string; target: string };
      senderId?: string;
      isDirectMessage?: boolean;
    },
  ): Promise<Record<string, unknown>>;
  /** Called by the gateway middleware for one inbound message. */
  routeInbound(inbound: BoundSessionInbound): Promise<BoundSessionDisposition>;
  /** Deliver one Session turn's final answer back to every bound conversation. */
  deliverSessionReply(input: { sessionId: string; turnId: string; text: string }): Promise<void>;
  /** Downgrade routes that aged out while the app was closed. */
  recoverOnStartup(): Promise<void>;
}

export function createSessionBridgeWiring(deps: SessionBridgeWiringDeps): SessionBridgeWiring {
  const now = deps.now ?? Date.now;
  const routes = new ConversationSessionRouteStore(deps.routesFilePath, now);
  const validate = createConversationSessionBindValidator({
    resolveSelector: deps.resolveSelector,
    ...(deps.directoryExists ? { directoryExists: deps.directoryExists } : {}),
  });
  async function deliverSessionReply(
    { sessionId, turnId, text }: BoundSessionTurnResult,
    publishedRoutes?: Set<string>,
  ): Promise<void> {
    if (!text.trim()) return;
    for (const route of await routes.notifyRoutesForSession(sessionId)) {
      if (publishedRoutes?.has(route.id)) continue;
      await deps.publish({
        // Stable across retries and restarts so one turn is delivered once.
        deliveryKey: createHash("sha256")
          .update("session-reply\u0000")
          .update(sessionId)
          .update("\u0000")
          .update(turnId)
          .update("\u0000")
          .update(route.id)
          .digest("hex"),
        type: "session.reply",
        text,
        target: { channel: route.channel, target: route.target },
      });
      publishedRoutes?.add(route.id);
    }
  }

  // A terminal event arrives after the inbound request has returned. Keep its
  // publication pending until the durable outbox owns every targeted reply.
  const pendingReplies = new Map<string, Promise<void>>();
  const retryDelayMs = Math.max(1, deps.deliveryRetryMs ?? 1_000);
  const runner = deps.createRunner((turn) => {
    const key = `${turn.sessionId}\u0000${turn.turnId}`;
    const existing = pendingReplies.get(key);
    if (existing) return existing;
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    pendingReplies.set(key, pending);
    const publishedRoutes = new Set<string>();
    let failures = 0;
    const attempt = async (): Promise<void> => {
      try {
        await deliverSessionReply(turn, publishedRoutes);
        pendingReplies.delete(key);
        resolve();
      } catch (error) {
        try {
          deps.onDeliveryError?.(error, turn);
        } catch {
          // Logging must not discard the reply that still needs publication.
        }
        const delay = Math.min(30_000, retryDelayMs * 2 ** Math.min(failures++, 10));
        const timer = setTimeout(() => {
          void attempt();
        }, delay);
        timer.unref?.();
      }
    };
    void attempt();
    return pending;
  });
  const bridge = new SessionConversationBridge({
    routes,
    runner,
    health: deps.health,
    describeStatus: deps.describeStatus,
  });
  const bindAction = createSessionBindHostAction({
    routes,
    validate,
    newVisitId: () => `visit-${randomUUID()}`,
    now,
  });

  return {
    routes,
    bridge,
    sessionBindExecutor: async (payload, context) => {
      // The conversation identity comes from the host's authenticated route,
      // never from the model's tool arguments.
      const target = context?.completionTarget;
      const bindContext: BindActionContext | undefined =
        target && context?.senderId
          ? {
              channel: target.channel,
              target: target.target,
              senderId: context.senderId,
              // Conversation ids and user ids are different namespaces on
              // several platforms. Only the adapter can confirm a private chat.
              isDirectMessage: context.isDirectMessage === true,
            }
          : undefined;
      const result = await bindAction(payload, bindContext);
      return { ...result };
    },
    routeInbound: (inbound) => bridge.accept(inbound),
    deliverSessionReply,
    recoverOnStartup: async () => {
      await routes.expireStaleBoundRoutes();
    },
  };
}

/** Minimal worker seam: the same request shape PetDispatchService uses. */
export interface BridgeWorkerLike extends MobileRunBridge {
  requestWorker(
    method: string,
    params: Record<string, unknown>,
    options: {
      settleOnExit?: boolean;
      failFast?: boolean;
      meta: { origin: "host"; producer: string };
    },
  ): Promise<{ ok: boolean; result?: unknown; message?: string }>;
  /** Live protocol stream, used to observe turn boundaries and steer uptake. */
  subscribeOutbound(
    listener: (line: string, snapshotEntry?: { sessionId: string; event: unknown }) => void,
  ): () => void;
}

/** Minimal projection seam: whether a Session is currently running. */
export interface BridgeAggregatorLike {
  getSnapshot(): { sessions: readonly { agentSessionId: string; runState: string }[] };
  refreshCatalog(force: boolean): Promise<unknown>;
}

function workerBoolean(result: unknown, key: string): boolean | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const value = (result as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
}

const META = {
  settleOnExit: true,
  failFast: true,
  meta: { origin: "host" as const, producer: "session-bridge" },
};

/**
 * Flatten one assistant message to plain text. `content` is either a string or
 * a block list; only text blocks are user-facing, so tool calls and thinking
 * never reach the chat.
 */
function assistantMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  const content = (message as { content?: unknown }).content;
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

/** Emitted when a Session finishes a turn and produced user-facing text. */
export interface BoundSessionTurnResult {
  sessionId: string;
  turnId: string;
  text: string;
}

/**
 * Drive a native Work Session through the worker bridge.
 *
 * Two contracts matter here and both were wrong before:
 *
 * - `agent/run` takes `task`, not `message`. Core rejects anything else at
 *   ingress (protocol/server.ts runInputError), so a misnamed field silently
 *   refused every delivery.
 * - the run RPC resolves only when the whole turn ENDS, which for a real
 *   Session is minutes. Waiting on it would blow the worker timeout and make
 *   the caller re-send. Acceptance is taken from the `agent/runAccepted`
 *   notification instead, and the reply is reported later through `onTurn`.
 */
export function createBoundSessionRunner(
  worker: BridgeWorkerLike,
  aggregator: BridgeAggregatorLike,
  onTurn?: (result: BoundSessionTurnResult) => void | Promise<void>,
): BoundSessionRunner {
  const injected = new Set<string>();
  interface ObservedRun {
    done: Promise<void>;
    resolve: () => void;
    runId?: string;
    clientMessageId?: string;
    fallbackTurnId: string;
    lastAssistantText?: string;
  }
  const running = new Map<string, ObservedRun>();
  const completed = new Set<string>();
  const publishing = new Set<string>();

  function beginRun(sessionId: string, clientMessageId?: string): ObservedRun {
    const existing = running.get(sessionId);
    if (existing) return existing;
    let resolve!: () => void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    const entry = { done, resolve, clientMessageId, fallbackTurnId: randomUUID() };
    running.set(sessionId, entry);
    return entry;
  }

  function endRun(sessionId: string, expected?: ObservedRun): void {
    const entry = running.get(sessionId);
    if (!entry || (expected && entry !== expected)) return;
    running.delete(sessionId);
    entry.resolve();
  }

  function belongsToRun(record: Record<string, unknown>, run: ObservedRun): boolean {
    if (typeof record.runId === "string" && run.runId) return record.runId === run.runId;
    if (typeof record.clientMessageId === "string" && run.clientMessageId) {
      return record.clientMessageId === run.clientMessageId;
    }
    return true;
  }

  // One tap serves steer confirmation, turn boundaries and reply capture.
  worker.subscribeOutbound((_line, snapshotEntry) => {
    const sessionId = snapshotEntry?.sessionId;
    const event = snapshotEntry?.event;
    if (!sessionId || !event || typeof event !== "object" || Array.isArray(event)) return;
    const record = event as Record<string, unknown>;
    // Child events share the parent's stream envelope. They cannot settle its
    // turn or become a private-chat reply.
    if (record.agentId !== undefined) return;
    const type = record.type;
    if (type === "steer_injected" && typeof record.id === "string") {
      injected.add(`${sessionId}\u0000${record.id}`);
      return;
    }
    if (type === "session_started" || type === "stream_request_start") {
      let entry = running.get(sessionId);
      if (entry && !belongsToRun(record, entry)) {
        // Only an explicit run boundary can replace the current owner. A late
        // model-step event from an older run must not steal the new run.
        if (type !== "session_started") return;
        endRun(sessionId, entry);
        entry = undefined;
      }
      entry ??= beginRun(sessionId);
      if (typeof record.runId === "string") entry.runId = record.runId;
      if (typeof record.clientMessageId === "string")
        entry.clientMessageId = record.clientMessageId;
      return;
    }
    if (type === "assistant_message") {
      const entry = running.get(sessionId) ?? beginRun(sessionId);
      if (!belongsToRun(record, entry)) return;
      const text = assistantMessageText(record.message);
      if (text) entry.lastAssistantText = text;
      return;
    }
    if (type === "turn_complete") {
      const entry = running.get(sessionId);
      const matching = entry && belongsToRun(record, entry) ? entry : undefined;
      // Core's completion text is the authoritative final answer. An explicit
      // empty result must not resurrect an earlier progress message.
      const failed = record.reason === "model_error";
      const stopped = typeof record.reason === "string" && record.reason.startsWith("aborted");
      const finalText = typeof record.text === "string" ? record.text.trim() : undefined;
      const text =
        finalText ||
        (failed
          ? "这个 Session 本轮执行失败，请在桌面端查看详情后重试。"
          : stopped
            ? "这个 Session 本轮已停止。你可以发送新消息继续。"
            : finalText === undefined
              ? matching?.lastAssistantText
              : undefined);
      const turnId =
        (typeof record.runId === "string" && record.runId) ||
        matching?.runId ||
        (typeof record.clientMessageId === "string" && record.clientMessageId) ||
        matching?.clientMessageId ||
        matching?.fallbackTurnId;
      if (matching) endRun(sessionId, matching);
      if (!text?.trim() || !turnId) return;
      const key = `${sessionId}\u0000${turnId}`;
      if (completed.has(key) || publishing.has(key)) return;
      publishing.add(key);
      try {
        const delivery = onTurn?.({ sessionId, turnId, text });
        void Promise.resolve(delivery).then(
          () => {
            publishing.delete(key);
            completed.add(key);
            if (completed.size > 1_000) completed.delete(completed.values().next().value!);
          },
          () => {
            publishing.delete(key);
          },
        );
      } catch {
        publishing.delete(key);
      }
    }
  });

  async function submitRun({
    sessionId,
    text,
    clientMessageId,
  }: {
    sessionId: string;
    text: string;
    clientMessageId: string;
  }): Promise<{ started: boolean; reason?: string }> {
    const existing = running.get(sessionId);
    const entry = beginRun(sessionId, clientMessageId);
    const acceptance = await injectMobileRunAndAwaitAcceptance(
      worker,
      {
        id: `session-bridge-run-${randomUUID()}`,
        // `task` is the model-facing input. `displayText` also makes the
        // existing Session emit `session_user_message`, so a desktop renderer
        // that already has this Session open sees the IM turn immediately.
        // The transcript would still persist `task` without it, but the live
        // chat would have no user bubble until a later cold re-hydration.
        params: {
          sessionId,
          task: text,
          displayText: text,
          clientMessageId,
          requireExisting: true,
        },
      },
      META.meta,
    );
    if (!acceptance.ok) {
      // A refused successor must never settle the turn already in flight.
      if (!existing) endRun(sessionId, entry);
      return { started: false, reason: acceptance.message };
    }
    return { started: true };
  }

  return {
    isRunning: async (sessionId) => {
      if (running.has(sessionId)) return true;
      const session = aggregator
        .getSnapshot()
        .sessions.find((entry) => entry.agentSessionId === sessionId);
      return session?.runState === "running" || session?.runState === "queued";
    },
    run: submitRun,
    steer: async ({ sessionId, text, id, clientMessageId }) => {
      const response = await worker.requestWorker(
        "agent/steer",
        { sessionId, text, id, clientMessageId },
        META,
      );
      return { accepted: response.ok && workerBoolean(response.result, "accepted") === true };
    },
    unsteer: async ({ sessionId, id }) => {
      const response = await worker.requestWorker("agent/unsteer", { sessionId, id }, META);
      // Treat an unknown answer as "we took it back" so the message is re-run
      // rather than assumed delivered.
      return { removed: !response.ok || workerBoolean(response.result, "removed") !== false };
    },
    wasInjected: (sessionId, id) => injected.has(`${sessionId}\u0000${id}`),
    runDone: (sessionId) => running.get(sessionId)?.done ?? Promise.resolve(),
    queueNextTurn: async (input) => {
      // Core owns serialization; its acknowledgement confirms the successor
      // is queued without waiting for the current or following turn to finish.
      const result = await submitRun(input);
      if (!result.started) {
        throw new Error(result.reason ?? "the Session refused the queued message");
      }
    },
    supportsSteer: (sessionId) => {
      const session = aggregator
        .getSnapshot()
        .sessions.find((entry) => entry.agentSessionId === sessionId);
      return session !== undefined;
    },
  };
}

/**
 * Re-check a bound Session before every delivery. A Session can be archived or
 * have its worktree removed mid-conversation, and delivering into either would
 * write the user's message somewhere it cannot be read.
 */
export function createBoundSessionHealth(
  aggregator: BridgeAggregatorLike,
  sessionsRootDir: string,
): BoundSessionHealth {
  return {
    check: async (sessionId) => {
      await aggregator.refreshCatalog(false).catch(() => undefined);
      const visible = aggregator
        .getSnapshot()
        .sessions.some((entry) => entry.agentSessionId === sessionId);
      if (!visible) return { ok: false, reason: "session-missing" };
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      try {
        const state = JSON.parse(
          await readFile(join(sessionsRootDir, sessionId, "state.json"), "utf8"),
        ) as Record<string, unknown>;
        if (typeof state.archivedAt === "number") {
          return { ok: false, reason: "session-archived" };
        }
        const cwd = typeof state.cwd === "string" ? state.cwd : "";
        if (cwd) {
          const { stat } = await import("node:fs/promises");
          const entry = await stat(cwd).catch(() => null);
          if (!entry?.isDirectory()) return { ok: false, reason: "worktree-missing" };
        }
      } catch {
        return { ok: false, reason: "session-missing" };
      }
      return { ok: true };
    },
  };
}
