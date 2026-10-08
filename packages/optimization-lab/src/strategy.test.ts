import { expect, test } from "bun:test";
import { reflectionInput } from "./strategy.js";
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
