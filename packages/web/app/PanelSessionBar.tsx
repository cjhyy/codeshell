import React from "react";
import type { SessionSummary } from "./protocol.js";

export function PanelSessionBar({
  sessionId,
  title,
  sessions,
  disabled,
  pending,
  error,
  canSelect,
  onSelect,
  onNew,
  onOpen,
}: {
  sessionId?: string;
  title: string;
  sessions: SessionSummary[];
  disabled: boolean;
  pending: string;
  error: string;
  canSelect: boolean;
  onSelect: (id: string) => void;
  onNew?: () => void;
  onOpen?: () => void;
}) {
  return (
    <div className="panel-session-context">
      <div className="panel-session-controls">
        <label className="panel-session-choice">
          <span>关联对话</span>
          <select
            aria-label="关联对话"
            title={title}
            value={sessionId ?? ""}
            disabled={disabled || !canSelect}
            onChange={(event) => onSelect(event.target.value)}
          >
            <option value="">未关联对话</option>
            {sessionId && !sessions.some((item) => item.sessionId === sessionId) ? (
              <option value={sessionId}>{title}</option>
            ) : null}
            {sessions.map((item) => (
              <option key={item.sessionId} value={item.sessionId}>
                {item.customTitle || item.title || item.preview || item.sessionId.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        <div className="panel-session-actions">
          {onNew ? (
            <button type="button" disabled={disabled} onClick={onNew}>
              新建对话
            </button>
          ) : null}
          {onOpen ? (
            <button type="button" disabled={disabled} onClick={onOpen}>
              {sessionId ? "打开对话" : "前往对话"}
            </button>
          ) : null}
        </div>
      </div>
      {pending ? <p role="status">{pending}</p> : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
