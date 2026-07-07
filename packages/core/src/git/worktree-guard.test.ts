import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createWorktree, validateWorktreeSlug } from "./worktree.js";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: ENV, encoding: "utf-8" }).trim();
}

describe("createWorktree same-branch guard", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "cs-wt-guard-"));
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "t@t.t"]);
    git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "f.txt"), "x\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "init"]);
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(join(repo, "..", ".worktrees"), { recursive: true, force: true });
  });

  test("errors clearly before git tries to check out a branch already used by a worktree", () => {
    const first = createWorktree(repo, "dup", "session123456");

    expect(() => createWorktree(repo, "dup", "session123456")).toThrow(
      new RegExp(
        `branch ${first.worktreeBranch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} already checked out at `,
      ),
    );
  });

  test("validateWorktreeSlug rejects empty or whitespace slugs", () => {
    expect(() => validateWorktreeSlug("")).toThrow(/empty/i);
    expect(() => validateWorktreeSlug("   ")).toThrow(/empty/i);
  });
});
