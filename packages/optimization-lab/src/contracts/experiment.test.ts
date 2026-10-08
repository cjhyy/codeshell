import { describe, expect, test } from "bun:test";
import { createExperimentPlan, verifyExperimentPlan, worstCaseTokens } from "./experiment.js";
import { createBudgetGrant, verifyBudgetGrant, assertGrantActive } from "./grant.js";
import { canonicalJson, sha256Hex } from "./canonical-json.js";
import { planContent, grantFor } from "../test-fixtures/foundation.js";

describe("immutable experiment plans", () => {
  test("key order cannot change plan hash, and inputs are copied", () => {
    const input = planContent();
    const plan = createExperimentPlan(input);
    const reordered = Object.fromEntries(Object.entries(input).reverse());
    expect(createExperimentPlan(reordered).planHash).toBe(plan.planHash);
    input.skill.body = "changed";
    expect(verifyExperimentPlan(plan).skill.body).not.toBe("changed");
  });
  const mutations: [string, (input: any) => void][] = [
    [
      "extra root field",
      (input) => {
        input.apiKey = "secret";
      },
    ],
    [
      "missing field",
      (input) => {
        delete input.scorerHash;
      },
    ],
    [
      "non-finite",
      (input) => {
        input.finalAllocation.estimatedTokens = Infinity;
      },
    ],
    [
      "non-positive limit",
      (input) => {
        input.bounds.trial.maxRequests = 0;
      },
    ],
    [
      "concurrency",
      (input) => {
        input.bounds.concurrency = 2;
      },
    ],
    [
      "candidate count",
      (input) => {
        input.bounds.maxCandidates = 3;
      },
    ],
    [
      "model judge",
      (input) => {
        input.judgeMode = "model";
      },
    ],
    [
      "secret endpoint",
      (input) => {
        input.connections.target.endpoint = "https://user:secret@test.invalid/v1";
      },
    ],
    [
      "query endpoint",
      (input) => {
        input.connections.target.endpoint = "https://test.invalid/v1?key=secret";
      },
    ],
    [
      "header projection",
      (input) => {
        input.connections.target.httpHeaders = { authorization: "secret" };
      },
    ],
    [
      "markdown only revision",
      (input) => {
        input.skill.revisionKind = "markdown";
      },
    ],
    [
      "extra files",
      (input) => {
        input.skill.extraFiles = ["script.sh"];
      },
    ],
    [
      "body hash",
      (input) => {
        input.skill.bodyHash = "0".repeat(64);
      },
    ],
    [
      "arbitrary body with valid hash",
      (input) => {
        input.skill.body = "Unrelated";
        input.skill.bodyHash = sha256Hex(input.skill.body);
      },
    ],
    [
      "arbitrary frontmatter prefix",
      (input) => {
        input.skill.frontmatterOriginal = "---";
      },
    ],
    [
      "bundle revision",
      (input) => {
        input.skill.revision = sha256Hex(input.skill.markdown);
      },
    ],
    [
      "unscoped criterion alias",
      (input) => {
        input.acceptance.criticalHardAssertionIds = ["answer"];
      },
    ],
    [
      "duplicated criterion",
      (input) => {
        input.acceptance.criticalHardAssertionIds = ["case-a/answer", "case-a/answer"];
      },
    ],
  ];
  for (const [name, mutate] of mutations)
    test(`rejects ${name}`, () => {
      const input = planContent();
      mutate(input);
      expect(() => createExperimentPlan(input)).toThrow();
    });
  test("rejects plan tampering even with valid component hashes", () => {
    const plan = createExperimentPlan(planContent());
    plan.objective.description = "Different objective";
    expect(() => verifyExperimentPlan(plan)).toThrow("plan hash mismatch");
  });
  test("worst-case bound is conditional, conservative and safe", () => {
    const input = planContent();
    expect(worstCaseTokens(createExperimentPlan(input), 10)).toBe(22000);
    input.connections.optimizer.outputCapCoversReasoning = "unknown";
    expect(worstCaseTokens(createExperimentPlan(input), 10)).toBeNull();
    input.connections.optimizer.outputCapCoversReasoning = true;
    input.bounds.trial.inputTokenUpperBound = null;
    expect(worstCaseTokens(createExperimentPlan(input), 10)).toBeNull();
    input.bounds.trial.inputTokenUpperBound = Number.MAX_SAFE_INTEGER;
    expect(worstCaseTokens(createExperimentPlan(input), 10)).toBeNull();
    expect(() => worstCaseTokens(createExperimentPlan(input), 0)).toThrow();
  });
});

describe("budget grants", () => {
  test("structural historical verification does not renew an expired grant", () => {
    const plan = createExperimentPlan(planContent());
    const now = Date.now();
    const grant = grantFor(plan.planHash, now);
    expect(verifyBudgetGrant(grant, plan.planHash)).toEqual(grant);
    expect(() => assertGrantActive(grant, plan.planHash, now + 120000)).toThrow("expired");
    expect(() => createBudgetGrant(grant, plan.planHash, now + 120000)).toThrow("expired");
  });
  test("rejects malformed, mismatched, zero, non-finite and revoked authorization", () => {
    const plan = createExperimentPlan(planContent());
    const now = Date.now();
    const grant = grantFor(plan.planHash, now);
    for (const patch of [
      { maxRequests: 0 },
      { maxExecutionMs: -1 },
      { maxEstimatedTokens: NaN },
      { extra: true },
      { planHash: "0".repeat(64) },
      { expiresAt: grant.confirmedAt },
      { revokedAt: new Date(now).toISOString() },
    ]) {
      expect(() => createBudgetGrant({ ...grant, ...patch }, plan.planHash, now)).toThrow();
    }
    expect(() =>
      createBudgetGrant(
        { ...grant, revokedAt: new Date(now).toISOString(), revocationReason: "user" },
        plan.planHash,
        now,
      ),
    ).toThrow("revoked");
    expect(canonicalJson(grant)).not.toContain("apiKey");
  });
});
