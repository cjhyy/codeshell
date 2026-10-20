import { expect, test } from "bun:test";
import { reflectionInput } from "./strategy.js";
import { createGradingTemplate, fullyGraded, importGrading } from "./grading.js";
import type { DatasetManifest } from "./contracts/dataset.js";
import type { EvalCase } from "./contracts/eval-case.js";
import type { ExperimentPlan } from "./contracts/experiment.js";
import type { Trial } from "./runner.js";

test("reflection payload carries only the selected development feedback", () => {
  const plan = {
    skill: { body: "Frozen original" },
    objective: { kind: "quality", description: "Improve quality" },
    datasetHash: "SECRET_DATASET_HASH",
    connections: { target: { endpoint: "SECRET_ENDPOINT" } },
  } as ExperimentPlan;
  const item = {
    id: "dev",
    split: "dev",
    input: "Current development input",
    expected: "SECRET_EXPECTED",
    rubric: [{ text: "SECRET_RUBRIC" }],
  } as EvalCase;
  const trial = {
    trialId: "trial",
    caseId: "dev",
    phase: "baseline",
    output: "Observed answer",
    status: "completed",
    assertions: [{ id: "hard", passed: false, reason: "required text missing" }],
  } as Trial;
  const payload = reflectionInput(
    plan,
    [item],
    [trial],
    [
      {
        trialId: "trial",
        semanticPassed: false,
        criteria: [{ id: "clear", verdict: "failed", evidence: "Answer lacks detail" }],
      },
    ],
  );
  expect(payload).toContain("Current development input");
  expect(payload).toContain("Answer lacks detail");
  for (const secret of [
    "SECRET_EXPECTED",
    "SECRET_RUBRIC",
    "SECRET_DATASET_HASH",
    "SECRET_ENDPOINT",
  ])
    expect(payload).not.toContain(secret);
  expect(() => reflectionInput(plan, [{ ...item, split: "holdout" }], [trial], [])).toThrow(
    "holdout",
  );
  expect(() => reflectionInput(plan, [item], [{ ...trial, phase: "holdout" }], [])).toThrow(
    "outside",
  );
});

// Regression (LAB-R3-01): grading corrections are appended, and both the
// original and the correction are frozen into the baseline feedback. The
// continuation gate (fullyGraded) honours the latest record, so reflection
// must also send the correction rather than the superseded first record.
test("reflection payload uses the latest grading correction for a trial", () => {
  const item = {
    id: "dev",
    split: "dev",
    input: "Development case",
    rubric: [{ id: "accuracy", text: "Accurate", requiresHumanGrading: true }],
  } as EvalCase;
  const dataset = { cases: [item] } as DatasetManifest;
  const trial = {
    trialId: "trial-dev",
    caseId: "dev",
    caseHash: "case-hash",
    bodyHash: "body-hash",
    phase: "baseline",
    status: "completed",
    output: "An answer",
    assertions: [],
  } as unknown as Trial;
  const plan = { skill: { body: "Original" }, objective: { kind: "quality" } } as ExperimentPlan;
  const { template, mapping } = createGradingTemplate("exp", "baseline", dataset, [trial]);
  const gradingItemId = template.items[0]!.gradingItemId;
  const initial = importGrading(
    {
      schemaVersion: 1,
      templateId: template.templateId,
      reviewer: "reviewer",
      items: [
        {
          gradingItemId,
          grades: [
            { id: "accuracy", verdict: "inconclusive", evidence: "Initial review unfinished" },
          ],
        },
      ],
    },
    mapping,
    [],
    () => "2026-10-17T00:00:00.000Z",
  );
  const correction = importGrading(
    {
      schemaVersion: 1,
      templateId: template.templateId,
      reviewer: "reviewer",
      items: [
        {
          gradingItemId,
          supersedesRecordHash: initial[0]!.recordHash,
          grades: [
            { id: "accuracy", verdict: "passed", evidence: "Final review confirms accuracy" },
          ],
        },
      ],
    },
    mapping,
    initial,
    () => "2026-10-17T00:01:00.000Z",
  );
  const records = [...initial, ...correction];
  expect(fullyGraded([trial], dataset, records)).toBe(true);

  const feedback = records.map((record) => ({
    trialId: record.trialId,
    semanticPassed: record.semanticPassed,
    criteria: record.grades,
  }));
  const payload = JSON.parse(reflectionInput(plan, [item], [trial], feedback));
  const semantic = payload.development[0].trials[0].semanticFeedback;
  expect(semantic.semanticPassed).toBe(true);
  expect(semantic.criteria[0].evidence).toBe("Final review confirms accuracy");
});
