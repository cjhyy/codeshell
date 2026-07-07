import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const releaseWorkflow = parse(readFileSync(".github/workflows/release.yml", "utf8")) as any;

function job(name: string): any {
  return releaseWorkflow.jobs[name];
}

function needs(jobConfig: any): string[] {
  const value = jobConfig?.needs;
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  return [];
}

describe("release workflow guards", () => {
  test("npm publish is gated by tag/package version verification for every release package", () => {
    expect(needs(job("npm-publish"))).toContain("verify-version");

    const verifyRun = String(
      job("verify-version").steps.find((step: any) => step.name === "assert version == tag")?.run ?? "",
    );

    expect(verifyRun).toContain("package.json");
    expect(verifyRun).toContain("packages/cdp/package.json");
    expect(verifyRun).toContain("packages/core/package.json");
    expect(verifyRun).toContain("packages/tui/package.json");
    expect(verifyRun).toContain("packages/desktop/package.json");
  });
});
