import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { gitDiffStat, gitDiff } from "./git-diff.js";

// Regression: /diff interpolated user input into a shell string passed to
// execSync (review-2026-05-30, high-severity command injection at
// core-commands.ts:512,523). The fix runs git via execFileSync with an argv
// array — a malicious `file` arg must reach git as a literal pathspec, never
// the shell.

describe("git-diff helpers — no shell injection", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "cs-gitdiff-"));
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
    const run = (args: string[]) => execFileSync("git", args, { cwd: repo, env, stdio: "pipe" });
    run(["init", "-q"]);
    run(["config", "user.email", "t@t.t"]);
    run(["config", "user.name", "t"]);
    writeFileSync(join(repo, "a.txt"), "v1\n");
    run(["add", "-A"]);
    run(["commit", "-q", "-m", "init"]);
    writeFileSync(join(repo, "a.txt"), "v2\n"); // a working-tree change to diff
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test("stat shows the changed file", () => {
    const stat = gitDiffStat(repo, "");
    expect(stat).toContain("a.txt");
  });

  test("diff body shows the change", () => {
    const diff = gitDiff(repo, "");
    expect(diff).toContain("+v2");
  });

  test("a shell-metacharacter file arg does NOT execute — treated as a pathspec", () => {
    const sentinel = join(repo, "PWNED");
    // If the arg were interpolated into a shell, `; touch PWNED #` would run.
    // Via execFileSync it is one literal pathspec git can't match → git errors,
    // our helper swallows it and returns "", and crucially PWNED is never made.
    const malicious = `; touch ${sentinel} #`;
    const out = gitDiff(repo, malicious);
    expect(existsSync(sentinel)).toBe(false);
    expect(out).toBe(""); // unmatched pathspec → empty / error swallowed
  });
});
