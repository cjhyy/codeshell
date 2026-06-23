import React, { useEffect, useState } from "react";
import { useT } from "../i18n/I18nProvider";

interface Interrupted {
  id: string;
  description: string;
  updatedAt: number;
}

/**
 * C (background-agent visibility): when a session is reopened, surface any
 * sub-agent that looks INTERRUPTED — stuck `active` + stale on disk (crashed /
 * app-killed before finishing). Otherwise such a sub-agent silently vanishes on
 * reopen and the user may think a stage completed when it didn't.
 *
 * Read-only by design: no resume button. Recovery is the user re-asking the
 * orchestrator, which re-spawns the role and reads the on-disk artifacts (the
 * pipeline is file-driven). The continuation primitive (AgentSendInput) exists
 * but isn't wired here on purpose — re-spawn-reads-files is the simpler, less
 * surprising recovery and doesn't risk duplicate cards.
 */
function InterruptedSubagentsBannerImpl({
  engineSessionId,
}: {
  engineSessionId: string | null | undefined;
}) {
  const { t } = useT();
  const [items, setItems] = useState<Interrupted[]>([]);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(false);
    setItems([]);
    if (!engineSessionId) return;
    let alive = true;
    void window.codeshell
      .listInterruptedSubagents(engineSessionId)
      .then((rows) => {
        if (alive) setItems(rows);
      })
      .catch(() => {
        /* best-effort; a failed probe just shows nothing */
      });
    return () => {
      alive = false;
    };
  }, [engineSessionId]);

  if (dismissed || items.length === 0) return null;

  return (
    <div className="px-4 py-2">
      <div className="rounded-lg border border-status-warn/40 bg-status-warn/10 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-status-warn">
            {t("msg.interruptedAgents.title", { count: items.length })}
          </span>
          <button
            type="button"
            className="ml-auto shrink-0 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setDismissed(true)}
          >
            {t("msg.interruptedAgents.dismiss")}
          </button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("msg.interruptedAgents.hint")}
        </p>
        <ul className="mt-1.5 flex flex-col gap-1">
          {items.map((it) => (
            <li key={it.id} className="truncate text-xs text-foreground">
              · {it.description}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export const InterruptedSubagentsBanner = React.memo(InterruptedSubagentsBannerImpl);
