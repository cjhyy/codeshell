import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { VERDICT_POLICY, VERDICT_POLICY_SUITE_VERSION } from "./verdict-policy.js";

describe("verdict policy", () => {
  test("matches the eval harness contract it was copied from", () => {
    const cases = JSON.parse(
      readFileSync(new URL("../../../../evals/harness/cases.json", import.meta.url), "utf8"),
    );
    // If this fails, the harness contract changed: re-copy verdictPolicy and
    // suiteVersion instead of loosening the test.
    expect(VERDICT_POLICY).toEqual(cases.verdictPolicy);
    expect(VERDICT_POLICY_SUITE_VERSION).toBe(cases.suiteVersion);
  });
});
