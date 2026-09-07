import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const { validateReleaseRecovery, collectReleaseAssets } = createRequire(import.meta.url)(
  "../scripts/validate-release-recovery.cjs",
);
const sha = "a".repeat(40);

function sourceFixture() {
  const run = {
    path: ".github/workflows/release.yml",
    event: "push",
    head_branch: "v0.9.7",
    head_sha: sha,
    status: "completed",
    head_repository: { full_name: "owner/repo" },
  };
  const jobs = [
    "verify tag matches package versions",
    "package release smoke (ten tarballs)",
    "package (ubuntu-latest)",
    "package (macos-latest)",
    "package (windows-latest)",
  ].map((name) => ({ name, status: "completed", conclusion: "success" }));
  const artifacts = ["codeshell-linux", "codeshell-mac", "codeshell-windows"].map(
    (name, index) => ({ name, id: index + 1, expired: false, size_in_bytes: 1 }),
  );
  const reference = { object: { type: "commit", sha } };
  const github = {
    rest: {
      actions: {
        getWorkflowRun: async () => ({ data: run }),
        listJobsForWorkflowRun: "jobs",
        listWorkflowRunArtifacts: "artifacts",
      },
      git: {
        getRef: async () => ({ data: reference }),
        getTag: async () => ({ data: { object: { type: "commit", sha } } }),
      },
    },
    paginate: async (method: string) => (method === "jobs" ? jobs : artifacts),
  };
  return {
    run,
    jobs,
    artifacts,
    reference,
    validate: (input: Record<string, string> = {}) =>
      validateReleaseRecovery({
        github,
        context: { repo: { owner: "owner", repo: "repo" } },
        tag: "v0.9.7",
        sourceRunId: "123",
        ...input,
      }),
  };
}

describe("release recovery source gate", () => {
  test("rejects malformed tags and run IDs before querying the source", async () => {
    const fixture = sourceFixture();
    await expect(fixture.validate({ tag: "v0.9.7; echo bad" })).rejects.toThrow(
      "Invalid release tag",
    );
    await expect(fixture.validate({ sourceRunId: "../123" })).rejects.toThrow(
      "Invalid source run ID",
    );
  });
  test("accepts an original verified run, including annotated tags", async () => {
    const fixture = sourceFixture();
    expect(await fixture.validate()).toEqual({ sha, artifactIds: "1,2,3" });
    fixture.reference.object.type = "tag";
    expect((await fixture.validate()).sha).toBe(sha);
  });
  test("rejects moved tags and runs from another event or repository", async () => {
    for (const mutate of [
      (f: ReturnType<typeof sourceFixture>) => {
        f.run.head_sha = "b".repeat(40);
      },
      (f: ReturnType<typeof sourceFixture>) => {
        f.run.event = "workflow_dispatch";
      },
      (f: ReturnType<typeof sourceFixture>) => {
        f.run.head_repository.full_name = "fork/repo";
      },
    ]) {
      const fixture = sourceFixture();
      mutate(fixture);
      await expect(fixture.validate()).rejects.toThrow();
    }
  });
  test("requires every successful gate and every retained installer artifact", async () => {
    for (let index = 0; index < 5; index += 1) {
      const fixture = sourceFixture();
      fixture.jobs[index]!.conclusion = "failure";
      await expect(fixture.validate()).rejects.toThrow("Source prerequisite did not succeed");
    }
    const fixture = sourceFixture();
    fixture.artifacts[1]!.expired = true;
    await expect(fixture.validate()).rejects.toThrow("Source artifact");
  });
});

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

test("release assets require matching updater versions and unique installer names", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-recovery-"));
  directories.push(directory);
  for (const [platform, metadata, installer] of [
    ["linux", "latest-linux.yml", "code-shell-0.9.7.AppImage"],
    ["mac", "latest-mac.yml", "code-shell-0.9.7-arm64.dmg"],
    ["windows", "latest.yml", "code-shell-Setup-0.9.7.exe"],
  ]) {
    const path = join(directory, `codeshell-${platform}`);
    mkdirSync(path);
    writeFileSync(join(path, metadata!), "version: 0.9.7\n");
    writeFileSync(join(path, installer!), "fixture");
    writeFileSync(join(path, "builder-debug.yml"), "ignored");
  }
  expect(collectReleaseAssets(directory, "0.9.7")).toHaveLength(6);
  expect(() => collectReleaseAssets(directory, "0.9.8")).toThrow("Updater version");
  const wrongVersion = join(directory, "codeshell-mac", "code-shell-0.9.70.dmg");
  writeFileSync(wrongVersion, "wrong version");
  expect(() => collectReleaseAssets(directory, "0.9.7")).toThrow("filename does not match");
  rmSync(wrongVersion);
  writeFileSync(join(directory, "codeshell-mac", "code-shell-Setup-0.9.7.exe"), "duplicate");
  expect(() => collectReleaseAssets(directory, "0.9.7")).toThrow("Duplicate release asset");
});
