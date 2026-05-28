import React, { useState, useEffect } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { ToolCard } from "../tool-cards";
import { ToolGroupCard } from "./ToolGroupCard";
import { ThinkingMessageView } from "./ThinkingMessageView";
import { AgentMessageView } from "./AgentMessageView";
import { ContextBoundaryView } from "./ContextBoundaryView";
import { Markdown } from "../Markdown";
import { processGroupLabel, type TurnProcessGroup } from "./streamGroups";

interface Props {
  group: TurnProcessGroup;
  turnEpoch?: number;
}

/**
 * Codex-style "已处理 X m Y s ⌄" — wraps the span from the first to
 * the last tool call within a turn. Pre-tool prologue and post-tool
 * final summary live OUTSIDE this card (rendered by the caller).
 *
 * Live turn: defaults to OPEN with a 1s elapsed ticker. Closed turn:
 * defaults to CLOSED with static total wall time.
 */
export function TurnProcessGroupCard({ group, turnEpoch }: Props) {
  const [open, setOpen] = useState(group.isLive);

  // Force-collapse on turn boundary, but only for already-closed groups.
  useEffect(() => {
    if (turnEpoch !== undefined && !group.isLive) setOpen(false);
  }, [turnEpoch, group.isLive]);

  // 1s elapsed ticker while live. For closed groups, use the static
  // span the reducer baked in.
  const [nowMs, setNowMs] = useState<number>(() =>
    group.isLive ? Date.now() : 0,
  );
  useEffect(() => {
    if (!group.isLive) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [group.isLive]);

  const elapsedMs = group.isLive
    ? Math.max(0, nowMs - group.firstToolStartedAt)
    : group.durationMs;
  const label = processGroupLabel(elapsedMs);

  return (
    <div className={`turn-process-group${open ? " open" : ""}${group.isLive ? " live" : ""}`}>
      <button
        type="button"
        className="turn-process-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="turn-process-label">{label}</span>
      </button>
      {open && (
        <div className="turn-process-body">
          {group.items.map((m) => {
            if (m.kind === "tool_group") {
              return <ToolGroupCard key={m.id} group={m} turnEpoch={turnEpoch} />;
            }
            if (m.kind === "tool") {
              return <ToolCard key={m.id} message={m} turnEpoch={turnEpoch} />;
            }
            if (m.kind === "assistant") {
              if (!m.done && m.text === "") return null;
              return (
                <div
                  key={m.id}
                  className={`msg-row msg-row-assistant ${m.done ? "done" : "streaming"}`}
                >
                  {m.done ? (
                    <Markdown text={m.text} />
                  ) : (
                    <div className="md-body md-streaming">
                      <pre>{m.text}</pre>
                    </div>
                  )}
                </div>
              );
            }
            if (m.kind === "thinking") {
              return <ThinkingMessageView key={m.id} message={m} />;
            }
            if (m.kind === "agent") {
              return <AgentMessageView key={m.id} message={m} />;
            }
            if (m.kind === "context_boundary") {
              return <ContextBoundaryView key={m.id} message={m} />;
            }
            return null;
          })}
        </div>
      )}
    </div>
  );
}
