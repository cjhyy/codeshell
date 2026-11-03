import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm, symlink, realpath, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { probeExternalChangedFiles } from "./external-change-provenance.js";

let root: string;
function git(...args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "provenance-")));
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  await writeFile(join(root, "clean.ts"), "committed\n");
  await writeFile(join(root, "modified.ts"), "before\n");
  await writeFile(join(root, "deleted.ts"), "gone\n");
  await writeFile(join(root, ".gitignore"), "ignored.ts\n");
  git("add", ".");
  git("commit", "-qm", "fixture");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("completion provenance probe (real Git)", () => {
  test("records only clean regular committed bytes; distinguishes modified/untracked/ignored/deleted/symlink/outside", async () => {
    await writeFile(join(root, "modified.ts"), "after\n");
    await writeFile(join(root, "untracked.ts"), "new");
    await writeFile(join(root, "ignored.ts"), "ignored");
    await rm(join(root, "deleted.ts"));
    await symlink(join(root, "clean.ts"), join(root, "link.ts"));
    const outside = await mkdtemp(join(tmpdir(), "outside-"));
    try {
      await writeFile(join(outside, "file"), "outside");
      const files = [
        "clean.ts",
        "modified.ts",
        "untracked.ts",
        "ignored.ts",
        "deleted.ts",
        "link.ts",
        join(outside, "file"),
      ];
      const result = await probeExternalChangedFiles(root, files, { cli: "codex" });
      expect(result).toMatchObject({ schemaVersion: 1, cli: "codex", capture: "completion" });
      expect(result.files.map((x) => x.presence)).toEqual([
        "present",
        "present",
        "present",
        "present",
        "missing",
        "not-regular",
        "present",
      ]);
      expect(result.files.slice(0, 4).map((x) => x.versionStatus)).toEqual([
        "recorded",
        "uncommitted",
        "untracked",
        "untracked",
      ]);
      expect(result.files[6]?.versionStatus).toBe("outside-repository");
      expect(result.files[0]?.contentRef).toMatchObject({
        kind: "git-blob",
        commit: git("rev-parse", "HEAD").trim(),
        blob: git("rev-parse", "HEAD:clean.ts").trim(),
        repoPath: "clean.ts",
        worktreePath: root,
        linkedWorktree: false,
      });
      for (const file of result.files.slice(1)) expect(file.contentRef).toBeUndefined();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
  test("literal pathspecs, unusual names, linked worktree identity, and raw bytes despite assume-unchanged", async () => {
    const names = [":(glob)*.ts", "space [x].ts", "文\n件.ts", "-dash.ts"];
    for (const name of names) await writeFile(join(root, name), name);
    git("--literal-pathspecs", "add", "--", ...names);
    git("commit", "-qm", "names");
    const wt = root + "-linked";
    git("worktree", "add", "-qb", "linked-fixture", wt);
    try {
      const result = await probeExternalChangedFiles(wt, names, { cli: "claude" });
      expect(result.files.map((x) => x.versionStatus)).toEqual(names.map(() => "recorded"));
      expect(result.files[0]?.contentRef?.linkedWorktree).toBe(true);
      expect(result.files[0]?.contentRef?.repositoryId).toBe(
        (await probeExternalChangedFiles(root, [names[0]!])).files[0]?.contentRef?.repositoryId,
      );
      git("update-index", "--assume-unchanged", "clean.ts");
      await writeFile(join(root, "clean.ts"), "different");
      expect((await probeExternalChangedFiles(root, ["clean.ts"])).files[0]?.versionStatus).toBe(
        "uncommitted",
      );
    } finally {
      git("worktree", "remove", "--force", wt);
    }
  });
  test("never executes configured filters and ignores hostile Git environment", async () => {
    const marker = join(root, "filter-ran");
    git("config", "filter.evil.clean", `touch '${marker}'; cat`);
    git("config", "filter.evil.required", "true");
    await writeFile(join(root, ".gitattributes"), "clean.ts filter=evil\n");
    const old = process.env.GIT_DIR;
    process.env.GIT_DIR = "/not-a-repository";
    try {
      const r = await probeExternalChangedFiles(root, ["clean.ts"]);
      expect(r.files[0]?.versionStatus).toBe("recorded");
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      if (old === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = old;
    }
  });
  test("does not execute filters whose names contain equals or trust a filter-normalized index", async () => {
    const marker = join(root, "equals-filter-ran");
    git("config", "filter.evil=x.clean", `touch '${marker}'; cat`);
    await writeFile(join(root, ".gitattributes"), "clean.ts filter=evil=x\n");
    await writeFile(join(root, "clean.ts"), "committed\n");
    const result = await probeExternalChangedFiles(root, ["clean.ts"]);
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(result.files[0]?.versionStatus).toBe("recorded");
  });
  test("classifies staged changes and mode changes as uncommitted", async () => {
    await writeFile(join(root, "staged.ts"), "staged");
    git("add", "staged.ts");
    await writeFile(join(root, "modified.ts"), "staged modification");
    git("add", "modified.ts");
    git("update-index", "--chmod=+x", "clean.ts");
    const result = await probeExternalChangedFiles(root, ["staged.ts", "modified.ts", "clean.ts"]);
    expect(result.files.map((ref) => ref.versionStatus)).toEqual([
      "uncommitted",
      "uncommitted",
      "uncommitted",
    ]);
  });
  test("unstaged executable-mode changes are uncommitted", async () => {
    if (process.platform === "win32") return;
    await chmod(join(root, "clean.ts"), 0o755);
    expect((await probeExternalChangedFiles(root, ["clean.ts"])).files[0]?.versionStatus).toBe(
      "uncommitted",
    );
  });
  test("caps publication at 100, enforces cumulative deadline, preserves presence on probe failure", async () => {
    const capped = await probeExternalChangedFiles(
      root,
      Array.from({ length: 110 }, (_, i) => `f${i}`),
      { maxFiles: 1 },
    );
    expect(capped.files).toHaveLength(100);
    expect(capped.files[1]?.versionStatus).toBe("skipped-limit");
    const before = Date.now();
    const stalled = await probeExternalChangedFiles(root, ["clean.ts"], {
      budgetMs: 30,
      runGit: async () => {
        await new Promise((r) => setTimeout(r, 100));
        throw Error("timeout");
      },
    });
    expect(Date.now() - before).toBeLessThan(95);
    expect(stalled.files[0]?.presence).toBe("present");
    expect(stalled.files[0]?.versionStatus).toBe("probe-failed");
    const failure = await probeExternalChangedFiles(root, ["clean.ts"], {
      runGit: async () => {
        throw Error("failure");
      },
    });
    expect(failure.files[0]).toMatchObject({ presence: "present", versionStatus: "probe-failed" });
  });
});
