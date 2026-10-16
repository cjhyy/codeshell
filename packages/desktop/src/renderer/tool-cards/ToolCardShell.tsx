import React from "react";
import type { ToolMessage } from "../types";
import { ChevronRight, ChevronDown } from "../ui/icons";
import { StatusDot, type Status } from "../ui/StatusDot";
import { formatDuration } from "./utils";
import { useAnchoredLayoutChange } from "../chat/TranscriptScrollContext";

interface Props {
  message: ToolMessage;
  /** One-line summary shown on the head row. */
  summary: React.ReactNode;
  /** Optional rich detail when the card is expanded inline. */
  details?: React.ReactNode;
  /** Important result preview that remains visible while details are collapsed. */
  preview?: React.ReactNode;
  /** Optional chip rendered on the head row (e.g. sandbox status). */
  headerBadge?: React.ReactNode;
  /** Optional interactive action beside the toggle button. */
  headerAction?: React.ReactNode;
  onSelect?: (m: ToolMessage) => void;
  selected?: boolean;
  /**
   * Monotonic per-turn counter. A card that ran during this epoch folds
   * at its end; manually opened historical cards keep their state.
   */
  turnEpoch?: number;
}

export function ToolCardShell({
  message,
  summary,
  details,
  preview,
  headerBadge,
  headerAction,
  onSelect,
  selected,
  turnEpoch,
}: Props) {
  const [open, setOpen] = React.useState(false);
  const anchoredChange = useAnchoredLayoutChange();
  const detailsId = React.useId();
  const hasDetails = Boolean(details || message.summary);
  const previousEpochRef = React.useRef(turnEpoch);
  const ranInEpochRef = React.useRef(false);
  const running = message.status === "running";
  React.useEffect(() => {
    if (turnEpoch !== undefined && previousEpochRef.current !== turnEpoch) {
      if (ranInEpochRef.current) setOpen(false);
      ranInEpochRef.current = false;
    }
    // Tool results usually arrive before turn completion. Keep this flag until
    // the epoch changes rather than checking only the latest terminal status.
    if (running) ranInEpochRef.current = true;
    previousEpochRef.current = turnEpoch;
  }, [running, turnEpoch]);
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
      data-tool-card=""
      className={
        "min-w-0 rounded-md border text-xs [overflow-wrap:anywhere] " +
        (selected
          ? "border-primary/40 bg-accent/40"
          : open
            ? "border-border/50 bg-card"
            : "border-transparent bg-card hover:border-border/40")
      }
      onClick={() => onSelect?.(message)}
    >
      <div className="flex min-w-0 items-center">
        <button
          type="button"
          data-tool-heading=""
          className="flex min-h-8 min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1 rounded-md px-2 py-1.5 text-left leading-5 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&>svg]:shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            if (hasDetails) anchoredChange(e.currentTarget, () => setOpen((o) => !o));
          }}
          aria-expanded={hasDetails ? open : undefined}
          aria-controls={hasDetails ? detailsId : undefined}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <StatusDot status={status} title={message.status} />
          <span className="flex min-w-0 flex-[1_1_5rem] items-center gap-2">
            <span className="max-w-[42%] shrink-0 truncate font-medium" title={message.toolName}>
              {message.toolName}
            </span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground [&_code]:text-muted-foreground">
              {summary}
            </span>
          </span>
          <span className="ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-1.5 text-[10px] leading-4">
            {headerBadge}
            {duration && (
              <span className="shrink-0 tabular-nums text-muted-foreground">{duration}</span>
            )}
            {message.status === "failed" && (
              <span className="shrink-0 rounded bg-status-err/10 px-1 text-status-err">error</span>
            )}
          </span>
        </button>
        {headerAction && <div className="shrink-0 pr-1">{headerAction}</div>}
      </div>
      {preview && <div className="border-t border-border/40 px-2 py-1.5">{preview}</div>}
      {hasDetails && (
        <div id={detailsId} hidden={!open} className="border-t border-border/40 px-2 py-2">
          {open && (
            <div className="flex min-w-0 flex-col gap-2">
              {message.summary && (
                <div data-tool-result-summary="" className="text-xs text-muted-foreground">
                  {message.summary}
                </div>
              )}
              {details}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
