import React, { useState, memo } from "react";
import type { AgentMessage } from "../types";
import { StatusDot } from "../ui/StatusDot";
import { ToolCard } from "../tool-cards";
import { Markdown } from "../Markdown";

function formatElapsed(startedAt: number, endedAt?: number): string {
  const ms = (endedAt ?? Date.now()) - startedAt;
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m${rem}s`;
}

function AgentMessageViewImpl({ message }: { message: AgentMessage }) {
  const [expanded, setExpanded] = useState(false);
  const status = message.error ? "err" : message.done ? "ok" : "running";
  const elapsed = formatElapsed(message.startedAt, message.endedAt);
  const hasBody = message.toolCalls.length > 0 || !!message.text || !!message.error;

  return (
    <div className="msg-row msg-agent">
      <div className={`msg-agent-card ${expanded ? "expanded" : "folded"}`}>
        <button
          type="button"
          className="msg-agent-head"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls={`agent-body-${message.id}`}
          disabled={!hasBody}
        >
          <StatusDot status={status} />
          <span className="msg-agent-name">{message.name ?? "agent"}</span>
          <span className="msg-agent-desc">{message.description}</span>
          <span className="msg-agent-meta">
            {elapsed}
            {message.toolCount > 0 && ` · ${message.toolCount} tools`}
          </span>
          {hasBody && (
            <span className="msg-agent-toggle">{expanded ? "▾" : "▸"}</span>
          )}
        </button>
        {expanded && (
          <div id={`agent-body-${message.id}`} className="msg-agent-body">
            {message.toolCalls.map((t) => (
              <ToolCard key={t.id} message={t} />
            ))}
            {message.text && (
              <div className="msg-agent-text">
                <Markdown text={message.text} />
              </div>
            )}
            {message.error && <div className="msg-agent-err">{message.error}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Memoized so subagent events that update one card don't re-render
 * sibling cards. Reducer produces a new AgentMessage object only when
 * that agent's own event arrives, so shallow comparison is correct.
 */
export const AgentMessageView = memo(AgentMessageViewImpl);
