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
    expect(needs(job("npm-publish"))).toContain("package-release-smoke");

    const verifyRun = String(
      job("verify-version").steps.find((step: any) => step.name === "assert version == tag")?.run ??
        "",
    );
    const verifierSource = readFileSync("scripts/verify-release-versions.ts", "utf8");
    expect(verifyRun).toContain("scripts/verify-release-versions.ts");
    expect(verifierSource).toContain("RELEASE_PACKAGES.map(packageManifestPath)");
    expect(verifierSource).toContain("discoverWorkspaceManifestPaths");
  });

  test("npm publish delegates to the centralized public package declaration", () => {
    const publishRun = String(
      job("npm-publish").steps.find((step: any) => String(step.name ?? "").startsWith("publish"))
        ?.run ?? "",
    );
    const publisherSource = readFileSync("scripts/publish-release-packages.ts", "utf8");
    expect(publishRun).toContain("scripts/publish-release-packages.ts");
    expect(publishRun).toContain("--execute");
    expect(publisherSource).toContain("PUBLIC_RELEASE_PACKAGES.map");
    expect(publisherSource).toContain("verifyReleaseVersions(rootVersion)");
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
