import { randomBytes, randomInt } from "node:crypto";
import { z } from "zod";
import { canonicalJson, sha256Hex } from "./contracts/canonical-json.js";
import type { DatasetManifest } from "./contracts/dataset.js";
import type { Trial } from "./runner.js";

export const GRADING_VERSION = "human_blind_v1";
export type CriterionVerdict = "passed" | "failed" | "inconclusive" | "not-applicable";
export interface Grade {
  id: string;
  verdict: CriterionVerdict;
  evidence: string;
}
export interface GradingTemplate {
  schemaVersion: 1;
  experimentId: string;
  templateId: string;
  phase: string;
  reviewer: string;
  items: {
    gradingItemId: string;
    supersedesRecordHash?: string;
    input: string;
    output: string;
    rubric: { id: string; text: string }[];
    grades: Grade[];
  }[];
}
export interface GradingMapping {
  schemaVersion: 1;
  experimentId: string;
  templateId: string;
  phase: string;
  items: {
    gradingItemId: string;
    trialId: string;
    trialHash: string;
    caseHash: string;
    bodyHash: string;
    rubricHash: string;
    criterionIds: string[];
  }[];
}
export interface GradingRecord {
  schemaVersion: 1;
  templateId: string;
  gradingItemId: string;
  trialId: string;
  reviewer: string;
  recordedAt: string;
  grades: Grade[];
  semanticPassed: boolean | null;
  supersedesRecordHash: string | null;
  recordHash: string;
}
const GradeSchema = z
  .object({
    id: z.string().min(1).max(64),
    verdict: z.enum(["passed", "failed", "inconclusive", "not-applicable"]),
    evidence: z.string().min(1).max(8000),
  })
  .strict();
const ImportSchema = z
  .object({
    schemaVersion: z.literal(1),
    templateId: z.string().min(1).max(128),
    reviewer: z.string().min(1).max(256),
    experimentId: z.string().optional(),
    phase: z.string().optional(),
    items: z
      .array(
        z
          .object({
            gradingItemId: z.string().min(1).max(128),
            grades: z.array(GradeSchema).min(1).max(16),
            supersedesRecordHash: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
            input: z.string().optional(),
            output: z.string().optional(),
            rubric: z.array(z.object({ id: z.string(), text: z.string() }).strict()).optional(),
          })
          .strict(),
      )
      .max(1200),
  })
  .strict();

/** Mapping is private. The public blind template has no candidate, case or execution IDs. */
export function createGradingTemplate(
  experimentId: string,
  phase: string,
  dataset: DatasetManifest,
  trials: Trial[],
): { template: GradingTemplate; mapping: GradingMapping } {
  const templateId = randomBytes(24).toString("hex");
  const pairs = trials
    .filter(
      (trial) =>
        trial.status === "completed" &&
        dataset.cases.find((item) => item.id === trial.caseId)?.rubric.length,
    )
    .map((trial) => {
      const item = dataset.cases.find((item) => item.id === trial.caseId)!;
      const gradingItemId = randomBytes(24).toString("hex");
      return {
        public: {
          gradingItemId,
          input: item.input,
          output: trial.output!,
          rubric: item.rubric.map(({ id, text }) => ({ id, text })),
          grades: item.rubric.map(({ id }) => ({
            id,
            verdict: "inconclusive" as const,
            evidence: "",
          })),
        },
        private: {
          gradingItemId,
          trialId: trial.trialId,
          trialHash: sha256Hex(canonicalJson(trial)),
          caseHash: trial.caseHash,
          bodyHash: trial.bodyHash,
          rubricHash: sha256Hex(canonicalJson(item.rubric)),
          criterionIds: item.rubric.map(({ id }) => id).sort(),
        },
      };
    });
  for (let index = pairs.length - 1; index > 0; index--) {
    const other = randomInt(index + 1);
    [pairs[index], pairs[other]] = [pairs[other]!, pairs[index]!];
  }
  return {
    template: {
      schemaVersion: 1,
      experimentId,
      templateId,
      phase,
      reviewer: "",
      items: pairs.map((pair) => pair.public),
    },
    mapping: {
      schemaVersion: 1,
      experimentId,
      templateId,
      phase,
      items: pairs.map((pair) => pair.private),
    },
  };
}

export function importGrading(
  raw: unknown,
  mapping: GradingMapping,
  existing: GradingRecord[],
  now: () => string = () => new Date().toISOString(),
  template?: GradingTemplate,
): GradingRecord[] {
  const input = ImportSchema.parse(raw);
  if (
    (input.experimentId !== undefined && input.experimentId !== mapping.experimentId) ||
    (input.phase !== undefined && input.phase !== mapping.phase)
  )
    throw new Error("grading display identity mismatch");
  if (input.templateId !== mapping.templateId) throw new Error("grading template mismatch");
  const seen = new Set<string>();
  return input.items.map((item) => {
    if (seen.has(item.gradingItemId)) throw new Error("duplicated grading item");
    seen.add(item.gradingItemId);
    const link = mapping.items.find((entry) => entry.gradingItemId === item.gradingItemId);
    if (!link) throw new Error("unknown grading item");
    const original = template?.items.find((entry) => entry.gradingItemId === item.gradingItemId);
    for (const key of ["input", "output", "rubric"] as const)
      if (
        item[key] !== undefined &&
        (!original || canonicalJson(item[key]) !== canonicalJson(original[key]))
      )
        throw new Error("grading display or rules changed");
    const grades = [...item.grades].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (canonicalJson(grades.map(({ id }) => id)) !== canonicalJson(link.criterionIds))
      throw new Error("grading rules are missing, duplicated or changed");
    const prior = [...existing]
      .reverse()
      .find(
        (entry) =>
          entry.templateId === input.templateId && entry.gradingItemId === item.gradingItemId,
      );
    if (prior) {
      if (
        prior.reviewer === input.reviewer &&
        canonicalJson(prior.grades) === canonicalJson(grades)
      )
        return prior;
      if (item.supersedesRecordHash !== prior.recordHash)
        throw new Error(
          "conflicting immutable grading record; export current template to append a correction",
        );
    } else if (item.supersedesRecordHash !== undefined)
      throw new Error("unknown grading correction predecessor");
    const applicable = grades.filter((grade) => grade.verdict !== "not-applicable");
    const semanticPassed = grades.some((grade) => grade.verdict === "failed")
      ? false
      : applicable.length === 0 || applicable.some((grade) => grade.verdict === "inconclusive")
        ? null
        : true;
    const content = {
      schemaVersion: 1 as const,
      templateId: input.templateId,
      gradingItemId: item.gradingItemId,
      trialId: link.trialId,
      reviewer: input.reviewer,
      recordedAt: now(),
      grades,
      semanticPassed,
      supersedesRecordHash: prior?.recordHash ?? null,
    };
    return { ...content, recordHash: sha256Hex(canonicalJson(content)) };
  });
}

export function verifyGradingRecord(record: GradingRecord): void {
  const { recordHash, ...content } = record;
  if (sha256Hex(canonicalJson(content)) !== recordHash)
    throw new Error("grading record integrity mismatch");
}

export function fullyGraded(
  trials: Trial[],
  dataset: DatasetManifest,
  records: GradingRecord[],
): boolean {
  return trials.every(
    (trial) =>
      trial.status !== "completed" ||
      !dataset.cases.find((item) => item.id === trial.caseId)?.rubric.length ||
      [...records].reverse().find((record) => record.trialId === trial.trialId)?.semanticPassed !=
        null,
  );
}
