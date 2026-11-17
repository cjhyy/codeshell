import type { ChatItem } from "../src/lib/streamReducer.js";
import { isInvisibleAssistant } from "./toolDisplayRecords.js";

export type ProcessItem = Extract<ChatItem, { kind: "assistant" | "tool" }>;
export type AnswerItem = Extract<ChatItem, { kind: "assistant" }>;

/** Display projection only: these cards do not establish run/producer identity. */
export interface ProcessActivityGroup {
  kind: "process";
  id: string;
  items: ProcessItem[];
  running: boolean;
}

export interface AnswerActivityGroup {
  kind: "answer";
  id: string;
  items: AnswerItem[];
  partial: boolean;
  pending: boolean;
}

export type ProcessActivityRow = ChatItem | ProcessActivityGroup | AnswerActivityGroup;

function hasAnswer(item: AnswerItem): boolean {
  return !!item.text || !!item.textDetailRef;
}

/**
 * Match Desktop's process/final-answer boundary without changing history items:
 * narration, thinking and tools through the last tool belong to the process;
 * the final answer stays outside, including while it streams. User messages,
 * errors, approvals/system records and agent changes always remain boundaries.
 */
export function projectProcessActivity(
  items: readonly ChatItem[],
  { running = false, partial = false }: { running?: boolean; partial?: boolean } = {},
): ProcessActivityRow[] {
  const rows: ProcessActivityRow[] = [];
  const counts = new Map<string, number>();
  let lastActivity = -1;
  let lastUser = -1;
  items.forEach((item, index) => {
    counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
    if (item.kind === "user") lastUser = index;
    if (item.kind === "assistant" || item.kind === "tool") lastActivity = index;
    // A later user/system/agent record cannot make an older process live again.
    else lastActivity = -1;
  });
  let pending: ProcessItem[] = [];
  let pendingEnd = -1;
  let partialTurn = partial;
  const flush = () => {
    if (!pending.length) return;
    const live =
      running &&
      pendingEnd > lastUser &&
      (pendingEnd === lastActivity || pending.some((item) => !item.done));
    let processEnd = -1;
    pending.forEach((item, index) => {
      if (item.kind === "tool") processEnd = index;
    });
    // A final assistant owns both reasoning and text. Keep its container stable
    // when the first text delta arrives so manually expanded reasoning survives.
    // MessageContent already folds reasoning; only earlier thinking belongs here.
    const process = pending.slice(0, processEnd + 1);
    const answer = pending.slice(processEnd + 1) as AnswerItem[];
    if (process.length) {
      rows.push({
        kind: "process",
        id: `process:${process[0].id}`,
        items: process,
        running:
          live &&
          (process.some((item) => item.kind === "tool" && !item.done) || !answer.some(hasAnswer)),
      });
    }
    if (answer.length) {
      rows.push({
        kind: "answer",
        id: `answer:${answer[0].id}`,
        items: answer,
        partial: partialTurn,
        pending: live || answer.some((item) => !item.done),
      });
    }
    pending = [];
  };
  items.forEach((item, index) => {
    const eligible =
      (item.kind === "assistant" || (item.kind === "tool" && !item.error)) &&
      item.id &&
      counts.get(item.id) === 1;
    if (!eligible) {
      flush();
      rows.push(item);
      if (item.kind === "user") partialTurn = false;
      return;
    }
    const processItem = item as ProcessItem;
    if (pending.length && pending[0].agentId !== processItem.agentId) flush();
    if (isInvisibleAssistant(processItem)) {
      // Only skip the already invisible shape; never erase reasoning/detail refs.
      if (pending.length) pendingEnd = index;
      return;
    }
    pending.push(processItem);
    pendingEnd = index;
  });
  flush();
  return rows;
}

/** Preserve every in-flight tool (including requests needing attention). */
export function currentProcessItems(items: readonly ProcessItem[]): ProcessItem[] {
  const active = items.filter((item) => !item.done);
  return active.length ? active : items.slice(-1);
}
