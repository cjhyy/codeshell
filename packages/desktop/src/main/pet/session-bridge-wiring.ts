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
  createRunner(onTurn: (result: BoundSessionTurnResult) => void): BoundSessionRunner;
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
  now?: () => number;
}

export interface SessionBridgeWiring {
  routes: ConversationSessionRouteStore;
  bridge: SessionConversationBridge;
  /** Register under the `sessionBind` key of the Mimi host-action table. */
  sessionBindExecutor(
    payload: Record<string, unknown>,
    context?: { completionTarget?: { channel: string; target: string }; senderId?: string },
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
  async function deliverSessionReply({
    sessionId,
    turnId,
    text,
  }: BoundSessionTurnResult): Promise<void> {
    if (!text.trim()) return;
    for (const route of await routes.notifyRoutesForSession(sessionId)) {
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
    }
  }

  const runner = deps.createRunner((turn) => {
    // The Session's answer is produced long after the inbound request
    // returned, so it goes back through the durable outbox.
    void deliverSessionReply(turn).catch(() => undefined);
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
              // Phase 1 binds private chats only. Without an adapter signal a
              // shared target cannot be proven private, so a target that
              // differs from the sender is treated as a group.
              isDirectMessage: target.target === context.senderId,
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
export interface BridgeWorkerLike {
  requestWorker(
    method: string,
    params: Record<string, unknown>,
    options: { meta: { origin: string; producer: string } },
  ): Promise<{ ok: boolean; result?: unknown; message?: string }>;
  /** Live protocol stream, used to observe turn boundaries and steer uptake. */
  subscribeOutbound?(
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

const META = { meta: { origin: "host", producer: "session-bridge" } };

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
  onTurn?: (result: BoundSessionTurnResult) => void,
): BoundSessionRunner {
  const injected = new Set<string>();
  const running = new Map<string, { done: Promise<void>; resolve: () => void }>();
  const lastAssistantText = new Map<string, string>();

  function beginRun(sessionId: string): void {
    if (running.has(sessionId)) return;
    let resolve!: () => void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    running.set(sessionId, { done, resolve });
  }

  function endRun(sessionId: string): void {
    const entry = running.get(sessionId);
    if (!entry) return;
    running.delete(sessionId);
    entry.resolve();
  }

  // One tap serves steer confirmation, turn boundaries and reply capture.
  worker.subscribeOutbound?.((_line, snapshotEntry) => {
    const sessionId = snapshotEntry?.sessionId;
    const event = snapshotEntry?.event;
    if (!sessionId || !event || typeof event !== "object" || Array.isArray(event)) return;
    const record = event as Record<string, unknown>;
    const type = record.type;
    if (type === "steer_injected" && typeof record.id === "string") {
      injected.add(`${sessionId}\u0000${record.id}`);
      return;
    }
    if (type === "stream_request_start") {
      beginRun(sessionId);
      return;
    }
    if (type === "assistant_message") {
      // Keep only the latest assistant text; the turn's final one is what the
      // conversation should receive, not every intermediate step.
      const text = assistantMessageText(record.message);
      if (text) lastAssistantText.set(sessionId, text);
      return;
    }
    if (type === "turn_complete") {
      const text = lastAssistantText.get(sessionId);
      lastAssistantText.delete(sessionId);
      endRun(sessionId);
      if (text?.trim()) {
        onTurn?.({ sessionId, turnId: `${sessionId}:${Date.now()}`, text });
      }
    }
  });

  return {
    isRunning: async (sessionId) => {
      if (running.has(sessionId)) return true;
      const session = aggregator
        .getSnapshot()
        .sessions.find((entry) => entry.agentSessionId === sessionId);
      return session?.runState === "running" || session?.runState === "queued";
    },
    run: async ({ sessionId, text, clientMessageId }) => {
      // Do NOT await the run RPC: it resolves at turn end, far past the worker
      // timeout. Acceptance is proven by runAccepted / stream_request_start.
      beginRun(sessionId);
      const settled = worker
        .requestWorker("agent/run", { sessionId, task: text, clientMessageId }, META)
        .then((response) => {
          endRun(sessionId);
          return response;
        })
        .catch(() => {
          endRun(sessionId);
          return { ok: false, message: "the agent worker did not accept the turn" };
        });
      const accepted = await Promise.race([
        settled.then((response) => (response.ok ? "ok" : "failed")),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 3_000)),
      ]);
      // "pending" means the run is still executing, which is success: the RPC
      // only returns once the whole turn is over.
      if (accepted === "failed") {
        const response = await settled;
        return { started: false, ...(response.message ? { reason: response.message } : {}) };
      }
      return { started: true };
    },
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
    queueNextTurn: async ({ sessionId, text, clientMessageId }) => {
      // Core's ChatSession serializes this behind the in-flight turn. The
      // result is checked: a refused queue must surface, not vanish.
      const response = await worker.requestWorker(
        "agent/run",
        { sessionId, task: text, clientMessageId },
        META,
      );
      if (!response.ok) {
        throw new Error(response.message ?? "the Session refused the queued message");
      }
    },
    supportsSteer: (sessionId) => {
      // An external runtime (codex / claude-code) has no steer at all; its
      // turns never pass through agent/run, so both steer and run would fail.
      // The projection is the only signal available here.
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
