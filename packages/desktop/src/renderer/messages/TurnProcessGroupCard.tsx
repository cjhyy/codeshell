import React, { memo, useState, useEffect, useRef } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { ToolCard } from "../tool-cards";
import { ToolGroupCard } from "./ToolGroupCard";
import { ThinkingMessageView } from "./ThinkingMessageView";
import { AgentMessageView } from "./AgentMessageView";
import { ContextBoundaryView } from "./ContextBoundaryView";
import { GoalProgressView } from "./GoalProgressView";
import { StreamingMarkdown } from "./StreamingMarkdown";
import { processGroupLabel, type RenderedTurnProcessGroup } from "./streamGroups";
import { AgentGroupCard } from "./AgentGroupCard";
import { isSystemReminderText } from "../contextSelection";
import { SystemReminderTask } from "./SystemReminderTask";

interface Props {
  /** Rendered shape: inner items may include an AgentGroup (foldAgentGroups). */
  group: RenderedTurnProcessGroup;
  turnEpoch?: number;
  /** Session cwd, forwarded to member tool cards for attachment resolution. */
  cwd?: string | null;
}

/**
 * Defense-in-depth against duplicate React keys (#1/#92): the merge/fold
 * pipeline is meant to keep ids unique (see mergeTranscripts' id-dedup pass),
 * but if a duplicate id ever slips through, mapping with key={m.id} throws
 * "Encountered two children with the same key" and the card never reconciles —
 * it sticks forever (the "update memory" card stuck across 5+ hours). Drop any
 * later item whose id already appeared so the keys are guaranteed unique.
 */
function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((it) => {
    if (seen.has(it.id)) return false;
    seen.add(it.id);
    return true;
  });
}

/**
 * Codex-style "已处理 X m Y s ⌄" — wraps a whole turn from just after
 * the user message through its last tool call (lead-in + mid-run
 * narration ride inside). Only the user bubble and the post-tool final
 * summary live OUTSIDE this card (rendered by the caller).
 *
 * Live turn: defaults to OPEN with a 1s elapsed ticker. Closed turn:
 * defaults to CLOSED with static total wall time.
 */
function TurnProcessGroupCardImpl({ group, turnEpoch, cwd }: Props) {
  const [open, setOpen] = useState(group.isLive);
  const prevIsLiveRef = useRef(group.isLive);
  const prevTurnEpochRef = useRef(turnEpoch);

  // Force-collapse only the process card whose own clean turn just transitioned
  // from live to closed. Older closed groups may have been manually expanded;
  // a later turnEpoch bump (background wakeup / next turn) must not fold them
  // again. Interrupted (stopped) turns still render flat; see showHeader below.
  useEffect(() => {
    const wasLive = prevIsLiveRef.current;
    const turnEpochChanged = turnEpoch !== undefined && prevTurnEpochRef.current !== turnEpoch;
    if (wasLive && !group.isLive && turnEpochChanged && !group.stopped) setOpen(false);
    prevIsLiveRef.current = group.isLive;
    prevTurnEpochRef.current = turnEpoch;
  }, [turnEpoch, group.isLive, group.stopped]);

  // Codex-style "已处理 X m Y s" header. Live turn: tick every 1s from the
  // first tool's start so the elapsed time counts up (group.durationMs is 0
  // while a tool is still running). Closed turn: static group.durationMs.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!group.isLive) return;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [group.isLive]);
  const elapsedMs = group.isLive ? Math.max(0, nowMs - group.firstToolStartedAt) : group.durationMs;
  const label = processGroupLabel(elapsedMs);

  // An interrupted turn never collapses behind the "已处理 Xs ⌄" header — its
  // produced content shows flat. The elapsed time + "你在 Ns 后停止了" marker is
  // rendered separately by TurnEndMessageView (the turn_end sibling outside this
  // group), so we deliberately drop the header here to avoid a duplicate marker.
  const showHeader = !group.stopped;
  const itemsVisible = group.stopped || open;
  const toolNames = group.items.flatMap((item) => {
    if (item.kind === "tool") return [item.toolName];
    if (item.kind === "tool_group") {
      return item.items.flatMap((member) => (member.kind === "tool" ? [member.toolName] : []));
    }
    return [];
  });

  return (
    <div className="px-4 py-1" data-message-kind="process" data-tool-names={toolNames.join(" ")}>
      {showHeader && (
        <button
          type="button"
          className={`flex w-full items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground${
            open ? " border-b border-border pb-1" : ""
          }`}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span>{label}</span>
        </button>
      )}
      {itemsVisible && (
        <div className={showHeader ? "mt-1 flex flex-col gap-1" : "flex flex-col gap-1"}>
          {dedupeById(group.items).map((m) => {
            if (m.kind === "tool_group") {
              return (
                <ToolGroupCard key={m.id} group={m} turnEpoch={turnEpoch} cwd={cwd} defaultOpen />
              );
            }
            if (m.kind === "tool") {
              return <ToolCard key={m.id} message={m} turnEpoch={turnEpoch} cwd={cwd} />;
            }
            if (m.kind === "assistant") {
              // Empty assistant = nothing to draw (only text renders here).
              // Replay makes tool-only turns done:true text:"" — suppress
              // those too, not just streaming empties. See AssistantMessageView.
              if (m.text === "") return null;
              return (
                <div key={m.id} className="py-1 text-sm">
                  {/* Inline assistant text belongs to the MAIN agent of this
                      turn — same session, same cwd the card already holds — so
                      forward it (matches AssistantMessageView). Relative image
                      paths / path links now resolve here too (stage 0b). */}
                  <StreamingMarkdown text={m.text} done={m.done} cwd={cwd ?? null} />
                </div>
              );
            }
            if (m.kind === "user") {
              if (isSystemReminderText(m.text)) {
                return <SystemReminderTask key={m.id} text={m.text} />;
              }
              // A steer / goal-wakeup / cron续接 spliced into a still-live turn
              // lands INSIDE this group (injected user is not a turn boundary,
              // see streamGroups foldTurnProcess). It must render as a
              // right-aligned user bubble here — without this branch the
              // confirmed steer hit `return null` and visibly vanished after
              // being consumed (regression: steer bubble disappears).
              // BUT a still-pending optimistic steer is owned by the queued-input
              // panel (visible + revocable there until steer_injected flips it to
              // pending:false). Rendering it here too would double it and show it
              // as already-in-transcript before the engine consumed it. Only draw
              // the CONFIRMED bubble; the panel handles the pending one.
              if (m.pending || m.text === "") return null;
              return (
                <div key={m.id} className="flex min-w-0 max-w-full flex-col items-end py-1">
                  <div className="min-w-0 max-w-[80%] rounded-xl border border-border bg-muted/40 px-3 py-2 text-sm">
                    <div className="whitespace-pre-wrap break-words">{m.text}</div>
                  </div>
                </div>
              );
            }
            if (m.kind === "thinking") {
              return <ThinkingMessageView key={m.id} message={m} />;
            }
            if (m.kind === "agent") {
              return <AgentMessageView key={m.id} message={m} />;
            }
            if (m.kind === "agent_group") {
              return <AgentGroupCard key={m.id} group={m} />;
            }
            if (m.kind === "context_boundary") {
              return <ContextBoundaryView key={m.id} message={m} />;
            }
            if (m.kind === "goal_progress") {
              return <GoalProgressView key={m.id} message={m} />;
            }
            return null;
          })}
        </div>
      )}
    </div>
  );
}

export const TurnProcessGroupCard = memo(TurnProcessGroupCardImpl);
