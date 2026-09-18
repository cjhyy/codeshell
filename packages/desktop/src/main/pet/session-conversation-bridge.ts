/**
 * The host side of a conversation that has entered a Work Session.
 *
 * Everything a bound message needs to survive lives here: the deterministic
 * commands, the fail-closed checks that run before each delivery, and the
 * admission into a new turn or the existing Session's queue. The gateway
 * middleware only asks "what happened to this message".
 *
 * Design rule this file exists to keep: a message is never lost and never
 * delivered to the wrong place. A failure returns an explicit routing error
 * rather than silently sending the text to a different conversation.
 */

import {
  boundSessionStalePrompt,
  parseBoundSessionCommand,
  type ConversationSessionRoute,
} from "@cjhyy/code-shell-pet";
import type { ConversationSessionRouteStore } from "./conversation-session-route-store.js";
import { imConversationRouteKey } from "./session-turn-scheduler.js";

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
  /** Queue for the next turn; resolves on worker admission, not turn completion. */
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
   * Only a confirmed absent binding may fall through to Mimi. An unknown
   * routing state must not send the same input to a second conversation.
   */
  async accept(inbound: BoundSessionInbound): Promise<BoundSessionDisposition> {
    try {
      return await this.route(inbound);
    } catch {
      return {
        kind: "suspended",
        text: "暂时无法确认当前 Session 路由，这条消息没有转交给 Mimi。请稍后重试。",
      };
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

    if (!inbound.isDirectMessage) {
      return { kind: "suspended", text: "进入 Session 目前只支持私聊。请私聊我再试一次。" };
    }

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

    if (!inbound.text.trim()) {
      return {
        kind: "suspended",
        text: "当前 Session 入口只支持文字消息，请输入文字后重试。",
      };
    }

    try {
      await this.deliver(route, inbound);
    } catch {
      // Never report success for a message that did not land. Telling the user
      // is the whole point: a silent "accepted" loses their input with no
      // trace, which is worse than an honest failure they can retry.
      return {
        kind: "suspended",
        text: `未能确认「${route.sessionTitle}」已接收这条消息。请稍后查看 /session，或发送 /mimi 退出。`,
      };
    }
    await this.deps.routes.recordInbound(route.id);
    this.deps.onVisitInbound?.(route);
    return notice ? { kind: "accepted", notice } : { kind: "accepted" };
  }

  /**
   * Both start and queue wait only for the worker's admission acknowledgement.
   * Waiting for a running turn to consume a steer can exceed the IM HTTP
   * timeout and route one input to both the Work Session and Mimi. Core's
   * session queue preserves the existing context and serializes follow-ups.
   */
  private async deliver(
    route: ConversationSessionRoute,
    inbound: BoundSessionInbound,
  ): Promise<void> {
    const clientMessageId = boundClientMessageId(route.id, inbound);
    const text = inbound.text.trim();
    const running = await this.deps.runner.isRunning(route.sessionId);

    if (running) {
      await this.deps.runner.queueNextTurn({
        sessionId: route.sessionId,
        text,
        clientMessageId,
      });
      return;
    }

    const started = await this.deps.runner.run({
      sessionId: route.sessionId,
      text,
      clientMessageId,
    });
    if (!started.started) {
      throw new Error(started.reason ?? "the Session refused the message");
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
