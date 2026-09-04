/**
 * The host side of a conversation that has entered a Work Session.
 *
 * Everything a bound message needs to survive lives here: the deterministic
 * commands, the fail-closed checks that run before each delivery, and the
 * decision between starting a turn, joining the one in flight, or queuing for
 * the next. The gateway middleware only asks "what happened to this message".
 *
 * Design rule this file exists to keep: a message is never lost and never
 * delivered to the wrong place. Every failure mode routes back to Mimi with a
 * reason rather than silently dropping the text or guessing a Session.
 */

import {
  boundSessionStalePrompt,
  parseBoundSessionCommand,
  type ConversationSessionRoute,
} from "@cjhyy/code-shell-pet";
import type { ConversationSessionRouteStore } from "./conversation-session-route-store.js";
import { imConversationRouteKey, resolveSteerOutcome } from "./session-turn-scheduler.js";

export type BoundSessionDisposition =
  | { kind: "not-bound" }
  | { kind: "accepted"; notice?: string }
  | { kind: "left"; text: string }
  | { kind: "status"; text: string }
  | { kind: "suspended"; text: string };

export interface BoundSessionInbound {
  channel: string;
  target: string;
  senderId: string;
  messageId?: string;
  text: string;
  isDirectMessage: boolean;
}

/** How the bridge reaches a Work Session. Injected so it can be tested. */
export interface BoundSessionRunner {
  /** Whether the Session currently has a turn in flight. */
  isRunning(sessionId: string): Promise<boolean>;
  /** Start a new turn. Resolves once the turn is accepted, not completed. */
  run(input: {
    sessionId: string;
    text: string;
    clientMessageId: string;
  }): Promise<{ started: boolean; reason?: string }>;
  /** Splice into the running turn. */
  steer(input: {
    sessionId: string;
    text: string;
    id: string;
    clientMessageId: string;
  }): Promise<{ accepted: boolean }>;
  unsteer(input: { sessionId: string; id: string }): Promise<{ removed: boolean }>;
  /** True once a steer_injected event named this entry. */
  wasInjected(sessionId: string, id: string): boolean;
  /** Resolves when the in-flight turn settles. */
  runDone(sessionId: string): Promise<void>;
  /** Persistently queue for the next turn (external runtimes cannot steer). */
  queueNextTurn(input: { sessionId: string; text: string; clientMessageId: string }): Promise<void>;
  /** Whether this runtime supports steering at all. */
  supportsSteer(sessionId: string): boolean;
}

export interface BoundSessionHealth {
  /** Re-checked before every delivery, not just at bind time. */
  check(
    sessionId: string,
  ): Promise<
    | { ok: true }
    | { ok: false; reason: "session-missing" | "session-archived" | "worktree-missing" }
  >;
}

export interface SessionConversationBridgeDeps {
  routes: ConversationSessionRouteStore;
  runner: BoundSessionRunner;
  health: BoundSessionHealth;
  /** Snapshot for /session, kept separate so status never starts a turn. */
  describeStatus(route: ConversationSessionRoute): Promise<string>;
  onVisitInbound?(route: ConversationSessionRoute): void;
  onVisitClosed?(route: ConversationSessionRoute, reason: "user" | "expired" | "suspended"): void;
}

const SUSPEND_MESSAGES: Record<string, string> = {
  "session-missing": "这个 Session 已经不存在了，已帮你退回 Mimi。刚才那条消息没有发送出去。",
  "session-archived": "这个 Session 已归档，已帮你退回 Mimi。刚才那条消息没有发送出去。",
  "worktree-missing":
    "这个 Session 的工作目录已经不存在了，已帮你退回 Mimi。刚才那条消息没有发送出去。",
};

export class SessionConversationBridge {
  constructor(private readonly deps: SessionConversationBridgeDeps) {}

  /**
   * Decide what happens to one inbound message. Never throws: an unexpected
   * failure reports not-bound so the gateway falls through to Mimi, which is
   * the behavior that existed before any binding.
   */
  async accept(inbound: BoundSessionInbound): Promise<BoundSessionDisposition> {
    try {
      return await this.route(inbound);
    } catch {
      return { kind: "not-bound" };
    }
  }

  private async route(inbound: BoundSessionInbound): Promise<BoundSessionDisposition> {
    const routeKey = imConversationRouteKey(inbound);
    if (!routeKey) return { kind: "not-bound" };

    // Downgrade anything that aged out before reading, so an expiry that
    // elapsed while the app was closed takes effect now rather than after
    // one more message has already been delivered.
    await this.deps.routes.expireStaleBoundRoutes();

    const command = parseBoundSessionCommand(inbound.text);
    const route = await this.deps.routes.boundRoute(routeKey);

    // Leaving is answered even with no binding, so a confused user always
    // gets a definite reply rather than silence.
    if (command === "leave") {
      if (!route) return { kind: "left", text: "当前不在任何 Session 中，消息由 Mimi 处理。" };
      await this.deps.routes.leave(routeKey, "user");
      this.deps.onVisitClosed?.(route, "user");
      return { kind: "left", text: `已退出「${route.sessionTitle}」，接下来由 Mimi 处理。` };
    }

    if (!route) return { kind: "not-bound" };

    if (command === "status") {
      // Deliberately does not touch the runner: /session must never start a
      // turn or wake a model.
      return { kind: "status", text: await this.deps.describeStatus(route) };
    }

    const health = await this.deps.health.check(route.sessionId);
    if (!health.ok) {
      await this.deps.routes.suspend(route.id, health.reason);
      this.deps.onVisitClosed?.(route, "suspended");
      return {
        kind: "suspended",
        text: SUSPEND_MESSAGES[health.reason] ?? "这个 Session 暂时不可用，已帮你退回 Mimi。",
      };
    }

    const notice = (await this.deps.routes.consumeStalePrompt(route.id))
      ? boundSessionStalePrompt(route.sessionTitle).hint
      : undefined;

    try {
      await this.deliver(route, inbound);
    } catch {
      // Never report success for a message that did not land. Telling the user
      // is the whole point: a silent "accepted" loses their input with no
      // trace, which is worse than an honest failure they can retry.
      return {
        kind: "suspended",
        text: `「${route.sessionTitle}」暂时无法接收消息，刚才那条没有发送出去。稍后再试，或发送 /mimi 退出。`,
      };
    }
    await this.deps.routes.recordInbound(route.id);
    this.deps.onVisitInbound?.(route);
    return notice ? { kind: "accepted", notice } : { kind: "accepted" };
  }

  /**
   * Start, join, or queue. The ordering is deliberate: ask whether a turn is
   * running, but never trust that answer alone — the engine rejects a steer
   * when no run is active, and the truth lives in the worker process.
   */
  private async deliver(
    route: ConversationSessionRoute,
    inbound: BoundSessionInbound,
  ): Promise<void> {
    const clientMessageId = boundClientMessageId(route.id, inbound);
    const text = inbound.text.trim();
    const running = await this.deps.runner.isRunning(route.sessionId);

    if (running && !this.deps.runner.supportsSteer(route.sessionId)) {
      // External runtimes (codex, claude-code) have no steer at all, only a
      // post-turn continuation queue, so the message waits durably.
      await this.deps.runner.queueNextTurn({
        sessionId: route.sessionId,
        text,
        clientMessageId,
      });
      return;
    }

    if (running) {
      const steerId = clientMessageId;
      const outcome = await resolveSteerOutcome({
        steer: () =>
          this.deps.runner.steer({
            sessionId: route.sessionId,
            text,
            id: steerId,
            clientMessageId,
          }),
        wasInjected: () => this.deps.runner.wasInjected(route.sessionId, steerId),
        unsteer: () => this.deps.runner.unsteer({ sessionId: route.sessionId, id: steerId }),
        runDone: () => this.deps.runner.runDone(route.sessionId),
      });
      if (outcome === "consumed") return;
      // Not consumed: fall through and run it as its own turn. The stable
      // clientMessageId keeps that safe if the steer secretly landed.
    }

    const started = await this.deps.runner.run({
      sessionId: route.sessionId,
      text,
      clientMessageId,
    });
    if (!started.started) {
      // A refused start must not vanish; queue it so the next turn picks it up.
      // queueNextTurn throws when it too is refused, and accept() turns that
      // into a visible failure rather than a false acknowledgement.
      await this.deps.runner.queueNextTurn({
        sessionId: route.sessionId,
        text,
        clientMessageId,
      });
    }
  }
}

/**
 * Stable per-message identity used for transcript dedupe and safe replay. The
 * platform message id is preferred; text is only a fallback for adapters that
 * do not supply one.
 */
export function boundClientMessageId(routeId: string, inbound: BoundSessionInbound): string {
  const platform = inbound.messageId?.trim() || `text:${inbound.text.trim()}`;
  return `im-session:${routeId}:${platform}`;
}
