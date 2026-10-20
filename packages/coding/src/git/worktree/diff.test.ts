import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, removeWorktree } from "./crud.js";
import { getWorktreeDiff, worktreeHasUncommittedOrAheadChanges } from "./diff.js";
import * as gitExec from "./git-exec.js";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: ENV, encoding: "utf-8" }).trim();
}

describe("coding getWorktreeDiff", () => {
  let repo: string;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cs-wt-diff-root-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "t@t.t"]);
    git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "f.txt"), "x\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "init"]);
    git(repo, ["branch", "-M", "main"]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("summarizes committed and uncommitted changes for one worktree", async () => {
    const wt = await createWorktree(repo, "feature", "session123456");
    writeFileSync(join(wt.worktreePath, "feature.txt"), "feature\n");
    git(wt.worktreePath, ["add", "-A"]);
    git(wt.worktreePath, ["commit", "-q", "-m", "feature"]);
    writeFileSync(join(wt.worktreePath, "dirty.txt"), "dirty\n");

    await expect(getWorktreeDiff(wt.worktreePath, "main")).resolves.toMatchObject({
      baseRef: "main",
      changedFiles: 2,
      aheadCommits: 1,
      hasUncommittedChanges: true,
    });
    await expect(worktreeHasUncommittedOrAheadChanges(wt.worktreePath, "main")).resolves.toBe(true);

    removeWorktree(wt.worktreePath, true);
  });

  test("counts rename destinations and preserves whitespace, Unicode, and newline paths", async () => {
    const wt = await createWorktree(repo, "paths", "session123456");
    const renamed = " renamed -> 目标\nfile.txt ";
    git(wt.worktreePath, ["mv", "f.txt", renamed]);
    writeFileSync(join(wt.worktreePath, ' dirty " -> 新\nfile '), "dirty\n");

    await expect(getWorktreeDiff(wt.worktreePath)).resolves.toMatchObject({
      changedFiles: 2,
      aheadCommits: 0,
      hasUncommittedChanges: true,
    });

    git(wt.worktreePath, ["commit", "-q", "-m", "rename"]);
    writeFileSync(join(wt.worktreePath, renamed), "edited\n");
    await expect(getWorktreeDiff(wt.worktreePath)).resolves.toMatchObject({
      changedFiles: 2,
      aheadCommits: 1,
      hasUncommittedChanges: true,
    });
  });

  test("does not refresh the index while reading a background summary", async () => {
    const indexPath = join(repo, ".git", "index");
    const before = readFileSync(indexPath);
    const changedTime = new Date(Date.now() + 5000);
    utimesSync(join(repo, "f.txt"), changedTime, changedTime);

    await expect(getWorktreeDiff(repo)).resolves.toMatchObject({
      changedFiles: 0,
      hasUncommittedChanges: false,
    });
    expect(readFileSync(indexPath)).toEqual(before);
  });

  test("falls back from an absent explicit base and supports repositories without a default base", async () => {
    await expect(getWorktreeDiff(repo, "missing-base")).resolves.toMatchObject({
      baseRef: "main",
      changedFiles: 0,
    });
    git(repo, ["branch", "-m", "feature"]);
    expect(await getWorktreeDiff(repo)).toEqual({
      changedFiles: 0,
      aheadCommits: 0,
      hasUncommittedChanges: false,
    });
  });

  test("keeps the two-dot fallback for unrelated histories", async () => {
    git(repo, ["checkout", "--orphan", "unrelated"]);
    git(repo, ["rm", "-q", "-f", "f.txt"]);
    writeFileSync(join(repo, "other.txt"), "other\n");
    git(repo, ["add", "other.txt"]);
    git(repo, ["commit", "-q", "-m", "unrelated"]);

    await expect(getWorktreeDiff(repo)).resolves.toMatchObject({
      baseRef: "main",
      changedFiles: 2,
      aheadCommits: 1,
      hasUncommittedChanges: false,
    });
  });

  test("rejects an unavailable workspace instead of reporting it clean", async () => {
    await expect(getWorktreeDiff(join(root, "missing"))).rejects.toThrow();
  });

  test.each(["rev-parse", "status", "diff", "rev-list"])(
    "surfaces a %s timeout instead of reporting a clean summary",
    async (command) => {
      const original = gitExec.execGit;
      const failure = Object.assign(new Error("Git command timed out"), { code: "ETIMEDOUT" });
      const execute = spyOn(gitExec, "execGit").mockImplementation((cwd, args, ...rest) => {
        if (args.includes(command)) return Promise.reject(failure);
        return original(cwd, args, ...rest);
      });
      try {
        await expect(getWorktreeDiff(repo)).rejects.toBe(failure);
      } finally {
        execute.mockRestore();
      }
    },
  );
});
