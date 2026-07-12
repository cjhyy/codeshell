import type { PetPendingDecision } from "../../preload/types";
import React from "react";
import { RiskPill } from "../approvals/RiskPill";
import { useT } from "../i18n";

export function PendingDecisionSection({
  pending,
  onOpen,
}: {
  pending: readonly PetPendingDecision[];
  onOpen?: (decision: PetPendingDecision) => void;
}) {
  const { t } = useT();
  return (
    <section aria-labelledby="pet-pending-heading" className="min-w-0">
      <h3
        id="pet-pending-heading"
        className="px-2 py-1 text-xs font-semibold text-muted-foreground"
      >
        {t("pet.pending.title")}
      </h3>
      {pending.length === 0 ? (
        <p className="px-2 py-3 text-sm text-muted-foreground">{t("pet.pending.empty")}</p>
      ) : (
        <ul>
          {pending.map((decision) => (
            <li
              key={`${decision.agentSessionId}:${decision.requestId}`}
              className="flex min-w-0 items-center gap-2 border-b border-border/60 px-2 py-2 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium" title={decision.title}>
                    {decision.title}
                  </span>
                  {decision.riskLevel && <RiskPill level={decision.riskLevel} />}
                </div>
                <span className="text-xs text-muted-foreground">
                  {decision.kind === "tool_approval"
                    ? t("pet.pending.toolApproval")
                    : t("pet.pending.askUser")}
                  {decision.toolName ? ` · ${decision.toolName}` : ""}
                </span>
              </div>
              <button
                type="button"
                className="shrink-0 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                onClick={() => onOpen?.(decision)}
              >
                {t("pet.pending.open")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
