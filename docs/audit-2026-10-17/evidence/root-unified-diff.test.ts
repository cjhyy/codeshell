import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { parseUnifiedDiff } from "../../../packages/desktop/src/renderer/diff/parseUnifiedDiff.ts";

function git(dir: string, ...args: string[]) {
  const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git fixture: ${r.status} ${r.stderr}`);
  return r.stdout;
}

function repo(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "cs-audit-diff-"));
  try {
    git(dir, "init", "--quiet");
    git(dir, "config", "user.name", "Audit Fixture");
    git(dir, "config", "user.email", "audit@example.invalid");
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("R2-09 changed content beginning -- or ++ is misread as a file header", () => repo((dir) => {
  writeFileSync(join(dir, "sample.txt"), "-- before\ncontext\n");
  git(dir, "add", "--", "sample.txt");
  git(dir, "commit", "--quiet", "-m", "fixture");
  writeFileSync(join(dir, "sample.txt"), "++ after\ncontext\n");
  const raw = git(dir, "diff", "--no-ext-diff", "--", "sample.txt");
  const files = parseUnifiedDiff(raw);
  console.log(JSON.stringify({ case: "header-like-content", raw, files }));
  expect(files[0].oldPath).toBe("before");
  expect(files[0].newPath).toBe("after");
  expect(files[0].hunks[0].lines.some((l) => l.kind === "add" || l.kind === "del")).toBe(false);
}));

test("R2-10 pure rename has neither old nor new path in the parsed result", () => repo((dir) => {
  writeFileSync(join(dir, "old.txt"), "retained contents\n");
  git(dir, "add", "--", "old.txt");
  git(dir, "commit", "--quiet", "-m", "fixture");
  renameSync(join(dir, "old.txt"), join(dir, "new.txt"));
  git(dir, "add", "--", "old.txt", "new.txt");
  const raw = git(dir, "diff", "--cached", "--no-ext-diff", "--find-renames");
  const files = parseUnifiedDiff(raw);
  console.log(JSON.stringify({ case: "pure-rename", raw, files }));
  expect(files).toHaveLength(1);
  expect(files[0].status).toBe("renamed");
  expect(files[0].oldPath).toBeNull();
  expect(files[0].newPath).toBeNull();
}));

test("R2-11 default git quoted Unicode filenames are not decoded", () => repo((dir) => {
  const path = "中文.txt";
  writeFileSync(join(dir, path), "old\n");
  git(dir, "add", "--", path);
  git(dir, "commit", "--quiet", "-m", "fixture");
  writeFileSync(join(dir, path), "new\n");
  const raw = git(dir, "-c", "core.quotePath=true", "diff", "--no-ext-diff", "--", path);
  const files = parseUnifiedDiff(raw);
  console.log(JSON.stringify({ case: "unicode-path", raw, files }));
  expect(files[0].newPath).not.toBe(path);
  expect(files[0].newPath).toStartWith('"b/');
  const plain = parseUnifiedDiff(git(dir, "-c", "core.quotePath=false", "diff", "--no-ext-diff", "--", path));
  expect(plain[0].newPath).toBe(path);
}));

test("ordinary ASCII content normal control retains paths and line numbers", () => {
  const files = parseUnifiedDiff("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n");
  expect(files[0].oldPath).toBe("a.ts");
  expect(files[0].newPath).toBe("a.ts");
  expect(files[0].hunks[0].lines.filter((l) => l.kind === "add" || l.kind === "del").map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([["del", 1, null], ["add", null, 1]]);
});
