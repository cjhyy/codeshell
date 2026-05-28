/**
 * Two-level folding for the chat stream — Codex-style.
 *
 * Level 1 — adjacent tool calls of ANY kind collapse into a single
 * "已处理 N 条命令 ⌄" card. The run ends at the first "hard" non-tool
 * message (user / agent / system / context_boundary / task_list /
 * ask_user / files_changed). Short "transparent" messages emitted
 * between tools — thinking and assistant_text — are absorbed into
 * the same group so model chatter doesn't visually shatter a run.
 *
 * Level 2 — within a user-turn, everything from the first tool call
 * to the last tool call (inclusive of any assistant text or level-1
 * groups in between) collapses into a "已处理 X m Y s ⌄" turn-
 * process card. Assistant text BEFORE the first tool and AFTER the
 * last tool stays visible — that's the user's question framing and
 * the assistant's final answer. The most recent (still-streaming)
 * turn skips level-2 folding so the user can watch progress live.
 */

import type {
  AssistantMessage,
  Message,
  ThinkingMessage,
  ToolMessage,
} from "../types";

/**
 * Inner item of a level-1 tool group. Beyond the tool calls themselves
 * we now absorb the "transparent" model output that lands between
 * tools — `thinking` and `assistant` text — so the visual run doesn't
 * splinter every time the model emits a one-liner between Bash calls.
 * See foldAdjacentTools() for the lookahead rule that decides what
 * counts as transparent.
 */
export type ToolGroupItem = ToolMessage | ThinkingMessage | AssistantMessage;

export interface ToolGroup {
  kind: "tool_group";
  /** Stable id derived from the first member, so React keys stay stable. */
  id: string;
  /** Inner items, in original order. Always starts and ends with a tool. */
  items: ToolGroupItem[];
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
 * "Transparent" message kinds — short model output that can appear
 * between tool calls without ending a level-1 run. Anything else
 * (user / agent / system / context_boundary / task_list / ask_user
 * / files_changed) is a hard break that forces a flush.
 */
function isTransparent(m: Message): m is ThinkingMessage | AssistantMessage {
  return m.kind === "thinking" || m.kind === "assistant";
}

/**
 * Build the display list:
 *   0. Drop task-tracker tool calls — those drive the pinned task
 *      panel, not the chat stream.
 *   1. Run level-1 folding: collapse adjacent tool messages into
 *      ToolGroup (regardless of toolName), absorbing transparent
 *      thinking/assistant items that land between two tools.
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

/**
 * Scan forward from `from` (exclusive) until we hit a tool or a hard
 * break, allowing only transparent items in between. Returns true if
 * the next non-transparent item is a tool — meaning the current run
 * can absorb [from..next_tool) as inner items.
 *
 * The lookahead only walks past transparent messages; the moment it
 * sees anything else (user, system, agent, etc.) it answers "no,
 * flush the run". This keeps the heuristic O(n) overall: each message
 * is visited at most twice (once by the outer loop, once by lookahead).
 */
function nextNonTransparentIsTool(
  messages: Message[],
  from: number,
): boolean {
  for (let j = from; j < messages.length; j++) {
    const m = messages[j]!;
    if (m.kind === "tool") return true;
    if (!isTransparent(m)) return false;
  }
  return false;
}

function foldAdjacentTools(messages: Message[]): Array<Message | ToolGroup> {
  const out: Array<Message | ToolGroup> = [];

  // Items being collected for the current run. The run always opens
  // with a tool; once it has ≥2 tools we emit a ToolGroup, otherwise
  // we splay the buffer back into `out` so a single tool stays a plain
  // ToolMessage row (matches pre-existing behavior).
  let buf: ToolGroupItem[] = [];

  const toolCountInBuf = (): number =>
    buf.reduce((n, it) => (it.kind === "tool" ? n + 1 : n), 0);

  // Drop any trailing transparent items hanging off the end of the
  // run — a run must end on a tool, not on thinking/assistant. Those
  // trailing items get pushed back to `out` so they render inline.
  const dropTrailingTransparent = (): ToolGroupItem[] => {
    const trailing: ToolGroupItem[] = [];
    while (buf.length > 0 && buf[buf.length - 1]!.kind !== "tool") {
      trailing.unshift(buf.pop()!);
    }
    return trailing;
  };

  const flushRun = (): void => {
    if (buf.length === 0) return;
    const trailing = dropTrailingTransparent();
    if (toolCountInBuf() >= 2) {
      const firstTool = buf.find((it) => it.kind === "tool") as ToolMessage;
      out.push({
        kind: "tool_group",
        id: `group-${firstTool.id}`,
        items: buf,
      });
    } else {
      // Single tool (with possibly some transparent items wedged in)
      // — splay everything back so it renders inline.
      for (const it of buf) out.push(it);
    }
    for (const it of trailing) out.push(it);
    buf = [];
  };

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.kind === "tool") {
      buf.push(m);
      continue;
    }
    if (buf.length > 0 && isTransparent(m) && nextNonTransparentIsTool(messages, i + 1)) {
      // Absorb the transparent item — another tool is coming before
      // any hard break, so this is just inline model chatter inside
      // an otherwise contiguous run.
      buf.push(m);
      continue;
    }
    flushRun();
    out.push(m);
  }
  flushRun();
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

function forEachTool(
  items: Array<Message | ToolGroup>,
  visit: (t: ToolMessage) => void,
): void {
  for (const it of items) {
    if (it.kind === "tool") visit(it);
    else if (it.kind === "tool_group") {
      for (const inner of it.items) {
        if (inner.kind === "tool") visit(inner);
      }
    }
  }
}

function firstToolStart(items: Array<Message | ToolGroup>): number {
  let earliest = Infinity;
  forEachTool(items, (t) => {
    if (t.startedAt < earliest) earliest = t.startedAt;
  });
  return isFinite(earliest) ? earliest : Date.now();
}

function anchorId(item: Message | ToolGroup): string {
  return item.kind === "tool_group" ? item.id : item.id;
}

function countToolsRecursive(items: Array<Message | ToolGroup>): number {
  let n = 0;
  forEachTool(items, () => {
    n += 1;
  });
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
  forEachTool(items, (t) => {
    if (typeof t.startedAt === "number" && t.startedAt < earliestStart) {
      earliestStart = t.startedAt;
    }
    const end = t.endedAt ?? t.startedAt;
    if (typeof end === "number" && end > latestEnd) latestEnd = end;
  });
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

/** Count tool calls inside a level-1 group (excludes transparent items). */
export function toolGroupToolCount(group: ToolGroup): number {
  let n = 0;
  for (const it of group.items) if (it.kind === "tool") n += 1;
  return n;
}
