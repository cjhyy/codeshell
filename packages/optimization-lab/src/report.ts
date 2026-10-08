import { canonicalJson, sha256Hex } from "./contracts/canonical-json.js";
import type { DatasetManifest } from "./contracts/dataset.js";
import {
  verifyExperimentPlan,
  worstCaseTokens,
  type ExperimentPlan,
} from "./contracts/experiment.js";
import type { Candidate } from "./candidate.js";
import { verifyGradingRecord, type GradingRecord } from "./grading.js";
import { evaluateAssertions } from "./assertions.js";
import { overfitHints } from "./overfit-hints.js";
import type { Trial } from "./runner.js";

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function latestGrade(trialId: string, grades: GradingRecord[]): GradingRecord | undefined {
  const records = [
    ...new Map(
      grades.filter((grade) => grade.trialId === trialId).map((grade) => [grade.recordHash, grade]),
    ).values(),
  ];
  const superseded = new Set(
    records
      .map(
        (grade) =>
          (grade as GradingRecord & { supersedesRecordHash?: string | null }).supersedesRecordHash,
      )
      .filter(Boolean),
  );
  const heads = records.filter((grade) => !superseded.has(grade.recordHash));
  return heads.length === 1 ? heads[0] : undefined;
}

/** Evidence is checked independently of the runner's claimed lifecycle status. */
export function trialVerdict(
  trial: Trial,
  dataset: DatasetManifest,
  grades: GradingRecord[],
): boolean | null {
  if (trial.status !== "completed" || trial.output === null) return null;
  const item = dataset.cases.find((item) => item.id === trial.caseId);
  if (
    !item ||
    item.readiness !== "runnable" ||
    !trial.observations.length ||
    trial.responseModel !== trial.requestModel
  )
    return null;
  if (
    trial.observations.some(
      (observation) =>
        observation.outcome !== "settled" ||
        observation.responseModel !== trial.requestModel ||
        observation.usage === null ||
        observation.status === null ||
        observation.status < 200 ||
        observation.status >= 300,
    )
  )
    return null;
  const assertions = evaluateAssertions(trial.output, item.hardAssertions);
  if (canonicalJson(assertions) !== canonicalJson(trial.assertions)) return null;
  if (assertions.some((assertion) => !assertion.passed)) return false;
  if (item.rubric.length) return latestGrade(trial.trialId, grades)?.semanticPassed ?? null;
  return assertions.length ? true : null;
}

function usageOf(trials: Trial[]) {
  const observations = trials.flatMap((trial) => trial.observations);
  const nullableSum = (
    key: "cacheReadTokens" | "cacheCreationTokens" | "reasoningTokens" | "reportedCostUsd",
  ) =>
    observations.length > 0 && observations.every((item) => item.usage && item.usage[key] !== null)
      ? observations.reduce((sum, item) => sum + item.usage![key]!, 0)
      : null;
  return {
    httpRequests: observations.length,
    reportedRequests: observations.filter((item) => item.outcome === "settled").length,
    unknownRequests: observations.filter((item) => item.outcome === "unknown").length,
    // These are the reported portions; unknown requests are listed separately.
    inputTokens: observations.reduce((sum, item) => sum + (item.usage?.inputTokens ?? 0), 0),
    outputTokens: observations.reduce((sum, item) => sum + (item.usage?.outputTokens ?? 0), 0),
    cacheReadTokens: nullableSum("cacheReadTokens"),
    cacheCreationTokens: nullableSum("cacheCreationTokens"),
    reasoningTokens: nullableSum("reasoningTokens"),
    reportedCostUsd: nullableSum("reportedCostUsd"),
    unknownCostRequests: observations.filter(
      (item) => !item.usage || item.usage.reportedCostUsd === null,
    ).length,
    executionMs: trials.reduce((sum, trial) => sum + trial.elapsedMs, 0),
  };
}

function pairedVerdict(
  trials: Trial[],
  dataset: DatasetManifest,
  grades: GradingRecord[],
  expectedRepeats: number,
): boolean | null {
  if (
    trials.length !== expectedRepeats ||
    new Set(trials.map((trial) => trial.repeat)).size !== expectedRepeats
  )
    return null;
  const values = trials.map((trial) => trialVerdict(trial, dataset, grades));
  return values.some((value) => value === null) ? null : values.every((value) => value === true);
}

/** A single valid diff hunk keeps common prefixes/suffixes without quadratic LCS. */
function bodyDiff(original: string, candidate: string): string {
  const before = original.split("\n");
  const after = candidate.split("\n");
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix++;
  const start = Math.max(0, prefix - 3);
  const endBefore = Math.min(before.length, before.length - suffix + 3);
  const endAfter = Math.min(after.length, after.length - suffix + 3);
  return [
    "--- original",
    "+++ candidate",
    `@@ -${start + 1},${endBefore - start} +${start + 1},${endAfter - start} @@`,
    ...before.slice(start, prefix).map((line) => ` ${line}`),
    ...before.slice(prefix, before.length - suffix).map((line) => `-${line}`),
    ...after.slice(prefix, after.length - suffix).map((line) => `+${line}`),
    ...before.slice(before.length - suffix, endBefore).map((line) => ` ${line}`),
  ].join("\n");
}
const fence = (text: string, language = "") => {
  const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 2);
  const marker = "`".repeat(longest + 1);
  return `${marker}${language}\n${text}\n${marker}`;
};
const cell = (value: unknown) =>
  String(value).replaceAll("|", "\\|").replaceAll("\n", " ").replaceAll("<", "&lt;");
const verdict = (value: boolean | null) =>
  value === null ? "unknown" : value ? "passed" : "failed";

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
  verifyExperimentPlan(plan);
  if (plan.datasetHash !== dataset.datasetHash)
    throw new Error("report dataset does not match the frozen plan");
  const selected =
    options.candidates.find((item) => item.bodyHash === options.selectedBodyHash) ?? null;
  const allowedBodies = new Set([
    plan.skill.bodyHash,
    ...options.candidates.map((item) => item.bodyHash),
  ]);
  for (const candidate of options.candidates) {
    if (
      sha256Hex(candidate.body) !== candidate.bodyHash ||
      candidate.parentBodyHash !== plan.skill.bodyHash ||
      candidate.markdown !== plan.skill.frontmatterOriginal + candidate.body ||
      candidate.sourceCaseIds.some(
        (id) => !dataset.cases.some((item) => item.id === id && item.split === "dev"),
      )
    )
      throw new Error("report candidate integrity mismatch");
  }
  const sortedTrials = [...options.trials].sort((a, b) => compare(a.trialId, b.trialId));
  const trialIds = new Set<string>();
  for (const trial of sortedTrials) {
    const identity = {
      planHash: trial.planHash,
      caseId: trial.caseId,
      bodyHash: trial.bodyHash,
      phase: trial.phase,
      repeat: trial.repeat,
    };
    if (
      trialIds.has(trial.trialId) ||
      trial.trialId !== sha256Hex(canonicalJson(identity)) ||
      trial.planHash !== plan.planHash ||
      trial.caseHash !== dataset.caseHashes[trial.caseId] ||
      !allowedBodies.has(trial.bodyHash) ||
      trial.requestModel !== plan.connections.target.modelId
    )
      throw new Error("report trial identity or artifact hash mismatch");
    trialIds.add(trial.trialId);
  }
  for (const grade of grades) {
    verifyGradingRecord(grade);
    if (!trialIds.has(grade.trialId)) throw new Error("report grading references an unknown trial");
  }
  const pairs = [...dataset.cases]
    .filter((item) => item.split === "holdout")
    .sort((a, b) => compare(a.id, b.id))
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
        baselineUsage.cacheCreationTokens !== null &&
        candidateUsage.cacheCreationTokens !== null &&
        baselineUsage.cacheCreationTokens === candidateUsage.cacheCreationTokens &&
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
    pairs.length > 0 &&
    pairs.every((pair) => pair.original !== null && pair.candidate !== null);
  const sufficient =
    sourceGroups >= plan.acceptance.minHoldoutSourceGroups &&
    plannedRunnable.length >= plan.acceptance.minPairedCases;
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
  if (count("regressed") > 0) conclusion = "regressed";
  else if (complete && sufficient && options.status === "report_ready") {
    if (criticalFailure) conclusion = "no_improvement";
    else if (plan.objective.kind === "quality")
      conclusion = count("improved") >= plan.acceptance.minFixes ? "improved" : "no_improvement";
    else if (costReductionRatio !== null)
      conclusion =
        costReductionRatio >= plan.acceptance.minCostReductionRatio ? "improved" : "no_improvement";
  }
  const finalGrantRevisions = [
    ...new Set(
      sortedTrials
        .filter((trial) => trial.phase === "holdout")
        .map((trial) => (trial as Trial & { grantRevision?: number }).grantRevision)
        .filter((revision): revision is number => revision !== undefined),
    ),
  ].sort((a, b) => a - b);
  const report = {
    schemaVersion: 1,
    reportVersion: "text_fragment_report_v1",
    planHash: plan.planHash,
    datasetHash: dataset.datasetHash,
    mode: "text_fragment",
    status: options.status,
    partial: options.status !== "report_ready" || !complete,
    adoptionEligible: false,
    change: selected
      ? {
          bodyHash: selected.bodyHash,
          parentBodyHash: selected.parentBodyHash,
          explanation: selected.explanation,
          sourceCaseIds: [...selected.sourceCaseIds].sort(compare),
          bodyDiff: bodyDiff(plan.skill.body, selected.body),
          overfitHints: overfitHints(
            plan.skill.body,
            selected.body,
            dataset.cases
              .filter((item) => item.split === "dev")
              .flatMap((item) => [item.input, item.expected ?? ""]),
            plan.objective.description,
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
      criticalFailure,
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
      worstCaseKnown: worstCaseTokens(plan, 1) !== null,
      finalGrantRevisions,
      holdoutSpansGrantRevisions: finalGrantRevisions.length > 1,
    },
    pairs,
    trials: sortedTrials,
    gradingHashes: [...new Set(grades.map((record) => record.recordHash))].sort(compare),
    feedbackHashes: [...(options.feedbackHashes ?? [])].sort(compare),
    limitations: [
      "Standalone text_fragment evaluates instructions, not Skill loading, tools or an Agent workflow.",
      "Model aliases and upstream environment are not pinned implementation identities.",
      "Blind grading hides candidate identity in metadata; output content may still reveal it.",
      "Development improvements are not holdout validation; fixed repeats are not independent source groups.",
      "Missing model/usage/reasoning/cost evidence remains unknown; reserved estimates are stop thresholds, not billing guarantees.",
      "No candidate was adopted into ordinary Skills, Memory or dream.",
      "Overfit hints inspect bounded text fragments and are advisory, not a safety or generalization proof.",
      ...(plan.bounds.repeats === 1 ? ["Each case has a single paired observation."] : []),
      ...(finalGrantRevisions.length > 1
        ? [
            "Holdout trials span authorization revisions; renewal may follow seeing partial results.",
          ]
        : []),
    ],
  };
  const json = canonicalJson(report);
  const hash = sha256Hex(json);
  const markdown = [
    "# Optimization Lab report",
    "",
    `Conclusion: **${conclusion}**${report.partial ? " (partial / evidence incomplete)" : ""}`,
    "",
    "## Change",
    "",
    selected?.explanation ?? "No candidate selected.",
    "",
    `Development sources: ${report.change?.sourceCaseIds.join(", ") || "none"}.`,
    "",
    report.change?.bodyDiff ? fence(report.change.bodyDiff, "diff") : "",
    "",
    "Overfit hints (advisory):",
    ...(report.change?.overfitHints.length
      ? report.change.overfitHints.map((hint) => `- ${hint}`)
      : ["- No hint found in the inspected fragments; this does not prove generalization."]),
    "",
    "## Effect",
    "",
    `Holdout: ${count("improved")} improved, ${count("regressed")} regressed, ${count("unchanged")} unchanged, ${count("unknown")} unknown.`,
    "",
    "| Case | Role | Original | Candidate | Change | Original reported USD | Candidate reported USD |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...pairs.map(
      (pair) =>
        `| ${cell(pair.caseId)} | ${pair.caseRole} | ${verdict(pair.original)} | ${verdict(pair.candidate)} | ${pair.change} | ${pair.baselineUsage.reportedCostUsd ?? "unknown"} | ${pair.candidateUsage.reportedCostUsd ?? "unknown"} |`,
    ),
    "",
    "## Denominators",
    "",
    `Planned: ${dataset.cases.length}; holdout: ${pairs.length}; paired: ${report.denominators.pairedHoldoutCases}; independent holdout groups: ${sourceGroups}; analysis only: ${report.denominators.analysisOnlyCases}; repeats: ${plan.bounds.repeats}.`,
    "",
    `Completed trials: ${report.denominators.completedTrials}; failed: ${report.denominators.failedTrials}; unknown: ${report.denominators.unknownTrials}; skipped: ${report.denominators.skippedTrials}.`,
    "",
    "## Cost",
    "",
    `Trial HTTP requests: ${report.costs.trial.httpRequests}; unknown: ${report.costs.trial.unknownRequests}; reported input tokens: ${report.costs.trial.inputTokens}; reported output tokens: ${report.costs.trial.outputTokens}; reported total cost: ${report.costs.trial.reportedCostUsd ?? "unknown"}; unknown cost requests: ${report.costs.trial.unknownCostRequests}.`,
    "",
    `Cost comparable: ${costComparable}; reduction ratio: ${costReductionRatio ?? "unknown"}; final authorization revisions: ${finalGrantRevisions.join(", ") || "unavailable"}.`,
    "",
    "### Optimization investment",
    "",
    fence(JSON.stringify(options.optimization ?? { status: "unavailable" }, null, 2), "json"),
    "",
    "### Reported / reserved / unknown budget",
    "",
    fence(JSON.stringify(options.ledger, null, 2), "json"),
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
