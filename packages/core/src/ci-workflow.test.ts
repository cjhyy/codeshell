import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const ciWorkflow = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as any;

describe("ci workflow guards", () => {
  test("guard job installs dependencies and runs lint", () => {
    const steps = ciWorkflow.jobs.guards.steps as any[];
    const runs = steps.map((step) => String(step.run ?? ""));

    expect(steps.some((step) => String(step.uses ?? "").startsWith("oven-sh/setup-bun@"))).toBe(
      true,
    );
    expect(runs.some((run) => run.includes("bun install --frozen-lockfile"))).toBe(true);
    expect(runs.some((run) => run.includes("bash scripts/check-no-engine-bypass.sh"))).toBe(
      true,
    );
    expect(runs.some((run) => run.includes("bun run lint"))).toBe(true);
  });
});
