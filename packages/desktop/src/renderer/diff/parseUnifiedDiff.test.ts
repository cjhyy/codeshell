import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUnifiedDiff } from "./parseUnifiedDiff";

function repository(run: (dir: string, git: (...args: string[]) => string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "codeshell-review-diff-"));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        `core.hooksPath=${join(dir, "absent-hooks")}`,
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.quotePath=true",
        ...args,
      ],
      { cwd: dir, encoding: "utf8", timeout: 5_000 },
    );
  try {
    git("init", "--quiet");
    git("config", "user.name", "Owned Review fixture");
    git("config", "user.email", "review@example.invalid");
    run(dir, git);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("real Git header-like hunk contents retain file identity, changes and context numbers", () => {
  repository((dir, git) => {
    writeFileSync(join(dir, "sample.txt"), "-- before\ncontext\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "Owned baseline");
    writeFileSync(join(dir, "sample.txt"), "++ after\ncontext\n");
    const raw = git("diff", "--no-ext-diff");
    console.log(JSON.stringify({ scenario: "hunk-content", raw, parsed: parseUnifiedDiff(raw) }));
    const [file] = parseUnifiedDiff(raw);
    expect([file.oldPath, file.newPath]).toEqual(["sample.txt", "sample.txt"]);
    expect(
      file.hunks[0].lines.map((line) => [line.kind, line.text, line.oldLine, line.newLine]),
    ).toEqual([
      ["del", "-- before", 1, null],
      ["add", "++ after", null, 1],
      ["ctx", "context", 2, 2],
    ]);
  });
});

test("real Git pure rename preserves both paths without requiring a content hunk", () => {
  repository((dir, git) => {
    const old = process.platform === "win32" ? "old 中文.txt" : " old 中文.txt ";
    const next = process.platform === "win32" ? "new 中文.txt" : " new 中文.txt ";
    writeFileSync(join(dir, old), "unchanged\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "Owned baseline");
    renameSync(join(dir, old), join(dir, next));
    git("add", "--all");
    const raw = git("diff", "--cached", "--no-ext-diff", "--find-renames");
    console.log(JSON.stringify({ scenario: "pure-rename", raw, parsed: parseUnifiedDiff(raw) }));
    expect(parseUnifiedDiff(raw)).toEqual([
      { oldPath: old, newPath: next, status: "renamed", hunks: [] },
    ]);
  });
});

test("real Git quoted UTF-8, quote, backslash and control characters decode as exact filenames", () => {
  repository((dir, git) => {
    const names = [
      "中文.txt",
      'quote"name.txt',
      "tab\tname.txt",
      "line\nname.txt",
      " padded name ",
    ];
    // Windows cannot create filenames containing a quote/control character.
    if (process.platform !== "win32") names.push("back\\slash.txt");
    const valid = process.platform === "win32" ? [names[0]] : names;
    for (const name of valid) writeFileSync(join(dir, name), "old\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "Owned baseline");
    for (const name of valid) writeFileSync(join(dir, name), "new\n");
    const raw = git("diff", "--no-ext-diff");
    console.log(JSON.stringify({ scenario: "quoted-paths", raw, parsed: parseUnifiedDiff(raw) }));
    expect(
      parseUnifiedDiff(raw)
        .map((file) => file.newPath)
        .sort(),
    ).toEqual([...valid].sort());
    expect(
      parseUnifiedDiff(git("-c", "core.quotePath=false", "diff", "--no-ext-diff"))
        .map((file) => file.newPath)
        .sort(),
    ).toEqual([...valid].sort());
  });
});

test("ordinary addition, deletion, multiple hunks and no-newline markers remain intact", () => {
  const raw =
    "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n@@ -4,0 +5 @@\n+tail\ndiff --git a/gone b/gone\ndeleted file mode 100644\n--- a/gone\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\ndiff --git a/added b/added\nnew file mode 100644\n--- /dev/null\n+++ b/added\n@@ -0,0 +1 @@\n+added\n";
  const files = parseUnifiedDiff(raw);
  expect(files.map((file) => [file.oldPath, file.newPath, file.status])).toEqual([
    ["a.txt", "a.txt", "modified"],
    ["gone", null, "deleted"],
    [null, "added", "added"],
  ]);
  expect(files[0].hunks.map((hunk) => hunk.lines.map((line) => line.kind))).toEqual([
    ["del", "add", "meta"],
    ["add"],
  ]);
});
