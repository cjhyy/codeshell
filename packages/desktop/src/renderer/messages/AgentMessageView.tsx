import React, { useState, memo } from "react";
import type { AgentMessage } from "../types";
import { StatusDot } from "../ui/StatusDot";
import { StreamingMarkdown } from "./StreamingMarkdown";
import { useT } from "../i18n/I18nProvider";
import { useSubagentNavigation } from "../subagents/SubagentNavigation";
import { Bot, ChevronDown, ChevronRight, ArrowUpRight } from "lucide-react";

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

  const bodyText = (message.text ?? "") + (message.textBuffer ?? "");
  const hasText = bodyText.trim().length > 0;
  const hasBody =
    !message.done || hasText || !!message.error || !!message.description.trim() || !!navigation;
  const isExpanded = expanded && hasBody;
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
          aria-expanded={isExpanded}
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
            {!isExpanded && message.description.trim() && (
              <span className="cs-agent-description" title={message.description}>
                {message.description}
              </span>
            )}
          </span>
          {hasBody && (
            <span className="cs-agent-disclosure">
              <span>{isExpanded ? t("msg.agent.hideDetails") : t("msg.agent.showDetails")}</span>
              {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </span>
          )}
        </button>
        {isExpanded && (
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
                {/* A child can have a different workspace. Leave the parent's
                    cwd out of its path links. */}
                <StreamingMarkdown text={bodyText} done={message.done} />
              </section>
            )}
            {message.error && <div className="cs-agent-error">{message.error}</div>}
            {!message.done && !hasText && !message.error && (
              <div className="text-sm text-muted-foreground">{t("msg.agent.waitingForResult")}</div>
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
 * The card summarizes the task, status and result. Detailed activity remains
 * available through the child conversation rather than duplicating its tools.
 */
export const AgentMessageView = memo(AgentMessageViewImpl);
