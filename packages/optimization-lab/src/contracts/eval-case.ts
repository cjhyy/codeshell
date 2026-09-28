import { z } from "zod";

export const MAX_CASE_TEXT_BYTES = 64 * 1024;

const boundedText = (max = MAX_CASE_TEXT_BYTES) =>
  z.string().refine((value) => Buffer.byteLength(value, "utf8") <= max, `exceeds ${max} bytes`);
const shortId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);

export const HardAssertionSchema = z.discriminatedUnion("kind", [
  z
    .object({ id: shortId, kind: z.literal("contains"), value: z.string().min(1).max(4096) })
    .strict(),
  z
    .object({ id: shortId, kind: z.literal("not_contains"), value: z.string().min(1).max(4096) })
    .strict(),
  z
    .object({
      id: shortId,
      kind: z.literal("json_field_equals"),
      path: z.array(z.string().min(1)).min(1).max(8),
      value: z.union([boundedText(), z.number().finite(), z.boolean(), z.null()]),
    })
    .strict(),
]);

export const RubricItemSchema = z
  .object({ id: shortId, text: z.string().min(1).max(2000), requiresHumanGrading: z.boolean() })
  .strict();

export const EvalCaseSchema = z
  .object({
    id: shortId,
    version: z.number().int().positive().safe(),
    sourceGroupId: z.string().min(1).max(128),
    provenance: z.enum(["real", "synthetic"]),
    caseRole: z.enum(["target_failure", "regression"]),
    split: z.enum(["dev", "holdout"]),
    input: boundedText().refine((value) => value.length > 0, "must not be empty"),
    fixtureRefs: z.array(z.string().min(1).max(256)).max(32).default([]),
    expected: boundedText().optional(),
    rubric: z.array(RubricItemSchema).max(16).default([]),
    hardAssertions: z.array(HardAssertionSchema).max(16).default([]),
    readiness: z.enum(["analysis_only", "runnable"]),
    missingEvidence: z.array(z.string().min(1).max(500)).max(32).default([]),
  })
  .strict();

export const DatasetInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    title: z.string().min(1).max(200),
    taskFamily: z.string().min(1).max(128),
    cases: z.array(EvalCaseSchema).min(1).max(200),
  })
  .strict();

export type HardAssertion = z.infer<typeof HardAssertionSchema>;
export type RubricItem = z.infer<typeof RubricItemSchema>;
export type EvalCase = z.infer<typeof EvalCaseSchema>;
export type DatasetInput = z.infer<typeof DatasetInputSchema>;
