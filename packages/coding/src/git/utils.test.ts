import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGitLog, getGitStatus } from "./utils.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

describe("coding git utils", () => {
  let repo: string;

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "csh-git-utils-")));
    git(repo, "init", "-q");
    git(repo, "config", "user.name", "Fixture Author");
    git(repo, "config", "user.email", "fixture@example.invalid");
    git(repo, "config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "alpha.txt"), "alpha\n");
    writeFileSync(join(repo, "beta.txt"), "beta\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "initial");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test("getGitStatus keeps the full path of a leading unstaged entry", () => {
    // Porcelain line ` M alpha.txt`: the leading status-column space must not
    // be trimmed away before the fixed-width path offset is applied.
    writeFileSync(join(repo, "alpha.txt"), "alpha changed\n");
    expect(getGitStatus(repo)).toEqual([{ status: "M", path: "alpha.txt" }]);
  });

  test("getGitStatus reports staged, unstaged, untracked and renamed entries", () => {
    writeFileSync(join(repo, "alpha.txt"), "alpha changed\n");
    git(repo, "add", "alpha.txt");
    writeFileSync(join(repo, "alpha.txt"), "alpha changed twice\n");
    git(repo, "mv", "beta.txt", "gamma.txt");
    writeFileSync(join(repo, "with space.txt"), "new\n");
    const entries = getGitStatus(repo);
    expect(entries).toContainEqual({ status: "MM", path: "alpha.txt" });
    expect(entries).toContainEqual({ status: "R", path: "gamma.txt", origPath: "beta.txt" });
    expect(entries).toContainEqual({ status: "??", path: "with space.txt" });
    expect(entries).toHaveLength(3);
  });

  test("getGitLog keeps a commit subject containing a pipe intact", () => {
    git(repo, "commit", "--allow-empty", "-qm", "feat: a | b");
    const [entry] = getGitLog(repo, 1);
    expect(entry?.message).toBe("feat: a | b");
    expect(entry?.author).toBe("Fixture Author");
    expect(entry?.date).toMatch(/^\d{4}-\d{2}-\d{2} /);
  });
});
