import { useT } from "../i18n";
import type { TranslationKey } from "../i18n/dict";
import type { LabSnapshot } from "./OptimizationLabPage";

const knownStatuses = new Set([
  "draft",
  "ready",
  "authorized",
  "baselining",
  "awaiting_baseline_grading",
  "proposing",
  "screening",
  "awaiting_screening_grading",
  "final_evaluating",
  "report_ready",
  "budget_exhausted",
  "interrupted",
  "cancelled",
  "failed",
]);
export function OptimizationLabSummary({ snapshot }: { snapshot: LabSnapshot }) {
  const { t } = useT();
  const { plan, state } = snapshot;
  const summary = snapshot.datasetSummary;
  const totals = snapshot.ledger?.totals;
  const number = (value: unknown) =>
    typeof value === "number" ? value.toLocaleString() : t("optimizationLab.unknown");
  const model = (connection: any) =>
    connection
      ? `${connection.modelId} · ${connection.connectionId}`
      : t("optimizationLab.unknown");
  const cells = [
    [t("optimizationLab.skill"), plan.skill?.name],
    [t("optimizationLab.target"), model(plan.connections?.target)],
    [t("optimizationLab.optimizer"), model(plan.connections?.optimizer)],
    [t("optimizationLab.devCases"), number(summary?.dev)],
    [t("optimizationLab.holdoutCases"), number(summary?.holdout)],
    [t("optimizationLab.sourceGroups"), number(summary?.sourceGroups)],
    [
      t("optimizationLab.maxRequests"),
      number(snapshot.grant?.maxRequests ?? snapshot.estimate?.maxRequests),
    ],
    [
      t("optimizationLab.maxExecution"),
      number(snapshot.grant?.maxExecutionMs ?? snapshot.estimate?.maxExecutionMs),
    ],
    [t("optimizationLab.maxOutput"), number(plan.bounds?.trial?.maxOutputTokens)],
    [t("optimizationLab.candidates"), number(plan.bounds?.maxCandidates)],
    [
      t("optimizationLab.finalReserved"),
      number(snapshot.ledger?.finalAllocation?.requests ?? plan.finalAllocation?.requests),
    ],
    [t("optimizationLab.worstTokens"), number(snapshot.estimate?.worstCaseTokens)],
  ];
  const rows = [
    ["Tokens", totals?.reportedTokens, totals?.reservedTokens, totals?.unknownTokens],
    [
      t("optimizationLab.executionMs"),
      totals?.reportedExecutionMs,
      totals?.reservedExecutionMs,
      totals?.unknownExecutionMs,
    ],
    [
      "USD",
      totals?.reportedCostUsd,
      totals?.reservedCostUsd,
      totals?.unknownCostAttempts ? t("optimizationLab.unknown") : totals?.unknownCostUsd,
    ],
  ];
  return (
    <>
      <p data-testid="optimization-lab-state" data-status={state.status} className="text-sm">
        {t("optimizationLab.state")}:{" "}
        <strong>
          {knownStatuses.has(state.status)
            ? t(`optimizationLab.statuses.${state.status}` as TranslationKey)
            : state.status}
        </strong>
      </p>
      <dl
        data-testid="optimization-lab-plan-summary"
        className="grid grid-cols-2 gap-4 sm:grid-cols-3"
      >
        {cells.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="mt-1 break-words text-sm">{value ?? t("optimizationLab.unknown")}</dd>
          </div>
        ))}
      </dl>
      <p className="text-sm text-muted-foreground">{t("optimizationLab.externalData")}</p>
      <p className="text-sm">
        {t("optimizationLab.requestsUsed")}: {number(totals?.requests ?? 0)}
      </p>
      <table data-testid="optimization-lab-consumption" className="w-full text-left text-sm">
        <thead>
          <tr>
            <th />
            {["reported", "reserved", "unknownUsage"].map((key) => (
              <th className="px-2 py-1 font-medium" key={key}>
                {t(`optimizationLab.${key}` as TranslationKey)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, ...values]) => (
            <tr key={label}>
              <th className="py-1 font-normal">{label}</th>
              {values.map((value, index) => (
                <td className="px-2 py-1" key={index}>
                  {typeof value === "string" ? value : number(value ?? (totals ? undefined : 0))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-sm text-muted-foreground">{t("optimizationLab.unknownBounds")}</p>
      <details>
        <summary className="cursor-pointer text-sm text-muted-foreground">
          {t("optimizationLab.frozenDetails")}
        </summary>
        <p className="mt-2 break-all font-mono text-xs">
          {snapshot.id}
          <br />
          {plan.planHash}
        </p>
        <pre
          data-testid="optimization-lab-plan"
          className="mt-2 max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap"
        >
          {JSON.stringify(
            { plan, estimate: snapshot.estimate, ledger: snapshot.ledger, grant: snapshot.grant },
            null,
            2,
          )}
        </pre>
      </details>
    </>
  );
}
