import React, { useState, memo } from "react";
import type { AgentMessage } from "../types";
import { StatusDot } from "../ui/StatusDot";
import { ToolCard } from "../tool-cards";
import { Markdown } from "../Markdown";

function AgentMessageViewImpl({ message }: { message: AgentMessage }) {
  const [expanded, setExpanded] = useState(false);
  const status = message.error ? "err" : message.done ? "ok" : "running";
  const hasBody = message.toolCalls.length > 0 || !!message.text || !!message.error;

  return (
    <div className="px-4 py-1">
      <div className="rounded-lg border border-border">
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm disabled:cursor-default"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls={`agent-body-${message.id}`}
          disabled={!hasBody}
        >
          <StatusDot status={status} />
          <span className="font-medium">{message.name ?? "agent"}</span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{message.description}</span>
          {message.toolCount > 0 && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {message.toolCount} tools
            </span>
          )}
          {hasBody && (
            <span className="shrink-0 text-muted-foreground">{expanded ? "▾" : "▸"}</span>
          )}
        </button>
        {expanded && (
          <div id={`agent-body-${message.id}`} className="flex flex-col gap-2 border-t border-border p-3">
            {message.toolCalls.map((t) => (
              <ToolCard key={t.id} message={t} />
            ))}
            {message.text && (
              <div className="text-sm">
                <Markdown text={message.text} />
              </div>
            )}
            {message.error && <div className="text-sm text-status-err">{message.error}</div>}
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
