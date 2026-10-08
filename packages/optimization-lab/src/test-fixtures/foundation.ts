import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createExperimentPlan,
  ESTIMATOR_VERSION,
  RUNNER_VERSION,
  STRATEGY_VERSION,
  type ExperimentPlanContent,
} from "../contracts/experiment.js";
import { VERDICT_POLICY_SUITE_VERSION } from "../contracts/verdict-policy.js";
import { sha256Hex } from "../contracts/canonical-json.js";
import { createBudgetGrant, type BudgetGrant } from "../contracts/grant.js";
import { ExperimentStore } from "../store.js";
import { ExperimentLease } from "../lease.js";

export function planContent(): ExperimentPlanContent {
  const frontmatterOriginal = "---\nname: sample\ndescription: Text only\n---\n";
  const body = "Answer the user's question accurately.\n";
  const markdown = frontmatterOriginal + body;
  const connection = {
    connectionId: "test",
    providerKind: "openai",
    modelId: "test-model",
    endpoint: "https://test.invalid/v1",
    configHash: "b".repeat(64),
    credentialRevision: null,
    outputCapCoversReasoning: true as const,
    pricing: {
      inputPerMillion: 1,
      outputPerMillion: 2,
      cachedInputPerMillion: null,
      source: "fixture",
      date: "2026-10-08",
    },
  };
  return {
    schemaVersion: 1,
    projectKey: "1234567890abcdef",
    datasetHash: "a".repeat(64),
    skill: {
      name: "sample",
      source: "project",
      revision: createHash("sha256")
        .update(`SKILL.md\0false\0${Buffer.byteLength(markdown)}\0`)
        .update(markdown)
        .digest("hex"),
      revisionKind: "bundle",
      markdown,
      body,
      frontmatterOriginal,
      markdownHash: sha256Hex(markdown),
      bodyHash: sha256Hex(body),
      extraFiles: [],
    },
    connections: { target: connection, optimizer: structuredClone(connection) },
    runnerVersion: RUNNER_VERSION,
    strategyVersion: STRATEGY_VERSION,
    estimatorVersion: ESTIMATOR_VERSION,
    verdictPolicySuiteVersion: VERDICT_POLICY_SUITE_VERSION,
    scorerHash: "c".repeat(64),
    judgeMode: "human",
    objective: { kind: "quality", description: "Improve accuracy" },
    acceptance: {
      criticalHardAssertionIds: ["case-a/answer"],
      regressionCaseIds: ["case-b"],
      qualityNoRegression: true,
      minFixes: 1,
      minCostReductionRatio: 0.1,
      costComparableOnly: true,
      minHoldoutSourceGroups: 3,
      minPairedCases: 1,
    },
    bounds: {
      concurrency: 1,
      maxCandidates: 2,
      repeats: 1,
      maxBodyBytes: 4096,
      maxContextBytes: 65536,
      trial: { maxRequests: 2, maxOutputTokens: 100, timeoutMs: 1000, inputTokenUpperBound: 1000 },
      optimization: {
        maxRequests: 2,
        maxOutputTokens: 200,
        timeoutMs: 1000,
        inputTokenUpperBound: 2000,
      },
    },
    externalData: {
      target: "current_case_input_and_skill",
      optimizer: "skill_and_dev_feedback",
      judge: "none",
    },
    finalAllocation: {
      requests: 2,
      estimatedTokens: 200,
      estimatedCostUsd: 0.02,
      executionMs: 2000,
    },
  };
}
export function grantFor(
  planHash: string,
  now = Date.now(),
  overrides: Partial<BudgetGrant> = {},
): BudgetGrant {
  return createBudgetGrant(
    {
      schemaVersion: 1,
      planHash,
      revision: 1,
      confirmedAt: new Date(now - 100).toISOString(),
      expiresAt: new Date(now + 120000).toISOString(),
      startOperationId: "start-a",
      maxRequests: 10,
      maxExecutionMs: 20000,
      maxEstimatedTokens: 10000,
      maxEstimatedCostUsd: 1,
      enforcementMode: "reserved_estimate",
      revokedAt: null,
      revocationReason: null,
      ...overrides,
    },
    planHash,
    now,
  );
}
export function fixture(overrides: Partial<BudgetGrant> = {}) {
  const root = mkdtempSync(join(tmpdir(), "codeshell-lab-foundation-"));
  const store = new ExperimentStore(root);
  const snapshot = store.create(createExperimentPlan(planContent()));
  let clock = Date.now();
  const now = () => clock;
  const grant = grantFor(snapshot.plan.planHash, clock, overrides);
  store.appendGrant(snapshot.state.id, grant);
  const lease = new ExperimentLease(store, { now });
  const fence = lease.acquire(snapshot.state.id);
  return {
    root,
    store,
    id: snapshot.state.id,
    plan: snapshot.plan,
    grant,
    lease,
    fence,
    now,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
