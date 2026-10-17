import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectReviewTarget, parseReviewArguments } from "./review-target.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Review Test",
  GIT_AUTHOR_EMAIL: "review@example.test",
  GIT_COMMITTER_NAME: "Review Test",
  GIT_COMMITTER_EMAIL: "review@example.test",
};
let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-review-target-")));
  git(["init", "-q", "--initial-branch=main"]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: root, env: GIT_ENV, encoding: "utf8" }).trim();
}
function write(path: string, content: string | Buffer): void {
  writeFileSync(join(root, path), content);
}
function commit(message = "initial"): string {
  git(["add", "-A"]);
  git(["commit", "-q", "-m", message]);
  return git(["rev-parse", "HEAD"]);
}

// These collect real Git scopes. No provider requests or user repository state are used.
describe("review argument parsing", () => {
  test("defaults to all uncommitted changes and preserves review output options", () => {
    expect(parseReviewArguments("--json --dimensions=security,perf 'src/a b.ts'")).toEqual({
      target: { kind: "working", mode: "all", file: "src/a b.ts" },
      json: true,
      dimensions: ["security", "performance"],
    });
  });
  test("accepts explicit scopes, separate values, and literal dash-prefixed paths", () => {
    expect(parseReviewArguments("--base origin/main").target).toEqual({
      kind: "base",
      ref: "origin/main",
    });
    expect(parseReviewArguments("--commit=abc123 -- -file").target).toEqual({
      kind: "commit",
      commit: "abc123",
      file: "-file",
    });
    expect(parseReviewArguments('--unstaged "src/a\\\\b.ts"').target).toEqual({
      kind: "working",
      mode: "unstaged",
      file: "src/a\\b.ts",
    });
  });
  test("rejects ambiguous, unknown, and incomplete arguments before collecting anything", () => {
    for (const input of [
      "--staged --unstaged",
      "--all --base=main",
      "--base",
      "--commit=HEAD",
      "--commit=--help",
      "--base=-p",
      "--unknown",
      "-q",
      "--json --json",
      "--dimensions=security,typo",
      "--dimensions=",
      "--dimensions=security --dimensions=correctness",
      "one.ts two.ts",
      "'unclosed",
      "''",
    ])
      expect(() => parseReviewArguments(input)).toThrow();
  });
});

describe("complete bounded review targets", () => {
  test("all includes staged, unstaged, and untracked text with exact newline metadata", async () => {
    write("tracked.txt", "before\n");
    commit();
    write("staged.txt", "staged only\n");
    git(["add", "staged.txt"]);
    write("tracked.txt", "unstaged only\n");
    write("new file.txt", "untracked only");
    const review = await collectReviewTarget(root, parseReviewArguments("").target);
    expect(review.files.sort()).toEqual(["new file.txt", "staged.txt", "tracked.txt"]);
    expect(review.content).toContain("+staged only");
    expect(review.content).toContain("+unstaged only");
    expect(review.content).toContain("+untracked only");
    expect(review.content).toContain("\\ No newline at end of file");
    expect(review.label).toBe("all uncommitted changes");
  });
  test("staged and unstaged are distinct; unstaged includes new untracked files", async () => {
    write("tracked.txt", "before\n");
    commit();
    write("tracked.txt", "index version\n");
    git(["add", "tracked.txt"]);
    write("tracked.txt", "working version\n");
    write("new.txt", "new text\n");
    const staged = await collectReviewTarget(root, { kind: "working", mode: "staged" });
    expect(staged.content).toContain("+index version");
    expect(staged.content).not.toContain("working version");
    expect(staged.files).toEqual(["tracked.txt"]);
    const unstaged = await collectReviewTarget(root, { kind: "working", mode: "unstaged" });
    expect(unstaged.content).toContain("-index version");
    expect(unstaged.content).toContain("+working version");
    expect(unstaged.content).toContain("+new text");
  });
  test("unborn all uses the final worktree contents and includes empty untracked files", async () => {
    write("first.txt", "index version\n");
    git(["add", "first.txt"]);
    write("first.txt", "final version\n");
    write("empty.txt", "");
    const review = await collectReviewTarget(root, { kind: "working", mode: "all" });
    expect(review.content).toContain("+final version");
    expect(review.content).not.toContain("index version");
    expect(review.content).toContain('diff --git "a/empty.txt" "b/empty.txt"');
    expect(review.files.sort()).toEqual(["empty.txt", "first.txt"]);
    const staged = await collectReviewTarget(root, { kind: "working", mode: "staged" });
    expect(staged.content).toContain("+index version");
    expect(staged.content).not.toContain("final version");
  });
  test("selected commits use their own patch, including root commits, without worktree changes", async () => {
    write("tracked.txt", "root version\n");
    const initial = commit();
    write("tracked.txt", "second version\n");
    const second = commit("second");
    write("tracked.txt", "uncommitted version\n");
    write("new.txt", "untracked\n");
    const firstReview = await collectReviewTarget(root, { kind: "commit", commit: initial });
    expect(firstReview.content).toContain("new file mode");
    expect(firstReview.content).toContain("+root version");
    expect(firstReview.content).not.toContain("second version");
    const secondReview = await collectReviewTarget(root, { kind: "commit", commit: second });
    expect(secondReview.content).toContain("-root version");
    expect(secondReview.content).toContain("+second version");
    expect(secondReview.content).not.toContain("uncommitted");
    expect(secondReview.files).toEqual(["tracked.txt"]);
  });
  test("base scope compares merge-base to HEAD rather than including base-only changes", async () => {
    write("common.txt", "common\n");
    commit();
    git(["checkout", "-q", "-b", "feature"]);
    write("feature.txt", "feature change\n");
    commit("feature");
    git(["checkout", "-q", "main"]);
    write("main-only.txt", "base diverged\n");
    commit("base advanced");
    git(["checkout", "-q", "feature"]);
    const review = await collectReviewTarget(root, { kind: "base", ref: "main" });
    expect(review.files).toEqual(["feature.txt"]);
    expect(review.content).toContain("+feature change");
    expect(review.content).not.toContain("base diverged");
  });
  test("paths are literal, cwd-relative, and confined to the repository", async () => {
    mkdirSync(join(root, "src"));
    write("src/a b[1].txt", "selected\n");
    write("src/other.txt", "other\n");
    const review = await collectReviewTarget(join(root, "src"), {
      kind: "working",
      mode: "all",
      file: "a b[1].txt",
    });
    expect(review.files).toEqual(["src/a b[1].txt"]);
    expect(review.content).toContain("+selected");
    expect(review.content).not.toContain("+other");
    await expect(
      collectReviewTarget(root, { kind: "working", mode: "all", file: "../outside.txt" }),
    ).rejects.toThrow("inside the Git repository");
    await expect(
      collectReviewTarget(root, { kind: "working", mode: "all", file: "missing.txt" }),
    ).rejects.toThrow("No changes");
  });
  test("ignored files stay outside the requested change scope", async () => {
    write(".gitignore", "private.txt\n");
    commit();
    write("private.txt", "ignored\n");
    expect((await collectReviewTarget(root, { kind: "working", mode: "all" })).content).toBe("");
  });
  test("binary tracked and untracked changes fail explicitly instead of returning clean or partial reviews", async () => {
    write("tracked.bin", Buffer.from([0, 1]));
    commit();
    write("tracked.bin", Buffer.from([0, 2]));
    await expect(collectReviewTarget(root, { kind: "working", mode: "all" })).rejects.toThrow(
      "Review incomplete: binary file tracked.bin",
    );
    git(["checkout", "--", "tracked.bin"]);
    write("new.bin", Buffer.from([0, 2]));
    await expect(collectReviewTarget(root, { kind: "working", mode: "all" })).rejects.toThrow(
      "Review incomplete: binary file new.bin",
    );
  });
  test("invalid UTF-8 and oversized added files fail before model review", async () => {
    write("bad.txt", Buffer.from([0xff, 0xfe]));
    await expect(collectReviewTarget(root, { kind: "working", mode: "all" })).rejects.toThrow(
      "not valid UTF-8",
    );
    rmSync(join(root, "bad.txt"));
    write("large.txt", "x".repeat(64 * 1024 + 1));
    await expect(collectReviewTarget(root, { kind: "working", mode: "all" })).rejects.toThrow(
      "added-file limit",
    );
  });
  test("tracked binary data cannot be disguised as a text patch by attributes", async () => {
    write(".gitattributes", "*.txt diff\n");
    write("tracked.txt", "before\n");
    commit();
    write("tracked.txt", Buffer.from([0, 1, 10]));
    await expect(collectReviewTarget(root, { kind: "working", mode: "all" })).rejects.toThrow(
      "patch contains binary data",
    );
    write("tracked.txt", Buffer.from([0xff, 0xfe, 10]));
    await expect(collectReviewTarget(root, { kind: "working", mode: "all" })).rejects.toThrow(
      "non-UTF-8 data",
    );
  });
  test("too many files and oversized tracked diffs fail explicitly without clipping a hunk", async () => {
    for (let index = 0; index < 101; index++) write(`new-${index}.txt`, "x\n");
    await expect(collectReviewTarget(root, { kind: "working", mode: "all" })).rejects.toThrow(
      "scope exceeds 100 files",
    );
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "many files"]);
    write("new-0.txt", "x".repeat(256 * 1024 + 1));
    await expect(collectReviewTarget(root, { kind: "working", mode: "all" })).rejects.toThrow(
      "Review incomplete",
    );
  });
  test("untracked symlinks cannot pull external files into a review", async () => {
    write("target.txt", "private target\n");
    symlinkSync(join(root, "target.txt"), join(root, "link.txt"), "file");
    await expect(
      collectReviewTarget(root, { kind: "working", mode: "all", file: "link.txt" }),
    ).rejects.toThrow("symbolic link");
  });
  test("unknown refs fail visibly instead of looking like an empty scope", async () => {
    write("tracked.txt", "initial\n");
    commit();
    await expect(collectReviewTarget(root, { kind: "base", ref: "missing-ref" })).rejects.toThrow(
      "Review collection failed",
    );
    await expect(collectReviewTarget(root, { kind: "commit", commit: "deadbeef" })).rejects.toThrow(
      "Review collection failed",
    );
  });
  test("unmerged paths fail explicitly rather than producing combined partial diffs", async () => {
    write("tracked.txt", "initial\n");
    commit();
    git(["checkout", "-q", "-b", "feature"]);
    write("tracked.txt", "feature\n");
    commit("feature");
    git(["checkout", "-q", "main"]);
    write("tracked.txt", "main\n");
    commit("main");
    try {
      git(["merge", "feature"]);
    } catch {
      // The real merge intentionally leaves the fixture conflicted.
    }
    await expect(collectReviewTarget(root, { kind: "working", mode: "all" })).rejects.toThrow(
      "resolve unmerged files",
    );
  });
  test("diff and textconv programs are disabled for review collection", async () => {
    write("tracked.txt", "before\n");
    write(".gitattributes", "tracked.txt diff=review-test\n");
    commit();
    git(["config", "diff.external", "false"]);
    git(["config", "diff.review-test.textconv", "false"]);
    write("tracked.txt", "after\n");
    const review = await collectReviewTarget(root, { kind: "working", mode: "all" });
    expect(review.content).toContain("-before");
    expect(review.content).toContain("+after");
  });
});
