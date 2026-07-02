import React, { memo, useState, useEffect } from "react";
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

  // Force-collapse on turn boundary, but only for already-closed groups — and
  // never for an interrupted (stopped) turn, which must keep its produced
  // content visible (it has no fold header at all; see showHeader below).
  useEffect(() => {
    if (turnEpoch !== undefined && !group.isLive && !group.stopped) setOpen(false);
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
  const elapsedMs = group.isLive
    ? Math.max(0, nowMs - group.firstToolStartedAt)
    : group.durationMs;
  const label = processGroupLabel(elapsedMs);

  // An interrupted turn never collapses behind the "已处理 Xs ⌄" header — its
  // produced content shows flat. The elapsed time + "你在 Ns 后停止了" marker is
  // rendered separately by TurnEndMessageView (the turn_end sibling outside this
  // group), so we deliberately drop the header here to avoid a duplicate marker.
  const showHeader = !group.stopped;
  const itemsVisible = group.stopped || open;

  return (
    <div className="px-4 py-1">
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
              return <ToolGroupCard key={m.id} group={m} turnEpoch={turnEpoch} cwd={cwd} defaultOpen />;
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
