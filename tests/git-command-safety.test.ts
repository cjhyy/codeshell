import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gitAdd,
  gitCheckout,
  gitCommit,
  getCurrentBranch,
  getGitDiff,
  ghPrComments,
} from "@cjhyy/code-shell-capability-coding";

/**
 * Task 3 — git helpers must build argv arrays, never command strings.
 * The proof-of-safety strategy is: pass a value that, under string
 * interpolation, would touch a sentinel file (`pwned`). After the call the
 * sentinel must NOT exist. git itself will exit non-zero on the malformed
 * input — that's fine, the point is that no shell got to interpret it.
 */

describe("git helpers — argv form prevents shell injection", () => {
  let repo: string;
  let sentinelDir: string;
  let sentinel: string;

  beforeEach(() => {
    sentinelDir = mkdtempSync(join(tmpdir(), "codeshell-git-sentinel-"));
    sentinel = join(sentinelDir, "pwned");
    repo = mkdtempSync(join(tmpdir(), "codeshell-git-repo-"));
    execFileSync("git", ["init", "--initial-branch=main", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "test"], { cwd: repo });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repo });
    writeFileSync(join(repo, "README.md"), "hi\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init", "-q"], { cwd: repo });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(sentinelDir, { recursive: true, force: true });
  });

  test("gitCheckout: malicious branch name does not execute injected command", () => {
    // Under the old `git checkout ${branch}` form, sh would have run
    // `touch <sentinel>`. With argv it's a literal branch name git rejects.
    const evil = `; touch ${sentinel} #`;
    expect(() => gitCheckout(repo, evil)).toThrow();
    expect(existsSync(sentinel)).toBe(false);
  });

  test("gitCheckout: also safe in create mode", () => {
    const evil = `; touch ${sentinel} #`;
    expect(() => gitCheckout(repo, evil, true)).toThrow();
    expect(existsSync(sentinel)).toBe(false);
  });

  test("gitCheckout: a leading-dash branch name is treated as a branch, not an option", () => {
    // Pre-fix the unquoted `--orphan` would be parsed by git as a flag and
    // silently work. argv form sends it as a positional arg, and the
    // surrounding "checkout"/"-b" already occupy the slots — git rejects it.
    expect(() => gitCheckout(repo, "--orphan")).toThrow();
  });

  test("ghPrComments: malicious PR URL is passed as a literal argument", () => {
    // gh isn't installed in CI; fall back to manually verifying that the
    // function never reaches a shell. We just need: either gh is missing
    // (function throws ENOENT) or gh rejects the URL — either way the
    // sentinel must not appear.
    const evil = `; touch ${sentinel} #`;
    try {
      ghPrComments(repo, evil);
    } catch {
      // expected — either gh missing or gh rejected the URL
    }
    expect(existsSync(sentinel)).toBe(false);
  });

  test("getGitDiff: file path with spaces and quotes is handled", () => {
    // Pre-fix `getGitDiff` join'd args with spaces, so a path like
    // "a b.txt" would be split. argv form preserves it intact.
    const tricky = `weird "name" with $vars and spaces.txt`;
    writeFileSync(join(repo, tricky), "x\n");
    execFileSync("git", ["add", "--", tricky], { cwd: repo });
    // getGitDiff with --staged + the tricky file should not throw.
    const out = getGitDiff(repo, { staged: true, file: tricky });
    // Either the file shows in the diff or git returns an empty string —
    // both are acceptable; the assertion is that we didn't blow up.
    expect(typeof out).toBe("string");
  });

  test("getGitDiff: a file path starting with `-` is treated as a path, not a flag", () => {
    // Pre-fix, `-evil` could have been parsed as a git option. argv form
    // with `--` terminates option parsing — git treats it as a (missing)
    // file path and returns an empty diff rather than acting on a flag.
    // The proof here is: it returns a string, and the sentinel side-effect
    // never fires.
    const out = getGitDiff(repo, { file: "-evil" });
    expect(typeof out).toBe("string");
    expect(existsSync(sentinel)).toBe(false);
  });

  test("gitAdd: file name starting with `-` is treated as a path, not a flag", () => {
    // Same argument as above for gitAdd's `--` terminator.
    writeFileSync(join(repo, "-tricky.txt"), "x\n");
    // Should not throw: "--" terminates option parsing, so "-tricky.txt"
    // is taken as a path.
    expect(() => gitAdd(repo, ["-tricky.txt"])).not.toThrow();
  });

  test("gitCommit: message with shell metacharacters is preserved verbatim", () => {
    writeFileSync(join(repo, "x.txt"), "x\n");
    gitAdd(repo, ["x.txt"]);
    const msg = `feat: try "; rm -rf /; echo $HOME \` and 'quotes'`;
    gitCommit(repo, msg);
    const log = execFileSync("git", ["log", "-1", "--format=%s"], {
      cwd: repo,
      encoding: "utf-8",
    }).trim();
    expect(log).toBe(msg);
  });

  test("getCurrentBranch: returns the actual branch name on a fresh repo", () => {
    // Sanity check that the argv conversion didn't accidentally break the
    // happy path.
    expect(getCurrentBranch(repo)).toBe("main");
  });
});
