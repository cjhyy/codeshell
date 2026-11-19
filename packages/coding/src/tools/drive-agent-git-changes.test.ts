import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driveChangedFiles } from "./drive-agent-changed-files.js";
import {
  DRIVE_GIT_CHANGED_FILES_CAP,
  driveGitChangedFiles,
  snapshotDriveGitState,
} from "./drive-agent-git-changes.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=worker@example.com", "-c", "user.name=worker", ...args],
    { cwd, encoding: "utf-8" },
  );
}

/** A real repository with one commit: `a.txt`, `b.txt`, `src/c.ts`, and `*.log` ignored. */
function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-drive-git-")));
  dirs.push(dir);
  git(dir, "init", "-q");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "a.txt"), "a\n");
  writeFileSync(join(dir, "b.txt"), "b\n");
  writeFileSync(join(dir, "src", "c.ts"), "c\n");
  writeFileSync(join(dir, ".gitignore"), "*.log\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

function changed(dir: string, baseline: ReturnType<typeof snapshotDriveGitState>): string[] {
  const { files } = driveChangedFiles(
    "codex",
    dir,
    { sessionId: "", changedFiles: [] },
    () => [],
    baseline,
  );
  return files.sort();
}

describe("git work tree attribution", () => {
  test("attributes what shell commands wrote, removed and created, and nothing git ignores", () => {
    const dir = repo();
    const baseline = snapshotDriveGitState(dir);
    writeFileSync(join(dir, "a.txt"), "changed by sed\n");
    rmSync(join(dir, "b.txt"));
    mkdirSync(join(dir, "out", "deep"), { recursive: true });
    writeFileSync(join(dir, "out", "deep", "new.txt"), "");
    writeFileSync(join(dir, "中文 name.txt"), "x");
    writeFileSync(join(dir, "build.log"), "ignored");
    expect(changed(dir, baseline)).toEqual(
      ["a.txt", "b.txt", join("out", "deep", "new.txt"), "中文 name.txt"].sort(),
    );
  });

  test("a clean run attributes nothing", () => {
    const dir = repo();
    const baseline = snapshotDriveGitState(dir);
    expect(driveGitChangedFiles(baseline)).toEqual({ files: [], total: 0 });
  });

  test("only what changed during the run counts when the tree was already dirty", () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "dirty before\n");
    writeFileSync(join(dir, "left-alone.txt"), "untracked before\n");
    writeFileSync(join(dir, "rewritten.txt"), "untracked before\n");
    writeFileSync(join(dir, "b.txt"), "dirty before, restored during\n");
    const baseline = snapshotDriveGitState(dir);
    writeFileSync(join(dir, "rewritten.txt"), "and written again by the worker\n");
    git(dir, "checkout", "--", "b.txt");
    writeFileSync(join(dir, "src", "c.ts"), "edited\n");
    expect(changed(dir, baseline)).toEqual(["b.txt", "rewritten.txt", join("src", "c.ts")]);
  });

  test("files the worker committed are attributed although the tree is clean again", () => {
    const dir = repo();
    const baseline = snapshotDriveGitState(dir);
    writeFileSync(join(dir, "a.txt"), "committed\n");
    writeFileSync(join(dir, "added.txt"), "committed\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "worker commit");
    writeFileSync(join(dir, "after.txt"), "uncommitted\n");
    expect(changed(dir, baseline)).toEqual(["a.txt", "added.txt", "after.txt"]);
  });

  test("a rename leaves the old path gone and the new one written", () => {
    const dir = repo();
    const baseline = snapshotDriveGitState(dir);
    git(dir, "mv", "a.txt", "renamed.txt");
    expect(changed(dir, baseline)).toEqual(["a.txt", "renamed.txt"]);
  });

  test("resolves paths against the work tree root when the worker runs in a subdirectory", () => {
    const dir = repo();
    const baseline = snapshotDriveGitState(join(dir, "src"));
    writeFileSync(join(dir, "src", "c.ts"), "edited\n");
    writeFileSync(join(dir, "top.txt"), "new\n");
    expect(changed(join(dir, "src"), baseline)).toEqual(["c.ts", join(dir, "top.txt")].sort());
  });

  test("caps the list and reports how many files there were", () => {
    const dir = repo();
    const baseline = snapshotDriveGitState(dir);
    const count = DRIVE_GIT_CHANGED_FILES_CAP + 5;
    for (let i = 0; i < count; i += 1) writeFileSync(join(dir, `gen-${i}.txt`), "");
    expect(driveGitChangedFiles(baseline)).toMatchObject({ total: count });
    const merged = driveChangedFiles(
      "claude",
      dir,
      { sessionId: "s1", changedFiles: [] },
      () => [join(dir, "gen-0.txt"), "/outside/reported.txt"],
      baseline,
    );
    // The transcript's own reports are kept; only the git list is cut.
    expect(merged.files).toHaveLength(DRIVE_GIT_CHANGED_FILES_CAP + 1);
    expect(merged.files).toContain("/outside/reported.txt");
    expect(merged.note).toBe(
      `[changed files] ${count} files changed in the work tree; only the first ` +
        `${DRIVE_GIT_CHANGED_FILES_CAP} are listed.`,
    );
  });

  test("merges with the CLI's own reports without duplicates", () => {
    const dir = repo();
    const baseline = snapshotDriveGitState(dir);
    writeFileSync(join(dir, "a.txt"), "patched\n");
    writeFileSync(join(dir, "shell.txt"), "by a shell command\n");
    const merged = driveChangedFiles(
      "codex",
      dir,
      { sessionId: "t1", changedFiles: [join(dir, "a.txt")] },
      () => ["a.txt"],
      baseline,
    );
    expect(merged.files).toEqual(["a.txt", "shell.txt"]);
    expect(merged.note).toBeUndefined();
  });

  test("without a baseline the existing sources are all there is", () => {
    const dir = repo();
    writeFileSync(join(dir, "shell.txt"), "unattributed in a shared directory\n");
    const merged = driveChangedFiles("codex", dir, { sessionId: "t1" }, () => ["a.txt"]);
    expect(merged).toEqual({ rawSize: 1, files: ["a.txt"] });
  });

  test("never throws: no repository, or one that went away", () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-drive-nogit-")));
    dirs.push(plain);
    expect(snapshotDriveGitState(plain)).toBeUndefined();
    expect(snapshotDriveGitState(join(plain, "missing"))).toBeUndefined();
    expect(driveGitChangedFiles(undefined)).toBeUndefined();

    const dir = repo();
    const baseline = snapshotDriveGitState(dir);
    rmSync(dir, { recursive: true, force: true });
    expect(driveGitChangedFiles(baseline)).toBeUndefined();
    expect(
      driveChangedFiles("codex", dir, { sessionId: "", changedFiles: ["x.ts"] }, () => [], baseline)
        .files,
    ).toEqual(["x.ts"]);
  });
});
