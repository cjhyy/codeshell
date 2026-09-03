/**
 * The host executor behind Mimi's BindConversationSession tool.
 *
 * Extracted rather than inlined in index.ts because the interesting part is
 * the validation chain, not the plumbing: the model supplies only an opaque
 * selector, and everything that decides whether it may become this
 * conversation's Session happens here, where it can be tested directly.
 *
 * The tool result never states an outcome. Mimi registers a request, the host
 * validates and performs it, and this receipt replaces her wording — so a
 * refusal cannot be reported to the user as a successful entry.
 */

import type { ConversationSessionRoute, SessionVisitReceipt } from "@cjhyy/code-shell-pet";
import { openSessionVisitReceipt } from "@cjhyy/code-shell-pet";
import type { ConversationSessionRouteStore } from "./conversation-session-route-store.js";
import type { BindValidation, ValidateBindInput } from "./conversation-session-bind-validator.js";
import { imConversationRouteKey } from "./session-turn-scheduler.js";

/** The originating conversation, supplied by the host, never by the model. */
export interface BindActionContext {
  channel: string;
  target: string;
  senderId: string;
  isDirectMessage: boolean;
}

export interface BindHostActionDeps {
  routes: ConversationSessionRouteStore;
  validate(input: ValidateBindInput): Promise<BindValidation>;
  /** Persist the receipt opened when a visit begins. */
  recordVisit?(receipt: SessionVisitReceipt): Promise<void>;
  newVisitId(): string;
  now(): number;
}

export interface BindActionResult {
  action: "enter" | "leave";
  ok: boolean;
  /** Authoritative text the host appends to Mimi's reply. */
  message: string;
  sessionTitle?: string;
}

export function createSessionBindHostAction(deps: BindHostActionDeps) {
  return async function execute(
    payload: Record<string, unknown>,
    context: BindActionContext | undefined,
  ): Promise<BindActionResult> {
    const action = payload.action;
    if (action !== "enter" && action !== "leave") {
      throw new Error("invalid session bind request");
    }
    if (!context) throw new Error("当前消息没有可用的会话路由");

    const routeKey = imConversationRouteKey(context);
    if (!routeKey) {
      return {
        action,
        ok: false,
        message: "这个会话缺少可用的身份信息，无法绑定 Session。",
      };
    }

    if (action === "leave") {
      const left = await deps.routes.leave(routeKey, "user");
      return left
        ? {
            action,
            ok: true,
            message: `已退出「${left.sessionTitle}」，接下来由 Mimi 处理。`,
            sessionTitle: left.sessionTitle,
          }
        : { action, ok: true, message: "当前不在任何 Session 中，消息由 Mimi 处理。" };
    }

    const selector = typeof payload.sessionSelector === "string" ? payload.sessionSelector : "";
    if (!selector) throw new Error("invalid session bind request");

    const validation = await deps.validate({
      selector,
      isDirectMessage: context.isDirectMessage,
      isAddressable: true,
    });
    if (!validation.ok) {
      // The refusal reason reaches the user verbatim; Mimi does not get to
      // reword it into something that sounds like success.
      return { action, ok: false, message: validation.message };
    }

    const route = await deps.routes.upsert({
      routeKey,
      channel: context.channel,
      target: context.target,
      senderId: context.senderId,
      sessionId: validation.candidate.sessionId,
      sessionTitle: validation.candidate.title,
      mode: "bound",
      origin: "enter",
    });

    await recordVisitOpen(deps, route);

    return {
      action,
      ok: true,
      sessionTitle: route.sessionTitle,
      message:
        `已进入「${route.sessionTitle}」。接下来的消息会直接发送到这个 Session。\n` +
        "发送 /mimi 可退出，发送 /session 可查看当前状态。",
    };
  };
}

async function recordVisitOpen(
  deps: BindHostActionDeps,
  route: ConversationSessionRoute,
): Promise<void> {
  if (!deps.recordVisit) return;
  // A receipt that cannot be written must not fail the bind: the user is
  // already routed, and losing Mimi's later summary is the lesser problem.
  await deps
    .recordVisit(
      openSessionVisitReceipt({
        id: deps.newVisitId(),
        routeId: route.id,
        sessionId: route.sessionId,
        title: route.sessionTitle,
        enteredAt: deps.now(),
      }),
    )
    .catch(() => undefined);
}
