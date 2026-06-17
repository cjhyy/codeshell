import React, { memo, useState } from "react";
import { Check, X, Users } from "lucide-react";
import type { AgentGroup } from "./agentGroup";
import { summarizeAgentGroup } from "./agentGroup";
import { AgentMessageView } from "./AgentMessageView";
import { formatDuration } from "../tool-cards/utils";
import { useT } from "../i18n/I18nProvider";

/**
 * Summary card for a fan-out of ≥2 sibling sub-agents (see agentGroup.ts).
 * Header shows the rollup (N 个子代理 · ✓X ✗Y · tools · wall-clock); expanding
 * reveals each member rendered by the existing AgentMessageView. Defaults open
 * while any member is still running (the user is watching progress), collapsed
 * once all have settled (noise reduction).
 */
function AgentGroupCardImpl({ group }: { group: AgentGroup }) {
  const { t } = useT();
  const stats = summarizeAgentGroup(group.agents);
  const anyRunning = stats.running > 0;
  const [open, setOpen] = useState(anyRunning);

  const dur = formatDuration(stats.wallMs);

  return (
    <div className="px-4 py-1">
      <div className="rounded-lg border border-border">
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <Users size={14} className="shrink-0 text-muted-foreground" />
          <span className="font-medium">{t("msg.agentGroup.count", { count: stats.total })}</span>
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            {stats.succeeded > 0 && (
              <span className="flex items-center gap-0.5 text-status-ok">
                <Check size={12} />
                {stats.succeeded}
              </span>
            )}
            {stats.failed > 0 && (
              <span className="flex items-center gap-0.5 text-status-err">
                <X size={12} />
                {stats.failed}
              </span>
            )}
            {anyRunning && (
              <span className="text-status-running">
                {t("msg.agentGroup.running", { count: stats.running })}
              </span>
            )}
          </span>
          <span className="min-w-0 flex-1" />
          <span className="shrink-0 text-xs text-muted-foreground">
            {t("msg.agentGroup.toolCount", { count: stats.toolTotal })}
            {!anyRunning && dur ? ` · ${dur}` : ""}
          </span>
          <span className="shrink-0 text-muted-foreground">{open ? "▾" : "▸"}</span>
        </button>
        {open && (
          <div className="border-t border-border py-1">
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
