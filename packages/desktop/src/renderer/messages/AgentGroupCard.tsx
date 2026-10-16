import React, { memo, useId, useState } from "react";
import { Check, ChevronRight, Loader2, X, Users } from "lucide-react";
import type { AgentGroup } from "./agentGroup";
import { summarizeAgentGroup } from "./agentGroup";
import { AgentMessageView } from "./AgentMessageView";
import { formatDuration } from "../tool-cards/utils";
import { useT } from "../i18n/I18nProvider";

/**
 * Summary card for a fan-out of ≥2 sibling sub-agents (see agentGroup.ts).
 * Header shows the status rollup and wall-clock; expanding
 * reveals each member rendered by the existing AgentMessageView. Starts open
 * if a member is running, or closed for settled history; subsequent updates
 * preserve the user's disclosure state.
 */
function AgentGroupCardImpl({ group }: { group: AgentGroup }) {
  const { t } = useT();
  const stats = summarizeAgentGroup(group.agents);
  const anyRunning = stats.running > 0;
  const [open, setOpen] = useState(anyRunning);
  const bodyId = useId();

  const dur = stats.wallMs > 0 ? formatDuration(stats.wallMs) : "";

  return (
    <div className="cs-agent-group">
      <div className="cs-agent-group-card" data-state={anyRunning ? "running" : "settled"}>
        <button
          type="button"
          className="cs-agent-group-heading"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={bodyId}
        >
          <span className="cs-agent-group-icon" aria-hidden="true">
            <Users size={15} />
          </span>
          <span className="cs-agent-group-heading-main">
            <span className="cs-agent-group-title">
              {t("msg.agentGroup.count", { count: stats.total })}
            </span>
            <span className="cs-agent-group-meta">
              {stats.succeeded > 0 && (
                <span className="cs-agent-group-status" data-status="succeeded">
                  <Check size={12} aria-hidden="true" />
                  {t("msg.agentGroup.succeeded", { count: stats.succeeded })}
                </span>
              )}
              {stats.failed > 0 && (
                <span className="cs-agent-group-status" data-status="failed">
                  <X size={12} aria-hidden="true" />
                  {t("msg.agentGroup.failed", { count: stats.failed })}
                </span>
              )}
              {anyRunning && (
                <span className="cs-agent-group-status" data-status="running">
                  <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                  {t("msg.agentGroup.running", { count: stats.running })}
                </span>
              )}
              {!anyRunning && dur && <span className="tabular-nums">{dur}</span>}
            </span>
          </span>
          <ChevronRight
            size={14}
            className={
              "cs-agent-group-chevron shrink-0 text-muted-foreground transition-transform " +
              (open ? "rotate-90" : "")
            }
            aria-hidden="true"
          />
        </button>
        {open && (
          <div id={bodyId} className="cs-agent-group-body">
            {group.agents.map((a) => (
              <AgentMessageView key={a.id} message={a} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Memoized: a fan-out's sibling agents each mutate on their own stream events.
 * foldAgentGroups produces a fresh AgentGroup object whenever any member's
 * AgentMessage reference changes (it runs on every rebuild), so shallow compare
 * on `group` correctly re-renders when — and only when — a member updates.
 */
export const AgentGroupCard = memo(AgentGroupCardImpl);
