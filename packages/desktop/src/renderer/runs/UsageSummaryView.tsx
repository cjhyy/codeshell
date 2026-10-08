import React from "react";
import type { UsageSummary } from "@cjhyy/code-shell-core";
import { useT } from "../i18n/I18nProvider";

/** Estimates and missing evidence share one visible display; unknown never means free. */
export function UsageSummaryView({ summary, title }: { summary: UsageSummary; title: string }) {
  const { t } = useT();
  return (
    <section
      className="min-w-0 rounded-xl border border-border/70 bg-muted/30 p-3 text-xs"
      aria-label={title}
    >
      <h3 className="font-medium">{title}</h3>
      <p className="mt-1 tabular-nums">
        {t("auto.runs.estimatedCost", {
          amount: summary.knownEstimatedCostUsd.toFixed(6),
          unknown: summary.unknownCostRequests,
        })}
      </p>
      <p className="mt-1 text-muted-foreground">
        {t("auto.runs.usageCoverage", {
          requests: summary.requests,
          missing: summary.unknownUsageRequests,
        })}
      </p>
      {summary.partial && (
        <p role="status" className="mt-1 text-status-warn">
          {t("auto.runs.partialUsage")}
        </p>
      )}
      {summary.byModel.map((model) => (
        <p
          className="mt-1 break-all text-muted-foreground"
          key={JSON.stringify([model.provider, model.providerKind, model.model])}
        >
          {model.provider}/{model.model} · {model.requests} · ~$
          {model.knownEstimatedCostUsd.toFixed(6)} ·{" "}
          {t("auto.runs.unknownCost", { count: model.unknownCostRequests })}
        </p>
      ))}
    </section>
  );
}
