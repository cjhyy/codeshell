import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson, sha256Hex } from "./canonical-json.js";
import { VERDICT_POLICY_SUITE_VERSION } from "./verdict-policy.js";

export const RUNNER_VERSION = "text_fragment_v1" as const;
export const STRATEGY_VERSION = "reflect_once_v1" as const;
export const ESTIMATOR_VERSION = "utf8_conservative_v1" as const;
export const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive().safe();
const nonnegative = z.number().finite().nonnegative();
const text = z.string().max(512 * 1024);

export const ResourceAllocationSchema = z
  .object({
    requests: z.number().int().nonnegative().safe(),
    estimatedTokens: nonnegative,
    estimatedCostUsd: nonnegative.nullable(),
    executionMs: z.number().int().nonnegative().safe(),
  })
  .strict();
export type ResourceAllocation = z.infer<typeof ResourceAllocationSchema>;

export const OperationLimitsSchema = z
  .object({
    maxRequests: positive.max(8),
    maxOutputTokens: positive.max(131072),
    timeoutMs: positive.max(600000),
    inputTokenUpperBound: positive.nullable(),
  })
  .strict();
export type OperationLimits = z.infer<typeof OperationLimitsSchema>;

/** Explicit, non-secret identity only. Arbitrary provider settings never belong here. */
export const ConnectionIdentitySchema = z
  .object({
    connectionId: z.string().min(1).max(256),
    providerKind: z.string().min(1).max(128),
    modelId: z.string().min(1).max(256),
    endpoint: z
      .string()
      .url()
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      }, "endpoint identity must not contain credentials, query or fragment"),
    configHash: HashSchema,
    credentialRevision: z.string().min(1).max(128).nullable(),
    outputCapCoversReasoning: z.union([z.boolean(), z.literal("unknown")]),
    pricing: z
      .object({
        inputPerMillion: nonnegative.nullable(),
        outputPerMillion: nonnegative.nullable(),
        cachedInputPerMillion: nonnegative.nullable(),
        source: z.string().min(1).max(1024).nullable(),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable(),
      })
      .strict(),
  })
  .strict();
export type ConnectionIdentity = z.infer<typeof ConnectionIdentitySchema>;

export const ExperimentPlanContentSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectKey: z.string().regex(/^[a-f0-9]{16,64}$/),
    datasetHash: HashSchema,
    skill: z
      .object({
        name: z.string().min(1).max(256),
        source: z.string().min(1).max(128),
        revision: HashSchema,
        revisionKind: z.literal("bundle"),
        markdown: text,
        body: text,
        frontmatterOriginal: text,
        markdownHash: HashSchema,
        bodyHash: HashSchema,
        extraFiles: z.array(z.never()).max(0),
      })
      .strict(),
    connections: z
      .object({ target: ConnectionIdentitySchema, optimizer: ConnectionIdentitySchema })
      .strict(),
    runnerVersion: z.enum([RUNNER_VERSION, "codeshell_isolated_v1"]),
    strategyVersion: z.enum([STRATEGY_VERSION, "fixed_candidate_trial_v1"]),
    fixedCandidate: z
      .object({
        sourceExperimentId: z.string().regex(/^exp_[a-f0-9-]{36}$/),
        sourcePlanHash: HashSchema,
        sourceReportHash: HashSchema,
        candidateHash: HashSchema,
        bodyHash: HashSchema,
        body: text,
        revealedHoldoutCaseIds: z.array(z.string().min(1).max(64)).max(200),
      })
      .strict()
      .optional(),
    estimatorVersion: z.literal(ESTIMATOR_VERSION),
    verdictPolicySuiteVersion: z.literal(VERDICT_POLICY_SUITE_VERSION),
    scorerHash: HashSchema,
    judgeMode: z.literal("human"),
    objective: z
      .object({ kind: z.enum(["quality", "cost"]), description: z.string().min(1).max(4096) })
      .strict(),
    acceptance: z
      .object({
        criticalHardAssertionIds: z.array(z.string().min(1).max(128)).max(3200),
        regressionCaseIds: z.array(z.string().min(1).max(128)).max(200),
        qualityNoRegression: z.literal(true),
        minFixes: z.number().int().nonnegative().safe(),
        minCostReductionRatio: z.number().finite().min(0).max(1),
        costComparableOnly: z.literal(true),
        minHoldoutSourceGroups: positive.min(3).max(200),
        minPairedCases: positive.max(200),
      })
      .strict(),
    bounds: z
      .object({
        concurrency: z.literal(1),
        maxCandidates: positive.max(2),
        repeats: positive.max(3),
        maxBodyBytes: positive.max(512 * 1024),
        maxContextBytes: positive.max(4 * 1024 * 1024),
        trial: OperationLimitsSchema,
        optimization: OperationLimitsSchema,
      })
      .strict(),
    externalData: z
      .object({
        target: z.literal("current_case_input_and_skill"),
        optimizer: z.enum(["skill_and_dev_feedback", "none"]),
        judge: z.literal("none"),
      })
      .strict(),
    finalAllocation: ResourceAllocationSchema,
  })
  .strict();

export type ExperimentPlanContent = z.infer<typeof ExperimentPlanContentSchema>;
export type ExperimentPlan = ExperimentPlanContent & { planHash: string };
export const ExperimentPlanSchema = ExperimentPlanContentSchema.extend({ planHash: HashSchema });

function validateContent(content: ExperimentPlanContent): void {
  const { skill } = content;
  const fixed = content.fixedCandidate;
  if (
    (content.strategyVersion === "fixed_candidate_trial_v1") !== Boolean(fixed) ||
    (fixed
      ? content.externalData.optimizer !== "none" ||
        content.bounds.maxCandidates !== 1 ||
        sha256Hex(fixed.body) !== fixed.bodyHash ||
        Buffer.byteLength(fixed.body) > content.bounds.maxBodyBytes ||
        fixed.bodyHash === skill.bodyHash
      : content.externalData.optimizer !== "skill_and_dev_feedback")
  )
    throw new Error("optimization_lab: fixed candidate binding mismatch");
  if (
    sha256Hex(skill.markdown) !== skill.markdownHash ||
    sha256Hex(skill.body) !== skill.bodyHash
  ) {
    throw new Error("optimization_lab: skill content hash mismatch");
  }
  // Same boundary contract as Core's readSkillSnapshot; never accept unrelated
  // body/prefix strings merely because each carries a self-consistent hash.
  const frontmatter = skill.markdown.match(/^---\s*\n([\s\S]*?)---\s*\n?/u)?.[0] ?? "";
  if (
    skill.frontmatterOriginal !== frontmatter ||
    skill.body !== skill.markdown.slice(frontmatter.length)
  ) {
    throw new Error("optimization_lab: Skill body/frontmatter extraction mismatch");
  }
  const bundleRevisions = [false, true].map((executable) =>
    createHash("sha256")
      .update(`SKILL.md\0${executable}\0${Buffer.byteLength(skill.markdown, "utf8")}\0`)
      .update(skill.markdown)
      .digest("hex"),
  );
  if (!bundleRevisions.includes(skill.revision))
    throw new Error("optimization_lab: Skill bundle revision mismatch");
  if (
    content.acceptance.criticalHardAssertionIds.some(
      (id) => !/^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,63}$/.test(id),
    )
  ) {
    throw new Error("optimization_lab: critical assertions require caseId/criterionId scope");
  }
  if (Buffer.byteLength(skill.body, "utf8") > content.bounds.maxBodyBytes) {
    throw new Error("optimization_lab: Skill body exceeds plan limit");
  }
  for (const ids of [
    content.acceptance.criticalHardAssertionIds,
    content.acceptance.regressionCaseIds,
  ]) {
    if (new Set(ids).size !== ids.length)
      throw new Error("optimization_lab: duplicated acceptance id");
  }
}

/** No timestamps or secrets are accepted in the immutable plan content. */
export function createExperimentPlan(raw: unknown): ExperimentPlan {
  canonicalJson(raw);
  const content = ExperimentPlanContentSchema.parse(raw);
  validateContent(content);
  return { ...content, planHash: sha256Hex(canonicalJson(content)) };
}

export function verifyExperimentPlan(raw: unknown): ExperimentPlan {
  canonicalJson(raw);
  const parsed = ExperimentPlanSchema.parse(raw);
  const { planHash, ...content } = parsed;
  const plan = createExperimentPlan(content);
  if (planHash !== plan.planHash) throw new Error("optimization_lab: plan hash mismatch");
  return plan;
}

/** Only a true provider output cap plus a conservative input bound gives a token bound. */
export function worstCaseTokens(plan: ExperimentPlan, maxRequests: number): number | null {
  verifyExperimentPlan(plan);
  if (!Number.isSafeInteger(maxRequests) || maxRequests <= 0)
    throw new Error("invalid request count");
  const operations = [plan.bounds.trial, plan.bounds.optimization];
  if (
    Object.values(plan.connections).some(
      (connection) => connection.outputCapCoversReasoning !== true,
    ) ||
    operations.some((limits) => limits.inputTokenUpperBound === null)
  )
    return null;
  const perRequest = Math.max(
    ...operations.map((limits) => limits.inputTokenUpperBound! + limits.maxOutputTokens),
  );
  const result = perRequest * maxRequests;
  return Number.isSafeInteger(result) ? result : null;
}
