import React, { useState, memo } from "react";
import type { AgentMessage, ToolMessage } from "../types";
import { StatusDot } from "../ui/StatusDot";
import { ToolCard } from "../tool-cards";
import { StreamingMarkdown } from "./StreamingMarkdown";
import { summarizeAgentActivity, describeActivity } from "../topbar/liveActivity";
import { useT } from "../i18n/I18nProvider";
import { useSubagentNavigation } from "../subagents/SubagentNavigation";
import { Bot, ChevronDown, ChevronRight, ArrowUpRight, Activity } from "lucide-react";

// Text deltas keep the tools array stable. Avoid walking the operation list on
// every token; ToolCard also memoizes individual calls when one tool changes.
const AgentToolCalls = memo(function AgentToolCalls({ tools }: { tools: ToolMessage[] }) {
  const { t } = useT();
  return (
    <section aria-label={t("msg.agent.activity")} className="cs-agent-activity">
      <div className="cs-agent-section-heading">
        <span>{t("msg.agent.activity")}</span>
        <span className="cs-agent-operation-count">
          {t("msg.agent.operationCount", { count: tools.length })}
        </span>
      </div>
      <div
        className="cs-agent-tool-list"
        role="region"
        tabIndex={0}
        aria-label={t("msg.agent.activity")}
      >
        {tools.map((tool) => (
          // A child can use a different workspace. Do not resolve its paths
          // against the parent session's cwd.
          <div key={tool.id} className="cs-agent-operation">
            <ToolCard message={tool} />
          </div>
        ))}
      </div>
    </section>
  );
});

function AgentMessageViewImpl({ message }: { message: AgentMessage }) {
  const { t } = useT();
  const navigation = useSubagentNavigation();
  const [expanded, setExpanded] = useState(false);
  const status = message.error ? "err" : message.done ? "ok" : "running";

  // Running in the background (detached past the auto-bg threshold) — surfaced
  // explicitly so the gap after the parent turn ends no longer looks idle. A
  // backgrounded agent whose heartbeat went stale (>90s = 3× the 30s ping) is
  // flagged "可能失联".
  const isBackgrounded = !!message.backgrounded && !message.done && !message.error;
  const lostContact =
    isBackgrounded &&
    message.lastHeartbeat !== undefined &&
    Date.now() - message.lastHeartbeat > 90_000;

  // Keep the current operation visible without opening the full activity.
  const liveText =
    !message.done && !message.error && message.toolCalls.length > 0
      ? describeActivity(summarizeAgentActivity(message.toolCalls))
      : null;

  const bodyText = (message.text ?? "") + (message.textBuffer ?? "");
  const hasText = bodyText.trim().length > 0;
  const hasTools = message.toolCalls.length > 0;
  const hasBody =
    hasTools || hasText || !!message.error || !!message.description.trim() || !!navigation;
  const statusText = message.error
    ? t("msg.agent.failed")
    : message.done
      ? t("msg.agent.completed")
      : lostContact
        ? t("msg.agent.mayBeLost")
        : isBackgrounded
          ? t("msg.agent.backgrounded")
          : t("msg.agent.running");

  return (
    <div className="cs-agent" data-message-kind="agent">
      <div className="cs-agent-card">
        <button
          type="button"
          className="cs-agent-heading"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls={`agent-body-${message.id}`}
          disabled={!hasBody}
        >
          <span className="cs-agent-icon" aria-hidden="true">
            <Bot size={17} />
          </span>
          <span className="cs-agent-heading-main">
            <span className="cs-agent-title-row">
              <span className="cs-agent-name" title={message.name}>
                {message.name ?? t("msg.agent.fallbackName")}
              </span>
              {message.agentType && <span className="cs-agent-type">{message.agentType}</span>}
              <span className="cs-agent-status" data-status={lostContact ? "warn" : status}>
                <StatusDot status={lostContact ? "warn" : status} />
                {statusText}
              </span>
            </span>
            {!expanded && message.description.trim() && (
              <span className="cs-agent-description" title={message.description}>
                {message.description}
              </span>
            )}
            {(liveText || message.toolCount > 0) && (
              <span className="cs-agent-meta">
                {liveText && (
                  <span className="cs-agent-live" title={liveText}>
                    <Activity size={12} aria-hidden="true" />
                    <span>{liveText}</span>
                  </span>
                )}
                {message.toolCount > 0 && (
                  <span>{t("msg.agent.toolCount", { count: message.toolCount })}</span>
                )}
              </span>
            )}
          </span>
          {hasBody && (
            <span className="cs-agent-disclosure">
              <span>{expanded ? t("msg.agent.hideDetails") : t("msg.agent.showDetails")}</span>
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </span>
          )}
        </button>
        {expanded && (
          <div id={`agent-body-${message.id}`} className="cs-agent-body">
            {(message.description.trim() || navigation) && (
              <section aria-label={t("msg.agent.task")} className="cs-agent-task">
                <div className="cs-agent-section-heading">
                  {message.description.trim() && <span>{t("msg.agent.task")}</span>}
                  {navigation && (
                    <button
                      type="button"
                      className="cs-agent-transcript"
                      onClick={() =>
                        navigation.onView({
                          agentId: message.id,
                          parentSessionId: navigation.sessionId,
                          label: message.description || message.name,
                          running: !message.done,
                        })
                      }
                    >
                      {t("msg.agent.transcript")}
                      <ArrowUpRight size={13} aria-hidden="true" />
                    </button>
                  )}
                </div>
                {message.description.trim() && (
                  <div className="cs-agent-task-text">{message.description}</div>
                )}
              </section>
            )}
            {hasText && (
              <section aria-label={t("msg.agent.output")} className="cs-agent-output">
                <div className="cs-agent-section-heading">{t("msg.agent.output")}</div>
                {/* StreamingMarkdown handles incremental rendering. As with
                    child tool cards, leave the parent's cwd out of path links. */}
                <StreamingMarkdown text={bodyText} done={message.done} />
              </section>
            )}
            {message.error && <div className="cs-agent-error">{message.error}</div>}
            {hasTools && <AgentToolCalls tools={message.toolCalls} />}
            {!message.done && !hasTools && !hasText && !message.error && (
              <div className="text-sm text-muted-foreground">
                {t("msg.agent.waitingForActivity")}
              </div>
            )}
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
