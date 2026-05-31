import React, { useEffect, useState } from "react";
import { formatElapsed, type LiveActivity } from "./liveActivity";
import type { TaskListMessage } from "../types";

interface Props {
  activity: LiveActivity;
  busy: boolean;
  tasks: TaskListMessage | null;
}

/**
 * Status popover anchored under the TopBar's status dot.
 *
 * When the agent has emitted a TaskList, we surface that as the
 * primary content — a numbered overview (1, 2, 3 …) of every task
 * with its status marker, since the in-flight plan is the most useful
 * "what's happening" signal. When there is no task list, we fall back
 * to the Codex-style current-tool / step-count / elapsed summary.
 */
export function StatusPopover({ activity, busy, tasks }: Props) {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!busy) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [busy]);

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

  if (!busy) {
    return (
      <div className="w-[180px] rounded-md border bg-popover p-2.5 text-center text-sm text-muted-foreground shadow-lg">
        空闲
      </div>
    );
  }

  const elapsedMs =
    activity.turnStartedAt > 0
      ? Math.max(0, nowMs - activity.turnStartedAt)
      : 0;
  const elapsed = activity.turnStartedAt > 0 ? formatElapsed(elapsedMs) : "—";
  const activityLabel = activity.lastToolName || "思考中";

  const row = (k: string, v: React.ReactNode) => (
    <div className="flex items-center justify-between gap-3 leading-relaxed">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{k}</span>
      <span className="max-w-[200px] truncate font-mono text-xs text-muted-foreground">{v}</span>
    </div>
  );

  return (
    <div className="w-[180px] rounded-md border bg-popover p-2.5 text-sm text-popover-foreground shadow-lg">
      {row("当前", `${activityLabel}${activity.toolInFlight ? "…" : ""}`)}
      {row("已处理", `${activity.toolCount} 步`)}
      {row("用时", elapsed)}
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
