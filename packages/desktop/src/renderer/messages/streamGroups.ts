/**
 * Two-level folding for the chat stream — Codex-style.
 *
 * Level 1 — adjacent tool calls of ANY kind collapse into a single
 * "已处理 N 条命令 ⌄" card. The run ends at the first "hard" non-tool
 * message (user / assistant / agent / system / context_boundary /
 * task_list / ask_user / files_changed). Thinking messages emitted
 * between tools are absorbed into the same group so hidden reasoning
 * doesn't visually shatter a run, but assistant text stays visible as
 * a hard boundary: tools → text → tools renders as three separate
 * blocks, not one giant command group.
 *
 * Level 2 — a whole user-turn that contains any tool collapses into ONE
 * "已处理 X m Y s ⌄" process card spanning from just after the user
 * message through the turn's last tool. Lead-in text and mid-run
 * narration ride INSIDE the card (default-open); only the user bubble
 * and the final summary after the last tool stay outside it. The most
 * recent live turn extends to the turn end so the user watches progress.
 */

import type { Message, ThinkingMessage, ToolMessage } from "../types";
import type { AgentGroup } from "./agentGroup";
import { describeActivity } from "../topbar/liveActivity";
import { translate } from "../i18n/translate";
import type { UILanguage } from "../uiLanguage";

/**
 * Active UI language, read without `loadUILanguage` so the pure label helpers
 * here stay usable from the unit tests (which run outside the DOM, with no
 * `localStorage`). Defaults to Chinese when the storage isn't available.
 */
function activeLang(): UILanguage {
  try {
    const raw = globalThis.localStorage?.getItem("codeshell.uiLanguage");
    return raw === "en" ? "en" : "zh";
  } catch {
    return "zh";
  }
}

/**
 * Inner item of a level-1 tool group. Beyond the tool calls themselves
 * we absorb only "transparent" thinking output that lands between
 * tools. Assistant text is intentionally excluded: it is user-visible
 * narration and must split command groups.
 */
export type ToolGroupItem = ToolMessage | ThinkingMessage;

export interface ToolGroup {
  kind: "tool_group";
  /** Stable id derived from the first member, so React keys stay stable. */
  id: string;
  /** Inner items, in original order. Always starts and ends with a tool. */
  items: ToolGroupItem[];
}

/**
 * Level-2 fold: a contiguous "process" block spanning one tool run.
 * Assistant text is not included; it splits process groups.
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
  /** True when this turn was interrupted (a trailing turn_end reason="stopped"
   *  sits in the turn slice). A stopped turn should NOT collapse behind the
   *  "已处理 Xs ⌄" header — its produced content renders flat instead. */
  stopped?: boolean;
  /** Inner items in original order — Message | ToolGroup. The foldAgentGroups
   *  post-pass produces a widened variant (see RenderedTurnProcessGroup) that
   *  may also hold an AgentGroup; the builder/reconciler only ever emit the
   *  narrow form here. */
  items: Array<Message | ToolGroup>;
}

export type StreamItem = Message | ToolGroup | TurnProcessGroup | AgentGroup;

/**
 * A TurnProcessGroup after the foldAgentGroups post-pass: its inner items may
 * additionally contain AgentGroups. Kept separate from the canonical
 * TurnProcessGroup so the builder/reconciler (which never produce AgentGroups
 * into items) stay narrowly typed. The render layer accepts this shape.
 */
export interface RenderedTurnProcessGroup extends Omit<TurnProcessGroup, "items"> {
  items: Array<Message | ToolGroup | AgentGroup>;
}

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
 * End-of-run bookkeeping tools: they record state (e.g. an automation's
 * memory summary) AFTER the visible answer, so the model commonly emits
 * "<report text> → UpdateAutomationMemory" in one turn. If such a tool
 * counted as the turn's `lastTool`, the level-2 process card would swallow
 * the report text that precedes it (only post-lastTool text stays inline).
 * Excluding them from the `lastTool` anchor keeps the report visible outside
 * the card; the tool itself still renders (it isn't hidden).
 */
const BOOKKEEPING_TOOL_NAMES = new Set([
  "updateautomationmemory",
  "update_automation_memory",
]);

/** True when an item is a tool (or tool group) consisting ONLY of
 *  bookkeeping tools — so it shouldn't anchor the process card's tail. */
function isBookkeepingToolish(item: Message | ToolGroup): boolean {
  const isBk = (name: string) => BOOKKEEPING_TOOL_NAMES.has(name.toLowerCase());
  if (item.kind === "tool") return isBk(item.toolName);
  if (item.kind === "tool_group") {
    return (
      item.items.length > 0 &&
      item.items.every((t) => t.kind === "tool" && isBk(t.toolName))
    );
  }
  return false;
}

/**
 * "Transparent" message kinds — non-user-visible model output that can
 * appear between tool calls without ending a level-1 run. Assistant text
 * is deliberately NOT transparent; it is a hard break that should remain
 * visible between command groups.
 */
function isTransparent(m: Message): m is ThinkingMessage {
  return m.kind === "thinking";
}

/**
 * Build the display list:
 *   0. Drop task-tracker tool calls — those drive the pinned task
 *      panel, not the chat stream.
 *   1. Run level-1 folding: collapse adjacent tool messages into
 *      ToolGroup (regardless of toolName), absorbing transparent
 *      thinking items that land between two tools.
 *   2. Run level-2 folding: wrap each tool-bearing user-turn into one
 *      TurnProcessGroup spanning up to the turn's last tool.
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

/**
 * Content signature for a built group, used to decide whether a freshly-built
 * group is structurally identical to the previous render's. buildStreamItems
 * allocates brand-new ToolGroup/TurnProcessGroup objects every call, so even
 * an unchanged group arrives as a new reference and defeats the React.memo on
 * its card — forcing the whole (live-turn) subtree to re-render every 50ms
 * batch. We compare signatures and, when equal, reuse the OLD object so memo
 * sees a stable prop and skips the subtree. (perf: scroll-jank-2026-06-02)
 *
 * The signature captures everything the card renders from the group: the
 * member ids in order, plus the fields that flip its header (toolCount,
 * durationMs, isLive). Leaf ToolMessage content (args/result/status) is NOT
 * hashed here — those are owned by the memoized ToolCard, which re-renders on
 * its own message-identity change independently of the group wrapper.
 */
/**
 * Per-inner-item signature token. Usually just the id — that's stable from the
 * reducer and is all the wrapper card needs. BUT an `agent` message mutates in
 * place (its nested toolCalls / textBuffer / done / error change while its id
 * stays fixed): a subagent fires more tools, streams text, then finishes. If we
 * keyed only on its id, an unchanged signature would make reconcileStreamItems
 * reuse the PREVIOUS group object — which still holds the STALE AgentMessage —
 * and the memoized card would render a frozen subagent (stuck at "1 tools",
 * never flipping to done). So fold the agent's renderable mutable shape into
 * the token. Leaf tool content is still owned by the memoized ToolCard and need
 * not be hashed here. (fix: subagent-card-stale-during-run)
 *
 * The card also shows a live "what it's doing now" line derived from its LAST
 * toolCall, so the token additionally captures that tool's id + status + a
 * cheap args fingerprint — otherwise the line wouldn't flip from "正在读取" to
 * the next action when a tool completes or its streamed args change without the
 * toolCount changing.
 */
let liveAgentToken = 0;
function innerItemToken(it: Message | ToolGroup): string {
  if (it.kind === "tool_group") return "tg(" + it.items.map((x) => x.id).join(",") + ")";
  if (it.kind === "agent") {
    // A LIVE (not-done) agent mutates in place every 50ms flush — its tool
    // status flips, streamed args grow, the live activity line changes — in
    // ways a content hash can't fully capture cheaply. The reducer hands us a
    // fresh AgentMessage object each time anyway, so just force a unique token
    // per build: the wrapping group is never reused while the agent is live,
    // so the card always re-renders the latest. Once done/errored its content
    // is stable, so we hash the renderable shape and reuse normally (lets the
    // memo skip a settled card on later batches).
    if (!it.done && !it.error) return `a-live(${it.id}:${(liveAgentToken += 1)})`;
    return `a(${it.id}:1:${it.error ? 1 : 0}:${it.toolCount}:${(it.text ?? "").length})`;
  }
  return it.id;
}

function groupSignature(item: StreamItem): string {
  if (item.kind === "tool_group") {
    return "g:" + item.items.map((it) => it.id).join(",");
  }
  if (item.kind === "turn_process_group") {
    const inner = item.items.map(innerItemToken).join(",");
    return `p:${item.isLive ? 1 : 0}:${item.stopped ? 1 : 0}:${item.durationMs}:${item.toolCount}:${inner}`;
  }
  return item.kind + ":" + item.id;
}

/**
 * Reuse previous-render group objects whose content signature is unchanged, so
 * downstream React.memo'd cards keep a stable `group` prop. Returns a list the
 * same length/order as `next`; only changed (or new) groups get the fresh
 * object. Plain Message items pass through untouched (their identity is already
 * stable from the reducer).
 */
export function reconcileStreamItems(prev: StreamItem[], next: StreamItem[]): StreamItem[] {
  if (prev.length === 0) return next;
  const prevBySig = new Map<string, StreamItem>();
  for (const p of prev) {
    if (p.kind === "tool_group" || p.kind === "turn_process_group") {
      prevBySig.set(groupSignature(p), p);
    }
  }
  let reused = false;
  const out = next.map((n) => {
    if (n.kind !== "tool_group" && n.kind !== "turn_process_group") return n;
    const hit = prevBySig.get(groupSignature(n));
    if (hit) {
      reused = true;
      return hit;
    }
    return n;
  });
  // If nothing was reused the new array is fine as-is; return it to avoid an
  // extra allocation churn on the no-overlap path.
  return reused ? out : next;
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
  // run — a run must end on a tool, not on thinking. Those
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
 * Walk items from each `user` message forward. A turn that contains at
 * least one tool collapses into ONE TurnProcessGroup spanning from the
 * item right after the `user` message through the LAST tool of the turn.
 * That outer card holds everything in between — lead-in text, mid-run
 * narration, thinking, and the level-1 tool groups — so a turn reads as
 * a single "已处理 …" card.
 *
 * Two things stay OUTSIDE the card:
 *   - the `user` bubble itself (it anchors the turn);
 *   - the final summary text AFTER the last tool (the assistant's answer
 *     to the user, which should remain plainly visible).
 *
 * A turn with no tools (purely conversational) emits its items inline —
 * no empty "已处理 0s" card.
 *
 * The most recent turn is marked `isLive: true` while the engine is
 * streaming; for it the span extends to the end of the turn so in-flight
 * trailing text stays inside the card until the next user message lands.
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
    const isLive = liveTurnActive && start === lastTurnStart && !turnHasDoneAssistant(items, start, end);
    // A turn the user interrupted carries a trailing turn_end reason="stopped"
    // (a flat sibling after the last tool). Such a turn must render flat, not
    // behind the elapsed-time fold header.
    const stopped = turnWasStopped(items, start, end);

    // user bubble stays outside the card.
    out.push(items[start]!);

    // Find the last tool-bearing item within (start, end). Bookkeeping-only
    // toolish items (e.g. a trailing UpdateAutomationMemory) are skipped so
    // they don't anchor the card's tail and swallow the report text that
    // precedes them — that text then stays inline after the real last tool.
    let lastTool = -1;
    for (let i = start + 1; i < end; i++) {
      if (isToolish(items[i]!) && !isBookkeepingToolish(items[i]!)) lastTool = i;
    }

    if (lastTool < 0) {
      // No tools in this turn → render everything inline (live turn
      // before any tool fires, or a purely conversational turn).
      for (let i = start + 1; i < end; i++) out.push(items[i]!);
      continue;
    }

    // Card spans [start+1 .. lastTool] for closed turns. For the live
    // turn we extend to `end` so in-flight trailing chatter stays inside
    // the card until the next user message solidifies the summary.
    const innerEnd = isLive ? end : lastTool + 1;
    const innerItems = items.slice(start + 1, innerEnd);
    // Closed-turn duration is the WHOLE turn's wall time, not just the tool
    // span: a turn whose tools each return instantly (a 0ms Skill, fast local
    // reads) still spent real time in the model. Prefer the user→assistant
    // stamp span over the slice [start..end) (which includes the trailing
    // summary that lives outside innerItems), and never report less than the
    // actual tool span. Replayed transcripts carry no stamps → tool span only.
    out.push({
      kind: "turn_process_group",
      id: `process-${anchorId(innerItems[0]!)}`,
      durationMs: isLive
        ? 0
        : turnSpanMs(items.slice(start, end)) || spanDurationMs(innerItems),
      firstToolStartedAt: firstToolStart(innerItems),
      isLive,
      toolCount: countToolsRecursive(innerItems),
      stopped,
      items: innerItems,
    });

    // Closed turn: the final summary after the last tool stays inline.
    if (!isLive) {
      for (let i = lastTool + 1; i < end; i++) out.push(items[i]!);
    }
  }
  return out;
}

function turnHasDoneAssistant(
  items: Array<Message | ToolGroup>,
  start: number,
  end: number,
): boolean {
  for (let i = start + 1; i < end; i++) {
    const item = items[i]!;
    if (item.kind === "assistant" && item.done) return true;
  }
  return false;
}

/** True when the turn slice [start+1, end) contains a turn_end reason="stopped"
 *  — i.e. the user interrupted this turn. */
function turnWasStopped(
  items: Array<Message | ToolGroup>,
  start: number,
  end: number,
): boolean {
  for (let i = start + 1; i < end; i++) {
    const item = items[i]!;
    if (item.kind === "turn_end" && item.reason === "stopped") return true;
  }
  return false;
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

/**
 * Whole-turn wall time as a single span: from the turn's earliest start (user
 * `createdAt`, assistant `createdAt`, or any tool `startedAt`) to its latest end
 * (assistant `doneAt` or any tool `endedAt`). `turnItems` is the full turn slice
 * [user .. next user), so it includes the trailing summary assistant that the
 * process card renders outside itself — that's the message carrying `doneAt`.
 *
 * Folding tool timestamps into the SAME span (rather than maxing two
 * independently-anchored spans) means a tool that outruns the recorded `doneAt`
 * still widens the end without resetting the start. Returns 0 only when NO
 * turn-level stamp exists (replayed/historical transcripts), letting the caller
 * fall back to the pure tool span instead of inventing a duration.
 */
function turnSpanMs(turnItems: Array<Message | ToolGroup>): number {
  let earliest = Infinity;
  let latest = 0;
  let sawStamp = false;
  const note = (start?: number, end?: number): void => {
    if (typeof start === "number") {
      if (start < earliest) earliest = start;
      sawStamp = true;
    }
    if (typeof end === "number" && end > latest) latest = end;
  };
  for (const it of turnItems) {
    if (it.kind === "user") note(it.createdAt);
    else if (it.kind === "assistant") note(it.createdAt, it.doneAt);
    else if (it.kind === "tool") note(it.startedAt, it.endedAt ?? it.startedAt);
    else if (it.kind === "tool_group") {
      for (const inner of it.items) {
        if (inner.kind === "tool") note(inner.startedAt, inner.endedAt ?? inner.startedAt);
      }
    }
  }
  // Require a turn-level stamp (user/assistant) to claim a turn span; a span
  // built only from tools is exactly what spanDurationMs already provides, so
  // returning 0 here routes those to the tool-span fallback unchanged.
  if (!sawStamp || !isFinite(earliest) || latest <= 0) return 0;
  return Math.max(0, latest - earliest);
}

// ── Header labels ─────────────────────────────────────────────────────

export function toolGroupLabel(count: number): string {
  return translate(activeLang(), "msg.process.toolGroupCommands", { count });
}

function latestToolInToolGroup(group: ToolGroup): ToolMessage | null {
  for (let i = group.items.length - 1; i >= 0; i--) {
    const item = group.items[i]!;
    if (item.kind === "tool") return item;
  }
  return null;
}

function latestToolInProcessGroup(group: TurnProcessGroup): ToolMessage | null {
  let latest: ToolMessage | null = null;
  forEachTool(group.items, (tool) => {
    latest = tool;
  });
  return latest;
}

export function toolGroupActivityLabel(group: ToolGroup): string {
  const tool = latestToolInToolGroup(group);
  return describeActivity({
    lastToolName: tool?.toolName ?? "",
    lastTool: tool,
    toolCount: toolGroupToolCount(group),
    turnStartedAt: tool?.startedAt ?? 0,
    toolInFlight: tool?.status === "running",
  });
}

export function processGroupActivityLabel(group: TurnProcessGroup): string {
  const tool = latestToolInProcessGroup(group);
  return describeActivity({
    lastToolName: tool?.toolName ?? "",
    lastTool: tool,
    toolCount: group.toolCount,
    turnStartedAt: group.firstToolStartedAt,
    toolInFlight: tool?.status === "running",
  });
}

export function processGroupLabel(durationMs: number): string {
  const lang = activeLang();
  const totalSec = Math.max(0, Math.floor(durationMs / 1000));
  if (totalSec < 60) return translate(lang, "msg.process.elapsedSec", { sec: totalSec });
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s === 0
    ? translate(lang, "msg.process.elapsedMin", { min: m })
    : translate(lang, "msg.process.elapsedMinSec", { min: m, sec: s });
}

/** Count tool calls inside a level-1 group (excludes transparent items). */
export function toolGroupToolCount(group: ToolGroup): number {
  let n = 0;
  for (const it of group.items) if (it.kind === "tool") n += 1;
  return n;
}
