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

  if (tasks && tasks.tasks.length > 0) {
    const done = tasks.tasks.filter((t) => t.status === "completed").length;
    const total = tasks.tasks.length;
    return (
      <div className="status-popover status-popover-tasks">
        <div className="status-popover-line status-popover-tasks-head">
          <span className="status-popover-key">Tasks</span>
          <span className="status-popover-val">
            {done}/{total}
          </span>
        </div>
        <ol className="status-popover-task-list">
          {tasks.tasks.map((t, i) => (
            <li
              key={t.id}
              className={`status-popover-task status-popover-task-${t.status}`}
            >
              <span className="status-popover-task-index">{i + 1}.</span>
              <span className="status-popover-task-marker">
                {markerFor(t.status)}
              </span>
              <span className="status-popover-task-text">
                {t.status === "in_progress" && t.activeForm
                  ? t.activeForm
                  : t.subject}
              </span>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  if (!busy) {
    return (
      <div className="status-popover">
        <div className="status-popover-line status-popover-muted">空闲</div>
      </div>
    );
  }

  const elapsedMs =
    activity.turnStartedAt > 0
      ? Math.max(0, nowMs - activity.turnStartedAt)
      : 0;
  const elapsed = activity.turnStartedAt > 0 ? formatElapsed(elapsedMs) : "—";
  const activityLabel = activity.lastToolName || "思考中";

  return (
    <div className="status-popover">
      <div className="status-popover-line">
        <span className="status-popover-key">当前</span>
        <span className="status-popover-val">
          {activityLabel}
          {activity.toolInFlight ? "…" : ""}
        </span>
      </div>
      <div className="status-popover-line">
        <span className="status-popover-key">已处理</span>
        <span className="status-popover-val">{activity.toolCount} 步</span>
      </div>
      <div className="status-popover-line">
        <span className="status-popover-key">用时</span>
        <span className="status-popover-val">{elapsed}</span>
      </div>
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
