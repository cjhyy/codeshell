import { chooseHydrateBase } from "../automation/hydrateOrder";
import type { Message, MessagesReducerState } from "../types";

function sameAnchor(left: Message, right: Message): boolean {
  if (left.kind !== right.kind) return false;
  if (left.id === right.id) return true;
  if (left.kind === "user" && right.kind === "user") {
    if (left.clientMessageId && right.clientMessageId) {
      return left.clientMessageId === right.clientMessageId;
    }
    if (left.steerId && right.steerId) return left.steerId === right.steerId;
    return (
      left.createdAt !== undefined && left.createdAt === right.createdAt && left.text === right.text
    );
  }
  return (
    left.kind === "assistant" &&
    right.kind === "assistant" &&
    left.createdAt !== undefined &&
    left.createdAt === right.createdAt &&
    left.text === right.text
  );
}

/** Reconcile two tail windows without losing legacy history before the disk window. */
export function mergeHistoryWindows(
  disk: MessagesReducerState,
  saved: MessagesReducerState,
): MessagesReducerState {
  const base = chooseHydrateBase(disk, saved);
  const first = disk.messages[0];
  if (!first) return base;
  const matches = saved.messages.flatMap((message, index) =>
    sameAnchor(first, message) ? [index] : [],
  );
  // Text alone is ambiguous (for example repeated "continue" requests). Only
  // retain a prefix when the start of the canonical window has one exact
  // durable-id or timestamp/content anchor in the saved snapshot.
  if (matches.length !== 1 || matches[0] === 0) return base;
  const ids = new Set(base.messages.map((message) => message.id));
  const prefix = saved.messages.slice(0, matches[0]).filter((message) => !ids.has(message.id));
  if (!prefix.length) return base;
  return {
    ...base,
    messages: [...prefix, ...base.messages],
    agentMessageIndex: Object.fromEntries(
      Object.entries(base.agentMessageIndex).map(([id, index]) => [id, index + prefix.length]),
    ),
  };
}
