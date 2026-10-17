import { expect, test } from "bun:test";
import { createGradingTemplate, fullyGraded, importGrading } from "../../../packages/optimization-lab/src/grading.js";
import { reflectionInput } from "../../../packages/optimization-lab/src/strategy.js";
import type { DatasetManifest } from "../../../packages/optimization-lab/src/contracts/dataset.js";
import type { ExperimentPlan } from "../../../packages/optimization-lab/src/contracts/experiment.js";
import type { EvalCase } from "../../../packages/optimization-lab/src/contracts/eval-case.js";
import type { Trial } from "../../../packages/optimization-lab/src/runner.js";
import { parseChallenges, parseReviews } from "../../../packages/arena/src/strategies/utils.js";
import { applyReviewResult } from "../../../packages/arena/src/transitions.js";
import { ArenaLedger } from "../../../packages/arena/src/ledger.js";
import { runAdjudication } from "../../../packages/arena/src/phases/adjudication.js";
import type { ArenaParticipant, ArenaStrategy, ClaimRecord } from "../../../packages/arena/src/types.js";

// Only pure transforms and the model-free early return of runAdjudication run here.
// No provider, process, Host, feature flag, or application is started.
globalThis.fetch = (() => { throw new Error("audit fixture forbids network"); }) as typeof fetch;

const observations: Record<string, unknown>[] = [];

function claim(id: string, status: ClaimRecord["status"] = "under_review"): ClaimRecord {
  return {
    claimId: id,
    owner: "author",
    finding: {
      id: "f1", kind: "improvement", title: "Check the boundary", summary: "Needs review",
      confidence: 0.5, evidence: [], affectedFiles: [],
    },
    evidenceRefs: [], evidencePacketIds: [], status, challenges: [], debateRounds: [],
  };
}

test("Lab continuation accepts the corrected grade but reflection sends its superseded predecessor", () => {
  const item = {
    id: "dev", split: "dev", input: "Answer this development case",
    rubric: [{ id: "accuracy", text: "Answer is accurate", requiresHumanGrading: true }],
  } as EvalCase;
  const dataset = { cases: [item] } as DatasetManifest;
  const trial = {
    trialId: "trial-dev", caseId: "dev", caseHash: "case-hash", bodyHash: "body-hash",
    phase: "baseline", status: "completed", output: "An answer", assertions: [],
  } as unknown as Trial;
  const plan = { skill: { body: "Original instructions" }, objective: { kind: "quality" } } as ExperimentPlan;
  const { template, mapping } = createGradingTemplate("experiment", "baseline", dataset, [trial]);
  const gradingItemId = template.items[0]!.gradingItemId;
  const initial = importGrading({
    schemaVersion: 1, templateId: template.templateId, reviewer: "reviewer",
    items: [{ gradingItemId, grades: [{ id: "accuracy", verdict: "inconclusive", evidence: "Initial review unfinished" }] }],
  }, mapping, [], () => "2026-10-17T00:00:00.000Z");
  const correction = importGrading({
    schemaVersion: 1, templateId: template.templateId, reviewer: "reviewer",
    items: [{ gradingItemId, supersedesRecordHash: initial[0]!.recordHash,
      grades: [{ id: "accuracy", verdict: "passed", evidence: "Final review confirms accuracy" }] }],
  }, mapping, initial, () => "2026-10-17T00:01:00.000Z");
  const records = [...initial, ...correction];
  const frozenFeedback = records.map((record) => ({ trialId: record.trialId, semanticPassed: record.semanticPassed, criteria: record.grades }));
  const payload = JSON.parse(reflectionInput(plan, [item], [trial], frozenFeedback));
  const actual = payload.development[0].trials[0].semanticFeedback;
  const latestOnly = JSON.parse(reflectionInput(plan, [item], [trial], frozenFeedback.slice(-1)));
  expect(fullyGraded([trial], dataset, initial)).toBe(false);
  expect(fullyGraded([trial], dataset, records)).toBe(true);
  expect(correction[0]!.supersedesRecordHash).toBe(initial[0]!.recordHash);
  expect(actual.semanticPassed).toBeNull();
  expect(actual.criteria[0].evidence).toBe("Initial review unfinished");
  expect(latestOnly.development[0].trials[0].semanticFeedback.semanticPassed).toBe(true);
  observations.push({ id: "LAB-R3-01", continuationFullyGraded: true, latestSemanticPassed: correction[0]!.semanticPassed, actualReflectionFeedback: actual });
});

test("Arena missing or invalid peer verdict becomes explicit agreement and verifies the claim", () => {
  const cases = [
    { claimId: "author:f1", reason: "I have not completed checking this" },
    { claimId: "author:f1", verdict: "uncertain", reason: "Unable to verify" },
  ];
  for (const raw of cases) {
    const parsed = parseChallenges("reviewer", JSON.stringify([raw]));
    const target = claim("author:f1");
    applyReviewResult(target, parsed, false);
    expect(parsed[0]!.verdict).toBe("agree");
    expect(target.status).toBe("verified");
    observations.push({ id: "ARENA-R3-01", raw, parsedVerdict: parsed[0]!.verdict, actualClaimStatus: target.status });
  }
  const needsEvidence = claim("author:f1");
  applyReviewResult(needsEvidence, parseChallenges("reviewer", JSON.stringify([{ claimId: "author:f1", verdict: "needs_evidence" }])), false);
  expect(needsEvidence.status).toBe("contested");
  expect(parseReviews("reviewer", JSON.stringify([{ findingId: "f1", reason: "No verdict supplied" }]))[0]!.verdict).toBe("agree");
});

test("Arena skips its unresolved sweep when every remaining claim is proposed or under review", async () => {
  const ledger = new ArenaLedger();
  const unreviewed = claim("author:proposed", "proposed");
  const unfinished = claim("author:under-review", "under_review");
  ledger.appendClaim(unreviewed);
  ledger.appendClaim(unfinished);
  const adjudications = await runAdjudication({
    concluder: { name: "unused", llm: { provider: "audit-no-provider", model: "unused" } } as ArenaParticipant,
    strategy: {} as ArenaStrategy, topic: "offline only", ledger,
  });
  const all = ledger.getAllClaims();
  // Same four filters as Arena.summarizeClaims, deliberately excludes transient states.
  const summarized = all.filter((item) => ["verified", "unresolved", "contested", "rejected"].includes(item.status));
  expect(adjudications).toEqual([]);
  expect(unreviewed.status).toBe("proposed");
  expect(unfinished.status).toBe("under_review");
  expect(ledger.getClaimsByStatus("unresolved")).toHaveLength(0);
  expect(summarized).toHaveLength(0);
  expect(all).toHaveLength(2);
  observations.push({ id: "ARENA-R3-02", allClaimCount: all.length, actualStatuses: all.map((item) => item.status), summarizedClaimCount: summarized.length });
});

test("emit audit observations", () => {
  console.log("AUDIT_OBSERVATIONS " + JSON.stringify(observations));
  expect(observations).toHaveLength(4);
});
