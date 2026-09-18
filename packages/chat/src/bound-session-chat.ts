/**
 * Routes a conversation that has entered a Work Session, ahead of Mimi.
 *
 * This middleware sits between the deterministic remote commands and
 * createMimiPetChat. When the host reports no binding for the conversation it
 * calls next() and Mimi handles the message exactly as before; when there is a
 * binding it terminates the chain, and the message goes to the Session instead
 * of the manager.
 *
 * Two properties matter more than they look:
 *
 * - Leaving is decided by the host, never by a model. /mimi has
 *   to work when the worker is wedged or the bound Session is unreachable,
 *   otherwise a user can be stuck inside a Session with no way out.
 * - The reply for an accepted message is not this middleware's job. A Session
 *   turn can take minutes, far longer than an inbound HTTP request should be
 *   held open, so acceptance is acknowledged immediately and the real answer
 *   comes back later through the durable outbox.
 */

import type { ChatMiddleware } from "./chat-gateway.js";
import type { ChannelMessage } from "./channel.js";

/** What the host decided to do with one inbound message. */
export type BoundSessionDisposition =
  | { kind: "not-bound" }
  | { kind: "accepted"; notice?: string }
  | { kind: "left"; text: string }
  | { kind: "status"; text: string }
  | { kind: "suspended"; text: string };

export interface BoundSessionControlClient {
  /**
   * Hand one inbound message to the host's bridge. Returns what happened so
   * the middleware can decide whether to stop or fall through to Mimi.
   */
  routeBoundSessionMessage(input: {
    channel: string;
    target: string;
    senderId: string;
    messageId?: string;
    text: string;
    isDirectMessage: boolean;
  }): Promise<BoundSessionDisposition>;
}

export interface BoundSessionChatOptions {
  desktop: BoundSessionControlClient;
  /**
   * Whether this conversation is a private chat. Group chats cannot be bound
   * in Phase 1, and the adapter is the only thing that knows which is which.
   */
  isDirectMessage?(message: ChannelMessage): boolean;
}

/**
 * A conversation is only addressable when both target and sender are known.
 * Without them two anonymous messages on one channel are indistinguishable,
 * and a reply could reach the wrong person, so such a message is left to Mimi.
 */
function isAddressable(message: ChannelMessage): boolean {
  return Boolean(message.target?.trim() && message.senderId?.trim());
}

export function createBoundSessionChat(options: BoundSessionChatOptions): ChatMiddleware {
  const isDirectMessage =
    options.isDirectMessage ?? ((message) => message.isDirectMessage === true);
  return async ({ message, reply }, next) => {
    if (!message.text.trim() && !message.attachments?.length) return next();
    if (!isAddressable(message)) return next();

    // A transport timeout is ambiguous: the Work Session may already have
    // accepted this message. Leave retry to the durable inbox instead of also
    // handing the same message to Mimi.
    const disposition = await options.desktop.routeBoundSessionMessage({
      channel: message.channel,
      target: message.target,
      senderId: message.senderId,
      ...(message.messageId ? { messageId: message.messageId } : {}),
      text: message.text,
      isDirectMessage: isDirectMessage(message),
    });

    switch (disposition.kind) {
      case "not-bound":
        return next();
      case "accepted":
        // The Session's answer arrives later through the outbox. Only an
        // explicit notice (the stale-binding reminder) is sent now.
        if (disposition.notice) await reply({ text: disposition.notice });
        return;
      case "left":
      case "status":
      case "suspended":
        await reply({ text: disposition.text });
        return;
    }
  };
}
