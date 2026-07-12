import React from "react";
import type { ToolMessage } from "../types";
import { ChevronRight, ChevronDown } from "../ui/icons";
import { StatusDot, type Status } from "../ui/StatusDot";
import { formatDuration } from "./utils";

interface Props {
  message: ToolMessage;
  /** One-line summary shown on the head row. */
  summary: React.ReactNode;
  /** Optional rich detail when the card is expanded inline. */
  details?: React.ReactNode;
  /** Optional chip rendered on the head row (e.g. sandbox status). */
  headerBadge?: React.ReactNode;
  /** Optional interactive action beside the toggle button. */
  headerAction?: React.ReactNode;
  onSelect?: (m: ToolMessage) => void;
  selected?: boolean;
  /**
   * Monotonic per-turn counter. When this value changes the card
   * re-collapses, even if the user had opened it during streaming —
   * Codex-style "turn ends, details fold back out of the way."
   */
  turnEpoch?: number;
}

export function ToolCardShell({
  message,
  summary,
  details,
  headerBadge,
  headerAction,
  onSelect,
  selected,
  turnEpoch,
}: Props) {
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    if (turnEpoch !== undefined) setOpen(false);
  }, [turnEpoch]);
  const status: Status =
    message.status === "running"
      ? "running"
      : message.status === "failed" || message.status === "denied"
        ? "err"
        : message.status === "succeeded"
          ? "ok"
          : message.status === "cancelled"
            ? "warn"
            : "idle";
  const duration = formatDuration(message.durationMs);
  return (
    <div
      className={
        "rounded-lg border text-sm " +
        (selected ? "border-primary/40 bg-accent/40" : "border-border")
      }
      onClick={() => onSelect?.(message)}
    >
      <div className="flex items-center">
        <button
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((o) => !o);
          }}
          aria-expanded={open}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <StatusDot status={status} title={message.status} />
          <span className="font-medium">{message.toolName}</span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{summary}</span>
          {headerBadge}
          {duration && <span className="shrink-0 text-xs text-muted-foreground">{duration}</span>}
          {message.status === "failed" && (
            <span className="shrink-0 rounded border border-status-err/40 px-1.5 text-xs text-status-err">
              error
            </span>
          )}
        </button>
        {headerAction && <div className="shrink-0 pr-3">{headerAction}</div>}
      </div>
      {open && details && <div className="border-t border-border px-3 py-2">{details}</div>}
      {message.summary && (
        <div className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
          {message.summary}
        </div>
      )}
    </div>
  );
}
