import { canonicalJson, sha256Hex } from "./contracts/canonical-json.js";
import type { DatasetManifest } from "./contracts/dataset.js";
import type { ExperimentPlan } from "./contracts/experiment.js";
import type { Candidate } from "./candidate.js";
import type { GradingRecord } from "./grading.js";
import { overfitHints } from "./overfit-hints.js";
import type { Trial } from "./runner.js";

export function trialVerdict(
  trial: Trial,
  dataset: DatasetManifest,
  grades: GradingRecord[],
): boolean | null {
  if (trial.status !== "completed") return null;
  if (trial.assertions.some((item) => !item.passed)) return false;
  const item = dataset.cases.find((item) => item.id === trial.caseId);
  if (!item) return null;
  if (item.rubric.length)
    return grades.find((grade) => grade.trialId === trial.trialId)?.semanticPassed ?? null;
  return trial.assertions.length ? true : null;
}

function usageOf(trials: Trial[]) {
  const observations = trials.flatMap((trial) => trial.observations);
  return {
    httpRequests: observations.length,
    reportedRequests: observations.filter((item) => item.outcome === "settled").length,
    unknownRequests: observations.filter((item) => item.outcome === "unknown").length,
    inputTokens: observations.reduce((sum, item) => sum + (item.usage?.inputTokens ?? 0), 0),
    outputTokens: observations.reduce((sum, item) => sum + (item.usage?.outputTokens ?? 0), 0),
    cacheReadTokens: observations.every(
      (item) => item.usage?.cacheReadTokens !== null && item.usage,
    )
      ? observations.reduce((sum, item) => sum + item.usage!.cacheReadTokens!, 0)
      : null,
    reasoningTokens: observations.every(
      (item) => item.usage?.reasoningTokens !== null && item.usage,
    )
      ? observations.reduce((sum, item) => sum + item.usage!.reasoningTokens!, 0)
      : null,
    reportedCostUsd:
      observations.length &&
      observations.every((item) => item.usage?.reportedCostUsd !== null && item.usage)
        ? observations.reduce((sum, item) => sum + item.usage!.reportedCostUsd!, 0)
        : null,
    executionMs: trials.reduce((sum, trial) => sum + trial.elapsedMs, 0),
  };
}

function pairedVerdict(
  trials: Trial[],
  dataset: DatasetManifest,
  grades: GradingRecord[],
  expectedRepeats: number,
): boolean | null {
  if (trials.length !== expectedRepeats) return null;
  const values = trials.map((trial) => trialVerdict(trial, dataset, grades));
  return values.some((value) => value === null) ? null : values.every((value) => value === true);
}

export function buildReport(options: {
  plan: ExperimentPlan;
  dataset: DatasetManifest;
  trials: Trial[];
  grades: GradingRecord[];
  candidates: Candidate[];
  selectedBodyHash: string | null;
  status: string;
  ledger: unknown;
  optimization?: unknown;
  feedbackHashes?: string[];
}) {
  const { plan, dataset, grades } = options;
  const selected =
    options.candidates.find((item) => item.bodyHash === options.selectedBodyHash) ?? null;
  const sortedTrials = [...options.trials].sort((a, b) =>
    a.trialId < b.trialId ? -1 : a.trialId > b.trialId ? 1 : 0,
  );
  const pairs = dataset.cases
    .filter((item) => item.split === "holdout")
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((item) => {
      const originals = sortedTrials.filter(
        (trial) =>
          trial.phase === "holdout" &&
          trial.caseId === item.id &&
          trial.bodyHash === plan.skill.bodyHash,
      );
      const candidates = sortedTrials.filter(
        (trial) =>
          trial.phase === "holdout" &&
          trial.caseId === item.id &&
          trial.bodyHash === selected?.bodyHash,
      );
      const original = pairedVerdict(originals, dataset, grades, plan.bounds.repeats);
      const candidate = pairedVerdict(candidates, dataset, grades, plan.bounds.repeats);
      const change =
        original === null || candidate === null
          ? "unknown"
          : original === candidate
            ? "unchanged"
            : candidate
              ? "improved"
              : "regressed";
      const baselineUsage = usageOf(originals);
      const candidateUsage = usageOf(candidates);
      const costComparable =
        original !== null &&
        candidate !== null &&
        baselineUsage.unknownRequests === 0 &&
        candidateUsage.unknownRequests === 0 &&
        baselineUsage.cacheReadTokens !== null &&
        candidateUsage.cacheReadTokens !== null &&
        baselineUsage.cacheReadTokens === candidateUsage.cacheReadTokens &&
        baselineUsage.reportedCostUsd !== null &&
        candidateUsage.reportedCostUsd !== null;
      return {
        caseId: item.id,
        sourceGroupId: item.sourceGroupId,
        caseRole: item.caseRole,
        readiness: item.readiness,
        original,
        candidate,
        change,
        baselineUsage,
        candidateUsage,
        costComparable,
        originalTrialIds: originals.map((trial) => trial.trialId),
        candidateTrialIds: candidates.map((trial) => trial.trialId),
      };
    });
  const count = (change: string) => pairs.filter((item) => item.change === change).length;
  const sourceGroups = new Set(
    pairs
      .filter((pair) => pair.original !== null && pair.candidate !== null)
      .map((pair) => pair.sourceGroupId),
  ).size;
  const plannedRunnable = pairs.filter((pair) => pair.readiness === "runnable");
  const complete =
    selected !== null &&
    plannedRunnable.length > 0 &&
    plannedRunnable.every((pair) => pair.original !== null && pair.candidate !== null);
  const sufficient =
    sourceGroups >= plan.acceptance.minHoldoutSourceGroups &&
    plannedRunnable.length >= plan.acceptance.minPairedCases;
  const regressionCases = pairs.filter((pair) =>
    plan.acceptance.regressionCaseIds.includes(pair.caseId),
  );
  const regression =
    count("regressed") > 0 || regressionCases.some((pair) => pair.candidate === false);
  const criticalFailure = sortedTrials.some(
    (trial) =>
      trial.phase === "holdout" &&
      trial.bodyHash === selected?.bodyHash &&
      trial.assertions.some(
        (assertion) =>
          !assertion.passed &&
          plan.acceptance.criticalHardAssertionIds.includes(`${trial.caseId}/${assertion.id}`),
      ),
  );
  const costComparable = complete && plannedRunnable.every((pair) => pair.costComparable);
  const baselineCost = plannedRunnable.reduce(
    (sum, pair) => sum + (pair.baselineUsage.reportedCostUsd ?? 0),
    0,
  );
  const candidateCost = plannedRunnable.reduce(
    (sum, pair) => sum + (pair.candidateUsage.reportedCostUsd ?? 0),
    0,
  );
  const costReductionRatio =
    costComparable && baselineCost > 0 ? 1 - candidateCost / baselineCost : null;
  let conclusion: "improved" | "no_improvement" | "regressed" | "inconclusive" = "inconclusive";
  if (regression || criticalFailure) conclusion = "regressed";
  else if (complete && sufficient && options.status === "report_ready") {
    if (plan.objective.kind === "quality")
      conclusion = count("improved") >= plan.acceptance.minFixes ? "improved" : "no_improvement";
    else if (costReductionRatio !== null)
      conclusion =
        costReductionRatio >= plan.acceptance.minCostReductionRatio ? "improved" : "no_improvement";
  }
  const report = {
    schemaVersion: 1,
    reportVersion: "text_fragment_report_v1",
    planHash: plan.planHash,
    datasetHash: dataset.datasetHash,
    mode: "text_fragment",
    status: options.status,
    partial: options.status !== "report_ready" || !complete,
    change: selected
      ? {
          bodyHash: selected.bodyHash,
          parentBodyHash: selected.parentBodyHash,
          explanation: selected.explanation,
          sourceCaseIds: selected.sourceCaseIds,
          bodyDiff: [
            ...plan.skill.body.split("\n").map((line) => `- ${line}`),
            ...selected.body.split("\n").map((line) => `+ ${line}`),
          ].join("\n"),
          overfitHints: overfitHints(
            plan.skill.body,
            selected.body,
            dataset.cases.filter((item) => item.split === "dev").map((item) => item.input),
          ),
        }
      : null,
    effect: {
      conclusion,
      evidence: sufficient
        ? "exploratory_text_evaluation"
        : "insufficient_independent_holdout_evidence",
      improved: count("improved"),
      regressed: count("regressed"),
      unchanged: count("unchanged"),
      unknown: count("unknown"),
      costComparable,
      costReductionRatio,
    },
    denominators: {
      plannedCases: dataset.cases.length,
      devCases: dataset.cases.filter((item) => item.split === "dev").length,
      holdoutCases: pairs.length,
      analysisOnlyCases: dataset.cases.filter((item) => item.readiness === "analysis_only").length,
      runnableHoldoutCases: plannedRunnable.length,
      pairedHoldoutCases: pairs.filter((pair) => pair.original !== null && pair.candidate !== null)
        .length,
      independentHoldoutGroups: sourceGroups,
      repeats: plan.bounds.repeats,
      completedTrials: sortedTrials.filter((trial) => trial.status === "completed").length,
      failedTrials: sortedTrials.filter((trial) => trial.status === "failed").length,
      unknownTrials: sortedTrials.filter((trial) => trial.status === "unknown").length,
      skippedTrials: sortedTrials.filter((trial) => trial.status === "skipped").length,
    },
    costs: {
      trial: usageOf(sortedTrials),
      optimization: options.optimization ?? null,
      ledger: options.ledger,
      pricing: plan.connections.target.pricing,
      worstCaseKnown: Object.values(plan.connections).every(
        (item) => item.outputCapCoversReasoning === true,
      ),
      finalGrantRevisions: [
        ...new Set(
          sortedTrials
            .filter((trial) => trial.phase === "holdout")
            .flatMap((trial) =>
              (trial as any).grantRevision === undefined ? [] : [(trial as any).grantRevision],
            ),
        ),
      ].sort(),
    },
    pairs,
    trials: sortedTrials,
    gradingHashes: grades.map((record) => record.recordHash).sort(),
    feedbackHashes: [...(options.feedbackHashes ?? [])].sort(),
    limitations: [
      "Standalone text_fragment evaluates instructions, not Skill loading, tools or an Agent workflow.",
      "Model aliases and upstream environment are not pinned implementation identities.",
      "Blind grading hides candidate identity in metadata; output content may still reveal it.",
      "Development improvements are not holdout validation; fixed repeats are not independent source groups.",
      "Missing model/usage/reasoning/cost evidence remains unknown; reserved estimates are stop thresholds, not billing guarantees.",
      "No candidate was adopted into ordinary Skills, Memory or dream.",
      ...(plan.bounds.repeats === 1 ? ["Each case has a single paired observation."] : []),
    ],
  };
  const json = canonicalJson(report);
  const hash = sha256Hex(json);
  const markdown = [
    "# Optimization Lab report",
    "",
    `Conclusion: **${conclusion}**${report.partial ? " (partial)" : ""}`,
    "",
    "## Change",
    "",
    selected?.explanation ?? "No candidate selected.",
    "",
    report.change?.bodyDiff ? `\`\`\`diff\n${report.change.bodyDiff}\n\`\`\`` : "",
    "## Effect",
    "",
    `Holdout: ${count("improved")} improved, ${count("regressed")} regressed, ${count("unchanged")} unchanged, ${count("unknown")} unknown.`,
    "",
    "## Denominators",
    "",
    `Planned: ${dataset.cases.length}; holdout: ${pairs.length}; paired: ${report.denominators.pairedHoldoutCases}; independent holdout groups: ${sourceGroups}; analysis only: ${report.denominators.analysisOnlyCases}; repeats: ${plan.bounds.repeats}.`,
    "",
    "## Cost",
    "",
    `Trial HTTP requests: ${report.costs.trial.httpRequests}; unknown: ${report.costs.trial.unknownRequests}; input tokens: ${report.costs.trial.inputTokens}; output tokens: ${report.costs.trial.outputTokens}; reported cost: ${report.costs.trial.reportedCostUsd ?? "unknown"}.`,
    "",
    "## Limitations",
    "",
    ...report.limitations.map((line) => `- ${line}`),
    "",
    `Report content hash: ${hash}`,
    "",
  ].join("\n");
  return { hash, json: report, markdown };
}
