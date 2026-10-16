import React, { memo, useState, useEffect, useId } from "react";
import { ChevronRight, ChevronDown, LoaderCircle } from "lucide-react";
import { ToolCard } from "../tool-cards";
import { ToolGroupCard } from "./ToolGroupCard";
import { ThinkingMessageView } from "./ThinkingMessageView";
import { AgentMessageView } from "./AgentMessageView";
import { ContextBoundaryView } from "./ContextBoundaryView";
import { GoalProgressView } from "./GoalProgressView";
import { StreamingMarkdown } from "./StreamingMarkdown";
import { processGroupDuration, type RenderedTurnProcessGroup } from "./streamGroups";
import { AgentGroupCard } from "./AgentGroupCard";
import { isSystemReminderText } from "../contextSelection";
import { SystemReminderTask } from "./SystemReminderTask";
import type { MarkdownRootStatus } from "../Markdown";
import type { UserMessage } from "../types";
import { useT } from "../i18n/I18nProvider";
import { useAnchoredLayoutChange } from "../chat/TranscriptScrollContext";

interface Props {
  /** Rendered shape: inner items may include an AgentGroup (foldAgentGroups). */
  group: RenderedTurnProcessGroup;
  turnEpoch?: number;
  /** Session cwd, forwarded to member tool cards for attachment resolution. */
  cwd?: string | null;
  sessionId?: string | null;
  sessionMainRootId?: string | null;
  rootStatus?: MarkdownRootStatus;
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
 * A turn's activity disclosure, from just after
 * the user message through its last tool call (lead-in + mid-run
 * narration ride inside). Consumed user follow-ups separate those activity
 * surfaces; the initial user bubble and final summary are rendered by the caller.
 *
 * A newly mounted live turn opens; history starts closed. Completion freezes
 * its clock while retaining the current disclosure and reading position.
 */
function TurnProcessGroupCardImpl({
  group,
  turnEpoch,
  cwd,
  sessionId,
  sessionMainRootId,
  rootStatus,
}: Props) {
  const [open, setOpen] = useState(group.isLive);
  const detailsId = useId();
  const { t } = useT();
  const anchoredChange = useAnchoredLayoutChange();

  // Live turn: tick every 1s from the
  // run start, including model work before the first tool. Closed turn uses
  // the frozen backend duration, with source timestamp fallback for old history.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!group.isLive) return;
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [group.isLive, group.startedAt, group.firstToolStartedAt]);
  const startedAt =
    group.startedAt ?? (group.firstToolStartedAt > 0 ? group.firstToolStartedAt : undefined);
  const elapsedMs = group.isLive
    ? startedAt === undefined
      ? undefined
      : Math.max(0, nowMs - startedAt)
    : group.durationMs;
  const duration = processGroupDuration(elapsedMs);
  const label = t(group.isLive ? "msg.process.processRunning" : "msg.process.processCompleted");

  // An interrupted turn never collapses behind the activity disclosure — its
  // produced content shows flat. The elapsed time + "你在 Ns 后停止了" marker is
  // rendered separately by TurnEndMessageView (the turn_end sibling outside this
  // group), so we deliberately drop the header here to avoid a duplicate marker.
  const showHeader = !group.stopped;
  const itemsVisible = group.stopped || open;
  // Keep the engine's single turn intact while presenting user requests between
  // activity surfaces. Reserve pending requests' boundaries so confirmation does
  // not remount later tools or lose their disclosure/focus. Their bubbles still
  // belong to the queue until consumed.
  type Part =
    | { kind: "activity"; id: string; items: RenderedTurnProcessGroup["items"] }
    | { kind: "user"; message: UserMessage };
  let activity: Extract<Part, { kind: "activity" }> = {
    kind: "activity",
    id: "leading",
    items: [],
  };
  const parts: Part[] = [activity];
  for (const item of dedupeById(group.items)) {
    if (item.kind === "user" && item.text !== "" && !isSystemReminderText(item.text)) {
      parts.push({ kind: "user", message: item });
      activity = { kind: "activity", id: `after:${item.id}`, items: [] };
      parts.push(activity);
    } else {
      activity.items.push(item);
    }
  }
  const toolNames = group.items.flatMap((item) => {
    if (item.kind === "tool") return [item.toolName];
    if (item.kind === "tool_group") {
      return item.items.flatMap((member) => (member.kind === "tool" ? [member.toolName] : []));
    }
    return [];
  });

  const renderActivity = (m: RenderedTurnProcessGroup["items"][number]) => {
    if (m.kind === "tool_group") {
      return (
        <ToolGroupCard
          key={m.id}
          group={m}
          turnEpoch={turnEpoch}
          cwd={cwd}
          sessionId={sessionId}
          sessionMainRootId={sessionMainRootId}
          rootStatus={rootStatus}
          defaultOpen
        />
      );
    }
    if (m.kind === "tool") {
      return (
        <ToolCard
          key={m.id}
          message={m}
          turnEpoch={turnEpoch}
          cwd={cwd}
          sessionId={sessionId}
          sessionMainRootId={sessionMainRootId}
          rootStatus={rootStatus}
        />
      );
    }
    if (m.kind === "assistant") {
      // Empty assistant = nothing to draw (only text renders here).
      // Replay makes tool-only turns done:true text:"" — suppress
      // those too, not just streaming empties. See AssistantMessageView.
      if (m.text === "") return null;
      return (
        <div key={m.id} className="cs-process-narration">
          {/* Inline assistant text belongs to the MAIN agent of this
            turn — same session, same cwd the card already holds — so
            forward it (matches AssistantMessageView). Relative image
            paths / path links now resolve here too (stage 0b). */}
          <StreamingMarkdown
            text={m.text}
            done={m.done}
            cwd={cwd ?? null}
            sessionId={sessionId}
            sessionMainRootId={sessionMainRootId}
            rootStatus={rootStatus}
          />
        </div>
      );
    }
    if (m.kind === "user") {
      return isSystemReminderText(m.text) ? <SystemReminderTask key={m.id} text={m.text} /> : null;
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
  };
  const activityNodes = parts.map((part) =>
    part.kind === "activity" && itemsVisible ? part.items.map(renderActivity).filter(Boolean) : [],
  );
  const controlledIds = parts
    .flatMap((part, index) =>
      part.kind === "activity" && (index === 0 || activityNodes[index].length > 0)
        ? [`${detailsId}-${index}`]
        : [],
    )
    .join(" ");

  return (
    <div
      className="cs-process min-w-0 max-w-full px-4 py-1"
      data-message-kind="process"
      data-tool-names={toolNames.join(" ")}
    >
      {parts.map((part, index) => {
        if (part.kind === "user") {
          if (part.message.pending || (!itemsVisible && !part.message.steerId)) return null;
          return (
            <div
              key={`user:${part.message.id}`}
              className="cs-process-user"
              data-steer-message={part.message.id}
            >
              <div className="min-w-0 max-w-[80%] rounded-xl border border-border bg-muted/40 px-3 py-2 text-sm">
                <div className="whitespace-pre-wrap break-words">{part.message.text}</div>
              </div>
            </div>
          );
        }
        const nodes = activityNodes[index];
        const header = index === 0 && showHeader;
        if (!header && nodes.length === 0) return null;
        return (
          <div key={part.id} className="cs-process-surface">
            {header && (
              <button
                type="button"
                className="cs-process-heading"
                onClick={(event) => anchoredChange(event.currentTarget, () => setOpen((v) => !v))}
                aria-expanded={open}
                aria-controls={controlledIds}
              >
                <span className="cs-process-label">
                  {group.isLive && (
                    <LoaderCircle
                      size={13}
                      className="animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  )}
                  {label}
                </span>
                {duration && (
                  <span
                    className="cs-process-duration"
                    aria-label={t("msg.process.processDurationAccessible", { time: duration })}
                  >
                    {duration}
                  </span>
                )}
                {open ? (
                  <ChevronDown className="cs-process-chevron" size={13} aria-hidden="true" />
                ) : (
                  <ChevronRight className="cs-process-chevron" size={13} aria-hidden="true" />
                )}
              </button>
            )}
            <div
              id={`${detailsId}-${index}`}
              className="cs-process-content"
              hidden={nodes.length === 0}
            >
              {nodes}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export const TurnProcessGroupCard = memo(TurnProcessGroupCardImpl);
