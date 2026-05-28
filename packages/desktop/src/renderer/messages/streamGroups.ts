/**
 * Two-level folding for the chat stream — Codex-style.
 *
 * Level 1 — adjacent tool calls of ANY kind collapse into a single
 * "已处理 N 条命令 ⌄" card. The run ends at the first non-tool
 * message (user / assistant / thinking / agent / system / context_
 * boundary / task_list / ask_user / files_changed).
 *
 * Level 2 — within a user-turn, everything from the first tool call
 * to the last tool call (inclusive of any assistant text or level-1
 * groups in between) collapses into a "已处理 X m Y s ⌄" turn-
 * process card. Assistant text BEFORE the first tool and AFTER the
 * last tool stays visible — that's the user's question framing and
 * the assistant's final answer. The most recent (still-streaming)
 * turn skips level-2 folding so the user can watch progress live.
 */

import type { Message, ToolMessage } from "../types";

export interface ToolGroup {
  kind: "tool_group";
  /** Stable id derived from the first member, so React keys stay stable. */
  id: string;
  tools: ToolMessage[];
}

/**
 * Level-2 fold: a contiguous "process" block spanning from the first
 * tool call of a turn to the last, including any assistant text or
 * level-1 ToolGroup that lives between them.
 *
 * Live turns (the most recent one, still streaming) also produce a
 * group so the user sees a live "已处理 5s ⌄" header tick up; the
 * card defaults to OPEN so tool progress is visible.
 */
export interface TurnProcessGroup {
  kind: "turn_process_group";
  id: string;
  /** Wall time from the first tool's startedAt to the last tool's
   *  endedAt — 0 if any tool is still running and the card is live.
   *  Consumers should prefer `firstToolStartedAt` + a 1s ticker for
   *  live cards. */
  durationMs: number;
  /** Earliest tool startedAt; used by the live ticker. */
  firstToolStartedAt: number;
  /** True while the owning turn is still streaming. */
  isLive: boolean;
  /** Number of tool calls inside (across all level-1 groups + inline). */
  toolCount: number;
  /** Inner items in original order — Message | ToolGroup. */
  items: Array<Message | ToolGroup>;
}

export type StreamItem = Message | ToolGroup | TurnProcessGroup;

/**
 * Tool names that drive the renderer's pinned task panel rather than
 * the chat stream. The reducer routes the *event* (task_update) into
 * a TaskListMessage, but the underlying tool call itself still arrives
 * as a ToolMessage that would otherwise clutter the transcript with
 * "TodoWrite / TaskCreate / TaskUpdate" rows. Filter them out before
 * folding.
 */
const HIDDEN_TOOL_NAMES = new Set([
  "todowrite",
  "todo_write",
  "taskcreate",
  "task_create",
  "taskupdate",
  "task_update",
  "tasklist",
  "task_list",
  "taskget",
  "task_get",
  "taskstop",
  "task_stop",
  "taskoutput",
  "task_output",
]);

function isHiddenTool(m: Message): boolean {
  return (
    m.kind === "tool" &&
    HIDDEN_TOOL_NAMES.has(m.toolName.toLowerCase())
  );
}

/**
 * Build the display list:
 *   0. Drop task-tracker tool calls — those drive the pinned task
 *      panel, not the chat stream.
 *   1. Run level-1 folding: collapse adjacent tool messages into
 *      ToolGroup (regardless of toolName).
 *   2. Run level-2 folding: within each user-turn slice, wrap the
 *      span from first tool to last tool into a TurnProcessGroup.
 *      Mark the most recent turn as live so its header ticks.
 */
export function buildStreamItems(
  messages: Message[],
  opts: { liveTurnActive?: boolean } = {},
): StreamItem[] {
  const filtered = messages.filter((m) => !isHiddenTool(m));
  const level1 = foldAdjacentTools(filtered);
  return foldTurnProcess(level1, opts.liveTurnActive ?? false);
}

// ── Level 1: adjacent tools → ToolGroup ───────────────────────────────

function isToolish(item: Message | ToolGroup): boolean {
  return item.kind === "tool" || item.kind === "tool_group";
}

function foldAdjacentTools(messages: Message[]): Array<Message | ToolGroup> {
  const out: Array<Message | ToolGroup> = [];
  let runStart = -1;

  const flushRun = (endExclusive: number): void => {
    if (runStart < 0) return;
    const tools = messages.slice(runStart, endExclusive) as ToolMessage[];
    if (tools.length === 1) {
      out.push(tools[0]!);
    } else {
      out.push({
        kind: "tool_group",
        id: `group-${tools[0]!.id}`,
        tools,
      });
    }
    runStart = -1;
  };

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.kind === "tool") {
      if (runStart < 0) runStart = i;
      continue;
    }
    flushRun(i);
    out.push(m);
  }
  flushRun(messages.length);
  return out;
}

// ── Level 2: per-turn process group ───────────────────────────────────

/**
 * Walk items from each `user` message forward, find the first and
 * last tool-bearing item, wrap [first..last] into a TurnProcessGroup.
 * Items before `first` (typically the assistant lead-in / thinking)
 * and after `last` (the final summary) pass through untouched.
 *
 * The most recent turn is marked `isLive: true`. Live turns still
 * produce a process group so the elapsed ticker shows up in real
 * time; the card just defaults open so the user sees tool progress.
 */
function foldTurnProcess(
  items: Array<Message | ToolGroup>,
  liveTurnActive: boolean,
): StreamItem[] {
  const userIdxs: number[] = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i]!.kind === "user") userIdxs.push(i);
  }
  if (userIdxs.length === 0) return items.slice();

  // Only the most recent turn can be "live", AND only while the
  // engine is actively streaming. Once turn_complete fires the
  // ticker should stop and the card becomes a normal closed group.
  const lastTurnStart = userIdxs[userIdxs.length - 1]!;

  const out: StreamItem[] = [];
  for (let k = 0; k < userIdxs.length; k++) {
    const start = userIdxs[k]!;
    const end = k + 1 < userIdxs.length ? userIdxs[k + 1]! : items.length;
    const isLive = liveTurnActive && start === lastTurnStart;

    // Find first/last toolish index within [start, end).
    let firstTool = -1;
    let lastTool = -1;
    for (let i = start; i < end; i++) {
      if (isToolish(items[i]!)) {
        if (firstTool < 0) firstTool = i;
        lastTool = i;
      }
    }

    if (firstTool < 0) {
      // No tools in this turn yet → emit everything inline (live turn
      // before any tool fires; or a turn that's purely conversational).
      for (let i = start; i < end; i++) out.push(items[i]!);
      continue;
    }

    // 1) Pre-tool prologue: items[start..firstTool).
    for (let i = start; i < firstTool; i++) out.push(items[i]!);

    // 2) Process group spans [firstTool..lastTool] for closed turns.
    //    For the live turn we extend the span to `end` so the in-flight
    //    assistant chatter that follows the most recent tool stays
    //    inside the process card (the "final summary" only solidifies
    //    after the next user message starts a new turn).
    const innerEnd = isLive ? end : lastTool + 1;
    const innerItems = items.slice(firstTool, innerEnd);
    out.push({
      kind: "turn_process_group",
      id: `process-${anchorId(innerItems[0]!)}`,
      durationMs: isLive ? 0 : spanDurationMs(innerItems),
      firstToolStartedAt: firstToolStart(innerItems),
      isLive,
      toolCount: countToolsRecursive(innerItems),
      items: innerItems,
    });

    // 3) Post-tool epilogue (closed turn only): the final assistant
    //    summary stays visible outside the process card.
    if (!isLive) {
      for (let i = lastTool + 1; i < end; i++) out.push(items[i]!);
    }
  }
  return out;
}

function firstToolStart(items: Array<Message | ToolGroup>): number {
  let earliest = Infinity;
  for (const it of items) {
    if (it.kind === "tool") {
      if (it.startedAt < earliest) earliest = it.startedAt;
    } else if (it.kind === "tool_group") {
      for (const t of it.tools) {
        if (t.startedAt < earliest) earliest = t.startedAt;
      }
    }
  }
  return isFinite(earliest) ? earliest : Date.now();
}

function anchorId(item: Message | ToolGroup): string {
  return item.kind === "tool_group" ? item.id : item.id;
}

function countToolsRecursive(items: Array<Message | ToolGroup>): number {
  let n = 0;
  for (const it of items) {
    if (it.kind === "tool") n += 1;
    else if (it.kind === "tool_group") n += it.tools.length;
  }
  return n;
}

/**
 * Wall time from the first tool's startedAt to the last tool's
 * endedAt (or startedAt if still running). Returns 0 if no
 * timestamps are available.
 */
function spanDurationMs(items: Array<Message | ToolGroup>): number {
  let earliestStart = Infinity;
  let latestEnd = 0;
  const visit = (t: ToolMessage): void => {
    if (typeof t.startedAt === "number" && t.startedAt < earliestStart) {
      earliestStart = t.startedAt;
    }
    const end = t.endedAt ?? t.startedAt;
    if (typeof end === "number" && end > latestEnd) latestEnd = end;
  };
  for (const it of items) {
    if (it.kind === "tool") visit(it);
    else if (it.kind === "tool_group") for (const t of it.tools) visit(t);
  }
  if (!isFinite(earliestStart) || latestEnd <= 0) return 0;
  return Math.max(0, latestEnd - earliestStart);
}

// ── Header labels ─────────────────────────────────────────────────────

export function toolGroupLabel(count: number): string {
  return `已处理 ${count} 条命令`;
}

export function processGroupLabel(durationMs: number): string {
  const totalSec = Math.max(0, Math.floor(durationMs / 1000));
  if (totalSec < 60) return `已处理 ${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s === 0 ? `已处理 ${m}m` : `已处理 ${m}m ${s}s`;
}
