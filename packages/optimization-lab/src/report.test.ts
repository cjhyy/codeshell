import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, sha256Hex } from "./contracts/canonical-json.js";
import { freezeDataset } from "./contracts/dataset.js";
import { createExperimentPlan } from "./contracts/experiment.js";
import { planContent } from "./test-fixtures/foundation.js";
import { evaluateAssertions } from "./assertions.js";
import { buildReport, trialVerdict } from "./report.js";
import type { Candidate } from "./candidate.js";
import type { Trial } from "./runner.js";
import type { GradingRecord } from "./grading.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture(semantic = false, analysisOnly = false) {
  const directory = mkdtempSync(join(tmpdir(), "lab-report-"));
  directories.push(directory);
  const frozen = freezeDataset(
    {
      schemaVersion: 1,
      title: "Source citations",
      taskFamily: "sources",
      cases: Array.from({ length: analysisOnly ? 7 : 6 }, (_, index) => ({
        id: `case-${index + 1}`,
        version: 1,
        sourceGroupId: `source-${index + 1}`,
        provenance: "synthetic",
        caseRole: index === 5 ? "regression" : "target_failure",
        split: index < 3 ? "dev" : "holdout",
        input: `Source ${index + 1}`,
        readiness: index === 6 ? "analysis_only" : "runnable",
        missingEvidence: index === 6 ? ["not reviewed"] : [],
        hardAssertions: [{ id: "cites", kind: "contains", value: "[S1]" }],
        rubric: semantic ? [{ id: "quality", text: "Accurate", requiresHumanGrading: true }] : [],
      })),
    },
    directory,
  );
  if (!frozen.ok) throw new Error("invalid fixture");
  const content = planContent();
  content.datasetHash = frozen.manifest.datasetHash;
  content.acceptance.criticalHardAssertionIds = [];
  content.acceptance.regressionCaseIds = ["case-6"];
  content.acceptance.minPairedCases = 3;
  const plan = createExperimentPlan(content);
  const body = "Cite sources with [S1].";
  const candidate: Candidate = {
    schemaVersion: 1,
    body,
    bodyHash: sha256Hex(body),
    markdown: plan.skill.frontmatterOriginal + body,
    parentBodyHash: plan.skill.bodyHash,
    strategyVersion: "reflect_once_v1",
    explanation: "Require explicit citations.",
    sourceCaseIds: ["case-1"],
  };
  const trial = (
    caseId: string,
    candidateVersion: boolean,
    passed: boolean,
    grantRevision = 1,
  ): Trial & { grantRevision: number } => {
    const item = frozen.manifest.cases.find((item) => item.id === caseId)!;
    const identity = {
      planHash: plan.planHash,
      caseId,
      bodyHash: candidateVersion ? candidate.bodyHash : plan.skill.bodyHash,
      phase: "holdout" as const,
      repeat: 0,
    };
    const output = passed ? "A sourced answer [S1]." : "An unsourced answer.";
    return {
      schemaVersion: 1,
      trialId: sha256Hex(canonicalJson(identity)),
      ...identity,
      caseHash: frozen.manifest.caseHashes[caseId]!,
      status: "completed",
      output,
      requestModel: plan.connections.target.modelId,
      responseModel: plan.connections.target.modelId,
      assertions: evaluateAssertions(output, item.hardAssertions),
      semanticStatus: semantic ? "not_evaluated" : "not_applicable",
      requestIds: [`request-${caseId}-${candidateVersion}`],
      observations: [
        {
          attemptId: `request-${caseId}-${candidateVersion}`,
          responseModel: plan.connections.target.modelId,
          status: 200,
          elapsedMs: 5,
          outcome: "settled",
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            reasoningTokens: 0,
            reportedCostUsd: candidateVersion ? 0.01 : 0.02,
          },
        },
      ],
      elapsedMs: 5,
      reason: null,
      grantRevision,
    };
  };
  const trials = [4, 5, 6].flatMap((index) => [
    trial(`case-${index}`, false, index === 6),
    trial(`case-${index}`, true, true),
  ]);
  const options = {
    plan,
    dataset: frozen.manifest,
    candidates: [candidate],
    selectedBodyHash: candidate.bodyHash,
    trials,
    grades: [] as GradingRecord[],
    status: "report_ready",
    ledger: { totals: { reportedTokens: 90, unknownTokens: 0 } },
    optimization: { requests: 1 },
  };
  return { options, trial, candidate };
}
function grade(trial: Trial, semanticPassed = true): GradingRecord {
  const content = {
    schemaVersion: 1 as const,
    templateId: "template",
    gradingItemId: trial.trialId,
    trialId: trial.trialId,
    reviewer: "human",
    recordedAt: "2026-10-08T00:00:00.000Z",
    grades: [
      {
        id: "quality",
        verdict: semanticPassed ? ("passed" as const) : ("failed" as const),
        evidence: "Compared with the provided source.",
      },
    ],
    semanticPassed,
  };
  return { ...content, recordHash: sha256Hex(canonicalJson(content)) };
}

describe("immutable experiment reports", () => {
  test("reports real paired effects, source evidence, costs and individual cases in Markdown", () => {
    const { options } = fixture();
    const report = buildReport(options);
    expect(report.json.effect.conclusion).toBe("improved");
    expect(report.json.effect.improved).toBe(2);
    expect(report.json.effect.byCaseRole.target_failure.improved).toBe(2);
    expect(report.json.effect.byCaseRole.regression.unchanged).toBe(1);
    expect(report.json.denominators.independentHoldoutGroups).toBe(3);
    expect(report.markdown).toContain("case-4");
    expect(report.markdown).toContain("case-1");
    expect(report.markdown).toContain("Optimization investment");
    expect(report.markdown).toContain("text_fragment");
    expect(report.json).toHaveProperty("adoptionEligible", false);
  });
  test("content hash is independent of caller order or current clock", () => {
    const { options } = fixture();
    const first = buildReport(options);
    const second = buildReport({ ...options, trials: [...options.trials].reverse() });
    expect(second).toEqual(first);
  });
  test("hard failure cannot be overridden by semantic passing grades", () => {
    const { options, trial } = fixture(true);
    const failed = trial("case-4", true, false);
    expect(trialVerdict(failed, options.dataset, [grade(failed)])).toBe(false);
  });
  test("explicit correction heads are order independent and competing grades stay unknown", () => {
    const { options, trial } = fixture(true);
    const passed = trial("case-4", true, true);
    const first = grade(passed, false);
    const { recordHash: _hash, ...content } = grade(passed, true);
    const corrected = { ...content, supersedesRecordHash: first.recordHash };
    const latest = { ...corrected, recordHash: sha256Hex(canonicalJson(corrected)) };
    expect(trialVerdict(passed, options.dataset, [latest, first])).toBe(true);
    expect(trialVerdict(passed, options.dataset, [first, latest])).toBe(true);
    expect(trialVerdict(passed, options.dataset, [first, grade(passed, true)])).toBeNull();
    // Feedback pinned before a correction keeps its original verdict.
    expect(trialVerdict(passed, options.dataset, [first])).toBe(false);
  });
  test("missing human grades and analysis-only cases remain in the denominator", () => {
    const { options } = fixture(true);
    expect(buildReport(options).json.effect.conclusion).toBe("inconclusive");
    const analysis = buildReport(fixture(false, true).options);
    expect(analysis.json.denominators.plannedCases).toBe(7);
    expect(analysis.json.denominators.analysisOnlyCases).toBe(1);
    expect(analysis.json.effect.unknown).toBe(1);
    expect(analysis.json.effect.conclusion).toBe("inconclusive");
  });
  test("claimed completed trial without actual model or usage is inconclusive", () => {
    const { options } = fixture();
    options.trials[1]!.observations[0]!.outcome = "unknown";
    options.trials[1]!.observations[0]!.responseModel = null;
    expect(buildReport(options).json.effect.conclusion).toBe("inconclusive");
  });
  test("changed cache conditions cannot establish cost savings", () => {
    const { options } = fixture();
    const { planHash: _hash, ...content } = options.plan;
    content.objective.kind = "cost";
    options.plan = createExperimentPlan(content);
    for (const trial of options.trials) {
      trial.planHash = options.plan.planHash;
      trial.trialId = sha256Hex(
        canonicalJson({
          planHash: trial.planHash,
          caseId: trial.caseId,
          bodyHash: trial.bodyHash,
          phase: trial.phase,
          repeat: trial.repeat,
        }),
      );
    }
    options.trials[1]!.observations[0]!.usage!.cacheReadTokens = 2;
    const result = buildReport(options);
    expect(result.json.effect.costComparable).toBe(false);
    expect(result.json.effect.conclusion).toBe("inconclusive");
  });
  test("partial lifecycle never becomes improved from local late grading", () => {
    const { options } = fixture(true);
    options.grades = options.trials.map((trial) => grade(trial));
    options.status = "cancelled";
    expect(buildReport(options).json.effect.conclusion).toBe("inconclusive");
    expect(buildReport(options).json.partial).toBe(true);
  });
  test("hard token bounds require input proof and final grant revisions are numeric", () => {
    const { options } = fixture();
    const { planHash: _hash, ...content } = options.plan;
    content.bounds.trial.inputTokenUpperBound = null;
    options.plan = createExperimentPlan(content);
    for (const trial of options.trials) {
      trial.planHash = options.plan.planHash;
      trial.trialId = sha256Hex(
        canonicalJson({
          planHash: trial.planHash,
          caseId: trial.caseId,
          bodyHash: trial.bodyHash,
          phase: trial.phase,
          repeat: trial.repeat,
        }),
      );
    }
    options.trials[0]!.grantRevision = 10;
    options.trials[1]!.grantRevision = 2;
    const result = buildReport(options);
    expect(result.json.costs.worstCaseKnown).toBe(false);
    expect(result.json.costs.finalGrantRevisions).toEqual([1, 2, 10]);
    expect(result.json.costs).toHaveProperty("holdoutSpansGrantRevisions", true);
  });
  test("duplicate trials and artifact/hash mismatches are rejected", () => {
    const { options } = fixture();
    expect(() =>
      buildReport({ ...options, trials: [...options.trials, options.trials[0]!] }),
    ).toThrow();
    options.trials[0]!.caseHash = "0".repeat(64);
    expect(() => buildReport(options)).toThrow();
  });
});
