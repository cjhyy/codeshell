import React, { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { TaskListMessage } from "../types";

/**
 * Compact task list rendered above the composer.
 *
 * Default state: collapsed to a one-line summary plus the active
 * task — long lists won't dominate the composer area.
 *
 * Expanded: every task, scrollable if very long.
 */
export function TaskListMessageView({ message }: { message: TaskListMessage }) {
  const [expanded, setExpanded] = useState(false);

  if (message.tasks.length === 0) return null;

  const tasks = message.tasks;
  const done = tasks.filter((t) => t.status === "completed").length;
  const inProgress = tasks.find((t) => t.status === "in_progress");
  const total = tasks.length;

  return (
    <div className="msg-row msg-tasks">
      <div className="msg-tasks-card">
        <button
          className="msg-tasks-head"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span className="msg-tasks-title">Tasks</span>
          <span className="msg-tasks-count">{done}/{total}</span>
          {!expanded && inProgress && (
            <span className="msg-tasks-current">
              <span className="msg-task-marker status-running">◐</span>
              <span className="msg-tasks-current-text">
                {inProgress.activeForm ?? inProgress.subject}
              </span>
            </span>
          )}
        </button>

        {expanded && (
          <ul className="msg-tasks-list">
            {tasks.map((t) => (
              <li key={t.id} className={`msg-task msg-task-${t.status}`}>
                <span className="msg-task-marker">{markerFor(t.status)}</span>
                <span className="msg-task-text">
                  {t.status === "in_progress" && t.activeForm ? t.activeForm : t.subject}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function markerFor(s: string): string {
  switch (s) {
    case "completed": return "✓";
    case "in_progress": return "◐";
    case "stopped": return "■";
    default: return "○";
  }
}
