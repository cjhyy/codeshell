import React, { useState, memo } from "react";
import type { AgentMessage } from "../types";
import { StatusDot } from "../ui/StatusDot";
import { Markdown, streamingMarkdownClassName } from "../Markdown";
import { summarizeAgentActivity, describeActivity } from "../topbar/liveActivity";
import { useT } from "../i18n/I18nProvider";

function AgentMessageViewImpl({ message }: { message: AgentMessage }) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);
  const status = message.error ? "err" : message.done ? "ok" : "running";

  // Running in the background (detached past the auto-bg threshold) — surfaced
  // explicitly so the gap after the parent turn ends no longer looks idle. A
  // backgrounded agent whose heartbeat went stale (>90s = 3× the 30s ping) is
  // flagged "可能失联".
  const isBackgrounded = !!message.backgrounded && !message.done;
  const lostContact =
    isBackgrounded &&
    message.lastHeartbeat !== undefined &&
    Date.now() - message.lastHeartbeat > 90_000;

  // What the subagent is doing right now (Codex-style verb + arg), derived
  // from its own toolCalls. Shown live in the header while running — that's
  // the signal the user wants ("正在读取 schema.ts"), not a tool-card dump.
  const liveText = !message.done && message.toolCalls.length > 0
    ? describeActivity(summarizeAgentActivity(message.toolCalls))
    : null;

  // The agent's text output (streaming buffer + finalized text). This — not
  // the tool list — is what the expanded body shows.
  const bodyText = (message.text ?? "") + (message.textBuffer ?? "");
  const hasBody = bodyText.trim().length > 0 || !!message.error;

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
          <span className="font-medium">{message.name ?? t("msg.agent.fallbackName")}</span>
          {message.agentType && (
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {message.agentType}
            </span>
          )}
          {isBackgrounded && (
            <span
              className={
                "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium " +
                (lostContact
                  ? "bg-status-warn/15 text-status-warn"
                  : "bg-status-running/15 text-status-running")
              }
            >
              {lostContact ? t("msg.agent.mayBeLost") : t("msg.agent.backgrounded")}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{message.description}</span>
          {/* Right side: live activity while running, else a quiet tool count. */}
          {liveText ? (
            <span className="min-w-0 max-w-[45%] shrink truncate text-xs text-muted-foreground">
              {liveText}
            </span>
          ) : message.toolCount > 0 ? (
            <span className="shrink-0 text-xs text-muted-foreground">
              {t("msg.agent.toolCount", { count: message.toolCount })}
            </span>
          ) : null}
          {hasBody && (
            <span className="shrink-0 text-muted-foreground">{expanded ? "▾" : "▸"}</span>
          )}
        </button>
        {expanded && (
          <div id={`agent-body-${message.id}`} className="flex flex-col gap-2 border-t border-border p-3">
            {bodyText.trim().length > 0 && (
              <div className="text-sm">
                {/* While the sub-agent is still streaming, render plain text —
                    re-parsing Markdown (remark + rehype-highlight) on every
                    token was a ~150ms-per-frame commit that froze the UI
                    (perf: subagent-stream-markdown-reparse). Only the settled
                    text, on done, goes through Markdown. */}
                {message.done ? (
                  <Markdown text={bodyText} />
                ) : (
                  <div className={streamingMarkdownClassName}>
                    <pre className="whitespace-pre-wrap font-sans">{bodyText}</pre>
                  </div>
                )}
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
 *
 * The card deliberately does NOT render the subagent's individual tool
 * cards — the user wants a live one-line "what it's doing now" summary in
 * the header (Codex-style) plus the agent's text output when expanded, not
 * a nested tool-card dump. This is also much cheaper to render on the 50ms
 * stream batches than re-laying-out N tool cards per flush.
 */
export const AgentMessageView = memo(AgentMessageViewImpl);
