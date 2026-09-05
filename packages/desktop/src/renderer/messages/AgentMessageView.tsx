import React, { useState, memo } from "react";
import type { AgentMessage, ToolMessage } from "../types";
import { StatusDot } from "../ui/StatusDot";
import { ToolCard } from "../tool-cards";
import { StreamingMarkdown } from "./StreamingMarkdown";
import { summarizeAgentActivity, describeActivity } from "../topbar/liveActivity";
import { useT } from "../i18n/I18nProvider";

// Text deltas keep the tools array stable. Avoid walking the operation list on
// every token; ToolCard also memoizes individual calls when one tool changes.
const AgentToolCalls = memo(function AgentToolCalls({ tools }: { tools: ToolMessage[] }) {
  const { t } = useT();
  return (
    <section aria-label={t("msg.agent.activity")} className="flex min-w-0 flex-col gap-2">
      <div className="text-xs font-medium text-muted-foreground">
        {t("msg.agent.activity")} · {t("msg.agent.operationCount", { count: tools.length })}
      </div>
      <div className="flex max-h-[28rem] min-w-0 flex-col gap-2 overflow-auto overscroll-contain">
        {tools.map((tool) => (
          // A child can use a different workspace. Do not resolve its paths
          // against the parent session's cwd.
          <ToolCard key={tool.id} message={tool} />
        ))}
      </div>
    </section>
  );
});

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

  // Keep the current operation visible without opening the full activity.
  const liveText =
    !message.done && message.toolCalls.length > 0
      ? describeActivity(summarizeAgentActivity(message.toolCalls))
      : null;

  const bodyText = (message.text ?? "") + (message.textBuffer ?? "");
  const hasText = bodyText.trim().length > 0;
  const hasTools = message.toolCalls.length > 0;
  const hasBody = hasTools || hasText || !!message.error || !!message.description.trim();

  return (
    <div className="min-w-0 max-w-full px-4 py-1">
      <div className="min-w-0 max-w-full rounded-lg border border-border">
        <button
          type="button"
          className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-sm disabled:cursor-default"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls={`agent-body-${message.id}`}
          disabled={!hasBody}
        >
          <StatusDot status={status} />
          <span className="max-w-[35%] shrink-0 truncate font-medium" title={message.name}>
            {message.name ?? t("msg.agent.fallbackName")}
          </span>
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
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {message.description}
          </span>
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
            <span className="shrink-0 text-xs text-muted-foreground">
              {expanded ? t("msg.agent.hideDetails") : t("msg.agent.showDetails")}{" "}
              {expanded ? "▾" : "▸"}
            </span>
          )}
        </button>
        {expanded && (
          <div
            id={`agent-body-${message.id}`}
            className="flex min-w-0 flex-col gap-3 border-t border-border p-3"
          >
            {message.description.trim() && (
              <section aria-label={t("msg.agent.task")} className="min-w-0">
                <div className="mb-1 text-xs font-medium text-muted-foreground">
                  {t("msg.agent.task")}
                </div>
                <div className="whitespace-pre-wrap break-words text-sm">{message.description}</div>
              </section>
            )}
            {hasTools && <AgentToolCalls tools={message.toolCalls} />}
            {hasText && (
              <section aria-label={t("msg.agent.output")} className="min-w-0 text-sm">
                <div className="mb-1 text-xs font-medium text-muted-foreground">
                  {t("msg.agent.output")}
                </div>
                {/* StreamingMarkdown handles incremental rendering. As with
                    child tool cards, leave the parent's cwd out of path links. */}
                <StreamingMarkdown text={bodyText} done={message.done} />
              </section>
            )}
            {!message.done && !hasTools && !hasText && !message.error && (
              <div className="text-sm text-muted-foreground">
                {t("msg.agent.waitingForActivity")}
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
 * Operation details are mounted only when requested, so collapsed agents stay
 * cheap during stream batches. Expanded agents reuse the normal tool cards for
 * commands, file changes, results and errors.
 */
export const AgentMessageView = memo(AgentMessageViewImpl);
