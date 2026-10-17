import { expect, test } from "bun:test";
import { parseUnifiedDiff } from "./parseUnifiedDiff";
import { withHeaderOnlyGitPatch } from "./headerOnlyGit.fixture";

test("actual owned Git mode-only, binary and empty add/delete retain complete identities", async () => {
  await withHeaderOnlyGitPatch(({ raw, unquoted, expected }) => {
    console.log(
      JSON.stringify({
        scenario: "header-only-real-git",
        raw,
        unquoted,
        parsed: parseUnifiedDiff(raw),
        expected,
      }),
    );
    for (const patch of [raw, unquoted]) {
      expect(patch).not.toContain("\n--- ");
      expect(patch).not.toContain("\n@@ ");
      expect(patch).toContain("Binary files ");
      expect(
        parseUnifiedDiff(patch).sort((a, b) =>
          (a.newPath ?? a.oldPath ?? "").localeCompare(b.newPath ?? b.oldPath ?? ""),
        ),
      ).toEqual(expected);
    }
  });
});

test("quoted header token boundaries preserve spaces, C escapes and UTF-8 octal", () => {
  for (const [header, oldPath, newPath] of [
    ['"a/old space.txt" "b/new space.txt"', "old space.txt", "new space.txt"],
    ['"a/quote\\" and \\t.txt" "b/quote\\" and \\t.txt"', 'quote" and \t.txt', 'quote" and \t.txt'],
    ['"a/\\344\\270\\255.txt" "b/\\344\\270\\255.txt"', "中.txt", "中.txt"],
    ['a/plain.txt "b/quoted new.txt"', "plain.txt", "quoted new.txt"],
    ['"a/quoted old.txt" b/plain.txt', "quoted old.txt", "plain.txt"],
    ["a/ space.txt  b/ space.txt ", " space.txt ", " space.txt "],
    ["a/folder b/name.dat b/folder b/name.dat", "folder b/name.dat", "folder b/name.dat"],
  ]) {
    expect(parseUnifiedDiff(`diff --git ${header}\nold mode 100644\nnew mode 100755\n`)).toEqual([
      { oldPath, newPath, status: "modified", hunks: [] },
    ]);
  }
});

test("ambiguous or incomplete header-only tokens do not manufacture a path", () => {
  for (const header of [
    '"a/unclosed b/file.txt',
    '"a/x"suffix "b/y"',
    '"a/x" "b/y" extra',
    "a/old space.txt b/different space.txt",
    "a/part b/name b/different b/name",
    "a/only.txt",
    "a/x c/y",
    "a/ b/",
  ])
    expect(parseUnifiedDiff(`diff --git ${header}\nold mode 100644\nnew mode 100755\n`)).toEqual([
      { oldPath: null, newPath: null, status: "modified", hunks: [] },
    ]);
});

test("explicit content and rename paths override fallback; empty file modes clear the absent side", () => {
  const header = "diff --git a/fallback b/fallback\n";
  expect(parseUnifiedDiff(header + "--- a/actual old\n+++ b/actual new\n")[0]).toMatchObject({
    oldPath: "actual old",
    newPath: "actual new",
  });
  expect(parseUnifiedDiff(header + "rename from old name\nrename to new name\n")[0]).toMatchObject({
    oldPath: "old name",
    newPath: "new name",
    status: "renamed",
  });
  expect(parseUnifiedDiff(header + "new file mode 100644\n")[0]).toMatchObject({
    oldPath: null,
    newPath: "fallback",
    status: "added",
  });
  expect(parseUnifiedDiff(header + "deleted file mode 100644\n")[0]).toMatchObject({
    oldPath: "fallback",
    newPath: null,
    status: "deleted",
  });
});
