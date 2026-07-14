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

function packageDir(packageJsonPath: string): string {
  if (packageJsonPath === "package.json") return ".";
  return packageJsonPath.replace(/\/package\.json$/, "");
}

function packageJsonRefsFromVersionCheck(): string[] {
  const verifyRun = String(
    job("verify-version").steps.find((step: any) => step.name === "assert version == tag")?.run ??
      "",
  );
  const matches = Array.from(
    verifyRun.matchAll(/(?:^|\s)(package\.json|packages\/[^/\s]+\/package\.json)/g),
  );
  return Array.from(new Set(matches.map((match) => match[1]!)));
}

function publishedPackageDirs(): Set<string> {
  const publishRun = String(
    job("npm-publish").steps.find((step: any) => String(step.name ?? "").startsWith("publish"))
      ?.run ?? "",
  );
  const dirs = new Set<string>();
  for (const line of publishRun.split("\n").map((value) => value.trim())) {
    if (!line.startsWith("bun publish")) continue;
    const cwd = line.match(/--cwd\s+([^\s]+)/)?.[1];
    dirs.add(cwd ?? ".");
  }
  return dirs;
}

describe("release workflow guards", () => {
  test("npm publish is gated by tag/package version verification for every release package", () => {
    expect(needs(job("npm-publish"))).toContain("verify-version");

    const verifyRun = String(
      job("verify-version").steps.find((step: any) => step.name === "assert version == tag")?.run ??
        "",
    );

    expect(verifyRun).toContain("package.json");
    expect(verifyRun).toContain("packages/cdp/package.json");
    expect(verifyRun).toContain("packages/core/package.json");
    expect(verifyRun).toContain("packages/coding/package.json");
    expect(verifyRun).toContain("packages/tui/package.json");
    expect(verifyRun).toContain("packages/desktop/package.json");
  });

  test("version-checked npm packages are published unless explicitly private", () => {
    const published = publishedPackageDirs();
    const mismatches: string[] = [];

    for (const packageJsonPath of packageJsonRefsFromVersionCheck()) {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as any;
      const dir = packageDir(packageJsonPath);
      if (packageJson.private === true) continue;
      if (!published.has(dir)) {
        mismatches.push(`${packageJson.name} is version-checked and public but not published`);
      }
    }

    expect(mismatches).toEqual([]);
  });

  test("release write permissions are isolated to the GitHub Release job", () => {
    expect(releaseWorkflow.permissions?.contents).not.toBe("write");

    expect(job("verify-version").permissions?.contents).toBe("read");
    expect(job("package").permissions?.contents).toBe("read");
    expect(job("npm-publish").permissions?.contents).toBe("read");
    expect(job("release").permissions?.contents).toBe("write");

    for (const jobName of ["verify-version", "package", "npm-publish"]) {
      const checkoutSteps = job(jobName).steps.filter((step: any) =>
        String(step.uses ?? "").startsWith("actions/checkout@"),
      );

      expect(checkoutSteps.length).toBeGreaterThan(0);
      for (const step of checkoutSteps) {
        expect(step.with?.["persist-credentials"]).toBe(false);
      }
    }
  });
});
