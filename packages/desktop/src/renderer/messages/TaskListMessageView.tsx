import React, { memo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { TaskListMessage } from "../types";

/**
 * Compact task list rendered above the composer.
 *
 * Default: a single-line header — "▸ Tasks  3/8  ◐ <current in_progress>"
 * — so a long plan doesn't dominate the composer area. Click the
 * header to expand into the full list (still capped by the pin
 * panel's max-height, so very long lists scroll instead of pushing
 * the input off-screen).
 *
 * Always-visible bits even when collapsed:
 *   - completed / total progress
 *   - the in_progress item label (so the user sees what's happening
 *     right now without expanding)
 */
function TaskListMessageViewImpl({ message }: { message: TaskListMessage }) {
  const [expanded, setExpanded] = useState(false);

  if (message.tasks.length === 0) return null;

  const tasks = message.tasks;
  const done = tasks.filter((t) => t.status === "completed").length;
  const inProgress = tasks.find((t) => t.status === "in_progress");
  const total = tasks.length;

  const markerColor = (s: string) =>
    s === "completed" ? "text-status-ok"
      : s === "in_progress" ? "text-status-running"
        : s === "stopped" ? "text-status-warn"
          : "text-muted-foreground";

  return (
    <div className="w-full rounded-lg border border-border bg-card text-sm">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-muted-foreground hover:text-foreground"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="text-xs font-semibold uppercase tracking-wide">Tasks</span>
        <span className="rounded border border-border px-1.5 text-xs tabular-nums text-muted-foreground">{done}/{total}</span>
        {!expanded && inProgress && (
          <span className="flex min-w-0 flex-1 items-center gap-1 text-foreground">
            <span className="text-status-running">◐</span>
            <span className="truncate">{inProgress.activeForm ?? inProgress.subject}</span>
          </span>
        )}
      </button>

      {expanded && (
        <ul className="px-3 pb-2">
          {tasks.map((t) => (
            <li key={t.id} className="flex items-baseline gap-2 py-0.5">
              <span className={"w-3.5 text-center " + markerColor(t.status)}>{markerFor(t.status)}</span>
              <span className={t.status === "completed" ? "text-muted-foreground line-through" : ""}>
                {t.status === "in_progress" && t.activeForm ? t.activeForm : t.subject}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export const TaskListMessageView = memo(TaskListMessageViewImpl);

function markerFor(s: string): string {
  switch (s) {
    case "completed": return "✓";
    case "in_progress": return "◐";
    case "stopped": return "■";
    default: return "○";
  }
}
