import { expect, test } from "bun:test";
import { createGradingTemplate, importGrading } from "./grading.js";
import type { DatasetManifest } from "./contracts/dataset.js";
import type { Trial } from "./runner.js";
const dataset = {
  cases: [
    {
      id: "case",
      input: "a question",
      rubric: [{ id: "quality", text: "good answer", requiresHumanGrading: true }],
    },
  ],
} as DatasetManifest;
const trial = {
  trialId: "secret-trial",
  caseId: "case",
  caseHash: "casehash",
  bodyHash: "candidatehash",
  phase: "baseline",
  status: "completed",
  output: "answer",
} as Trial;
test("blind templates omit private identities and reject conflicts", () => {
  const { template, mapping } = createGradingTemplate("experiment", "baseline", dataset, [trial]);
  const text = JSON.stringify(template);
  expect(text).not.toContain("secret-trial");
  expect(text).not.toContain("candidatehash");
  const raw = {
    schemaVersion: 1,
    templateId: template.templateId,
    reviewer: "human",
    items: [
      {
        gradingItemId: template.items[0]!.gradingItemId,
        grades: [{ id: "quality", verdict: "passed", evidence: "Correct detail" }],
      },
    ],
  };
  const records = importGrading(raw, mapping, [], () => "2026-10-08T01:00:00.000Z");
  expect(records[0]?.semanticPassed).toBe(true);
  expect(importGrading(raw, mapping, records)).toEqual(records);
  expect(() =>
    importGrading(
      {
        ...raw,
        items: [
          { ...raw.items[0], grades: [{ id: "quality", verdict: "failed", evidence: "Changed" }] },
        ],
      },
      mapping,
      records,
    ),
  ).toThrow("conflicting");
  expect(() =>
    importGrading({ ...raw, items: [{ ...raw.items[0], gradingItemId: "unknown" }] }, mapping, []),
  ).toThrow("unknown");
});
test("all not-applicable grades never create a semantic pass", () => {
  const { template, mapping } = createGradingTemplate("experiment", "baseline", dataset, [trial]);
  const record = importGrading(
    {
      schemaVersion: 1,
      templateId: template.templateId,
      reviewer: "human",
      items: [
        {
          gradingItemId: template.items[0]!.gradingItemId,
          grades: [{ id: "quality", verdict: "not-applicable", evidence: "cannot assess" }],
        },
      ],
    },
    mapping,
    [],
  );
  expect(record[0]?.semanticPassed).toBeNull();
});

test("explicit corrections append evidence and inconclusive scores do not unlock a phase", () => {
  const { template, mapping } = createGradingTemplate("experiment", "baseline", dataset, [trial]);
  const item = template.items[0]!;
  const raw = {
    schemaVersion: 1,
    templateId: template.templateId,
    reviewer: "human",
    items: [
      {
        gradingItemId: item.gradingItemId,
        grades: [{ id: "quality", verdict: "inconclusive", evidence: "Not enough evidence yet" }],
      },
    ],
  };
  const initial = importGrading(raw, mapping, []);
  const corrected = importGrading(
    {
      ...raw,
      items: [
        {
          ...raw.items[0],
          supersedesRecordHash: initial[0]!.recordHash,
          grades: [{ id: "quality", verdict: "passed", evidence: "Reviewed against the source" }],
        },
      ],
    },
    mapping,
    initial,
  );
  expect(corrected[0]?.semanticPassed).toBe(true);
  expect(corrected[0]?.supersedesRecordHash).toBe(initial[0]!.recordHash);
  expect(corrected[0]?.recordHash).not.toBe(initial[0]?.recordHash);
});
