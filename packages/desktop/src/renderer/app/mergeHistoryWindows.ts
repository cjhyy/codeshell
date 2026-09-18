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

interface UserTurn {
  start: number;
  end: number;
}

function uniqueUserTurns(messages: readonly Message[]): Map<string, UserTurn | null> {
  const turns = new Map<string, UserTurn | null>();
  let end = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.kind !== "user") continue;
    const intent = message.clientMessageId
      ? `client:${message.clientMessageId}`
      : message.steerId
        ? `steer:${message.steerId}`
        : undefined;
    if (intent) turns.set(intent, turns.has(intent) ? null : { start: index, end });
    end = index;
  }
  return turns;
}

/** An interrupted reply can become an interior cache-only row after the next
 * completed turn. Recover it in its proven user turn, not as an orphan tail. */
function restoreCachedReplies(
  disk: MessagesReducerState,
  saved: MessagesReducerState,
  base: MessagesReducerState,
): MessagesReducerState {
  const savedTurns = uniqueUserTurns(saved.messages);
  const basePositions = new Map(base.messages.map((message, index) => [message, index]));
  const retainedIds = new Set(base.messages.map((message) => message.id));
  const insertions = new Map<number, Message[]>();
  for (const [intent, turn] of uniqueUserTurns(disk.messages)) {
    const cached = savedTurns.get(intent);
    if (!turn || !cached) continue;
    const canonical = disk.messages.slice(turn.start + 1, turn.end);
    // A canonical answer supersedes any cached partial. Compaction is also
    // deliberate history removal, not evidence of an interrupted reply.
    if (
      canonical.some(
        (message) => message.kind === "assistant" || message.kind === "context_boundary",
      )
    )
      continue;
    const final = canonical.find((message) => message.kind === "turn_end");
    const last = basePositions.get(disk.messages[turn.end - 1]!);
    if (last === undefined) continue;
    let nextPosition = (final ? basePositions.get(final) : undefined) ?? last + 1;
    const anchors = new Map(canonical.map((message) => [message.id, message]));
    const replies: Array<{ position: number; message: Message }> = [];
    for (let index = cached.end - 1; index > cached.start; index -= 1) {
      const message = saved.messages[index]!;
      const anchor = anchors.get(message.id);
      const position = anchor?.kind === message.kind ? basePositions.get(anchor) : undefined;
      if (position !== undefined) nextPosition = position;
      if (message.kind !== "assistant" || !message.text || retainedIds.has(message.id)) continue;
      retainedIds.add(message.id);
      replies.push({ position: nextPosition, message });
    }
    for (const { position, message } of replies.reverse()) {
      const rows = insertions.get(position) ?? [];
      rows.push(message);
      insertions.set(position, rows);
    }
  }
  if (!insertions.size) return base;
  const positions = new Map<number, number>();
  const messages: Message[] = [];
  for (let index = 0; index <= base.messages.length; index += 1) {
    messages.push(...(insertions.get(index) ?? []));
    if (index < base.messages.length) {
      positions.set(index, messages.length);
      messages.push(base.messages[index]!);
    }
  }
  return {
    ...base,
    messages,
    agentMessageIndex: Object.fromEntries(
      Object.entries(base.agentMessageIndex).map(([id, index]) => [
        id,
        positions.get(index) ?? index,
      ]),
    ),
  };
}

/** Reconcile two tail windows without losing legacy history before the disk window. */
export function mergeHistoryWindows(
  disk: MessagesReducerState,
  saved: MessagesReducerState,
): MessagesReducerState {
  const base = restoreCachedReplies(disk, saved, chooseHydrateBase(disk, saved));
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
