import React from "react";
import type { LiveActivity } from "./liveActivity";
import type { TaskListMessage } from "../types";

interface Props {
  /** Kept for prop compatibility with TopBar; the popover no longer renders a
   *  live-activity summary (that moved inline into the message stream — see
   *  messages/LiveActivityLine). */
  activity?: LiveActivity;
  busy: boolean;
  tasks: TaskListMessage | null;
}

/**
 * Status popover anchored under the TopBar's status dot. Shows ONLY the
 * current task list (the in-flight plan emitted via TodoWrite/task_update).
 *
 * The old "current tool / step count / elapsed" summary was removed: that
 * live "what's happening right now" signal now renders inline at the bottom
 * of the message stream (LiveActivityLine), Codex-style, instead of hiding in
 * a hover popover. When there are no tasks the popover is a small
 * idle/running placeholder.
 */
export function StatusPopover({ busy, tasks }: Props) {
  const markerColor = (s: string) =>
    s === "completed" ? "text-status-ok" : s === "in_progress" ? "text-status-running" : "text-muted-foreground";

  if (tasks && tasks.tasks.length > 0) {
    const done = tasks.tasks.filter((t) => t.status === "completed").length;
    const total = tasks.tasks.length;
    return (
      <div className="w-[300px] rounded-md border bg-popover p-2.5 text-sm text-popover-foreground shadow-lg">
        <div className="mb-1.5 flex items-center justify-between border-b border-border pb-1.5">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">Tasks</span>
          <span className="font-mono text-xs text-muted-foreground">{done}/{total}</span>
        </div>
        <ol className="flex max-h-60 flex-col gap-0.5 overflow-y-auto">
          {tasks.tasks.map((t, i) => (
            <li key={t.id} className="grid grid-cols-[auto_auto_1fr] items-baseline gap-1.5 text-xs">
              <span className="min-w-[1.6em] text-right font-mono text-muted-foreground">{i + 1}.</span>
              <span className={"w-4 text-center font-mono " + markerColor(t.status)}>{markerFor(t.status)}</span>
              <span className={"truncate " + (t.status === "completed" ? "text-muted-foreground line-through" : "")}>
                {t.status === "in_progress" && t.activeForm ? t.activeForm : t.subject}
              </span>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  // No task list — a minimal placeholder. Live activity is shown inline in the
  // stream, so there's nothing tool-by-tool to surface here.
  return (
    <div className="w-[140px] rounded-md border bg-popover p-2.5 text-center text-sm text-muted-foreground shadow-lg">
      {busy ? "运行中…" : "空闲"}
    </div>
  );
}

function markerFor(status: string): string {
  switch (status) {
    case "completed":
      return "✓";
    case "in_progress":
      return "◐";
    default:
      return "○";
  }
}
