/**
 * Everything about a conversation that has entered a Work Session.
 *
 * These four modules are one feature and are always consumed together, so the
 * package barrel re-exports this file rather than each of them: the durable
 * route record, the chat-facing Session list, the receipt Mimi reads after a
 * visit, and the deterministic commands that must work without a model.
 */

export * from "./conversation-session-route.js";
export * from "./im-session-list.js";
export * from "./session-visit-receipt.js";
export * from "./bound-session-commands.js";
