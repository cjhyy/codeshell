import React from "react";
import type { TaskListMessage } from "../types";

export function TaskListMessageView({ message }: { message: TaskListMessage }) {
  if (message.tasks.length === 0) return null;
  return (
    <div className="msg-row msg-tasks">
      <div className="msg-tasks-card">
        <div className="msg-tasks-head">Tasks</div>
        <ul className="msg-tasks-list">
          {message.tasks.map((t) => (
            <li key={t.id} className={`msg-task msg-task-${t.status}`}>
              <span className="msg-task-marker">{markerFor(t.status)}</span>
              <span className="msg-task-text">
                {t.status === "in_progress" && t.activeForm ? t.activeForm : t.subject}
              </span>
            </li>
          ))}
        </ul>
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
