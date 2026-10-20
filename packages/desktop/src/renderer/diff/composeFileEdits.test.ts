import { describe, expect, test } from "bun:test";
import { composeFileEdits, syntheticSnippetDiff, type FileEditOperation } from "./composeFileEdits";
import { parseUnifiedDiff } from "./parseUnifiedDiff";

function edit(oldText: string, newText: string, replaceAll = false): FileEditOperation {
  return { kind: "edit", oldText, newText, replaceAll };
}

function changedLines(diff: string): string[] {
  return parseUnifiedDiff(diff).flatMap((file) =>
    file.hunks.flatMap((hunk) =>
      hunk.lines
        .filter((line) => line.kind === "add" || line.kind === "del")
        .map((line) => `${line.kind === "add" ? "+" : "-"}${line.text}`),
    ),
  );
}

describe("composeFileEdits", () => {
  test("composes a replacement chain into the initial and final snippets", () => {
    const result = composeFileEdits("a.ts", [edit("a", "b"), edit("b", "c")]);
    expect(changedLines(result.diff)).toEqual(["-a", "+c"]);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(parseUnifiedDiff(result.diff)).toHaveLength(1);
  });

  test("cancels a reverted edit while retaining its baseline for the next edit", () => {
    expect(composeFileEdits("a.ts", [edit("a", "b"), edit("b", "a")])).toEqual({
      diff: "",
      added: 0,
      removed: 0,
    });
    const result = composeFileEdits("a.ts", [edit("a", "b"), edit("b", "a"), edit("a", "c")]);
    expect(changedLines(result.diff)).toEqual(["-a", "+c"]);
  });

  test("retains unrelated snippets as multiple hunks under one file header", () => {
    const result = composeFileEdits("a.ts", [edit("one", "two"), edit("three", "four")]);
    const files = parseUnifiedDiff(result.diff);
    expect(files).toHaveLength(1);
    expect(files[0]?.hunks).toHaveLength(2);
    expect(changedLines(result.diff)).toEqual(["-one", "+two", "-three", "+four"]);
    expect(result.added).toBe(2);
    expect(result.removed).toBe(2);
  });

  test("replays a unique replacement within the known after-snippet", () => {
    const result = composeFileEdits("a.ts", [
      edit("before", "top\nmiddle\nbottom"),
      edit("middle", "final"),
    ]);
    expect(changedLines(result.diff)).toEqual(["-before", "+top", "+final", "+bottom"]);
    expect(parseUnifiedDiff(result.diff)[0]?.hunks).toHaveLength(1);
  });

  test("keeps enclosing snippets separate because their shared text does not prove a location", () => {
    const result = composeFileEdits("a.ts", [
      edit("original", "intermediate"),
      edit("top\nintermediate\nbottom", "top\nfinal\nbottom"),
    ]);
    // These payloads can also come from two distinct globally unique edits.
    // Even when one physical file could support a net merge, no position or
    // full baseline in this API distinguishes that file from the counterexample.
    expect(changedLines(result.diff)).toEqual([
      "-original",
      "+intermediate",
      "-intermediate",
      "+final",
    ]);
    expect(parseUnifiedDiff(result.diff)[0]?.hunks).toHaveLength(2);
    expect(parseUnifiedDiff(result.diff)[0]?.hunks[1]?.lines.map((line) => line.text)).toEqual([
      "top",
      "intermediate",
      "final",
      "bottom",
    ]);
  });

  test("does not guess when a replacement or enclosing context has multiple matches", () => {
    for (const operations of [
      [edit("original", "same same"), edit("same", "final")],
      [edit("original", "same"), edit("same same", "final")],
    ]) {
      const result = composeFileEdits("a.ts", operations);
      expect(parseUnifiedDiff(result.diff)[0]?.hunks).toHaveLength(2);
      expect(changedLines(result.diff)).toContain("-original");
      expect(changedLines(result.diff)).toContain("+final");
    }
  });

  test("does not locate an insertion by an empty string after a deletion", () => {
    const result = composeFileEdits("a.ts", [edit("a", ""), edit("", "b")]);
    expect(parseUnifiedDiff(result.diff)[0]?.hunks).toHaveLength(2);
    expect(changedLines(result.diff)).toEqual(["-a", "+b"]);
  });

  test("only replays the most recent segment after an unresolved operation", () => {
    const result = composeFileEdits("a.ts", [edit("a", "b"), edit("x", "y"), edit("b", "c")]);
    expect(parseUnifiedDiff(result.diff)[0]?.hunks).toHaveLength(3);
    expect(changedLines(result.diff)).toEqual(["-a", "+b", "-x", "+y", "-b", "+c"]);
  });

  test("edits the full known content supplied by Write and keeps its addition status", () => {
    const result = composeFileEdits("a.ts", [
      { kind: "write", content: "top\nbefore\nbottom\n" },
      edit("before", "after"),
    ]);
    expect(changedLines(result.diff)).toEqual(["+top", "+after", "+bottom"]);
    expect(result.added).toBe(3);
    expect(result.removed).toBe(0);
    expect(parseUnifiedDiff(result.diff)[0]?.status).toBe("added");
    expect(parseUnifiedDiff(result.diff)[0]?.oldPath).toBeNull();
  });

  test("consecutive Writes keep the final content, including edits between Writes", () => {
    const result = composeFileEdits("a.ts", [
      { kind: "write", content: "first" },
      edit("first", "second"),
      { kind: "write", content: "final\ncontent" },
    ]);
    expect(changedLines(result.diff)).toEqual(["+final", "+content"]);
    expect(parseUnifiedDiff(result.diff)[0]?.hunks).toHaveLength(1);
  });

  test("does not expand a complete Write with contradictory outer context", () => {
    const result = composeFileEdits("a.ts", [
      { kind: "write", content: "known" },
      edit("outside\nknown", "outside\nchanged"),
    ]);
    expect(parseUnifiedDiff(result.diff)[0]?.hunks).toHaveLength(2);
    expect(changedLines(result.diff)).toContain("+known");
    expect(changedLines(result.diff)).toContain("+changed");
  });

  test("opaque patches preserve their original hunk coordinates and stop composition", () => {
    const opaque = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -41 +41 @@ original location",
      "-before",
      "+after",
      "",
    ].join("\n");
    const result = composeFileEdits("a.ts", [
      edit("a", "b"),
      { kind: "opaque", diff: opaque },
      edit("b", "c"),
    ]);
    expect(result.diff).toContain("@@ -41 +41 @@ original location\n-before\n+after");
    expect(parseUnifiedDiff(result.diff)).toHaveLength(1);
    expect(parseUnifiedDiff(result.diff)[0]?.hunks).toHaveLength(3);
    expect(changedLines(result.diff)).toEqual(["-a", "+b", "-before", "+after", "-b", "+c"]);
  });

  test("opaque input with repeated file headers still produces only one file block", () => {
    const diff =
      syntheticSnippetDiff("a.ts", "one", "two") + syntheticSnippetDiff("a.ts", "three", "four");
    const result = composeFileEdits("a.ts", [{ kind: "opaque", diff }]);
    expect(result.diff.match(/^diff --git /gm)).toHaveLength(1);
    expect(parseUnifiedDiff(result.diff)[0]?.hunks).toHaveLength(2);
    expect(changedLines(result.diff)).toEqual(["-one", "+two", "-three", "+four"]);
  });

  test("replace_all remains an independent preview and prevents later replay across it", () => {
    const result = composeFileEdits("a.ts", [edit("a", "b"), edit("x", "y", true), edit("b", "c")]);
    expect(parseUnifiedDiff(result.diff)[0]?.hunks).toHaveLength(3);
    expect(changedLines(result.diff)).toEqual(["-a", "+b", "-x", "+y", "-b", "+c"]);
    const chain = composeFileEdits("a.ts", [edit("a", "b", true), edit("b", "c")]);
    expect(parseUnifiedDiff(chain.diff)[0]?.hunks).toHaveLength(2);
  });

  test("preserves explicit opaque added, deleted, and empty-file metadata", () => {
    const added = composeFileEdits("a.ts", [
      { kind: "opaque", diff: syntheticSnippetDiff("a.ts", "", "before", "added") },
      edit("before", "after"),
    ]);
    expect(parseUnifiedDiff(added.diff)[0]?.status).toBe("added");
    const deleted = composeFileEdits("a.ts", [
      {
        kind: "opaque",
        diff: "diff --git a/a.ts b/a.ts\ndeleted file mode 100644\n--- a/a.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n",
      },
    ]);
    expect(parseUnifiedDiff(deleted.diff)[0]?.status).toBe("deleted");
    expect(changedLines(deleted.diff)).toEqual(["-gone"]);
    const empty = composeFileEdits("a.ts", [
      { kind: "opaque", diff: "diff --git a/a.ts b/a.ts\nnew file mode 100644\n" },
    ]);
    expect(parseUnifiedDiff(empty.diff)[0]?.status).toBe("added");
    expect(empty.added).toBe(0);
    expect(empty.removed).toBe(0);
  });

  test("limits synthetic unchanged context to three lines on either side", () => {
    const before = "one\ntwo\nthree\nfour\nold\nfive\nsix\nseven\neight";
    const result = composeFileEdits("a.ts", [edit(before, before.replace("old", "new"))]);
    expect(parseUnifiedDiff(result.diff)[0]?.hunks[0]?.lines.map((line) => line.text)).toEqual([
      "two",
      "three",
      "four",
      "old",
      "new",
      "five",
      "six",
      "seven",
    ]);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
  });
});
