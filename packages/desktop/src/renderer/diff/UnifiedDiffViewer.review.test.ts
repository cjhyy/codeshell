import { describe, expect, test } from "bun:test";
import type { DiffFile } from "./parseUnifiedDiff";
import { reviewDiffFileKey } from "./UnifiedDiffViewer";
import { diffFileStats, diffLineText, splitDiffSections } from "./diffSections";
import { toPierreFileDiff } from "../code-view/pierreDiffModel";
import { withHeaderOnlyGitPatch } from "./headerOnlyGit.fixture";

const file: DiffFile = {
  oldPath: "src/shared.ts",
  newPath: "src/shared.ts",
  status: "modified",
  hunks: [],
};

describe("Review diff repository identity", () => {
  test("each Git section keeps its own header, including header-only files", async () => {
    await withHeaderOnlyGitPatch(({ raw, expected }) => {
      const sections = splitDiffSections(raw);
      expect(sections.map((section) => section.file)).toEqual(expected);
      // Header-only changes have no body for Pierre; text sections do.
      expect(sections.every((section) => toPierreFileDiff(section, "k") === null)).toBe(true);
    });
  });

  test("Pierre renders the hunks while display names stay ours", () => {
    const raw = [
      'diff --git "a/ padded name.ts " "b/ padded name.ts "',
      "index 1111111..2222222 100644",
      '--- "a/ padded name.ts "',
      '+++ "b/ padded name.ts "',
      "@@ -1,3 +1,3 @@",
      " keep",
      "-old line",
      "+new line",
      " tail",
      "",
    ].join("\n");
    const [section] = splitDiffSections(raw);
    const pierre = toPierreFileDiff(section!, "cache-key");
    expect(pierre?.name).toBe(" padded name.ts ");
    expect(pierre?.prevName).toBeUndefined();
    expect(pierre?.cacheKey).toBe("cache-key");
    expect(pierre?.hunks).toHaveLength(1);
    expect(diffFileStats(section!.file)).toEqual({ added: 1, removed: 1 });
    expect(diffLineText(section!.file, "additions", 2)).toBe("new line");
    expect(diffLineText(section!.file, "deletions", 2)).toBe("old line");
    expect(diffLineText(section!.file, "additions", 99)).toBe("");
  });

  test("does not key same-named relative files by path alone", () => {
    const left = reviewDiffFileKey({ rootId: "root-a", repoRoot: "/workspace/repo-a" }, file, 0);
    const right = reviewDiffFileKey({ rootId: "root-b", repoRoot: "/workspace/repo-b" }, file, 0);

    expect(left).not.toBe(right);
    expect(left).toContain("root-a");
    expect(left).toContain("/workspace/repo-a");
  });
});
